// Draws every capture window as a full-screen-shaped card with its pane tree inside,
// and sends edits to the main process. The trees are never changed here: main
// applies each edit, updates the capture windows, and sends the new state back.

const stage = document.getElementById('stage');
let state = null;
let drag = null; // gutter drag in progress
let pressed = false; // pointer down on a pane, maybe about to drag it
let dragging = null; // pane being dragged: { windowId, paneId, el, ghost, over }
let choosing = false; // a pane's source menu has focus; a redraw would close it
let typing = false; // a pane's URL box is open; a redraw would close it
let picking = false; // the dialog that chooses the apps Open app… offers is open
let pending = null; // state that arrived during a drag or a menu choice, drawn after it

// Shown in a capture window's pane (see the planner pane in windowManager.js) rather
// than in its own window.
const IN_PANE = new URLSearchParams(location.search).has('pane');

const EDGE = 0.25; // share of a pane's width or height that counts as its edge

document.getElementById('new-window').addEventListener('click', () => window.planner.newWindow());
const chooseAppsButton = document.getElementById('choose-apps');
chooseAppsButton.addEventListener('click', () => chooseApps());

// Lays the cards out in the grid that makes them largest, keeping the screen's shape.
function fitStage() {
  if (!state) return;
  const n = state.windows.length;
  const box = stage.parentElement;
  const style = getComputedStyle(box);
  const w = box.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  const h = box.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
  const gap = 16;
  const head = 30; // card title bar
  let best = { cols: 1, width: 0 };
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const width = Math.min((w - gap * (cols - 1)) / cols, ((h - gap * (rows - 1)) / rows - head) * state.aspect);
    if (width > best.width) best = { cols, width };
  }
  stage.style.gridTemplateColumns = `repeat(${best.cols}, ${Math.floor(best.width)}px)`;
  for (const body of stage.querySelectorAll('.window-body')) {
    body.style.height = `${Math.floor(best.width / state.aspect)}px`;
  }
}

function button(parent, label, title, onClick, cls = '') {
  const b = document.createElement('button');
  b.textContent = label;
  b.title = title;
  b.className = cls;
  b.draggable = false;
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  parent.appendChild(b);
  return b;
}

// A divider between children i and i+1 of a split. onResize gets the new sizes,
// at most once per frame, so the capture window follows the drag live. In a pane it
// gets them once, on release: resizing live would move the pane, and so the planner
// and the gutter, under the pointer.
function gutter(box, node, i, onResize) {
  const g = document.createElement('div');
  g.className = 'gutter';
  g.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    g.setPointerCapture(e.pointerId);
    g.classList.add('dragging');
    const rect = box.getBoundingClientRect();
    drag = {
      g,
      start: node.dir === 'row' ? e.clientX : e.clientY,
      length: node.dir === 'row' ? rect.width : rect.height,
      sizes: node.sizes.slice(),
      items: [...box.children].filter((c) => !c.classList.contains('gutter')),
      frame: 0,
    };
  });
  g.addEventListener('pointermove', (e) => {
    if (!drag || drag.g !== g) return;
    const pos = node.dir === 'row' ? e.clientX : e.clientY;
    const pair = drag.sizes[i] + drag.sizes[i + 1];
    const min = 0.05;
    const a = Math.min(pair - min, Math.max(min, drag.sizes[i] + (pos - drag.start) / drag.length));
    const sizes = drag.sizes.slice();
    sizes[i] = a;
    sizes[i + 1] = pair - a;
    drag.items[i].style.flex = `${sizes[i]} 1 0`;
    drag.items[i + 1].style.flex = `${sizes[i + 1]} 1 0`;
    drag.next = sizes;
    if (IN_PANE) return;
    cancelAnimationFrame(drag.frame);
    drag.frame = requestAnimationFrame(() => onResize(sizes));
  });
  const end = () => {
    if (!drag || drag.g !== g) return;
    g.classList.remove('dragging');
    if (IN_PANE && drag.next) onResize(drag.next);
    drag = null;
    flush();
  };
  g.addEventListener('pointerup', end);
  g.addEventListener('pointercancel', end);
  g.addEventListener('lostpointercapture', end);
  return g;
}

