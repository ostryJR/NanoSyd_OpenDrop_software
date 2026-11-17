'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Sequence, MAX_FRAMES, CELLS, DEFAULT_FRAME_TIME, MIN_TIME, MAX_TIME, sameSnapshot } = require('../js/model.js');

test('a new sequence is empty and its last frame is 1', () => {
  const seq = new Sequence();
  assert.equal(seq.frames[1].length, CELLS);
  assert.equal(seq.cells(5000).length, CELLS);
  assert.ok(seq.isEmpty(5000));
  assert.ok(!seq.get(0, 5000));
  assert.ok(seq.isEmpty(1));
  assert.equal(seq.lastFrame(), 1);
});

test('lastFrame() is the last frame with any electrode on', () => {
  const seq = new Sequence();
  seq.set(5, 7, true);
  seq.set(3, 2, true);
  assert.equal(seq.lastFrame(), 7);
  seq.set(143, MAX_FRAMES, true);
  assert.equal(seq.lastFrame(), MAX_FRAMES);
  seq.set(143, MAX_FRAMES, false);
  assert.equal(seq.lastFrame(), 7);
  assert.throws(() => seq.set(0, MAX_FRAMES + 1, true), RangeError);
});

test('the table grows past frame 200 and undo snapshots follow it', () => {
  const seq = new Sequence();
  const before = seq.snapshot();
  seq.set(4, 1000, true);
  seq.setTime(1000, 2000);
  assert.equal(seq.lastFrame(), 1000);
  assert.equal(seq.timeOf(1000), 2000);
  assert.ok(!sameSnapshot(before, seq.snapshot()));
  const after = seq.snapshot();
  seq.restore(before);
  assert.equal(seq.lastFrame(), 1);
  assert.equal(seq.timeOf(1000), DEFAULT_FRAME_TIME);
  seq.restore(after);
  assert.ok(seq.get(4, 1000));
  seq.set(4, 1000, false);
  seq.setTime(1000, 0);
  assert.ok(sameSnapshot(before, seq.snapshot()), 'empty extra frames are no change');
});

test('copy, clear frame and clear all', () => {
  const seq = new Sequence();
  seq.set(9, 1, true);
  seq.set(10, 1, true);
  seq.copyFrame(1, 2);
  assert.ok(seq.get(9, 2) && seq.get(10, 2));
  seq.set(9, 2, false);
  assert.ok(seq.get(9, 1), 'the copy is independent');
  seq.clearFrame(1);
  assert.ok(seq.isEmpty(1));
  assert.ok(seq.get(10, 2));
  seq.clearAll();
  assert.equal(seq.lastFrame(), 1);
  assert.ok(seq.isEmpty(1));
});

test('snapshot and restore copy electrodes and frame times, not the default time', () => {
  const seq = new Sequence();
  seq.set(5, 7, true);
  seq.setTime(7, 1500);
  const snap = seq.snapshot();
  seq.set(6, 8, true);
  seq.set(5, 7, false);
  seq.setTime(7, 0);
  seq.frameTime = 900;
  seq.restore(snap);
  assert.ok(seq.get(5, 7));
  assert.ok(!seq.get(6, 8));
  assert.equal(seq.timeOf(7), 1500);
  assert.equal(seq.timeOf(8), 900, 'the default frame time is a setting, not restored');
  snap.cells[7 * CELLS + 5] = 0;
  assert.ok(seq.get(5, 7), 'the snapshot is a copy');
});

test('frame times: own time or the default, clamped, and summed by elapsed()', () => {
  const seq = new Sequence();
  assert.equal(seq.timeOf(3), DEFAULT_FRAME_TIME);
  seq.setTime(2, 1234.4);
  seq.setTime(3, 1);
  seq.setTime(4, 1e9);
  assert.deepEqual([seq.timeOf(2), seq.timeOf(3), seq.timeOf(4)], [1234, MIN_TIME, MAX_TIME]);
  seq.setTime(4, 0);
  assert.equal(seq.timeOf(4), DEFAULT_FRAME_TIME);
  assert.equal(seq.elapsed(3), DEFAULT_FRAME_TIME + 1234 + MIN_TIME);
  seq.clearAll();
  assert.equal(seq.timeOf(2), DEFAULT_FRAME_TIME, 'clear all drops the frames\' own times');
});
