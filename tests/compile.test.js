'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { getLayout } = require('../js/layout.js');
const { Sequence, CELLS, MAX_FRAMES } = require('../js/model.js');
const { encode, decode } = require('../js/jsonio.js');
const T = require('../js/templates.js');
const { compile, importSequence, RESERVOIR_STEPS } = require('../js/compile.js');

const rects = getLayout('electrodes').rects;
const E = (column, row) => column * 8 + row;
const onIn = (seq, f) => {
  const on = [];
  for (let e = 0; e < CELLS; e++) if (seq.get(e, f)) on.push(e);
  return on;
};
const sorted = (list) => [...list].sort((a, b) => a - b);
const project = (actions, extra = {}) => ({ frameTime: 500, templates: {}, actions, ...extra });
const path = (id, where, points, extra = {}) => ({ id, type: 'path', name: id, droplet: '', ...where, points: points.map((e) => (typeof e === 'number' ? { e } : e)), ...extra });
const pattern = (id, where, frames, extra = {}) => ({ id, type: 'pattern', name: id, droplet: '', ...where, frames, ...extra });
const issues = (r, kind) => r.issues.filter((i) => i.kind === kind);

// Small seeded random generator so failures can be reproduced.
function random(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('a path: one electrode per frame along its line, from its start frame', () => {
  const r = compile(project([path('a1', { start: 3 }, [E(1, 0), E(3, 0), E(3, 2)])]), rects);
  assert.deepEqual([3, 4, 5, 6, 7].map((f) => onIn(r.seq, f)), [[E(1, 0)], [E(2, 0)], [E(3, 0)], [E(3, 1)], [E(3, 2)]]);
  assert.deepEqual(r.spans.get('a1'), { from: 3, to: 7 });
  assert.deepEqual(r.active[5], [{ id: 'a1', step: 2 }]);
  assert.equal(r.seq.lastFrame(), 7);
  assert.deepEqual(r.issues, []);
});

test('a dispense writes the reservoir’s six frames', () => {
  for (const reservoir of Object.keys(RESERVOIR_STEPS)) {
    const r = compile(project([{ id: 'a1', type: 'dispense', name: 'd', droplet: '', start: 2, reservoir }]), rects);
    assert.deepEqual([2, 3, 4, 5, 6, 7].map((f) => onIn(r.seq, f)), RESERVOIR_STEPS[reservoir].map(sorted), reservoir);
  }
  const glass = compile(project([{ id: 'a1', type: 'dispense', name: 'd', droplet: '', start: 1, reservoir: 'reservoirLeftTop' }]), getLayout('electrodes_glass').rects);
  assert.match(issues(glass, 'invalid')[0].text, /no such reservoir/);
});

test('a template: the frames place() gives, turned and anchored where it was dropped', () => {
  const split = T.BUILT_IN.find((t) => t.id === 'split');
  const p = project([{ id: 'a1', type: 'template', name: 'Split', droplet: '', start: 4, template: 'split', at: E(5, 4), turns: 1 }], {
    templates: { split: { name: split.name, frames: split.frames } },
  });
  const r = compile(p, rects);
  const spot = T.place(split, 1, E(5, 4), 4, rects);
  spot.frames.forEach((cells, i) => assert.deepEqual(onIn(r.seq, 4 + i), sorted(cells)));
  p.actions[0].at = E(14, 7);
  assert.match(issues(compile(p, rects), 'invalid')[0].text, /doesn't fit/);
  p.actions[0].template = 'gone';
  assert.match(issues(compile(p, rects), 'invalid')[0].text, /missing from the file/);
});

test('a pattern is taken as it is, control lines included', () => {
  const r = compile(project([pattern('a1', { start: 2 }, [[9, 10], [], [128]])]), getLayout('electrodes_magnet').rects);
  assert.deepEqual([2, 3, 4].map((f) => onIn(r.seq, f)), [[9, 10], [], [128]]);
  assert.deepEqual(r.spans.get('a1'), { from: 2, to: 4 });
});

test('step times: a path’s waits, its own step time, or the default', () => {
  const r = compile(project([path('a1', { start: 1 }, [E(1, 0), { e: E(3, 0), wait: 4000 }, E(5, 0)], { stepTime: 800 })]), rects);
  assert.deepEqual([1, 2, 3, 4, 5].map((f) => r.seq.timeOf(f)), [800, 800, 4000, 800, 800]);
  const t = compile(project([pattern('a1', { start: 1 }, [[9], [9]], { times: [0, 1500] })]), rects);
  assert.deepEqual([t.seq.timeOf(1), t.seq.timeOf(2), t.seq.times[1]], [500, 1500, 0]);
});

test('“after”: an action starts in the last frame of the one it follows (+ delay)', () => {
  const r = compile(project([
    path('a1', { start: 2 }, [E(1, 0), E(4, 0)]),
    path('a2', { after: 'a1' }, [E(4, 0), E(4, 3)]),
    pattern('a3', { after: 'a2', delay: 2 }, [[E(4, 3)]]),
  ]), rects);
  assert.deepEqual(r.spans.get('a1'), { from: 2, to: 5 });
  assert.deepEqual(r.spans.get('a2'), { from: 5, to: 8 });
  assert.deepEqual(r.spans.get('a3'), { from: 10, to: 10 });
  assert.deepEqual(onIn(r.seq, 5), [E(4, 0)], 'the droplet is handed over in frame 5');
  assert.deepEqual(r.issues, []);
});

test('an action linked after another should start where it ends, or the droplet would jump', () => {
  const r = compile(project([
    path('a1', { start: 1 }, [E(1, 0), E(4, 0)]),
    path('a2', { after: 'a1' }, [E(6, 0), E(6, 3)]),
  ]), rects);
  assert.equal(issues(r, 'jump').length, 1);
  assert.equal(issues(r, 'jump')[0].id, 'a2');
});

test('a frame lasts as long as its longest step, and the actions held up are named', () => {
  const r = compile(project([
    pattern('hold', { start: 1 }, [[9]], { times: [5000] }),
    path('move', { start: 1 }, [E(10, 6), E(14, 6)]),
  ]), rects);
  assert.equal(r.seq.timeOf(1), 5000);
  assert.deepEqual(issues(r, 'waits'), [{ kind: 'waits', id: 'hold', frame: 1, time: 5000, ids: ['move'] }]);
});

test('no warning when the one waiting is just arriving (the droplet handed over to a hold)', () => {
  const r = compile(project([
    path('move', { start: 1 }, [E(1, 0), E(4, 0)]),
    pattern('hold', { after: 'move' }, [[E(4, 0)]], { times: [60000] }),
  ]), rects);
  assert.equal(r.seq.timeOf(4), 60000);
  assert.deepEqual(issues(r, 'waits'), []);
});

test('split: a long step stretches over the frames the others take, each step at least its time', () => {
  const hold = pattern('hold', { start: 1 }, [[9]], { times: [5000], split: true });
  const r = compile(project([hold, path('move', { start: 1 }, [E(10, 6), E(14, 6)]), pattern('next', { after: 'hold' }, [[9, 10]])]), rects);
  assert.deepEqual(r.spans.get('move'), { from: 1, to: 5 });
  assert.deepEqual(r.spans.get('hold'), { from: 1, to: 6 }, 'four frames of 0.5 s with the path, then the rest');
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map((f) => r.seq.timeOf(f)), [500, 500, 500, 500, 500, 2500, 500]);
  assert.equal(r.seq.elapsed(6), 5000, 'the hold lasts its 5 s');
  assert.deepEqual(r.spans.get('next'), { from: 6, to: 6 }, 'what follows the hold starts when it ends');
  assert.ok([1, 2, 3, 4, 5, 6].every((f) => r.seq.get(9, f)));
  assert.deepEqual(issues(r, 'waits'), []);
});

test('split: a wait can overrun by up to one frame; split actions alone take turns ending', () => {
  const r = compile(project([
    pattern('hold', { start: 1 }, [[9]], { times: [1200], split: true }),
    path('slow', { start: 1 }, [E(10, 6), E(14, 6)], { stepTime: 1000 }),
  ]), rects);
  assert.deepEqual(r.spans.get('hold'), { from: 1, to: 2 }, '2 s for a 1.2 s hold');
  const alone = compile(project([
    pattern('long', { start: 1 }, [[9]], { times: [3000], split: true }),
    pattern('short', { start: 1 }, [[20]], { times: [1000], split: true }),
  ]), rects);
  assert.deepEqual([alone.seq.timeOf(1), alone.seq.timeOf(2)], [1000, 2000]);
  assert.deepEqual(alone.spans.get('short'), { from: 1, to: 1 });
  assert.deepEqual(alone.spans.get('long'), { from: 1, to: 2 });
});

test('problems: off the array, past frame 200, missing or broken links, unknown kinds', () => {
  const r = compile(project([
    path('off', { start: 1 }, [E(1, 0), E(5, 4)]),
    path('late', { start: MAX_FRAMES - 1 }, [E(1, 0), E(5, 0)]),
    path('orphan', { after: 'nobody' }, [E(1, 0), E(2, 0)]),
    path('afterOff', { after: 'off' }, [E(1, 0), E(2, 0)]),
    { id: 'future', type: 'measure', name: 'Measure', droplet: '', start: 1, instrument: 'spectrometer' },
  ]), rects);
  const kinds = Object.fromEntries(r.issues.map((i) => [i.id, i.kind]));
  assert.deepEqual(kinds, { off: 'invalid', late: 'cut', orphan: 'link', afterOff: 'link', future: 'unknown' });
  assert.deepEqual(r.spans.get('late'), { from: MAX_FRAMES - 1, to: MAX_FRAMES, cut: true });
  assert.ok(r.seq.get(E(2, 0), MAX_FRAMES), 'the part before frame 200 is still there');
  assert.match(r.issues.find((i) => i.id === 'future').text, /kept in the file/);
});

test('a cycle of links never starts', () => {
  const r = compile(project([path('a', { after: 'b' }, [E(1, 0), E(2, 0)]), path('b', { after: 'a' }, [E(2, 0), E(3, 0)])]), rects);
  assert.equal(r.seq.lastFrame(), 1);
  assert.deepEqual(r.issues.map((i) => i.kind), ['link', 'link']);
});

test('importing an OpenDrop file and compiling it gives the same frames and times back', () => {
  const rand = random(5);
  for (const last of [1, 2, 17, 120, MAX_FRAMES]) {
    const seq = new Sequence();
    for (let f = 1; f <= last; f++) for (let e = 0; e < CELLS; e++) if (rand() < 0.05) seq.set(e, f, true);
    seq.set(Math.floor(rand() * CELLS), last, true);
    seq.frameTime = 400;
    for (let f = 1; f <= last; f++) if (rand() < 0.2) seq.setTime(f, 100 + Math.floor(rand() * 5000));
    const text = encode(seq);
    const { seq: loaded } = decode(text);
    const action = { id: 'a1', ...importSequence(loaded, 'file.json') };
    const r = compile(project([action], { frameTime: loaded.frameTime }), rects);
    assert.equal(encode(r.seq), text, `last frame ${last}`);
  }
});

test('an imported block keeps leading empty frames and their times', () => {
  const seq = new Sequence();
  seq.set(9, 3, true);
  seq.setTime(1, 2000);
  const action = importSequence(seq, 'x');
  assert.deepEqual(action.frames, [[], [], [9]]);
  assert.deepEqual(action.times, [2000, 0, 0]);
  assert.equal(action.start, 1);
});

test('“after” a list: a merge starts when the last droplet it waits for has arrived', () => {
  const merge = T.BUILT_IN.find((t) => t.id === 'merge');
  const r = compile(project([
    path('a', { start: 1 }, [E(2, 0), E(2, 3)]),
    path('b', { start: 1 }, [E(4, 7), E(4, 3)]),
    { id: 'm', type: 'template', name: 'm', droplet: '', after: ['a', 'b'], template: 'merge', at: E(2, 3), turns: 0 },
  ], { templates: { merge: { name: merge.name, frames: merge.frames } } }), rects);
  assert.deepEqual(r.spans.get('a'), { from: 1, to: 4 });
  assert.deepEqual(r.spans.get('b'), { from: 1, to: 5 });
  assert.deepEqual(r.spans.get('m'), { from: 5, to: 7 }, 'after the later one');
  assert.deepEqual(r.issues, [], 'no jump, and the droplets meeting in the merge is no touch');
});

test('droplets of different actions touch on the same or neighbouring electrodes, diagonals too', () => {
  const touchesOf = (actions) => [...compile(project(actions), rects).touches];
  assert.deepEqual(touchesOf([path('a', { start: 1 }, [E(1, 0), E(6, 0)]), path('b', { start: 1 }, [E(1, 2), E(6, 2)])]), []);
  assert.deepEqual(touchesOf([path('a', { start: 1 }, [E(1, 0), E(6, 0)]), path('b', { start: 1 }, [E(1, 1), E(6, 1)])]), ['a|b']);
  assert.deepEqual(touchesOf([path('a', { start: 1 }, [E(1, 0), E(2, 0)]), path('b', { start: 1 }, [E(3, 1), E(4, 1)])]), ['a|b'], 'diagonal');
  // b moves next to where a was a frame before
  assert.deepEqual(touchesOf([path('a', { start: 1 }, [E(5, 0), E(5, 3)]), path('b', { start: 2 }, [E(7, 0), E(6, 0), E(6, 7)])]), ['a|b']);
  const r = compile(project([path('a', { start: 1 }, [E(1, 0), E(6, 0)]), path('b', { start: 1 }, [E(1, 1), E(6, 1)])]), rects);
  assert.deepEqual(issues(r, 'touch').map((i) => [i.id, i.other, i.frame]), [['a', 'b', 1], ['b', 'a', 1]]);
});

test('no touch between an action and what carries on with its droplet; control lines don’t count', () => {
  const touchesOf = (actions, rectsFor = rects) => [...compile(project(actions), rectsFor).touches];
  assert.deepEqual(touchesOf([path('a', { start: 1 }, [E(1, 0), E(4, 0)]), path('b', { after: 'a', delay: 3 }, [E(4, 0), E(4, 4)])]), []);
  assert.deepEqual(touchesOf([path('a', { start: 1 }, [E(1, 0), E(4, 0)]), path('b', { start: 9 }, [E(4, 0), E(4, 4)])]), [], 'picked up later');
  const magnets = getLayout('electrodes_magnet').rects;
  assert.deepEqual(touchesOf([pattern('m', { start: 1 }, [[128], [128]]), path('b', { start: 1 }, [E(13, 6), E(14, 6)])], magnets), []);
});

test('a droplet rests where its action left it until something carries on from there', () => {
  const r = compile(project([
    path('a', { start: 1 }, [E(1, 0), E(4, 0)]),
    path('b', { start: 8 }, [E(4, 0), E(4, 4)]),
    path('c', { start: 20 }, [E(1, 1), E(6, 1)]),
  ]), rects);
  assert.deepEqual(r.resting.filter((x) => x.id === 'a'), [{ id: 'a', cells: [E(4, 0)], from: 5, to: 7 }]);
  assert.deepEqual(r.resting.filter((x) => x.id === 'b'), [{ id: 'b', cells: [E(4, 4)], from: 13, to: 25 }]);
  assert.deepEqual([...r.touches], [], 'c passes (4,1) after a’s droplet was taken, and far from b’s');
  const late = compile(project([path('a', { start: 1 }, [E(1, 0), E(4, 0)]), path('c', { start: 20 }, [E(1, 1), E(6, 1)])]), rects);
  assert.deepEqual([...late.touches], ['a|c'], 'with nothing taking it, a’s droplet is still on (4,0)');
});
