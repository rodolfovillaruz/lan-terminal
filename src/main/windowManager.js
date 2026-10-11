const { app, BrowserWindow, ipcMain, screen } = require('electron');
const { EventEmitter } = require('events');
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

class WindowManager extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    // id (UUID) -> { id, win, panes, layout, activePane, moveMode, alwaysOnTop, ready }
    // panes: paneId -> { id, term, pty, title, process, ready, pending, exited }
    // A pane's term is the window showing it; it changes when the pane moves.
    this.terminals = new Map();
    this.saveTimer = null;
    this.planner = null; // the layout planner window, while open
    this.snapshots = new Map(); // request id -> resolve(serialized pane contents)
    this.quitting = false;
    app.on('before-quit', () => { this.quitting = true; });

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
    // A pane's screen and scrollback, serialized so it can move to another window.
    ipcMain.on('pane:serialized', (_event, requestId, data) => {
      const resolve = this.snapshots.get(requestId);
      this.snapshots.delete(requestId);
      resolve?.(typeof data === 'string' ? data : '');
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
    plannerAction('planner:move', (fromId, paneId, toId, targetId, zone) => this.movePane(fromId, paneId, toId, targetId, zone));
    plannerAction('planner:resize', (id, splitPath, sizes) => this.resizeSplit(id, splitPath, sizes));
    plannerAction('planner:select', (id, paneId) => this.selectPane(id, paneId));
    plannerAction('planner:new-window', () => this.create());
    plannerAction('planner:close-window', (id) => this.terminals.size > 1 && this.close(id));
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
      return { id, title: p.title, process: p.process, pid: p.pty.pid };
    });
  }

  #plannerState() {
    const { width, height } = this.#fullBounds();
    return {
      aspect: width / height,
      windows: [...this.terminals.values()]
        .filter((t) => !t.closed && !t.win.isDestroyed())
        .map((t) => ({ id: t.id, focused: t.win.isFocused(), layout: t.layout, active: t.activePane, panes: this.#paneList(t) })),
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

  // Saves each window's pane shape for the next start. The shapes are taken now, not
  // when the timer fires, and nothing is saved while quitting, so the windows closing
  // on quit do not erase the saved set.
  #saveSoon() {
    if (this.quitting) return;
    const saved = [...this.terminals.values()].filter((t) => !t.closed).map((t) => layout.shape(t.layout));
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.config.windows = saved;
      saveConfig(this.config);
    }, 500);
  }

  #spawnPane(term) {
    const id = crypto.randomUUID();
    const shell = this.config.shell || process.env.SHELL || os.userInfo().shell || '/bin/bash';
    const proc = pty.spawn(shell, this.config.shellArgs || [], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: os.homedir(),
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
    });
    const pane = { id, term, pty: proc, title: path.basename(shell), process: path.basename(shell), ready: false, pending: '', exited: false };
    term.panes.set(id, pane);

    proc.onData((data) => {
      // Hold output until the pane's xterm is listening so the first prompt is not lost.
      if (!pane.ready) pane.pending += data;
      else if (!pane.term.win.isDestroyed()) pane.term.win.webContents.send('pty:data', id, data);
    });
    proc.onExit(() => {
      pane.exited = true;
      this.#removePane(pane.term, id);
    });
    return id;
  }

  #removePane(term, paneId) {
    if (term.closed || !term.panes.has(paneId)) return;
    term.panes.delete(paneId);
    const heir = layout.heir(term.layout, paneId);
    const next = layout.removePane(term.layout, paneId);
    if (!next) {
      if (!term.win.isDestroyed()) term.win.close();
      return;
    }
    term.layout = next;
    if (term.activePane === paneId) term.activePane = heir;
    this.#pushLayout(term);
  }

  // Stops sending a pane's output to its window and asks that window for the pane's
  // screen and scrollback. Output from then on waits in pane.pending, after the
  // snapshot, for the window that shows the pane next.
  #detach(pane) {
    pane.ready = false;
    const term = pane.term;
    if (!term.ready || term.win.isDestroyed()) return Promise.resolve('');
    const requestId = crypto.randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.snapshots.delete(requestId);
        resolve('');
      }, 1000);
      this.snapshots.set(requestId, (data) => {
        clearTimeout(timer);
        resolve(data);
      });
      term.win.webContents.send('pane:serialize', requestId, pane.id);
    });
  }

  // The pane did not move after all: its window still has its xterm, so resume output.
  #reattach(pane) {
    const term = pane.term;
    if (term.closed || term.win.isDestroyed()) return;
    pane.ready = true;
    if (pane.pending) term.win.webContents.send('pty:data', pane.id, pane.pending);
    pane.pending = '';
  }

  create({ layout: saved } = {}) {
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

    const term = { id, win, panes: new Map(), layout: null, activePane: null, moveMode: false, alwaysOnTop: false, ready: false };
    this.terminals.set(id, term);
    term.layout = saved ? layout.hydrate(saved, () => this.#spawnPane(term)) : layout.pane(this.#spawnPane(term));
    term.activePane = layout.leaves(term.layout)[0];

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

  // Startup: one window per saved pane shape.
  restore(saved) {
    if (!Array.isArray(saved) || saved.length === 0) return this.create();
    const ids = saved.map((shape) => this.create({ layout: shape }));
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
          x: b.x,
          y: b.y,
          width: b.width,
          height: b.height,
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
    term.win.close();
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

  // Killing the shell removes the pane once it exits (see #spawnPane).
  closePane(id, paneId) {
    const term = this.get(id);
    const pane = term?.panes.get(paneId);
    if (!pane || term.panes.size === 1) return false;
    pane.pty.kill();
    return true;
  }

  // Moves pane paneId of window fromId onto pane targetId of window toId. The center
  // zone trades the two panes' places; an edge zone puts the pane beside the target.
  // Across windows the shell keeps running and its screen and scrollback come along.
  // Moving a window's last pane out closes that window.
  async movePane(fromId, paneId, toId, targetId, zone) {
    if (!(zone in ZONES)) throw new Error('unknown drop zone');
    const from = this.get(fromId);
    const to = this.get(toId);
    const pane = from?.panes.get(paneId);
    const target = to?.panes.get(targetId);
    if (!pane || !target || paneId === targetId) return false;
    const place = ZONES[zone];

    if (from === to) {
      from.layout = place
        ? layout.splitPane(layout.removePane(from.layout, paneId), targetId, place.dir, paneId, place.before)
        : layout.swapPanes(from.layout, paneId, targetId);
      from.activePane = paneId;
      this.#pushLayout(from);
      return true;
    }

    if (from.moving || to.moving) return false;
    from.moving = true;
    to.moving = true;
    try {
      const [snapshot, targetSnapshot] = await Promise.all([this.#detach(pane), place ? null : this.#detach(target)]);
      // A window or pane can go away while the snapshots are on their way.
      if (from.closed || to.closed || pane.exited || target.exited || !from.panes.has(paneId) || !to.panes.has(targetId)) {
        this.#reattach(pane);
        if (!place) this.#reattach(target);
        return false;
      }
      pane.pending = snapshot + pane.pending;
      from.panes.delete(paneId);
      to.panes.set(paneId, pane);
      pane.term = to;

      if (place) {
        to.layout = layout.splitPane(to.layout, targetId, place.dir, paneId, place.before);
        const heir = layout.heir(from.layout, paneId);
        const rest = layout.removePane(from.layout, paneId);
        if (rest) {
          from.layout = rest;
          if (from.activePane === paneId) from.activePane = heir;
        }
        to.activePane = paneId;
        this.#pushLayout(to);
        if (rest) this.#pushLayout(from);
        else from.win.close();
      } else {
        target.pending = targetSnapshot + target.pending;
        to.panes.delete(targetId);
        from.panes.set(targetId, target);
        target.term = from;
        from.layout = layout.replacePane(from.layout, paneId, targetId);
        to.layout = layout.replacePane(to.layout, targetId, paneId);
        if (from.activePane === paneId) from.activePane = targetId;
        if (to.activePane === targetId) to.activePane = paneId;
        this.#pushLayout(from);
        this.#pushLayout(to);
      }
      return true;
    } finally {
      from.moving = false;
      to.moving = false;
    }
  }

  resizeSplit(id, splitPath, sizes) {
    const term = this.get(id);
    if (!term) return false;
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
