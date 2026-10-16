// linuxserver.io desktop apps (webtop, chromium, ...): one Docker container each,
// shown in a pane through the app's browser UI on port 3000. Like a multiplexer
// session, an app keeps running when its pane closes; stop() is the only thing that
// stops it. The app never pulls images or removes containers and volumes.
//
// An instance is (app, name): the container and its /config volume are both
// lan-terminal-<app>-<name>, e.g. lan-terminal-chromium-0.
//
// A container that something else runs, such as docker compose, can be shown too: it
// carries the label lan-terminal.pane=<name> and publishes port 3000 on the host. The
// app starts it when it is stopped, and never creates, stops or removes it.

const { execFile } = require('child_process');
const http = require('http');
const os = require('os');

const REGISTRY = 'lscr.io/linuxserver/';
const PORT = '3000/tcp'; // the desktop UI in linuxserver's Selkies and KasmVNC images
const IMAGE_LABEL = 'lan-terminal.image';
const PANE_LABEL = 'lan-terminal.pane';

// Names become container and volume names, so Docker's rules apply.
const validName = (name) => typeof name === 'string' && /^[A-Za-z0-9_][A-Za-z0-9_-]*$/.test(name);
const validApp = (app) => typeof app === 'string' && /^[a-z0-9][a-z0-9_.-]*$/.test(app);
const validTag = (tag) => typeof tag === 'string' && /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(tag);

const container = (app, name) => `lan-terminal-${app}-${name}`;
const image = (app, tag) => `${REGISTRY}${app}:${tag}`;

function docker(bin, args, timeout = 15000) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolve(stdout);
    });
  });
}

const parseLines = (out) => out.split('\n').map((l) => l.trim()).filter(Boolean);

// "lscr.io/linuxserver/webtop:arch-kde" -> { app: 'webtop', tag: 'arch-kde' }
function parseImage(ref) {
  if (typeof ref !== 'string' || !ref.startsWith(REGISTRY)) return null;
  const [app, tag = 'latest'] = ref.slice(REGISTRY.length).split(':');
  return validApp(app) && validTag(tag) ? { app, tag } : null;
}

// Pulled linuxserver images that serve a desktop UI, as [{ app, tag }] sorted by
// app then tag. Images without port 3000 (linuxserver's server apps) are left out.
async function images(bin) {
  const refs = parseLines(
    await docker(bin, ['images', '--filter', `reference=${REGISTRY}*`, '--format', '{{.Repository}}:{{.Tag}}']).catch(() => ''),
  ).filter((ref) => parseImage(ref));
  if (refs.length === 0) return [];
  const ports = parseLines(await docker(bin, ['image', 'inspect', ...refs, '--format', '{{json .Config.ExposedPorts}}']).catch(() => ''));
  return refs
    .filter((_, i) => ports[i]?.includes(`"${PORT}"`))
    .map(parseImage)
    .sort((a, b) => a.app.localeCompare(b.app) || a.tag.localeCompare(b.tag));
}

// "container\tstate\timage\timage label" lines -> [{ app, name, tag, running }]. The
// label wins when present, since .Image turns into an id once a tag moves on. Webtops
// from before this module carry no label, and their .Image names them.
function parseList(out) {
  const found = [];
  for (const line of parseLines(out)) {
    const [cname, state, img, label] = line.split('\t');
    const ref = parseImage(label || img);
    const prefix = ref && `lan-terminal-${ref.app}-`;
    const name = ref && cname.startsWith(prefix) ? cname.slice(prefix.length) : null;
    if (validName(name)) found.push({ ...ref, name, running: state === 'running' });
  }
  return found.sort((a, b) => a.app.localeCompare(b.app) || a.name.localeCompare(b.name, undefined, { numeric: true }));
}

// The app's linuxserver containers, running or stopped.
async function list(bin) {
  const format = `{{.Names}}\t{{.State}}\t{{.Image}}\t{{.Label "${IMAGE_LABEL}"}}`;
  const out = await docker(bin, ['ps', '-a', '--filter', 'name=^lan-terminal-', '--format', format]).catch(() => '');
  return parseList(out);
}

