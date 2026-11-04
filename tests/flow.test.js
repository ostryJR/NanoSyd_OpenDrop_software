'use strict';
// Which way droplets go: counter-clockwise mixers, the moves drawn for templates, and what comes
// along when the start or end of a path is dragged.
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../js/templates.js');
const { Editor } = require('../js/editor.js');
const { getLayout } = require('../js/layout.js');
const { electrodeGraph } = require('../js/paths.js');

const rects = getLayout('electrodes').rects;
const graph = electrodeGraph(rects);
const E = (column, row) => column * 8 + row;
const at = (e) => [graph.centres.get(e).x, graph.centres.get(e).y];
const builtIn = (id) => T.BUILT_IN.find((t) => t.id === id);
const pointsOf = (a) => a.points.map((p) => p.e);

function drag(ed, ...cells) {
  ed.pointerDown(...at(cells[0]));
  for (const e of cells.slice(1)) ed.pointerMove(...at(e));
  return ed.pointerUp();
}

// Dispense from the upper-left reservoir, a path to (3,3), a 2 x 2 circle mix there, and a path
// on to (8,3): all linked, one droplet.
function chain() {
  const ed = new Editor(getLayout('electrodes'));
  ed.pointerDown(-29, -5);
  ed.pointerUp();
  drag(ed, 9, E(3, 1), E(3, 3));
  ed.startPlacement(builtIn('circle-2x2'));
  ed.hoverPlacement(...at(E(3, 3)));
  ed.dropPlacement();
  drag(ed, E(3, 3), E(8, 3));
  ed.setTool('select');
  return ed;
}
const named = (ed, name) => ed.project.actions.find((a) => a.name === name);
const spanOf = (ed, name) => {
  const s = ed.span(named(ed, name).id);
  return [s.from, s.to];
};
const MIX = 'Circle mix 2×2, 3 rounds';

test('a circle mix can go round counter-clockwise: down first, from and back to the same electrode', () => {
  const ccw = T.fromParams({ kind: 'circle', size: 2, rounds: 3, dir: 'ccw' });
  assert.deepEqual(ccw.frames.slice(0, 5), [[[0, 0]], [[0, 1]], [[1, 1]], [[1, 0]], [[0, 0]]]);
  assert.deepEqual(ccw.frames.at(-1), [[0, 0]]);
  assert.equal(ccw.id, 'circle-2x2-r3-ccw');
  assert.equal(ccw.name, 'Circle mix 2×2 counter-clockwise, 3 rounds');
  assert.equal(T.stepsOf(ccw), T.stepsOf(builtIn('circle-2x2')));
  const big = T.fromParams({ kind: 'circle', size: 3, rounds: 1, dir: 'ccw' });
  assert.deepEqual(big.frames.map(([[c, r]]) => `${c}${r}`).join(' '), '00 01 02 12 22 21 20 10 00');
  // Clockwise is the default, and is left out of the parameters (files stay as they were).
  assert.deepEqual(T.cleanParams({ kind: 'circle', size: 2, rounds: 3, dir: 'cw' }), { kind: 'circle', size: 2, rounds: 3 });
  assert.deepEqual(T.cleanParams({ kind: 'circle', dir: 'sideways' }), { kind: 'circle', size: 2, rounds: 3 });
  assert.equal(T.fromParams({ kind: 'circle', size: 2, rounds: 3, dir: 'cw' }).id, 'circle-2x2');
  assert.deepEqual(T.cleanParams({ kind: 'backforth', dir: 'ccw' }), { kind: 'backforth', length: 4, rounds: 2 }, 'only circles go round');
});

test('a template’s moves: round a circle one way, both ways along a back-and-forth, out of a split, into a merge', () => {
  const moves = (id, params) => {
    const t = params ? T.fromParams(params) : builtIn(id);
    const spot = T.place(t, 0, E(6, 3), 1, rects);
    return T.flow(spot.frames, graph);
  };
  const c = (e) => graph.centres.get(e);
  const between = (m, a, b) => m.from.x === c(a).x && m.from.y === c(a).y && m.to.x === c(b).x && m.to.y === c(b).y;

  const round = moves('circle-2x2');
  assert.equal(round.length, 4, 'three rounds draw one square');
  assert.ok(round.every((m) => !m.both));
  assert.ok(between(round[0], E(6, 3), E(7, 3)), 'clockwise: right first');
  const back = moves(null, { kind: 'circle', size: 2, rounds: 3, dir: 'ccw' });
  assert.ok(between(back[0], E(6, 3), E(6, 4)), 'counter-clockwise: down first');
  assert.equal(moves('circle-3x3').length, 8);

  const line = moves('back-and-forth');
  assert.equal(line.length, 3);
  assert.ok(line.every((m) => m.both));

  // The split stretches the droplet over three electrodes (its centre stays), then two droplets
  // go out from the middle.
  const split = moves('split');
  assert.equal(split.length, 4);
  assert.ok(split.some((m) => between(m, E(6, 3), E(5, 3))) && split.some((m) => between(m, E(6, 3), E(7, 3))));
  assert.ok(split.some((m) => between(m, E(5, 3), E(4, 3))) && split.some((m) => between(m, E(7, 3), E(8, 3))));
  const merge = moves('merge');
  assert.equal(merge.length, 2);
  assert.ok(merge.some((m) => between(m, E(6, 3), E(7, 3))) && merge.some((m) => between(m, E(8, 3), E(7, 3))), 'both come into the middle');
  assert.deepEqual(T.flow([[E(2, 2)], [E(2, 2)]], graph), [], 'standing still is no move');
});

