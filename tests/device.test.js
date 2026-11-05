'use strict';
// Talking to the OpenDrop: the bytes of today's protocol, lining the stream up, one frame in flight,
// the session the page uses, and the proposed protocol 1 - all against a simulated device that
// counts bytes the way OpenDropV42.ino does.
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../js/device.js');
const { SimulatedOpenDrop } = require('../js/device-sim.js');
const { Sequence } = require('../js/model.js');

const FAST = { timeout: 80, settle: 20, boot: 60 };
const until = async (cond, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 2));
  }
};
const last = (sim) => sim.frames[sim.frames.length - 1];

test('a frame: one byte per column, bit = row; magnets, feedback, temperatures and command in their bytes', () => {
  const f = D.encodeFrame([0, 9, 15, 127, 128, 129, 143], { feedback: true, temps: [30, 200, 5], command: 4 });
  assert.equal(f.length, 32);
  assert.equal(f[0], 0b00000001, 'electrode 0: column 0, row 0');
  assert.equal(f[1], 0b10000010, 'electrodes 9 and 15: column 1, rows 1 and 7');
  assert.equal(f[15], 0b10000000);
  assert.equal(f[16], 0b00000011, 'electrodes 128 and 129: the magnets (0x1 and 0x2 for the firmware)');
  assert.equal(f[17], 0b10000000, 'electrode 143');
  assert.equal(f[24], 1, 'feedback on');
  assert.deepEqual([f[26], f[27], f[28]], [30, 120, 20], 'temperature targets, kept to 20-120 °C');
  assert.equal(f[31], 4, 'the command (protocol 1)');
  assert.deepEqual(Array.from(D.encodeFrame([]).subarray(26, 29)), [25, 25, 25], 'targets default to 25 °C, as the original sends');
  const seq = new Sequence();
  seq.set(9, 3, true);
  seq.set(128, 3, true);
  assert.deepEqual(D.cellsIn(seq, 3), [9, 128]);
});

test('an answer: sensed electrodes (bits reversed), temperatures, protocol and board', () => {
  const a = new Uint8Array(24);
  a[1] = 0b01000000; // bit 6 = row 1: electrode 9
  a[14] = 0b00000001; // bit 0 = row 7: electrode 119
  a[16] = 1;
  a[17] = 50;
  a[18] = 37; // 37.50 °C
  a[20] = 255; // no sensor
  a[21] = 5;
  a[22] = 24; // 24.05 °C
  a[23] = 0x12;
  const r = D.decodeReply(a);
  assert.deepEqual(r.sensed, [9, 119]);
  assert.deepEqual(r.temps, [37.5, null, 24.05]);
  assert.equal(r.protocol, 1);
  assert.equal(r.board.name, 'OpenDrop V4.2 · magnet & temperature adapter');
  const names = [0x00, 0x01, 0x10, 0x11, 0x12].map((id) => D.boardInfo(id));
  assert.deepEqual(names.map((b) => b.name), ['OpenDrop V4.1', 'OpenDrop V4.1 · magnet', 'OpenDrop V4.2', 'OpenDrop V4.2 · magnet', 'OpenDrop V4.2 · magnet & temperature adapter']);
  assert.deepEqual(names.map((b) => [b.magnet, b.feedback, b.temperature]), [[false, false, false], [true, false, false], [false, true, false], [true, true, false], [true, true, true]]);
});

test('lining up: from any byte count the device is stuck at, the next frame lands whole', async () => {
  for (const stuckAt of [0, 1, 2, 9, 16, 30, 31]) {
    const sim = new SimulatedOpenDrop({ stuckAt });
    const link = new D.Link(sim, FAST);
    assert.ok(await link.sync(), `stuck at ${stuckAt}`);
    assert.equal(sim.count, 0, `lined up from ${stuckAt}`);
    assert.ok(await link.exchange(D.encodeFrame([9, 10]), D.REPLY));
    assert.deepEqual(last(sim), [9, 10]);
    await link.close();
  }
});

test('lining up waits for a device that is starting, and drops its start-up text', async () => {
  const sim = new SimulatedOpenDrop({ boot: 100, stuckAt: 0 });
  const link = new D.Link(sim, FAST);
  assert.ok(await link.sync());
  assert.equal(sim.count, 0);
  const answer = await link.exchange(D.encodeFrame([20]), D.REPLY);
  assert.equal(D.decodeReply(answer).board.id, 0x12, 'a real answer, not text');
  await link.close();
  assert.ok(!(await new D.Link(new SimulatedOpenDrop({ silent: true }), FAST).sync()), 'a port that never answers');
});

test('one frame in flight: while one is out, only the newest waiting one is sent', async () => {
  const sim = new SimulatedOpenDrop({ latency: 15 });
  const link = new D.Link(sim, FAST);
  await link.sync();
  const before = sim.frames.length;
  const sent = [1, 2, 3, 4, 5].map((e) => link.send(D.encodeFrame([e])));
  const results = await Promise.all(sent);
  assert.deepEqual(results.map((r) => (r === undefined ? 'replaced' : r ? 'answered' : 'none')), ['answered', 'replaced', 'replaced', 'replaced', 'answered']);
  assert.deepEqual(sim.frames.slice(before), [[1], [5]]);
  await link.close();
});

