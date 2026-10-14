import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useI18n } from '../i18n.jsx';

// Auto-recorded query history. Click an entry to reopen it in a SQL tab.
export default function History({ reloadKey, onOpen, toast }) {
  const { t } = useI18n();
  const [items, setItems] = useState([]);

  async function load() {
    try { setItems(await api.history(200)); }
    catch (e) { toast(e.message, 'err'); }
  }
  useEffect(() => { load(); }, [reloadKey]);

  async function clear() {
    if (!confirm(t('history.confirmClear'))) return;
    try { await api.clearHistory(); load(); }
    catch (e) { toast(e.message, 'err'); }
  }

  return (
    <div className="panel-list">
      <div className="panel-actions">
        <button className="mini" onClick={load}>{t('history.refresh')}</button>
        <span style={{ flex: 1 }} />
        <button className="mini" onClick={clear}>{t('history.clear')}</button>
      </div>
      {items.length === 0 && <div className="empty">{t('history.empty')}</div>}
      {items.map((e) => (
        <div key={e.id} className="list-item" onClick={() => onOpen(e)} title={e.sql}>
          <span className="icon">{e.ok ? '✅' : '❌'}</span>
          <div className="grow">
            <div className="name">{(e.sql || '').slice(0, 54).replace(/\s+/g, ' ')}</div>
            <div className="sub">
              {new Date(e.at).toLocaleTimeString()} · {e.summary}{e.elapsedMs != null ? ` · ${e.elapsedMs} ms` : ''}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
