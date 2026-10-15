import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import SavedQueries from './SavedQueries.jsx';
import History from './History.jsx';
import { useI18n } from '../i18n.jsx';
import { EnvBadge, envColor } from '../lib/env.jsx';
import { askText } from '../lib/dialogs.jsx';
import { useConnStatus } from '../lib/connStatus.js';

// Reusable tree node.
function Node({ label, icon, iconClass, iconTitle, caret, open, selected, onToggle, onClick, onDouble, right, children, depth = 0, stripe, drag }) {
  return (
    <div className="tnode">
      <div
        className={'row' + (selected ? ' selected' : '')}
        style={{ paddingLeft: 8 + depth * 12, boxShadow: stripe ? `inset 3px 0 0 ${stripe}` : undefined }}
        draggable={!!drag}
        onDragStart={drag ? (e) => { e.dataTransfer.setData(DRAG_TYPE, drag); e.dataTransfer.effectAllowed = 'move'; } : undefined}
        onClick={onClick}
        onDoubleClick={onDouble}
      >
        <span className="caret" onClick={(e) => { e.stopPropagation(); onToggle?.(); }}>
          {caret ? (open ? '▼' : '▶') : ''}
        </span>
        <span className={'icon' + (iconClass ? ' ' + iconClass : '')} title={iconTitle}>{icon}</span>
        <span className="label">{label}</span>
        {right}
      </div>
      {open && children && <div className="children">{children}</div>}
    </div>
  );
}

