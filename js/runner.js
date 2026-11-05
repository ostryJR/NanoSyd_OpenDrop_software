/* Running the process: from Start, each stretch is shown on the board with the droplets where they
 * really are and played frame by frame with its frame times (the OpenDrop follows when it is
 * live); a Measure or Ask tile asks for its value, decisions and repeats choose the way, until
 * End. Nothing in the project changes; while it runs, the board can't be edited. No DOM here:
 * the page passes in how to ask and is told when anything changed. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./process.js'));
  else (root.OD = root.OD || {}).runner = factory(root.OD.process);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (P) {
  'use strict';

  class Runner {
    // hooks: { editor, ask(step) -> Promise of the value, or null to stop the run, changed(),
    //   timers ({ setTimeout, clearTimeout }), now() -> ms, speed (1 = real time) }
    constructor(hooks) {
      this.hooks = { changed() {}, timers: globalThis, now: () => Date.now(), speed: 1, ...hooks };
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

    // Runs the process to its end (or until stopped). Resolves with how it ended:
    // 'end', 'stopped' or 'stuck'.
    async start() {
      if (this.running) return null;
      const ed = this.ed;
      const process = ed.doc.process;
      if (!process) return null;
      ed.cancel();
      ed.playing = false;
      const back = ed.scope && ed.scope.tile;
      this.stopping = false;
      this.state = { tile: null, stretch: null, frame: 0, frames: 0, log: [], values: {}, paused: false, done: null, text: '', started: this.hooks.now() };
      ed.frozen = 'A run is going: stop it to change things';
      const walk = new P.Walk(JSON.parse(JSON.stringify(process)));
      let droplets = [];
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
          ed.showStretch(s.id, droplets);
          const tile = P.tileById(process, s.start);
          this.state.stretch = s.id;
          this.state.tile = s.start;
          const end = Math.max(0, ...[...ed.compiled.spans.values()].map((x) => x.to));
          if (!ed.project.actions.length) this.note(`${name(tile)}: nothing on the board`, s.start);
          else {
            this.note(`${name(tile)}${s.tiles.length > 1 ? ` (and ${s.tiles.length - 1} more)` : ''}: ${end} frames`, s.start);
            this.state.frames = end;
            for (let f = 1; f <= end && !this.stopping; f++) {
              ed.frame = f;
              this.state.frame = f;
              this.hooks.changed();
              await this.sleep(ed.seq.timeOf(f));
            }
          }
          if (this.stopping) {
            ended = 'stopped';
            break;
          }
          droplets = ed.compiled.left;
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
