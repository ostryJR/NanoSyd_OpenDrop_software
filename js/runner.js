/* Running the process: from Start, each stretch is shown on the board with the droplets where they
 * really are and played frame by frame with its frame times (the OpenDrop follows when it is
 * live); a Measure or Ask tile asks for its value, decisions and repeats choose the way, until
 * End. Nothing in the project changes; while it runs, the board can't be edited. No DOM here:
 * the page passes in how to ask and is told when anything changed. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./process.js'), require('./heat.js'));
  else (root.OD = root.OD || {}).runner = factory(root.OD.process, root.OD.heat);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (P, heat) {
  'use strict';

  class Runner {
    // hooks: { editor, ask(step) -> Promise of the value, or null to stop the run, changed(),
    //   timers ({ setTimeout, clearTimeout }), now() -> ms, speed (1 = real time),
    //   readings() -> the heaters' temperatures (°C or null ×3) when a live device measures
    //   them, otherwise null: a frame that waits for the heaters then lasts until they get
    //   there, instead of its estimated time }
    constructor(hooks) {
      this.hooks = { changed() {}, timers: globalThis, now: () => Date.now(), speed: 1, readings: () => null, ...hooks };
      this.ed = hooks.editor;
      this.state = null; // { tile, stretch, frame, frames, log, values, paused, done, text, started }
      this.stopping = false;
      this.wake = null;
    }

    get running() {
      return Boolean(this.state && !this.state.done);
    }

    note(text, tile = null) {
      const s = this.state;
      s.log.push({ ms: this.hooks.now() - s.started, text, tile });
      this.hooks.changed();
    }

    // Runs the process to its end (or until stopped); a project without a process plays its
    // sequence once, frame 1 to the last. Resolves with how it ended: 'end', 'stopped' or 'stuck'.
    async start() {
      if (this.running) return null;
      const ed = this.ed;
      const process = ed.doc.process;
      ed.cancel();
      ed.playing = false;
      const back = ed.scope && ed.scope.tile;
      this.stopping = false;
      this.state = { tile: null, stretch: null, frame: 0, frames: 0, log: [], values: {}, paused: false, done: null, text: '', started: this.hooks.now() };
      ed.frozen = 'A run is going: stop it to change things';
      if (!process) return this.playSequence();
      const walk = new P.Walk(JSON.parse(JSON.stringify(process)));
      let droplets = [];
      let controls = null; // the heaters and magnets as the stretches before left them
      const name = (t) => (t.kind === 'decision' ? P.conditionText(t, process) : t.name || P.KINDS[t.kind].name);
      let ended = 'end';
      let seen = 0;
      try {
        for (;;) {
          for (; seen < walk.log.length; seen++) {
            const e = walk.log[seen];
            if (e.kind === 'decision' || e.kind === 'repeat') this.note(`${name(P.tileById(process, e.tile))}: ${e.text.replace(/^.*: /, '')}`, e.tile);
            else if (e.kind === 'value') this.note(e.text, e.tile);
          }
          if (this.stopping) {
            ended = 'stopped';
            break;
          }
          const step = walk.step;
          if (step.kind === 'end') break;
          if (step.kind === 'stuck') {
            ended = 'stuck';
            this.state.text = step.text;
            this.note(`Stopped: ${step.text}`);
            break;
          }
          if (step.kind === 'ask') {
            this.state.tile = step.tile.id;
            this.state.stretch = null;
            this.hooks.changed();
            const value = await this.hooks.ask(step);
            if (value === null || value === undefined || this.stopping) {
              ended = 'stopped';
              break;
            }
            walk.answer(value);
            this.state.values = { ...walk.values };
            continue;
          }
          // A stretch: show it with the droplets as they are, and play it.
          const s = step.stretch;
          ed.showStretch(s.id, droplets, controls);
          const tile = P.tileById(process, s.start);
          this.state.stretch = s.id;
          this.state.tile = s.start;
          const end = Math.max(0, ...[...ed.compiled.spans.values()].map((x) => x.to));
          if (!ed.project.actions.length) this.note(`${name(tile)}: nothing on the board`, s.start);
          else {
            this.note(`${name(tile)}${s.tiles.length > 1 ? ` (and ${s.tiles.length - 1} more)` : ''}: ${end} frames`, s.start);
            await this.playFrames(end);
          }
          if (this.stopping) {
            ended = 'stopped';
            break;
          }
          droplets = ed.compiled.left;
          controls = ed.compiled.controls;
          walk.go();
        }
      } finally {
        ed.frozen = null;
        this.state.done = ended;
        this.state.stretch = null;
        if (ended === 'end') this.note('Done');
        else if (ended === 'stopped') this.note('Stopped');
        if (!(back && ed.openTile(back))) ed.rescope();
        this.hooks.changed();
      }
      return ended;
    }

    // Plays frames 1 to `end` on the board, each for its time (or until the heaters get there).
    async playFrames(end) {
      const ed = this.ed;
      this.state.frames = end;
      for (let f = 1; f <= end && !this.stopping; f++) {
        ed.frame = f;
        this.state.frame = f;
        this.hooks.changed();
        const hold = ed.seq.holds.get(f);
        if (hold && this.hooks.readings()) await this.heatUp(hold, f);
        else await this.sleep(ed.seq.timeOf(f));
      }
    }

    // No process: the sequence once, then back to the frame that was on screen.
    async playSequence() {
      const ed = this.ed;
      const back = ed.frame;
      const end = ed.seq.lastFrame();
      let ended = 'end';
      try {
        if (!ed.project.actions.length || end < 1) this.note('Nothing on the board');
        else {
          this.note(`The sequence: ${end} frames`);
          await this.playFrames(end);
        }
        if (this.stopping) ended = 'stopped';
      } finally {
        ed.frozen = null;
        this.state.done = ended;
        ed.frame = back;
        this.note(ended === 'end' ? 'Done' : 'Stopped');
      }
      return ended;
    }

    // Waits in frame f until the device's heaters reach `hold`'s targets (or the run stops).
    async heatUp(hold, f) {
      const from = this.hooks.now();
      this.state.heating = { frame: f, targets: hold.targets, tolerance: hold.tolerance };
      this.note(`Waiting for the heaters: ${heat.targetsText(hold.targets)}`);
      for (;;) {
        const temps = this.hooks.readings();
        if (!temps || heat.reached(temps, hold.targets, hold.tolerance) || this.stopping) break;
        await this.sleep(250 * this.hooks.speed);
      }
      this.state.heating = null;
      if (!this.stopping) {
        const s = Math.round((this.hooks.now() - from) / 1000);
        this.note(`The heaters got there (${s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`})`);
      }
    }

    // Waits `ms` of run time (longer while paused, shorter at a higher speed).
    async sleep(ms) {
      let left = ms / this.hooks.speed;
      while (left > 0 && !this.stopping) {
        if (this.state.paused) {
          await new Promise((resolve) => {
            this.wake = resolve;
          });
          continue;
        }
        const from = this.hooks.now();
        await new Promise((resolve) => {
          this.wake = resolve;
          this.timer = this.hooks.timers.setTimeout(resolve, left);
        });
        this.hooks.timers.clearTimeout(this.timer);
        left -= this.hooks.now() - from;
      }
    }

    pause(on = !this.state.paused) {
      if (!this.running) return;
      this.state.paused = on;
      if (this.wake) this.wake();
      this.note(on ? 'Paused' : 'Going on');
    }

    stop() {
      if (!this.running) return;
      this.stopping = true;
      if (this.wake) this.wake();
    }
  }

  return { Runner };
});
