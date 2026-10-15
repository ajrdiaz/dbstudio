import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../i18n.jsx';
import { downloadText } from '../lib/download.js';
import { NULL_TEXT, toTSV, parseTSV, toCSV, quoteId, quoteVal, isBlob } from '../lib/gridText.js';

// Spreadsheet-style grid used for both table data and query results.
//
// Rows are arrays (one value per column). Pending changes live here until
// saved: `edits[row][col]` for existing rows, `newRows[i].vals[col]` for added
// rows (missing = DEFAULT) and `deleted` row indexes. Every mutation keeps the
// previous state on an undo stack.
//
// Coordinates: "view" rows (vi) are what the user sees — existing rows in the
// current client-side sort order, then the new rows. R(vi) maps to the
// underlying index (0..n-1 existing, n.. new).

const EMPTY = { edits: {}, newRows: [], deleted: [] };
// Column widths fit the content like SQLyog: header and the first rows,
// capped so one long text doesn't push the other columns away.
const FIT_ROWS = 200;
const FIT_MAX = 320; // automatic width
const FIT_MAX_MANUAL = 600; // double-click on the header border
let measureCtx = null;
function textWidth(text, font) {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  measureCtx.font = font;
  return measureCtx.measureText(text).width;
}
const OVERSCAN = 12;
let newRowSeq = 1;

const sameVal = (a, b) =>
  (a === null || a === undefined) ? (b === null || b === undefined) : (b !== null && b !== undefined && String(a) === String(b));

function displayOf(v, meta) {
  if (v === undefined) return meta?.autoIncrement ? '(Auto)' : '(DEFAULT)';
  if (v === null) return NULL_TEXT;
  if (isBlob(v)) return `(BLOB ${v.data.length} B)`;
  if (typeof v === 'object') return JSON.stringify(v);
  const s = String(v);
  return s.length > 300 ? s.slice(0, 300) + '…' : s.replace(/\r?\n/g, ' ↵ ');
}

