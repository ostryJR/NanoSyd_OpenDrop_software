'use strict';
// The process on the board: each stretch (the steps between two stops) has its own board and
// timeline, starts with the droplets the stretch before left, and its actions belong to tiles.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Editor } = require('../js/editor.js');
const { getLayout } = require('../js/layout.js');
const { electrodeGraph } = require('../js/paths.js');
const { compile } = require('../js/compile.js');
const P = require('../js/process.js');
const S = require('../js/stretch.js');
const projects = require('../js/project.js');

const lay = getLayout('electrodes');
const { centres } = electrodeGraph(lay.rects);
const at = (e) => [centres.get(e).x, centres.get(e).y];
const E = (column, row) => column * 8 + row;
const drag = (ed, ...cells) => {
  ed.pointerDown(...at(cells[0]));
  for (const e of cells.slice(1)) ed.pointerMove(...at(e));
  return ed.pointerUp();
};

// Start, dispense, move to (3,3), mix there, measure conc, and mix again until conc < 5.
function dilution() {
  const ed = new Editor(lay);
  ed.makeProcess();
  const ids = {};
  ed.processChange((p) => {
    p.tiles = [];
    p.links = [];
    for (const [key, kind, fields] of [
      ['start', 'start'], ['dispense', 'dispense', { reservoir: 'reservoirLeftTop' }], ['move', 'move'],
      ['mix', 'mix'], ['measure', 'measure', { value: 'conc', unit: 'mM' }],
      ['decision', 'decision', { value: 'conc', op: '<', than: 5 }], ['end', 'end'],
    ]) ids[key] = P.addTile(p, kind, 0, 0, fields || {}).id;
    const l = (a, port, b) => P.link(p, ids[a], port, ids[b]);
    l('start', 'next', 'dispense');
    l('dispense', 'next', 'move');
    l('move', 'next', 'mix');
    l('mix', 'next', 'measure');
    l('measure', 'next', 'decision');
    l('decision', 'yes', 'end');
    l('decision', 'no', 'mix');
  });
  return { ed, ids };
}

// The dilution loop with its work placed: dispense, a path to (3,3), the mixer there.
function placed() {
  const { ed, ids } = dilution();
  assert.ok(ed.openTile(ids.dispense));
  assert.equal(ed.placeTile().kind, 'added');
  assert.ok(ed.openTile(ids.move));
  assert.equal(ed.placeTile().kind, 'draw');
  ed.frame = 6;
  drag(ed, 9, E(3, 1), E(3, 3));
  assert.ok(ed.openTile(ids.mix));
  assert.equal(ed.placeTile().kind, 'placing');
  ed.hoverPlacement(...at(E(3, 3)));
  assert.ok(ed.dropPlacement());
  return { ed, ids };
}

test('a project gets a process: Start, one step with everything so far, End; the board is as it was', () => {
  const ed = new Editor(lay);
  drag(ed, E(2, 2), E(6, 2));
  const frames = ed.seq.lastFrame();
  assert.ok(ed.makeProcess());
  assert.deepEqual(ed.doc.process.tiles.map((t) => t.kind), ['start', 'step', 'end']);
  assert.ok(ed.doc.actions.every((a) => a.tile === ed.doc.process.tiles[1].id));
  assert.equal(ed.scope.tile, ed.doc.process.tiles[1].id, 'its step is open');
  assert.equal(ed.seq.lastFrame(), frames);
  assert.ok(!ed.makeProcess(), 'only once');
});

