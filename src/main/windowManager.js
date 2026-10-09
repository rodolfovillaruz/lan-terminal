const { BrowserWindow, ipcMain, screen } = require('electron');
const { EventEmitter } = require('events');
const path = require('path');
const os = require('os');
const pty = require('node-pty');

class WindowManager extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.terminals = new Map(); // id -> { id, win, pty, title, moveMode }
    this.nextId = 1;

    // Renderer -> PTY. The sender identifies which terminal the message belongs to.
    ipcMain.on('pty:input', (event, data) => this.#fromSender(event)?.pty.write(data));
    ipcMain.on('pty:resize', (event, cols, rows) => {
      const term = this.#fromSender(event);
      if (term && cols > 0 && rows > 0) term.pty.resize(cols, rows);
    });
    ipcMain.on('pty:ready', (event) => {
      const term = this.#fromSender(event);
      if (!term) return;
      term.ready = true;
      if (term.pending) event.sender.send('pty:data', term.pending);
      term.pending = '';
      if (term.moveMode) event.sender.send('moveMode', true);
    });
    ipcMain.on('moveMode:exit', (event) => {
      const term = this.#fromSender(event);
      if (term) this.setMoveMode(term.id, false);
    });
    ipcMain.handle('terminal:config', () => ({
      fontSize: config.fontSize,
      background: config.background,
      foreground: config.foreground,
    }));
  }

  #fromSender(event) {
    for (const term of this.terminals.values()) {
      if (!term.win.isDestroyed() && term.win.webContents === event.sender) return term;
    }
    return null;
  }

  #changed() {
    this.emit('changed', this.list());
  }

  create() {
    const id = this.nextId++;
    const { width: dw, height: dh } = screen.getPrimaryDisplay().bounds;
    const width = this.config.width || dw;
    const height = this.config.height || dh;

    const win = new BrowserWindow({
      x: 0,
      y: 0,
      width,
      height,
      frame: false,
      resizable: false,
      maximizable: false,
      minimizable: true,
      fullscreenable: false,
      closable: true, // closable programmatically; there is no close button to click
      backgroundColor: this.config.background,
      title: `Terminal ${id}`,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    win.setMenu(null);

    const shell = this.config.shell || process.env.SHELL || os.userInfo().shell || '/bin/bash';
    const proc = pty.spawn(shell, this.config.shellArgs || [], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: os.homedir(),
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
    });

    const term = { id, win, pty: proc, title: path.basename(shell), moveMode: false, ready: false, pending: '' };
    this.terminals.set(id, term);

    proc.onData((data) => {
      // Hold output until the renderer is listening so the first prompt is not lost.
      if (!term.ready) term.pending += data;
      else if (!win.isDestroyed()) win.webContents.send('pty:data', data);
    });
    proc.onExit(() => {
      term.exited = true;
      if (!win.isDestroyed()) win.close();
    });

    // A reload (e.g. renderer crash recovery) needs a fresh handshake.
    win.webContents.on('did-start-loading', () => { term.ready = false; });
    win.webContents.on('page-title-updated', (event, title) => {
      // xterm.js forwards the shell's OSC title; keep the window title stable for OBS.
      event.preventDefault();
      term.title = title;
      this.#changed();
    });
    win.on('focus', () => this.#changed());
    win.on('moved', () => this.#changed());
    win.on('closed', () => {
      if (!term.exited) proc.kill();
      this.terminals.delete(id);
      this.#changed();
    });
    win.once('ready-to-show', () => win.show());

    win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    this.#changed();
    return id;
  }

  get(id) {
    return this.terminals.get(Number(id)) || null;
  }

  list() {
    return [...this.terminals.values()]
      .filter((t) => !t.win.isDestroyed())
      .map((t) => {
        const b = t.win.getBounds();
        return {
          id: t.id,
          title: t.title,
          x: b.x,
          y: b.y,
          width: b.width,
          height: b.height,
          moveMode: t.moveMode,
          focused: t.win.isFocused(),
          minimized: t.win.isMinimized(),
          pid: t.pty.pid,
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
    const term = this.get(id);
    if (!term) return false;
    term.win.setPosition(0, 0);
    this.#changed();
    return true;
  }

  setMoveMode(id, enabled) {
    const term = this.get(id);
    if (!term) return false;
    term.moveMode = Boolean(enabled);
    term.win.webContents.send('moveMode', term.moveMode);
    if (term.moveMode) this.focus(id);
    this.#changed();
    return true;
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
}

module.exports = { WindowManager };
