import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { useI18n } from '../i18n.jsx';
import { splitStatements } from '../lib/sqlSplit.js';
import { guardWrite, EnvBadge, getConn } from '../lib/env.jsx';

// "Compare / Copy" tab: schema synchronization script and table/database copy
// between any two databases (same or different connections).
export default function ToolsTab({ connections, preset, view: savedView, onViewChange, onOpenScript, toast }) {
  const { t } = useI18n();
  const [view, setViewState] = useState(savedView || preset?.view || 'compare');
  const setView = (v) => { setViewState(v); onViewChange?.(v); };
  return (
    <div className="tabview tools-tab">
      <div className="structure-tabs">
        <button className={view === 'compare' ? 'active' : ''} onClick={() => setView('compare')}>{t('tools.compare')}</button>
        <button className={view === 'copy' ? 'active' : ''} onClick={() => setView('copy')}>{t('tools.copy')}</button>
      </div>
      <div className="tools-body" style={{ display: view === 'compare' ? 'grid' : 'none' }}>
        <Compare connections={connections} preset={preset} onOpenScript={onOpenScript} toast={toast} />
      </div>
      <div className="tools-body" style={{ display: view === 'copy' ? 'grid' : 'none' }}>
        <Copy connections={connections} preset={preset} toast={toast} />
      </div>
    </div>
  );
}

