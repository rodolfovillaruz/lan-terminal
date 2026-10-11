const { Tray, Menu, nativeImage, clipboard, app } = require('electron');
const path = require('path');
const os = require('os');

function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
}

function createTray(config, windows) {
  const icon = nativeImage.createFromPath(path.join(__dirname, '..', '..', 'assets', 'tray.png'));
  const tray = new Tray(icon);
  tray.setToolTip('LAN Terminal');

  const build = (list = windows.list()) => {
    const windowItems = list.length
      ? list.map((w) => ({
          // An item with a submenu cannot also be a radio, so a dot marks the focused window.
          label: `${w.focused ? '●' : '○'}  ${w.title === w.process ? w.process : `${w.process} — ${w.title}`}`,
          submenu: [
            { label: 'Select capture window', click: () => windows.focus(w.id) },
            { label: `Plan layout… (${w.panes.length} ${w.panes.length === 1 ? 'pane' : 'panes'})`, click: () => windows.openPlanner(w.id) },
          ],
        }))
      : [{ label: 'No open windows', enabled: false }];

    const urls = lanAddresses().map((ip) => `http://${ip}:${config.port}`);
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Focus window', enabled: false },
        ...windowItems,
        { type: 'separator' },
        { label: 'New window', click: () => windows.create() },
        { type: 'separator' },
        ...urls.map((u) => ({ label: `API: ${u}`, enabled: false })),
        { label: 'Copy API token', click: () => clipboard.writeText(config.token) },
        { type: 'separator' },
        {
          label: 'Presenter mode',
          type: 'checkbox',
          checked: config.presenterMode,
          click: (item) => windows.setPresenterMode(item.checked),
        },
        { type: 'separator' },
        { label: 'Quit', click: () => app.quit() },
      ]),
    );
  };

  windows.on('changed', build);
  build();
  return tray;
}

module.exports = { createTray };
