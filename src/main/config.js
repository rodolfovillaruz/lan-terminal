const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const CONFIG_DIR = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'lan-terminal');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

const DEFAULTS = {
  host: '0.0.0.0',
  port: 8765,
  token: null, // generated on first run
  shell: null, // null = use $SHELL / the account's login shell
  shellArgs: ['-l'],
  ptmux: null, // null = find ptmux on $PATH or in ~/.cargo/bin
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

module.exports = { load, save, CONFIG_PATH };
