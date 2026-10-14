// Builds CREATE TABLE / ALTER TABLE statements from a column spec sent by the
// visual table designer. All identifiers and values go through the safe quoting
// helpers in sql.js.
import { quoteId, quoteVal } from './sql.js';

const RAW_DEFAULTS = new Set(['CURRENT_TIMESTAMP', 'CURRENT_TIMESTAMP()', 'NOW()', 'NULL']);
const safeWord = (s) => String(s || '').replace(/[^\w]/g, '');

function columnType(col) {
  let t = String(col.type || 'VARCHAR').toUpperCase();
  if (col.length != null && String(col.length).trim() !== '') t += `(${String(col.length).trim()})`;
  if (col.unsigned) t += ' UNSIGNED';
  return t;
}

function defaultClause(col) {
  if (col.autoIncrement) return '';
  const d = col.default;
  if (d === undefined || d === null || d === '') return '';
  const up = String(d).trim().toUpperCase();
  if (RAW_DEFAULTS.has(up)) return ` DEFAULT ${up}`;
  return ` DEFAULT ${quoteVal(d)}`;
}

export function columnDef(col) {
  let s = `${quoteId(col.name)} ${columnType(col)}`;
  s += col.nullable ? ' NULL' : ' NOT NULL';
  s += defaultClause(col);
  if (col.autoIncrement) s += ' AUTO_INCREMENT';
  if (col.comment) s += ` COMMENT ${quoteVal(col.comment)}`;
  return s;
}

export function buildCreateTable({ db, name, columns = [], primaryKey = [], engine, charset }) {
  if (!name) throw new Error('Table name is required');
  if (!columns.length) throw new Error('At least one column is required');
  const defs = columns.map(columnDef);
  if (primaryKey.length) defs.push(`PRIMARY KEY (${primaryKey.map(quoteId).join(', ')})`);
  let sql = `CREATE TABLE ${quoteId(db)}.${quoteId(name)} (\n  ${defs.join(',\n  ')}\n)`;
  if (engine) sql += ` ENGINE=${safeWord(engine)}`;
  if (charset) sql += ` DEFAULT CHARSET=${safeWord(charset)}`;
  return sql;
}

export function buildAlterTable({ db, table, adds = [], changes = [], drops = [], primaryKey, originalPrimaryKey, rename }) {
  const clauses = [];
  for (const name of drops) clauses.push(`DROP COLUMN ${quoteId(name)}`);
  for (const col of adds) clauses.push(`ADD COLUMN ${columnDef(col)}`);
  for (const ch of changes) {
    if (ch.origName && ch.origName !== ch.col.name) {
      clauses.push(`CHANGE COLUMN ${quoteId(ch.origName)} ${columnDef(ch.col)}`);
    } else {
      clauses.push(`MODIFY COLUMN ${columnDef(ch.col)}`);
    }
  }
  const pkChanged = JSON.stringify(primaryKey || []) !== JSON.stringify(originalPrimaryKey || []);
  if (pkChanged) {
    if ((originalPrimaryKey || []).length) clauses.push('DROP PRIMARY KEY');
    if ((primaryKey || []).length) clauses.push(`ADD PRIMARY KEY (${primaryKey.map(quoteId).join(', ')})`);
  }
  let sql = '';
  if (clauses.length) sql = `ALTER TABLE ${quoteId(db)}.${quoteId(table)}\n  ${clauses.join(',\n  ')}`;
  if (rename && rename !== table) {
    const r = `ALTER TABLE ${quoteId(db)}.${quoteId(table)} RENAME TO ${quoteId(db)}.${quoteId(rename)}`;
    sql = sql ? `${sql};\n${r}` : r;
  }
  return sql;
}
