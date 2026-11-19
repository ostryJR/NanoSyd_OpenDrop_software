/* Talking to the OpenDrop over USB serial, as OpenDropController4_25 does with OpenDropV42.ino:
 * the 32 bytes of a frame, the 24-byte answer (sensed electrodes, temperatures, board), lining
 * the byte stream up, and one frame in flight at a time. Also protocol 1, proposed for new
 * firmware: loading a whole sequence with its frame times so the device runs it on its own (see
 * docs/device-protocol.md). The transport (Web Serial in the page, a simulated device in tests) is
 * passed in. No DOM here. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else (root.OD = root.OD || {}).device = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const BAUD = 115200;
  const PACKET = 32; // bytes in a frame or command sent to the device
  const REPLY = 24; // bytes the device answers a frame with
  const STATUS = 32; // bytes it answers a protocol 1 command with
  const COLUMNS = 18; // 16 electrode columns, then 2 columns of control lines (electrodes 128-143)
  const CELLS = COLUMNS * 8;
  const DROPLET_CELLS = 128;
  const MAX_FRAMES = 200; // protocol 1's limit (a sequence loaded on the device); live frames have none
  const DEFAULT_TEMP = 25; // the original controller's starting targets, sent to every board
  const TEMP_RANGE = [20, 120];
  const NO_SENSOR = 150;
  // Positions in a packet: the firmware's ControlBytesIn[i] is byte 16 + i. The custom firmware
  // (OpenDropVCustom) reads the high voltage: volts, frequency / 10 and 1 DC / 2 AC, where 0 keeps
  // what the device has; and `save` = 1 writes its settings (high voltage, sound, feedback) to
  // flash. Ordinary frames send 0 in all four, so they change nothing; older firmware ignores
  // them. Protocol 1's command is in byte 23 (ControlBytesIn[7], unused).
  const OUT = { command: 23, feedback: 24, save: 25, temps: 26, volts: 29, freq: 30, mode: 31 };
  const VOLTS = [50, 240];
  const FREQ = [100, 1000]; // Hz, in steps of 10
  const MODES = { dc: 1, ac: 2 };
  // Positions in an answer.
  const IN = { protocol: 16, temps: 17, board: 23, result: 24, state: 25, frame: 26, stored: 27, crc: 28 };
  const COMMAND = { frame: 0, load: 1, run: 2, stop: 3, status: 4 };
  const RESULTS = ['ok', 'bad checksum', 'too long', 'busy', 'unknown command', 'nothing loaded'];
  const RUN_STATES = ['idle', 'running', 'done'];

  // High-voltage settings as sent: { volts, hz, mode } each null (keep the device's) or in range.
  function cleanHV(hv) {
    const out = { volts: null, hz: null, mode: null };
    if (!hv || typeof hv !== 'object') return out;
    const v = Number(hv.volts);
    if (hv.volts !== null && hv.volts !== '' && Number.isFinite(v) && v > 0) out.volts = Math.min(VOLTS[1], Math.max(VOLTS[0], Math.round(v)));
    const f = Number(hv.hz);
    if (hv.hz !== null && hv.hz !== '' && Number.isFinite(f) && f > 0) out.hz = Math.min(FREQ[1], Math.max(FREQ[0], Math.round(f / 10) * 10));
    if (hv.mode === 'dc' || hv.mode === 'ac') out.mode = hv.mode;
    return out;
  }

  const clampTemp = (t) => (Number.isFinite(t) ? Math.min(TEMP_RANGE[1], Math.max(TEMP_RANGE[0], Math.round(t))) : DEFAULT_TEMP);

  // --- bytes ----------------------------------------------------------------------------------

  // A packet: electrodes `cells` on (0-143: byte = column, bit = row), the feedback switch, the
  // three temperature targets (°C), the high voltage (cleanHV; unset = 0, keep), whether the
  // device saves its settings, and the command (0 = a frame to show, as today's firmware knows
  // it; others are protocol 1).
  function encodeFrame(cells = [], { feedback = false, temps = null, hv = null, save = false, command = COMMAND.frame } = {}) {
    const out = new Uint8Array(PACKET);
    for (const e of cells) if (Number.isInteger(e) && e >= 0 && e < CELLS) out[e >> 3] |= 1 << (e & 7);
    out[OUT.feedback] = feedback ? 1 : 0;
    for (let i = 0; i < 3; i++) out[OUT.temps + i] = clampTemp(temps ? temps[i] : DEFAULT_TEMP);
    out[OUT.command] = command;
    const h = cleanHV(hv);
    out[OUT.volts] = h.volts || 0;
    out[OUT.freq] = h.hz ? h.hz / 10 : 0;
    out[OUT.mode] = h.mode ? MODES[h.mode] : 0;
    out[OUT.save] = save ? 1 : 0;
    return out;
  }

  // The electrodes on in frame f of a sequence.
  function cellsIn(seq, f) {
    const out = [];
    for (let e = 0; e < CELLS; e++) if (seq.get(e, f)) out.push(e);
    return out;
  }

  // What a board ID says: OpenDrop version in the high four bits, the adapter in the low four.
  function boardInfo(id) {
    const v = id >> 4;
    const a = id & 0x0f;
    const version = v === 0 ? '4.1' : v === 1 ? '4.2' : `4.x (id ${id})`;
    const adapter = ['', 'magnet', 'magnet & temperature adapter'][a];
    return {
      id,
      version,
      name: `OpenDrop V${version}${adapter === undefined ? ` · adapter ${a}` : adapter ? ` · ${adapter}` : ''}`,
      magnet: a === 1 || a === 2,
      temperature: a === 2,
      feedback: v >= 1,
    };
  }

  // An answer: the electrodes the device senses a droplet on (bit b of byte x is row 7 - b), the
  // three temperatures (null: no sensor), the protocol it speaks and its board; a protocol 1
  // answer also has the result, run state, current frame, frames stored and their checksum.
  function decodeReply(bytes) {
    const sensed = [];
    for (let x = 0; x < 16; x++) for (let b = 7; b >= 0; b--) if ((bytes[x] >> b) & 1) sensed.push(x * 8 + 7 - b);
    const temps = [0, 1, 2].map((i) => {
      const t = bytes[IN.temps + 2 * i] / 100 + bytes[IN.temps + 2 * i + 1];
      return t >= NO_SENSOR ? null : Math.round(t * 100) / 100;
    });
    const out = { sensed, temps, protocol: bytes[IN.protocol], board: boardInfo(bytes[IN.board]) };
    if (bytes.length >= STATUS) {
      out.result = RESULTS[bytes[IN.result]] || `error ${bytes[IN.result]}`;
      out.state = RUN_STATES[bytes[IN.state]] || 'idle';
      out.frame = bytes[IN.frame];
      out.stored = bytes[IN.stored];
      out.crc = bytes[IN.crc] | (bytes[IN.crc + 1] << 8);
    }
    return out;
  }

  // CRC-16/CCITT-FALSE (polynomial 0x1021, start 0xFFFF): "123456789" gives 0x29B1.
  function crc16(bytes) {
    let crc = 0xffff;
    for (const b of bytes) {
      crc ^= b << 8;
      for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
    return crc;
  }

  // Protocol 1's sequence block: "OD", format 1, the frame count, then each frame's 18 electrode
  // bytes and its time in ms (uint32, little-endian), then the CRC of all that (little-endian).
  function encodeSequence(seq, last = seq.lastFrame()) {
    const n = Math.min(MAX_FRAMES, Math.max(1, last));
    const out = new Uint8Array(4 + n * (COLUMNS + 4) + 2);
    out.set([0x4f, 0x44, 1, n]);
    for (let f = 1; f <= n; f++) {
      const at = 4 + (f - 1) * (COLUMNS + 4);
      out.set(encodeFrame(cellsIn(seq, f)).subarray(0, COLUMNS), at);
      const ms = Math.max(0, Math.round(seq.timeOf(f)));
      for (let k = 0; k < 4; k++) out[at + COLUMNS + k] = (ms >>> (8 * k)) & 0xff;
    }
    const crc = crc16(out.subarray(0, out.length - 2));
    out[out.length - 2] = crc & 0xff;
    out[out.length - 1] = crc >> 8;
    return out;
  }

  // A sequence block read back: { frames: [[electrodes]], times: [ms], crc } or { error }.
  function decodeSequence(bytes) {
    if (bytes.length < 6 || bytes[0] !== 0x4f || bytes[1] !== 0x44) return { error: 'not a sequence block' };
    if (bytes[2] !== 1) return { error: `format ${bytes[2]} is unknown` };
    const n = bytes[3];
    if (n < 1 || n > MAX_FRAMES) return { error: 'too long' };
    const size = 4 + n * (COLUMNS + 4) + 2;
    if (bytes.length < size) return { error: 'cut short' };
    const crc = bytes[size - 2] | (bytes[size - 1] << 8);
    if (crc16(bytes.subarray(0, size - 2)) !== crc) return { error: 'bad checksum' };
    const frames = [];
    const times = [];
    for (let f = 0; f < n; f++) {
      const at = 4 + f * (COLUMNS + 4);
      const cells = [];
      for (let x = 0; x < COLUMNS; x++) for (let r = 0; r < 8; r++) if ((bytes[at + x] >> r) & 1) cells.push(x * 8 + r);
      frames.push(cells);
      let ms = 0;
      for (let k = 3; k >= 0; k--) ms = ms * 256 + bytes[at + COLUMNS + k];
      times.push(ms);
    }
    return { frames, times, crc, size };
  }

  const sameBytes = (a, b) => Boolean(a && b) && a.length === b.length && a.every((v, i) => v === b[i]);

  // The line the firmware prints when it has started, "Welcome to OpenDrop". Returns how many bytes
  // at the start of `bytes` are that line, or 0. Only a line naming OpenDrop counts, so an answer
  // (whose bytes can be anything) is never taken for text. (Its board ID line comes two seconds
  // earlier, while nothing is being waited for, and is dropped with everything else then.)
  const START_LINE = /^[\x20-\x7e]*OpenDrop[\x20-\x7e]*\r\n/;
  function textLine(bytes) {
    const head = String.fromCharCode(...Array.from(bytes.slice(0, 64)));
    const m = START_LINE.exec(head);
    return m ? m[0].length : 0;
  }

  // --- the link -------------------------------------------------------------------------------
  // One exchange at a time: what came in before it is dropped, the bytes are written, and the
  // answer is awaited. The firmware has no start marker: it counts bytes and acts on every 32nd.

  class Link {
    // transport: { write(bytes) -> Promise, close() -> Promise }; the link sets its onData(chunk)
    // and onClose(). Times in ms: timeout (an answer), settle (no answer by then means none is
    // coming), boot (a device that was just plugged in starting up).
    constructor(transport, { timeout = 500, settle = 150, boot = 2500, timers = globalThis } = {}) {
      this.transport = transport;
      this.opts = { timeout, settle, boot };
      this.timers = timers;
      this.inbox = [];
      this.waiting = null; // { expect, resolve, timer }
      this.queue = Promise.resolve();
      this.next = null; // the newest frame waiting to be sent: { bytes, resolve }
      this.pumping = false;
      this.closed = false;
      this.onLost = null;
      transport.onData = (chunk) => this.receive(chunk);
      transport.onClose = () => this.lost();
    }

    sleep(ms) {
      return new Promise((resolve) => this.timers.setTimeout(resolve, ms));
    }

    receive(chunk) {
      if (this.closed) return;
      for (const b of chunk) this.inbox.push(b);
      // The start-up line is dropped wherever it comes.
      for (let n = textLine(this.inbox); n; n = textLine(this.inbox)) this.inbox.splice(0, n);
      const w = this.waiting;
      if (!w) {
        if (this.inbox.length > 64) this.inbox = []; // nothing asked for it
        return;
      }
      if (this.inbox.length >= w.expect) {
        this.waiting = null;
        this.timers.clearTimeout(w.timer);
        w.resolve(Uint8Array.from(this.inbox.splice(0, w.expect)));
      }
    }

    // Writes `bytes`, then resolves with the `expect` bytes answered, or null if none came within
    // `wait` ms or the link is gone.
    exchange(bytes, expect, wait = this.opts.timeout) {
      const run = async () => {
        if (this.closed) return null;
        this.inbox = [];
        const answer = new Promise((resolve) => {
          const timer = this.timers.setTimeout(() => {
            if (this.waiting && this.waiting.resolve === resolve) this.waiting = null;
            resolve(null);
          }, wait);
          this.waiting = { expect, resolve, timer };
        });
        try {
          await this.transport.write(bytes);
        } catch {
          this.lost();
          return null;
        }
        return answer;
      };
      const result = this.queue.then(run, run);
      this.queue = result.then(() => null, () => null);
      return result;
    }

    // Lines the device's byte count up with ours. A burst of 31 bytes either completes the packet
    // the device is in the middle of (it answers, and is left one byte nearer the start of a
    // packet than before: so again), or doesn't (it was at the start of one: one more byte
    // completes it, and the answer says so). That has to come out twice in a row, so an answer
    // that came late can't fool it. The zeros it completes packets with switch the electrodes
    // off. A device that doesn't answer may still be starting up: one more try after `boot` ms.
    // Returns whether it answered.
    async sync() {
      for (let attempt = 0; attempt < 2 && !this.closed; attempt++) {
        if (attempt) await this.sleep(this.opts.boot);
        let lined = 0;
        for (let round = 0; round < 3 * PACKET && !this.closed; round++) {
          const answer = await this.exchange(new Uint8Array(PACKET - 1), REPLY, this.opts.settle);
          if (answer) {
            lined = 0;
            continue;
          }
          if (!(await this.exchange(new Uint8Array(1), REPLY, this.opts.timeout))) break;
          if (++lined === 2) return true;
        }
      }
      return false;
    }

    // A frame to show: sent once the one before is answered; when newer ones come meanwhile, only
    // the newest is sent. Resolves with the answer, null if none came, or undefined if a newer
    // frame took its place.
    send(bytes) {
      if (this.next) this.next.resolve(undefined);
      return new Promise((resolve) => {
        this.next = { bytes, resolve };
        if (!this.pumping) this.pump();
      });
    }

    async pump() {
      this.pumping = true;
      while (this.next && !this.closed) {
        const { bytes, resolve } = this.next;
        this.next = null;
        resolve(await this.exchange(bytes, REPLY));
      }
      if (this.next) this.next.resolve(null);
      this.next = null;
      this.pumping = false;
    }

    // The device went away (unplugged, or the port failed).
    lost() {
      if (this.closed) return;
      this.closed = true;
      this.drop();
      if (this.onLost) this.onLost();
    }

    drop() {
      if (this.waiting) {
        this.timers.clearTimeout(this.waiting.timer);
        this.waiting.resolve(null);
        this.waiting = null;
      }
      if (this.next) this.next.resolve(null);
      this.next = null;
    }

    async close() {
      if (!this.closed) {
        this.closed = true;
        this.drop();
      }
      try {
        await this.transport.close();
      } catch {
        // already closed
      }
    }
  }

  // --- a session --------------------------------------------------------------------------------
  // What the page works with: connecting, live (the device shows the frame on screen; otherwise
  // everything is off), feedback, temperature targets, polling, and protocol 1's load and run.

  class Session {
    // on: { change() — anything shown changed; board(board) — a board was found or changed;
    //       lost() — the device went away }
    constructor(on = {}, { poll = 1000, pollFeedback = 300, pollRun = 500, timers = globalThis, link = {} } = {}) {
      this.on = { change() {}, board() {}, lost() {}, ...on };
      this.opts = { poll, pollFeedback, pollRun };
      this.timers = timers;
      this.linkOptions = { timers, ...link };
      this.link = null;
      this.state = 'off'; // off, connecting, on, silent (not answering)
      this.board = null;
      this.protocol = 0;
      this.temps = [null, null, null];
      this.sensed = [];
      this.live = false;
      this.feedback = false;
      this.targets = [DEFAULT_TEMP, DEFAULT_TEMP, DEFAULT_TEMP];
      this.cells = []; // the frame on screen
      this.frameTargets = null; // heater targets the frame on screen sets (°C or null ×3), if any
      this.lastSent = null;
      this.pollTimer = null;
      this.run = null; // a sequence running on the device: { frames, frame, state }
      this.label = '';
    }

    get connected() {
      return this.state === 'on' || this.state === 'silent';
    }

    get canLoad() {
      return this.state === 'on' && this.protocol >= 1;
    }

    setState(state) {
      if (state === this.state) return;
      this.state = state;
      this.on.change();
    }

    // The bytes the device should have now: the frame on screen when live, otherwise all off.
    bytes() {
      return encodeFrame(this.live ? this.cells : [], { feedback: this.feedback && Boolean(this.board && this.board.feedback), temps: this.sentTargets });
    }

    // The heater targets sent: live, those the frame on screen sets (the others as set here);
    // otherwise those set here.
    get sentTargets() {
      const own = this.live && this.frameTargets;
      return this.targets.map((t, i) => (own && typeof own[i] === 'number' ? clampTemp(own[i]) : t));
    }

    // Opens a session on `transport`. Live starts off; the device gets an all-off frame.
    async attach(transport, { label = '' } = {}) {
      if (this.link) await this.detach({ allOff: false });
      const link = new Link(transport, this.linkOptions);
      this.link = link;
      link.onLost = () => this.lost(link);
      this.label = label;
      this.live = false;
      this.lastSent = null;
      this.run = null;
      this.setState('connecting');
      const ok = (await link.sync()) && this.link === link && (await this.push(true));
      if (this.link !== link) return false;
      if (!ok) {
        this.link = null;
        await link.close();
        this.setState('off');
        return false;
      }
      this.setState('on');
      this.schedule();
      return true;
    }

    // Sends what the device should have (if it changed, or `always`) and takes in the answer.
    // Returns false if the device didn't answer.
    async push(always = false) {
      const link = this.link;
      if (!link || this.run) return true;
      const bytes = this.bytes();
      if (!always && sameBytes(bytes, this.lastSent)) return true;
      this.lastSent = bytes;
      const answer = await link.send(bytes);
      if (answer === undefined || link !== this.link) return true; // a newer frame took its place
      if (!answer) {
        this.lastSent = null;
        if (this.state === 'on') this.setState('silent');
        return false;
      }
      this.take(answer);
      if (this.state === 'silent') this.setState('on');
      return true;
    }

    take(answer) {
      const info = decodeReply(answer);
      const board = info.board;
      const changed = !this.board || this.board.id !== board.id;
      this.board = board;
      this.protocol = info.protocol;
      this.temps = board.temperature ? info.temps : [null, null, null];
      this.sensed = this.feedback && board.feedback ? info.sensed.filter((e) => e < DROPLET_CELLS) : [];
      if (changed) this.on.board(board);
      this.on.change();
      return info;
    }

    // Polling: resends the current state so temperatures, feedback and the connection stay
    // fresh; a device that stopped answering is lined up again. While a sequence runs on the
    // device, its status is asked instead.
    schedule() {
      this.timers.clearTimeout(this.pollTimer);
      if (!this.link) return;
      const every = this.run ? this.opts.pollRun : this.feedback ? this.opts.pollFeedback : this.opts.poll;
      this.pollTimer = this.timers.setTimeout(() => this.tick(), every);
    }

    async tick() {
      const link = this.link;
      if (!link) return;
      if (this.run) await this.status();
      else if (this.state === 'silent') {
        if ((await link.sync()) && link === this.link) await this.push(true);
      } else await this.push(true);
      if (link === this.link) this.schedule();
    }

    // The frame on screen (its electrodes, and the heater targets it sets, if any); sent at once
    // when live.
    show(cells, targets = null) {
      this.cells = cells;
      this.frameTargets = targets;
      if (this.live && this.state === 'on') this.push();
    }

    setLive(on) {
      this.live = Boolean(on) && this.connected && !this.run;
      if (this.link) this.push();
      this.on.change();
      return this.live;
    }

    setFeedback(on) {
      this.feedback = Boolean(on);
      if (!this.feedback) this.sensed = [];
      if (this.link) {
        this.push();
        this.schedule();
      }
      this.on.change();
    }

    setTargets(temps) {
      this.targets = [0, 1, 2].map((i) => clampTemp(temps[i]));
      if (this.link) this.push();
      this.on.change();
    }

    // Sends the high voltage (cleanHV; unset parts keep what the device has) once, with what the
    // device should have now; with `save`, the device also writes its settings to flash, so they
    // are there after it is switched off and on (the feedback switch too). Ordinary frames after
    // it send 0 there again: the device keeps these. Resolves with { ok, reason }.
    async sendHV(hv, { save = false } = {}) {
      const link = this.link;
      if (!link || this.state !== 'on') return { ok: false, reason: 'no device is connected' };
      if (this.run) return { ok: false, reason: 'a sequence is running on the device' };
      const bytes = encodeFrame(this.live ? this.cells : [], { feedback: this.feedback && Boolean(this.board && this.board.feedback), temps: this.sentTargets, hv, save });
      const answer = await link.exchange(bytes, REPLY);
      if (link !== this.link) return { ok: false, reason: 'the device went away' };
      this.lastSent = null; // the next frame goes as usual
      if (!answer) return { ok: false, reason: "the device didn't answer" };
      this.take(answer);
      return { ok: true };
    }

    // Live off, everything off on the device.
    allOff() {
      this.live = false;
      const done = this.link ? this.push() : Promise.resolve(true);
      this.on.change();
      return done;
    }

    // Closes the session; with `allOff`, the device gets an all-off frame first.
    async detach({ allOff = true } = {}) {
      const link = this.link;
      this.timers.clearTimeout(this.pollTimer);
      if (!link) return;
      this.live = false;
      if (allOff && !link.closed) {
        if (this.run) await this.command(COMMAND.stop);
        this.run = null;
        await this.push();
      }
      this.link = null;
      await link.close();
      this.reset();
    }

    // Best effort when the page goes away: all off, not waited for.
    leave() {
      const link = this.link;
      if (!link || link.closed) return;
      this.timers.clearTimeout(this.pollTimer);
      try {
        const done = link.transport.write(this.run ? encodeFrame([], { command: COMMAND.stop }) : encodeFrame([], { temps: this.targets }));
        if (done && done.catch) done.catch(() => {});
      } catch {
        // the page is going anyway
      }
    }

    lost(link) {
      if (link !== this.link) return;
      this.timers.clearTimeout(this.pollTimer);
      this.link = null;
      this.reset();
      this.on.lost();
    }

    reset() {
      this.live = false;
      this.run = null;
      this.board = null;
      this.protocol = 0;
      this.sensed = [];
      this.temps = [null, null, null];
      this.lastSent = null;
      this.state = 'off';
      this.on.change();
    }

    // --- protocol 1 ---------------------------------------------------------------------------

    // A command packet and its 32-byte answer, decoded; null if the device didn't answer.
    async command(code, extra = null, wait = 2000) {
      if (!this.link || this.protocol < 1) return null;
      const packet = encodeFrame([], { feedback: this.feedback && Boolean(this.board && this.board.feedback), temps: this.targets, command: code });
      const bytes = extra ? Uint8Array.from([...packet, ...extra]) : packet;
      const answer = await this.link.exchange(bytes, STATUS, wait);
      return answer ? this.take(answer) : null;
    }

    // Loads a sequence block into the device. { ok, reason }.
    async load(block) {
      if (!this.canLoad) return { ok: false, reason: "this device's firmware only follows live frames" };
      if (this.run) return { ok: false, reason: 'a sequence is running on the device' };
      this.allOff();
      const info = await this.command(COMMAND.load, block, 2000 + block.length);
      if (!info) return { ok: false, reason: "the device didn't answer" };
      if (info.result !== 'ok') return { ok: false, reason: info.result };
      const crc = block[block.length - 2] | (block[block.length - 1] << 8);
      if (info.crc !== crc || info.stored !== block[3]) return { ok: false, reason: 'the device kept something else' };
      return { ok: true, frames: info.stored };
    }

    // Runs the loaded sequence on the device: live goes off, and the status is polled.
    async start() {
      if (!this.canLoad) return { ok: false, reason: "this device's firmware only follows live frames" };
      this.allOff();
      const info = await this.command(COMMAND.run);
      if (!info) return { ok: false, reason: "the device didn't answer" };
      if (info.result !== 'ok') return { ok: false, reason: info.result };
      this.run = { frames: info.stored, frame: info.frame, state: info.state };
      this.schedule();
      this.on.change();
      return { ok: true };
    }

    async stop() {
      const info = await this.command(COMMAND.stop);
      this.run = null;
      this.lastSent = null;
      this.schedule();
      this.on.change();
      return info ? { ok: info.result === 'ok', reason: info.result } : { ok: false, reason: "the device didn't answer" };
    }

    async status() {
      const info = await this.command(COMMAND.status);
      if (!info) {
        if (this.state === 'on') this.setState('silent');
        return null;
      }
      if (this.state === 'silent') this.setState('on');
      if (this.run) {
        this.run = { frames: info.stored, frame: info.frame, state: info.state };
        if (info.state !== 'running') {
          this.run = { ...this.run, ended: true };
          const ended = this.run;
          this.run = null;
          this.lastSent = null;
          this.on.change();
          return { ...info, ended };
        }
        this.on.change();
      }
      return info;
    }
  }

  return {
    BAUD, PACKET, REPLY, STATUS, COLUMNS, CELLS, MAX_FRAMES, DEFAULT_TEMP, TEMP_RANGE, NO_SENSOR, OUT, IN, COMMAND, VOLTS, FREQ, cleanHV,
    RESULTS, RUN_STATES, encodeFrame, cellsIn, boardInfo, decodeReply, crc16, encodeSequence, decodeSequence, sameBytes,
    textLine, Link, Session,
  };
});