test('dragging the end of a path moves the mixer attached there, and the path going out follows', () => {
  const ed = chain();
  const mix = named(ed, MIX);
  ed.select(named(ed, 'Path 1').id);
  ed.pointerDown(...at(E(3, 3))); // Path 1's end, under the mixer
  ed.pointerMove(...at(E(5, 3)));
  assert.ok(ed.edit.preview.valid, ed.edit.preview.reason);
  assert.deepEqual([...ed.edit.preview.changes.keys()].sort(), [mix.id, named(ed, 'Path 1').id, named(ed, 'Path 2').id].sort());
  const done = ed.pointerUp();
  assert.deepEqual(done, { kind: 'edit', name: 'Path 1', reshaped: true, along: [MIX, 'Path 2'] });
  assert.equal(ed.action(mix.id).at, E(5, 3));
  assert.deepEqual(pointsOf(named(ed, 'Path 1')), [9, E(5, 1), E(5, 3)]);
  assert.deepEqual(pointsOf(named(ed, 'Path 2')), [E(5, 3), E(8, 3)]);
  assert.deepEqual([spanOf(ed, 'Path 1'), spanOf(ed, MIX), spanOf(ed, 'Path 2')], [[6, 12], [12, 24], [24, 27]]);
  assert.deepEqual(ed.compiled.issues, []);
  assert.ok(ed.undo(), 'one undo step');
  assert.equal(ed.action(mix.id).at, E(3, 3));
  assert.deepEqual(pointsOf(named(ed, 'Path 2')), [E(3, 3), E(8, 3)]);
});

test('dragging the start of the path going out moves the mixer too, and the path coming in follows', () => {
  const ed = chain();
  const mix = named(ed, MIX);
  ed.select(named(ed, 'Path 2').id);
  ed.frame = 22;
  ed.pointerDown(...at(E(3, 3))); // Path 2's start
  ed.pointerMove(...at(E(3, 5)));
  const done = ed.pointerUp();
  assert.ok(done, ed.notice);
  assert.equal(ed.action(mix.id).at, E(3, 5));
  assert.deepEqual(pointsOf(named(ed, 'Path 2')), [E(3, 5), E(3, 3), E(8, 3)]);
  assert.deepEqual(pointsOf(named(ed, 'Path 1')), [9, E(3, 1), E(3, 5)]);
  assert.deepEqual(ed.compiled.issues, []);
});

test('the freehand tool does the same on a path whose end something follows', () => {
  const ed = chain();
  ed.setTool('freehand');
  ed.select(named(ed, 'Path 1').id);
  drag(ed, E(3, 3), E(4, 3), E(5, 3));
  assert.equal(named(ed, MIX).at, E(5, 3));
  assert.equal(ed.project.actions.length, 4, 'nothing new was drawn');
});

test('where the mixer can’t come along, the end stays and nothing changes', () => {
  const ed = chain();
  ed.select(named(ed, 'Path 1').id);
  const before = ed.state();
  ed.pointerDown(...at(E(3, 3)));
  ed.pointerMove(...at(E(3, 7))); // the 2 x 2 mixer would hang off the bottom edge
  assert.equal(ed.edit.preview.valid, false);
  assert.match(ed.edit.preview.reason, /Circle mix 2×2, 3 rounds/);
  assert.equal(ed.pointerUp(), null);
  assert.equal(ed.state(), before);
});

