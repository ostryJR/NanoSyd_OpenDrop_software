'use strict';
// Heaters and magnets: temperature and magnet settings on the board and in the process, the
// estimated waits, what goes to the device, and the files.
const test = require('node:test');
const assert = require('node:assert/strict');
const heat = require('../js/heat.js');
const { compile, importControls } = require('../js/compile.js');
const { encode, decode } = require('../js/jsonio.js');
const projects = require('../js/project.js');
const { Editor } = require('../js/editor.js');
const { Runner } = require('../js/runner.js');
const { getLayout } = require('../js/layout.js');
const { Session, decodeReply } = require('../js/device.js');
const P = require('../js/process.js');

const lay = getLayout('electrodes');
const rects = lay.rects;
const project = (actions, extra = {}) => ({ frameTime: 500, templates: {}, actions, ...extra });
const path = (id, fields, points) => ({ id, type: 'path', name: id, droplet: 'D', points: points.map((e) => ({ e })), ...fields });

test('estimates: the slowest heater counts, warming and cooling at their own rates', () => {
  const rates = { up: 10, down: 5 };
  assert.equal(heat.estimateMs([null, null, null], [45, null, null], rates), 120000); // 25 -> 45 at 10/min
  assert.equal(heat.estimateMs([60, 30, null], [40, 50, null], rates), 240000); // 60 -> 40 at 5/min
  assert.equal(heat.estimateMs([60, null, null], [60, null, null], rates), 0);
  assert.equal(heat.rampAt(25, 45, 60000, rates), 35);
  assert.equal(heat.rampAt(25, 45, 600000, rates), 45);
  assert.ok(heat.reached([59.5, null, 20], [60, null, null], 1));
  assert.ok(!heat.reached([58, null, null], [60, null, null], 1));
  assert.ok(!heat.reached([null, null, null], [60, null, null], 1), 'no reading is not there yet');
  assert.deepEqual(heat.cleanTargets([200, 'x', 10.4]), [120, null, 20]);
});

test('a temperature setting lasts no time; one that waits lasts the estimate, without holding the others up', () => {
  const r = compile(project([
    path('p', { start: 1 }, [17, 25, 33, 41]),
    { id: 't', type: 'temp', name: 'T', droplet: '', start: 2, targets: [45, null, null], wait: true, tolerance: 1 },
    { id: 'q', type: 'temp', name: 'Q', droplet: '', start: 3, targets: [null, 30, null] },
  ], { heatRates: { up: 10, down: 5 } }), rects);
  assert.deepEqual(r.issues, []);
  assert.deepEqual(r.spans.get('p'), { from: 1, to: 4 }, 'the path keeps going');
  assert.deepEqual(r.spans.get('q'), { from: 3, to: 3 });
  const t = r.spans.get('t');
  assert.equal(t.from, 2);
  // 2 min in all: frames 2-4 of the path take 1.5 s, the last frame the rest.
  assert.equal(r.seq.elapsed(t.to) - r.seq.elapsed(t.from - 1), 120000);
  assert.deepEqual(r.seq.holds.get(t.to).targets, [45, null, null]);
  assert.equal(r.seq.lastFrame(), t.to, 'a wait at the end counts as frames');
  assert.deepEqual(r.seq.controlsAt(1).targets, [null, null, null]);
  assert.deepEqual(r.seq.controlsAt(2).targets, [45, null, null]);
  assert.deepEqual(r.seq.controlsAt(3).targets, [45, 30, null]);
  assert.deepEqual(r.controls.targets, [45, 30, null]);
});

test('a magnet stays on from its frame until switched off, as its control line', () => {
  const r = compile(project([
    path('p', { start: 1 }, [17, 25, 33, 41, 42]),
    { id: 'on', type: 'magnet', name: 'M', droplet: '', start: 2, magnet: 1, on: true },
    { id: 'off', type: 'magnet', name: 'M', droplet: '', start: 4, magnet: 1, on: false },
    { id: 'two', type: 'magnet', name: 'M', droplet: '', start: 3, magnet: 2, on: true },
  ]), rects);
  const m1 = [1, 2, 3, 4, 5].map((f) => r.seq.get(heat.magnetCell(1), f));
  const m2 = [1, 2, 3, 4, 5].map((f) => r.seq.get(heat.magnetCell(2), f));
  assert.deepEqual(m1, [false, true, true, false, false]);
  assert.deepEqual(m2, [false, false, true, true, true]);
  assert.deepEqual(r.controls.magnets, [false, true]);
  assert.equal(r.seq.timeOf(2), 500, 'switching takes no time of its own');
  assert.deepEqual(r.issues, []);
});

test('controls coming in carry on: a magnet that is on stays on in every frame', () => {
  const r = compile(project([path('p', { start: 1 }, [17, 25])]), rects, { controls: { targets: [50, null, null], magnets: [true, false] } });
  assert.ok(r.seq.get(heat.magnetCell(1), 1) && r.seq.get(heat.magnetCell(1), 2));
  assert.deepEqual(r.seq.controlsAt(2).targets, [50, null, null]);
});

test('files: targets and waits go into the OpenDrop JSON and come back as settings', () => {
  const r = compile(project([
    path('p', { start: 1 }, [17, 25, 33]),
    { id: 't', type: 'temp', name: 'T', droplet: '', start: 2, targets: [40, null, 70], wait: true, tolerance: 2 },
  ]), rects);
  const text = encode(r.seq);
  assert.match(text, /"temp": \[40, null, 70\]/);
  assert.match(text, /"waitTemp": 2/);
  const back = decode(text);
  assert.equal(back.seq.lastFrame(), r.seq.lastFrame());
  assert.deepEqual(back.seq.controlsAt(3).targets, [40, null, 70]);
  const settings = importControls(back.seq);
  assert.deepEqual(settings, [{ type: 'temp', name: 'Temperature', droplet: '', start: 2, targets: [40, null, 70], wait: true, tolerance: 2 }]);
  // A file without targets writes none.
  assert.doesNotMatch(encode(compile(project([path('p', { start: 1 }, [17, 25])]), rects).seq), /temp/);
});

