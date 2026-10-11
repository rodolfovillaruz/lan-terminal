// Draws a capture window's split tree as a miniature and sends edits to the main
// process. The tree is never changed here: main applies each edit and sends it back.

const stage = document.getElementById('stage');
let state = null;
let drag = null; // gutter drag in progress: incoming states wait until it ends
let pending = null;

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

function paneBox(id) {
  const order = state.panes.findIndex((p) => p.id === id);
  const info = state.panes[order];
  const el = document.createElement('div');
  el.className = 'pane';
  el.classList.toggle('active', id === state.active);
  el.draggable = true;

  const num = document.createElement('div');
  num.className = 'num';
  num.textContent = order + 1;
  const proc = document.createElement('div');
  proc.className = 'proc';
  proc.textContent = info.title && info.title !== info.process ? `${info.process} — ${info.title}` : info.process;
  el.title = proc.textContent;

  const tools = document.createElement('div');
  tools.className = 'tools';
  const button = (label, title, onClick, cls = '') => {
    const b = document.createElement('button');
    b.textContent = label;
    b.title = title;
    b.className = cls;
    b.draggable = false;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      onClick();
    });
    tools.appendChild(b);
    return b;
  };
  button('◫', 'Split right', () => window.planner.split(id, 'row'));
  button('⊟', 'Split down', () => window.planner.split(id, 'col'));
  button('✕', 'Close pane', () => window.planner.close(id), 'close').disabled = state.panes.length === 1;

  el.append(tools, num, proc);
  el.addEventListener('click', () => window.planner.select(id));

  // Drop one pane on another to swap their places.
  el.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/x-pane', id);
    e.dataTransfer.effectAllowed = 'move';
    el.classList.add('dragging');
  });
  el.addEventListener('dragend', () => el.classList.remove('dragging'));
  el.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes('text/x-pane')) return;
    e.preventDefault();
    el.classList.add('drop');
  });
  el.addEventListener('dragleave', () => el.classList.remove('drop'));
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    el.classList.remove('drop');
    const from = e.dataTransfer.getData('text/x-pane');
    if (from && from !== id) window.planner.swap(from, id);
  });
  return el;
}

function gutter(box, node, path, i) {
  const g = document.createElement('div');
  g.className = 'gutter';
  g.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
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
    // One update per frame keeps the capture window live without flooding IPC.
    cancelAnimationFrame(drag.frame);
    drag.frame = requestAnimationFrame(() => window.planner.resize(path, sizes));
  });
  const end = () => {
    if (!drag || drag.g !== g) return;
    g.classList.remove('dragging');
    drag = null;
    if (pending) render(pending);
    pending = null;
  };
  g.addEventListener('pointerup', end);
  g.addEventListener('pointercancel', end);
  g.addEventListener('lostpointercapture', end);
  return g;
}

function build(node, path) {
  if (node.type === 'pane') return paneBox(node.id);
  const box = document.createElement('div');
  box.className = `split ${node.dir}`;
  node.children.forEach((child, i) => {
    if (i > 0) box.appendChild(gutter(box, node, path, i - 1));
    const el = build(child, [...path, i]);
    el.style.flex = `${node.sizes[i]} 1 0`;
    box.appendChild(el);
  });
  return box;
}

function render(next) {
  if (!next) return;
  if (drag) {
    pending = next;
    return;
  }
  state = next;
  const tree = build(state.layout, []);
  tree.style.flex = '1 1 0';
  stage.replaceChildren(tree);
  fitStage();
}

window.addEventListener('resize', fitStage);
window.planner.onState(render);
window.planner.getState().then(render);
