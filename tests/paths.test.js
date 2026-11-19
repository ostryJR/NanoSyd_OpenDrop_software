'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { getLayout } = require('../js/layout.js');
const { electrodeGraph, shortestRoute, rightAngleRoute, straightRoute, PathDraft } = require('../js/paths.js');

const standard = electrodeGraph(getLayout('electrodes').rects);
const E = (column, row) => column * 8 + row;
const neighbours = (e) => standard.neighbours.get(e);

test('main grid: neighbours are above, below, left and right, never diagonal', () => {
  for (let c = 1; c <= 14; c++) {
    for (let r = 0; r < 8; r++) {
      const expected = [];
      if (c > 1) expected.push(E(c - 1, r));
      if (r > 0) expected.push(E(c, r - 1));
      if (r < 7) expected.push(E(c, r + 1));
      if (c < 14) expected.push(E(c + 1, r));
      const inGrid = neighbours(E(c, r)).filter((e) => e >= 8 && e < 120);
      assert.deepEqual(inGrid, expected.sort((a, b) => a - b), `electrode ${E(c, r)}`);
    }
  }
});

test('the reservoirs join the grid only where their dispense sequences cross over', () => {
  const reservoirSide = (e) => neighbours(e).filter((v) => v < 8 || v >= 120);
  const links = { 9: [0], 14: [7], 113: [120], 118: [127] };
  for (const e of [8, 9, 10, 11, 12, 13, 14, 15, 112, 113, 114, 115, 116, 117, 118, 119]) {
    assert.deepEqual(reservoirSide(e), links[e] || [], `electrode ${e}`);
  }
  assert.deepEqual(neighbours(0), [1, 2, 9]);
  assert.deepEqual(neighbours(3), [1, 2]);
  assert.deepEqual(neighbours(120), [113, 121, 122]);
  assert.deepEqual(neighbours(123), [121, 122]);
});

test('standard layout: every electrode can be reached from every other', () => {
  for (let e = 0; e < 128; e++) assert.ok(shortestRoute(standard, 9, e), `electrode ${e}`);
});

test('magnets are not on any droplet route', () => {
  const magnet = electrodeGraph(getLayout('electrodes_magnet').rects);
  assert.deepEqual(magnet.neighbours.get(128), []);
  assert.deepEqual(magnet.neighbours.get(129), []);
  assert.equal(shortestRoute(magnet, 9, 128), null);
});

test('shortest routes step between neighbours', () => {
  assert.deepEqual(shortestRoute(standard, 9, 9), [9]);
  assert.equal(shortestRoute(standard, E(1, 0), E(3, 2)).length - 1, 4);
  const across = shortestRoute(standard, 3, 123); // reservoir to reservoir, through both bridges
  assert.equal(across.length - 1, 19);
  for (const bridge of [0, 9, 113, 120]) assert.ok(across.includes(bridge), `passes ${bridge}`);
});

test('right-angle routes: one line, or two at a right angle, starting along the given axis', () => {
  assert.deepEqual(rightAngleRoute(standard, E(1, 0), E(3, 2), 'h'), [E(1, 0), E(2, 0), E(3, 0), E(3, 1), E(3, 2)]);
  assert.deepEqual(rightAngleRoute(standard, E(1, 0), E(3, 2), 'v'), [E(1, 0), E(1, 1), E(1, 2), E(2, 2), E(3, 2)]);
  const row = rightAngleRoute(standard, E(2, 5), E(9, 5), 'v'); // same row: a single line either way
  assert.deepEqual(row, [2, 3, 4, 5, 6, 7, 8, 9].map((c) => E(c, 5)));
});

test('straight routes turn the other way when a corner electrode is missing', () => {
  // A 3 x 3 block of electrodes with the top-right one missing.
  const rects = [];
  for (let c = 0; c < 3; c++) {
    for (let r = 0; r < 3; r++) if (!(c === 2 && r === 0)) rects.push({ x: 2 * c, y: 2 * r, h: 2, v: 2, e: E(c, r) });
  }
  const g = electrodeGraph(rects);
  assert.equal(rightAngleRoute(g, E(0, 0), E(2, 2), 'h'), null);
  assert.deepEqual(straightRoute(g, E(0, 0), E(2, 2), 'h'), [E(0, 0), E(0, 1), E(0, 2), E(1, 2), E(2, 2)]);
});

test('freehand drafts ignore electrodes a droplet cannot get to', () => {
  const rects = getLayout('electrodes_magnet').rects;
  const draft = new PathDraft(rects, 9, 1, { mx: -13, my: -5 });
  draft.moveTo(-5, 10); // ends on magnet 128
  assert.ok(draft.steps > 0);
  assert.ok(!draft.cells.includes(128));
});
