// DBStudio desktop (Electron main process).
// Runs the same API in-process on the loopback interface, shows the UI in a
// window, stays in the system tray to keep watching alert rules, and turns
// monitor events into native Windows notifications.
import { app, BrowserWindow, Tray, Menu, Notification, nativeImage, shell, dialog } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const asset = (f) => path.join(here, 'assets', f);
// Fixed port range: the UI's local settings (theme, language, panel) are
// stored per origin, so a stable port keeps them between launches.
const PORTS = Array.from({ length: 20 }, (_, i) => 4799 + i);
const TYPE_ES = {
  replication: 'Replicación', down: 'Servidor caído', connections: 'Conexiones al límite',
  longQuery: 'Consulta larga / bloqueo', slowQueries: 'Consultas lentas',
};

// Startup / error log: %APPDATA%\DBStudio\desktop.log (or DBSTUDIO_LOG).
const logFile = () => process.env.DBSTUDIO_LOG || path.join(app.getPath('userData'), 'desktop.log');
function log(...a) {
  try {
    fs.mkdirSync(path.dirname(logFile()), { recursive: true });
    fs.appendFileSync(logFile(), `${new Date().toISOString()} ${a.map((x) => (x instanceof Error ? x.stack : String(x))).join(' ')}
`);
  } catch { /* ignore */ }
}
process.on('uncaughtException', (e) => log('uncaught', e));
process.on('unhandledRejection', (e) => log('unhandled', e));

// `--smoke-test` (used by `npm run release`): start the packaged app headless,
// verify the server, UI and dependencies, write the result and quit.
const SMOKE = process.argv.includes('--smoke-test');
if (SMOKE) app.setPath('userData', path.join(app.getPath('temp'), `dbstudio-smoke-${process.pid}`));

app.setAppUserModelId('pe.dbstudio.app'); // required for Windows notifications
if (!SMOKE && !app.requestSingleInstanceLock()) {
  log('another instance is running; exiting');
  app.quit();
  process.exit(0);
}
log('starting', app.getVersion(), process.argv.slice(1).join(' '));

let win = null;
let tray = null;
let port = null;
let monitor = null;
let quitting = false;
const startHidden = process.argv.includes('--hidden');

// ---- small persisted settings (window bounds, tray behaviour) ----
const settingsFile = () => path.join(app.getPath('userData'), 'desktop-settings.json');
let settings = { keepInTray: true, trayHintShown: false, bounds: null };
function loadSettings() {
  try { settings = { ...settings, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) }; } catch { /* first run */ }
}
function saveSettings() {
  try { fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2)); } catch { /* ignore */ }
}

