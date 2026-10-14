import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useI18n } from '../i18n.jsx';
import { guardWrite } from '../lib/env.jsx';

const TYPES = [
  'INT', 'BIGINT', 'TINYINT', 'SMALLINT', 'MEDIUMINT', 'DECIMAL', 'FLOAT', 'DOUBLE',
  'VARCHAR', 'CHAR', 'TEXT', 'MEDIUMTEXT', 'LONGTEXT', 'DATE', 'DATETIME', 'TIMESTAMP',
  'TIME', 'YEAR', 'BOOLEAN', 'JSON', 'BLOB', 'ENUM', 'SET',
];

let uid = 1;
const newCol = (over = {}) => ({
  key: 'c' + uid++, origName: null, name: '', type: 'INT', length: '', unsigned: false,
  nullable: true, default: '', autoIncrement: false, comment: '', primaryKey: false,
  dirty: true, ...over,
});

// Parse a MySQL column_type like "int(10) unsigned" / "decimal(10,2)" / "varchar(100)".
function parseType(ct) {
  const m = /^(\w+)(?:\(([^)]*)\))?\s*(unsigned)?/i.exec(ct || '');
  return {
    type: (m?.[1] || 'VARCHAR').toUpperCase(),
    length: m?.[2] || '',
    unsigned: !!m?.[3],
  };
}

