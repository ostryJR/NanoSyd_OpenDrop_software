'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Editor, UNDO_LIMIT } = require('../js/editor.js');
const { getLayout } = require('../js/layout.js');
const { MAX_FRAMES, CELLS, Sequence } = require('../js/model.js');
const { electrodeGraph } = require('../js/paths.js');

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

test('paint tool: dragging paints the state set by the press, without skipping electrodes', () => {
  const ed = standard();
  ed.setTool('paint');
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
  const loaded = new Sequence();
  loaded.set(20, 2, true);
  ed.replaceSequence(loaded);
  assert.equal(ed.frame, 1);
  assert.deepEqual(onIn(ed, 1), []);
  assert.deepEqual(onIn(ed, 2), [20]);
});

// --- drawing paths -----------------------------------------------------------------------------

// Press on the first electrode and move through the rest, without letting go.
const drag = (ed, first, ...rest) => {
  ed.pointerDown(...at(first));
  for (const e of rest) ed.pointerMove(...at(e));
};
const framesFrom = (ed, from, count) => Array.from({ length: count }, (_, i) => onIn(ed, from + i));

test('freehand: a drag shows a path but adds nothing until the button is released', () => {
  const ed = standard();
  assert.equal(ed.tool, 'freehand', 'the default tool');
  drag(ed, 8, 40); // along the top row in one move
  assert.deepEqual(ed.draft.cells, [8, 16, 24, 32, 40]);
  assert.equal(ed.draft.steps, 4);
  assert.equal(ed.draft.end, 40);
  assert.equal(ed.seq.lastFrame(), 1);
  assert.deepEqual(onIn(ed, 1), [], 'nothing in the sequence yet');
  assert.deepEqual(ed.pointerUp(), { from: 1, to: 5, steps: 4 });
  assert.deepEqual(framesFrom(ed, 1, 5), [[8], [16], [24], [32], [40]]);
  assert.equal(ed.frame, 5, 'the view moves to the end of the path');
  assert.equal(ed.draft, null);
});

test('freehand: the next drag carries on from where the last path ended', () => {
  const ed = standard();
  drag(ed, 8, 24);
  ed.pointerUp();
  drag(ed, 24, 26); // down the column
  ed.pointerUp();
  assert.deepEqual(framesFrom(ed, 1, 5), [[8], [16], [24], [25], [26]]);
  assert.equal(ed.frame, 5);
});

test('freehand: diagonal and fast moves become steps between neighbouring electrodes', () => {
  const ed = standard();
  drag(ed, 8, 61); // column 1 row 0 to column 7 row 5, in one diagonal move
  const { cells } = ed.draft;
  const { neighbours } = electrodeGraph(getLayout('electrodes').rects);
  for (let i = 1; i < cells.length; i++) {
    assert.ok(neighbours.get(cells[i - 1]).includes(cells[i]), `${cells[i - 1]} -> ${cells[i]}`);
  }
  assert.equal(ed.draft.end, 61);
  assert.equal(ed.draft.steps, 6 + 5, 'six columns across and five rows down');
});

test('freehand: going back over the path takes steps back; back at the start, nothing is added', () => {
  const ed = standard();
  drag(ed, 8, 40, 24);
  assert.deepEqual(ed.draft.cells, [8, 16, 24]);
  ed.pointerMove(...at(8));
  assert.equal(ed.draft.steps, 0);
  assert.equal(ed.pointerUp(), null);
  assert.equal(ed.seq.lastFrame(), 1);
  assert.deepEqual(onIn(ed, 1), [], 'and the start electrode is not toggled');
  assert.ok(!ed.canUndo);
});

test('freehand: a loop keeps every step, including the return to the start', () => {
  const ed = standard();
  drag(ed, 8, 16, 17, 9, 8);
  assert.deepEqual(ed.draft.cells, [8, 16, 17, 9, 8]);
  ed.pointerUp();
  assert.deepEqual(framesFrom(ed, 1, 5), [[8], [16], [17], [9], [8]]);
});

test('path tools: a click without a drag still toggles the electrode', () => {
  for (const tool of ['freehand', 'straight']) {
    const ed = standard();
    ed.setTool(tool);
    click(ed, 9);
    assert.deepEqual(onIn(ed, 1), [9], tool);
    click(ed, 9);
    assert.deepEqual(onIn(ed, 1), [], tool);
  }
});

