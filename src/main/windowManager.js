const { app, BrowserWindow, ipcMain, screen } = require('electron');
const { EventEmitter } = require('events');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const pty = require('node-pty');
const { save: saveConfig } = require('./config');
const layout = require('./layout');

// Where a dragged pane lands relative to the pane it is dropped on.
const ZONES = {
  center: null, // trade places
  left: { dir: 'row', before: true },
  right: { dir: 'row', before: false },
  top: { dir: 'col', before: true },
  bottom: { dir: 'col', before: false },
};

// ptmux (the pseudo-terminal project) from config, $PATH or cargo's install dir. The
// systemd user service runs without ~/.cargo/bin on its PATH, hence the last one.
function findPtmux(configured) {
  if (configured) return configured;
  const dirs = [...(process.env.PATH || '').split(path.delimiter), path.join(os.homedir(), '.cargo', 'bin')];
  for (const dir of dirs.filter(Boolean)) {
    const file = path.join(dir, 'ptmux');
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return file;
    } catch {
      // not here
    }
  }
  return null;
}

// ptmux session names are socket file names, so they cannot contain '/' or '.'.
const validSession = (name) => typeof name === 'string' && name !== '' && !/[/.]/.test(name);

// A saved pane shape leaf: 'pane' for a shell, { ptmux: name } for a session.
const isLeaf = (s) => s === 'pane' || validSession(s?.ptmux);

