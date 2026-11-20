'use strict';
// Talking to the OpenDrop: the bytes of today's protocol, lining the stream up, one frame in flight,
// the session the page uses, and the proposed protocol 1 - all against a simulated device that
// counts bytes the way OpenDropV42.ino does.
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../js/device.js');
const { SimulatedOpenDrop } = require('../js/device-sim.js');
const { Sequence } = require('../js/model.js');

const FAST = { timeout: 80, settle: 20, boot: 60, ack: 40 };
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
  assert.equal(f[17], 0, 'electrode 143 isn\'t sent: byte 17 is the message length (custom firmware)');
  assert.equal(f[24], 1, 'feedback on');
  assert.deepEqual([f[26], f[27], f[28]], [30, 120, 20], 'temperature targets, kept to 20-120 °C');
  assert.equal(f[23], 4, 'the command (protocol 1), in byte 23');
  assert.equal(f[25], 0, 'not saving the settings');
  assert.deepEqual(Array.from(f.subarray(29, 32)), [0, 0, 0], 'no high voltage set: 0 = the device keeps its own');
  assert.deepEqual(Array.from(D.encodeFrame([]).subarray(26, 29)), [0, 0, 0], 'heaters off unless set: 0 (not the original’s 25 °C, which keeps them heating)');
  assert.deepEqual(Array.from(D.encodeFrame([], { temps: [null, 40, ''] }).subarray(26, 29)), [0, 40, 0], 'null or empty: off');
  const seq = new Sequence();
  seq.set(9, 3, true);
  seq.set(128, 3, true);
  assert.deepEqual(D.cellsIn(seq, 3), [9, 128]);
});

test('a magnet that is on stays on where the sequence has no frame', () => {
  const H = require('../js/heat.js');
  assert.deepEqual(D.MAGNET_CELLS, H.MAGNETS.map((m) => m.e), 'same control lines as heat.MAGNETS');
  const seq = new Sequence();
  seq.set(9, 1, true);
  const on1 = { targets: [null, null, null], magnets: [true, false] };
  assert.deepEqual(D.cellsIn(seq, 5, on1), [129], 'past the end: magnet 1 still on');
  assert.deepEqual(D.cellsIn(seq, 1, { targets: [null, null, null], magnets: [true, true] }), [9, 129, 128]);
  assert.deepEqual(D.cellsIn(seq, 5, H.emptyControls()), [], 'magnets off: nothing added');
  const bytes = D.encodeFrame(D.cellsIn(seq, 5, on1));
  assert.equal(bytes[16] & 0x2, 0x2, 'byte 16 bit 0x2: the firmware keeps magnet 1 on');
});

// The firmware switches a magnet before it answers (set_Magnet: ~300 ms each); here scaled down:
// switching both (120 ms) takes longer than the 80 ms an ordinary answer is waited for.
test('switching magnets: the answer is waited for, so the device stays answering and the magnets stay on', async (t) => {
  const sim = new SimulatedOpenDrop({ board: 0x11, magnetMs: 60 });
  const { s } = session({ link: { ...FAST, magnet: 60 } });
  t.after(() => s.detach());
  const states = [];
  const setState = s.setState.bind(s);
  s.setState = (x) => {
    states.push(x);
    setState(x);
  };
  assert.ok(await s.attach(sim));
  s.setLive(true);
  s.show([9, 129, 128]); // both magnets on
  await until(() => sim.magnets === 0x03);
  await new Promise((r) => setTimeout(r, 400)); // a few polls
  assert.ok(!states.includes('silent'), 'never taken for not answering');
  assert.equal(sim.magnets, 0x03, 'both still on');
  assert.equal(sim.magnetSwitches, 2, 'switched once each, not off and on again');
  s.show([10, 129]); // magnet 2 off
  await until(() => sim.magnets === 0x02);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(sim.magnetSwitches, 3);
  assert.ok(!states.includes('silent'));
});