function canListen(p) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(p, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

async function startServer() {
  const server = await import(pathToFileURL(path.join(here, 'server', 'index.js')).href);
  monitor = await import(pathToFileURL(path.join(here, 'server', 'monitor.js')).href);
  let chosen = 0;
  for (const p of PORTS) if (await canListen(p)) { chosen = p; break; }
  const r = await server.start({ port: chosen, host: '127.0.0.1', staticDir: path.join(here, 'web') });
  port = r.port;
  monitor.monitorEvents.on('alert', onAlert);
}

// ---- window ----
function createWindow() {
  const b = settings.bounds || {};
  win = new BrowserWindow({
    width: b.width || 1440, height: b.height || 900, x: b.x, y: b.y,
    minWidth: 900, minHeight: 560,
    title: 'DBStudio',
    icon: asset('icon-256.png'),
    backgroundColor: '#12151b',
    autoHideMenuBar: true,
    show: false,
    webPreferences: { preload: path.join(here, 'preload.cjs'), contextIsolation: true, sandbox: true },
  });
  if (b.maximized) win.maximize();
  // Tell the taskbar which icon to show for this window. Otherwise it resolves
  // the AppUserModelID through the Start menu shortcut, and after an update
  // (shortcut recreated) Explorer could keep showing a generic icon.
  if (process.platform === 'win32' && app.isPackaged) {
    win.setAppDetails({
      appId: 'pe.dbstudio.app', appIconPath: process.execPath, appIconIndex: 0,
      relaunchCommand: `"${process.execPath}"`, relaunchDisplayName: 'DBStudio',
    });
  }
  win.loadURL(`http://127.0.0.1:${port}/`);
  win.once('ready-to-show', () => { if (!startHidden) win.show(); });

  // Links to other sites open in the default browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(`http://127.0.0.1:${port}/`)) { e.preventDefault(); shell.openExternal(url); }
  });
  // The page asks to stay when a transaction is open: confirm before quitting.
  win.webContents.on('will-prevent-unload', (e) => {
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning', buttons: ['Salir de todos modos', 'Cancelar'], defaultId: 1, cancelId: 1,
      title: 'DBStudio', message: 'Hay una transacción abierta.',
      detail: 'Si sales ahora se revertirá (ROLLBACK). Vuelve a la pestaña y haz Commit para guardarla.',
    });
    if (choice === 0) e.preventDefault();
    else { quitting = false; cancelUpdate(); }
  });

  const remember = () => {
    if (!win || win.isMinimized()) return;
    settings.bounds = { ...(win.isMaximized() ? settings.bounds : win.getBounds()), maximized: win.isMaximized() };
    saveSettings();
  };
  win.on('resize', remember);
  win.on('move', remember);
  // Closing the window keeps DBStudio running in the tray (alerts keep working).
  win.on('close', (e) => {
    if (quitting || !settings.keepInTray) return;
    e.preventDefault();
    win.hide();
    if (!settings.trayHintShown) {
      settings.trayHintShown = true;
      saveSettings();
      new Notification({
        title: 'DBStudio sigue activo',
        body: 'Sigue vigilando tus alertas desde la bandeja del sistema. Clic derecho en el ícono para salir.',
        icon: asset('icon-256.png'),
      }).show();
    }
  });
}

function showWindow() {
  if (!win) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// ---- updates: a newer installer in the project's desktop/release folder ----
const buildInfo = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(here, 'build-info.json'), 'utf8')); } catch { return null; }
})();
const cmpVer = (a, b) => {
  const x = a.split('.').map(Number); const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
};
let pendingUpdate = null; // { version, file }
let notifiedVersion = null;
let updating = null; // the update being installed (tray turns green)

function findUpdate() {
  const dir = buildInfo?.releaseDir;
  if (!dir || !fs.existsSync(dir)) return null;
  let best = null;
  for (const f of fs.readdirSync(dir)) {
    const m = /^DBStudio-Setup-(\d+\.\d+\.\d+)\.exe$/.exec(f);
    if (m && cmpVer(m[1], app.getVersion()) > 0 && (!best || cmpVer(m[1], best.version) > 0)) best = { version: m[1], file: path.join(dir, f) };
  }
  return best;
}
function offerUpdate(u) {
  if (updating) return;
  const choice = dialog.showMessageBoxSync({
    type: 'info', buttons: ['Actualizar ahora', 'Más tarde'], defaultId: 0, cancelId: 1, title: 'DBStudio',
    message: `Hay una nueva versión de DBStudio: ${u.version} (tienes ${app.getVersion()}).`,
    detail: 'Se instala sola en unos segundos y DBStudio se vuelve a abrir con tus pestañas. '
      + 'Mientras tanto el ícono de la bandeja se pone verde. Tus conexiones, consultas y alertas se conservan.',
  });
  if (choice !== 0) return;
  startUpdate(u);
}
function startUpdate(u) {
  log('updating to', u.version);
  updating = { ...u, hidden: !win || !win.isVisible() };
  updateTray();
  quitting = true;
  // The installer starts in 'will-quit', i.e. only if nothing cancels the quit
  // (an open transaction asks first).
  app.quit();
}
function cancelUpdate() {
  if (!updating) return;
  log('update cancelled');
  updating = null;
  updateTray();
}

