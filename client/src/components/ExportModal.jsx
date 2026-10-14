import React, { useState } from 'react';
import { api } from '../api.js';
import { downloadText, pickFile } from '../lib/download.js';
import { useI18n } from '../i18n.jsx';
import { guardWrite } from '../lib/env.jsx';

// Export a database to a .sql dump, or import a .sql file into it.
export default function ExportModal({ connId, db, tables, onClose, toast }) {
  const { t } = useI18n();
  const [structure, setStructure] = useState(true);
  const [data, setData] = useState(true);
  const [selected, setSelected] = useState(() => new Set(tables));
  const [busy, setBusy] = useState(false);

  function toggle(t) {
    setSelected((s) => {
      const n = new Set(s);
      n.has(t) ? n.delete(t) : n.add(t);
      return n;
    });
  }

  async function doExport() {
    setBusy(true);
    try {
      const sql = await api.exportDump(connId, db, { tables: [...selected], structure, data });
      downloadText(`${db}.sql`, sql, 'application/sql');
      toast(t('export.dumpDownloaded'), 'ok');
      onClose();
    } catch (e) { toast(e.message, 'err'); }
    finally { setBusy(false); }
  }

  async function doImport() {
    const file = await pickFile('.sql');
    if (!file) return;
    if (!(await guardWrite(connId, { summary: t('env.importSummary', { file: file.name, db }) }))) return;
    setBusy(true);
    try {
      const r = await api.importSql(connId, db, file.text);
      toast(t('export.imported', { name: file.name, ms: r.elapsedMs }), 'ok');
      onClose();
    } catch (e) { toast(e.message, 'err'); }
    finally { setBusy(false); }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <h3>{t('export.title', { db })}</h3>
        <div className="content">
          <div style={{ display: 'flex', gap: 16 }}>
            <label style={{ display: 'flex', gap: 6 }}><input type="checkbox" checked={structure} onChange={(e) => setStructure(e.target.checked)} /> {t('export.structure')}</label>
            <label style={{ display: 'flex', gap: 6 }}><input type="checkbox" checked={data} onChange={(e) => setData(e.target.checked)} /> {t('export.data')}</label>
          </div>
          <div className="field">
            <label>{t('export.tables', { sel: selected.size, total: tables.length })}</label>
            <div style={{ maxHeight: 200, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 4, padding: 6 }}>
              {tables.length === 0 && <div className="count">{t('export.noTables')}</div>}
              {tables.map((t) => (
                <label key={t} style={{ display: 'flex', gap: 6 }}>
                  <input type="checkbox" checked={selected.has(t)} onChange={() => toggle(t)} /> {t}
                </label>
              ))}
            </div>
          </div>
        </div>
        <div className="actions">
          <button onClick={doImport} disabled={busy}>{t('export.import')}</button>
          <span style={{ flex: 1 }} />
          <button onClick={onClose}>{t('export.close')}</button>
          <button className="primary" onClick={doExport} disabled={busy || selected.size === 0}>
            {busy ? t('export.working') : t('export.export')}
          </button>
        </div>
      </div>
    </div>
  );
}
