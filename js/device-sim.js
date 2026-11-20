/* A simulated OpenDrop, for the tests and for trying the Device tab without hardware (open the page
 * with #sim, or #simstock for stock firmware). It behaves like OpenDropV42.ino: it counts incoming
 * bytes and acts on every 32nd, drives the electrodes, and answers with 24 bytes. As nanoSYD's
 * firmware (OpenDropVCustom, the default) it also shows messages, sets and saves the high voltage
 * and confirms those command frames with a 25th byte, 0xA0 | flags; as stock firmware it does none
 * of that. With protocol 1 it also takes the proposed
 * commands: load a sequence, run it on its own clock, stop, status (docs/device-protocol.md). It is
 * a transport for device.js: write(bytes), close(), onData, onClose. No DOM here. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./device.js'));
  else (root.OD = root.OD || {}).deviceSim = factory(root.OD.device);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (device) {
  'use strict';

  const { PACKET, REPLY, STATUS, COLUMNS, COMMAND, OUT, ACK, isCommand, decodeSequence } = device;
  const RESULT = { ok: 0, badChecksum: 1, tooLong: 2, busy: 3, unknown: 4, nothingLoaded: 5 };
  const STATE = { idle: 0, running: 1, done: 2 };

  class SimulatedOpenDrop {
    // board: board ID (0x12 = V4.2 with magnets and temperature adapter); protocol: 0 as today's
    // firmware, 1 with the proposed commands; stuckAt: bytes of a packet it already has (a stream
    // out of step); silent: never answers; boot: ms it takes to start (bytes wait meanwhile, then
    // it prints its start-up line); latency: ms before an answer; timeScale: how fast a run goes;
    // firmware: 'nanosyd' (messages, high voltage, save, the confirmation byte) or 'stock';
    // magnetMs: how long switching one magnet keeps it busy before it answers (set_Magnet).
    constructor({ board = 0x12, protocol = 0, stuckAt = 0, silent = false, boot = 0, latency = 1, timeScale = 1, firmware = 'nanosyd', magnetMs = 300, timers = globalThis } = {}) {
      Object.assign(this, { board, protocol, silent, latency, timeScale, firmware, magnetMs, timers });
      this.magnets = 0; // byte 16's magnet bits as last applied (0x02 magnet 1, 0x01 magnet 2)
      this.magnetSwitches = 0; // times a magnet was switched
      this.held = null; // answers waiting while it switches a magnet
      this.menu = false; // someone is in the device's menu: high voltage and save are ignored
      this.garble = 0; // the next n messages arrive incomplete (not shown, confirmed without 0x04)
      this.count = stuckAt;
      this.packet = new Uint8Array(PACKET);
      this.cells = []; // electrodes driven now
      this.frames = []; // every frame driven, in order
      this.feedback = false;
      this.targets = [0, 0, 0];
      this.temps = [21.5, 21.5, 21.5];
      this.hv = { volts: 240, hz: 1000, ac: false }; // as the firmware starts (OpenDrop.cpp)
      this.hvChanges = 0; // times it set the high voltage anew
      this.saved = null; // the settings written to flash: { volts, hz, ac, feedback }
      this.saves = 0; // flash writes (only when something changed)
      this.message = ''; // the message on its screen
      this.messages = []; // every message shown or cleared (''), in order
      this.text = null; // a message's text coming in: { packet, n, bytes }
      this.block = null; // protocol 1: a sequence block coming in
      this.loaded = null; // { frames, times, crc }
      this.run = null; // { frame, timer }
      this.state = STATE.idle;
      this.closed = false;
      this.onData = null;
      this.onClose = null;
      this.waiting = []; // bytes that came while it was starting
      this.booting = boot > 0;
      if (this.booting) this.timers.setTimeout(() => this.started(), boot);
    }

    started() {
      this.booting = false;
      this.say(Array.from('Welcome to OpenDrop\r\n', (c) => c.charCodeAt(0)));
      const bytes = this.waiting;
      this.waiting = [];
      for (const b of bytes) this.take(b);
    }

    write(bytes) {
      if (this.closed) return Promise.reject(new Error('the port is closed'));
      for (const b of bytes) {
        if (this.booting) this.waiting.push(b);
        else this.take(b);
      }
      return Promise.resolve();
    }

    close() {
      this.closed = true;
      this.halt();
      return Promise.resolve();
    }

    // The cable pulled out.
    unplug() {
      this.closed = true;
      this.halt();
      if (this.onClose) this.onClose();
    }

    say(bytes) {
      if (this.silent) return;
      const out = Uint8Array.from(bytes);
      if (this.held) {
        this.held.push(out);
        return;
      }
      this.timers.setTimeout(() => {
        if (!this.closed && this.onData) this.onData(out);
      }, this.latency);
    }

    take(b) {
      // The text of a message: N bytes after the packet, read before the packet is acted on.
      if (this.text) {
        this.text.bytes.push(b);
        if (this.text.bytes.length < this.text.n) return;
        const { packet } = this.text;
        let stored = true;
        if (this.garble > 0) {
          this.garble--;
          stored = false;
        } else {
          this.message = String.fromCharCode(...this.text.bytes).slice(0, 20);
          this.messages.push(this.message);
        }
        this.text = null;
        this.handle(packet, stored);
        return;
      }
      if (this.block) {
        this.block.bytes.push(b);
        if (this.block.bytes.length === 4) {
          const n = this.block.bytes[3];
          if (this.block.bytes[0] !== 0x4f || this.block.bytes[1] !== 0x44 || n < 1 || n > 200) {
            this.block = null;
            this.answer(RESULT.tooLong);
            return;
          }
          this.block.size = 4 + n * (COLUMNS + 4) + 2;
        }
        if (this.block.size && this.block.bytes.length === this.block.size) {
          const seq = decodeSequence(Uint8Array.from(this.block.bytes));
          this.block = null;
          if (seq.error) {
            this.answer(seq.error === 'bad checksum' ? RESULT.badChecksum : RESULT.tooLong);
            return;
          }
          this.loaded = seq;
          this.state = STATE.idle;
          this.answer(RESULT.ok);
        }
        return;
      }
      this.packet[this.count++] = b;
      if (this.count < PACKET) return;
      this.count = 0;
      const p = this.packet.slice();
      if (this.firmware === 'stock') {
        this.handle(p);
        return;
      }
      // The custom firmware's message byte: N text bytes follow, 255 clears it.
      const n = p[OUT.message];
      if (n > 0 && n < 255) {
        this.text = { packet: p, n, bytes: [] };
        return;
      }
      if (n === 255) {
        this.message = '';
        this.messages.push('');
      }
      this.handle(p, n !== 0);
    }

    // A whole packet (and its message's text, if any; `stored`: the message was shown or cleared).
    handle(p, stored = false) {
      const stock = this.firmware === 'stock';
      const command = this.protocol >= 1 ? p[OUT.command] : COMMAND.frame;
      if (stock || !this.menu) this.feedback = Boolean(p[24]);
      this.targets = [p[26], p[27], p[28]];
      let ack = ACK.mark;
      if (!stock) {
        const asked = p[OUT.volts] || p[OUT.freq] || p[OUT.mode] || p[OUT.save] === 1;
        if (this.menu) {
          if (asked) ack |= ACK.menu;
        } else {
          this.highVoltage(p);
          if (p[OUT.volts] || p[OUT.freq] || p[OUT.mode]) ack |= ACK.hv;
          if (p[OUT.save] === 1) {
            this.save();
            ack |= ACK.saved;
          }
        }
        if (stored) ack |= ACK.msg;
      }
      this.warm();
      if (command === COMMAND.frame) {
        if (!this.run) this.drive(cellsOf(p, stock));
        this.applyMagnets(p);
        this.reply(REPLY);
        if (!stock && isCommand(p)) this.say([ack]);
      } else if (command === COMMAND.load) {
        if (this.run) this.answer(RESULT.busy);
        else this.block = { bytes: [], size: 0 };
      } else if (command === COMMAND.run) {
        if (!this.loaded) this.answer(RESULT.nothingLoaded);
        else if (this.run) this.answer(RESULT.busy);
        else {
          this.start();
          this.answer(RESULT.ok);
        }
      } else if (command === COMMAND.stop) {
        this.halt();
        this.drive([]);
        if (this.state === STATE.running) this.state = STATE.idle;
        this.answer(RESULT.ok);
      } else if (command === COMMAND.status) {
        this.answer(RESULT.ok);
      } else this.answer(RESULT.unknown);
    }

    // The custom firmware's high voltage: volts, frequency / 10, 1 DC / 2 AC; 0 keeps the setting.
    highVoltage(p) {
      const volts = p[OUT.volts] ? Math.min(240, Math.max(50, p[OUT.volts])) : this.hv.volts;
      const hz = p[OUT.freq] ? Math.min(1000, Math.max(100, p[OUT.freq] * 10)) : this.hv.hz;
      const ac = p[OUT.mode] ? p[OUT.mode] === 2 : this.hv.ac;
      if (volts === this.hv.volts && hz === this.hv.hz && ac === this.hv.ac) return;
      this.hv = { volts, hz, ac };
      this.hvChanges++;
    }

    // save_settings(): only writes when something differs from what is stored.
    save() {
      const now = { ...this.hv, feedback: this.feedback };
      if (this.saved && JSON.stringify(this.saved) === JSON.stringify(now)) return;
      this.saved = now;
      this.saves++;
    }

    drive(cells) {
      this.cells = cells;
      this.frames.push(cells);
    }

    // As the firmware: each packet sets the magnets from byte 16, and switching one takes
    // magnetMs (it pulses the coil) before the answer goes.
    applyMagnets(p) {
      const now = p[16] & 0x03;
      const diff = now ^ this.magnets;
      this.magnets = now;
      const n = (diff & 1) + ((diff >> 1) & 1);
      if (!n || !this.magnetMs) return;
      this.magnetSwitches += n;
      if (this.held) return; // already busy: answered with the rest
      this.held = [];
      this.timers.setTimeout(() => {
        const out = this.held;
        this.held = null;
        for (const b of out) this.say(b);
      }, n * this.magnetMs);
    }

    // Temperatures creep towards their targets, a little with each packet.
    warm() {
      if ((this.board & 0x0f) !== 2) return;
      this.temps = this.temps.map((t, i) => {
        const goal = this.targets[i] || 21.5; // 0: off, back to the room's temperature
        return Math.abs(goal - t) < 0.5 ? goal : t + Math.sign(goal - t) * 0.5;
      });
    }

    // The 24 bytes of today's answer (and the 8 more of protocol 1's).
    reply(size, result = RESULT.ok) {
      const out = new Uint8Array(size);
      if (this.feedback && this.board >> 4 >= 1) {
        for (const e of this.cells) if (e < 128) out[e >> 3] |= 1 << (7 - (e & 7));
      }
      out[16] = this.protocol;
      this.temps.forEach((t, i) => {
        const whole = Math.floor(t);
        out[17 + 2 * i] = Math.round((t - whole) * 100);
        out[18 + 2 * i] = (this.board & 0x0f) === 2 ? whole : 255;
      });
      out[23] = this.board;
      if (size >= STATUS) {
        out[24] = result;
        out[25] = this.state;
        out[26] = this.run ? this.run.frame : 0;
        out[27] = this.loaded ? this.loaded.frames.length : 0;
        const crc = this.loaded ? this.loaded.crc : 0;
        out[28] = crc & 0xff;
        out[29] = crc >> 8;
      }
      this.say(out);
    }

    answer(result) {
      this.reply(STATUS, result);
    }

    // Running a loaded sequence on its own clock: each frame for its time, then all off.
    start() {
      this.state = STATE.running;
      this.run = { frame: 0, timer: null };
      this.step();
    }

    step() {
      const run = this.run;
      if (!run) return;
      if (run.frame >= this.loaded.frames.length) {
        this.run = null;
        this.drive([]);
        this.state = STATE.done;
        return;
      }
      this.drive(this.loaded.frames[run.frame]);
      const ms = this.loaded.times[run.frame] * this.timeScale;
      run.frame++;
      run.timer = this.timers.setTimeout(() => this.step(), ms);
    }

    halt() {
      if (this.run) this.timers.clearTimeout(this.run.timer);
      this.run = null;
    }
  }

  function cellsOf(packet, stock = false) {
    const cells = [];
    // Columns 0-16: byte 17 is the custom firmware's message length (stock firmware: 136-143).
    for (let x = 0; x < (stock ? COLUMNS : COLUMNS - 1); x++) for (let r = 0; r < 8; r++) if ((packet[x] >> r) & 1) cells.push(x * 8 + r);
    return cells;
  }

  return { SimulatedOpenDrop, RESULT, STATE };
});
