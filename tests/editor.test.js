'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Editor, UNDO_LIMIT } = require('../js/editor.js');
const { getLayout } = require('../js/layout.js');
const { MAX_FRAMES, CELLS, Sequence } = require('../js/model.js');
const { electrodeGraph } = require('../js/paths.js');
const projects = require('../js/project.js');

const standard = () => new Editor(getLayout('electrodes'));
// Centre of electrode e on the standard layout, in grid units.
const { centres } = electrodeGraph(getLayout('electrodes').rects);
const at = (e) => [centres.get(e).x, centres.get(e).y];
const E = (column, row) => column * 8 + row;
const onIn = (ed, f) => {
  const on = [];
  for (let e = 0; e < CELLS; e++) if (ed.seq.get(e, f)) on.push(e);
  return on;
};
const click = (ed, e, opts) => {
  ed.pointerDown(...at(e), opts);
  ed.pointerUp();
};
// Something already on: a pattern from frame `start` (not an undo step, like setting up a test).
const put = (ed, start, frames, extra = {}) => {
  const a = { id: projects.nextId(ed.project), type: 'pattern', name: 'Given', droplet: '', start, frames, ...extra };
  ed.project.actions.push(a);
  ed.recompile();
  return a;
};
const paintClick = (ed, e, opts) => {
  const tool = ed.tool;
  ed.setTool('paint');
  click(ed, e, opts);
  ed.setTool(tool);
};
const byType = (ed, type) => ed.project.actions.filter((a) => a.type === type);
const pointsOf = (a) => a.points.map((p) => p.e);

test('paint: a click toggles the electrode in the current frame, kept as a pattern', () => {
  const ed = standard();
  ed.setTool('paint');
  click(ed, 9);
  assert.deepEqual(onIn(ed, 1), [9]);
  const [pattern] = byType(ed, 'pattern');
  assert.deepEqual(pattern.frames, [[9]]);
  assert.equal(ed.selection, pattern.id, 'the new pattern is selected');
  click(ed, 9);
  assert.deepEqual(onIn(ed, 1), []);
  assert.equal(ed.project.actions.length, 0, 'an empty pattern goes away');
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
  assert.equal(byType(ed, 'pattern').length, 1, 'one pattern');
});

test('paint-off only removes the pattern’s own electrodes, and says whose an electrode is', () => {
  const ed = standard();
  ed.pointerDown(...at(8));
  ed.pointerMove(...at(24));
  ed.pointerUp(); // Path 1: 8, 16, 24 in frames 1-3
  ed.frame = 2;
  ed.setTool('paint');
  click(ed, 18); // a new pattern in frame 2
  ed.pointerDown(...at(18)); // off...
  ed.pointerMove(...at(16)); // ...and over the path's droplet
  ed.pointerUp();
  assert.deepEqual(onIn(ed, 2), [16], 'the path is still there');
  assert.match(ed.notice, /16 is part of “Path 1”/);
});

test('Shift+click goes to the next frame and switches the electrode on', () => {
  const ed = standard();
  paintClick(ed, 9);
  for (const e of [17, 25, 33]) click(ed, e, { shift: true });
  assert.equal(ed.frame, 4);
  assert.deepEqual([1, 2, 3, 4].map((f) => onIn(ed, f)), [[9], [17], [25], [33]]);
  assert.equal(byType(ed, 'pattern').length, 1, 'the pattern grows a frame each time');

  put(ed, 5, [[41]]);
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
  assert.equal(ed.project.actions.length, 0);
});

