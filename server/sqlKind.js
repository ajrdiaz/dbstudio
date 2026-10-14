// Classifies SQL statements as read-only or "writes" (anything that can change
// data, schema, users or server state). Used to confirm before running writes
// on production connections and to block them on read-only connections.
// Kept in sync with client/src/lib/sqlKind.js.

const READ = new Set(['SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'USE', 'HELP', 'VALUES', 'TABLE', 'CHECK', 'CHECKSUM', 'DO']);

function firstWords(sql) {
  const s = sql
    // Executable comments (/*!40101 SET NAMES ... */) run their content.
    .replace(/\/\*!\d*([\s\S]*?)\*\//g, ' $1 ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|\n)\s*(--\s|#).*$/gm, ' ')
    .replace(/^[\s(]+/, '')
    .toUpperCase();
  return s.split(/\s+/).filter(Boolean);
}

export function isWriteStatement(sql) {
  const w = firstWords(sql);
  if (!w.length) return false;
  const k = w[0];
  if (READ.has(k)) return false;
  // CTEs: WITH ... SELECT is a read unless it feeds an UPDATE/DELETE/INSERT.
  if (k === 'WITH') return /\b(UPDATE|DELETE|INSERT|REPLACE)\b/i.test(sql);
  // Session-only SET (variables, names, ...) is harmless; SET GLOBAL/PERSIST/PASSWORD is not.
  if (k === 'SET') return /^(GLOBAL|PERSIST|PERSIST_ONLY|PASSWORD|DEFAULT\s+ROLE|ROLE)$/.test(w[1] || '') || /^@@GLOBAL\./.test(w[1] || '');
  // MariaDB "ANALYZE SELECT ..." just runs and profiles the SELECT.
  if (k === 'ANALYZE') return !['SELECT', 'FORMAT'].includes(w[1]);
  return true;
}

export const writeStatements = (list) => list.filter(isWriteStatement);

// Throws when the saved connection is marked read-only and any statement writes.
export function assertWritable(conn, statements, what = 'esta operación') {
  if (!conn?.readOnly) return;
  const bad = statements.filter(isWriteStatement);
  if (bad.length) {
    const err = new Error(`Conexión de solo lectura: ${what} no está permitido (${bad[0].slice(0, 80)}…)`);
    err.status = 403;
    throw err;
  }
}
