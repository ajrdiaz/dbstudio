import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { useI18n } from '../i18n.jsx';
import { usePolling } from '../lib/polling.js';
import LineChart from './LineChart.jsx';

// Live server dashboard (like pgAdmin's): polls SHOW GLOBAL STATUS, turns
// counters into per-second rates and keeps the last few minutes in memory.
const HISTORY = 150;
const RATE_KEYS = ['Questions', 'Com_select', 'Com_insert', 'Com_update', 'Com_delete', 'Bytes_received', 'Bytes_sent',
  'Innodb_rows_read', 'Innodb_rows_inserted', 'Innodb_rows_updated', 'Innodb_rows_deleted', 'Slow_queries',
  'Created_tmp_disk_tables', 'Created_tmp_tables', 'Aborted_connects', 'Innodb_buffer_pool_reads', 'Innodb_buffer_pool_read_requests'];
const S = (i) => `var(--series-${i})`;

const num = (v) => {
  if (v == null || Number.isNaN(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1e6) return `${(v / 1e6).toFixed(1)} M`;
  if (a >= 1e4) return `${(v / 1e3).toFixed(1)} k`;
  if (a >= 100 || Number.isInteger(v)) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1);
  return v.toFixed(a > 0 && a < 1 ? 2 : 1).replace(/\.0+$/, '');
};
const kb = (v) => (v == null ? '—' : v >= 1024 ? `${(v / 1024).toFixed(1)} MB/s` : `${v.toFixed(v < 10 ? 1 : 0)} KB/s`);