test('a path that carries on from the end stretches to meet it; the middle of a line moves alone', () => {
  const ed = new Editor(getLayout('electrodes'));
  drag(ed, E(2, 6), E(6, 6)); // Path 1, frames 1-5
  ed.escape();
  drag(ed, E(6, 6), E(6, 3)); // Path 2 carries on after it
  const [p1, p2] = ed.project.actions;
  assert.equal(p2.after, p1.id);
  ed.setTool('select');
  ed.select(p1.id);
  ed.pointerDown(...at(E(6, 6)));
  ed.pointerMove(...at(E(8, 6)));
  ed.pointerUp();
  assert.deepEqual(pointsOf(ed.action(p1.id)), [E(2, 6), E(8, 6)]);
  assert.deepEqual(pointsOf(ed.action(p2.id)), [E(8, 6), E(6, 6), E(6, 3)]);
  assert.deepEqual(ed.compiled.issues, []);

  // A piece dragged sideways keeps both ends where they are, so nothing else moves.
  ed.select(p2.id);
  ed.pointerDown(...at(E(6, 5)));
  ed.pointerMove(...at(E(5, 5)));
  ed.pointerUp();
  assert.deepEqual(pointsOf(ed.action(p1.id)), [E(2, 6), E(8, 6)]);
  assert.equal(pointsOf(ed.action(p2.id))[0], E(8, 6));
});

test('a placed circle mix can be switched to counter-clockwise; the paths stay attached', () => {
  const ed = chain();
  const id = named(ed, MIX).id;
  ed.frame = 11;
  assert.deepEqual(ed.cellsIn(id), [E(4, 3)], 'clockwise: right first');
  assert.ok(ed.setParams(id, { dir: 'ccw' }));
  const mix = ed.action(id);
  assert.deepEqual(mix.params, { kind: 'circle', size: 2, rounds: 3, dir: 'ccw' });
  assert.equal(mix.name, 'Circle mix 2×2 counter-clockwise, 3 rounds');
  assert.equal(mix.template, 'circle-2x2-r3-ccw');
  assert.deepEqual(ed.cellsIn(id), [E(3, 4)], 'down first');
  assert.deepEqual(pointsOf(named(ed, 'Path 2')), [E(3, 3), E(8, 3)]);
  assert.deepEqual(ed.compiled.issues, []);
  assert.ok(ed.setParams(id, { dir: 'cw' }));
  assert.deepEqual(ed.action(id).params, { kind: 'circle', size: 2, rounds: 3 });
  assert.equal(ed.action(id).template, 'circle-2x2');
});

test('moving a merge: the droplet that got there first and waits comes along too, and is picked up', () => {
  const ed = new Editor(getLayout('electrodes'));
  drag(ed, E(1, 2), E(5, 2)); // Droplet 1: frames 1-5
  ed.escape();
  ed.frame = 1;
  drag(ed, E(5, 6), E(5, 4)); // Droplet 2: frames 1-3, then it waits on (5,4)
  ed.escape();
  ed.frame = 5;
  ed.startPlacement(builtIn('merge')); // vertical: (5,2) and (5,4) meet on (5,3)
  ed.hoverPlacement(...at(E(5, 2)));
  ed.dropPlacement();
  const [p1, p2, merge] = ed.project.actions;
  assert.deepEqual(merge.after, [p1.id, p2.id]);
  ed.setTool('select');
  ed.pointerDown(...at(E(5, 2)));
  ed.pointerMove(...at(E(7, 2)));
  assert.deepEqual(ed.edit.attached.incoming, [p1.id, p2.id], 'both paths into it are attached');
  ed.pointerUp();
  assert.equal(ed.action(merge.id).at, E(7, 2));
  assert.deepEqual(pointsOf(ed.action(p2.id)), [E(5, 6), E(5, 4), E(7, 4)]);
  assert.deepEqual(ed.compiled.issues, []);
  // Both droplets are on in the merge's first frame, where they were brought.
  const first = ed.span(merge.id).from;
  assert.ok(ed.seq.get(E(7, 2), first) && ed.seq.get(E(7, 4), first));
});

test('a move, turn or resize that would lose a droplet is refused', () => {
  const ed = new Editor(getLayout('electrodes'));
  ed.pointerDown(-29, -5); // the upper-left reservoir: its droplet ends on 9 in frame 6
  ed.pointerUp();
  ed.startPlacement(builtIn('circle-2x2'));
  ed.hoverPlacement(...at(9));
  ed.dropPlacement(); // a mixer straight after the dispense, no path in between
  const mix = ed.project.actions[1];
  assert.equal(mix.after, ed.project.actions[0].id);
  const before = ed.state();
  ed.setTool('select');
  ed.frame = 7;
  ed.pointerDown(...at(E(2, 1)));
  ed.pointerMove(...at(E(4, 1)));
  assert.equal(ed.edit.preview.valid, false);
  assert.match(ed.edit.preview.reason, /wouldn't start where “Dispense left top” leaves its droplet, so that droplet would be lost/);
  assert.equal(ed.pointerUp(), null);
  assert.equal(ed.state(), before);
  assert.equal(ed.nudge(1, 0), false, 'nor with ⌥/Alt + arrows');
  assert.ok(ed.rotateSelected(1), 'turning it round its drop point keeps it on the droplet');
});
