const { contextBridge, ipcRenderer } = require('electron');

// One planner shows every capture window; window ids pick which window an edit is for.
contextBridge.exposeInMainWorld('planner', {
  getState: () => ipcRenderer.invoke('planner:state'),
  onState: (cb) => ipcRenderer.on('planner:state', (_e, state) => cb(state)),
  split: (windowId, paneId, dir) => ipcRenderer.send('planner:split', windowId, paneId, dir),
  close: (windowId, paneId) => ipcRenderer.send('planner:close', windowId, paneId),
  move: (fromId, paneId, toId, targetId, zone) => ipcRenderer.send('planner:move', fromId, paneId, toId, targetId, zone),
  resize: (windowId, path, sizes) => ipcRenderer.send('planner:resize', windowId, path, sizes),
  select: (windowId, paneId) => ipcRenderer.send('planner:select', windowId, paneId),
  newWindow: () => ipcRenderer.send('planner:new-window'),
  closeWindow: (windowId) => ipcRenderer.send('planner:close-window', windowId),
  focusWindow: (windowId) => ipcRenderer.send('planner:focus-window', windowId),
});
