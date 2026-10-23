const { app, BrowserWindow, clipboard, dialog, ipcMain, screen, session } = require('electron');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const pty = require('node-pty');
const { save: saveConfig, loadDeviceApps, saveDeviceApps } = require('./config');
const layout = require('./layout');
const mux = require('./mux');
const ls = require('./linuxserver');
const scrcpy = require('./scrcpy');
const kube = require('./kube');
const registry = require('./registry');

// Where a dragged pane lands relative to the pane it is dropped on.
const ZONES = {
  center: null, // trade places
  left: { dir: 'row', before: true },
  right: { dir: 'row', before: false },
  top: { dir: 'col', before: true },
  bottom: { dir: 'col', before: false },
};

// Web page panes load http and https pages only.
const RECENT_PAGES = 10;
const validPage = (url) => {
  if (typeof url !== 'string' || url.length > 4096) return false;
  try {
    return ['http:', 'https:'].includes(new URL(url).protocol);
  } catch {
    return false;
  }
};

// The planner, in its own window or in a pane (a webview in the planner partition).
const PLANNER_PAGE = path.join(__dirname, '..', 'planner', 'planner.html');
const PLANNER_URL = pathToFileURL(PLANNER_PAGE).href;
const PLANNER_PANE_URL = `${PLANNER_URL}?pane`; // tells the page it is in a pane
const PLANNER_PRELOAD = path.join(__dirname, '..', 'preload', 'planner-preload.js');
const PLANNER_PARTITION = 'planner';

// DroidCam's kernel module, which makes the V4L2 loopback device its client feeds the
// phone's camera into. The window finds the device by its name, "Droidcam".
const DROIDCAM_MODULE = '/sys/module/v4l2loopback_dc';

// What a pane shows, as a source: null for a shell, { mux, name } for a multiplexer
// session, { app, instance, tag } for a linuxserver app (e.g. chromium 0), { device,
// display } for an Android device (its adb serial): its screen, or with display a
// new virtual display on it (see scrcpy.validDisplay), { page } for a web page
// (its URL), { planner: true } for the layout planner, { droidcam: true, fillWidth }
// for DroidCam's camera (fillWidth: its video spans the pane's width, see
// setCameraFillWidth), or { container: name } for a container labelled
// lan-terminal.pane=<name> (see linuxserver.js), { pod, namespace } for a Kubernetes
// pod the app runs (see kube.js), or { launcher: true } for the form that opens one
// or the layout planner in a new pane. A saved pane shape stores it as its leaf: 'pane', { <mux>: name } (e.g.
// { tmux: 'work' }), { linuxserver: app, name, tag }, { scrcpy: serial, display,
// startApp }, where startApp is the app last opened on a new display, which opens
// again when the display comes back, { page: url }, the page it was last on,
// { planner: true }, { droidcam: true, fillWidth }, { container: name },
// { pod, namespace } or { launcher: true }.
// { webtop: name, tag } is the older form for a webtop.
const leafSource = (s) => {
  if (s?.planner === true) return { planner: true };
  if (s?.launcher === true) return { launcher: true };
  if (kube.validName(s?.pod) && kube.validName(s?.namespace)) return { pod: s.pod, namespace: s.namespace };
  if (s?.droidcam === true) return { droidcam: true, fillWidth: s.fillWidth === true };
  if (ls.validName(s?.container)) return { container: s.container };
  if (validPage(s?.page)) return { page: s.page };
  if (scrcpy.validSerial(s?.scrcpy)) {
    const display = scrcpy.validDisplay(s.display) ? s.display : null;
    return { device: s.scrcpy, display, startApp: display !== null && scrcpy.validPackage(s.startApp) ? s.startApp : null };
  }
  const app = s?.linuxserver ?? (s?.webtop !== undefined ? 'webtop' : undefined);
  const instance = s?.linuxserver ? s.name : s?.webtop;
  if (ls.validApp(app) && ls.validName(instance)) return { app, instance, tag: ls.validTag(s.tag) ? s.tag : 'latest' };
  const found = mux.NAMES.filter((m) => mux.validSession(s?.[m]));
  return found.length === 1 ? { mux: found[0], name: s[found[0]] } : null;
};
const isLeaf = (s) => s === 'pane' || leafSource(s) !== null;
const paneLeaf = (p) =>
  p.planner ? { planner: true } : p.launcher ? { launcher: true } : p.pod ? { pod: p.pod, namespace: p.namespace } : p.droidcam ? { droidcam: true, ...(p.fillWidth && { fillWidth: true }) } : p.container ? { container: p.container } : p.page ? { page: p.page } : p.device ? { scrcpy: p.device, ...(p.display !== null && { display: p.display }), ...(p.startApp && { startApp: p.startApp }) } : p.app ? { linuxserver: p.app, name: p.instance, tag: p.tag } : p.session ? { [p.mux]: p.session } : 'pane';
const sameSource = (p, source) =>
  Boolean(p.planner) === Boolean(source?.planner) && Boolean(p.droidcam) === Boolean(source?.droidcam) &&
  Boolean(p.launcher) === Boolean(source?.launcher) && (p.pod ?? null) === (source?.pod ?? null) && (p.namespace ?? null) === (source?.namespace ?? null) &&
  (p.container ?? null) === (source?.container ?? null) &&
  (p.page ?? null) === (source?.page ?? null) &&
  (p.device ?? null) === (source?.device ?? null) && (p.display ?? null) === (source?.display ?? null) &&
  p.app === (source?.app ?? null) && p.instance === (source?.instance ?? null) &&
  p.mux === (source?.mux ?? null) && p.session === (source?.name ?? null);