test('copy last frame, clear frame and clear all buttons', () => {
  const ed = standard();
  paintClick(ed, 9);
  paintClick(ed, 10);
  assert.equal(ed.pointerDown(35, 5), 'copy'); // on frame 1 there is nothing to copy
  assert.equal(ed.seq.lastFrame(), 1);
  ed.nextFrame();
  ed.pointerDown(35, 5);
  assert.deepEqual(onIn(ed, 2), [9, 10]);
  assert.deepEqual(byType(ed, 'pattern')[0].frames, [[9, 10], [9, 10]], 'copied into the same pattern');
  assert.equal(ed.pointerDown(35, 8), 'clearFrame');
  assert.deepEqual(onIn(ed, 2), []);
  assert.deepEqual(onIn(ed, 1), [9, 10]);
  ed.nextFrame();
  assert.equal(ed.pointerDown(35, 11), 'clearAll');
  assert.equal(ed.frame, 1);
  assert.deepEqual(onIn(ed, 1), []);
  assert.equal(ed.project.actions.length, 0);
});

test('clear frame leaves paths and templates, and says which are still on', () => {
  const ed = standard();
  ed.pointerDown(...at(8));
  ed.pointerMove(...at(24));
  ed.pointerUp();
  ed.frame = 2;
  ed.pointerDown(35, 8);
  assert.deepEqual(onIn(ed, 2), [16]);
  assert.match(ed.notice, /Still on in frame 2: “Path 1”/);
});

test('clear all also stops playback', () => {
  const ed = standard();
  put(ed, 1, [[9], [], [], [10]]);
  ed.togglePlay(0);
  ed.tick(501);
  assert.equal(ed.pointerDown(35, 11), 'clearAll');
  assert.ok(!ed.playing, 'playback stopped');
  assert.equal(ed.frame, 1);
  assert.equal(ed.seq.lastFrame(), 1);
  assert.equal(ed.tick(5000), false, 'and stays stopped');
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
    const [d] = byType(ed, 'dispense');
    assert.equal(d.start, 3);
    assert.equal(d.droplet, 'Droplet 1', 'a dispense makes a new droplet');
  }
});

test('reservoir buttons do nothing on layouts without those reservoirs', () => {
  const ed = new Editor(getLayout('electrodes_glass'));
  assert.equal(ed.pointerDown(29, -5), null);
  assert.equal(ed.seq.lastFrame(), 1);
});

