const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('terminal', {
  getConfig: () => ipcRenderer.invoke('terminal:config'),
  write: (data) => ipcRenderer.send('pty:input', data),
  ready: () => ipcRenderer.send('pty:ready'),
  resize: (cols, rows) => ipcRenderer.send('pty:resize', cols, rows),
  onData: (cb) => ipcRenderer.on('pty:data', (_e, data) => cb(data)),
  onMoveMode: (cb) => ipcRenderer.on('moveMode', (_e, enabled) => cb(enabled)),
  onPresenterMode: (cb) => ipcRenderer.on('presenterMode', (_e, enabled) => cb(enabled)),
  exitMoveMode: () => ipcRenderer.send('moveMode:exit'),
  moveStart: () => ipcRenderer.send('move:start'),
  moveDrag: () => ipcRenderer.send('move:drag'),
  moveEnd: () => ipcRenderer.send('move:end'),
});
