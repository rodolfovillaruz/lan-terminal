const { BrowserWindow, ipcMain, screen } = require('electron');
const { EventEmitter } = require('events');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const pty = require('node-pty');
const { save: saveConfig } = require('./config');
const layout = require('./layout');

class WindowManager extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    // id (UUID) -> { id, win, panes, layout, activePane, moveMode, alwaysOnTop, ready, planner }
    // panes: paneId -> { id, pty, title, process, ready, pending, exited }
    this.terminals = new Map();
    this.saveTimer = null;

    // Label each pane with its foreground process (bash, vim, claude, ...).
    setInterval(() => {
      let changed = false;
      for (const term of this.terminals.values()) {
        let paneChanged = false;
        for (const pane of term.panes.values()) {
          try {
            const name = path.basename(pane.pty.process);
            if (name && name !== pane.process) {
              pane.process = name;
              paneChanged = true;
            }
          } catch {
            // The pty can close between ticks.
          }
        }
        if (paneChanged) {
          this.#sendPlanner(term);
          changed = true;
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
    ipcMain.on('pane:focus', (event, paneId) => {
      const term = this.#fromSender(event);
      if (term && term.panes.has(paneId) && term.activePane !== paneId) {
        term.activePane = paneId;
        this.#sendPlanner(term);
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

    // Planner window -> layout of the capture window it was opened for.
    ipcMain.handle('planner:state', (event) => {
      const term = this.#fromPlanner(event);
      return term ? this.#plannerState(term) : null;
    });
    const plannerAction = (channel, fn) =>
      ipcMain.on(channel, (event, ...args) => {
        const term = this.#fromPlanner(event);
        if (!term) return;
        try {
          fn(term, ...args);
        } catch (err) {
          console.warn(`${channel}:`, err.message);
        }
      });
    plannerAction('planner:split', (term, paneId, dir) => this.splitPane(term.id, paneId, dir));
    plannerAction('planner:close', (term, paneId) => this.closePane(term.id, paneId));
    plannerAction('planner:swap', (term, a, b) => this.swapPanes(term.id, a, b));
    plannerAction('planner:resize', (term, splitPath, sizes) => this.resizeSplit(term.id, splitPath, sizes));
    plannerAction('planner:select', (term, paneId) => this.selectPane(term.id, paneId));
  }

  #fromSender(event) {
    for (const term of this.terminals.values()) {
      if (!term.win.isDestroyed() && term.win.webContents === event.sender) return term;
    }
    return null;
  }

  #fromPlanner(event) {
    for (const term of this.terminals.values()) {
      if (term.planner && !term.planner.isDestroyed() && term.planner.webContents === event.sender) return term;
    }
    return null;
  }

  #pane(event, paneId) {
    return this.#fromSender(event)?.panes.get(paneId) || null;
  }

  #changed() {
    this.emit('changed', this.list());
  }

  #paneList(term) {
    return layout.leaves(term.layout).map((id) => {
      const p = term.panes.get(id);
      return { id, title: p.title, process: p.process, pid: p.pty.pid };
    });
  }

  #plannerState(term) {
    const { width, height } = term.win.getBounds();
    return { layout: term.layout, panes: this.#paneList(term), active: term.activePane, aspect: width / height };
  }

  #sendLayout(term) {
    if (!term.ready || term.win.isDestroyed()) return;
    term.win.webContents.send('layout', { layout: term.layout, active: term.activePane });
  }

  #sendPlanner(term) {
    if (term.planner && !term.planner.isDestroyed()) {
      term.planner.webContents.send('planner:state', this.#plannerState(term));
    }
  }

  // Every layout edit lands here: the capture window and the planner redraw from the
  // same tree, and the shape becomes the saved layout for the next start.
  #pushLayout(term) {
    this.#sendLayout(term);
    this.#sendPlanner(term);
    this.#changed();
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.config.layout = layout.shape(term.layout);
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
    const pane = { id, pty: proc, title: path.basename(shell), process: path.basename(shell), ready: false, pending: '', exited: false };
    term.panes.set(id, pane);

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

  create({ layout: saved } = {}) {
    const id = crypto.randomUUID();
    const { width: dw, height: dh } = screen.getPrimaryDisplay().bounds;
    const width = this.config.width || dw;
    const height = this.config.height || dh;

    const win = new BrowserWindow({
      x: 0,
      y: 0,
      width,
      height,
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

    const term = { id, win, panes: new Map(), layout: null, activePane: null, moveMode: false, alwaysOnTop: false, ready: false, planner: null };
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
      this.#sendPlanner(term);
      this.#changed();
    });
    win.on('focus', () => this.#changed());
    win.on('moved', () => this.#changed());
    win.on('closed', () => {
      term.closed = true;
      for (const pane of term.panes.values()) if (!pane.exited) pane.pty.kill();
      if (term.planner && !term.planner.isDestroyed()) term.planner.close();
      this.terminals.delete(id);
      this.#changed();
    });
    win.once('ready-to-show', () => win.show());
    // KWin shrinks a new window to the work area (above the panel) when it is mapped.
    // A resize after mapping is not clamped, so restore the full size once it is shown.
    win.once('show', () => win.setBounds({ x: 0, y: 0, width, height }));

    win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    this.#changed();
    return id;
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

  swapPanes(id, a, b) {
    const term = this.get(id);
    if (!term) return false;
    term.layout = layout.swapPanes(term.layout, a, b);
    this.#pushLayout(term);
    return true;
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
    this.#pushLayout(term);
    return true;
  }

  // One planner per capture window. It is a normal framed window and is not a terminal,
  // so it stays out of this.terminals and the focus list.
  openPlanner(id) {
    const term = this.get(id);
    if (!term) return false;
    if (term.planner && !term.planner.isDestroyed()) {
      term.planner.show();
      term.planner.focus();
      return true;
    }
    const planner = new BrowserWindow({
      width: 900,
      height: 640,
      minWidth: 480,
      minHeight: 360,
      title: 'Pane layout — LAN Terminal',
      backgroundColor: '#1b1d22',
      autoHideMenuBar: true,
      // A keep-above capture window would otherwise cover its own planner.
      alwaysOnTop: term.alwaysOnTop,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'planner-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    planner.setMenu(null);
    planner.on('closed', () => {
      if (term.planner === planner) term.planner = null;
    });
    term.planner = planner;
    planner.loadFile(path.join(__dirname, '..', 'planner', 'planner.html'));
    return true;
  }
}

module.exports = { WindowManager };
