import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { useI18n } from '../i18n.jsx';
import { guardWrite, getConn, EnvBadge } from '../lib/env.jsx';
import ReplicationView from './ReplicationView.jsx';
import DashboardView from './DashboardView.jsx';
import TopQueriesView from './TopQueriesView.jsx';
import { usePolling } from '../lib/polling.js';

// Server administration for one connection — SQLyog's process list, server
// variables / status and User Manager in one tab.
export default function ServerTab({ connId, view: savedView, onViewChange, onOpenScript, toast }) {
  const { t } = useI18n();
  // The selected section is stored with the tab (workspace), so it survives reloads.
  const [view, setViewState] = useState(savedView || 'dashboard');
  const setView = (v) => { setViewState(v); onViewChange?.(v); };
  return (
    <div className="tabview server-tab">
      <div className="structure-tabs">
        {['dashboard', 'processes', 'top', 'status', 'variables', 'replication', 'users'].map((v) => (
          <button key={v} className={view === v ? 'active' : ''} onClick={() => setView(v)}>{t('admin.' + v)}</button>
        ))}
      </div>
      {/* Kept mounted so the charts keep their history; polling pauses while hidden. */}
      <div className="server-body" style={{ display: view === 'dashboard' ? 'flex' : 'none' }}>
        <DashboardView connId={connId} toast={toast} />
      </div>
      <div className="server-body" style={{ display: view === 'dashboard' ? 'none' : 'flex' }}>
        {view === 'processes' && <Processes connId={connId} toast={toast} />}
        {view === 'top' && <TopQueriesView connId={connId} onOpenScript={onOpenScript} toast={toast} />}
        {view === 'status' && <Status connId={connId} toast={toast} />}
        {view === 'variables' && <Variables connId={connId} toast={toast} />}
        {view === 'replication' && <ReplicationView connId={connId} toast={toast} />}
        {view === 'users' && <Users connId={connId} toast={toast} />}
      </div>
    </div>
  );
}


function RefreshBar({ onRefresh, every, setEvery, loading, barRef, children }) {
  const { t } = useI18n();
  return (
    <div className="data-toolbar" ref={barRef}>
      <button className="mini" onClick={() => onRefresh()} disabled={loading}>{t('data.refresh')}</button>
      <label className="count">{t('admin.autoRefresh')}</label>
      <select value={every} onChange={(e) => setEvery(Number(e.target.value))}>
        <option value={0}>{t('admin.off')}</option>
        {[1, 2, 5, 10, 30].map((s) => <option key={s} value={s}>{s} s</option>)}
      </select>
      {children}
    </div>
  );
}

