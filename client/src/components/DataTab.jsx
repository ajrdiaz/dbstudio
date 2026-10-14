import React, { useEffect, useState, useCallback, useRef } from 'react';
import { api } from '../api.js';
import { useI18n } from '../i18n.jsx';
import EditableGrid from './EditableGrid.jsx';
import { guardWrite, cancelledError } from '../lib/env.jsx';

// Editable, paged data browser for a single table — the SQLyog "Table Data" tab.
export default function DataTab({ connId, db, table, reloadKey, onImport, toast }) {
  const { t } = useI18n();
  const [state, setState] = useState({ columns: [], rows: [], total: null, primaryKey: [] });
  const [loading, setLoading] = useState(false);
  const [limit, setLimit] = useState(100);
  const [offset, setOffset] = useState(0);
  const [orderBy, setOrderBy] = useState('');
  const [dir, setDir] = useState('ASC');
  const [where, setWhere] = useState('');
  const dirtyRef = useRef(false);

  // Leaving the page (refresh, paging, sorting) drops unsaved grid edits.
  const confirmDiscard = () => !dirtyRef.current || window.confirm(t('grid.confirmDiscard'));

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = { limit, offset };
      if (orderBy) { params.orderBy = orderBy; params.dir = dir; }
      if (where.trim()) params.where = where.trim();
      setState(await api.tableData(connId, db, table, params));
    } catch (e) { toast(e.message, 'err'); }
    finally { setLoading(false); }
  }, [connId, db, table, limit, offset, orderBy, dir, where, toast]);

  // `where` is applied on Enter / Refresh, not on every keystroke.
  useEffect(() => { load(); }, [connId, db, table, limit, offset, orderBy, dir, reloadKey]); // eslint-disable-line react-hooks/exhaustive-deps

  function sortByCol(c) {
    if (!confirmDiscard()) return;
    if (orderBy === c) setDir((d) => (d === 'ASC' ? 'DESC' : 'ASC'));
    else { setOrderBy(c); setDir('ASC'); }
    setOffset(0);
  }
  const go = (fn) => () => { if (confirmDiscard()) fn(); };

  const page = Math.floor(offset / limit) + 1;
  const pages = state.total != null ? Math.max(1, Math.ceil(state.total / limit)) : null;
  const canEdit = state.primaryKey.length > 0;

  const tools = (
    <>
      <button className="mini" onClick={go(load)} disabled={loading}>{loading ? '…' : t('data.refresh')}</button>
      <button className="mini" onClick={onImport} title={t('imp.button')}>⤒︎ {t('imp.short')}</button>
      <input
        className="filter"
        placeholder={t('data.filter')}
        value={where}
        onChange={(e) => setWhere(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && confirmDiscard()) { if (offset) setOffset(0); else load(); } }}
      />
      <div className="pager">
        <button className="mini" disabled={offset === 0} onClick={go(() => setOffset(Math.max(0, offset - limit)))}>◀</button>
        <span>{page}{pages ? ` / ${pages}` : ''}</span>
        <button className="mini" disabled={pages ? page >= pages : state.rows.length < limit} onClick={go(() => setOffset(offset + limit))}>▶</button>
        <select value={limit} onChange={(e) => { if (confirmDiscard()) { setLimit(Number(e.target.value)); setOffset(0); } }}>
          {[50, 100, 250, 500, 1000, 5000].map((n) => <option key={n} value={n}>{t('data.perPage', { n })}</option>)}
        </select>
        {state.total != null && <span className="count">{t('data.rows', { n: state.total })}</span>}
      </div>
    </>
  );

  return (
    <div className="tabview">
      <EditableGrid
        columns={state.columns}
        rows={state.rows}
        editable={canEdit}
        primaryKey={state.primaryKey}
        tableName={table}
        readonlyReason={canEdit ? '' : t('data.readonlyTitle')}
        rowOffset={offset}
        sort={orderBy ? { col: orderBy, dir } : null}
        onSort={sortByCol}
        leftTools={tools}
        exportName={table}
        toast={toast}
        onDirtyChange={(d) => { dirtyRef.current = d; }}
        onSave={async (changes, preview) => {
          if (!preview) {
            const { statements } = await api.saveRows(connId, db, table, { ...changes, preview: true });
            if (!(await guardWrite(connId, { statements }))) throw cancelledError();
          }
          return api.saveRows(connId, db, table, { ...changes, preview });
        }}
        onSaved={load}
      />
    </div>
  );
}
