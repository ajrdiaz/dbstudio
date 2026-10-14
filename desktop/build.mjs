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

// The whole server source tree (subfolders included), minus deps and manifests.
const serverDir = path.join(root, 'server');
fs.cpSync(serverDir, path.join(stage, 'server'), {
  recursive: true,
  filter: (src) => {
    const rel = path.relative(serverDir, src);
    return !rel.split(/[\\/]/).includes('node_modules') && !/^package(-lock)?\.json$/.test(path.basename(src));
  },
});
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
// Build info for the desktop app's "new version available" check.
let commit = '';
try { commit = execSync('git rev-parse --short HEAD', { cwd: root }).toString().trim(); } catch { /* not a git checkout */ }
fs.writeFileSync(path.join(stage, 'build-info.json'), JSON.stringify({
  version: pkg.version, commit, builtAt: new Date().toISOString(),
  releaseDir: path.join(here, 'release'),
}, null, 2));
console.log(`✔ stage listo (v${pkg.version}${commit ? ` · ${commit}` : ''})`);
