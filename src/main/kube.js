// Images (linuxserver.io's or any other) as Kubernetes pods, shown in a pane through
// their browser UI.
// Each pod is a bare Pod the app labels as its own, with /config on an emptyDir:
// it lasts as long as the pod, through restarts of its container and of the node,
// and goes when the pod is deleted. Like a linuxserver container, a pod keeps running
// when its pane closes, and any pane can open it again. The pane reaches the UI
// through `kubectl port-forward` on a localhost port.
//
// A pod can also mount host directories (hostPath volumes on the node, which is this
// host on a one-node cluster), so pods that mount the same one share its files, and
// use the node's NVIDIA GPUs through the nvidia RuntimeClass.

const { execFile, spawn } = require('child_process');
const os = require('os');
const path = require('path');
const registry = require('./registry');

const MANAGED = 'app.kubernetes.io/managed-by=lan-terminal';
const IMAGE_ANNOTATION = 'lan-terminal.image';
const PORT_ANNOTATION = 'lan-terminal.port';
const MOUNTS_ANNOTATION = 'lan-terminal.mounts';
const CHOWN_ANNOTATION = 'lan-terminal.chown'; // a chown job's { host, uid, gid }
const GPU_RUNTIME_CLASS = 'nvidia'; // the NVIDIA container toolkit's RuntimeClass
const DEFAULT_PORT = 3000; // the desktop UI in linuxserver's Selkies and KasmVNC images

// Kubernetes names (DNS-1123 labels) for namespaces and pods.
const validName = (name) => typeof name === 'string' && name.length <= 63 && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(name);
const validPort = (port) => Number.isInteger(port) && port > 0 && port < 65536;
// A new pod's browser port is optional: null for a pod with no UI to show.
const validBrowserPort = (port) => port === null || validPort(port);
// An absolute path with no "." or ".." parts, such as a host directory or where it
// goes in a pod.
const validPath = (p) => typeof p === 'string' && p.length <= 1024 && p.startsWith('/') && !/[\0\n]/.test(p) &&
  path.posix.normalize(p) === p && (p === '/' || !p.endsWith('/'));
const RESERVED_PATHS = ['/config', '/dev/shm']; // the pod's own volumes
const CHOWN_IMAGE = 'docker.io/library/busybox:1.37';
const validId = (id) => Number.isInteger(id) && id >= 0 && id < 2 ** 31;