// "container\tstate\tlabel" lines -> [{ name, container, running }], one per
// name (the first container that carries it), sorted by name.
function parseLabelled(out) {
  const found = new Map();
  for (const line of parseLines(out)) {
    const [cname, state, name] = line.split('\t');
    if (validName(name) && !found.has(name)) found.set(name, { name, container: cname, running: state === 'running' });
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// Containers labelled lan-terminal.pane, running or stopped.
async function labelled(bin) {
  const format = `{{.Names}}\t{{.State}}\t{{.Label "${PANE_LABEL}"}}`;
  const out = await docker(bin, ['ps', '-a', '--filter', `label=${PANE_LABEL}`, '--format', format]).catch(() => '');
  return parseLabelled(out);
}

// Arguments for a new container. The app runs as the host user, as the linuxserver
// images expect, and listens only on a localhost port that Docker picks.
function runArgs(app, name, tag) {
  const { uid, gid } = os.userInfo();
  return [
    'run', '-d',
    '--name', container(app, name),
    '--label', `${IMAGE_LABEL}=${image(app, tag)}`,
    '-e', `PUID=${uid}`,
    '-e', `PGID=${gid}`,
    '-e', `TZ=${Intl.DateTimeFormat().resolvedOptions().timeZone || 'Etc/UTC'}`,
    '-p', `127.0.0.1::${PORT}`,
    '--shm-size', '1g',
    '--security-opt', 'seccomp=unconfined',
    '-v', `${container(app, name)}:/config`,
    image(app, tag),
  ];
}

// Resolves once the app's web server answers, so the pane never shows a refused
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
        if (Date.now() > deadline) reject(new Error('the app did not start in time'));
        else setTimeout(attempt, 500);
      });
    };
    attempt();
  });
}

// Starts instance (app, name), from a new container on tag if there is none or by
// starting the stopped one, and returns the URL of its UI.
async function ensure(bin, app, name, tag) {
  if (!validApp(app) || !validName(name)) throw new Error(`bad app instance: ${app} ${name}`);
  const existing = (await list(bin)).find((c) => c.app === app && c.name === name);
  if (!existing) {
    if (!validTag(tag)) throw new Error(`bad image tag: ${tag}`);
    await docker(bin, runArgs(app, name, tag), 60000);
  } else if (!existing.running) {
    await docker(bin, ['start', container(app, name)], 60000);
  }
  return uiUrl(bin, container(app, name));
}

// The URL of a running container's UI, once it answers.
async function uiUrl(bin, cname, hint = '') {
  // "127.0.0.1:49153", one line per published address.
  const port = parseLines(await docker(bin, ['port', cname, PORT]).catch(() => ''))[0]?.split(':').pop();
  if (!port) throw new Error(`the container publishes no UI port${hint}`);
  const url = `http://127.0.0.1:${port}/`;
  await waitForHttp(url, 90000);
  return url;
}

// Starts the container labelled lan-terminal.pane=<name> if it is stopped, and
// returns the URL of its UI.
async function ensureLabelled(bin, name) {
  if (!validName(name)) throw new Error(`bad container name: ${name}`);
  const found = (await labelled(bin)).find((c) => c.name === name);
  if (!found) throw new Error(`no container is labelled ${PANE_LABEL}=${name}`);
  if (!found.running) await docker(bin, ['start', found.container], 60000);
  return uiUrl(bin, found.container, ` (publish port 3000, e.g. "127.0.0.1:3010:3000")`);
}

// Stops the container; it and its volume stay, so picking it again starts it.
function stop(bin, app, name) {
  if (!validApp(app) || !validName(name)) throw new Error(`bad app instance: ${app} ${name}`);
  return docker(bin, ['stop', container(app, name)], 60000);
}

module.exports = { validName, validApp, validTag, container, parseImage, parseList, parseLabelled, images, list, labelled, runArgs, waitForHttp, ensure, ensureLabelled, stop };
