const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ury', {
  getState: () => ipcRenderer.invoke('get-state'),
  pair: (data) => ipcRenderer.invoke('pair', data),
  setSite: (siteUrl) => ipcRenderer.invoke('set-site', siteUrl),
  unpair: () => ipcRenderer.invoke('unpair'),
  listPrinters: () => ipcRenderer.invoke('list-printers'),
  testPrint: (printer) => ipcRenderer.invoke('test-print', printer),
  openPos: () => ipcRenderer.invoke('open-pos'),
  onStatus: (callback) => ipcRenderer.on('agent-status', (_event, status) => callback(status)),
});
