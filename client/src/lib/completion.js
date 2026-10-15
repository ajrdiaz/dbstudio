// Monaco SQL autocomplete backed by the live schema map. A single completion
// provider is registered globally; each editor updates the shared `current`
// schema when it mounts or its database changes (one editor is focused at a
// time, so this is enough to give table/column suggestions).
//
// Suggestions depend on where the cursor is (like SQLyog / DBeaver):
//   alias.|            -> columns of that table only
//   FROM / JOIN ... |  -> tables first
//   ORDER BY col |     -> ASC / DESC first
//   elsewhere          -> columns of the statement's tables, then functions,
//                         keywords, other tables and columns
import { statementAt } from './sqlSplit.js';

let current = { tables: {} };
let registered = false;

const KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'AS', 'ON', 'USING', 'IN', 'IS', 'NULL', 'IS NULL',
  'IS NOT NULL', 'NOT NULL', 'LIKE', 'NOT LIKE', 'REGEXP', 'BETWEEN', 'EXISTS', 'NOT EXISTS', 'DISTINCT', 'ALL',
  'JOIN', 'INNER JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'CROSS JOIN', 'STRAIGHT_JOIN',
  'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'OFFSET', 'ASC', 'DESC', 'WITH ROLLUP',
  'UNION', 'UNION ALL', 'WITH', 'RECURSIVE', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
  'TRUE', 'FALSE', 'DIV', 'MOD', 'XOR', 'INTERVAL', 'FOR UPDATE', 'LOCK IN SHARE MODE',
  'INSERT INTO', 'VALUES', 'ON DUPLICATE KEY UPDATE', 'REPLACE INTO', 'UPDATE', 'SET', 'DELETE FROM',
  'CREATE TABLE', 'ALTER TABLE', 'DROP TABLE', 'TRUNCATE TABLE', 'RENAME TABLE', 'CREATE INDEX', 'DROP INDEX',
  'CREATE VIEW', 'CREATE OR REPLACE VIEW', 'ADD COLUMN', 'MODIFY COLUMN', 'CHANGE COLUMN', 'DROP COLUMN',
  'PRIMARY KEY', 'FOREIGN KEY', 'REFERENCES', 'UNIQUE', 'INDEX', 'DEFAULT', 'AUTO_INCREMENT', 'COMMENT',
  'START TRANSACTION', 'BEGIN', 'COMMIT', 'ROLLBACK', 'SHOW TABLES', 'SHOW COLUMNS FROM', 'SHOW CREATE TABLE',
  'SHOW PROCESSLIST', 'SHOW FULL PROCESSLIST', 'DESCRIBE', 'EXPLAIN', 'USE', 'CALL',
  'INT', 'BIGINT', 'TINYINT', 'DECIMAL', 'VARCHAR', 'CHAR', 'TEXT', 'DATETIME', 'TIMESTAMP', 'JSON',
];

const FUNCTIONS = [
  // aggregates / control flow
  'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'GROUP_CONCAT', 'IF', 'IFNULL', 'NULLIF', 'COALESCE', 'GREATEST', 'LEAST',
  // strings
  'CONCAT', 'CONCAT_WS', 'SUBSTRING', 'SUBSTRING_INDEX', 'LEFT', 'RIGHT', 'LENGTH', 'CHAR_LENGTH', 'UPPER',
  'LOWER', 'TRIM', 'LTRIM', 'RTRIM', 'REPLACE', 'LPAD', 'RPAD', 'LOCATE', 'INSTR', 'REVERSE', 'FORMAT', 'CAST',
  'CONVERT', 'HEX', 'MD5', 'SHA2', 'UUID',
  // numbers
  'ROUND', 'TRUNCATE', 'FLOOR', 'CEIL', 'ABS', 'MOD', 'POW', 'RAND',
  // dates
  'NOW', 'CURDATE', 'CURTIME', 'SYSDATE', 'DATE', 'TIME', 'YEAR', 'MONTH', 'DAY', 'HOUR', 'MINUTE', 'WEEK',
  'DAYOFWEEK', 'LAST_DAY', 'DATE_FORMAT', 'STR_TO_DATE', 'DATE_ADD', 'DATE_SUB', 'DATEDIFF', 'TIMESTAMPDIFF',
  'UNIX_TIMESTAMP', 'FROM_UNIXTIME',
  // json / window / misc
  'JSON_EXTRACT', 'JSON_UNQUOTE', 'JSON_OBJECT', 'JSON_ARRAY', 'ROW_NUMBER', 'RANK', 'DENSE_RANK', 'LAG', 'LEAD',
  'DATABASE', 'LAST_INSERT_ID', 'FOUND_ROWS', 'VERSION',
];

