// Helpers shared by the saved-queries panel and the "save query" dialog.
const LAST_KEY = 'dbstudio.lastQueryFolder';

// Options for a folder <select>: root first, then every folder as "A / B".
export function folderOptions(folders, rootLabel) {
  return [{ value: '', label: rootLabel }, ...folders.map((f) => ({ value: f, label: f.split('/').join(' / ') }))];
}

export function lastFolder(folders) {
  try {
    const f = localStorage.getItem(LAST_KEY) || '';
    return folders.includes(f) ? f : '';
  } catch { return ''; }
}

export function rememberFolder(f) {
  try { localStorage.setItem(LAST_KEY, f || ''); } catch { /* ignore */ }
}

export const folderName = (path) => path.slice(path.lastIndexOf('/') + 1);
export const parentOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
