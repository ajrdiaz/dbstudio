// Where DBStudio keeps its data. ~/.dbstudio always holds config.json (the
// pointer to the data folder) and, by default, the encryption key; the data
// files themselves (connections, saved queries, history, workspace) live in the
// configurable data folder — e.g. inside OneDrive or Google Drive so they sync
// between PCs.
//
// Precedence: DBSTUDIO_DATA_DIR env var > config.json "dataDir" > ~/.dbstudio
import {
  readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, copyFileSync,
  readdirSync, statSync, unlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, isAbsolute } from 'node:path';

export const HOME_DIR = join(homedir(), '.dbstudio');
const CONFIG = join(HOME_DIR, 'config.json');
export const DATA_FILES = ['connections.json', 'queries.json', 'history.json', 'workspace.json'];

function readConfig() {
  try { return JSON.parse(readFileSync(CONFIG, 'utf8')); } catch { return {}; }
}

export function dataDir() {
  if (process.env.DBSTUDIO_DATA_DIR) return resolve(process.env.DBSTUDIO_DATA_DIR);
  const { dataDir: d } = readConfig();
  return d ? resolve(d) : HOME_DIR;
}

export function dataSource() {
  if (process.env.DBSTUDIO_DATA_DIR) return 'env';
  return readConfig().dataDir ? 'config' : 'default';
}

export function dataFile(name) {
  const dir = dataDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, name);
}

// The key that encrypts saved passwords. A key inside the data folder wins (it
// travels with the synced data so other PCs can decrypt); otherwise the local,
// never-synced one in ~/.dbstudio is used.
export function keyFile() {
  const synced = join(dataDir(), '.key');
  if (existsSync(synced)) return synced;
  if (!existsSync(HOME_DIR)) mkdirSync(HOME_DIR, { recursive: true });
  return join(HOME_DIR, '.key');
}

// True when the key in use lives in the (possibly synced) data folder.
export function keySynced() {
  return keyFile() !== join(HOME_DIR, '.key');
}

// Write via temp file + rename so a sync client never uploads a half-written
// file.
export function writeFileAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  try {
    renameSync(tmp, file);
  } catch {
    // Some sync clients briefly lock the target; fall back to a direct write.
    writeFileSync(file, text, { mode: 0o600 });
    try { unlinkSync(tmp); } catch { /* ignore */ }
  }
}

// What a candidate folder already contains.
export function inspectDir(dir) {
  const abs = resolve(dir);
  const exists = existsSync(abs) && statSync(abs).isDirectory();
  const files = exists ? DATA_FILES.filter((f) => existsSync(join(abs, f))) : [];
  return {
    dir: abs,
    exists,
    files,
    hasData: files.length > 0,
    hasKey: exists && existsSync(join(abs, '.key')),
    current: abs === dataDir(),
  };
}

// Switch the data folder.
//   mode 'copy' — copy this PC's data files into the new folder (overwrites)
//   mode 'use'  — keep whatever the folder already has (e.g. set up from another PC)
//   includeKey  — also place the encryption key in the folder, so other PCs
//                 using it can read saved passwords
// The old files are left in place as a backup.
export function setDataDir(dir, { mode = 'copy', includeKey = false } = {}) {
  if (process.env.DBSTUDIO_DATA_DIR) {
    throw new Error('DBSTUDIO_DATA_DIR is set; unset it to change the folder from the app');
  }
  if (!dir || !isAbsolute(dir)) throw new Error('Use an absolute folder path');
  const target = resolve(dir);
  mkdirSync(target, { recursive: true });

  const from = dataDir();
  const currentKey = keyFile();
  if (target !== from) {
    if (mode === 'copy') {
      for (const f of DATA_FILES) {
        const src = join(from, f);
        if (existsSync(src)) copyFileSync(src, join(target, f));
      }
      // Copied connections are encrypted with the key in use now: the folder
      // must keep using it, so bring it along (replacing any other key there)
      // unless it's the local key, which stays found by fallback anyway.
      const usingLocalKey = currentKey === join(HOME_DIR, '.key');
      if (includeKey || !usingLocalKey || existsSync(join(target, '.key'))) {
        if (currentKey !== join(target, '.key')) copyFileSync(currentKey, join(target, '.key'));
      }
    } else if (includeKey && !existsSync(join(target, '.key'))) {
      copyFileSync(currentKey, join(target, '.key'));
    }
  } else if (includeKey && !existsSync(join(target, '.key'))) {
    copyFileSync(currentKey, join(target, '.key'));
  }

  const cfg = readConfig();
  if (target === HOME_DIR) delete cfg.dataDir;
  else cfg.dataDir = target;
  if (!existsSync(HOME_DIR)) mkdirSync(HOME_DIR, { recursive: true });
  writeFileAtomic(CONFIG, JSON.stringify(cfg, null, 2));
  return inspectDir(target);
}

// Suggested folders for OneDrive / Google Drive on this machine.
export function detectCloudFolders() {
  const out = [];
  const seen = new Set();
  const add = (provider, base, label) => {
    if (!base || !existsSync(base)) return;
    const dir = join(base, 'DBStudio');
    if (seen.has(dir.toLowerCase())) return;
    seen.add(dir.toLowerCase());
    out.push({ provider, label, dir, ...inspectDir(dir) });
  };

  // OneDrive (personal / work) — exposed via env vars on Windows.
  add('onedrive', process.env.OneDriveConsumer, 'OneDrive');
  add('onedrive', process.env.OneDriveCommercial, 'OneDrive (trabajo)');
  add('onedrive', process.env.OneDrive, 'OneDrive');
  add('onedrive', join(homedir(), 'OneDrive'), 'OneDrive');
  // macOS: ~/Library/CloudStorage/OneDrive-*, GoogleDrive-*
  const cloudStorage = join(homedir(), 'Library', 'CloudStorage');
  if (existsSync(cloudStorage)) {
    for (const name of safeList(cloudStorage)) {
      if (name.startsWith('OneDrive')) add('onedrive', join(cloudStorage, name), name);
      if (name.startsWith('GoogleDrive')) {
        for (const sub of ['My Drive', 'Mi unidad']) add('gdrive', join(cloudStorage, name, sub), `Google Drive (${name.slice(12)})`);
      }
    }
  }

  // Google Drive for desktop on Windows mounts each account as a drive letter
  // containing "My Drive" (or the localized "Mi unidad").
  if (process.platform === 'win32') {
    for (const letter of 'DEFGHIJKLMNOPQRSTUVWXYZ') {
      for (const sub of ['My Drive', 'Mi unidad']) {
        add('gdrive', `${letter}:\\${sub}`, `Google Drive (${letter}:)`);
      }
    }
  }
  for (const sub of ['My Drive', 'Mi unidad']) add('gdrive', join(homedir(), 'Google Drive', sub), 'Google Drive');
  return out;
}

function safeList(dir) {
  try { return readdirSync(dir); } catch { return []; }
}
