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
