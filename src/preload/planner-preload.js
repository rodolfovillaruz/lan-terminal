const { contextBridge, ipcRenderer } = require('electron');

// The main process knows which capture window this planner belongs to from the sender.
contextBridge.exposeInMainWorld('planner', {
  getState: () => ipcRenderer.invoke('planner:state'),
  onState: (cb) => ipcRenderer.on('planner:state', (_e, state) => cb(state)),
  split: (paneId, dir) => ipcRenderer.send('planner:split', paneId, dir),
  close: (paneId) => ipcRenderer.send('planner:close', paneId),
  swap: (a, b) => ipcRenderer.send('planner:swap', a, b),
  resize: (path, sizes) => ipcRenderer.send('planner:resize', path, sizes),
  select: (paneId) => ipcRenderer.send('planner:select', paneId),
});
