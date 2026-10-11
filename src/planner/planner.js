// Draws every capture window as a full-screen-shaped card with its pane tree inside,
// and sends edits to the main process. The trees are never changed here: main
// applies each edit, updates the capture windows, and sends the new state back.

const stage = document.getElementById('stage');
let state = null;
let drag = null; // gutter drag in progress
let pressed = false; // pointer down on a pane, maybe about to drag it
let dragging = null; // pane being dragged: { windowId, paneId, el, ghost, over }
let choosing = false; // a pane's source menu has focus; a redraw would close it
let pending = null; // state that arrived during a drag or a menu choice, drawn after it

const EDGE = 0.25; // share of a pane's width or height that counts as its edge

document.getElementById('new-window').addEventListener('click', () => window.planner.newWindow());

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
// at most once per frame, so the capture window follows the drag live.
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
    cancelAnimationFrame(drag.frame);
    drag.frame = requestAnimationFrame(() => onResize(sizes));
  });
  const end = () => {
    if (!drag || drag.g !== g) return;
    g.classList.remove('dragging');
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
    if (e.button !== 0 || e.target.closest('button, select')) return;
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

// A pane's program: "tmux work", "ptmux 2", "webtop 0", "bash", "vim".
function paneName(info) {
  if (info.webtop) return `webtop ${info.webtop}`;
  return info.session ? `${info.mux} ${info.session}` : info.process;
}

// The pane's menu value (see sourceMenu).
function paneSource(info) {
  if (info.webtop) return `webtop:${info.webtop}`;
  return info.session ? `${info.mux}:${info.session}` : 'shell';
}

// What a pane shows, as one line: "tmux work — vim notes.md", "bash", "vim — notes.md".
function paneLabel(info) {
  const name = paneName(info);
  return info.title && info.title !== name && info.title !== info.process ? `${name} — ${info.title}` : name;
}

// The menu that picks what a pane shows: a shell, for each installed multiplexer
// (ptmux, tmux, screen) a running session or a new one, or a webtop (an existing
// container or a new one from a pulled image tag). current is the pane's choice
// ('shell', '<mux>:<name>' or 'webtop:<name>'), or null for a placeholder (an empty
// window).
// While the menu has focus, redraws wait, or the open menu would vanish.
function sourceMenu(current, onChoose) {
  const select = document.createElement('select');
  select.className = 'source';
  select.title = 'What this pane shows. A session or webtop keeps running when the pane closes or switches.';
  const option = (parent, value, label) => {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    parent.appendChild(o);
    return o;
  };
  if (current === null) option(select, '', 'Open…').disabled = true;
  option(select, 'shell', 'Shell');
  for (const mux of state.muxes) {
    const group = document.createElement('optgroup');
    group.label = `${mux.id} sessions`;
    const names = new Set(mux.sessions);
    // The pane's own session, even if the last listing has not seen it yet.
    if (current?.startsWith(`${mux.id}:`)) names.add(current.slice(mux.id.length + 1));
    for (const name of names) option(group, `${mux.id}:${name}`, name);
    option(group, `${mux.id}:new`, `New ${mux.id} session`);
    select.appendChild(group);
  }
  if (state.webtop) {
    const group = document.createElement('optgroup');
    group.label = 'webtops';
    const containers = new Map(state.webtop.containers.map((c) => [c.name, c]));
    if (current?.startsWith('webtop:') && !containers.has(current.slice(7))) containers.set(current.slice(7), { running: true });
    for (const [name, c] of containers) option(group, `webtop:${name}`, c.running ? name : `${name} (stopped)`);
    for (const tag of state.webtop.images) option(group, `webtop:new:${tag}`, `New webtop (${tag})`);
    if (group.children.length) select.appendChild(group);
  }
  select.value = current ?? '';
  select.addEventListener('focus', () => { choosing = true; });
  select.addEventListener('blur', () => {
    choosing = false;
    flush();
  });
  select.addEventListener('change', () => {
    onChoose(select.value);
    select.blur();
  });
  return select;
}

function paneBox(win, id) {
  const info = win.panes.find((p) => p.id === id);
  const el = document.createElement('div');
  el.className = 'pane';
  el.classList.toggle('active', id === win.active);

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
  if (info.webtop) {
    button(tools, '■', `Stop webtop ${info.webtop} (its files stay in its volume)`, () => {
      if (confirm(`Stop webtop ${info.webtop}? Programs running in its desktop are closed; files in its home stay.`)) {
        window.planner.stopWebtop(info.webtop);
      }
    }, 'close');
  }
  // Only a locked window may lose its last pane; any other window would close.
  button(tools, '✕', info.webtop ? 'Close pane (the webtop keeps running)' : info.session ? 'Close pane (the session keeps running)' : 'Close pane', () => window.planner.close(win.id, id), 'close').disabled =
    win.panes.length === 1 && !win.locked;

  el.append(zone, tools, proc, source);
  el.dataset.windowId = win.id;
  el.dataset.paneId = id;
  startDrag(el, win.id, id, proc.textContent);
  return el;
}

// A locked window with no panes: start a shell, a multiplexer session or a webtop in it.
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
  if (drag || dragging || pressed || choosing) {
    pending = next;
    return;
  }
  state = next;
  stage.replaceChildren(...state.windows.map((w, i) => windowCard(w, i + 1)));
  fitStage();
}

window.addEventListener('resize', fitStage);
window.planner.onState(render);
window.planner.getState().then(render);
