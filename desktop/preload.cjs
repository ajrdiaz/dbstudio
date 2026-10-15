// Minimal bridge between the desktop shell and the web UI.
const { contextBridge, ipcRenderer } = require('electron');

// Lets the UI know it runs inside the desktop app (native notifications are
// shown by the main process, so the page doesn't show browser ones).
// setTheme keeps the native title bar in the UI's light/dark theme.
contextBridge.exposeInMainWorld('dbstudioDesktop', {
  electron: process.versions.electron,
  setTheme: (theme) => ipcRenderer.send('theme', theme),
});

// Clicking a native alert notification opens the alerts tab.
ipcRenderer.on('open-alerts', () => window.dispatchEvent(new CustomEvent('dbstudio:open-alerts')));