// The app's files can't be replaced while it runs, so a small hidden
// PowerShell helper takes over: it keeps a green "updating" icon in the tray,
// waits for this process to exit, runs the installer silently and reopens
// DBStudio (with --hidden if the window was in the tray).
const UPDATER_PS1 = `
$AppPid = [int]$env:DBS_UPD_PID; $Installer = $env:DBS_UPD_INSTALLER; $Exe = $env:DBS_UPD_EXE
$Icon = $env:DBS_UPD_ICON; $Version = $env:DBS_UPD_VERSION; $Log = $env:DBS_UPD_LOG; $Hidden = $env:DBS_UPD_HIDDEN
function W($m) { try { Add-Content -LiteralPath $Log -Value ((Get-Date).ToString('o') + ' updater ' + $m) } catch {} }
W "started (waiting for $AppPid)"
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
$ni = New-Object System.Windows.Forms.NotifyIcon
try { $ni.Icon = [System.Drawing.Icon]::FromHandle(([System.Drawing.Bitmap]::FromFile($Icon)).GetHicon()) } catch {}
$ni.Text = "DBStudio: actualizando a $Version..."
$ni.Visible = $true
# Small window bottom-right (+ green taskbar button): tray icons of new
# programs are often hidden in Windows 11's overflow menu.
$form = $null
try {
  $form = New-Object System.Windows.Forms.Form
  $form.Text = 'DBStudio'; $form.FormBorderStyle = 'None'; $form.TopMost = $true; $form.ShowInTaskbar = $true
  $form.StartPosition = 'Manual'; $form.Size = New-Object System.Drawing.Size(360, 96)
  $wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
  $form.Location = New-Object System.Drawing.Point(($wa.Right - 376), ($wa.Bottom - 112))
  $form.BackColor = [System.Drawing.Color]::FromArgb(24, 28, 36)
  try { $form.Icon = [System.Drawing.Icon]::FromHandle(([System.Drawing.Bitmap]::FromFile($env:DBS_UPD_BIGICON)).GetHicon()) } catch {}
  $pic = New-Object System.Windows.Forms.PictureBox
  $pic.Image = [System.Drawing.Image]::FromFile($env:DBS_UPD_BIGICON); $pic.SizeMode = 'Zoom'
  $pic.Location = New-Object System.Drawing.Point(16, 22); $pic.Size = New-Object System.Drawing.Size(44, 44)
  $title = New-Object System.Windows.Forms.Label
  $title.Text = "Actualizando DBStudio a $Version..."; $title.ForeColor = [System.Drawing.Color]::White
  $title.Font = New-Object System.Drawing.Font('Segoe UI', 10, [System.Drawing.FontStyle]::Bold)
  $title.Location = New-Object System.Drawing.Point(72, 16); $title.AutoSize = $true
  $sub = New-Object System.Windows.Forms.Label
  $sub.Text = 'Se volverá a abrir solo con tus pestañas.'; $sub.ForeColor = [System.Drawing.Color]::FromArgb(170, 178, 192)
  $sub.Font = New-Object System.Drawing.Font('Segoe UI', 9); $sub.Location = New-Object System.Drawing.Point(72, 40); $sub.AutoSize = $true
  $bar = New-Object System.Windows.Forms.ProgressBar
  $bar.Style = 'Marquee'; $bar.MarqueeAnimationSpeed = 30
  $bar.Location = New-Object System.Drawing.Point(72, 66); $bar.Size = New-Object System.Drawing.Size(270, 8)
  $form.Controls.AddRange(@($pic, $title, $sub, $bar))
  $form.Show()
} catch { W ("window " + $_) }
$pump = { param($ms) $end = (Get-Date).AddMilliseconds($ms); while ((Get-Date) -lt $end) { [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 100 } }
try {
  $app = Get-Process -Id $AppPid -ErrorAction SilentlyContinue
  $t = 0
  while ($app -and -not $app.HasExited -and $t -lt 600) { & $pump 100; $t++ }
  & $pump 500
  W "installing $Version"
  $p = Start-Process -FilePath $Installer -ArgumentList '/S' -PassThru
  while (-not $p.HasExited) { & $pump 200 }
  W ("installer exit " + $p.ExitCode)
  # The exe was missing for a moment: Windows may have cached a generic icon.
  try { Start-Process ie4uinit.exe -ArgumentList '-show' -Wait -WindowStyle Hidden } catch {}
} catch { W ("error " + $_) }
finally { $ni.Visible = $false; $ni.Dispose(); if ($form) { $form.Close() } }
if (Test-Path -LiteralPath $Exe) {
  if ($Hidden -eq '1') { Start-Process -FilePath $Exe -ArgumentList '--hidden' } else { Start-Process -FilePath $Exe }
} else { W "missing $Exe" }
`;
function launchUpdater(u) {
  const dir = fs.mkdtempSync(path.join(app.getPath('temp'), 'dbstudio-update-'));
  const script = path.join(dir, 'update.ps1');
  // Icons go outside app.asar: PowerShell can't read inside it.
  const icon = path.join(dir, 'tray-update.png');
  const bigIcon = path.join(dir, 'icon-update.png');
  fs.writeFileSync(script, '\ufeff' + UPDATER_PS1); // BOM: PowerShell 5 reads the accents as UTF-8
  fs.copyFileSync(asset('tray-update-32.png'), icon);
  fs.copyFileSync(asset('icon-update-256.png'), bigIcon);
  settings.updateFrom = app.getVersion();
  saveSettings();
  // Started through `cmd /c start` so it is fully independent of this process:
  // Node kills non-detached children when the app exits, and a detached
  // PowerShell (no console) exits without running the script. Parameters go
  // in the environment so paths never need quoting.
  const child = spawn('cmd.exe', ['/d', '/s', '/c',
    `start "" /min powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${script}"`], {
    detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true,
    env: {
      ...process.env,
      DBS_UPD_PID: String(process.pid), DBS_UPD_INSTALLER: u.file, DBS_UPD_EXE: process.execPath,
      DBS_UPD_ICON: icon, DBS_UPD_BIGICON: bigIcon, DBS_UPD_VERSION: u.version, DBS_UPD_LOG: logFile(), DBS_UPD_HIDDEN: u.hidden ? '1' : '0',
    },
  });
  child.unref();
  log('updater started', u.version);
}
// After an update the new version says so (or that the installer failed).
function reportUpdate() {
  const from = settings.updateFrom;
  if (!from) return;
  delete settings.updateFrom;
  saveSettings();
  const ok = cmpVer(app.getVersion(), from) > 0;
  // While the installer replaced the exe Windows may have cached a generic
  // taskbar icon; ask it to refresh its icon cache.
  try { spawn('ie4uinit.exe', ['-show'], { stdio: 'ignore', windowsHide: true }).on('error', () => {}); } catch { /* ignore */ }
  log(ok ? 'updated' : 'update failed', from, '->', app.getVersion());
  new Notification({
    title: ok ? `DBStudio actualizado a ${app.getVersion()}` : 'No se pudo actualizar DBStudio',
    body: ok ? 'Tus pestañas, conexiones y alertas siguen como las dejaste.'
      : `Sigues con la versión ${app.getVersion()}. Prueba de nuevo desde la bandeja → Buscar actualizaciones.`,
    icon: asset('icon-256.png'),
  }).show();
}
function checkUpdate(manual = false) {
  if (updating) return;
  const u = findUpdate();
  pendingUpdate = u;
  updateTray();
  if (!u) {
    if (manual) dialog.showMessageBox({ type: 'info', title: 'DBStudio', message: `Tienes la última versión (${app.getVersion()}).` });
    return;
  }
  if (manual) { offerUpdate(u); return; }
  // End-to-end test of the update flow (no dialog to click).
  if (process.env.DBSTUDIO_UPDATE_TEST === '1') { startUpdate(u); return; }
  if (notifiedVersion === u.version) return;
  notifiedVersion = u.version;
  const n = new Notification({ title: `DBStudio ${u.version} disponible`, body: 'Clic para instalar la nueva versión.', icon: asset('icon-256.png') });
  n.on('click', () => offerUpdate(u));
  n.show();
}

