import React, { useEffect, useState } from 'react';
import { useI18n } from '../i18n.jsx';

// In-app replacement for window.prompt(), which Electron doesn't support.
// Usage: const name = await askText({ title, label, value }); // null if cancelled
let host = null;

export function askText(opts) {
  if (!host) return Promise.resolve(window.prompt(opts.label || opts.title || '', opts.value || ''));
  return host(opts);
}

export function PromptHost() {
  const { t } = useI18n();
  const [req, setReq] = useState(null);
  const [value, setValue] = useState('');
  useEffect(() => {
    host = (o) => new Promise((resolve) => { setValue(o.value || ''); setReq({ ...o, resolve }); });
    return () => { host = null; };
  }, []);
  if (!req) return null;
  const done = (v) => { req.resolve(v); setReq(null); };
  return (
    <div className="modal-backdrop confirm-layer" onMouseDown={(e) => e.target === e.currentTarget && done(null)}>
      <div className="modal">
        <h3>{req.title}</h3>
        <div className="content">
          {req.label && <label className="count">{req.label}</label>}
          <input autoFocus value={value} onChange={(e) => setValue(e.target.value)}
            onFocus={(e) => e.target.select()}
            onKeyDown={(e) => { if (e.key === 'Enter') done(value); if (e.key === 'Escape') done(null); }} />
        </div>
        <div className="actions">
          <button onClick={() => done(null)}>{t('conn.cancel')}</button>
          <button className="primary" onClick={() => done(value)}>{t('grid.apply')}</button>
        </div>
      </div>
    </div>
  );
}
