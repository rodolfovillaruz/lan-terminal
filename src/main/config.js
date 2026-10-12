const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const CONFIG_DIR = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'lan-terminal');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
// Each Android device's apps, as last listed, so a pane's app menu opens at once
// after a restart: { <adb serial>: { apps: [{ name, package, system }], at } }.
const DEVICE_APPS_PATH = path.join(CONFIG_DIR, 'device-apps.json');

const DEFAULTS = {
  host: '0.0.0.0',
  port: 8765,
  token: null, // generated on first run
  shell: null, // null = use $SHELL / the account's login shell
  shellArgs: ['-l'],
  // Multiplexer binaries for session panes; null = find on $PATH or in ~/.cargo/bin.
  ptmux: null,
  tmux: null,
  screen: null,
  docker: null, // for linuxserver app panes (webtop, chromium, ...); null = find on $PATH
  // For Android device panes; null = find on $PATH (adb also in the Android SDK).
  adb: null,
  scrcpy: null,
  scrcpyDisplays: [], // more new-display sizes for the pane menu, e.g. "1920x1080/240"
  scrcpyKeepApps: false, // closing a new display moves its apps to the main screen
  scrcpyApps: {}, // per adb serial, the apps (packages) Open app… offers; none = all
  scrcpyImePolicy: null, // where a new display's keyboard shows: "local", "fallback", "hide"
  scrcpyAudio: true, // play a device's sound in its pane (Android 11 or later)
  scrcpyAudioDup: false, // keep the sound playing on the device too (Android 13 or later)
  recentPages: [], // the web pages opened last, newest first, for the pane menu
  fontSize: 16,
  width: null, // null = primary display width
  height: null, // null = primary display height
  background: '#000000',
  foreground: '#e6e6e6',
  presenterMode: true, // move mode shows only the move cursor, no overlay or hint
  windows: null, // each window's pane split shape and lock, restored on startup
};

function load() {
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`Could not read ${CONFIG_PATH}:`, err.message);
  }

  const config = { ...DEFAULTS, ...stored };
  // Older builds saved one window's pane shape as layout, then a window tiling whose
  // leaves held each window's panes.
  if (!config.windows && config.tiling) {
    const tiles = (s) => (s && 'panes' in s ? [s.panes] : (s?.children || []).flatMap(tiles));
    config.windows = tiles(config.tiling);
  }
  if (!config.windows && config.layout) config.windows = [config.layout];
  delete config.layout;
  delete config.tiling;
  // Entries were bare pane shapes before windows could be locked.
  if (Array.isArray(config.windows)) {
    config.windows = config.windows.map((w) =>
      typeof w === 'string' || (w && 'dir' in w) ? { panes: w, locked: false } : w);
  }
  if (!config.token) config.token = crypto.randomBytes(24).toString('base64url');

  // Write back so new defaults and the generated token are visible to the user.
  if (JSON.stringify(config) !== JSON.stringify(stored)) save(config);
  return config;
}

function save(config) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
}

function loadDeviceApps() {
  try {
    const stored = JSON.parse(fs.readFileSync(DEVICE_APPS_PATH, 'utf8'));
    return stored && typeof stored === 'object' ? stored : {};
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`Could not read ${DEVICE_APPS_PATH}:`, err.message);
    return {};
  }
}

// Written to a temporary file first, so a crash mid-write leaves the old lists.
function saveDeviceApps(lists) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const tmp = `${DEVICE_APPS_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(lists) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, DEVICE_APPS_PATH);
}

module.exports = { load, save, loadDeviceApps, saveDeviceApps, CONFIG_PATH };
