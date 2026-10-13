const FONT_FAMILY = 'JetBrainsMono NL NFM';

// Android key codes (android/keycodes.h) for keys that do not type text.
const KEYCODES = {
  Enter: 66, NumpadEnter: 66, Backspace: 67, Delete: 112, Tab: 61, Escape: 111, Space: 62,
  ArrowUp: 19, ArrowDown: 20, ArrowLeft: 21, ArrowRight: 22,
  Home: 122, End: 123, PageUp: 92, PageDown: 93, Insert: 124,
};

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
  // update for web, page and planner panes. el is what sits in the split tree.
  const panes = new Map();
  let active = null;

  const onFocus = (id) => () => {
    if (active === id) return;
    active = id;
    window.terminal.focusPane(id);
  };

  // Moving an iframe or webview in the page reloads it, and the split tree is rebuilt
  // on every layout change, so web content lives in its own layer and is laid over an
  // empty slot in the tree instead. Returns the slot and the box laid over it.
  const layerSlot = () => {
    const el = document.createElement('div');
    el.className = 'pane web';
    const box = document.createElement('div');
    box.className = 'app';
    webLayer.appendChild(box);
    // Inside the slot's border, which draws the line between panes.
    const place = () => {
      const r = el.getBoundingClientRect();
      // Hidden too behind a maximized pane, which only the tree's classes tell.
      box.hidden = !el.isConnected || el.clientWidth === 0 || (root.classList.contains('maximized') && !el.classList.contains('max'));
      Object.assign(box.style, {
        left: `${r.left + el.clientLeft}px`,
        top: `${r.top + el.clientTop}px`,
        width: `${el.clientWidth}px`,
        height: `${el.clientHeight}px`,
      });
    };
    new ResizeObserver(place).observe(el);
    return { el, box, place };
  };

  // A linuxserver app's UI (webtop, chromium, ...).
  const createWebPane = (id, info) => {
    const { el, box, place } = layerSlot();
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
    update(info);

    const p = {
      el,
      update,
      syncSize: place,
      focus: () => frame?.focus(),
      dispose: () => box.remove(),
    };
    panes.set(id, p);
    return p;
  };

  // A web page, in a webview: unlike an iframe, it shows pages that refuse to be
  // framed. It loads its URL once and then follows its links, and tells the main
  // process where it is, so the saved layout reopens there. A page that does not load
  // (a dev server restarting, say) is tried again every few seconds.
  const createPagePane = (id, info) => {
    const { el, box, place } = layerSlot();
    box.classList.add('page');
    const view = document.createElement('webview');
    view.partition = 'persist:pages';
    view.src = info.url;
    const status = document.createElement('p');
    status.hidden = true;
    box.append(view, status);

    let failed = null; // the URL that did not load, while it is tried again
    let retry = null;
    view.addEventListener('did-start-loading', () => { failed = null; });
    view.addEventListener('did-fail-load', (e) => {
      // -3 is a load that was cut short by another, which is not an error.
      if (!e.isMainFrame || e.errorCode === -3) return;
      failed = e.validatedURL;
      status.textContent = `${failed}: ${e.errorDescription || `error ${e.errorCode}`}. Trying again…`;
    });
    view.addEventListener('did-stop-loading', () => {
      status.hidden = !failed;
      clearTimeout(retry);
      // A failed load leaves the webview on the URL that failed, so reload tries it again.
      if (failed) retry = setTimeout(() => view.reload(), 3000);
    });
    const report = () => window.terminal.pageState(id, view.getURL(), view.getTitle());
    view.addEventListener('did-navigate', report);
    view.addEventListener('did-navigate-in-page', (e) => e.isMainFrame && report());
    view.addEventListener('page-title-updated', report);
    view.addEventListener('focus', onFocus(id));

    const p = {
      el,
      update: () => {},
      reload: () => {
        clearTimeout(retry);
        view.reload();
      },
      syncSize: place,
      focus: () => view.focus(),
      dispose: () => {
        clearTimeout(retry);
        box.remove();
      },
    };
    panes.set(id, p);
    return p;
  };

  // The layout planner, in a webview that the main process gives the planner's preload.
  const createPlannerPane = (id, info) => {
    const { el, box, place } = layerSlot();
    const view = document.createElement('webview');
    view.partition = 'planner';
    view.src = info.url;
    view.addEventListener('focus', onFocus(id));
    box.append(view);
    const p = {
      el,
      update: () => {},
      syncSize: place,
      focus: () => view.focus(),
      dispose: () => box.remove(),
    };
    panes.set(id, p);
    return p;
  };

  // An Android device's screen, from scrcpy's H.264 stream (see src/main/scrcpy.js).
  // A canvas survives moves in the split tree, so unlike an iframe it lives in its slot.
  // A left drag is a finger on the touchscreen, the wheel scrolls, the right button
  // is Back and the middle button Home; typing goes to the device.
  const createScrcpyPane = (id, info) => {
    const el = document.createElement('div');
    el.className = 'pane device';
    const canvas = document.createElement('canvas');
    canvas.tabIndex = 0;
    const status = document.createElement('p');
    el.append(canvas, status);
    const ctx = canvas.getContext('2d');
    let video = null; // { width, height } the device sends, which input positions refer to
    let decoder = null;
    let config = null; // SPS and PPS, sent again in front of every key frame
    let keyFrame = false; // the decoder has had one since it was set up
    let timestamp = 0;

    const closeDecoder = () => {
      if (decoder && decoder.state !== 'closed') decoder.close();
      decoder = null;
      keyFrame = false;
    };
    // Starts over from the next key frame, which the main process asks the device for.
    const restart = () => {
      closeDecoder();
      window.terminal.scrcpyReady(id);
    };
    // "avc1.PPCCLL" from the SPS NAL unit: profile, constraint flags and level.
    const codecOf = (data) => {
      for (let i = 0; i + 6 < data.length; i++) {
        if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1 && (data[i + 3] & 0x1f) === 7) {
          return `avc1.${[...data.subarray(i + 4, i + 7)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
        }
      }
      return null;
    };
    const draw = (frame) => {
      if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
        canvas.width = frame.displayWidth;
        canvas.height = frame.displayHeight;
      }
      ctx.drawImage(frame, 0, 0);
      frame.close();
    };
    const onPacket = ({ config: isConfig, key, data }) => {
      if (isConfig) {
        const codec = codecOf(data);
        if (!codec) return;
        closeDecoder();
        config = data;
        decoder = new VideoDecoder({
          output: draw,
          error: (err) => {
            console.warn('scrcpy decoder:', err.message);
            restart();
          },
        });
        decoder.configure({ codec, optimizeForLatency: true });
        return;
      }
      if (decoder?.state !== 'configured' || (!keyFrame && !key)) return;
      // Frames pile up when decoding falls behind; skip to a fresh key frame.
      if (decoder.decodeQueueSize > 30) return restart();
      keyFrame = true;
      let chunk = data;
      if (key) {
        chunk = new Uint8Array(config.length + data.length);
        chunk.set(config);
        chunk.set(data, config.length);
      }
      decoder.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: timestamp++, data: chunk }));
    };

    // The device's sound: Opus packets, decoded and queued a little ahead of the
    // audio clock so packets that arrive unevenly over adb still play without gaps.
    // When the queue runs dry (the device went quiet) or runs too far ahead, it
    // starts over AHEAD seconds from now.
    const AHEAD = 0.06;
    const MAX_AHEAD = 0.3;
    let audioCtx = null;
    let audioDecoder = null;
    let playAt = 0;
    let audioTime = 0;
    const closeAudio = () => {
      if (audioDecoder && audioDecoder.state !== 'closed') audioDecoder.close();
      audioCtx?.close();
      audioDecoder = null;
      audioCtx = null;
    };
    const play = (frame) => {
      if (!audioCtx) return frame.close();
      const buffer = audioCtx.createBuffer(frame.numberOfChannels, frame.numberOfFrames, frame.sampleRate);
      for (let c = 0; c < frame.numberOfChannels; c++) {
        frame.copyTo(buffer.getChannelData(c), { planeIndex: c, format: 'f32-planar' });
      }
      frame.close();
      const now = audioCtx.currentTime;
      if (playAt < now + 0.01 || playAt > now + MAX_AHEAD) playAt = now + AHEAD;
      const source = audioCtx.createBufferSource();
      source.buffer = buffer;
      source.connect(audioCtx.destination);
      source.start(playAt);
      playAt += buffer.duration;
    };
    const onAudio = ({ config: isConfig, data }) => {
      if (isConfig) {
        // The OpusHead: the channel count is its byte 9.
        closeAudio();
        audioCtx = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });
        audioDecoder = new AudioDecoder({
          output: play,
          error: (err) => {
            console.warn('scrcpy audio:', err.message);
            closeAudio();
          },
        });
        audioDecoder.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: data[9] || 2, description: data });
        return;
      }
      if (audioDecoder?.state !== 'configured') return;
      audioDecoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: audioTime, data }));
      audioTime += 20000; // the timestamps only need to grow
    };

    // Where a pointer event lands on the device, in video pixels; the picture is
    // letterboxed inside the canvas box (object-fit: contain).
    const devicePoint = (e) => {
      if (!video) return null;
      const r = canvas.getBoundingClientRect();
      const scale = Math.min(r.width / video.width, r.height / video.height);
      const x = (e.clientX - r.left - (r.width - video.width * scale) / 2) / scale;
      const y = (e.clientY - r.top - (r.height - video.height * scale) / 2) / scale;
      const inside = x >= 0 && y >= 0 && x < video.width && y < video.height;
      return { x: Math.min(Math.max(x, 0), video.width - 1), y: Math.min(Math.max(y, 0), video.height - 1), inside };
    };
    const input = (msg) => window.terminal.scrcpyInput(id, msg);
    const pressKey = (keycode, metastate = 0) => {
      input({ type: 'keycode', action: 0, keycode, metastate });
      input({ type: 'keycode', action: 1, keycode, metastate });
    };

    // Ctrl+Shift+Alt+X captures the mouse and keyboard: they become a USB mouse and
    // keyboard on the device, the pointer is locked to the pane (its cursor shows on
    // the device instead), and every key, shortcuts included, goes to the device.
    // Ctrl+Shift+Alt+X again releases them, and so do losing the pointer lock, leaving the
    // pane and the stream stopping. Where the
    // device cannot put a USB mouse on the pane's display (a new display before
    // Android 15), only the keyboard is captured and the mouse stays a finger.
    let captured = false;
    let captureMouse = false; // from the main process, which knows the device
    let mouseCaptured = false;
    const setCaptured = (on) => {
      if (on === captured) return;
      captured = on;
      mouseCaptured = on && captureMouse;
      window.terminal.scrcpyCapture(id, on);
      if (mouseCaptured) {
        Promise.resolve(canvas.requestPointerLock({ unadjustedMovement: true }))
          .catch(() => canvas.requestPointerLock()) // without raw input, mouse acceleration applies
          .catch((err) => console.warn('pointer lock:', err.message));
      } else if (!on && document.pointerLockElement === canvas) {
        document.exitPointerLock();
      }
    };
    // Losing the lock releases; a lock that was never granted does not.
    let pointerLocked = false;
    document.addEventListener('pointerlockchange', () => {
      if (captured && pointerLocked && document.pointerLockElement !== canvas) setCaptured(false);
      pointerLocked = document.pointerLockElement === canvas;
    });
    canvas.addEventListener('blur', () => setCaptured(false));
    const hidMouse = (e, extra = {}) => {
      e.preventDefault();
      window.terminal.scrcpyHidMouse(id, { buttons: e.buttons, dx: e.movementX || 0, dy: e.movementY || 0, ...extra });
    };

    let touching = false;
    canvas.addEventListener('pointerdown', (e) => {
      canvas.focus();
      if (mouseCaptured) return hidMouse(e);
      const pt = devicePoint(e);
      if (!pt?.inside) return;
      e.preventDefault();
      if (e.button === 0) {
        touching = true;
        canvas.setPointerCapture(e.pointerId);
        input({ type: 'touch', action: 0, x: pt.x, y: pt.y, pressure: 1 });
      } else if (e.button === 2) {
        input({ type: 'backOrScreenOn', action: 0 });
        input({ type: 'backOrScreenOn', action: 1 });
      } else if (e.button === 1) {
        pressKey(3); // HOME
      } else if (e.button === 3) {
        pressKey(4); // BACK
      } else if (e.button === 4) {
        pressKey(187); // APP_SWITCH
      }
    });
    canvas.addEventListener('pointermove', (e) => {
      if (mouseCaptured) return hidMouse(e);
      const pt = touching && devicePoint(e);
      if (pt) input({ type: 'touch', action: 2, x: pt.x, y: pt.y, pressure: 1 });
    });
    const lift = (e) => {
      if (mouseCaptured) return hidMouse(e);
      if (!touching) return;
      touching = false;
      const pt = devicePoint(e);
      if (pt) input({ type: 'touch', action: 1, x: pt.x, y: pt.y, pressure: 0 });
    };
    canvas.addEventListener('pointerup', lift);
    canvas.addEventListener('pointercancel', lift);
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('wheel', (e) => {
      const notches = e.deltaMode === 0 ? 100 : e.deltaMode === 1 ? 3 : 1;
      if (mouseCaptured) return hidMouse(e, { dx: 0, dy: 0, wheel: -e.deltaY / notches, hwheel: e.deltaX / notches });
      const pt = devicePoint(e);
      if (!pt?.inside) return;
      e.preventDefault();
      const clamp = (v) => Math.min(16, Math.max(-16, v));
      input({ type: 'scroll', x: pt.x, y: pt.y, h: clamp(e.deltaX / notches), v: clamp(-e.deltaY / notches) });
    }, { passive: false });

    // Text goes in as text, so any layout and any character works; keys that are not
    // text, and shortcuts with Ctrl or Alt, go in as Android key codes.
    const keycodeOf = (e) => {
      if (e.code in KEYCODES) return KEYCODES[e.code];
      if (!(e.ctrlKey || e.altKey || e.metaKey)) return null;
      if (/^Key[A-Z]$/.test(e.code)) return 29 + e.code.charCodeAt(3) - 65; // A..Z
      if (/^Digit[0-9]$/.test(e.code)) return 7 + Number(e.code[5]); // 0..9
      return null;
    };
    const metaOf = (e) => (e.shiftKey ? 0x1 : 0) | (e.altKey ? 0x2 : 0) | (e.ctrlKey ? 0x1000 : 0) | (e.metaKey ? 0x10000 : 0);
    for (const type of ['keydown', 'keyup']) {
      canvas.addEventListener(type, (e) => {
        if (e.ctrlKey && e.shiftKey && e.altKey && e.code === 'KeyX') {
          e.preventDefault();
          if (type === 'keydown' && !e.repeat) setCaptured(!captured);
          return;
        }
        if (captured) {
          // The device repeats a held key itself, as with a real keyboard.
          e.preventDefault();
          if (!e.repeat) window.terminal.scrcpyHidKey(id, e.code, type === 'keydown');
          return;
        }
        if (e.isComposing) return;
        const keycode = keycodeOf(e);
        if (keycode !== null) {
          e.preventDefault();
          input({ type: 'keycode', action: type === 'keydown' ? 0 : 1, keycode, metastate: metaOf(e) });
        } else if (type === 'keydown' && [...e.key].length === 1) {
          e.preventDefault();
          input({ type: 'text', text: e.key });
        }
      });
    }
    canvas.addEventListener('focus', onFocus(id));

    // A flex display follows the pane's size, in device pixels.
    let fit = false;
    const syncSize = () => {
      if (!fit || !el.isConnected || el.clientWidth === 0) return;
      const ratio = window.devicePixelRatio || 1;
      window.terminal.scrcpyResize(id, Math.round(el.clientWidth * ratio), Math.round(el.clientHeight * ratio));
    };
    new ResizeObserver(syncSize).observe(el);

    const update = (next) => {
      captureMouse = Boolean(next.captureMouse);
      if (next.fit && !fit) {
        fit = true;
        syncSize();
      }
      status.textContent = next.status ?? '';
      status.hidden = !next.status;
      canvas.hidden = Boolean(next.status);
      if (next.status) {
        setCaptured(false);
        closeAudio();
        video = null;
        closeDecoder();
      }
    };
    update(info);

    const p = {
      el,
      update,
      session: (v) => { video = v; },
      packet: onPacket,
      audio: onAudio,
      syncSize,
      focus: () => canvas.focus(),
      dispose: () => {
        setCaptured(false);
        closeDecoder();
        closeAudio();
      },
    };
    panes.set(id, p);
    window.terminal.scrcpyReady(id);
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

    // Ctrl+Shift+C copies the selection; with nothing selected it does nothing, so it
    // never reaches the shell as Ctrl+C. Ctrl+Shift+V pastes the clipboard.
    term.attachCustomKeyEventHandler((e) => {
      if (!(e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey)) return true;
      if (e.code !== 'KeyC' && e.code !== 'KeyV') return true;
      if (e.type === 'keydown' && e.code === 'KeyC' && term.hasSelection()) window.terminal.copy(term.getSelection());
      if (e.type === 'keydown' && e.code === 'KeyV') window.terminal.paste().then((text) => text && term.paste(text));
      e.preventDefault();
      return false;
    });
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
  const paneEl = (id, info) => {
    const other = info[id]; // a web, page or device pane, which has no pty
    const p = panes.get(id);
    if (p && other) p.update(other);
    if (p) return p.el;
    if (other?.kind === 'scrcpy') return createScrcpyPane(id, other).el;
    if (other?.kind === 'page') return createPagePane(id, other).el;
    if (other?.kind === 'planner') return createPlannerPane(id, other).el;
    return (other ? createWebPane(id, other) : createPane(id)).el;
  };
  // The maximized pane goes in maxed.el, to be laid over the whole window, and an
  // empty pane keeps its place, so the others keep their size.
  const build = (node, seen, info, maxed) => {
    if (node.type === 'pane') {
      seen.add(node.id);
      const el = paneEl(node.id, info);
      if (node.id !== maxed.id) return el;
      maxed.el = el;
      const spacer = document.createElement('div');
      spacer.className = 'pane';
      return spacer;
    }
    const box = document.createElement('div');
    box.className = `split ${node.dir}`;
    node.children.forEach((child, i) => {
      const el = build(child, seen, info, maxed);
      el.style.flex = `${node.sizes[i]} 1 0`;
      box.appendChild(el);
    });
    return box;
  };

  window.terminal.onData((id, data) => panes.get(id)?.term?.write(data));
  window.terminal.onScrcpySession((id, video) => panes.get(id)?.session?.(video));
  window.terminal.onScrcpyPacket((id, packet) => panes.get(id)?.packet?.(packet));
  window.terminal.onScrcpyAudio((id, packet) => panes.get(id)?.audio?.(packet));
  window.terminal.onPageReload((id) => panes.get(id)?.reload?.());
  window.terminal.onLayout((state) => {
    const seen = new Set();
    const maxed = { id: state.maximized, el: null };
    // A locked window with no panes shows just its background.
    if (state.layout) {
      const tree = build(state.layout, seen, state.panes || {}, maxed);
      tree.style.flex = '1 1 0';
      root.replaceChildren(tree);
      if (maxed.el) root.append(maxed.el);
    } else {
      root.replaceChildren();
    }
    for (const [id, p] of panes) {
      if (seen.has(id)) continue;
      p.dispose();
      panes.delete(id);
    }
    // A maximized pane covers the window; the others keep their size underneath, so
    // their shells and displays are not resized there and back.
    root.classList.toggle('maximized', Boolean(maxed.el));
    for (const p of panes.values()) p.el.classList.toggle('max', p.el === maxed.el);
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
