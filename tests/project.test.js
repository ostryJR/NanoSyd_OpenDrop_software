'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../js/project.js');
const T = require('../js/templates.js');

const circle = T.BUILT_IN.find((t) => t.id === 'circle-2x2');

function sample() {
  const p = P.newProject({ layout: 'electrodes', frameTime: 400 });
  p.templates['circle-2x2'] = { name: circle.name, frames: circle.frames };
  p.templates.unused = { name: 'Unused', frames: [[[0, 0]]] };
  p.actions.push(
    { id: 'a1', type: 'dispense', name: 'Dispense left top', droplet: 'Sample', start: 1, reservoir: 'reservoirLeftTop' },
    { id: 'a2', type: 'path', name: 'Sample to mixer', droplet: 'Sample', after: 'a1', points: [{ e: 9 }, { e: 41 }, { e: 44 }] },
    { id: 'a3', type: 'template', name: 'Mix', droplet: 'Sample', after: 'a2', template: 'circle-2x2', at: 44, turns: 0 },
    { id: 'a4', type: 'pattern', name: 'old.json', droplet: '', start: 1, frames: [[8, 9], [], [128]] }
  );
  return p;
}

test('a new project is empty, with its tag and version', () => {
  const p = P.newProject();
  assert.deepEqual(p, { openDropGeneratorProject: 1, layout: 'electrodes', frameTime: 500, templates: {}, actions: [] });
  assert.ok(P.isProject(p));
  assert.ok(!P.isProject([{ y0: '1' }]));
  assert.ok(!P.isProject(null));
});

test('save and open give the same project back; templates no action uses are left out', () => {
  const p = sample();
  const text = P.serialize(p);
  const { project, warnings } = P.parse(text);
  assert.deepEqual(warnings, []);
  assert.deepEqual(project.actions, p.actions);
  assert.deepEqual(Object.keys(project.templates), ['circle-2x2']);
  assert.equal(project.frameTime, 400);
  assert.equal(P.serialize(project), text, 'saving again changes nothing');
});

test('times of their own from older files are left out, with a warning', () => {
  const p = sample();
  Object.assign(p.actions[1], { stepTime: 600, split: true });
  p.actions[1].points[1].wait = 5000;
  p.actions[3].times = [0, 2000, 0];
  const { project, warnings } = P.parse(P.serialize(p));
  assert.match(warnings.join(' '), /2 action\(s\) had times of their own/);
  assert.deepEqual(project.actions, sample().actions);
});

test('the file is readable: one field per line, keys in a fixed order', () => {
  const text = P.serialize(sample());
  assert.match(text, /^\{\n {2}"openDropGeneratorProject": 1,\n {2}"layout": "electrodes",\n {2}"frameTime": 400,/);
  assert.match(text, /\n {6}"points": \[\{"e":9\},\{"e":41\},\{"e":44\}\]\n/);
  const scrambled = { ...sample(), actions: [{ points: [{ e: 3 }], name: 'x', type: 'path', id: 'a9', start: 2, droplet: '' }] };
  const keys = Object.keys(JSON.parse(P.serialize(scrambled)).actions[0]);
  assert.deepEqual(keys, ['id', 'type', 'name', 'droplet', 'start', 'points']);
  assert.match(P.serialize(P.newProject()), /"templates": \{\},\n {2}"actions": \[\]\n\}\n$/);
});

