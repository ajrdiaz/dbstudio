// Server administration endpoints, like SQLyog's process list, variables /
// status and User Manager. Identifiers and values that reach SQL are either
// whitelisted or quoted.
import { quoteId, quoteVal } from './sql.js';

const PRIVILEGES = [
  'ALL PRIVILEGES', 'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'ALTER', 'INDEX',
  'REFERENCES', 'CREATE VIEW', 'SHOW VIEW', 'TRIGGER', 'EXECUTE', 'CREATE ROUTINE', 'ALTER ROUTINE',
  'EVENT', 'LOCK TABLES', 'CREATE TEMPORARY TABLES', 'PROCESS', 'RELOAD', 'SHUTDOWN', 'SUPER',
  'FILE', 'SHOW DATABASES', 'REPLICATION CLIENT', 'REPLICATION SLAVE', 'CREATE USER',
];

const account = (user, host) => `${quoteVal(String(user ?? ''))}@${quoteVal(String(host ?? '%'))}`;

// `db`.`table` scope for GRANT/REVOKE; '*' stays a wildcard.
function scopeOf(db, table) {
  const d = !db || db === '*' ? '*' : quoteId(db);
  const t = !table || table === '*' ? '*' : quoteId(table);
  return `${d}.${t}`;
}

// "GRANT X ON y TO z [IDENTIFIED BY ...] [WITH GRANT OPTION]" -> REVOKE statements.
export function revokeFor(grantLine) {
  if (grantLine.includes(';')) return [];
  const m = /^GRANT\s+(.+?)\s+ON\s+(.+?)\s+TO\s+(\S+@\S+)(?:\s+IDENTIFIED\s+BY\s+.*?)?(\s+WITH\s+GRANT\s+OPTION)?\s*$/i.exec(grantLine.trim());
  if (!m) return [];
  const [, privs, on, to, withGrant] = m;
  if (/^PROXY\b/i.test(privs)) return [`REVOKE ${privs} ON ${on} FROM ${to}`];
  const out = [];
  if (!/^USAGE$/i.test(privs.trim())) out.push(`REVOKE ${privs} ON ${on} FROM ${to}`);
  if (withGrant) out.push(`REVOKE GRANT OPTION ON ${on} FROM ${to}`);
  return out;
}

