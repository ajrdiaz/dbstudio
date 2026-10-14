import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { useI18n } from '../i18n.jsx';
import { usePolling } from '../lib/polling.js';

// Replication monitor (read-only): replica health and lag per channel with a
// short lag history, plus the primary side (binlog position, connected
// replicas). Works with MySQL and MariaDB, old and new terminology.
const HISTORY = 60;

// Same thresholds for the number, the chart and the card: < 30 s fine,
// up to 5 min lagging, beyond that badly behind.
const LAG_WARN = 30;
const LAG_BAD = 300;
const lagLevel = (s) => (s == null ? 'bad' : s < LAG_WARN ? 'good' : s < LAG_BAD ? 'warn' : 'bad');
const fmtLag = (s) => {
  if (s == null) return '—';
  if (s < 120) return `${s} s`;
  if (s < 7200) return `${Math.floor(s / 60)} min ${s % 60} s`;
  return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
};

function health(ch) {
  if (ch.lastIoError || ch.lastSqlError) return 'error';
  if (ch.ioRunning !== 'Yes' || ch.sqlRunning !== 'Yes') return 'stopped';
  const lag = ch.secondsBehind == null ? 0 : ch.secondsBehind - (ch.sqlDelay || 0);
  if (lag >= LAG_BAD) return 'behind';
  if (lag >= LAG_WARN) return 'lagging';
  return 'ok';
}

