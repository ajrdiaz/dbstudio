import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { useI18n } from '../i18n.jsx';
import { askText, askChoice } from '../lib/dialogs.jsx';
import { ContextMenu } from './EditableGrid.jsx';
import { folderOptions, folderName, parentOf } from '../lib/savedFolders.js';

// Saved queries (favorites) in folders, like files: click to open in a SQL
// tab; drag queries or folders onto a folder (or the empty area = root);
// right-click for actions. The search box filters by name, SQL or folder.
const DRAG_QUERY = 'application/x-dbstudio-query';
const DRAG_FOLDER = 'application/x-dbstudio-folder';
const CLOSED_KEY = 'dbstudio.savedClosed';

function loadClosed() {
  try { return new Set(JSON.parse(localStorage.getItem(CLOSED_KEY) || '[]')); } catch { return new Set(); }
}

export default function SavedQueries({ reloadKey, onOpen, toast }) {
  const { t } = useI18n();
  const [items, setItems] = useState([]);
  const [folders, setFolders] = useState([]);
  const [search, setSearch] = useState('');
  const [closed, setClosed] = useState(loadClosed);
  const [dropTarget, setDropTarget] = useState(null); // folder path, '' = root
  const [menu, setMenu] = useState(null); // { x, y, items }

  async function load() {
    try {
      const [q, f] = await Promise.all([api.listQueries(), api.listQueryFolders()]);
      setItems(q);
      setFolders(f);
    } catch (e) { toast(e.message, 'err'); }
  }
  useEffect(() => { load(); }, [reloadKey]);
  useEffect(() => {
    try { localStorage.setItem(CLOSED_KEY, JSON.stringify([...closed])); } catch { /* ignore */ }
  }, [closed]);

  const run = async (fn) => {
    try { await fn(); } catch (e) { toast(e.message, 'err'); }
    load();
  };
  const toggle = (path) => setClosed((s) => {
    const n = new Set(s);
    n.has(path) ? n.delete(path) : n.add(path);
    return n;
  });

  // ---- actions ----
  async function removeQuery(q) {
    if (!confirm(t('saved.confirmDelete', { name: q.name }))) return;
    run(() => api.deleteQuery(q.id));
  }
  async function renameQuery(q) {
    const name = (await askText({ title: t('saved.rename'), label: t('saved.renamePrompt'), value: q.name }))?.trim();
    if (!name || name === q.name) return;
    run(() => api.updateQuery(q.id, { name }));
  }
  async function moveQuery(q) {
    const folder = await askChoice({
      title: t('saved.moveTo'), label: q.name, value: q.folder || '',
      options: folderOptions(folders, t('saved.root')),
    });
    if (folder == null || folder === (q.folder || '')) return;
    run(() => api.updateQuery(q.id, { folder }));
  }
  async function newFolder(parent = '') {
    const name = (await askText({
      title: t('saved.newFolder'),
      label: parent ? t('saved.newSubfolderIn', { folder: parent.split('/').join(' / ') }) : t('saved.folderName'),
    }))?.trim();
    if (!name) return;
    if (name.includes('/')) { toast(t('saved.noSlash'), 'err'); return; }
    const path = parent ? `${parent}/${name}` : name;
    setClosed((s) => { const n = new Set(s); n.delete(parent); return n; });
    run(() => api.createQueryFolder(path));
  }
  async function renameFolder(path) {
    const name = (await askText({ title: t('saved.renameFolder'), label: t('saved.folderName'), value: folderName(path) }))?.trim();
    if (!name || name === folderName(path)) return;
    if (name.includes('/')) { toast(t('saved.noSlash'), 'err'); return; }
    const parent = parentOf(path);
    run(() => api.renameQueryFolder(path, parent ? `${parent}/${name}` : name));
  }
  async function deleteFolder(path) {
    if (!confirm(t('saved.confirmDeleteFolder', { folder: folderName(path) }))) return;
    run(() => api.deleteQueryFolder(path));
  }

  // ---- drag & drop ----
  function onDrop(e, target) {
    e.preventDefault();
    e.stopPropagation();
    setDropTarget(null);
    const qid = e.dataTransfer.getData(DRAG_QUERY);
    const from = e.dataTransfer.getData(DRAG_FOLDER);
    if (qid) {
      const q = items.find((x) => x.id === qid);
      if (q && (q.folder || '') !== target) run(() => api.updateQuery(qid, { folder: target }));
    } else if (from) {
      if (target === from || target.startsWith(from + '/') || parentOf(from) === target) return;
      run(() => api.renameQueryFolder(from, target ? `${target}/${folderName(from)}` : folderName(from)));
    }
  }
  const dropProps = (target) => ({
    onDragOver: (e) => {
      const types = [...e.dataTransfer.types];
      if (types.includes(DRAG_QUERY) || types.includes(DRAG_FOLDER)) { e.preventDefault(); e.stopPropagation(); setDropTarget(target); }
    },
    onDragLeave: (e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDropTarget((d) => (d === target ? null : d)); },
    onDrop: (e) => onDrop(e, target),
  });

  // ---- context menus ----
  const openMenu = (e, list) => { e.preventDefault(); e.stopPropagation(); setMenu({ x: e.clientX, y: e.clientY, items: list }); };
  const queryMenu = (q) => [
    { label: t('saved.open'), run: () => onOpen(q) },
    { label: t('saved.rename'), run: () => renameQuery(q) },
    { label: t('saved.moveTo'), run: () => moveQuery(q) },
    '-',
    { label: t('saved.delete'), run: () => removeQuery(q) },
  ];
  const folderMenu = (path) => [
    { label: t('saved.newSubfolder'), run: () => newFolder(path) },
    { label: t('saved.renameFolder'), run: () => renameFolder(path) },
    '-',
    { label: t('saved.deleteFolder'), run: () => deleteFolder(path) },
  ];

  // ---- tree ----
  const tree = useMemo(() => {
    const root = { path: '', folders: new Map(), queries: [] };
    const nodeFor = (path) => {
      let n = root;
      for (const part of path.split('/').filter(Boolean)) {
        const p = n.path ? `${n.path}/${part}` : part;
        if (!n.folders.has(part)) n.folders.set(part, { path: p, folders: new Map(), queries: [] });
        n = n.folders.get(part);
      }
      return n;
    };
    folders.forEach(nodeFor);
    items.forEach((q) => nodeFor(q.folder || '').queries.push(q));
    return root;
  }, [items, folders]);
  const countIn = (n) => n.queries.length + [...n.folders.values()].reduce((a, f) => a + countIn(f), 0);
  const indent = (depth) => ({ paddingLeft: 8 + depth * 14 });

  const renderQuery = (q, depth, showFolder = false) => (
    <div key={q.id} className="list-item saved-q" style={indent(depth)} title={q.sql}
      draggable onDragStart={(e) => { e.dataTransfer.setData(DRAG_QUERY, q.id); e.dataTransfer.effectAllowed = 'move'; }}
      onClick={() => onOpen(q)} onContextMenu={(e) => openMenu(e, queryMenu(q))}>
      <span className="icon">📄︎</span>
      <div className="grow">
        <div className="name">{q.name}</div>
        <div className="sub">
          {showFolder && q.folder ? `📁︎ ${q.folder.split('/').join(' / ')} · ` : ''}
          {q.database ? q.database + ' · ' : ''}{(q.sql || '').slice(0, 48).replace(/\s+/g, ' ')}
        </div>
      </div>
      <button className="mini" title={t('saved.rename')} onClick={(e) => { e.stopPropagation(); renameQuery(q); }}>✎︎</button>
      <button className="mini" title={t('saved.delete')} onClick={(e) => { e.stopPropagation(); removeQuery(q); }}>🗑︎</button>
    </div>
  );
  const renderFolder = (n, depth) => {
    const open = !closed.has(n.path);
    return (
      <div key={'f:' + n.path} className={'saved-folder' + (dropTarget === n.path ? ' drop' : '')} {...dropProps(n.path)}>
        <div className="list-item folder-row" style={indent(depth)} title={t('saved.folderHint')}
          draggable onDragStart={(e) => { e.stopPropagation(); e.dataTransfer.setData(DRAG_FOLDER, n.path); e.dataTransfer.effectAllowed = 'move'; }}
          onClick={() => toggle(n.path)} onContextMenu={(e) => openMenu(e, folderMenu(n.path))}>
          <span className="caret">{open ? '▼' : '▶'}</span>
          <span className="icon folder-icon">{open ? '📂︎' : '📁︎'}</span>
          <div className="grow"><div className="name">{folderName(n.path)}</div></div>
          <span className="count">{countIn(n)}</span>
          <button className="mini" title={t('saved.newSubfolder')} onClick={(e) => { e.stopPropagation(); newFolder(n.path); }}>＋︎</button>
          <button className="mini" title={t('saved.renameFolder')} onClick={(e) => { e.stopPropagation(); renameFolder(n.path); }}>✎︎</button>
          <button className="mini" title={t('saved.deleteFolder')} onClick={(e) => { e.stopPropagation(); deleteFolder(n.path); }}>🗑︎</button>
        </div>
        {open && renderChildren(n, depth + 1)}
      </div>
    );
  };
  const renderChildren = (n, depth) => [
    ...[...n.folders.values()].sort((a, b) => folderName(a.path).localeCompare(folderName(b.path))).map((f) => renderFolder(f, depth)),
    ...[...n.queries].sort((a, b) => a.name.localeCompare(b.name)).map((q) => renderQuery(q, depth)),
  ];

  const term = search.trim().toLowerCase();
  const found = term
    ? items.filter((q) => [q.name, q.sql, q.folder, q.database].some((v) => (v || '').toLowerCase().includes(term)))
      .sort((a, b) => a.name.localeCompare(b.name))
    : null;

  return (
    <div className="saved-panel">
      <div className="saved-tools">
        <input className="saved-search" placeholder={t('saved.search')} value={search}
          onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setSearch('')} />
        <button className="mini" title={t('saved.newFolder')} onClick={() => newFolder('')}>＋︎📁︎</button>
      </div>
      <div className={'panel-list' + (dropTarget === '' ? ' drop-root' : '')} {...dropProps('')}
        onContextMenu={(e) => openMenu(e, [{ label: t('saved.newFolder'), run: () => newFolder('') }])}>
        {items.length === 0 && folders.length === 0 && <div className="empty">{t('saved.empty')}<br />{t('saved.hint')}</div>}
        {found
          ? (found.length ? found.map((q) => renderQuery(q, 0, true)) : <div className="empty">{t('saved.noMatch')}</div>)
          : renderChildren(tree, 0)}
      </div>
      {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
    </div>
  );
}
