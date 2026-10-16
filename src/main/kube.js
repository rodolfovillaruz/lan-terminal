// linuxserver.io images as Kubernetes pods, shown in a pane through their browser UI.
// Each pod is a bare Pod the app labels as its own, with /config on an emptyDir:
// it lasts as long as the pod, through restarts of its container and of the node,
// and goes when the pod is deleted. Like a linuxserver container, a pod keeps running
// when its pane closes, and any pane can open it again. The pane reaches the UI
// through `kubectl port-forward` on a localhost port.

const { execFile, spawn } = require('child_process');
const os = require('os');
const ls = require('./linuxserver');

const CATALOG_URL = 'https://api.linuxserver.io/api/v1/images';
const CATALOG_TTL = 60 * 60 * 1000;
const MANAGED = 'app.kubernetes.io/managed-by=lan-terminal';
const IMAGE_ANNOTATION = 'lan-terminal.image';
const PORT_ANNOTATION = 'lan-terminal.port';
const DEFAULT_PORT = 3000; // the desktop UI in linuxserver's Selkies and KasmVNC images

// Kubernetes names (DNS-1123 labels) for namespaces and pods.
const validName = (name) => typeof name === 'string' && name.length <= 63 && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(name);
const validPort = (port) => Number.isInteger(port) && port > 0 && port < 65536;

function kubectl(bin, args, { timeout = 15000, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(bin, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolve(stdout);
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

async function namespaces(bin) {
  const out = await kubectl(bin, ['get', 'namespaces', '-o', 'jsonpath={.items[*].metadata.name}']);
  return out.split(/\s+/).filter(Boolean).sort();
}

function createNamespace(bin, name) {
  if (!validName(name)) throw new Error('a namespace name is lowercase letters, digits and dashes');
  return kubectl(bin, ['create', 'namespace', name]);
}

// The app's pods in every namespace: [{ namespace, name, app, tag, port, phase, ready }],
// sorted by namespace then name.
async function pods(bin) {
  const out = await kubectl(bin, ['get', 'pods', '--all-namespaces', '-l', MANAGED, '-o', 'json']);
  return JSON.parse(out).items
    .map((p) => {
      const ref = ls.parseImage(p.metadata.annotations?.[IMAGE_ANNOTATION]) ?? {};
      const port = Number(p.metadata.annotations?.[PORT_ANNOTATION]) || DEFAULT_PORT;
      const ready = (p.status.conditions ?? []).some((c) => c.type === 'Ready' && c.status === 'True');
      return { namespace: p.metadata.namespace, name: p.metadata.name, app: ref.app ?? null, tag: ref.tag ?? null, port, phase: p.status.phase, ready };
    })
    .sort((a, b) => a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name, undefined, { numeric: true }));
}

// The pod for a new instance of app:tag, run as the host user as the linuxserver
// images expect, with the shared memory and seccomp settings the desktops need.
function podSpec(namespace, name, app, tag, port) {
  const { uid, gid } = os.userInfo();
  const image = `lscr.io/linuxserver/${app}:${tag}`;
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name,
      namespace,
      labels: { 'app.kubernetes.io/managed-by': 'lan-terminal', 'app.kubernetes.io/name': app.replace(/[^a-z0-9-]/g, '-') },
      annotations: { [IMAGE_ANNOTATION]: image, [PORT_ANNOTATION]: String(port) },
    },
    spec: {
      restartPolicy: 'Always',
      securityContext: { seccompProfile: { type: 'Unconfined' } },
      containers: [{
        name: 'app',
        image,
        env: [
          { name: 'PUID', value: String(uid) },
          { name: 'PGID', value: String(gid) },
          { name: 'TZ', value: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Etc/UTC' },
        ],
        ports: [{ containerPort: port }],
        volumeMounts: [{ name: 'config', mountPath: '/config' }, { name: 'shm', mountPath: '/dev/shm' }],
      }],
      volumes: [{ name: 'config', emptyDir: {} }, { name: 'shm', emptyDir: { medium: 'Memory', sizeLimit: '1Gi' } }],
    },
  };
}

// A name for a new pod of app in namespace: <app>-<n> with the smallest free n.
function freeName(app, taken) {
  const base = app.replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'app';
  for (let n = 0; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

function create(bin, namespace, name, app, tag, port) {
  if (!validName(namespace) || !validName(name)) throw new Error(`bad pod: ${namespace}/${name}`);
  if (!ls.validApp(app) || !ls.validTag(tag) || !validPort(port)) throw new Error(`bad image: ${app}:${tag} port ${port}`);
  return kubectl(bin, ['create', '-f', '-'], { input: JSON.stringify(podSpec(namespace, name, app, tag, port)) });
}

// Waits for the pod to be ready; pulling a desktop image the first time takes minutes.
function waitReady(bin, namespace, name) {
  return kubectl(bin, ['wait', '--for=condition=Ready', `pod/${name}`, '-n', namespace, '--timeout=900s'], { timeout: 910000 });
}

// Forwards a localhost port that kubectl picks to the pod's port. Resolves with
// { child, url } once kubectl says where it listens; the child ends when the pod
// goes away or restarts.
function forward(bin, namespace, name, port) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['port-forward', '-n', namespace, `pod/${name}`, `:${port}`, '--address', '127.0.0.1'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    let out = '';
    child.stderr.on('data', (d) => { err += d; });
    child.stdout.on('data', (d) => {
      out += d;
      // "Forwarding from 127.0.0.1:41234 -> 3000"
      const m = out.match(/Forwarding from 127\.0\.0\.1:(\d+)/);
      if (m) resolve({ child, url: `http://127.0.0.1:${m[1]}/` });
    });
    child.on('error', reject);
    child.on('exit', () => reject(new Error(err.trim() || 'kubectl port-forward stopped')));
  });
}

// linuxserver's image catalog: [{ name, category, description, tags }], without the
// deprecated images. Kept for an hour.
let catalogCache = null;
async function catalog() {
  if (catalogCache && Date.now() - catalogCache.at < CATALOG_TTL) return catalogCache.images;
  const res = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`the linuxserver catalog answered ${res.status}`);
  const images = (await res.json()).data.repositories.linuxserver
    .filter((i) => !i.deprecated && ls.validApp(i.name))
    .map((i) => ({ name: i.name, category: i.category ?? '', description: i.description ?? '', tags: (i.tags ?? []).map((t) => t.tag).filter(ls.validTag) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  catalogCache = { images, at: Date.now() };
  return images;
}

module.exports = { DEFAULT_PORT, validName, validPort, namespaces, createNamespace, pods, podSpec, freeName, create, waitReady, forward, catalog };
