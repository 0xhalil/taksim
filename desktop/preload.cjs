const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('taksimDesktop', {
  platform: process.platform,
  pickFolder: (start) => ipcRenderer.invoke('taksim:pick-folder', start),
  // the menu bar: its labels in the app's language, its commands run by the page
  setMenu: (labels) => ipcRenderer.send('taksim:menu', labels),
  onCommand: (fn) => { ipcRenderer.on('taksim:command', (_e, command, n) => fn(String(command), Number(n) || 0)); },
});