export function registerAdmin(app, { h, getPool }) {
  const base = '/api/connections/:id/admin';

  // ---------- processes ----------
  app.get(`${base}/processes`, h(async (req, res) => {
    const pool = await getPool(req.params.id);
    const [rows] = await pool.query('SHOW FULL PROCESSLIST');
    const [[me]] = await pool.query('SELECT CONNECTION_ID() AS id');
    res.json({ rows, ownIds: [Number(me.id)] });
  }));
  app.post(`${base}/processes/:pid/kill`, h(async (req, res) => {
    const pool = await getPool(req.params.id);
    const pid = Number(req.params.pid);
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('Invalid process id');
    await pool.query(`KILL ${req.body?.queryOnly ? 'QUERY ' : ''}${pid}`);
    res.json({ ok: true });
  }));

  // ---------- replication (read-only monitoring) ----------
  app.get(`${base}/replication`, h(async (req, res) => {
    const pool = await getPool(req.params.id);
    res.json(await replicationInfo(pool));
  }));

  // ---------- variables / status ----------
  app.get(`${base}/variables`, h(async (req, res) => {
    const pool = await getPool(req.params.id);
    const kind = req.query.kind === 'status' ? 'STATUS' : 'VARIABLES';
    const scope = req.query.scope === 'session' ? 'SESSION' : 'GLOBAL';
    const [rows] = await pool.query({ sql: `SHOW ${scope} ${kind}`, rowsAsArray: true });
    res.json({ rows: rows.map(([name, value]) => ({ name, value })) });
  }));
  app.post(`${base}/variables`, h(async (req, res) => {
    const pool = await getPool(req.params.id);
    const { name, value } = req.body || {};
    if (!/^[a-z0-9_]+$/i.test(String(name || ''))) throw new Error('Invalid variable name');
    const v = String(value ?? '').trim();
    const raw = /^-?\d+(\.\d+)?$/.test(v) || /^(ON|OFF|TRUE|FALSE|DEFAULT)$/i.test(v) ? v : quoteVal(v);
    const sql = `SET GLOBAL ${name} = ${raw}`;
    await pool.query(sql);
    res.json({ ok: true, sql });
  }));

  // ---------- users & privileges ----------
  app.get(`${base}/users`, h(async (req, res) => {
    const pool = await getPool(req.params.id);
    const [rows] = await pool.query('SELECT User AS user, Host AS host FROM mysql.user ORDER BY User, Host');
    res.json({ rows, privileges: PRIVILEGES });
  }));
  app.post(`${base}/users/grants`, h(async (req, res) => {
    const pool = await getPool(req.params.id);
    const { user, host } = req.body || {};
    const [rows] = await pool.query({ sql: `SHOW GRANTS FOR ${account(user, host)}`, rowsAsArray: true });
    const grants = rows.map(([g]) => ({ grant: g, revoke: revokeFor(g) }));
    res.json({ grants });
  }));

  // Every mutation accepts { preview: true } to just return the SQL.
  const run = async (req, res, statements) => {
    if (req.body?.preview) return res.json({ statements });
    const pool = await getPool(req.params.id);
    const conn = await pool.getConnection();
    try {
      for (const s of statements) await conn.query(s);
    } finally {
      conn.release();
    }
    res.json({ ok: true, statements });
  };

  app.post(`${base}/users/create`, h(async (req, res) => {
    const { user, host = '%', password = '' } = req.body || {};
    if (!user) throw new Error('User name required');
    await run(req, res, [`CREATE USER ${account(user, host)}${password ? ` IDENTIFIED BY ${quoteVal(password)}` : ''}`]);
  }));
  app.post(`${base}/users/password`, h(async (req, res) => {
    const { user, host, password = '' } = req.body || {};
    await run(req, res, [`ALTER USER ${account(user, host)} IDENTIFIED BY ${quoteVal(password)}`]);
  }));
  app.post(`${base}/users/drop`, h(async (req, res) => {
    const { user, host } = req.body || {};
    await run(req, res, [`DROP USER ${account(user, host)}`]);
  }));
  app.post(`${base}/users/grant`, h(async (req, res) => {
    const { user, host, privileges = [], db = '*', table = '*', grantOption = false } = req.body || {};
    const privs = privileges.filter((p) => PRIVILEGES.includes(p));
    if (!privs.length) throw new Error('Choose at least one privilege');
    const list = privs.includes('ALL PRIVILEGES') ? ['ALL PRIVILEGES'] : privs;
    await run(req, res, [`GRANT ${list.join(', ')} ON ${scopeOf(db, table)} TO ${account(user, host)}${grantOption ? ' WITH GRANT OPTION' : ''}`]);
  }));
  app.post(`${base}/users/revoke`, h(async (req, res) => {
    const { grant } = req.body || {};
    const statements = revokeFor(String(grant || ''));
    if (!statements.length) throw new Error('Nothing to revoke for that grant');
    await run(req, res, statements);
  }));
}

// ---------------------------------------------------------------------------
// Replication status, for MySQL 5.7/8.x and MariaDB, old and new terminology.
// ---------------------------------------------------------------------------

// First statement that the server accepts, or null.
async function firstWorking(pool, statements) {
  let lastErr = null;
  for (const sql of statements) {
    try {
      const [rows] = await pool.query(sql);
      return { sql, rows };
    } catch (e) {
      lastErr = e;
      // Missing privilege is the real answer; syntax errors mean "try the next variant".
      if (e.code === 'ER_SPECIFIC_ACCESS_DENIED_ERROR' || e.code === 'ER_DBACCESS_DENIED_ERROR') throw e;
    }
  }
  return { sql: null, rows: [], error: lastErr };
}

const pick = (row, ...keys) => {
  for (const k of keys) if (row[k] !== undefined && row[k] !== null && row[k] !== '') return row[k];
  return null;
};
const yes = (v) => (v == null ? null : String(v));

function normalizeChannel(r) {
  const lag = pick(r, 'Seconds_Behind_Source', 'Seconds_Behind_Master');
  return {
    channel: pick(r, 'Connection_name', 'Channel_Name') || '',
    sourceHost: pick(r, 'Source_Host', 'Master_Host'),
    sourcePort: pick(r, 'Source_Port', 'Master_Port'),
    sourceUser: pick(r, 'Source_User', 'Master_User'),
    ioRunning: yes(pick(r, 'Replica_IO_Running', 'Slave_IO_Running')),
    sqlRunning: yes(pick(r, 'Replica_SQL_Running', 'Slave_SQL_Running')),
    ioState: pick(r, 'Replica_IO_State', 'Slave_IO_State'),
    sqlState: pick(r, 'Replica_SQL_Running_State', 'Slave_SQL_Running_State', 'Slave_SQL_State'),
    secondsBehind: lag == null ? null : Number(lag),
    sqlDelay: Number(pick(r, 'SQL_Delay') || 0),
    sqlRemainingDelay: pick(r, 'SQL_Remaining_Delay'),
    lastIoError: pick(r, 'Last_IO_Error'),
    lastIoErrno: Number(pick(r, 'Last_IO_Errno') || 0),
    lastIoErrorAt: pick(r, 'Last_IO_Error_Timestamp'),
    lastSqlError: pick(r, 'Last_SQL_Error'),
    lastSqlErrno: Number(pick(r, 'Last_SQL_Errno') || 0),
    lastSqlErrorAt: pick(r, 'Last_SQL_Error_Timestamp'),
    sourceLogFile: pick(r, 'Source_Log_File', 'Master_Log_File'),
    readPos: pick(r, 'Read_Source_Log_Pos', 'Read_Master_Log_Pos'),
    execLogFile: pick(r, 'Relay_Source_Log_File', 'Relay_Master_Log_File'),
    execPos: pick(r, 'Exec_Source_Log_Pos', 'Exec_Master_Log_Pos'),
    gtid: pick(r, 'Gtid_IO_Pos', 'Executed_Gtid_Set'),
    usingGtid: pick(r, 'Using_Gtid', 'Auto_Position'),
    raw: r,
  };
}

