'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Editor } = require('../js/editor.js');
const { getLayout } = require('../js/layout.js');
const { MAX_FRAMES, CELLS } = require('../js/model.js');

const standard = () => new Editor(getLayout('electrodes'));
// Centre of electrode (column, row) of the main grid, in grid units.
const at = (e) => [-15 + 2 * Math.floor(e / 8), -7 + 2 * (e % 8)];
const onIn = (ed, f) => {
  const on = [];
  for (let e = 0; e < CELLS; e++) if (ed.seq.get(e, f)) on.push(e);
  return on;
};
const click = (ed, e, opts) => {
  ed.pointerDown(...at(e), opts);
  ed.pointerUp();
};

test('a click toggles the electrode in the current frame', () => {
  const ed = standard();
  click(ed, 9);
  assert.deepEqual(onIn(ed, 1), [9]);
  click(ed, 9);
  assert.deepEqual(onIn(ed, 1), []);
});

test('dragging paints the state set by the press, without skipping electrodes', () => {
  const ed = standard();
  ed.pointerDown(...at(8)); // 8 goes on, so the drag paints "on"
  ed.pointerMove(...at(112)); // one big jump along the top row
  ed.pointerUp();
  assert.deepEqual(onIn(ed, 1), [8, 16, 24, 32, 40, 48, 56, 64, 72, 80, 88, 96, 104, 112]);

  ed.pointerDown(...at(8)); // 8 is on now, so this drag paints "off"
  ed.pointerMove(...at(40));
  ed.pointerUp();
  assert.deepEqual(onIn(ed, 1), [48, 56, 64, 72, 80, 88, 96, 104, 112]);
  assert.equal(ed.frame, 1);
});

test('Shift+click goes to the next frame and switches the electrode on', () => {
  const ed = standard();
  click(ed, 9);
  for (const e of [17, 25, 33]) click(ed, e, { shift: true });
  assert.equal(ed.frame, 4);
  assert.deepEqual([1, 2, 3, 4].map((f) => onIn(ed, f)), [[9], [17], [25], [33]]);

  ed.seq.set(41, 5, true);
  click(ed, 41, { shift: true }); // never switches off
  assert.equal(ed.frame, 5);
  assert.deepEqual(onIn(ed, 5), [41]);
});

test('frames stay between 1 and 200', () => {
  const ed = standard();
  ed.prevFrame();
  assert.equal(ed.frame, 1);
  ed.frame = MAX_FRAMES;
  ed.nextFrame();
  assert.equal(ed.frame, MAX_FRAMES);
  click(ed, 9, { shift: true });
  assert.equal(ed.frame, MAX_FRAMES);
  assert.ok(ed.seq.get(9, MAX_FRAMES));
});

test('presses outside the array or between electrodes change nothing', () => {
  const ed = standard();
  ed.pointerDown(0, 14);
  ed.pointerMove(...at(9));
  ed.pointerUp();
  ed.pointerDown(-15, -2);
  ed.pointerUp();
  assert.equal(ed.seq.lastFrame(), 1);
  assert.deepEqual(onIn(ed, 1), []);
});

test('copy last frame, clear frame and clear all buttons', () => {
  const ed = standard();
  click(ed, 9);
  click(ed, 10);
  assert.equal(ed.pointerDown(35, 5), 'copy'); // on frame 1 there is nothing to copy
  assert.equal(ed.seq.lastFrame(), 1);
  ed.nextFrame();
  ed.pointerDown(35, 5);
  assert.deepEqual(onIn(ed, 2), [9, 10]);
  assert.equal(ed.pointerDown(35, 8), 'clearFrame');
  assert.deepEqual(onIn(ed, 2), []);
  assert.deepEqual(onIn(ed, 1), [9, 10]);
  ed.nextFrame();
  assert.equal(ed.pointerDown(35, 11), 'clearAll');
  assert.equal(ed.frame, 1);
  assert.deepEqual(onIn(ed, 1), []);
});