// Modal that shows the SQL an action will run and asks to confirm it.
function ConfirmSql({ connId, title, statements, danger, onRun, onClose }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const conn = getConn(connId);
  const prod = conn?.env === 'production';
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal wide">
        <h3>{prod ? '⚠ ' : ''}{title} <EnvBadge conn={conn} /></h3>
        <div className="content">
          {prod && <div className="err-text">{t('env.prodWarning', { name: conn.name })}</div>}
          <pre className="ddl sql-preview">{statements.map((s) => s + ';').join('\n')}</pre></div>
        <div className="actions">
          <button onClick={onClose}>{t('conn.cancel')}</button>
          <button className={danger || prod ? 'danger-solid' : 'primary'} disabled={busy}
            onClick={async () => { setBusy(true); try { await onRun(); onClose(); } catch { /* caller already showed the error */ } finally { setBusy(false); } }}>
            {t('admin.run')}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------- Processes ----------------
function Processes({ connId, toast }) {
  const { t } = useI18n();
  const [data, setData] = useState({ rows: [], ownIds: [] });
  const [hideSleep, setHideSleep] = useState(true);
  const [every, setEvery] = useState(5);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState('');
  const barRef = useRef(null);
  const load = useCallback(async (o) => {
    setLoading(true);
    try { setData(await api.admin.processes(connId)); }
    catch (e) {
      // Don't repeat the same error every few seconds: pause auto-refresh.
      if (o?.auto) { setEvery(0); toast(t('admin.autoPaused', { msg: e.message }), 'err'); } else toast(e.message, 'err');
    }
    finally { setLoading(false); }
  }, [connId, toast, t]);
  useEffect(() => { load(); }, [load]);
  usePolling(load, every, barRef);

  async function kill(p, queryOnly) {
    const msg = queryOnly ? t('admin.confirmKillQuery', { id: p.Id }) : t('admin.confirmKill', { id: p.Id, user: p.User });
    if (!(await guardWrite(connId, { statements: [`KILL ${queryOnly ? 'QUERY ' : ''}${p.Id}`], force: true }))) return;
    try { await api.admin.kill(connId, p.Id, queryOnly); toast(t('admin.killed', { id: p.Id }), 'ok'); load(); }
    catch (e) { toast(e.message, 'err'); }
  }

  const f = filter.toLowerCase();
  const rows = data.rows.filter((p) => (!hideSleep || p.Command !== 'Sleep')
    && (!f || [p.User, p.Host, p.db, p.State, p.Info].some((x) => String(x ?? '').toLowerCase().includes(f))));
  return (
    <>
      <RefreshBar onRefresh={load} every={every} setEvery={setEvery} loading={loading} barRef={barRef}>
        <label className="radio"><input type="checkbox" checked={hideSleep} onChange={(e) => setHideSleep(e.target.checked)} /> {t('admin.hideSleep')}</label>
        <input className="filter" placeholder={t('admin.filter')} value={filter} onChange={(e) => setFilter(e.target.value)} />
        <span className="count">{t('admin.processCount', { n: rows.length, total: data.rows.length })}</span>
      </RefreshBar>
      <div className="results-pane scroll">
        <table className="grid admin-table">
          <thead>
            <tr><th /><th>Id</th><th>{t('admin.user')}</th><th>Host</th><th>{t('admin.db')}</th><th>{t('admin.command')}</th><th>{t('admin.time')}</th><th>{t('admin.state')}</th><th>SQL</th></tr>
          </thead>
          <tbody>
            {rows.map((p) => {
              const own = data.ownIds.includes(Number(p.Id));
              const slow = Number(p.Time) >= 10 && p.Command !== 'Sleep';
              return (
                <tr key={p.Id} className={slow ? 'slow' : ''}>
                  <td className="actions-cell">
                    {!own && p.Info && <button className="mini" onClick={() => kill(p, true)}>{t('admin.killQuery')}</button>}
                    {!own && <button className="mini danger" onClick={() => kill(p, false)}>{t('admin.kill')}</button>}
                  </td>
                  <td>{p.Id}{own && <span className="count"> ({t('admin.thisApp')})</span>}</td>
                  <td>{p.User}</td>
                  <td>{p.Host}</td>
                  <td>{p.db ?? ''}</td>
                  <td>{p.Command}</td>
                  <td className="num">{p.Time}</td>
                  <td>{p.State ?? ''}</td>
                  <td className="sql-cell" title={p.Info || ''}>{p.Info ?? ''}</td>
                </tr>
              );
            })}
            {!rows.length && <tr><td colSpan={9} className="empty-row">{t('admin.noProcesses')}</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ---------------- Status ----------------
const fmtBytes = (n) => {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let v = Number(n) || 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i ? 1 : 0)} ${u[i]}`;
};
const fmtUptime = (s) => {
  s = Number(s) || 0;
  const d = Math.floor(s / 86400); const h = Math.floor((s % 86400) / 3600); const m = Math.floor((s % 3600) / 60);
  return `${d ? d + 'd ' : ''}${h}h ${m}m`;
};

function Status({ connId, toast }) {
  const { t } = useI18n();
  const [rows, setRows] = useState([]);
  const [rates, setRates] = useState({});
  const [every, setEvery] = useState(0);
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(false);
  const prev = useRef(null);
  const barRef = useRef(null);
  const load = useCallback(async (o) => {
    setLoading(true);
    try {
      const r = await api.admin.variables(connId, 'status');
      const now = Date.now();
      const map = Object.fromEntries(r.rows.map((x) => [x.name, x.value]));
      if (prev.current) {
        const dt = (now - prev.current.at) / 1000;
        const next = {};
        for (const [k, v] of Object.entries(map)) {
          const a = Number(prev.current.map[k]); const b = Number(v);
          if (Number.isFinite(a) && Number.isFinite(b) && b !== a && dt > 0) next[k] = (b - a) / dt;
        }
        setRates(next);
      }
      prev.current = { at: now, map };
      setRows(r.rows);
    } catch (e) {
      if (o?.auto) { setEvery(0); toast(t('admin.autoPaused', { msg: e.message }), 'err'); } else toast(e.message, 'err');
    }
    finally { setLoading(false); }
  }, [connId, toast, t]);
  useEffect(() => { load(); }, [load]);
  usePolling(load, every, barRef);

  const m = useMemo(() => Object.fromEntries(rows.map((x) => [x.name, x.value])), [rows]);
  const uptime = Number(m.Uptime) || 1;
  const qps = rates.Questions ?? (Number(m.Questions) || 0) / uptime;
  const cards = [
    [t('admin.uptime'), fmtUptime(m.Uptime)],
    [t('admin.connected'), m.Threads_connected],
    [t('admin.running'), m.Threads_running],
    [t('admin.qps'), qps.toFixed(qps < 10 ? 2 : 0)],
    [t('admin.slow'), m.Slow_queries],
    [t('admin.received'), fmtBytes(m.Bytes_received)],
    [t('admin.sent'), fmtBytes(m.Bytes_sent)],
    [t('admin.aborted'), m.Aborted_connects],
  ];
  const f = filter.toLowerCase();
  return (
    <>
      <RefreshBar onRefresh={load} every={every} setEvery={setEvery} loading={loading} barRef={barRef}>
        <input className="filter" placeholder={t('admin.filterVars')} value={filter} onChange={(e) => setFilter(e.target.value)} />
        <span className="count">{every ? t('admin.ratesHint') : t('admin.ratesOff')}</span>
      </RefreshBar>
      <div className="results-pane scroll">
        <div className="stat-cards">
          {cards.map(([k, v]) => <div key={k} className="stat-card"><div className="count">{k}</div><div className="stat-val">{v ?? '—'}</div></div>)}
        </div>
        <table className="grid admin-table">
          <thead><tr><th>{t('admin.variable')}</th><th>{t('admin.value')}</th><th>{t('admin.perSec')}</th></tr></thead>
          <tbody>
            {rows.filter((x) => !f || x.name.toLowerCase().includes(f)).map((x) => (
              <tr key={x.name}>
                <td>{x.name}</td>
                <td className="num">{x.value}</td>
                <td className="num">{rates[x.name] != null ? rates[x.name].toFixed(1) : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ---------------- Variables ----------------
function Variables({ connId, toast }) {
  const { t } = useI18n();
  const [rows, setRows] = useState([]);
  const [filter, setFilter] = useState('');
  const [edit, setEdit] = useState(null); // {name, value}
  const [confirm, setConfirm] = useState(null);
  const load = useCallback(async () => {
    try { setRows((await api.admin.variables(connId, 'variables')).rows); } catch (e) { toast(e.message, 'err'); }
  }, [connId, toast]);
  useEffect(() => { load(); }, [load]);
  const f = filter.toLowerCase();

  function ask(name, value) {
    const v = String(value).trim();
    const raw = /^-?\d+(\.\d+)?$/.test(v) || /^(ON|OFF|TRUE|FALSE|DEFAULT)$/i.test(v) ? v : `'${v.replace(/'/g, "''")}'`;
    setConfirm({ name, value: v, sql: `SET GLOBAL ${name} = ${raw}` });
  }
  return (
    <>
      <div className="data-toolbar">
        <button className="mini" onClick={load}>{t('data.refresh')}</button>
        <input className="filter" placeholder={t('admin.filterVars')} value={filter} onChange={(e) => setFilter(e.target.value)} />
        <span className="count">{t('admin.varsHint')}</span>
      </div>
      <div className="results-pane scroll">
        <table className="grid admin-table">
          <thead><tr><th>{t('admin.variable')}</th><th>{t('admin.value')}</th></tr></thead>
          <tbody>
            {rows.filter((x) => !f || x.name.toLowerCase().includes(f) || String(x.value).toLowerCase().includes(f)).map((x) => (
              <tr key={x.name}>
                <td>{x.name}</td>
                <td className="var-val" onDoubleClick={() => setEdit({ name: x.name, value: x.value ?? '' })} title={x.value ?? ''}>
                  {edit?.name === x.name ? (
                    <input autoFocus value={edit.value}
                      onChange={(e) => setEdit({ ...edit, value: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') setEdit(null);
                        if (e.key === 'Enter') { setEdit(null); if (e.currentTarget.value !== String(x.value ?? '')) ask(x.name, e.currentTarget.value); }
                      }}
                      onBlur={() => setEdit(null)} />
                  ) : (x.value ?? '')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {confirm && (
        <ConfirmSql connId={connId} title={t('admin.setVarTitle')} statements={[confirm.sql]} onClose={() => setConfirm(null)}
          onRun={async () => {
            try { await api.admin.setVariable(connId, confirm.name, confirm.value); toast(t('admin.varSet', { name: confirm.name }), 'ok'); load(); }
            catch (e) { toast(e.message, 'err'); throw e; }
          }} />
      )}
    </>
  );
}

// ---------------- Users & privileges ----------------
function Users({ connId, toast }) {
  const { t } = useI18n();
  const [users, setUsers] = useState([]);
  const [privList, setPrivList] = useState([]);
  const [sel, setSel] = useState(null); // {user, host}
  const [grants, setGrants] = useState([]);
  const [dbs, setDbs] = useState([]);
  const [confirm, setConfirm] = useState(null); // {title, statements, danger, run}
  const [newUser, setNewUser] = useState(null); // {user, host, password}
  const [grantForm, setGrantForm] = useState({ privileges: ['SELECT'], db: '*', table: '*', grantOption: false });
  const [pw, setPw] = useState('');

  const loadUsers = useCallback(async () => {
    try { const r = await api.admin.users(connId); setUsers(r.rows); setPrivList(r.privileges); }
    catch (e) { toast(e.message, 'err'); }
  }, [connId, toast]);
  const loadGrants = useCallback(async (u) => {
    if (!u) return;
    try { setGrants((await api.admin.userAction(connId, 'grants', u)).grants); }
    catch (e) { setGrants([]); toast(e.message, 'err'); }
  }, [connId, toast]);
  useEffect(() => { loadUsers(); api.databases(connId).then((l) => setDbs(l.map((d) => d.name))).catch(() => {}); }, [connId, loadUsers]);
  useEffect(() => { loadGrants(sel); }, [sel, loadGrants]);

  // Preview the SQL first, then confirm to run it.
  async function action(kind, body, { title, danger, after } = {}) {
    try {
      const { statements } = await api.admin.userAction(connId, kind, { ...body, preview: true });
      setConfirm({
        title, danger, statements,
        run: async () => {
          try {
            await api.admin.userAction(connId, kind, body);
            toast(t('admin.done'), 'ok');
            after?.();
          } catch (e) { toast(e.message, 'err'); throw e; }
        },
      });
    } catch (e) { toast(e.message, 'err'); }
  }

  const togglePriv = (p) => setGrantForm((g) => ({
    ...g,
    privileges: g.privileges.includes(p) ? g.privileges.filter((x) => x !== p) : [...g.privileges, p],
  }));
  const isSel = (u) => sel && sel.user === u.user && sel.host === u.host;

  return (
    <div className="users-layout">
      <div className="users-list">
        <div className="panel-actions">
          <button className="mini" onClick={() => setNewUser({ user: '', host: '%', password: '' })}>＋ {t('admin.newUser')}</button>
          <button className="mini" onClick={loadUsers}>{t('data.refresh')}</button>
        </div>
        <div className="panel-list">
          {users.map((u) => (
            <div key={`${u.user}@${u.host}`} className={'list-item' + (isSel(u) ? ' selected' : '')} onClick={() => setSel(u)}>
              <span className="grow"><span className="name">{u.user || t('admin.anonymous')}</span><span className="sub">@{u.host}</span></span>
            </div>
          ))}
        </div>
      </div>

      <div className="users-detail">
        {newUser && (
          <div className="note">
            <b>{t('admin.newUser')}</b>
            <div className="row3">
              <input placeholder={t('admin.user')} value={newUser.user} onChange={(e) => setNewUser({ ...newUser, user: e.target.value })} autoFocus />
              <input placeholder="Host (%)" value={newUser.host} onChange={(e) => setNewUser({ ...newUser, host: e.target.value })} />
              <input type="password" placeholder={t('conn.password')} value={newUser.password} onChange={(e) => setNewUser({ ...newUser, password: e.target.value })} />
            </div>
            <div className="count">{t('admin.hostHint')}</div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="primary" disabled={!newUser.user} onClick={() => action('create', newUser, {
                title: t('admin.newUser'),
                after: () => { const u = { user: newUser.user, host: newUser.host || '%' }; setNewUser(null); loadUsers(); setSel(u); },
              })}>{t('admin.create')}</button>
              <button onClick={() => setNewUser(null)}>{t('conn.cancel')}</button>
            </div>
          </div>
        )}

        {!sel && !newUser && <div className="empty">{t('admin.pickUser')}</div>}
        {sel && (
          <>
            <h4 className="user-title">{sel.user}<span className="count">@{sel.host}</span></h4>
            <div className="section-title">{t('admin.grants')}</div>
            <div className="grant-list">
              {grants.map((g, i) => (
                <div key={i} className="grant-line">
                  <code>{g.grant.replace(/IDENTIFIED BY PASSWORD '[^']*'/i, "IDENTIFIED BY PASSWORD '•••'")}</code>
                  {g.revoke.length > 0 && (
                    <button className="mini danger" onClick={() => action('revoke', { grant: g.grant }, { title: t('admin.revoke'), danger: true, after: () => loadGrants(sel) })}>
                      {t('admin.revoke')}
                    </button>
                  )}
                </div>
              ))}
            </div>

            <div className="section-title">{t('admin.addPrivileges')}</div>
            <div className="note">
              <div className="row3">
                <label className="field-inline">{t('admin.db')}
                  <select value={grantForm.db} onChange={(e) => setGrantForm({ ...grantForm, db: e.target.value })}>
                    <option value="*">{t('admin.allDbs')}</option>
                    {dbs.map((d) => <option key={d} value={d}>{d}</option>)}
                  </select>
                </label>
                <label className="field-inline">{t('admin.table')}
                  <input value={grantForm.table} onChange={(e) => setGrantForm({ ...grantForm, table: e.target.value || '*' })} disabled={grantForm.db === '*'} />
                </label>
                <label className="radio"><input type="checkbox" checked={grantForm.grantOption} onChange={(e) => setGrantForm({ ...grantForm, grantOption: e.target.checked })} /> WITH GRANT OPTION</label>
              </div>
              <div className="priv-grid">
                {privList.map((p) => (
                  <label key={p} className={'radio' + (p === 'ALL PRIVILEGES' ? ' all-priv' : '')}>
                    <input type="checkbox" checked={grantForm.privileges.includes(p)} onChange={() => togglePriv(p)} /> {p}
                  </label>
                ))}
              </div>
              <div>
                <button className="primary" disabled={!grantForm.privileges.length}
                  onClick={() => action('grant', { ...sel, ...grantForm }, { title: t('admin.addPrivileges'), after: () => loadGrants(sel) })}>
                  {t('admin.grant')}
                </button>
              </div>
            </div>

            <div className="section-title">{t('admin.account')}</div>
            <div className="note">
              <div style={{ display: 'flex', gap: 6 }}>
                <input type="password" placeholder={t('admin.newPassword')} value={pw} onChange={(e) => setPw(e.target.value)} />
                <button disabled={!pw} onClick={() => action('password', { ...sel, password: pw }, { title: t('admin.changePassword'), after: () => setPw('') })}>
                  {t('admin.changePassword')}
                </button>
                <span style={{ flex: 1 }} />
                <button className="danger" onClick={() => action('drop', sel, {
                  title: t('admin.dropUser'), danger: true,
                  after: () => { setSel(null); setGrants([]); loadUsers(); },
                })}>{t('admin.dropUser')}</button>
              </div>
            </div>
          </>
        )}
      </div>

      {confirm && (
        <ConfirmSql connId={connId} title={confirm.title} statements={confirm.statements} danger={confirm.danger}
          onRun={confirm.run} onClose={() => setConfirm(null)} />
      )}
    </div>
  );
}
