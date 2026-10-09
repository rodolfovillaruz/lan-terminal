const FONT_FAMILY = 'JetBrainsMono NL NFM';

async function main() {
  const cfg = await window.terminal.getConfig();
  await Promise.all([
    document.fonts.load(`${cfg.fontSize}px "${FONT_FAMILY}"`),
    document.fonts.load(`bold ${cfg.fontSize}px "${FONT_FAMILY}"`),
  ]);

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
  term.open(document.getElementById('terminal'));
  try {
    const webgl = new WebglAddon.WebglAddon();
    webgl.onContextLoss(() => webgl.dispose());
    term.loadAddon(webgl);
  } catch (err) {
    console.warn('WebGL renderer unavailable, using DOM renderer', err);
  }

  const syncSize = () => {
    fit.fit();
    window.terminal.resize(term.cols, term.rows);
  };
  syncSize();
  new ResizeObserver(syncSize).observe(document.getElementById('terminal'));

  window.terminal.onData((data) => term.write(data));
  term.onData((data) => window.terminal.write(data));
  term.onTitleChange((title) => { document.title = title; });

  const overlay = document.getElementById('move-overlay');
  // Presenter mode hides the overlay's tint, outline and label; only the cursor shows move mode.
  overlay.classList.toggle('presenter', cfg.presenterMode);
  window.terminal.onPresenterMode((enabled) => overlay.classList.toggle('presenter', enabled));
  window.terminal.onMoveMode((enabled) => {
    overlay.hidden = !enabled;
    if (!enabled) term.focus();
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
  term.focus();
}

main();
