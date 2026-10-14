// Background monitor: per-connection alert rules checked on an interval, with
// a firing / resolved state machine, a persisted history and an event stream
// (SSE for the browser UI, an EventEmitter for the desktop app's native
// notifications). All checks only READ from the servers.
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { dataFile, writeFileAtomic } from './paths.js';
import { replicationInfo } from './admin.js';

export const monitorEvents = new EventEmitter();
monitorEvents.setMaxListeners(50);

const RULES = 'alerts.json';
const HISTORY = 'alert-history.json';
const HISTORY_CAP = 300;
const TICK_MS = 5000;

export const RULE_TYPES = {
  replication: { lagSec: 60 },            // threads stopped / errors (critical), lag over lagSec (warning)
  down: { failures: 2 },                   // N failed checks in a row
  connections: { pct: 85 },               // Threads_connected >= pct% of max_connections
  longQuery: { seconds: 120 },            // a statement running longer than N seconds
  slowQueries: { perMin: 10 },            // Slow_queries rate per minute
};

const read = (name, fallback) => {
  const f = dataFile(name);
  if (!existsSync(f)) return fallback;
  try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return fallback; }
};
const write = (name, data) => writeFileAtomic(dataFile(name), JSON.stringify(data, null, 2));

export const listRules = () => read(RULES, []);
const saveRules = (rules) => write(RULES, rules);
export const listHistory = () => read(HISTORY, []);

function normalizeRule(data, prev = {}) {
  const type = data.type ?? prev.type;
  if (!RULE_TYPES[type]) throw new Error('Tipo de regla no válido');
  if (!(data.connId ?? prev.connId)) throw new Error('Falta la conexión');
  return {
    id: prev.id || randomUUID(),
    connId: data.connId ?? prev.connId,
    type,
    enabled: data.enabled ?? prev.enabled ?? true,
    params: { ...RULE_TYPES[type], ...(prev.params || {}), ...(data.params || {}) },
    intervalSec: Math.max(10, Number(data.intervalSec ?? prev.intervalSec ?? 30)),
    repeatMin: Math.max(0, Number(data.repeatMin ?? prev.repeatMin ?? 60)),
  };
}

export function createRule(data) {
  const rules = listRules();
  const r = normalizeRule(data);
  rules.push(r);
  saveRules(rules);
  return r;
}
export function updateRule(id, data) {
  const rules = listRules();
  const i = rules.findIndex((x) => x.id === id);
  if (i < 0) return null;
  rules[i] = normalizeRule(data, rules[i]);
  saveRules(rules);
  if (!rules[i].enabled) states.delete(id);
  return rules[i];
}
export function deleteRule(id) {
  const rules = listRules();
  const next = rules.filter((x) => x.id !== id);
  saveRules(next);
  states.delete(id);
  return next.length !== rules.length;
}