test('reservoir buttons write the six-frame dispense sequences of the original', () => {
  // Transcribed from mousePressed() in OpenDropController4_25.pde (fluxels[column * ysize + row]).
  const R = (column, row) => column * 8 + row;
  const cases = [
    [[29, -5], [[R(15, 3)], [R(15, 3), R(15, 2)], [R(15, 2), R(15, 1), R(15, 0)], [R(15, 0), R(14, 1)], [R(14, 1), R(15, 3), R(15, 2)], [R(14, 1), R(15, 3)]]],
    [[29, 5], [[R(15, 4)], [R(15, 4), R(15, 5)], [R(15, 5), R(15, 6), R(15, 7)], [R(15, 7), R(14, 6)], [R(14, 6), R(15, 4), R(15, 5)], [R(14, 6), R(15, 4)]]],
    [[-29, -5], [[R(0, 3)], [R(0, 3), R(0, 2)], [R(0, 2), R(0, 1), R(0, 0)], [R(0, 0), R(1, 1)], [R(1, 1), R(0, 3), R(0, 2)], [R(1, 1), R(0, 3)]]],
    [[-29, 5], [[R(0, 4)], [R(0, 4), R(0, 5)], [R(0, 5), R(0, 6), R(0, 7)], [R(0, 7), R(1, 6)], [R(1, 6), R(0, 4), R(0, 5)], [R(1, 6), R(0, 4)]]],
  ];
  for (const [[x, y], frames] of cases) {
    const ed = standard();
    ed.frame = 3;
    ed.pointerDown(x, y);
    assert.equal(ed.frame, 8, 'ends on the last frame of the sequence');
    const sorted = (list) => [...list].sort((a, b) => a - b);
    assert.deepEqual([3, 4, 5, 6, 7, 8].map((f) => onIn(ed, f)), frames.map(sorted));
  }
});

test('reservoir buttons do nothing on layouts without those reservoirs', () => {
  const ed = new Editor(getLayout('electrodes_glass'));
  assert.equal(ed.pointerDown(29, -5), null);
  assert.equal(ed.seq.lastFrame(), 1);
});

test('play loops from the current frame to the last non-empty frame, then from 1', () => {
  const ed = standard();
  ed.seq.set(9, 3, true);
  assert.equal(ed.pointerDown(39, -8), 'play'); // the label is part of the button, as in the original
  assert.ok(ed.playing);
  ed.playStart = 0;
  assert.equal(ed.frameMs, 500); // 120 frames/min
  assert.equal(ed.tick(500), false);
  assert.equal(ed.tick(501), true);
  assert.equal(ed.frame, 2);
  ed.tick(1002);
  assert.equal(ed.frame, 3);
  ed.tick(1503);
  assert.equal(ed.frame, 1);
  ed.togglePlay(2000);
  assert.ok(!ed.playing);
  assert.equal(ed.tick(9999), false);
});

test('the wheel steps frames when stopped and changes the speed while playing', () => {
  const ed = standard();
  ed.wheel(-1);
  assert.equal(ed.frame, 2, 'wheel up = next frame');
  ed.wheel(1);
  assert.equal(ed.frame, 1);
  ed.togglePlay(0);
  ed.wheel(-1);
  assert.equal(ed.speed, 125);
  assert.equal(ed.frame, 1);
  for (let i = 0; i < 200; i++) ed.wheel(1);
  assert.equal(ed.speed, 5);
  for (let i = 0; i < 200; i++) ed.wheel(-1);
  assert.equal(ed.speed, 600);
});

test('save, load and the frame arrows are found at the original positions', () => {
  const ed = standard();
  assert.equal(ed.pointerDown(33, -19), 'save');
  assert.equal(ed.pointerDown(39, -19), 'load');
  assert.equal(ed.pointerDown(19, 19), 'next');
  assert.equal(ed.frame, 2);
  assert.equal(ed.pointerDown(-19, 19), 'prev');
  assert.equal(ed.frame, 1);
});

test('loading replaces the sequence and goes back to frame 1', () => {
  const ed = standard();
  click(ed, 9);
  ed.frame = 7;
  const { Sequence } = require('../js/model.js');
  const loaded = new Sequence();
  loaded.set(20, 2, true);
  ed.replaceSequence(loaded);
  assert.equal(ed.frame, 1);
  assert.deepEqual(onIn(ed, 1), []);
  assert.deepEqual(onIn(ed, 2), [20]);
});
