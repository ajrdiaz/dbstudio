import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { useI18n } from '../i18n.jsx';
import { downloadText } from '../lib/download.js';

// Interactive ER diagram of one database: automatic layered layout
// (referenced tables to the left), crow's-foot relationship lines, pan/zoom,
// draggable tables (positions remembered per connection+db), highlight on
// click, "keys only" mode and PNG/SVG export.
const ROW_H = 18;
const HEAD_H = 26;
const GAP_X = 90;
const GAP_Y = 28;

function boxWidth(tb) {
  let w = 12 + tb.name.length * 7.6 + 40;
  for (const c of tb.columns) w = Math.max(w, 34 + c.name.length * 6.8 + 14 + shortType(c.type).length * 6.2);
  return Math.min(360, Math.max(170, Math.round(w)));
}
const shortType = (t) => (t.length > 22 ? t.slice(0, 21) + '…' : t);

// Layered layout: level = longest FK chain to a table with no outgoing FKs.
function autoLayout(tables, relations, keysOnly) {
  const out = {};
  const byName = Object.fromEntries(tables.map((t) => [t.name, t]));
  const targets = {};
  for (const r of relations) if (!r.external && r.toTable !== r.fromTable && byName[r.toTable]) (targets[r.fromTable] ||= new Set()).add(r.toTable);
  const level = {};
  const visit = (n, stack = new Set()) => {
    if (level[n] != null) return level[n];
    if (stack.has(n)) return 0;
    stack.add(n);
    let l = 0;
    for (const t of targets[n] || []) l = Math.max(l, 1 + visit(t, stack));
    stack.delete(n);
    level[n] = l;
    return l;
  };
  const connected = new Set();
  for (const r of relations) if (!r.external && byName[r.toTable]) { connected.add(r.fromTable); connected.add(r.toTable); }
  for (const t of tables) if (connected.has(t.name)) visit(t.name);
  const cols = [];
  for (const t of tables) if (connected.has(t.name)) (cols[level[t.name]] ||= []).push(t);
  // Order each column by the average position of its neighbours in the previous one.
  const order = {};
  cols.forEach((col, ci) => {
    if (ci > 0) {
      const bary = (t) => {
        const ns = [...(targets[t.name] || [])].filter((n) => order[n] != null);
        return ns.length ? ns.reduce((a, n) => a + order[n], 0) / ns.length : 1e9;
      };
      col.sort((a, b) => bary(a) - bary(b) || a.name.localeCompare(b.name));
    } else col.sort((a, b) => a.name.localeCompare(b.name));
    col.forEach((t, i) => { order[t.name] = i; });
  });
  let x = 20; let maxH = 0;
  for (const col of cols.filter(Boolean)) {
    let y = 20;
    const w = Math.max(...col.map(boxWidth));
    for (const t of col) { out[t.name] = { x, y }; y += boxHeight(t, keysOnly, relations) + GAP_Y; }
    maxH = Math.max(maxH, y);
    x += w + GAP_X;
  }
  // Unrelated tables: a grid below.
  const loose = tables.filter((t) => !connected.has(t.name)).sort((a, b) => a.name.localeCompare(b.name));
  let lx = 20; let ly = maxH + (maxH ? 40 : 20); let rowH = 0;
  const maxW = Math.max(x, 1100);
  for (const t of loose) {
    const w = boxWidth(t);
    if (lx + w > maxW && lx > 20) { lx = 20; ly += rowH + GAP_Y; rowH = 0; }
    out[t.name] = { x: lx, y: ly };
    lx += w + 40;
    rowH = Math.max(rowH, boxHeight(t, keysOnly, relations));
  }
  return out;
}