// ---------------------------------------------------------------------------
// Checks: each returns { problem: bool, level, message, value } or throws.
// ---------------------------------------------------------------------------
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what}: sin respuesta en ${ms / 1000} s`)), ms))]);

async function statusMap(pool, names) {
  const [rows] = await pool.query({ sql: `SHOW GLOBAL STATUS WHERE Variable_name IN (${names.map(() => '?').join(',')})`, values: names, rowsAsArray: true });
  return Object.fromEntries(rows.map(([k, v]) => [k, Number(v)]));
}

const slowPrev = new Map(); // ruleId -> { at, n }

const CHECKS = {
  async replication(pool, p) {
    const info = await replicationInfo(pool);
    if (info.error) return { problem: true, level: 'warning', message: `No se pudo leer la replicación: ${info.error}` };
    if (!info.channels.length) return { problem: false, message: 'Este servidor no es réplica' };
    const issues = [];
    let level = 'warning';
    let worstLag = 0;
    for (const ch of info.channels) {
      const name = ch.channel ? `[${ch.channel}] ` : '';
      if (ch.lastSqlError || ch.lastIoError) { level = 'critical'; issues.push(`${name}error: ${(ch.lastSqlError || ch.lastIoError).slice(0, 160)}`); continue; }
      if (ch.ioRunning !== 'Yes' || ch.sqlRunning !== 'Yes') { level = 'critical'; issues.push(`${name}hilos detenidos (IO ${ch.ioRunning}, SQL ${ch.sqlRunning})`); continue; }
      const lag = (ch.secondsBehind ?? 0) - (ch.sqlDelay || 0);
      worstLag = Math.max(worstLag, lag);
      if (lag >= p.lagSec) issues.push(`${name}atraso de ${lag} s (límite ${p.lagSec} s)`);
    }
    return issues.length
      ? { problem: true, level, message: issues.join(' · '), value: worstLag }
      : { problem: false, message: `Sincronizada (atraso ${worstLag} s)`, value: worstLag };
  },
  async down(pool) {
    await withTimeout(pool.query('SELECT 1'), 10000, 'Conexión');
    return { problem: false, message: 'Responde' };
  },
  async connections(pool, p) {
    const s = await statusMap(pool, ['Threads_connected', 'Threads_running']);
    const [[v]] = await pool.query('SELECT @@max_connections AS m');
    const pct = (s.Threads_connected / Number(v.m)) * 100;
    const msg = `${s.Threads_connected} de ${v.m} conexiones (${pct.toFixed(0)} %), ${s.Threads_running} ejecutando`;
    return { problem: pct >= p.pct, level: pct >= Math.max(95, p.pct) ? 'critical' : 'warning', message: msg, value: Math.round(pct) };
  },
  async longQuery(pool, p) {
    const [rows] = await pool.query('SHOW FULL PROCESSLIST');
    const busy = rows
      .filter((r) => r.Info && !['Sleep', 'Daemon', 'Binlog Dump', 'Binlog Dump GTID', 'Connect'].includes(r.Command)
        && !/system user|event_scheduler/i.test(r.User || '') && Number(r.Time) >= p.seconds)
      .sort((a, b) => Number(b.Time) - Number(a.Time));
    if (!busy.length) return { problem: false, message: `Ninguna consulta supera ${p.seconds} s` };
    const top = busy.slice(0, 3).map((r) => `#${r.Id} ${r.User} ${r.Time}s${/lock/i.test(r.State || '') ? ' (bloqueo)' : ''}: ${String(r.Info).replace(/\s+/g, ' ').slice(0, 90)}`);
    return { problem: true, level: busy.some((r) => /lock/i.test(r.State || '')) ? 'critical' : 'warning', message: `${busy.length} consulta(s) > ${p.seconds} s — ${top.join(' | ')}`, value: Number(busy[0].Time) };
  },
  async slowQueries(pool, p, rule) {
    const s = await statusMap(pool, ['Slow_queries']);
    const prev = slowPrev.get(rule.id);
    slowPrev.set(rule.id, { at: Date.now(), n: s.Slow_queries });
    if (!prev) return { problem: false, message: 'Midiendo…' };
    const perMin = ((s.Slow_queries - prev.n) / (Date.now() - prev.at)) * 60000;
    return { problem: perMin >= p.perMin, level: 'warning', message: `${perMin.toFixed(1)} consultas lentas por minuto (límite ${p.perMin})`, value: Math.round(perMin * 10) / 10 };
  },
};

// ---------------------------------------------------------------------------
// Scheduler + state machine
// ---------------------------------------------------------------------------
const states = new Map(); // ruleId -> { status, since, lastRun, lastNotified, streak, message, level, value, running }
let deps = null;
let timer = null;

function connName(id) {
  try { return deps.getConnectionRaw(id)?.name || id; } catch { return id; }
}

function record(entry) {
  const h = listHistory();
  h.unshift(entry);
  write(HISTORY, h.slice(0, HISTORY_CAP));
}

function emit(kind, rule, st) {
  const ev = {
    id: randomUUID(), at: new Date().toISOString(), kind, // fired | reminder | resolved
    ruleId: rule.id, type: rule.type, connId: rule.connId, connName: connName(rule.connId),
    level: kind === 'resolved' ? 'ok' : st.level, message: st.message,
  };
  if (kind !== 'reminder') record(ev);
  monitorEvents.emit('alert', ev);
}

