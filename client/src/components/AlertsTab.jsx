import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { useI18n } from '../i18n.jsx';
import { usePolling } from '../lib/polling.js';
import { EnvBadge, getConn } from '../lib/env.jsx';
import { isDesktop } from '../lib/alerts.js';

// Alerts: active problems, the rules being watched and the event history.
const TYPES = {
  replication: { params: [['lagSec', 's']] },
  down: { params: [['failures', '']] },
  connections: { params: [['pct', '%']] },
  longQuery: { params: [['seconds', 's']] },
  slowQueries: { params: [['perMin', '/min']] },
};
const DEFAULTS = { replication: { lagSec: 60 }, down: { failures: 2 }, connections: { pct: 85 }, longQuery: { seconds: 120 }, slowQueries: { perMin: 10 } };

const ago = (t, tr) => {
  if (!t) return '—';
  const s = Math.round((Date.now() - (typeof t === 'number' ? t : Date.parse(t))) / 1000);
  if (s < 60) return tr('al.secAgo', { n: s });
  if (s < 3600) return tr('al.minAgo', { n: Math.round(s / 60) });
  return tr('al.hAgo', { n: Math.round(s / 3600) });
};

export default function AlertsTab({ connections, onOpenServer, toast, reloadKey }) {
  const { t } = useI18n();
  const [data, setData] = useState({ rules: [], states: {}, history: [], active: 0 });
  const [edit, setEdit] = useState(null); // rule being edited / created
  const [presetConn, setPresetConn] = useState(connections[0]?.id || '');
  const [perm, setPerm] = useState(typeof Notification !== 'undefined' ? Notification.permission : 'unsupported');
  const barRef = useRef(null);

  const load = useCallback(async () => {
    try { setData(await api.monitor.state()); } catch (e) { toast(e.message, 'err'); }
  }, [toast]);
  useEffect(() => { load(); }, [load, reloadKey]);
  usePolling(load, 10, barRef);

  async function save(rule) {
    try {
      if (rule.id) await api.monitor.update(rule.id, rule); else await api.monitor.create(rule);
      setEdit(null); load();
    } catch (e) { toast(e.message, 'err'); }
  }
  async function toggle(rule) { try { await api.monitor.update(rule.id, { enabled: !rule.enabled }); load(); } catch (e) { toast(e.message, 'err'); } }
  async function remove(rule) {
    if (!window.confirm(t('al.confirmDelete'))) return;
    try { await api.monitor.remove(rule.id); load(); } catch (e) { toast(e.message, 'err'); }
  }
  async function test(rule) {
    try {
      const r = await api.monitor.test(rule.id);
      toast(`${r.problem ? '⚠ ' : r.problem === false ? '✔ ' : ''}${r.message}`, r.problem ? 'err' : 'ok');
    } catch (e) { toast(e.message, 'err'); }
  }
  // Recommended set for a connection; replication only if it is a replica.
  async function addPresets() {
    if (!presetConn) return;
    const existing = new Set(data.rules.filter((r) => r.connId === presetConn).map((r) => r.type));
    const types = ['down', 'connections', 'longQuery', 'slowQueries'];
    try {
      const repl = await api.admin.replication(presetConn).catch(() => null);
      if (repl?.role === 'replica') types.unshift('replication');
    } catch { /* ignore */ }
    let n = 0;
    for (const type of types) {
      if (existing.has(type)) continue;
      await api.monitor.create({ connId: presetConn, type, params: DEFAULTS[type], intervalSec: type === 'down' ? 30 : 60, repeatMin: 60 });
      n++;
    }
    toast(t('al.presetsAdded', { n }), 'ok');
    load();
  }
  async function askPermission() {
    try { setPerm(await Notification.requestPermission()); } catch { /* ignore */ }
  }

  const active = data.rules.filter((r) => r.enabled && data.states[r.id]?.status === 'firing');
  const describe = (r) => t('al.desc_' + r.type, r.params);

  return (
    <div className="tabview alerts-tab">
      <div className="data-toolbar" ref={barRef}>
        <button className="mini primary" onClick={() => setEdit({ connId: connections[0]?.id, type: 'down', params: DEFAULTS.down, intervalSec: 30, repeatMin: 60, enabled: true })}>＋ {t('al.newRule')}</button>
        <span className="btn-group">
          <select value={presetConn} onChange={(e) => setPresetConn(e.target.value)}>
            {connections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <button className="mini" onClick={addPresets} title={t('al.presetsTitle')}>{t('al.presets')}</button>
        </span>
        <span style={{ flex: 1 }} />
        {isDesktop()
          ? <span className="count">{t('al.desktopNotif')}</span>
          : perm === 'granted'
            ? <span className="count">✔ {t('al.browserNotifOn')}</span>
            : perm !== 'unsupported' && <button className="mini" onClick={askPermission}>{t('al.enableBrowserNotif')}</button>}
      </div>
      <div className="results-pane scroll alerts-body">
        <section>
          <div className="sec-title">{t('al.active', { n: active.length })}</div>
          {!active.length && <div className="count ok-line">✔ {t('al.allGood')}</div>}
          {active.map((r) => {
            const st = data.states[r.id];
            return (
              <div key={r.id} className={'alert-card ' + (st.level || 'warning')}>
                <span className="alert-level">{st.level === 'critical' ? '✖' : '⚠'} {t('al.lvl_' + (st.level || 'warning'))}</span>
                <b>{r.connName}</b> <EnvBadge conn={getConn(r.connId)} small />
                <span className="count">· {t('al.t_' + r.type)} · {t('al.since', { ago: ago(st.since, t) })}</span>
                <div className="alert-msg">{st.message}</div>
                <button className="mini" onClick={() => onOpenServer(r.connId, r.type === 'replication' ? 'replication' : r.type === 'longQuery' ? 'processes' : 'dashboard')}>{t('al.open')}</button>
              </div>
            );
          })}
        </section>

        <section>
          <div className="sec-title">{t('al.rules', { n: data.rules.length })}</div>
          {!data.rules.length && <div className="empty">{t('al.noRules')}</div>}
          {data.rules.length > 0 && (
            <table className="grid admin-table rules-table">
              <thead><tr><th /><th>{t('al.connection')}</th><th>{t('al.type')}</th><th>{t('al.condition')}</th><th>{t('al.status')}</th><th>{t('al.lastCheck')}</th><th /></tr></thead>
              <tbody>
                {data.rules.map((r) => {
                  const st = data.states[r.id] || {};
                  return (
                    <tr key={r.id} className={r.enabled ? '' : 'off'}>
                      <td><input type="checkbox" checked={r.enabled} onChange={() => toggle(r)} title={t('al.enabled')} /></td>
                      <td>{r.connName} <EnvBadge conn={getConn(r.connId)} small /></td>
                      <td>{t('al.t_' + r.type)}</td>
                      <td>{describe(r)}<div className="count">{t('al.every', { s: r.intervalSec })}{r.repeatMin ? ` · ${t('al.repeat', { m: r.repeatMin })}` : ''}</div></td>
                      <td><span className={'rule-status ' + st.status}>{t('al.st_' + st.status)}</span><div className="count rule-msg" title={st.message}>{st.message}</div></td>
                      <td className="count">{ago(st.lastRun, t)}</td>
                      <td className="actions-cell">
                        <button className="mini" onClick={() => test(r)}>{t('al.test')}</button>
                        <button className="mini" onClick={() => setEdit(r)}>✎︎</button>
                        <button className="mini danger" onClick={() => remove(r)}>✕</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>

        <section>
          <div className="row3">
            <div className="sec-title">{t('al.history')}</div>
            <span style={{ flex: 1 }} />
            {data.history.length > 0 && <button className="mini" onClick={async () => { await api.monitor.clearHistory(); load(); }}>{t('al.clearHistory')}</button>}
          </div>
          {!data.history.length && <div className="count">{t('al.noHistory')}</div>}
          {data.history.length > 0 && (
            <table className="grid admin-table">
              <tbody>
                {data.history.map((h) => (
                  <tr key={h.id}>
                    <td className="count">{new Date(h.at).toLocaleString()}</td>
                    <td><span className={'hist-kind ' + h.kind + ' ' + h.level}>{h.kind === 'resolved' ? '✔' : h.level === 'critical' ? '✖' : '⚠'} {t('al.k_' + h.kind)}</span></td>
                    <td>{h.connName}</td>
                    <td>{t('al.t_' + h.type)}</td>
                    <td className="hist-msg">{h.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>

      {edit && <RuleEditor rule={edit} connections={connections} onSave={save} onClose={() => setEdit(null)} />}
    </div>
  );
}

function RuleEditor({ rule, connections, onSave, onClose }) {
  const { t } = useI18n();
  const [r, setR] = useState({ ...rule, params: { ...rule.params } });
  const setType = (type) => setR((x) => ({ ...x, type, params: { ...DEFAULTS[type] } }));
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <h3>{rule.id ? t('al.editRule') : t('al.newRule')}</h3>
        <div className="content">
          <div className="field">
            <label>{t('al.connection')}</label>
            <select value={r.connId} onChange={(e) => setR({ ...r, connId: e.target.value })}>
              {connections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label>{t('al.type')}</label>
            <select value={r.type} onChange={(e) => setType(e.target.value)}>
              {Object.keys(TYPES).map((k) => <option key={k} value={k}>{t('al.t_' + k)}</option>)}
            </select>
            <div className="count">{t('al.help_' + r.type)}</div>
          </div>
          {TYPES[r.type].params.map(([k, unit]) => (
            <div className="field" key={k}>
              <label>{t('al.p_' + k)}</label>
              <div className="row3"><input type="number" min="1" value={r.params[k]} onChange={(e) => setR({ ...r, params: { ...r.params, [k]: Number(e.target.value) } })} /> <span className="count">{unit}</span></div>
            </div>
          ))}
          <div className="row2">
            <div className="field">
              <label>{t('al.interval')}</label>
              <input type="number" min="10" value={r.intervalSec} onChange={(e) => setR({ ...r, intervalSec: Number(e.target.value) })} />
            </div>
            <div className="field">
              <label>{t('al.repeatLabel')}</label>
              <input type="number" min="0" value={r.repeatMin} onChange={(e) => setR({ ...r, repeatMin: Number(e.target.value) })} />
            </div>
          </div>
          <label className="radio"><input type="checkbox" checked={r.enabled} onChange={(e) => setR({ ...r, enabled: e.target.checked })} /> {t('al.enabled')}</label>
        </div>
        <div className="actions">
          <button onClick={onClose}>{t('conn.cancel')}</button>
          <button className="primary" onClick={() => onSave(r)}>{t('conn.save')}</button>
        </div>
      </div>
    </div>
  );
}
