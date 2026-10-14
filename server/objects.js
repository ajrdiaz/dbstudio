// Object search across all databases of a connection (like pgAdmin's
// "Search objects") and DDL of any object (to open it in the editor).
import { quoteId } from './sql.js';

const SYSTEM = ['information_schema', 'mysql', 'performance_schema', 'sys'];
const likeEscape = (s) => s.replace(/[\\%_]/g, (c) => '\\' + c);
const KINDS = ['table', 'view', 'column', 'procedure', 'function', 'trigger', 'event'];

export async function searchObjects(pool, { q, types = KINDS, includeSystem = false, inCode = false, limit = 200 }) {
  const term = String(q || '').trim();
  if (term.length < 2) return { results: [], truncated: false };
  const like = `%${likeEscape(term)}%`;
  // [extra WHERE clause, its params] excluding system schemas unless asked.
  const sys = (col) => (includeSystem ? ['', []] : [`AND ${col} NOT IN (${SYSTEM.map(() => '?').join(',')})`, SYSTEM]);
  const want = new Set(types);
  const out = [];
  let truncated = false;
  const run = async (sql, params) => {
    const [rows] = await pool.query(sql + ` LIMIT ${limit + 1}`, params);
    if (rows.length > limit) { truncated = true; rows.length = limit; }
    return rows;
  };

  if (want.has('table') || want.has('view')) {
    const [f, p] = sys('TABLE_SCHEMA');
    const rows = await run(
      `SELECT TABLE_SCHEMA AS db, TABLE_NAME AS name, TABLE_TYPE AS t, TABLE_ROWS AS rowsApprox, TABLE_COMMENT AS comment
         FROM information_schema.TABLES WHERE TABLE_NAME LIKE ? ${f} ORDER BY TABLE_SCHEMA, TABLE_NAME`, [like, ...p]);
    for (const r of rows) {
      const kind = r.t === 'VIEW' ? 'view' : 'table';
      const detail = kind === 'view' ? '' : r.comment || (r.rowsApprox != null ? `~${r.rowsApprox} filas` : '');
      if (want.has(kind)) out.push({ kind, db: r.db, name: r.name, detail });
    }
  }
  if (want.has('column')) {
    const [f, p] = sys('TABLE_SCHEMA');
    const rows = await run(
      `SELECT TABLE_SCHEMA AS db, TABLE_NAME AS tableName, COLUMN_NAME AS name, COLUMN_TYPE AS type, COLUMN_KEY AS ckey
         FROM information_schema.COLUMNS WHERE COLUMN_NAME LIKE ? ${f} ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION`, [like, ...p]);
    for (const r of rows) out.push({ kind: 'column', db: r.db, table: r.tableName, name: r.name, detail: `${r.type}${r.ckey === 'PRI' ? ' · PK' : ''}` });
  }
  if (want.has('procedure') || want.has('function')) {
    const [f, p] = sys('ROUTINE_SCHEMA');
    const code = inCode ? ' OR ROUTINE_DEFINITION LIKE ?' : '';
    const rows = await run(
      `SELECT ROUTINE_SCHEMA AS db, ROUTINE_NAME AS name, ROUTINE_TYPE AS t, ROUTINE_NAME LIKE ? AS byName
         FROM information_schema.ROUTINES WHERE (ROUTINE_NAME LIKE ?${code}) ${f} ORDER BY ROUTINE_SCHEMA, ROUTINE_NAME`,
      [like, like, ...(inCode ? [like] : []), ...p]);
    for (const r of rows) {
      const kind = r.t === 'FUNCTION' ? 'function' : 'procedure';
      if (want.has(kind)) out.push({ kind, db: r.db, name: r.name, detail: Number(r.byName) ? '' : 'coincide en el código' });
    }
  }
  if (inCode && want.has('view')) {
    const [f, p] = sys('TABLE_SCHEMA');
    const rows = await run(
      `SELECT TABLE_SCHEMA AS db, TABLE_NAME AS name FROM information_schema.VIEWS
        WHERE VIEW_DEFINITION LIKE ? AND TABLE_NAME NOT LIKE ? ${f} ORDER BY TABLE_SCHEMA, TABLE_NAME`, [like, like, ...p]);
    for (const r of rows) out.push({ kind: 'view', db: r.db, name: r.name, detail: 'coincide en el código' });
  }
  if (want.has('trigger')) {
    const [f, p] = sys('TRIGGER_SCHEMA');
    const code = inCode ? ' OR ACTION_STATEMENT LIKE ?' : '';
    const rows = await run(
      `SELECT TRIGGER_SCHEMA AS db, TRIGGER_NAME AS name, EVENT_OBJECT_TABLE AS tableName, ACTION_TIMING AS timing, EVENT_MANIPULATION AS ev
         FROM information_schema.TRIGGERS WHERE (TRIGGER_NAME LIKE ?${code}) ${f} ORDER BY TRIGGER_SCHEMA, TRIGGER_NAME`,
      [like, ...(inCode ? [like] : []), ...p]);
    for (const r of rows) out.push({ kind: 'trigger', db: r.db, name: r.name, table: r.tableName, detail: `${r.timing} ${r.ev} ON ${r.tableName}` });
  }
  if (want.has('event')) {
    const [f, p] = sys('EVENT_SCHEMA');
    try {
      const rows = await run(
        `SELECT EVENT_SCHEMA AS db, EVENT_NAME AS name, STATUS AS status FROM information_schema.EVENTS
          WHERE EVENT_NAME LIKE ? ${f} ORDER BY EVENT_SCHEMA, EVENT_NAME`, [like, ...p]);
      for (const r of rows) out.push({ kind: 'event', db: r.db, name: r.name, detail: r.status });
    } catch { /* no EVENT privilege */ }
  }
  return { results: out, truncated };
}