test('parts this version doesn’t know are kept and written back', () => {
  const p = sample();
  p.inputs = { concentration: { from: 'spectrometer' } };
  p.actions.push({ id: 'a5', type: 'measure', name: 'Measure', droplet: 'Sample', after: 'a3', instrument: 'spectrometer', until: { above: 2 } });
  p.actions[1].note = 'slowly';
  p.actions[1].points[1].measure = 'here';
  const { project, warnings } = P.parse(P.serialize(p));
  assert.deepEqual(project.inputs, p.inputs);
  assert.deepEqual(project.actions[4], p.actions[4]);
  assert.equal(project.actions[1].note, 'slowly');
  assert.equal(project.actions[1].points[1].measure, 'here');
  assert.match(warnings.join(' '), /1 action\(s\) of a kind this version doesn't know are kept/);
});

test('a file from a newer version opens with a warning and keeps its version number', () => {
  const { project, warnings } = P.parse(JSON.stringify({ openDropGeneratorProject: 3, actions: [] }));
  assert.equal(project.openDropGeneratorProject, 3);
  assert.match(warnings[0], /newer version/);
});

test('broken parts are cleaned or left out, with warnings', () => {
  const { project, warnings } = P.parse(JSON.stringify({
    openDropGeneratorProject: 1,
    layout: 7,
    frameTime: -3,
    templates: { good: { name: 'G', frames: [[[0, 0]]] }, bad: { frames: 'x' } },
    actions: [
      'junk',
      { type: 'path', name: 'No points', points: [] },
      { id: 'p', type: 'path', name: 'Ok', start: 999999, points: [9, { e: 17, wait: -1 }, { e: 'x' }], stepTime: 0, split: 'yes', times: 'no' },
      { id: 'p', type: 'pattern', frames: [[1, 1, 900, 2]], delay: 3 },
      { id: 't', type: 'template', name: 'T', template: 'good', at: 44, turns: 7, after: 'p' },
      { id: 'd', type: 'dispense', reservoir: 'nowhere' },
    ],
  }));
  assert.equal(project.layout, 'electrodes');
  assert.equal(project.frameTime, 500);
  assert.deepEqual(Object.keys(project.templates), ['good']);
  assert.deepEqual(project.actions.map((a) => a.id), ['p', 'a1', 't']);
  assert.deepEqual(project.actions[0], { id: 'p', type: 'path', name: 'Ok', droplet: '', start: 1, points: [{ e: 9 }, { e: 17 }] });
  assert.deepEqual(project.actions[1], { id: 'a1', type: 'pattern', name: 'Pattern', droplet: '', start: 1, frames: [[1, 2]] });
  assert.equal(project.actions[2].turns, 3);
  assert.equal(project.actions[2].after, 'p');
  assert.equal(project.actions[2].start, undefined);
  const text = warnings.join(' | ');
  for (const w of [/template bad/, /action 1 has no type/, /“No points” has no points/, /unusable start frame/, /two actions were called p/, /names no known reservoir/]) {
    assert.match(text, w);
  }
});

test('not a project: an error', () => {
  assert.throws(() => P.parse('[{"y0": "1"}]'), /not an OpenDrop Generator project/);
  assert.throws(() => P.parse('not json'), SyntaxError);
});

test('new ids, names and droplet names follow the ones in use', () => {
  const p = sample();
  assert.equal(P.nextId(p), 'a5');
  assert.equal(P.nextName(p, 'Path'), 'Path 1');
  p.actions.push({ id: 'a12', type: 'path', name: 'Path 3', droplet: 'Droplet 2', start: 1, points: [{ e: 9 }] });
  assert.equal(P.nextId(p), 'a13');
  assert.equal(P.nextName(p, 'Path'), 'Path 4');
  assert.equal(P.nextDroplet(p), 'Droplet 3');
});

test('templates are copied in once: built-in ones by their id, others as t1, t2…', () => {
  const p = P.newProject();
  assert.equal(P.embedTemplate(p, circle), 'circle-2x2');
  assert.equal(P.embedTemplate(p, circle), 'circle-2x2', 'the same one again');
  const mine = { name: 'Mine', frames: [[[0, 0]], [[1, 0]]] };
  assert.equal(P.embedTemplate(p, mine), 't1');
  assert.equal(P.embedTemplate(p, { ...mine, name: 'Other' }), 't2');
  assert.deepEqual(p.templates.t1, mine);
  // A built-in one that changed in a later version doesn't overwrite the copy in the file.
  assert.equal(P.embedTemplate(p, { ...circle, frames: [[[0, 0]]] }), 't3');
  assert.deepEqual(p.templates['circle-2x2'].frames, circle.frames);
});

test('“after” may list several actions (a merge); a template keeps its parameters', () => {
  const { project, warnings } = P.parse(JSON.stringify({
    openDropGeneratorProject: 1,
    templates: { 'circle-3x3-r5': { name: 'Circle mix 3×3, 5 rounds', frames: [[[0, 0]]] } },
    actions: [
      { id: 'a', type: 'path', start: 1, points: [{ e: 9 }] },
      { id: 'b', type: 'path', start: 1, points: [{ e: 20 }] },
      { id: 'm', type: 'template', after: ['a', 'b'], delay: 2, template: 'circle-3x3-r5', at: 9, params: { kind: 'circle', size: 3, rounds: 5 } },
    ],
  }));
  assert.deepEqual(warnings, []);
  assert.deepEqual(project.actions[2].after, ['a', 'b']);
  assert.equal(project.actions[2].delay, 2);
  assert.deepEqual(project.actions[2].params, { kind: 'circle', size: 3, rounds: 5 });
  assert.match(P.serialize(project), /"after": \["a","b"\],\n {6}"delay": 2,/);
});

test('droplet short names: D12 for Droplet 12, initials for long names, each part of a merge', () => {
  assert.equal(P.shortDroplet('Droplet 12'), 'D12');
  assert.equal(P.shortDroplet('droplet  3'), 'D3');
  assert.equal(P.shortDroplet('Sample'), 'Sample', 'a short word stays');
  assert.equal(P.shortDroplet('Sample buffer 2'), 'SB2');
  assert.equal(P.shortDroplet('Droplet 1 + Droplet 2'), 'D1 + D2', 'older merged names shorten too');
  assert.equal(P.shortDroplet('D1 + D2 + Droplet 3'), 'D1 + D2 + D3');
  assert.equal(P.shortDroplet(''), '');
  assert.equal(P.shortDroplet(undefined), '');
});

test('a Dispense tile keeps the name of the droplet it makes; an unusable one is left out', () => {
  const p = sample();
  p.process = {
    tiles: [
      { id: 'p1', kind: 'start', x: 0, y: 0 },
      { id: 'p2', kind: 'dispense', name: 'Sample in', x: 0, y: 100, reservoir: 'reservoirLeftTop', droplet: '  Sample ' },
      { id: 'p3', kind: 'dispense', x: 0, y: 200, droplet: 7 },
      { id: 'p4', kind: 'mix', x: 0, y: 300, droplet: 'Nope' },
    ],
    links: [{ from: 'p1', port: 'next', to: 'p2' }],
  };
  const { project, warnings } = P.parse(P.serialize(p));
  assert.equal(project.process.tiles[1].droplet, 'Sample', 'trimmed');
  assert.equal(project.process.tiles[2].droplet, undefined);
  assert.equal(project.process.tiles[3].droplet, undefined, 'only a Dispense names a droplet');
  assert.equal(warnings.filter((w) => /droplet name of the tile/.test(w)).length, 2);
  const again = P.parse(P.serialize(project));
  assert.deepEqual(again.warnings, []);
  assert.deepEqual(again.project.process, project.process, 'saving again changes nothing');
  assert.match(P.serialize(project), /"reservoir":"reservoirLeftTop","droplet":"Sample"\}/, 'after the other settings');
});

