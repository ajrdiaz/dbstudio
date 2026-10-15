import React, { useEffect, useState } from 'react';
import { useI18n } from '../i18n.jsx';
import { isWriteStatement } from './sqlKind.js';

// Connection environments (like Navicat): a color + badge everywhere the
// connection appears, confirmation before writes and optional read-only mode.

export const ENVS = ['', 'development', 'testing', 'staging', 'production'];
export const ENV_SHORT = { development: 'DEV', testing: 'TEST', staging: 'STG', production: 'PROD' };

// Module-level registry of saved connections, kept current by App, so any
// component can look up a connection's environment by id.
let registry = new Map();
export function setConnectionRegistry(list) {
  registry = new Map(list.map((c) => [c.id, c]));
}
export const getConn = (id) => registry.get(id) || null;

// CSS color for a connection: custom color, else its environment's color.
export function envColor(conn) {
  if (!conn) return null;
  if (conn.color) return conn.color;
  return conn.env ? `var(--env-${conn.env})` : null;
}

// Text color for a custom hex background: white or near-black, whichever
// reads better (WCAG contrast). Theme colors (var(--env-*)) use white.
export function textOn(color) {
  const m = /^#([0-9a-f]{6})$/i.exec(color || '');
  if (!m) return undefined;
  const lum = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
    .reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i], 0);
  return 1.05 / (lum + 0.05) >= (lum + 0.05) / 0.0574 ? '#fff' : '#111318';
}

export function EnvBadge({ conn, small }) {
  const { t } = useI18n();
  if (!conn?.env && !conn?.readOnly) return null;
  return (
    <>
      {conn.env && (
        <span className={'env-badge' + (small ? ' small' : '')} style={{ background: envColor(conn), color: textOn(conn.color) }} title={t('env.' + conn.env)}>
          {ENV_SHORT[conn.env]}
        </span>
      )}
      {conn.readOnly && <span className={'env-badge ro' + (small ? ' small' : '')} title={t('env.readOnlyTitle')}>RO</span>}
    </>
  );
}

// Stripe above a tab's content; a labelled warning bar for staging/production.
export function EnvBanner({ connId }) {
  const { t } = useI18n();
  const conn = getConn(connId);
  const color = envColor(conn);
  if (!color && !conn?.readOnly) return null;
  const loud = conn.env === 'production' || conn.env === 'staging' || conn.readOnly;
  if (!loud) return <div className="env-stripe" style={{ background: color }} />;
  return (
    <div className={'env-banner' + (color ? '' : ' ro')} style={color ? { background: color, color: textOn(conn.color) } : undefined}>
      {conn.env === 'production' ? '⚠ ' : ''}{conn.env ? t('env.' + conn.env).toUpperCase() : ''}
      <span className="env-banner-name">{conn.name}</span>
      <span className="env-banner-hint">
        {conn.readOnly ? t('env.bannerReadOnly') : conn.confirmWrites ? t('env.bannerConfirm') : ''}
      </span>
    </div>
  );
}

// ---- write guard ----
let host = null; // set by <ConfirmHost/>

// Resolves true if the action may proceed. Asks for confirmation when the
// connection has "confirm writes" on (or `force`), and refuses on read-only
// connections. `statements` are shown in the dialog; `summary` describes
// non-SQL actions (e.g. a table copy).
export function guardWrite(connId, { statements = [], summary = '', force = false } = {}) {
  const conn = getConn(connId);
  const writes = statements.filter(isWriteStatement);
  const isWrite = writes.length > 0 || (!!summary && !statements.length);
  if (!isWrite) return Promise.resolve(true);
  if (conn?.readOnly) return host ? host({ conn, writes, summary, blocked: true }).then(() => false) : Promise.resolve(false);
  if (!force && !conn?.confirmWrites) return Promise.resolve(true);
  return host ? host({ conn, writes, summary }) : Promise.resolve(window.confirm(summary || writes.join(';\n')));
}

export function ConfirmHost() {
  const { t } = useI18n();
  const [req, setReq] = useState(null);
  useEffect(() => {
    host = (r) => new Promise((resolve) => setReq({ ...r, resolve }));
    return () => { host = null; };
  }, []);
  if (!req) return null;
  const { conn, writes, summary, blocked } = req;
  const done = (v) => { req.resolve(v); setReq(null); };
  const shown = writes.slice(0, 15);
  const color = envColor(conn) || 'var(--accent)';
  return (
    <div className="modal-backdrop confirm-layer" onMouseDown={(e) => e.target === e.currentTarget && done(false)}>
      <div className="modal wide env-confirm" style={{ borderTop: `6px solid ${color}` }}
        onKeyDown={(e) => { if (e.key === 'Escape') done(false); }}>
        <h3>
          {conn?.env === 'production' ? '⚠ ' : ''}
          {blocked ? t('env.blockedTitle') : t('env.confirmTitle')}
          {' '}<EnvBadge conn={conn} />
        </h3>
        <div className="content">
          <div>
            {blocked
              ? t('env.blockedText', { name: conn?.name || '' })
              : t('env.confirmText', { name: conn?.name || '', env: conn?.env ? t('env.' + conn.env) : t('env.none') })}
          </div>
          {summary && <div className="note">{summary}</div>}
          {shown.length > 0 && (
            <pre className="ddl sql-preview">{shown.map((s) => s.trim() + ';').join('\n')}{writes.length > shown.length ? `\n-- … ${t('env.andMore', { n: writes.length - shown.length })}` : ''}</pre>
          )}
        </div>
        <div className="actions">
          {blocked ? (
            <button className="primary" autoFocus onClick={() => done(false)}>{t('grid.close')}</button>
          ) : (
            <>
              <button autoFocus onClick={() => done(false)}>{t('conn.cancel')}</button>
              <button className={conn?.env === 'production' ? 'danger-solid' : 'primary'} onClick={() => done(true)}>
                {conn?.env === 'production' ? t('env.runInProd') : t('admin.run')}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// Error thrown when the user cancels at the guard; callers don't toast it.
export function cancelledError() {
  const e = new Error('cancelled');
  e.silent = true;
  return e;
}