// Words that can follow a table name but are not its alias.
const NOT_ALIAS = new Set(['where', 'on', 'using', 'join', 'inner', 'left', 'right', 'cross', 'natural', 'straight_join',
  'set', 'group', 'order', 'having', 'limit', 'union', 'values', 'select', 'as', 'for', 'lock', 'window', 'partition',
  'force', 'use', 'ignore', 'outer']);

export function setSchema(map) {
  current = map && map.tables ? map : { tables: {} };
}

// Tables referenced by a statement, with their aliases: { alias|name (lowercase) -> table }.
function tableRefs(sql, tables) {
  const byLower = new Map(Object.keys(tables).map((t) => [t.toLowerCase(), t]));
  const refs = new Map();
  const re = /\b(?:from|join|update|into)\s+((?:`[^`]+`|\w+)(?:\s*\.\s*(?:`[^`]+`|\w+))?)(?:\s+(?:as\s+)?(`[^`]+`|\w+))?/gi;
  const strip = (s) => s.replace(/`/g, '');
  let m;
  while ((m = re.exec(sql))) {
    const name = strip(m[1].split('.').pop().trim());
    const table = byLower.get(name.toLowerCase());
    if (!table) continue;
    refs.set(name.toLowerCase(), table);
    const alias = m[2] && strip(m[2]);
    if (alias && !NOT_ALIAS.has(alias.toLowerCase())) refs.set(alias.toLowerCase(), table);
  }
  return refs;
}

export function ensureProvider(monaco) {
  if (registered) return;
  registered = true;
  monaco.languages.registerCompletionItemProvider('sql', {
    triggerCharacters: [' ', '.', '`'],
    provideCompletionItems(model, position) {
      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber, endLineNumber: position.lineNumber,
        startColumn: word.startColumn, endColumn: word.endColumn,
      };
      const K = monaco.languages.CompletionItemKind;
      const tables = current.tables || {};

      // The statement under the cursor, and its text up to the current word.
      const text = model.getValue();
      const offset = model.getOffsetAt({ lineNumber: position.lineNumber, column: word.startColumn });
      const stmt = statementAt(text, offset);
      const stmtText = stmt ? text.slice(stmt.start, stmt.end) : text;
      const before = stmt ? text.slice(Math.min(stmt.start, offset), offset) : text.slice(0, offset);
      const refs = tableRefs(stmtText, tables);

      // alias.| or table.| -> only that table's columns.
      const dot = /(`[^`]+`|\w+)\s*\.\s*`?$/.exec(before);
      if (dot) {
        const table = refs.get(dot[1].replace(/`/g, '').toLowerCase())
          || Object.keys(tables).find((t) => t.toLowerCase() === dot[1].replace(/`/g, '').toLowerCase());
        if (table) {
          return {
            suggestions: tables[table].map((c, i) => ({
              label: c, kind: K.Field, insertText: c, range, detail: table, sortText: String(i).padStart(4, '0'),
            })),
          };
        }
      }

      // Clause context from the last keyword before the cursor.
      const flat = before.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, "''").toLowerCase();
      const wantsTable = /\b(?:from|join|update|into|table|describe)\s+(?:`?\w+`?\s*,\s*)*$/.test(flat);
      // ORDER BY <expr> |  (not right after BY or a comma) -> ASC / DESC
      const orderBy = /\border\s+by\s+(?:(?!\b(?:limit|union|for)\b)[^;])*$/.exec(flat);
      const afterOrderExpr = orderBy && /[\w`)\]]\s+$/.test(flat) && !/\bby\s+$/.test(flat) && !/,\s*$/.test(flat);

      const usedTables = new Set(refs.values());
      const suggestions = [];
      const add = (rank, item) => suggestions.push({ ...item, range, sortText: rank + item.label });

      for (const t of Object.keys(tables)) {
        add(wantsTable ? '0' : '6', { label: t, kind: K.Struct, insertText: t });
      }
      const seenCols = new Set();
      // Columns of the tables in this statement first, then the rest.
      for (const t of [...usedTables, ...Object.keys(tables).filter((x) => !usedTables.has(x))]) {
        for (const c of tables[t]) {
          if (seenCols.has(c)) continue;
          seenCols.add(c);
          add(usedTables.has(t) ? '2' : '7', { label: c, kind: K.Field, insertText: c, detail: t });
        }
      }
      for (const f of FUNCTIONS) {
        add('4', {
          label: f, kind: K.Function,
          insertText: `${f}($0)`, insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
        });
      }
      for (const kw of KEYWORDS) {
        const top = afterOrderExpr && (kw === 'DESC' || kw === 'ASC');
        add(top ? '1' : wantsTable ? '8' : '5', { label: kw, kind: K.Keyword, insertText: kw });
      }
      return { suggestions };
    },
  });
}