test('lining up with magnets on: the zeros switch them off, and their slower answer is waited for', async () => {
  for (const stuckAt of [0, 5, 31]) {
    const sim = new SimulatedOpenDrop({ magnetMs: 60 });
    const link = new D.Link(sim, { ...FAST, magnet: 60 });
    assert.ok(await link.sync());
    assert.ok(await link.exchange(D.encodeFrame([9, 128, 129]), D.REPLY), 'answered after switching both');
    assert.equal(sim.magnets, 0x03);
    sim.count = stuckAt; // out of step
    assert.ok(await link.sync(), `lined up from ${stuckAt}`);
    assert.equal(sim.count, 0);
    assert.equal(sim.magnets, 0, 'the zeros switched them off');
    assert.ok(await link.exchange(D.encodeFrame([9, 129]), D.REPLY));
    assert.deepEqual(last(sim), [9, 129]);
    assert.equal(sim.magnets, 0x02, 'and the next frame switches magnet 1 on again');
    await link.close();
  }
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
  const events = { boards: [], lost: 0, changes: 0, notices: [] };
  const s = new D.Session(
    { board: (b) => events.boards.push(b.name), lost: () => events.lost++, change: () => events.changes++, notice: (text) => events.notices.push(text) },
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

test('high voltage: volts, frequency / 10 and 1 DC / 2 AC in bytes 29-31, kept in range; unset = 0', () => {
  const f = D.encodeFrame([], { hv: { volts: 120, hz: 500, mode: 'ac' } });
  assert.deepEqual(Array.from(f.subarray(29, 32)), [120, 50, 2]);
  assert.deepEqual(Array.from(D.encodeFrame([], { hv: { volts: 300, hz: 55, mode: 'dc' } }).subarray(29, 32)), [240, 10, 1], 'clamped to 240 V and 100 Hz');
  assert.deepEqual(Array.from(D.encodeFrame([], { hv: { volts: 20, hz: 1234 } }).subarray(29, 32)), [50, 100, 0], '50 V at least, 1000 Hz at most; mode kept');
  assert.deepEqual(D.cleanHV({ volts: '', hz: null, mode: 'x' }), { volts: null, hz: null, mode: null });
  assert.deepEqual(D.cleanHV({ volts: '150', hz: '333' }), { volts: 150, hz: 330, mode: null }, 'frequency in steps of 10');
});

test('high voltage: sent once (ordinary frames send 0 and change nothing); saving writes it to flash once', async () => {
  const sim = new SimulatedOpenDrop({ board: 0x12 });
  const { s } = session();
  await s.attach(sim);
  assert.deepEqual(sim.hv, { volts: 240, hz: 1000, ac: false }, 'as the device starts');
  assert.deepEqual(await s.sendHV({ volts: 150, mode: 'ac' }), { ok: true });
  assert.deepEqual(sim.hv, { volts: 150, hz: 1000, ac: true }, 'the frequency it had stays');
  assert.equal(sim.saves, 0, 'applied, not saved');
  const changes = sim.hvChanges;
  s.show([12]);
  s.setLive(true);
  await until(() => last(sim).join() === '12');
  assert.equal(sim.packet[29] + sim.packet[30] + sim.packet[31] + sim.packet[25], 0, 'ordinary frames send 0 there');
  assert.equal(sim.hvChanges, changes);
  assert.deepEqual(sim.hv, { volts: 150, hz: 1000, ac: true }, 'and the device keeps what it was sent');
  s.setFeedback(true);
  assert.deepEqual(await s.sendHV({ volts: 200, hz: 500, mode: 'ac' }, { save: true }), { ok: true });
  assert.deepEqual(sim.saved, { volts: 200, hz: 500, ac: true, feedback: true }, 'saved, with the feedback switch as sent');
  assert.deepEqual(await s.sendHV({ volts: 200, hz: 500, mode: 'ac' }, { save: true }), { ok: true });
  assert.equal(sim.saves, 1, 'saving the same again writes nothing');
  await s.detach();
  assert.deepEqual(await s.sendHV({ volts: 100 }), { ok: false, reason: 'no device is connected' });
});

test('a message: its length in byte 17, the text after the packet; 255 clears it; plain ASCII, 20 characters', () => {
  const f = D.encodeFrame([9], { message: 'Add buffer' });
  assert.equal(f.length, 32 + 10);
  assert.equal(f[17], 10);
  assert.equal(String.fromCharCode(...f.subarray(32)), 'Add buffer');
  assert.equal(f[1], 0b00000010, 'the electrodes as usual');
  const clear = D.encodeFrame([], { message: '' });
  assert.equal(clear.length, 32);
  assert.equal(clear[17], 255);
  assert.equal(D.encodeFrame([]).length, 32, 'no message: 32 bytes, byte 17 = 0');
  assert.equal(D.encodeFrame([])[17], 0);
  assert.equal(D.cleanMessage('  Ajoutez   l’échantillon à 37 °C, s’il vous plaît '), 'Ajoutez l?echantillo');
  assert.equal(D.cleanMessage('Mix\nnow'), 'Mix now');
});

test('the screen message: live, the frame’s message goes once; a note goes over it; live off or all off clears it', async (t) => {
  const sim = new SimulatedOpenDrop({ board: 0x12 });
  const { s } = session();
  t.after(() => s.detach());
  await s.attach(sim);
  s.show([12], null, 'Mixing');
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(sim.messages, [], 'not live: the screen is left alone');
  s.setLive(true);
  await until(() => sim.message === 'Mixing');
  assert.deepEqual(last(sim), [12]);
  s.show([13], null, 'Mixing');
  await until(() => last(sim).join() === '13');
  assert.deepEqual(sim.messages, ['Mixing'], 'the same message isn’t sent again');
  s.setNote('Add the sample?');
  await until(() => sim.message === 'Add the sample?');
  s.setNote(null);
  await until(() => sim.message === 'Mixing', 'back to the frame’s');
  s.show([14], null, null);
  await until(() => sim.message === '', 'a frame without a message clears the one shown');
  s.show([14], null, 'Heating');
  await until(() => sim.message === 'Heating');
  await s.allOff();
  await until(() => sim.message === '');
  assert.deepEqual(sim.messages, ['Mixing', 'Add the sample?', 'Mixing', '', 'Heating', '']);
  await s.detach();
});

test('command frames: a message, save or high voltage; the confirmation byte, 0xA0 | flags', () => {
  assert.ok(!D.isCommand(D.encodeFrame([1, 2, 3], { feedback: true, temps: [40, 0, 0] })), 'an ordinary frame');
  assert.ok(!D.isCommand(new Uint8Array(31)), 'lining up');
  assert.ok(D.isCommand(D.encodeFrame([], { message: 'Hi' })));
  assert.ok(D.isCommand(D.encodeFrame([], { message: '' })), 'a clear');
  assert.ok(D.isCommand(D.encodeFrame([], { save: true })));
  assert.ok(D.isCommand(D.encodeFrame([], { hv: { mode: 'dc' } })));
  assert.deepEqual(D.decodeAck(0xa3), { hv: true, saved: true, msg: false, menu: false });
  assert.deepEqual(D.decodeAck(0xac), { hv: false, saved: false, msg: true, menu: true });
  assert.deepEqual(D.decodeAck(0xa0), { hv: false, saved: false, msg: false, menu: false });
  assert.equal(D.decodeAck(0x53), null, 'high nibble not 0xA: not a confirmation');
  assert.equal(D.decodeAck(undefined), null, 'missing');
});

test('the link: a command frame is answered with 25 bytes, an ordinary one with 24; stock firmware sends no 25th', async () => {
  const sim = new SimulatedOpenDrop();
  const link = new D.Link(sim, FAST);
  await link.sync();
  const plain = await link.exchange(D.encodeFrame([3]), D.REPLY);
  assert.equal(plain.length, 24);
  const hv = await link.exchange(D.encodeFrame([3], { hv: { volts: 120 }, save: true }), D.REPLY);
  assert.equal(hv.length, 25);
  assert.deepEqual(D.decodeAck(hv[24]), { hv: true, saved: true, msg: false, menu: false });
  const msg = await link.exchange(D.encodeFrame([3], { message: 'Hi' }), D.REPLY);
  assert.equal(msg[24], 0xa4);
  await link.close();

  const stock = new SimulatedOpenDrop({ firmware: 'stock' });
  const l2 = new D.Link(stock, FAST);
  const seen = [];
  l2.tap = (e) => seen.push(e);
  await l2.sync();
  const t0 = Date.now();
  const a = await l2.exchange(D.encodeFrame([4], { hv: { volts: 120 } }), D.REPLY);
  assert.equal(a.length, 24, 'the answer, after waiting for a confirmation that doesn’t come');
  assert.ok(Date.now() - t0 >= 35);
  assert.ok(seen[seen.length - 1].noAck, 'the log says so');
  assert.deepEqual(stock.hv, { volts: 240, hz: 1000, ac: false }, 'stock firmware ignores the high voltage');
  assert.equal((await l2.exchange(D.encodeFrame([5]), D.REPLY)).length, 24);
  assert.deepEqual(last(stock), [5], 'still in step');
  await l2.close();
});

test('high voltage and save: confirmed; menu open on the device; not confirmed by stock firmware', async (t) => {
  const sim = new SimulatedOpenDrop();
  const { s } = session();
  t.after(() => s.detach());
  await s.attach(sim);
  sim.menu = true;
  assert.deepEqual(await s.sendHV({ volts: 150 }, { save: true }), { ok: false, reason: 'menu open on the device, try again' });
  assert.deepEqual(sim.hv, { volts: 240, hz: 1000, ac: false }, 'ignored while the menu is open');
  assert.equal(sim.saves, 0);
  sim.menu = false;
  assert.deepEqual(await s.sendHV({ volts: 150 }, { save: true }), { ok: true });
  assert.equal(sim.hv.volts, 150);
  assert.equal(sim.saves, 1);
  await s.detach();

  const stock = new SimulatedOpenDrop({ firmware: 'stock' });
  await s.attach(stock);
  assert.deepEqual(await s.sendHV({ volts: 150 }), { ok: false, reason: 'not confirmed (no nanoSYD firmware?)' });
  assert.ok(s.stock);
  assert.equal(s.state, 'on', 'the device still answers');
});

test('a message that arrives incomplete is sent again', async (t) => {
  const sim = new SimulatedOpenDrop();
  const { s, events } = session();
  t.after(() => s.detach());
  await s.attach(sim);
  sim.garble = 1;
  s.show([12], null, 'Mixing');
  s.setLive(true);
  await until(() => s.shown === 'Mixing');
  assert.deepEqual(sim.messages, ['Mixing'], 'shown on the second try');
  assert.deepEqual(events.notices, []);
  sim.garble = 5;
  s.show([12], null, 'Heating');
  await until(() => s.shown === 'Heating');
  assert.equal(sim.garble, 2, 'sent three times, then given up');
  assert.deepEqual(events.notices, ['Message not shown on the device: it arrived incomplete']);
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(sim.garble, 2, 'and not sent again by polling');
});

test('stock firmware: a message isn’t confirmed; the stream is lined up again and no more messages go', async (t) => {
  const sim = new SimulatedOpenDrop({ firmware: 'stock' });
  const { s, events } = session();
  t.after(() => s.detach());
  await s.attach(sim);
  s.show([12], null, 'Mixing');
  s.setLive(true);
  await until(() => events.notices.length === 1);
  assert.deepEqual(events.notices, ['Message not confirmed (no nanoSYD firmware?). Messages are not sent to this device']);
  assert.ok(s.stock);
  await until(() => !s.syncing && sim.count === 0);
  s.show([20], null, 'Heating');
  await until(() => last(sim).join() === '20');
  assert.equal(sim.count, 0, 'packets land whole: no text after them');
  assert.equal(s.state, 'on');
  assert.equal(events.notices.length, 1);
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