const SHOW = {
  table: ['TABLE', 'Create Table'],
  view: ['VIEW', 'Create View'],
  procedure: ['PROCEDURE', 'Create Procedure'],
  function: ['FUNCTION', 'Create Function'],
  trigger: ['TRIGGER', 'SQL Original Statement'],
  event: ['EVENT', 'Create Event'],
};

// DDL ready to edit in the SQL editor; routines/triggers/events get a
// DELIMITER block with DROP + CREATE so the script can be re-run as is.
export async function objectDDL(pool, db, kind, name) {
  const spec = SHOW[kind];
  if (!spec) throw new Error('Tipo de objeto no válido');
  const fq = `${quoteId(db)}.${quoteId(name)}`;
  const [[row]] = await pool.query(`SHOW CREATE ${spec[0]} ${fq}`);
  const def = row?.[spec[1]];
  if (!def) throw new Error('No se pudo leer la definición (¿faltan privilegios?)');
  if (kind === 'table') return `${def};`;
  if (kind === 'view') return `${def.replace(/^CREATE\s+/i, 'CREATE OR REPLACE ')};`;
  return `DELIMITER $$\nDROP ${spec[0]} IF EXISTS ${quoteId(name)}$$\n${def}$$\nDELIMITER ;\n`;
}

export function registerObjects(app, { h, getPool }) {
  app.get('/api/connections/:id/search', h(async (req, res) => {
    const pool = await getPool(req.params.id);
    const types = String(req.query.types || '').split(',').filter((x) => KINDS.includes(x));
    res.json(await searchObjects(pool, {
      q: req.query.q,
      types: types.length ? types : KINDS,
      includeSystem: req.query.system === '1',
      inCode: req.query.code === '1',
    }));
  }));
  app.get('/api/connections/:id/databases/:db/ddl/:kind/:name', h(async (req, res) => {
    const pool = await getPool(req.params.id);
    res.json({ sql: await objectDDL(pool, req.params.db, req.params.kind, req.params.name) });
  }));
}
