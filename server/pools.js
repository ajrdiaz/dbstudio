// Live connection-pool manager. One mysql2 pool per saved-connection id, lazily
// created and cached so repeated requests reuse sockets.
import mysql from 'mysql2/promise';
import { getConnectionRaw } from './store.js';
import { ensureTunnel, openTunnel, closeTunnel, closeAllTunnels } from './tunnel.js';

const pools = new Map(); // id -> pool
const pending = new Map(); // id -> Promise<pool> while an SSH tunnel opens

export function buildConfig(raw) {
  const cfg = {
    host: raw.host,
    port: raw.port,
    user: raw.user,
    password: raw.password,
    waitForConnections: true,
    connectionLimit: 5,
    multipleStatements: true,
    dateStrings: true, // keep dates as strings so the grid round-trips them
    supportBigNumbers: true,
    bigNumberStrings: true,
    namedPlaceholders: false,
  };
  if (raw.database) cfg.database = raw.database;
  if (raw.ssl) cfg.ssl = { rejectUnauthorized: false };
  return cfg;
}

// Async because an SSH tunnel may have to be opened first; the pool then
// connects to the tunnel's local port. If the SSH session drops, the pool is
// discarded so the next request reconnects.
export async function getPool(id) {
  if (pools.has(id)) return pools.get(id);
  if (pending.has(id)) return pending.get(id);
  const raw = getConnectionRaw(id);
  if (!raw) throw new Error('Connection profile not found');
  const p = (async () => {
    let target = raw;
    if (raw.ssh?.enabled) {
      const t = await ensureTunnel(id, raw.ssh, raw.host, raw.port, () => { closePool(id); });
      target = { ...raw, host: '127.0.0.1', port: t.port };
    }
    const pool = mysql.createPool(buildConfig(target));
    pools.set(id, pool);
    return pool;
  })();
  pending.set(id, p);
  try { return await p; } finally { pending.delete(id); }
}

// Connection options for a dedicated (non-pooled) editor session, through the
// connection's SSH tunnel when it has one.
export async function sessionConfig(id) {
  const raw = getConnectionRaw(id);
  if (!raw) throw new Error('Connection profile not found');
  let target = raw;
  if (raw.ssh?.enabled) {
    const t = await ensureTunnel(id, raw.ssh, raw.host, raw.port, () => { closePool(id); });
    target = { ...raw, host: '127.0.0.1', port: t.port };
  }
  const { waitForConnections, connectionLimit, queueLimit, ...cfg } = buildConfig(target);
  return { ...cfg, connectTimeout: 15000 };
}

export async function closePool(id) {
  const pool = pools.get(id);
  if (pool) {
    pools.delete(id);
    await pool.end().catch(() => {});
  }
  await closeTunnel(id);
}

export async function closeAllPools() {
  const all = [...pools.values()];
  pools.clear();
  await Promise.all(all.map((p) => p.end().catch(() => {})));
  await closeAllTunnels();
}

// Ad-hoc connection used for a one-shot test without caching a pool.
export async function testConfig(raw) {
  let tunnel = null;
  let target = raw;
  if (raw.ssh?.enabled) {
    tunnel = await openTunnel(raw.ssh, raw.host, raw.port);
    target = { ...raw, host: '127.0.0.1', port: tunnel.port };
  }
  try {
    const conn = await mysql.createConnection({ ...buildConfig(target), connectTimeout: 10000 });
    try {
      const [rows] = await conn.query('SELECT VERSION() AS version');
      return { ok: true, version: rows[0].version, ssh: !!tunnel };
    } finally {
      await conn.end().catch(() => {});
    }
  } finally {
    tunnel?.close();
  }
}
