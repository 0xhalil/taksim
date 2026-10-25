const { app, BrowserWindow, Menu, ipcMain, dialog, shell, nativeImage } = require('electron');
const { join, isAbsolute } = require('node:path');
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const { Engine } = require('./engine.cjs');
app.setName('taksim');
// one window for one engine: a second launch brings the first one forward
if (!app.requestSingleInstanceLock()) app.exit(0);
// TAKSIM_URL: an engine already running elsewhere on this machine, used as it is
const given = process.env.TAKSIM_URL ? new URL(process.env.TAKSIM_URL) : null;
if (given && (given.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(given.hostname) || given.username || given.password)) throw new Error('Electron requires a local taksim engine');
// the engine's port, kept when another program held 8787 and it moved (ServerLauncher.portKey)
const kept = () => { try { return JSON.parse(readFileSync(join(app.getPath('userData'), 'engine.json'), 'utf8')).port; } catch { return null; } };
const keep = (port) => { try { mkdirSync(app.getPath('userData'), { recursive: true }); writeFileSync(join(app.getPath('userData'), 'engine.json'), JSON.stringify({ port })); } catch {} };
const engine = new Engine({ port: given ? Number(given.port || 80) : (Number(process.env.TAKSIM_PORT) || kept() || 8787), movable: !given && !process.env.TAKSIM_PORT, packaged: app.isPackaged, onMove: keep });
const base = () => (given ? given.origin : engine.url);
let win, choosing = false, quitting = false;
// the native app's icon (native/scripts/make-icon.swift), copied to ui/app by scripts/sync-native.mjs
const icon = nativeImage.createFromPath(join(engine.root, 'ui', 'app', 'icon.png'));
const trusted = url => { try { const u = new URL(url); return u.origin === base() && u.pathname === '/app'; } catch { return false; } };
const external = url => { try { if (['https:', 'http:'].includes(new URL(url).protocol)) shell.openExternal(url).catch(console.error); } catch {} };
async function connect() {
  if (!given) return engine.ensure();
  try { const r = await fetch(new URL('/health', given), { signal: AbortSignal.timeout(1500) }); if (r.ok && (await r.json()).ok === true) return; } catch {}
  throw new Error('The selected taksim engine is not running');
}
ipcMain.handle('taksim:pick-folder', async (event, start) => {
  if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || !trusted(event.senderFrame.url)) throw new Error('Untrusted folder request');
  if (choosing) return { path: null, canceled: true };
  choosing = true;
  try {
    const result = await dialog.showOpenDialog(win, {
      title: 'Choose folder', buttonLabel: 'Select', properties: ['openDirectory', 'createDirectory'],
      ...(typeof start === 'string' && isAbsolute(start) ? { defaultPath: start } : {}),
    });
    return { path: result.canceled ? null : result.filePaths[0] ?? null, canceled: result.canceled };
  } finally { choosing = false; }
});
// The menu bar, as TaksimApp.commands builds it; the page runs the commands. On Linux and Windows the window has no
// menu bar and the page's own key handling (app.mjs) does the same. The page handles the shortcuts itself, so they
// are shown but not registered (it would run them twice).
function menu(labels = {}) {
  const text = (k, fallback) => (typeof labels[k] === 'string' && labels[k] ? labels[k].slice(0, 80) : fallback);
  const run = (command, n) => () => win?.webContents.send('taksim:command', command, n);
  const item = (label, accelerator, command, n) => ({ label, accelerator, registerAccelerator: false, click: run(command, n) });
  const tabs = Array.isArray(labels.tabs) ? labels.tabs : [];
  return Menu.buildFromTemplate([
    { role: 'appMenu', submenu: [
      { role: 'about' }, { type: 'separator' },
      item(text('settings', 'Settings…'), 'Cmd+,', 'settings'), { type: 'separator' },
      { role: 'services' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' },
    ] },
    { role: 'fileMenu', submenu: [item(text('newCanvas', 'New canvas'), 'Cmd+T', 'newCanvas'), { type: 'separator' }, { role: 'close' }] },
    { role: 'editMenu' },
    { label: text('canvas', 'Canvas'), submenu: [
      item(text('palette', 'Command palette'), 'Cmd+K', 'palette'),
      item(text('sidebar', 'Sidebar'), 'Cmd+Shift+A', 'sidebar'),
      item(text('showAll', 'Show all'), 'Cmd+0', 'showAll'),
      { type: 'separator' },
      ...Array.from({ length: 9 }, (_, i) => item(typeof tabs[i] === 'string' && tabs[i] ? tabs[i].slice(0, 80) : `Tab ${i + 1}`, `Cmd+${i + 1}`, 'tab', i)),
    ] },
    { role: 'windowMenu', submenu: [{ role: 'minimize' }, { role: 'zoom' }, ...(app.isPackaged ? [] : [{ type: 'separator' }, { role: 'toggleDevTools' }]), { type: 'separator' }, { role: 'front' }] },
    { role: 'help', submenu: [{ label: text('intro', 'Intro and accounts'), click: run('intro') }] },
  ]);
}
ipcMain.on('taksim:menu', (event, labels) => {
  if (process.platform !== 'darwin' || !win || event.sender !== win.webContents || !trusted(event.senderFrame?.url)) return;
  Menu.setApplicationMenu(menu(labels && typeof labels === 'object' ? labels : {}));
});
async function openWindow() {
  win = new BrowserWindow({ width: 1440, height: 960, minWidth: 800, minHeight: 600, title: 'taksim', backgroundColor: '#1E1F22', icon,
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 14, y: 13 } } : { titleBarOverlay: { color: '#00000000', symbolColor: '#868A91', height: 40 } }),
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.removeMenu();
  win.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (event, url) => { if (!trusted(url)) { event.preventDefault(); external(url); } });
  win.webContents.on('will-attach-webview', event => event.preventDefault());
  const url = new URL('/app', base());
  if (process.env.TAKSIM_CANVAS) url.searchParams.set('canvas', process.env.TAKSIM_CANVAS);
  await win.loadURL(url.href);
  win.show(); win.focus();
  if (process.argv.includes('--choose-folder')) {
    await win.webContents.executeJavaScript(`(async () => { for (let i = 0; i < 100 && !window.taksim; i++) await new Promise(r => setTimeout(r, 100)); if (window.taksim) { taksim.welcome.close(); await taksim.quickAdd(); } })()`);
  }
}
// a released Linux or Windows app updates itself from the GitHub release (the Mac app is the native one)
function checkForUpdates() {
  if (!app.isPackaged || process.platform === 'darwin' || process.env.TAKSIM_NO_UPDATE) return;
  try { require('electron-updater').autoUpdater.checkForUpdatesAndNotify().catch(() => {}); } catch {}
}
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.whenReady().then(async () => {
  if (process.platform === 'darwin') { Menu.setApplicationMenu(menu()); if (!icon.isEmpty()) app.dock?.setIcon(icon); }
  await connect(); await openWindow();
  checkForUpdates();
}).catch(e => { dialog.showErrorBox('taksim', e.message); app.quit(); });
app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) openWindow().catch(console.error); });
app.on('window-all-closed', () => app.quit());
// the engine this app started saves and closes its agents before the app goes
app.on('before-quit', (event) => {
  if (quitting || !engine.child) return;
  event.preventDefault();
  quitting = true;
  engine.stop().finally(() => app.quit());
});
