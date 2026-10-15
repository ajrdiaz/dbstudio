import React, { useEffect, useState } from 'react';
import { useI18n } from '../i18n.jsx';

// In-app replacement for window.prompt(), which Electron doesn't support.
//   const name = await askText({ title, label, value });            // null if cancelled
//   const r = await askText({ title, label, value, choice: { label, value, options: [{ value, label }] } });
//     -> { text, choice } (or null)
//   const v = await askChoice({ title, label, value, options });      // value or null
let host = null;

export function askText(opts) {
  if (!host) {
    const text = window.prompt(opts.label || opts.title || '', opts.value || '');
    return Promise.resolve(opts.choice ? (text == null ? null : { text, choice: opts.choice.value }) : text);
  }
  return host(opts);
}

export function askChoice({ title, label, value, options }) {
  if (!host) return Promise.resolve(value);
  return host({ title, noText: true, choice: { label, value, options } }).then((r) => (r ? r.choice : null));
}

export function PromptHost() {
  const { t } = useI18n();
  const [req, setReq] = useState(null);
  const [value, setValue] = useState('');
  const [choice, setChoice] = useState('');
  useEffect(() => {
    host = (o) => new Promise((resolve) => {
      setValue(o.value || '');
      setChoice(o.choice?.value ?? '');
      setReq({ ...o, resolve });
    });
    return () => { host = null; };
  }, []);
  if (!req) return null;
  const done = (ok) => {
    req.resolve(!ok ? null : req.choice ? { text: value, choice } : value);
    setReq(null);
  };
  const keys = (e) => { if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); };
  return (
    <div className="modal-backdrop confirm-layer" onMouseDown={(e) => e.target === e.currentTarget && done(false)}>
      <div className="modal">
        <h3>{req.title}</h3>
        <div className="content">
          {!req.noText && (
            <>
              {req.label && <label className="count">{req.label}</label>}
              <input autoFocus value={value} onChange={(e) => setValue(e.target.value)}
                onFocus={(e) => e.target.select()} onKeyDown={keys} />
            </>
          )}
          {req.choice && (
            <>
              {req.choice.label && <label className="count">{req.choice.label}</label>}
              <select autoFocus={req.noText} value={choice} onChange={(e) => setChoice(e.target.value)} onKeyDown={keys}>
                {req.choice.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </>
          )}
        </div>
        <div className="actions">
          <button onClick={() => done(false)}>{t('conn.cancel')}</button>
          <button className="primary" onClick={() => done(true)}>{t('grid.apply')}</button>
        </div>
      </div>
    </div>
  );
}