// Nested flex boxes for a split tree; leaf(id) draws each pane.
function build(node, path, leaf, onResize) {
  if (node.type === 'pane') return leaf(node.id);
  const box = document.createElement('div');
  box.className = `split ${node.dir}`;
  node.children.forEach((child, i) => {
    if (i > 0) box.appendChild(gutter(box, node, i - 1, (sizes) => onResize(path, sizes)));
    const el = build(child, [...path, i], leaf, onResize);
    el.style.flex = `${node.sizes[i]} 1 0`;
    box.appendChild(el);
  });
  return box;
}

// Pane dragging uses pointer events, not HTML drag and drop: Chromium's X11 drag
// session can wedge the whole app when the drop makes the main process busy.
// A press that moves less than DRAG_START pixels is a click, which selects the pane.
const DRAG_START = 5;

function startDrag(el, windowId, paneId, label) {
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('button, select, input')) return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    pressed = true;
    const press = { x: e.clientX, y: e.clientY };

    const move = (ev) => {
      if (!dragging) {
        if (Math.hypot(ev.clientX - press.x, ev.clientY - press.y) < DRAG_START) return;
        const ghost = document.createElement('div');
        ghost.className = 'ghost';
        ghost.textContent = label;
        document.body.appendChild(ghost);
        dragging = { windowId, paneId, el, ghost, over: null };
        el.classList.add('dragging');
      }
      dragging.ghost.style.transform = `translate(${ev.clientX + 12}px, ${ev.clientY + 12}px)`;
      const target = dropTarget(ev);
      if (dragging.over && dragging.over !== target?.el) delete dragging.over.dataset.drop;
      dragging.over = target?.el || null;
      if (target) target.el.dataset.drop = target.zone;
    };

    const finish = (ev, drop) => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', escape, true);
      pressed = false;
      if (!dragging) {
        if (drop) window.planner.select(windowId, paneId);
        flush();
        return;
      }
      const target = drop ? dropTarget(ev) : null;
      if (dragging.over) delete dragging.over.dataset.drop;
      dragging.ghost.remove();
      el.classList.remove('dragging');
      dragging = null;
      if (target) window.planner.move(windowId, paneId, target.paneId, target.zone);
      flush();
    };
    const up = (ev) => finish(ev, true);
    const cancel = (ev) => finish(ev, false);
    const escape = (ev) => {
      if (ev.key === 'Escape') finish(ev, false);
    };

    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', escape, true);
  });
}

// The pane under the pointer, and where on it the dragged pane would land. Only panes
// of the dragged pane's own window take a drop.
function dropTarget(e) {
  const hit = document.elementFromPoint(e.clientX, e.clientY)?.closest('.pane');
  if (!hit || !dragging || hit.dataset.windowId !== dragging.windowId || hit.dataset.paneId === dragging.paneId) return null;
  return { el: hit, paneId: hit.dataset.paneId, zone: dropZone(hit, e) };
}

// Which part of the pane the pointer is over: an edge, or the middle.
function dropZone(el, e) {
  const r = el.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width;
  const y = (e.clientY - r.top) / r.height;
  const edges = [['left', x], ['right', 1 - x], ['top', y], ['bottom', 1 - y]].filter(([, d]) => d < EDGE);
  if (edges.length === 0) return 'center';
  return edges.sort((a, b) => a[1] - b[1])[0][0];
}

// A pane's program: "tmux work", "ptmux 2", "chromium 0", "Pixel 8", "localhost:3000",
// "bash", "vim".
function paneName(info) {
  if (info.planner) return 'Plan layout';
  if (info.droidcam) return 'DroidCam';
  if (info.page) return new URL(info.page).host;
  if (info.device) {
    const display = info.display === null ? '' : ` · ${displayLabel(info.display)}`;
    return `${info.model ?? info.device}${display}${info.deviceApp ? ` · ${info.deviceApp.name}` : ''}`;
  }
  if (info.app) return `${info.app} ${info.instance}`;
  return info.session ? `${info.mux} ${info.session}` : info.process;
}

// The pane's menu value (see sourceMenu).
function paneSource(info) {
  if (info.planner) return 'planner';
  if (info.droidcam) return 'droidcam';
  if (info.page) return `page:${info.page}`;
  if (info.device && info.deviceApp) return appSource(info.device, info.deviceApp.package);
  if (info.device) return deviceSource(info.device, info.display);
  if (info.app) return `ls:${info.app}:${info.instance}`;
  return info.session ? `${info.mux}:${info.session}` : 'shell';
}

