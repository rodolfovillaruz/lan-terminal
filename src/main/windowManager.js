const { app, BrowserWindow, ipcMain, screen } = require('electron');
const { EventEmitter } = require('events');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const pty = require('node-pty');
const { save: saveConfig } = require('./config');
const layout = require('./layout');
const mux = require('./mux');
const ls = require('./linuxserver');
const scrcpy = require('./scrcpy');

// Where a dragged pane lands relative to the pane it is dropped on.
const ZONES = {
  center: null, // trade places
  left: { dir: 'row', before: true },
  right: { dir: 'row', before: false },
  top: { dir: 'col', before: true },
  bottom: { dir: 'col', before: false },
};

// What a pane shows, as a source: null for a shell, { mux, name } for a multiplexer
// session, { app, instance, tag } for a linuxserver app (e.g. chromium 0), { device }
// for an Android device's screen (its adb serial). A saved pane shape stores it as
// its leaf: 'pane', { <mux>: name } (e.g. { tmux: 'work' }), { linuxserver: app,
// name, tag } or { scrcpy: serial }. { webtop: name, tag } is the older form for a
// webtop.
const leafSource = (s) => {
  if (scrcpy.validSerial(s?.scrcpy)) return { device: s.scrcpy };
  const app = s?.linuxserver ?? (s?.webtop !== undefined ? 'webtop' : undefined);
  const instance = s?.linuxserver ? s.name : s?.webtop;
  if (ls.validApp(app) && ls.validName(instance)) return { app, instance, tag: ls.validTag(s.tag) ? s.tag : 'latest' };
  const found = mux.NAMES.filter((m) => mux.validSession(s?.[m]));
  return found.length === 1 ? { mux: found[0], name: s[found[0]] } : null;
};
const isLeaf = (s) => s === 'pane' || leafSource(s) !== null;
const paneLeaf = (p) =>
  p.device ? { scrcpy: p.device } : p.app ? { linuxserver: p.app, name: p.instance, tag: p.tag } : p.session ? { [p.mux]: p.session } : 'pane';
const sameSource = (p, source) =>
  (p.device ?? null) === (source?.device ?? null) &&
  p.app === (source?.app ?? null) && p.instance === (source?.instance ?? null) &&
  p.mux === (source?.mux ?? null) && p.session === (source?.name ?? null);

