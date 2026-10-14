// Text conversions for the data grid: Excel-compatible TSV (clipboard), CSV
// export and SQL literals for "copy as INSERT".

export const NULL_TEXT = '(NULL)';

// Cells with tabs, newlines or quotes are wrapped in quotes, as Excel does.
export function toTSV(matrix) {
  return matrix
    .map((row) => row.map((v) => {
      const s = v == null ? '' : String(v);
      return /[\t\n\r"]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join('\t'))
    .join('\r\n');
}

// Parses what Excel / Google Sheets / our own grid put on the clipboard.
export function parseTSV(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let i = 0;
  let quoted = false;
  const s = text.replace(/\r\n?/g, '\n');
  while (i < s.length) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') { cell += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      cell += ch; i++; continue;
    }
    if (ch === '"' && cell === '') { quoted = true; i++; continue; }
    if (ch === '\t') { row.push(cell); cell = ''; i++; continue; }
    if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++; continue; }
    cell += ch; i++;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

export function toCSV(header, rows) {
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return [header, ...rows].map((r) => r.map(esc).join(',')).join('\n');
}

export function quoteId(name) {
  return '`' + String(name).replace(/`/g, '``') + '`';
}

export function quoteVal(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  return "'" + String(v).replace(/\\/g, '\\\\').replace(/'/g, "''").replace(/\n/g, '\\n').replace(/\r/g, '\\r') + "'";
}

// mysql2 serializes binary columns as {type:'Buffer', data:[...]}.
export function isBlob(v) {
  return v && typeof v === 'object' && v.type === 'Buffer' && Array.isArray(v.data);
}
