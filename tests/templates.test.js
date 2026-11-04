'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { getLayout } = require('../js/layout.js');
const { Sequence, MAX_FRAMES } = require('../js/model.js');
const T = require('../js/templates.js');

const rects = getLayout('electrodes').rects;
const E = (column, row) => column * 8 + row;
const byId = (id) => T.BUILT_IN.find((t) => t.id === id);

test('built-in templates: names, step counts, and the drop point first', () => {
  const steps = Object.fromEntries(T.BUILT_IN.map((t) => [t.id, T.stepsOf(t)]));
  assert.deepEqual(steps, { 'circle-2x2': 12, 'circle-3x3': 16, 'back-and-forth': 12, split: 3, merge: 2, 'split-merge': 12 });
  for (const t of T.BUILT_IN) {
    assert.ok(t.builtIn && t.name, t.id);
    // The drop point is the leftmost (then top) electrode of the first frame, as for your own.
    assert.deepEqual(T.fromSequence(T.toSequence(t)).frames, t.frames, t.id);
  }
});

test('circle mixing goes round a square and ends where it started', () => {
  const { frames } = byId('circle-2x2');
  assert.deepEqual(frames.slice(0, 5), [[[0, 0]], [[1, 0]], [[1, 1]], [[0, 1]], [[0, 0]]]);
  assert.deepEqual(frames[frames.length - 1], [[0, 0]]);
});

test('split stretches the droplet over three electrodes, then pinches the middle', () => {
  assert.deepEqual(byId('split').frames, [[[0, 0]], [[-1, 0], [0, 0], [1, 0]], [[-1, 0], [1, 0]], [[-2, 0], [2, 0]]]);
});

test('placing a template: its electrodes in frames from the one on screen', () => {
  const spot = T.place(byId('circle-2x2'), 0, E(3, 2), 7, rects);
  assert.ok(spot.valid);
  assert.deepEqual(spot.frames.slice(0, 4), [[E(3, 2)], [E(4, 2)], [E(4, 3)], [E(3, 3)]]);
  assert.equal(spot.steps, 12);
  assert.equal(spot.endFrame, 19);
});

test('a quarter turn rotates clockwise around the drop point', () => {
  const split = byId('split');
  const turned = T.place(split, 1, E(5, 4), 1, rects);
  assert.deepEqual(turned.frames[1], [E(5, 3), E(5, 4), E(5, 5)]);
  assert.deepEqual(turned.frames[3], [E(5, 2), E(5, 6)]);
  assert.deepEqual(T.rotate(split.frames, 4), split.frames);
});

test('templates that run off the array or past frame 200 do not fit', () => {
  const circle = byId('circle-3x3');
  const corner = T.place(circle, 0, E(14, 7), 1, rects); // bottom-right corner of the grid
  assert.equal(corner.fits, false);
  assert.equal(corner.valid, false);
  const late = T.place(circle, 0, E(3, 2), MAX_FRAMES - 10, rects);
  assert.ok(late.fits);
  assert.equal(late.inTime, false);
  assert.equal(T.place(circle, 0, 128, 1, getLayout('electrodes_magnet').rects).fits, false, 'magnets are no drop point');
  // A split reaches two columns each way: from column 2 that includes reservoir electrode 4.
  assert.equal(T.place(byId('split'), 0, E(2, 4), 1, rects).fits, true, 'reservoir electrodes count where they exist');
  assert.equal(T.place(byId('split'), 0, E(1, 4), 1, rects).fits, false, 'one column further is off the array');
});

test('a template drawn in a sequence: trimmed, relative to its first electrode, with own times', () => {
  const seq = new Sequence();
  seq.set(E(6, 3), 4, true); // nothing in frames 1-3
  seq.set(E(6, 4), 5, true);
  seq.set(E(5, 4), 6, true);
  seq.set(E(7, 4), 6, true);
  seq.set(128, 6, true); // a magnet: not part of templates
  seq.setTime(5, 2000);
  const made = T.fromSequence(seq);
  assert.deepEqual(made.frames, [[[0, 0]], [[0, 1]], [[-1, 1], [1, 1]]]);
  assert.deepEqual(made.times, [0, 2000, 0]);
  assert.equal(T.fromSequence(new Sequence()), null);
  const back = T.toSequence(made);
  assert.equal(back.timeOf(2), 2000);
});

test('stored templates are checked; export and import round-trip', () => {
  assert.equal(T.clean(null), null);
  assert.equal(T.clean({ name: 'x', frames: [] }), null);
  assert.equal(T.clean({ name: 'x', frames: [[]] }), null, 'needs an electrode in the first frame');
  const t = T.clean({ name: '  Mix  ', frames: [[[0, 0], [99, 0], 'junk'], [[1, 0]]], times: [0, 5e9] });
  assert.deepEqual(t, { name: 'Mix', frames: [[[0, 0]], [[1, 0]]], times: [0, 3600000] });
  const text = T.exportText([t, byId('merge')]);
  const back = T.importText(text);
  assert.equal(back.length, 2);
  assert.ok(T.sameTemplate(back[0], t));
  assert.equal(back[1].name, 'Merge two droplets');
  assert.ok(!('builtIn' in back[1]), 'imported templates are your own');
  assert.throws(() => T.importText('{"something": "else"}'), /not a templates file/);
  assert.throws(() => T.importText('[{"name": "x"}]'), /no templates/);
});

test('built-in mixes have parameters; other values make other frames, with a key and a name', () => {
  assert.deepEqual(byId('circle-3x3').params, { kind: 'circle', size: 3, rounds: 2 });
  for (const t of T.BUILT_IN.filter((x) => x.params)) {
    const again = T.fromParams(t.params);
    assert.equal(again.id, t.id, 'its own parameters give the built-in itself');
    assert.deepEqual(again.frames, t.frames);
  }
  const big = T.fromParams({ kind: 'circle', size: 3, rounds: 5 });
  assert.equal(big.id, 'circle-3x3-r5');
  assert.equal(big.name, 'Circle mix 3×3, 5 rounds');
  assert.equal(T.stepsOf(big), 8 * 5);
  const line = T.fromParams({ kind: 'backforth', length: 3, rounds: 1 });
  assert.deepEqual(line.frames, [[[0, 0]], [[1, 0]], [[2, 0]], [[1, 0]], [[0, 0]]]);
  assert.equal(T.fromParams({ kind: 'splitmerge', rounds: 1 }).frames.length, 7);
  assert.deepEqual(T.cleanParams({ kind: 'circle', size: 9, rounds: 'x' }), { kind: 'circle', size: 3, rounds: 3 });
  assert.equal(T.fromParams({ kind: 'nope' }), null);
});

test('built-ins are listed in groups: merge and split first, then the mixers', () => {
  assert.deepEqual(T.GROUPS, ['Merge and split', 'Mixers']);
  assert.deepEqual(T.BUILT_IN.map((t) => t.id), ['merge', 'split', 'circle-2x2', 'circle-3x3', 'back-and-forth', 'split-merge']);
  for (const t of T.BUILT_IN) assert.ok(T.GROUPS.includes(t.group), t.id);
  assert.equal(byId('merge').turns, 1, 'a merge is dropped standing up');
  assert.equal(byId('circle-2x2').group, 'Mixers');
});
