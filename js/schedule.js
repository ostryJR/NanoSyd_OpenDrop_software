/* The process in time, with lanes that go their own way. Each lane runs on its own: a stretch (the
 * steps between two stops) starts in the frame after the work leading to it ended, and plays at
 * the same time as whatever else is playing; a frame on the board is all of them together. A
 * question (Measure, Ask, a decision whose value isn't known) pauses everything while it is asked;
 * decisions and Repeats choose the way. A lane that ends in End leaves its droplets where they
 * are. A Wait for all or a Merge that lanes reach from different stretches waits for all of them.
 *
 * A Schedule is used by a run (questions answered by you) and to lay the process out on the
 * timeline (`route`: on at every decision, without asking). No DOM here. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./compile.js'), require('./process.js'), require('./model.js'), require('./stretch.js'));
  else (root.OD = root.OD || {}).schedule = factory(root.OD.compile, root.OD.process, root.OD.model, root.OD.stretch);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (compiler, P, model, S) {
  'use strict';

  const { compile } = compiler;
  const MAX_IDLE = 1000; // moves without playing a frame before it counts as going round for ever
  const DROPLET_CELLS = 128; // electrodes of droplets; the ones above are control lines
  const tileName = (t) => t.name || P.KINDS[t.kind].name;
  const valueText = (v) => (v === true ? 'yes' : v === false ? 'no' : String(v));

  class Schedule {
    // choose(tile, values): the port a decision goes by, or undefined if its value isn't known
    // (a run then asks for it). Without it, decisions go by the values.
    constructor(doc, rects, { choose = null } = {}) {
      this.doc = doc;
      this.rects = rects;
      this.process = doc.process;
      this.g = P.graph(this.process);
      this.back = P.backLinks(this.process, this.g);
      this.st = P.stretches(this.process, this.g, this.back);
      this.choose = choose || ((t, values) => {
        const holds = P.evaluate(t, values);
        return holds === undefined ? undefined : holds ? 'yes' : 'no';
      });
      this.frame = 0; // the last frame played
      this.visits = []; // each time the way goes through a stretch (see enter())
      this.threads = []; // lanes on their way between stretches: { at, droplets, via }
      this.parked = []; // droplets left where they are: { droplet, cells, from }
      this.values = {};
      this.rounds = new Map(); // Repeat tile -> rounds left
      this.joins = new Map(); // join tile -> { links: Set, droplets } lanes arrived so far
      this.marks = []; // stops on the way: { kind: 'stop' | 'end', tile, frame, text }
      this.log = []; // what was decided, counted and answered, for a run's log
      this.controls = null; // the heaters and magnets as the last frame left them
      this.pending = null; // a question waiting for an answer: { kind: 'ask', tile, missing, thread }
      this.ended = null; // { kind: 'end' | 'stuck' | 'cut', text }
      this.idle = 0;
      this.cache = new Map();
      const start = this.process.tiles.find((t) => t.kind === 'start');
      if (start) this.threads.push({ at: start.id, droplets: [], via: null });
      else this.finish('stuck', 'There is no Start tile');
    }

    finish(kind, text = '') {
      if (this.ended) return;
      this.ended = { kind, text };
      if (kind !== 'end') this.log.push({ kind, text });
    }

    // Moves the lanes on until each plays, waits or has ended, and says what comes next:
    // { kind: 'play' } (a frame: current(), then step()), { kind: 'ask', tile, missing }, or the end
    // ({ kind: 'end' | 'stuck' | 'cut', text }).
    advance() {
      for (;;) {
        while (!this.ended && !this.pending && this.threads.length) this.move(this.threads.shift());
        if (this.ended || this.pending || !this.fireJoins()) break;
      }
      if (this.ended) return { ...this.ended };
      if (this.pending) return this.pending;
      if (this.visits.some((v) => v.to > this.frame)) return { kind: 'play' };
      if (this.joins.size) {
        const t = this.g.byId.get([...this.joins.keys()][0]);
        this.finish('stuck', `${tileName(t)}: it waits for lanes that never get there`);
      } else this.finish('end');
      return { ...this.ended };
    }

    // One lane one tile further.
    move(t) {
      if (++this.idle > MAX_IDLE) {
        this.finish('stuck', 'The process goes round without doing anything');
        return;
      }
      const x = this.g.byId.get(t.at);
      switch (x.kind) {
        case 'start':
          this.follow(t, x, 'next');
          return;
        case 'end':
          this.marks.push({ kind: 'end', tile: x.id, frame: this.frame, text: tileName(x) });
          this.park(t.droplets);
          return;
        case 'measure':
        case 'ask':
          this.pending = { kind: 'ask', tile: x, thread: t };
          return;
        case 'decision': {
          const port = this.choose(x, this.values);
          if (port === undefined) {
            this.pending = { kind: 'ask', tile: x, missing: x.value, thread: t };
            return;
          }
          const text = `${P.conditionText(x, this.process)}: ${port}`;
          this.log.push({ kind: 'decision', tile: x.id, text });
          this.marks.push({ kind: 'stop', tile: x.id, frame: this.frame, text });
          this.follow(t, x, port);
          return;
        }
        case 'repeat': {
          const times = Math.max(1, Number(x.times) || 1);
          const left = this.rounds.has(x.id) ? this.rounds.get(x.id) : times;
          if (left > 0) {
            this.rounds.set(x.id, left - 1);
            const text = `round ${times - left + 1} of ${times}`;
            this.log.push({ kind: 'repeat', tile: x.id, text });
            this.marks.push({ kind: 'stop', tile: x.id, frame: this.frame, text: `${tileName(x)}: ${text}` });
            this.follow(t, x, 'again');
          } else {
            this.rounds.delete(x.id);
            this.log.push({ kind: 'repeat', tile: x.id, text: 'done' });
            this.follow(t, x, 'done');
          }
          return;
        }
        default:
          this.enter(t, x);
      }
    }

    follow(t, x, port) {
      const l = this.g.out.get(x.id).find((y) => y.port === port);
      if (!l) this.finish('stuck', `${tileName(x)}: its ${P.portName(port)} arrow goes nowhere`);
      else this.threads.push({ at: l.to, droplets: t.droplets, via: l });
    }

    // A lane gets to a stretch: it plays from the next frame, with the lane's droplets and the
    // heaters and magnets as they are.
    enter(t, x) {
      // A Wait for all or Merge that lanes reach from different stretches waits for them all
      // (see fireJoins()).
      if (P.endsLanes(x) && !t.joined && this.g.into.get(x.id).filter((l) => !this.back.has(P.linkKey(l))).length > 1) {
        const j = this.joins.get(x.id) || { droplets: [] };
        j.droplets.push(...t.droplets);
        this.joins.set(x.id, j);
        return;
      }
      const sid = this.st.of.get(x.id);
      const s = this.st.list.find((y) => y.id === sid);
      if (!s) {
        this.finish('stuck', `${tileName(x)}: it isn't part of any step on the board`);
        return;
      }
      const key = JSON.stringify([sid, t.droplets, this.controls]);
      if (!this.cache.has(key)) {
        this.cache.set(key, compile(S.stretchProject(this.doc, s.tiles), this.rects, { arrive: S.arrivals(t.droplets), controls: this.controls }));
      }
      const compiled = this.cache.get(key);
      const mine = this.doc.actions.filter((a) => s.tiles.includes(a.tile));
      const length = Math.max(0, ...mine.map((a) => (compiled.spans.get(a.id) || { to: 0 }).to));
      if (this.frame + length > model.MAX_FRAMES) {
        this.finish('cut', `It runs past frame ${model.MAX_FRAMES}`);
        return;
      }
      const v = {
        visit: this.visits.length + 1,
        stretch: sid,
        tile: s.start,
        tiles: s.tiles,
        from: this.frame + 1,
        to: this.frame + length,
        length,
        compiled,
        state: t.droplets,
        controls: this.controls,
        exits: S.waysOut(this.doc, s, compiled, this.g, this.back).map((w) => ({ ...w, done: false })),
        done: false,
      };
      this.visits.push(v);
      this.release(v, 0);
    }

    // A Wait for all or Merge waiting for lanes goes on once no other lane can still get there (so
    // it doesn't wait for the other side of a decision). Whether one went on.
    fireJoins() {
      if (!this.joins.size) return false;
      // Where the lanes still going are, or will go on from.
      const live = [...this.threads.map((t) => t.at), ...(this.pending ? [this.pending.thread.at] : [])];
      for (const v of this.visits) for (const e of v.exits) if (!e.done) live.push(e.link.to);
      let fired = false;
      for (const [id, j] of [...this.joins]) {
        const others = [...live, ...[...this.joins.keys()].filter((k) => k !== id)];
        if (others.some((from) => this.reaches(from, id))) continue;
        this.joins.delete(id);
        this.threads.push({ at: id, droplets: j.droplets, via: null, joined: true });
        fired = true;
      }
      return fired;
    }

    // Whether tile `to` can be reached from tile `from` (or is it).
    reaches(from, to) {
      const seen = new Set([from]);
      const queue = [from];
      while (queue.length) {
        const id = queue.shift();
        if (id === to) return true;
        for (const l of this.g.out.get(id)) {
          if (seen.has(l.to)) continue;
          seen.add(l.to);
          queue.push(l.to);
        }
      }
      return false;
    }

    // The ways out of visit v whose lane's work has ended by its frame `local` go on; once all of
    // it has played, droplets no way took stay where they are.
    release(v, local) {
      for (const e of v.exits) {
        if (e.done || e.frame > local) continue;
        e.done = true;
        this.threads.push({ at: e.link.to, droplets: e.droplets, via: e.link });
      }
      if (v.done || local < v.length) return;
      v.done = true;
      if (!v.exits.length) {
        this.finish('stuck', `${tileName(this.g.byId.get(v.tile))}: nothing comes after it`);
        return;
      }
      const taken = new Set(v.exits.flatMap((e) => e.droplets.map((d) => d.droplet)));
      this.park(v.compiled.left.filter((d) => !taken.has(d.droplet)));
    }

    park(droplets) {
      for (const d of droplets) this.parked.push({ droplet: d.droplet, cells: d.cells.slice(), from: this.frame + 1 });
    }

    // The visits playing in frame f.
    playing(f = this.frame + 1) {
      return this.visits.filter((v) => v.from <= f && f <= v.to);
    }

    // The next frame: which visits play it and at which of their own frames, how long it lasts
    // (the longest of theirs: a Wait alone in one lane holds the others for that frame), and the
    // heaters' hold in it, if any.
    current() {
      const frame = this.frame + 1;
      const parts = this.playing(frame).map((visit) => ({ visit, local: frame - visit.from + 1 }));
      const time = Math.max(0, ...parts.map((p) => p.visit.compiled.seq.timeOf(p.local)));
      const hold = parts.map((p) => p.visit.compiled.seq.holds.get(p.local)).find(Boolean) || null;
      return { frame, parts, time, hold };
    }

    // That frame has played: on to the next; lanes whose work ended go on.
    step() {
      this.frame++;
      this.idle = 0;
      for (const v of this.visits) {
        if (v.done || v.from > this.frame) continue;
        const local = this.frame - v.from + 1;
        const c = local <= v.length ? v.compiled.seq.controls[local] : null;
        if (c) this.controls = c; // the lane that started last sets them
        this.release(v, local);
      }
    }

    // The answer to the question asked.
    answer(value) {
      const p = this.pending;
      if (!p) return;
      this.pending = null;
      this.idle = 0;
      const t = p.tile;
      const name = p.missing || t.value;
      if (name) this.values[name] = value;
      this.log.push({ kind: 'value', tile: t.id, text: `${name || tileName(t)} = ${valueText(value)}` });
      if (t.kind === 'decision') this.threads.unshift(p.thread);
      else {
        this.marks.push({ kind: 'stop', tile: t.id, frame: this.frame, text: `${tileName(t)}${name ? `: ${name} = ${valueText(value)}` : ''}` });
        this.follow(p.thread, t, 'next');
      }
    }

    // On from the question without an answer (laying the process out).
    skip() {
      const p = this.pending;
      if (!p) return;
      this.pending = null;
      const t = p.tile;
      this.marks.push({ kind: 'stop', tile: t.id, frame: this.frame, text: `${tileName(t)}${t.value ? `: ${t.value}` : ''}` });
      if (t.kind === 'decision') this.follow(p.thread, t, 'yes');
      else this.follow(p.thread, t, 'next');
    }

    // Other lanes' droplets while visit v plays, for compile()'s `context`: those of the visits
    // playing at the same time (switched on or lying), and those left where they are.
    contextOf(v) {
      const out = [];
      for (const w of this.visits) {
        if (w === v || w.to < v.from || w.from > v.to || !w.length) continue;
        const names = new Map([...S.arrivals(w.state), ...this.doc.actions].map((a) => [a.id, a.droplet || '']));
        const entries = new Map();
        const entry = (id) => {
          if (!entries.has(id)) entries.set(id, { id: `lane:${w.visit}:${id}`, droplet: names.get(id) || '', on: {}, rest: {} });
          return entries.get(id);
        };
        const put = (map, f, cells) => (map[f] = (map[f] || []).concat(cells));
        for (let f = Math.max(v.from, w.from); f <= Math.min(v.to, w.to); f++) {
          const wl = f - w.from + 1;
          const vl = f - v.from + 1;
          for (const { id, step } of w.compiled.active[wl] || []) {
            const x = w.compiled.expanded.get(id);
            const cells = x && x.steps ? x.steps[step].cells.filter((e) => e >= 0 && e < DROPLET_CELLS) : [];
            if (cells.length) put(id.startsWith('in:') ? entry(id).rest : entry(id).on, vl, cells);
          }
          for (const r of w.compiled.resting) if (r.from <= wl && wl <= r.to && !String(r.id).startsWith('lane:')) put(entry(r.id).rest, vl, r.cells);
        }
        out.push(...entries.values());
      }
      this.parked.forEach((d, i) => {
        const rest = {};
        for (let f = Math.max(v.from, d.from); f <= v.to; f++) rest[f - v.from + 1] = d.cells;
        if (Object.keys(rest).length) out.push({ id: `lane:left${i}`, droplet: d.droplet, on: {}, rest });
      });
      return out;
    }

    // Everything played or laid out so far as one project and its frames, for the board and the
    // timeline: { project (the actions, ids "<visit>:<id>", `visit`, `of` the real id), compiled
    // (like compile()'s, with other lanes' droplets checked against each visit), parts (each visit,
    // { kind: 'stretch', visit, stretch, tile, tiles, from, to, state, controls, context }, and the
    // stops, { kind: 'stop' | 'end', tile, frame, text }, in order) }.
    plan() {
      const seq = new model.Sequence();
      seq.frameTime = this.doc.frameTime || seq.frameTime;
      const actions = [];
      const spans = new Map();
      const expanded = new Map();
      const active = [[]];
      const issues = [];
      const resting = [];
      const pid = (v, id) => `${v}:${id}`;
      const end = Math.max(0, ...this.visits.map((v) => v.to), ...this.marks.map((m) => m.frame));
      for (let f = 1; f <= end; f++) {
        const parts = this.playing(f);
        seq.grow(f);
        active[f] = [];
        let time = 0;
        for (const v of parts) {
          const local = f - v.from + 1;
          const cells = v.compiled.seq.cells(local);
          for (let e = 0; e < cells.length; e++) if (cells[e]) seq.frames[f][e] = 1;
          time = Math.max(time, v.compiled.seq.timeOf(local));
          const hold = v.compiled.seq.holds.get(local);
          if (hold && !seq.holds.has(f)) seq.holds.set(f, hold);
          if (v.compiled.seq.controls[local]) seq.controls[f] = v.compiled.seq.controls[local];
          active[f].push(...(v.compiled.active[local] || []).map((x) => ({ ...x, id: pid(v.visit, x.id) })));
        }
        if (time && time !== seq.frameTime) seq.setTime(f, time);
      }
      seq.end = end;
      const parts = [];
      for (const v of this.visits) {
        const context = this.contextOf(v);
        // Checked against the other lanes too (only for the frames as laid out here).
        const checked = context.length && v.length
          ? compile(S.stretchProject(this.doc, v.tiles), this.rects, { arrive: S.arrivals(v.state), controls: v.controls, context })
          : v.compiled;
        const shift = v.from - 1;
        for (const a of this.doc.actions.filter((x) => v.tiles.includes(x.tile))) {
          const id = pid(v.visit, a.id);
          const after = a.after === undefined ? undefined : Array.isArray(a.after) ? a.after.map((x) => pid(v.visit, x)) : pid(v.visit, a.after);
          actions.push({ ...a, id, of: a.id, visit: v.visit, ...(after === undefined ? {} : { after }) });
          const span = v.compiled.spans.get(a.id);
          if (span) spans.set(id, { from: span.from + shift, to: span.to + shift });
          if (v.compiled.expanded.has(a.id)) expanded.set(id, v.compiled.expanded.get(a.id));
        }
        for (const i of checked.issues) if (!String(i.id).startsWith('lane:')) issues.push({ ...i, id: pid(v.visit, i.id) });
        const names = new Map([...S.arrivals(v.state), ...this.doc.actions].map((a) => [a.id, a.droplet || '']));
        for (const r of v.compiled.resting) {
          if (r.from > v.length) continue;
          resting.push({ id: pid(v.visit, r.id), droplet: names.get(r.id) || '', cells: r.cells, from: r.from + shift, to: Math.min(r.to, v.length) + shift });
        }
        parts.push({ kind: 'stretch', visit: v.visit, stretch: v.stretch, tile: v.tile, tiles: v.tiles, from: v.from, to: v.to, state: v.state, controls: v.controls, context });
      }
      for (const d of this.parked) if (d.from <= end) resting.push({ id: 'left', droplet: d.droplet, cells: d.cells, from: d.from, to: end });
      for (const m of this.marks) parts.push(m);
      parts.sort((a, b) => (a.kind === 'stretch' ? a.from - 1 : a.frame) - (b.kind === 'stretch' ? b.from - 1 : b.frame) || (a.kind === 'stretch') - (b.kind === 'stretch'));
      const project = { ...this.doc, actions };
      delete project.process;
      const compiled = {
        seq, spans, active, expanded, resting, touches: new Set(), left: [], issues,
        frameTime: seq.frameTime, controls: this.controls, rates: this.visits.length ? this.visits[0].compiled.rates : null,
      };
      return { project, compiled, parts };
    }
  }

  // The process laid out along one way through it, as a run would go if every decision went on
  // instead of back round a loop (a loop that waits for an answer is shown once; where both ways go
  // on, "yes"), every Repeat ran its rounds, and nothing was asked. plan()'s
  // { project, compiled, parts }, and how it ended: 'end', 'stuck' (an arrow goes nowhere, or no
  // Start) or 'cut' (too long).
  function route(doc, rects) {
    const g = P.graph(doc.process);
    const back = P.backLinks(doc.process, g);
    const choose = (t) => {
      const ways = ['yes', 'no'].map((name) => g.out.get(t.id).find((l) => l.port === name)).filter(Boolean);
      const pick = ways.find((l) => !back.has(P.linkKey(l))) || ways[0];
      return pick ? pick.port : 'yes';
    };
    const s = new Schedule(doc, rects, { choose });
    for (;;) {
      const r = s.advance();
      if (r.kind === 'ask') s.skip();
      else if (r.kind === 'play') s.step();
      else break;
    }
    return { ...s.plan(), ended: s.ended.kind, text: s.ended.text };
  }

  return { Schedule, route };
});
