// Schema compare / sync script and table copy between databases (possibly on
// different connections), like SQLyog's "Schema Synchronization" and
// "Copy Database".
import { randomUUID } from 'node:crypto';
import { quoteId, quoteVal } from './sql.js';

// ---------------------------------------------------------------------------
// Schema snapshot
// ---------------------------------------------------------------------------

const ID = '`((?:[^`]|``)+)`';
const unq = (s) => s.replace(/``/g, '`');

// Splits SHOW CREATE TABLE into columns / indexes / foreign keys / checks /
// table options, each kept as the server's own canonical definition text.
export function parseCreateTable(sql) {
  const out = { cols: [], colDef: {}, idx: {}, fks: {}, checks: {}, options: '' };
  for (const raw of sql.split('\n').slice(1)) {
    const line = raw.trim().replace(/,$/, '');
    let m;
    if (line.startsWith(')')) { out.options = line.slice(1).trim(); continue; }
    if ((m = new RegExp(`^${ID}\\s+(.*)$`).exec(line))) {
      const name = unq(m[1]);
      out.cols.push(name);
      out.colDef[name] = m[2];
    } else if (/^PRIMARY KEY/i.test(line)) out.idx.PRIMARY = line;
    else if ((m = new RegExp(`^(?:UNIQUE |FULLTEXT |SPATIAL |VECTOR )?(?:KEY|INDEX)\\s+${ID}`, 'i').exec(line))) out.idx[unq(m[1])] = line;
    else if ((m = new RegExp(`^CONSTRAINT\\s+${ID}\\s+FOREIGN KEY`, 'i').exec(line))) out.fks[unq(m[1])] = line;
    else if ((m = new RegExp(`^CONSTRAINT\\s+${ID}\\s+CHECK`, 'i').exec(line))) out.checks[unq(m[1])] = line;
  }
  out.options = out.options.replace(/\s*AUTO_INCREMENT=\d+/i, '').trim();
  return out;
}

const stripDefiner = (s) => s.replace(/\s*DEFINER=`[^`]*`@`[^`]*`/gi, '').replace(/\s*DEFINER=\S+/gi, '');
const retarget = (s, from, to) => (from === to ? s : s.split(`${quoteId(from)}.`).join(`${quoteId(to)}.`));

async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

