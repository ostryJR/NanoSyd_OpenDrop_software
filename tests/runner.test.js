'use strict';
// Running the process: stretch by stretch on the board, asking at Measure, choosing at decisions,
// round the loop until the value holds.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Editor } = require('../js/editor.js');
const { Runner } = require('../js/runner.js');
const { getLayout } = require('../js/layout.js');
const { electrodeGraph } = require('../js/paths.js');
const P = require('../js/process.js');

const lay = getLayout('electrodes');
const { centres } = electrodeGraph(lay.rects);
const at = (e) => [centres.get(e).x, centres.get(e).y];
const E = (column, row) => column * 8 + row;

// The dilution loop with its work placed: dispense, a path to (3,3), a mixer there, measure,
// mix again until conc < 5.
function placed() {
  const ed = new Editor(lay);
  ed.makeProcess();
  const ids = {};
  ed.processChange((p) => {
    p.tiles = [];
    p.links = [];
    for (const [key, kind, fields] of [
      ['start', 'start'], ['dispense', 'dispense'], ['move', 'move'], ['mix', 'mix'],
      ['measure', 'measure', { value: 'conc', unit: 'mM' }], ['decision', 'decision', { value: 'conc', op: '<', than: 5 }], ['end', 'end'],
    ]) ids[key] = P.addTile(p, kind, 0, 0, fields || {}).id;
    for (const [a, port, b] of [['start', 'next', 'dispense'], ['dispense', 'next', 'move'], ['move', 'next', 'mix'], ['mix', 'next', 'measure'], ['measure', 'next', 'decision'], ['decision', 'yes', 'end'], ['decision', 'no', 'mix']]) {
      P.link(p, ids[a], port, ids[b]);
    }
  });
  ed.openTile(ids.dispense);
  ed.placeTile();
  ed.openTile(ids.move);
  ed.frame = 6;
  ed.pointerDown(...at(9));
  for (const e of [E(2, 1), E(3, 1), E(3, 2), E(3, 3)]) ed.pointerMove(...at(e));
  ed.pointerUp();
  ed.openTile(ids.mix);
  ed.placeTile();
  ed.hoverPlacement(...at(E(3, 3)));
  ed.dropPlacement();
  return { ed, ids };
}

test('a run: dispense and move, then mix until the measured value is below 5; the board shows each stretch', async () => {
  const { ed, ids } = placed();
  const asked = [];
  const shown = [];
  const answers = [7, 3];
  let last = null;
  const runner = new Runner({
    editor: ed,
    speed: 1000,
    ask: async (step) => {
      asked.push(step.tile.id);
      return answers.shift();
    },
    changed: () => {
      const now = runner.state && runner.state.stretch;
      if (now !== last && now) shown.push(now);
      last = now;
    },
  });
  const before = ed.state();
  assert.equal(await runner.start(), 'end');
  assert.deepEqual(asked, [ids.measure, ids.measure]);
  assert.deepEqual(shown, [ids.dispense, ids.mix, ids.mix]);
  assert.deepEqual(runner.state.values, { conc: 3 });
  assert.ok(runner.state.log.some((e) => /conc < 5 mM: no/.test(e.text)));
  assert.ok(runner.state.log.some((e) => /conc < 5 mM: yes/.test(e.text)));
  assert.equal(ed.frozen, null, 'editing works again');
  assert.equal(ed.scope.tile, ids.mix, 'the tile that was open is open again');
  assert.equal(ed.state(), before, 'the run changed nothing');
});

test('while a run goes the board can’t be changed; stopping at a question ends it', async () => {
  const { ed } = placed();
  let runner;
  const ask = () => {
    ed.pointerDown(...at(E(10, 6)));
    ed.pointerMove(...at(E(12, 6)));
    ed.pointerUp();
    assert.match(ed.notice, /A run is going/);
    return Promise.resolve(null);
  };
  runner = new Runner({ editor: ed, speed: 1000, ask });
  assert.equal(await runner.start(), 'stopped');
  assert.ok(!runner.running);
  assert.equal(ed.frozen, null);
});

