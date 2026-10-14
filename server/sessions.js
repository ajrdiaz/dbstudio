// Editor sessions: each SQL tab gets its own dedicated connection (like SQLyog
// / pgAdmin), so manual transactions, session variables, temporary tables and
// USE survive between runs, and a running query can be cancelled with
// KILL QUERY <thread id> from another connection.
import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { sessionConfig } from './pools.js';

const IDLE_MS = 30 * 60 * 1000; // idle sessions are closed (open transactions roll back)
const sessions = new Map(); // sid -> { sid, connId, conn, threadId, autocommit, inTransaction, busy, lastUsed }

setInterval(() => {
  const now = Date.now();
  for (const s of sessions.values()) {
    if (!s.busy && now - s.lastUsed > IDLE_MS) closeSession(s.sid);
  }
}, 60 * 1000).unref();

export async function openSession(connId) {
  const cfg = await sessionConfig(connId);
  const conn = await mysql.createConnection(cfg);
  const s = {
    sid: randomUUID(), connId, conn, threadId: conn.threadId,
    autocommit: true, inTransaction: false, busy: false, lastUsed: Date.now(),
  };
  // A dropped connection (server restart, network, SSH) ends the session.
  conn.on('error', () => sessions.delete(s.sid));
  sessions.set(s.sid, s);
  return publicState(s);
}

export function publicState(s) {
  return { sid: s.sid, threadId: s.threadId, autocommit: s.autocommit, inTransaction: s.inTransaction };
}

export function getSession(sid, connId) {
  const s = sessions.get(sid);
  if (!s || (connId && s.connId !== connId)) {
    const e = new Error('La sesión del editor ya no existe (la conexión se cerró o expiró).');
    e.code = 'SESSION_GONE';
    throw e;
  }
  s.lastUsed = Date.now();
  return s;
}

// Reads the server's "transaction open" flag from an OK packet.
export async function refreshTxState(s) {
  try {
    const [r] = await s.conn.query('DO 0');
    s.inTransaction = !!(r.serverStatus & 1);
  } catch { /* leave as is */ }
  return s.inTransaction;
}

export async function closeSession(sid) {
  const s = sessions.get(sid);
  if (!s) return false;
  sessions.delete(sid);
  try { await s.conn.end(); } catch { s.conn.destroy(); }
  return true;
}

export function closeSessionsFor(connId) {
  for (const s of [...sessions.values()]) if (s.connId === connId) closeSession(s.sid);
}

export function registerSessions(app, { h, getPool }) {
  app.post('/api/connections/:id/sessions', h(async (req, res) => {
    res.json(await openSession(req.params.id));
  }));
  // POST variant so the page can close it with navigator.sendBeacon on unload.
  app.post('/api/sessions/:sid/close', h(async (req, res) => res.json({ ok: await closeSession(req.params.sid) })));
  app.delete('/api/sessions/:sid', h(async (req, res) => res.json({ ok: await closeSession(req.params.sid) })));

  app.post('/api/sessions/:sid/autocommit', h(async (req, res) => {
    const s = getSession(req.params.sid);
    const on = !!req.body?.on;
    await s.conn.query(`SET autocommit = ${on ? 1 : 0}`);
    s.autocommit = on;
    await refreshTxState(s);
    res.json(publicState(s));
  }));
  app.post('/api/sessions/:sid/commit', h(async (req, res) => {
    const s = getSession(req.params.sid);
    await s.conn.query('COMMIT');
    await refreshTxState(s);
    res.json(publicState(s));
  }));
  app.post('/api/sessions/:sid/rollback', h(async (req, res) => {
    const s = getSession(req.params.sid);
    await s.conn.query('ROLLBACK');
    await refreshTxState(s);
    res.json(publicState(s));
  }));
  // Cancel the statement running on this session from another connection.
  app.post('/api/sessions/:sid/cancel', h(async (req, res) => {
    const s = sessions.get(req.params.sid);
    if (!s || !s.busy) return res.json({ ok: false });
    const pool = await getPool(s.connId);
    await pool.query(`KILL QUERY ${Number(s.threadId)}`);
    res.json({ ok: true });
  }));
}
