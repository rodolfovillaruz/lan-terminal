const FONT_FAMILY = 'JetBrainsMono NL NFM';

async function main() {
  const cfg = await window.terminal.getConfig();
  await Promise.all([
    document.fonts.load(`${cfg.fontSize}px "${FONT_FAMILY}"`),
    document.fonts.load(`bold ${cfg.fontSize}px "${FONT_FAMILY}"`),
  ]);

  const root = document.getElementById('terminal');
  const webLayer = document.getElementById('apps');
  const overlay = document.getElementById('move-overlay');
  // paneId -> { el, syncSize, focus, dispose }, plus term for terminal panes and
  // place/update for web panes. el is what sits in the split tree.
  const panes = new Map();
  let active = null;

  const onFocus = (id) => () => {
    if (active === id) return;
    active = id;
    window.terminal.focusPane(id);
  };

  // A linuxserver app's UI (webtop, chromium, ...). Moving an iframe in the page
  // reloads it, and the split tree is rebuilt on every layout change, so the iframe
  // lives in its own layer and is laid over an empty slot in the tree instead.
  const createWebPane = (id, info) => {
    const el = document.createElement('div');
    el.className = 'pane web';
    const box = document.createElement('div');
    box.className = 'app';
    webLayer.appendChild(box);
    let url = null;
    let frame = null;

    const update = (next) => {
      if (next.url && next.url !== url) {
        url = next.url;
        frame = document.createElement('iframe');
        frame.src = url;
        frame.allow = 'clipboard-read; clipboard-write; fullscreen; autoplay; keyboard-map';
        frame.addEventListener('focus', onFocus(id));
        box.replaceChildren(frame);
      } else if (!next.url) {
        const status = document.createElement('p');
        status.textContent = next.error ? `${next.label}: ${next.error}` : `Starting ${next.label}…`;
        box.replaceChildren(status);
        url = null;
        frame = null;
      }
    };
    // Inside the slot's border, which draws the line between panes.
    const place = () => {
      const r = el.getBoundingClientRect();
      box.hidden = !el.isConnected || el.clientWidth === 0;
      Object.assign(box.style, {
        left: `${r.left + el.clientLeft}px`,
        top: `${r.top + el.clientTop}px`,
        width: `${el.clientWidth}px`,
        height: `${el.clientHeight}px`,
      });
    };
    new ResizeObserver(place).observe(el);
    update(info);

    const p = {
      el,
      update,
      place,
      syncSize: place,
      focus: () => frame?.focus(),
      dispose: () => box.remove(),
    };
    panes.set(id, p);
    return p;
  };

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
    el.addEventListener('focusin', onFocus(id));

    const p = { el, term, syncSize, focus: () => term.focus(), dispose: () => term.dispose() };
    panes.set(id, p);
    window.terminal.paneReady(id);
    return p;
  };

  // Rebuilds the split containers and moves the existing pane elements into them, so
  // reordering keeps each pane's xterm and scrollback.
  const build = (node, seen, info) => {
    if (node.type === 'pane') {
      seen.add(node.id);
      const web = info[node.id];
      const p = panes.get(node.id);
      if (p && web) p.update(web);
      return (p || (web ? createWebPane(node.id, web) : createPane(node.id))).el;
    }
    const box = document.createElement('div');
    box.className = `split ${node.dir}`;
    node.children.forEach((child, i) => {
      const el = build(child, seen, info);
      el.style.flex = `${node.sizes[i]} 1 0`;
      box.appendChild(el);
    });
    return box;
  };

  window.terminal.onData((id, data) => panes.get(id)?.term?.write(data));
  window.terminal.onLayout((state) => {
    const seen = new Set();
    // A locked window with no panes shows just its background.
    if (state.layout) {
      const tree = build(state.layout, seen, state.panes || {});
      tree.style.flex = '1 1 0';
      root.replaceChildren(tree);
    } else {
      root.replaceChildren();
    }
    for (const [id, p] of panes) {
      if (seen.has(id)) continue;
      p.dispose();
      panes.delete(id);
    }
    for (const p of panes.values()) p.syncSize();
    const target = panes.get(state.active);
    if (target && (state.active !== active || !target.el.contains(document.activeElement))) {
      active = state.active;
      if (overlay.hidden) target.focus();
    }
  });

  // Presenter mode hides the overlay's tint, outline and label; only the cursor shows move mode.
  overlay.classList.toggle('presenter', cfg.presenterMode);
  window.terminal.onPresenterMode((enabled) => overlay.classList.toggle('presenter', enabled));
  window.terminal.onMoveMode((enabled) => {
    overlay.hidden = !enabled;
    if (!enabled) panes.get(active)?.focus();
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
