import React, { useEffect, useMemo, useRef, useState } from 'react';
import readXlsxFile, { readSheetNames } from 'read-excel-file';
import { api } from '../api.js';
import { useI18n } from '../i18n.jsx';
import { guardWrite } from '../lib/env.jsx';
import { detectDelimiter, parseCSV, inferType, normalizeValue, cleanName } from '../lib/importParse.js';

// Import a CSV / TSV / Excel file into a new or existing table, with column
// mapping, type suggestions, value conversion and a live preview. Rows are
// sent in batches so a progress bar can follow along.
const TYPES = ['INT', 'BIGINT', 'DECIMAL(12,2)', 'DOUBLE', 'DATE', 'DATETIME', 'TIME', 'VARCHAR(255)', 'TEXT', 'BOOLEAN', 'JSON'];
const BATCH = 500;

export default function ImportModal({ connId, db, table: initialTable, onClose, onDone, toast }) {
  const { t } = useI18n();
  const [file, setFile] = useState(null); // { name, size, kind: 'csv'|'xlsx', raw }
  const [sheets, setSheets] = useState([]);
  const [sheet, setSheet] = useState('');
  const [encoding, setEncoding] = useState('utf-8');
  const [delim, setDelim] = useState('auto');
  const [header, setHeader] = useState(true);
  const [matrix, setMatrix] = useState([]); // parsed rows (incl. header row)
  const [target, setTarget] = useState(initialTable ? 'existing' : 'new');
  const [newName, setNewName] = useState('');
  const [addId, setAddId] = useState(true);
  const [existing, setExisting] = useState(initialTable || '');
  const [tables, setTables] = useState([]);
  const [tableCols, setTableCols] = useState([]); // [{name, type}]
  const [mapping, setMapping] = useState([]); // per file column: { name, type, target }
  const [mode, setMode] = useState('insert');
  const [truncate, setTruncate] = useState(false);
  const [opts, setOpts] = useState({ emptyAsNull: true, decimalComma: false, dateOrder: 'dmy' });
  const [progress, setProgress] = useState(null); // { done, total, error? }
  const [sqlPreview, setSqlPreview] = useState(null);
  const cancelRef = useRef(false);

  useEffect(() => {
    api.objects(connId, db).then((o) => setTables(o.tables.map((x) => x.name))).catch((e) => toast(e.message, 'err'));
  }, [connId, db, toast]);
  useEffect(() => {
    if (target !== 'existing' || !existing) { setTableCols([]); return; }
    api.structure(connId, db, existing)
      .then((s) => setTableCols((s.columns || []).map((c) => ({ name: c.name, type: c.type || '' }))))
      .catch((e) => toast(e.message, 'err'));
  }, [connId, db, existing, target, toast]);

  async function pick(e) {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    const isX = /\.xlsx$/i.test(f.name);
    if (/\.xls$/i.test(f.name)) { toast(t('imp.xlsOld'), 'err'); return; }
    setFile({ name: f.name, size: f.size, kind: isX ? 'xlsx' : 'csv', raw: f });
    setNewName(cleanName(f.name.replace(/\.[^.]+$/, ''), 0, new Set()).toLowerCase());
    setProgress(null);
    if (isX) {
      try { const names = await readSheetNames(f); setSheets(names); setSheet(names[0]); }
      catch (err) { toast(t('imp.readError', { msg: err.message }), 'err'); }
    } else { setSheets([]); setSheet(''); }
  }

  // Parse whenever the file or its read options change.
  useEffect(() => {
    if (!file) return;
    let alive = true;
    (async () => {
      try {
        let rows;
        if (file.kind === 'xlsx') {
          if (!sheet) return;
          rows = await readXlsxFile(file.raw, { sheet });
        } else {
          const buf = await file.raw.arrayBuffer();
          const text = new TextDecoder(encoding).decode(buf);
          rows = parseCSV(text, delim === 'auto' ? detectDelimiter(text) : delim === 'tab' ? '\t' : delim);
        }
        if (alive) setMatrix(rows);
      } catch (err) { if (alive) toast(t('imp.readError', { msg: err.message }), 'err'); }
    })();
    return () => { alive = false; };
  }, [file, sheet, encoding, delim, t, toast]);

  const width = Math.max(0, ...matrix.slice(0, 50).map((r) => r.length));
  const headers = useMemo(() => {
    const used = new Set();
    return Array.from({ length: width }, (_, i) => cleanName(header ? matrix[0]?.[i] : '', i, used));
  }, [matrix, header, width]);
  const dataRows = useMemo(() => (header ? matrix.slice(1) : matrix), [matrix, header]);

  // (Re)build the mapping when the file columns or the target change.
  useEffect(() => {
    const sample = dataRows.slice(0, 1000);
    setMapping(headers.map((h, i) => {
      const col = sample.map((r) => r[i]);
      const byName = tableCols.find((c) => c.name.toLowerCase() === h.toLowerCase());
      return { name: h, type: inferType(col, opts), target: byName ? byName.name : '' };
    }));
  }, [headers, dataRows, tableCols, opts.decimalComma, opts.dateOrder]); // eslint-disable-line react-hooks/exhaustive-deps

  const setMap = (i, patch) => setMapping((m) => m.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  // Columns actually imported: [fileIndex, targetName, targetType]
  const plan = useMemo(() => mapping
    .map((m, i) => (target === 'new' ? [i, m.name, m.type] : m.target ? [i, m.target, tableCols.find((c) => c.name === m.target)?.type || ''] : null))
    .filter(Boolean), [mapping, target, tableCols]);
  const convert = (r) => plan.map(([i, , type]) => normalizeValue(r[i], type, opts));
  const tableName = target === 'new' ? newName.trim() : existing;
  const dupTargets = plan.map((p) => p[1].toLowerCase()).filter((n, i, a) => a.indexOf(n) !== i);
  const ready = file && dataRows.length && plan.length && tableName && !dupTargets.length && (target === 'existing' || !tables.includes(tableName));

  function body(rows, first) {
    return {
      table: tableName,
      columns: plan.map((p) => p[1]),
      rows,
      mode: target === 'existing' ? mode : 'insert',
      create: first && target === 'new' ? { columns: plan.map((p) => ({ name: p[1], type: p[2] })), addId } : undefined,
      truncate: first && target === 'existing' && truncate,
    };
  }

  async function showSql() {
    try { setSqlPreview((await api.importRows(connId, db, { ...body(dataRows.slice(0, 3).map(convert), true), preview: true })).statements); }
    catch (e) { toast(e.message, 'err'); }
  }

  async function run() {
    const summary = t('imp.summary', { n: dataRows.length.toLocaleString(), table: `${db}.${tableName}` }) + (truncate && target === 'existing' ? ` ${t('imp.withTruncate')}` : '');
    if (truncate && target === 'existing' && !window.confirm(t('imp.confirmTruncate', { table: tableName }))) return;
    if (!(await guardWrite(connId, { summary }))) return;
    cancelRef.current = false;
    const total = dataRows.length;
    setProgress({ done: 0, total, affected: 0 });
    let affected = 0; let warnings = 0;
    try {
      for (let i = 0; i < total; i += BATCH) {
        if (cancelRef.current) { setProgress((p) => ({ ...p, cancelled: true })); return; }
        const r = await api.importRows(connId, db, body(dataRows.slice(i, i + BATCH).map(convert), i === 0));
        affected += r.affected; warnings += r.warnings;
        setProgress({ done: Math.min(total, i + BATCH), total, affected, warnings });
      }
      setProgress({ done: total, total, affected, warnings, finished: true });
      toast(t('imp.done', { n: total.toLocaleString(), table: tableName }), 'ok');
      onDone?.(tableName);
    } catch (e) {
      setProgress((p) => ({ ...p, error: e.message }));
    }
  }

  const running = progress && !progress.finished && !progress.error && !progress.cancelled;
  const preview = dataRows.slice(0, 15);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !running && onClose()}>
      <div className="modal import-modal">
        <h3>{t('imp.title', { db })}</h3>
        <div className="content import-body">
          <section>
            <div className="sec-title">1 · {t('imp.file')}</div>
            <div className="row3">
              <label className="file-btn"><input type="file" accept=".csv,.tsv,.txt,.xlsx" onChange={pick} />{t('imp.pick')}</label>
              {file && <span><b>{file.name}</b> <span className="count">· {(file.size / 1024).toFixed(0)} KB · {t('imp.rowsRead', { n: dataRows.length.toLocaleString() })}</span></span>}
            </div>
            {file && (
              <div className="row3">
                {file.kind === 'xlsx' ? (
                  <label className="field-inline">{t('imp.sheet')}
                    <select value={sheet} onChange={(e) => setSheet(e.target.value)}>{sheets.map((s) => <option key={s}>{s}</option>)}</select>
                  </label>
                ) : (
                  <>
                    <label className="field-inline">{t('imp.delimiter')}
                      <select value={delim} onChange={(e) => setDelim(e.target.value)}>
                        <option value="auto">{t('imp.auto')}</option><option value=";">;</option><option value=",">,</option><option value="tab">Tab</option><option value="|">|</option>
                      </select>
                    </label>
                    <label className="field-inline">{t('imp.encoding')}
                      <select value={encoding} onChange={(e) => setEncoding(e.target.value)}>
                        <option value="utf-8">UTF-8</option><option value="windows-1252">Windows-1252 / Latin-1</option>
                      </select>
                    </label>
                  </>
                )}
                <label className="radio"><input type="checkbox" checked={header} onChange={(e) => setHeader(e.target.checked)} /> {t('imp.header')}</label>
              </div>
            )}
          </section>

          {file && (
            <section>
              <div className="sec-title">2 · {t('imp.target')}</div>
              <div className="row3">
                <label className="radio"><input type="radio" checked={target === 'new'} onChange={() => setTarget('new')} /> {t('imp.newTable')}</label>
                <input value={newName} onChange={(e) => setNewName(e.target.value)} disabled={target !== 'new'} placeholder={t('imp.tableName')} />
                <label className="radio"><input type="checkbox" checked={addId} onChange={(e) => setAddId(e.target.checked)} disabled={target !== 'new'} /> {t('imp.addId')}</label>
              </div>
              {target === 'new' && tables.includes(newName.trim()) && <div className="err-text">{t('imp.exists')}</div>}
              <div className="row3">
                <label className="radio"><input type="radio" checked={target === 'existing'} onChange={() => setTarget('existing')} /> {t('imp.existing')}</label>
                <select value={existing} onChange={(e) => setExisting(e.target.value)} disabled={target !== 'existing'}>
                  <option value="">—</option>{tables.map((x) => <option key={x}>{x}</option>)}
                </select>
                {target === 'existing' && (
                  <>
                    <select value={mode} onChange={(e) => setMode(e.target.value)} title={t('imp.modeTitle')}>
                      <option value="insert">{t('imp.mInsert')}</option><option value="ignore">{t('imp.mIgnore')}</option>
                      <option value="update">{t('imp.mUpdate')}</option><option value="replace">{t('imp.mReplace')}</option>
                    </select>
                    <label className="radio"><input type="checkbox" checked={truncate} onChange={(e) => setTruncate(e.target.checked)} /> <span className="err-text">{t('imp.truncate')}</span></label>
                  </>
                )}
              </div>
              <div className="row3">
                <label className="radio"><input type="checkbox" checked={opts.emptyAsNull} onChange={(e) => setOpts({ ...opts, emptyAsNull: e.target.checked })} /> {t('imp.emptyNull')}</label>
                <label className="radio"><input type="checkbox" checked={opts.decimalComma} onChange={(e) => setOpts({ ...opts, decimalComma: e.target.checked })} /> {t('imp.decimalComma')}</label>
                <label className="field-inline">{t('imp.dateOrder')}
                  <select value={opts.dateOrder} onChange={(e) => setOpts({ ...opts, dateOrder: e.target.value })}>
                    <option value="dmy">dd/mm/aaaa</option><option value="mdy">mm/dd/aaaa</option>
                  </select>
                </label>
              </div>
            </section>
          )}

          {file && mapping.length > 0 && (
            <section>
              <div className="sec-title">3 · {t('imp.columns')}</div>
              <div className="map-wrap">
                <table className="grid admin-table map-table">
                  <thead><tr><th>{t('imp.fileCol')}</th><th>{t('imp.sample')}</th><th>→ {target === 'new' ? t('imp.newCol') : t('imp.tableCol')}</th>{target === 'new' && <th>{t('imp.type')}</th>}</tr></thead>
                  <tbody>
                    {mapping.map((m, i) => (
                      <tr key={i}>
                        <td><b>{header ? String(matrix[0]?.[i] ?? '') : `#${i + 1}`}</b></td>
                        <td className="count sample">{dataRows.slice(0, 3).map((r) => (r[i] instanceof Date ? r[i].toISOString().slice(0, 10) : String(r[i] ?? ''))).join(' · ')}</td>
                        <td>
                          {target === 'new' ? (
                            <input value={m.name} onChange={(e) => setMap(i, { name: e.target.value })} />
                          ) : (
                            <select value={m.target} onChange={(e) => setMap(i, { target: e.target.value })}>
                              <option value="">{t('imp.skip')}</option>
                              {tableCols.map((c) => <option key={c.name} value={c.name}>{c.name} ({c.type})</option>)}
                            </select>
                          )}
                        </td>
                        {target === 'new' && (
                          <td>
                            <input list="imp-types" value={m.type} onChange={(e) => setMap(i, { type: e.target.value.toUpperCase() })} className="type-input" />
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
                <datalist id="imp-types">{TYPES.map((x) => <option key={x} value={x} />)}</datalist>
              </div>
              {dupTargets.length > 0 && <div className="err-text">{t('imp.dupCols', { cols: [...new Set(dupTargets)].join(', ') })}</div>}
            </section>
          )}

          {file && plan.length > 0 && (
            <section>
              <div className="sec-title">4 · {t('imp.preview', { n: preview.length, total: dataRows.length.toLocaleString() })}</div>
              <div className="map-wrap">
                <table className="grid admin-table preview-table">
                  <thead><tr>{plan.map((p) => <th key={p[1]}>{p[1]}<div className="count">{p[2]}</div></th>)}</tr></thead>
                  <tbody>{preview.map((r, k) => <tr key={k}>{convert(r).map((v, j) => <td key={j} className={v === null ? 'null' : ''}>{v === null ? '(NULL)' : String(v)}</td>)}</tr>)}</tbody>
                </table>
              </div>
            </section>
          )}

          {sqlPreview && <pre className="ddl sql-preview">{sqlPreview.join(';\n\n')};</pre>}
          {progress && (
            <div className="note">
              <div className="progress big"><div style={{ width: `${(progress.done / progress.total) * 100}%` }} /><span>{progress.done.toLocaleString()} / {progress.total.toLocaleString()}</span></div>
              {progress.finished && <div className="ok-text">✔ {t('imp.finished', { n: progress.affected.toLocaleString(), w: progress.warnings || 0 })}</div>}
              {progress.cancelled && <div className="warn-text">{t('imp.cancelled', { n: progress.done.toLocaleString() })}</div>}
              {progress.error && <div className="err-text">✖ {t('imp.failed', { n: progress.done.toLocaleString() })}: {progress.error}</div>}
            </div>
          )}
        </div>
        <div className="actions">
          <button onClick={showSql} disabled={!ready || running}>{t('imp.showSql')}</button>
          <span style={{ flex: 1 }} />
          {running
            ? <button onClick={() => { cancelRef.current = true; }}>{t('conn.cancel')}</button>
            : <button onClick={onClose}>{progress?.finished ? t('grid.close') : t('conn.cancel')}</button>}
          {!progress?.finished && (
            <button className="primary" disabled={!ready || running} onClick={run}>
              {t('imp.run', { n: dataRows.length.toLocaleString() })}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
