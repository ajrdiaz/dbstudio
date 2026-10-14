// CSV / Excel import helpers: parsing, delimiter detection, column type
// inference and value normalization (dates dd/mm/yyyy, decimal comma, ...).

export function detectDelimiter(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 20);
  let best = ','; let bestScore = -1;
  for (const d of [',', ';', '\t', '|']) {
    const counts = lines.map((l) => splitLine(l, d).length);
    if (!counts.length || counts[0] < 2) continue;
    const same = counts.filter((c) => c === counts[0]).length;
    const score = same * 100 + counts[0];
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return best;
}

function splitLine(line, d) {
  return parseCSV(line, d)[0] || [];
}

// RFC 4180-ish: quoted fields, doubled quotes, newlines inside quotes.
export function parseCSV(text, d = ',') {
  const rows = []; let row = []; let cell = ''; let q = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += ch;
    } else if (ch === '"' && cell === '') q = true;
    else if (ch === d) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

export function cleanName(raw, i, used) {
  let n = String(raw ?? '').trim().replace(/[`]/g, '').replace(/\s+/g, '_').replace(/[^\p{L}\p{N}_$]/gu, '').slice(0, 64);
  if (!n) n = `col_${i + 1}`;
  let out = n; let k = 2;
  while (used.has(out.toLowerCase())) out = `${n}_${k++}`;
  used.add(out.toLowerCase());
  return out;
}

const RE_INT = /^-?\d+$/;
const RE_DEC_DOT = /^-?(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$/;
const RE_DEC_COMMA = /^-?(\d{1,3}(\.\d{3})+|\d+)(,\d+)?$/;
const RE_DMY = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;
const RE_YMD = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;
const pad = (n) => String(n).padStart(2, '0');

function dateParts(v, opts) {
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    return { y: v.getUTCFullYear(), m: v.getUTCMonth() + 1, d: v.getUTCDate(), H: v.getUTCHours(), M: v.getUTCMinutes(), S: v.getUTCSeconds() };
  }
  const s = String(v).trim();
  let m = RE_YMD.exec(s);
  if (m) return { y: +m[1], m: +m[2], d: +m[3], H: +(m[4] || 0), M: +(m[5] || 0), S: +(m[6] || 0), time: !!m[4] };
  m = RE_DMY.exec(s);
  if (m) {
    const [a, b] = opts.dateOrder === 'mdy' ? [+m[2], +m[1]] : [+m[1], +m[2]];
    if (b < 1 || b > 12 || a < 1 || a > 31) return null;
    return { y: +m[3], m: b, d: a, H: +(m[4] || 0), M: +(m[5] || 0), S: +(m[6] || 0), time: !!m[4] };
  }
  return null;
}

// Suggest a MySQL type from sample values.
export function inferType(values, opts = {}) {
  const vals = values.filter((v) => v !== null && v !== undefined && String(v).trim() !== '');
  if (!vals.length) return 'VARCHAR(255)';
  const strs = vals.map((v) => (v instanceof Date ? v : String(v).trim()));
  if (strs.every((v) => typeof v === 'string' && RE_INT.test(v) && v.length < 19 && !(v.length > 1 && v.startsWith('0')))) {
    const big = strs.some((v) => Math.abs(Number(v)) > 2147483647);
    return big ? 'BIGINT' : 'INT';
  }
  const decRe = opts.decimalComma ? RE_DEC_COMMA : RE_DEC_DOT;
  // Codes with leading zeros (007, 0123) must stay text or the zeros are lost.
  const leadingZero = (v) => /^-?0\d/.test(v);
  if (strs.every((v) => typeof v === 'string' && decRe.test(v) && !leadingZero(v))) {
    let intD = 1; let fracD = 0;
    for (const v of strs) {
      const norm = normalizeNumber(v, opts);
      const [i, f = ''] = norm.replace('-', '').split('.');
      intD = Math.max(intD, i.length); fracD = Math.max(fracD, f.length);
    }
    if (intD + fracD > 30) return 'DOUBLE';
    fracD = Math.min(fracD, 10);
    return `DECIMAL(${Math.min(30, intD + fracD)},${fracD})`;
  }
  const BOOL = ['true', 'false', 'si', 'sí', 'no', 'yes', 'verdadero', 'falso'];
  if (strs.every((v) => typeof v === 'string' && BOOL.includes(v.toLowerCase()))) return 'BOOLEAN';
  const dates = strs.map((v) => dateParts(v, opts));
  if (dates.every(Boolean)) {
    const withTime = dates.some((d) => d.H || d.M || d.S || d.time);
    return withTime ? 'DATETIME' : 'DATE';
  }
  const maxLen = Math.max(...strs.map((v) => String(v).length));
  if (maxLen > 2000) return 'TEXT';
  const n = Math.max(32, Math.ceil((maxLen * 1.5) / 16) * 16);
  return `VARCHAR(${Math.min(n, 4000)})`;
}

function normalizeNumber(v, opts) {
  const s = String(v).trim();
  if (opts.decimalComma) return s.replace(/\./g, '').replace(',', '.');
  return RE_DEC_DOT.test(s) ? s.replace(/,/g, '') : s;
}

// Convert a cell to what MySQL expects for the target column type.
export function normalizeValue(v, type, opts = {}) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' && v.trim() === '') return opts.emptyAsNull ? null : '';
  const t = String(type || '').toLowerCase();
  // Booleans before numbers: tinyint(1) would otherwise be parsed as a number.
  if (/bool|tinyint\(1\)|bit/.test(t)) {
    const s = String(v).trim().toLowerCase();
    if (['true', 'si', 'sí', 'yes', 'y', 's', 'x', 'verdadero', '1'].includes(s)) return 1;
    if (['false', 'no', 'n', 'falso', '0'].includes(s)) return 0;
  }
  if (/int|decimal|double|float|numeric|real/.test(t)) {
    if (typeof v === 'number') return v;
    if (typeof v === 'boolean') return v ? 1 : 0;
    return normalizeNumber(v, opts);
  }
  if (/^(date|datetime|timestamp)/.test(t)) {
    const d = dateParts(v, opts);
    if (!d) return String(v);
    const day = `${d.y}-${pad(d.m)}-${pad(d.d)}`;
    return t.startsWith('date') && !t.startsWith('datetime') ? day : `${day} ${pad(d.H)}:${pad(d.M)}:${pad(d.S)}`;
  }
  if (v instanceof Date) return dateParts(v, opts) ? normalizeValue(v, 'datetime', opts) : String(v);
  return typeof v === 'string' ? v : String(v);
}