test('each tile’s work goes on its stretch; the next stretch starts with the droplet where it was left', () => {
  const { ed, ids } = placed();
  const doc = ed.doc;
  const tileOf = (type) => doc.actions.filter((a) => a.type === type).map((a) => a.tile);
  assert.deepEqual(tileOf('dispense'), [ids.dispense]);
  assert.deepEqual(tileOf('path'), [ids.move]);
  assert.deepEqual(tileOf('template'), [ids.mix]);
  const path = doc.actions.find((a) => a.type === 'path');
  assert.equal(path.after, doc.actions.find((a) => a.type === 'dispense').id, 'the move follows the dispense');

  // The mixer's stretch starts with Droplet 1 on (3,3), and the mixer carries on from it.
  assert.deepEqual(ed.arrive.map((a) => [a.droplet, a.cells]), [['Droplet 1', [E(3, 3)]]]);
  const mix = doc.actions.find((a) => a.type === 'template');
  assert.equal(mix.after, 'in:Droplet 1');
  assert.equal(mix.droplet, 'Droplet 1');
  assert.deepEqual(ed.span(mix.id), { from: 1, to: 13 }, 'from frame 1 of its own timeline');
  assert.equal(ed.seq.get(E(3, 3), 1), true);

  const info = ed.analyze();
  assert.deepEqual(info.st.list.map((s) => s.tiles), [[ids.dispense, ids.move], [ids.mix]]);
  const t = info.tile.get(ids.move);
  assert.deepEqual([t.from, t.to, t.placed, t.problems], [6, 10, true, []]);
  assert.deepEqual(info.tile.get(ids.mix).problems, [], 'the loop brings the droplet back where it was');
  assert.deepEqual(info.stretch.get(ids.mix).compiled.left, [{ droplet: 'Droplet 1', cells: [E(3, 3)] }]);
});

test('arrivals: they switch nothing on, can’t be touched by other droplets, and can’t be selected', () => {
  const { ed } = placed();
  ed.frame = 1;
  ed.setTool('freehand');
  ed.escape();
  drag(ed, E(7, 6), E(9, 6)); // well away from the mixer on (3,3)-(4,4)
  assert.ok(ed.doc.actions.some((a) => a.type === 'path' && a.points[0].e === E(7, 6)), `far enough away: ${ed.notice}`);
  ed.undo();
  drag(ed, E(2, 5), E(2, 4)); // ends diagonally next to Droplet 1's mixer on (3,3)
  assert.match(ed.notice || '', /would touch/);
  ed.selection = null;
  ed.clickSelect(E(3, 3));
  assert.notEqual(ed.selected && ed.selected.type, 'arrive');

  // Without the mixer the droplet just waits there: nothing switched on, a ring on the board.
  const compiled = compile({ ...ed.project, actions: [] }, lay.rects, { arrive: ed.arrive });
  assert.equal(compiled.seq.get(E(3, 3), 1), false);
  assert.deepEqual(compiled.left, [{ droplet: 'Droplet 1', cells: [E(3, 3)] }]);
});

test('a wait holds its own lane for its time while the other droplet keeps moving', () => {
  const project = projects.newProject();
  project.actions = [
    { id: 'a1', type: 'path', name: 'A', droplet: 'A', start: 1, points: [{ e: E(2, 1) }, { e: E(4, 1) }] },
    { id: 'a2', type: 'wait', name: 'Hold', droplet: '', after: 'a1', duration: 2000 },
    { id: 'a3', type: 'path', name: 'A on', droplet: 'A', after: 'a2', points: [{ e: E(4, 1) }, { e: E(6, 1) }] },
    { id: 'b1', type: 'path', name: 'B', droplet: 'B', start: 1, points: [{ e: E(2, 6) }, { e: E(12, 6) }] },
  ];
  const c = compile(project, lay.rects);
  assert.deepEqual([c.spans.get('a1'), c.spans.get('a2')], [{ from: 1, to: 3 }, { from: 3, to: 6 }]);
  assert.equal(c.spans.get('a3').from, 6, 'A goes on once 2 s have gone by (frames of 0.5 s)');
  assert.deepEqual(c.spans.get('b1'), { from: 1, to: 11 }, 'B never waited');
  assert.equal(c.seq.elapsed(5) - c.seq.elapsed(2), 1500);
});

