'use strict';
// The process: tiles and arrows, stretches (what one board shows), loops and their labels, the
// checks, the tidy layout, and a run going through it.
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../js/process.js');

// Builds a process from a list of [kind, fields] and arrows "a>b" / "a.port>b" by index (1-based).
function build(tiles, arrows) {
  const p = P.emptyProcess();
  const ids = tiles.map(([kind, fields = {}]) => P.addTile(p, kind, 0, 0, fields).id);
  for (const a of arrows) {
    const [, from, port = 'next', to] = /^(\d+)(?:\.(\w+))?>(\d+)$/.exec(a);
    const why = P.link(p, ids[from - 1], port, ids[to - 1]);
    if (why) throw new Error(`${a}: ${why}`);
  }
  return { p, id: (n) => ids[n - 1] };
}

// Dispense, move to a mixer, mix, measure; dilute again (mix) until conc < 5.
const dilution = () =>
  build(
    [['start'], ['dispense'], ['move'], ['mix'], ['measure', { value: 'conc', unit: 'mM' }], ['decision', { value: 'conc', op: '<', than: 5 }], ['end']],
    ['1>2', '2>3', '3>4', '4>5', '5>6', '6.yes>7', '6.no>4']
  );

test('tiles and arrows: ids, settings to start with, one arrow per output, and what can’t be linked', () => {
  const p = P.emptyProcess();
  const s = P.addTile(p, 'start', 0, 0);
  const m = P.addTile(p, 'measure');
  const d = P.addTile(p, 'decision');
  assert.deepEqual([s.id, m.id, d.id], ['p1', 'p2', 'p3']);
  assert.equal(m.value, 'conc');
  assert.deepEqual([d.value, d.op], ['conc', '<'], 'a decision starts with the last measured value');
  assert.equal(P.addTile(p, 'measure').value, 'value2', 'a second measure gets a value of its own');
  const step = P.addTile(p, 'step');
  assert.equal(P.link(p, s.id, 'next', step.id), null);
  assert.equal(P.link(p, s.id, 'next', m.id), null);
  assert.deepEqual(p.links.filter((l) => l.from === s.id).map((l) => l.to), [m.id], 'the output’s arrow was replaced');
  assert.match(P.link(p, m.id, 'next', s.id), /Start/);
  assert.match(P.link(p, m.id, 'next', m.id), /itself/);
  assert.match(P.link(p, d.id, 'next', m.id), /no next output/);
  const par = P.addTile(p, 'parallel', 0, 0, { lanes: 3 });
  assert.deepEqual(P.portsOf(par), ['lane1', 'lane2', 'lane3']);
  P.link(p, par.id, 'lane3', step.id);
  P.setLanes(p, par.id, 2);
  assert.ok(!p.links.some((l) => l.from === par.id), 'the arrow from a lane that went is dropped');
  assert.ok(P.removeTile(p, m.id));
  assert.ok(!p.links.some((l) => l.to === m.id || l.from === m.id));
});

test('stretches: the steps between stops; a loop’s start begins one; parallel lanes stay together', () => {
  const { p, id } = dilution();
  const st = P.stretches(p);
  assert.deepEqual(st.list.map((s) => s.tiles), [[id(2), id(3)], [id(4)]]);
  assert.equal(st.of.get(id(5)), undefined, 'a measure is a stop, not in a stretch');

  const par = build(
    [['start'], ['parallel'], ['dispense'], ['move'], ['dispense'], ['join'], ['merge'], ['end']],
    ['1>2', '2.lane1>3', '3>4', '2.lane2>5', '4>6', '5>6', '6>7', '7>8']
  );
  assert.deepEqual(P.stretches(par.p).list.map((s) => s.tiles), [[2, 3, 4, 5, 6, 7].map(par.id)]);

  const ifElse = build(
    [['start'], ['ask'], ['decision', { value: 'ok', op: 'is', than: 'yes' }], ['step'], ['step'], ['step'], ['end']],
    ['1>2', '2>3', '3.yes>4', '3.no>5', '4>6', '5>6', '6>7']
  );
  assert.deepEqual(P.stretches(ifElse.p).list.map((s) => s.tiles), [[ifElse.id(4)], [ifElse.id(5)], [ifElse.id(6)]], 'where the two ways meet again starts a stretch');
});

