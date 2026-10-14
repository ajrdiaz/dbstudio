import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { useI18n } from '../i18n.jsx';
import { EnvBadge, getConn } from '../lib/env.jsx';

// "Search objects" (pgAdmin) / quick open (VS Code Ctrl+P): find tables,
// views, columns, routines, triggers and events by name across every database
// of a connection, optionally inside routine/view code, and open them.
const KINDS = ['table', 'view', 'column', 'procedure', 'function', 'trigger', 'event'];
const ICON = { table: '▦', view: '◫', column: '│', procedure: 'ƒ', function: 'ƒ', trigger: '⚡', event: '⏲' };

export default function SearchModal({ connections, connId: initialConn, onClose, onOpenData, onOpenStructure, onOpenCode, toast }) {
  const { t } = useI18n();
  const [connId, setConnId] = useState(initialConn || connections[0]?.id || '');
  const [q, setQ] = useState('');
  const [types, setTypes] = useState(new Set(KINDS));
  const [inCode, setInCode] = useState(false);
  const [system, setSystem] = useState(false);
  const [res, setRes] = useState({ results: [], truncated: false });
  const [loading, setLoading] = useState(false);
  const [sel, setSel] = useState(0);
  const listRef = useRef(null);
  const seq = useRef(0);

  // Debounced search; stale responses are ignored.
  useEffect(() => {
    if (!connId || q.trim().length < 2) { setRes({ results: [], truncated: false }); return undefined; }
    const my = ++seq.current;
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const r = await api.search(connId, { q: q.trim(), types: [...types].join(','), code: inCode ? 1 : 0, system: system ? 1 : 0 });
        if (my === seq.current) { setRes(r); setSel(0); }
      } catch (e) { if (my === seq.current) toast(e.message, 'err'); }
      finally { if (my === seq.current) setLoading(false); }
    }, 250);
    return () => clearTimeout(timer);
  }, [connId, q, types, inCode, system, toast]);

  const items = res.results;
  const counts = useMemo(() => {
    const c = {};
    for (const it of items) c[it.kind] = (c[it.kind] || 0) + 1;
    return c;
  }, [items]);

  function open(it, action) {
    if (!it) return;
    const a = action || (it.kind === 'table' || it.kind === 'view' ? 'data' : it.kind === 'column' ? 'structure' : 'code');
    if (a === 'data') onOpenData(connId, it.db, it.name);
    else if (a === 'structure') onOpenStructure(connId, it.db, it.table || it.name);
    else onOpenCode(connId, it.db, it.kind, it.name);
    onClose();
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(items.length - 1, s + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); open(items[sel]); }
  }
  useEffect(() => {
    listRef.current?.querySelector('.search-item.sel')?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  const toggleType = (k) => setTypes((s) => {
    const n = new Set(s);
    if (n.has(k)) { if (n.size > 1) n.delete(k); } else n.add(k);
    return n;
  });
  const highlight = (name) => {
    const i = name.toLowerCase().indexOf(q.trim().toLowerCase());
    if (i < 0 || !q.trim()) return name;
    return <>{name.slice(0, i)}<mark>{name.slice(i, i + q.trim().length)}</mark>{name.slice(i + q.trim().length)}</>;
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal wide search-modal" onKeyDown={onKey}>
        <div className="search-top">
          <span className="search-icon">⌕</span>
          <input autoFocus className="search-input" placeholder={t('search.placeholder')} value={q} onChange={(e) => setQ(e.target.value)} />
          <select value={connId} onChange={(e) => setConnId(e.target.value)} title={t('search.connection')}>
            {connections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <EnvBadge conn={getConn(connId)} small />
        </div>
        <div className="search-filters">
          {KINDS.map((k) => (
            <button key={k} className={'chip-btn' + (types.has(k) ? ' on' : '')} onClick={() => toggleType(k)}>
              {ICON[k]} {t('search.k_' + k)}{counts[k] ? <span className="count"> {counts[k]}</span> : null}
            </button>
          ))}
          <span style={{ flex: 1 }} />
          <label className="radio"><input type="checkbox" checked={inCode} onChange={(e) => setInCode(e.target.checked)} /> {t('search.inCode')}</label>
          <label className="radio"><input type="checkbox" checked={system} onChange={(e) => setSystem(e.target.checked)} /> {t('search.system')}</label>
        </div>
        <div className="search-results" ref={listRef}>
          {q.trim().length < 2 && <div className="empty">{t('search.hint')}</div>}
          {q.trim().length >= 2 && !loading && !items.length && <div className="empty">{t('search.none')}</div>}
          {items.map((it, i) => (
            <div key={i} className={'search-item' + (i === sel ? ' sel' : '')} onMouseEnter={() => setSel(i)} onDoubleClick={() => open(it)}>
              <span className="search-kind" title={t('search.k_' + it.kind)}>{ICON[it.kind]}</span>
              <span className="grow">
                <span className="name">{it.kind === 'column' ? <>{it.table}.<b>{highlight(it.name)}</b></> : <b>{highlight(it.name)}</b>}</span>
                <span className="sub">{it.db}{it.detail ? ` · ${it.detail}` : ''}</span>
              </span>
              <span className="search-actions">
                {(it.kind === 'table' || it.kind === 'view') && <button className="mini" onClick={() => open(it, 'data')}>{t('search.data')}</button>}
                {(it.kind === 'table' || it.kind === 'column') && <button className="mini" onClick={() => open(it, 'structure')}>{t('search.structure')}</button>}
                {it.kind !== 'table' && it.kind !== 'column' && <button className="mini" onClick={() => open(it, 'code')}>{t('search.code')}</button>}
              </span>
            </div>
          ))}
        </div>
        <div className="search-foot count">
          {loading ? t('search.searching') : res.truncated ? t('search.truncated') : items.length ? t('search.found', { n: items.length }) : ''}
          <span style={{ flex: 1 }} />
          {t('search.keys')}
        </div>
      </div>
    </div>
  );
}
