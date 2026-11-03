'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { LAYOUTS, getLayout, hitTest, inArray } = require('../js/layout.js');

test('all 12 layouts from the repository are available, standard first', () => {
  assert.equal(LAYOUTS.length, 12);
  assert.deepEqual(LAYOUTS.slice(0, 2).map((l) => l.id), ['electrodes', 'electrodes_magnet']);
  for (const l of LAYOUTS) assert.ok(l.rects.length > 0, l.id);
  assert.equal(getLayout('no-such-layout').id, 'electrodes');
});

test('standard layout: 148 rectangles covering electrodes 0..127', () => {
  const { rects } = getLayout('electrodes');
  assert.equal(rects.length, 148);
  const ids = [...new Set(rects.map((r) => r.e))].sort((a, b) => a - b);
  assert.deepEqual(ids, Array.from({ length: 128 }, (_, i) => i));
});

test('magnet layout adds the magnet electrodes 128 and 129', () => {
  const ids = new Set(getLayout('electrodes_magnet').rects.map((r) => r.e));
  assert.equal(ids.size, 130);
  assert.ok(ids.has(128) && ids.has(129));
});

test('hit-testing finds the electrode under a point like the original', () => {
  const { rects } = getLayout('electrodes');
  // Main grid: column c (1..14) starts at x = -16 + 2c, row r at y = -8 + 2r; electrode c*8 + r.
  for (let c = 1; c <= 14; c++) {
    for (let r = 0; r < 8; r++) assert.deepEqual(hitTest(rects, -15 + 2 * c, -7 + 2 * r), [c * 8 + r]);
  }
  assert.deepEqual(hitTest(rects, -14, -8), [8], 'top-left corner belongs to the electrode');
  assert.deepEqual(hitTest(rects, -12, -8), [16], 'a shared edge belongs to the right-hand electrode');
  assert.deepEqual(hitTest(rects, -20, -7), [3], 'upper-left reservoir');
  assert.deepEqual(hitTest(rects, 20, 6.5), [124], 'lower-right reservoir');
  assert.deepEqual(hitTest(rects, -15, -2), [], 'gap next to the grid');
  assert.deepEqual(hitTest(rects, 0, 10), [], 'below the array');
});

test('rectangles of the standard layout never overlap', () => {
  const { rects } = getLayout('electrodes');
  for (let x = -21.75; x < 21; x += 0.5) {
    for (let y = -8.75; y < 8; y += 0.5) assert.ok(hitTest(rects, x, y).length <= 1, `${x},${y}`);
  }
});

test('electrodes only react inside the original array box', () => {
  assert.ok(inArray(23.9, 11.9));
  assert.ok(!inArray(24, 0));
  assert.ok(!inArray(0, -12));
});
