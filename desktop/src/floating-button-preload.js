const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('floatingButton', {
  pointer: (phase) => ipcRenderer.send('floating-button', phase),
  onState: (callback) => ipcRenderer.on('floating-button-state', (_event, state) => callback(state)),
});
