// Images (linuxserver.io's or any other) as Kubernetes pods, shown in a pane through
// their browser UI.
// Each pod is a bare Pod the app labels as its own, with /config on an emptyDir:
// it lasts as long as the pod, through restarts of its container and of the node,
// and goes when the pod is deleted. Like a linuxserver container, a pod keeps running
// when its pane closes, and any pane can open it again. The pane reaches the UI
// through `kubectl port-forward` on a localhost port.
//
// A pod can also mount host directories (hostPath volumes on the node, which is this
// host on a one-node cluster), so pods that mount the same one share its files.

const { execFile, spawn } = require('child_process');
const os = require('os');
const path = require('path');
const registry = require('./registry');

const MANAGED = 'app.kubernetes.io/managed-by=lan-terminal';
const IMAGE_ANNOTATION = 'lan-terminal.image';
const PORT_ANNOTATION = 'lan-terminal.port';
const MOUNTS_ANNOTATION = 'lan-terminal.mounts';
const DEFAULT_PORT = 3000; // the desktop UI in linuxserver's Selkies and KasmVNC images

// Kubernetes names (DNS-1123 labels) for namespaces and pods.
const validName = (name) => typeof name === 'string' && name.length <= 63 && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(name);
const validPort = (port) => Number.isInteger(port) && port > 0 && port < 65536;
// An absolute path with no "." or ".." parts, such as a host directory or where it
// goes in a pod.
const validPath = (p) => typeof p === 'string' && p.length <= 1024 && p.startsWith('/') && !/[\0\n]/.test(p) &&
  path.posix.normalize(p) === p && (p === '/' || !p.endsWith('/'));
const RESERVED_PATHS = ['/config', '/dev/shm']; // the pod's own volumes

// [{ host, path }]: each host directory goes to an absolute path in the pod, no two
// to the same one nor over the pod's own volumes. Throws when they cannot.
function checkMounts(mounts) {
  if (!Array.isArray(mounts) || mounts.length > 32) throw new Error('bad mounts');
  const seen = new Set(RESERVED_PATHS);
  for (const m of mounts) {
    if (!validPath(m?.host)) throw new Error(`a host directory is an absolute path: ${m?.host}`);
    if (!validPath(m.path) || m.path === '/') throw new Error(`a path in the pod is an absolute path other than /: ${m.path}`);
    if (RESERVED_PATHS.includes(m.path)) throw new Error(`${m.path} is the pod's own volume`);
    if (seen.has(m.path)) throw new Error(`two volumes go to ${m.path} in the pod`);
    seen.add(m.path);
  }
}

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

// The app's pods in every namespace: [{ namespace, name, image, app, tag, port, mounts,
// phase, ready }],
// sorted by namespace then name.
async function pods(bin) {
  const out = await kubectl(bin, ['get', 'pods', '--all-namespaces', '-l', MANAGED, '-o', 'json']);
  return JSON.parse(out).items
    .map((p) => {
      const annotations = p.metadata.annotations ?? {};
      const ref = registry.parseImage(annotations[IMAGE_ANNOTATION]);
      const port = Number(annotations[PORT_ANNOTATION]) || DEFAULT_PORT;
      let mounts = [];
      try {
        mounts = JSON.parse(annotations[MOUNTS_ANNOTATION] ?? '[]');
      } catch {}
      const ready = (p.status.conditions ?? []).some((c) => c.type === 'Ready' && c.status === 'True');
      return { namespace: p.metadata.namespace, name: p.metadata.name, image: ref ? `${ref.repo}:${ref.tag}` : null, app: ref?.app ?? null, tag: ref?.tag ?? null, port, mounts, phase: p.status.phase, ready };
    })
    .sort((a, b) => a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name, undefined, { numeric: true }));
}

// The pod for a new instance of repo:tag, run as the host user as the linuxserver
// images expect, with the shared memory and seccomp settings the desktops need, and
// mounts' host directories (see checkMounts).
function podSpec(namespace, name, repo, tag, port, mounts = []) {
  const { uid, gid } = os.userInfo();
  const image = `${repo}:${tag}`;
  const app = registry.parseImage(image).app;
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name,
      namespace,
      labels: { 'app.kubernetes.io/managed-by': 'lan-terminal', 'app.kubernetes.io/name': app.replace(/[^a-z0-9-]/g, '-') },
      annotations: { [IMAGE_ANNOTATION]: image, [PORT_ANNOTATION]: String(port), [MOUNTS_ANNOTATION]: JSON.stringify(mounts) },
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
        volumeMounts: [
          { name: 'config', mountPath: '/config' },
          { name: 'shm', mountPath: '/dev/shm' },
          ...mounts.map((m, i) => ({ name: `host-${i}`, mountPath: m.path })),
        ],
      }],
      volumes: [
        { name: 'config', emptyDir: {} },
        { name: 'shm', emptyDir: { medium: 'Memory', sizeLimit: '1Gi' } },
        ...mounts.map((m, i) => ({ name: `host-${i}`, hostPath: { path: m.host, type: 'DirectoryOrCreate' } })),
      ],
    },
  };
}

// A name for a new pod of app:tag in namespace: <app>-<tag>-<n> with the smallest free
// n, the tag lowercased and its dots and underscores made dashes, as pod names need.
function freeName(app, tag, taken) {
  const part = (s) => s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  const base = [part(app) || 'app', part(tag)].filter(Boolean).join('-').slice(0, 50).replace(/-$/, '');
  for (let n = 0; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

function create(bin, namespace, name, repo, tag, port, mounts = []) {
  if (!validName(namespace) || !validName(name)) throw new Error(`bad pod: ${namespace}/${name}`);
  if (!registry.validRepo(repo) || !registry.validTag(tag) || !validPort(port)) throw new Error(`bad image: ${repo}:${tag} port ${port}`);
  checkMounts(mounts);
  return kubectl(bin, ['create', '-f', '-'], { input: JSON.stringify(podSpec(namespace, name, repo, tag, port, mounts)) });
}

// Deletes one of the app's pods, and waits for it to be gone. Pods it did not make are
// left alone.
async function remove(bin, namespace, name) {
  if (!validName(namespace) || !validName(name)) throw new Error(`bad pod: ${namespace}/${name}`);
  if (!(await pods(bin)).some((p) => p.namespace === namespace && p.name === name)) throw new Error(`${namespace}/${name} is not one of this app's pods`);
  return kubectl(bin, ['delete', 'pod', name, '-n', namespace], { timeout: 120000 });
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

module.exports = { DEFAULT_PORT, validName, validPort, validPath, checkMounts, namespaces, createNamespace, pods, podSpec, freeName, create, remove, waitReady, forward };