// ---- tray ----
function activeAlerts() {
  try { return monitor?.monitorState().active || 0; } catch { return 0; }
}
function updateTray() {
  if (!tray) return;
  const n = activeAlerts();
  if (updating) {
    tray.setImage(nativeImage.createFromPath(asset('tray-update-32.png')));
    tray.setToolTip(`DBStudio — actualizando a ${updating.version}…`);
    return;
  }
  tray.setImage(nativeImage.createFromPath(asset(n ? 'tray-alert-32.png' : 'tray-32.png')));
  tray.setToolTip(n ? `DBStudio — ${n} alerta(s) activa(s)` : 'DBStudio — sin alertas');
  const login = app.getLoginItemSettings();
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Abrir DBStudio', click: showWindow },
    { label: n ? `Ver alertas (${n} activa${n === 1 ? '' : 's'})` : 'Ver alertas', click: () => { showWindow(); win.webContents.send('open-alerts'); } },
    { type: 'separator' },
    pendingUpdate
      ? { label: `⬆ Instalar versión ${pendingUpdate.version}`, click: () => offerUpdate(pendingUpdate) }
      : { label: 'Buscar actualizaciones', click: () => checkUpdate(true) },
    { label: `Versión ${app.getVersion()}`, enabled: false },
    { type: 'separator' },
    {
      label: 'Iniciar con Windows', type: 'checkbox', checked: login.openAtLogin,
      click: (item) => { app.setLoginItemSettings({ openAtLogin: item.checked, args: ['--hidden'] }); updateTray(); },
    },
    {
      label: 'Al cerrar la ventana, seguir en la bandeja', type: 'checkbox', checked: settings.keepInTray,
      click: (item) => { settings.keepInTray = item.checked; saveSettings(); },
    },
    { type: 'separator' },
    { label: 'Salir', click: () => { quitting = true; app.quit(); } },
  ]));
}

