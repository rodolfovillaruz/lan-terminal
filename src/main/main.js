const { app } = require('electron');

// Native Wayland does not let a client position its own windows or take focus,
// so run through XWayland where setPosition(0, 0) and focus() work under KWin.
// Electron picks the display backend before this file runs, so the switch must be
// on the real command line; relaunch with it if we were started without it.
const X11_FLAG = '--ozone-platform=x11';
const needsRelaunch = process.platform === 'linux' && !process.argv.includes(X11_FLAG);

if (needsRelaunch) {
  app.relaunch({ args: [X11_FLAG, ...process.argv.slice(1)] });
  app.exit(0);
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  start();
}

function start() {
  const config = require('./config');
  const { WindowManager } = require('./windowManager');
  const { startApi } = require('./api');
  const { createTray } = require('./tray');

  let windows;
  let tray; // keep a reference so the tray icon is not garbage-collected

  // Launching the app again opens another terminal instead of a second process.
  app.on('second-instance', () => windows?.create());

  // The tray keeps the app alive with zero windows; quit only from the tray menu.
  app.on('window-all-closed', () => {});

  app.whenReady().then(() => {
    const cfg = config.load();
    windows = new WindowManager(cfg);
    tray = createTray(cfg, windows);
    startApi(cfg, windows);
    windows.create();
    console.log(`Config: ${config.CONFIG_PATH}`);
  });
}
