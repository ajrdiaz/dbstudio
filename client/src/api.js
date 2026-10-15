// Thin fetch wrapper around the backend API.
import { isConnError, setConnStatus } from './lib/connStatus.js';

const BASE = '/api';

async function req(path, opts = {}) {
  // Calls that talk to a connection's server (/connections/:id/...) update its health.
  const connId = /^\/connections\/([^/?]+)\/./.exec(path)?.[1];
  const res = await fetch(BASE + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const ct = res.headers.get('content-type') || '';
  if (connId && ct.includes('application/json')) {
    const j = await res.clone().json().catch(() => null);
    const code = res.ok ? j?.error?.code : j?.code;
    if (isConnError(code)) setConnStatus(connId, true, (res.ok ? j.error.message : j.error) || code);
    else if (res.ok) setConnStatus(connId, false);
  }
  if (!res.ok) {
    let msg = res.statusText;
    let code = null;
    if (ct.includes('application/json')) {
      const j = await res.json().catch(() => ({}));
      msg = j.error || msg;
      code = j.code || null;
    } else {
      const text = await res.text().catch(() => '');
      // Express's HTML 404 page means the API process predates this route.
      const missing = text.match(/Cannot (GET|POST|PUT|DELETE) ([^<\s]+)/);
      msg = missing
        ? `El servidor no reconoce ${missing[2]}: reinicia DBStudio (run.sh) para cargar la versión nueva.`
        : text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || msg;
    }
    const err = new Error(msg);
    err.code = code;
    throw err;
  }
  if (ct.includes('application/json')) return res.json();
  return res.text();
}

export const api = {
  // connections
  listConnections: () => req('/connections'),
  createConnection: (data) => req('/connections', { method: 'POST', body: data }),
  updateConnection: (id, data) => req(`/connections/${id}`, { method: 'PUT', body: data }),
  deleteConnection: (id) => req(`/connections/${id}`, { method: 'DELETE' }),
  testConnection: (data) => req('/connections/test', { method: 'POST', body: data }),

  // schema
  databases: (id) => req(`/connections/${id}/databases`),
  objects: (id, db) => req(`/connections/${id}/databases/${encodeURIComponent(db)}/objects`),
  structure: (id, db, table) =>
    req(`/connections/${id}/databases/${encodeURIComponent(db)}/tables/${encodeURIComponent(table)}/structure`),
  createDatabase: (id, body) => req(`/connections/${id}/databases`, { method: 'POST', body }),
  dropDatabase: (id, db) => req(`/connections/${id}/databases/${encodeURIComponent(db)}`, { method: 'DELETE' }),
  dropTable: (id, db, table) =>
    req(`/connections/${id}/databases/${encodeURIComponent(db)}/tables/${encodeURIComponent(table)}`, { method: 'DELETE' }),

  // data
  tableData: (id, db, table, params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return req(`/connections/${id}/databases/${encodeURIComponent(db)}/tables/${encodeURIComponent(table)}/data?${qs}`);
  },
  saveRows: (id, db, table, body) =>
    req(`/connections/${id}/databases/${encodeURIComponent(db)}/tables/${encodeURIComponent(table)}/rows`, {
      method: 'POST', body,
    }),

  // query
  query: (id, body) => req(`/connections/${id}/query`, { method: 'POST', body }),

  // export / import
  exportDump: (id, db, body) =>
    req(`/connections/${id}/databases/${encodeURIComponent(db)}/export`, { method: 'POST', body }),
  exportRows: (id, body) => req(`/connections/${id}/export-rows`, { method: 'POST', body }),
  importSql: (id, db, sql) =>
    req(`/connections/${id}/databases/${encodeURIComponent(db)}/import`, { method: 'POST', body: { sql } }),

  // saved queries (favorites)
  listQueries: () => req('/queries'),
  createQuery: (body) => req('/queries', { method: 'POST', body }),
  updateQuery: (qid, body) => req(`/queries/${qid}`, { method: 'PUT', body }),
  deleteQuery: (qid) => req(`/queries/${qid}`, { method: 'DELETE' }),
  listQueryFolders: () => req('/query-folders'),
  createQueryFolder: (path) => req('/query-folders', { method: 'POST', body: { path } }),
  renameQueryFolder: (from, to) => req('/query-folders/rename', { method: 'POST', body: { from, to } }),
  deleteQueryFolder: (path) => req('/query-folders/delete', { method: 'POST', body: { path } }),

  // history
  history: (limit = 200) => req(`/history?limit=${limit}`),
  clearHistory: () => req('/history', { method: 'DELETE' }),

  // schema compare / table copy
  tools: {
    compare: (body) => req('/tools/compare', { method: 'POST', body }),
    copy: (body) => req('/tools/copy', { method: 'POST', body }),
    job: (jid) => req(`/tools/jobs/${jid}`),
    cancel: (jid) => req(`/tools/jobs/${jid}/cancel`, { method: 'POST' }),
  },

  // per-database tools: table statistics / maintenance / ER model
  dbinfo: {
    stats: (id, db) => req(`/connections/${id}/databases/${encodeURIComponent(db)}/table-stats`),
    maintenance: (id, db, body) => req(`/connections/${id}/databases/${encodeURIComponent(db)}/maintenance`, { method: 'POST', body }),
    erd: (id, db) => req(`/connections/${id}/databases/${encodeURIComponent(db)}/erd`),
  },
  // CSV / Excel import, one batch of rows per call
  importRows: (id, db, body) => req(`/connections/${id}/databases/${encodeURIComponent(db)}/import-rows`, { method: 'POST', body }),

  // object search / DDL
  search: (id, params) => req(`/connections/${id}/search?${new URLSearchParams(params)}`),
  ddl: (id, db, kind, name) => req(`/connections/${id}/databases/${encodeURIComponent(db)}/ddl/${kind}/${encodeURIComponent(name)}`),

  // background monitor / alert rules
  monitor: {
    state: () => req('/monitor'),
    create: (rule) => req('/monitor/rules', { method: 'POST', body: rule }),
    update: (id, rule) => req(`/monitor/rules/${id}`, { method: 'PUT', body: rule }),
    remove: (id) => req(`/monitor/rules/${id}`, { method: 'DELETE' }),
    test: (id) => req(`/monitor/rules/${id}/test`, { method: 'POST' }),
    clearHistory: () => req('/monitor/history/clear', { method: 'POST' }),
  },

  // editor sessions (one dedicated connection per SQL tab)
  sessions: {
    open: (connId) => req(`/connections/${connId}/sessions`, { method: 'POST' }),
    close: (sid) => req(`/sessions/${sid}/close`, { method: 'POST' }),
    autocommit: (sid, on) => req(`/sessions/${sid}/autocommit`, { method: 'POST', body: { on } }),
    commit: (sid) => req(`/sessions/${sid}/commit`, { method: 'POST' }),
    rollback: (sid) => req(`/sessions/${sid}/rollback`, { method: 'POST' }),
    cancel: (sid) => req(`/sessions/${sid}/cancel`, { method: 'POST' }),
  },

  // server administration
  admin: {
    processes: (id) => req(`/connections/${id}/admin/processes`),
    kill: (id, pid, queryOnly) => req(`/connections/${id}/admin/processes/${encodeURIComponent(pid)}/kill`, { method: 'POST', body: { queryOnly } }),
    variables: (id, kind) => req(`/connections/${id}/admin/variables?kind=${kind}`),
    setVariable: (id, name, value) => req(`/connections/${id}/admin/variables`, { method: 'POST', body: { name, value } }),
    users: (id) => req(`/connections/${id}/admin/users`),
    replication: (id) => req(`/connections/${id}/admin/replication`),
    topQueries: (id, params) => req(`/connections/${id}/admin/top-queries?${new URLSearchParams(params)}`),
    resetTopQueries: (id, preview) => req(`/connections/${id}/admin/top-queries/reset`, { method: 'POST', body: { preview } }),
    // kind: grants | create | password | drop | grant | revoke
    userAction: (id, kind, body) => req(`/connections/${id}/admin/users/${kind}`, { method: 'POST', body }),
  },

  // data folder (local / OneDrive / Google Drive)
  getStorage: () => req('/settings/storage'),
  inspectStorage: (dir) => req('/settings/storage/inspect', { method: 'POST', body: { dir } }),
  setStorage: (body) => req('/settings/storage', { method: 'PUT', body }),

  // workspace (open tabs)
  getWorkspace: () => req('/workspace'),
  saveWorkspace: (body) => req('/workspace', { method: 'PUT', body }),

  // editor autocomplete
  schemaMap: (id, db) => req(`/connections/${id}/databases/${encodeURIComponent(db)}/schema-map`),

  // table designer
  createTable: (id, db, body) =>
    req(`/connections/${id}/databases/${encodeURIComponent(db)}/tables`, { method: 'POST', body }),
  alterTable: (id, db, table, body) =>
    req(`/connections/${id}/databases/${encodeURIComponent(db)}/tables/${encodeURIComponent(table)}/alter`, { method: 'POST', body }),
};