test('the board’s order is checked against the process; droplets arriving differently are a problem', () => {
  const { ed, ids } = placed();
  // Move the path to start before the dispense ends.
  ed.openTile(ids.move);
  const path = ed.project.actions.find((a) => a.type === 'path');
  ed.change(() => {
    delete path.after;
    path.start = 2;
  }, { check: false });
  let info = ed.analyze();
  assert.ok(info.tile.get(ids.move).problems.some((p) => /before “Dispense” ends/.test(p)), info.tile.get(ids.move).problems.join('; '));
  ed.undo();

  // A mixer that leaves the droplet one column on: the next round finds it elsewhere.
  ed.openTile(ids.mix);
  const mix = ed.project.actions.find((a) => a.type === 'template');
  const shifted = projects.newProject();
  void shifted;
  ed.change(() => {
    ed.project.actions.push({ id: 'a99', type: 'path', name: 'Off', droplet: 'Droplet 1', tile: ids.mix, after: mix.id, points: [{ e: E(3, 3) }, { e: E(4, 3) }] });
  });
  info = ed.analyze();
  assert.ok(info.tile.get(ids.mix).problems.some((p) => /the droplets are elsewhere/.test(p)));
});

test('new actions follow the tiles before them; the board can’t be changed with no step open', () => {
  const { ed, ids } = dilution();
  ed.openTile(ids.dispense);
  ed.placeTile();
  // A Step tile added between the move and the mixer, in the same stretch.
  let step;
  ed.processChange((p) => {
    step = P.addTile(p, 'step', 0, 0);
    P.link(p, ids.move, 'next', step.id);
    P.link(p, step.id, 'next', ids.mix);
  });
  ed.openTile(ids.move);
  ed.frame = 6;
  drag(ed, 9, E(3, 1));
  ed.openTile(step.id);
  ed.frame = 1; // drawn earlier on screen, but it can only start once the move has ended
  ed.escape();
  drag(ed, E(3, 1), E(3, 2));
  const mine = ed.doc.actions.find((a) => a.tile === step.id);
  const move = ed.doc.actions.find((a) => a.tile === ids.move);
  assert.equal(mine.after, move.id);
  assert.ok(ed.span(mine.id).from >= ed.span(move.id).to);

  // A process with nothing to show yet: drawing says to open a step first.
  const empty = new Editor(lay);
  empty.makeProcess();
  empty.processChange((p) => {
    P.removeTile(p, p.tiles[1].id);
  });
  assert.equal(empty.scope.tile, null);
  drag(empty, E(2, 2), E(4, 2));
  assert.match(empty.notice, /Open a step of the process first/);
  assert.equal(empty.doc.actions.length, 0);
});

test('process edits are undone like drawing; removing a tile takes its actions, undo brings them back', () => {
  const { ed, ids } = placed();
  const before = ed.doc.actions.length;
  assert.ok(ed.removeTile(ids.mix));
  assert.equal(ed.doc.actions.length, before - 1);
  assert.ok(!ed.doc.process.tiles.some((t) => t.id === ids.mix));
  assert.ok(ed.undo());
  assert.ok(ed.doc.process.tiles.some((t) => t.id === ids.mix));
  assert.equal(ed.doc.actions.length, before);
  ed.processChange((p) => P.moveTile(p, ids.end, 400, 600));
  ed.undo();
  assert.notEqual(P.tileById(ed.doc.process, ids.end).x, 400);
  assert.ok(ed.redo());
  assert.equal(P.tileById(ed.doc.process, ids.end).x, 400);
});

