'use strict';
// The whole process on one timeline: the stretches one after another along the way a run would go
// on (on at every decision, Repeats their rounds), for looking at and playing, not changing.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Editor } = require('../js/editor.js');
const { Runner } = require('../js/runner.js');
const { route } = require('../js/schedule.js');
const { getLayout } = require('../js/layout.js');
const { electrodeGraph } = require('../js/paths.js');
const P = require('../js/process.js');

const lay = getLayout('electrodes');
const { centres } = electrodeGraph(lay.rects);
const at = (e) => [centres.get(e).x, centres.get(e).y];
const E = (column, row) => column * 8 + row;

// Dispense, a path to (3,3), then mix there and measure until conc < 5 (no goes back to mix).
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

test('the way through: each stretch once, its frames after the ones before, a stop at each question', () => {
  const { ed, ids } = placed();
  ed.flush();
  const { parts, ended, compiled, project } = route(ed.doc, lay.rects);
  assert.equal(ended, 'end');
  const kinds = parts.map((p) => (p.kind === 'stretch' ? `s:${p.stretch}` : `${p.kind}:${p.tile}`));
  assert.deepEqual(kinds, [`s:${ids.dispense}`, `s:${ids.mix}`, `stop:${ids.measure}`, `stop:${ids.decision}`, `end:${ids.end}`]);
  const [first, second] = parts;
  assert.equal(first.from, 1);
  assert.equal(second.from, first.to + 1, 'the mix comes right after the move');
  assert.ok(second.to > second.from);
  assert.match(parts[3].text, /conc < 5 mM: yes/, 'on at the decision, not back round');
  assert.equal(compiled.seq.lastFrame(), second.to);
  // Each stretch's own frames, put where they go.
  ed.openTile(ids.mix);
  for (let f = 1; f <= second.to - second.from + 1; f++) {
    for (let e = 0; e < 128; e++) assert.equal(compiled.seq.get(e, second.from + f - 1), ed.seq.get(e, f), `frame ${f}, electrode ${e}`);
  }
  // The actions, copied with the part they are in.
  assert.ok(project.actions.every((a) => a.id === `${a.visit}:${a.of}`));
  for (const a of project.actions) {
    const span = compiled.spans.get(a.id);
    const part = parts.find((p) => p.kind === 'stretch' && p.visit === a.visit);
    assert.ok(span.from >= part.from && span.to <= part.to, `${a.name} inside its part`);
  }
});

test('a Repeat runs its rounds; an arrow that goes nowhere stops it short', () => {
  const ed = new Editor(lay);
  ed.makeProcess();
  const ids = {};
  ed.processChange((p) => {
    p.tiles = [];
    p.links = [];
    for (const [key, kind, fields] of [['start', 'start'], ['repeat', 'repeat', { times: 3 }], ['mix', 'mix'], ['end', 'end']]) ids[key] = P.addTile(p, kind, 0, 0, fields || {}).id;
    for (const [a, port, b] of [['start', 'next', 'repeat'], ['repeat', 'again', 'mix'], ['mix', 'next', 'repeat'], ['repeat', 'done', 'end']]) P.link(p, ids[a], port, ids[b]);
  });
  ed.flush();
  let r = route(ed.doc, lay.rects);
  assert.equal(r.ended, 'end');
  assert.equal(r.parts.filter((p) => p.kind === 'stretch').length, 3);
  assert.deepEqual(r.parts.filter((p) => p.kind === 'stop').map((p) => p.text.replace(/^.*: /, '')), ['round 1 of 3', 'round 2 of 3', 'round 3 of 3']);
  ed.processChange((p) => P.unlink(p, ids.repeat, 'done'));
  ed.flush();
  r = route(ed.doc, lay.rects);
  assert.equal(r.ended, 'stuck');
});

test('playing on past a stretch’s last frame: the page can take it on to the next one', () => {
  const { ed, ids } = placed();
  ed.openTile(ids.dispense);
  const last = ed.seq.lastFrame();
  let asked = 0;
  ed.onPlayEnd = () => {
    asked++;
    ed.openTile(ids.mix);
    ed.frame = 1;
    return true;
  };
  ed.frame = last;
  ed.togglePlay(0);
  assert.equal(ed.tick(10 ** 9), true);
  assert.equal(asked, 1);
  assert.equal(ed.scope.tile, ids.mix);
  assert.equal(ed.frame, 1);
  assert.equal(ed.playLast, ed.seq.lastFrame(), 'it plays to the end of the new stretch');
  // Without the page taking it on, back to frame 1.
  ed.onPlayEnd = () => false;
  ed.frame = ed.playLast;
  ed.tick(2 * 10 ** 9);
  assert.equal(ed.frame, 1);
});

test('each time through a stretch has the droplets as they come in that time', () => {
  const { ed, ids } = placed();
  ed.flush();
  const { parts } = route(ed.doc, lay.rects);
  const [dispense, mix] = parts.filter((p) => p.kind === 'stretch');
  assert.deepEqual(dispense.state, []);
  assert.equal(mix.state.length, 1, 'the droplet the move left');
  assert.ok(ed.openTile(ids.mix, { state: mix.state, controls: mix.controls }));
  assert.deepEqual(ed.arrive.map((a) => a.cells), mix.state.map((d) => d.cells));
});
