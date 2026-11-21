const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('keyboardButton', {
  pointer: (phase) => ipcRenderer.send('keyboard-button', phase),
});
