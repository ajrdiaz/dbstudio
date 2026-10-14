// Local persistence for saved queries, query history and the open-tabs
// workspace. All three live as JSON files in the data folder (~/.dbstudio by
// default, or a OneDrive / Google Drive folder — see paths.js), acting like a
// single-user "local account" that survives browser reloads and restarts.
import { readFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dataFile, writeFileAtomic } from './paths.js';

// File names, resolved against the (changeable) data folder on each access.
const QUERIES = 'queries.json';
const HISTORY = 'history.json';
const WORKSPACE = 'workspace.json';
const HISTORY_CAP = 500;

function readJson(name, fallback) {
  const file = dataFile(name);
  if (!existsSync(file)) return fallback;
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(name, data) {
  writeFileAtomic(dataFile(name), JSON.stringify(data, null, 2));
}

// ---------- Saved queries (favorites) ----------
export function listQueries() {
  return readJson(QUERIES, []).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}
export function createQuery(data) {
  const list = readJson(QUERIES, []);
  const q = {
    id: randomUUID(),
    name: data.name || 'Untitled query',
    sql: data.sql || '',
    connectionId: data.connectionId || null,
    database: data.database || '',
    updatedAt: new Date().toISOString(),
  };
  list.push(q);
  writeJson(QUERIES, list);
  return q;
}
export function updateQuery(id, data) {
  const list = readJson(QUERIES, []);
  const idx = list.findIndex((x) => x.id === id);
  if (idx === -1) return null;
  list[idx] = {
    ...list[idx],
    name: data.name ?? list[idx].name,
    sql: data.sql ?? list[idx].sql,
    database: data.database ?? list[idx].database,
    updatedAt: new Date().toISOString(),
  };
  writeJson(QUERIES, list);
  return list[idx];
}
export function deleteQuery(id) {
  const list = readJson(QUERIES, []);
  const next = list.filter((x) => x.id !== id);
  writeJson(QUERIES, next);
  return next.length !== list.length;
}

// ---------- Query history (auto-recorded) ----------
export function addHistory(entry) {
  const list = readJson(HISTORY, []);
  list.unshift({
    id: randomUUID(),
    at: new Date().toISOString(),
    sql: entry.sql,
    connectionId: entry.connectionId || null,
    database: entry.database || '',
    ok: !!entry.ok,
    summary: entry.summary || '',
    elapsedMs: entry.elapsedMs ?? null,
  });
  writeJson(HISTORY, list.slice(0, HISTORY_CAP));
}
export function listHistory(limit = 200) {
  return readJson(HISTORY, []).slice(0, limit);
}
export function clearHistory() {
  writeJson(HISTORY, []);
  return true;
}

// ---------- Workspace (open tabs) ----------
export function getWorkspace() {
  return readJson(WORKSPACE, { tabs: [], activeTab: null });
}
export function saveWorkspace(ws) {
  writeJson(WORKSPACE, { tabs: ws.tabs || [], activeTab: ws.activeTab ?? null });
  return true;
}
