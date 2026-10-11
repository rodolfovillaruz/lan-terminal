// Checks the pane layout tree helpers: node scripts/layout-test.js
const assert = require('assert');
const L = require('../src/main/layout');

let t = L.pane('a');
t = L.splitPane(t, 'a', 'row', 'b');
assert.deepStrictEqual(L.leaves(t), ['a', 'b']);
assert.strictEqual(t.dir, 'row');

// Same direction adds a sibling.
t = L.splitPane(t, 'b', 'row', 'c');
assert.strictEqual(t.children.length, 3);
assert.deepStrictEqual(t.sizes, [0.5, 0.25, 0.25]);

// Other direction nests a split.
t = L.splitPane(t, 'a', 'col', 'd');
assert.deepStrictEqual(L.leaves(t), ['a', 'd', 'b', 'c']);
assert.strictEqual(t.children[0].dir, 'col');

// Swap reorders.
t = L.swapPanes(t, 'a', 'c');
assert.deepStrictEqual(L.leaves(t), ['c', 'd', 'b', 'a']);

// Removing collapses a one-child split.
t = L.removePane(t, 'd');
assert.deepStrictEqual(L.leaves(t), ['c', 'b', 'a']);
assert.strictEqual(t.children[0].type, 'pane');
assert.ok(Math.abs(t.sizes.reduce((x, y) => x + y) - 1) < 1e-9);

// A nested split in the same direction folds into its parent after a removal.
let f = L.splitPane(L.pane('x'), 'x', 'row', 'y');
f = L.splitPane(f, 'y', 'col', 'z');
f = L.splitPane(f, 'z', 'row', 'w');
f = L.removePane(f, 'y');
assert.strictEqual(f.dir, 'row');
assert.deepStrictEqual(L.leaves(f), ['x', 'z', 'w']);

// The neighbor before a removed pane (or after, for the first) takes its place and space.
let r = L.splitPane(L.pane('a'), 'a', 'row', 'b');
r = L.splitPane(r, 'b', 'row', 'c');
r = L.splitPane(r, 'b', 'col', 'd'); // row: [a, col[b, d], c]
assert.strictEqual(L.heir(r, 'c'), 'd');
assert.strictEqual(L.heir(r, 'a'), 'b');
assert.strictEqual(L.heir(r, 'd'), 'b');
const rc = L.removePane(r, 'c');
assert.deepStrictEqual(rc.sizes, [0.5, 0.5]);
assert.strictEqual(L.heir(L.pane('a'), 'a'), null);

// Sizes are clamped and normalized.
t = L.setSizes(t, [], [0, 1, 1]);
assert.ok(t.sizes[0] > 0 && Math.abs(t.sizes.reduce((x, y) => x + y) - 1) < 1e-9);
assert.throws(() => L.setSizes(t, [0], [0.5, 0.5]));

// Shape round trip.
let n = 0;
const h = L.hydrate(JSON.parse(JSON.stringify(L.shape(t))), () => `p${n++}`);
assert.deepStrictEqual(L.shape(h), L.shape(t));
assert.deepStrictEqual(L.leaves(h), ['p0', 'p1', 'p2']);
assert.deepStrictEqual(L.hydrate({ bogus: 1 }, () => 'q'), L.pane('q'));
assert.strictEqual(L.removePane(L.pane('a'), 'a'), null);

// Inserting before a pane, and replacing a pane in place.
let b = L.splitPane(L.pane('a'), 'a', 'row', 'b', true);
assert.deepStrictEqual(L.leaves(b), ['b', 'a']);
b = L.splitPane(b, 'a', 'row', 'c', true);
assert.deepStrictEqual(L.leaves(b), ['b', 'c', 'a']);
b = L.splitPane(b, 'c', 'col', 'd', true);
assert.deepStrictEqual(L.leaves(b), ['b', 'd', 'c', 'a']);
assert.deepStrictEqual(L.leaves(L.replacePane(b, 'd', 'x')), ['b', 'x', 'c', 'a']);

console.log('layout ok');