// [{ host, path, chown }]: each host directory goes to an absolute path in the pod, no
// two to the same one nor over the pod's own volumes. chown, if there, is { uid, gid }
// for the directory to belong to. Throws when they cannot.
function checkMounts(mounts) {
  if (!Array.isArray(mounts) || mounts.length > 32) throw new Error('bad mounts');
  const seen = new Set(RESERVED_PATHS);
  for (const m of mounts) {
    if (!validPath(m?.host)) throw new Error(`a host directory is an absolute path: ${m?.host}`);
    if (!validPath(m.path) || m.path === '/') throw new Error(`a path in the pod is an absolute path other than /: ${m.path}`);
    if (RESERVED_PATHS.includes(m.path)) throw new Error(`${m.path} is the pod's own volume`);
    if (seen.has(m.path)) throw new Error(`two volumes go to ${m.path} in the pod`);
    if (m.chown && !(validId(m.chown.uid) && validId(m.chown.gid))) throw new Error(`a user or group id is a whole number from 0: ${m.host}`);
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

// The app's pods in every namespace: [{ namespace, name, image, app, tag, port (null for
// no browser port), mounts, gpu, phase, ready }],
// sorted by namespace then name.
async function pods(bin) {
  const out = await kubectl(bin, ['get', 'pods', '--all-namespaces', '-l', MANAGED, '-o', 'json']);
  return JSON.parse(out).items
    .map((p) => {
      const annotations = p.metadata.annotations ?? {};
      const ref = registry.parseImage(annotations[IMAGE_ANNOTATION]);
      // An empty port annotation is a pod with no browser port; none at all, one from
      // before the port was asked for.
      const port = annotations[PORT_ANNOTATION] === '' ? null : Number(annotations[PORT_ANNOTATION]) || DEFAULT_PORT;
      let mounts = [];
      try {
        mounts = JSON.parse(annotations[MOUNTS_ANNOTATION] ?? '[]');
      } catch {}
      const ready = (p.status.conditions ?? []).some((c) => c.type === 'Ready' && c.status === 'True');
      return { namespace: p.metadata.namespace, name: p.metadata.name, image: ref ? `${ref.repo}:${ref.tag}` : null, app: ref?.app ?? null, tag: ref?.tag ?? null, port, mounts, gpu: p.spec.runtimeClassName === GPU_RUNTIME_CLASS, phase: p.status.phase, ready };
    })
    .sort((a, b) => a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name, undefined, { numeric: true }));
}

// The pod for a new instance of repo:tag, run as the host user as the linuxserver
// images expect, with the shared memory and seccomp settings the desktops need, and
// mounts' host directories (see checkMounts). Before the app starts, an init container
// running as root gives each directory with chown, and everything in it, to its user
// and group. It runs each time the pod starts. port is the browser port, or null. With
// gpu, the pod runs under the nvidia RuntimeClass and sees all of the node's GPUs,
// as `docker run --gpus all` does, without taking one from the device plugin, so any
// number of pods can share them. The image is pulled each time the pod starts, so a
// pod made of a tag that has moved runs what the tag names now.
function podSpec(namespace, name, repo, tag, port, mounts = [], gpu = false) {
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
      annotations: { [IMAGE_ANNOTATION]: image, [PORT_ANNOTATION]: port === null ? '' : String(port), [MOUNTS_ANNOTATION]: JSON.stringify(mounts) },
    },
    spec: {
      restartPolicy: 'Always',
      ...(gpu && { runtimeClassName: GPU_RUNTIME_CLASS }),
      securityContext: { seccompProfile: { type: 'Unconfined' } },
      initContainers: mounts.flatMap((m, i) => (m.chown ? [{
        name: `chown-${i}`,
        image: CHOWN_IMAGE,
        command: ['chown', '-R', `${m.chown.uid}:${m.chown.gid}`, '/mnt'],
        securityContext: { runAsUser: 0, runAsGroup: 0 },
        volumeMounts: [{ name: `host-${i}`, mountPath: '/mnt' }],
      }] : [])),
      containers: [{
        name: 'app',
        image,
        imagePullPolicy: 'Always',
        env: [
          { name: 'PUID', value: String(uid) },
          { name: 'PGID', value: String(gid) },
          { name: 'TZ', value: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Etc/UTC' },
          ...(gpu ? [{ name: 'NVIDIA_VISIBLE_DEVICES', value: 'all' }, { name: 'NVIDIA_DRIVER_CAPABILITIES', value: 'all' }] : []),
        ],
        ...(port !== null && { ports: [{ containerPort: port }] }),
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

function create(bin, namespace, name, repo, tag, port, mounts = [], gpu = false) {
  if (!validName(namespace) || !validName(name)) throw new Error(`bad pod: ${namespace}/${name}`);
  if (!registry.validRepo(repo) || !registry.validTag(tag) || !validBrowserPort(port)) throw new Error(`bad image: ${repo}:${tag} port ${port}`);
  checkMounts(mounts);
  return kubectl(bin, ['create', '-f', '-'], { input: JSON.stringify(podSpec(namespace, name, repo, tag, port, mounts, Boolean(gpu))) });
}

// Deletes one of the app's pods, and waits for it to be gone. Pods it did not make are
// left alone.
async function remove(bin, namespace, name) {
  if (!validName(namespace) || !validName(name)) throw new Error(`bad pod: ${namespace}/${name}`);
  if (!(await pods(bin)).some((p) => p.namespace === namespace && p.name === name)) throw new Error(`${namespace}/${name} is not one of this app's pods`);
  return kubectl(bin, ['delete', 'pod', name, '-n', namespace], { timeout: 120000 });
}

// A chown job gives a host directory and everything in it to a user and group, as a
// mount's chown does but once, without a pod: a Job running chown -R as root from
// busybox, named chown-<random>. It stays, with its pod, until it is deleted.
function chownJobSpec(namespace, host, uid, gid) {
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      generateName: 'chown-',
      namespace,
      labels: { 'app.kubernetes.io/managed-by': 'lan-terminal', 'app.kubernetes.io/name': 'chown' },
      annotations: { [CHOWN_ANNOTATION]: JSON.stringify({ host, uid, gid }) },
    },
    spec: {
      backoffLimit: 0,
      template: {
        // Not labelled as the app's, so its pod does not list with the app's pods.
        metadata: { labels: { 'app.kubernetes.io/name': 'chown' } },
        spec: {
          restartPolicy: 'Never',
          containers: [{
            name: 'chown',
            image: CHOWN_IMAGE,
            command: ['chown', '-R', `${uid}:${gid}`, '/mnt'],
            securityContext: { runAsUser: 0, runAsGroup: 0 },
            volumeMounts: [{ name: 'host', mountPath: '/mnt' }],
          }],
          volumes: [{ name: 'host', hostPath: { path: host, type: 'DirectoryOrCreate' } }],
        },
      },
    },
  };
}

function createChownJob(bin, namespace, host, uid, gid) {
  if (!validName(namespace)) throw new Error(`bad namespace: ${namespace}`);
  if (!validPath(host)) throw new Error(`a host directory is an absolute path: ${host}`);
  if (!(validId(uid) && validId(gid))) throw new Error('a user or group id is a whole number from 0');
  return kubectl(bin, ['create', '-f', '-', '-o', 'name'], { input: JSON.stringify(chownJobSpec(namespace, host, uid, gid)) });
}

// The app's chown jobs in every namespace: [{ namespace, name, host, uid, gid, state }],
// state being 'running', 'complete' or 'failed', sorted by namespace then when made.
async function chownJobs(bin) {
  const out = await kubectl(bin, ['get', 'jobs', '--all-namespaces', '-l', `${MANAGED},app.kubernetes.io/name=chown`, '-o', 'json']);
  return JSON.parse(out).items
    .map((j) => {
      let what = {};
      try {
        what = JSON.parse(j.metadata.annotations?.[CHOWN_ANNOTATION] ?? '{}');
      } catch {}
      const done = (type) => (j.status.conditions ?? []).some((c) => c.type === type && c.status === 'True');
      const state = done('Complete') ? 'complete' : done('Failed') ? 'failed' : 'running';
      return { namespace: j.metadata.namespace, name: j.metadata.name, host: what.host ?? null, uid: what.uid ?? null, gid: what.gid ?? null, state, created: j.metadata.creationTimestamp };
    })
    .sort((a, b) => a.namespace.localeCompare(b.namespace) || a.created.localeCompare(b.created));
}

// Deletes one of the app's chown jobs, and its pod. Jobs it did not make are left alone.
async function removeChownJob(bin, namespace, name) {
  if (!validName(namespace) || !validName(name)) throw new Error(`bad job: ${namespace}/${name}`);
  if (!(await chownJobs(bin)).some((j) => j.namespace === namespace && j.name === name)) throw new Error(`${namespace}/${name} is not one of this app's chown jobs`);
  return kubectl(bin, ['delete', 'job', name, '-n', namespace, '--cascade=foreground'], { timeout: 120000 });
}

// A scan job lists the immediate subdirectories of a directory on the node (such as
// /srv), read-only, without a pod staying behind: a Job running from busybox, named
// scan-<random>. Its pod's logs are the directory names, one per line.
function scanJobSpec(namespace, dir) {
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      generateName: 'scan-',
      namespace,
      labels: { 'app.kubernetes.io/managed-by': 'lan-terminal', 'app.kubernetes.io/name': 'scan' },
    },
    spec: {
      backoffLimit: 0,
      template: {
        // Not labelled as the app's, so its pod does not list with the app's pods.
        metadata: { labels: { 'app.kubernetes.io/name': 'scan' } },
        spec: {
          restartPolicy: 'Never',
          containers: [{
            name: 'scan',
            image: CHOWN_IMAGE,
            command: ['sh', '-c', 'for d in /mnt/*/; do [ -d "$d" ] && basename "$d"; done'],
            volumeMounts: [{ name: 'host', mountPath: '/mnt', readOnly: true }],
          }],
          volumes: [{ name: 'host', hostPath: { path: dir, type: 'DirectoryOrCreate' } }],
        },
      },
    },
  };
}

// Polls a Job's conditions until it completes or fails, or timeoutMs passes: 'complete',
// 'failed' or 'timeout'.
async function waitJob(bin, namespace, name, timeoutMs = 30000) {
  const start = Date.now();
  for (;;) {
    const out = await kubectl(bin, ['get', 'job', name, '-n', namespace, '-o', 'json']);
    const conditions = JSON.parse(out).status.conditions ?? [];
    const done = (type) => conditions.some((c) => c.type === type && c.status === 'True');
    if (done('Complete')) return 'complete';
    if (done('Failed')) return 'failed';
    if (Date.now() - start >= timeoutMs) return 'timeout';
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

// Runs a scan job over a directory on the node (such as /srv) and resolves with the
// sorted names of its immediate subdirectories. The job and its pod are gone either way
// by the time this resolves or throws.
async function scanHostDir(bin, namespace, dir) {
  if (!validName(namespace)) throw new Error(`bad namespace: ${namespace}`);
  if (!validPath(dir)) throw new Error(`a directory is an absolute path: ${dir}`);
  const created = await kubectl(bin, ['create', '-f', '-', '-o', 'name'], { input: JSON.stringify(scanJobSpec(namespace, dir)) });
  const name = created.trim().split('/').pop();
  try {
    const state = await waitJob(bin, namespace, name);
    if (state !== 'complete') throw new Error(`could not list ${dir} on the node (job ${state})`);
    const out = await kubectl(bin, ['logs', `job/${name}`, '-n', namespace]);
    return [...new Set(out.split('\n').map((s) => s.trim()).filter(Boolean))].sort();
  } finally {
    await kubectl(bin, ['delete', 'job', name, '-n', namespace, '--cascade=foreground'], { timeout: 120000 }).catch(() => {});
  }
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

module.exports = { DEFAULT_PORT, validName, validPort, validBrowserPort, validPath, checkMounts, namespaces, createNamespace, pods, podSpec, freeName, create, remove, chownJobSpec, createChownJob, chownJobs, removeChownJob, scanJobSpec, scanHostDir, waitReady, forward };
