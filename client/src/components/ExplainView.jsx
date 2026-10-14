import React from 'react';
import { useI18n } from '../i18n.jsx';

// Visual EXPLAIN: the classic plan table with each access type rated
// (good / ok / bad), a bar for the estimated rows and plain-language tips —
// e.g. full table scans, filesort, temporary tables, unused indexes.
const TYPE_RATING = {
  system: 'good', const: 'good', eq_ref: 'good', ref: 'good', fulltext: 'good',
  ref_or_null: 'ok', index_merge: 'ok', unique_subquery: 'ok', index_subquery: 'ok', range: 'ok',
  index: 'warn', ALL: 'bad',
};

export default function ExplainView({ plan }) {
  const { t } = useI18n();
  const cols = plan.columns.map((c) => c.name.toLowerCase());
  const get = (row, name) => { const i = cols.indexOf(name); return i < 0 ? null : row[i]; };
  const rows = plan.rows.map((r) => ({
    id: get(r, 'id'), selectType: get(r, 'select_type'), table: get(r, 'table'), type: get(r, 'type'),
    possibleKeys: get(r, 'possible_keys'), key: get(r, 'key'), keyLen: get(r, 'key_len'), ref: get(r, 'ref'),
    rows: Number(get(r, 'rows')) || 0, filtered: get(r, 'filtered'), extra: get(r, 'extra') || '',
  }));
  const maxRows = Math.max(1, ...rows.map((r) => r.rows));

  const tips = [];
  for (const r of rows) {
    const tb = r.table || '?';
    if (r.type === 'ALL' && r.rows > 100) tips.push({ level: 'bad', text: t('explain.tipFullScan', { table: tb, rows: r.rows.toLocaleString() }) });
    if (r.type === 'index' && r.rows > 1000) tips.push({ level: 'warn', text: t('explain.tipIndexScan', { table: tb }) });
    if (r.possibleKeys && !r.key) tips.push({ level: 'warn', text: t('explain.tipUnusedKey', { table: tb, keys: r.possibleKeys }) });
    if (/filesort/i.test(r.extra)) tips.push({ level: 'warn', text: t('explain.tipFilesort', { table: tb }) });
    if (/temporary/i.test(r.extra)) tips.push({ level: 'warn', text: t('explain.tipTemporary', { table: tb }) });
    if (/join buffer/i.test(r.extra)) tips.push({ level: 'warn', text: t('explain.tipJoinBuffer', { table: tb }) });
  }

  return (
    <div className="explain">
      <div className="explain-sql"><b>EXPLAIN</b> {plan.sql}</div>
      <table className="grid explain-table">
        <thead>
          <tr>
            <th>id</th><th>select_type</th><th>{t('explain.table')}</th><th>{t('explain.access')}</th>
            <th>{t('explain.indexUsed')}</th><th>possible_keys</th><th>ref</th><th>{t('explain.rows')}</th><th>Extra</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const rating = TYPE_RATING[r.type] || 'ok';
            return (
              <tr key={i}>
                <td>{r.id ?? ''}</td>
                <td>{r.selectType}</td>
                <td><b>{r.table}</b></td>
                <td><span className={'plan-type ' + rating} title={t('explain.type_' + rating)}>{r.type ?? '—'}</span></td>
                <td>{r.key ? <code>{r.key}</code> : <span className="count">{t('explain.none')}</span>}{r.keyLen ? <span className="count"> ({r.keyLen})</span> : null}</td>
                <td className="count">{r.possibleKeys || '—'}</td>
                <td className="count">{r.ref || '—'}</td>
                <td>
                  <div className="plan-rows">
                    <div className={'plan-bar ' + rating} style={{ width: `${Math.max(3, (Math.log10(r.rows + 1) / Math.log10(maxRows + 1)) * 100)}%` }} />
                    <span>{r.rows.toLocaleString()}{r.filtered != null && r.filtered !== '' ? ` · ${Number(r.filtered).toFixed(0)}%` : ''}</span>
                  </div>
                </td>
                <td className={/filesort|temporary/i.test(r.extra) ? 'plan-extra-warn' : ''}>{r.extra}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="plan-tips">
        {tips.length === 0
          ? <div className="tip good">✔ {t('explain.allGood')}</div>
          : tips.map((tip, i) => <div key={i} className={'tip ' + tip.level}>{tip.level === 'bad' ? '✖' : '⚠'} {tip.text}</div>)}
      </div>
      <div className="count">{t('explain.legend')}</div>
    </div>
  );
}
