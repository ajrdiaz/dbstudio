// Persistence for saved connection profiles.
// Stored as connections.json in the data folder (see paths.js). Passwords are obfuscated (NOT
// strong encryption) so they are not sitting in plain text; treat this file as
// a secret regardless. This mirrors how desktop clients persist credentials.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomUUID, scryptSync, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { dataFile, keyFile, writeFileAtomic } from './paths.js';

// Paths are resolved on every call: the data folder can change at runtime.
const file = () => dataFile('connections.json');

const keyCache = new Map(); // secret -> derived key (scrypt is slow)
function getKey() {
  const kf = keyFile();
  if (!existsSync(kf)) {
    writeFileSync(kf, randomBytes(32).toString('hex'), { mode: 0o600 });
  }
  const secret = readFileSync(kf, 'utf8').trim();
  if (!keyCache.has(secret)) keyCache.set(secret, scryptSync(secret, 'dbstudio-salt', 32));
  return keyCache.get(secret);
}

export function encrypt(text) {
  if (text == null || text === '') return '';
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', getKey(), iv);
  const enc = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

export function decrypt(blob) {
  if (!blob) return '';
  try {
    const [ivh, tagh, dh] = String(blob).split(':');
    const decipher = createDecipheriv('aes-256-gcm', getKey(), Buffer.from(ivh, 'hex'));
    decipher.setAuthTag(Buffer.from(tagh, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(dh, 'hex')), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}

function readAll() {
  const f = file();
  if (!existsSync(f)) return [];
  try {
    return JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    return [];
  }
}

function writeAll(list) {
  writeFileAtomic(file(), JSON.stringify(list, null, 2));
}

const SSH_SECRETS = ['password', 'privateKey', 'passphrase'];

// Environment tag (like Navicat): drives colors in the UI, confirmation before
// writes and an optional server-enforced read-only mode.
const ENVS = ['', 'development', 'testing', 'staging', 'production'];
function envFrom(data, prev) {
  const env = ENVS.includes(data.env) ? data.env : (prev.env || '');
  return {
    env,
    confirmWrites: data.confirmWrites ?? prev.confirmWrites ?? env === 'production',
    readOnly: data.readOnly ?? prev.readOnly ?? false,
  };
}

// SSH settings from a create/update body. Secrets are encrypted; an empty or
// missing secret keeps the previous one (the UI never receives them back).
function sshFrom(data, prev) {
  if (!data) return prev || null;
  const p = prev || {};
  const out = {
    enabled: data.enabled ?? p.enabled ?? false,
    host: data.host ?? p.host ?? '',
    port: data.port != null && data.port !== '' ? Number(data.port) : (p.port || 22),
    user: data.user ?? p.user ?? '',
    auth: data.auth ?? p.auth ?? 'password',
  };
  for (const k of SSH_SECRETS) {
    out[k] = data[k] != null && data[k] !== '' ? encrypt(data[k]) : (p[k] || '');
  }
  return out;
}

function sshPublic(ssh) {
  if (!ssh) return null;
  const { password, privateKey, passphrase, ...rest } = ssh;
  return { ...rest, hasPassword: !!password, hasPrivateKey: !!privateKey, hasPassphrase: !!passphrase };
}

// Public shape never includes passwords or keys in clear.
function toPublic(c) {
  const { password, ssh, ...rest } = c;
  return { ...rest, hasPassword: !!password, ssh: sshPublic(ssh) };
}

export function listConnections() {
  return readAll().map(toPublic);
}

export function getConnectionRaw(id) {
  const c = readAll().find((x) => x.id === id);
  if (!c) return null;
  const ssh = c.ssh ? { ...c.ssh } : null;
  if (ssh) for (const k of SSH_SECRETS) ssh[k] = decrypt(ssh[k]);
  return { ...c, password: decrypt(c.password), ssh };
}

// A saved profile with unsaved form edits on top (for "Test" while editing):
// blank secrets fall back to the stored ones.
export function mergeForTest(id, body) {
  const raw = getConnectionRaw(id);
  if (!raw) return null;
  const out = { ...raw };
  for (const k of ['host', 'port', 'user', 'database', 'ssl']) if (body[k] !== undefined) out[k] = body[k];
  if (body.password) out.password = body.password;
  if (body.ssh) {
    out.ssh = { ...(raw.ssh || {}), ...body.ssh };
    for (const k of SSH_SECRETS) if (!body.ssh[k]) out.ssh[k] = raw.ssh?.[k] || '';
  }
  return out;
}

export function createConnection(data) {
  const list = readAll();
  const conn = {
    id: randomUUID(),
    name: data.name || 'New connection',
    host: data.host || '127.0.0.1',
    port: Number(data.port) || 3306,
    user: data.user || 'root',
    password: encrypt(data.password || ''),
    database: data.database || '',
    ssl: !!data.ssl,
    ssh: sshFrom(data.ssh, null),
    color: data.color || '',
    group: String(data.group || '').trim(),
    ...envFrom(data, {}),
    createdAt: new Date().toISOString(),
  };
  list.push(conn);
  writeAll(list);
  return toPublic(conn);
}

export function updateConnection(id, data) {
  const list = readAll();
  const idx = list.findIndex((x) => x.id === id);
  if (idx === -1) return null;
  const prev = list[idx];
  const next = {
    ...prev,
    name: data.name ?? prev.name,
    host: data.host ?? prev.host,
    port: data.port != null ? Number(data.port) : prev.port,
    user: data.user ?? prev.user,
    database: data.database ?? prev.database,
    ssl: data.ssl ?? prev.ssl,
    ssh: data.ssh ? sshFrom(data.ssh, prev.ssh) : (prev.ssh || null),
    color: data.color ?? prev.color,
    group: data.group != null ? String(data.group).trim() : (prev.group || ''),
    ...envFrom(data, prev),
  };
  // Only replace password when a new one is explicitly provided.
  if (data.password !== undefined && data.password !== null) {
    next.password = encrypt(data.password);
  }
  list[idx] = next;
  writeAll(list);
  return toPublic(next);
}

export function deleteConnection(id) {
  const list = readAll();
  const next = list.filter((x) => x.id !== id);
  writeAll(next);
  return next.length !== list.length;
}
