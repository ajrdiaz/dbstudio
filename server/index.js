import express from 'express';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  listConnections, getConnectionRaw, createConnection,
  updateConnection, deleteConnection, encrypt, decrypt, mergeForTest,
} from './store.js';
import { getPool, closePool, closeAllPools, testConfig, buildConfig } from './pools.js';
import { dataDir, dataSource, HOME_DIR, keyFile, keySynced, inspectDir, setDataDir, detectCloudFolders } from './paths.js';
import {
  quoteId, quoteVal, listDatabases, listObjects, tableColumns,
  tableIndexes, tableForeignKeys, createTableDDL, primaryKey, columnMeta,
} from './sql.js';
import {
  listQueries, createQuery, updateQuery, deleteQuery,
  addHistory, listHistory, clearHistory,
  getWorkspace, saveWorkspace,
} from './workspace.js';
import { buildCreateTable, buildAlterTable } from './ddl.js';
import { registerAdmin, registerTopQueries } from './admin.js';
import { registerTools } from './tools.js';
import { registerObjects } from './objects.js';
import { registerDbInfo } from './dbinfo.js';
import { assertWritable } from './sqlKind.js';
import { registerSessions, getSession, refreshTxState, publicState, closeSessionsFor } from './sessions.js';

const app = express();

// Local-only API: refuse requests that don't come from DBStudio's own UI.
// - Host must be the loopback name (blocks DNS-rebinding from web pages).
// - A browser Origin, when sent, must be a loopback origin too (blocks any
//   website you visit from calling this API with your saved connections).
// Set DBSTUDIO_ALLOW_REMOTE=1 only behind your own authentication.
const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
app.use((req, res, next) => {
  if (process.env.DBSTUDIO_ALLOW_REMOTE === '1') return next();
  const host = String(req.headers.host || '');
  const origin = req.headers.origin;
  let originOk = true;
  if (origin && origin !== 'null') {
    try { originOk = LOOPBACK.test(new URL(origin).host); } catch { originOk = false; }
  } else if (origin === 'null') originOk = false;
  if (!LOOPBACK.test(host) || !originOk) return res.status(403).json({ error: 'Origen no permitido' });
  next();
});
app.use(express.json({ limit: '50mb' }));

// Wrap async handlers so thrown errors become clean JSON responses.
const h = (fn) => (req, res) => fn(req, res).catch((err) => {
  res.status(400).json({ error: err.sqlMessage || err.message || String(err), code: err.code || null });
});

// Read-only connections: refuse every modifying request for that connection
// (designer, row saves, import, drops, admin actions, ...). Reads, exports and
// SQL previews stay allowed; /query checks each statement itself.
const READONLY_SAFE = [/^\/query$/, /\/export(-rows)?$/, /^\/admin\/users\/grants$/];
app.use('/api/connections/:id', (req, res, next) => {
  if (req.method === 'GET' || req.params.id === 'test' || req.path === '/' || req.body?.preview) return next();
  if (/\/maintenance$/.test(req.path) && req.body?.op === 'check') return next();
  if (READONLY_SAFE.some((r) => r.test(req.path))) return next();
  if (getConnectionRaw(req.params.id)?.readOnly) {
    return res.status(403).json({ error: 'Conexión de solo lectura: no se permiten cambios.' });
  }
  next();
});

// ---------- Connection profiles ----------
app.get('/api/connections', h(async (_req, res) => {
  res.json(listConnections());
}));

app.post('/api/connections', h(async (req, res) => {
  res.json(createConnection(req.body));
}));

app.put('/api/connections/:id', h(async (req, res) => {
  const updated = updateConnection(req.params.id, req.body);
  if (!updated) return res.status(404).json({ error: 'Not found' });
  await closePool(req.params.id); // force fresh pool with new settings
  res.json(updated);
}));

