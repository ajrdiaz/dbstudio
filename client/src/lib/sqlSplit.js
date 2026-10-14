// Splits a SQL script into statements, the way SQLyog / the mysql CLI do:
// honours '...', "...", `...` quoting, -- / # / /* */ comments and
// `DELIMITER xx` lines. Returns [{ sql, start, end }] where `sql` excludes the
// delimiter, `start` is the offset of the first non-blank char and `end` is the
// offset just past the delimiter (or the end of the text).
export function splitStatements(text) {
  const out = [];
  let delim = ';';
  let i = 0;
  let stmtStart = -1;
  const n = text.length;

  const flush = (endSql, endAll) => {
    if (stmtStart >= 0) {
      const sql = text.slice(stmtStart, endSql).trim();
      if (sql) out.push({ sql, start: stmtStart, end: endAll });
    }
    stmtStart = -1;
  };

  while (i < n) {
    const ch = text[i];

    // DELIMITER command — only valid at the start of a statement.
    if (stmtStart < 0 && /^delimiter[ \t]/i.test(text.slice(i, i + 10))) {
      let eol = text.indexOf('\n', i);
      if (eol < 0) eol = n;
      const d = text.slice(i + 10, eol).trim();
      if (d) delim = d;
      i = eol;
      continue;
    }

    // Comments
    if ((ch === '-' && text[i + 1] === '-' && /\s/.test(text[i + 2] ?? ' ')) || ch === '#') {
      const eol = text.indexOf('\n', i);
      i = eol < 0 ? n : eol;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      i = close < 0 ? n : close + 2;
      continue;
    }

    if (/\s/.test(ch)) { i++; continue; }
    if (stmtStart < 0) stmtStart = i;

    // Quoted strings / identifiers (backslash escapes + doubled quotes)
    if (ch === "'" || ch === '"' || ch === '`') {
      i++;
      while (i < n) {
        if (text[i] === '\\' && ch !== '`') { i += 2; continue; }
        if (text[i] === ch) {
          if (text[i + 1] === ch) { i += 2; continue; }
          break;
        }
        i++;
      }
      i++;
      continue;
    }

    if (text.startsWith(delim, i)) {
      flush(i, i + delim.length);
      i += delim.length;
      continue;
    }
    i++;
  }
  flush(n, n);
  return out;
}

// Picks the statement the cursor is "on": the one whose span contains the
// offset (cursor right after the `;` counts). In the blank space between two
// statements, prefer the previous one if the cursor is still on its last line,
// otherwise the next one.
export function statementAt(text, offset) {
  const stmts = splitStatements(text);
  if (!stmts.length) return null;
  for (const s of stmts) {
    if (offset >= s.start && offset <= s.end) return s;
  }
  let prev = null;
  let next = null;
  for (const s of stmts) {
    if (s.end < offset) prev = s;
    else if (s.start > offset && !next) next = s;
  }
  if (prev && !text.slice(prev.end, offset).includes('\n')) return prev;
  return next || prev;
}