export default function DashboardView({ connId, toast }) {
  const { t } = useI18n();
  const [every, setEvery] = useState(2);
  const [hist, setHist] = useState({ times: [], rows: [] }); // rows: per sample {gauges, rates}
  const [vars, setVars] = useState({});
  const prev = useRef(null);
  const barRef = useRef(null);

  useEffect(() => {
    api.admin.variables(connId, 'variables')
      .then((r) => setVars(Object.fromEntries(r.rows.filter((x) => ['max_connections', 'innodb_buffer_pool_size', 'version'].includes(x.name)).map((x) => [x.name, x.value]))))
      .catch(() => {});
  }, [connId]);

  const load = useCallback(async (o) => {
    try {
      const r = await api.admin.variables(connId, 'status');
      const now = Date.now();
      const m = Object.fromEntries(r.rows.map((x) => [x.name, Number(x.value)]));
      const p = prev.current;
      prev.current = { at: now, m };
      if (!p) return;
      const dt = (now - p.at) / 1000;
      if (dt <= 0) return;
      const rate = {};
      for (const k of RATE_KEYS) rate[k] = Math.max(0, ((m[k] ?? 0) - (p.m[k] ?? 0)) / dt);
      const req = rate.Innodb_buffer_pool_read_requests;
      const sample = {
        connected: m.Threads_connected, running: m.Threads_running, rate,
        hit: req > 0 ? (1 - rate.Innodb_buffer_pool_reads / req) * 100 : null,
        poolUsed: m.Innodb_buffer_pool_pages_total ? ((m.Innodb_buffer_pool_pages_total - m.Innodb_buffer_pool_pages_free) / m.Innodb_buffer_pool_pages_total) * 100 : null,
        slowTotal: m.Slow_queries, uptime: m.Uptime,
      };
      setHist((h) => {
        const times = [...h.times, now].slice(-HISTORY);
        const rows = [...h.rows, sample].slice(-HISTORY);
        return { times, rows };
      });
    } catch (e) {
      if (o?.auto) { setEvery(0); toast(t('admin.autoPaused', { msg: e.message }), 'err'); } else toast(e.message, 'err');
    }
  }, [connId, toast, t]);
  // Two quick readings so the first rates appear right away.
  useEffect(() => { load().then(() => setTimeout(() => load(), 1000)); }, [load]);
  usePolling(load, every, barRef);

  const { times, rows } = hist;
  const last = rows[rows.length - 1];
  const col = (f) => rows.map(f);
  const maxConn = Number(vars.max_connections) || null;
  const hitLevel = last?.hit == null ? null : last.hit >= 99 ? 'good' : last.hit >= 95 ? 'warn' : 'bad';

  return (
    <>
      <div className="data-toolbar" ref={barRef}>
        <label className="count">{t('admin.autoRefresh')}</label>
        <select value={every} onChange={(e) => setEvery(Number(e.target.value))}>
          <option value={0}>{t('admin.off')}</option>
          {[1, 2, 5, 10].map((s) => <option key={s} value={s}>{s} s</option>)}
        </select>
        <span className="count">{t('dash.hint', { n: Math.round((HISTORY * (every || 2)) / 60) })}</span>
      </div>
      <div className="results-pane scroll dash">
        <div className="stat-cards">
          <div className="stat-card"><div className="count">{t('admin.qps')}</div><div className="stat-val">{last ? num(last.rate.Questions) : '…'}</div></div>
          <div className="stat-card">
            <div className="count">{t('admin.connected')}</div>
            <div className="stat-val">{last?.connected ?? '…'}{maxConn ? <span className="count"> / {maxConn}</span> : null}</div>
          </div>
          <div className="stat-card"><div className="count">{t('admin.running')}</div><div className="stat-val">{last?.running ?? '…'}</div></div>
          <div className="stat-card">
            <div className="count">{t('dash.hit')}</div>
            <div className={'stat-val ' + (hitLevel || '')}>
              {last?.hit == null ? '—' : `${last.hit.toFixed(1)} %`}
              {hitLevel && <span className={'status-tag ' + hitLevel}>{hitLevel === 'good' ? '✔' : '⚠'} {t('dash.hit_' + hitLevel)}</span>}
            </div>
          </div>
          <div className="stat-card"><div className="count">{t('dash.poolUsed')}</div><div className="stat-val">{last?.poolUsed == null ? '—' : `${last.poolUsed.toFixed(0)} %`}</div></div>
          <div className="stat-card"><div className="count">{t('dash.slowMin')}</div><div className="stat-val">{last ? num(last.rate.Slow_queries * 60) : '…'}<span className="count"> · {t('dash.total', { n: last?.slowTotal ?? '—' })}</span></div></div>
          <div className="stat-card"><div className="count">{t('dash.tmpDisk')}</div><div className="stat-val">{last ? num(last.rate.Created_tmp_disk_tables) : '…'}</div></div>
        </div>
        <div className="chart-grid">
          <LineChart title={t('dash.chartConn')} times={times} format={(v) => num(v)}
            series={[
              { name: t('dash.connected'), color: S(1), values: col((r) => r.connected) },
              { name: t('dash.running'), color: S(2), values: col((r) => r.running) },
            ]} />
          <LineChart title={t('dash.chartQps')} times={times} format={(v) => num(v)} unit="/s"
            series={[
              { name: 'SELECT', color: S(1), values: col((r) => r.rate.Com_select) },
              { name: 'INSERT', color: S(2), values: col((r) => r.rate.Com_insert) },
              { name: 'UPDATE', color: S(3), values: col((r) => r.rate.Com_update) },
              { name: 'DELETE', color: S(4), values: col((r) => r.rate.Com_delete) },
            ]} />
          <LineChart title={t('dash.chartNet')} times={times} format={kb}
            series={[
              { name: t('dash.received'), color: S(1), values: col((r) => r.rate.Bytes_received / 1024) },
              { name: t('dash.sent'), color: S(2), values: col((r) => r.rate.Bytes_sent / 1024) },
            ]} />
          <LineChart title={t('dash.chartRows')} times={times} format={(v) => num(v)} unit="/s"
            series={[
              { name: t('dash.read'), color: S(1), values: col((r) => r.rate.Innodb_rows_read) },
              { name: t('dash.inserted'), color: S(2), values: col((r) => r.rate.Innodb_rows_inserted) },
              { name: t('dash.updated'), color: S(3), values: col((r) => r.rate.Innodb_rows_updated) },
              { name: t('dash.deleted'), color: S(4), values: col((r) => r.rate.Innodb_rows_deleted) },
            ]} />
        </div>
      </div>
    </>
  );
}
