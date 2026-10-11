const { contextBridge, ipcRenderer } = require('electron');

// One planner tiles every capture window; window ids pick which window a pane edit is for.
contextBridge.exposeInMainWorld('planner', {
  getState: () => ipcRenderer.invoke('planner:state'),
  onState: (cb) => ipcRenderer.on('planner:state', (_e, state) => cb(state)),
  split: (windowId, paneId, dir) => ipcRenderer.send('planner:split', windowId, paneId, dir),
  close: (windowId, paneId) => ipcRenderer.send('planner:close', windowId, paneId),
  swap: (windowId, a, b) => ipcRenderer.send('planner:swap', windowId, a, b),
  resize: (windowId, path, sizes) => ipcRenderer.send('planner:resize', windowId, path, sizes),
  select: (windowId, paneId) => ipcRenderer.send('planner:select', windowId, paneId),
  tileSplit: (windowId, dir) => ipcRenderer.send('planner:tile-split', windowId, dir),
  tileClose: (windowId) => ipcRenderer.send('planner:tile-close', windowId),
  tileSwap: (a, b) => ipcRenderer.send('planner:tile-swap', a, b),
  tileResize: (path, sizes) => ipcRenderer.send('planner:tile-resize', path, sizes),
  untile: () => ipcRenderer.send('planner:untile'),
});