test('an older Ask that took a number opens as a Measure, typed in, its question as the prompt', () => {
  const p = sample();
  p.process = {
    tiles: [
      { id: 'p1', kind: 'start', x: 0, y: 0 },
      { id: 'p2', kind: 'ask', name: 'Ask', x: 0, y: 100, question: 'How much is left?', answer: 'number', value: 'left' },
      { id: 'p3', kind: 'ask', name: 'Ready?', x: 0, y: 200, question: 'Go on?', answer: 'yesno', value: 'ok' },
    ],
    links: [{ from: 'p1', port: 'next', to: 'p2' }, { from: 'p2', port: 'next', to: 'p3' }],
  };
  const { project, warnings } = P.parse(P.serialize(p));
  assert.deepEqual(warnings, []);
  const [, measure, ask] = project.process.tiles;
  assert.deepEqual(
    { kind: measure.kind, name: measure.name, prompt: measure.prompt, unit: measure.unit, source: measure.source, value: measure.value, question: measure.question, answer: measure.answer },
    { kind: 'measure', name: 'Measure', prompt: 'How much is left?', unit: '', source: 'typed', value: 'left', question: undefined, answer: undefined }
  );
  assert.equal(ask.kind, 'ask');
  assert.equal(ask.answer, undefined, 'an Ask is always yes or no now');
  assert.equal(project.process.links.length, 2, 'its arrows stay');
});

test('the project keeps its high voltage, cleaned to the device’s limits; none set, none kept', () => {
  const p = sample();
  p.hv = { volts: 300, hz: 333, mode: 'ac' };
  const { project, warnings } = P.parse(P.serialize(p));
  assert.deepEqual(warnings, []);
  assert.deepEqual(project.hv, { volts: 240, hz: 330, mode: 'ac' });
  assert.equal(P.serialize(P.parse(P.serialize(project)).project), P.serialize(project), 'saving again changes nothing');
  const none = sample();
  none.hv = { volts: '', mode: 'x' };
  const back = P.parse(P.serialize(none));
  assert.equal(back.project.hv, undefined);
  assert.match(back.warnings.join(' '), /high-voltage settings are unusable/);
  assert.equal(P.parse(P.serialize(sample())).project.hv, undefined, 'a project without one stays without');
});

test('the timeline’s track order: strings, each once; anything else is left out', () => {
  const p = P.newProject();
  const open = (trackOrder) => P.parse({ ...p, trackOrder }).project.trackOrder;
  assert.deepEqual(open(['d:A', 'm:magnets', 'd:A', 3, null]), ['d:A', 'm:magnets']);
  assert.equal(open('d:A'), undefined);
  assert.equal(open([]), undefined);
  assert.equal(P.parse(p).project.trackOrder, undefined);
});
