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
    { id: 'a2', type: 'path', name: 'Sample to mixer', droplet: 'Sample', after: 'a1', points: [{ e: 9 }, { e: 41, wait: 5000 }, { e: 44 }], stepTime: 600 },
    { id: 'a3', type: 'template', name: 'Mix', droplet: 'Sample', after: 'a2', template: 'circle-2x2', at: 44, turns: 0, split: true },
    { id: 'a4', type: 'pattern', name: 'old.json', droplet: '', start: 1, frames: [[8, 9], [], [128]], times: [0, 2000, 0] }
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

test('the file is readable: one field per line, keys in a fixed order', () => {
  const text = P.serialize(sample());
  assert.match(text, /^\{\n {2}"openDropGeneratorProject": 1,\n {2}"layout": "electrodes",\n {2}"frameTime": 400,/);
  assert.match(text, /\n {6}"points": \[\{"e":9\},\{"e":41,"wait":5000\},\{"e":44\}\],\n/);
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
      { id: 'p', type: 'path', name: 'Ok', start: 999, points: [9, { e: 17, wait: -1 }, { e: 'x' }], stepTime: 0, split: 'yes', times: 'no' },
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
  const mine = { name: 'Mine', frames: [[[0, 0]], [[1, 0]]], times: [0, 900] };
  assert.equal(P.embedTemplate(p, mine), 't1');
  assert.equal(P.embedTemplate(p, { ...mine, name: 'Other' }), 't2');
  assert.deepEqual(p.templates.t1, mine);
  // A built-in one that changed in a later version doesn't overwrite the copy in the file.
  assert.equal(P.embedTemplate(p, { ...circle, frames: [[[0, 0]]] }), 't3');
  assert.deepEqual(p.templates['circle-2x2'].frames, circle.frames);
});
