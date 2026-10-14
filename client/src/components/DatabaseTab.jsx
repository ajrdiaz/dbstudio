import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { useI18n } from '../i18n.jsx';
import { guardWrite } from '../lib/env.jsx';
import ErdView from './ErdView.jsx';

// Database tab: table statistics + maintenance, and the ER diagram.
export default function DatabaseTab({ connId, db, view: savedView, onViewChange, onOpenData, onOpenStructure, toast }) {
  const { t } = useI18n();
  const [view, setViewState] = useState(savedView || 'tables');
  const setView = (v) => { setViewState(v); onViewChange?.(v); };
  // Opened again from the tree with a specific view (e.g. "Diagrama ER").
  useEffect(() => { if (savedView) setViewState(savedView); }, [savedView]);
  return (
    <div className="tabview db-tab">
      <div className="structure-tabs">
        <button className={view === 'tables' ? 'active' : ''} onClick={() => setView('tables')}>{t('dbt.tables')}</button>
        <button className={view === 'erd' ? 'active' : ''} onClick={() => setView('erd')}>{t('dbt.erd')}</button>
      </div>
      <div className="server-body" style={{ display: view === 'tables' ? 'flex' : 'none' }}>
        <TableStats connId={connId} db={db} onOpenData={onOpenData} onOpenStructure={onOpenStructure} toast={toast} />
      </div>
      {view === 'erd' && (
        <div className="server-body">
          <ErdView connId={connId} db={db} onOpenData={onOpenData} onOpenStructure={onOpenStructure} toast={toast} />
        </div>
      )}
    </div>
  );
}