test('play loops from the current frame to the last non-empty frame, then from 1', () => {
  const ed = standard();
  put(ed, 3, [[9]]);
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

test('save, load, export and the frame arrows are found on the board', () => {
  const ed = standard();
  assert.equal(ed.pointerDown(33, -19), 'save');
  assert.equal(ed.pointerDown(39, -19), 'load');
  assert.equal(ed.pointerDown(27, -19), 'export');
  assert.equal(ed.pointerDown(19, 19), 'next');
  assert.equal(ed.frame, 2);
  assert.equal(ed.pointerDown(-19, 19), 'prev');
  assert.equal(ed.frame, 1);
});

test('opening an OpenDrop file gives one block and goes back to frame 1', () => {
  const ed = standard();
  paintClick(ed, 9);
  ed.frame = 7;
  const loaded = new Sequence();
  loaded.set(20, 2, true);
  loaded.set(128, 3, true);
  ed.openSequence(loaded, { name: 'old.json' });
  assert.equal(ed.frame, 1);
  assert.deepEqual(onIn(ed, 1), []);
  assert.deepEqual(onIn(ed, 2), [20]);
  assert.deepEqual(onIn(ed, 3), [128]);
  assert.equal(ed.project.actions.length, 1);
  assert.equal(ed.project.actions[0].name, 'old.json');
  assert.ok(ed.undo(), 'undoable');
  assert.deepEqual(onIn(ed, 1), [9]);
});

test('opening a project replaces the actions; its default frame time comes along', () => {
  const ed = standard();
  paintClick(ed, 9);
  const { project } = projects.parse(JSON.stringify({
    openDropGeneratorProject: 1, layout: 'electrodes', frameTime: 250, templates: {},
    actions: [{ id: 'a1', type: 'path', name: 'Saved path', droplet: 'S', start: 2, points: [{ e: 8 }, { e: 24 }] }],
  }));
  ed.openProject(project);
  assert.deepEqual([2, 3, 4].map((f) => onIn(ed, f)), [[8], [16], [24]]);
  assert.equal(ed.seq.timeOf(2), 250);
  assert.ok(ed.undo());
  assert.deepEqual(onIn(ed, 1), [9]);
  assert.equal(ed.project.frameTime, 250, 'the default frame time is a setting');
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
  assert.deepEqual(ed.pointerUp(), { kind: 'path', from: 1, to: 5, steps: 4, extended: false });
  assert.deepEqual(framesFrom(ed, 1, 5), [[8], [16], [24], [32], [40]]);
  assert.equal(ed.frame, 5, 'the view moves to the end of the path');
  assert.equal(ed.draft, null);
});

test('a drawn path is saved as a line: its ends and corners', () => {
  const ed = standard();
  drag(ed, 8, 24, 26, 42); // right 2, down 2, right 2
  ed.pointerUp();
  const [path] = byType(ed, 'path');
  assert.deepEqual(pointsOf(path), [8, 24, 26, 42]);
  assert.equal(path.start, 1);
  assert.equal(path.name, 'Path 1');
  assert.deepEqual(framesFrom(ed, 1, 7), [[8], [16], [24], [25], [26], [34], [42]]);
});

test('freehand: the next drag carries on from where the last path ended', () => {
  const ed = standard();
  drag(ed, 8, 24);
  ed.pointerUp();
  drag(ed, 24, 26); // down the column
  ed.pointerUp();
  assert.deepEqual(framesFrom(ed, 1, 5), [[8], [16], [24], [25], [26]]);
  assert.equal(ed.frame, 5);
  const paths = byType(ed, 'path');
  assert.equal(paths.length, 1, 'drawing on from the selected path’s free end extends it');
  assert.deepEqual(pointsOf(paths[0]), [8, 24, 26]);
});

test('drawing on from a path that something follows starts a new, linked path', () => {
  const ed = standard();
  drag(ed, 8, 24);
  ed.pointerUp();
  ed.escape(); // nothing selected: the next path is a new one, linked after the first
  drag(ed, 24, 26);
  ed.pointerUp();
  const [first, second] = byType(ed, 'path');
  assert.equal(second.after, first.id);
  assert.equal(second.droplet, first.droplet, 'the same droplet');
  assert.equal(second.start, undefined);
  assert.deepEqual(framesFrom(ed, 1, 5), [[8], [16], [24], [25], [26]]);
});

test('a path drawn elsewhere starts at its frame with a new droplet name', () => {
  const ed = standard();
  drag(ed, 8, 24);
  ed.pointerUp();
  ed.frame = 1;
  drag(ed, 100, 102);
  ed.pointerUp();
  const [first, second] = byType(ed, 'path');
  assert.equal(second.start, 1);
  assert.equal(second.after, undefined);
  assert.equal(first.droplet, 'Droplet 1');
  assert.equal(second.droplet, 'Droplet 2');
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
  ed.pointerUp();
  for (let i = 0; i < cells.length; i++) assert.deepEqual(onIn(ed, 1 + i), [cells[i]], 'the line gives back the drawn route');
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

test('path tools and the select tool: a click selects what is there instead of toggling', () => {
  for (const tool of ['freehand', 'straight', 'select']) {
    const ed = standard();
    drag(ed, 8, 24);
    ed.pointerUp();
    ed.escape();
    ed.setTool(tool);
    ed.frame = 2;
    click(ed, 16);
    assert.equal(ed.selection, 'a1', tool);
    assert.deepEqual(onIn(ed, 2), [16], `${tool}: nothing toggled`);
    click(ed, 50);
    assert.equal(ed.selection, null, `${tool}: a click on nothing lets go`);
    click(ed, 24); // not on in frame 2, but on the path's line
    assert.equal(ed.selection, 'a1', `${tool}: the line can be clicked too`);
  }
});

test('clicking again on the same electrode picks the next action below', () => {
  const ed = standard();
  put(ed, 1, [[9]]);
  put(ed, 1, [[9, 10]]);
  ed.setTool('select');
  click(ed, 9);
  assert.equal(ed.selection, 'a2', 'the latest first');
  click(ed, 9);
  assert.equal(ed.selection, 'a1');
  click(ed, 9);
  assert.equal(ed.selection, 'a2');
  assert.equal(ed.escape(), 'deselected');
  assert.equal(ed.selection, null);
});

test('paths are added on top of what their frames already hold', () => {
  const ed = standard();
  put(ed, 2, [[120]]);
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
  assert.deepEqual(ed.pointerUp(), { kind: 'path', from: 198, to: 200, steps: 2, extended: false });
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
  assert.deepEqual(pointsOf(byType(ed, 'path')[0]), [8, 11]);
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

// --- reshaping lines and moving actions ------------------------------------------------------

// Dispense from the upper-left reservoir, a path to (3,3), a 2 x 2 circle mix there, and a path
// on to (8,3): all linked, one droplet.
const { BUILT_IN } = require('../js/templates.js');
const builtIn = (id) => BUILT_IN.find((t) => t.id === id);
function chain() {
  const ed = standard();
  ed.pointerDown(-29, -5); // upper-left reservoir: frames 1-6, ends on 9
  drag(ed, 9, E(3, 1), E(3, 3));
  ed.pointerUp();
  ed.startPlacement(builtIn('circle-2x2'));
  ed.hoverPlacement(...at(E(3, 3)));
  ed.dropPlacement();
  drag(ed, E(3, 3), E(8, 3));
  ed.pointerUp();
  ed.setTool('select');
  return ed;
}
const named = (ed, name) => ed.project.actions.find((a) => a.name === name);
const spanOf = (ed, name) => {
  const s = ed.span(named(ed, name).id);
  return [s.from, s.to];
};

test('a chain of actions: each linked after the one before, one droplet', () => {
  const ed = chain();
  const [d, p1, mix, p2] = ed.project.actions;
  assert.deepEqual(ed.project.actions.map((a) => a.type), ['dispense', 'path', 'template', 'path']);
  assert.equal(p1.after, d.id);
  assert.equal(mix.after, p1.id);
  assert.equal(p2.after, mix.id);
  assert.ok(ed.project.actions.every((a) => a.droplet === 'Droplet 1'));
  assert.deepEqual([spanOf(ed, 'Path 1'), spanOf(ed, mix.name), spanOf(ed, 'Path 2')], [[6, 10], [10, 22], [22, 27]]);
  assert.deepEqual(ed.compiled.issues, []);
});

test('dragging a piece of a line sideways re-routes it; the ends stay', () => {
  const ed = chain();
  ed.select(named(ed, 'Path 1').id);
  ed.pointerDown(...at(E(2, 1))); // on the piece from 9 to (3,1)
  ed.pointerMove(...at(E(2, 2)));
  assert.ok(ed.edit.preview.valid);
  assert.equal(onIn(ed, 7).length, 1, 'nothing changes until the button is released');
  assert.deepEqual(ed.pointerUp(), { kind: 'edit', name: 'Path 1', reshaped: true });
  assert.deepEqual(pointsOf(named(ed, 'Path 1')), [9, E(1, 2), E(3, 2), E(3, 3)]);
  assert.deepEqual(framesFrom(ed, 6, 5).map((f) => f.filter((e) => e >= 8)), [[9], [10], [18], [26], [27]]);
  assert.ok(ed.undo());
  assert.deepEqual(pointsOf(named(ed, 'Path 1')), [9, E(3, 1), E(3, 3)]);
});

test('a longer line moves what is linked after it later; dragging a corner or an end', () => {
  const ed = chain();
  ed.select(named(ed, 'Path 1').id);
  ed.pointerDown(...at(E(3, 1))); // the corner
  ed.pointerMove(...at(E(5, 1)));
  ed.pointerUp();
  assert.deepEqual(pointsOf(named(ed, 'Path 1')), [9, E(5, 1), E(5, 3), E(3, 3)], 'corner moved, the end stays with a connecting piece');
  assert.deepEqual(spanOf(ed, 'Path 1'), [6, 14], '4 steps longer');
  assert.deepEqual(spanOf(ed, 'Circle mix 2×2, 3 rounds'), [14, 26], 'the mixer follows in time');
  assert.deepEqual(spanOf(ed, 'Path 2'), [26, 31]);

  ed.select(named(ed, 'Path 2').id);
  ed.pointerDown(...at(E(8, 3))); // its end
  ed.pointerMove(...at(E(8, 6)));
  ed.pointerUp();
  assert.deepEqual(pointsOf(named(ed, 'Path 2')), [E(3, 3), E(8, 3), E(8, 6)]);
});

test('moving a mixer: the path coming in and the path going out follow it', () => {
  const ed = chain();
  const mix = named(ed, 'Circle mix 2×2, 3 rounds');
  ed.frame = 11; // the mixer's droplet is on (4,3)
  click(ed, E(4, 3));
  assert.equal(ed.selection, mix.id);
  ed.pointerDown(...at(E(4, 3)));
  ed.pointerMove(...at(E(6, 3)));
  assert.deepEqual(ed.edit.attached, { incoming: [named(ed, 'Path 1').id], outgoing: [named(ed, 'Path 2').id] });
  ed.pointerUp();
  assert.equal(ed.action(mix.id).at, E(5, 3));
  assert.deepEqual(pointsOf(named(ed, 'Path 1')), [9, E(5, 1), E(5, 3)]);
  assert.deepEqual(pointsOf(named(ed, 'Path 2')), [E(5, 3), E(8, 3)]);
  assert.deepEqual([spanOf(ed, 'Path 1'), spanOf(ed, mix.name), spanOf(ed, 'Path 2')], [[6, 12], [12, 24], [24, 27]]);
  assert.deepEqual(ed.compiled.issues, []);
});

test('a move that doesn’t fit shows red and changes nothing', () => {
  const ed = chain();
  const mix = named(ed, 'Circle mix 2×2, 3 rounds');
  ed.frame = 11;
  click(ed, E(4, 3));
  const before = ed.state();
  ed.pointerDown(...at(E(4, 3)));
  ed.pointerMove(...at(E(14, 7))); // the mixer would hang off the bottom-right corner
  assert.equal(ed.edit.preview.valid, false);
  assert.equal(ed.pointerUp(), null);
  assert.match(ed.notice, /can't go there|doesn't fit|off the array/);
  assert.equal(ed.state(), before);
  assert.equal(mix.at, E(3, 3));
});

test('a dispense stays at its reservoir', () => {
  const ed = chain();
  ed.frame = 2;
  click(ed, 3);
  assert.equal(ed.selected.type, 'dispense');
  ed.pointerDown(...at(3));
  ed.pointerMove(...at(E(2, 2)));
  ed.pointerUp();
  assert.match(ed.notice, /stays at its reservoir/);
  assert.equal(ed.nudge(1, 0), false);
});

test('Shift+drag and ⌥/Alt + arrows move a whole path; a moved path no longer starts where it should', () => {
  const ed = chain();
  const id = named(ed, 'Path 2').id;
  ed.select(id);
  ed.pointerDown(...at(E(6, 3)), { shift: true });
  ed.pointerMove(...at(E(6, 5)));
  ed.pointerUp();
  assert.deepEqual(pointsOf(ed.action(id)), [E(3, 5), E(8, 5)]);
  assert.ok(ed.compiled.issues.some((i) => i.kind === 'jump' && i.id === id), 'the droplet would jump');
  assert.ok(ed.nudge(0, -1));
  assert.ok(ed.nudge(0, -1));
  assert.deepEqual(pointsOf(ed.action(id)), [E(3, 3), E(8, 3)]);
  assert.ok(!ed.compiled.issues.some((i) => i.kind === 'jump'));
});

test('double-click adds a point to a piece, and removes a point the line doesn’t need', () => {
  const ed = standard();
  drag(ed, 8, 72);
  ed.pointerUp();
  const path = () => byType(ed, 'path')[0];
  assert.ok(ed.doubleClick(...at(40)));
  assert.deepEqual(pointsOf(path()), [8, 40, 72]);
  ed.setTool('select');
  ed.pointerDown(...at(56)); // the piece after the new point
  ed.pointerMove(...at(58));
  ed.pointerUp();
  assert.deepEqual(pointsOf(path()), [8, 40, 42, 74, 72], 'only the part after the point moved');
  assert.equal(ed.doubleClick(...at(42)), false, "a corner can't go");
  assert.ok(ed.doubleClick(...at(40)) === false, "nor can one where the line turns");
});

test('deleting an action: the ones after it keep their frames', () => {
  const ed = chain();
  const mix = named(ed, 'Circle mix 2×2, 3 rounds');
  ed.select(named(ed, 'Path 1').id);
  assert.ok(ed.deleteSelected());
  assert.equal(mix.after, undefined);
  assert.equal(mix.start, 10);
  assert.deepEqual(spanOf(ed, mix.name), [10, 22]);
  assert.equal(ed.selection, null);
});

test('names and droplet names; a droplet name carries down the chain', () => {
  const ed = chain();
  const p1 = named(ed, 'Path 1');
  ed.rename(p1.id, '  Sample to mixer ');
  assert.equal(p1.name, 'Sample to mixer');
  ed.setDroplet(p1.id, 'Sample');
  assert.deepEqual(ed.project.actions.map((a) => a.droplet), ['Droplet 1', 'Sample', 'Sample', 'Sample']);
  ed.undo();
  assert.deepEqual(ed.project.actions.map((a) => a.droplet), ['Droplet 1', 'Droplet 1', 'Droplet 1', 'Droplet 1']);
});

// --- undo ----------------------------------------------------------------------------------------

test('undo and redo go back and forth, each to the frame the change was made in', () => {
  const ed = standard();
  assert.ok(!ed.canUndo && !ed.canRedo);
  paintClick(ed, 9);
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
  paintClick(ed, 40); // a new change: the undone path can't be redone any more
  assert.ok(!ed.canRedo);
});

test('each change is one undo step: paint, Shift+click, drags, buttons, reservoirs, opening', () => {
  const ed = standard();
  const changes = [
    () => paintClick(ed, 9),
    () => paintClick(ed, 17, { shift: true }),
    () => {
      ed.setTool('paint');
      drag(ed, 10, 106);
      ed.pointerUp();
    },
    () => ed.pointerDown(35, 5), // copy last frame into frame 2
    () => ed.pointerDown(35, 8), // clear frame
    () => ed.pointerDown(29, -5), // upper-right reservoir: frames 2-7
    () => {
      ed.setTool('freehand');
      drag(ed, 113, 115);
      ed.pointerUp();
    },
    () => {
      const loaded = new Sequence();
      loaded.set(50, 4, true);
      ed.openSequence(loaded);
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
  click(ed, 9); // selects nothing
  assert.ok(!ed.canUndo);
});

test('undo during a drag only cancels the drag', () => {
  const ed = standard();
  paintClick(ed, 40);
  drag(ed, 8, 24);
  assert.ok(ed.undo());
  assert.equal(ed.draft, null);
  assert.deepEqual(onIn(ed, 1), [40], 'the earlier change is kept');
  assert.ok(ed.canUndo);
});

test(`undo keeps the last ${UNDO_LIMIT} changes`, () => {
  const ed = standard();
  for (let i = 0; i < UNDO_LIMIT + 5; i++) paintClick(ed, 9);
  let undone = 0;
  while (ed.undo()) undone++;
  assert.equal(undone, UNDO_LIMIT);
});

test('the switch on the left picks the drag tool, with undo and redo buttons below it', () => {
  const ed = standard();
  assert.equal(ed.pointerDown(-42, -5), 'toolStraight');
  assert.equal(ed.tool, 'straight');
  assert.equal(ed.pointerDown(-38, 1), 'toolSelect'); // on the label
  assert.equal(ed.tool, 'select');
  assert.equal(ed.pointerDown(-42, -8), 'toolFreehand');
  assert.equal(ed.tool, 'freehand');
  ed.setTool('nonsense');
  assert.equal(ed.tool, 'freehand');
  assert.equal(ed.pointerDown(-38, -2), 'toolPaint');
  assert.equal(ed.tool, 'paint');

  click(ed, 9);
  assert.equal(ed.pointerDown(-42, 5), 'undo');
  assert.deepEqual(onIn(ed, 1), []);
  assert.equal(ed.pointerDown(-42, 8), 'redo');
  assert.deepEqual(onIn(ed, 1), [9]);
});

// --- templates and timing ----------------------------------------------------------------------

test('dragging a template shows where it lands; dropping adds it and moves to its end', () => {
  const ed = standard();
  put(ed, 3, [[60]]); // something already in the frames it covers
  ed.frame = 2;
  ed.startPlacement(builtIn('circle-2x2'));
  ed.hoverPlacement(...at(17)); // column 2, row 1
  assert.ok(ed.placement.spot.valid);
  assert.equal(ed.seq.lastFrame(), 3, 'nothing added yet');
  assert.deepEqual(ed.dropPlacement(), { from: 2, to: 14, steps: 12 });
  assert.deepEqual(framesFrom(ed, 2, 5), [[17], [25, 60], [26], [18], [17]], 'added on top of what was there');
  assert.equal(ed.frame, 14);
  assert.equal(ed.placement, null);
  const t = byType(ed, 'template')[0];
  assert.deepEqual([t.template, t.at, t.turns], ['circle-2x2', 17, 0]);
  assert.deepEqual(ed.project.templates['circle-2x2'].frames, builtIn('circle-2x2').frames, 'a copy goes into the project');
  ed.undo();
  assert.equal(ed.seq.lastFrame(), 3);
  assert.equal(ed.frame, 2);
});

test('a template can be turned, does nothing where it does not fit, and Esc drops it', () => {
  const ed = standard();
  ed.startPlacement(builtIn('split'));
  ed.hoverPlacement(...at(44)); // column 5, row 4
  ed.rotatePlacement();
  assert.deepEqual(ed.placement.spot.frames[2], [43, 45]);
  ed.hoverPlacement(...at(119)); // bottom-right corner: a split can't go there
  assert.equal(ed.placement.spot.valid, false);
  assert.equal(ed.dropPlacement(), null);
  assert.equal(ed.seq.lastFrame(), 1);
  assert.ok(!ed.canUndo);

  ed.startPlacement(builtIn('merge'));
  ed.hoverPlacement(0, 14); // off the array
  assert.equal(ed.placement.spot, null);
  assert.equal(ed.cancel(), true);
  assert.equal(ed.placement, null);
});

test('templates with frame times bring them along', () => {
  const ed = standard();
  ed.startPlacement({ name: 'hold', frames: [[[0, 0]], [[1, 0]]], times: [0, 4000] });
  ed.hoverPlacement(...at(9));
  ed.dropPlacement();
  assert.equal(ed.seq.timeOf(1), 500);
  assert.equal(ed.seq.timeOf(2), 4000);
});

test('making a template sets the project aside, with its frame and undo history', () => {
  const ed = standard();
  paintClick(ed, 9);
  ed.frame = 4;
  ed.startTemplate();
  assert.ok(ed.makingTemplate);
  assert.equal(ed.frame, 1);
  assert.equal(ed.seq.lastFrame(), 1);
  assert.ok(!ed.canUndo, 'a fresh history for the template');
  drag(ed, 40, 56);
  ed.pointerUp();
  ed.setDefaultTime(300);
  assert.deepEqual(onIn(ed, 3), [56]);
  ed.endTemplate();
  assert.ok(!ed.makingTemplate);
  assert.equal(ed.frame, 4);
  assert.deepEqual(onIn(ed, 1), [9]);
  assert.equal(ed.seq.lastFrame(), 1);
  assert.equal(ed.seq.frameTime, 300, 'the default frame time is a setting and stays');
  assert.ok(ed.undo());
  assert.deepEqual(onIn(ed, 1), [], 'the project keeps its own undo history');
});

test('changing a template: it comes in as a selected pattern that paint edits', () => {
  const ed = standard();
  const seq = new Sequence();
  seq.set(20, 1, true);
  seq.set(28, 2, true);
  ed.startTemplate(seq);
  assert.equal(ed.selected.type, 'pattern');
  ed.setTool('paint');
  ed.frame = 2;
  click(ed, 29);
  assert.deepEqual(onIn(ed, 2), [28, 29]);
  assert.equal(ed.project.actions.length, 1, 'painted into the template, not beside it');
});

test('playback holds each frame for its own time', () => {
  const ed = standard();
  put(ed, 1, [[9], [], [9]], { times: [0, 2000, 0] });
  ed.togglePlay(0);
  assert.equal(ed.tick(501), true);
  assert.equal(ed.frame, 2);
  assert.equal(ed.tick(2000), false, 'frame 2 lasts 2 s');
  assert.equal(ed.tick(2502), true);
  assert.equal(ed.frame, 3);
});

test("a frame's own time goes on what runs in it and is undoable; the default is a setting", () => {
  const ed = standard();
  put(ed, 1, [[9], [9], [9], [9]]);
  assert.deepEqual(ed.setFrameTime(6, 1500), [], 'nothing runs in frame 6');
  ed.setFrameTime(3, 1500);
  assert.equal(ed.seq.timeOf(3), 1500);
  assert.deepEqual(ed.project.actions[0].times, [0, 0, 1500, 0]);
  ed.setDefaultTime(250);
  assert.ok(ed.undo());
  assert.equal(ed.seq.timeOf(3), 250, 'back to the default, which stays at 250');
  assert.ok(!ed.canUndo);
  assert.equal(ed.speed, 240, 'shown as 240 frames/min');
});

test('on a path, a frame time is a wait at the electrode the droplet is on', () => {
  const ed = standard();
  drag(ed, 8, 40);
  ed.pointerUp();
  const path = () => byType(ed, 'path')[0];
  ed.setFrameTime(3, 5000); // the droplet is on 24
  assert.deepEqual(path().points, [{ e: 8 }, { e: 24, wait: 5000 }, { e: 40 }]);
  assert.equal(ed.seq.timeOf(3), 5000);
  ed.setTool('select');
  ed.pointerDown(...at(32)); // reshaping elsewhere keeps the wait on its electrode
  ed.pointerMove(...at(34));
  ed.pointerUp();
  assert.deepEqual(pointsOf(path()), [8, 24, 26, 42, 40]);
  assert.deepEqual(path().points.find((p) => p.wait), { e: 24, wait: 5000 });
  ed.setFrameTime(3, 0);
  assert.ok(!path().points.some((p) => p.wait));
  ed.setStepTime(path().id, 800);
  assert.equal(ed.seq.timeOf(2), 800);
});

test('a long step makes the others wait, unless it lets them keep moving (split)', () => {
  const ed = standard();
  put(ed, 1, [[9]], { times: [5000], name: 'Incubate' });
  drag(ed, 100, 102); // another droplet moving at the same time, frames 1-3
  ed.pointerUp();
  const wait = ed.compiled.issues.find((i) => i.kind === 'waits');
  assert.deepEqual([wait.id, wait.frame, wait.ids], ['a1', 1, ['a2']]);
  assert.equal(ed.seq.timeOf(1), 5000);
  assert.ok(ed.setSplit('a1', true));
  assert.ok(!ed.compiled.issues.some((i) => i.kind === 'waits'));
  assert.deepEqual([1, 2, 3, 4].map((f) => ed.seq.timeOf(f)), [500, 500, 500, 3500], 'the path moves on while the hold lasts 5 s');
  assert.deepEqual([1, 2, 3, 4].map((f) => onIn(ed, f).includes(9)), [true, true, true, true]);
  ed.undo();
  assert.ok(ed.compiled.issues.some((i) => i.kind === 'waits'));
});
