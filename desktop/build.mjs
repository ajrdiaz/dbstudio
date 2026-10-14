// Prepares desktop/stage, the folder Electron runs and electron-builder packs:
//   stage/main.mjs, preload.cjs, assets/   desktop shell
//   stage/server/                          API sources (ESM, "type": "module")
//   stage/node_modules/                    API production dependencies (declared in
//                                          stage/package.json so electron-builder packs them)
//   stage/web/                             built UI (vite build)
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const stage = path.join(here, 'stage');
const run = (cmd, cwd) => execSync(cmd, { cwd, stdio: 'inherit', shell: true });

console.log('› Compilando la interfaz…');
run('npx vite build', path.join(root, 'client'));

console.log('› Preparando desktop/stage…');
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(path.join(stage, 'server'), { recursive: true });
for (const f of ['main.mjs', 'preload.cjs']) fs.copyFileSync(path.join(here, f), path.join(stage, f));
fs.cpSync(path.join(here, 'assets'), path.join(stage, 'assets'), { recursive: true });

const serverDir = path.join(root, 'server');
for (const f of fs.readdirSync(serverDir)) {
  if (f.endsWith('.js')) fs.copyFileSync(path.join(serverDir, f), path.join(stage, 'server', f));
}
const serverPkg = JSON.parse(fs.readFileSync(path.join(serverDir, 'package.json'), 'utf8'));
// Only "type": "module" is needed next to the sources; dependencies live at the stage root.
fs.writeFileSync(path.join(stage, 'server', 'package.json'), JSON.stringify({ type: 'module', private: true }, null, 2));

fs.cpSync(path.join(root, 'client', 'dist'), path.join(stage, 'web'), { recursive: true });

const pkg = JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8'));
fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify({
  name: 'dbstudio',
  productName: pkg.productName,
  version: pkg.version,
  description: pkg.description,
  author: pkg.author,
  main: 'main.mjs',
  dependencies: serverPkg.dependencies,
}, null, 2));
// Same versions as the server's lockfile (npm ci only checks the dependency list).
fs.copyFileSync(path.join(serverDir, 'package-lock.json'), path.join(stage, 'package-lock.json'));
console.log('› Instalando dependencias del servidor (producción)…');
run('npm ci --omit=dev --omit=optional --no-audit --no-fund', stage);
console.log('✔ stage listo');
