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

  const label = (w) => {
    if (w.panes.length === 0) return 'Empty window (locked)';
    const name = w.app ? `${w.app} ${w.instance}` : w.session ? `${w.mux} ${w.session}` : w.process;
    return w.title === name || w.title === w.process ? name : `${name} — ${w.title}`;
  };

  const build = (list = windows.list()) => {
    const windowItems = list.length
      ? list.map((w) => ({
          label: label(w),
          type: 'radio',
          checked: w.focused,
          click: () => windows.focus(w.id),
        }))
      : [{ label: 'No open windows', enabled: false }];

    const urls = lanAddresses().map((ip) => `http://${ip}:${config.port}`);
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Focus window', enabled: false },
        ...windowItems,
        { type: 'separator' },
        { label: 'New window', click: () => windows.create() },
        { label: 'Plan layout…', click: () => windows.openPlanner() },
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