app.delete('/api/connections/:id', h(async (req, res) => {
  await closePool(req.params.id);
  closeSessionsFor(req.params.id);
  res.json({ ok: deleteConnection(req.params.id) });
}));

// Test either a saved profile (by id) or an ad-hoc body.
app.post('/api/connections/test', h(async (req, res) => {
  const b = req.body || {};
  const raw = b.id ? mergeForTest(b.id, b) : b;
  if (!raw) return res.status(404).json({ error: 'Not found' });
  res.json(await testConfig(raw));
}));

// ---------- Schema tree ----------
app.get('/api/connections/:id/databases', h(async (req, res) => {
  const pool = await getPool(req.params.id);
  res.json(await listDatabases(pool));
}));

app.get('/api/connections/:id/databases/:db/objects', h(async (req, res) => {
  const pool = await getPool(req.params.id);
  res.json(await listObjects(pool, req.params.db));
}));

app.get('/api/connections/:id/databases/:db/tables/:table/structure', h(async (req, res) => {
  const pool = await getPool(req.params.id);
  const { db, table } = req.params;
  const [columns, indexes, foreignKeys, ddl] = await Promise.all([
    tableColumns(pool, db, table),
    tableIndexes(pool, db, table),
    tableForeignKeys(pool, db, table),
    createTableDDL(pool, db, table),
  ]);
  res.json({ columns, indexes, foreignKeys, ddl });
}));

// ---------- Schema map for editor autocomplete ----------
app.get('/api/connections/:id/databases/:db/schema-map', h(async (req, res) => {
  const pool = await getPool(req.params.id);
  const [rows] = await pool.query(
    `SELECT table_name AS t, column_name AS c
       FROM information_schema.columns
      WHERE table_schema = ?
      ORDER BY table_name, ordinal_position`,
    [req.params.db]
  );
  const tables = {};
  for (const r of rows) {
    (tables[r.t] = tables[r.t] || []).push(r.c);
  }
  res.json({ tables });
}));

// ---------- Visual table designer: create ----------
app.post('/api/connections/:id/databases/:db/tables', h(async (req, res) => {
  const pool = await getPool(req.params.id);
  const sql = buildCreateTable({ db: req.params.db, ...req.body });
  if (req.body?.preview) return res.json({ sql });
  await pool.query(sql);
  res.json({ ok: true, sql });
}));

// ---------- Visual table designer: alter ----------
app.post('/api/connections/:id/databases/:db/tables/:table/alter', h(async (req, res) => {
  const pool = await getPool(req.params.id);
  const sql = buildAlterTable({ db: req.params.db, table: req.params.table, ...req.body });
  if (!sql.trim()) return res.json({ ok: true, sql: '', info: 'No changes' });
  if (req.body?.preview) return res.json({ sql });
  await pool.query(sql);
  res.json({ ok: true, sql });
}));

// ---------- Table data (paged) ----------
app.get('/api/connections/:id/databases/:db/tables/:table/data', h(async (req, res) => {
  const pool = await getPool(req.params.id);
  const { db, table } = req.params;
  const limit = Math.min(Number(req.query.limit) || 100, 5000);
  const offset = Number(req.query.offset) || 0;
  const orderBy = req.query.orderBy ? String(req.query.orderBy) : null;
  const dir = String(req.query.dir).toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
  const where = req.query.where ? String(req.query.where).trim() : '';

  const fq = `${quoteId(db)}.${quoteId(table)}`;
  let sql = `SELECT * FROM ${fq}`;
  if (where) sql += ` WHERE ${where}`;
  if (orderBy) sql += ` ORDER BY ${quoteId(orderBy)} ${dir}`;
  sql += ` LIMIT ${limit} OFFSET ${offset}`;

  const [rows, fields] = await pool.query({ sql, rowsAsArray: true });
  let total = null;
  try {
    const [c] = await pool.query(
      `SELECT COUNT(*) AS n FROM ${fq}${where ? ` WHERE ${where}` : ''}`
    );
    total = Number(c[0].n);
  } catch { /* ignore count failures on big/virtual tables */ }

  const [pk, meta] = await Promise.all([primaryKey(pool, db, table), columnMeta(pool, db, table)]);
  res.json({
    columns: fields.map((f) => ({ name: f.name, type: f.columnType, meta: meta[f.orgName || f.name] || null })),
    rows,
    total,
    primaryKey: pk,
  });
}));