// A device's screen ('scrcpy:<serial>'), or a new display on it (see displayLabel).
function deviceSource(serial, display) {
  return display === null ? `scrcpy:${serial}` : `scrcpy-display:${display}:${serial}`;
}

// An app that has been on a device pane, moving to the pane that picks it. Package
// names cannot contain ':'.
function appSource(serial, pkg) {
  return `scrcpy-app:${pkg}:${serial}`;
}

// deviceSource's value back as { serial, display }. Serials can contain ':', and
// displays cannot.
function parseDeviceSource(value) {
  const rest = value.slice(value.indexOf(':') + 1);
  if (!value.startsWith('scrcpy-display:')) return { serial: rest, display: null };
  const cut = rest.indexOf(':');
  return { serial: rest.slice(cut + 1), display: rest.slice(0, cut) };
}

// A new display, as scrcpy's --new-display takes it ('', '1920x1080', '/240',
// '1920x1080/240'), or 'fit' / 'fit/<dpi>' for one that keeps fitting its pane.
function displayLabel(display) {
  if (display.startsWith('fit')) return `new display fitting the pane${display.length > 3 ? ` (${display.slice(4)} dpi)` : ''}`;
  return `new display${display ? ` ${display}` : ''}`;
}

// What a pane shows, as one line: "tmux work — vim notes.md", "bash", "vim — notes.md".
function paneLabel(info) {
  const name = paneName(info);
  // A device pane's title is its model, which the name already starts with.
  if (info.device) return name;
  return info.title && info.title !== name && info.title !== info.process ? `${name} — ${info.title}` : name;
}

// The menu that picks what a pane shows: a shell, for each installed multiplexer
// (ptmux, tmux, screen) a running session or a new one, a linuxserver app such
// as webtop or chromium (an existing container or a new one from a pulled image),
// the screen of a connected Android device (through scrcpy) or a new display on it,
// an app that has been on a device pane (which moves it to this pane), a web page
// (a recent one, or a URL typed into the box that "Web page…" opens), DroidCam's
// camera, or this planner.
// current is the pane's choice ('shell', '<mux>:<name>', 'ls:<app>:<instance>',
// 'page:<url>', 'planner', ...), or null for a placeholder (an empty window).
// While the menu has focus, redraws wait, or the open menu would vanish. Opening it
// first fetches the sessions, apps and pulled images, so an image pulled a moment
// ago is already there.
function sourceMenu(current, onChoose) {
  const select = document.createElement('select');
  select.className = 'source';
  select.title = 'What this pane shows. A session or app keeps running when the pane closes or switches.';
  fillSourceMenu(select, current, state);

  // Fresh options, without a redraw, which would close the menu.
  const refresh = async () => {
    const fresh = await window.planner.refresh();
    pending = fresh;
    fillSourceMenu(select, current, fresh);
  };
  // A click opens the menu only once the fresh options are in. Fetching takes a few
  // tens of milliseconds, well inside the click's activation that showPicker needs.
  let opening = false;
  select.addEventListener('mousedown', async (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    opening = true;
    select.focus();
    try {
      await refresh();
    } finally {
      opening = false;
    }
    if (document.activeElement === select) select.showPicker();
  });
  select.addEventListener('focus', () => {
    choosing = true;
    // Reached with the keyboard: fetch before arrow keys or Space open it.
    if (!opening) refresh();
  });
  select.addEventListener('blur', () => {
    choosing = false;
    flush();
  });
  select.addEventListener('change', () => {
    if (select.value === 'page:new') {
      urlBox(select, current, onChoose);
      return;
    }
    onChoose(select.value);
    select.blur();
  });
  return select;
}

// "localhost:3000/admin" -> "http://localhost:3000/admin"; null unless it makes an
// http or https URL.
function pageUrl(text) {
  text = text.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `http://${text}`;
  try {
    const url = new URL(text);
    return ['http:', 'https:'].includes(url.protocol) && url.host ? url.href : null;
  } catch {
    return null;
  }
}