const PREFS_KEY = 'dbstudio-sidebar';
const DRAG_TYPE = 'text/x-dbstudio-conn';
const DEFAULT_WIDTH = 290;
function loadPrefs() {
  const base = { collapsed: false, width: DEFAULT_WIDTH, view: 'connections', closedGroups: [] };
  try { return { ...base, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') }; } catch { return base; }
}

export default function Sidebar({
  connections, active, onNewConnection, onEditConnection, onDeleteConnection,
  onConnect, onOpenData, onOpenStructure, onOpenQuery, onExport, onRefreshConns,
  onOpenDesigner, onOpenServer, onOpenTools, onOpenSearch, onOpenCode, onOpenDatabase, onImport, schemaVersion, savedReloadKey, onOpenSavedQuery, onOpenHistory, toast,
}) {
  const { t } = useI18n();
  const connStatus = useConnStatus();
  // expansion + lazy-loaded data keyed by node path
  const [expanded, setExpanded] = useState({});
  const [dbs, setDbs] = useState({});       // connId -> [db]
  const [objects, setObjects] = useState({}); // `${connId}:${db}` -> objects
  const [selected, setSelected] = useState(null);
  // Layout prefs (collapsed, width, current view) survive reloads.
  const [prefs, setPrefs] = useState(loadPrefs);
  const { collapsed, width, view } = prefs;
  const setView = (v) => setPrefs((p) => ({ ...p, view: v }));
  const setCollapsed = (c) => setPrefs((p) => ({ ...p, collapsed: typeof c === 'function' ? c(p.collapsed) : c }));
  useEffect(() => {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* ignore */ }
  }, [prefs]);

  // Ctrl+B toggles the panel, like VS Code.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'b' || e.key === 'B')) {
        e.preventDefault();
        setCollapsed((c) => !c);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  function startResize(e) {
    e.preventDefault();
    const x0 = e.clientX; const w0 = width;
    const mv = (ev) => setPrefs((p) => ({ ...p, width: Math.min(640, Math.max(180, w0 + ev.clientX - x0)) }));
    const up = () => { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); document.body.classList.remove('resizing'); };
    document.body.classList.add('resizing');
    window.addEventListener('mousemove', mv);
    window.addEventListener('mouseup', up);
  }
  const openView = (v) => setPrefs((p) => ({ ...p, view: v, collapsed: false }));

  // ---- connection groups (folders) ----
  const [dropTarget, setDropTarget] = useState(null); // group name, '' = root
  const closedGroups = new Set(prefs.closedGroups || []);
  const toggleGroup = (g) => setPrefs((p) => {
    const s = new Set(p.closedGroups || []);
    s.has(g) ? s.delete(g) : s.add(g);
    return { ...p, closedGroups: [...s] };
  });
  async function moveToGroup(e, group) {
    e.preventDefault();
    e.stopPropagation();
    setDropTarget(null);
    const id = e.dataTransfer.getData(DRAG_TYPE);
    const c = connections.find((x) => x.id === id);
    if (!c || (c.group || '') === group) return;
    try { await api.updateConnection(id, { group }); onRefreshConns(); }
    catch (err) { toast(err.message, 'err'); }
  }
  async function renameGroup(e, g) {
    e.stopPropagation();
    const name = await askText({ title: t('groups.rename'), label: t('groups.renamePrompt'), value: g });
    if (name == null || name.trim() === g) return;
    try {
      for (const c of connections.filter((x) => x.group === g)) await api.updateConnection(c.id, { group: name.trim() });
      onRefreshConns();
    } catch (err) { toast(err.message, 'err'); }
  }
  const dropProps = (g) => ({
    onDragOver: (e) => { if ([...e.dataTransfer.types].includes(DRAG_TYPE)) { e.preventDefault(); e.stopPropagation(); setDropTarget(g); } },
    onDragLeave: (e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDropTarget((d) => (d === g ? null : d)); },
    onDrop: (e) => moveToGroup(e, g),
  });
  // Folders first (alphabetical), then connections without a group.
  function groupLayout(list, render) {
    const groups = {};
    const root = [];
    for (const c of list) (c.group ? (groups[c.group] ||= []) : root).push(c);
    const names = Object.keys(groups).sort((a, b) => a.localeCompare(b));
    return [
      ...names.map((g) => {
        const open = !closedGroups.has(g);
        return (
          <div key={'grp:' + g} className={'tnode conn-group' + (dropTarget === g ? ' drop' : '')} {...dropProps(g)}>
            <div className="row group-row" onClick={() => toggleGroup(g)} title={t('groups.hint')}>
              <span className="caret">{open ? '▼' : '▶'}</span>
              <span className="icon">{open ? '📂︎' : '📁︎'}</span>
              <span className="label"><b>{g}</b></span>
              <span className="count">{groups[g].length}</span>
              <button className="mini" title={t('groups.rename')} onClick={(e) => renameGroup(e, g)}>✎︎</button>
            </div>
            {open && <div className="children">{groups[g].map(render)}</div>}
          </div>
        );
      }),
      ...root.map(render),
    ];
  }

  const toggle = (key) => setExpanded((e) => ({ ...e, [key]: !e[key] }));

  async function expandConn(c) {
    const key = `c:${c.id}`;
    if (!expanded[key] && !dbs[c.id]) {
      try {
        const list = await api.databases(c.id);
        setDbs((d) => ({ ...d, [c.id]: list }));
        onConnect?.(c);
      } catch (e) { toast(e.message, 'err'); return; }
    }
    toggle(key);
  }

  async function expandDb(connId, db) {
    const key = `d:${connId}:${db}`;
    const okey = `${connId}:${db}`;
    if (!expanded[key] && !objects[okey]) {
      try {
        const objs = await api.objects(connId, db);
        setObjects((o) => ({ ...o, [okey]: objs }));
      } catch (e) { toast(e.message, 'err'); return; }
    }
    toggle(key);
  }

  async function reloadObjects(connId, db) {
    const okey = `${connId}:${db}`;
    try {
      const objs = await api.objects(connId, db);
      setObjects((o) => ({ ...o, [okey]: objs }));
    } catch (e) { toast(e.message, 'err'); }
  }

  // Re-fetch already-loaded object lists when the schema changes (e.g. after the
  // designer creates/alters a table), keeping the current expansion intact.
  useEffect(() => {
    if (!schemaVersion) return;
    for (const okey of Object.keys(objects)) {
      const [connId, db] = okey.split(':');
      reloadObjects(connId, db);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schemaVersion]);

  function Category({ connId, db, name, label, icon, items, render }) {
    const key = `cat:${connId}:${db}:${name}`;
    return (
      <Node
        label={label || name} icon={icon} caret open={expanded[key]} depth={2}
        onToggle={() => toggle(key)} onClick={() => toggle(key)}
        right={<span className="count">{items.length}</span>}
      >
        {items.map((it) => render(it))}
      </Node>
    );
  }

  if (collapsed) {
    // Slim rail: each icon re-opens the panel on that view.
    return (
      <div className="sidebar collapsed">
        <button className="rail-btn" title={t('side.expand')} onClick={() => setCollapsed(false)}>»</button>
        <button className={'rail-btn' + (view === 'connections' ? ' active' : '')} title={t('side.connections')} onClick={() => openView('connections')}>🖳︎</button>
        <button className={'rail-btn' + (view === 'saved' ? ' active' : '')} title={t('side.saved')} onClick={() => openView('saved')}>📄︎</button>
        <button className={'rail-btn' + (view === 'history' ? ' active' : '')} title={t('side.history')} onClick={() => openView('history')}>🕘︎</button>
        <button className="rail-btn" title={t('search.open')} onClick={onOpenSearch}>⌕</button>
        <span style={{ flex: 1 }} />
        <button className="rail-btn" title={t('side.newConnection')} onClick={onNewConnection}>＋︎</button>
      </div>
    );
  }

  return (
    <div className="sidebar" style={{ width }}>
      <div className="side-switch">
        <button className={view === 'connections' ? 'active' : ''} onClick={() => setView('connections')}>🖳︎ {t('side.connections')}</button>
        <button className={view === 'saved' ? 'active' : ''} onClick={() => setView('saved')}>📄︎ {t('side.saved')}</button>
        <button className={view === 'history' ? 'active' : ''} onClick={() => setView('history')}>🕘︎ {t('side.history')}</button>
        <button className="collapse-btn" title={t('side.collapse')} onClick={() => setCollapsed(true)}>«</button>
      </div>
      <div className="side-resizer" title={t('side.resize')} onMouseDown={startResize}
        onDoubleClick={() => setPrefs((p) => ({ ...p, width: DEFAULT_WIDTH }))} />

      {view === 'saved' && (
        <SavedQueries reloadKey={savedReloadKey} onOpen={onOpenSavedQuery} toast={toast} />
      )}
      {view === 'history' && (
        <History reloadKey={savedReloadKey} onOpen={onOpenHistory} toast={toast} />
      )}
      {view === 'connections' && (
      <>
      <div className="side-head">
        <span className="title">{t('side.connections')}</span>
        <button className="mini" title={t('search.open')} onClick={onOpenSearch}>⌕</button>
        <button className="mini" title={t('side.newConnection')} onClick={onNewConnection}>＋︎</button>
        <button className="mini" title={t('side.refresh')} onClick={onRefreshConns}>⟳︎</button>
      </div>
      <div className={'tree' + (dropTarget === '' ? ' drop-root' : '')} {...dropProps('')}>
        {connections.length === 0 && <div className="empty">{t('side.noConnections')}<br />{t('side.clickToAdd')}</div>}
        {groupLayout(connections, (c) => {
          const ckey = `c:${c.id}`;
          const connOpen = expanded[ckey];
          const down = connStatus[c.id]?.down;
          return (
            <Node
              key={c.id}
              label={<>{c.name} <EnvBadge conn={c} small /></>}
              stripe={envColor(c)}
              drag={c.id}
              icon={connOpen && !down ? '🖧︎' : '🖳︎'}
              iconClass={down ? 'conn-down' : undefined}
              iconTitle={down ? t('side.connDown', { msg: connStatus[c.id].message }) : undefined}
              caret open={connOpen}
              selected={active?.id === c.id}
              onToggle={() => expandConn(c)}
              onClick={() => expandConn(c)}
              right={
                <>
                  <button className="mini" title={t('side.sqlEditor')} onClick={(e) => { e.stopPropagation(); onConnect?.(c); onOpenQuery(c.id, c.database || ''); }}>⌨︎</button>
                  <button className="mini" title={t('admin.title')} onClick={(e) => { e.stopPropagation(); onConnect?.(c); onOpenServer(c.id); }}>⛭︎</button>
                  <button className="mini" title={t('side.edit')} onClick={(e) => { e.stopPropagation(); onEditConnection(c); }}>✎︎</button>
                  <button className="mini" title={t('side.delete')} onClick={(e) => { e.stopPropagation(); onDeleteConnection(c); }}>🗑︎</button>
                </>
              }
            >
              {(dbs[c.id] || []).map((db) => {
                const dkey = `d:${c.id}:${db.name}`;
                const okey = `${c.id}:${db.name}`;
                const objs = objects[okey];
                return (
                  <Node
                    key={db.name}
                    label={db.name}
                    icon="🗄︎"
                    caret open={expanded[dkey]} depth={1}
                    selected={selected === dkey}
                    onToggle={() => expandDb(c.id, db.name)}
                    onClick={() => { setSelected(dkey); expandDb(c.id, db.name); }}
                    right={
                      <>
                        <button className="mini" title={t('side.newTable')} onClick={(e) => { e.stopPropagation(); onOpenDesigner(c.id, db.name, null); }}>＋︎▦︎</button>
                        <button className="mini" title={t('side.sqlOnDb')} onClick={(e) => { e.stopPropagation(); onOpenQuery(c.id, db.name); }}>⌨︎</button>
                        <button className="mini" title={t('imp.button')} onClick={(e) => { e.stopPropagation(); onImport(c.id, db.name); }}>⤒︎</button>
                        <button className="mini" title={t('dbt.button')} onClick={(e) => { e.stopPropagation(); onOpenDatabase(c.id, db.name); }}>▤︎</button>
                        <button className="mini" title={t('tools.dbButton')} onClick={(e) => { e.stopPropagation(); onOpenTools({ connId: c.id, db: db.name }); }}>⇄</button>
                        <button className="mini" title={t('side.export')} onClick={(e) => { e.stopPropagation(); onExport(c.id, db.name, objs?.tables?.map((tb) => tb.name) || []); }}>⤓︎</button>
                      </>
                    }
                  >
                    {objs && (
                      <>
                        <Category
                          connId={c.id} db={db.name} name="Tables" label={t('side.tables')} icon="▦︎" items={objs.tables}
                          render={(tbl) => (
                            <Node
                              key={'t' + tbl.name} label={tbl.name} icon="▦︎" depth={3}
                              selected={selected === `t:${okey}:${tbl.name}`}
                              onClick={() => setSelected(`t:${okey}:${tbl.name}`)}
                              onDouble={() => onOpenData(c.id, db.name, tbl.name)}
                              right={
                                <>
                                  <button className="mini" title={t('side.design')} onClick={(e) => { e.stopPropagation(); onOpenDesigner(c.id, db.name, tbl.name); }}>🛠︎</button>
                                  <button className="mini" title={t('side.structure')} onClick={(e) => { e.stopPropagation(); onOpenStructure(c.id, db.name, tbl.name); }}>⚙︎</button>
                                  <span className="count">{tbl.rows ?? ''}</span>
                                </>
                              }
                            />
                          )}
                        />
                        <Category
                          connId={c.id} db={db.name} name="Views" label={t('side.views')} icon="◫︎" items={objs.views}
                          render={(v) => (
                            <Node key={'v' + v.name} label={v.name} icon="◫︎" depth={3}
                              onDouble={() => onOpenData(c.id, db.name, v.name)} />
                          )}
                        />
                        <Category
                          connId={c.id} db={db.name} name="Procedures" label={t('side.procedures')} icon="ƒ︎" items={objs.procedures}
                          render={(p) => <Node key={'p' + p.name} label={p.name} icon="ƒ︎" depth={3} onDouble={() => onOpenCode(c.id, db.name, 'procedure', p.name)} />}
                        />
                        <Category
                          connId={c.id} db={db.name} name="Functions" label={t('side.functions')} icon="ƒ︎" items={objs.functions}
                          render={(f) => <Node key={'f' + f.name} label={f.name} icon="ƒ︎" depth={3} onDouble={() => onOpenCode(c.id, db.name, 'function', f.name)} />}
                        />
                        <Category
                          connId={c.id} db={db.name} name="Triggers" label={t('side.triggers')} icon="⚡︎" items={objs.triggers}
                          render={(tg) => <Node key={'g' + tg.name} label={tg.name} icon="⚡︎" depth={3} onDouble={() => onOpenCode(c.id, db.name, 'trigger', tg.name)} />}
                        />
                      </>
                    )}
                  </Node>
                );
              })}
            </Node>
          );
        })}
      </div>
      </>
      )}
    </div>
  );
}