// Lag history: fills the column width, 0 s sits on a visible baseline, and
// the caption explains the time span and scale.
function Sparkline({ points, every }) {
  const { t } = useI18n();
  if (points.length < 2) return <div className="spark-wrap"><div className="spark empty-spark" /><div className="count">{t('repl.collecting')}</div></div>;
  const w = 300; const h = 56; const pad = 6;
  const max = Math.max(5, ...points.map((p) => p ?? 0));
  const step = w / (points.length - 1);
  const y = (p) => h - pad - ((p ?? max) / max) * (h - pad * 2);
  const xy = points.map((p, i) => [i * step, y(p)]);
  const d = xy.map(([x, yy], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${yy.toFixed(1)}`).join(' ');
  const last = points[points.length - 1];
  const span = every ? Math.round(((points.length - 1) * every) / 60 * 10) / 10 : null;
  return (
    <div className="spark-wrap">
      <svg className={'spark ' + lagLevel(last)} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
        <line x1="0" x2={w} y1={h - pad} y2={h - pad} className="base" />
        <path d={`${d} L${w},${h} L0,${h} Z`} className="area" />
        <path d={d} className="line" />
      </svg>
      <div className="count">{span ? t('repl.historySpan', { min: span }) : ''} · {t('repl.historyMax', { max: fmtLag(max) })}</div>
    </div>
  );
}

function Thread({ label, running, state }) {
  const cls = running === 'Yes' ? 'good' : running === 'Connecting' || running === 'Preparing' ? 'warn' : 'bad';
  return (
    <div className="repl-thread">
      <span className={'dot ' + cls} /> <b>{label}</b> <span className={'repl-run ' + cls}>{running ?? '—'}</span>
      {state && <div className="count">{state}</div>}
    </div>
  );
}

export default function ReplicationView({ connId, toast }) {
  const { t } = useI18n();
  const [data, setData] = useState(null);
  const [every, setEvery] = useState(5);
  const [loading, setLoading] = useState(false);
  const [raw, setRaw] = useState({});
  const hist = useRef({}); // channel -> [lag]
  const barRef = useRef(null);

  const load = useCallback(async (o) => {
    setLoading(true);
    try {
      const d = await api.admin.replication(connId);
      for (const ch of d.channels) {
        const a = (hist.current[ch.channel] ||= []);
        a.push(ch.secondsBehind);
        if (a.length > HISTORY) a.shift();
      }
      setData(d);
    } catch (e) {
      if (o?.auto) { setEvery(0); toast(t('admin.autoPaused', { msg: e.message }), 'err'); } else toast(e.message, 'err');
    }
    finally { setLoading(false); }
  }, [connId, toast, t]);
  useEffect(() => { load(); }, [load]);
  usePolling(load, every, barRef);

  if (!data) return <div className="empty">{loading ? '…' : ''}</div>;
  const s = data.server;
  return (
    <>
      <div className="data-toolbar" ref={barRef}>
        <button className="mini" onClick={() => load()} disabled={loading}>{t('data.refresh')}</button>
        <label className="count">{t('admin.autoRefresh')}</label>
        <select value={every} onChange={(e) => setEvery(Number(e.target.value))}>
          <option value={0}>{t('admin.off')}</option>
          {[2, 5, 10, 30].map((x) => <option key={x} value={x}>{x} s</option>)}
        </select>
        <span className="count">{t('repl.readOnlyNote')}</span>
      </div>
      <div className="results-pane scroll repl">
        <div className="stat-cards">
          <div className="stat-card"><div className="count">{t('repl.role')}</div><div className="stat-val">{t('repl.role_' + data.role)}</div></div>
          <div className="stat-card"><div className="count">{t('repl.server')}</div><div className="stat-val small">{s.hostname} · id {s.serverId}</div><div className="count">{s.version}</div></div>
          <div className="stat-card">
            <div className="count">read_only</div>
            <div className={'stat-val ' + (s.readOnly ? 'good' : data.role === 'replica' ? 'warn' : '')}>{s.readOnly ? 'ON' : 'OFF'}{s.superReadOnly ? ' · super_read_only' : ''}</div>
            {data.role === 'replica' && !s.readOnly && <div className="count warn-text">{t('repl.replicaWritable')}</div>}
          </div>
        </div>

        {data.error && <div className="note warn">{t('repl.noPrivilege', { msg: data.error })}</div>}

        {data.channels.map((ch) => {
          const hl = health(ch);
          const points = hist.current[ch.channel] || [];
          const backlog = ch.sourceLogFile === ch.execLogFile && ch.readPos != null && ch.execPos != null
            ? Number(ch.readPos) - Number(ch.execPos) : null;
          return (
            <div key={ch.channel} className={'repl-card ' + hl}>
              <div className="repl-head">
                <span className={'repl-health ' + hl}>{hl === 'ok' ? '✔ ' : hl === 'lagging' || hl === 'behind' ? '⚠ ' : '✖ '}{t('repl.h_' + hl)}</span>
                <b>{ch.channel ? `${ch.channel} · ` : ''}{t('repl.from', { host: `${ch.sourceHost}:${ch.sourcePort}`, user: ch.sourceUser || '' })}</b>
              </div>
              <div className="repl-grid">
                <div className="repl-lag">
                  <div className="count">{t('repl.lag')}</div>
                  <div className={'lag-val ' + lagLevel(ch.secondsBehind == null ? null : ch.secondsBehind - (ch.sqlDelay || 0))}>{fmtLag(ch.secondsBehind)}</div>
                  {ch.secondsBehind == null && <div className="count">{t('repl.lagUnknown')}</div>}
                  {ch.sqlDelay > 0 && <div className="count">{t('repl.delayed', { s: ch.sqlDelay, rem: ch.sqlRemainingDelay ?? '—' })}</div>}
                  <Sparkline points={points} every={every} />
                </div>
                <div className="repl-threads">
                  <Thread label={t('repl.io')} running={ch.ioRunning} state={ch.ioState} />
                  <Thread label={t('repl.sql')} running={ch.sqlRunning} state={ch.sqlState} />
                </div>
                <div className="repl-pos">
                  <div><div className="count">{t('repl.read')}</div><code>{ch.sourceLogFile}:{ch.readPos}</code></div>
                  <div><div className="count">{t('repl.executed')}</div><code>{ch.execLogFile}:{ch.execPos}</code></div>
                  {backlog != null && <div className="count">{t('repl.backlog', { n: backlog.toLocaleString() })}</div>}
                  {ch.gtid && <div><span className="count">GTID</span> <code>{ch.gtid}</code></div>}
                  <div className="count">GTID: {ch.usingGtid || '—'}</div>
                </div>
              </div>
              {ch.lastIoError && <div className="repl-error"><b>IO #{ch.lastIoErrno}</b> {ch.lastIoErrorAt ? `(${ch.lastIoErrorAt}) ` : ''}{ch.lastIoError}</div>}
              {ch.lastSqlError && <div className="repl-error"><b>SQL #{ch.lastSqlErrno}</b> {ch.lastSqlErrorAt ? `(${ch.lastSqlErrorAt}) ` : ''}{ch.lastSqlError}</div>}
              <button className="mini" onClick={() => setRaw((r) => ({ ...r, [ch.channel]: !r[ch.channel] }))}>
                {raw[ch.channel] ? t('repl.hideRaw') : t('repl.showRaw')}
              </button>
              {raw[ch.channel] && (
                <table className="grid admin-table raw-table">
                  <tbody>
                    {Object.entries(ch.raw).map(([k, v]) => <tr key={k}><td>{k}</td><td>{v == null ? '' : String(v)}</td></tr>)}
                  </tbody>
                </table>
              )}
            </div>
          );
        })}

        {(data.binlog || data.replicas.length > 0) && (
          <div className="repl-card primary">
            <div className="repl-head"><b>{t('repl.primarySide')}</b></div>
            {data.binlog && (
              <div>
                <span className="count">{t('repl.binlog')}</span>{' '}
                <code>{data.binlog.file ? `${data.binlog.file}:${data.binlog.position}` : ''}{data.binlog.gtid ? ` · GTID ${data.binlog.gtid}` : ''}</code>
              </div>
            )}
            <div className="count">{t('repl.connectedReplicas', { n: data.replicas.length })}</div>
            {data.replicas.length > 0 && (
              <table className="grid admin-table">
                <thead><tr><th>server_id</th><th>Host</th><th>{t('conn.port')}</th></tr></thead>
                <tbody>{data.replicas.map((r) => <tr key={r.serverId}><td>{r.serverId}</td><td>{r.host || '—'}</td><td>{r.port}</td></tr>)}</tbody>
              </table>
            )}
          </div>
        )}

        {data.role === 'standalone' && !data.error && <div className="empty">{t('repl.standalone')}</div>}
      </div>
    </>
  );
}
