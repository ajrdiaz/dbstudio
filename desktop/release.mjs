// Ship a new desktop version after a feature lands, so web and desktop stay in sync:
//   npm run release              -> patch  (1.1.0 -> 1.1.1)
//   npm run release -- minor     -> minor  (1.1.0 -> 1.2.0)
//   npm run release -- major
// Steps: parity checks → clean git tree → version bump → stage + installer →
// smoke test of the PACKAGED app → root shortcut → commit "Escritorio vX.Y.Z".
// The installed app notices the new installer and offers to update itself.
import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const args = process.argv.slice(2);
const level = ['major', 'minor', 'patch'].find((l) => args.includes(l)) || 'patch';
const run = (cmd, opts = {}) => execSync(cmd, { cwd: here, stdio: 'inherit', shell: true, ...opts });
const fail = (msg) => { console.error(`\n✖ ${msg}`); process.exit(1); };

console.log('› 1/6 Compatibilidad web/escritorio');
if (spawnSync(process.execPath, ['check.mjs'], { cwd: here, stdio: 'inherit' }).status !== 0) fail('Corrige los errores de check.mjs antes de publicar.');

console.log('› 2/6 Repositorio sin cambios pendientes');
const dirty = execSync('git status --porcelain', { cwd: root }).toString().trim();
if (dirty && !args.includes('--allow-dirty')) fail(`Hay cambios sin commit:\n${dirty}\nHaz commit de la funcionalidad primero (o usa --allow-dirty).`);

const pkgFile = path.join(here, 'package.json');
const pkgText = fs.readFileSync(pkgFile, 'utf8');
const pkg = JSON.parse(pkgText);
const [ma, mi, pa] = pkg.version.split('.').map(Number);
const next = level === 'major' ? `${ma + 1}.0.0` : level === 'minor' ? `${ma}.${mi + 1}.0` : `${ma}.${mi}.${pa + 1}`;
console.log(`› 3/6 Versión ${pkg.version} → ${next}`);
fs.writeFileSync(pkgFile, pkgText.replace(`"version": "${pkg.version}"`, `"version": "${next}"`));
const restoreVersion = () => fs.writeFileSync(pkgFile, pkgText);

try {
  console.log('› 4/6 Interfaz + instalador');
  run('node build.mjs');
  run('npx --no-install electron-builder --win nsis --publish never', { env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' } });

  console.log('› 5/6 Prueba del app empaquetado');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dbstudio-release-'));
  const outFile = path.join(tmp, 'smoke.json');
  const exe = path.join(here, 'release', 'win-unpacked', 'DBStudio.exe');
  const r = spawnSync(exe, ['--smoke-test'], {
    env: { ...process.env, DBSTUDIO_SMOKE_OUT: outFile, DBSTUDIO_DATA_DIR: path.join(tmp, 'data') },
    timeout: 90000,
  });
  const smoke = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, 'utf8')) : null;
  if (!smoke?.ok) {
    console.error(JSON.stringify(smoke || { status: r.status, error: String(r.error || '') }, null, 2));
    throw new Error('El app empaquetado no pasó la prueba (ver arriba).');
  }
  console.log(`  ✔ UI, API, monitor y dependencias OK (${Object.keys(smoke.checks.deps).join(', ')})`);
} catch (e) {
  restoreVersion();
  fail(e.message);
}

console.log('› 6/6 Acceso directo y commit de versión');
run('node shortcut.mjs');
execSync(`git add desktop/package.json && git commit -q -m "Escritorio v${next}" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`, { cwd: root, stdio: 'inherit', shell: true });

const installer = path.join(here, 'release', `DBStudio-Setup-${next}.exe`);
console.log(`\n✔ Escritorio v${next} listo: ${installer}`);
console.log('  El app instalado lo detecta y ofrece actualizar (o: bandeja → Buscar actualizaciones).');
console.log('  La versión web ya tiene los cambios (run.sh recarga solo).');
