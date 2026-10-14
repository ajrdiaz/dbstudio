// Per-database tools: table statistics + maintenance (ANALYZE / OPTIMIZE /
// CHECK / REPAIR), and the model for the ER diagram (tables, columns, FKs).
import { quoteId, quoteVal } from './sql.js';

export async function tableStats(pool, db) {
  const [rows] = await pool.query(
    `SELECT TABLE_NAME AS name, ENGINE AS engine, TABLE_ROWS AS rowsApprox, AVG_ROW_LENGTH AS avgRow,
            DATA_LENGTH AS dataBytes, INDEX_LENGTH AS indexBytes, DATA_FREE AS freeBytes,
            AUTO_INCREMENT AS autoIncrement, CREATE_TIME AS created, UPDATE_TIME AS updated,
            TABLE_COLLATION AS collation, ROW_FORMAT AS rowFormat, TABLE_COMMENT AS comment
       FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'
      ORDER BY TABLE_NAME`, [db]);
  return rows.map((r) => {
    const data = Number(r.dataBytes) || 0;
    const index = Number(r.indexBytes) || 0;
    const free = Number(r.freeBytes) || 0;
    return {
      ...r,
      rowsApprox: r.rowsApprox == null ? null : Number(r.rowsApprox),
      dataBytes: data, indexBytes: index, freeBytes: free, totalBytes: data + index,
      // Share of the allocated space that is free (reclaimable by OPTIMIZE).
      fragPct: data + index + free > 0 ? (free / (data + index + free)) * 100 : 0,
    };
  });
}

const OPS = { analyze: 'ANALYZE', optimize: 'OPTIMIZE', check: 'CHECK', repair: 'REPAIR' };
const CHECK_OPTS = ['QUICK', 'FAST', 'MEDIUM', 'EXTENDED', 'CHANGED'];

export function maintenanceSql(db, op, tables, option) {
  const kw = OPS[op];
  if (!kw) throw new Error('Operación no válida');
  if (!tables?.length) throw new Error('Elige al menos una tabla');
  const list = tables.map((t) => `${quoteId(db)}.${quoteId(t)}`).join(', ');
  const opt = op === 'check' && CHECK_OPTS.includes(option) ? ` ${option}` : '';
  return `${kw} TABLE ${list}${opt}`;
}

export async function erdModel(pool, db) {
  const [cols] = await pool.query(
    `SELECT TABLE_NAME AS t, COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable, COLUMN_KEY AS ckey
       FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION`, [db]);
  const [tbls] = await pool.query(
    'SELECT TABLE_NAME AS name, TABLE_TYPE AS type, TABLE_ROWS AS rowsApprox FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME', [db]);
  const [fks] = await pool.query(
    `SELECT CONSTRAINT_NAME AS name, TABLE_NAME AS fromTable, COLUMN_NAME AS fromCol,
            REFERENCED_TABLE_SCHEMA AS toDb, REFERENCED_TABLE_NAME AS toTable, REFERENCED_COLUMN_NAME AS toCol
       FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL
      ORDER BY TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION`, [db]);
  const byTable = {};
  for (const t of tbls) byTable[t.name] = { name: t.name, view: t.type === 'VIEW', rowsApprox: t.rowsApprox == null ? null : Number(t.rowsApprox), columns: [] };
  for (const c of cols) {
    byTable[c.t]?.columns.push({ name: c.name, type: c.type, nullable: c.nullable === 'YES', pk: c.ckey === 'PRI', unique: c.ckey === 'UNI', indexed: !!c.ckey });
  }
  // Group multi-column FKs.
  const rel = {};
  for (const f of fks) {
    const k = `${f.fromTable}.${f.name}`;
    (rel[k] ||= { name: f.name, fromTable: f.fromTable, toTable: f.toTable, external: f.toDb !== db, fromCols: [], toCols: [] });
    rel[k].fromCols.push(f.fromCol);
    rel[k].toCols.push(f.toCol);
  }
  return { tables: Object.values(byTable), relations: Object.values(rel) };
}

