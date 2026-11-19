/* The Device tab and the device boxes on the board: connecting the OpenDrop (Web Serial), live,
 * feedback, temperatures, and the proposed sending of a whole sequence. The page calls paint()
 * after drawing, action() for the board boxes, and leave() when it closes. */
(function (root) {
  'use strict';

  const OD = root.OD;
  const { Session, encodeSequence, cellsIn, TEMP_RANGE, MAX_FRAMES } = OD.device;
  const serial = OD.serial;
  const { SimulatedOpenDrop } = OD.deviceSim;
  const $ = (id) => document.getElementById(id);
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const MAGNET_PAIR = ['electrodes', 'electrodes_magnet'];
  const hvText = (hv) =>
    hv ? [hv.volts ? `${hv.volts} V` : '', hv.mode ? hv.mode.toUpperCase() : '', hv.hz && hv.mode !== 'dc' ? `${hv.hz} Hz` : ''].filter(Boolean).join(', ') : '';

  class DevicePanel {
    // app: { editor, setStatus(text, kind), redraw(), prefs (an object kept between visits),
    //        savePrefs(), layoutId() -> current layout id, useLayout(id), formatTime(ms) }
    constructor(app) {
      this.app = app;
      this.ed = app.editor;
      this.prefs = app.prefs;
      if (typeof this.prefs.auto !== 'boolean') this.prefs.auto = true;
      this.session = new Session({
        change: () => this.changed(),
        board: (b) => this.boardFound(b),
        lost: () => this.lost(),
      });
      if (Array.isArray(this.prefs.targets)) this.session.targets = this.prefs.targets.slice(0, 3);
      this.portLabel = '';
      this.key = '';
      this.busy = false; // connecting

      this.dom = {
        unsupported: $('device-unsupported'),
        dot: $('device-dot'),
        tabDot: $('tab-device-dot'),
        state: $('device-state'),
        port: $('device-port'),
        connect: $('device-connect'),
        disconnect: $('device-disconnect'),
        sim: $('device-sim'),
        auto: $('device-auto'),
        allOff: $('device-alloff'),
        feedbackPart: $('device-feedback-part'),
        feedback: $('device-feedback'),
        sensed: $('device-sensed'),
        tempsPart: $('device-temps-part'),
        temps: $('device-temps').querySelector('tbody'),
        seq: $('device-seq'),
        load: $('device-load'),
        run: $('device-run'),
        stop: $('device-stop'),
        runState: $('device-run-state'),
        seqNote: $('device-seq-note'),
        hvNow: $('device-hv-now'),
        hvSave: $('device-hv-save'),
      };
      this.buildTemps();
      this.wire();

      const d = this.dom;
      d.unsupported.hidden = serial.supported();
      d.sim.hidden = !/sim/.test(root.location.hash);
      d.auto.checked = this.prefs.auto;
      if (serial.supported()) {
        serial.watch((port) => this.plugged(port));
        if (this.prefs.auto) this.free().then((ok) => ok && this.reconnect());
      }
    }

    // --- the board and the page ---------------------------------------------------------------

    // After each picture: the frame on screen goes to the device when live; the tab is updated.
    paint() {
      if (this.session.connected) {
        const c = this.ed.controlsAt(this.ed.frame);
        this.session.show(cellsIn(this.ed.seq, this.ed.frame), c.targets.some((t) => t !== null) ? c.targets : null);
      }
      this.render();
    }

    // What the board's device boxes and dots show.
    boardState() {
      const s = this.session;
      return {
        state: this.busy && s.state === 'off' ? 'connecting' : s.state,
        live: s.live,
        feedback: s.feedback && Boolean(s.board && s.board.feedback),
        canFeedback: Boolean(s.board && s.board.feedback),
        name: s.board ? s.board.name : '',
        sensed: s.sensed,
      };
    }

    // A board box: 'connect' (from the click itself: the port picker needs it), 'live', 'feedback'.
    action(name) {
      if (name === 'connect') {
        if (this.session.connected) this.disconnect();
        else this.connect();
      } else if (name === 'live') this.setLive(!this.session.live);
      else if (name === 'feedback') this.setFeedback(!this.session.feedback);
    }

    // The page is closing or reloading: everything off, as far as there is time.
    leave() {
      this.session.leave();
    }

    // --- connecting -----------------------------------------------------------------------------

    async connect() {
      if (!serial.supported()) {
        this.app.setStatus("This browser can't reach USB devices: open the page in Chrome or Edge on a computer", 'warn');
        return;
      }
      let port;
      try {
        port = await serial.pick();
      } catch (err) {
        this.app.setStatus(`Could not connect: ${err.message}`, 'error');
        return;
      }
      if (port) await this.open(port);
    }

    async open(port, { quiet = false } = {}) {
      if (this.busy || this.session.connected) return false;
      this.busy = true;
      this.changed();
      if (!quiet) this.app.setStatus('Connecting to the OpenDrop…');
      let transport;
      try {
        transport = await serial.openPort(port);
      } catch (err) {
        this.busy = false;
        this.changed();
        this.app.setStatus(`Could not connect: ${err.message}`, 'error');
        return false;
      }
      this.portLabel = serial.label(port);
      const ok = await this.session.attach(transport, { label: this.portLabel });
      this.busy = false;
      if (!ok) {
        this.changed();
        this.app.setStatus(`No answer on ${this.portLabel}: is it the OpenDrop, and is it on? Its firmware may be busy in a menu.`, 'error');
        return false;
      }
      this.prefs.port = serial.infoOf(port);
      this.app.savePrefs();
      this.connected(quiet ? 'Reconnected to' : 'Connected to');
      return true;
    }

    // A simulated OpenDrop in the page (#sim; #sim1 also takes whole sequences).
    async useSimulated() {
      if (this.session.connected) await this.session.detach();
      const protocol = /sim1/.test(root.location.hash) ? 1 : 0;
      this.busy = true;
      this.changed();
      this.portLabel = 'simulated in this page';
      const ok = await this.session.attach(new SimulatedOpenDrop({ board: 0x12, protocol, latency: 3 }), { label: this.portLabel });
      this.busy = false;
      if (ok) this.connected('Connected to a simulated');
      else this.changed();
    }

    connected(verb) {
      const s = this.session;
      const name = s.board ? s.board.name : 'the OpenDrop';
      const switched = this.switchedLayout ? ` Switched to the ${this.switchedLayout} layout for this board.` : '';
      this.switchedLayout = null;
      this.app.setStatus(`${verb} ${name}. Live is off: turn it on to send the frame on screen.${switched}`);
      this.changed();
    }

    // The device as it was last time, without the port picker (the page may use it already).
    async reconnect() {
      try {
        const port = await serial.remembered(this.prefs.port);
        if (port) await this.open(port, { quiet: true });
      } catch {
        // nothing to reconnect to
      }
    }

    plugged(port) {
      if (!this.prefs.auto || this.session.connected || this.busy) return;
      const known = this.prefs.port && this.prefs.port.usbVendorId !== undefined;
      if (known && !serial.sameInfo(serial.infoOf(port), this.prefs.port)) return;
      this.free().then((ok) => ok && this.open(port, { quiet: true }));
    }

    // Whether this tab may take the device: not when another tab of this page has it (the page
    // says, through app.deviceElsewhere()).
    async free() {
      if (!this.app.deviceElsewhere) return true;
      const elsewhere = await this.app.deviceElsewhere();
      if (elsewhere) this.app.setStatus('The OpenDrop is connected in another tab of this page');
      return !elsewhere;
    }

    async disconnect() {
      await this.session.detach();
      this.app.setStatus('Disconnected: everything on the device was switched off first');
      this.changed();
    }

    lost() {
      const again = this.prefs.auto ? ' It reconnects when plugged back in, with live off.' : '';
      this.app.setStatus(`The OpenDrop went away (unplugged?).${again}`, 'warn');
      this.changed();
    }

    // The board tells which layout fits: magnet boards the magnet one. Only switched between the
    // standard and magnet layouts, as the original did.
    boardFound(board) {
      const now = this.app.layoutId();
      if (!MAGNET_PAIR.includes(now)) return;
      const want = board.magnet ? 'electrodes_magnet' : 'electrodes';
      if (want === now) return;
      this.app.useLayout(want);
      this.switchedLayout = board.magnet ? 'magnet' : 'standard';
    }

    // --- live, feedback, temperatures ------------------------------------------------------------

    needsDevice() {
      if (this.session.connected) return false;
      this.app.setStatus('Connect the OpenDrop first: connect, bottom left, or the Device tab', 'warn');
      return true;
    }

    setLive(on) {
      if (this.needsDevice()) return;
      if (this.session.run) {
        this.app.setStatus('A sequence is running on the device: stop it first', 'warn');
        return;
      }
      if (this.session.setLive(on)) this.app.setStatus(`Live: the device shows frame ${this.ed.frame}, and follows what is on screen`);
      else this.app.setStatus('Live off: everything on the device is switched off');
      this.changed();
    }

    setFeedback(on) {
      if (this.needsDevice()) return;
      const s = this.session;
      if (on && !(s.board && s.board.feedback)) {
        this.app.setStatus(`${s.board ? s.board.name : 'This board'} has no feedback (OpenDrop V4.2 has it)`, 'warn');
        return;
      }
      s.setFeedback(on);
      this.app.setStatus(on ? 'Feedback: dots show where the device senses droplets' : 'Feedback off');
      this.changed();
    }

    allOff() {
      if (this.needsDevice()) return;
      this.session.allOff();
      this.app.setStatus('Everything on the device is switched off; live is off');
    }

    buildTemps() {
      this.tempInputs = [];
      this.tempNow = [];
      for (let i = 0; i < 3; i++) {
        const tr = document.createElement('tr');
        const name = document.createElement('th');
        name.textContent = `T${i + 1}`;
        const now = document.createElement('td');
        const target = document.createElement('td');
        const input = document.createElement('input');
        Object.assign(input, { type: 'number', min: TEMP_RANGE[0], max: TEMP_RANGE[1], step: 1 });
        input.setAttribute('aria-label', `T${i + 1} target, °C`);
        input.addEventListener('change', () => this.setTarget(i, Number(input.value)));
        input.addEventListener('keydown', (evt) => {
          if (evt.key === 'Enter' || evt.key === 'Escape') input.blur();
          evt.stopPropagation();
        });
        target.append(input, ' °C');
        tr.append(name, now, target);
        this.dom.temps.appendChild(tr);
        this.tempInputs.push(input);
        this.tempNow.push(now);
      }
    }

    setTarget(i, value) {
      const targets = this.session.targets.slice();
      targets[i] = value;
      this.session.setTargets(targets);
      this.prefs.targets = this.session.targets.slice();
      this.app.savePrefs();
      this.app.setStatus(`T${i + 1} target: ${this.session.targets[i]} °C`);
    }

    // --- a whole sequence (protocol 1) -----------------------------------------------------------

    async load() {
      if (this.ed.readOnly) return this.app.setStatus(this.ed.readOnly, 'warn');
      const seq = this.ed.seq;
      const n = seq.lastFrame();
      if (n > MAX_FRAMES) {
        this.app.setStatus(`Not sent: the device holds at most ${MAX_FRAMES} frames and this sequence has ${n}. Play it live instead (live on the board, then simulate), which has no limit.`, 'warn');
        return;
      }
      const result = await this.session.load(encodeSequence(seq, n));
      if (result.ok) this.app.setStatus(`Sent ${plural(result.frames, 'frame')} (${this.app.formatTime(seq.elapsed(n))}) to the device: Run starts it`);
      else this.app.setStatus(`Not sent: ${result.reason}`, 'warn');
      this.changed();
    }

    async run() {
      if (this.ed.readOnly) return this.app.setStatus(this.ed.readOnly, 'warn');
      const result = await this.session.start();
      if (result.ok) this.app.setStatus('Running on the device, on its own clock; Stop ends it and switches everything off');
      else this.app.setStatus(`Not started: ${result.reason}`, 'warn');
      this.changed();
    }

    async stop() {
      const result = await this.session.stop();
      this.app.setStatus(result.ok ? 'Stopped: everything on the device is switched off' : `Not stopped: ${result.reason}`, result.ok ? 'info' : 'warn');
      this.changed();
    }

    // --- the tab -----------------------------------------------------------------------------------

    wire() {
      const d = this.dom;
      const click = (node, fn) =>
        node.addEventListener('click', (evt) => {
          evt.currentTarget.blur();
          fn();
        });
      click(d.connect, () => this.connect());
      click(d.disconnect, () => this.disconnect());
      click(d.sim, () => this.useSimulated());
      click(d.allOff, () => this.allOff());
      click(d.load, () => this.load());
      click(d.run, () => this.run());
      click(d.stop, () => this.stop());
      d.auto.addEventListener('change', () => {
        this.prefs.auto = d.auto.checked;
        this.app.savePrefs();
        d.auto.blur();
      });
      click(d.hvSave, () => this.saveHV());
      d.feedback.addEventListener('change', () => {
        this.setFeedback(d.feedback.checked);
        d.feedback.blur();
        this.key = '';
        this.render();
      });
    }

    changed() {
      this.app.redraw();
    }

    // Save to device: the project's high voltage, sent with the save flag, so the device writes
    // it to its memory (with its sound and the feedback switch as sent now). Nothing set in the
    // project: the device saves what it has.
    async saveHV() {
      const hv = this.ed.project.hv || null;
      const r = await this.session.sendHV(hv, { save: true });
      const what = hvText(hv);
      if (r.ok) this.app.setStatus(what ? `Saved on the device: ${what}; it starts with these from now on` : 'Saved on the device: the settings it has now');
      else this.app.setStatus(`Not saved: ${r.reason}`, 'warn');
      this.changed();
    }

    render() {
      const s = this.session;
      const b = this.boardState();
      const seq = this.ed.seq;
      const n = seq.lastFrame();
      const key = JSON.stringify([b, s.temps, s.targets, s.sentTargets, s.live, s.protocol, s.run, this.portLabel, n, seq.elapsed(n), this.busy, this.ed.readOnly, this.ed.project.hv || null]);
      if (key === this.key) return;
      this.key = key;
      const d = this.dom;
      const on = s.connected;
      for (const dot of [d.dot, d.tabDot]) dot.className = `dot ${b.state}`;
      const states = {
        off: 'Not connected',
        connecting: 'Connecting…',
        on: b.name || 'Connected',
        silent: `${b.name || 'The OpenDrop'}: not answering`,
      };
      d.state.textContent = states[b.state];
      d.port.textContent = on ? `${this.portLabel}${s.protocol ? ` · protocol ${s.protocol}` : ''}` : serial.supported() ? 'USB, Chrome or Edge' : '';
      d.connect.hidden = on;
      document.getElementById('device-pick-hint').hidden = on;
      d.connect.disabled = this.busy || !serial.supported();
      d.disconnect.hidden = !on;
      d.allOff.disabled = !on;
      d.feedbackPart.hidden = !(on && b.canFeedback);
      d.feedback.checked = b.feedback;
      d.sensed.textContent = b.feedback ? (s.sensed.length ? `Senses ${plural(s.sensed.length, 'electrode')}` : 'Senses nothing') : '';
      d.tempsPart.hidden = !(on && s.board && s.board.temperature);
      const sent = s.sentTargets;
      s.temps.forEach((t, i) => {
        this.tempNow[i].textContent = t === null ? '—' : `${t.toFixed(1)} °C`;
        // Live, a heater the sequence sets follows the frame on screen.
        const bySeq = Boolean(s.live && s.frameTargets && typeof s.frameTargets[i] === 'number');
        const input = this.tempInputs[i];
        input.disabled = bySeq;
        input.title = bySeq ? 'Set by the sequence while live (frame on screen)' : '';
        if (document.activeElement !== input) input.value = String(bySeq ? sent[i] : s.targets[i]);
      });
      // The project's high voltage (set in Properties).
      const hv = hvText(this.ed.project.hv);
      d.hvNow.textContent = hv ? `This project: ${hv}` : "This project sets none: the device keeps its own";
      d.hvSave.disabled = s.state !== 'on' || Boolean(s.run);
      d.seq.textContent = `${plural(n, 'frame')}, ${this.app.formatTime(seq.elapsed(n))}`;
      // While the process runs here (or in another tab), the device is the run's: no sending.
      const running = this.ed.readOnly;
      d.load.disabled = !s.canLoad || Boolean(s.run) || Boolean(running);
      d.run.disabled = !s.canLoad || Boolean(s.run) || Boolean(running);
      d.load.title = running || '';
      d.run.title = running || 'The device plays the sequence sent to it on its own, without this page (not the process\'s ▶ Run)';
      d.stop.disabled = !s.canLoad || !s.run;
      d.seqNote.hidden = on && s.protocol >= 1;
      d.runState.textContent = s.run ? `Running on the device: frame ${s.run.frame} of ${s.run.frames}` : '';
    }
  }

  OD.devicePanel = { DevicePanel };
})(globalThis);
