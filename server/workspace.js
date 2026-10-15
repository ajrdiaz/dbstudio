// Local persistence for saved queries, query history and the open-tabs
// workspace. All three live as JSON files in the data folder (~/.dbstudio by
// default, or a OneDrive / Google Drive folder — see paths.js), acting like a
// single-user "local account" that survives browser reloads and restarts.
import { readFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dataFile, writeFileAtomic } from './paths.js';

// File names, resolved against the (changeable) data folder on each access.
const QUERIES = 'queries.json';
const QUERY_FOLDERS = 'query-folders.json'; // folders that may still be empty
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
    folder: normFolder(data.folder),
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
  const prev = list[idx];
  const next = {
    ...prev,
    name: data.name ?? prev.name,
    sql: data.sql ?? prev.sql,
    database: data.database ?? prev.database,
    folder: data.folder !== undefined ? normFolder(data.folder) : (prev.folder || ''),
  };
  // Moving to another folder doesn't count as an edit.
  const edited = next.name !== prev.name || next.sql !== prev.sql || next.database !== prev.database;
  list[idx] = { ...next, updatedAt: edited ? new Date().toISOString() : prev.updatedAt };
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

// ---------- Saved query folders ----------
// A query's folder is a path like "Reportes/Ventas" ('' = root). Folders
// exist while they hold queries; query-folders.json also keeps empty ones.
export function normFolder(f) {
  return String(f || '').split('/').map((x) => x.trim()).filter(Boolean).join('/');
}
const inFolder = (path, folder) => path === folder || path.startsWith(folder + '/');

export function listQueryFolders() {
  const set = new Set();
  const add = (p) => { const parts = normFolder(p).split('/').filter(Boolean); for (let i = 1; i <= parts.length; i++) set.add(parts.slice(0, i).join('/')); };
  readJson(QUERY_FOLDERS, []).forEach(add);
  readJson(QUERIES, []).forEach((q) => add(q.folder));
  return [...set].sort((a, b) => a.localeCompare(b));
}
export function createQueryFolder(path) {
  const p = normFolder(path);
  if (!p) throw new Error('Nombre de carpeta vacío');
  const list = readJson(QUERY_FOLDERS, []);
  if (!list.includes(p)) { list.push(p); writeJson(QUERY_FOLDERS, list); }
  return listQueryFolders();
}
// Rename or move a folder (with its subfolders and queries): "A/B" -> "C/B".
export function renameQueryFolder(from, to) {
  const f = normFolder(from); const t = normFolder(to);
  if (!f) throw new Error('Carpeta no válida');
  if (t && inFolder(t, f)) throw new Error('No se puede mover una carpeta dentro de sí misma');
  const move = (p) => (inFolder(p, f) ? normFolder(t + p.slice(f.length)) : p);
  writeJson(QUERIES, readJson(QUERIES, []).map((q) => ({ ...q, folder: move(normFolder(q.folder)) })));
  writeJson(QUERY_FOLDERS, [...new Set(readJson(QUERY_FOLDERS, []).map((p) => move(normFolder(p))).filter(Boolean))]);
  return listQueryFolders();
}
// Delete a folder: its queries and subfolders move up one level (never deleted).
export function deleteQueryFolder(path) {
  const f = normFolder(path);
  if (!f) throw new Error('Carpeta no válida');
  const parent = f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '';
  writeJson(QUERY_FOLDERS, readJson(QUERY_FOLDERS, []).filter((p) => normFolder(p) !== f));
  return renameQueryFolder(f, parent);
}
