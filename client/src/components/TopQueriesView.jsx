import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useI18n } from '../i18n.jsx';
import { guardWrite } from '../lib/env.jsx';

// Heaviest queries by total time, average, executions, rows examined, ...
// (performance_schema digests, or the slow log table).
const fmtMs = (ms) => {
  if (ms == null) return '—';
  if (ms >= 60000) return `${(ms / 60000).toFixed(1)} min`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(ms >= 10000 ? 0 : 1)} s`;
  return `${ms.toFixed(ms < 10 ? 2 : 0)} ms`;
};
const fmtN = (n) => (n == null ? '—' : n >= 1e6 ? `${(n / 1e6).toFixed(1)} M` : n >= 1e4 ? `${(n / 1e3).toFixed(1)} k` : n.toLocaleString());

export default function TopQueriesView({ connId, onOpenScript, toast }) {
  const { t } = useI18n();
  const [order, setOrder] = useState('total');
  const [schema, setSchema] = useState('');
  const [dbs, setDbs] = useState([]);
  const [internal, setInternal] = useState(false);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try { setData(await api.admin.topQueries(connId, { order, schema, internal: internal ? 1 : 0, limit: 50 })); }
    catch (e) { toast(e.message, 'err'); }
    finally { setLoading(false); }
  }, [connId, order, schema, internal, toast]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { api.databases(connId).then((l) => setDbs(l.map((d) => d.name))).catch(() => {}); }, [connId]);

  async function reset() {
    try {
      const { statements } = await api.admin.resetTopQueries(connId, true);
      if (!(await guardWrite(connId, { statements, force: true }))) return;
      await api.admin.resetTopQueries(connId, false);
      toast(t('top.resetDone'), 'ok');
      load();
    } catch (e) { toast(e.message, 'err'); }
  }

  const rows = data?.rows || [];
  return (
    <>
      <div className="data-toolbar">
        <button className="mini" onClick={load} disabled={loading}>{t('data.refresh')}</button>
        <label className="count">{t('top.orderBy')}</label>
        <select value={order} onChange={(e) => setOrder(e.target.value)}>
          {['total', 'avg', 'max', 'count', 'examined', 'noindex', 'tmpdisk'].map((o) => <option key={o} value={o}>{t('top.o_' + o)}</option>)}
        </select>
        <select value={schema} onChange={(e) => setSchema(e.target.value)} title={t('admin.db')}>
          <option value="">{t('top.allDbs')}</option>
          {dbs.map((d) => <option key={d}>{d}</option>)}
        </select>
        <label className="radio"><input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} /> {t('top.internal')}</label>
        <span style={{ flex: 1 }} />
        {data?.source === 'performance_schema' && <button className="mini" onClick={reset} title={t('top.resetTitle')}>{t('top.reset')}</button>}
        {data?.source && <span className="count">{t('top.source', { s: data.source })}</span>}
      </div>
      <div className="results-pane scroll">
        {data && !data.source && (
          <div className="note top-help">
            <b>{t('top.unavailable')}</b>
            <div>{t('top.howPs')}</div>
            <pre className="ddl">{'[mysqld]\nperformance_schema = ON'}</pre>
            <div>{t('top.howSlow')}</div>
            <pre className="ddl">{"SET GLOBAL log_output = 'TABLE';\nSET GLOBAL slow_query_log = 1;\nSET GLOBAL long_query_time = 1;  -- segundos"}</pre>
          </div>
        )}
        {rows.length > 0 && (
          <table className="grid admin-table top-table">
            <thead>
              <tr>
                <th>#</th><th>{t('top.query')}</th><th>{t('admin.db')}</th><th>{t('top.calls')}</th><th>{t('top.total')}</th>
                <th>{t('top.avg')}</th><th>{t('top.max')}</th><th title={t('top.examinedTitle')}>{t('top.examined')}</th>
                <th title={t('top.noIndexTitle')}>{t('top.noIndex')}</th><th>{t('top.lastSeen')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const perCall = r.calls ? r.examined / r.calls : 0;
                const ratio = r.sent ? r.examined / Math.max(1, r.sent) : r.examined;
                const scanWarn = perCall > 10000 || (ratio > 1000 && r.examined > 100000);
                const flags = [
                  r.noIndex > 0 && t('top.fNoIndex'),
                  scanWarn && t('top.fScan', { n: fmtN(Math.round(perCall)) }),
                  r.tmpDisk > 0 && t('top.fTmpDisk'),
                  r.errors > 0 && t('top.fErrors', { n: r.errors }),
                ].filter(Boolean);
                return (
                  <React.Fragment key={i}>
                    <tr className={'top-row' + (open === i ? ' open' : '')} onClick={() => setOpen(open === i ? null : i)}>
                      <td className="num">{i + 1}</td>
                      <td className="top-sql">
                        <code>{r.text}</code>
                        {flags.length > 0 && <div className="top-flags">{flags.map((f) => <span key={f} className="flag">⚠ {f}</span>)}</div>}
                      </td>
                      <td>{r.db || ''}</td>
                      <td className="num">{fmtN(r.calls)}</td>
                      <td className="num size-cell">
                        <div className="size-bar" style={{ width: `${Math.min(100, r.pct)}%` }} />
                        <span>{fmtMs(r.totalMs)} <span className="count">{r.pct.toFixed(1)}%</span></span>
                      </td>
                      <td className="num">{fmtMs(r.avgMs)}</td>
                      <td className="num">{fmtMs(r.maxMs)}</td>
                      <td className={'num' + (scanWarn ? ' warn-text' : '')}>{fmtN(r.examined)}<div className="count">{t('top.perCall', { n: fmtN(Math.round(perCall)) })}</div></td>
                      <td className={'num' + (r.noIndex ? ' warn-text' : '')}>{r.noIndex != null ? fmtN(r.noIndex) : '—'}</td>
                      <td className="count">{r.lastSeen ? String(r.lastSeen).replace('T', ' ').slice(0, 19) : ''}</td>
                    </tr>
                    {open === i && (
                      <tr className="top-detail">
                        <td />
                        <td colSpan={9}>
                          <pre className="ddl">{r.text}</pre>
                          <div className="row3">
                            <button className="mini" onClick={() => onOpenScript(connId, r.db || '', `${r.text};`, `⏱︎ ${r.text.slice(0, 24)}…`)}>{t('top.openEditor')}</button>
                            <span className="count">{t('top.detail', { sent: fmtN(r.sent), aff: fmtN(r.affected ?? 0), lock: fmtMs(r.lockMs ?? 0), tmp: fmtN(r.tmpDisk ?? 0) })}</span>
                          </div>
                          {/\?/.test(r.text) && <div className="count">{t('top.placeholders')}</div>}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        )}
        {data?.source && !rows.length && <div className="empty">{t('top.none')}</div>}
      </div>
    </>
  );
}