function plainText(v) {
  if (v === undefined) return '';
  if (v === null) return NULL_TEXT;
  if (isBlob(v)) return `(BLOB ${v.data.length} B)`;
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

// Pure: apply cell writes to a pending-changes state (writing the original
// value back removes the edit, so the cell is no longer "changed").
function writeCells(prev, writes, rows, n) {
  const edits = { ...prev.edits };
  const copied = new Set();
  let newRows = prev.newRows;
  let newCopied = false;
  for (const { r, c, v } of writes) {
    if (r < n) {
      if (!copied.has(r)) { edits[r] = { ...(edits[r] || {}) }; copied.add(r); }
      if (sameVal(rows[r][c], v)) delete edits[r][c];
      else edits[r][c] = v;
      if (!Object.keys(edits[r]).length) delete edits[r];
    } else {
      if (!newCopied) { newRows = newRows.slice(); newCopied = true; }
      const i = r - n;
      newRows[i] = { ...newRows[i], vals: { ...newRows[i].vals, [c]: v } };
    }
  }
  return { ...prev, edits, newRows };
}

export default function EditableGrid({
  columns, rows, editable = false, targets, primaryKey = [], tableName,
  readonlyReason, onSave, onSaved, onDirtyChange, rowOffset = 0,
  sort, onSort, leftTools, exportName = 'result', toast,
}) {
  const { t } = useI18n();
  const n = rows.length;
  const tg = targets || columns.map((c) => c.name);

  // ---- pending changes + undo ----
  const [st, setSt] = useState(EMPTY);
  const stRef = useRef(EMPTY);
  const undoRef = useRef([]);
  const mutate = useCallback((fn) => {
    const prev = stRef.current;
    const next = fn(prev);
    if (next === prev) return;
    undoRef.current.push(prev);
    if (undoRef.current.length > 200) undoRef.current.shift();
    stRef.current = next;
    setSt(next);
  }, []);
  const resetChanges = useCallback(() => {
    undoRef.current = [];
    stRef.current = EMPTY;
    setSt(EMPTY);
  }, []);

  // ---- UI state ----
  const [sel, setSel] = useState(null); // {ar, ac, fr, fc} anchor + focus (view coords)
  const [editing, setEditingState] = useState(null); // {vi, c, text, wasNull, fresh}
  // Mirror of `editing` so a commit can't run twice (Enter, then the input's blur).
  const editRef = useRef(null);
  const setEditing = useCallback((v) => {
    setEditingState((prev) => {
      const next = typeof v === 'function' ? v(prev) : v;
      editRef.current = next;
      return next;
    });
  }, []);
  const [bigEdit, setBigEdit] = useState(null); // {vi, c}
  const [formRow, setFormRow] = useState(null); // vi
  const [menu, setMenu] = useState(null); // {x, y}
  const [preview, setPreview] = useState(null); // [sql]
  const [saving, setSaving] = useState(false);
  const [localSort, setLocalSort] = useState(null); // {c, dir} when the parent doesn't sort
  const [widths, setWidths] = useState([]);
  const scrollRef = useRef(null);
  const dragRef = useRef(null); // 'cells' | 'rows' | null
  const [vp, setVp] = useState({ top: 0, height: 600 });
  const [rowH, setRowH] = useState(23);

  // New data → drop pending changes and selection.
  useEffect(() => { resetChanges(); setSel(null); setEditing(null); setLocalSort(null); }, [rows, resetChanges]);
  // Fit when the columns change, and again when the first rows arrive.
  const fitFor = useRef({ columns: null, hadRows: false });
  useEffect(() => {
    const f = fitFor.current;
    if (f.columns === columns && (f.hadRows || !rows.length)) return;
    fitFor.current = { columns, hadRows: rows.length > 0 };
    setWidths(columns.map((_, c) => fitWidth(c, Math.min(rows.length, FIT_ROWS), FIT_MAX, (r) => rows[r][c])));
  }, [columns, rows]);

  const changeCount = useMemo(
    () => Object.values(st.edits).reduce((a, e) => a + Object.keys(e).length, 0) + st.newRows.length + st.deleted.length,
    [st]
  );
  useEffect(() => { onDirtyChange?.(changeCount > 0); }, [changeCount, onDirtyChange]);

  const delSet = useMemo(() => new Set(st.deleted), [st.deleted]);
  const total = n + st.newRows.length;
  const lastCol = columns.length - 1;
  // Row-number column sized to the largest number shown.
  const ROWNUM_W = Math.max(40, String(rowOffset + total).length * 8 + 18);

  // ---- client-side sort (query results) ----
  const order = useMemo(() => {
    const idx = rows.map((_, i) => i);
    if (!localSort) return idx;
    const { c, dir } = localSort;
    const mul = dir === 'ASC' ? 1 : -1;
    return idx.sort((a, b) => {
      const x = rows[a][c]; const y = rows[b][c];
      if (x === y) return 0;
      if (x === null || x === undefined) return -1 * mul;
      if (y === null || y === undefined) return 1 * mul;
      const nx = Number(x); const ny = Number(y);
      if (!Number.isNaN(nx) && !Number.isNaN(ny) && x !== '' && y !== '') return (nx - ny) * mul;
      return String(x).localeCompare(String(y)) * mul;
    });
  }, [rows, localSort]);
  const R = useCallback((vi) => (vi < n ? order[vi] : vi), [order, n]);

  const getVal = useCallback((r, c) => {
    if (r < n) {
      const e = st.edits[r];
      return e && c in e ? e[c] : rows[r][c];
    }
    return st.newRows[r - n]?.vals[c];
  }, [st, rows, n]);

  const metaOf = (c) => columns[c]?.meta || null;
  // Width (px) that shows column c's header and `count` values from valueAt(i).
  function fitWidth(c, count, cap, valueAt) {
    const base = scrollRef.current ? getComputedStyle(scrollRef.current) : null;
    const family = base?.fontFamily || 'Segoe UI, system-ui, sans-serif';
    const size = base?.fontSize || '13px';
    const font = `${size} ${family}`;
    const meta = metaOf(c);
    // Header: bold name + PK badge + sort arrow + padding.
    let w = textWidth(String(columns[c].name), `600 ${font}`) + 34 + (primaryKey.includes(tg[c]) ? 26 : 0);
    for (let i = 0; i < count && w < cap; i++) w = Math.max(w, textWidth(displayOf(valueAt(i), meta), font) + 16);
    return Math.round(Math.min(cap, Math.max(48, w)));
  }
  const colEditable = (c) => editable && tg[c] != null && !metaOf(c)?.generated;
  const cellEditable = (vi, c) => {
    const r = R(vi);
    return colEditable(c) && !(r < n && delSet.has(r)) && !isBlob(getVal(r, c));
  };

  // ---- selection helpers ----
  const range = sel && {
    r1: Math.min(sel.ar, sel.fr), r2: Math.max(sel.ar, sel.fr),
    c1: Math.min(sel.ac, sel.fc), c2: Math.max(sel.ac, sel.fc),
  };
  const inRange = (vi, c) => range && vi >= range.r1 && vi <= range.r2 && c >= range.c1 && c <= range.c2;
  const selectedViewRows = () => {
    if (!range) return [];
    const out = [];
    for (let vi = range.r1; vi <= range.r2; vi++) out.push(vi);
    return out;
  };
  const focusGrid = () => scrollRef.current?.focus({ preventScroll: true });

  function moveTo(r, c, extend) {
    if (!total) return;
    r = Math.max(0, Math.min(total - 1, r));
    c = Math.max(0, Math.min(lastCol, c));
    setSel((s) => (extend && s ? { ...s, fr: r, fc: c } : { ar: r, ac: c, fr: r, fc: c }));
  }

  // ---- virtualization ----
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => setVp({ top: el.scrollTop, height: el.clientHeight || 600 });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useLayoutEffect(() => {
    const tr = scrollRef.current?.querySelector('tbody tr.data');
    if (tr && tr.offsetHeight && Math.abs(tr.offsetHeight - rowH) > 0.5) setRowH(tr.offsetHeight);
  });
  const start = Math.max(0, Math.floor(vp.top / rowH) - OVERSCAN);
  const end = Math.min(total, Math.ceil((vp.top + vp.height) / rowH) + OVERSCAN);

  // Keep the focused cell visible.
  useLayoutEffect(() => {
    if (!sel) return;
    const el = scrollRef.current;
    if (!el) return;
    // Row y in scroll coordinates sits below the sticky header (~one row tall).
    const head = rowH;
    const top = sel.fr * rowH;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + rowH + head > el.scrollTop + el.clientHeight) el.scrollTop = top + rowH + head - el.clientHeight;
    const td = el.querySelector(`[data-cell="${sel.fr}:${sel.fc}"]`);
    if (td) {
      const left = td.offsetLeft - ROWNUM_W;
      const right = td.offsetLeft + td.offsetWidth;
      if (left < el.scrollLeft) el.scrollLeft = Math.max(0, left);
      else if (right > el.scrollLeft + el.clientWidth) el.scrollLeft = right - el.clientWidth;
    }
  }, [sel?.fr, sel?.fc]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- mutations ----
  function setCells(writes) {
    const ok = writes
      .filter((w) => cellEditable(w.vi, w.c))
      .map((w) => ({ r: R(w.vi), c: w.c, v: w.v }))
      .filter((w) => { const cur = getVal(w.r, w.c); return !(cur === w.v || (cur !== undefined && sameVal(cur, w.v))); });
    if (!ok.length) return;
    mutate((prev) => writeCells(prev, ok, rows, n));
  }
  // Delete key / menu: NULL where the column allows it, else empty string.
  // asEmpty forces ''.
  function clearSelection(asEmpty = false) {
    if (!range || !editable) return;
    const writes = [];
    for (let vi = range.r1; vi <= range.r2; vi++) {
      for (let c = range.c1; c <= range.c2; c++) {
        const nullable = metaOf(c)?.nullable !== false;
        writes.push({ vi, c, v: !asEmpty && nullable ? null : '' });
      }
    }
    setCells(writes);
  }
  function addRows(count = 1) {
    if (!editable) return;
    mutate((prev) => ({
      ...prev,
      newRows: [...prev.newRows, ...Array.from({ length: count }, () => ({ key: newRowSeq++, vals: {} }))],
    }));
    // Select the first cell of the new row (not clamped: `total` is pre-insert here).
    const vi = total + count - 1;
    const c = sel?.fc ?? 0;
    setSel({ ar: vi, ac: c, fr: vi, fc: c });
  }
  function duplicateRows() {
    if (!editable || !range) return;
    const src = selectedViewRows();
    mutate((prev) => ({
      ...prev,
      newRows: [
        ...prev.newRows,
        ...src.map((vi) => {
          const r = R(vi);
          const vals = {};
          columns.forEach((col, c) => {
            if (!colEditable(c) || col.meta?.autoIncrement) return;
            const v = r < n ? (prev.edits[r] && c in prev.edits[r] ? prev.edits[r][c] : rows[r][c]) : prev.newRows[r - n].vals[c];
            if (v !== undefined && !isBlob(v)) vals[c] = v;
          });
          return { key: newRowSeq++, vals };
        }),
      ],
    }));
  }
  function toggleDeleteRows() {
    if (!editable || !range) return;
    const vis = selectedViewRows();
    mutate((prev) => {
      const del = new Set(prev.deleted);
      const dropNew = new Set();
      for (const vi of vis) {
        const r = R(vi);
        if (r >= n) dropNew.add(r - n);
        else if (del.has(r)) del.delete(r);
        else del.add(r);
      }
      return { ...prev, deleted: [...del], newRows: prev.newRows.filter((_, i) => !dropNew.has(i)) };
    });
  }
  function revertRows() {
    const vis = selectedViewRows().map(R).filter((r) => r < n);
    mutate((prev) => {
      const edits = { ...prev.edits };
      vis.forEach((r) => delete edits[r]);
      return { ...prev, edits, deleted: prev.deleted.filter((r) => !vis.includes(r)) };
    });
  }
  function undo() {
    const prev = undoRef.current.pop();
    if (!prev) return;
    stRef.current = prev;
    setSt(prev);
  }

  // ---- editing ----
  function startEdit(vi, c, initialText) {
    if (!cellEditable(vi, c)) {
      if (!editable) toast?.(readonlyReason || t('grid.readonly'), 'err');
      return;
    }
    const v = getVal(R(vi), c);
    const s = v === null || v === undefined ? '' : String(v);
    if (initialText === undefined && (s.length > 120 || s.includes('\n'))) { setBigEdit({ vi, c }); return; }
    setEditing({ vi, c, text: initialText ?? s, wasNull: v === null, wasUnset: v === undefined, fresh: initialText !== undefined });
  }
  function commitEdit(move) {
    const ed = editRef.current;
    if (!ed) return;
    editRef.current = null;
    setEditing(null);
    const noChange = (ed.wasNull || ed.wasUnset) && ed.text === '';
    if (!noChange) setCells([{ vi: ed.vi, c: ed.c, v: ed.text }]);
    if (move) moveTo(ed.vi + move[0], ed.c + move[1]);
    focusGrid();
  }

  // ---- clipboard ----
  function selectionMatrix(withHeader) {
    if (!range) return [];
    const m = [];
    if (withHeader) m.push(columns.slice(range.c1, range.c2 + 1).map((c) => c.name));
    for (let vi = range.r1; vi <= range.r2; vi++) {
      const r = R(vi);
      const row = [];
      for (let c = range.c1; c <= range.c2; c++) row.push(plainText(getVal(r, c)));
      m.push(row);
    }
    return m;
  }
  function insertStatements() {
    if (!range) return '';
    const cols = [];
    for (let c = range.c1; c <= range.c2; c++) cols.push(c);
    const tbl = tableName ? quoteId(tableName) : '`tabla`';
    const names = cols.map((c) => quoteId(tg[c] || columns[c].name)).join(', ');
    return selectedViewRows().map((vi) => {
      const r = R(vi);
      const vals = cols.map((c) => { const v = getVal(r, c); return v === undefined ? 'DEFAULT' : quoteVal(isBlob(v) ? null : v); });
      return `INSERT INTO ${tbl} (${names}) VALUES (${vals.join(', ')});`;
    }).join('\n');
  }
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); } catch { toast?.(t('grid.clipboardBlocked'), 'err'); }
  }
  function applyPaste(text) {
    if (!sel) return;
    if (!editable) { toast?.(readonlyReason || t('grid.readonly'), 'err'); return; }
    const m = parseTSV(text);
    if (!m.length) return;
    const conv = (s) => (s === NULL_TEXT ? null : s);
    const writes = [];
    // One value onto a multi-cell selection fills it, as in Excel.
    if (m.length === 1 && m[0].length === 1 && range && (range.r2 > range.r1 || range.c2 > range.c1)) {
      for (let vi = range.r1; vi <= range.r2; vi++) for (let c = range.c1; c <= range.c2; c++) writes.push({ vi, c, v: conv(m[0][0]) });
      setCells(writes);
      return;
    }
    const r0 = range.r1; const c0 = range.c1;
    const needed = Math.max(0, r0 + m.length - total);
    mutate((prev) => {
      let next = needed
        ? { ...prev, newRows: [...prev.newRows, ...Array.from({ length: needed }, () => ({ key: newRowSeq++, vals: {} }))] }
        : prev;
      const nTotal = n + next.newRows.length;
      const list = [];
      m.forEach((line, i) => {
        const vi = r0 + i;
        if (vi >= nTotal) return;
        const r = vi < n ? order[vi] : vi;
        if (r < n && next.deleted.includes(r)) return;
        line.forEach((s, j) => {
          const c = c0 + j;
          if (c > lastCol || !colEditable(c)) return;
          list.push({ r, c, v: conv(s) });
        });
      });
      return writeCells(next, list, rows, n);
    });
    setSel({ ar: r0, ac: c0, fr: Math.min(r0 + m.length - 1, total + needed - 1), fc: Math.min(c0 + m[0].length - 1, lastCol) });
  }

  // ---- save / preview ----
  function buildChanges() {
    const pkIdx = primaryKey.map((k) => tg.indexOf(k));
    const pkOf = (r) => Object.fromEntries(primaryKey.map((k, i) => [k, rows[r][pkIdx[i]]]));
    const updates = Object.entries(st.edits)
      .filter(([r]) => !delSet.has(Number(r)))
      .map(([r, e]) => ({ pk: pkOf(Number(r)), changes: Object.fromEntries(Object.entries(e).map(([c, v]) => [tg[c], v])) }));
    const deletes = st.deleted.map((r) => ({ pk: pkOf(r) }));
    const inserts = st.newRows.map((nr) => Object.fromEntries(
      Object.entries(nr.vals).filter(([, v]) => v !== undefined).map(([c, v]) => [tg[c], v])
    ));
    return { inserts, updates, deletes };
  }
  async function save() {
    if (!changeCount || saving) return;
    if (editing) commitEdit();
    setSaving(true);
    try {
      const r = await onSave(buildChanges(), false);
      toast?.(t('grid.saved', { n: r?.affected ?? 0 }), 'ok');
      setPreview(null);
      resetChanges();
      onSaved?.();
    } catch (e) {
      if (!e.silent) toast?.(e.message, 'err');
    } finally {
      setSaving(false);
    }
  }
  async function showPreview() {
    try {
      const r = await onSave(buildChanges(), true);
      setPreview(r.statements || []);
    } catch (e) { toast?.(e.message, 'err'); }
  }

  function exportAs(format) {
    const live = [];
    for (let vi = 0; vi < n; vi++) {
      const r = order[vi];
      if (delSet.has(r)) continue;
      live.push(columns.map((_, c) => { const v = getVal(r, c); return isBlob(v) ? null : v; }));
    }
    const names = columns.map((c) => c.name);
    if (format === 'json') {
      const keys = names.map((k, i) => (names.indexOf(k) === i ? k : `${k}_${i}`));
      downloadText(`${exportName}.json`, JSON.stringify(live.map((r) => Object.fromEntries(keys.map((k, i) => [k, r[i]]))), null, 2), 'application/json');
    } else {
      downloadText(`${exportName}.csv`, toCSV(names, live), 'text/csv');
    }
  }

  // ---- keyboard ----
  function onKeyDown(e) {
    if (editing || bigEdit || formRow !== null || preview) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key;
    if (menu && k === 'Escape') { setMenu(null); e.preventDefault(); return; }
    if (ctrl && (k === 's' || k === 'S')) { e.preventDefault(); save(); return; }
    if (ctrl && (k === 'z' || k === 'Z')) { e.preventDefault(); undo(); return; }
    if (ctrl && (k === 'a' || k === 'A')) { e.preventDefault(); if (total) setSel({ ar: 0, ac: 0, fr: total - 1, fc: lastCol }); return; }
    if (k === 'Insert') { e.preventDefault(); addRows(1); return; }
    if (!sel) {
      if (total && /^(Arrow|Tab|Enter|Home|End|Page)/.test(k)) { e.preventDefault(); moveTo(0, 0); }
      return;
    }
    const page = Math.max(1, Math.floor(vp.height / rowH) - 2);
    const shift = e.shiftKey;
    const handled = () => e.preventDefault();
    switch (k) {
      case 'ArrowUp': handled(); return moveTo(ctrl ? 0 : sel.fr - 1, sel.fc, shift);
      case 'ArrowDown': handled(); return moveTo(ctrl ? total - 1 : sel.fr + 1, sel.fc, shift);
      case 'ArrowLeft': handled(); return moveTo(sel.fr, ctrl ? 0 : sel.fc - 1, shift);
      case 'ArrowRight': handled(); return moveTo(sel.fr, ctrl ? lastCol : sel.fc + 1, shift);
      case 'PageUp': handled(); return moveTo(sel.fr - page, sel.fc, shift);
      case 'PageDown': handled(); return moveTo(sel.fr + page, sel.fc, shift);
      case 'Home': handled(); return moveTo(ctrl ? 0 : sel.fr, 0, shift);
      case 'End': handled(); return moveTo(ctrl ? total - 1 : sel.fr, lastCol, shift);
      case 'Tab': {
        handled();
        let r = sel.fr; let c = sel.fc + (shift ? -1 : 1);
        if (c > lastCol) { c = 0; r++; } else if (c < 0) { c = lastCol; r--; }
        return moveTo(r, c);
      }
      case 'Enter': handled(); return moveTo(sel.fr + (shift ? -1 : 1), sel.fc);
      case 'F2': handled(); return startEdit(sel.fr, sel.fc);
      case 'F4': handled(); return setBigEdit({ vi: sel.fr, c: sel.fc });
      case 'Delete':
        handled();
        return ctrl ? toggleDeleteRows() : clearSelection();
      case 'Backspace': handled(); return startEdit(sel.fr, sel.fc, '');
      case 'd': case 'D':
        if (ctrl) { handled(); return duplicateRows(); }
        break;
      default:
    }
    // Typing a character starts editing and replaces the content (Excel).
    if (!ctrl && !e.altKey && k.length === 1) {
      e.preventDefault();
      startEdit(sel.fr, sel.fc, k);
    }
  }
  function onCopy(e) {
    if (editing || bigEdit || formRow !== null || !range) return;
    e.preventDefault();
    e.clipboardData.setData('text/plain', toTSV(selectionMatrix(false)));
  }
  function onPaste(e) {
    if (editing || bigEdit || formRow !== null) return;
    e.preventDefault();
    applyPaste(e.clipboardData.getData('text/plain'));
  }

  // ---- mouse ----
  useEffect(() => {
    const up = () => { dragRef.current = null; };
    window.addEventListener('mouseup', up);
    return () => window.removeEventListener('mouseup', up);
  }, []);
  function cellDown(e, vi, c) {
    if (e.button !== 0) return;
    if (editing && !(editing.vi === vi && editing.c === c)) commitEdit();
    if (e.shiftKey && sel) setSel({ ...sel, fr: vi, fc: c });
    else setSel({ ar: vi, ac: c, fr: vi, fc: c });
    dragRef.current = 'cells';
    setMenu(null);
    focusGrid();
    if (!(editing && editing.vi === vi && editing.c === c)) e.preventDefault();
  }
  function cellEnter(vi, c) {
    if (dragRef.current === 'cells') setSel((s) => s && { ...s, fr: vi, fc: c });
    else if (dragRef.current === 'rows') setSel((s) => s && { ...s, fr: vi });
  }
  function rowDown(e, vi) {
    if (e.button !== 0) return;
    if (editing) commitEdit();
    if (e.shiftKey && sel) setSel({ ar: sel.ar, ac: 0, fr: vi, fc: lastCol });
    else setSel({ ar: vi, ac: 0, fr: vi, fc: lastCol });
    dragRef.current = 'rows';
    setMenu(null);
    focusGrid();
    e.preventDefault();
  }
  function onContext(e, vi, c) {
    e.preventDefault();
    if (!inRange(vi, c)) setSel({ ar: vi, ac: c, fr: vi, fc: c });
    setMenu({ x: Math.min(e.clientX, window.innerWidth - 240), y: Math.min(e.clientY, window.innerHeight - 380) });
    focusGrid();
  }
  function headerClick(c) {
    if (onSort) onSort(columns[c].name);
    else setLocalSort((s) => (s && s.c === c ? (s.dir === 'ASC' ? { c, dir: 'DESC' } : null) : { c, dir: 'ASC' }));
  }
  function startResize(e, c) {
    e.preventDefault(); e.stopPropagation();
    const x0 = e.clientX; const w0 = widths[c];
    const mv = (ev) => setWidths((w) => { const nw = w.slice(); nw[c] = Math.max(40, w0 + ev.clientX - x0); return nw; });
    const up = () => { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', mv);
    window.addEventListener('mouseup', up);
  }
  function autoFit(e, c) {
    e.stopPropagation();
    const w = fitWidth(c, end - start, FIT_MAX_MANUAL, (i) => getVal(R(start + i), c));
    setWidths((ws) => { const nw = ws.slice(); nw[c] = w; return nw; });
  }

  // ---- render ----
  const sortInfo = onSort ? (sort && { c: columns.findIndex((x) => x.name === sort.col), dir: sort.dir }) : localSort;
  const tableWidth = ROWNUM_W + widths.reduce((a, b) => a + b, 0);
  const activeRowDirty = sel && (() => { const r = R(sel.fr); return r < n && (st.edits[r] || delSet.has(r)); })();
  const reasonText = readonlyReason || t('grid.readonly');

  const bodyRows = [];
  for (let vi = start; vi < end; vi++) {
    const r = R(vi);
    const isNew = r >= n;
    const isDel = !isNew && delSet.has(r);
    bodyRows.push(
      <tr key={isNew ? 'n' + st.newRows[r - n].key : 'r' + r} className={'data' + (isNew ? ' new' : '') + (isDel ? ' del' : '')}>
        <td className={'rownum' + (range && vi >= range.r1 && vi <= range.r2 ? ' selrow' : '')} onMouseDown={(e) => rowDown(e, vi)} onMouseEnter={() => cellEnter(vi, 0)}>
          {isNew ? '＊' : rowOffset + r + 1}
        </td>
        {columns.map((col, c) => {
          const v = getVal(r, c);
          const isEd = editing && editing.vi === vi && editing.c === c;
          const dirty = isNew ? v !== undefined : !!(st.edits[r] && c in st.edits[r]);
          const cls = [
            v === null ? 'null' : '', v === undefined ? 'unset' : '', dirty ? 'changed' : '',
            inRange(vi, c) ? 'sel' : '', sel && sel.fr === vi && sel.fc === c ? 'active' : '',
            colEditable(c) ? '' : 'ro', isEd ? 'editing' : '',
          ].filter(Boolean).join(' ');
          return (
            <td
              key={c}
              data-cell={`${vi}:${c}`}
              className={cls}
              title={!isEd && typeof v === 'string' && v.length > 40 ? v.slice(0, 1000) : undefined}
              onMouseDown={(e) => cellDown(e, vi, c)}
              onMouseEnter={() => cellEnter(vi, c)}
              onDoubleClick={() => startEdit(vi, c)}
              onContextMenu={(e) => onContext(e, vi, c)}
            >
              {isEd ? (
                <InlineEditor
                  editing={editing}
                  meta={col.meta}
                  onChange={(text) => setEditing((ed) => ({ ...ed, text }))}
                  onCommit={commitEdit}
                  onCancel={() => { setEditing(null); focusGrid(); }}
                  onBig={() => { setEditing(null); setBigEdit({ vi, c, text: editing.text }); }}
                />
              ) : displayOf(v, col.meta)}
            </td>
          );
        })}
      </tr>
    );
  }

  return (
    <div className="egrid-wrap">
      <div className="egrid-tools">
        {leftTools}
        <span style={{ flex: 1 }} />
        {editable ? (
          <>
            <button className="mini" title={t('grid.addRowTitle')} onClick={() => addRows(1)}>＋ {t('grid.row')}</button>
            <button className="mini" title={t('grid.duplicateTitle')} onClick={duplicateRows} disabled={!range}>⧉</button>
            <button className="mini" title={t('grid.deleteTitle')} onClick={toggleDeleteRows} disabled={!range}>✕</button>
            <button className="mini" title={t('grid.undoTitle')} onClick={undo} disabled={!undoRef.current.length}>↶</button>
            <button className="mini" title={t('grid.formTitle')} onClick={() => sel && setFormRow(sel.fr)} disabled={!sel}>☰</button>
            {changeCount > 0 && <span className="badge">{t('grid.pending', { n: changeCount })}</span>}
            <button className="mini" onClick={() => mutate(() => EMPTY)} disabled={!changeCount}>{t('grid.discard')}</button>
            <button className="mini" title={t('grid.previewTitle')} onClick={showPreview} disabled={!changeCount}>SQL</button>
            <button className="mini primary" title="Ctrl+S" onClick={save} disabled={!changeCount || saving}>{saving ? '…' : t('grid.save')}</button>
          </>
        ) : (
          <>
            <button className="mini" title={t('grid.formTitle')} onClick={() => sel && setFormRow(sel.fr)} disabled={!sel}>☰</button>
            <span className="badge ro-badge" title={reasonText}>{t('grid.readonlyShort')}</span>
          </>
        )}
        <button className="mini" onClick={() => exportAs('csv')}>⤓︎ CSV</button>
        <button className="mini" onClick={() => exportAs('json')}>⤓︎ JSON</button>
      </div>

      <div
        className="egrid-scroll"
        ref={scrollRef}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onCopy={onCopy}
        onPaste={onPaste}
        onScroll={(e) => setVp({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight })}
      >
        <table className="grid egrid" style={{ width: tableWidth }}>
          <colgroup>
            <col style={{ width: ROWNUM_W }} />
            {widths.map((w, i) => <col key={i} style={{ width: w }} />)}
          </colgroup>
          <thead>
            <tr>
              <th className="rownum corner" onClick={() => total && setSel({ ar: 0, ac: 0, fr: total - 1, fc: lastCol })}>#</th>
              {columns.map((col, c) => {
                const m = col.meta;
                const isPk = tg[c] && primaryKey.includes(tg[c]);
                return (
                  <th
                    key={c}
                    className={colEditable(c) ? '' : 'ro'}
                    title={[col.name, m?.columnType, m ? (m.nullable ? 'NULL' : 'NOT NULL') : '', m?.autoIncrement ? 'AUTO_INCREMENT' : '', !colEditable(c) && editable ? t('grid.colReadonly') : ''].filter(Boolean).join(' · ')}
                    onClick={() => headerClick(c)}
                  >
                    {isPk ? <span className="pk">PK</span> : null}{col.name}
                    {sortInfo && sortInfo.c === c ? (sortInfo.dir === 'ASC' ? ' ▲' : ' ▼') : ''}
                    <span className="resizer" onMouseDown={(e) => startResize(e, c)} onDoubleClick={(e) => autoFit(e, c)} onClick={(e) => e.stopPropagation()} />
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {start > 0 && <tr className="spacer" style={{ height: start * rowH }}><td colSpan={columns.length + 1} /></tr>}
            {bodyRows}
            {end < total && <tr className="spacer" style={{ height: (total - end) * rowH }}><td colSpan={columns.length + 1} /></tr>}
            {total === 0 && (
              <tr><td colSpan={columns.length + 1} className="empty-row">{t('grid.noRows')}</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => { setMenu(null); focusGrid(); }} items={[
          { label: t('grid.copy'), hint: 'Ctrl+C', run: () => copyText(toTSV(selectionMatrix(false))) },
          { label: t('grid.copyHeaders'), run: () => copyText(toTSV(selectionMatrix(true))) },
          { label: t('grid.copyInsert'), run: () => copyText(insertStatements()) },
          editable && { label: t('grid.paste'), hint: 'Ctrl+V', run: () => navigator.clipboard.readText().then(applyPaste).catch(() => toast?.(t('grid.clipboardBlocked'), 'err')) },
          '-',
          editable && { label: t('grid.editCell'), hint: 'F2', run: () => startEdit(sel.fr, sel.fc), disabled: !sel || !cellEditable(sel.fr, sel.fc) },
          { label: editable ? t('grid.editBig') : t('grid.viewBig'), hint: 'F4', run: () => setBigEdit({ vi: sel.fr, c: sel.fc }), disabled: !sel },
          editable && { label: t('grid.setNull'), hint: t('grid.deleteKey'), run: () => clearSelection(false) },
          editable && { label: t('grid.setEmpty'), run: () => clearSelection(true) },
          '-',
          editable && { label: t('grid.addRow'), hint: 'Insert', run: () => addRows(1) },
          editable && { label: t('grid.duplicate'), hint: 'Ctrl+D', run: duplicateRows },
          editable && { label: t('grid.deleteRows'), hint: 'Ctrl+Supr', run: toggleDeleteRows },
          editable && activeRowDirty && { label: t('grid.revertRow'), run: revertRows },
          '-',
          { label: t('grid.form'), run: () => setFormRow(sel.fr), disabled: !sel },
        ]} />
      )}

      {bigEdit && (
        <BigEditor
          title={`${columns[bigEdit.c].name}${columns[bigEdit.c].meta?.columnType ? ' · ' + columns[bigEdit.c].meta.columnType : ''}`}
          value={bigEdit.text ?? getVal(R(bigEdit.vi), bigEdit.c)}
          readOnly={!cellEditable(bigEdit.vi, bigEdit.c)}
          nullable={columns[bigEdit.c].meta?.nullable !== false}
          onSave={(v) => { setCells([{ vi: bigEdit.vi, c: bigEdit.c, v }]); setBigEdit(null); focusGrid(); }}
          onClose={() => { setBigEdit(null); focusGrid(); }}
        />
      )}

      {formRow !== null && formRow < total && (
        <FormView
          vi={formRow}
          total={total}
          rowLabel={R(formRow) < n ? rowOffset + R(formRow) + 1 : '＊'}
          columns={columns}
          targets={tg}
          primaryKey={primaryKey}
          getVal={(c) => getVal(R(formRow), c)}
          isDirty={(c) => { const r = R(formRow); return r < n ? !!(st.edits[r] && c in st.edits[r]) : st.newRows[r - n]?.vals[c] !== undefined; }}
          canEdit={(c) => cellEditable(formRow, c)}
          onChange={(c, v) => setCells([{ vi: formRow, c, v }])}
          onNav={(vi) => { setFormRow(vi); moveTo(vi, sel?.fc ?? 0); }}
          onNew={editable ? () => { addRows(1); setFormRow(total); } : null}
          onClose={() => { setFormRow(null); focusGrid(); }}
        />
      )}

      {preview && (
        <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setPreview(null)}>
          <div className="modal wide">
            <h3>{t('grid.previewHeading', { n: preview.length })}</h3>
            <div className="content">
              <pre className="ddl sql-preview">{preview.map((s) => s + ';').join('\n')}</pre>
            </div>
            <div className="actions">
              <button onClick={() => copyText(preview.map((s) => s + ';').join('\n'))}>{t('grid.copy')}</button>
              <span style={{ flex: 1 }} />
              <button onClick={() => setPreview(null)}>{t('conn.cancel')}</button>
              <button className="primary" onClick={save} disabled={saving}>{t('grid.runSave')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function InlineEditor({ editing, meta, onChange, onCommit, onCancel, onBig }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    if (el.setSelectionRange) {
      if (editing.fresh) el.setSelectionRange(el.value.length, el.value.length);
      else el.select();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const keys = (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && e.altKey) { e.preventDefault(); onBig(); return; }
    if (e.key === 'Enter') { e.preventDefault(); onCommit([e.shiftKey ? -1 : 1, 0]); }
    else if (e.key === 'Tab') { e.preventDefault(); onCommit([0, e.shiftKey ? -1 : 1]); }
    else if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
  };
  if (meta?.options) {
    return (
      <select
        ref={ref}
        className="cell-input"
        value={editing.text}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={keys}
        onBlur={() => onCommit()}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {!meta.options.includes(editing.text) && <option value={editing.text}>{editing.text}</option>}
        {meta.options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  }
  return (
    <input
      ref={ref}
      className="cell-input"
      value={editing.text}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={keys}
      onBlur={() => onCommit()}
      onMouseDown={(e) => e.stopPropagation()}
      onCopy={(e) => e.stopPropagation()}
      onPaste={(e) => e.stopPropagation()}
    />
  );
}

function ContextMenu({ x, y, items, onClose }) {
  useEffect(() => {
    const close = (e) => { if (!e.target.closest?.('.ctx-menu')) onClose(); };
    const t = setTimeout(() => window.addEventListener('mousedown', close), 0);
    return () => { clearTimeout(t); window.removeEventListener('mousedown', close); };
  }, [onClose]);
  const list = items.filter(Boolean).filter((it, i, arr) => it !== '-' || (i > 0 && arr[i - 1] !== '-' && i < arr.length - 1));
  return (
    <div className="ctx-menu" style={{ left: x, top: y }} onContextMenu={(e) => e.preventDefault()}>
      {list.map((it, i) => (it === '-' ? <div key={i} className="sep" /> : (
        <button key={i} disabled={it.disabled} onClick={() => { onClose(); it.run(); }}>
          <span>{it.label}</span>{it.hint && <span className="hint">{it.hint}</span>}
        </button>
      )))}
    </div>
  );
}

function BigEditor({ title, value, readOnly, nullable, onSave, onClose }) {
  const { t } = useI18n();
  const [text, setText] = useState(value === null || value === undefined ? '' : isBlob(value) ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value));
  const [isNull, setIsNull] = useState(value === null);
  let json = null;
  try { const s = text.trim(); if (s.startsWith('{') || s.startsWith('[')) json = JSON.parse(s); } catch { json = null; }
  const save = () => onSave(isNull ? null : text);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal wide">
        <h3>{title}</h3>
        <div className="content">
          <textarea
            className="big-text"
            value={isNull ? '' : text}
            placeholder={isNull ? NULL_TEXT : ''}
            readOnly={readOnly || isNull}
            autoFocus
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') { e.preventDefault(); onClose(); }
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !readOnly) { e.preventDefault(); save(); }
            }}
          />
          <div className="big-tools">
            {!readOnly && nullable && (
              <label className="radio"><input type="checkbox" checked={isNull} onChange={(e) => setIsNull(e.target.checked)} /> NULL</label>
            )}
            {json && !isNull && (
              <>
                <button className="mini" onClick={() => setText(JSON.stringify(json, null, 2))}>{t('grid.jsonPretty')}</button>
                <button className="mini" onClick={() => setText(JSON.stringify(json))}>{t('grid.jsonCompact')}</button>
              </>
            )}
            <span className="count">{t('grid.chars', { n: text.length })}</span>
          </div>
        </div>
        <div className="actions">
          <button onClick={onClose}>{readOnly ? t('grid.close') : t('conn.cancel')}</button>
          {!readOnly && <button className="primary" title="Ctrl+Enter" onClick={save}>{t('grid.apply')}</button>}
        </div>
      </div>
    </div>
  );
}

function FormView({ vi, total, rowLabel, columns, targets, primaryKey, getVal, isDirty, canEdit, onChange, onNav, onNew, onClose }) {
  const { t } = useI18n();
  useEffect(() => {
    const k = (e) => {
      if (e.key === 'Escape') onClose();
      if (e.altKey && e.key === 'ArrowDown' && vi < total - 1) { e.preventDefault(); onNav(vi + 1); }
      if (e.altKey && e.key === 'ArrowUp' && vi > 0) { e.preventDefault(); onNav(vi - 1); }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [vi, total, onNav, onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal wide form-view">
        <h3>
          {t('grid.formHeading', { row: rowLabel })}
          <span className="count" style={{ marginLeft: 8 }}>{vi + 1} / {total}</span>
        </h3>
        <div className="content form-fields">
          {columns.map((col, c) => {
            const v = getVal(c);
            const ed = canEdit(c);
            const m = col.meta;
            const s = v === null || v === undefined ? '' : isBlob(v) ? `(BLOB ${v.data.length} B)` : typeof v === 'object' ? JSON.stringify(v) : String(v);
            const long = s.length > 60 || s.includes('\n') || /text|json|blob/i.test(m?.columnType || '');
            const key = `${vi}:${c}:${s}`;
            return (
              <div key={c} className={'form-row' + (isDirty(c) ? ' changed' : '')}>
                <label title={m?.columnType || ''}>
                  {targets[c] && primaryKey.includes(targets[c]) && <span className="pk">PK</span>}
                  {col.name}
                  <span className="count">{m?.columnType || ''}</span>
                </label>
                <div className="form-ctl">
                  {m?.options ? (
                    <select disabled={!ed || v === null} value={v ?? ''} onChange={(e) => onChange(c, e.target.value)}>
                      {v != null && !m.options.includes(String(v)) && <option value={String(v)}>{String(v)}</option>}
                      {v == null && <option value="">{v === null ? NULL_TEXT : '(DEFAULT)'}</option>}
                      {m.options.map((o) => <option key={o} value={o}>{o}</option>)}
                    </select>
                  ) : long ? (
                    <textarea key={key} rows={3} defaultValue={s} readOnly={!ed} placeholder={v === null ? NULL_TEXT : v === undefined ? '(DEFAULT)' : ''}
                      onBlur={(e) => { if (ed && !(v == null && e.target.value === '') && e.target.value !== s) onChange(c, e.target.value); }} />
                  ) : (
                    <input key={key} defaultValue={s} readOnly={!ed} placeholder={v === null ? NULL_TEXT : v === undefined ? (m?.autoIncrement ? '(Auto)' : '(DEFAULT)') : ''}
                      onBlur={(e) => { if (ed && !(v == null && e.target.value === '') && e.target.value !== s) onChange(c, e.target.value); }}
                      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
                  )}
                  {ed && m?.nullable !== false && (
                    <label className="radio null-toggle">
                      <input type="checkbox" checked={v === null} onChange={(e) => onChange(c, e.target.checked ? null : '')} /> NULL
                    </label>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <div className="actions">
          <button onClick={() => onNav(0)} disabled={vi === 0}>⏮</button>
          <button onClick={() => onNav(vi - 1)} disabled={vi === 0} title="Alt+↑">◀</button>
          <button onClick={() => onNav(vi + 1)} disabled={vi >= total - 1} title="Alt+↓">▶</button>
          <button onClick={() => onNav(total - 1)} disabled={vi >= total - 1}>⏭</button>
          {onNew && <button onClick={onNew}>＋ {t('grid.row')}</button>}
          <span style={{ flex: 1 }} />
          <button className="primary" onClick={onClose}>{t('grid.close')}</button>
        </div>
      </div>
    </div>
  );
}