// Every way of changing the project: each one refused, saying why, while the run waits at a question.
function tryEverything(ed, ids) {
  const sel = ed.project.actions[0].id; // one on the board now
  const attempts = {
    undo: () => ed.undo(),
    delete: () => (ed.select(sel), ed.deleteSelected()),
    rename: () => ed.rename(sel, 'Renamed'),
    nudge: () => (ed.select(sel), ed.nudge(1, 0)),
    tileSettings: () => ed.tileSettings(ids.measure, { name: 'Other' }),
    setTileParams: () => ed.setTileParams(ids.mix, { rounds: 5 }),
    removeTile: () => ed.removeTile(ids.end),
    processChange: () => ed.processChange((p) => P.moveTile(p, ids.end, 100, 100)),
    frameTime: () => ed.setDefaultTime(1234),
    heatRates: () => ed.setHeatRates({ up: 42 }),
    highVoltage: () => ed.setHV({ volts: 120 }),
    layout: () => ed.setLayout(getLayout('electrodes')),
    template: () => ed.startTemplate(),
    openProject: () => ed.openProject({ actions: [], templates: {}, frameTime: 500 }),
    clearAll: () => (ed.run('clearAll'), false),
  };
  const done = {};
  for (const [name, fn] of Object.entries(attempts)) {
    ed.notice = null;
    done[name] = Boolean(fn()) || !ed.notice;
    if (!done[name]) assert.match(ed.notice, /A run is going/, name);
  }
  return Object.keys(done).filter((k) => done[k]);
}

test('while a run goes nothing in the project can be changed, from anywhere', async () => {
  const { ed, ids } = placed();
  ed.select(ed.doc.actions[0].id);
  const before = ed.state();
  const time = ed.doc.frameTime;
  const undos = ed.undoStack.length;
  let through = null;
  const runner = new Runner({
    editor: ed,
    speed: 1000,
    ask: async () => {
      through = tryEverything(ed, ids);
      return null;
    },
  });
  assert.equal(await runner.start(), 'stopped');
  assert.deepEqual(through, [], 'nothing got through');
  assert.equal(ed.state(), before);
  assert.equal(ed.doc.frameTime, time);
  assert.ok(!ed.doc.heatRates || ed.doc.heatRates.up !== 42);
  assert.equal(ed.project.hv, undefined, 'the high voltage too');
  assert.ok(!ed.makingTemplate);
  assert.equal(ed.undoStack.length, undos);
  assert.ok(ed.processChange((p) => P.moveTile(p, ids.end, 100, 100)), 'after the run it can be changed again');
});

test('while a run goes the frame on screen is the run’s: no stepping, scrolling or playing through frames', async () => {
  const { ed } = placed();
  let seen = null;
  const runner = new Runner({
    editor: ed,
    speed: 1000,
    ask: async () => {
      const f = ed.frame;
      const tries = [
        () => ed.nextFrame(),
        () => ed.prevFrame(),
        () => ed.wheel(-1),
        () => ed.wheel(1),
        () => ed.togglePlay(0),
        () => ed.run('next'),
        () => ed.run('prev'),
        () => ed.run('play'),
      ];
      seen = tries.map((t) => {
        ed.notice = null;
        t();
        return { frame: ed.frame, playing: ed.playing, notice: Boolean(ed.notice) };
      });
      seen.every((x) => x.frame === f) || (seen.moved = true);
      return null;
    },
  });
  assert.equal(await runner.start(), 'stopped');
  assert.ok(seen && !seen.moved, 'the frame stayed');
  assert.ok(seen.every((x) => !x.playing && x.notice), 'nothing played, and each said why');
  ed.frame = 1;
  ed.nextFrame();
  assert.equal(ed.frame, 2, 'after the run frames can be stepped through again');
});

test('a run in another tab: nothing changes here either until it ends; a template being made is not the project', () => {
  const { ed, ids } = placed();
  const before = ed.state();
  ed.runElsewhere = 'A run is going in the other tab: stop it there to change things';
  assert.deepEqual(tryEverything(ed, ids), []);
  assert.equal(ed.state(), before);
  assert.equal(ed.applyRemote({ actions: [], templates: {} }), false, 'what the other tab sends waits too');
  ed.runElsewhere = null;
  // A template being made isn't the shared project: a run elsewhere doesn't stop drawing it.
  assert.ok(ed.startTemplate());
  ed.runElsewhere = 'A run is going in the other tab: stop it there to change things';
  assert.equal(ed.readOnly, null);
  assert.ok(ed.dispense('reservoirLeftTop'), 'drawn in the template');
  ed.endTemplate();
  assert.ok(ed.readOnly, 'back in the project: nothing changes');
  ed.runElsewhere = null;
  assert.ok(ed.processChange((p) => P.moveTile(p, ids.end, 100, 100)));
});