// Connection + database picker. `allowNew` lets the user type a database name
// that doesn't exist yet (copy target).
function DbPicker({ label, connections, value, onChange, allowNew }) {
  const { t } = useI18n();
  const [dbs, setDbs] = useState([]);
  const listId = useRef('dbl' + Math.random().toString(36).slice(2)).current;
  useEffect(() => {
    if (!value.connId) { setDbs([]); return; }
    let alive = true;
    api.databases(value.connId).then((l) => alive && setDbs(l.map((d) => d.name))).catch(() => alive && setDbs([]));
    return () => { alive = false; };
  }, [value.connId]);
  return (
    <div className="db-picker">
      <div className="count">{label} <EnvBadge conn={getConn(value.connId)} small /></div>
      <select value={value.connId || ''} onChange={(e) => onChange({ connId: e.target.value, db: '' })}>
        <option value="">{t('tools.pickConn')}</option>
        {connections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
      {allowNew ? (
        <>
          <input list={listId} value={value.db} placeholder={t('tools.dbOrNew')} onChange={(e) => onChange({ ...value, db: e.target.value })} />
          <datalist id={listId}>{dbs.map((d) => <option key={d} value={d} />)}</datalist>
        </>
      ) : (
        <select value={value.db} onChange={(e) => onChange({ ...value, db: e.target.value })} disabled={!value.connId}>
          <option value="">{t('tools.pickDb')}</option>
          {dbs.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
      )}
    </div>
  );
}

const STATUS_ICON = { new: '＋', changed: '≠', extra: '−', same: '=' };

function Compare({ connections, preset, onOpenScript, toast }) {
  const { t } = useI18n();
  const [src, setSrc] = useState({ connId: preset?.connId || '', db: preset?.db || '' });
  const [dst, setDst] = useState({ connId: preset?.connId || '', db: '' });
  const [routines, setRoutines] = useState(true);
  const [includeDrops, setIncludeDrops] = useState(false);
  const [showSame, setShowSame] = useState(false);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState(null);
  const [runResult, setRunResult] = useState(null);

  // keepRun: re-compare after running the script without hiding its result.
  async function compare(keepRun = false) {
    setBusy(true);
    if (!keepRun) setRunResult(null);
    try { setRes(await api.tools.compare({ source: src, target: dst, includeDrops, routines })); }
    catch (e) { toast(e.message, 'err'); }
    finally { setBusy(false); }
  }
  async function runOnTarget() {
    const statements = splitStatements(res.script).map((s) => s.sql);
    // Always confirm (not only on production): this changes the target's schema.
    if (!(await guardWrite(dst.connId, { statements, force: true }))) return;
    setBusy(true);
    try {
      const r = await api.query(dst.connId, { statements, database: dst.db });
      if (r.error) {
        setRunResult({ ok: false, text: t('tools.runFailed', { n: r.error.statement + 1, total: statements.length, msg: r.error.message }) });
      } else {
        setRunResult({ ok: true, text: t('tools.runOk', { n: statements.length }) });
        await compare(true);
      }
    } catch (e) { toast(e.message, 'err'); }
    finally { setBusy(false); }
  }

  const same = src.connId && src.db && src.connId === dst.connId && src.db === dst.db;
  const ready = src.connId && src.db && dst.connId && dst.db && !same;
  const items = res ? res.items.filter((i) => showSame || i.status !== 'same') : [];
  return (
    <>
      <div className="tools-form">
        <DbPicker label={t('tools.source')} connections={connections} value={src} onChange={setSrc} />
        <div className="tools-arrow">→</div>
        <DbPicker label={t('tools.targetToSync')} connections={connections} value={dst} onChange={setDst} />
      </div>
      <div className="tools-opts">
        <label className="radio"><input type="checkbox" checked={routines} onChange={(e) => setRoutines(e.target.checked)} /> {t('tools.includeRoutines')}</label>
        <label className="radio"><input type="checkbox" checked={includeDrops} onChange={(e) => setIncludeDrops(e.target.checked)} /> {t('tools.includeDrops')}</label>
        <button className="primary" disabled={!ready || busy} onClick={() => compare()}>{busy ? '…' : t('tools.compareBtn')}</button>
        {same && <span className="err-text">{t('tools.sameDb')}</span>}
      </div>
      <div className="count">{t('tools.compareHint')}</div>

      {res && (
        <div className="compare-result">
          <div className="compare-summary">
            <span className="chip new">＋ {t('tools.sNew', { n: res.summary.new })}</span>
            <span className="chip changed">≠ {t('tools.sChanged', { n: res.summary.changed })}</span>
            <span className="chip extra">− {t('tools.sExtra', { n: res.summary.extra })}</span>
            <span className="chip same">= {t('tools.sSame', { n: res.summary.same })}</span>
            <label className="radio"><input type="checkbox" checked={showSame} onChange={(e) => setShowSame(e.target.checked)} /> {t('tools.showSame')}</label>
          </div>
          <div className="compare-cols">
            <div className="compare-items">
              {!items.length && <div className="empty">{t('tools.identical')}</div>}
              {items.map((it) => (
                <div key={it.type + it.name} className={'cmp-item ' + it.status}>
                  <div><span className="cmp-icon">{STATUS_ICON[it.status]}</span> <span className="count">{t('tools.type_' + it.type)}</span> <b>{it.name}</b>
                    {it.status === 'extra' && !includeDrops && <span className="count"> · {t('tools.notDropped')}</span>}
                  </div>
                  {it.details.map((d, i) => <div key={i} className="cmp-detail">{d}</div>)}
                </div>
              ))}
            </div>
            <div className="compare-script">
              <div className="row3">
                <b>{t('tools.script')}</b>
                <span style={{ flex: 1 }} />
                <button className="mini" disabled={!res.script} onClick={() => navigator.clipboard.writeText(res.script).then(() => toast(t('tools.copied'), 'ok'))}>{t('grid.copy')}</button>
                <button className="mini" disabled={!res.script} onClick={() => onOpenScript(dst.connId, dst.db, res.script)}>{t('tools.openInEditor')}</button>
                <button className="mini primary" disabled={!res.script || busy} onClick={runOnTarget}>{t('tools.runOnTarget')}</button>
              </div>
              {runResult && <div className={runResult.ok ? 'ok-text' : 'err-text'}>{runResult.text}</div>}
              <pre className="ddl script-pre">{res.script || t('tools.noChanges')}</pre>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function Copy({ connections, preset, toast }) {
  const { t } = useI18n();
  const [src, setSrc] = useState({ connId: preset?.connId || '', db: preset?.db || '' });
  const [dst, setDst] = useState({ connId: preset?.connId || '', db: '' });
  const [tables, setTables] = useState([]);
  const [picked, setPicked] = useState(new Set());
  const [opts, setOpts] = useState({ structure: true, data: true, dropExisting: false, createDb: true });
  const [job, setJob] = useState(null);
  const timer = useRef(null);

  useEffect(() => {
    if (!src.connId || !src.db) { setTables([]); return; }
    api.objects(src.connId, src.db)
      .then((o) => { setTables(o.tables); setPicked(new Set(o.tables.map((x) => x.name))); })
      .catch((e) => toast(e.message, 'err'));
  }, [src.connId, src.db, toast]);
  useEffect(() => () => clearInterval(timer.current), []);

  async function start() {
    if (opts.dropExisting && !window.confirm(t('tools.confirmDrop', { db: dst.db }))) return;
    if (!(await guardWrite(dst.connId, { summary: t('env.copySummary', { n: picked.size, db: dst.db }) }))) return;
    try {
      const { id } = await api.tools.copy({ source: src, target: dst, tables: tables.map((x) => x.name).filter((n) => picked.has(n)), ...opts });
      const poll = async () => {
        try {
          const j = await api.tools.job(id);
          setJob(j);
          if (j.status !== 'running') {
            clearInterval(timer.current);
            toast(j.status === 'done' ? t('tools.copyDone') : j.status === 'cancelled' ? t('tools.copyCancelled') : t('tools.copyErrors'), j.status === 'done' ? 'ok' : 'err');
          }
        } catch (e) { clearInterval(timer.current); toast(e.message, 'err'); }
      };
      clearInterval(timer.current);
      timer.current = setInterval(poll, 500);
      poll();
    } catch (e) { toast(e.message, 'err'); }
  }

  const toggle = (n) => setPicked((s) => { const x = new Set(s); x.has(n) ? x.delete(n) : x.add(n); return x; });
  const running = job?.status === 'running';
  const same = src.connId && src.connId === dst.connId && src.db && src.db === dst.db;
  const ready = src.connId && src.db && dst.connId && dst.db.trim() && picked.size && !same && !running && (opts.structure || opts.data);
  return (
    <>
      <div className="tools-form">
        <DbPicker label={t('tools.source')} connections={connections} value={src} onChange={setSrc} />
        <div className="tools-arrow">→</div>
        <DbPicker label={t('tools.target')} connections={connections} value={dst} onChange={setDst} allowNew />
      </div>
      <div className="tools-opts">
        <label className="radio"><input type="checkbox" checked={opts.structure} onChange={(e) => setOpts({ ...opts, structure: e.target.checked })} /> {t('tools.structure')}</label>
        <label className="radio"><input type="checkbox" checked={opts.data} onChange={(e) => setOpts({ ...opts, data: e.target.checked })} /> {t('tools.data')}</label>
        <label className="radio"><input type="checkbox" checked={opts.dropExisting} onChange={(e) => setOpts({ ...opts, dropExisting: e.target.checked })} /> {t('tools.dropExisting')}</label>
        <label className="radio"><input type="checkbox" checked={opts.createDb} onChange={(e) => setOpts({ ...opts, createDb: e.target.checked })} /> {t('tools.createDb')}</label>
        <button className="primary" disabled={!ready} onClick={start}>{t('tools.copyBtn', { n: picked.size })}</button>
        {running && <button onClick={() => api.tools.cancel(job.id)}>{t('conn.cancel')}</button>}
        {same && <span className="err-text">{t('tools.sameDb')}</span>}
      </div>
      <div className="count">{t('tools.copyHint')}</div>

      <div className="copy-tables">
        <div className="row3">
          <b>{t('tools.tables', { n: tables.length })}</b>
          <button className="mini" onClick={() => setPicked(new Set(tables.map((x) => x.name)))}>{t('tools.all')}</button>
          <button className="mini" onClick={() => setPicked(new Set())}>{t('tools.none')}</button>
        </div>
        <table className="grid admin-table">
          <thead><tr><th /><th>{t('explain.table')}</th><th>{t('tools.rowsApprox')}</th><th>{t('tools.progress')}</th><th>{t('admin.state')}</th></tr></thead>
          <tbody>
            {tables.map((tb) => {
              const j = job?.tables.find((x) => x.name === tb.name);
              const pct = j && j.total ? Math.min(100, (j.rows / j.total) * 100) : j?.status === 'done' ? 100 : 0;
              return (
                <tr key={tb.name}>
                  <td><input type="checkbox" checked={picked.has(tb.name)} onChange={() => toggle(tb.name)} disabled={running} /></td>
                  <td>{tb.name}</td>
                  <td className="num">{tb.rows ?? ''}</td>
                  <td>{j && <div className="progress"><div style={{ width: `${pct}%` }} /><span>{j.rows.toLocaleString()}{j.total != null ? ` / ${j.total.toLocaleString()}` : ''}</span></div>}</td>
                  <td className={j?.status === 'error' ? 'err-text' : ''}>{j ? (j.error || t('tools.st_' + j.status)) : ''}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
