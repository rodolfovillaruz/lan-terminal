const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('terminal', {
  getConfig: () => ipcRenderer.invoke('terminal:config'),
  ready: () => ipcRenderer.send('term:ready'),
  paneReady: (paneId) => ipcRenderer.send('pty:ready', paneId),
  write: (paneId, data) => ipcRenderer.send('pty:input', paneId, data),
  resize: (paneId, cols, rows) => ipcRenderer.send('pty:resize', paneId, cols, rows),
  focusPane: (paneId) => ipcRenderer.send('pane:focus', paneId),
  // Web page panes: where the page went, and reloads asked for from the planner.
  pageState: (paneId, url, title) => ipcRenderer.send('page:state', paneId, url, title),
  onPageReload: (cb) => ipcRenderer.on('page:reload', (_e, paneId) => cb(paneId)),
  // Camera panes: fitting a pane's height to its video resizes the split above it.
  onCameraFitHeight: (cb) => ipcRenderer.on('camera:fit-height', (_e, paneId) => cb(paneId)),
  resizeSplit: (splitPath, sizes) => ipcRenderer.send('pane:resize-split', splitPath, sizes),
  // A new pane's form: what it offers, a new namespace, and opening a pod or a shell
  // ('pod:<ns>:<name>', 'pod:new:<ns>:<app>:<tag>:<port>' or 'shell'). The last two
  // resolve with an error message, or null.
  launcherState: () => ipcRenderer.invoke('launcher:state'),
  createNamespace: (name) => ipcRenderer.invoke('launcher:namespace', name),
  launch: (paneId, choice) => ipcRenderer.invoke('launcher:open', paneId, choice),
  // true when the dialog says yes; then deletePod answers null, or an error message.
  confirmDeletePod: (namespace, pod) => ipcRenderer.invoke('launcher:confirm-delete-pod', namespace, pod),
  deletePod: (namespace, pod) => ipcRenderer.invoke('launcher:delete-pod', namespace, pod),
  copy: (text) => ipcRenderer.send('clipboard:write', text),
  paste: () => ipcRenderer.invoke('clipboard:read'),
  // Android device panes: the video stream in, touch and key events out.
  scrcpyReady: (paneId) => ipcRenderer.send('scrcpy:ready', paneId),
  scrcpyInput: (paneId, msg) => ipcRenderer.send('scrcpy:input', paneId, msg),
  scrcpyResize: (paneId, width, height) => ipcRenderer.send('scrcpy:resize', paneId, width, height),
  scrcpyCapture: (paneId, on) => ipcRenderer.send('scrcpy:capture', paneId, on),
  scrcpyHidKey: (paneId, code, down) => ipcRenderer.send('scrcpy:hid-key', paneId, code, down),
  scrcpyHidMouse: (paneId, motion) => ipcRenderer.send('scrcpy:hid-mouse', paneId, motion),
  onScrcpySession: (cb) => ipcRenderer.on('scrcpy:session', (_e, paneId, video) => cb(paneId, video)),
  onScrcpyPacket: (cb) => ipcRenderer.on('scrcpy:packet', (_e, paneId, packet) => cb(paneId, packet)),
  onScrcpyAudio: (cb) => ipcRenderer.on('scrcpy:audio', (_e, paneId, packet) => cb(paneId, packet)),
  onData: (cb) => ipcRenderer.on('pty:data', (_e, paneId, data) => cb(paneId, data)),
  onLayout: (cb) => ipcRenderer.on('layout', (_e, state) => cb(state)),
  onMoveMode: (cb) => ipcRenderer.on('moveMode', (_e, enabled) => cb(enabled)),
  onPresenterMode: (cb) => ipcRenderer.on('presenterMode', (_e, enabled) => cb(enabled)),
  exitMoveMode: () => ipcRenderer.send('moveMode:exit'),
  onResizeMode: (cb) => ipcRenderer.on('resizeMode', (_e, enabled) => cb(enabled)),
  exitResizeMode: () => ipcRenderer.send('resizeMode:exit'),
  // Resize mode's pane tools. zone: 'center' (trade places) or a side of the target.
  closePane: (paneId) => ipcRenderer.send('pane:close', paneId),
  homePane: (paneId) => ipcRenderer.send('pane:home', paneId),
  pinPane: (paneId, on) => ipcRenderer.send('pane:pin', paneId, on),
  maximizePane: (paneId) => ipcRenderer.send('pane:maximize', paneId),
  reloadPane: (paneId) => ipcRenderer.send('pane:reload', paneId),
  movePane: (paneId, targetId, zone) => ipcRenderer.send('pane:move', paneId, targetId, zone),
  // side: 'left', 'right', 'top' or 'bottom' of the pane.
  splitPane: (paneId, side) => ipcRenderer.send('pane:split', paneId, side),
  moveStart: () => ipcRenderer.send('move:start'),
  moveDrag: () => ipcRenderer.send('move:drag'),
  moveEnd: () => ipcRenderer.send('move:end'),
});