test('a wait tile adds its hold; the work is kept with the open tile between visits; a run shows a stretch', () => {
  const { ed, ids } = placed();
  let wait;
  ed.processChange((p) => {
    wait = P.addTile(p, 'wait', 0, 0, { seconds: 3 });
    P.link(p, ids.move, 'next', wait.id);
    P.link(p, wait.id, 'next', ids.mix);
  });
  ed.openTile(wait.id);
  assert.equal(ed.placeTile().kind, 'added');
  const hold = ed.doc.actions.find((a) => a.type === 'wait');
  assert.deepEqual([hold.tile, hold.duration, hold.after], [wait.id, 3000, ed.doc.actions.find((a) => a.type === 'path').id]);

  const again = new Editor(lay);
  again.resume(JSON.parse(JSON.stringify(ed.snapshot())));
  assert.equal(again.scope.tile, wait.id);
  assert.equal(again.doc.actions.length, ed.doc.actions.length);
  assert.ok(again.canUndo);

  const info = ed.analyze();
  const mixStretch = info.st.of.get(ids.mix);
  assert.ok(ed.showStretch(mixStretch, [{ droplet: 'Droplet 1', cells: [E(3, 3)] }]));
  assert.equal(ed.scope.stretch, mixStretch);
  assert.equal(ed.seq.lastFrame(), 13);
});

// Two lanes on one board: each dispenses and moves a droplet; the merge puts them together.
// `join`: the lanes end in a Wait for all before the merge, else they go straight into it.
function lanes(join) {
  const ed = new Editor(lay);
  ed.makeProcess();
  const ids = {};
  const end = join ? 'join' : 'merge';
  ed.processChange((p) => {
    p.tiles = [];
    p.links = [];
    for (const [key, kind, fields] of [
      ['start', 'start'], ['par', 'parallel'], ['dA', 'dispense', { reservoir: 'reservoirLeftTop' }], ['mA', 'move'],
      ['dB', 'dispense', { reservoir: 'reservoirLeftBottom' }], ['mB', 'move'], ...(join ? [['join', 'join']] : []), ['merge', 'merge'], ['end', 'end'],
    ]) ids[key] = P.addTile(p, kind, 0, 0, fields || {}).id;
    for (const [a, port, b] of [
      ['start', 'next', 'par'], ['par', 'lane1', 'dA'], ['dA', 'next', 'mA'], ['mA', 'next', end],
      ['par', 'lane2', 'dB'], ['dB', 'next', 'mB'], ['mB', 'next', end], ...(join ? [['join', 'next', 'merge']] : []), ['merge', 'next', 'end'],
    ]) P.link(p, ids[a], port, ids[b]);
  });
  return { ed, ids };
}

test('parallel lanes share one board: both dispense at once; the lanes go into the merge, which waits for both', () => {
  const { ed, ids } = lanes(false);
  assert.deepEqual(P.check(ed.doc.process), []);
  assert.equal(P.inputsOf(P.tileById(ed.doc.process, ids.merge), ed.doc.process), 2);
  placeLanes(ed, ids);
});

test('with a Wait for all before the merge it works the same; a hint says it isn’t needed', () => {
  const { ed, ids } = lanes(true);
  assert.deepEqual(P.check(ed.doc.process).map((i) => [i.tile, i.level]), [[ids.join, 'warn']]);
  placeLanes(ed, ids);
});

// Places the lanes' work, and the merge where both droplets meet: it starts after both lanes end.
function placeLanes(ed, ids) {
  for (const lane of ['dA', 'dB']) {
    ed.openTile(ids[lane]);
    assert.equal(ed.placeTile().kind, 'added');
  }
  ed.openTile(ids.mA);
  ed.frame = 6;
  drag(ed, 9, E(5, 1), E(5, 3));
  ed.openTile(ids.mB);
  ed.frame = 6;
  ed.escape();
  drag(ed, 14, E(5, 6), E(5, 5));
  ed.openTile(ids.merge);
  assert.equal(ed.placeTile().kind, 'placing');
  ed.hoverPlacement(...at(E(5, 3)));
  assert.ok(ed.dropPlacement(), ed.notice);

  const info = ed.analyze();
  assert.equal(info.st.list.length, 1, 'one board for all of it');
  const by = (tile) => ed.doc.actions.find((a) => a.tile === ids[tile]);
  const span = (tile) => info.stretch.get(info.st.list[0].id).compiled.spans.get(by(tile).id);
  assert.equal(span('dA').from, 1);
  assert.equal(span('dB').from, 1, 'the lanes run at the same time');
  assert.deepEqual([...by('merge').after].sort(), [by('mA').id, by('mB').id].sort(), 'the merge waits for both lanes');
  assert.equal(span('merge').from, Math.max(span('mA').to, span('mB').to));
  assert.equal(by('merge').droplet, 'D1 + D2');
  for (const t of Object.values(ids)) assert.deepEqual(info.tile.get(t).problems, [], t);
}

