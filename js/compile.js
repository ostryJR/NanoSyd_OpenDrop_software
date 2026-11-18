/* Turns a project's actions into frames: the 200 x 144 on/off table and frame times that the
 * OpenDrop file format holds. Nothing else in the project is frames; this runs again after every
 * change, and on export. No DOM here. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./model.js'), require('./paths.js'), require('./templates.js'), require('./lines.js'), require('./heat.js'));
  } else {
    (root.OD = root.OD || {}).compile = factory(root.OD.model, root.OD.paths, root.OD.templates, root.OD.lines, root.OD.heat);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (model, paths, templates, lines, heat) {
  'use strict';

  const { CELLS, MAX_FRAMES, DEFAULT_FRAME_TIME, Sequence } = model;
  const { nearGraph } = paths;
  const { DROPLET_CELLS } = templates;

  // The reservoir buttons' droplet-dispensing sequences (from the original's mousePressed): the
  // electrodes switched on in each of six consecutive frames.
  const RESERVOIR_STEPS = {
    reservoirRightTop: [[123], [123, 122], [122, 121, 120], [120, 113], [113, 123, 122], [113, 123]],
    reservoirRightBottom: [[124], [124, 125], [125, 126, 127], [127, 118], [118, 124, 125], [118, 124]],
    reservoirLeftTop: [[3], [3, 2], [2, 1, 0], [0, 9], [9, 3, 2], [9, 3]],
    reservoirLeftBottom: [[4], [4, 5], [5, 6, 7], [7, 14], [14, 4, 5], [14, 4]],
  };
  const RESERVOIR_NAMES = {
    reservoirRightTop: 'right top',
    reservoirRightBottom: 'right bottom',
    reservoirLeftTop: 'left top',
    reservoirLeftBottom: 'left bottom',
  };

  // One action as steps { cells, time } (time 0 = the default frame time: every step that
  // switches electrodes takes one frame; only a Wait and a temperature that waits take their own
  // time), or { error } if it can't be shown. Paths also return `built` (their electrodes and
  // point steps).
  function expand(action, project, ctx) {
    switch (action.type) {
      case 'path': {
        const built = lines.build(ctx.graph, action.points);
        if (built.error) return { error: built.error };
        return { steps: built.cells.map((e) => ({ cells: [e], time: 0 })), built };
      }
      case 'template': {
        const def = project.templates && project.templates[action.template];
        if (!def) return { error: `its template (${action.template}) is missing from the file` };
        const spot = templates.place(def, action.turns || 0, action.at, 1, ctx.rects);
        if (!spot.fits) return { error: "it doesn't fit there: part of it would be off the array" };
        return { steps: spot.frames.map((cells) => ({ cells, time: 0 })) };
      }
      case 'dispense': {
        const list = RESERVOIR_STEPS[action.reservoir];
        if (!list) return { error: `there is no reservoir called ${action.reservoir}` };
        if (list.some((cells) => cells.some((e) => !ctx.graph.centres.has(e)))) {
          return { error: 'this layout has no such reservoir' };
        }
        return { steps: list.map((cells) => ({ cells: cells.slice(), time: 0 })) };
      }
      case 'pattern':
        return { steps: action.frames.map((cells) => ({ cells: cells.slice(), time: 0 })) };
      case 'arrive':
        // A droplet coming in from the stretch before: it rests on its electrodes from frame 1.
        return { steps: [{ cells: (action.cells || []).slice(), time: 0 }] };
      case 'wait':
        // A hold: nothing switched on for its time; the others keep moving meanwhile.
        return { steps: [{ cells: [], time: Math.max(1, Math.round(action.duration || 0)) }] };
      case 'temp':
        // Sets heater targets from its frame on. Waiting for them, it lasts as long as the heaters
        // are estimated to take (worked out where it starts); the others keep moving meanwhile.
        if (!Array.isArray(action.targets) || !action.targets.some((t) => typeof t === 'number')) return { error: 'it sets no temperature' };
        return { steps: [{ cells: [], time: 0 }] };
      case 'magnet':
        // Switches a magnet on or off from its frame on; it doesn't hold anything up.
        return { steps: [{ cells: [], time: 0 }] };
      default:
        return { error: `this version can't show “${action.type}” actions (kept in the file)`, unknown: true };
    }
  }

  // The actions an action waits for: `after` is one id or a list of them (it starts when they
  // have all ended). null for a fixed start.
  const predsOf = (a) => (a.after === undefined || a.after === null ? null : Array.isArray(a.after) ? a.after : [a.after]);

  // The frames of a project for a layout's rectangles:
  //   seq      the frames and frame times (a Sequence, as saved in OpenDrop files)
  //   spans    action id -> { from, to } frames (cut: it ran past the MAX_FRAMES guard)
  //   active   active[f] = [{ id, step }] for the actions running in frame f
  //   expanded action id -> what expand() returned
  //   resting  [{ id, cells, from, to }]: droplets left where an action ended, until picked up
  //   touches  Set of 'id|id' pairs of actions whose droplets touch
  //   left     [{ droplet, cells }]: where the droplets are at the end, by droplet name
  //   issues   [{ kind, id, text, ... }]; kinds: invalid, unknown, link, cut, jump, touch
  // Actions start at their `start` frame, or in the last frame of the action(s) they follow
  // (+ delay): the droplet is handed over in that frame. A frame lasts the default frame time. A
  // Wait (and a temperature that waits) doesn't hold the others up: it lasts over as many frames
  // as the others take, at least its own time; alone, its frame lasts the rest of it. `arrive` lists droplets coming in from the stretch before: actions of type
  // 'arrive' ({ id, droplet, cells }) that rest on their electrodes from frame 1, switch nothing on
  // and don't set frame times; others can follow them (after: their id) and mustn't touch them.
  // `controls` are the heater targets and magnets coming in (heat.emptyControls() if none):
  // 'temp' and 'magnet' actions change them from the frame they start in, magnets that are on
  // switch their electrodes (128/129) on in every frame, and seq.controls has them per frame.
  // A 'temp' action that waits makes its last frame a hold (seq.holds): played live, that frame
  // lasts until the heaters get there. `rates` (°C/min) give the estimate it lasts otherwise.
  function compile(project, rects, { arrive = [], controls = null } = {}) {
    const ctx = lines.context(rects);
    const frameTime = project.frameTime || DEFAULT_FRAME_TIME;
    const seq = new Sequence();
    seq.frameTime = frameTime;
    const issues = [];
    const spans = new Map();
    const active = [[]]; // grows with the frames
    const expanded = new Map();
    const actions = arrive.length ? [...arrive, ...project.actions] : project.actions;
    const coming = (a) => a.type === 'arrive';
    // Settings that take no time: a magnet, a temperature that doesn't wait.
    const marker = (a) => a.type === 'magnet' || (a.type === 'temp' && !a.wait);
    // Settings and waits don't hold the others up: they last over the frames the others take.
    const split = (a) => a.type === 'wait' || a.type === 'temp' || a.type === 'magnet';
    const state = controls ? heat.copyControls(controls) : heat.emptyControls();
    const rates = heat.cleanRates(project.heatRates);
    const byId = new Map(actions.map((a) => [a.id, a]));
    const nameOf = (id) => (byId.has(id) ? `“${byId.get(id).name}”` : id);

    const runnable = [];
    for (const a of actions) {
      const x = expand(a, project, ctx);
      expanded.set(a.id, x);
      if (x.error) issues.push({ kind: x.unknown ? 'unknown' : 'invalid', id: a.id, text: x.error });
      else if (!x.steps.length) issues.push({ kind: 'invalid', id: a.id, text: 'it has no steps' });
      else runnable.push(a);
    }

    const push = (map, key, value) => {
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(value);
    };
    const starts = new Map(); // frame -> actions starting there
    const followers = new Map(); // id -> actions that follow it
    const waiting = new Map(); // id -> ids it still waits for
    for (const a of runnable) {
      const preds = predsOf(a);
      if (!preds) push(starts, a.start || 1, a);
      else if (!preds.length || preds.some((id) => typeof id !== 'string')) issues.push({ kind: 'unknown', id: a.id, text: 'its start (after) is not understood' });
      else if (preds.some((id) => !byId.has(id))) {
        issues.push({ kind: 'link', id: a.id, text: `it follows an action that isn't there (${preds.filter((id) => !byId.has(id)).join(', ')})` });
      } else {
        waiting.set(a.id, new Set(preds));
        for (const id of new Set(preds)) push(followers, id, a);
      }
    }

    const stepTime = (r) => r.steps[r.k].time || frameTime;
    const started = new Set();
    const scheduled = new Map(); // frame -> followers starting there after a delay
    let running = [];
    const begin = (a, f) => {
      if (started.has(a.id)) return null;
      started.add(a.id);
      const r = { a, steps: expanded.get(a.id).steps, k: 0, from: f, remaining: 0 };
      if (marker(a)) r.remaining = 0;
      else if (a.type === 'temp') {
        // Waiting for the heaters: at least a frame, however close they are already.
        const want = state.targets.map((t, i) => (a.targets[i] === null || a.targets[i] === undefined ? null : a.targets[i]));
        r.remaining = Math.max(frameTime, heat.estimateMs(state.targets, want, rates));
        r.steps = [{ cells: [], time: r.remaining }];
      } else r.remaining = stepTime(r);
      if (a.type === 'temp' || a.type === 'magnet') heat.apply(state, a);
      running.push(r);
      return r;
    };
    // The controls in frame f; magnets that are on switch their electrodes on.
    const record = (f) => {
      seq.controls[f] = heat.copyControls(state);
      state.magnets.forEach((on, i) => {
        if (on) seq.set(heat.MAGNETS[i].e, f, true);
      });
    };
    const anyControls = heat.usesControls(state) || actions.some((a) => a.type === 'temp' || a.type === 'magnet');

    // Frames run until nothing is running or waiting to start (or the guard is reached).
    const lastStart = Math.max(0, ...starts.keys());
    for (let f = 1; f <= MAX_FRAMES; f++) {
      if (!running.length && f > lastStart && ![...scheduled.keys()].some((k) => k >= f)) break;
      active[f] = [];
      for (const a of starts.get(f) || []) begin(a, f);
      for (const a of scheduled.get(f) || []) begin(a, f);
      if (!running.length) {
        if (anyControls) record(f);
        continue;
      }

      // A frame with something switching electrodes lasts the default frame time; one with only
      // waits lasts until the first of them ends.
      const moves = (r) => !split(r.a) && !coming(r.a);
      let time = frameTime;
      if (!running.some(moves)) {
        const rest = running.filter((r) => !marker(r.a)).map((r) => r.remaining);
        if (rest.length) time = Math.min(...rest);
      }

      // Actions that end in this frame start their followers here too (once all that a follower
      // waits for have ended); those can only make the frame longer, which may end more split
      // actions.
      const ended = new Set();
      for (let more = true; more; ) {
        more = false;
        for (const r of running.slice()) {
          if (ended.has(r) || r.k !== r.steps.length - 1 || (split(r.a) && r.remaining > time)) continue;
          ended.add(r);
          more = true;
          for (const s of followers.get(r.a.id) || []) {
            const rest = waiting.get(s.id);
            rest.delete(r.a.id);
            if (rest.size) continue;
            if (s.delay > 0) {
              push(scheduled, f + s.delay, s);
              continue;
            }
            const n = begin(s, f);
            if (n && moves(n)) time = Math.max(time, frameTime);
          }
        }
      }

      for (const r of running) {
        if (!coming(r.a)) for (const e of r.steps[r.k].cells) if (e >= 0 && e < CELLS) seq.set(e, f, true);
        active[f].push({ id: r.a.id, step: r.k });
      }
      seq.setTime(f, time === frameTime ? 0 : time);
      if (anyControls) record(f);

      const next = [];
      for (const r of running) {
        if (split(r.a)) {
          r.remaining -= time;
          if (r.remaining > 0) {
            next.push(r);
            continue;
          }
        }
        r.k++;
        if (r.k >= r.steps.length) {
          spans.set(r.a.id, { from: r.from, to: f });
          if (r.a.type === 'temp' && r.a.wait) {
            seq.holds.set(f, { id: r.a.id, targets: r.a.targets.map((t) => (typeof t === 'number' ? t : null)), tolerance: heat.cleanTolerance(r.a.tolerance) });
          }
          continue;
        }
        if (split(r.a)) r.remaining = stepTime(r);
        next.push(r);
      }
      running = next;
    }

    for (const s of spans.values()) seq.end = Math.max(seq.end, s.to);
    for (const r of running) {
      spans.set(r.a.id, { from: r.from, to: MAX_FRAMES, cut: true });
      issues.push({ kind: 'cut', id: r.a.id, text: `it runs past frame ${MAX_FRAMES} and is cut short there` });
    }
    for (const a of runnable) {
      if (started.has(a.id) || !waiting.has(a.id)) continue; // fixed starts always start; bad links were reported
      const late = [...scheduled].some(([f, list]) => f > MAX_FRAMES && list.includes(a));
      const preds = predsOf(a);
      const notRun = preds.find((id) => !started.has(id));
      if (late) issues.push({ kind: 'cut', id: a.id, text: `it would start after frame ${MAX_FRAMES}` });
      else if (notRun) issues.push({ kind: 'link', id: a.id, text: `it follows ${nameOf(notRun)}, which doesn't run` });
      else issues.push({ kind: 'link', id: a.id, text: `it follows ${nameOf(preds.find((id) => !spans.has(id) || spans.get(id).cut) || preds[0])}, which never ends` });
    }

    // Droplet electrodes (control lines left out) of each step, and the first and last ones.
    const dropletCells = (cells) => cells.filter((e) => e >= 0 && e < DROPLET_CELLS);
    const firstCells = (id) => dropletCells(expanded.get(id).steps[0].cells);
    const lastCells = (id) => {
      const steps = expanded.get(id).steps;
      return dropletCells(steps[steps.length - 1].cells);
    };
    const shares = (a, b) => a.some((e) => b.includes(e));

    // A follower should start where the action(s) before it end: otherwise its droplet would jump.
    for (const a of runnable) {
      const preds = predsOf(a);
      if (!preds || a.type === 'dispense' || !spans.has(a.id)) continue;
      const first = firstCells(a.id);
      const away = preds.find((id) => spans.has(id) && lastCells(id).length && first.length && !shares(first, lastCells(id)));
      if (away) issues.push({ kind: 'jump', id: a.id, other: away, text: `it doesn't start where ${nameOf(away)} ends, so the droplet would jump` });
    }

    // Who carries on with whose droplet: B follows A (linked), or starts on one of A's last
    // electrodes no earlier than A's last frame. Their droplets are the same, so they may touch.
    const ran = runnable.filter((a) => spans.has(a.id));
    const takesOver = (a, b) => spans.get(b.id).from >= spans.get(a.id).to && shares(firstCells(b.id), lastCells(a.id));
    const links = new Set();
    const key = (x, y) => (x < y ? `${x}|${y}` : `${y}|${x}`);
    for (const b of ran) {
      for (const id of predsOf(b) || []) links.add(key(id, b.id));
      for (const a of ran) if (a !== b && takesOver(a, b)) links.add(key(a.id, b.id));
    }

    // A droplet stays where its action left it until something carries on from that electrode
    // (or to the end): it can still be touched there. A dispense's reservoir electrode (its first
    // step, on again at its end) holds the liquid left in the reservoir, not a droplet: only the
    // droplet it pulled out rests.
    let end = 0;
    for (const s of spans.values()) end = Math.max(end, s.to);
    const resting = [];
    for (const a of ran) {
      const span = spans.get(a.id);
      if (span.cut) continue;
      const reservoir = a.type === 'dispense' ? firstCells(a.id) : [];
      for (const e of lastCells(a.id)) {
        if (reservoir.includes(e)) continue;
        let until = end;
        for (const b of ran) {
          const sb = spans.get(b.id);
          if (b !== a && sb.from >= span.to && firstCells(b.id).includes(e)) until = Math.min(until, sb.from - 1);
        }
        if (until > span.to) resting.push({ id: a.id, cells: [e], from: span.to + 1, to: until });
      }
    }

    // Droplets of different actions touch when they are on the same or neighbouring electrodes
    // (diagonals too) in the same frame, or a droplet moves next to where another one just was.
    const near = nearGraph(rects);
    const groups = Array.from({ length: end + 2 }, () => new Map()); // frame -> id -> droplet cells
    const add = (f, id, cells) => {
      if (!cells.length) return;
      const g = groups[f];
      g.set(id, [...(g.get(id) || []), ...cells]);
    };
    for (let f = 1; f <= end; f++) {
      for (const { id, step } of active[f]) add(f, id, dropletCells(expanded.get(id).steps[step].cells));
    }
    for (const r of resting) for (let f = r.from; f <= r.to; f++) add(f, r.id, r.cells);
    const touching = (xs, ys) => xs.some((x) => ys.some((y) => (near.get(x) ? near.get(x).has(y) : x === y)));
    // pair -> { a, b, frame, cells: { [id]: electrodes }, before: b was there the frame before }
    const touches = new Map();
    const note = (a, b, f, cellsA, cellsB, before = false) => {
      const k = key(a, b);
      if (a === b || links.has(k) || touches.has(k)) return;
      touches.set(k, { a, b, frame: f, cells: { [a]: cellsA, [b]: cellsB }, before });
    };
    for (let f = 1; f <= end; f++) {
      const now = [...groups[f]];
      for (let i = 0; i < now.length; i++) {
        for (let j = i + 1; j < now.length; j++) if (touching(now[i][1], now[j][1])) note(now[i][0], now[j][0], f, now[i][1], now[j][1]);
        // Next to where another droplet was a frame before: its electrode has only just gone off.
        for (const [id, cells] of groups[f - 1]) if (id !== now[i][0] && touching(now[i][1], cells)) note(now[i][0], id, f, now[i][1], cells, true);
      }
    }
    for (const { a, b, frame, cells, before } of touches.values()) {
      const where = { frame, cells, before };
      issues.push({ kind: 'touch', id: a, other: b, ...where, text: `its droplet touches ${nameOf(b)}'s in frame ${frame}` });
      issues.push({ kind: 'touch', id: b, other: a, ...where, text: `its droplet touches ${nameOf(a)}'s in frame ${frame}` });
    }

    // The droplets at the end: where the actions running in the last frame leave theirs, and where
    // droplets rest until then; by droplet name (an action without one goes by its own name).
    // A dispense's reservoir electrode (its first step) stays on at its end, holding the liquid
    // left in the reservoir: that isn't its droplet.
    const leftBy = new Map();
    const put = (id, all) => {
      const a = byId.get(id);
      const cells = a.type === 'dispense' ? all.filter((e) => !firstCells(id).includes(e)) : all;
      if (!cells.length) return;
      const name = a.droplet || a.name || id;
      leftBy.set(name, [...new Set([...(leftBy.get(name) || []), ...cells])].sort((x, y) => x - y));
    };
    for (const a of ran) if (spans.get(a.id).to === end && !spans.get(a.id).cut) put(a.id, lastCells(a.id));
    for (const r of resting) if (r.to === end) put(r.id, r.cells);
    const left = [...leftBy].map(([droplet, cells]) => ({ droplet, cells })).sort((x, y) => (x.droplet < y.droplet ? -1 : x.droplet > y.droplet ? 1 : 0));

    return { seq, spans, active, expanded, resting, touches: new Set(touches.keys()), left, issues, frameTime, controls: state, rates };
  }

  // A sequence (e.g. a loaded OpenDrop file) as one pattern action covering frame 1 to its last
  // frame. Its frames' own times are left out: every frame lasts the default frame time.
  function importSequence(seq, name = 'Imported') {
    const last = seq.lastFrame();
    const frames = [];
    for (let f = 1; f <= last; f++) {
      const cells = [];
      for (let e = 0; e < CELLS; e++) if (seq.get(e, f)) cells.push(e);
      frames.push(cells);
    }
    return { type: 'pattern', name, droplet: '', start: 1, frames };
  }

  // A loaded sequence's heater targets as temperature actions, one where they change (from frame
  // `first` on, starting at frame 1 + `shift`). A frame the file waits in makes its setting wait.
  function importControls(seq, { first = 1, shift = 0 } = {}) {
    const out = [];
    let before = [null, null, null];
    let open = null;
    for (let f = first; f <= seq.controls.length - 1; f++) {
      const c = seq.controls[f];
      if (c && JSON.stringify(c.targets) !== JSON.stringify(before)) {
        const targets = c.targets.map((t, i) => (t !== before[i] ? t : null));
        if (targets.some((t) => t !== null)) {
          open = { type: 'temp', name: 'Temperature', droplet: '', start: f - first + 1 + shift, targets };
          out.push(open);
        }
        before = c.targets.slice();
      }
      const hold = seq.holds.get(f);
      if (hold && open && !open.wait) Object.assign(open, { wait: true, tolerance: hold.tolerance });
    }
    return out;
  }

  return { compile, expand, importSequence, importControls, predsOf, RESERVOIR_STEPS, RESERVOIR_NAMES };
});