// ---------- Row mutations from the grid ----------
// body: { inserts: [ {col:val} ], updates: [ {pk:{...}, changes:{...}} ], deletes: [ {pk:{...}} ] }
app.post('/api/connections/:id/databases/:db/tables/:table/rows', h(async (req, res) => {
  const pool = await getPool(req.params.id);
  const { db, table } = req.params;
  const fq = `${quoteId(db)}.${quoteId(table)}`;
  const { inserts = [], updates = [], deletes = [], preview = false, session } = req.body || {};
  const statements = [];
  for (const d of deletes) {
    const whereClause = buildPkWhere(d.pk);
    if (whereClause) statements.push(`DELETE FROM ${fq} WHERE ${whereClause} LIMIT 1`);
  }
  for (const u of updates) {
    const set = Object.entries(u.changes || {}).map(([c, v]) => `${quoteId(c)} = ${quoteVal(v)}`).join(', ');
    const whereClause = buildPkWhere(u.pk);
    if (set && whereClause) statements.push(`UPDATE ${fq} SET ${set} WHERE ${whereClause} LIMIT 1`);
  }
  for (const row of inserts) {
    const cols = Object.keys(row);
    statements.push(cols.length
      ? `INSERT INTO ${fq} (${cols.map(quoteId).join(', ')}) VALUES (${cols.map((c) => quoteVal(row[c])).join(', ')})`
      : `INSERT INTO ${fq} () VALUES ()`);
  }
  if (preview) return res.json({ statements });

  // From a query tab in manual-transaction mode the edits join that open
  // transaction (the user commits or rolls back); otherwise they commit here.
  const sess = session ? getSession(session, req.params.id) : null;
  if (sess && !sess.autocommit) {
    if (sess.busy) throw new Error('Esta pestaña ya está ejecutando una consulta.');
    sess.busy = true;
    let affected = 0;
    try {
      for (const sql of statements) {
        const [r] = await sess.conn.query(sql);
        affected += r.affectedRows || 0;
      }
    } finally {
      await refreshTxState(sess);
      sess.busy = false;
    }
    return res.json({ ok: true, affected, statements, inTransaction: true, session: publicState(sess) });
  }
  const conn = await pool.getConnection();
  let affected = 0;
  try {
    await conn.beginTransaction();
    for (const sql of statements) {
      const [r] = await conn.query(sql);
      affected += r.affectedRows || 0;
    }
    await conn.commit();
    res.json({ ok: true, affected, statements });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}));

function buildPkWhere(pk) {
  const parts = Object.entries(pk || {}).map(([c, v]) =>
    v === null ? `${quoteId(c)} IS NULL` : `${quoteId(c)} = ${quoteVal(v)}`
  );
  return parts.join(' AND ');
}

// ---------- Arbitrary SQL execution ----------
// Runs one or more statements; returns an array of result sets / status.
app.post('/api/connections/:id/query', h(async (req, res) => {
  const pool = await getPool(req.params.id);
  // body: { statements: [sql, ...] } (run in order on one session, stopping at
  // the first error, like SQLyog) or the legacy { sql } (one batch).
  // session: run on the tab's dedicated connection (transactions, cancel).
  // limit: cap rows returned by top-level SELECTs (sql_select_limit).
  const { sql, statements, database, session, limit } = req.body || {};
  const list = (Array.isArray(statements) && statements.length ? statements : [sql])
    .filter((x) => typeof x === 'string' && x.trim());
  if (!list.length) return res.status(400).json({ error: 'Empty SQL' });
  assertWritable(getConnectionRaw(req.params.id), list, 'ejecutar sentencias que modifican datos');
  const sess = session ? getSession(session, req.params.id) : null;
  if (sess?.busy) throw new Error('Esta pestaña ya está ejecutando una consulta.');
  const conn = sess ? sess.conn : await pool.getConnection();
  if (sess) sess.busy = true;
  const started = Date.now();
  const results = [];
  let error = null;
  try {
    if (database) await conn.query(`USE ${quoteId(database)}`);
    const lim = Number(limit);
    await conn.query(`SET SESSION sql_select_limit = ${Number.isInteger(lim) && lim > 0 ? lim : 'DEFAULT'}`);
    const metaCache = new Map();
    for (let i = 0; i < list.length; i++) {
      const t0 = Date.now();
      try {
        const [res1, fields] = await conn.query({ sql: list[i], rowsAsArray: true });
        const sets = normalizeResults(res1, fields, Date.now() - t0).results;
        for (const set of sets) {
          set.statement = i;
          set.sql = list[i];
          if (set.type === 'rows') set.edit = await editInfo(conn, set.fields, metaCache);
          delete set.fields;
        }
        results.push(...sets);
      } catch (err) {
        error = { statement: i, sql: list[i], message: err.sqlMessage || err.message, code: err.code || null, elapsedMs: Date.now() - t0 };
        break;
      }
    }
  } finally {
    if (sess) {
      await refreshTxState(sess);
      sess.busy = false;
    } else {
      // Pooled connections go back clean.
      await conn.query('SET SESSION sql_select_limit = DEFAULT').catch(() => {});
      conn.release();
    }
  }
  const elapsedMs = Date.now() - started;
  const summary = error
    ? error.message
    : results.map((r) => (r.type === 'rows' ? `${r.rowCount} rows` : `${r.affectedRows} affected`)).join(', ');
  addHistory({ sql: list.join(';\n'), connectionId: req.params.id, database, ok: !error, summary, elapsedMs });
  res.json({ results, error, statements: list.length, elapsedMs, limit: Number(limit) || null, session: sess ? publicState(sess) : null });
}));

// Can this result set be edited in place? Only when every column that maps to
// a real table comes from the same table and that table's whole primary key is
// present — then edits are saved through the rows endpoint by PK, like SQLyog.
async function editInfo(conn, fields, cache) {
  const src = (fields || []).filter((f) => f.orgTable);
  if (!src.length) return null;
  const { schema, orgTable } = src[0];
  if (!schema || src.some((f) => f.schema !== schema || f.orgTable !== orgTable)) {
    return { editable: false, reason: 'multi' };
  }
  const key = `${schema}.${orgTable}`;
  if (!cache.has(key)) {
    const [pk, meta] = await Promise.all([primaryKey(conn, schema, orgTable), columnMeta(conn, schema, orgTable)]);
    cache.set(key, { pk, meta });
  }
  const { pk, meta } = cache.get(key);
  const seen = new Set();
  // Result column index -> real column name (null = read-only: expression or repeat).
  const columns = fields.map((f) => {
    if (f.orgTable !== orgTable || !f.orgName || seen.has(f.orgName) || !meta[f.orgName]) return null;
    seen.add(f.orgName);
    return f.orgName;
  });
  const base = { db: schema, table: orgTable, primaryKey: pk, columns, meta };
  if (!pk.length) return { ...base, editable: false, reason: 'nopk' };
  if (pk.some((k) => !columns.includes(k))) return { ...base, editable: false, reason: 'pkmissing' };
  return { ...base, editable: true };
}

// ---------- Saved queries ----------
app.get('/api/queries', h(async (_req, res) => res.json(listQueries())));
app.post('/api/queries', h(async (req, res) => res.json(createQuery(req.body))));
app.put('/api/queries/:qid', h(async (req, res) => {
  const q = updateQuery(req.params.qid, req.body);
  if (!q) return res.status(404).json({ error: 'Not found' });
  res.json(q);
}));
app.delete('/api/queries/:qid', h(async (req, res) => res.json({ ok: deleteQuery(req.params.qid) })));

// ---------- Query history ----------
app.get('/api/history', h(async (req, res) => res.json(listHistory(Number(req.query.limit) || 200))));
app.delete('/api/history', h(async (_req, res) => res.json({ ok: clearHistory() })));

// ---------- Workspace (open tabs) ----------
// ---------- Storage location (data folder) ----------
const storageInfo = () => ({
  dataDir: dataDir(),
  defaultDir: HOME_DIR,
  source: dataSource(), // default | config | env
  keyFile: keyFile(),
  keySynced: keySynced(),
  current: inspectDir(dataDir()),
  suggestions: detectCloudFolders(),
});
app.get('/api/settings/storage', h(async (_req, res) => res.json(storageInfo())));
app.post('/api/settings/storage/inspect', h(async (req, res) => res.json(inspectDir(String(req.body?.dir || '')))));
app.put('/api/settings/storage', h(async (req, res) => {
  const { dir, mode, includeKey } = req.body || {};
  setDataDir(String(dir || ''), { mode, includeKey: !!includeKey });
  await closeAllPools(); // connection profiles may differ in the new folder
  res.json(storageInfo());
}));

app.get('/api/workspace', h(async (_req, res) => res.json(getWorkspace())));
app.put('/api/workspace', h(async (req, res) => res.json({ ok: saveWorkspace(req.body || {}) })));

// mysql2 returns different shapes for single vs multi-statement; normalize to
// an array of { type, columns?, rows?, affectedRows?, insertId?, elapsedMs }.
// Single SELECT  -> results = [rowObj,...], fields = [fieldObj,...]
// Single OK      -> results = ResultSetHeader, fields = undefined
// Multi-statement-> results = [resultSet,...], fields = [fieldArr|undefined,...]
function normalizeResults(results, fields, elapsedMs) {
  const sets = [];
  const add = (rows, flds) => {
    if (Array.isArray(rows)) {
      sets.push({
        type: 'rows',
        columns: (flds || []).map((f) => ({ name: f.name, type: f.columnType })),
        rows,
        rowCount: rows.length,
        elapsedMs,
        fields: flds || [], // raw field defs; consumed by editInfo, not sent
      });
    } else {
      sets.push({
        type: 'ok',
        affectedRows: rows?.affectedRows ?? 0,
        insertId: rows?.insertId ?? 0,
        info: rows?.info || '',
        elapsedMs,
      });
    }
  };

  // Multi-statement iff `fields` is a parallel array whose entries are
  // themselves field-arrays (SELECT) or undefined (OK packet).
  const multi =
    Array.isArray(results) &&
    Array.isArray(fields) &&
    fields.length > 0 &&
    (fields[0] === undefined || Array.isArray(fields[0]));

  if (multi) {
    results.forEach((r, i) => add(r, fields[i]));
  } else {
    add(results, fields);
  }
  return { results: sets };
}

// ---------- Export: SQL dump of selected tables ----------
app.post('/api/connections/:id/databases/:db/export', h(async (req, res) => {
  const pool = await getPool(req.params.id);
  const { db } = req.params;
  const { tables = [], structure = true, data = true } = req.body || {};
  let list = tables;
  if (!list.length) {
    const objs = await listObjects(pool, db);
    list = objs.tables.map((t) => t.name);
  }
  let out = `-- DBStudio dump of \`${db}\`\n-- Generated ${new Date().toISOString()}\n\n`;
  out += 'SET FOREIGN_KEY_CHECKS=0;\n\n';
  for (const t of list) {
    if (structure) {
      const ddl = await createTableDDL(pool, db, t);
      out += `DROP TABLE IF EXISTS ${quoteId(t)};\n${ddl};\n\n`;
    }
    if (data) {
      const [rows, fields] = await pool.query(`SELECT * FROM ${quoteId(db)}.${quoteId(t)}`);
      if (rows.length) {
        const cols = fields.map((f) => f.name);
        out += `INSERT INTO ${quoteId(t)} (${cols.map(quoteId).join(', ')}) VALUES\n`;
        out += rows
          .map((r) => '(' + cols.map((c) => quoteVal(r[c])).join(', ') + ')')
          .join(',\n');
        out += ';\n\n';
      }
    }
  }
  out += 'SET FOREIGN_KEY_CHECKS=1;\n';
  res.type('application/sql').send(out);
}));

// ---------- Export: result rows to CSV / JSON ----------
app.post('/api/connections/:id/export-rows', h(async (req, res) => {
  const { rows = [], columns = [], format = 'csv' } = req.body || {};
  if (format === 'json') {
    res.type('application/json').send(JSON.stringify(rows, null, 2));
    return;
  }
  const cols = columns.length ? columns : (rows[0] ? Object.keys(rows[0]) : []);
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  let csv = cols.join(',') + '\n';
  csv += rows.map((r) => cols.map((c) => esc(r[c])).join(',')).join('\n');
  res.type('text/csv').send(csv);
}));

// ---------- Import: run an uploaded .sql script ----------
app.post('/api/connections/:id/databases/:db/import', h(async (req, res) => {
  const pool = await getPool(req.params.id);
  const { db } = req.params;
  const { sql } = req.body || {};
  if (!sql) return res.status(400).json({ error: 'No SQL provided' });
  const conn = await pool.getConnection();
  try {
    if (db) await conn.query(`USE ${quoteId(db)}`);
    const started = Date.now();
    await conn.query(sql);
    res.json({ ok: true, elapsedMs: Date.now() - started });
  } finally {
    conn.release();
  }
}));

// ---------- Create / drop database ----------
app.post('/api/connections/:id/databases', h(async (req, res) => {
  const pool = await getPool(req.params.id);
  const { name, charset, collation } = req.body || {};
  let sql = `CREATE DATABASE ${quoteId(name)}`;
  if (charset) sql += ` CHARACTER SET ${quoteId(charset)}`;
  if (collation) sql += ` COLLATE ${quoteId(collation)}`;
  await pool.query(sql);
  res.json({ ok: true });
}));

app.delete('/api/connections/:id/databases/:db', h(async (req, res) => {
  const pool = await getPool(req.params.id);
  await pool.query(`DROP DATABASE ${quoteId(req.params.db)}`);
  res.json({ ok: true });
}));

app.delete('/api/connections/:id/databases/:db/tables/:table', h(async (req, res) => {
  const pool = await getPool(req.params.id);
  await pool.query(`DROP TABLE ${quoteId(req.params.db)}.${quoteId(req.params.table)}`);
  res.json({ ok: true });
}));

app.get('/api/health', (_req, res) => res.json({ ok: true }));

registerAdmin(app, { h, getPool });
registerTopQueries(app, { h, getPool });
registerSessions(app, { h, getPool });
registerObjects(app, { h, getPool });
registerDbInfo(app, { h, getPool });
registerTools(app, { h, getPool, getConnectionRaw });

// Start the API (used by `node index.js` and by the desktop app).
// Listens on the loopback interface only, unless HOST says otherwise.
// staticDir: also serve the built UI (desktop app / production).
export function start({
  port = Number(process.env.PORT) || 4000,
  host = process.env.HOST || '127.0.0.1',
  staticDir = process.env.STATIC_DIR,
} = {}) {
  if (staticDir) {
    app.use(express.static(staticDir));
    app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(staticDir, 'index.html')));
  }
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => resolve({ server, port: server.address().port, host }));
    server.on('error', reject);
  });
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  start().then(({ port, host }) => console.log(`DBStudio API listening on http://${host}:${port}`));
}
