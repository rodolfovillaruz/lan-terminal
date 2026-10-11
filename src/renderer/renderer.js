const FONT_FAMILY = 'JetBrainsMono NL NFM';

async function main() {
  const cfg = await window.terminal.getConfig();
  await Promise.all([
    document.fonts.load(`${cfg.fontSize}px "${FONT_FAMILY}"`),
    document.fonts.load(`bold ${cfg.fontSize}px "${FONT_FAMILY}"`),
  ]);

  const root = document.getElementById('terminal');
  const overlay = document.getElementById('move-overlay');
  const panes = new Map(); // paneId -> { el, term, fit, serialize, syncSize }
  let active = null;

  const createPane = (id) => {
    const el = document.createElement('div');
    el.className = 'pane';
    const term = new Terminal({
      fontFamily: `"${FONT_FAMILY}", monospace`,
      fontSize: cfg.fontSize,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 10000,
      theme: { background: cfg.background, foreground: cfg.foreground },
    });
    const fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    // Lets the pane's screen and scrollback move with it to another window. Without the
    // addon (e.g. an install that missed `npm install`) panes still work, and a moved
    // pane starts blank.
    let serialize = null;
    if (typeof SerializeAddon !== 'undefined') {
      serialize = new SerializeAddon.SerializeAddon();
      term.loadAddon(serialize);
    }
    // xterm measures its container on open, so the element must be in the page first.
    root.appendChild(el);
    term.open(el);
    try {
      const webgl = new WebglAddon.WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch (err) {
      console.warn('WebGL renderer unavailable, using DOM renderer', err);
    }

    const syncSize = () => {
      if (!el.isConnected || el.clientWidth === 0) return;
      fit.fit();
      window.terminal.resize(id, term.cols, term.rows);
    };
    new ResizeObserver(syncSize).observe(el);

    term.onData((data) => window.terminal.write(id, data));
    // The main process splits "<paneId>\t<title>" back apart; the OS title stays fixed.
    term.onTitleChange((title) => { document.title = `${id}\t${title}`; });
    el.addEventListener('focusin', () => {
      if (active === id) return;
      active = id;
      window.terminal.focusPane(id);
    });

    const p = { el, term, fit, serialize, syncSize };
    panes.set(id, p);
    window.terminal.paneReady(id);
    return p;
  };

  // Rebuilds the split containers and moves the existing pane elements into them, so
  // reordering keeps each pane's xterm and scrollback.
  const build = (node, seen) => {
    if (node.type === 'pane') {
      seen.add(node.id);
      return (panes.get(node.id) || createPane(node.id)).el;
    }
    const box = document.createElement('div');
    box.className = `split ${node.dir}`;
    node.children.forEach((child, i) => {
      const el = build(child, seen);
      el.style.flex = `${node.sizes[i]} 1 0`;
      box.appendChild(el);
    });
    return box;
  };

  window.terminal.onData((id, data) => panes.get(id)?.term.write(data));
  window.terminal.onSerialize((requestId, id) => {
    const p = panes.get(id);
    let data = '';
    try {
      data = p?.serialize ? p.serialize.serialize({ scrollback: 10000 }) : '';
    } catch (err) {
      console.warn('Could not serialize pane', err);
    }
    window.terminal.serialized(requestId, data);
  });
  window.terminal.onLayout((state) => {
    const seen = new Set();
    const tree = build(state.layout, seen);
    tree.style.flex = '1 1 0';
    root.replaceChildren(tree);
    for (const [id, p] of panes) {
      if (seen.has(id)) continue;
      p.term.dispose();
      panes.delete(id);
    }
    for (const p of panes.values()) p.syncSize();
    const target = panes.get(state.active);
    if (target && (state.active !== active || !target.el.contains(document.activeElement))) {
      active = state.active;
      if (overlay.hidden) target.term.focus();
    }
  });

  // Presenter mode hides the overlay's tint, outline and label; only the cursor shows move mode.
  overlay.classList.toggle('presenter', cfg.presenterMode);
  window.terminal.onPresenterMode((enabled) => overlay.classList.toggle('presenter', enabled));
  window.terminal.onMoveMode((enabled) => {
    overlay.hidden = !enabled;
    if (!enabled) panes.get(active)?.term.focus();
  });
  // The main process reads the cursor and moves the window; this only reports the drag.
  let dragging = false;
  overlay.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    dragging = true;
    overlay.setPointerCapture(e.pointerId);
    window.terminal.moveStart();
  });
  overlay.addEventListener('pointermove', () => {
    if (dragging) window.terminal.moveDrag();
  });
  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    window.terminal.moveEnd();
  };
  overlay.addEventListener('pointerup', endDrag);
  overlay.addEventListener('pointercancel', endDrag);
  overlay.addEventListener('lostpointercapture', endDrag);
  window.addEventListener('keydown', (e) => {
    if (!overlay.hidden && e.key === 'Escape') {
      window.terminal.exitMoveMode();
    }
    if (!overlay.hidden) {
      // Keyboard input does not reach the shell while moving.
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);

  window.terminal.ready();
}

main();