// --- names: one per step; droplets named on the Dispense tile ---------------------------------------

const tileOf = (ed, id) => P.tileById(ed.doc.process, id);
const workOf = (ed, id) => ed.doc.actions.filter((a) => a.tile === id);

test('one name per step: a tile’s work on the board goes by the tile’s name; renaming either renames both', () => {
  const { ed, ids } = placed();
  assert.deepEqual(['dispense', 'move', 'mix'].map((k) => workOf(ed, ids[k]).map((a) => a.name)), [['Dispense'], ['Move'], ['Mix']]);

  assert.ok(ed.tileSettings(ids.dispense, { name: 'Sample in' }));
  assert.equal(workOf(ed, ids.dispense)[0].name, 'Sample in', 'renaming the tile renames its work');

  ed.openTile(ids.mix);
  const mix = workOf(ed, ids.mix)[0];
  assert.ok(ed.rename(mix.id, 'Dilute'));
  assert.equal(tileOf(ed, ids.mix).name, 'Dilute', 'renaming on the board renames the tile');
  assert.equal(workOf(ed, ids.mix)[0].name, 'Dilute');
  assert.ok(ed.namedByTile(workOf(ed, ids.mix)[0]));
  assert.ok(ed.undo());
  assert.equal(tileOf(ed, ids.mix).name, 'Mix', 'one undo takes it back');
  assert.equal(workOf(ed, ids.mix)[0].name, 'Mix');
  assert.ok(ed.compiled.issues.every((i) => !/Dilute/.test(i.text)));
});

test('a tile with two things on the board: “Move” and “Move · 2”; a Step tile’s work keeps its own names', () => {
  const ed = new Editor(lay);
  drag(ed, E(2, 2), E(6, 2)); // drawn before there was a process
  ed.rename(ed.project.actions[0].id, 'Sample to mixer');
  ed.makeProcess();
  const step = ed.doc.process.tiles.find((t) => t.kind === 'step');
  assert.equal(workOf(ed, step.id)[0].name, 'Sample to mixer', 'kept: it is in a Step tile');
  assert.ok(!ed.namedByTile(workOf(ed, step.id)[0]));
  assert.ok(ed.rename(workOf(ed, step.id)[0].id, 'To the mixer'));
  assert.equal(step.name, 'Step 1', 'a Step tile’s work is renamed on its own');
  assert.equal(workOf(ed, step.id)[0].name, 'To the mixer');

  let move = null;
  ed.processChange((p) => {
    move = P.addTile(p, 'move', 0, 300);
    P.link(p, step.id, 'next', move.id);
  });
  assert.ok(ed.openTile(move.id));
  ed.frame = 1;
  drag(ed, E(2, 6), E(5, 6));
  ed.escape();
  ed.frame = 1;
  drag(ed, E(9, 4), E(12, 4));
  assert.deepEqual(workOf(ed, move.id).map((a) => a.name), ['Move', 'Move · 2']);
  ed.tileSettings(move.id, { name: 'Away' });
  assert.deepEqual(workOf(ed, move.id).map((a) => a.name), ['Away', 'Away · 2']);
});