class WindowManager extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    // id (UUID) -> { id, win, panes, layout, activePane, locked, moveMode, alwaysOnTop, ready }
    // layout is null for a window with no panes, which only a locked window can be.
    // panes: paneId -> { id, kind, title, process, mux, session, app, instance, ... }
    //   kind 'term': { pty, ready, pending, exited } runs a shell or a multiplexer client;
    //     mux and session name the session it is attached to (see mux.js), or are null.
    //   kind 'web': { app, instance, tag, url, error } shows a linuxserver app, e.g.
    //     webtop or chromium (see linuxserver.js); url is null until it answers.
    //   kind 'scrcpy': { device, model, mirror, status, video, config } shows an
    //     Android device's screen (see scrcpy.js); the window decodes the stream.
    this.terminals = new Map();
    this.saveTimer = null;
    this.planner = null; // the layout planner window, while open
    // Installed multiplexers: mux -> binary path.
    this.muxes = new Map(mux.NAMES.map((m) => [m, mux.find(m, config[m])]).filter(([, bin]) => bin));
    this.sessions = new Map(); // mux -> Map(session name -> target), as last listed
    this.docker = mux.find('docker', config.docker);
    this.apps = { images: [], containers: [] }; // linuxserver apps as last listed
    this.adb = scrcpy.findAdb(config.adb);
    this.devices = []; // Android devices as last listed: [{ serial, model }]
    this.scrcpyTools = null; // the installed scrcpy's { version, server }, once found
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

    // Renderer -> PTY. The sender identifies the window; the pane id picks the shell in it.
    ipcMain.on('pty:input', (event, paneId, data) => this.#pane(event, paneId)?.pty?.write(data));
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
      if (this.#plannerOpen() && event.sender === this.planner.webContents) await this.refreshSessions();
      return this.#plannerState();
    });
    const plannerAction = (channel, fn) =>
      ipcMain.on(channel, async (event, ...args) => {
        if (!this.#plannerOpen() || event.sender !== this.planner.webContents) return;
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
    plannerAction('planner:source', (id, paneId, source) => this.setPaneSource(id, paneId, source));
    plannerAction('planner:add-pane', (id, source) => this.addPane(id, source));
    plannerAction('planner:stop-app', (app, instance) => this.stopApp(app, instance));
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
    if (this.#plannerOpen()) this.planner.webContents.send('planner:state', this.#plannerState());
  }

  #plannerOpen() {
    return Boolean(this.planner && !this.planner.isDestroyed());
  }

  #fullBounds() {
    const { width: dw, height: dh } = screen.getPrimaryDisplay().bounds;
    return { x: 0, y: 0, width: this.config.width || dw, height: this.config.height || dh };
  }

  #paneList(term) {
    return layout.leaves(term.layout).map((id) => {
      const p = term.panes.get(id);
      return { id, title: p.title, process: p.process, mux: p.mux, session: p.session, app: p.app, instance: p.instance, device: p.device ?? null, model: p.model ?? null, pid: p.pty?.pid ?? null };
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
      // Connected Android devices, or null without adb.
      android: this.adb ? this.devices : null,
      windows: [...this.terminals.values()]
        .filter((t) => !t.closed && !t.win.isDestroyed())
        .map((t) => ({ id: t.id, focused: t.win.isFocused(), locked: t.locked, layout: t.layout, active: t.activePane, panes: this.#paneList(t) })),
    };
  }

  #sendLayout(term) {
    if (!term.ready || term.win.isDestroyed()) return;
    // Web panes have no pty to describe them, so the renderer gets what to show.
    const panes = {};
    for (const p of term.panes.values()) {
      if (p.kind === 'web') panes[p.id] = { kind: 'web', url: p.url, error: p.error, label: `${p.app} ${p.instance} (${p.tag})` };
      if (p.kind === 'scrcpy') panes[p.id] = { kind: 'scrcpy', status: p.status };
    }
    term.win.webContents.send('layout', { layout: term.layout, active: term.activePane, panes });
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
    proc.onExit(() => {
      pane.exited = true;
      this.#removePane(term, id);
    });
    return id;
  }

  // An app pane shows a placeholder while the container starts (or is reused), then
  // the app's UI. Closing the pane leaves the container running.
  #spawnWebPane(term, { app, instance, tag }) {
    const id = crypto.randomUUID();
    const pane = { id, kind: 'web', app, instance, tag, url: null, error: null, mux: null, session: null, title: app, process: app, exited: false };
    term.panes.set(id, pane);
    if (!this.docker) {
      pane.error = 'docker is not installed';
      return id;
    }
    ls
      .ensure(this.docker, app, instance, tag)
      .then((url) => { pane.url = url; })
      .catch((err) => {
        pane.error = err.message;
        console.warn(`${app} ${instance}:`, err.message);
      })
      .finally(() => {
        if (term.panes.get(id) !== pane) return;
        this.#sendLayout(term);
        this.refreshSessions();
      });
    return id;
  }

  // A device pane mirrors the device's screen for as long as the pane exists. When
  // the device is not connected, or the stream stops (a cable pulled, the server
  // killed), the pane says so and tries again every few seconds.
  #spawnScrcpyPane(term, { device }) {
    const id = crypto.randomUUID();
    const model = this.devices.find((d) => d.serial === device)?.model ?? device;
    const pane = { id, kind: 'scrcpy', device, model, mirror: null, retry: null, status: `Connecting to ${model}…`, video: null, ready: false, mux: null, session: null, app: null, instance: null, title: model, process: 'scrcpy', exited: false };
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
      const mirror = new scrcpy.Mirror({ adb: this.adb, ...this.scrcpyTools }, device);
      pane.mirror = mirror;
      mirror.on('name', (name) => {
        pane.model = pane.title = name;
        this.#changed();
      });
      mirror.on('session', (video) => {
        pane.video = video;
        send('scrcpy:session', video);
        setStatus(null);
      });
      mirror.on('packet', (packet) => send('scrcpy:packet', packet));
      mirror.on('end', (err) => {
        if (pane.mirror === mirror) pane.mirror = null;
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

  #makePane(term, source) {
    if (source?.device) return this.#spawnScrcpyPane(term, source);
    return source?.app ? this.#spawnWebPane(term, source) : this.#spawnPane(term, source);
  }

  // A shell's pty is killed, and its exit removes the pane. A multiplexer client
  // only detaches; an app's container keeps running. A device's mirror stops.
  #endPane(pane) {
    if (pane.pty) pane.pty.kill();
    pane.exited = true;
    clearTimeout(pane.retry);
    pane.mirror?.stop();
  }

  // Lists every installed multiplexer's sessions, the linuxserver apps and the
  // Android devices. The planner shows them in each pane's menu.
  async refreshSessions() {
    const [lists, images, containers, devices] = await Promise.all([
      Promise.all([...this.muxes].map(async ([m, bin]) => [m, await mux.list(m, bin)])),
      this.docker ? ls.images(this.docker) : [],
      this.docker ? ls.list(this.docker) : [],
      this.adb ? scrcpy.devices(this.adb) : [],
    ]);
    const next = { sessions: new Map(lists), apps: { images, containers }, devices };
    const key = ({ sessions, apps, devices }) => JSON.stringify([[...sessions].map(([m, names]) => [m, [...names]]), apps, devices]);
    if (key(next) === key(this)) return;
    this.sessions = next.sessions;
    this.apps = next.apps;
    this.devices = next.devices;
    if (this.#plannerOpen()) this.planner.webContents.send('planner:state', this.#plannerState());
  }

  // A planner menu choice: 'shell', '<mux>:new', '<mux>:<name>' (e.g. 'tmux:work'),
  // 'ls:new:<app>:<tag>' (e.g. 'ls:new:chromium:latest'), 'ls:<app>:<instance>' or
  // 'scrcpy:<adb serial>'.
  // Returns a source (see leafSource). A new session or app instance gets the smallest
  // free number, like `ptmux new` and `tmux new`
  // without a name, skipping names that panes already use.
  async #resolveSource(source) {
    if (source === 'shell') return null;
    if (typeof source === 'string' && source.startsWith('ls:')) return this.#resolveApp(source.slice(3).split(':'));
    if (typeof source === 'string' && source.startsWith('scrcpy:')) {
      // Serials of devices on the network contain ':' themselves.
      const device = source.slice('scrcpy:'.length);
      if (!this.adb) throw new Error('adb is not installed');
      if (!scrcpy.validSerial(device)) throw new Error('bad adb serial');
      return { device };
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

  // Stops an app's container and removes the panes that showed it.
  async stopApp(app, instance) {
    if (!this.docker) throw new Error('docker is not installed');
    await ls.stop(this.docker, app, instance);
    for (const term of [...this.terminals.values()]) {
      for (const pane of [...term.panes.values()]) if (pane.app === app && pane.instance === instance) this.#removePane(term, pane.id);
    }
    await this.refreshSessions();
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
  }

  // saved is a pane shape; empty: true opens it with no panes (a locked window saved
  // empty). Without either the window starts with one shell.
  create({ layout: saved, empty = false, locked = false } = {}) {
    const id = crypto.randomUUID();
    const bounds = this.#fullBounds();

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
      },
    });
    win.setMenu(null);

    const term = { id, win, panes: new Map(), layout: null, activePane: null, locked: Boolean(locked), moveMode: false, alwaysOnTop: false, ready: false };
    this.terminals.set(id, term);
    if (!(empty && term.locked)) {
      term.layout = saved
        ? layout.hydrate(saved, (leaf) => this.#makePane(term, leafSource(leaf)), isLeaf)
        : layout.pane(this.#spawnPane(term));
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
    // KWin shrinks a new window to the work area (above the panel) when it is mapped.
    // A resize after mapping is not clamped, so restore the full size once it is shown.
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
          device: active?.device ?? null,
          x: b.x,
          y: b.y,
          width: b.width,
          height: b.height,
          locked: t.locked,
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

  // A shell, multiplexer session or linuxserver app (see #resolveSource) in an empty window.
  async addPane(id, choice = 'shell') {
    const source = await this.#resolveSource(choice);
    const term = this.get(id);
    if (!term || term.layout) return false;
    const paneId = this.#makePane(term, source);
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
    if (!old || term.closed || sameSource(old, source)) return false;
    const newId = this.#makePane(term, source);
    // Out of the map first, so the old pty's exit does not remove the pane's place.
    term.panes.delete(paneId);
    this.#endPane(old);
    this.#setLayout(term, layout.replacePane(term.layout, paneId, newId), term.activePane === paneId ? newId : term.activePane);
    this.#pushLayout(term);
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

  // Keep-above puts the window over KDE's panel; skip-taskbar drops its taskbar and Alt+Tab entry.
  setAlwaysOnTop(id, enabled) {
    const term = this.get(id);
    if (!term) return false;
    term.alwaysOnTop = Boolean(enabled);
    term.win.setAlwaysOnTop(term.alwaysOnTop);
    term.win.setSkipTaskbar(term.alwaysOnTop);
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

  splitPane(id, paneId, dir) {
    const term = this.get(id);
    if (!term || !term.panes.has(paneId)) return false;
    const newId = this.#spawnPane(term);
    try {
      term.layout = layout.splitPane(term.layout, paneId, dir, newId);
    } catch (err) {
      this.#endPane(term.panes.get(newId));
      throw err;
    }
    term.activePane = newId;
    this.#pushLayout(term);
    return true;
  }

  // Killing the shell removes the pane once it exits (see #spawnPane); a web or
  // device pane has no process to wait for. Only a locked window can lose its last pane this way.
  closePane(id, paneId) {
    const term = this.get(id);
    const pane = term?.panes.get(paneId);
    if (!pane || (term.panes.size === 1 && !term.locked)) return false;
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
    this.focus(id);
    this.#sendLayout(term);
    this.#changed();
    return true;
  }

  // A single planner shows every capture window and its panes. It is a normal framed
  // window and not a terminal, so it stays out of this.terminals and the focus list.
  // It stays on top because the capture windows fill the screen.
  openPlanner() {
    this.refreshSessions();
    if (this.#plannerOpen()) {
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
        preload: path.join(__dirname, '..', 'preload', 'planner-preload.js'),
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
    planner.loadFile(path.join(__dirname, '..', 'planner', 'planner.html'));
    return true;
  }
}

module.exports = { WindowManager };
