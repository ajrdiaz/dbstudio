// Monaco SQL autocomplete backed by the live schema map. A single completion
// provider is registered globally; each editor updates the shared `current`
// schema when it mounts or its database changes (one editor is focused at a
// time, so this is enough to give table/column suggestions).
let current = { tables: {} };
let registered = false;

const KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'INSERT INTO', 'UPDATE', 'DELETE FROM', 'SET', 'VALUES',
  'JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN', 'ON', 'GROUP BY', 'ORDER BY',
  'HAVING', 'LIMIT', 'OFFSET', 'AS', 'AND', 'OR', 'NOT', 'NULL', 'IS NULL', 'LIKE',
  'IN', 'BETWEEN', 'DISTINCT', 'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'CREATE TABLE',
  'ALTER TABLE', 'DROP TABLE', 'PRIMARY KEY', 'FOREIGN KEY', 'DEFAULT', 'AUTO_INCREMENT',
];

export function setSchema(map) {
  current = map && map.tables ? map : { tables: {} };
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
      const suggestions = [];
      const tables = current.tables || {};
      const seenCols = new Set();

      for (const t of Object.keys(tables)) {
        suggestions.push({ label: t, kind: K.Struct, insertText: t, range, detail: 'table', sortText: '1' + t });
        for (const c of tables[t]) {
          if (seenCols.has(c)) continue;
          seenCols.add(c);
          suggestions.push({ label: c, kind: K.Field, insertText: c, range, detail: 'column', sortText: '2' + c });
        }
      }
      for (const kw of KEYWORDS) {
        suggestions.push({ label: kw, kind: K.Keyword, insertText: kw, range, sortText: '3' + kw });
      }
      return { suggestions };
    },
  });
}
