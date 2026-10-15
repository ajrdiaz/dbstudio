import React, { useRef, useState, useEffect, useMemo } from 'react';
import Editor from '@monaco-editor/react';
import { api } from '../api.js';
import EditableGrid from './EditableGrid.jsx';
import ExplainView from './ExplainView.jsx';
import { guardWrite, cancelledError } from '../lib/env.jsx';
import { setTabSession } from '../lib/editorSessions.js';
import { askText } from '../lib/dialogs.jsx';
import { folderOptions, lastFolder, rememberFolder } from '../lib/savedFolders.js';
import { format as formatSqlText } from 'sql-formatter';
import { ensureProvider, setSchema } from '../lib/completion.js';
import { splitStatements, statementAt } from '../lib/sqlSplit.js';
import { useI18n } from '../i18n.jsx';

// SQL editor tab: Monaco on top, result set(s) below. Like SQLyog, Ctrl+Enter
// (or F9) runs the statement under the cursor — or the selection, if any — and
// Ctrl+Shift+Enter (or F5 / Ctrl+F9) runs the whole script.
// Reports sql/database changes up (onStateChange) so the workspace can persist
// them, and can save the current SQL as a named favorite.
export default function QueryTab({ tabId, connId, database, initialSql, savedQueryId, savedBase, autocommitPref, rowLimitPref, theme, onStateChange, onSaved, toast }) {
  const { t } = useI18n();
  const [sql, setSql] = useState(initialSql || '');
  const [db, setDb] = useState(database || '');
  const [databases, setDatabases] = useState([]);
  // Last execution: { results: [...], error, statements, elapsedMs } — one
  // result tab per row set plus a "Messages" tab, like SQLyog.
  const [exec, setExec] = useState(null);
  const [resTab, setResTab] = useState(null); // index into exec.results, 'msg' or 'plan'
  const [plan, setPlan] = useState(null); // last EXPLAIN: { sql, columns, rows }
  const [running, setRunning] = useState(false);
  const [editorPct, setEditorPct] = useState(42);
  // Dedicated server session for this tab (transactions, cancel, session vars).
  const sessRef = useRef(null); // { sid }
  const [autocommit, setAutocommit] = useState(autocommitPref !== false);
  const [inTx, setInTx] = useState(false);
  const [rowLimit, setRowLimit] = useState(rowLimitPref ?? 1000);
  const [cancelling, setCancelling] = useState(false);
  const dirtyRef = useRef({}); // result index -> has unsaved grid edits
  const [linkedQuery, setLinkedQuery] = useState(savedQueryId || null);
  // What the linked saved query holds ({ sql, database }), to tell whether the
  // tab has unsaved changes (shown as ● on the tab, saved with Ctrl+S).
  const [base, setBase] = useState(savedBase || null);
  const modified = !!linkedQuery && !!base && (sql !== base.sql || db !== (base.database || ''));
  const editorRef = useRef(null);
  const schemaRef = useRef({ tables: {} }); // this tab's schema for autocomplete
  // Editor keybindings are registered once on mount, so they call through this
  // ref to always reach the latest run/save (and therefore the current db etc).
  const actionsRef = useRef({});

  // Load the database list for the dropdown.
  useEffect(() => {
    let alive = true;
    api.databases(connId)
      .then((list) => alive && setDatabases(list.map((d) => d.name)))
      .catch(() => {});
    return () => { alive = false; };
  }, [connId]);

  // Load the schema map for autocomplete whenever the target database changes.
  useEffect(() => {
    if (!db) { schemaRef.current = { tables: {} }; setSchema(schemaRef.current); return; }
    let alive = true;
    api.schemaMap(connId, db)
      .then((map) => { if (alive) { schemaRef.current = map; setSchema(map); } })
      .catch(() => {});
    return () => { alive = false; };
  }, [connId, db]);

  // Push state up (debounced) for workspace persistence.
  useEffect(() => {
    if (!onStateChange) return;
    const t = setTimeout(() => onStateChange(tabId, { sql, database: db, savedQueryId: linkedQuery, savedBase: base, autocommit, rowLimit }), 400);
    return () => clearTimeout(t);
  }, [sql, db, linkedQuery, base, autocommit, rowLimit, tabId, onStateChange]);
  // The ● on the tab updates right away.
  useEffect(() => { onStateChange?.(tabId, { modified }); }, [modified, tabId, onStateChange]);
  // Tabs restored from an older workspace don't carry the saved text: fetch it.
  useEffect(() => {
    if (!linkedQuery || base) return;
    let alive = true;
    api.listQueries()
      .then((list) => {
        const q = list.find((x) => x.id === linkedQuery);
        if (alive && q) setBase({ sql: q.sql, database: q.database || '' });
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [linkedQuery, base]);

  // ---- editor session ----
  function applySession(st) {
    if (!st) return;
    setInTx(!!st.inTransaction);
    setTabSession(tabId, { sid: st.sid, inTransaction: !!st.inTransaction });
  }
  async function ensureSession() {
    if (sessRef.current) return sessRef.current.sid;
    const st = await api.sessions.open(connId);
    sessRef.current = { sid: st.sid };
    if (!autocommit) applySession(await api.sessions.autocommit(st.sid, false));
    else applySession(st);
    return st.sid;
  }
  function dropSession() {
    sessRef.current = null;
    setInTx(false);
    setTabSession(tabId, null);
  }
  // Run on the tab's session. A vanished session (server restart, idle
  // timeout) is recreated transparently — unless a transaction was open,
  // because its earlier statements are gone: then the user must know.
  async function sessionQuery(body) {
    const sid = await ensureSession();
    try {
      const r = await api.query(connId, { ...body, session: sid, limit: rowLimit || undefined });
      applySession(r.session);
      return r;
    } catch (e) {
      if (e.code !== 'SESSION_GONE') throw e;
      const hadTx = inTx;
      dropSession();
      if (hadTx) throw new Error(t('tx.lostTx'));
      const sid2 = await ensureSession();
      const r = await api.query(connId, { ...body, session: sid2, limit: rowLimit || undefined });
      applySession(r.session);
      return r;
    }
  }
  // Close the session when the tab goes away.
  useEffect(() => () => {
    const s = sessRef.current;
    setTabSession(tabId, null);
    if (s) api.sessions.close(s.sid).catch(() => {});
  }, [tabId]);

  async function toggleAutocommit(on) {
    if (on && inTx && !window.confirm(t('tx.confirmAutocommitOn'))) return;
    setAutocommit(on);
    if (!sessRef.current) return;
    try { applySession(await api.sessions.autocommit(sessRef.current.sid, on)); }
    catch (e) { toast(e.message, 'err'); if (e.code === 'SESSION_GONE') dropSession(); }
  }
  async function commit() {
    if (!sessRef.current) return;
    if (!(await guardWrite(connId, { statements: ['COMMIT'] }))) return;
    try { applySession(await api.sessions.commit(sessRef.current.sid)); toast(t('tx.committed'), 'ok'); }
    catch (e) { toast(e.message, 'err'); if (e.code === 'SESSION_GONE') dropSession(); }
  }
  async function rollback() {
    if (!sessRef.current) return;
    try { applySession(await api.sessions.rollback(sessRef.current.sid)); toast(t('tx.rolledBack'), 'ok'); }
    catch (e) { toast(e.message, 'err'); if (e.code === 'SESSION_GONE') dropSession(); }
  }
  async function cancelRun() {
    if (!sessRef.current) return;
    setCancelling(true);
    try { await api.sessions.cancel(sessRef.current.sid); } catch (e) { toast(e.message, 'err'); }
  }

  // What to execute, as a list of statements (DELIMITER handled client-side):
  // 'current' = the selection, else the statement at the cursor; 'all' = the
  // whole script. Always read from the editor, never from captured state.
  function pickStatements(mode) {
    const ed = editorRef.current;
    const model = ed?.getModel();
    const text = model ? model.getValue() : sql;
    const split = (s) => splitStatements(s).map((st) => st.sql);
    if (mode === 'all' || !ed) return split(text);
    const sel = model.getValueInRange(ed.getSelection());
    if (sel && sel.trim()) return split(sel);
    const stmt = statementAt(text, model.getOffsetAt(ed.getPosition()));
    if (!stmt) return [];
    // Briefly select what is about to run so it's obvious which statement it was.
    flash(ed, model.getPositionAt(stmt.start), model.getPositionAt(stmt.start + stmt.sql.length));
    return [stmt.sql];
  }

  const hasUnsaved = () => Object.values(dirtyRef.current).some(Boolean);

  async function run(mode = 'current') {
    const statements = pickStatements(mode);
    if (!statements.length) return;
    if (hasUnsaved() && !window.confirm(t('grid.confirmDiscard'))) return;
    if (!(await guardWrite(connId, { statements }))) return;
    setRunning(true);
    setCancelling(false);
    try {
      const r = await sessionQuery({ statements, database: db || undefined });
      dirtyRef.current = {};
      setExec({ ...r, list: statements });
      setPlan(null);
      const firstRows = r.results.findIndex((x) => x.type === 'rows');
      setResTab(r.error || firstRows < 0 ? 'msg' : firstRows);
    } catch (e) {
      setExec({ results: [], error: { statement: 0, sql: statements[0], message: e.message }, statements: statements.length, list: statements });
      setResTab('msg');
    } finally {
      setRunning(false);
    }
  }

  // After saving edits made in a result grid, re-run just that statement.
  async function refreshResult(i) {
    const rs = exec?.results[i];
    if (!rs) return;
    try {
      const r = await sessionQuery({ statements: [rs.sql], database: db || undefined });
      const fresh = r.results.find((x) => x.type === 'rows');
      if (fresh) setExec((ex) => ({ ...ex, results: ex.results.map((x, j) => (j === i ? { ...fresh, statement: rs.statement } : x)) }));
    } catch (e) { toast(e.message, 'err'); }
  }

  // Format with sql-formatter (MariaDB dialect) through Monaco edits so Ctrl+Z
  // undoes it. scope: 'auto' = selection or whole script; 'current' = the
  // statement under the cursor (F12, as in SQLyog).
  function formatSql(scope = 'auto') {
    const ed = editorRef.current;
    const model = ed?.getModel();
    if (!model) return;
    let range = ed.getSelection();
    if (scope === 'current' && range.isEmpty()) {
      const stmt = statementAt(model.getValue(), model.getOffsetAt(ed.getPosition()));
      if (!stmt) return;
      const a = model.getPositionAt(stmt.start);
      const b = model.getPositionAt(stmt.start + stmt.sql.length);
      range = { startLineNumber: a.lineNumber, startColumn: a.column, endLineNumber: b.lineNumber, endColumn: b.column };
    } else if (range.isEmpty()) {
      range = model.getFullModelRange();
    }
    const src = model.getValueInRange(range);
    if (/^\s*delimiter\s/im.test(src)) { toast(t('query.formatDelimiter'), 'err'); return; }
    try {
      const out = formatSqlText(src, { language: 'mariadb', keywordCase: 'upper', tabWidth: 2, linesBetweenQueries: 2 });
      ed.pushUndoStop();
      ed.executeEdits('format', [{ range, text: out, forceMoveMarkers: true }]);
      ed.pushUndoStop();
      ed.focus();
    } catch (e) {
      toast(t('query.formatError', { msg: e.message.split('\n')[0] }), 'err');
    }
  }

  // EXPLAIN the statement under the cursor (or the selection) into a "Plan" tab.
  async function explain() {
    const statements = pickStatements('current');
    if (!statements.length) return;
    const stmt = statements[0];
    if (!/^\s*(\(?\s*select|with|update|delete|insert|replace|table)\b/i.test(stmt)) {
      toast(t('explain.notExplainable'), 'err');
      return;
    }
    setRunning(true);
    try {
      const r = await sessionQuery({ statements: [`EXPLAIN ${stmt}`], database: db || undefined });
      if (r.error) throw new Error(r.error.message);
      const rs = r.results.find((x) => x.type === 'rows');
      setPlan({ sql: stmt, columns: rs.columns, rows: rs.rows });
      if (!exec) setExec({ results: [], error: null, statements: 0, list: [] });
      setResTab('plan');
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      setRunning(false);
    }
  }

  function startSplitDrag(e) {
    e.preventDefault();
    // Relative drag: move the editor's bottom edge by exactly what the mouse
    // moves. (Using the pointer position against the whole pane made the bar
    // jump down by the toolbar's height on the first click.)
    const pane = e.currentTarget.parentElement;
    const editorEl = e.currentTarget.previousElementSibling;
    const paneH = pane.getBoundingClientRect().height;
    const startY = e.clientY;
    const startH = editorEl.getBoundingClientRect().height;
    const mv = (ev) => {
      const h = startH + (ev.clientY - startY);
      setEditorPct(Math.min(85, Math.max(12, (h / paneH) * 100)));
    };
    const up = () => {
      document.body.classList.remove('resizing-rows');
      window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up);
    };
    document.body.classList.add('resizing-rows');
    window.addEventListener('mousemove', mv);
    window.addEventListener('mouseup', up);
  }

  function onMount(editor, monaco) {
    editorRef.current = editor;
    if (!initialSql) editor.focus(); // fresh "＋" tab: ready to type
    ensureProvider(monaco);
    setSchema(schemaRef.current);
    // When this editor gains focus, make its schema the active one.
    editor.onDidFocusEditorText(() => setSchema(schemaRef.current));
    // addAction (not addCommand) keeps keybindings scoped to this editor when
    // several query tabs exist.
    const { KeyMod, KeyCode } = monaco;
    editor.addAction({
      id: 'dbstudio.runCurrent', label: 'Run current statement',
      keybindings: [KeyMod.CtrlCmd | KeyCode.Enter, KeyCode.F9],
      run: () => actionsRef.current.run('current'),
    });
    editor.addAction({
      id: 'dbstudio.runAll', label: 'Run all',
      keybindings: [KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.Enter, KeyCode.F5, KeyMod.CtrlCmd | KeyCode.F9],
      run: () => actionsRef.current.run('all'),
    });
    editor.addAction({
      id: 'dbstudio.format', label: 'Format SQL',
      keybindings: [KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyF],
      run: () => actionsRef.current.formatSql('auto'),
    });
    editor.addAction({
      id: 'dbstudio.formatCurrent', label: 'Format current statement',
      keybindings: [KeyCode.F12],
      run: () => actionsRef.current.formatSql('current'),
    });
    editor.addAction({
      id: 'dbstudio.save', label: 'Save query',
      keybindings: [KeyMod.CtrlCmd | KeyCode.KeyS],
      run: () => actionsRef.current.saveQuery(),
    });
  }

  async function saveQuery() {
    const text = editorRef.current?.getValue() ?? sql;
    try {
      if (linkedQuery) {
        await api.updateQuery(linkedQuery, { sql: text, database: db });
        setBase({ sql: text, database: db });
        toast(t('query.updated'), 'ok');
      } else {
        const folders = await api.listQueryFolders().catch(() => []);
        const r = await askText({
          title: t('query.save'), label: t('query.nameThis'),
          choice: { label: t('saved.folder'), value: lastFolder(folders), options: folderOptions(folders, t('saved.root')) },
        });
        const name = r?.text?.trim();
        if (!name) return;
        rememberFolder(r.choice);
        const q = await api.createQuery({ name, sql: text, database: db, connectionId: connId, folder: r.choice });
        setLinkedQuery(q.id);
        setBase({ sql: text, database: db });
        onStateChange?.(tabId, { title: name });
        toast(t('query.saved'), 'ok');
      }
      onSaved?.();
    } catch (e) { toast(e.message, 'err'); }
  }

  actionsRef.current = { run, saveQuery, formatSql };

  const rowSets = exec ? exec.results.map((rs, i) => ({ rs, i })).filter((x) => x.rs.type === 'rows') : [];

  return (
    <div className="editor-pane">
      <div className="editor-toolbar">
        {running ? (
          <IconButton className="danger-solid" onClick={cancelRun} disabled={cancelling}
            label={cancelling ? t('tx.cancelling') : t('tx.cancelTitle')} icon="■" />
        ) : (
          <IconButton className="primary" onClick={() => run('current')} label={t('query.runTitle')} icon="▶︎" />
        )}
        <IconButton onClick={() => run('all')} disabled={running} label={t('query.runAllTitle')} icon="▶︎▶︎" />
        <IconButton onClick={saveQuery} label={linkedQuery ? t('query.updateTitle') : t('query.saveTitle')} icon="💾︎" />
        <IconButton onClick={() => formatSql('auto')} label={t('query.formatTitle')} icon="≡" />
        <IconButton onClick={explain} disabled={running} label={t('explain.title')} icon="⚡︎" />
        <label className="count">{t('query.db')}</label>
        <select value={db} onChange={(e) => setDb(e.target.value)} className="db-pick">
          <option value="">{t('query.none')}</option>
          {databases.map((d) => <option key={d} value={d}>{d}</option>)}
          {db && !databases.includes(db) && <option value={db}>{db}</option>}
        </select>
        <label className="count" title={t('tx.limitTitle')}>{t('tx.limit')}</label>
        <select value={rowLimit} onChange={(e) => setRowLimit(Number(e.target.value))} title={t('tx.limitTitle')}>
          {[100, 1000, 5000, 10000, 50000].map((n) => <option key={n} value={n}>{n.toLocaleString()}</option>)}
          <option value={0}>{t('tx.noLimit')}</option>
        </select>
        <label className="radio autocommit" title={t('tx.autocommitTitle')}>
          <input type="checkbox" checked={autocommit} onChange={(e) => toggleAutocommit(e.target.checked)} /> Auto-commit
        </label>
        {!autocommit && (
          <span className={'tx-state' + (inTx ? ' open' : '')} title={inTx ? t('tx.openTitle') : t('tx.manualTitle')}>
            {inTx ? t('tx.open') : t('tx.manual')}
          </span>
        )}
        {(!autocommit || inTx) && (
          <>
            <button className="tx-commit" onClick={commit} disabled={running || !inTx}>✔ Commit</button>
            <button className="tx-rollback" onClick={rollback} disabled={running || !inTx}>↶ Rollback</button>
          </>
        )}
        <span style={{ flex: 1 }} />
        <IconButton onClick={() => setSql('')} label={t('query.clearTitle')} icon="⌫" />
      </div>
      <div className="editor-host" style={{ height: `${editorPct}%` }}>
        <Editor
          defaultLanguage="sql"
          theme={theme === 'dark' ? 'vs-dark' : 'vs'}
          value={sql}
          onChange={(v) => setSql(v ?? '')}
          onMount={onMount}
          options={{
            fontSize: 13, minimap: { enabled: false }, scrollBeyondLastLine: false,
            automaticLayout: true, wordWrap: 'on',
            quickSuggestions: true, suggestOnTriggerCharacters: true,
          }}
        />
      </div>
      <div className="splitter" onMouseDown={startSplitDrag} title={t('query.splitter')} />
      <div className="results-pane">
        {!exec && !running && <div className="empty">{t('query.hint')}</div>}
        {running && !exec && <div className="empty">{t('query.running')}</div>}
        {exec && (
          <>
            <div className="result-tabs">
              {rowSets.map(({ rs, i }, k) => (
                <button key={i} className={resTab === i ? 'active' : ''} onClick={() => setResTab(i)} title={rs.sql}>
                  {t('query.resultN', { n: k + 1 })} <span className="count">({rs.rowCount})</span>
                </button>
              ))}
              {plan && (
                <button className={resTab === 'plan' ? 'active' : ''} onClick={() => setResTab('plan')}>{t('explain.tab')}</button>
              )}
              <button className={resTab === 'msg' ? 'active' : ''} onClick={() => setResTab('msg')}>
                {exec.error ? '✖ ' : ''}{t('query.messages')}
              </button>
              <span style={{ flex: 1 }} />
              {running && <span className="count">{t('query.running')}</span>}
            </div>
            {rowSets.map(({ rs, i }) => (
              <div key={i} className="result-body" style={{ display: resTab === i ? 'flex' : 'none' }}>
                <ResultView rs={rs} connId={connId} toast={toast} limit={exec.limit}
                  getSession={() => sessRef.current?.sid} manualTx={!autocommit}
                  onTxState={(st) => applySession(st)}
                  onDirty={(d) => { dirtyRef.current[i] = d; }}
                  onSaved={() => refreshResult(i)} />
              </div>
            ))}
            {resTab === 'msg' && <Messages exec={exec} />}
            {resTab === 'plan' && plan && <ExplainView plan={plan} />}
          </>
        )}
      </div>
    </div>
  );
}

// One result set: editable when the server says it maps to a single table
// with its primary key present.
function ResultView({ rs, connId, toast, onDirty, onSaved, limit, getSession, manualTx, onTxState }) {
  const { t } = useI18n();
  const edit = rs.edit;
  const columns = useMemo(
    () => rs.columns.map((c, i) => ({ ...c, meta: edit?.columns?.[i] ? edit.meta[edit.columns[i]] : null })),
    [rs, edit]
  );
  const reason = !edit ? t('grid.roNoTable')
    : edit.reason === 'multi' ? t('grid.roMulti')
      : edit.reason === 'nopk' ? t('grid.roNoPk', { table: edit.table })
        : edit.reason === 'pkmissing' ? t('grid.roPkMissing', { pk: edit.primaryKey.join(', ') })
          : '';
  return (
    <EditableGrid
      columns={columns}
      rows={rs.rows}
      editable={!!edit?.editable}
      targets={edit?.columns}
      primaryKey={edit?.primaryKey || []}
      tableName={edit?.table}
      readonlyReason={reason}
      exportName={edit?.table || 'result'}
      toast={toast}
      onDirtyChange={onDirty}
      onSave={async (changes, preview) => {
        if (!preview) {
          const { statements } = await api.saveRows(connId, edit.db, edit.table, { ...changes, preview: true });
          if (!(await guardWrite(connId, { statements }))) throw cancelledError();
      }
        const r = await api.saveRows(connId, edit.db, edit.table, { ...changes, preview, session: getSession() });
        if (!preview && r.session) {
          onTxState(r.session);
          toast(t('tx.savedInTx'), 'ok');
        }
        return r;
      }}
      onSaved={onSaved}
      leftTools={(
        <span className="count">
          {t('query.rows', { n: rs.rowCount })} · {rs.elapsedMs} ms
          {limit && rs.rowCount === limit ? <b className="warn-text"> · {t('tx.limited', { n: limit.toLocaleString() })}</b> : null}
          {manualTx && edit?.editable ? ` · ${t('tx.editsInTx')}` : ''}
          {edit?.editable ? ` · ${t('grid.editableOn', { table: `${edit.db}.${edit.table}` })}` : ''}
        </span>
      )}
    />
  );
}

// Per-statement outcome, like SQLyog's Messages tab.
function Messages({ exec }) {
  const { t } = useI18n();
  const lines = [];
  for (let i = 0; i < exec.statements; i++) {
    const sets = exec.results.filter((r) => r.statement === i);
    const err = exec.error && exec.error.statement === i ? exec.error : null;
    const skipped = exec.error && i > exec.error.statement;
    const sqlText = (exec.list?.[i] || sets[0]?.sql || err?.sql || '').replace(/\s+/g, ' ').slice(0, 160);
    lines.push(
      <div key={i} className={'msg-line' + (err ? ' err' : skipped ? ' skipped' : '')}>
        <div className="msg-sql"><b>#{i + 1}</b> {sqlText}</div>
        {err && <div>✖ {err.code ? `[${err.code}] ` : ''}{err.message}</div>}
        {skipped && <div>{t('query.notRun')}</div>}
        {sets.map((rs, k) => (
          <div key={k} className="ok">
            {rs.type === 'rows'
              ? `${t('query.rows', { n: rs.rowCount })} · ${rs.elapsedMs} ms`
              : t('query.okAffected', {
                n: rs.affectedRows,
                insert: rs.insertId ? t('query.insertId', { id: rs.insertId }) : '',
                ms: rs.elapsedMs,
                info: rs.info ? `· ${rs.info}` : '',
              })}
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="messages">
      {lines}
      {exec.elapsedMs != null && <div className="count">{t('query.totalTime', { ms: exec.elapsedMs, n: exec.statements })}</div>}
    </div>
  );
}

// Select [a, b] for a moment, then restore the cursor.
function flash(ed, a, b) {
  const pos = ed.getPosition();
  ed.setSelection({ startLineNumber: a.lineNumber, startColumn: a.column, endLineNumber: b.lineNumber, endColumn: b.column });
  setTimeout(() => {
    const sel = ed.getSelection();
    if (sel && sel.startLineNumber === a.lineNumber && sel.startColumn === a.column
      && sel.endLineNumber === b.lineNumber && sel.endColumn === b.column) {
      ed.setPosition(pos);
    }
  }, 350);
}

// Toolbar button that shows only an icon; the description (with shortcut) is
// the tooltip and the accessible name.
function IconButton({ icon, label, className = '', ...props }) {
  return (
    <button className={('tb-icon ' + className).trim()} title={label} aria-label={label} {...props}>
      <span aria-hidden="true">{icon}</span>
    </button>
  );
}