// ---------------------------------------------------------------------------
// Import rows (CSV / Excel) into an existing or new table, one batch per call
// so the client can show progress.
// ---------------------------------------------------------------------------
const TYPE_RE = /^(TINYINT|SMALLINT|MEDIUMINT|INT|BIGINT|DECIMAL\(\d{1,2},\d{1,2}\)|DOUBLE|FLOAT|DATE|DATETIME|TIME|YEAR|VARCHAR\(\d{1,5}\)|CHAR\(\d{1,3}\)|TEXT|MEDIUMTEXT|LONGTEXT|BOOLEAN|JSON)$/i;

export function createTableSql(table, columns, addId) {
  if (!columns?.length) throw new Error('No hay columnas para crear la tabla');
  const defs = columns.map((c) => {
    if (!TYPE_RE.test(String(c.type || ''))) throw new Error(`Tipo no permitido para ${c.name}: ${c.type}`);
    return `  ${quoteId(c.name)} ${c.type.toUpperCase()} NULL`;
  });
  if (addId) defs.unshift('  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY');
  return `CREATE TABLE ${quoteId(table)} (\n${defs.join(',\n')}\n)`;
}

export function insertSql(table, cols, rows, mode) {
  const head = mode === 'replace' ? 'REPLACE' : mode === 'ignore' ? 'INSERT IGNORE' : 'INSERT';
  const values = rows.map((r) => `(${cols.map((_, i) => quoteVal(r[i] === undefined ? null : r[i])).join(', ')})`).join(',\n');
  let sql = `${head} INTO ${quoteId(table)} (${cols.map(quoteId).join(', ')}) VALUES\n${values}`;
  if (mode === 'update') sql += `\nON DUPLICATE KEY UPDATE ${cols.map((c) => `${quoteId(c)} = VALUES(${quoteId(c)})`).join(', ')}`;
  return sql;
}

export function registerDbInfo(app, { h, getPool }) {
  // body: { table, columns: [target col], rows: [[...]], mode: insert|ignore|update|replace,
  //         create?: { columns: [{name,type}], addId }, truncate?, preview? }
  app.post('/api/connections/:id/databases/:db/import-rows', h(async (req, res) => {
    const { table, columns = [], rows = [], mode = 'insert', create, truncate, preview } = req.body || {};
    if (!table) throw new Error('Falta la tabla destino');
    if (!columns.length) throw new Error('No hay columnas para importar');
    const statements = [];
    if (create) statements.push(createTableSql(table, create.columns, create.addId));
    if (truncate) statements.push(`TRUNCATE TABLE ${quoteId(table)}`);
    if (rows.length) statements.push(insertSql(table, columns, rows, mode));
    if (preview) return res.json({ statements: statements.map((x) => (x.length > 2000 ? x.slice(0, 2000) + '\n…' : x)) });
    const pool = await getPool(req.params.id);
    const conn = await pool.getConnection();
    try {
      await conn.query(`USE ${quoteId(req.params.db)}`);
      let affected = 0; let warnings = 0;
      for (const sql of statements) {
        const [r] = await conn.query(sql);
        affected += r.affectedRows || 0;
        warnings += r.warningStatus || 0;
      }
      res.json({ ok: true, affected, warnings });
    } finally {
      conn.release();
    }
  }));

  app.get('/api/connections/:id/databases/:db/table-stats', h(async (req, res) => {
    const pool = await getPool(req.params.id);
    res.json({ tables: await tableStats(pool, req.params.db) });
  }));
  // body: { op, tables: [...], option?, preview? }
  app.post('/api/connections/:id/databases/:db/maintenance', h(async (req, res) => {
    const { op, tables, option, preview } = req.body || {};
    const sql = maintenanceSql(req.params.db, op, tables, option);
    if (preview) return res.json({ sql });
    const pool = await getPool(req.params.id);
    const t0 = Date.now();
    const [rows] = await pool.query(sql);
    res.json({
      sql, elapsedMs: Date.now() - t0,
      results: rows.map((r) => ({ table: r.Table, op: r.Op, type: r.Msg_type, text: r.Msg_text })),
    });
  }));
  app.get('/api/connections/:id/databases/:db/erd', h(async (req, res) => {
    const pool = await getPool(req.params.id);
    res.json(await erdModel(pool, req.params.db));
  }));
}