test('project files: settings are cleaned, empty ones left out', () => {
  const { project: p, warnings } = projects.parse(JSON.stringify({
    openDropGeneratorProject: 1,
    heatRates: { up: -1, down: 3 },
    actions: [
      { id: 'a', type: 'temp', targets: [300, null], wait: 'yes', tolerance: 5 },
      { id: 'b', type: 'temp', targets: [] },
      { id: 'c', type: 'magnet', magnet: 7, droplet: 'x' },
    ],
  }));
  assert.deepEqual(p.heatRates, { up: heat.DEFAULT_RATES.up, down: 3 });
  assert.deepEqual(p.actions.map((a) => a.id), ['a', 'c']);
  assert.deepEqual(p.actions[0].targets, [120, null, null]);
  assert.equal(p.actions[0].wait, undefined);
  assert.deepEqual([p.actions[1].magnet, p.actions[1].on, p.actions[1].droplet], [1, true, '']);
  assert.match(warnings.join(' '), /sets nothing/);
});

// Start -> Temperature (waits) -> Magnet -> Measure -> Move -> End.
function processDoc() {
  const ed = new Editor(lay);
  ed.makeProcess();
  const ids = {};
  ed.processChange((p) => {
    p.tiles = [];
    p.links = [];
    for (const [key, kind, fields] of [
      ['start', 'start'], ['heat', 'temperature', { targets: [45, null, null], wait: true }], ['magnet', 'magnet', { magnet: 2, on: true }],
      ['measure', 'measure'], ['move', 'move'], ['end', 'end'],
    ]) ids[key] = P.addTile(p, kind, 0, 0, fields || {}).id;
    for (const [a, b] of [['start', 'heat'], ['heat', 'magnet'], ['magnet', 'measure'], ['measure', 'move'], ['move', 'end']]) P.link(p, ids[a], 'next', ids[b]);
  });
  for (const k of ['heat', 'magnet']) {
    assert.ok(ed.openTile(ids[k]));
    assert.equal(ed.placeTile().kind, 'added');
  }
  return { ed, ids };
}

test('process tiles: Temperature and Magnet are placed as settings, and the next stretch starts with them', () => {
  const { ed, ids } = processDoc();
  ed.openTile(ids.heat);
  const [t, m] = ed.project.actions;
  assert.deepEqual([t.type, t.targets, t.wait, m.type, m.magnet, m.on], ['temp', [45, null, null], true, 'magnet', 2, true]);
  assert.equal(m.after, t.id, 'the magnet waits for the heater');
  // Changing the tile changes what is placed.
  ed.tileSettings(ids.heat, { targets: [50, null, null], wait: false });
  ed.openTile(ids.heat);
  assert.deepEqual(ed.project.actions[0].targets, [50, null, null]);
  assert.equal(ed.project.actions[0].wait, undefined);
  // The move after the Measure stop: heaters and magnet carried in.
  ed.openTile(ids.move);
  assert.deepEqual(ed.controlsIn, { targets: [50, null, null], magnets: [false, true] });
  assert.deepEqual(ed.controlsAt(1).magnets, [false, true]);
});

test('a run waits in a heater hold until a live device reads the targets', async () => {
  const { ed } = processDoc();
  let temp = 30;
  const log = [];
  const runner = new Runner({
    editor: ed,
    speed: 1000,
    ask: async () => 1,
    readings: () => {
      if (runner.state && runner.state.heating) temp += 5; // warming while it waits
      return [temp, null, null];
    },
    changed() {
      const s = runner.state;
      if (s.log.length) log.push(s.log[s.log.length - 1].text);
    },
  });
  const ended = await runner.start();
  assert.equal(ended, 'end');
  assert.ok(temp >= 44, `it waited for the heater (${temp})`);
  assert.ok(log.some((t) => /Waiting for the heaters: T1 45 °C/.test(t)));
  assert.ok(log.some((t) => /The heaters got there/.test(t)));
});

test('playing live holds a heater frame until the readings get there', () => {
  const ed = new Editor(lay);
  ed.addTemp(1, { targets: [40, null, null], wait: true });
  let temps = null;
  ed.readings = () => temps;
  const hold = [...ed.seq.holds.keys()][0];
  ed.frame = hold;
  ed.togglePlay(0);
  ed.addTemp(hold + 1, { targets: [null, 30, null] }); // something after it to go on to
  ed.frame = hold;
  ed.playing = true;
  ed.playStart = 0;
  temps = [30, null, null];
  assert.equal(ed.tick(10 ** 9), false, 'live and not there yet: it holds');
  assert.ok(ed.holding);
  temps = [39.5, null, null];
  assert.equal(ed.tick(10 ** 9), true, 'there: it goes on');
});

test('live, the device gets the frame’s heater targets; the others as set in the Device tab', () => {
  const s = new Session();
  s.targets = [25, 33, 25];
  s.show([], [60, null, null]);
  assert.deepEqual(s.sentTargets, [25, 33, 25], 'not live: what the Device tab says');
  s.live = true;
  assert.deepEqual(s.sentTargets, [60, 33, 25]);
  const bytes = s.bytes();
  assert.deepEqual([bytes[26], bytes[27], bytes[28]], [60, 33, 25]);
  void decodeReply;
});