export async function replicationInfo(pool) {
  const [[server]] = await pool.query(
    'SELECT @@hostname AS hostname, @@server_id AS serverId, @@read_only AS readOnly, VERSION() AS version');
  let superReadOnly = null;
  try { const [[r]] = await pool.query('SELECT @@super_read_only AS v'); superReadOnly = Number(r.v); } catch { /* MariaDB */ }

  const out = {
    server: { ...server, readOnly: Number(server.readOnly), superReadOnly },
    channels: [], replicas: [], binlog: null, error: null,
  };
  try {
    // MariaDB multi-source first (one row per connection), then single-source variants.
    const r = await firstWorking(pool, ['SHOW ALL REPLICAS STATUS', 'SHOW ALL SLAVES STATUS', 'SHOW REPLICA STATUS', 'SHOW SLAVE STATUS']);
    out.channels = r.rows.map(normalizeChannel);
  } catch (e) {
    out.error = e.sqlMessage || e.message;
  }
  // Primary side: current binlog position and connected replicas.
  try {
    const r = await firstWorking(pool, ['SHOW BINARY LOG STATUS', 'SHOW MASTER STATUS']);
    if (r.rows[0]) {
      const b = r.rows[0];
      out.binlog = { file: b.File, position: b.Position, gtid: b.Executed_Gtid_Set || null };
    }
  } catch { /* no privilege */ }
  try {
    const r = await firstWorking(pool, ['SHOW REPLICAS', 'SHOW SLAVE HOSTS']);
    out.replicas = r.rows.map((x) => ({
      serverId: pick(x, 'Server_Id', 'Server_id'), host: pick(x, 'Host'), port: pick(x, 'Port'),
      sourceId: pick(x, 'Source_Id', 'Master_id', 'Master_Id'),
    }));
  } catch { /* no privilege */ }
  if (!out.binlog) {
    try {
      const [[g]] = await pool.query('SELECT @@gtid_binlog_pos AS pos');
      if (g?.pos) out.binlog = { file: null, position: null, gtid: g.pos };
    } catch { /* MySQL */ }
  }
  out.role = out.channels.length ? 'replica' : out.replicas.length ? 'primary' : out.binlog ? 'primary-noreplicas' : 'standalone';
  return out;
}

// ---------------------------------------------------------------------------
// Heaviest queries (like pg_stat_statements): performance_schema statement
// digests, or the slow log table as a fallback.
// ---------------------------------------------------------------------------
const TOP_ORDER = {
  total: 'SUM_TIMER_WAIT', avg: 'AVG_TIMER_WAIT', max: 'MAX_TIMER_WAIT', count: 'COUNT_STAR',
  examined: 'SUM_ROWS_EXAMINED', noindex: 'SUM_NO_INDEX_USED + SUM_NO_GOOD_INDEX_USED', tmpdisk: 'SUM_CREATED_TMP_DISK_TABLES',
};
const PS = 1e9; // picoseconds -> milliseconds