function session(opts = {}) {
  const events = { boards: [], lost: 0, changes: 0 };
  const s = new D.Session(
    { board: (b) => events.boards.push(b.name), lost: () => events.lost++, change: () => events.changes++ },
    { poll: 40, pollFeedback: 20, pollRun: 15, link: FAST, ...opts }
  );
  return { s, events };
}

test('a session: connect with everything off, live follows the frame on screen, off again', async () => {
  const sim = new SimulatedOpenDrop({ board: 0x11 });
  const { s, events } = session();
  s.show([9, 10]);
  assert.ok(await s.attach(sim));
  assert.equal(s.state, 'on');
  assert.deepEqual(events.boards, ['OpenDrop V4.2 · magnet']);
  assert.deepEqual(last(sim), [], 'live starts off: everything off');
  s.setLive(true);
  await until(() => last(sim).join() === '9,10');
  s.show([11, 129]);
  await until(() => last(sim).join() === '11,129', 500);
  s.setLive(false);
  await until(() => last(sim).length === 0);
  await s.detach();
  assert.equal(s.state, 'off');
  assert.ok(sim.closed);
});

test('feedback shows the sensed electrodes; temperature targets reach the device and readings come back', async () => {
  const sim = new SimulatedOpenDrop({ board: 0x12 });
  const { s } = session();
  await s.attach(sim);
  s.show([12, 13]);
  s.setLive(true);
  s.setFeedback(true);
  await until(() => s.sensed.join() === '12,13');
  s.setTargets([30, 25, 25]);
  await until(() => sim.targets[0] === 30);
  await until(() => s.temps[0] > 21.5);
  assert.equal(s.temps.length, 3);
  s.setFeedback(false);
  assert.deepEqual(s.sensed, []);
  await s.detach();
  assert.deepEqual(last(sim), [], 'disconnecting switches everything off first');
});

test('a device that stops answering is marked so and lined up again when it answers; unplugging ends the session', async () => {
  const sim = new SimulatedOpenDrop({ board: 0x10 });
  const { s, events } = session();
  await s.attach(sim);
  s.setLive(true);
  sim.silent = true;
  s.show([30]);
  await until(() => s.state === 'silent');
  sim.silent = false;
  sim.count = 7; // and its count went astray meanwhile
  await until(() => s.state === 'on', 3000);
  await until(() => last(sim).join() === '30');
  sim.unplug();
  assert.equal(events.lost, 1);
  assert.equal(s.state, 'off');
  assert.equal(s.live, false);
});

test('protocol 1: a sequence block with its frame times and checksum', () => {
  assert.equal(D.crc16(Buffer.from('123456789')), 0x29b1);
  const seq = new Sequence();
  seq.set(9, 1, true);
  seq.set(10, 2, true);
  seq.set(129, 2, true);
  seq.setTime(2, 1500);
  const block = D.encodeSequence(seq);
  assert.equal(block.length, 4 + 2 * 22 + 2);
  assert.deepEqual(Array.from(block.subarray(0, 4)), [0x4f, 0x44, 1, 2]);
  const back = D.decodeSequence(block);
  assert.deepEqual(back.frames, [[9], [10, 129]]);
  assert.deepEqual(back.times, [seq.frameTime, 1500]);
  block[10] ^= 1;
  assert.equal(D.decodeSequence(block).error, 'bad checksum');
});

test('protocol 1: load, run on the device, status until done; stop; a protocol 0 device is never sent commands', async () => {
  const seq = new Sequence();
  for (let f = 1; f <= 4; f++) seq.set(8 + f, f, true);
  const sim = new SimulatedOpenDrop({ protocol: 1, timeScale: 0.01 });
  const { s } = session();
  await s.attach(sim);
  assert.ok(s.canLoad);
  s.show([50]);
  s.setLive(true);
  const loaded = await s.load(D.encodeSequence(seq));
  assert.deepEqual(loaded, { ok: true, frames: 4 });
  assert.equal(s.live, false, 'loading turns live off');
  const start = sim.frames.length;
  assert.deepEqual(await s.start(), { ok: true });
  await until(() => s.run === null, 3000);
  assert.deepEqual(sim.frames.slice(start), [[9], [10], [11], [12], []], 'its frames in order, then everything off');

  // Stop while running.
  sim.timeScale = 10;
  await s.start();
  await until(() => sim.run && sim.run.frame >= 1);
  assert.equal((await s.stop()).ok, true);
  assert.equal(sim.run, null);
  assert.deepEqual(last(sim), []);
  await s.detach();

  const old = new SimulatedOpenDrop({ protocol: 0 });
  const { s: s0 } = session();
  await s0.attach(old);
  assert.equal(s0.canLoad, false);
  const frames = old.frames.length;
  const refused = await s0.load(D.encodeSequence(seq));
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /only follows live frames/);
  assert.equal(old.frames.length, frames, 'nothing was sent to it');
  await s0.detach();
});