test('the Dispense tile names its droplet; renamed there or on the board, it is renamed down the process', () => {
  const { ed, ids } = dilution();
  assert.ok(ed.tileSettings(ids.dispense, { droplet: 'Sample' }));
  assert.equal(tileOf(ed, ids.dispense).droplet, 'Sample');
  // Placing: the dispense makes "Sample", which the move and (in the next part) the mix carry.
  ed.openTile(ids.dispense);
  ed.placeTile();
  ed.openTile(ids.move);
  ed.placeTile();
  ed.frame = 6;
  drag(ed, 9, E(3, 1), E(3, 3));
  ed.openTile(ids.mix);
  ed.placeTile();
  ed.hoverPlacement(...at(E(3, 3)));
  assert.ok(ed.dropPlacement(), ed.notice);
  const droplets = () => ['dispense', 'move', 'mix'].map((k) => workOf(ed, ids[k])[0].droplet);
  assert.deepEqual(droplets(), ['Sample', 'Sample', 'Sample']);
  assert.equal(workOf(ed, ids.mix)[0].after, 'in:Sample');

  // Renamed on the tile: everything after follows, the next part's link too.
  assert.ok(ed.tileSettings(ids.dispense, { droplet: 'Buffer' }));
  assert.deepEqual(droplets(), ['Buffer', 'Buffer', 'Buffer']);
  assert.equal(workOf(ed, ids.mix)[0].after, 'in:Buffer');
  const info = ed.analyze();
  for (const k of ['dispense', 'move', 'mix']) assert.deepEqual(info.tile.get(ids[k]).problems, [], k);
  assert.deepEqual(info.tile.get(ids.mix).droplets, ['Buffer'], 'tiles know the droplets they work on');

  // Renamed on the board, on the dispense: the tile follows.
  ed.openTile(ids.dispense);
  assert.ok(ed.setDroplet(workOf(ed, ids.dispense)[0].id, 'Water'));
  assert.equal(tileOf(ed, ids.dispense).droplet, 'Water');
  assert.deepEqual(droplets(), ['Water', 'Water', 'Water']);

  // Renamed from the move on: before it, it keeps its name.
  ed.openTile(ids.move);
  assert.ok(ed.setDroplet(workOf(ed, ids.move)[0].id, 'Diluted'));
  assert.deepEqual(droplets(), ['Water', 'Diluted', 'Diluted']);
  assert.equal(tileOf(ed, ids.dispense).droplet, 'Water');
  assert.equal(workOf(ed, ids.mix)[0].after, 'in:Diluted');
  assert.deepEqual(ed.analyze().tile.get(ids.mix).problems, []);
  assert.ok(ed.undo());
  assert.deepEqual(droplets(), ['Water', 'Water', 'Water']);
});

test('a Dispense tile with no droplet name gets a free one when placed, kept on the tile', () => {
  const { ed, ids } = dilution();
  assert.equal(ed.freeDroplet(), 'Droplet 1');
  ed.openTile(ids.dispense);
  ed.placeTile();
  assert.equal(workOf(ed, ids.dispense)[0].droplet, 'Droplet 1');
  assert.equal(tileOf(ed, ids.dispense).droplet, 'Droplet 1');
  assert.equal(ed.freeDroplet(), 'Droplet 2');
});

test('merged droplets follow a rename by their short names; two Dispense tiles of one part can’t share a name', () => {
  const { ed, ids } = lanes(false);
  placeLanes(ed, ids);
  const merge = () => workOf(ed, ids.merge)[0];
  assert.equal(merge().droplet, 'D1 + D2');
  assert.ok(ed.tileSettings(ids.dA, { droplet: 'Sample' }));
  assert.equal(workOf(ed, ids.mA)[0].droplet, 'Sample');
  assert.equal(merge().droplet, 'Sample + D2');
  assert.ok(ed.tileSettings(ids.dB, { droplet: 'Sample' }));
  const warned = P.check(ed.doc.process).filter((i) => /also makes “Sample”/.test(i.text)).map((i) => i.tile).sort();
  assert.deepEqual(warned, [ids.dA, ids.dB].sort());
});