function fkCols(name, relations) {
  const s = new Set();
  for (const r of relations) if (r.fromTable === name) r.fromCols.forEach((c) => s.add(c));
  return s;
}
function visibleCols(t, keysOnly, relations) {
  if (!keysOnly) return t.columns;
  const fk = fkCols(t.name, relations);
  return t.columns.filter((c) => c.pk || fk.has(c.name));
}
function boxHeight(t, keysOnly, relations) {
  const vis = visibleCols(t, keysOnly, relations);
  const more = t.columns.length - vis.length;
  return HEAD_H + vis.length * ROW_H + (more > 0 ? ROW_H : 0) + 6;
}

export default function ErdView({ connId, db, onOpenData, onOpenStructure, toast }) {
  const { t } = useI18n();
  const storeKey = `dbstudio-erd:${connId}:${db}`;
  const [model, setModel] = useState(null);
  const [pos, setPos] = useState({});
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const [keysOnly, setKeysOnly] = useState(false);
  const [sel, setSel] = useState(null);
  const [find, setFind] = useState('');
  const wrapRef = useRef(null);
  const svgRef = useRef(null);
  const drag = useRef(null);

  useEffect(() => {
    let alive = true;
    api.dbinfo.erd(connId, db).then((m) => {
      if (!alive) return;
      setModel(m);
      let saved = {};
      try { saved = JSON.parse(localStorage.getItem(storeKey) || '{}'); } catch { /* ignore */ }
      const auto = autoLayout(m.tables, m.relations, false);
      setPos(Object.fromEntries(m.tables.map((tb) => [tb.name, saved.pos?.[tb.name] || auto[tb.name]])));
      if (saved.keysOnly) setKeysOnly(true);
      requestAnimationFrame(() => fitRef.current?.(Object.fromEntries(m.tables.map((tb) => [tb.name, saved.pos?.[tb.name] || auto[tb.name]])), m));
    }).catch((e) => toast(e.message, 'err'));
    return () => { alive = false; };
  }, [connId, db, storeKey, toast]);

  // Remember positions and mode.
  useEffect(() => {
    if (!model) return;
    try { localStorage.setItem(storeKey, JSON.stringify({ pos, keysOnly })); } catch { /* ignore */ }
  }, [pos, keysOnly, model, storeKey]);

  const sizes = useMemo(() => {
    if (!model) return {};
    return Object.fromEntries(model.tables.map((tb) => [tb.name, { w: boxWidth(tb), h: boxHeight(tb, keysOnly, model.relations) }]));
  }, [model, keysOnly]);

  const fitRef = useRef(null);
  const fit = useCallback((p = pos, m = model) => {
    const el = wrapRef.current;
    if (!el || !m || !m.tables.length) return;
    let x1 = Infinity; let y1 = Infinity; let x2 = -Infinity; let y2 = -Infinity;
    for (const tb of m.tables) {
      const q = p[tb.name]; if (!q) continue;
      const w = boxWidth(tb); const h = boxHeight(tb, keysOnly, m.relations);
      x1 = Math.min(x1, q.x); y1 = Math.min(y1, q.y); x2 = Math.max(x2, q.x + w); y2 = Math.max(y2, q.y + h);
    }
    const W = el.clientWidth; const H = el.clientHeight;
    const k = Math.min(1.4, Math.max(0.15, Math.min(W / (x2 - x1 + 60), H / (y2 - y1 + 60))));
    setView({ k, x: (W - (x2 - x1) * k) / 2 - x1 * k, y: (H - (y2 - y1) * k) / 2 - y1 * k });
  }, [pos, model, keysOnly]);
  fitRef.current = fit;

  // ---- pan / zoom / drag ----
  function onWheel(e) {
    e.preventDefault();
    const r = wrapRef.current.getBoundingClientRect();
    const mx = e.clientX - r.left; const my = e.clientY - r.top;
    setView((v) => {
      const k = Math.min(3, Math.max(0.1, v.k * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
      return { k, x: mx - ((mx - v.x) / v.k) * k, y: my - ((my - v.y) / v.k) * k };
    });
  }
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  });
  function down(e, table) {
    if (e.button !== 0) return;
    e.stopPropagation();
    drag.current = table
      ? { kind: 'table', table, sx: e.clientX, sy: e.clientY, ox: pos[table].x, oy: pos[table].y, moved: false }
      : { kind: 'pan', sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y, moved: false };
    const mv = (ev) => {
      const d = drag.current; if (!d) return;
      const dx = ev.clientX - d.sx; const dy = ev.clientY - d.sy;
      if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
      if (d.kind === 'table') setPos((p) => ({ ...p, [d.table]: { x: d.ox + dx / view.k, y: d.oy + dy / view.k } }));
      else setView((v) => ({ ...v, x: d.ox + dx, y: d.oy + dy }));
    };
    const up = () => {
      const d = drag.current;
      if (d && !d.moved) setSel(d.kind === 'table' ? d.table : null);
      drag.current = null;
      window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', mv);
    window.addEventListener('mouseup', up);
  }

  function relayout() {
    const auto = autoLayout(model.tables, model.relations, keysOnly);
    setPos(auto);
    requestAnimationFrame(() => fit(auto));
  }
  function goTo(name) {
    const q = pos[name]; const el = wrapRef.current;
    if (!q || !el) return;
    setSel(name);
    setView((v) => ({ ...v, x: el.clientWidth / 2 - (q.x + sizes[name].w / 2) * v.k, y: el.clientHeight / 3 - q.y * v.k }));
  }

  // ---- export (colors resolved from the current theme) ----
  function svgString() {
    const svg = svgRef.current.cloneNode(true);
    const cs = getComputedStyle(document.documentElement);
    const v = (n) => cs.getPropertyValue(n).trim();
    svg.querySelector('.erd-grid')?.remove();
    const g = svg.querySelector('g.erd-root');
    g.setAttribute('transform', '');
    let x1 = Infinity; let y1 = Infinity; let x2 = -Infinity; let y2 = -Infinity;
    for (const tb of model.tables) {
      const q = pos[tb.name]; const s = sizes[tb.name];
      x1 = Math.min(x1, q.x); y1 = Math.min(y1, q.y); x2 = Math.max(x2, q.x + s.w); y2 = Math.max(y2, q.y + s.h);
    }
    svg.setAttribute('viewBox', `${x1 - 20} ${y1 - 20} ${x2 - x1 + 40} ${y2 - y1 + 40}`);
    svg.setAttribute('width', x2 - x1 + 40); svg.setAttribute('height', y2 - y1 + 40);
    svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
    style.textContent = `
      text { font-family: Segoe UI, Arial, sans-serif; font-size: 12px; fill: ${v('--text')}; }
      .erd-bg { fill: ${v('--bg')}; }
      .erd-box { fill: ${v('--panel')}; stroke: ${v('--border')}; }
      .erd-head { fill: ${v('--accent-soft')}; }
      .erd-title { font-weight: 700; }
      .erd-type, .erd-more { fill: ${v('--muted')}; font-size: 11px; }
      .erd-key { fill: ${v('--accent')}; font-size: 9px; font-weight: 700; }
      .erd-rel { fill: none; stroke: ${v('--muted')}; stroke-width: 1.4; }
      .erd-view .erd-box { stroke-dasharray: 4 3; }`;
    svg.insertBefore(style, svg.firstChild);
    const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    bg.setAttribute('class', 'erd-bg'); bg.setAttribute('x', x1 - 20); bg.setAttribute('y', y1 - 20);
    bg.setAttribute('width', x2 - x1 + 40); bg.setAttribute('height', y2 - y1 + 40);
    svg.insertBefore(bg, style.nextSibling);
    return new XMLSerializer().serializeToString(svg);
  }
  function exportSvg() { downloadText(`${db}-erd.svg`, svgString(), 'image/svg+xml'); }
  function exportPng() {
    const s = svgString();
    const img = new Image();
    img.onload = () => {
      const scale = 2;
      const c = document.createElement('canvas');
      c.width = img.width * scale; c.height = img.height * scale;
      const ctx = c.getContext('2d');
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0);
      c.toBlob((b) => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(b); a.download = `${db}-erd.png`; a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      });
    };
    img.onerror = () => toast(t('erd.exportError'), 'err');
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(s);
  }

  if (!model) return <div className="empty">…</div>;
  if (!model.tables.length) return <div className="empty">{t('erd.empty')}</div>;

  const related = new Set();
  if (sel) for (const r of model.relations) { if (r.fromTable === sel) related.add(r.toTable); if (r.toTable === sel) related.add(r.fromTable); }
  const dim = (name) => sel && name !== sel && !related.has(name);
  const rowY = (tb, col) => {
    const vis = visibleCols(tb, keysOnly, model.relations);
    const i = vis.findIndex((c) => c.name === col);
    return HEAD_H + (i < 0 ? 0 : i) * ROW_H + ROW_H / 2 + 2;
  };
  const byName = Object.fromEntries(model.tables.map((tb) => [tb.name, tb]));
  const matches = find.trim() ? model.tables.filter((tb) => tb.name.toLowerCase().includes(find.trim().toLowerCase())) : [];

  return (
    <div className="erd">
      <div className="data-toolbar">
        <input className="filter" placeholder={t('erd.find')} value={find} onChange={(e) => setFind(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && matches[0]) goTo(matches[0].name); }} />
        {matches.slice(0, 5).map((m) => <button key={m.name} className="mini" onClick={() => goTo(m.name)}>{m.name}</button>)}
        <span style={{ flex: 1 }} />
        <label className="radio"><input type="checkbox" checked={keysOnly} onChange={(e) => setKeysOnly(e.target.checked)} /> {t('erd.keysOnly')}</label>
        <button className="mini" onClick={() => setView((v) => ({ ...v, k: Math.min(3, v.k * 1.2) }))}>＋</button>
        <button className="mini" onClick={() => setView((v) => ({ ...v, k: Math.max(0.1, v.k / 1.2) }))}>－</button>
        <span className="count">{Math.round(view.k * 100)}%</span>
        <button className="mini" onClick={() => fit()}>{t('erd.fit')}</button>
        <button className="mini" onClick={relayout} title={t('erd.relayoutTitle')}>{t('erd.relayout')}</button>
        <button className="mini" onClick={exportPng}>⤓︎ PNG</button>
        <button className="mini" onClick={exportSvg}>⤓︎ SVG</button>
      </div>
      <div className="erd-canvas" ref={wrapRef} onMouseDown={(e) => down(e, null)}>
        <svg ref={svgRef} width="100%" height="100%">
          <defs>
            <pattern id="erd-dots" width="20" height="20" patternUnits="userSpaceOnUse" patternTransform={`translate(${view.x},${view.y}) scale(${view.k})`}>
              <circle cx="1" cy="1" r="1" className="erd-dot" />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#erd-dots)" className="erd-grid" />
          <g className="erd-root" transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
            {model.relations.filter((r) => !r.external && byName[r.toTable] && pos[r.fromTable] && pos[r.toTable]).map((r) => {
              const a = pos[r.fromTable]; const b = pos[r.toTable];
              const sa = sizes[r.fromTable]; const sb = sizes[r.toTable];
              const ay = a.y + rowY(byName[r.fromTable], r.fromCols[0]);
              const by = b.y + rowY(byName[r.toTable], r.toCols[0]);
              const hot = sel && (r.fromTable === sel || r.toTable === sel);
              let d; let ax; let bx; let dirA; let dirB;
              if (r.fromTable === r.toTable) {
                ax = a.x + sa.w; bx = a.x + sa.w;
                d = `M${ax},${ay} C${ax + 50},${ay} ${bx + 50},${by} ${bx},${by}`;
                dirA = 1; dirB = 1;
              } else {
                const right = b.x + sb.w / 2 > a.x + sa.w / 2;
                ax = right ? a.x + sa.w : a.x; bx = right ? b.x : b.x + sb.w;
                dirA = right ? 1 : -1; dirB = right ? -1 : 1;
                const dx = Math.max(40, Math.abs(bx - ax) / 2);
                d = `M${ax},${ay} C${ax + dirA * dx},${ay} ${bx + dirB * dx},${by} ${bx},${by}`;
              }
              // crow's foot (many) at the FK side, a bar (one) at the referenced side
              const foot = `M${ax + dirA * 12},${ay} L${ax},${ay - 6} M${ax + dirA * 12},${ay} L${ax},${ay + 6} M${ax + dirA * 12},${ay} L${ax},${ay}`;
              const bar = `M${bx + dirB * 8},${by - 6} L${bx + dirB * 8},${by + 6}`;
              return (
                <g key={r.fromTable + r.name} className={'erd-relg' + (hot ? ' hot' : sel ? ' dim' : '')}>
                  <title>{`${r.name}: ${r.fromTable}(${r.fromCols.join(', ')}) → ${r.toTable}(${r.toCols.join(', ')})`}</title>
                  <path d={d} className="erd-rel" />
                  <path d={foot} className="erd-rel" />
                  <path d={bar} className="erd-rel" />
                </g>
              );
            })}
            {model.tables.map((tb) => {
              const q = pos[tb.name]; if (!q) return null;
              const s = sizes[tb.name];
              const vis = visibleCols(tb, keysOnly, model.relations);
              const fk = fkCols(tb.name, model.relations);
              const more = tb.columns.length - vis.length;
              return (
                <g key={tb.name} transform={`translate(${q.x},${q.y})`}
                  className={'erd-table' + (tb.view ? ' erd-view' : '') + (sel === tb.name ? ' sel' : '') + (dim(tb.name) ? ' dim' : '')}
                  onMouseDown={(e) => down(e, tb.name)}
                  onDoubleClick={() => onOpenData(connId, db, tb.name)}>
                  <rect width={s.w} height={s.h} rx="6" className="erd-box" />
                  <path d={`M0,6 a6,6 0 0 1 6,-6 h${s.w - 12} a6,6 0 0 1 6,6 v${HEAD_H - 6} h-${s.w} Z`} className="erd-head" />
                  <text x="10" y="17" className="erd-title">{tb.view ? '◫ ' : ''}{tb.name}</text>
                  {tb.rowsApprox != null && !tb.view && <text x={s.w - 8} y="17" textAnchor="end" className="erd-more">~{tb.rowsApprox.toLocaleString()}</text>}
                  {vis.map((c, i) => (
                    <g key={c.name} transform={`translate(0,${HEAD_H + i * ROW_H})`}>
                      {c.pk && <text x="8" y="13" className="erd-key">PK</text>}
                      {!c.pk && fk.has(c.name) && <text x="8" y="13" className="erd-key">FK</text>}
                      <text x="30" y="13" className={c.nullable ? 'erd-col' : 'erd-col notnull'}>{c.name}</text>
                      <text x={s.w - 8} y="13" textAnchor="end" className="erd-type">{shortType(c.type)}</text>
                    </g>
                  ))}
                  {more > 0 && <text x="30" y={HEAD_H + vis.length * ROW_H + 13} className="erd-more">{t('erd.more', { n: more })}</text>}
                </g>
              );
            })}
          </g>
        </svg>
        <div className="erd-legend count">{t('erd.legend')}</div>
        {sel && (
          <div className="erd-sel note">
            <b>{sel}</b>
            <span className="count">{t('erd.relCount', { n: model.relations.filter((r) => r.fromTable === sel || r.toTable === sel).length })}</span>
            <button className="mini" onClick={() => onOpenData(connId, db, sel)}>{t('search.data')}</button>
            <button className="mini" onClick={() => onOpenStructure(connId, db, sel)}>{t('search.structure')}</button>
          </div>
        )}
      </div>
    </div>
  );
}