// ---- alerts → native notifications ----
function onAlert(ev) {
  log('alert', ev.kind, ev.level, ev.type, ev.connName);
  updateTray();
  const title = ev.kind === 'resolved'
    ? `✔ ${ev.connName}: resuelto`
    : `${ev.level === 'critical' ? '✖' : '⚠'} ${ev.connName}${ev.kind === 'reminder' ? ' (sigue)' : ''}`;
  const n = new Notification({
    title,
    body: `${TYPE_ES[ev.type] || ev.type}: ${ev.message}`.slice(0, 250),
    icon: asset(ev.kind === 'resolved' ? 'icon-256.png' : 'icon-alert-256.png'),
    urgency: ev.level === 'critical' ? 'critical' : 'normal',
  });
  n.on('click', () => { showWindow(); win.webContents.send('open-alerts'); });
  n.show();
}

// ---- lifecycle ----
app.on('second-instance', showWindow);
app.on('before-quit', () => { quitting = true; });
app.on('will-quit', () => { if (updating) launchUpdater(updating); });
app.on('window-all-closed', () => { if (!settings.keepInTray) app.quit(); });

app.whenReady().then(async () => {
  loadSettings();
  if (SMOKE) { await smokeTest(); return; }
  try {
    await startServer();
    log('server on port', port);
  } catch (e) {
    log('server failed', e);
    dialog.showErrorBox('DBStudio', `No se pudo iniciar el servidor interno:\n${e.message}`);
    app.quit();
    return;
  }
  tray = new Tray(nativeImage.createFromPath(asset('tray-32.png')));
  tray.on('click', showWindow);
  updateTray();
  setInterval(updateTray, 30000).unref();
  reportUpdate(); // before the window: refreshes the icon cache after an update
  createWindow();
  setTimeout(() => checkUpdate(), 15000);
  setInterval(() => checkUpdate(), 30 * 60 * 1000).unref();
});

async function smokeTest() {
  const out = process.env.DBSTUDIO_SMOKE_OUT;
  const result = { version: app.getVersion(), build: buildInfo, checks: {} };
  let ok = false;
  try {
    await startServer();
    const base = `http://127.0.0.1:${port}`;
    const page = await fetch(`${base}/`).then((r) => r.text());
    result.checks.ui = /<div id="root">/.test(page);
    result.checks.api = (await fetch(`${base}/api/settings/storage`)).ok;
    result.checks.monitor = (await fetch(`${base}/api/monitor`)).ok;
    // Every server dependency must load from inside the package.
    const pkg = JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8'));
    result.checks.deps = {};
    for (const d of Object.keys(pkg.dependencies || {})) {
      try { await import(d); result.checks.deps[d] = true; } catch (e) { result.checks.deps[d] = String(e.message || e); }
    }
    ok = result.checks.ui && result.checks.api && result.checks.monitor && Object.values(result.checks.deps).every((v) => v === true);
  } catch (e) {
    result.error = String(e.stack || e);
  }
  result.ok = ok;
  if (out) fs.writeFileSync(out, JSON.stringify(result, null, 2));
  app.exit(ok ? 0 : 1);
}
