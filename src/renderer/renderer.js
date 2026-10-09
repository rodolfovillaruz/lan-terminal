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
  window.terminal.onMoveMode((enabled) => {
    overlay.hidden = !enabled;
    if (!enabled) term.focus();
  });
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
