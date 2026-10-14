// After `npm run dist`: (re)create "Instalador DBStudio.lnk" in the project
// root, pointing to the newest installer in desktop/release.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const release = path.join(here, 'release');
const installers = fs.existsSync(release)
  ? fs.readdirSync(release).filter((f) => /^DBStudio-Setup-.*\.exe$/.test(f))
    .map((f) => ({ f, t: fs.statSync(path.join(release, f)).mtimeMs })).sort((a, b) => b.t - a.t)
  : [];
if (!installers.length) {
  console.log('No hay instalador en desktop/release; ejecuta primero npm run dist');
  process.exit(0);
}
const target = path.join(release, installers[0].f);
const link = path.join(here, '..', 'Instalador DBStudio.lnk');
const ps = [
  '$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:LNK)',
  '$s.TargetPath = $env:TARGET',
  '$s.WorkingDirectory = Split-Path $env:TARGET',
  '$s.IconLocation = $env:TARGET + ",0"',
  '$s.Description = "Instalar DBStudio (escritorio)"',
  '$s.Save()',
].join('; ');
execFileSync('powershell', ['-NoProfile', '-Command', ps], { env: { ...process.env, LNK: link, TARGET: target }, stdio: 'inherit' });
console.log(`✔ Acceso directo: ${path.resolve(link)} → ${installers[0].f}`);
