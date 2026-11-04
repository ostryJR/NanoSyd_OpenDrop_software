'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { getLayout, LAYOUTS } = require('../js/layout.js');
const { shortestRoute } = require('../js/paths.js');
const L = require('../js/lines.js');

const ctx = L.context(getLayout('electrodes').rects);
const g = ctx.graph;
const E = (column, row) => column * 8 + row;
const P = (...cr) => cr.map(([c, r]) => ({ e: E(c, r) }));
const D = (dc, dr) => ({ dx: 2 * dc, dy: 2 * dr }); // whole electrodes on the standard grid
const es = (points) => points.map((p) => p.e);

// Small seeded random generator so failures can be reproduced.
function random(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('a straight piece runs along one row or column, between neighbours', () => {
  assert.deepEqual(L.lineRoute(g, E(1, 0), E(5, 0)), [E(1, 0), E(2, 0), E(3, 0), E(4, 0), E(5, 0)]);
  assert.deepEqual(L.lineRoute(g, E(5, 6), E(5, 2)), [E(5, 6), E(5, 5), E(5, 4), E(5, 3), E(5, 2)]);
  assert.equal(L.lineRoute(g, E(1, 0), E(5, 4)), null, 'not in line');
  assert.equal(L.lineRoute(g, E(1, 0), 200), null, 'not an electrode');
  assert.deepEqual(L.lineRoute(g, 9, 9), [9]);
});

test('a line is built from its points; a piece that isn’t straight makes it unusable', () => {
  const built = L.build(g, P([1, 0], [5, 0], [5, 4]));
  assert.deepEqual(built.cells, [E(1, 0), E(2, 0), E(3, 0), E(4, 0), E(5, 0), E(5, 1), E(5, 2), E(5, 3), E(5, 4)]);
  assert.deepEqual(built.steps, [0, 4, 8]);
  assert.equal(built.error, null);
  const bad = L.build(g, P([1, 0], [5, 4]));
  assert.equal(bad.cells, null);
  assert.equal(bad.bad, 0);
  assert.match(bad.error, /isn't a straight line/);
  assert.match(L.build(g, [{ e: 300 }]).error, /isn't on this layout/);
  assert.match(L.build(g, []).error, /no points/);
});

test('a drawn route becomes its ends and corners, and always gives the same route back', () => {
  assert.deepEqual(es(L.pointsFromRoute(g, [8, 16, 24, 25, 26, 27, 35, 43])), [8, 24, 27, 43]);
  const loop = [8, 16, 17, 9, 8];
  assert.deepEqual(es(L.pointsFromRoute(g, loop)), loop);
  const uTurn = [8, 16, 24, 16, 8];
  assert.deepEqual(es(L.pointsFromRoute(g, uTurn)), [8, 24, 8]);
  assert.deepEqual(L.build(g, L.pointsFromRoute(g, uTurn)).cells, uTurn);
  // Through both reservoir bridges, which aren't on a row or column.
  const across = shortestRoute(g, 3, 123);
  assert.deepEqual(L.build(g, L.pointsFromRoute(g, across)).cells, across);
});

test('random freehand routes come back exactly, on every layout', () => {
  const rand = random(11);
  for (const lay of LAYOUTS) {
    const graph = L.context(lay.rects).graph;
    const ids = [...graph.neighbours.keys()].filter((e) => graph.neighbours.get(e).length);
    for (let n = 0; n < 40; n++) {
      const route = [ids[Math.floor(rand() * ids.length)]];
      for (let i = 0; i < 25; i++) {
        const next = graph.neighbours.get(route[route.length - 1]);
        const e = next[Math.floor(rand() * next.length)];
        if (e !== route[route.length - 2]) route.push(e); // drawing back over a step takes it back
      }
      const points = L.pointsFromRoute(graph, route);
      assert.deepEqual(L.build(graph, points).cells, route, `${lay.id}: ${route.join(',')}`);
    }
  }
});

test('points to keep (such as waits) stay, with their fields', () => {
  const points = L.pointsFromRoute(g, [8, 16, 24, 32, 40], new Map([[2, { wait: 3000 }]]));
  assert.deepEqual(points, [{ e: 8 }, { e: 24, wait: 3000 }, { e: 40 }]);
});

test('dragging a piece sideways: a right-angle neighbour stretches, at an end a connecting piece is added', () => {
  assert.deepEqual(es(L.dragPiece(ctx, P([1, 0], [5, 0], [5, 4]), 0, D(0, 2))), es(P([1, 0], [1, 2], [5, 2], [5, 4])));
  assert.deepEqual(es(L.dragPiece(ctx, P([1, 0], [5, 0], [5, 4]), 1, D(2, 0))), es(P([1, 0], [7, 0], [7, 4], [5, 4])));
  // Moving along the piece does nothing.
  assert.deepEqual(es(L.dragPiece(ctx, P([1, 0], [5, 0], [5, 4]), 0, D(3, 0))), es(P([1, 0], [5, 0], [5, 4])));
  // A detour: points on a straight line, and the piece between them pulled down.
  const detour = L.dragPiece(ctx, P([1, 0], [4, 0], [6, 0], [9, 0]), 1, D(0, 2));
  assert.deepEqual(es(detour), es(P([1, 0], [4, 0], [4, 2], [6, 2], [6, 0], [9, 0])));
});

test('dragging the start or end: longer, shorter, or round a new corner', () => {
  assert.deepEqual(es(L.dragEnd(ctx, P([1, 0], [5, 0]), 'end', D(0, 2))), es(P([1, 0], [5, 0], [5, 2])));
  assert.deepEqual(es(L.dragEnd(ctx, P([1, 0], [5, 0]), 'end', D(2, 0))), es(P([1, 0], [7, 0])));
  assert.deepEqual(es(L.dragEnd(ctx, P([1, 0], [5, 0]), 'start', D(0, 2))), es(P([1, 2], [1, 0], [5, 0])));
  assert.deepEqual(es(L.dragEnd(ctx, P([1, 0], [5, 0], [5, 4]), 'start', D(0, 2))), es(P([1, 2], [5, 2], [5, 4])));
  assert.deepEqual(es(L.dragEnd(ctx, P([1, 0], [5, 0], [5, 4]), 'end', D(2, 2))), es(P([1, 0], [7, 0], [7, 6])));
  // Back onto the corner before it: the last piece goes.
  assert.deepEqual(es(L.dragEnd(ctx, P([1, 0], [5, 0], [5, 4]), 'end', D(0, -4))), es(P([1, 0], [5, 0])));
});

test('dragging a corner moves both its pieces; a point on a straight run slides along it', () => {
  assert.deepEqual(es(L.dragPoint(ctx, P([1, 0], [5, 0], [5, 4]), 1, D(2, 2))), es(P([1, 0], [1, 2], [7, 2], [7, 4], [5, 4])));
  assert.deepEqual(es(L.dragPoint(ctx, P([1, 0], [5, 0], [5, 4], [9, 4]), 1, D(1, 1))), es(P([1, 0], [1, 1], [6, 1], [6, 4], [9, 4])));
  const run = [{ e: E(1, 0) }, { e: E(3, 0), wait: 2000 }, { e: E(6, 0) }];
  assert.deepEqual(L.dragPoint(ctx, run, 1, D(1, 3)), [{ e: E(1, 0) }, { e: E(4, 0), wait: 2000 }, { e: E(6, 0) }]);
});

test('tidy-up: zero-length pieces and points on straight runs go, waits and turning points stay', () => {
  assert.deepEqual(es(L.tidy(g, P([1, 0], [3, 0], [3, 0], [5, 0], [5, 2]))), es(P([1, 0], [5, 0], [5, 2])));
  assert.deepEqual(L.tidy(g, [{ e: E(1, 0) }, { e: E(3, 0), wait: 2000 }, { e: E(5, 0) }]), [{ e: E(1, 0) }, { e: E(3, 0), wait: 2000 }, { e: E(5, 0) }]);
  assert.deepEqual(L.tidy(g, [{ e: E(1, 0) }, { e: E(3, 0) }, { e: E(3, 0), wait: 900 }, { e: E(5, 0) }]), [{ e: E(1, 0) }, { e: E(3, 0), wait: 900 }, { e: E(5, 0) }]);
  assert.deepEqual(es(L.tidy(g, P([1, 0], [5, 0], [2, 0]))), es(P([1, 0], [5, 0], [2, 0])), 'turning back');
  assert.deepEqual(L.tidy(g, [{ e: E(1, 0) }, { e: E(3, 0), measure: 'x' }, { e: E(5, 0) }])[1], { e: E(3, 0), measure: 'x' }, 'unknown fields stay');
});

test('a wait moves only when its own point moves', () => {
  const pts = [{ e: E(1, 0) }, { e: E(3, 0), wait: 5000 }, { e: E(5, 0) }, { e: E(5, 4) }];
  const reshaped = L.dragPiece(ctx, pts, 2, D(2, 0)); // the vertical piece after it
  assert.deepEqual(reshaped.find((p) => p.wait), { e: E(3, 0), wait: 5000 });
  const moved = L.dragPiece(ctx, pts, 1, D(0, 1)); // the piece it starts
  assert.deepEqual(moved.find((p) => p.wait), { e: E(3, 0), wait: 5000 }, 'the run before it is straight: it stays, joined by a short piece');
});

test('off the layout, an edit gives null; a line moves as a whole', () => {
  assert.equal(L.dragPiece(ctx, P([1, 0], [5, 0]), 0, D(0, -1)), null);
  assert.equal(L.moveLine(ctx, P([1, 0], [5, 0]), D(-8, 0)), null);
  // Three columns left lands on a reservoir electrode: the points exist, but the line can't be built.
  const onReservoir = L.moveLine(ctx, P([1, 0], [5, 0]), D(-3, 0));
  assert.ok(onReservoir);
  assert.match(L.build(g, onReservoir).error, /isn't a straight line/);
  assert.deepEqual(es(L.moveLine(ctx, P([1, 0], [5, 0], [5, 4]), D(2, 1))), es(P([3, 1], [7, 1], [7, 5])));
});

test('adding and removing points, waits on a step, and what part of a line an electrode is', () => {
  const pts = P([1, 0], [5, 0], [5, 4]);
  const built = L.build(g, pts);
  assert.deepEqual(es(L.addPointAt(pts, built, 2)), es(P([1, 0], [3, 0], [5, 0], [5, 4])));
  assert.deepEqual(L.addPointAt(pts, built, 4, { wait: 700 })[1], { e: E(5, 0), wait: 700 });
  assert.equal(L.removePoint(g, pts, 1), null, 'without the corner the line would not be straight');
  assert.deepEqual(es(L.removePoint(g, P([1, 0], [3, 0], [5, 0]), 1)), es(P([1, 0], [5, 0])));
  assert.equal(L.removePoint(g, pts, 0), null, 'the ends stay');
  const waited = [{ e: E(1, 0) }, { e: E(3, 0), wait: 700 }, { e: E(5, 0) }];
  assert.deepEqual(L.clearWaitAt(g, waited, L.build(g, waited), 2), P([1, 0], [5, 0]));
  assert.deepEqual(L.partAt(built, pts, E(1, 0)), { kind: 'start', index: 0, step: 0 });
  assert.deepEqual(L.partAt(built, pts, E(5, 0)), { kind: 'point', index: 1, step: 4 });
  assert.deepEqual(L.partAt(built, pts, E(5, 2)), { kind: 'piece', index: 1, step: 6 });
  assert.deepEqual(L.partAt(built, pts, E(5, 4)), { kind: 'end', index: 2, step: 8 });
  assert.equal(L.partAt(built, pts, E(9, 6)), null);
  // A line passing an electrode twice: the visit nearest the given step counts.
  const back = P([1, 0], [5, 0], [1, 0]);
  const builtBack = L.build(g, back);
  assert.equal(L.partAt(builtBack, back, E(2, 0), 0).step, 1);
  assert.equal(L.partAt(builtBack, back, E(2, 0), 8).step, 7);
});

test('irregular layouts: straight means straight on screen, whatever the numbers', () => {
  const crea = L.context(getLayout('electrodes_crea').rects).graph;
  let checked = 0;
  for (const [a, list] of crea.neighbours) {
    for (const b of list) {
      assert.deepEqual(L.lineRoute(crea, a, b), [a, b], `${a} -> ${b}`);
      checked++;
    }
  }
  assert.ok(checked > 100);
});
