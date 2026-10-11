const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('terminal', {
  getConfig: () => ipcRenderer.invoke('terminal:config'),
  ready: () => ipcRenderer.send('term:ready'),
  paneReady: (paneId) => ipcRenderer.send('pty:ready', paneId),
  write: (paneId, data) => ipcRenderer.send('pty:input', paneId, data),
  resize: (paneId, cols, rows) => ipcRenderer.send('pty:resize', paneId, cols, rows),
  focusPane: (paneId) => ipcRenderer.send('pane:focus', paneId),
  // Android device panes: the video stream in, touch and key events out.
  scrcpyReady: (paneId) => ipcRenderer.send('scrcpy:ready', paneId),
  scrcpyInput: (paneId, msg) => ipcRenderer.send('scrcpy:input', paneId, msg),
  onScrcpySession: (cb) => ipcRenderer.on('scrcpy:session', (_e, paneId, video) => cb(paneId, video)),
  onScrcpyPacket: (cb) => ipcRenderer.on('scrcpy:packet', (_e, paneId, packet) => cb(paneId, packet)),
  onData: (cb) => ipcRenderer.on('pty:data', (_e, paneId, data) => cb(paneId, data)),
  onLayout: (cb) => ipcRenderer.on('layout', (_e, state) => cb(state)),
  onMoveMode: (cb) => ipcRenderer.on('moveMode', (_e, enabled) => cb(enabled)),
  onPresenterMode: (cb) => ipcRenderer.on('presenterMode', (_e, enabled) => cb(enabled)),
  exitMoveMode: () => ipcRenderer.send('moveMode:exit'),
  moveStart: () => ipcRenderer.send('move:start'),
  moveDrag: () => ipcRenderer.send('move:drag'),
  moveEnd: () => ipcRenderer.send('move:end'),
});
