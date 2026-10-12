const { contextBridge, ipcRenderer } = require('electron');

// One planner shows every capture window; window ids pick which window an edit is for.
contextBridge.exposeInMainWorld('planner', {
  getState: () => ipcRenderer.invoke('planner:state'),
  refresh: () => ipcRenderer.invoke('planner:refresh'),
  onState: (cb) => ipcRenderer.on('planner:state', (_e, state) => cb(state)),
  split: (windowId, paneId, dir) => ipcRenderer.send('planner:split', windowId, paneId, dir),
  close: (windowId, paneId) => ipcRenderer.send('planner:close', windowId, paneId),
  move: (windowId, paneId, targetId, zone) => ipcRenderer.send('planner:move', windowId, paneId, targetId, zone),
  resize: (windowId, path, sizes) => ipcRenderer.send('planner:resize', windowId, path, sizes),
  select: (windowId, paneId) => ipcRenderer.send('planner:select', windowId, paneId),
  // source: 'shell', '<mux>:new', '<mux>:<session>', 'ls:new:<app>:<tag>', 'ls:<app>:<instance>'
  // 'scrcpy:<adb serial>', 'scrcpy-display:<display>:<adb serial>',
  // 'scrcpy-app:<package>:<adb serial>' or 'page:<url>'
  setSource: (windowId, paneId, source) => ipcRenderer.send('planner:source', windowId, paneId, source),
  addPane: (windowId, source) => ipcRenderer.send('planner:add-pane', windowId, source),
  stopApp: (app, instance) => ipcRenderer.send('planner:stop-app', app, instance),
  reloadPage: (windowId, paneId) => ipcRenderer.send('planner:reload-page', windowId, paneId),
  // An Android device's apps ([{ name, package, system }]), and opening one in a device pane.
  deviceApps: (serial) => ipcRenderer.invoke('planner:device-apps', serial),
  openApp: (windowId, paneId, pkg) => ipcRenderer.send('planner:open-app', windowId, paneId, pkg),
  newWindow: () => ipcRenderer.send('planner:new-window'),
  lockWindow: (windowId, locked) => ipcRenderer.send('planner:lock-window', windowId, locked),
  closeWindow: (windowId) => ipcRenderer.send('planner:close-window', windowId),
  focusWindow: (windowId) => ipcRenderer.send('planner:focus-window', windowId),
});
