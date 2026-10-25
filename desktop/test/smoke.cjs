// Run with Electron against a disposable/local engine: electron desktop/test/smoke.cjs
const assert = require('node:assert/strict');
const { app, BrowserWindow, dialog } = require('electron');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const home = mkdtempSync(join(tmpdir(), 'taksim-electron-test-'));
app.setPath('userData', home);
let canceled = false, options;
dialog.showOpenDialog = async (_window, opts) => { options = opts; return { canceled, filePaths: canceled ? [] : [tmpdir()] }; };
require('../main.cjs');
app.whenReady().then(async () => {
  try {
    let w;
    for (let i = 0; i < 150; i++) {
      w = BrowserWindow.getAllWindows()[0];
      if (w && await w.webContents.executeJavaScript('!!window.taksim?.store').catch(() => false)) break;
      await new Promise(r => setTimeout(r, 100));
    }
    assert.ok(w);
    const chrome = await w.webContents.executeJavaScript(`({ platform: document.documentElement.dataset.desktop, drag: getComputedStyle(document.querySelector('header')).getPropertyValue('-webkit-app-region'), button: getComputedStyle(document.querySelector('header button')).getPropertyValue('-webkit-app-region') })`);
    assert.equal(chrome.platform, process.platform);
    assert.equal(chrome.drag, 'drag');
    assert.equal(chrome.button, 'no-drag');
    const result = await w.webContents.executeJavaScript(`(async () => { const {api} = await import('/ui/app/api.mjs'); return { folder: await api.post('/v1/pick-folder', {start: '/tmp'}), node: typeof require }; })()`);
    assert.equal(result.node, 'undefined');
    assert.equal(result.folder.path, tmpdir());
    assert.ok(options.properties.includes('openDirectory'));
    canceled = true;
    const cancel = await w.webContents.executeJavaScript(`(async () => { taksim.welcome.close(); const before = taksim.store.currentAgents.length; await taksim.quickAdd(); return {before, after: taksim.store.currentAgents.length, sheet: !!document.querySelector('.sheet-scrim')}; })()`);
    assert.equal(cancel.before, cancel.after);
    assert.equal(cancel.sheet, false);
    const models = await w.webContents.executeJavaScript(`(async () => { await taksim.store.loadChoices(); return taksim.store.models.filter(m => m.owned_by === 'antigravity').map(m => m.display_name); })()`);
    assert.ok(models.length);
    assert.ok(models.every(n => n && n !== 'agy' && !n.startsWith('agy:')));
    console.log('Electron smoke passed: sandbox, native folder bridge, cancellation, Antigravity names');
    app.exit(0);
  } catch (e) { console.error(e); app.exit(1); }
});
app.on('quit', () => { try { rmSync(home, {recursive: true, force: true}); } catch {} });