async function snapshot(pool, db, { routines = true } = {}) {
  const [objs] = await pool.query(
    'SELECT TABLE_NAME AS name, TABLE_TYPE AS type FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME', [db]);
  if (!objs.length) {
    const [[exists]] = await pool.query('SELECT COUNT(*) AS n FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [db]);
    if (!Number(exists.n)) throw new Error(`La base de datos ${db} no existe`);
  }
  const snap = { tables: {}, views: {}, procedure: {}, function: {}, trigger: {} };
  const fq = (n) => `${quoteId(db)}.${quoteId(n)}`;
  // SHOW CREATE qualifies names with the schema only when it isn't the
  // session's current database; drop our own prefix so both sides compare equal.
  const own = (def) => def.split(`${quoteId(db)}.`).join('');
  await mapLimit(objs, 4, async (o) => {
    if (o.type === 'VIEW') {
      const [[r]] = await pool.query(`SHOW CREATE VIEW ${fq(o.name)}`);
      snap.views[o.name] = own(stripDefiner(r['Create View'])).replace(/ALGORITHM=UNDEFINED\s+/i, '').replace(/SQL SECURITY DEFINER\s+/i, '');
    } else {
      const [[r]] = await pool.query(`SHOW CREATE TABLE ${fq(o.name)}`);
      const create = r['Create Table'];
      snap.tables[o.name] = { create: create.replace(/\s*AUTO_INCREMENT=\d+/i, ''), ...parseCreateTable(create) };
    }
  });
  if (routines) {
    const [rs] = await pool.query(
      'SELECT ROUTINE_NAME AS name, ROUTINE_TYPE AS type FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ?', [db]);
    await mapLimit(rs, 4, async (r) => {
      const kind = r.type === 'FUNCTION' ? 'FUNCTION' : 'PROCEDURE';
      const [[row]] = await pool.query(`SHOW CREATE ${kind} ${fq(r.name)}`);
      const def = row[kind === 'FUNCTION' ? 'Create Function' : 'Create Procedure'];
      if (def) snap[kind.toLowerCase()][r.name] = own(stripDefiner(def));
    });
    const [ts] = await pool.query('SELECT TRIGGER_NAME AS name FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ?', [db]);
    await mapLimit(ts, 4, async (tr) => {
      const [[row]] = await pool.query(`SHOW CREATE TRIGGER ${fq(tr.name)}`);
      snap.trigger[tr.name] = own(stripDefiner(row['SQL Original Statement']));
    });
  }
  return snap;
}

// ---------------------------------------------------------------------------
// Compare -> sync script (makes TARGET look like SOURCE)
// ---------------------------------------------------------------------------

function diffTable(name, s, t) {
  const details = [];
  const fkDrops = [];
  const fkAdds = [];
  const clauses = [];
  const T = quoteId(name);

  for (const [k, line] of Object.entries(t.fks)) {
    if (s.fks[k] !== line) { fkDrops.push(`ALTER TABLE ${T} DROP FOREIGN KEY ${quoteId(k)}`); if (!s.fks[k]) details.push(`− FK ${k}`); }
  }
  for (const [k, line] of Object.entries(s.fks)) {
    if (t.fks[k] !== line) { fkAdds.push(`ALTER TABLE ${T} ADD ${line}`); details.push(t.fks[k] ? `≠ FK ${k}` : `+ FK ${k}`); }
  }
  for (const [k, line] of Object.entries(t.checks)) if (s.checks[k] !== line) clauses.push(`DROP CONSTRAINT ${quoteId(k)}`);
  for (const [k, line] of Object.entries(t.idx)) {
    if (s.idx[k] !== line) {
      clauses.push(k === 'PRIMARY' ? 'DROP PRIMARY KEY' : `DROP INDEX ${quoteId(k)}`);
      if (!s.idx[k]) details.push(`− ${k === 'PRIMARY' ? 'PRIMARY KEY' : 'índice ' + k}`);
    }
  }
  for (const c of t.cols) if (!(c in s.colDef)) { clauses.push(`DROP COLUMN ${quoteId(c)}`); details.push(`− columna ${c}`); }
  s.cols.forEach((c, i) => {
    const pos = i === 0 ? ' FIRST' : ` AFTER ${quoteId(s.cols[i - 1])}`;
    if (!(c in t.colDef)) {
      clauses.push(`ADD COLUMN ${quoteId(c)} ${s.colDef[c]}${pos}`);
      details.push(`+ columna ${c} ${s.colDef[c]}`);
    } else {
      const ti = t.cols.indexOf(c);
      const movedPrev = (i === 0 ? null : s.cols[i - 1]) !== (ti === 0 ? null : t.cols[ti - 1]);
      if (s.colDef[c] !== t.colDef[c] || movedPrev) {
        clauses.push(`MODIFY COLUMN ${quoteId(c)} ${s.colDef[c]}${movedPrev ? pos : ''}`);
        details.push(s.colDef[c] !== t.colDef[c] ? `≠ columna ${c}: ${t.colDef[c]}  →  ${s.colDef[c]}` : `↕ columna ${c} (posición)`);
      }
    }
  });
  for (const [k, line] of Object.entries(s.idx)) {
    if (t.idx[k] !== line) { clauses.push(`ADD ${line}`); details.push(`${t.idx[k] ? '≠' : '+'} ${k === 'PRIMARY' ? 'PRIMARY KEY' : 'índice ' + k}`); }
  }
  for (const [k, line] of Object.entries(s.checks)) if (t.checks[k] !== line) { clauses.push(`ADD ${line}`); details.push(`≠ CHECK ${k}`); }
  if (s.options !== t.options) { clauses.push(s.options); details.push(`≠ opciones: ${t.options}  →  ${s.options}`); }

  const alter = clauses.length ? [`ALTER TABLE ${T}\n  ${clauses.join(',\n  ')}`] : [];
  return { details, fkDrops, fkAdds, alter, changed: details.length > 0 || alter.length > 0 };
}

export async function compareSchemas(srcPool, srcDb, dstPool, dstDb, { includeDrops = false, routines = true } = {}) {
  const [s, t] = await Promise.all([snapshot(srcPool, srcDb, { routines }), snapshot(dstPool, dstDb, { routines })]);
  const items = [];
  const creates = []; const fkDrops = []; const alters = []; const fkAdds = []; const drops = [];
  const viewStmts = []; const blockStmts = [];

  for (const name of Object.keys(s.tables)) {
    const st = s.tables[name];
    if (!t.tables[name]) {
      const create = retarget(st.create, srcDb, dstDb);
      creates.push(create);
      items.push({ type: 'table', name, status: 'new', details: [`${st.cols.length} columnas`] });
    } else {
      const d = diffTable(name, st, t.tables[name]);
      if (d.changed) {
        fkDrops.push(...d.fkDrops); alters.push(...d.alter); fkAdds.push(...d.fkAdds.map((x) => retarget(x, srcDb, dstDb)));
        items.push({ type: 'table', name, status: 'changed', details: d.details });
      } else items.push({ type: 'table', name, status: 'same', details: [] });
    }
  }
  for (const name of Object.keys(t.tables)) {
    if (!s.tables[name]) {
      items.push({ type: 'table', name, status: 'extra', details: [] });
      if (includeDrops) drops.push(`DROP TABLE IF EXISTS ${quoteId(name)}`);
    }
  }
  for (const name of Object.keys(s.views)) {
    const def = retarget(s.views[name], srcDb, dstDb);
    if (t.views[name] === def) { items.push({ type: 'view', name, status: 'same', details: [] }); continue; }
    viewStmts.push(def.replace(/^CREATE\s+/i, 'CREATE OR REPLACE '));
    items.push({ type: 'view', name, status: t.views[name] ? 'changed' : 'new', details: [] });
  }
  for (const name of Object.keys(t.views)) {
    if (!s.views[name]) { items.push({ type: 'view', name, status: 'extra', details: [] }); if (includeDrops) drops.push(`DROP VIEW IF EXISTS ${quoteId(name)}`); }
  }
  for (const kind of ['procedure', 'function', 'trigger']) {
    const KW = kind.toUpperCase();
    for (const name of Object.keys(s[kind])) {
      const def = retarget(s[kind][name], srcDb, dstDb);
      if (t[kind][name] === def) { items.push({ type: kind, name, status: 'same', details: [] }); continue; }
      blockStmts.push(`DROP ${KW} IF EXISTS ${quoteId(name)}$$\n${def}$$`);
      items.push({ type: kind, name, status: t[kind][name] ? 'changed' : 'new', details: [] });
    }
    for (const name of Object.keys(t[kind])) {
      if (!s[kind][name]) {
        items.push({ type: kind, name, status: 'extra', details: [] });
        if (includeDrops) drops.push(`DROP ${KW} IF EXISTS ${quoteId(name)}`);
      }
    }
  }

  const body = [...fkDrops, ...creates, ...alters, ...fkAdds, ...viewStmts, ...drops];
  let script = '';
  if (body.length || blockStmts.length) {
    script = [
      `-- DBStudio: sincronizar ${dstDb} con la estructura de ${srcDb}`,
      `-- Generado ${new Date().toISOString()}`,
      `USE ${quoteId(dstDb)};`,
      'SET FOREIGN_KEY_CHECKS = 0;',
      '',
      ...body.map((x) => x + ';\n'),
      ...(blockStmts.length ? ['DELIMITER $$', ...blockStmts, 'DELIMITER ;', ''] : []),
      'SET FOREIGN_KEY_CHECKS = 1;',
    ].join('\n');
  }
  const summary = { new: 0, changed: 0, extra: 0, same: 0 };
  for (const it of items) summary[it.status]++;
  return { items, summary, script };
}

// ---------------------------------------------------------------------------
// Copy tables (structure and/or data) as a background job
// ---------------------------------------------------------------------------

const jobs = new Map();

function sqlLiteral(v) {
  if (v === null || v === undefined) return 'NULL';
  if (Buffer.isBuffer(v)) return v.length ? `X'${v.toString('hex')}'` : "''";
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  if (typeof v === 'object') return quoteVal(JSON.stringify(v));
  return quoteVal(v);
}

// Keep JSON as text and geometry as its internal binary form so they insert back unchanged.
const rawTypeCast = (field, next) => {
  if (field.type === 'JSON') return field.string();
  if (field.type === 'GEOMETRY') return field.buffer();
  return next();
};

export function startCopy({ srcPool, srcDb, dstPool, dstDb, tables, structure = true, data = true, dropExisting = false, createDb = true }) {
  const job = {
    id: randomUUID(), status: 'running', cancelled: false, error: null, startedAt: Date.now(), finishedAt: null,
    tables: tables.map((name) => ({ name, status: 'pending', rows: 0, total: null, error: null })),
  };
  jobs.set(job.id, job);

  (async () => {
    const sconn = await srcPool.getConnection();
    const tconn = await dstPool.getConnection();
    try {
      if (createDb) {
        const [[cs]] = await sconn.query(
          'SELECT DEFAULT_CHARACTER_SET_NAME AS cs, DEFAULT_COLLATION_NAME AS co FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [srcDb]);
        await tconn.query(`CREATE DATABASE IF NOT EXISTS ${quoteId(dstDb)}${cs ? ` CHARACTER SET ${cs.cs} COLLATE ${cs.co}` : ''}`);
      }
      await tconn.query(`USE ${quoteId(dstDb)}`);
      await tconn.query("SET SESSION FOREIGN_KEY_CHECKS = 0, UNIQUE_CHECKS = 0, SQL_MODE = CONCAT(@@SQL_MODE, ',NO_AUTO_VALUE_ON_ZERO')");
      for (const tb of job.tables) {
        if (job.cancelled) { tb.status = 'cancelled'; continue; }
        tb.status = 'running';
        const src = `${quoteId(srcDb)}.${quoteId(tb.name)}`;
        try {
          if (structure) {
            const [[r]] = await sconn.query(`SHOW CREATE TABLE ${src}`);
            if (dropExisting) await tconn.query(`DROP TABLE IF EXISTS ${quoteId(tb.name)}`);
            await tconn.query(retarget(r['Create Table'], srcDb, dstDb));
          }
          if (data) {
            const [cols] = await sconn.query(
              `SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND EXTRA NOT LIKE '%GENERATED%'
                ORDER BY ORDINAL_POSITION`, [srcDb, tb.name]);
            const names = cols.map((c) => quoteId(c.name)).join(', ');
            const [[cnt]] = await sconn.query(`SELECT COUNT(*) AS n FROM ${src}`);
            tb.total = Number(cnt.n);
            const head = `INSERT INTO ${quoteId(tb.name)} (${names}) VALUES `;
            let batch = []; let bytes = 0;
            const flush = async () => {
              if (!batch.length) return;
              await tconn.query(head + batch.join(','));
              tb.rows += batch.length;
              batch = []; bytes = 0;
            };
            const stream = sconn.connection
              .query({ sql: `SELECT ${names} FROM ${src}`, rowsAsArray: true, typeCast: rawTypeCast })
              .stream({ highWaterMark: 500 });
            for await (const row of stream) {
              if (job.cancelled) { stream.destroy(); break; }
              const tuple = `(${row.map(sqlLiteral).join(',')})`;
              batch.push(tuple);
              bytes += tuple.length;
              if (batch.length >= 500 || bytes > 1_000_000) await flush();
            }
            if (!job.cancelled) await flush();
          }
          tb.status = job.cancelled ? 'cancelled' : 'done';
        } catch (e) {
          tb.status = 'error';
          tb.error = e.sqlMessage || e.message;
        }
      }
      job.status = job.cancelled ? 'cancelled' : job.tables.some((x) => x.status === 'error') ? 'partial' : 'done';
    } catch (e) {
      job.status = 'error';
      job.error = e.sqlMessage || e.message;
    } finally {
      await tconn.query('SET SESSION FOREIGN_KEY_CHECKS = 1, UNIQUE_CHECKS = 1').catch(() => {});
      sconn.release(); tconn.release();
      job.finishedAt = Date.now();
      setTimeout(() => jobs.delete(job.id), 30 * 60 * 1000);
    }
  })();
  return job;
}

export function jobState(id) {
  const j = jobs.get(id);
  if (!j) return null;
  const { cancelled, ...pub } = j;
  return pub;
}
export function cancelJob(id) {
  const j = jobs.get(id);
  if (j) j.cancelled = true;
  return !!j;
}

export function registerTools(app, { h, getPool, getConnectionRaw }) {
  app.post('/api/tools/compare', h(async (req, res) => {
    const { source, target, includeDrops, routines } = req.body || {};
    const [sp, tp] = await Promise.all([getPool(source.connId), getPool(target.connId)]);
    res.json(await compareSchemas(sp, source.db, tp, target.db, { includeDrops: !!includeDrops, routines: routines !== false }));
  }));
  app.post('/api/tools/copy', h(async (req, res) => {
    const { source, target, tables = [], structure, data, dropExisting, createDb } = req.body || {};
    if (!tables.length) throw new Error('Elige al menos una tabla');
    if (source.connId === target.connId && source.db === target.db) throw new Error('El origen y el destino son la misma base de datos');
    if (getConnectionRaw(target.connId)?.readOnly) throw new Error('La conexión destino es de solo lectura.');
    const [srcPool, dstPool] = await Promise.all([getPool(source.connId), getPool(target.connId)]);
    const job = startCopy({ srcPool, srcDb: source.db, dstPool, dstDb: target.db, tables, structure: structure !== false, data: data !== false, dropExisting: !!dropExisting, createDb: createDb !== false });
    res.json({ id: job.id });
  }));
  app.get('/api/tools/jobs/:jid', h(async (req, res) => {
    const j = jobState(req.params.jid);
    if (!j) return res.status(404).json({ error: 'Job not found' });
    res.json(j);
  }));
  app.post('/api/tools/jobs/:jid/cancel', h(async (req, res) => res.json({ ok: cancelJob(req.params.jid) })));
}