// Takes the source menu's place: Enter opens the URL in the pane, Esc or clicking
// away puts the menu back. Starts from the pane's own page, if it shows one.
function urlBox(select, current, onChoose) {
  typing = true;
  const input = document.createElement('input');
  input.className = 'source url';
  input.type = 'text';
  input.spellcheck = false;
  input.placeholder = 'localhost:3000';
  input.title = 'A web page to show in this pane. Enter opens it, Esc cancels.';
  input.value = current?.startsWith('page:') ? current.slice(5) : '';
  let done = false;
  const close = (choice) => {
    if (done) return;
    done = true;
    typing = false;
    choosing = false; // the menu may not have seen its own blur when the box replaced it
    if (choice) onChoose(choice);
    select.value = current ?? '';
    if (input.isConnected) input.replaceWith(select);
    flush();
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') close(null);
    if (e.key !== 'Enter') return;
    const url = pageUrl(input.value);
    input.classList.toggle('invalid', !url);
    if (url) close(`page:${url}`);
  });
  input.addEventListener('input', () => input.classList.remove('invalid'));
  input.addEventListener('blur', () => close(null));
  select.replaceWith(input);
  input.focus();
  input.select();
}

function fillSourceMenu(select, current, st) {
  const option = (parent, value, label) => {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    parent.appendChild(o);
    return o;
  };
  select.replaceChildren();
  if (current === null) option(select, '', 'Open…').disabled = true;
  option(select, 'shell', 'Shell');
  option(select, 'planner', 'Plan layout').title = 'This planner, in the pane';
  for (const mux of st.muxes) {
    const group = document.createElement('optgroup');
    group.label = `${mux.id} sessions`;
    const names = new Set(mux.sessions);
    // The pane's own session, even if the last listing has not seen it yet.
    if (current?.startsWith(`${mux.id}:`)) names.add(current.slice(mux.id.length + 1));
    for (const name of names) option(group, `${mux.id}:${name}`, name);
    option(group, `${mux.id}:new`, `New ${mux.id} session`);
    select.appendChild(group);
  }
  if (st.linuxserver) {
    const group = document.createElement('optgroup');
    group.label = 'linuxserver';
    const running = new Map(st.linuxserver.containers.map((c) => [`ls:${c.app}:${c.name}`, c]));
    // The pane's own app, even if the last listing has not seen it yet.
    if (current?.startsWith('ls:') && !running.has(current)) {
      const [, app, name] = current.split(':');
      running.set(current, { app, name, running: true });
    }
    for (const [value, c] of running) option(group, value, `${c.app} ${c.name}${c.running ? '' : ' (stopped)'}`);
    for (const { app, tag } of st.linuxserver.images) {
      option(group, `ls:new:${app}:${tag}`, tag === 'latest' ? `New ${app}` : `New ${app} (${tag})`);
    }
    if (group.children.length) select.appendChild(group);
  }
  // Per device: its screen, and the new displays the config offers.
  if (st.android) {
    const capitalize = (text) => text[0].toUpperCase() + text.slice(1);
    for (const { serial, model } of st.android.devices) {
      const group = document.createElement('optgroup');
      group.label = `${model} (scrcpy)`;
      option(group, deviceSource(serial, null), 'Screen');
      for (const display of st.android.displays) option(group, deviceSource(serial, display), capitalize(displayLabel(display)));
      select.appendChild(group);
      // Apps that have been on its panes. Picking one moves it to this pane.
      const apps = st.android.apps?.[serial] ?? [];
      if (apps.length) {
        const appGroup = document.createElement('optgroup');
        appGroup.label = `${model} apps`;
        for (const app of apps) option(appGroup, appSource(serial, app.package), app.name).title = `${app.package}: move it to this pane`;
        select.appendChild(appGroup);
      }
    }
    // The pane's own device, even while it is disconnected, or its display when the
    // config no longer offers it.
    if (current?.startsWith('scrcpy') && !current.startsWith('scrcpy-app:') && ![...select.options].some((o) => o.value === current)) {
      const group = document.createElement('optgroup');
      group.label = 'Android (scrcpy)';
      const { serial, display } = parseDeviceSource(current);
      option(group, current, `${serial}${display === null ? '' : ` · ${displayLabel(display)}`}`);
      select.appendChild(group);
    }
  }
  // DroidCam's camera, when its module is loaded (or the pane already shows it).
  if (st.droidcam || current === 'droidcam') {
    const group = document.createElement('optgroup');
    group.label = 'Cameras';
    option(group, 'droidcam', 'DroidCam').title = "The phone's camera, through DroidCam's V4L2 loopback device";
    select.appendChild(group);
  }
  // The pane's own page, the pages opened last, and a box for any other.
  const pages = document.createElement('optgroup');
  pages.label = 'Web pages';
  const urls = new Set(st.pages ?? []);
  if (current?.startsWith('page:')) urls.add(current.slice(5));
  for (const url of urls) option(pages, `page:${url}`, url.replace(/^https?:\/\//, '')).title = url;
  option(pages, 'page:new', 'Web page…');
  select.appendChild(pages);
  select.value = current ?? '';
}

// Opens an app on a device pane's screen or new display. The device's apps are
// fetched when the menu opens (the main process keeps them a minute, and listing them
// takes the device a few seconds the first time). Like the source menu, it holds
// redraws while it has focus.
function appMenu(win, id, info) {
  const select = document.createElement('select');
  select.className = 'source apps';
  select.title = info.display === null
    ? 'Open an app on the phone'
    : 'Open an app on this new display; it opens again when the display comes back';
  const fill = (apps, note) => {
    const option = (parent, value, label) => {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = label;
      parent.appendChild(o);
      return o;
    };
    select.replaceChildren();
    option(select, '', note ?? 'Open app…').disabled = true;
    // Only the apps chosen for this phone, when some are chosen.
    const shown = new Set(state.android?.shownApps?.[info.device] ?? []);
    if (shown.size) apps = apps.filter((a) => shown.has(a.package));
    // The app on the pane now, even before the list is in or when it is not chosen.
    const current = info.deviceApp;
    if (current && !apps.some((a) => a.package === current.package)) option(select, current.package, current.name).title = current.package;
    for (const [label, system] of [['Apps', false], ['System apps', true]]) {
      const group = document.createElement('optgroup');
      group.label = label;
      for (const app of apps.filter((a) => a.system === system)) option(group, app.package, app.name).title = app.package;
      if (group.children.length) select.appendChild(group);
    }
    select.value = note ? '' : current?.package ?? '';
  };
  fill([]);

  let opening = false;
  select.addEventListener('mousedown', async (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    opening = true;
    select.focus();
    fill([], 'Loading apps…');
    let apps = [];
    try {
      apps = await window.planner.deviceApps(info.device);
    } finally {
      opening = false;
    }
    fill(apps, apps.length ? null : 'No apps found');
    if (document.activeElement !== select) return;
    try {
      select.showPicker();
    } catch {
      // The click's activation ran out while the device listed its apps; the next
      // click opens the menu at once.
    }
  });
  select.addEventListener('focus', async () => {
    choosing = true;
    if (opening) return;
    // Reached with the keyboard.
    fill(await window.planner.deviceApps(info.device));
  });
  select.addEventListener('blur', () => {
    choosing = false;
    flush();
  });
  select.addEventListener('change', () => {
    if (select.value && select.value !== info.deviceApp?.package) window.planner.openApp(win.id, id, select.value);
    select.blur();
  });
  return select;
}

// A checklist of one phone's apps: the ticked ones are all that the Open app… menus
// of its panes offer; none ticked offers them all. Each phone has its own list. The
// ticks on every phone looked at are kept until Save, which saves each one's list.
function chooseApps() {
  const devices = state.android?.devices ?? [];
  if (!devices.length) return;
  picking = true;
  const saved = state.android?.shownApps ?? {};
  const edits = new Map(); // serial -> Set(package), for each phone looked at
  const listed = new Map(); // serial -> its apps, once listed

  const dialog = document.createElement('dialog');
  dialog.className = 'choose-apps';
  const title = document.createElement('h2');
  title.textContent = 'Apps to offer in Open app…';
  const hint = document.createElement('p');
  hint.textContent = 'Only the ticked apps show in the Open app… menu of this phone\'s panes. With none ticked, it shows them all.';
  const phoneRow = document.createElement('label');
  phoneRow.className = 'phone';
  phoneRow.textContent = 'Phone';
  const phone = document.createElement('select');
  for (const { serial, model } of devices) {
    const o = document.createElement('option');
    o.value = serial;
    o.textContent = devices.filter((d) => d.model === model).length > 1 ? `${model} (${serial})` : model;
    o.title = serial;
    phone.appendChild(o);
  }
  // The phone in the focused window's active pane, if there is one.
  const focused = state.windows.find((w) => w.focused) ?? state.windows[0];
  const activeDevice = focused?.panes.find((p) => p.id === focused.active)?.device;
  if (devices.some((d) => d.serial === activeDevice)) phone.value = activeDevice;
  phoneRow.appendChild(phone);
  const search = document.createElement('input');
  search.type = 'search';
  search.placeholder = 'Search apps';
  search.spellcheck = false;
  const list = document.createElement('div');
  list.className = 'list';
  let rows = [];

  const note = (text) => {
    const p = document.createElement('div');
    p.className = 'note';
    p.textContent = text;
    return p;
  };
  const filter = () => {
    const q = search.value.trim().toLowerCase();
    for (const r of rows) r.row.hidden = Boolean(q) && !r.text.includes(q);
    for (const head of list.querySelectorAll('h3')) {
      head.hidden = rows.every((r) => r.head !== head || r.row.hidden);
    }
  };
  // Lists the phone's apps, ticked as last saved or as ticked since the dialog opened.
  const show = async (serial) => {
    rows = [];
    list.replaceChildren(note('Loading apps…'));
    let apps = listed.get(serial);
    if (!apps) {
      apps = await window.planner.deviceApps(serial);
      listed.set(serial, apps);
    }
    if (phone.value !== serial || !dialog.open) return;
    if (!edits.has(serial)) edits.set(serial, new Set(saved[serial] ?? []));
    const ticked = edits.get(serial);
    list.replaceChildren();
    for (const [label, system] of [['Apps', false], ['System apps', true]]) {
      const group = apps.filter((a) => a.system === system);
      if (!group.length) continue;
      const head = document.createElement('h3');
      head.textContent = label;
      list.appendChild(head);
      for (const app of group) {
        const row = document.createElement('label');
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = ticked.has(app.package);
        box.addEventListener('change', () => {
          if (box.checked) ticked.add(app.package);
          else ticked.delete(app.package);
        });
        const name = document.createElement('span');
        name.textContent = app.name;
        const pkg = document.createElement('small');
        pkg.textContent = app.package;
        row.append(box, name, pkg);
        list.appendChild(row);
        rows.push({ row, box, head, text: `${app.name} ${app.package}`.toLowerCase() });
      }
    }
    if (!rows.length) list.appendChild(note('No apps found'));
    filter();
  };
  phone.addEventListener('change', () => show(phone.value));
  search.addEventListener('input', filter);

  const buttons = document.createElement('div');
  buttons.className = 'buttons';
  const action = (label, onClick, cls = '') => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.className = cls;
    b.addEventListener('click', onClick);
    buttons.appendChild(b);
  };
  action('Untick all', () => {
    edits.get(phone.value)?.clear();
    for (const r of rows) r.box.checked = false;
  });
  action('Cancel', () => dialog.close());
  action('Save', () => {
    for (const [serial, ticked] of edits) {
      const before = [...(saved[serial] ?? [])].sort().join();
      if ([...ticked].sort().join() !== before) window.planner.setShownApps(serial, [...ticked]);
    }
    dialog.close();
  }, 'primary');
  dialog.append(title, hint, phoneRow, search, list, buttons);
  dialog.addEventListener('close', () => {
    dialog.remove();
    picking = false;
    flush();
  });
  document.body.appendChild(dialog);
  dialog.showModal();
  search.focus();
  show(phone.value);
}

function paneBox(win, id) {
  const info = win.panes.find((p) => p.id === id);
  const el = document.createElement('div');
  el.className = 'pane';
  el.classList.toggle('active', id === win.active);
  // Behind the maximized pane, so not on screen for now.
  el.classList.toggle('covered', Boolean(win.maximized) && id !== win.maximized);

  const proc = document.createElement('div');
  proc.className = 'proc';
  proc.textContent = paneLabel(info);
  el.title = proc.textContent;
  const zone = document.createElement('div');
  zone.className = 'zone';
  const source = sourceMenu(paneSource(info), (value) => window.planner.setSource(win.id, id, value));

  const tools = document.createElement('div');
  tools.className = 'tools';
  button(tools, '◫', 'Split pane right', () => window.planner.split(win.id, id, 'row'));
  button(tools, '⊟', 'Split pane down', () => window.planner.split(win.id, id, 'col'));
  const maxed = win.maximized === id;
  const max = button(
    tools,
    maxed ? '⊡' : '⛶',
    maxed ? 'Put the panes back (Ctrl+Shift+Alt+Z)' : 'Maximize: fill the window with this pane for now (Ctrl+Shift+Alt+Z)',
    () => window.planner.maximize(win.id, maxed ? null : id),
    'max',
  );
  max.setAttribute('aria-pressed', String(maxed));
  max.disabled = win.panes.length === 1 && !maxed;
  if (info.page) button(tools, '↻', 'Reload the page', () => window.planner.reloadPage(win.id, id));
  if (info.app) {
    const name = paneName(info);
    button(tools, '■', `Stop ${name} (its files stay in its volume)`, () => {
      if (confirm(`Stop ${name}? Programs running in it are closed; files in its home stay.`)) {
        window.planner.stopApp(info.app, info.instance);
      }
    }, 'close');
  }
  // Only a locked window may lose its last pane; any other window would close.
  const closeTip = info.app ? `Close pane (${info.app} keeps running)` : info.session ? 'Close pane (the session keeps running)'
    : info.device && info.display !== null ? 'Close pane and its new display' : 'Close pane';
  button(tools, '✕', closeTip, () => window.planner.close(win.id, id), 'close').disabled =
    win.panes.length === 1 && !win.locked;

  el.append(zone, tools, proc, source);
  if (info.device) el.append(appMenu(win, id, info));
  el.dataset.windowId = win.id;
  el.dataset.paneId = id;
  startDrag(el, win.id, id, proc.textContent);
  return el;
}

// A locked window with no panes: start a shell, a multiplexer session, a linuxserver
// app, a device or a web page in it.
function emptyBox(win) {
  const el = document.createElement('div');
  el.className = 'empty';
  const text = document.createElement('p');
  text.textContent = 'No panes. The window stays open and blank.';
  el.append(text, sourceMenu(null, (value) => window.planner.addPane(win.id, value)));
  el.dataset.windowId = win.id;
  return el;
}

function windowCard(win, number) {
  const el = document.createElement('section');
  el.className = 'window';
  el.classList.toggle('focused', win.focused);
  el.classList.toggle('locked', win.locked);

  const head = document.createElement('div');
  head.className = 'window-head';
  const name = document.createElement('span');
  name.className = 'name';
  const active = win.panes.find((p) => p.id === win.active);
  name.textContent = `Window ${number}${active ? ` · ${paneName(active)}` : ''}`;
  const tools = document.createElement('span');
  tools.className = 'tools';
  const lock = button(
    tools,
    win.locked ? 'Locked' : 'Lock',
    win.locked
      ? 'Locked: this window stays open, even with no panes, so a capture source keeps pointing at it. Click to unlock.'
      : 'Lock this window so it stays open, even when its last pane exits',
    () => window.planner.lockWindow(win.id, !win.locked),
    'lock',
  );
  lock.setAttribute('aria-pressed', String(win.locked));
  button(tools, '⤢', 'Bring this window to the front', () => window.planner.focusWindow(win.id));
  button(tools, '✕', win.locked ? 'Unlock this window to close it' : 'Close this window and its shells', () => window.planner.closeWindow(win.id), 'close').disabled =
    win.locked || state.windows.length === 1;
  head.append(name, tools);

  const body = document.createElement('div');
  body.className = 'window-body';
  if (win.layout) {
    const panes = build(win.layout, [], (paneId) => paneBox(win, paneId), (path, sizes) => window.planner.resize(win.id, path, sizes));
    panes.style.flex = '1 1 0';
    body.appendChild(panes);
  } else {
    body.appendChild(emptyBox(win));
  }

  el.append(head, body);
  return el;
}

function flush() {
  const next = pending;
  pending = null;
  render(next);
}

// Redrawing mid-drag would remove the element being dragged, so a state that
// arrives during a drag, or while a source menu is open, waits for it to end.
function render(next) {
  if (!next) return;
  if (drag || dragging || pressed || choosing || typing || picking) {
    pending = next;
    return;
  }
  state = next;
  // Shown with adb; usable once a phone is connected.
  chooseAppsButton.hidden = !state.android;
  chooseAppsButton.disabled = !state.android?.devices.length;
  chooseAppsButton.title = chooseAppsButton.disabled
    ? 'Connect a phone to choose the apps its Open app… menu offers'
    : 'Choose, for each phone, the apps its Open app… menu offers';
  stage.replaceChildren(...state.windows.map((w, i) => windowCard(w, i + 1)));
  fitStage();
}

window.addEventListener('resize', fitStage);
window.planner.onState(render);
window.planner.getState().then(render);
