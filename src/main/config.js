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
  fontSize: 16,
  width: null, // null = primary display width
  height: null, // null = primary display height
  background: '#000000',
  foreground: '#e6e6e6',
};

function load() {
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`Could not read ${CONFIG_PATH}:`, err.message);
  }

  const config = { ...DEFAULTS, ...stored };
  if (!config.token) config.token = crypto.randomBytes(24).toString('base64url');

  // Write back so new defaults and the generated token are visible to the user.
  if (JSON.stringify(config) !== JSON.stringify(stored)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  }
  return config;
}

module.exports = { load, CONFIG_PATH };
