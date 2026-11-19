'use strict';
// The traffic log: what the link reports (every packet out, every answer, no answer, start-up
// text), the words for each, and folding repeated status packets.
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../js/device.js');
const { SimulatedOpenDrop } = require('../js/device-sim.js');

const FAST = { timeout: 80, settle: 20, boot: 60 };
const until = async (cond, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 2));
  }
};

test('the link reports what it writes and what comes back, lining up included', async (t) => {
  const sim = new SimulatedOpenDrop({ board: 0x12, stuckAt: 5 });
  const s = new D.Session({}, { poll: 40, link: FAST });
  t.after(() => s.detach());
  const seen = [];
  s.tap = (e) => seen.push(e);
  await s.attach(sim);
  assert.ok(seen.some((e) => e.dir === 'out' && e.bytes.length === 31), 'lining up: 31 zero bytes');
  assert.ok(seen.some((e) => e.dir === 'none'), 'some of them get no answer');
  const n = seen.length;
  s.show([9, 17], null, 'Hello');
  s.setLive(true);
  await until(() => seen.slice(n).some((e) => e.dir === 'in'));
  const out = seen.slice(n).find((e) => e.dir === 'out');
  assert.equal(out.bytes.length, 32 + 5, 'the message text after the packet');
  assert.match(D.describeOut(out.bytes), /^electrodes 9, 17 · heaters off \/ off \/ off · message “Hello” \(5 bytes after the packet\)$/);
  const answer = seen.slice(n).find((e) => e.dir === 'in');
  assert.equal(answer.bytes.length, 24);
  assert.match(D.describeIn(answer.bytes), /OpenDrop V4\.2 .* \(id 0x12\)/);
});

test('words for a packet: magnets, feedback, high voltage, save, a clear', () => {
  const p = D.encodeFrame([128, 129], { feedback: true, hv: { volts: 200, hz: 500, mode: 'ac' }, save: true, message: '' });
  assert.equal(D.describeOut(p), 'all electrodes off · magnets M1 M2 on · feedback on · heaters off / off / off · clear the screen message · high voltage 200 V, 500 Hz, AC · SAVE settings to flash');
  assert.equal(D.describeOut(new Uint8Array(1)), '1 zero byte (lining up)');
  assert.equal(D.hex(Uint8Array.from([0, 15, 255])), '00 0f ff');
});

test('the log folds the same packet and answer into a count, and gives it as text', () => {
  // A stand-in for the page: just enough of the DOM.
  const el = () => ({ children: [], className: '', textContent: '', checked: false, scrollTop: 0, clientHeight: 0, scrollHeight: 0,
    addEventListener() {}, append(...c) { this.children.push(...c); }, appendChild(c) { this.children.push(c); }, replaceChildren() { this.children = []; }, remove() {} });
  global.document = { createElement: el };
  global.OD = { device: D };
  require('../js/seriallog.js');
  const { SerialLog } = global.OD.serialLog;
  const dom = { on: el(), fold: el(), clear: el(), copy: el(), save: el(), list: el(), count: el() };
  dom.fold.checked = true;
  const log = new SerialLog(dom, { setStatus() {} });
  log.setOn(true);
  const status = D.encodeFrame([]);
  const reply = new Uint8Array(24);
  reply[23] = 0x12;
  for (let i = 0; i < 5; i++) {
    log.add({ dir: 'out', bytes: status });
    log.add({ dir: 'in', bytes: reply });
  }
  assert.equal(log.entries.length, 2, 'five status checks: one pair');
  assert.deepEqual(log.entries.map((e) => e.count), [5, 5]);
  // Readings that change a little each time still fold; the entry shows the latest.
  const warmer = reply.slice();
  warmer[17] = 37;
  warmer[18] = 22;
  log.add({ dir: 'out', bytes: status });
  log.add({ dir: 'in', bytes: warmer });
  assert.equal(log.entries.length, 2);
  assert.deepEqual(log.entries.map((e) => e.count), [6, 6]);
  assert.ok(log.entries[1].varied);
  assert.match(D.describeIn(log.entries[1].bytes), /T1 22\.37 °C/);
  // A different answer otherwise (it senses a droplet) doesn't.
  const sensing = warmer.slice();
  sensing[1] = 0b10000000;
  log.add({ dir: 'out', bytes: status });
  log.add({ dir: 'in', bytes: sensing });
  assert.equal(log.entries.length, 4);
  log.entries.splice(2);
  log.held = null;
  log.add({ dir: 'out', bytes: D.encodeFrame([9]) });
  log.add({ dir: 'in', bytes: reply });
  log.add({ dir: 'out', bytes: status });
  log.add({ dir: 'none', bytes: new Uint8Array(0), wait: 500 });
  assert.deepEqual(log.entries.map((e) => [e.dir, e.count]), [['out', 6], ['in', 6], ['out', 1], ['in', 1], ['out', 1], ['none', 1]]);
  const text = log.text();
  assert.match(text, /→ sent 32 bytes ×6: all electrodes off/);
  assert.match(text, /← answer, 24 bytes ×6 \(temperatures: the latest\): /);
  assert.match(text, /→ sent 32 bytes: electrodes 9 ·/);
  assert.match(text, /× no answer: nothing came back within 500 ms/);
  assert.match(text, /\n    00 00 00/);
  log.setOn(false);
  log.add({ dir: 'out', bytes: status });
  assert.equal(log.entries.length, 6, 'nothing is logged while off');
  delete global.document;
});