class WindowManager extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    // id (UUID) -> { id, win, panes, layout, activePane, maximized, pinned, locked, moveMode, resizeMode, alwaysOnTop, ready }
    // layout is null for a window with no panes, which only a locked window can be.
    // maximized is the pane that fills the window for now, or null; it is not saved.
    // pinned are panes that stay in sight, in their place, over a maximized pane; not saved either.
    // panes: paneId -> { id, kind, title, process, mux, session, app, instance, ... }
    //   kind 'term': { pty, ready, pending, exited } runs a shell or a multiplexer client;
    //     mux and session name the session it is attached to (see mux.js), or are null.
    //   kind 'web': { app, instance, tag, url, error } shows a linuxserver app, e.g.
    //     webtop or chromium (see linuxserver.js); url is null until it answers.
    //     With container instead of app, instance and tag, it shows the container
    //     labelled lan-terminal.pane=<container>, which something else runs. With pod
    //     and namespace, it shows a Kubernetes pod the app runs, through forward, its
    //     kubectl port-forward (see kube.js).
    //   kind 'launcher': { launcher: true } is a form in the window that turns the
    //     pane into a new or existing pod, or a shell.
    //   kind 'scrcpy': { device, display, model, mirror, status, video, fitSize } shows
    //     an Android device's screen or a new display on it (see scrcpy.js); the
    //     window decodes the stream. fitSize is the pane's size in pixels, which a
    //     flex display ('fit') follows. foreground is the app on top of the display
    //     it shows (a package), or null for the home screen or while it is not known.
    //   kind 'page': { page } shows a web page in a webview; page is the URL it is on,
    //     which follows its links, so the saved layout reopens where it was.
    //   kind 'planner': { planner: true } shows the layout planner in a webview.
    //   kind 'camera': { droidcam: true } shows DroidCam's V4L2 loopback device, which
    //     the window opens as a camera.
    this.terminals = new Map();
    this.saveTimer = null;
    this.planner = null; // the layout planner window, while open
    this.panePlanners = new Set(); // the webContents of planners shown in panes
    // Installed multiplexers: mux -> binary path.
    this.muxes = new Map(mux.NAMES.map((m) => [m, mux.find(m, config[m])]).filter(([, bin]) => bin));
    this.sessions = new Map(); // mux -> Map(session name -> target), as last listed
    this.docker = mux.find('docker', config.docker);
    // linuxserver apps as last listed, and the containers labelled lan-terminal.pane.
    this.apps = { images: [], containers: [], labelled: [] };
    this.kubectl = mux.find('kubectl', config.kubectl);
    this.pods = []; // the app's Kubernetes pods as last listed (see kube.pods)
    this.adb = scrcpy.findAdb(config.adb);
    this.devices = []; // Android devices as last listed: [{ serial, model }]
    this.scrcpyTools = null; // the installed scrcpy's { version, server }, once found
    // serial -> Set(package): apps that have been on top of a pane, which the pane
    // menus offer to move to another pane while they run (see #pollDeviceApps).
    this.paneApps = new Map();
    this.runningApps = new Map(); // serial -> Set(package), as last listed
    this.appPoll = null; // the listing under way, if any
    // serial -> { apps, at, loading }: each device's apps for the planner's app menus,
    // kept on disk between runs.
    this.deviceApps = new Map(
      Object.entries(loadDeviceApps())
        .filter(([serial, l]) => scrcpy.validSerial(serial) && Array.isArray(l?.apps))
        .map(([serial, l]) => [serial, { apps: l.apps.filter((a) => scrcpy.validPackage(a?.package)), at: Number(l.at) || 0 }]),
    );
    // scrcpyApps was one list for every device before it was kept per device: each
    // device listed so far gets the apps from it that it has.
    if (Array.isArray(config.scrcpyApps)) {
      const old = new Set(config.scrcpyApps);
      config.scrcpyApps = Object.fromEntries(
        [...this.deviceApps]
          .map(([serial, l]) => [serial, l.apps.map((a) => a.package).filter((pkg) => old.has(pkg)).sort()])
          .filter(([, pkgs]) => pkgs.length),
      );
      saveConfig(config);
    }
    this.quitting = false;
    app.on('before-quit', () => { this.quitting = true; });
    // systemd stops the service with SIGTERM. Quit through the app so the locked
    // windows, which refuse to close otherwise, let go.
    for (const signal of ['SIGTERM', 'SIGINT']) {
      process.on(signal, () => {
        this.quitting = true;
        app.quit();
      });
    }

    // Label each pane with its foreground process (bash, vim, claude, ...).
    setInterval(() => {
      let changed = false;
      for (const term of this.terminals.values()) {
        for (const pane of term.panes.values()) {
          if (!pane.pty) continue;
          try {
            const name = path.basename(pane.pty.process);
            if (name && name !== pane.process) {
              pane.process = name;
              changed = true;
            }
          } catch {
            // The pty can close between ticks.
          }
        }
      }
      if (changed) this.#changed();
    }, 1000);
    // Sessions started or ended outside the app show up in the planner's pane menus.
    setInterval(() => {
      if (this.#plannerOpen()) this.refreshSessions();
    }, 2000);
    // Which app each device pane shows, for the planner and for the saved layout.
    setInterval(() => this.#pollDeviceApps(), 3000);

    // Renderer -> PTY. The sender identifies the window; the pane id picks the shell in it.
    ipcMain.on('pty:input', (event, paneId, data) => this.#pane(event, paneId)?.pty?.write(data));
    ipcMain.on('clipboard:write', (event, text) => {
      if (this.#fromSender(event) && typeof text === 'string') clipboard.writeText(text);
    });
    ipcMain.handle('clipboard:read', (event) => (this.#fromSender(event) ? clipboard.readText() : ''));
    ipcMain.on('pty:resize', (event, paneId, cols, rows) => {
      const pane = this.#pane(event, paneId);
      if (pane?.pty && cols > 0 && rows > 0) pane.pty.resize(cols, rows);
    });
    // The window's renderer is listening: send it the layout so it creates the panes.
    ipcMain.on('term:ready', (event) => {
      const term = this.#fromSender(event);
      if (!term) return;
      term.ready = true;
      this.#sendLayout(term);
      if (term.moveMode) event.sender.send('moveMode', true);
      if (term.resizeMode) event.sender.send('resizeMode', true);
    });
    // A pane's xterm exists: flush the output it missed.
    ipcMain.on('pty:ready', (event, paneId) => {
      const pane = this.#pane(event, paneId);
      if (!pane?.pty) return;
      pane.ready = true;
      if (pane.pending) event.sender.send('pty:data', pane.id, pane.pending);
      pane.pending = '';
    });
    // A device pane's decoder is listening: send it the video size and ask the device
    // for a fresh key frame, which a decoder needs to start.
    ipcMain.on('scrcpy:ready', (event, paneId) => {
      const pane = this.#pane(event, paneId);
      if (pane?.kind !== 'scrcpy') return;
      pane.ready = true;
      if (pane.video) event.sender.send('scrcpy:session', pane.id, pane.video);
      // Opus packets decode on their own once the decoder has the OpusHead.
      if (pane.audioConfig) event.sender.send('scrcpy:audio', pane.id, { config: true, data: pane.audioConfig });
      pane.mirror?.send({ type: 'resetVideo' });
    });
    ipcMain.on('scrcpy:input', (event, paneId, msg) => {
      const pane = this.#pane(event, paneId);
      if (pane?.kind !== 'scrcpy' || !pane.video) return;
      try {
        pane.mirror?.send({ ...msg, width: pane.video.width, height: pane.video.height });
      } catch (err) {
        console.warn('scrcpy:input:', err.message);
      }
    });
    // Ctrl+Shift+Alt+X in a device pane: its mouse and keyboard become a USB mouse and
    // keyboard on the device, or stop being one.
    ipcMain.on('scrcpy:capture', (event, paneId, on) => {
      const pane = this.#pane(event, paneId);
      if (pane?.kind === 'scrcpy') pane.mirror?.capture(Boolean(on));
    });
    ipcMain.on('scrcpy:hid-key', (event, paneId, code, down) => {
      const pane = this.#pane(event, paneId);
      if (pane?.kind === 'scrcpy' && typeof code === 'string') pane.mirror?.hidKey(code, Boolean(down));
    });
    ipcMain.on('scrcpy:hid-mouse', (event, paneId, motion) => {
      const pane = this.#pane(event, paneId);
      if (pane?.kind !== 'scrcpy' || typeof motion !== 'object' || !motion) return;
      const num = (v) => (Number.isFinite(v) ? v : 0);
      pane.mirror?.hidMouse({ buttons: num(motion.buttons), dx: num(motion.dx), dy: num(motion.dy), wheel: num(motion.wheel), hwheel: num(motion.hwheel) });
    });
    // A flex display's pane changed size: resize the display to match.
    ipcMain.on('scrcpy:resize', (event, paneId, width, height) => {
      const pane = this.#pane(event, paneId);
      if (pane?.kind !== 'scrcpy' || !scrcpy.isFit(pane.display)) return;
      if (!(Number.isInteger(width) && Number.isInteger(height) && width >= 64 && height >= 64)) return;
      pane.fitSize = { width: Math.min(width, 0xffff), height: Math.min(height, 0xffff) };
      pane.mirror?.send({ type: 'resizeDisplay', ...pane.fitSize });
    });
    // A page pane went to another URL or changed its title.
    ipcMain.on('page:state', (event, paneId, url, title) => {
      const pane = this.#pane(event, paneId);
      if (pane?.kind !== 'page') return;
      let changed = false;
      if (validPage(url) && url !== pane.page) {
        pane.page = url;
        changed = true;
        this.#saveSoon();
      }
      if (typeof title === 'string' && title !== pane.title) {
        pane.title = title || new URL(pane.page).host;
        changed = true;
      }
      if (changed) this.#changed();
    });
    // New sizes for a split: a camera pane's height fitted to its video (see
    // fitCameraHeight), or a divider dragged in resize mode.
    ipcMain.on('pane:resize-split', (event, splitPath, sizes) => {
      const term = this.#fromSender(event);
      if (!term?.layout) return;
      try {
        this.resizeSplit(term.id, splitPath, sizes);
      } catch (err) {
        console.warn('pane:resize-split:', err.message);
      }
    });
    // A click in resize mode: a new pane on that side of the pane, with the form that
    // picks what it shows. Resize mode ends, so the new pane takes the keyboard.
    ipcMain.on('pane:split', (event, paneId, side) => {
      const term = this.#fromSender(event);
      const place = Object.hasOwn(ZONES, side) && ZONES[side];
      if (term && place && this.splitPane(term.id, paneId, place.dir, place.before, { launcher: true })) {
        this.setResizeMode(term.id, false);
      }
    });
    // The tools on a pane in resize mode: close, back to a New pane form, pin over a
    // maximized pane, maximize (paneId null puts the panes back), reload, and dropping
    // a pane on another (see movePane).
    ipcMain.on('pane:close', (event, paneId) => {
      const term = this.#fromSender(event);
      if (term) this.closePane(term.id, paneId);
    });
    // The home tool ends resize mode, so the form takes the keyboard.
    ipcMain.on('pane:home', (event, paneId) => {
      const term = this.#fromSender(event);
      if (term && this.homePane(term.id, paneId)) this.setResizeMode(term.id, false);
    });
    ipcMain.on('pane:pin', (event, paneId, on) => {
      const term = this.#fromSender(event);
      if (term) this.pinPane(term.id, paneId, Boolean(on));
    });
    ipcMain.on('pane:reload', (event, paneId) => {
      const term = this.#fromSender(event);
      if (term) this.reloadPane(term.id, paneId);
    });
    ipcMain.on('pane:maximize', (event, paneId) => {
      const term = this.#fromSender(event);
      if (term) this.maximizePane(term.id, paneId ?? null);
    });
    ipcMain.on('pane:move', (event, paneId, targetId, zone) => {
      const term = this.#fromSender(event);
      try {
        if (term) this.movePane(term.id, paneId, targetId, zone);
      } catch (err) {
        console.warn('pane:move:', err.message);
      }
    });
    // A launcher pane's form: what it offers, a new namespace, and the choice that
    // turns the pane into a pod ('pod:…', see #resolvePod) or a shell.
    ipcMain.handle('launcher:state', (event) => (this.#fromSender(event) ? this.launcherState() : null));
    // The image breadcrumbs' suggestions: what goes after a prefix, and a repository's
    // tags. Each answers { images } or { tags }, empty with an error when the registry
    // does not say.
    ipcMain.handle('launcher:images', async (event, prefix) => {
      if (!this.#fromSender(event)) return null;
      try {
        return { images: await registry.list(prefix), error: null };
      } catch (err) {
        return { images: [], error: err.message };
      }
    });
    ipcMain.handle('launcher:tags', async (event, repo) => {
      if (!this.#fromSender(event)) return null;
      try {
        return { tags: await registry.tags(repo), error: null };
      } catch (err) {
        return { tags: [], error: err.message };
      }
    });
    // Adds (on) or removes a preset: kind 'prefix' (an image prefix) or 'hostDir'.
    // Answers null, or what went wrong.
    ipcMain.handle('launcher:preset', (event, kind, value, on) => {
      if (!this.#fromSender(event)) return 'unknown window';
      try {
        this.setPreset(kind, value, on);
        return null;
      } catch (err) {
        return err.message;
      }
    });
    ipcMain.handle('launcher:namespace', async (event, name) => {
      if (!this.#fromSender(event)) return null;
      try {
        await this.createNamespace(name);
        return null;
      } catch (err) {
        return err.message;
      }
    });
    // Deleting a pod from the form: a dialog over the window asks first (true for yes),
    // then the delete answers null, or what went wrong.
    ipcMain.handle('launcher:confirm-delete-pod', async (event, namespace, pod) => {
      const term = this.#fromSender(event);
      if (!term || !kube.validName(namespace) || !kube.validName(pod)) return false;
      const { response } = await dialog.showMessageBox(term.win, {
        type: 'warning',
        title: 'Delete pod',
        message: `Delete the pod ${namespace}/${pod}?`,
        detail: 'Its home directory (/config) goes with it, and the panes showing it turn into New pane forms.',
        buttons: ['Cancel', 'Delete'],
        defaultId: 0,
        cancelId: 0,
      });
      return response === 1;
    });
    ipcMain.handle('launcher:delete-pod', async (event, namespace, pod) => {
      if (!this.#fromSender(event)) return 'unknown window';
      try {
        await this.deletePod(namespace, pod);
        return null;
      } catch (err) {
        return err.message;
      }
    });
    // Creating a pod from the form leaves the form as it is: it answers null, or what
    // went wrong, and the pod shows in the form's list.
    ipcMain.handle('launcher:create-pod', async (event, wanted) => {
      if (!this.#fromSender(event)) return null;
      try {
        await this.createPod(wanted);
        return null;
      } catch (err) {
        return err.message;
      }
    });
    // Chown jobs from the form: listing them ({ jobs, error }) while one runs, making one
    // and deleting one, which answer null or what went wrong.
    ipcMain.handle('launcher:chown-jobs', async (event) => {
      if (!this.#fromSender(event) || !this.kubectl) return { jobs: [], error: null };
      try {
        return { jobs: await kube.chownJobs(this.kubectl), error: null };
      } catch (err) {
        return { jobs: [], error: err.message };
      }
    });
    ipcMain.handle('launcher:create-chown-job', async (event, namespace, host, uid, gid) => {
      if (!this.#fromSender(event)) return 'unknown window';
      try {
        await this.createChownJob(namespace, host, uid, gid);
        return null;
      } catch (err) {
        return err.message;
      }
    });
    ipcMain.handle('launcher:delete-chown-job', async (event, namespace, name) => {
      if (!this.#fromSender(event)) return 'unknown window';
      if (!this.kubectl) return 'kubectl is not installed';
      try {
        await kube.removeChownJob(this.kubectl, namespace, name);
        return null;
      } catch (err) {
        return err.message;
      }
    });
    // Scans a directory on the node (dir, such as /srv) from the form: runs a job that
    // lists every subdirectory under it, at any depth, and offers each as a host
    // directory. Answers { added, error }.
    ipcMain.handle('launcher:scan-host-dirs', async (event, namespace, dir) => {
      if (!this.#fromSender(event)) return { added: [], error: 'unknown window' };
      try {
        return { added: await this.scanHostDirs(namespace, dir), error: null };
      } catch (err) {
        return { added: [], error: err.message };
      }
    });
    ipcMain.handle('launcher:open', async (event, paneId, choice) => {
      const term = this.#fromSender(event);
      if (term?.panes.get(paneId)?.kind !== 'launcher') return 'the pane is no longer a new pane';
      if (!(choice === 'planner' || (typeof choice === 'string' && choice.startsWith('pod:')))) return 'unknown choice';
      try {
        await this.setPaneSource(term.id, paneId, choice);
        return null;
      } catch (err) {
        return err.message;
      }
    });
    ipcMain.on('pane:focus', (event, paneId) => {
      const term = this.#fromSender(event);
      if (term && term.panes.has(paneId) && term.activePane !== paneId) {
        term.activePane = paneId;
        this.#changed();
      }
    });
    ipcMain.on('moveMode:exit', (event) => {
      const term = this.#fromSender(event);
      if (term) this.setMoveMode(term.id, false);
    });
    ipcMain.on('resizeMode:exit', (event) => {
      const term = this.#fromSender(event);
      if (term) this.setResizeMode(term.id, false);
    });
    // Move-mode drag. KWin's own window drag (app-region: drag) stops at the top edge,
    // but it leaves positions the app sets alone, so follow the cursor here instead.
    ipcMain.on('move:start', (event) => {
      const term = this.#fromSender(event);
      if (!term?.moveMode) return;
      const [x, y] = term.win.getPosition();
      term.drag = { cursor: screen.getCursorScreenPoint(), x, y };
    });
    ipcMain.on('move:drag', (event) => {
      const term = this.#fromSender(event);
      if (!term?.moveMode || !term.drag) return;
      const { cursor, x, y } = term.drag;
      const now = screen.getCursorScreenPoint();
      term.win.setPosition(x + now.x - cursor.x, y + now.y - cursor.y);
    });
    ipcMain.on('move:end', (event) => {
      const term = this.#fromSender(event);
      if (!term?.drag) return;
      term.drag = null;
      this.#changed();
    });
    ipcMain.handle('terminal:config', () => ({
      fontSize: config.fontSize,
      background: config.background,
      foreground: config.foreground,
      presenterMode: config.presenterMode,
    }));

    // Planner window -> windows and the panes inside them.
    ipcMain.handle('planner:state', () => this.#plannerState());
    // A pane menu is opening: list sessions, linuxserver apps and pulled images now.
    ipcMain.handle('planner:refresh', async (event) => {
      if (this.#isPlanner(event.sender)) await Promise.all([this.refreshSessions(), this.#pollDeviceApps()]);
      return this.#plannerState();
    });
    const plannerAction = (channel, fn) =>
      ipcMain.on(channel, async (event, ...args) => {
        if (!this.#isPlanner(event.sender)) return;
        try {
          await fn(...args);
        } catch (err) {
          console.warn(`${channel}:`, err.message);
        }
      });
    plannerAction('planner:split', (id, paneId, dir) => this.splitPane(id, paneId, dir));
    plannerAction('planner:close', (id, paneId) => this.closePane(id, paneId));
    plannerAction('planner:move', (id, paneId, targetId, zone) => this.movePane(id, paneId, targetId, zone));
    plannerAction('planner:resize', (id, splitPath, sizes) => this.resizeSplit(id, splitPath, sizes));
    plannerAction('planner:select', (id, paneId) => this.selectPane(id, paneId));
    plannerAction('planner:maximize', (id, paneId) => this.maximizePane(id, paneId));
    plannerAction('planner:source', (id, paneId, source) => this.setPaneSource(id, paneId, source));
    plannerAction('planner:add-pane', (id, source) => this.addPane(id, source));
    plannerAction('planner:stop-app', (app, instance) => this.stopApp(app, instance));
    plannerAction('planner:camera-fill-width', (id, paneId, on) => this.setCameraFillWidth(id, paneId, on));
    plannerAction('planner:camera-fit-height', (id, paneId) => this.fitCameraHeight(id, paneId));
    plannerAction('planner:reload-page', (id, paneId) => this.reloadPage(id, paneId));
    plannerAction('planner:open-app', (id, paneId, pkg) => this.openDeviceApp(id, paneId, pkg));
    plannerAction('planner:shown-apps', (serial, packages) => this.setShownApps(serial, packages));
    // A device pane's app menu is opening: the device's apps, listed now if need be.
    ipcMain.handle('planner:device-apps', (event, serial) => {
      if (!this.#isPlanner(event.sender)) return [];
      return this.#deviceApps(serial).catch((err) => {
        console.warn(`apps on ${serial}:`, err.message);
        return [];
      });
    });
    plannerAction('planner:new-window', () => this.create());
    plannerAction('planner:close-window', (id) => this.terminals.size > 1 && this.close(id));
    plannerAction('planner:lock-window', (id, locked) => this.setLocked(id, locked));
    plannerAction('planner:focus-window', (id) => this.focus(id));
  }

  #fromSender(event) {
    for (const term of this.terminals.values()) {
      if (!term.win.isDestroyed() && term.win.webContents === event.sender) return term;
    }
    return null;
  }

  #pane(event, paneId) {
    return this.#fromSender(event)?.panes.get(paneId) || null;
  }

  // Every window, pane, title and focus change lands here, so the planner redraws
  // from the same notification as the tray and the LAN clients.
  #changed() {
    this.emit('changed', this.list());
    this.#sendPlanners();
  }

  // The planner window, or a planner pane, is open.
  #plannerOpen() {
    return this.#plannerWindowOpen() || this.panePlanners.size > 0;
  }

  #plannerWindowOpen() {
    return Boolean(this.planner && !this.planner.isDestroyed());
  }

  #isPlanner(sender) {
    return (this.#plannerWindowOpen() && sender === this.planner.webContents) || this.panePlanners.has(sender);
  }

  // The planner window and every planner pane redraw from the same state.
  #sendPlanners() {
    if (!this.#plannerOpen()) return;
    const st = this.#plannerState();
    if (this.#plannerWindowOpen()) this.planner.webContents.send('planner:state', st);
    for (const wc of this.panePlanners) wc.send('planner:state', st);
  }

  #fullBounds() {
    const { width: dw, height: dh } = screen.getPrimaryDisplay().bounds;
    return { x: 0, y: 0, width: this.config.width || dw, height: this.config.height || dh };
  }

  // Maximized: the work area beside KDE's panel, no bigger than the configured size.
  #maximizedBounds() {
    const { x, y, width, height } = screen.getPrimaryDisplay().workArea;
    const full = this.#fullBounds();
    return { x, y, width: Math.min(width, full.width), height: Math.min(height, full.height) };
  }

  #paneList(term) {
    return layout.leaves(term.layout).map((id) => {
      const p = term.panes.get(id);
      const deviceApp = p.foreground ? { package: p.foreground, name: this.#appName(p.device, p.foreground) } : null;
      return { id, title: p.title, process: p.process, mux: p.mux, session: p.session, app: p.app, instance: p.instance, container: p.container ?? null, pod: p.pod ?? null, namespace: p.namespace ?? null, launcher: Boolean(p.launcher), page: p.page ?? null, planner: Boolean(p.planner), droidcam: Boolean(p.droidcam), fillWidth: Boolean(p.fillWidth), device: p.device ?? null, display: p.display ?? null, startApp: p.startApp ?? null, deviceApp, model: p.model ?? null, pid: p.pty?.pid ?? null };
    });
  }

  #plannerState() {
    const { width, height } = this.#fullBounds();
    return {
      aspect: width / height,
      // Each installed multiplexer and its running sessions, for the pane menus.
      muxes: [...this.muxes.keys()].map((m) => ({ id: m, sessions: [...(this.sessions.get(m)?.keys() ?? [])] })),
      // Pulled linuxserver app images and the app's containers, or null without docker.
      linuxserver: this.docker ? this.apps : null,
      // The app's Kubernetes pods, or null without kubectl.
      pods: this.kubectl ? this.pods : null,
      // Connected Android devices and the new displays the menu offers on each, or
      // null without adb.
      // and the apps each one has had on top of a pane that still run on it.
      // shownApps are, per device, the packages its Open app… offers (none for all).
      android: this.adb ? { devices: this.devices, displays: this.#displayChoices(), apps: this.#movableApps(), shownApps: this.#shownApps() } : null,
      // DroidCam's module is loaded, so its camera can be shown.
      droidcam: fs.existsSync(DROIDCAM_MODULE),
      // The web pages opened last, newest first.
      pages: this.#recentPages(),
      windows: [...this.terminals.values()]
        .filter((t) => !t.closed && !t.win.isDestroyed())
        .map((t) => ({ id: t.id, focused: t.win.isFocused(), locked: t.locked, layout: t.layout, active: t.activePane, maximized: t.maximized, panes: this.#paneList(t) })),
    };
  }

  // { serial: [package] }: per device, the apps its Open app… offers.
  #shownApps() {
    const chosen = this.config.scrcpyApps;
    if (!chosen || typeof chosen !== 'object' || Array.isArray(chosen)) return {};
    return Object.fromEntries(
      Object.entries(chosen)
        .filter(([serial, pkgs]) => scrcpy.validSerial(serial) && Array.isArray(pkgs))
        .map(([serial, pkgs]) => [serial, pkgs.filter(scrcpy.validPackage)]),
    );
  }

  // The packages a device's Open app… offers; none offers them all.
  setShownApps(serial, packages) {
    if (!scrcpy.validSerial(serial)) throw new Error('bad adb serial');
    if (!Array.isArray(packages)) throw new Error('packages must be a list');
    const chosen = this.#shownApps();
    const pkgs = [...new Set(packages.filter(scrcpy.validPackage))].sort();
    if (pkgs.length) chosen[serial] = pkgs;
    else delete chosen[serial];
    this.config.scrcpyApps = chosen;
    saveConfig(this.config);
    this.#changed();
    return true;
  }

  // An app's name from the device's app list, or its package until the list is in.
  #appName(serial, pkg) {
    return this.deviceApps.get(serial)?.apps?.find((a) => a.package === pkg)?.name ?? pkg;
  }

  #devicePanes() {
    return [...this.terminals.values()].flatMap((t) => [...t.panes.values()].filter((p) => p.kind === 'scrcpy' && !p.exited));
  }

  // { serial: [{ package, name }] }: per device, the apps that have been on top of a
  // pane and still run, or are on top of one now, by name.
  #movableApps() {
    const shown = new Map();
    for (const p of this.#devicePanes()) if (p.foreground) shown.set(p.device, (shown.get(p.device) ?? new Set()).add(p.foreground));
    const out = {};
    for (const serial of new Set([...this.paneApps.keys(), ...shown.keys()])) {
      const running = this.runningApps.get(serial) ?? new Set();
      const pkgs = new Set([...(shown.get(serial) ?? []), ...[...(this.paneApps.get(serial) ?? [])].filter((pkg) => running.has(pkg))]);
      out[serial] = [...pkgs]
        .map((pkg) => ({ package: pkg, name: this.#appName(serial, pkg) }))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    }
    return out;
  }

  // Reads which app is on top of each connected device pane's display. A new display
  // remembers it as its startApp, so the saved layout brings back the app it last
  // showed, however it was opened. A listing already under way is shared.
  #pollDeviceApps() {
    this.appPoll ??= (async () => {
      const panes = this.#devicePanes().filter((p) => p.mirror && p.video);
      let changed = false;
      await Promise.all([...new Set(panes.map((p) => p.device))].map(async (serial) => {
        let found;
        try {
          found = await scrcpy.tasks(this.adb, serial);
        } catch {
          return;
        }
        const running = this.runningApps.get(serial);
        if (!running || [...found.running].join() !== [...running].join()) changed = true;
        this.runningApps.set(serial, found.running);
        for (const p of panes) {
          if (p.device !== serial || p.exited) continue;
          const top = found.top.get(p.mirror?.displayId) ?? null;
          if (top) this.paneApps.set(serial, (this.paneApps.get(serial) ?? new Set()).add(top));
          if (top !== p.foreground) {
            p.foreground = top;
            changed = true;
          }
          if (top && p.display !== null && p.startApp !== top) {
            p.startApp = top;
            this.#saveSoon();
          }
        }
      }));
      if (changed) this.#changed();
    })().finally(() => { this.appPoll = null; });
    return this.appPoll;
  }

  // pkg is moving to pane: no other pane holds on to it, so a saved layout does not
  // open it in two places.
  #claimApp(pane, pkg) {
    this.paneApps.set(pane.device, (this.paneApps.get(pane.device) ?? new Set()).add(pkg));
    for (const p of this.#devicePanes()) {
      if (p === pane || p.device !== pane.device) continue;
      if (p.startApp === pkg) p.startApp = null;
      if (p.foreground === pkg) p.foreground = null;
    }
    pane.foreground = pkg;
    if (pane.display !== null) pane.startApp = pkg;
    this.#changed();
    this.#saveSoon();
  }

  #recentPages() {
    return (Array.isArray(this.config.recentPages) ? this.config.recentPages : []).filter(validPage);
  }

  // A new display at the main screen's size, one that fits its pane, and the sizes
  // from the config's scrcpyDisplays.
  #displayChoices() {
    const extra = Array.isArray(this.config.scrcpyDisplays) ? this.config.scrcpyDisplays : [];
    return [...new Set(['', 'fit', ...extra.filter(scrcpy.validDisplay)])];
  }

  // A device's apps. Listing takes the device several seconds, so the last list (kept
  // on disk between runs) comes back at once, and one older than a minute is listed
  // again in the background for the next time. Only a device never listed waits.
  async #deviceApps(serial) {
    if (!scrcpy.validSerial(serial) || !this.adb) return [];
    const cached = this.deviceApps.get(serial);
    if (cached?.apps) {
      if (!cached.loading && Date.now() - cached.at > 60000) this.#listApps(serial).catch(() => {});
      return cached.apps;
    }
    return cached?.loading ?? this.#listApps(serial);
  }

  // Lists a device's apps and saves the list. A listing already under way is shared.
  async #listApps(serial) {
    const cached = this.deviceApps.get(serial);
    if (cached?.loading) return cached.loading;
    const loading = (async () => {
      this.scrcpyTools ??= await scrcpy.findScrcpy(this.config.scrcpy);
      return scrcpy.apps({ adb: this.adb, ...this.scrcpyTools }, serial);
    })();
    this.deviceApps.set(serial, { ...cached, loading });
    try {
      const apps = await loading;
      this.deviceApps.set(serial, { apps, at: Date.now() });
      // The pane menus name the apps on device panes from this list.
      this.#changed();
      const lists = Object.fromEntries([...this.deviceApps].filter(([, l]) => l.apps).map(([s, l]) => [s, { apps: l.apps, at: l.at }]));
      try {
        saveDeviceApps(lists);
      } catch (err) {
        console.warn('Could not save the device app lists:', err.message);
      }
      return apps;
    } catch (err) {
      this.deviceApps.set(serial, { ...cached, loading: null });
      throw err;
    }
  }

  // Opens an app on what a device pane shows: the device's screen, or the pane's new
  // display, which remembers it and opens it again when the display comes back.
  openDeviceApp(id, paneId, pkg) {
    const term = this.get(id);
    const pane = term?.panes.get(paneId);
    if (pane?.kind !== 'scrcpy' || !scrcpy.validPackage(pkg)) return false;
    if (!pane.mirror || !pane.video) throw new Error(`${pane.model} is not connected`);
    // Starting an app that runs on another display moves it to this one.
    pane.mirror.send({ type: 'startApp', package: pkg });
    this.#claimApp(pane, pkg);
    return true;
  }

  #sendLayout(term) {
    if (!term.ready || term.win.isDestroyed()) return;
    // Web panes have no pty to describe them, so the renderer gets what to show.
    const panes = {};
    for (const p of term.panes.values()) {
      if (p.kind === 'web') panes[p.id] = { kind: 'web', url: p.url, error: p.error, label: p.pod ? `${p.namespace}/${p.pod}` : p.container ?? `${p.app} ${p.instance} (${p.tag})` };
      if (p.kind === 'launcher') panes[p.id] = { kind: 'launcher' };
      if (p.kind === 'page') panes[p.id] = { kind: 'page', url: p.page };
      if (p.kind === 'planner') panes[p.id] = { kind: 'planner', url: PLANNER_PANE_URL };
      // Spanning the width only applies beside other panes; alone, it shows it all.
      if (p.kind === 'camera') panes[p.id] = { kind: 'camera', name: 'Droidcam', label: 'DroidCam', fillWidth: p.fillWidth && layout.leaves(term.layout).length > 1 };
      if (p.kind === 'scrcpy') panes[p.id] = { kind: 'scrcpy', status: p.status, fit: scrcpy.isFit(p.display), captureMouse: p.mirror?.capturesMouse ?? false };
    }
    term.win.webContents.send('layout', { layout: term.layout, active: term.activePane, maximized: term.maximized, pinned: [...term.pinned], panes });
  }

  // Every pane edit lands here: the capture window and the planner redraw from the
  // same tree.
  #pushLayout(term) {
    this.#sendLayout(term);
    this.#changed();
    this.#saveSoon();
  }

  // Saves each window's pane shape and lock for the next start. The shapes are taken now, not
  // when the timer fires, and nothing is saved while quitting, so the windows closing
  // on quit do not erase the saved set.
  #saveSoon() {
    if (this.quitting) return;
    const leafShape = (t) => (id) => (t.panes.has(id) ? paneLeaf(t.panes.get(id)) : 'pane');
    const saved = [...this.terminals.values()]
      .filter((t) => !t.closed)
      .map((t) => ({ panes: t.layout ? layout.shape(t.layout, leafShape(t)) : null, locked: t.locked }));
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.config.windows = saved;
      saveConfig(this.config);
    }, 500);
  }

  // With a session ({ mux, name }) the pane runs that multiplexer's client attached to
  // it, starting the session if it is not running. The session outlives the pane:
  // closing the pane only detaches. A multiplexer that is not installed falls back to
  // a shell.
  #spawnPane(term, session = null) {
    const bin = session && mux.validSession(session.name) ? this.muxes.get(session.mux) : null;
    if (!bin) session = null;
    const id = crypto.randomUUID();
    const shell = this.config.shell || process.env.SHELL || os.userInfo().shell || '/bin/bash';
    const target = session && this.sessions.get(session.mux)?.get(session.name);
    const [file, args] = session ? [bin, mux.MUXES[session.mux].spawn(session.name, target)] : [shell, this.config.shellArgs || []];
    const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
    // Started from inside a multiplexer session, the app would pass its variables on
    // and the clients would nest.
    for (const m of mux.NAMES) delete env[mux.MUXES[m].env];
    const proc = pty.spawn(file, args, { name: 'xterm-256color', cols: 80, rows: 24, cwd: os.homedir(), env });
    const name = path.basename(file);
    // The title starts as the program's name, which labels hide, until the program
    // sets its own.
    const pane = { id, kind: 'term', pty: proc, mux: session?.mux ?? null, session: session?.name ?? null, app: null, instance: null, title: name, process: name, ready: false, pending: '', exited: false };
    term.panes.set(id, pane);
    if (session && !target) setTimeout(() => this.refreshSessions(), 500);

    proc.onData((data) => {
      // Hold output until the pane's xterm is listening so the first prompt is not lost.
      if (!pane.ready) pane.pending += data;
      else if (!term.win.isDestroyed()) term.win.webContents.send('pty:data', id, data);
    });
    // A shell that exits on its own leaves a New pane form in its place; one closed
    // with closePane takes its place with it.
    proc.onExit(() => {
      pane.exited = true;
      if (pane.closing) this.#removePane(term, id);
      else this.#formInPlace(term, id);
    });
    return id;
  }

  // An app pane shows a placeholder while the container starts (or is reused), then
  // the app's UI. Closing the pane leaves the container running.
  // A labelled container ({ container }) is started if need be, the same way.
  #spawnWebPane(term, { app = null, instance = null, tag = null, container = null }) {
    const id = crypto.randomUUID();
    const name = container ?? app;
    const pane = { id, kind: 'web', app, instance, tag, container, url: null, error: null, mux: null, session: null, title: name, process: name, exited: false };
    term.panes.set(id, pane);
    if (!this.docker) {
      pane.error = 'docker is not installed';
      return id;
    }
    (container ? ls.ensureLabelled(this.docker, container) : ls.ensure(this.docker, app, instance, tag))
      .then((url) => { pane.url = url; })
      .catch((err) => {
        pane.error = err.message;
        console.warn(`${container ?? `${app} ${instance}`}:`, err.message);
      })
      .finally(() => {
        if (term.panes.get(id) !== pane) return;
        this.#sendLayout(term);
        this.refreshSessions();
      });
    return id;
  }

  // A device pane mirrors the device's screen, or shows a new display on it, for as
  // long as the pane exists. A new display and the apps on it go away with the
  // pane, unless scrcpyKeepApps moves the apps to the main screen. When
  // the device is not connected, or the stream stops (a cable pulled, the server
  // killed), the pane says so and tries again every few seconds.
  #spawnScrcpyPane(term, { device, display = null, startApp = null }) {
    const id = crypto.randomUUID();
    const model = this.devices.find((d) => d.serial === device)?.model ?? device;
    const pane = { id, kind: 'scrcpy', device, display, startApp, fitSize: null, model, mirror: null, retry: null, status: `Connecting to ${model}…`, video: null, ready: false, mux: null, session: null, app: null, instance: null, title: model, process: 'scrcpy', exited: false };
    term.panes.set(id, pane);
    const send = (channel, ...args) => {
      if (pane.ready && !term.win.isDestroyed()) term.win.webContents.send(channel, id, ...args);
    };
    const setStatus = (status) => {
      if (pane.exited || pane.status === status) return;
      pane.status = status;
      this.#sendLayout(term);
    };
    const retry = (status) => {
      setStatus(status);
      pane.retry = setTimeout(connect, 3000);
    };
    const connect = async () => {
      pane.retry = null;
      if (pane.exited) return;
      if (!this.adb) return setStatus('adb is not installed');
      try {
        this.scrcpyTools ??= await scrcpy.findScrcpy(this.config.scrcpy);
      } catch (err) {
        return setStatus(err.message);
      }
      await this.refreshSessions();
      if (pane.exited) return;
      if (!this.devices.some((d) => d.serial === device)) return retry(`Waiting for ${pane.model === device ? device : `${pane.model} (${device})`}…`);
      // A device has one sound, so only one of its panes plays it.
      const audio = this.config.scrcpyAudio !== false &&
        ![...this.terminals.values()].some((t) => [...t.panes.values()].some((p) => p !== pane && p.device === device && p.mirror?.options.audio));
      const mirror = new scrcpy.Mirror({ adb: this.adb, ...this.scrcpyTools }, device, {
        audio,
        audioDup: this.config.scrcpyAudioDup,
        display,
        fitSize: pane.fitSize,
        keepApps: this.config.scrcpyKeepApps,
        imePolicy: this.config.scrcpyImePolicy,
      });
      pane.mirror = mirror;
      mirror.on('name', (name) => {
        pane.model = pane.title = name;
        this.#changed();
      });
      mirror.on('session', (video) => {
        // The pane may have changed size while the server started.
        const fit = pane.fitSize;
        if (!pane.video && fit && scrcpy.isFit(display) && (fit.width !== video.width || fit.height !== video.height)) {
          mirror.send({ type: 'resizeDisplay', ...fit });
        }
        // A new display starts empty: bring back the app the pane last had open.
        if (!pane.video && display !== null && pane.startApp) mirror.send({ type: 'startApp', package: pane.startApp });
        // List the device's apps ahead of the planner's app menu needing them (or
        // refresh a list from an earlier run).
        if (!pane.video) this.#deviceApps(device).catch(() => {});
        pane.video = video;
        send('scrcpy:session', video);
        setStatus(null);
      });
      mirror.on('packet', (packet) => send('scrcpy:packet', packet));
      mirror.on('audio', (packet) => {
        if (packet.config) pane.audioConfig = packet.data;
        send('scrcpy:audio', packet);
      });
      mirror.on('audio-off', (reason) => console.warn(`scrcpy ${device}: no sound: ${reason}`));
      mirror.on('end', (err) => {
        if (pane.mirror === mirror) pane.mirror = null;
        pane.foreground = null;
        pane.audioConfig = null;
        pane.video = null;
        if (pane.exited) return;
        console.warn(`scrcpy ${device}:`, err?.message);
        retry(`${pane.model}: ${err?.message ?? 'stopped'}. Trying again…`);
      });
      mirror.start();
    };
    connect();
    return id;
  }

  // A page pane is a webview in the window, which loads the page, follows its links
  // and reports where it is (see 'page:state'). The page goes away with the pane.
  #spawnPagePane(term, { page }) {
    const id = crypto.randomUUID();
    term.panes.set(id, { id, kind: 'page', page, mux: null, session: null, app: null, instance: null, title: new URL(page).host, process: 'web', exited: false });
    return id;
  }

  // A planner pane is a webview in the window that loads the planner page with its
  // preload (see will-attach-webview), so it edits every window's layout, its own too.
  #spawnPlannerPane(term) {
    const id = crypto.randomUUID();
    term.panes.set(id, { id, kind: 'planner', planner: true, mux: null, session: null, app: null, instance: null, title: 'Plan layout', process: 'planner', exited: false });
    return id;
  }

  // A camera pane shows a V4L2 capture device, found and opened by the window; the
  // DroidCam client, not the app, feeds the phone's camera into it.
  #spawnCameraPane(term, source) {
    const id = crypto.randomUUID();
    term.panes.set(id, { id, kind: 'camera', droidcam: true, fillWidth: Boolean(source.fillWidth), mux: null, session: null, app: null, instance: null, title: 'DroidCam', process: 'droidcam', exited: false });
    return id;
  }

  // A launcher pane is a form the window draws (see createLauncherPane in the renderer).
  #spawnLauncherPane(term) {
    const id = crypto.randomUUID();
    term.panes.set(id, { id, kind: 'launcher', launcher: true, mux: null, session: null, app: null, instance: null, title: 'New pane', process: 'launcher', exited: false });
    return id;
  }

  // A pod pane makes its pod first if newPod says how, waits for it to be ready,
  // and shows its UI through kubectl port-forward. The forward ends when the pod's
  // container restarts or the pod goes, so the pane then says so and tries again
  // every few seconds. The pod keeps running when the pane closes.
  #spawnPodPane(term, { pod, namespace, newPod = null }) {
    const id = crypto.randomUUID();
    const label = `${namespace}/${pod}`;
    const pane = { id, kind: 'web', pod, namespace, url: null, error: null, forward: null, retry: null, mux: null, session: null, app: null, instance: null, title: pod, process: 'pod', exited: false };
    term.panes.set(id, pane);
    const show = (url, error) => {
      if (pane.exited || term.panes.get(id) !== pane) return;
      pane.url = url;
      pane.error = error;
      this.#sendLayout(term);
    };
    const retry = (err) => {
      pane.forward = null;
      if (pane.exited) return;
      console.warn(`pod ${label}:`, err.message);
      show(null, `${err.message}. Trying again…`);
      pane.retry = setTimeout(connect, 3000);
    };
    const connect = async () => {
      pane.retry = null;
      if (pane.exited) return;
      if (!this.kubectl) return show(null, 'kubectl is not installed');
      try {
        if (newPod) {
          await kube.create(this.kubectl, namespace, pod, newPod.repo, newPod.tag, newPod.port, newPod.mounts, newPod.gpu);
          newPod = null;
          this.refreshSessions();
        }
        show(null, null);
        const found = (await kube.pods(this.kubectl)).find((p) => p.namespace === namespace && p.name === pod);
        if (found && found.port === null) return show(null, 'The pod has no browser port to show');
        await kube.waitReady(this.kubectl, namespace, pod);
        const port = found?.port ?? kube.DEFAULT_PORT;
        if (pane.exited) return;
        const { child, url } = await kube.forward(this.kubectl, namespace, pod, port);
        if (pane.exited) return child.kill();
        pane.forward = child;
        child.on('exit', () => {
          if (pane.forward === child) retry(new Error('the connection to the pod ended'));
        });
        await ls.waitForHttp(url, 90000);
        show(url, null);
      } catch (err) {
        // A pod that could not be made is not tried again: the form is the place to fix it.
        if (newPod) return show(null, err.message);
        // Out of pane.forward first, so its exit does not try again a second time.
        const child = pane.forward;
        pane.forward = null;
        child?.kill();
        retry(err);
      }
    };
    connect();
    return id;
  }

  // Reloads a page pane, e.g. after a change to the page on the server.
  reloadPage(id, paneId) {
    const term = this.get(id);
    if (term?.panes.get(paneId)?.kind !== 'page' || term.win.isDestroyed()) return false;
    term.win.webContents.send('page:reload', paneId);
    return true;
  }

  // A camera pane's video spans the pane's width, its top and bottom cropped to the
  // pane's height, rather than showing whole inside it. Only with other panes beside it.
  setCameraFillWidth(id, paneId, on) {
    const term = this.get(id);
    const pane = term?.panes.get(paneId);
    if (pane?.kind !== 'camera') return false;
    pane.fillWidth = Boolean(on);
    this.#pushLayout(term);
    return true;
  }

  // Asks the window to make a camera pane as tall as its video is at the pane's width,
  // by resizing the split above it; the window knows the video's size and the pane's.
  fitCameraHeight(id, paneId) {
    const term = this.get(id);
    if (term?.panes.get(paneId)?.kind !== 'camera' || term.win.isDestroyed()) return false;
    term.win.webContents.send('camera:fit-height', paneId);
    return true;
  }

  #makePane(term, source) {
    if (source?.planner) return this.#spawnPlannerPane(term);
    if (source?.launcher) return this.#spawnLauncherPane(term);
    if (source?.pod || source?.newPod) return this.#spawnPodPane(term, source);
    if (source?.droidcam) return this.#spawnCameraPane(term, source);
    if (source?.page) return this.#spawnPagePane(term, source);
    if (source?.device) return this.#spawnScrcpyPane(term, source);
    return source?.app || source?.container ? this.#spawnWebPane(term, source) : this.#spawnPane(term, source);
  }

  // A shell's pty is killed, and its exit removes the pane. A multiplexer client
  // only detaches; an app's container keeps running. A device's mirror stops.
  #endPane(pane) {
    if (pane.pty && !pane.exited) pane.pty.kill();
    pane.exited = true;
    clearTimeout(pane.retry);
    pane.mirror?.stop();
    pane.forward?.kill();
  }

  // Lists every installed multiplexer's sessions, the linuxserver apps and the
  // Android devices. The planner shows them in each pane's menu.
  async refreshSessions() {
    const [lists, images, containers, labelled, devices, pods] = await Promise.all([
      Promise.all([...this.muxes].map(async ([m, bin]) => [m, await mux.list(m, bin)])),
      this.docker ? ls.images(this.docker) : [],
      this.docker ? ls.list(this.docker) : [],
      this.docker ? ls.labelled(this.docker) : [],
      this.adb ? scrcpy.devices(this.adb) : [],
      this.kubectl ? kube.pods(this.kubectl).catch(() => this.pods) : [],
    ]);
    const next = { sessions: new Map(lists), apps: { images, containers, labelled }, devices, pods };
    const key = ({ sessions, apps, devices, pods }) => JSON.stringify([[...sessions].map(([m, names]) => [m, [...names]]), apps, devices, pods]);
    if (key(next) === key(this)) return;
    this.sessions = next.sessions;
    this.apps = next.apps;
    this.devices = next.devices;
    this.pods = next.pods;
    this.#sendPlanners();
  }

  // A planner menu choice: 'shell', '<mux>:new', '<mux>:<name>' (e.g. 'tmux:work'),
  // 'ls:new:<app>:<tag>' (e.g. 'ls:new:chromium:latest'), 'ls:<app>:<instance>',
  // 'container:<name>' (a container labelled lan-terminal.pane=<name>) or
  // 'scrcpy:<adb serial>', 'scrcpy-display:<display>:<adb serial>' (a new display,
  // see scrcpy.validDisplay), 'scrcpy-app:<package>:<adb serial>' (an app moving from
  // the pane it is on), 'page:<url>' (a web page), 'planner' (the layout planner) or
  // 'droidcam' (DroidCam's camera).
  // Returns a source (see leafSource). A new session or app instance gets the smallest
  // free number, like `ptmux new` and `tmux new`
  // without a name, skipping names that panes already use.
  async #resolveSource(source) {
    if (source === 'shell') return null;
    if (source === 'planner') return { planner: true };
    if (source === 'launcher') return { launcher: true };
    if (source === 'droidcam') return { droidcam: true };
    if (typeof source === 'string' && source.startsWith('pod:')) return this.#resolvePod(source.slice(4));
    if (typeof source === 'string' && source.startsWith('page:')) {
      const page = source.slice(5);
      if (!validPage(page)) throw new Error('a web page must be an http or https URL');
      this.config.recentPages = [page, ...this.#recentPages().filter((u) => u !== page)].slice(0, RECENT_PAGES);
      saveConfig(this.config);
      return { page };
    }
    if (typeof source === 'string' && source.startsWith('ls:')) return this.#resolveApp(source.slice(3).split(':'));
    if (typeof source === 'string' && source.startsWith('container:')) {
      if (!this.docker) throw new Error('docker is not installed');
      const container = source.slice(10);
      if (!ls.validName(container)) throw new Error('bad container name');
      return { container };
    }
    // An app that has been on a device pane, moving to this pane: 'scrcpy-app:<package>:<serial>'.
    if (typeof source === 'string' && source.startsWith('scrcpy-app:')) {
      const rest = source.slice(11);
      const pkg = rest.slice(0, rest.indexOf(':'));
      const serial = rest.slice(pkg.length + 1);
      if (!this.adb) throw new Error('adb is not installed');
      if (!scrcpy.validSerial(serial) || !scrcpy.validPackage(pkg)) throw new Error('bad device app');
      // A pane that is not on the device becomes a new display like the one the app
      // is on, or one that fits the pane.
      const from = this.#devicePanes().find((p) => p.device === serial && p.foreground === pkg && p.display !== null);
      return { device: serial, display: from?.display ?? 'fit', startApp: pkg, move: true };
    }
    if (typeof source === 'string' && /^scrcpy(-display)?:/.test(source)) {
      // Serials of devices on the network contain ':' themselves; displays do not.
      let rest = source.slice(source.indexOf(':') + 1);
      let display = null;
      if (source.startsWith('scrcpy-display:')) {
        display = rest.slice(0, rest.indexOf(':'));
        rest = rest.slice(display.length + 1);
        if (!scrcpy.validDisplay(display)) throw new Error('bad display size');
      }
      if (!this.adb) throw new Error('adb is not installed');
      if (!scrcpy.validSerial(rest)) throw new Error('bad adb serial');
      return { device: rest, display };
    }
    const [, m, name] = (typeof source === 'string' && source.match(/^([a-z]+):(.*)$/)) || [];
    if (!mux.MUXES[m]) throw new Error('unknown pane source');
    if (!this.muxes.has(m)) throw new Error(`${m} is not installed`);
    if (name === 'new') {
      await this.refreshSessions();
      const taken = new Set(this.sessions.get(m)?.keys());
      for (const term of this.terminals.values()) for (const p of term.panes.values()) if (p.mux === m) taken.add(p.session);
      for (let n = 0; ; n++) if (!taken.has(String(n))) return { mux: m, name: String(n) };
    }
    if (!mux.validSession(name)) throw new Error('bad session name');
    return { mux: m, name };
  }

  async #resolveApp(parts) {
    if (!this.docker) throw new Error('docker is not installed');
    await this.refreshSessions();
    if (parts[0] === 'new') {
      const [, app, tag] = parts;
      if (!ls.validApp(app) || !ls.validTag(tag)) throw new Error('bad linuxserver image');
      const taken = new Set(this.apps.containers.filter((c) => c.app === app).map((c) => c.name));
      for (const term of this.terminals.values()) for (const p of term.panes.values()) if (p.app === app) taken.add(p.instance);
      for (let n = 0; ; n++) if (!taken.has(String(n))) return { app, instance: String(n), tag };
    }
    const [app, instance] = parts;
    if (!ls.validApp(app) || !ls.validName(instance)) throw new Error('bad linuxserver app');
    const tag = this.apps.containers.find((c) => c.app === app && c.name === instance)?.tag ?? 'latest';
    return { app, instance, tag };
  }

  // 'pod:<namespace>:<name>' opens a pod; 'pod:new:<json>' makes one from { namespace,
  // repo, tag, port, mounts, gpu } (port the browser port, or null for none; mounts:
  // [{ host, path, chown }], each host one of hostDirs; gpu true for the node's GPUs),
  // named <app>-<tag>-<n> with the smallest n free in the namespace, and makes the
  // namespace the one the next new pod form starts on.
  async #resolvePod(spec) {
    if (!this.kubectl) throw new Error('kubectl is not installed');
    if (!spec.startsWith('new:')) {
      const parts = spec.split(':');
      const [namespace, pod] = parts;
      if (parts.length !== 2 || !kube.validName(namespace) || !kube.validName(pod)) throw new Error('bad pod');
      return { pod, namespace };
    }
    let wanted;
    try {
      wanted = JSON.parse(spec.slice(4));
    } catch {
      throw new Error('bad new pod');
    }
    const { namespace, repo, tag, port = null, mounts = [], gpu = false } = wanted ?? {};
    if (!kube.validName(namespace) || !registry.validRepo(repo) || !registry.validTag(tag) || !kube.validBrowserPort(port) || typeof gpu !== 'boolean') {
      throw new Error('bad pod image');
    }
    kube.checkMounts(mounts);
    const unknown = mounts.find((m) => !this.#hostDirs().includes(m.host));
    if (unknown) throw new Error(`${unknown.host} is not one of the host directories`);
    const app = registry.parseImage(`${repo}:${tag}`).app;
    await this.refreshSessions();
    const taken = new Set(this.pods.filter((p) => p.namespace === namespace).map((p) => p.name));
    for (const term of this.terminals.values()) for (const p of term.panes.values()) if (p.namespace === namespace) taken.add(p.pod);
    this.config.podNamespace = namespace;
    saveConfig(this.config);
    return { pod: kube.freeName(app, tag, taken), namespace, newPod: { repo, tag, port, mounts: mounts.map((m) => ({ host: m.host, path: m.path, ...(m.chown && { chown: { uid: m.chown.uid, gid: m.chown.gid } }) })), gpu } };
  }

  #imagePrefixes() {
    const prefixes = this.config.imagePrefixes;
    return Array.isArray(prefixes) ? prefixes.filter(registry.validPrefix) : [];
  }

  #hostDirs() {
    const dirs = this.config.hostDirs;
    return Array.isArray(dirs) ? dirs.filter(kube.validPath) : [];
  }

  // Adds or removes one of the New pane form's presets (see launcherState). A host
  // directory is a path on the cluster's nodes, only saved here: the node makes it
  // when a pod mounts it. Removing one leaves the pods that mount it alone.
  setPreset(kind, value, on) {
    if (typeof value !== 'string') throw new Error('bad preset');
    if (kind === 'prefix') {
      const prefix = value.trim().replace(/\/*$/, '/');
      if (on && !registry.validPrefix(prefix)) throw new Error(`${value} is not an image prefix, such as lscr.io/linuxserver/ or ghcr.io/org/`);
      const rest = this.#imagePrefixes().filter((p) => p !== prefix);
      this.config.imagePrefixes = on ? [...rest, prefix] : rest;
    } else if (kind === 'hostDir') {
      const dir = value.trim().length > 1 ? value.trim().replace(/\/+$/, '') : value.trim();
      if (on && !kube.validPath(dir)) throw new Error(`${value} is not an absolute path`);
      const rest = this.#hostDirs().filter((d) => d !== dir);
      this.config.hostDirs = on ? [...rest, dir].sort() : rest;
    } else {
      throw new Error('bad preset');
    }
    saveConfig(this.config);
  }

  // What a launcher pane's form offers: the namespaces, the one to start on (where the
  // last new pod went, while it exists), the app's pods and chown jobs, and the presets: image
  // prefixes, host directories and the user and group a mount's chown starts on.
  // Whatever cannot be listed comes back empty, with
  // the reason in errors. The images under a prefix come separately (launcher:images).
  async launcherState() {
    const id = (n) => (Number.isInteger(n) && n >= 0 ? n : 1000);
    const presets = { prefixes: this.#imagePrefixes(), hostDirs: this.#hostDirs(), chownUid: id(this.config.chownUid), chownGid: id(this.config.chownGid) };
    if (!this.kubectl) return { namespaces: [], namespace: null, pods: [], jobs: [], ...presets, errors: ['kubectl is not installed'] };
    const errors = [];
    const failed = (fallback) => (err) => {
      errors.push(err.message);
      return fallback;
    };
    const [namespaces, pods, jobs] = await Promise.all([
      kube.namespaces(this.kubectl).catch(failed([])),
      kube.pods(this.kubectl).catch(failed(this.pods)),
      kube.chownJobs(this.kubectl).catch(failed([])),
    ]);
    const last = this.config.podNamespace;
    return { namespaces, namespace: namespaces.includes(last) ? last : namespaces.includes('default') ? 'default' : namespaces[0] ?? null, pods, jobs, ...presets, errors };
  }

  // Makes a new pod (wanted as for 'pod:new:', see #resolvePod) without opening it.
  async createPod(wanted) {
    const { pod, namespace, newPod } = await this.#resolvePod(`new:${JSON.stringify(wanted)}`);
    await kube.create(this.kubectl, namespace, pod, newPod.repo, newPod.tag, newPod.port, newPod.mounts, newPod.gpu);
    await this.refreshSessions();
    return { pod, namespace };
  }

  // Starts a chown job (see kube.createChownJob) on one of the host directories.
  async createChownJob(namespace, host, uid, gid) {
    if (!this.kubectl) throw new Error('kubectl is not installed');
    if (!this.#hostDirs().includes(host)) throw new Error(`${host} is not one of the host directories`);
    await kube.createChownJob(this.kubectl, namespace, host, uid, gid);
  }

  // Runs a job (see kube.scanHostDir) that lists every subdirectory under dir on the
  // node, at any depth, and offers each as a host directory preset. Resolves with the
  // paths added.
  async scanHostDirs(namespace, dir) {
    if (!this.kubectl) throw new Error('kubectl is not installed');
    const names = await kube.scanHostDir(this.kubectl, namespace, dir);
    const paths = names.map((n) => `${dir === '/' ? '' : dir}/${n}`);
    for (const p of paths) this.setPreset('hostDir', p, true);
    return paths;
  }

  async createNamespace(name) {
    if (!this.kubectl) throw new Error('kubectl is not installed');
    await kube.createNamespace(this.kubectl, name);
  }

  // Deletes one of the app's pods and puts New pane forms in place of the panes that
  // showed it.
  async deletePod(namespace, pod) {
    if (!this.kubectl) throw new Error('kubectl is not installed');
    await kube.remove(this.kubectl, namespace, pod);
    for (const term of [...this.terminals.values()]) {
      for (const pane of [...term.panes.values()]) {
        if (pane.pod === pod && pane.namespace === namespace) this.#formInPlace(term, pane.id);
      }
    }
    await this.refreshSessions();
  }

  // Stops an app's container and puts New pane forms in place of the panes that showed it.
  async stopApp(app, instance) {
    if (!this.docker) throw new Error('docker is not installed');
    await ls.stop(this.docker, app, instance);
    for (const term of [...this.terminals.values()]) {
      for (const pane of [...term.panes.values()]) if (pane.app === app && pane.instance === instance) this.#formInPlace(term, pane.id);
    }
    await this.refreshSessions();
  }

  // A pane that closed without being asked to: a New pane form takes its place.
  #formInPlace(term, paneId) {
    if (term.closed || !term.panes.has(paneId)) return;
    this.#swapPane(term, paneId, { launcher: true });
  }

  #removePane(term, paneId) {
    if (term.closed || !term.panes.has(paneId)) return;
    term.panes.delete(paneId);
    const heir = layout.heir(term.layout, paneId);
    const next = layout.removePane(term.layout, paneId);
    if (!next && !term.locked) {
      if (!term.win.isDestroyed()) term.win.close();
      return;
    }
    this.#setLayout(term, next, term.activePane === paneId ? heir : term.activePane);
    this.#pushLayout(term);
  }

  // A locked window keeps its place on screen with no panes, so an OBS source pointed
  // at it does not jump to another window when its last shell exits.
  #setLayout(term, tree, active) {
    term.layout = tree;
    term.activePane = tree ? active : null;
    if (!tree || !layout.leaves(tree).includes(term.maximized)) term.maximized = null;
    const leaves = new Set(tree ? layout.leaves(tree) : []);
    for (const p of term.pinned) if (!leaves.has(p)) term.pinned.delete(p);
  }

  // In any pane, Ctrl+Shift+Alt+Z maximizes the active pane or puts it back,
  // Ctrl+Shift+Alt+Q puts a New pane form in its place, Ctrl+Shift+Alt+F switches
  // between fullscreen and maximized, and Ctrl+Shift+Alt+R resize mode.
  #windowKey(term, input) {
    if (input.type !== 'keyDown' || input.isAutoRepeat) return false;
    if (!(input.control && input.shift && input.alt && !input.meta)) return false;
    if (input.code === 'KeyZ') {
      if (term.activePane) this.maximizePane(term.id, term.maximized ? null : term.activePane);
    } else if (input.code === 'KeyQ') {
      if (term.activePane) this.homePane(term.id, term.activePane);
    } else if (input.code === 'KeyF') {
      this.setAlwaysOnTop(term.id, !term.alwaysOnTop);
    } else if (input.code === 'KeyR') {
      this.setResizeMode(term.id, !term.resizeMode);
    } else {
      return false;
    }
    return true;
  }

  // saved is a pane shape; empty: true opens it with no panes (a locked window saved
  // empty). Without either the window starts with one New pane form.
  create({ layout: saved, empty = false, locked = false } = {}) {
    const id = crypto.randomUUID();
    const bounds = this.#maximizedBounds();

    const win = new BrowserWindow({
      ...bounds,
      frame: false,
      roundedCorners: false,
      resizable: false,
      maximizable: false,
      minimizable: true,
      fullscreenable: false,
      closable: true, // closable programmatically; there is no close button to click
      backgroundColor: this.config.background,
      title: 'LAN Terminal',
      show: false,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // A device pane plays the device's sound without a click first.
        autoplayPolicy: 'no-user-gesture-required',
        // Web page panes; see will-attach-webview below.
        webviewTag: true,
      },
    });
    win.setMenu(null);

    // A page pane's webview gets no preload or Node, only http(s) pages, and the
    // session that keeps logins across restarts. A planner pane's gets the planner
    // page and the planner window's preload, in a session of its own.
    win.webContents.on('will-attach-webview', (event, prefs, params) => {
      delete prefs.preload;
      Object.assign(prefs, { nodeIntegration: false, nodeIntegrationInSubFrames: false, contextIsolation: true, sandbox: true });
      if (params.src === PLANNER_PANE_URL && params.partition === PLANNER_PARTITION) prefs.preload = PLANNER_PRELOAD;
      else if (!validPage(params.src) || params.partition !== 'persist:pages') event.preventDefault();
    });
    win.webContents.on('did-attach-webview', (_event, guest) => {
      if (guest.session === session.fromPartition(PLANNER_PARTITION)) {
        // It stays on the planner page.
        guest.setWindowOpenHandler(() => ({ action: 'deny' }));
        guest.on('will-navigate', (event) => event.preventDefault());
        guest.on('before-input-event', (event, input) => {
          if (this.#windowKey(term, input)) event.preventDefault();
        });
        this.panePlanners.add(guest);
        guest.once('destroyed', () => this.panePlanners.delete(guest));
        this.refreshSessions();
        return;
      }
      // Links that open a new window open in the pane instead.
      guest.setWindowOpenHandler(({ url }) => {
        if (validPage(url)) guest.loadURL(url);
        return { action: 'deny' };
      });
      // Browser keys: F5 or Ctrl+R reloads (with Shift, past the cache), Alt+Left and
      // Alt+Right go back and forward.
      guest.on('before-input-event', (event, input) => {
        if (this.#windowKey(term, input)) return event.preventDefault();
        if (input.type !== 'keyDown') return;
        const ctrl = input.control || input.meta;
        const nav = guest.navigationHistory;
        if (input.key === 'F5' || (ctrl && input.code === 'KeyR')) {
          if (input.shift) guest.reloadIgnoringCache();
          else guest.reload();
        } else if (input.alt && !ctrl && input.key === 'ArrowLeft' && nav.canGoBack()) {
          nav.goBack();
        } else if (input.alt && !ctrl && input.key === 'ArrowRight' && nav.canGoForward()) {
          nav.goForward();
        } else {
          return;
        }
        event.preventDefault();
      });
    });

    const term = { id, win, panes: new Map(), layout: null, activePane: null, maximized: null, pinned: new Set(), locked: Boolean(locked), moveMode: false, resizeMode: false, alwaysOnTop: false, ready: false };
    this.terminals.set(id, term);
    if (!(empty && term.locked)) {
      term.layout = saved
        ? layout.hydrate(saved, (leaf) => this.#makePane(term, leafSource(leaf)), isLeaf)
        : layout.pane(this.#makePane(term, { launcher: true }));
      term.activePane = layout.leaves(term.layout)[0];
    }

    // A reload (e.g. renderer crash recovery) needs a fresh handshake. Only the page
    // itself counts: an app pane's iframe loading must not stop layouts and output.
    win.webContents.on('did-start-navigation', (details) => {
      if (!details.isMainFrame || details.isSameDocument) return;
      term.ready = false;
      for (const pane of term.panes.values()) if (pane.pty || pane.kind === 'scrcpy') pane.ready = false;
    });
    win.webContents.on('page-title-updated', (event, title) => {
      // xterm.js forwards the shell's OSC title; keep the window title stable for OBS.
      event.preventDefault();
      // The renderer titles the page "<paneId>\t<title>" so the title lands on the right pane.
      const tab = title.indexOf('\t');
      const pane = tab > 0 && term.panes.get(title.slice(0, tab));
      if (!pane) return;
      pane.title = title.slice(tab + 1);
      this.#changed();
    });
    // Before the pane sees the key, so it works in app and page panes too.
    win.webContents.on('before-input-event', (event, input) => {
      if (this.#windowKey(term, input)) event.preventDefault();
    });
    win.on('focus', () => this.#changed());
    win.on('moved', () => this.#changed());
    // Nothing but quitting closes a locked window, not even the window manager.
    win.on('close', (event) => {
      if (term.locked && !this.quitting) event.preventDefault();
    });
    win.on('closed', () => {
      term.closed = true;
      for (const pane of term.panes.values()) if (!pane.exited) this.#endPane(pane);
      this.terminals.delete(id);
      this.#changed();
      this.#saveSoon();
    });
    win.once('ready-to-show', () => win.show());
    // A new window starts maximized; KWin also shrinks it to the work area when it is
    // mapped, so set the size again once it is shown.
    win.once('show', () => win.setBounds(bounds));

    win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    this.#changed();
    this.#saveSoon();
    return id;
  }

  // Startup: one window per saved entry, with its panes and lock. Session panes
  // reattach to sessions that outlived the app and restart the ones that did not.
  async restore(saved) {
    await this.refreshSessions();
    if (!Array.isArray(saved) || saved.length === 0) return this.create();
    const ids = saved.map((w) => this.create({ layout: w?.panes ?? undefined, empty: w?.panes === null, locked: w?.locked }));
    return ids[0];
  }

  get(id) {
    return this.terminals.get(String(id)) || null;
  }

  list() {
    return [...this.terminals.values()]
      .filter((t) => !t.win.isDestroyed())
      .map((t) => {
        const b = t.win.getBounds();
        const active = t.panes.get(t.activePane);
        return {
          id: t.id,
          title: active?.title ?? '',
          process: active?.process ?? '',
          mux: active?.mux ?? null,
          session: active?.session ?? null,
          app: active?.app ?? null,
          instance: active?.instance ?? null,
          container: active?.container ?? null,
          page: active?.page ?? null,
          device: active?.device ?? null,
          display: active?.display ?? null,
          deviceApp: active?.foreground ?? null,
          x: b.x,
          y: b.y,
          width: b.width,
          height: b.height,
          locked: t.locked,
          maximized: t.maximized,
          moveMode: t.moveMode,
          alwaysOnTop: t.alwaysOnTop,
          focused: t.win.isFocused(),
          minimized: t.win.isMinimized(),
          pid: active?.pty?.pid ?? null,
          panes: this.#paneList(t),
        };
      });
  }

  close(id) {
    const term = this.get(id);
    if (!term) return false;
    if (term.locked) throw new Error('window is locked');
    term.win.close();
    return true;
  }

  // A locked window cannot be closed and stays open when its last pane exits.
  setLocked(id, locked) {
    const term = this.get(id);
    if (!term) return false;
    term.locked = Boolean(locked);
    // Unlocking an empty window would leave a window nothing can fill or close itself.
    if (!term.locked && !term.layout) {
      term.win.close();
      return true;
    }
    this.#changed();
    this.#saveSoon();
    return true;
  }

  // A shell, multiplexer session, linuxserver app, device or web page (see
  // #resolveSource) in an empty window.
  async addPane(id, choice = 'shell') {
    const source = await this.#resolveSource(choice);
    const term = this.get(id);
    if (!term || term.layout) return false;
    const paneId = this.#makePane(term, source);
    if (source?.move) this.#claimApp(term.panes.get(paneId), source.startApp);
    this.#setLayout(term, layout.pane(paneId), paneId);
    this.#pushLayout(term);
    return true;
  }

  // Swaps what a pane shows (see #resolveSource) for a new pane in the same place. A
  // multiplexer client that goes away leaves its session running, and an app keeps
  // its container.
  async setPaneSource(id, paneId, choice) {
    const source = await this.#resolveSource(choice);
    const term = this.get(id);
    const old = term?.panes.get(paneId);
    if (!old || term.closed) return false;
    // A pane already on the app's device keeps its display and opens the app there.
    if (source?.move && old.device === source.device && old.mirror && old.video) {
      return old.foreground === source.startApp || this.openDeviceApp(id, paneId, source.startApp);
    }
    if (!source?.move && sameSource(old, source)) return false;
    const newId = this.#swapPane(term, paneId, source);
    if (source?.move) this.#claimApp(term.panes.get(newId), source.startApp);
    return true;
  }

  // Ends pane paneId and puts a new pane showing source in its place, which keeps its
  // size, and its being active, maximized or pinned. Returns the new pane's id.
  #swapPane(term, paneId, source) {
    const old = term.panes.get(paneId);
    const newId = this.#makePane(term, source);
    // Out of the map first, so the old pty's exit does not remove the pane's place.
    term.panes.delete(paneId);
    this.#endPane(old);
    if (term.maximized === paneId) term.maximized = newId;
    if (term.pinned.has(paneId)) term.pinned.add(newId);
    this.#setLayout(term, layout.replacePane(term.layout, paneId, newId), term.activePane === paneId ? newId : term.activePane);
    this.#pushLayout(term);
    return newId;
  }

  // Closes a pane and opens what it showed again, in the same place: a shell starts
  // afresh, a session or pod is attached to again, a page loads its URL again.
  reloadPane(id, paneId) {
    const term = this.get(id);
    const pane = term?.panes.get(paneId);
    if (!pane || term.closed) return false;
    this.#swapPane(term, paneId, leafSource(paneLeaf(pane)));
    return true;
  }

  // Closes a pane and puts a New pane form in its place. A form stays as it is.
  homePane(id, paneId) {
    const term = this.get(id);
    const pane = term?.panes.get(paneId);
    if (!pane || term.closed || pane.kind === 'launcher') return false;
    this.#swapPane(term, paneId, { launcher: true });
    return true;
  }

  resetPosition(id) {
    return this.setPosition(id, 0, 0);
  }

  setPosition(id, x, y) {
    const term = this.get(id);
    if (!term) return false;
    if (!Number.isInteger(x) || !Number.isInteger(y)) throw new Error('x and y must be integers');
    term.win.setPosition(x, y);
    this.#changed();
    return true;
  }

  setMoveMode(id, enabled) {
    const term = this.get(id);
    if (!term) return false;
    term.moveMode = Boolean(enabled);
    term.drag = null;
    term.win.webContents.send('moveMode', term.moveMode);
    if (term.moveMode) this.focus(id);
    this.#changed();
    return true;
  }

  // Resize mode puts handles on the lines between panes, to drag like the planner's.
  setResizeMode(id, enabled) {
    const term = this.get(id);
    if (!term) return false;
    term.resizeMode = Boolean(enabled);
    term.win.webContents.send('resizeMode', term.resizeMode);
    if (term.resizeMode) this.focus(id);
    return true;
  }

  // Fullscreen (always on top) fills the whole display: keep-above puts the window over
  // KDE's panel, and skip-taskbar drops its taskbar and Alt+Tab entry. Off, the window
  // is maximized: a normal window filling the work area beside the panel. Either way it
  // goes back to the top left, wherever move mode had put it.
  setAlwaysOnTop(id, enabled) {
    const term = this.get(id);
    if (!term) return false;
    term.alwaysOnTop = Boolean(enabled);
    term.win.setAlwaysOnTop(term.alwaysOnTop);
    term.win.setSkipTaskbar(term.alwaysOnTop);
    // A resize is not clamped to the work area once the window is mapped.
    term.win.setBounds(term.alwaysOnTop ? this.#fullBounds() : this.#maximizedBounds());
    if (term.alwaysOnTop) this.focus(id);
    this.#changed();
    return true;
  }

  setPresenterMode(enabled) {
    this.config.presenterMode = Boolean(enabled);
    saveConfig(this.config);
    for (const term of this.terminals.values()) {
      if (!term.win.isDestroyed()) term.win.webContents.send('presenterMode', this.config.presenterMode);
    }
    this.#changed();
  }

  focus(id) {
    const term = this.get(id);
    if (!term) return false;
    if (term.win.isMinimized()) term.win.restore();
    term.win.show();
    term.win.moveTop();
    term.win.focus();
    return true;
  }

  // before puts the new pane left of (row) or above (col) paneId. The new pane is a
  // shell, or what source says (see leafSource).
  splitPane(id, paneId, dir, before = false, source = null) {
    const term = this.get(id);
    if (!term || !term.panes.has(paneId)) return false;
    const newId = this.#makePane(term, source);
    try {
      term.layout = layout.splitPane(term.layout, paneId, dir, newId, before);
    } catch (err) {
      this.#endPane(term.panes.get(newId));
      throw err;
    }
    term.activePane = newId;
    term.maximized = null; // the new pane shows
    this.#pushLayout(term);
    return true;
  }

  // Killing the shell removes the pane once it exits (see #spawnPane); a web or
  // device pane has no process to wait for. Only a locked window can lose its last pane this way.
  closePane(id, paneId) {
    const term = this.get(id);
    const pane = term?.panes.get(paneId);
    if (!pane || (term.panes.size === 1 && !term.locked)) return false;
    pane.closing = true;
    this.#endPane(pane);
    if (!pane.pty) this.#removePane(term, paneId);
    return true;
  }

  // Moves pane paneId onto pane targetId of the same window. The center zone trades
  // the two panes' places; an edge zone puts the pane beside the target. Panes do not
  // move between windows; to show a session elsewhere, pick it in another pane.
  movePane(id, paneId, targetId, zone) {
    if (!(zone in ZONES)) throw new Error('unknown drop zone');
    const term = this.get(id);
    if (!term || paneId === targetId || !term.panes.has(paneId) || !term.panes.has(targetId)) return false;
    const place = ZONES[zone];
    term.layout = place
      ? layout.splitPane(layout.removePane(term.layout, paneId), targetId, place.dir, paneId, place.before)
      : layout.swapPanes(term.layout, paneId, targetId);
    term.activePane = paneId;
    term.maximized = null;
    this.#pushLayout(term);
    return true;
  }

  resizeSplit(id, splitPath, sizes) {
    const term = this.get(id);
    if (!term?.layout) return false;
    term.layout = layout.setSizes(term.layout, splitPath, sizes);
    this.#pushLayout(term);
    return true;
  }

  selectPane(id, paneId) {
    const term = this.get(id);
    if (!term || !term.panes.has(paneId)) return false;
    term.activePane = paneId;
    // A pane hidden behind the maximized one would get the keys out of sight.
    if (term.maximized && term.maximized !== paneId) term.maximized = null;
    this.focus(id);
    this.#sendLayout(term);
    this.#changed();
    return true;
  }

  // Fills the window with pane paneId for now, over the others, which keep running at
  // their size; null puts the layout back. Not saved, and splitting or moving a pane,
  // or selecting another, puts it back too.
  maximizePane(id, paneId) {
    const term = this.get(id);
    if (!term || (paneId !== null && !term.panes.has(paneId))) return false;
    term.maximized = paneId;
    if (paneId) term.activePane = paneId;
    this.#sendLayout(term);
    this.#changed();
    return true;
  }

  // A pinned pane stays in sight over a maximized one; see #setLayout.
  pinPane(id, paneId, on) {
    const term = this.get(id);
    if (!term || !term.panes.has(paneId)) return false;
    if (on) term.pinned.add(paneId);
    else term.pinned.delete(paneId);
    this.#sendLayout(term);
    return true;
  }

  // A single planner shows every capture window and its panes. It is a normal framed
  // window and not a terminal, so it stays out of this.terminals and the focus list.
  // It stays on top because the capture windows fill the screen.
  openPlanner() {
    this.refreshSessions();
    if (this.#plannerWindowOpen()) {
      this.planner.show();
      this.planner.focus();
      return true;
    }
    const planner = new BrowserWindow({
      width: 1000,
      height: 680,
      minWidth: 560,
      minHeight: 400,
      title: 'Plan layout — LAN Terminal',
      backgroundColor: '#1b1d22',
      autoHideMenuBar: true,
      alwaysOnTop: true,
      webPreferences: {
        preload: PLANNER_PRELOAD,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    planner.setMenu(null);
    planner.on('closed', () => {
      if (this.planner === planner) this.planner = null;
    });
    this.planner = planner;
    planner.loadFile(PLANNER_PAGE);
    return true;
  }
}

module.exports = { WindowManager };
