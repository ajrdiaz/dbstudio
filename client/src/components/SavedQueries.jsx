import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useI18n } from '../i18n.jsx';

// List of saved queries (favorites). Click to open in a new SQL tab.
export default function SavedQueries({ reloadKey, onOpen, toast }) {
  const { t } = useI18n();
  const [items, setItems] = useState([]);

  async function load() {
    try { setItems(await api.listQueries()); }
    catch (e) { toast(e.message, 'err'); }
  }
  useEffect(() => { load(); }, [reloadKey]);

  async function remove(e, q) {
    e.stopPropagation();
    if (!confirm(t('saved.confirmDelete', { name: q.name }))) return;
    try { await api.deleteQuery(q.id); load(); }
    catch (e) { toast(e.message, 'err'); }
  }

  async function rename(e, q) {
    e.stopPropagation();
    const name = prompt(t('saved.renamePrompt'), q.name);
    if (!name || name === q.name) return;
    try { await api.updateQuery(q.id, { name }); load(); }
    catch (e) { toast(e.message, 'err'); }
  }

  return (
    <div className="panel-list">
      {items.length === 0 && <div className="empty">{t('saved.empty')}<br />{t('saved.hint')}</div>}
      {items.map((q) => (
        <div key={q.id} className="list-item" onClick={() => onOpen(q)} title={q.sql}>
          <span className="icon">📄︎</span>
          <div className="grow">
            <div className="name">{q.name}</div>
            <div className="sub">{q.database ? q.database + ' · ' : ''}{(q.sql || '').slice(0, 48).replace(/\s+/g, ' ')}</div>
          </div>
          <button className="mini" title={t('saved.rename')} onClick={(e) => rename(e, q)}>✎︎</button>
          <button className="mini" title={t('saved.delete')} onClick={(e) => remove(e, q)}>🗑︎</button>
        </div>
      ))}
    </div>
  );
}