class WindowManager extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    // id (UUID) -> { id, win, panes, layout, activePane, locked, moveMode, alwaysOnTop, ready }
    // layout is null for a window with no panes, which only a locked window can be.
    // panes: paneId -> { id, pty, session, title, process, ready, pending, exited }
    // session is the ptmux session the pane is attached to, or null for a plain shell.
    this.terminals = new Map();
    this.saveTimer = null;
    this.planner = null; // the layout planner window, while open
    this.ptmux = findPtmux(config.ptmux);
    this.sessions = []; // live ptmux sessions as of the last `ptmux ls`
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
    ipcMain.on('pty:input', (event, paneId, data) => this.#pane(event, paneId)?.pty.write(data));
    ipcMain.on('pty:resize', (event, paneId, cols, rows) => {
      const pane = this.#pane(event, paneId);
      if (pane && cols > 0 && rows > 0) pane.pty.resize(cols, rows);
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
      if (!pane) return;
      pane.ready = true;
      if (pane.pending) event.sender.send('pty:data', pane.id, pane.pending);
      pane.pending = '';
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
      return { id, title: p.title, process: p.process, session: p.session, pid: p.pty.pid };
    });
  }

  #plannerState() {
    const { width, height } = this.#fullBounds();
    return {
      aspect: width / height,
      ptmux: Boolean(this.ptmux),
      sessions: this.sessions,
      windows: [...this.terminals.values()]
        .filter((t) => !t.closed && !t.win.isDestroyed())
        .map((t) => ({ id: t.id, focused: t.win.isFocused(), locked: t.locked, layout: t.layout, active: t.activePane, panes: this.#paneList(t) })),
    };
  }

  #sendLayout(term) {
    if (!term.ready || term.win.isDestroyed()) return;
    term.win.webContents.send('layout', { layout: term.layout, active: term.activePane });
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
    const leafShape = (t) => (id) => {
      const session = t.panes.get(id)?.session;
      return session ? { ptmux: session } : 'pane';
    };
    const saved = [...this.terminals.values()]
      .filter((t) => !t.closed)
      .map((t) => ({ panes: t.layout ? layout.shape(t.layout, leafShape(t)) : null, locked: t.locked }));
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.config.windows = saved;
      saveConfig(this.config);
    }, 500);
  }

  // With a session name the pane runs a ptmux client attached to that session,
  // starting the session if it is not running. The session outlives the pane: closing
  // the pane only detaches. Without ptmux the pane falls back to a shell.
  #spawnPane(term, session = null) {
    if (!this.ptmux || !validSession(session)) session = null;
    const id = crypto.randomUUID();
    const shell = this.config.shell || process.env.SHELL || os.userInfo().shell || '/bin/bash';
    const [file, args] = session
      ? [this.ptmux, this.sessions.includes(session) ? ['attach', '-t', session] : ['new', '-s', session]]
      : [shell, this.config.shellArgs || []];
    const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
    // Started from inside a ptmux session, the app would pass its $PTMUX on, and
    // `ptmux new` refuses to nest.
    delete env.PTMUX;
    const proc = pty.spawn(file, args, { name: 'xterm-256color', cols: 80, rows: 24, cwd: os.homedir(), env });
    const name = path.basename(file);
    const pane = { id, pty: proc, session, title: session ?? name, process: name, ready: false, pending: '', exited: false };
    term.panes.set(id, pane);
    if (session && !this.sessions.includes(session)) setTimeout(() => this.refreshSessions(), 500);

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

  // Runs `ptmux ls`. The planner shows the result in each pane's menu.
  refreshSessions() {
    if (!this.ptmux) return Promise.resolve();
    return new Promise((resolve) => {
      execFile(this.ptmux, ['ls'], { timeout: 2000 }, (err, stdout) => {
        const names = err ? [] : stdout.split('\n').filter(Boolean);
        if (names.join('\n') !== this.sessions.join('\n')) {
          this.sessions = names;
          if (this.#plannerOpen()) this.planner.webContents.send('planner:state', this.#plannerState());
        }
        resolve();
      });
    });
  }

  // A planner menu choice: 'shell', 'ptmux:new', or 'ptmux:<name>'. Returns the session
  // name, or null for a shell. A new session gets the smallest free number, like
  // `ptmux new` without -s, skipping names that panes already use.
  async #resolveSource(source) {
    if (source === 'shell') return null;
    if (!this.ptmux) throw new Error('ptmux is not installed');
    if (source === 'ptmux:new') {
      await this.refreshSessions();
      const taken = new Set(this.sessions);
      for (const term of this.terminals.values()) for (const p of term.panes.values()) if (p.session) taken.add(p.session);
      for (let n = 0; ; n++) if (!taken.has(String(n))) return String(n);
    }
    const name = typeof source === 'string' && source.startsWith('ptmux:') ? source.slice(6) : null;
    if (!validSession(name)) throw new Error('unknown pane source');
    return name;
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
        ? layout.hydrate(saved, (leaf) => this.#spawnPane(term, leaf?.ptmux), isLeaf)
        : layout.pane(this.#spawnPane(term));
      term.activePane = layout.leaves(term.layout)[0];
    }

    // A reload (e.g. renderer crash recovery) needs a fresh handshake.
    win.webContents.on('did-start-loading', () => {
      term.ready = false;
      for (const pane of term.panes.values()) pane.ready = false;
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
      for (const pane of term.panes.values()) if (!pane.exited) pane.pty.kill();
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
          session: active?.session ?? null,
          x: b.x,
          y: b.y,
          width: b.width,
          height: b.height,
          locked: t.locked,
          moveMode: t.moveMode,
          alwaysOnTop: t.alwaysOnTop,
          focused: t.win.isFocused(),
          minimized: t.win.isMinimized(),
          pid: active?.pty.pid ?? null,
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

  // A shell or ptmux session (see #resolveSource) in an empty window.
  async addPane(id, source = 'shell') {
    const session = await this.#resolveSource(source);
    const term = this.get(id);
    if (!term || term.layout) return false;
    const paneId = this.#spawnPane(term, session);
    this.#setLayout(term, layout.pane(paneId), paneId);
    this.#pushLayout(term);
    return true;
  }

  // Swaps what a pane shows (see #resolveSource) for a new pane in the same place. A
  // ptmux client that goes away leaves its session running.
  async setPaneSource(id, paneId, source) {
    const session = await this.#resolveSource(source);
    const term = this.get(id);
    const old = term?.panes.get(paneId);
    if (!old || term.closed || old.session === session) return false;
    const newId = this.#spawnPane(term, session);
    // Out of the map first, so the old pty's exit does not remove the pane's place.
    term.panes.delete(paneId);
    old.pty.kill();
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
      term.panes.get(newId).pty.kill();
      throw err;
    }
    term.activePane = newId;
    this.#pushLayout(term);
    return true;
  }

  // Killing the shell removes the pane once it exits (see #spawnPane). Only a locked
  // window can lose its last pane this way.
  closePane(id, paneId) {
    const term = this.get(id);
    const pane = term?.panes.get(paneId);
    if (!pane || (term.panes.size === 1 && !term.locked)) return false;
    pane.pty.kill();
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