test('paths are added on top of what their frames already hold', () => {
  const ed = standard();
  ed.seq.set(120, 2, true);
  drag(ed, 8, 24);
  ed.pointerUp();
  assert.deepEqual(onIn(ed, 2), [16, 120]);
});

test('paths stop at frame 200', () => {
  const ed = standard();
  ed.frame = MAX_FRAMES - 2;
  drag(ed, 8, 48); // five steps wanted, two fit
  assert.equal(ed.draft.steps, 2);
  assert.ok(ed.draft.limited);
  assert.deepEqual(ed.pointerUp(), { from: 198, to: 200, steps: 2 });
  assert.deepEqual(onIn(ed, MAX_FRAMES), [24]);

  ed.setTool('straight');
  ed.frame = MAX_FRAMES - 1;
  drag(ed, 9, 17, 57);
  assert.deepEqual(ed.draft.cells, [9, 17]);
  assert.ok(ed.draft.limited);
});

test('straight: the first line follows the direction the drag starts in', () => {
  const ed = standard();
  ed.setTool('straight');
  drag(ed, 8, 16, 26); // starts to the right, ends at column 3 row 2
  assert.deepEqual(ed.draft.cells, [8, 16, 24, 25, 26]);
  assert.equal(ed.draft.end, 26);
  ed.pointerMove(...at(8)); // back on the start electrode: the next direction decides again
  assert.deepEqual(ed.draft.cells, [8]);
  ed.pointerMove(...at(9)); // starts downwards
  ed.pointerMove(...at(26));
  assert.deepEqual(ed.draft.cells, [8, 9, 10, 18, 26]);
  ed.pointerMove(...at(11)); // same column as the start: a single line
  assert.deepEqual(ed.draft.cells, [8, 9, 10, 11]);
  ed.pointerUp();
  assert.deepEqual(framesFrom(ed, 1, 4), [[8], [9], [10], [11]]);
  assert.equal(ed.frame, 4);
});

test('straight: between electrodes or off the array, the path stays as it was', () => {
  const ed = standard();
  ed.setTool('straight');
  drag(ed, 8, 40);
  ed.pointerMove(0, 14); // below the array
  ed.pointerMove(-15, -2); // the gap left of the grid
  assert.deepEqual(ed.draft.cells, [8, 16, 24, 32, 40]);
});

test('drawing a path stops playback; a plain click does not', () => {
  const ed = standard();
  ed.togglePlay(0);
  click(ed, 9);
  assert.ok(ed.playing);
  drag(ed, 8, 16);
  assert.ok(!ed.playing);
});

test('Esc drops the path being drawn, and takes back a paint drag', () => {
  const ed = standard();
  drag(ed, 8, 40);
  assert.equal(ed.cancel(), true);
  assert.equal(ed.draft, null);
  assert.equal(ed.pointerUp(), null);
  assert.equal(ed.seq.lastFrame(), 1);

  ed.setTool('paint');
  drag(ed, 8, 40);
  assert.deepEqual(onIn(ed, 1), [8, 16, 24, 32, 40]);
  ed.cancel();
  assert.deepEqual(onIn(ed, 1), []);
  assert.ok(!ed.canUndo);
  assert.equal(ed.cancel(), false, 'nothing left to cancel');
});

// --- undo ----------------------------------------------------------------------------------------

test('undo and redo go back and forth, each to the frame the change was made in', () => {
  const ed = standard();
  assert.ok(!ed.canUndo && !ed.canRedo);
  click(ed, 9);
  drag(ed, 9, 25); // 9, 17, 25 in frames 1-3
  ed.pointerUp();
  assert.equal(ed.frame, 3);

  assert.ok(ed.undo());
  assert.equal(ed.frame, 1);
  assert.deepEqual(onIn(ed, 1), [9]);
  assert.equal(ed.seq.lastFrame(), 1);
  assert.ok(ed.undo());
  assert.deepEqual(onIn(ed, 1), []);
  assert.equal(ed.undo(), false, 'nothing more to undo');

  assert.ok(ed.redo());
  assert.ok(ed.redo());
  assert.equal(ed.frame, 3);
  assert.deepEqual(framesFrom(ed, 1, 3), [[9], [17], [25]]);
  assert.equal(ed.redo(), false);

  ed.undo();
  click(ed, 40); // a new change: the undone path can't be redone any more
  assert.ok(!ed.canRedo);
});

