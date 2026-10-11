// Pane layout tree for one capture window.
//   pane:  { type: 'pane', id }
//   split: { type: 'split', dir: 'row' | 'col', sizes: [fractions], children: [...] }
// 'row' puts children side by side, 'col' stacks them. Pane order is the depth-first
// order of the leaves. A split is addressed by its path: child indices from the root.

const MIN_SIZE = 0.05;

function pane(id) {
  return { type: 'pane', id };
}

function leaves(node) {
  return node.type === 'pane' ? [node.id] : node.children.flatMap(leaves);
}

// Returns the new tree; trees are never mutated so callers can compare and send them.
function map(node, fn) {
  const next = fn(node);
  if (next !== node || node.type === 'pane') return next;
  const children = node.children.map((c) => map(c, fn));
  return children.every((c, i) => c === node.children[i]) ? node : { ...node, children };
}

// Scales sizes to sum to 1 with every share at least MIN_SIZE. Idempotent, so a
// saved layout comes back exactly as it was.
function normalize(sizes) {
  let out = sizes.map((s) => (Number.isFinite(s) && s > 0 ? s : 0));
  const pinned = new Set();
  for (;;) {
    const free = out.reduce((a, s, i) => (pinned.has(i) ? a : a + s), 0);
    const room = 1 - MIN_SIZE * pinned.size;
    out = out.map((s, i) => (pinned.has(i) ? MIN_SIZE : free > 0 ? (s * room) / free : room / (out.length - pinned.size)));
    const low = out.findIndex((s, i) => !pinned.has(i) && s < MIN_SIZE);
    if (low < 0) return out;
    pinned.add(low);
  }
}

function splitPane(tree, paneId, dir, newId) {
  if (dir !== 'row' && dir !== 'col') throw new Error('dir must be row or col');
  // Same direction as the parent split: add a sibling instead of nesting another split.
  const parentDone = map(tree, (node) => {
    if (node.type !== 'split' || node.dir !== dir) return node;
    const i = node.children.findIndex((c) => c.type === 'pane' && c.id === paneId);
    if (i < 0) return node;
    const half = node.sizes[i] / 2;
    return {
      ...node,
      children: [...node.children.slice(0, i + 1), pane(newId), ...node.children.slice(i + 1)],
      sizes: [...node.sizes.slice(0, i), half, half, ...node.sizes.slice(i + 1)],
    };
  });
  if (parentDone !== tree) return parentDone;
  return map(tree, (node) =>
    node.type === 'pane' && node.id === paneId
      ? { type: 'split', dir, sizes: [0.5, 0.5], children: [node, pane(newId)] }
      : node,
  );
}

function removePane(tree, paneId) {
  if (tree.type === 'pane') return tree.id === paneId ? null : tree;
  const kept = [];
  const sizes = [];
  let freed = null;
  tree.children.forEach((child, i) => {
    const next = removePane(child, paneId);
    if (next) {
      kept.push(next);
      sizes.push(tree.sizes[i]);
    } else {
      freed = { at: kept.length, size: tree.sizes[i] };
    }
  });
  if (kept.length === 0) return null;
  // The pane's space goes to the neighbor that takes its place (see heir()).
  if (freed) sizes[freed.at > 0 ? freed.at - 1 : 0] += freed.size;
  if (kept.length === 1) return kept[0];
  // A nested split in the same direction folds into its parent.
  const children = [];
  const flatSizes = [];
  kept.forEach((child, i) => {
    if (child.type === 'split' && child.dir === tree.dir) {
      child.children.forEach((c, j) => {
        children.push(c);
        flatSizes.push(sizes[i] * child.sizes[j]);
      });
    } else {
      children.push(child);
      flatSizes.push(sizes[i]);
    }
  });
  return { ...tree, children, sizes: normalize(flatSizes) };
}

// The pane that takes over paneId's space when it is removed: the nearest pane of
// the sibling before it, or of the sibling after it when it is the first child.
function heir(tree, paneId) {
  if (tree.type === 'pane') return null;
  const i = tree.children.findIndex((c) => c.type === 'pane' && c.id === paneId);
  if (i >= 0) {
    if (i > 0) return leaves(tree.children[i - 1]).at(-1);
    return leaves(tree.children[1])[0];
  }
  for (const child of tree.children) {
    const found = heir(child, paneId);
    if (found) return found;
  }
  return null;
}

function swapPanes(tree, a, b) {
  if (a === b) return tree;
  const ids = leaves(tree);
  if (!ids.includes(a) || !ids.includes(b)) throw new Error('no such pane');
  return map(tree, (node) => {
    if (node.type !== 'pane') return node;
    if (node.id === a) return pane(b);
    if (node.id === b) return pane(a);
    return node;
  });
}

function setSizes(tree, path, sizes) {
  if (!Array.isArray(path) || !Array.isArray(sizes)) throw new Error('path and sizes must be arrays');
  const update = (node, depth) => {
    if (node.type !== 'split') throw new Error('path does not name a split');
    if (depth === path.length) {
      if (sizes.length !== node.children.length) throw new Error('sizes must match the split');
      return { ...node, sizes: normalize(sizes.map(Number)) };
    }
    const i = path[depth];
    if (!Number.isInteger(i) || !node.children[i]) throw new Error('path does not name a split');
    const children = node.children.slice();
    children[i] = update(children[i], depth + 1);
    return { ...node, children };
  };
  return update(tree, 0);
}

// The tree without leaf ids, for saving. A pane tree's leaves save as 'pane'; the
// window tiling passes leafShape to save each window's own pane shape in its leaf.
function shape(node, leafShape = () => 'pane') {
  if (node.type === 'pane') return leafShape(node.id);
  return { dir: node.dir, sizes: node.sizes, children: node.children.map((c) => shape(c, leafShape)) };
}

// Builds a tree from a saved shape; makeLeaf(leafShape) creates a leaf and returns its id.
// Anything malformed falls back to a single leaf.
function hydrate(saved, makeLeaf, isLeaf = (s) => s === 'pane') {
  const valid = (s) =>
    isLeaf(s) ||
    (s && (s.dir === 'row' || s.dir === 'col') && Array.isArray(s.children) && s.children.length >= 2 &&
      Array.isArray(s.sizes) && s.sizes.length === s.children.length && s.children.every(valid));
  if (!valid(saved)) return pane(makeLeaf(undefined));
  const build = (s) =>
    isLeaf(s)
      ? pane(makeLeaf(s))
      : { type: 'split', dir: s.dir, sizes: normalize(s.sizes.map(Number)), children: s.children.map(build) };
  return build(saved);
}

// Integer rectangles for every leaf inside area. Edges are rounded from the running
// total, so neighbors share an edge and the leaves cover area exactly.
function rects(tree, area, out = new Map()) {
  if (tree.type === 'pane') {
    out.set(tree.id, { x: area.x, y: area.y, width: area.width, height: area.height });
    return out;
  }
  const row = tree.dir === 'row';
  const start = row ? area.x : area.y;
  const length = row ? area.width : area.height;
  let edge = start;
  let total = 0;
  tree.children.forEach((child, i) => {
    total += tree.sizes[i];
    const next = i === tree.children.length - 1 ? start + length : start + Math.round(length * total);
    const sub = row
      ? { x: edge, y: area.y, width: next - edge, height: area.height }
      : { x: area.x, y: edge, width: area.width, height: next - edge };
    rects(child, sub, out);
    edge = next;
  });
  return out;
}

module.exports = { pane, leaves, splitPane, removePane, heir, swapPanes, setSizes, shape, hydrate, rects };
