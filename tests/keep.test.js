'use strict';
// Keeping the work between visits: what the editor hands over to be stored, and taking it up
// again in a fresh editor, as after a page reload.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Editor, UNDO_LIMIT } = require('../js/editor.js');
const { getLayout } = require('../js/layout.js');
const { electrodeGraph } = require('../js/paths.js');

const lay = getLayout('electrodes');
const { centres } = electrodeGraph(lay.rects);
const at = (e) => [centres.get(e).x, centres.get(e).y];
const E = (column, row) => column * 8 + row;
const drag = (ed, ...cells) => {
  ed.pointerDown(...at(cells[0]));
  for (const e of cells.slice(1)) ed.pointerMove(...at(e));
  return ed.pointerUp();
};
// Through JSON and back, as the browser's storage does it.
const reload = (ed, history) => {
  const fresh = new Editor(lay);
  const warnings = fresh.resume(JSON.parse(JSON.stringify(ed.snapshot(history))));
  return { fresh, warnings };
};

function twoPaths() {
  const ed = new Editor(lay);
  drag(ed, E(2, 2), E(6, 2));
  ed.escape();
  ed.frame = 1;
  drag(ed, E(2, 6), E(6, 6), E(6, 4));
  ed.setStepTime(ed.selection, 800);
  ed.setDefaultTime(400);
  return ed;
}

test('the project comes back with its frame, selection, frame times and undo history', () => {
  const ed = twoPaths();
  ed.frame = 3;
  ed.undo(); // the step time again
  const { fresh, warnings } = reload(ed);
  assert.deepEqual(warnings, []);
  assert.equal(fresh.state(), ed.state());
  assert.equal(fresh.frame, ed.frame);
  assert.equal(fresh.selection, ed.selection);
  assert.equal(fresh.project.frameTime, 400);
  assert.equal(fresh.seq.lastFrame(), ed.seq.lastFrame());
  assert.ok(fresh.canUndo && fresh.canRedo);
  assert.ok(fresh.redo(), 'redo works after the reload');
  assert.equal(fresh.action(fresh.selection).stepTime, 800);
  while (fresh.undo());
  assert.equal(fresh.project.actions.length, 0, 'undo goes all the way back');
});

test('less undo history can be kept; none at all still keeps the project', () => {
  const ed = twoPaths();
  assert.equal(reload(ed, 1).fresh.undoStack.length, 1);
  const { fresh } = reload(ed, 0);
  assert.equal(fresh.state(), ed.state());
  assert.ok(!fresh.canUndo);
  assert.equal(ed.snapshot().undo.length, ed.undoStack.length);
  assert.ok(ed.undoStack.length <= UNDO_LIMIT);
});

test('a template being made comes back, with the project set aside behind it', () => {
  const ed = twoPaths();
  const main = ed.state();
  ed.startTemplate();
  drag(ed, E(4, 3), E(5, 3), E(5, 4));
  const { fresh } = reload(ed);
  assert.ok(fresh.makingTemplate);
  assert.equal(fresh.project.actions.length, 1, 'the template drawn so far');
  assert.ok(fresh.canUndo, 'its own undo history');
  fresh.endTemplate();
  assert.equal(fresh.state(), main, 'the project behind it is as it was');
  assert.equal(fresh.project.actions.length, 2);
});

test('anything malformed is cleaned up or left out; no project at all is refused', () => {
  const ed = twoPaths();
  const data = JSON.parse(JSON.stringify(ed.snapshot()));
  data.frame = 999;
  data.selection = 'a77';
  data.undo.push({ state: 'not json', frame: 1 }, { frame: 2 }, null);
  data.project.actions.push({ id: 'a9', type: 'path', name: 'Broken', points: [] });
  const fresh = new Editor(lay);
  const warnings = fresh.resume(data);
  assert.equal(fresh.frame, 999);
  assert.equal(fresh.selection, null);
  assert.equal(fresh.undoStack.length, ed.undoStack.length, 'the broken undo steps are left out');
  assert.equal(fresh.project.actions.length, 2);
  assert.match(warnings.join(' '), /Broken/);
  assert.throws(() => new Editor(lay).resume(null));
  assert.throws(() => new Editor(lay).resume({ project: { something: 'else' } }));
});
