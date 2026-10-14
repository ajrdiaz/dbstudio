import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useI18n } from '../i18n.jsx';

// Read-only structure viewer: columns, indexes, foreign keys and the CREATE DDL.
export default function StructureTab({ connId, db, table, view: savedView, onViewChange, toast }) {
  const { t } = useI18n();
  const [data, setData] = useState(null);
  const [tab, setTabState] = useState(savedView || 'columns');
  const setTab = (v) => { setTabState(v); onViewChange?.(v); };

  useEffect(() => {
    api.structure(connId, db, table)
      .then(setData)
      .catch((e) => toast(e.message, 'err'));
  }, [connId, db, table, toast]);

  if (!data) return <div className="empty">{t('struct.loading')}</div>;

  const tabLabels = {
    columns: t('struct.columns'), indexes: t('struct.indexes'),
    foreignKeys: t('struct.foreignKeys'), ddl: t('struct.ddl'),
  };

  return (
    <div className="tabview">
      <div className="structure-tabs">
        {['columns', 'indexes', 'foreignKeys', 'ddl'].map((key) => (
          <button key={key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>
            {tabLabels[key]}
          </button>
        ))}
      </div>
      <div className="structure-body">
        {tab === 'columns' && (
          <table className="grid">
            <thead><tr><th>#</th><th>{t('struct.name')}</th><th>{t('struct.type')}</th><th>{t('struct.null')}</th><th>{t('struct.key')}</th><th>{t('struct.default')}</th><th>{t('struct.extra')}</th><th>{t('struct.comment')}</th></tr></thead>
            <tbody>
              {data.columns.map((c) => (
                <tr key={c.name}>
                  <td>{c.position}</td><td>{c.name}</td><td>{c.type}</td>
                  <td>{c.nullable}</td><td>{c.keyType}</td>
                  <td className={c.defaultValue == null ? 'null' : ''}>{c.defaultValue == null ? '(NULL)' : String(c.defaultValue)}</td>
                  <td>{c.extra}</td><td>{c.comment}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {tab === 'indexes' && (
          <table className="grid">
            <thead><tr><th>{t('struct.name')}</th><th>{t('struct.unique')}</th><th>{t('struct.type')}</th><th>{t('struct.columnsCol')}</th></tr></thead>
            <tbody>
              {data.indexes.map((i) => (
                <tr key={i.name}><td>{i.name}</td><td>{i.unique ? 'YES' : ''}</td><td>{i.type}</td><td>{i.columns.join(', ')}</td></tr>
              ))}
              {data.indexes.length === 0 && <tr><td colSpan={4} className="empty">{t('struct.noIndexes')}</td></tr>}
            </tbody>
          </table>
        )}
        {tab === 'foreignKeys' && (
          <table className="grid">
            <thead><tr><th>{t('struct.name')}</th><th>{t('struct.column')}</th><th>{t('struct.references')}</th><th>{t('struct.onUpdate')}</th><th>{t('struct.onDelete')}</th></tr></thead>
            <tbody>
              {data.foreignKeys.map((f, i) => (
                <tr key={i}><td>{f.name}</td><td>{f.columnName}</td><td>{f.refTable}.{f.refColumn}</td><td>{f.onUpdate}</td><td>{f.onDelete}</td></tr>
              ))}
              {data.foreignKeys.length === 0 && <tr><td colSpan={5} className="empty">{t('struct.noForeignKeys')}</td></tr>}
            </tbody>
          </table>
        )}
        {tab === 'ddl' && <pre className="ddl">{data.ddl}</pre>}
      </div>
    </div>
  );
}
