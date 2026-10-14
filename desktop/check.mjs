// Web/desktop parity checks. The same server + client code runs in the browser
// (run.sh) and inside the desktop app (Electron); these catch what works in one
// but breaks in the other. Exit code 1 if there are errors.
//   node check.mjs      (also run by `npm run release`)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const errors = [];
const warnings = [];
const rel = (f) => path.relative(root, f).replace(/\\/g, '/');

function walk(dir, exts, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, exts, out);
    else if (exts.some((x) => e.name.endsWith(x))) out.push(p);
  }
  return out;
}
function scan(files, re, onHit) {
  for (const f of files) {
    fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      const t = line.trim();
      if (t.startsWith('//') || t.startsWith('*')) return;
      if (re.test(line)) onHit(f, i + 1, t);
    });
  }
}

const clientFiles = walk(path.join(root, 'client', 'src'), ['.js', '.jsx']);
const serverFiles = walk(path.join(root, 'server'), ['.js']);

// 1. window.prompt does not exist in Electron -> use askText() (lib/dialogs.jsx).
scan(clientFiles.filter((f) => !f.endsWith('dialogs.jsx')), /(^|[^\w.])(window\.)?prompt\s*\(/, (f, n, t) =>
  errors.push(`${rel(f)}:${n} usa prompt(); en escritorio no existe → usar askText() de lib/dialogs.jsx\n      ${t}`));

// 2. Nothing may be loaded from the internet at runtime (desktop works offline; no third parties).
scan(clientFiles.filter((f) => !f.endsWith('i18n.jsx')), /['"`]https?:\/\/(?!127\.0\.0\.1|localhost|www\.w3\.org\/)/, (f, n, t) =>
  warnings.push(`${rel(f)}:${n} URL externa: en escritorio debe funcionar sin internet (empaquetar el recurso)\n      ${t}`));
const html = fs.readFileSync(path.join(root, 'client', 'index.html'), 'utf8');
if (/(src|href)=["']https?:\/\//.test(html)) errors.push('client/index.html carga recursos externos (CDN): empaquetarlos');

// 3. Browser notifications: only through lib/alerts.js (the desktop shows native ones).
scan(clientFiles.filter((f) => !f.endsWith('alerts.js')), /new\s+Notification\s*\(/, (f, n) =>
  errors.push(`${rel(f)}:${n} new Notification(): usar browserNotify() de lib/alerts.js (en escritorio notifica Electron)`));

// 4. i18n: every key in both dictionaries.
const i18n = fs.readFileSync(path.join(root, 'client', 'src', 'i18n.jsx'), 'utf8');
const enAt = i18n.search(/\n {2}en: \{/);
const keysOf = (txt) => new Set([...txt.matchAll(/^ {4}'([\w.-]+)':/gm)].map((m) => m[1]));
const es = keysOf(i18n.slice(0, enAt));
const en = keysOf(i18n.slice(enAt));
const onlyEs = [...es].filter((k) => !en.has(k));
const onlyEn = [...en].filter((k) => !es.has(k));
if (onlyEs.length) errors.push(`i18n: faltan en inglés: ${onlyEs.join(', ')}`);
if (onlyEn.length) errors.push(`i18n: faltan en español: ${onlyEn.join(', ')}`);

// 5. Server: in the desktop app the working directory is the install folder.
scan(serverFiles, /process\.cwd\(\)/, (f, n) =>
  warnings.push(`${rel(f)}:${n} process.cwd(): en escritorio apunta a la carpeta de instalación; usar paths.js / import.meta.url`));
// (tunnel.js listens on an internal loopback port for the SSH forwarder: expected.)
scan(serverFiles.filter((f) => !['index.js', 'tunnel.js'].includes(path.basename(f))), /\.listen\s*\(/, (f, n) =>
  warnings.push(`${rel(f)}:${n} abre otro puerto: el escritorio solo expone el de start(); revisar`));

// 6. Native addons need special packaging (asarUnpack + rebuild for Electron).
const serverModules = path.join(root, 'server', 'node_modules');
if (fs.existsSync(serverModules)) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'server', 'package.json'), 'utf8'));
  for (const dep of Object.keys(pkg.dependencies || {})) {
    const dir = path.join(serverModules, dep);
    if (fs.existsSync(path.join(dir, 'binding.gyp'))) warnings.push(`dependencia nativa en el server: ${dep} (requiere reconstruirla para Electron)`);
  }
}

for (const w of warnings) console.log(`⚠ ${w}`);
for (const e of errors) console.log(`✖ ${e}`);
console.log(errors.length ? `\n${errors.length} error(es), ${warnings.length} aviso(s)` : `✔ Web/escritorio compatibles (${warnings.length} aviso(s))`);
process.exit(errors.length ? 1 : 0);
