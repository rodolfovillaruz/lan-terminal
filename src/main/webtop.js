// Webtops: full Linux desktops from linuxserver's webtop image, one Docker container
// each, shown in a pane through the desktop's browser UI. Like a multiplexer session,
// a webtop keeps running when its pane closes; stop() is the only thing that stops it.
// The app never pulls images or removes containers and volumes.

const { execFile } = require('child_process');
const http = require('http');
const os = require('os');

const IMAGE = 'lscr.io/linuxserver/webtop';
const LABEL = 'lan-terminal.webtop'; // value: the webtop's name
const TAG_LABEL = 'lan-terminal.webtop.tag';

// Names become container and volume names, so Docker's rules apply.
const validName = (name) => typeof name === 'string' && /^[A-Za-z0-9_][A-Za-z0-9_-]*$/.test(name);
const validTag = (tag) => typeof tag === 'string' && /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(tag);

// The container and its /config volume (the desktop user's home) share one name.
const container = (name) => `lan-terminal-webtop-${name}`;

function docker(bin, args, timeout = 15000) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolve(stdout);
    });
  });
}

// Tags of the webtop image that are already pulled, e.g. ['arch-kde', 'latest'].
async function images(bin) {
  const out = await docker(bin, ['images', IMAGE, '--format', '{{.Tag}}']).catch(() => '');
  return [...new Set(parseLines(out).filter((t) => t !== '<none>'))].sort();
}

const parseLines = (out) => out.split('\n').map((l) => l.trim()).filter(Boolean);

// "name\tstate\ttag" lines from `docker ps` -> Map name -> { running, tag }.
function parseList(out) {
  const found = new Map();
  for (const line of parseLines(out)) {
    const [name, state, tag] = line.split('\t');
    if (validName(name)) found.set(name, { running: state === 'running', tag: tag || 'latest' });
  }
  return found;
}

// The app's webtop containers, running or stopped.
async function list(bin) {
  const format = `{{.Label "${LABEL}"}}\t{{.State}}\t{{.Label "${TAG_LABEL}"}}`;
  const out = await docker(bin, ['ps', '-a', '--filter', `label=${LABEL}`, '--format', format]).catch(() => '');
  return parseList(out);
}

// Arguments for a new webtop container. The desktop runs as the host user, like the
// linuxserver images expect, and listens only on a localhost port that Docker picks.
function runArgs(name, tag) {
  const { uid, gid } = os.userInfo();
  return [
    'run', '-d',
    '--name', container(name),
    '--label', `${LABEL}=${name}`,
    '--label', `${TAG_LABEL}=${tag}`,
    '-e', `PUID=${uid}`,
    '-e', `PGID=${gid}`,
    '-e', `TZ=${Intl.DateTimeFormat().resolvedOptions().timeZone || 'Etc/UTC'}`,
    '-p', '127.0.0.1::3000',
    '--shm-size', '1g',
    '--security-opt', 'seccomp=unconfined',
    '-v', `${container(name)}:/config`,
    `${IMAGE}:${tag}`,
  ];
}

// Resolves once the desktop's web server answers, so the pane never shows a refused
// connection while the container boots.
function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get(url, (res) => {
        res.resume();
        resolve();
      });
      req.setTimeout(2000, () => req.destroy());
      req.on('error', () => {
        if (Date.now() > deadline) reject(new Error('the desktop did not start in time'));
        else setTimeout(attempt, 500);
      });
    };
    attempt();
  });
}

// Starts webtop name (a new container from tag if there is none, or the stopped one)
// and returns the URL of its desktop.
async function ensure(bin, name, tag) {
  if (!validName(name)) throw new Error(`bad webtop name: ${name}`);
  const existing = (await list(bin)).get(name);
  if (!existing) {
    if (!validTag(tag)) throw new Error(`bad webtop image tag: ${tag}`);
    await docker(bin, runArgs(name, tag), 60000);
  } else if (!existing.running) {
    await docker(bin, ['start', container(name)], 60000);
  }
  // "127.0.0.1:49153", one line per published address.
  const port = parseLines(await docker(bin, ['port', container(name), '3000/tcp']))[0]?.split(':').pop();
  if (!port) throw new Error('the container publishes no desktop port');
  const url = `http://127.0.0.1:${port}/`;
  await waitForHttp(url, 90000);
  return url;
}

// Stops the container; it and its volume stay, so picking it again starts it.
function stop(bin, name) {
  if (!validName(name)) throw new Error(`bad webtop name: ${name}`);
  return docker(bin, ['stop', container(name)], 60000);
}

module.exports = { validName, validTag, container, images, list, parseList, runArgs, ensure, stop };
