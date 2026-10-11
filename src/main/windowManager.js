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
    // id (UUID) -> { id, win, panes, layout, activePane, moveMode, alwaysOnTop, ready, bounds }
    // panes: paneId -> { id, pty, title, process, ready, pending, exited }
    this.terminals = new Map();
    this.saveTimer = null;
    this.planner = null; // the layout planner window, while open
    // Split tree whose leaves are window ids. The planner edits it and tiles the
    // capture windows from it; without the planner open, windows stay where they are.
    this.tiling = null;

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

    // Planner window -> window tiling and the panes inside each window.
    ipcMain.handle('planner:state', () => this.#plannerState());
    const plannerAction = (channel, fn) =>
      ipcMain.on(channel, (event, ...args) => {
        if (!this.planner || this.planner.isDestroyed() || event.sender !== this.planner.webContents) return;
        try {
          fn(...args);
        } catch (err) {
          console.warn(`${channel}:`, err.message);
        }
      });
    plannerAction('planner:split', (id, paneId, dir) => this.splitPane(id, paneId, dir));
    plannerAction('planner:close', (id, paneId) => this.closePane(id, paneId));
    plannerAction('planner:swap', (id, a, b) => this.swapPanes(id, a, b));
    plannerAction('planner:resize', (id, splitPath, sizes) => this.resizeSplit(id, splitPath, sizes));
    plannerAction('planner:select', (id, paneId) => this.selectPane(id, paneId));
    plannerAction('planner:tile-split', (id, dir) => this.tileSplit(id, dir));
    plannerAction('planner:tile-close', (id) => this.tileClose(id));
    plannerAction('planner:tile-swap', (a, b) => this.tileSwap(a, b));
    plannerAction('planner:tile-resize', (splitPath, sizes) => this.tileResize(splitPath, sizes));
    plannerAction('planner:untile', () => this.untile());
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
      tiling: this.tiling,
      windows: [...this.terminals.values()]
        .filter((t) => !t.win.isDestroyed())
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

  // Saves the tiling with each window's pane shape for the next start. The shape is
  // taken now, not when the timer fires, so windows closing on quit are not lost.
  #saveSoon() {
    if (!this.tiling) return;
    const saved = layout.shape(this.tiling, (id) => {
      const term = this.terminals.get(id);
      return { panes: term ? layout.shape(term.layout) : 'pane' };
    });
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.config.tiling = saved;
      saveConfig(this.config);
    }, 500);
  }

  // Brings the tiling in line with the open windows: closed ones leave, new ones are
  // split off the last tile (or laid out in one even row when there is no tiling yet).
  #reconcileTiling() {
    const open = [...this.terminals.keys()];
    let tree = this.tiling;
    if (tree) {
      for (const id of layout.leaves(tree)) if (!this.terminals.has(id)) tree = layout.removePane(tree, id);
    }
    if (!tree && open.length > 1) {
      tree = { type: 'split', dir: 'row', sizes: open.map(() => 1 / open.length), children: open.map(layout.pane) };
    }
    for (const id of open) {
      if (tree && layout.leaves(tree).includes(id)) continue;
      tree = tree ? layout.splitPane(tree, layout.leaves(tree).at(-1), 'row', id) : layout.pane(id);
    }
    this.tiling = tree;
  }

  #applyTiling() {
    if (!this.tiling) return;
    for (const [id, rect] of layout.rects(this.tiling, this.#fullBounds())) {
      const term = this.terminals.get(id);
      if (term && !term.win.isDestroyed()) this.#setBounds(term, rect);
    }
    this.#changed();
  }

  // Terminal windows are not user-resizable, which X11 enforces with fixed size hints,
  // so lift that just for the resize.
  #setBounds(term, rect) {
    term.bounds = rect;
    term.win.setResizable(true);
    term.win.setBounds(rect);
    term.win.setResizable(false);
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

  // bounds places the window as a tile; without it the window fills the screen.
  // A window opened while the planner is open joins the tiling unless skipTiling.
  create({ layout: saved, bounds, skipTiling = false } = {}) {
    const id = crypto.randomUUID();
    const initial = bounds || this.#fullBounds();

    const win = new BrowserWindow({
      ...initial,
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

    const term = { id, win, panes: new Map(), layout: null, activePane: null, moveMode: false, alwaysOnTop: false, ready: false, bounds: bounds || null };
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
      // Its neighbor takes over the tile; the planner shows that at once.
      if (this.tiling && layout.leaves(this.tiling).includes(id)) {
        this.tiling = layout.removePane(this.tiling, id);
        if (this.#plannerOpen()) this.#applyTiling();
        if (term.closedByPlanner) this.#saveSoon();
      }
      this.#changed();
    });
    win.once('ready-to-show', () => win.show());
    // KWin shrinks a new window to the work area (above the panel) when it is mapped.
    // A resize after mapping is not clamped, so restore the size once it is shown.
    win.once('show', () => this.#setBounds(term, term.bounds || this.#fullBounds()));

    win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    if (this.#plannerOpen() && !skipTiling) {
      this.#reconcileTiling();
      this.#applyTiling();
    }
    this.#changed();
    return id;
  }

  // Startup: one window per saved tile, placed in its tile with its saved panes.
  restore(saved) {
    if (!saved) return this.create();
    const isLeaf = (s) => typeof s === 'object' && s !== null && 'panes' in s;
    const shapes = new Map();
    let n = 0;
    const tree = layout.hydrate(saved, (leaf) => {
      const key = `tile${n++}`;
      shapes.set(key, leaf?.panes);
      return key;
    }, isLeaf);
    if (tree.type === 'pane') return this.create({ layout: shapes.get(tree.id) });
    const rects = layout.rects(tree, this.#fullBounds());
    const ids = new Map();
    for (const [key, rect] of rects) ids.set(key, this.create({ layout: shapes.get(key), bounds: rect }));
    const relabel = (node) =>
      node.type === 'pane' ? layout.pane(ids.get(node.id)) : { ...node, children: node.children.map(relabel) };
    this.tiling = relabel(tree);
    return [...ids.values()][0];
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
    this.focus(id);
    this.#sendLayout(term);
    this.#changed();
    return true;
  }

  // Window tiling, driven by the planner. Each edit retiles the screen at once.
  tileSplit(id, dir) {
    if (!this.tiling || !layout.leaves(this.tiling).includes(id)) return false;
    if (dir !== 'row' && dir !== 'col') throw new Error('dir must be row or col');
    const newId = this.create({ skipTiling: true });
    this.tiling = layout.splitPane(this.tiling, id, dir, newId);
    this.#applyTiling();
    this.#saveSoon();
    return true;
  }

  // The window's 'closed' handler hands its tile to the neighbor.
  tileClose(id) {
    const term = this.get(id);
    if (!term || this.terminals.size === 1) return false;
    term.closedByPlanner = true;
    term.win.close();
    return true;
  }

  tileSwap(a, b) {
    if (!this.tiling) return false;
    this.tiling = layout.swapPanes(this.tiling, a, b);
    this.#applyTiling();
    this.#saveSoon();
    return true;
  }

  tileResize(splitPath, sizes) {
    if (!this.tiling) return false;
    this.tiling = layout.setSizes(this.tiling, splitPath, sizes);
    this.#applyTiling();
    this.#saveSoon();
    return true;
  }

  // Back to stacked full-screen windows. The tiling is kept for the next edit.
  untile() {
    for (const term of this.terminals.values()) {
      if (!term.win.isDestroyed()) this.#setBounds(term, this.#fullBounds());
    }
    for (const term of this.terminals.values()) term.bounds = null;
    this.#changed();
    return true;
  }

  // A single planner tiles every capture window. It is a normal framed window and not
  // a terminal, so it stays out of this.terminals and the focus list. It stays on top
  // because the capture windows fill the screen.
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
    this.#reconcileTiling();
    this.#applyTiling();
    return true;
  }
}

module.exports = { WindowManager };