// Visual table designer. With `table` set it alters an existing table; otherwise
// it creates a new one.
export default function TableDesigner({ connId, db, table, onDone, toast }) {
  const { t } = useI18n();
  const isAlter = !!table;
  const [name, setName] = useState(table || '');
  const [cols, setCols] = useState(isAlter ? [] : [newCol({ name: 'id', type: 'INT', nullable: false, autoIncrement: true, primaryKey: true })]);
  const [engine, setEngine] = useState('InnoDB');
  const [charset, setCharset] = useState('utf8mb4');
  const [origPk, setOrigPk] = useState([]);
  const [origNames, setOrigNames] = useState([]);
  const [preview, setPreview] = useState('');
  const [loading, setLoading] = useState(isAlter);

  useEffect(() => {
    if (!isAlter) return;
    api.structure(connId, db, table).then((s) => {
      const pk = s.columns.filter((c) => c.keyType === 'PRI').map((c) => c.name);
      setOrigPk(pk);
      setOrigNames(s.columns.map((c) => c.name));
      setCols(s.columns.map((c) => {
        const pt = parseType(c.type);
        return {
          key: 'c' + uid++, origName: c.name, name: c.name, type: pt.type, length: pt.length,
          unsigned: pt.unsigned, nullable: c.nullable === 'YES',
          default: c.defaultValue == null ? '' : String(c.defaultValue),
          autoIncrement: /auto_increment/i.test(c.extra || ''),
          comment: c.comment || '', primaryKey: pk.includes(c.name), dirty: false,
        };
      }));
      setLoading(false);
    }).catch((e) => { toast(e.message, 'err'); setLoading(false); });
  }, [connId, db, table, isAlter]);

  function patch(key, field, value) {
    setCols((list) => list.map((c) => (c.key === key ? { ...c, [field]: value, dirty: true } : c)));
  }
  function addCol() { setCols((l) => [...l, newCol()]); }
  function removeCol(key) { setCols((l) => l.filter((c) => c.key !== key)); }
  function move(key, dir) {
    setCols((l) => {
      const i = l.findIndex((c) => c.key === key);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= l.length) return l;
      const copy = [...l];
      [copy[i], copy[j]] = [copy[j], copy[i]];
      return copy;
    });
  }

  function toSpec(c) {
    return {
      name: c.name, type: c.type, length: c.length, unsigned: c.unsigned,
      nullable: c.nullable, default: c.default, autoIncrement: c.autoIncrement, comment: c.comment,
    };
  }

  function buildPayload() {
    const primaryKey = cols.filter((c) => c.primaryKey).map((c) => c.name);
    if (!isAlter) {
      return { name, columns: cols.map(toSpec), primaryKey, engine, charset };
    }
    const currentOrig = new Set(cols.filter((c) => c.origName).map((c) => c.origName));
    const adds = cols.filter((c) => !c.origName).map(toSpec);
    const changes = cols
      .filter((c) => c.origName && (c.dirty || c.origName !== c.name))
      .map((c) => ({ origName: c.origName, col: toSpec(c) }));
    const drops = origNames.filter((n) => !currentOrig.has(n));
    return { adds, changes, drops, primaryKey, originalPrimaryKey: origPk, rename: name };
  }

  async function doPreview() {
    try {
      const payload = { ...buildPayload(), preview: true };
      const r = isAlter
        ? await api.alterTable(connId, db, table, payload)
        : await api.createTable(connId, db, payload);
      setPreview(r.sql || '(no changes)');
    } catch (e) { toast(e.message, 'err'); }
  }

  async function doSave() {
    try {
      const payload = buildPayload();
      const pv = isAlter
        ? await api.alterTable(connId, db, table, { ...payload, preview: true })
        : await api.createTable(connId, db, { ...payload, preview: true });
      if (pv.sql && !(await guardWrite(connId, { statements: [pv.sql] }))) return;
      const r = isAlter
        ? await api.alterTable(connId, db, table, payload)
        : await api.createTable(connId, db, payload);
      toast(isAlter ? t('designer.altered') : t('designer.created'), 'ok');
      setPreview(r.sql || '');
      onDone?.();
    } catch (e) { toast(e.message, 'err'); }
  }

  if (loading) return <div className="empty">{t('designer.loading')}</div>;

  return (
    <div className="tabview">
      <div className="data-toolbar">
        <strong>{isAlter ? t('designer.alter') : t('designer.create')}</strong>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('designer.tableName')} style={{ width: 180 }} />
        {!isAlter && (
          <>
            <label className="count">{t('designer.engine')}</label>
            <input value={engine} onChange={(e) => setEngine(e.target.value)} style={{ width: 90 }} />
            <label className="count">{t('designer.charset')}</label>
            <input value={charset} onChange={(e) => setCharset(e.target.value)} style={{ width: 90 }} />
          </>
        )}
        <span style={{ flex: 1 }} />
        <button onClick={addCol}>{t('designer.addColumn')}</button>
        <button onClick={doPreview}>{t('designer.preview')}</button>
        <button className="primary" onClick={doSave}>{isAlter ? t('designer.applyBtn') : t('designer.createBtn')}</button>
      </div>
      <div className="results-pane">
        <table className="grid designer">
          <thead>
            <tr>
              <th></th><th>PK</th><th>{t('designer.colName')}</th><th>{t('designer.colType')}</th><th>{t('designer.colLength')}</th>
              <th>{t('designer.colUnsigned')}</th><th>{t('designer.colNull')}</th><th>{t('designer.colDefault')}</th><th>{t('designer.colAI')}</th><th>{t('designer.colComment')}</th><th></th>
            </tr>
          </thead>
          <tbody>
            {cols.map((c) => (
              <tr key={c.key}>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <button className="mini" onClick={() => move(c.key, -1)}>▲</button>
                  <button className="mini" onClick={() => move(c.key, 1)}>▼</button>
                </td>
                <td style={{ textAlign: 'center' }}><input type="checkbox" checked={c.primaryKey} onChange={(e) => patch(c.key, 'primaryKey', e.target.checked)} /></td>
                <td><input value={c.name} onChange={(e) => patch(c.key, 'name', e.target.value)} style={{ width: 130 }} /></td>
                <td>
                  <input list="dbstudio-types" value={c.type} onChange={(e) => patch(c.key, 'type', e.target.value.toUpperCase())} style={{ width: 110 }} />
                </td>
                <td><input value={c.length} onChange={(e) => patch(c.key, 'length', e.target.value)} style={{ width: 60 }} placeholder="—" /></td>
                <td style={{ textAlign: 'center' }}><input type="checkbox" checked={c.unsigned} onChange={(e) => patch(c.key, 'unsigned', e.target.checked)} /></td>
                <td style={{ textAlign: 'center' }}><input type="checkbox" checked={c.nullable} onChange={(e) => patch(c.key, 'nullable', e.target.checked)} /></td>
                <td><input value={c.default} onChange={(e) => patch(c.key, 'default', e.target.value)} style={{ width: 110 }} placeholder="—" /></td>
                <td style={{ textAlign: 'center' }}><input type="checkbox" checked={c.autoIncrement} onChange={(e) => patch(c.key, 'autoIncrement', e.target.checked)} /></td>
                <td><input value={c.comment} onChange={(e) => patch(c.key, 'comment', e.target.value)} style={{ width: 130 }} /></td>
                <td><button className="mini danger" onClick={() => removeCol(c.key)}>✕</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        <datalist id="dbstudio-types">
          {TYPES.map((t) => <option key={t} value={t} />)}
        </datalist>
        {preview && <pre className="ddl" style={{ margin: 8 }}>{preview}</pre>}
      </div>
    </div>
  );
}