test('each change is one undo step: clicks, drags, Shift+click, buttons, reservoirs, loading', () => {
  const ed = standard();
  const changes = [
    () => click(ed, 9),
    () => click(ed, 17, { shift: true }),
    () => {
      ed.setTool('paint');
      drag(ed, 10, 106);
      ed.pointerUp();
    },
    () => ed.pointerDown(35, 5), // copy last frame (frame 2 = frame 1)
    () => ed.pointerDown(35, 8), // clear frame
    () => ed.pointerDown(29, -5), // upper-right reservoir: frames 2-7
    () => {
      const loaded = new Sequence();
      loaded.set(50, 4, true);
      ed.replaceSequence(loaded);
    },
    () => ed.pointerDown(35, 11), // clear all
  ];
  const before = [];
  for (const change of changes) {
    before.push({ snap: ed.seq.snapshot(), frame: ed.frame });
    change();
    assert.notDeepEqual(ed.seq.snapshot(), before[before.length - 1].snap, 'the change changed something');
  }
  for (let i = before.length - 1; i >= 0; i--) {
    assert.ok(ed.undo());
    assert.deepEqual(ed.seq.snapshot(), before[i].snap, `undo of change ${i + 1}`);
    assert.equal(ed.frame, before[i].frame, `frame after undoing change ${i + 1}`);
  }
  assert.ok(!ed.canUndo);
});

test('changing frames and buttons that change nothing leave nothing to undo', () => {
  const ed = standard();
  ed.pointerDown(35, 5); // copy last frame on frame 1
  ed.pointerDown(35, 8); // clear an empty frame
  ed.pointerDown(35, 11); // clear all with nothing there
  ed.nextFrame();
  ed.wheel(1);
  ed.pointerDown(39, -8); // play
  ed.pointerDown(39, -8); // stop
  assert.ok(!ed.canUndo);
});

test('undo during a drag only cancels the drag', () => {
  const ed = standard();
  click(ed, 40);
  drag(ed, 8, 24);
  assert.ok(ed.undo());
  assert.equal(ed.draft, null);
  assert.deepEqual(onIn(ed, 1), [40], 'the earlier change is kept');
  assert.ok(ed.canUndo);
});

test(`undo keeps the last ${UNDO_LIMIT} changes`, () => {
  const ed = standard();
  for (let i = 0; i < UNDO_LIMIT + 5; i++) click(ed, 9);
  let undone = 0;
  while (ed.undo()) undone++;
  assert.equal(undone, UNDO_LIMIT);
});

test('the switch on the left picks the drag tool, with undo and redo buttons below it', () => {
  const ed = standard();
  assert.equal(ed.pointerDown(-42, -5), 'toolStraight');
  assert.equal(ed.tool, 'straight');
  assert.equal(ed.pointerDown(-38, -2), 'toolPaint'); // on the label
  assert.equal(ed.tool, 'paint');
  assert.equal(ed.pointerDown(-42, -8), 'toolFreehand');
  assert.equal(ed.tool, 'freehand');
  ed.setTool('nonsense');
  assert.equal(ed.tool, 'freehand');

  click(ed, 9);
  assert.equal(ed.pointerDown(-42, 5), 'undo');
  assert.deepEqual(onIn(ed, 1), []);
  assert.equal(ed.pointerDown(-42, 8), 'redo');
  assert.deepEqual(onIn(ed, 1), [9]);
});

// --- timing ----------------------------------------------------------------------------------------

test('playback holds each frame for its own time', () => {
  const ed = standard();
  ed.seq.set(9, 3, true);
  ed.seq.setTime(2, 2000);
  ed.togglePlay(0);
  assert.equal(ed.tick(501), true);
  assert.equal(ed.frame, 2);
  assert.equal(ed.tick(2000), false, 'frame 2 lasts 2 s');
  assert.equal(ed.tick(2502), true);
  assert.equal(ed.frame, 3);
});

test("a frame's own time is undoable; the default frame time is a setting", () => {
  const ed = standard();
  ed.setFrameTime(3, 1500);
  assert.equal(ed.seq.timeOf(3), 1500);
  ed.setDefaultTime(250);
  assert.ok(ed.undo());
  assert.equal(ed.seq.timeOf(3), 250, 'back to the default, which stays at 250');
  assert.ok(!ed.canUndo);
  assert.equal(ed.speed, 240, 'shown as 240 frames/min');
});
