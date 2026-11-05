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

test('tidy: top-down rows, a second output to the right; arrows going back up don’t push tiles down', () => {
  const { p, id } = dilution();
  P.tidy(p);
  const at = (n) => [p.tiles.find((t) => t.id === id(n)).x, p.tiles.find((t) => t.id === id(n)).y];
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map((n) => at(n)[1] / P.ROW), [0, 1, 2, 3, 4, 5, 6]);
  assert.ok([1, 2, 3, 4, 5, 6, 7].every((n) => at(n)[0] === 0), 'one column: the loop goes back up');
  const ifElse = build([['start'], ['ask'], ['decision', { value: 'ok', op: 'is', than: 'yes' }], ['step'], ['step'], ['end']], ['1>2', '2>3', '3.yes>4', '3.no>5', '4>6', '5>6']);
  P.tidy(ifElse.p);
  const x = (n) => ifElse.p.tiles.find((t) => t.id === ifElse.id(n)).x;
  assert.equal(x(4), x(3), 'yes carries on below');
  assert.ok(x(5) > x(3), 'no goes to the right');
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
