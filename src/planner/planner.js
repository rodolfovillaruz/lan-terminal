// Draws the window tiling, with each window's pane tree inside its tile, and sends
// edits to the main process. The trees are never changed here: main applies each
// edit, retiles the capture windows, and sends the new state back.

const stage = document.getElementById('stage');
let state = null;
let windows = new Map(); // window id -> { id, focused, layout, active, panes }
let drag = null; // gutter drag in progress
let dragging = false; // window or pane drag in progress
let pending = null; // state that arrived during a drag, drawn when it ends

document.getElementById('untile').addEventListener('click', () => window.planner.untile());

function fitStage() {
  if (!state) return;
  const box = stage.parentElement;
  const style = getComputedStyle(box);
  const w = box.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  const h = box.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
  const width = Math.min(w, h * state.aspect);
  stage.style.width = `${width}px`;
  stage.style.height = `${width / state.aspect}px`;
}

function leaves(node) {
  return node.type === 'pane' ? [node.id] : node.children.flatMap(leaves);
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

// Makes el a drop target for drags of the given type; onDrop gets the dragged id.
function dropTarget(el, type, onDrop) {
  el.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes(type)) return;
    e.preventDefault();
    e.stopPropagation();
    el.classList.add('drop');
  });
  el.addEventListener('dragleave', (e) => {
    if (!el.contains(e.relatedTarget)) el.classList.remove('drop');
  });
  el.addEventListener('drop', (e) => {
    el.classList.remove('drop');
    if (!e.dataTransfer.types.includes(type)) return;
    e.preventDefault();
    e.stopPropagation();
    onDrop(e.dataTransfer.getData(type));
  });
}

function dragSource(el, type, id) {
  el.draggable = true;
  el.addEventListener('dragstart', (e) => {
    e.stopPropagation();
    e.dataTransfer.setData(type, id);
    e.dataTransfer.effectAllowed = 'move';
    el.classList.add('dragging');
    dragging = true;
  });
  el.addEventListener('dragend', () => {
    el.classList.remove('dragging');
    dragging = false;
    flush();
  });
}

// A divider between children i and i+1 of a split. onResize gets the new sizes,
// at most once per frame, so the capture windows follow the drag live.
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

// Nested flex boxes for a split tree; leaf(id) draws each leaf.
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

function paneBox(win, id) {
  const order = win.panes.findIndex((p) => p.id === id);
  const info = win.panes[order];
  const el = document.createElement('div');
  el.className = 'pane';
  el.classList.toggle('active', id === win.active);

  const num = document.createElement('div');
  num.className = 'num';
  num.textContent = order + 1;
  const proc = document.createElement('div');
  proc.className = 'proc';
  proc.textContent = info.title && info.title !== info.process ? `${info.process} — ${info.title}` : info.process;
  el.title = proc.textContent;

  const tools = document.createElement('div');
  tools.className = 'tools';
  button(tools, '◫', 'Split pane right', () => window.planner.split(win.id, id, 'row'));
  button(tools, '⊟', 'Split pane down', () => window.planner.split(win.id, id, 'col'));
  button(tools, '✕', 'Close pane', () => window.planner.close(win.id, id), 'close').disabled = win.panes.length === 1;

  el.append(tools, num, proc);
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    window.planner.select(win.id, id);
  });

  // Panes swap only within their own window: the drag type carries the window id.
  const type = `text/x-pane-${win.id}`;
  dragSource(el, type, id);
  dropTarget(el, type, (from) => {
    if (from && from !== id) window.planner.swap(win.id, from, id);
  });
  return el;
}

function windowTile(id, number) {
  const win = windows.get(id);
  const el = document.createElement('div');
  el.className = 'window';
  if (!win) return el; // a window the tiling still names while it closes
  el.classList.toggle('focused', win.focused);

  const head = document.createElement('div');
  head.className = 'window-head';
  const name = document.createElement('span');
  name.className = 'name';
  const active = win.panes.find((p) => p.id === win.active);
  name.textContent = `Window ${number}${active ? ` · ${active.process}` : ''}`;
  const tools = document.createElement('span');
  tools.className = 'tools';
  button(tools, '◫', 'Add a window to the right', () => window.planner.tileSplit(id, 'row'));
  button(tools, '⊟', 'Add a window below', () => window.planner.tileSplit(id, 'col'));
  button(tools, '✕', 'Close this window and its shells', () => window.planner.tileClose(id), 'close').disabled = windows.size === 1;
  head.append(name, tools);
  head.title = 'Drag onto another window to swap them';
  dragSource(head, 'text/x-window', id);

  const body = document.createElement('div');
  body.className = 'window-body';
  const panes = build(win.layout, [], (paneId) => paneBox(win, paneId), (path, sizes) => window.planner.resize(id, path, sizes));
  panes.style.flex = '1 1 0';
  body.appendChild(panes);

  el.append(head, body);
  dropTarget(el, 'text/x-window', (from) => {
    if (from && from !== id) window.planner.tileSwap(from, id);
  });
  return el;
}

function flush() {
  const next = pending;
  pending = null;
  render(next);
}

// Redrawing mid-drag would remove the element being dragged, so a state that
// arrives during a drag waits for it to end.
function render(next) {
  if (!next) return;
  if (drag || dragging) {
    pending = next;
    return;
  }
  state = next;
  windows = new Map(state.windows.map((w) => [w.id, w]));
  if (!state.tiling) {
    stage.replaceChildren();
    return;
  }
  const order = leaves(state.tiling);
  const tree = build(state.tiling, [], (id) => windowTile(id, order.indexOf(id) + 1), (path, sizes) => window.planner.tileResize(path, sizes));
  tree.style.flex = '1 1 0';
  stage.replaceChildren(tree);
  fitStage();
}

window.addEventListener('resize', fitStage);
window.planner.onState(render);
window.planner.getState().then(render);
