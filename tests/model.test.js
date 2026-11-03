'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Sequence, MAX_FRAMES, CELLS } = require('../js/model.js');

test('a new sequence is empty and its last frame is 1', () => {
  const seq = new Sequence();
  assert.equal(seq.frames.length, MAX_FRAMES + 1);
  assert.equal(seq.frames[1].length, CELLS);
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
