const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ury', {
  getState: () => ipcRenderer.invoke('get-state'),
  pair: (data) => ipcRenderer.invoke('pair', data),
  setSite: (siteUrl) => ipcRenderer.invoke('set-site', siteUrl),
  unpair: () => ipcRenderer.invoke('unpair'),
  listPrinters: () => ipcRenderer.invoke('list-printers'),
  testPrint: (printer) => ipcRenderer.invoke('test-print', printer),
  openPos: () => ipcRenderer.invoke('open-pos'),
  setScreen: (settings) => ipcRenderer.invoke('set-screen', settings),
  onStatus: (callback) => ipcRenderer.on('agent-status', (_event, status) => callback(status)),
  checkUpdate: () => ipcRenderer.invoke('check-update'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  updateNow: () => ipcRenderer.invoke('update-now'),
  setEscpos: (printerName, on) => ipcRenderer.invoke('set-escpos', { printerName, on }),
  onUpdate: (callback) => ipcRenderer.on('update-status', (_event, status) => callback(status)),
});
