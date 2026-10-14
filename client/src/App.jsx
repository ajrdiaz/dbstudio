import React, { useEffect, useState, useCallback, useRef } from 'react';
import { api } from './api.js';
import Sidebar from './components/Sidebar.jsx';
import ConnectionModal from './components/ConnectionModal.jsx';
import QueryTab from './components/QueryTab.jsx';
import DataTab from './components/DataTab.jsx';
import StructureTab from './components/StructureTab.jsx';
import TableDesigner from './components/TableDesigner.jsx';
import ExportModal from './components/ExportModal.jsx';
import StorageModal from './components/StorageModal.jsx';
import ServerTab from './components/ServerTab.jsx';
import ToolsTab from './components/ToolsTab.jsx';
import SearchModal from './components/SearchModal.jsx';
import DatabaseTab from './components/DatabaseTab.jsx';
import ImportModal from './components/ImportModal.jsx';
import { useI18n } from './i18n.jsx';
import { tabHasOpenTx, anyOpenTx, releaseAllSessions } from './lib/editorSessions.js';
import { setConnectionRegistry, ConfirmHost, EnvBanner, EnvBadge, envColor, getConn } from './lib/env.jsx';

let tabSeq = 1;
const nextId = () => 't' + tabSeq++;

export default function App() {
  const { t, lang, setLang } = useI18n();
  const [connections, setConnections] = useState([]);
  // Active connection = the one shown as "Connected: …". Kept as an id (the
  // object is looked up so renames/deletes are reflected) and remembered across
  // reloads.
  const [activeId, setActiveId] = useState(() => {
    try { return localStorage.getItem('dbstudio-active-conn') || null; } catch { return null; }
  });
  const [tabs, setTabs] = useState([]);
  const [activeTab, setActiveTab] = useState(null);
  const [connModal, setConnModal] = useState(null); // {initial?} | null
  const [exportModal, setExportModal] = useState(null); // {connId, db, tables} | null
  const [storageModal, setStorageModal] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [importModal, setImportModal] = useState(null); // { connId, db, table? }
  const [importedVersion, setImportedVersion] = useState(0); // bump: data tabs reload
  const [toast, setToast] = useState(null);
  const [savedReloadKey, setSavedReloadKey] = useState(0); // bump to refresh Saved/History panels
  const [schemaVersion, setSchemaVersion] = useState(0); // bump to re-fetch tree objects
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem('dbstudio-theme') || 'light'; } catch { return 'light'; }
  });
  const restored = useRef(false);
  const active = connections.find((c) => c.id === activeId) || null;
  // Environment lookups (colors, write guard) read this registry during render.
  setConnectionRegistry(connections);

  useEffect(() => {
    try {
      if (activeId) localStorage.setItem('dbstudio-active-conn', activeId);
      else localStorage.removeItem('dbstudio-active-conn');
    } catch { /* ignore */ }
  }, [activeId]);

  // Follow the current tab: switching to (or restoring) a tab makes its
  // connection the active one, like SQLyog.
  useEffect(() => {
    const cur = tabs.find((x) => x.id === activeTab);
    if (cur?.connId && cur.connId !== activeId) setActiveId(cur.connId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, tabs.length]);

  // Apply + persist the theme.
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('dbstudio-theme', theme); } catch { /* ignore */ }
  }, [theme]);

  // Ctrl+P: search objects (like "go to" in VS Code).
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'p' || e.key === 'P')) {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // Warn before leaving with an open transaction; release editor sessions on exit.
  useEffect(() => {
    const before = (e) => { if (anyOpenTx()) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', before);
    window.addEventListener('pagehide', releaseAllSessions);
    return () => { window.removeEventListener('beforeunload', before); window.removeEventListener('pagehide', releaseAllSessions); };
  }, []);

  const notify = useCallback((message, kind = 'info') => {
    setToast({ message, kind });
    setTimeout(() => setToast(null), 3500);
  }, []);

  const refreshConns = useCallback(async () => {
    try { setConnections(await api.listConnections()); }
    catch (e) { notify(e.message, 'err'); }
  }, [notify]);

  useEffect(() => { refreshConns(); }, [refreshConns]);

  // --- Restore the saved workspace (open tabs) on first load ---
  useEffect(() => {
    (async () => {
      try {
        const ws = await api.getWorkspace();
        if (ws?.tabs?.length) {
          // advance the id counter past any restored ids
          let max = 0;
          for (const t of ws.tabs) {
            const n = Number(String(t.id).replace(/\D/g, ''));
            if (n > max) max = n;
          }
          tabSeq = max + 1;
          setTabs(ws.tabs);
          setActiveTab(ws.activeTab && ws.tabs.some((t) => t.id === ws.activeTab) ? ws.activeTab : ws.tabs[0].id);
        }
      } catch { /* no workspace yet */ }
      restored.current = true;
    })();
  }, []);

  // --- Auto-save the workspace whenever tabs change (after restore) ---
  useEffect(() => {
    if (!restored.current) return;
    const t = setTimeout(() => {
      api.saveWorkspace({ tabs, activeTab }).catch(() => {});
    }, 600);
    return () => clearTimeout(t);
  }, [tabs, activeTab]);

  function openTab(tab) {
    const id = nextId();
    setTabs((t) => [...t, { id, ...tab }]);
    setActiveTab(id);
  }

  function closeTab(id) {
    // Closing the tab closes its session: an open transaction would roll back.
    if (tabHasOpenTx(id) && !window.confirm(t('tx.confirmCloseTab'))) return;
    setTabs((t) => {
      const next = t.filter((x) => x.id !== id);
      if (activeTab === id) setActiveTab(next.length ? next[next.length - 1].id : null);
      return next;
    });
  }

  // Keep a query tab's editable state inside the tab object so it persists.
  const updateTabState = useCallback((id, patch) => {
    setTabs((t) => t.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  }, []);

  // --- tab openers ---
  const openData = (connId, db, table) =>
    openTab({ kind: 'data', title: `${db}.${table}`, connId, db, table });
  const openStructure = (connId, db, table) =>
    openTab({ kind: 'structure', title: `⚙︎ ${table}`, connId, db, table });
  const openQuery = (connId, db) =>
    openTab({ kind: 'query', title: db ? `SQL · ${db}` : 'SQL', connId, database: db, sql: 'SELECT 1;' });
  const openServer = (connId) => {
    const existing = tabs.find((x) => x.kind === 'server' && x.connId === connId);
    if (existing) { setActiveTab(existing.id); return; }
    const c = connections.find((x) => x.id === connId);
    openTab({ kind: 'server', title: `⛭︎ ${c?.name || 'Server'}`, connId });
  };
  // One "database" tab per connection+db (stats, maintenance, ER diagram).
  const openDatabase = (connId, db, view) => {
    const existing = tabs.find((x) => x.kind === 'database' && x.connId === connId && x.db === db);
    if (existing) {
      if (view) updateTabState(existing.id, { view });
      setActiveTab(existing.id);
      return;
    }
    openTab({ kind: 'database', title: `▤︎ ${db}`, connId, db, view: view || 'tables' });
  };
  const openTools = (preset) => openTab({ kind: 'tools', title: '⇄ ' + t('tools.tabTitle'), preset: preset || null });
  // Compare tool -> "open script in editor": a query tab on the target.
  const openScript = (connId, db, sql, title) =>
    openTab({ kind: 'query', title: title || (db ? `SQL · ${db}` : 'SQL'), connId, database: db, sql });
  // Open a view / routine / trigger / event definition in a SQL tab.
  async function openCode(connId, db, kind, name) {
    try {
      const { sql } = await api.ddl(connId, db, kind, name);
      openScript(connId, db, sql, `${{ view: '◫', procedure: 'ƒ', function: 'ƒ', trigger: '⚡', event: '⏲' }[kind] || ''}︎ ${name}`);
    } catch (e) { notify(e.message, 'err'); }
  }
  const openDesigner = (connId, db, table) =>
    openTab({ kind: 'designer', title: table ? `🛠︎ ${table}` : `🛠︎ New table · ${db}`, connId, db, table: table || null });

  // "＋" next to the tabs (like SQLyog): empty SQL tab on the same connection /
  // database as the current tab, else the active connection.
  function openNewQueryHere() {
    const cur = tabs.find((x) => x.id === activeTab);
    const connId = (cur && connections.some((c) => c.id === cur.connId) ? cur.connId : null)
      || active?.id || connections[0]?.id;
    if (!connId) { notify(t('conn.addFirst'), 'err'); return; }
    const db = cur?.connId === connId
      ? (cur.kind === 'query' ? cur.database : cur.db) || ''
      : (connections.find((c) => c.id === connId)?.database || '');
    openTab({ kind: 'query', title: db ? `SQL · ${db}` : 'SQL', connId, database: db, sql: '' });
  }

  function openSavedQuery(q) {
    const connId = q.connectionId && connections.some((c) => c.id === q.connectionId)
      ? q.connectionId : (active?.id || connections[0]?.id);
    if (!connId) { notify(t('conn.addFirst'), 'err'); return; }
    openTab({ kind: 'query', title: q.name, connId, database: q.database || '', sql: q.sql, savedQueryId: q.id });
  }

  function openHistory(e) {
    const connId = e.connectionId && connections.some((c) => c.id === e.connectionId)
      ? e.connectionId : (active?.id || connections[0]?.id);
    if (!connId) { notify(t('conn.addFirst'), 'err'); return; }
    openTab({ kind: 'query', title: 'SQL (history)', connId, database: e.database || '', sql: e.sql });
  }

  // --- connection actions ---
  async function deleteConnection(c) {
    if (!confirm(t('conn.confirmDelete', { name: c.name }))) return;
    try { await api.deleteConnection(c.id); notify(t('conn.deleted'), 'ok'); refreshConns(); }
    catch (e) { notify(e.message, 'err'); }
  }

  const onQuerySaved = useCallback(() => setSavedReloadKey((k) => k + 1), []);

  const activeTabObj = tabs.find((t) => t.id === activeTab);

  return (
    <div className="app">
      <div className="toolbar">
        <span className="brand">◆ DBStudio</span>
        <button onClick={() => setConnModal({})}>{t('nav.newConnection')}</button>
        {active && <button onClick={() => openQuery(active.id, active.database || '')}>{t('nav.newQuery')}</button>}
        {active && <button onClick={() => openServer(active.id)} title={t('admin.title')}>{t('nav.server')}</button>}
        {connections.length > 0 && <button onClick={() => openTools(active ? { connId: active.id } : null)} title={t('tools.title')}>⇄ {t('tools.tabTitle')}</button>}
        <span className="spacer" />
        <span className="count">{active ? t('nav.connected', { name: active.name }) : t('nav.noConnection')}</span>
        {active && <EnvBadge conn={active} small />}
        <select title={t('nav.language')} value={lang} onChange={(e) => setLang(e.target.value)}>
          <option value="es">🇪🇸 ES</option>
          <option value="en">🇬🇧 EN</option>
        </select>
        <button title={t('storage.title')} onClick={() => setStorageModal(true)}>{t('nav.storage')}</button>
        <button title={t('nav.toggleTheme')} onClick={() => setTheme((v) => (v === 'dark' ? 'light' : 'dark'))}>
          {theme === 'dark' ? t('nav.light') : t('nav.dark')}
        </button>
      </div>

      <div className="body">
        <Sidebar
          connections={connections}
          active={active}
          onNewConnection={() => setConnModal({})}
          onEditConnection={(c) => setConnModal({ initial: c })}
          onDeleteConnection={deleteConnection}
          onConnect={(c) => setActiveId(c.id)}
          onOpenData={openData}
          onOpenStructure={openStructure}
          onOpenQuery={openQuery}
          onExport={(connId, db, tables) => setExportModal({ connId, db, tables })}
          onRefreshConns={refreshConns}
          onOpenDesigner={openDesigner}
          onOpenServer={openServer}
          onOpenTools={openTools}
          onOpenSearch={() => setSearchOpen(true)}
          onOpenDatabase={openDatabase}
          onImport={(connId, db, table) => setImportModal({ connId, db, table })}
          onOpenCode={openCode}
          schemaVersion={schemaVersion}
          savedReloadKey={savedReloadKey}
          onOpenSavedQuery={openSavedQuery}
          onOpenHistory={openHistory}
          toast={notify}
        />

        <div className="main-area">
          <div className="tabs" onDoubleClick={(e) => e.target === e.currentTarget && openNewQueryHere()}>
            {tabs.map((t) => (
              <div
                key={t.id}
                className={'tab' + (t.id === activeTab ? ' active' : '')}
                onClick={() => setActiveTab(t.id)}
                style={envColor(getConn(t.connId)) ? { boxShadow: `inset 0 3px 0 ${envColor(getConn(t.connId))}` } : undefined}
              >
                {getConn(t.connId)?.env === 'production' && <EnvBadge conn={getConn(t.connId)} small />}
                <span>{t.title}</span>
                <button className="close" onClick={(e) => { e.stopPropagation(); closeTab(t.id); }}>✕</button>
              </div>
            ))}
            {tabs.length === 0 && <div className="tab active" style={{ cursor: 'default' }}>{t('tabs.welcome')}</div>}
            {connections.length > 0 && (
              <button className="tab-add" title={t('tabs.newQuery')} onClick={openNewQueryHere}>＋</button>
            )}
          </div>

          <div className="tabview" style={{ flex: 1, minHeight: 0 }}>
            {!activeTabObj && (
              <div className="empty">
                <h2>◆ DBStudio</h2>
                <p>{t('welcome.subtitle')}</p>
                <p>{t('welcome.body')}</p>
              </div>
            )}
            {/* Keep all tabs mounted so editor/grid state survives tab switches. */}
            {tabs.map((t) => (
              <div key={t.id} style={{ display: t.id === activeTab ? 'flex' : 'none', flex: 1, minHeight: 0, flexDirection: 'column' }}>
                {t.connId && <EnvBanner connId={t.connId} />}
                {t.kind === 'query' && (
                  <QueryTab
                    tabId={t.id}
                    connId={t.connId}
                    database={t.database}
                    initialSql={t.sql}
                    savedQueryId={t.savedQueryId}
                    autocommitPref={t.autocommit}
                    rowLimitPref={t.rowLimit}
                    theme={theme}
                    onStateChange={updateTabState}
                    onSaved={onQuerySaved}
                    toast={notify}
                  />
                )}
                {t.kind === 'database' && <DatabaseTab connId={t.connId} db={t.db} view={t.view} onViewChange={(v) => updateTabState(t.id, { view: v })} onOpenData={openData} onOpenStructure={openStructure} toast={notify} />}
                {t.kind === 'server' && <ServerTab connId={t.connId} onOpenScript={openScript} view={t.view} onViewChange={(v) => updateTabState(t.id, { view: v })} toast={notify} />}
                {t.kind === 'tools' && <ToolsTab connections={connections} preset={t.preset} view={t.view} onViewChange={(v) => updateTabState(t.id, { view: v })} onOpenScript={openScript} toast={notify} />}
                {t.kind === 'data' && <DataTab connId={t.connId} db={t.db} table={t.table} reloadKey={importedVersion} onImport={() => setImportModal({ connId: t.connId, db: t.db, table: t.table })} toast={notify} />}
                {t.kind === 'structure' && <StructureTab connId={t.connId} db={t.db} table={t.table} view={t.view} onViewChange={(v) => updateTabState(t.id, { view: v })} toast={notify} />}
                {t.kind === 'designer' && (
                  <TableDesigner
                    connId={t.connId} db={t.db} table={t.table}
                    onDone={() => setSchemaVersion((v) => v + 1)}
                    toast={notify}
                  />
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      {connModal && (
        <ConnectionModal
          initial={connModal.initial}
          groups={[...new Set(connections.map((c) => c.group).filter(Boolean))].sort()}
          onClose={() => setConnModal(null)}
          onSaved={() => { setConnModal(null); refreshConns(); notify(t('conn.saved'), 'ok'); }}
          toast={notify}
        />
      )}
      <ConfirmHost />
      {importModal && (
        <ImportModal {...importModal} toast={notify}
          onClose={() => setImportModal(null)}
          onDone={() => { setSchemaVersion((v) => v + 1); setImportedVersion((v) => v + 1); }} />
      )}
      {searchOpen && connections.length > 0 && (
        <SearchModal connections={connections} connId={getConn(tabs.find((x) => x.id === activeTab)?.connId)?.id || active?.id}
          onClose={() => setSearchOpen(false)} onOpenData={openData} onOpenStructure={openStructure} onOpenCode={openCode} toast={notify} />
      )}
      {storageModal && <StorageModal onClose={() => setStorageModal(false)} toast={notify} />}
      {exportModal && (
        <ExportModal
          connId={exportModal.connId}
          db={exportModal.db}
          tables={exportModal.tables}
          onClose={() => setExportModal(null)}
          toast={notify}
        />
      )}
      {toast && <div className={'toast ' + (toast.kind || '')}>{toast.message}</div>}
    </div>
  );
}