export async function topQueries(pool, { order = 'total', limit = 50, schema = '', hideInternal = true }) {
  const [[st]] = await pool.query('SELECT @@performance_schema AS ps, @@log_output AS lo, @@slow_query_log AS slow');
  const lim = Math.min(Math.max(Number(limit) || 50, 5), 500);
  const internal = "AND DIGEST_TEXT NOT LIKE '%information_schema%' AND DIGEST_TEXT NOT LIKE '%performance_schema%' AND DIGEST_TEXT NOT LIKE 'SHOW %' AND DIGEST_TEXT NOT LIKE 'SET %' AND DIGEST_TEXT NOT LIKE 'DO %' AND DIGEST_TEXT NOT LIKE 'KILL %' AND DIGEST_TEXT NOT LIKE '%@@%'";
  if (Number(st.ps)) {
    const where = [`DIGEST_TEXT IS NOT NULL`];
    const params = [];
    if (schema) { where.push('SCHEMA_NAME = ?'); params.push(schema); }
    const [[tot]] = await pool.query(`SELECT SUM(SUM_TIMER_WAIT) AS t FROM performance_schema.events_statements_summary_by_digest`);
    const [rows] = await pool.query(
      `SELECT SCHEMA_NAME AS db, DIGEST AS digest, DIGEST_TEXT AS text, COUNT_STAR AS calls,
              SUM_TIMER_WAIT AS totalT, AVG_TIMER_WAIT AS avgT, MAX_TIMER_WAIT AS maxT, SUM_LOCK_TIME AS lockT,
              SUM_ROWS_EXAMINED AS examined, SUM_ROWS_SENT AS sent, SUM_ROWS_AFFECTED AS affected,
              SUM_NO_INDEX_USED + SUM_NO_GOOD_INDEX_USED AS noIndex, SUM_CREATED_TMP_DISK_TABLES AS tmpDisk,
              SUM_SORT_MERGE_PASSES AS sortMerge, SUM_ERRORS AS errors, FIRST_SEEN AS firstSeen, LAST_SEEN AS lastSeen
         FROM performance_schema.events_statements_summary_by_digest
        WHERE ${where.join(' AND ')} ${hideInternal ? internal : ''}
        ORDER BY ${TOP_ORDER[order] || TOP_ORDER.total} DESC LIMIT ${lim}`, params);
    const total = Number(tot.t) || 1;
    return {
      source: 'performance_schema',
      rows: rows.map((r) => ({
        db: r.db, digest: r.digest, text: r.text, calls: Number(r.calls),
        totalMs: Number(r.totalT) / PS, avgMs: Number(r.avgT) / PS, maxMs: Number(r.maxT) / PS, lockMs: Number(r.lockT) / PS,
        pct: (Number(r.totalT) / total) * 100,
        examined: Number(r.examined), sent: Number(r.sent), affected: Number(r.affected),
        noIndex: Number(r.noIndex), tmpDisk: Number(r.tmpDisk), sortMerge: Number(r.sortMerge), errors: Number(r.errors),
        firstSeen: r.firstSeen, lastSeen: r.lastSeen,
      })),
    };
  }
  // Fallback: slow log written to a table.
  if (String(st.lo).toUpperCase().includes('TABLE') && Number(st.slow)) {
    const ord = { total: 'totalS', avg: 'avgS', max: 'maxS', count: 'calls', examined: 'examined' }[order] || 'totalS';
    const [rows] = await pool.query(
      `SELECT db, LEFT(sql_text, 2000) AS text, COUNT(*) AS calls, SUM(TIME_TO_SEC(query_time)) AS totalS,
              AVG(TIME_TO_SEC(query_time)) AS avgS, MAX(TIME_TO_SEC(query_time)) AS maxS,
              SUM(rows_examined) AS examined, SUM(rows_sent) AS sent, MAX(start_time) AS lastSeen
         FROM mysql.slow_log ${schema ? 'WHERE db = ?' : ''}
        GROUP BY db, LEFT(sql_text, 2000) ORDER BY ${ord} DESC LIMIT ${lim}`, schema ? [schema] : []);
    const total = rows.reduce((a, r) => a + Number(r.totalS), 0) || 1;
    return {
      source: 'slow_log',
      rows: rows.map((r) => ({
        db: r.db, text: r.text, calls: Number(r.calls), totalMs: Number(r.totalS) * 1000, avgMs: Number(r.avgS) * 1000,
        maxMs: Number(r.maxS) * 1000, pct: (Number(r.totalS) / total) * 100, examined: Number(r.examined), sent: Number(r.sent),
        lastSeen: r.lastSeen,
      })),
    };
  }
  return { source: null, rows: [], performanceSchema: Number(st.ps), logOutput: st.lo, slowLog: Number(st.slow) };
}

export function registerTopQueries(app, { h, getPool }) {
  app.get('/api/connections/:id/admin/top-queries', h(async (req, res) => {
    const pool = await getPool(req.params.id);
    res.json(await topQueries(pool, {
      order: req.query.order, limit: req.query.limit, schema: req.query.schema || '',
      hideInternal: req.query.internal !== '1',
    }));
  }));
  // Start a fresh measurement window.
  app.post('/api/connections/:id/admin/top-queries/reset', h(async (req, res) => {
    const sql = 'TRUNCATE TABLE performance_schema.events_statements_summary_by_digest';
    if (req.body?.preview) return res.json({ statements: [sql] });
    const pool = await getPool(req.params.id);
    await pool.query(sql);
    res.json({ ok: true });
  }));
}