test('loops: the tiles they go round and a label from the decision that leads out', () => {
  const { p, id } = dilution();
  const [lp] = P.loops(p);
  assert.equal(lp.label, 'repeat until conc < 5 mM');
  assert.deepEqual(lp.tiles, [id(4), id(5), id(6)]);

  p.links.find((l) => l.port === 'yes').to = id(4); // yes goes back instead, no goes on
  p.links.find((l) => l.port === 'no').to = id(7);
  assert.equal(P.loops(p)[0].label, 'repeat while conc < 5 mM');

  const rep = build([['start'], ['repeat', { times: 3 }], ['mix'], ['end']], ['1>2', '2.again>3', '3>2', '2.done>4']);
  assert.equal(P.loops(rep.p)[0].label, 'repeat 3×');

  const forever = build([['start'], ['step'], ['step']], ['1>2', '2>3', '3>2']);
  const [f] = P.loops(forever.p);
  assert.ok(f.endless);
  assert.ok(P.check(forever.p).some((i) => /never ends/.test(i.text)));
});

test('checks: Start, arrows going nowhere, tiles never reached, values not measured, parallel lanes', () => {
  assert.ok(P.check(P.emptyProcess()).some((i) => /no Start/.test(i.text)));
  const { p, id } = dilution();
  assert.deepEqual(P.check(p), [], 'the dilution loop is fine');

  const loose = build([['start'], ['decision', { value: 'conc', op: '<', than: 1 }], ['step'], ['measure', { value: 'conc' }]], ['1>2', '2.yes>3']);
  const texts = P.check(loose.p).map((i) => i.text);
  assert.ok(texts.includes('Its no arrow goes nowhere'));
  assert.ok(texts.some((t) => /A run never gets here/.test(t)), 'the measure is never reached');
  assert.ok(texts.some((t) => /conc isn't measured before this/.test(t)));

  const inLanes = build(
    [['start'], ['parallel'], ['measure'], ['step'], ['join'], ['end']],
    ['1>2', '2.lane1>3', '3>5', '2.lane2>4', '4>5', '5>6']
  );
  assert.ok(P.check(inLanes.p).some((i) => /Measure can't be inside parallel lanes/.test(i.text)));
  const noJoin = build([['start'], ['parallel'], ['step'], ['step'], ['end']], ['1>2', '2.lane1>3', '2.lane2>4', '3>5', '4>5']);
  const noJoinTexts = P.check(noJoin.p).map((i) => i.text);
  assert.ok(noJoinTexts.some((t) => /don't join again/.test(t)));
  void id;
});

// A tile's box on the canvas: [left, top, right, bottom].
const box = (t) => {
  const [w, h] = P.sizeOf(t);
  return [t.x - w / 2, t.y - h / 2, t.x + w / 2, t.y + h / 2];
};

test('tidy: top-down rows, a second output to the right; arrows going back up don’t push tiles down', () => {
  const { p, id } = dilution();
  P.tidy(p);
  const tile = (n) => p.tiles.find((t) => t.id === id(n));
  const ys = [1, 2, 3, 4, 5, 6, 7].map((n) => tile(n).y);
  assert.equal(ys[0], 0, 'Start is at the top');
  assert.ok(ys.every((y, i) => i === 0 || y > ys[i - 1]), `one row each, in order: ${ys}`);
  assert.ok([1, 2, 3, 4, 5, 6, 7].every((n) => tile(n).x === 0), 'one column: the loop goes back up');
  const ifElse = build([['start'], ['ask'], ['decision', { value: 'ok', op: 'is', than: 'yes' }], ['step'], ['step'], ['end']], ['1>2', '2>3', '3.yes>4', '3.no>5', '4>6', '5>6']);
  P.tidy(ifElse.p);
  const t = (n) => ifElse.p.tiles.find((x) => x.id === ifElse.id(n));
  assert.equal(t(4).x, t(3).x, 'yes carries on below');
  assert.ok(t(5).x > t(3).x, 'no goes to the right');
  assert.equal(t(4).y, t(5).y, 'both ways on one row');
  assert.ok(t(6).y > t(4).y, 'where they meet again goes below the lowest of them');
});

test('tidy: rows and columns sized by their tiles, with short gaps and no overlaps', () => {
  const par = build(
    [['start'], ['parallel'], ['dispense'], ['move'], ['dispense'], ['merge'], ['ask'], ['decision', { value: 'ok', op: 'is', than: 'yes' }], ['end'], ['end']],
    ['1>2', '2.lane1>3', '3>4', '2.lane2>5', '4>6', '5>6', '6>7', '7>8', '8.yes>9', '8.no>10']
  );
  P.tidy(par.p);
  const tiles = par.p.tiles;
  for (const a of tiles) {
    for (const b of tiles) {
      if (a === b) continue;
      const [al, at, ar, ab] = box(a);
      const [bl, bt, br, bb] = box(b);
      assert.ok(ar <= bl || br <= al || ab <= bt || bb <= at, `${a.id} and ${b.id} overlap`);
    }
  }
  // Each arrow going down is short: from the bottom of one row to the top of the next.
  const t = (n) => tiles.find((x) => x.id === par.id(n));
  for (const [a, b] of [[1, 2], [2, 3], [3, 4], [6, 7], [7, 8], [8, 9]]) {
    const gap = box(t(b))[1] - box(t(a))[3];
    assert.ok(gap >= 30 && gap <= 45, `${a}→${b}: a gap of ${gap}`);
  }
  // A short tile in a row of tall ones: centred, and the row is as tall as its tallest tile.
  assert.equal(t(3).y, t(5).y, 'the two lanes start on one row');
  assert.equal(box(t(8))[1] - box(t(7))[3], P.GAP_Y, 'a decision row is as tall as the decision');
  // Columns: each as wide as its widest tile, GAP_X apart.
  const xs = [...new Set(tiles.map((x) => x.x))].sort((a, b) => a - b);
  assert.equal(xs.length, 3, 'yes and lane 1 below Start, no, then lane 2');
  const widest = (x) => Math.max(...tiles.filter((y) => y.x === x).map((y) => P.sizeOf(y)[0]));
  for (let i = 1; i < xs.length; i++) assert.equal(xs[i] - widest(xs[i]) / 2 - (xs[i - 1] + widest(xs[i - 1]) / 2), P.GAP_X);
  assert.ok(t(10).x > t(9).x, 'no goes to the right');
  assert.ok(t(5).x > t(3).x, 'lane 2 goes to the right');
});

test('tidy: room above a loop for its outline and label, and below it', () => {
  const { p, id } = dilution();
  P.tidy(p);
  const t = (n) => p.tiles.find((x) => x.id === id(n));
  const [lp] = P.loops(p);
  const top = Math.min(...lp.tiles.map((x) => box(P.tileById(p, x))[1]));
  const bottom = Math.max(...lp.tiles.map((x) => box(P.tileById(p, x))[3]));
  // The outline is drawn LOOP.top above its top tile and LOOP.bottom below its bottom one.
  const above = box(t(3))[3]; // the move, just before the loop
  const below = box(t(7))[1]; // End, just after it
  assert.ok(top - P.LOOP.top - above >= 16, `the outline clears the tile above: ${top - P.LOOP.top - above}`);
  assert.ok(below - (bottom + P.LOOP.bottom) >= 16, `the outline clears the tile below: ${below - (bottom + P.LOOP.bottom)}`);
  assert.ok(top - above > box(t(3))[1] - box(t(2))[3], 'more room above the loop than between other rows');
  assert.ok(top - above <= 70, 'but not much more');
});

test('tile sizes: Start and End small, a decision tall, parallel and Wait for all thin bars', () => {
  const sizes = Object.fromEntries(Object.keys(P.KINDS).map((k) => [k, P.sizeOf({ kind: k })]));
  assert.deepEqual(sizes.start, [120, 40]);
  assert.deepEqual(sizes.end, [120, 40]);
  assert.deepEqual(sizes.decision, [190, 84]);
  assert.deepEqual(sizes.repeat, [170, 52]);
  assert.deepEqual(sizes.parallel, [230, 20]);
  assert.deepEqual(sizes.join, [230, 20]);
  for (const k of ['step', 'dispense', 'move', 'mix', 'merge', 'split', 'wait', 'measure', 'ask']) assert.deepEqual(sizes[k], [210, 60], k);
});

// Two lanes, each with a droplet, going straight into a Merge: no Wait for all.
const lanesIntoMerge = () =>
  build(
    [['start'], ['parallel'], ['dispense'], ['move'], ['dispense'], ['merge'], ['end']],
    ['1>2', '2.lane1>3', '3>4', '2.lane2>5', '4>6', '5>6', '6>7']
  );

test('a merge takes several arrows in: the lanes end there, like a Wait for all', () => {
  const { p, id } = lanesIntoMerge();
  assert.deepEqual(P.stretches(p).list.map((s) => s.tiles), [[2, 3, 4, 5, 6].map(id)], 'one stretch: the merge doesn’t start another');
  assert.deepEqual(P.check(p), [], 'lanes may end in a Merge');

  // One arrow in is fine for a merge (both droplets came one way), not for a Wait for all.
  const one = build([['start'], ['dispense'], ['dispense'], ['merge'], ['end']], ['1>2', '2>3', '3>4', '4>5']);
  assert.deepEqual(P.check(one.p), []);
  const join = build([['start'], ['step'], ['join'], ['end']], ['1>2', '2>3', '3>4']);
  assert.ok(P.check(join.p).some((i) => /Only one lane/.test(i.text)));

  // Lanes coming from different stretches: the merge starts a stretch of its own.
  const ways = build(
    [['start'], ['ask'], ['decision', { value: 'ok', op: 'is', than: 'yes' }], ['dispense'], ['dispense'], ['merge'], ['end']],
    ['1>2', '2>3', '3.yes>4', '3.no>5', '4>6', '5>6', '6>7']
  );
  assert.deepEqual(P.stretches(ways.p).list.map((s) => s.tiles), [[ways.id(4)], [ways.id(5)], [ways.id(6)]]);

  // A stop in a lane is still an error, and lanes that never end too.
  const stop = build([['start'], ['parallel'], ['measure'], ['step'], ['merge'], ['end']], ['1>2', '2.lane1>3', '3>5', '2.lane2>4', '4>5', '5>6']);
  assert.ok(P.check(stop.p).some((i) => /Measure can't be inside parallel lanes/.test(i.text)));
});

test('inputs: none on Start, one per arrow on a merge or Wait for all (at least two), else one', () => {
  const { p, id } = lanesIntoMerge();
  assert.equal(P.inputsOf(P.tileById(p, id(1)), p), 0);
  assert.equal(P.inputsOf(P.tileById(p, id(3)), p), 1);
  assert.equal(P.inputsOf(P.tileById(p, id(7)), p), 1);
  assert.equal(P.inputsOf(P.tileById(p, id(6)), p), 2);
  assert.equal(P.inputsOf({ kind: 'merge', id: 'x' }), 2, 'without the process: two');
  assert.equal(P.inputsOf({ kind: 'join', id: 'x' }), 2);
  const three = build(
    [['start'], ['parallel', { lanes: 3 }], ['step'], ['step'], ['step'], ['join'], ['end']],
    ['1>2', '2.lane1>3', '2.lane2>4', '2.lane3>5', '3>6', '4>6', '5>6', '6>7']
  );
  assert.equal(P.inputsOf(P.tileById(three.p, three.id(6)), three.p), 3);
  assert.equal(P.inputsOf(P.tileById(three.p, three.id(2)), three.p), 1, 'a parallel has one way in');
});

test('names and groups: every kind says what it does and is in the palette once', () => {
  for (const [k, kind] of Object.entries(P.KINDS)) assert.ok(typeof kind.about === 'string' && kind.about.length > 10, k);
  assert.equal(P.KINDS.join.name, 'Wait for all');
  assert.match(P.KINDS.merge.about, /become one/);
  assert.match(P.KINDS.join.about, /stay apart/);
  assert.match(P.KINDS.mix.about, /one droplet/);
  const listed = P.PALETTE_GROUPS.flatMap((g) => g.kinds);
  assert.deepEqual([...listed].sort(), Object.keys(P.KINDS).sort(), 'every kind once');
  assert.equal(new Set(listed).size, listed.length);
  assert.ok(P.PALETTE_GROUPS.every((g) => g.name && g.kinds.length));
  assert.deepEqual(P.PALETTE, listed);
  assert.deepEqual(P.PALETTE_GROUPS.find((g) => g.kinds.includes('merge')).kinds, ['step', 'dispense', 'move', 'mix', 'merge', 'split', 'wait']);
});

test('a Wait for all straight into a Merge isn’t needed: a hint, nothing blocked', () => {
  const both = build(
    [['start'], ['parallel'], ['dispense'], ['dispense'], ['join'], ['merge'], ['end']],
    ['1>2', '2.lane1>3', '2.lane2>4', '3>5', '4>5', '5>6', '6>7']
  );
  const issues = P.check(both.p);
  assert.deepEqual(issues.map((i) => [i.tile, i.level]), [[both.id(5), 'warn']]);
  assert.match(issues[0].text, /The Merge already waits for its lanes: this Wait for all isn't needed/);
  const w = new P.Walk(both.p);
  assert.equal(w.step.kind, 'stretch', 'a run still goes');
});

test('a run: stretches in turn, the measured value decides, the loop goes round until it holds', () => {
  const { p, id } = dilution();
  const w = new P.Walk(p);
  const played = [];
  const answers = [7, 3];
  while (w.step.kind !== 'end' && w.step.kind !== 'stuck') {
    if (w.step.kind === 'stretch') {
      played.push(w.step.stretch.id);
      w.go();
    } else w.answer(answers.shift());
  }
  assert.equal(w.step.kind, 'end');
  assert.deepEqual(played, [id(2), id(4), id(4)], 'dispense and move, then mix twice');
  assert.deepEqual(w.log.filter((e) => e.kind === 'decision').map((e) => e.text), ['conc < 5 mM: no', 'conc < 5 mM: yes']);
  assert.deepEqual(w.values, { conc: 3 });
});

test('a run: repeat counts its rounds, a decision without its value asks for it, a dead end stops', () => {
  const rep = build([['start'], ['repeat', { times: 2 }], ['mix'], ['end']], ['1>2', '2.again>3', '3>2', '2.done>4']);
  const w = new P.Walk(rep.p);
  let plays = 0;
  while (w.step.kind === 'stretch') {
    plays++;
    w.go();
  }
  assert.equal(plays, 2);
  assert.equal(w.step.kind, 'end');

  const unasked = build([['start'], ['decision', { value: 'conc', op: '>', than: 1 }], ['end'], ['end'], ['measure', { value: 'conc' }]], ['1>2', '2.yes>3', '2.no>4']);
  const u = new P.Walk(unasked.p);
  assert.equal(u.step.kind, 'ask');
  assert.equal(u.step.missing, 'conc');
  u.answer(2);
  assert.equal(u.step.kind, 'end');
  assert.equal(u.step.tile, unasked.id(3));

  const dead = build([['start'], ['step']], ['1>2']);
  const d = new P.Walk(dead.p);
  d.go();
  assert.equal(d.step.kind, 'stuck');
  assert.match(d.step.text, /nothing comes after it/);
});

test('conditions: comparisons and yes/no', () => {
  const t = (op, than) => ({ value: 'v', op, than });
  assert.equal(P.evaluate(t('<', 5), { v: 3 }), true);
  assert.equal(P.evaluate(t('>=', 5), { v: 5 }), true);
  assert.equal(P.evaluate(t('!=', 5), { v: 5 }), false);
  assert.equal(P.evaluate(t('<', 5), {}), undefined);
  assert.equal(P.evaluate(t('is', 'yes'), { v: true }), true);
  assert.equal(P.evaluate(t('is', 'no'), { v: true }), false);
  assert.equal(P.conditionText(t('<=', 2)), 'v ≤ 2');
});