export const fmtBytes = (n) => {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let v = Number(n) || 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i && v < 10 ? 1 : 0)} ${u[i]}`;
};

const COLS = [
  ['name', 'dbt.table'], ['engine', 'dbt.engine'], ['rowsApprox', 'dbt.rows'], ['dataBytes', 'dbt.data'],
  ['indexBytes', 'dbt.indexes'], ['totalBytes', 'dbt.total'], ['fragPct', 'dbt.free'], ['autoIncrement', 'AUTO_INC'],
  ['updated', 'dbt.updated'], ['rowFormat', 'dbt.rowFormat'], ['collation', 'Collation'],
];

function TableStats({ connId, db, onOpenData, onOpenStructure, toast }) {
  const { t } = useI18n();
  const [tables, setTables] = useState([]);
  const [loading, setLoading] = useState(false);
  const [picked, setPicked] = useState(new Set());
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState({ key: 'totalBytes', dir: -1 });
  const [checkOpt, setCheckOpt] = useState('MEDIUM');
  const [busy, setBusy] = useState(null); // op running
  const [report, setReport] = useState(null); // { sql, results, elapsedMs }

  const load = useCallback(async () => {
    setLoading(true);
    try { setTables((await api.dbinfo.stats(connId, db)).tables); }
    catch (e) { toast(e.message, 'err'); }
    finally { setLoading(false); }
  }, [connId, db, toast]);
  useEffect(() => { load(); }, [load]);

  const shown = useMemo(() => {
    const f = filter.toLowerCase();
    const list = tables.filter((x) => !f || x.name.toLowerCase().includes(f));
    const { key, dir } = sort;
    return list.sort((a, b) => {
      const x = a[key]; const y = b[key];
      if (x == null) return 1; if (y == null) return -1;
      return (typeof x === 'number' ? x - y : String(x).localeCompare(String(y))) * dir;
    });
  }, [tables, filter, sort]);
  const maxTotal = Math.max(1, ...tables.map((x) => x.totalBytes));
  const totals = tables.reduce((a, x) => ({ rows: a.rows + (x.rowsApprox || 0), data: a.data + x.dataBytes, idx: a.idx + x.indexBytes, free: a.free + x.freeBytes }), { rows: 0, data: 0, idx: 0, free: 0 });
  const allPicked = shown.length > 0 && shown.every((x) => picked.has(x.name));

  async function run(op) {
    const list = tables.map((x) => x.name).filter((n) => picked.has(n));
    if (!list.length) return;
    try {
      const { sql } = await api.dbinfo.maintenance(connId, db, { op, tables: list, option: checkOpt, preview: true });
      // OPTIMIZE / REPAIR rebuild tables (locks, I/O): always confirm. CHECK only reads.
      if (op !== 'check' && !(await guardWrite(connId, { statements: [sql], force: op === 'optimize' || op === 'repair' }))) return;
      setBusy(op);
      const r = await api.dbinfo.maintenance(connId, db, { op, tables: list, option: checkOpt });
      setReport(r);
      const bad = r.results.filter((x) => x.type === 'error' || (x.type === 'status' && x.text !== 'OK' && x.text !== 'Table is already up to date'));
      toast(bad.length ? t('dbt.opWarn', { n: bad.length }) : t('dbt.opOk', { op: op.toUpperCase(), n: list.length }), bad.length ? 'err' : 'ok');
      load();
    } catch (e) { toast(e.message, 'err'); }
    finally { setBusy(null); }
  }

  const sortBy = (key) => setSort((s) => (s.key === key ? { key, dir: -s.dir } : { key, dir: key === 'name' || key === 'engine' ? 1 : -1 }));
  const toggle = (n) => setPicked((s) => { const x = new Set(s); x.has(n) ? x.delete(n) : x.add(n); return x; });

  return (
    <>
      <div className="data-toolbar">
        <button className="mini" onClick={load} disabled={loading}>{t('data.refresh')}</button>
        <input className="filter" placeholder={t('admin.filterVars')} value={filter} onChange={(e) => setFilter(e.target.value)} />
        <span className="count">{t('dbt.selected', { n: picked.size })}</span>
        <button className="mini" disabled={!picked.size || busy} title={t('dbt.analyzeTitle')} onClick={() => run('analyze')}>{busy === 'analyze' ? '…' : t('dbt.analyze')}</button>
        <button className="mini" disabled={!picked.size || busy} title={t('dbt.optimizeTitle')} onClick={() => run('optimize')}>{busy === 'optimize' ? '…' : t('dbt.optimize')}</button>
        <span className="btn-group">
          <button className="mini" disabled={!picked.size || busy} title={t('dbt.checkTitle')} onClick={() => run('check')}>{busy === 'check' ? '…' : t('dbt.check')}</button>
          <select value={checkOpt} onChange={(e) => setCheckOpt(e.target.value)} title={t('dbt.checkOpt')}>
            {['QUICK', 'MEDIUM', 'EXTENDED'].map((o) => <option key={o}>{o}</option>)}
          </select>
        </span>
        <button className="mini" disabled={!picked.size || busy} title={t('dbt.repairTitle')} onClick={() => run('repair')}>{busy === 'repair' ? '…' : t('dbt.repair')}</button>
      </div>
      <div className="results-pane scroll">
        <table className="grid admin-table stats-table">
          <thead>
            <tr>
              <th><input type="checkbox" checked={allPicked} onChange={() => setPicked(allPicked ? new Set() : new Set(shown.map((x) => x.name)))} /></th>
              {COLS.map(([k, label]) => (
                <th key={k} onClick={() => sortBy(k)} className="sortable">
                  {label.startsWith('dbt.') ? t(label) : label}{sort.key === k ? (sort.dir > 0 ? ' ▲' : ' ▼') : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((x) => {
              const fragHigh = x.fragPct >= 20 && x.freeBytes >= 10 * 1024 * 1024;
              return (
                <tr key={x.name} className={picked.has(x.name) ? 'picked' : ''} onDoubleClick={() => onOpenData(connId, db, x.name)}>
                  <td><input type="checkbox" checked={picked.has(x.name)} onChange={() => toggle(x.name)} /></td>
                  <td><a className="link" onClick={() => onOpenStructure(connId, db, x.name)} title={t('dbt.openStructure')}>{x.name}</a></td>
                  <td>{x.engine}</td>
                  <td className="num">{x.rowsApprox == null ? '' : `~${x.rowsApprox.toLocaleString()}`}</td>
                  <td className="num">{fmtBytes(x.dataBytes)}</td>
                  <td className="num">{fmtBytes(x.indexBytes)}</td>
                  <td className="num size-cell">
                    <div className="size-bar" style={{ width: `${(x.totalBytes / maxTotal) * 100}%` }} />
                    <span>{fmtBytes(x.totalBytes)}</span>
                  </td>
                  <td className={'num' + (fragHigh ? ' warn-text' : '')} title={t('dbt.freeTitle')}>
                    {x.freeBytes ? `${fmtBytes(x.freeBytes)} · ${x.fragPct.toFixed(0)}%` : '—'}
                  </td>
                  <td className="num">{x.autoIncrement ?? ''}</td>
                  <td>{x.updated ?? ''}</td>
                  <td>{x.rowFormat}</td>
                  <td className="count">{x.collation}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <td /><td><b>{t('dbt.totalN', { n: tables.length })}</b></td><td />
              <td className="num">~{totals.rows.toLocaleString()}</td>
              <td className="num">{fmtBytes(totals.data)}</td><td className="num">{fmtBytes(totals.idx)}</td>
              <td className="num"><b>{fmtBytes(totals.data + totals.idx)}</b></td>
              <td className="num">{fmtBytes(totals.free)}</td><td colSpan={4} />
            </tr>
          </tfoot>
        </table>
        <div className="count stats-note">{t('dbt.note')}</div>
        {report && (
          <div className="note maint-report">
            <div><b>{report.sql}</b> <span className="count">· {report.elapsedMs} ms</span></div>
            {report.results.map((r, i) => (
              <div key={i} className={'maint-line ' + r.type}>
                <code>{r.table}</code> <span className="maint-type">{r.type}</span> {r.text}
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
