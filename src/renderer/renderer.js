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
  const resizeOverlay = document.getElementById('resize-overlay');
  // paneId -> { el, syncSize, focus, dispose }, plus term for terminal panes and
  // update for web, page, planner and camera panes. el is what sits in the split tree.
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
      // Hidden too behind a maximized pane, unless pinned, which only the tree's classes tell.
      const maxed = root.classList.contains('maximized');
      box.hidden = !el.isConnected || el.clientWidth === 0 || (maxed && !el.classList.contains('max') && !el.classList.contains('pinned'));
      const left = r.left + el.clientLeft;
      const top = r.top + el.clientTop;
      Object.assign(box.style, {
        left: `${left}px`,
        top: `${top}px`,
        width: `${el.clientWidth}px`,
        height: `${el.clientHeight}px`,
        zIndex: el.classList.contains('pinned') ? 2 : el.classList.contains('max') ? 1 : '',
        clipPath: '',
      });
      // A maximized app or page lies over the window's own panes, so it leaves holes
      // where pinned panes are.
      if (maxed && el.classList.contains('max')) {
        const holes = [...root.querySelectorAll('.pane.pinned')].map((p) => {
          const h = p.getBoundingClientRect();
          return `M${h.left - left} ${h.top - top}h${h.width}v${h.height}h${-h.width}z`;
        });
        if (holes.length) box.style.clipPath = `path(evenodd, 'M0 0h${el.clientWidth}v${el.clientHeight}h${-el.clientWidth}z${holes.join('')}')`;
      }
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

  // A V4L2 camera, such as the loopback device DroidCam feeds the phone's camera into,
  // found by its name. A camera that is not there, or that cannot be opened or stops,
  // says so and is tried again every few seconds. A loopback device opens even when
  // nothing feeds it, and then sends no frames, so the pane also says when none have
  // come for a while, and clears that once they do. With fillWidth the video spans the
  // pane's width and its top and bottom are cropped, instead of showing whole.
  const createCameraPane = (id, info) => {
    const { el, box, place } = layerSlot();
    box.classList.add('camera');
    const video = document.createElement('video');
    video.autoplay = true;
    video.muted = true;
    const status = document.createElement('p');
    box.append(video, status);

    let stream = null;
    let retry = null;
    let disposed = false;
    let lastFrame = 0; // when the last frame showed, or 0 for none since opening
    const STALL = 3000;
    const onFrame = () => {
      lastFrame = performance.now();
      if (stream) status.hidden = true;
      video.requestVideoFrameCallback(onFrame);
    };
    video.requestVideoFrameCallback(onFrame);
    const watch = setInterval(() => {
      if (!stream || performance.now() - lastFrame < STALL) return;
      status.textContent = `No video from ${info.label}. Is the phone connected in the ${info.label} app?`;
      status.hidden = false;
    }, 1000);
    const stop = () => {
      stream?.getTracks().forEach((t) => t.stop());
      stream = null;
      video.srcObject = null;
    };
    const wait = (text) => {
      stop();
      status.textContent = `${text} Trying again…`;
      status.hidden = false;
      retry = setTimeout(connect, 3000);
    };
    const connect = async () => {
      retry = null;
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const camera = devices.find((d) => d.kind === 'videoinput' && d.label.toLowerCase().includes(info.name.toLowerCase()));
        if (!camera) return disposed || wait(`${info.label} is not available.`);
        const next = await navigator.mediaDevices.getUserMedia({
          video: { deviceId: { exact: camera.deviceId }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        });
        if (disposed) return next.getTracks().forEach((t) => t.stop());
        stream = next;
        lastFrame = performance.now(); // a grace period before saying no video came
        video.srcObject = stream;
        status.textContent = `Waiting for video from ${info.label}…`;
        stream.getVideoTracks()[0].addEventListener('ended', () => disposed || wait(`${info.label} stopped.`));
      } catch (err) {
        if (!disposed) wait(`${info.label}: ${err.message || err.name}.`);
      }
    };
    status.textContent = `Opening ${info.label}…`;
    connect();

    const update = (next) => box.classList.toggle('fill-width', Boolean(next.fillWidth));
    update(info);

    const p = {
      el,
      update,
      // The pane's height that shows the whole video at the pane's width, once it has come.
      videoHeight: () => (video.videoWidth ? (el.clientWidth * video.videoHeight) / video.videoWidth : null),
      syncSize: place,
      focus: () => {},
      dispose: () => {
        disposed = true;
        clearTimeout(retry);
        clearInterval(watch);
        stop();
        box.remove();
      },
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

  // A new pane's form: open one of the app's pods in a namespace, make a new pod from
  // any linuxserver image, or show the layout planner. The namespace starts on the one the last
  // new pod went to. Picking one turns the pane into it.
  const createLauncherPane = (id) => {
    const el = document.createElement('div');
    el.className = 'pane launcher';
    el.addEventListener('focusin', onFocus(id));
    el.innerHTML = `
      <form>
        <h2>New pane</h2>
        <label class="row">Namespace <select name="namespace"></select></label>
        <div class="row new-namespace" hidden>
          <input name="newNamespace" placeholder="namespace name" autocomplete="off" spellcheck="false">
          <button type="button" data-act="create-namespace">Create</button>
          <button type="button" data-act="cancel-namespace">Cancel</button>
        </div>
        <h3>Open a pod</h3>
        <ul class="pods"></ul>
        <h3>New pod</h3>
        <label class="row">Image <span class="prefix">lscr.io/linuxserver/</span><input name="image" list="launcher-images-${id}" placeholder="webtop" autocomplete="off" spellcheck="false"></label>
        <datalist id="launcher-images-${id}"></datalist>
        <label class="row">Tag <input name="tag" list="launcher-tags-${id}" value="latest" autocomplete="off" spellcheck="false"></label>
        <datalist id="launcher-tags-${id}"></datalist>
        <label class="row">UI port <input name="port" type="number" min="1" max="65535" value="3000"></label>
        <p class="about"></p>
        <div class="row">
          <button type="submit">Create pod</button>
          <button type="button" data-act="planner">Plan layout</button>
          <button type="button" data-act="refresh" title="List the namespaces and pods again">↻</button>
        </div>
        <p class="status"></p>
      </form>`;
    const form = el.querySelector('form');
    const nsSelect = form.elements.namespace;
    const newNs = el.querySelector('.new-namespace');
    const podList = el.querySelector('.pods');
    const imageList = el.querySelector(`#launcher-images-${id}`);
    const tagList = el.querySelector(`#launcher-tags-${id}`);
    const about = el.querySelector('.about');
    const status = el.querySelector('.status');
    const NEW_NS = '\u0000new'; // the "New namespace…" option, which no namespace can be named
    let st = null; // the last launcherState
    let busy = false;
    // The pods being deleted, as 'namespace/name'; several can be at once. Only one
    // dialog asks at a time.
    const deleting = new Set();
    let confirming = false;

    // waiting puts a spinner before the text.
    const say = (text, error = false, waiting = false) => {
      status.textContent = text;
      status.classList.toggle('error', error);
      status.classList.toggle('waiting', waiting);
    };
    const sayDeleting = () => deleting.size > 0 && (say(`Deleting ${[...deleting].join(', ')}…`, false, true), true);
    const drawPods = () => {
      const ns = nsSelect.value;
      const pods = (st?.pods ?? []).filter((p) => p.namespace === ns);
      podList.replaceChildren(...pods.map((p) => {
        const li = document.createElement('li');
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = p.name;
        b.addEventListener('click', () => launch(`pod:${p.namespace}:${p.name}`, `Opening ${p.namespace}/${p.name}…`));
        const what = document.createElement('span');
        what.textContent = `${p.app ? `${p.app}:${p.tag}` : 'unknown image'} · ${p.ready ? 'ready' : p.phase}`;
        if (deleting.has(`${p.namespace}/${p.name}`)) {
          li.className = 'deleting';
          b.disabled = true;
          const spin = document.createElement('i');
          spin.className = 'spinner';
          spin.title = 'Deleting…';
          li.append(b, what, spin);
          return li;
        }
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'delete';
        del.textContent = '✕';
        del.title = `Delete ${p.namespace}/${p.name}`;
        del.addEventListener('click', () => deletePod(p));
        li.append(b, what, del);
        return li;
      }));
      if (!pods.length) {
        const li = document.createElement('li');
        li.className = 'none';
        li.textContent = ns ? `No pods from this app in ${ns} yet.` : 'No namespace.';
        podList.append(li);
      }
    };
    const drawImage = () => {
      const image = st?.images.find((i) => i.name === form.elements.image.value.trim());
      tagList.replaceChildren(...(image?.tags ?? ['latest']).map((t) => Object.assign(document.createElement('option'), { value: t })));
      about.textContent = image ? `${image.category ? `${image.category}. ` : ''}${image.description.replace(/\[([^\]]*)\]/g, '$1')}` : '';
    };
    const load = async (keepNamespace = true) => {
      say('Listing namespaces, pods and images…');
      const prev = keepNamespace ? nsSelect.value : '';
      st = await window.terminal.launcherState();
      if (!st) return;
      const pick = prev && st.namespaces.includes(prev) ? prev : st.namespace;
      nsSelect.replaceChildren(
        ...st.namespaces.map((n) => Object.assign(document.createElement('option'), { value: n, textContent: n })),
        Object.assign(document.createElement('option'), { value: NEW_NS, textContent: 'New namespace…' }),
      );
      nsSelect.value = pick ?? NEW_NS;
      newNs.hidden = nsSelect.value !== NEW_NS;
      imageList.replaceChildren(...st.images.map((i) => Object.assign(document.createElement('option'), { value: i.name, textContent: i.category })));
      drawPods();
      drawImage();
      say(st.errors.join(' · '), st.errors.length > 0);
      if (!st.errors.length) sayDeleting();
    };
    const deletePod = async (p) => {
      const label = `${p.namespace}/${p.name}`;
      if (confirming || deleting.has(label)) return;
      confirming = true;
      const yes = await window.terminal.confirmDeletePod(p.namespace, p.name);
      confirming = false;
      if (!yes) return;
      deleting.add(label);
      drawPods();
      sayDeleting();
      const err = await window.terminal.deletePod(p.namespace, p.name);
      deleting.delete(label);
      if (err) {
        drawPods();
        return say(`${label}: ${err}`, true);
      }
      await load();
      if (!sayDeleting()) say(`Deleted ${label}.`);
    };
    const launch = async (choice, message) => {
      if (busy) return;
      busy = true;
      say(message);
      const err = await window.terminal.launch(id, choice);
      busy = false;
      // On success the pane turns into what was picked and this form goes away.
      if (err) say(err, true);
    };

    nsSelect.addEventListener('change', () => {
      newNs.hidden = nsSelect.value !== NEW_NS;
      if (!newNs.hidden) form.elements.newNamespace.focus();
      drawPods();
    });
    form.elements.image.addEventListener('input', drawImage);
    form.addEventListener('click', async (e) => {
      const act = e.target.closest('button')?.dataset.act;
      if (act === 'planner') launch('planner', 'Opening the layout planner…');
      if (act === 'refresh') load();
      if (act === 'cancel-namespace') {
        nsSelect.value = st?.namespace ?? '';
        newNs.hidden = true;
        drawPods();
      }
      if (act === 'create-namespace') {
        const name = form.elements.newNamespace.value.trim();
        say(`Creating namespace ${name}…`);
        const err = await window.terminal.createNamespace(name);
        if (err) return say(err, true);
        form.elements.newNamespace.value = '';
        await load(false);
        nsSelect.value = name;
        newNs.hidden = true;
        drawPods();
        say(`Created namespace ${name}.`);
      }
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const ns = nsSelect.value;
      const image = form.elements.image.value.trim();
      const tag = form.elements.tag.value.trim() || 'latest';
      const port = Number(form.elements.port.value);
      if (!ns || ns === NEW_NS) return say('Pick a namespace first.', true);
      if (!/^[a-z0-9][a-z0-9_.-]*$/.test(image)) return say('Pick an image, e.g. webtop.', true);
      if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(tag)) return say('That is not an image tag.', true);
      if (!Number.isInteger(port) || port < 1 || port > 65535) return say('The UI port is a number from 1 to 65535.', true);
      launch(`pod:new:${ns}:${image}:${tag}:${port}`, `Creating a ${image} pod in ${ns}…`);
    });
    load();

    const p = {
      el,
      update: () => {},
      syncSize: () => {},
      focus: () => (form.elements.image.value ? nsSelect : form.elements.image).focus(),
      dispose: () => {},
    };
    panes.set(id, p);
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
    if (other?.kind === 'camera') return createCameraPane(id, other).el;
    if (other?.kind === 'launcher') return createLauncherPane(id).el;
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

  // Makes a pane height pixels tall by resizing the nearest stacking split above it, the
  // others in that split sharing what is left. Only side-by-side splits come between
  // the two, so the pane grows as much as the split's child that holds it.
  let drawn = null; // the layout last drawn
  const fitHeight = (id, height) => {
    const p = panes.get(id);
    if (!drawn || !p?.el.isConnected || root.classList.contains('maximized')) return;
    // The path to the nearest 'col' split holding the pane, and the child it is in.
    const find = (node, path) => {
      if (node.type === 'pane') return node.id === id ? { split: null } : null;
      for (const [i, child] of node.children.entries()) {
        const found = find(child, [...path, i]);
        if (!found) continue;
        return found.split || node.dir !== 'col' ? found : { split: path, index: i };
      }
      return null;
    };
    const found = find(drawn, []);
    if (!found?.split) return;
    // The split's box, and its children as drawn.
    let child = p.el;
    while (child.parentElement && !child.parentElement.classList.contains('col')) child = child.parentElement;
    const items = [...child.parentElement.children];
    if (items.indexOf(child) !== found.index) return;
    const heights = items.map((c) => c.getBoundingClientRect().height);
    const total = heights.reduce((a, h) => a + h, 0);
    const rest = total - heights[found.index];
    const want = Math.min(total, Math.max(0, heights[found.index] + height - p.el.clientHeight));
    const sizes = heights.map((h, i) => (i === found.index ? want : rest > 0 ? (h * (total - want)) / rest : 0) / total);
    window.terminal.resizeSplit(found.split, sizes);
  };
  window.terminal.onCameraFitHeight((id) => {
    const height = panes.get(id)?.videoHeight?.();
    if (height) fitHeight(id, height);
  });

  window.terminal.onData((id, data) => panes.get(id)?.term?.write(data));
  window.terminal.onScrcpySession((id, video) => panes.get(id)?.session?.(video));
  window.terminal.onScrcpyPacket((id, packet) => panes.get(id)?.packet?.(packet));
  window.terminal.onScrcpyAudio((id, packet) => panes.get(id)?.audio?.(packet));
  window.terminal.onPageReload((id) => panes.get(id)?.reload?.());
  window.terminal.onLayout((state) => {
    const seen = new Set();
    const maxed = { id: state.maximized, el: null };
    // A locked window with no panes shows just its background.
    drawn = state.layout;
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
    maxedId = maxed.el ? state.maximized : null;
    // Pinned panes stay in sight, in their place, over the maximized one.
    pinned = new Set(state.pinned ?? []);
    for (const [id, p] of panes) {
      p.el.classList.toggle('max', p.el === maxed.el);
      p.el.classList.toggle('pinned', pinned.has(id) && p.el !== maxed.el);
    }
    for (const p of panes.values()) p.syncSize();
    const target = panes.get(state.active);
    if (target && (state.active !== active || !target.el.contains(document.activeElement))) {
      active = state.active;
      if (overlay.hidden && resizeOverlay.hidden) target.focus();
    }
    drawHandles();
  });

  // Presenter mode hides the overlays' tint, outline and label; only the cursor shows
  // move mode, and resize mode's handles show only as the cursor over them.
  for (const o of [overlay, resizeOverlay]) o.classList.toggle('presenter', cfg.presenterMode);
  window.terminal.onPresenterMode((enabled) => {
    for (const o of [overlay, resizeOverlay]) o.classList.toggle('presenter', enabled);
  });
  window.terminal.onMoveMode((enabled) => {
    overlay.hidden = !enabled;
    if (!enabled && resizeOverlay.hidden) panes.get(active)?.focus();
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
  // Resize mode: a handle over each line between panes, dragged like the planner's
  // gutters. The line moves here as it is dragged, and the split's new sizes go to the
  // main process on release, so the panes are not rebuilt under the pointer.
  const HANDLE = 8; // px
  let resizing = null; // { h, start, length, sizes, next }
  const handle = (node, box, items, path, i) => {
    const row = node.dir === 'row';
    const h = document.createElement('div');
    h.className = `handle ${node.dir}`;
    const place = () => {
      const r = items[i + 1].getBoundingClientRect();
      const b = box.getBoundingClientRect();
      Object.assign(h.style, row
        ? { left: `${r.left - HANDLE / 2}px`, top: `${b.top}px`, width: `${HANDLE}px`, height: `${b.height}px` }
        : { left: `${b.left}px`, top: `${r.top - HANDLE / 2}px`, width: `${b.width}px`, height: `${HANDLE}px` });
    };
    place();
    h.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      h.setPointerCapture(e.pointerId);
      h.classList.add('dragging');
      const b = box.getBoundingClientRect();
      resizing = { h, start: row ? e.clientX : e.clientY, length: row ? b.width : b.height, sizes: node.sizes.slice(), next: null };
    });
    h.addEventListener('pointermove', (e) => {
      if (resizing?.h !== h) return;
      const pos = row ? e.clientX : e.clientY;
      const pair = resizing.sizes[i] + resizing.sizes[i + 1];
      const min = 0.05;
      const a = Math.min(pair - min, Math.max(min, resizing.sizes[i] + (pos - resizing.start) / resizing.length));
      const sizes = resizing.sizes.slice();
      sizes[i] = a;
      sizes[i + 1] = pair - a;
      items[i].style.flex = `${sizes[i]} 1 0`;
      items[i + 1].style.flex = `${sizes[i + 1]} 1 0`;
      resizing.next = sizes;
      place();
    });
    const end = () => {
      if (resizing?.h !== h) return;
      const { next } = resizing;
      resizing = null;
      h.classList.remove('dragging');
      if (next) window.terminal.resizeSplit(path, next);
      drawHandles();
    };
    h.addEventListener('pointerup', end);
    h.addEventListener('pointercancel', end);
    h.addEventListener('lostpointercapture', end);
    return h;
  };
  // Also in resize mode, each pane under the pointer shows what a press there does:
  //  - its tools in its top left corner: ✕ closes it, 🏠 puts a New pane form in its
  //    place (as Ctrl+Shift+Alt+Q does), 📌 pins it over a maximized pane,
  //    ⛶ maximizes it (⊡ puts the panes back), ⟳ reloads it;
  //  - within an eighth of its size from its centre, a hand: drag it onto another pane
  //    to trade places (its middle) or to go beside it (an edge), as in the planner;
  //  - elsewhere, the half nearest the pointer, where a click puts a new pane.
  // Nothing over a handle, which is for dragging the line.
  const preview = document.createElement('div');
  preview.className = 'split-preview';
  preview.hidden = true;
  const tools = document.createElement('div');
  tools.className = 'pane-tools';
  tools.hidden = true;
  const tool = (label, title, onClick) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.title = title;
    b.addEventListener('pointerdown', (e) => e.stopPropagation());
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      onClick();
    });
    tools.append(b);
    return b;
  };
  let toolsPane = null; // the pane the tools are on
  const closeTool = tool('✕', 'Close pane', () => window.terminal.closePane(toolsPane));
  const homeTool = tool('🏠', 'Home: close the pane and put a New pane form in its place (Ctrl+Shift+Alt+Q)', () => window.terminal.homePane(toolsPane));
  const pinTool = tool('📌', '', () => window.terminal.pinPane(toolsPane, !pinned.has(toolsPane)));
  const maxTool = tool('⛶', '', () => window.terminal.maximizePane(maxedId === toolsPane ? null : toolsPane));
  tool('⟳', 'Reload: close the pane and open what it showed again, in the same place', () => window.terminal.reloadPane(toolsPane));
  resizeOverlay.append(preview, tools);
  let maxedId = null; // as last drawn
  let pinned = new Set();
  let splitTarget = null; // { id, side }
  let moving = null; // a pane being pressed or dragged by its middle: { id, x, y, dragged, target }
  let pressedMiddle = false; // the press was on a pane's middle, so its click splits nothing
  let pointer = null; // the pointer's last place over the overlay
  const MIDDLE = 1 / 8;
  const DRAG_START = 5; // px

  // The pane on top at a point: a pinned pane over a maximized one, then the
  // maximized pane, or any pane when none is maximized.
  const paneAt = (x, y, except = null) => {
    const maxed = root.classList.contains('maximized');
    const order = [...panes].filter(([id, p]) => id !== except && p.el.isConnected && (!maxed || p.el.classList.contains('max') || pinned.has(id)));
    if (maxed) order.sort(([a], [b]) => pinned.has(b) - pinned.has(a));
    for (const [id, p] of order) {
      const r = p.el.getBoundingClientRect();
      if (x >= r.left && x < r.right && y >= r.top && y < r.bottom) return { id, r };
    }
    return null;
  };
  const showBox = (left, top, width, height, label) => {
    Object.assign(preview.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
    preview.textContent = label;
    preview.hidden = false;
  };
  // Where on pane r a point is, as shares of its width and height.
  const shares = (r, x, y) => [(x - r.left) / r.width, (y - r.top) / r.height];
  const inMiddle = (r, x, y) => {
    const [fx, fy] = shares(r, x, y);
    return Math.abs(fx - 0.5) <= MIDDLE && Math.abs(fy - 0.5) <= MIDDLE;
  };
  const nearestSide = (fx, fy) => [['left', fx], ['right', 1 - fx], ['top', fy], ['bottom', 1 - fy]].sort((a, b) => a[1] - b[1])[0];
  const showHalf = (r, side, label) => {
    const w = side === 'left' || side === 'right' ? r.width / 2 : r.width;
    const h = side === 'top' || side === 'bottom' ? r.height / 2 : r.height;
    showBox(side === 'right' ? r.right - w : r.left, side === 'bottom' ? r.bottom - h : r.top, w, h, label);
  };
  const showTools = (hit) => {
    toolsPane = hit?.id ?? null;
    tools.hidden = !hit;
    if (!hit) return;
    Object.assign(tools.style, { left: `${hit.r.left + 6}px`, top: `${hit.r.top + 6}px` });
    closeTool.disabled = panes.size === 1;
    homeTool.disabled = panes.get(hit.id)?.el.classList.contains('launcher') ?? false;
    pinTool.classList.toggle('on', pinned.has(hit.id));
    pinTool.title = pinned.has(hit.id) ? 'Unpin: hide it behind a maximized pane again' : 'Pin: keep it in sight, in its place, over a maximized pane';
    maxTool.textContent = maxedId === hit.id ? '⊡' : '⛶';
    maxTool.title = maxedId === hit.id ? 'Put the panes back' : 'Maximize: fill the window with this pane';
  };

  const hover = (x, y, target) => {
    splitTarget = null;
    preview.hidden = true;
    resizeOverlay.style.cursor = '';
    if (resizeOverlay.hidden || resizing || x === undefined) return showTools(null);
    if (moving) {
      resizeOverlay.style.cursor = 'grabbing';
      // A press that moves less than DRAG_START pixels drops nowhere.
      moving.dragged ||= Math.hypot(x - moving.x, y - moving.y) >= DRAG_START;
      moving.target = null;
      if (!moving.dragged) return;
      // Where the dragged pane would land: trading places in a pane's middle, or beside
      // it at an edge (a quarter of its size, as in the planner).
      const hit = paneAt(x, y, moving.id);
      if (!hit) return;
      const [fx, fy] = shares(hit.r, x, y);
      const [side, d] = nearestSide(fx, fy);
      const zone = d < 0.25 ? side : 'center';
      moving.target = { id: hit.id, zone };
      if (zone === 'center') showBox(hit.r.left, hit.r.top, hit.r.width, hit.r.height, '⇄');
      else showHalf(hit.r, side, '→');
      return;
    }
    if (target !== resizeOverlay && !tools.contains(target)) return; // a handle
    const hit = paneAt(x, y);
    if (!tools.contains(target)) showTools(hit);
    if (!hit || tools.contains(target)) return;
    if (inMiddle(hit.r, x, y)) {
      resizeOverlay.style.cursor = 'grab';
      return;
    }
    const [side] = nearestSide(...shares(hit.r, x, y));
    splitTarget = { id: hit.id, side };
    showHalf(hit.r, side, '+');
  };
  const rehover = () => (pointer ? hover(pointer.x, pointer.y, document.elementFromPoint(pointer.x, pointer.y)) : hover());

  resizeOverlay.addEventListener('pointermove', (e) => {
    pointer = { x: e.clientX, y: e.clientY };
    hover(e.clientX, e.clientY, e.target);
  });
  resizeOverlay.addEventListener('pointerleave', () => {
    if (moving) return;
    pointer = null;
    hover();
  });
  resizeOverlay.addEventListener('pointerdown', (e) => {
    pressedMiddle = false;
    if (e.button !== 0 || e.target !== resizeOverlay) return;
    const hit = paneAt(e.clientX, e.clientY);
    if (!hit || !inMiddle(hit.r, e.clientX, e.clientY)) return;
    e.preventDefault();
    pressedMiddle = true;
    resizeOverlay.setPointerCapture(e.pointerId);
    moving = { id: hit.id, x: e.clientX, y: e.clientY, dragged: false, target: null };
    showTools(null);
    hover(e.clientX, e.clientY, e.target);
  });
  const endMove = () => {
    if (!moving) return;
    const { id, target } = moving;
    moving = null;
    if (target) window.terminal.movePane(id, target.id, target.zone);
    rehover();
  };
  resizeOverlay.addEventListener('pointerup', endMove);
  resizeOverlay.addEventListener('pointercancel', () => {
    if (moving) moving.target = null;
    endMove();
  });
  resizeOverlay.addEventListener('lostpointercapture', endMove);
  resizeOverlay.addEventListener('click', (e) => {
    if (pressedMiddle || e.target !== resizeOverlay) return;
    hover(e.clientX, e.clientY, e.target);
    if (splitTarget) window.terminal.splitPane(splitTarget.id, splitTarget.side);
  });

  // Walks the layout and the split boxes drawn from it together. None while a pane is
  // maximized: its lines are out of sight.
  function drawHandles() {
    if (resizing) return;
    for (const h of resizeOverlay.querySelectorAll('.handle')) h.remove();
    if (!resizeOverlay.hidden && drawn && !root.classList.contains('maximized')) {
      const walk = (node, el, path) => {
        if (node.type === 'pane') return;
        const items = [...el.children];
        node.children.forEach((child, i) => {
          walk(child, items[i], [...path, i]);
          if (i > 0) resizeOverlay.appendChild(handle(node, el, items, path, i - 1));
        });
      };
      walk(drawn, root.firstElementChild, []);
    }
    // The panes may have moved under the pointer.
    if (!moving) rehover();
  }
  window.addEventListener('resize', drawHandles);
  window.terminal.onResizeMode((enabled) => {
    resizeOverlay.hidden = !enabled;
    if (enabled) document.activeElement?.blur();
    else if (overlay.hidden) panes.get(active)?.focus();
    moving = null;
    drawHandles();
  });

  window.addEventListener('keydown', (e) => {
    if (!resizeOverlay.hidden && overlay.hidden && e.key === 'Escape') {
      window.terminal.exitResizeMode();
    }
    if (!overlay.hidden && e.key === 'Escape') {
      window.terminal.exitMoveMode();
    }
    if (!overlay.hidden || !resizeOverlay.hidden) {
      // Keyboard input does not reach the shell while moving or resizing.
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);

  window.terminal.ready();
}

main();