export async function runRule(rule, { notify = true } = {}) {
  const st = states.get(rule.id) || { status: 'pending', streak: 0 };
  st.running = true;
  st.lastRun = Date.now();
  states.set(rule.id, st);
  let res;
  try {
    const pool = await deps.getPool(rule.connId);
    res = await withTimeout(CHECKS[rule.type](pool, rule.params, rule), 20000, 'Chequeo');
  } catch (e) {
    const msg = e.sqlMessage || e.message;
    res = rule.type === 'down'
      ? { problem: true, level: 'critical', message: `Sin conexión: ${msg}` }
      : { problem: null, message: `No se pudo verificar: ${msg}` };
  } finally {
    st.running = false;
  }
  st.message = res.message;
  st.value = res.value ?? null;
  if (!notify) return { ...res };
  if (res.problem === null) { st.status = st.status === 'firing' ? 'firing' : 'unknown'; return res; }
  const need = rule.type === 'down' ? Math.max(1, Number(rule.params.failures) || 1) : 1;
  if (res.problem) {
    st.streak = (st.streak || 0) + 1;
    st.level = res.level;
    if (st.status !== 'firing' && st.streak >= need) {
      st.status = 'firing'; st.since = Date.now(); st.lastNotified = Date.now();
      emit('fired', rule, st);
    } else if (st.status === 'firing' && rule.repeatMin > 0 && Date.now() - st.lastNotified >= rule.repeatMin * 60000) {
      st.lastNotified = Date.now();
      emit('reminder', rule, st);
    }
  } else {
    st.streak = 0;
    if (st.status === 'firing') { st.status = 'ok'; st.since = Date.now(); emit('resolved', rule, st); }
    else st.status = 'ok';
  }
  return res;
}

async function tick() {
  const now = Date.now();
  for (const rule of listRules()) {
    if (!rule.enabled) continue;
    const st = states.get(rule.id);
    if (st?.running) continue;
    if (st?.lastRun && now - st.lastRun < rule.intervalSec * 1000) continue;
    runRule(rule).catch(() => {});
  }
}

export function startMonitor(d) {
  deps = d;
  if (!timer) {
    timer = setInterval(tick, TICK_MS);
    timer.unref?.();
    setTimeout(tick, 1500).unref?.();
  }
}

export function monitorState() {
  const rules = listRules();
  const st = Object.fromEntries(rules.map((r) => {
    const s = states.get(r.id) || { status: r.enabled ? 'pending' : 'off' };
    return [r.id, { status: r.enabled ? s.status : 'off', since: s.since || null, lastRun: s.lastRun || null, message: s.message || '', level: s.level || null, value: s.value ?? null }];
  }));
  return {
    rules: rules.map((r) => ({ ...r, connName: connName(r.connId) })),
    states: st,
    active: rules.filter((r) => r.enabled && st[r.id].status === 'firing').length,
    history: listHistory().slice(0, 100),
  };
}

export function registerMonitor(app, { h }) {
  app.get('/api/monitor', h(async (_req, res) => res.json(monitorState())));
  app.post('/api/monitor/rules', h(async (req, res) => res.json(createRule(req.body || {}))));
  app.put('/api/monitor/rules/:rid', h(async (req, res) => {
    const r = updateRule(req.params.rid, req.body || {});
    if (!r) return res.status(404).json({ error: 'Regla no encontrada' });
    res.json(r);
  }));
  app.delete('/api/monitor/rules/:rid', h(async (req, res) => res.json({ ok: deleteRule(req.params.rid) })));
  // Run a rule once right now without notifying (the "Probar" button).
  app.post('/api/monitor/rules/:rid/test', h(async (req, res) => {
    const rule = listRules().find((x) => x.id === req.params.rid);
    if (!rule) return res.status(404).json({ error: 'Regla no encontrada' });
    res.json(await runRule(rule, { notify: false }));
  }));
  app.post('/api/monitor/history/clear', h(async (_req, res) => { write(HISTORY, []); res.json({ ok: true }); }));
  // Server-sent events: alerts as they happen.
  app.get('/api/monitor/stream', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('retry: 5000\n\n');
    const send = (ev) => res.write(`event: alert\ndata: ${JSON.stringify(ev)}\n\n`);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    monitorEvents.on('alert', send);
    req.on('close', () => { clearInterval(ping); monitorEvents.off('alert', send); });
  });
}
