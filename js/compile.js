/* Turns a project's actions into frames: the 200 x 144 on/off table and frame times that the
 * OpenDrop file format holds. Nothing else in the project is frames; this runs again after every
 * change, and on export. No DOM here. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./model.js'), require('./paths.js'), require('./templates.js'), require('./lines.js'));
  } else {
    (root.OD = root.OD || {}).compile = factory(root.OD.model, root.OD.paths, root.OD.templates, root.OD.lines);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (model, paths, templates, lines) {
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

  const ownTime = (action, k) => (Array.isArray(action.times) && action.times[k] > 0 ? action.times[k] : 0);

  // One action as steps { cells, time } (time 0 = the action's step time or the default), or
  // { error } if it can't be shown. Paths also return `built` (their electrodes and point steps).
  // A wait on a path's point comes on top of its step there: the droplet arrives, then stays
  // that much longer, so a wait always holds it up, however long a step is.
  function expand(action, project, ctx) {
    switch (action.type) {
      case 'path': {
        const built = lines.build(ctx.graph, action.points);
        if (built.error) return { error: built.error };
        const waits = new Map();
        action.points.forEach((p, i) => {
          if (p.wait > 0) waits.set(built.steps[i], Math.max(waits.get(built.steps[i]) || 0, p.wait));
        });
        const step = action.stepTime || (project && project.frameTime) || DEFAULT_FRAME_TIME;
        return { steps: built.cells.map((e, k) => ({ cells: [e], time: waits.has(k) ? step + waits.get(k) : 0 })), built };
      }
      case 'template': {
        const def = project.templates && project.templates[action.template];
        if (!def) return { error: `its template (${action.template}) is missing from the file` };
        const spot = templates.place(def, action.turns || 0, action.at, 1, ctx.rects);
        if (!spot.fits) return { error: "it doesn't fit there: part of it would be off the array" };
        return { steps: spot.frames.map((cells, k) => ({ cells, time: ownTime(action, k) })) };
      }
      case 'dispense': {
        const list = RESERVOIR_STEPS[action.reservoir];
        if (!list) return { error: `there is no reservoir called ${action.reservoir}` };
        if (list.some((cells) => cells.some((e) => !ctx.graph.centres.has(e)))) {
          return { error: 'this layout has no such reservoir' };
        }
        return { steps: list.map((cells, k) => ({ cells: cells.slice(), time: ownTime(action, k) })) };
      }
      case 'pattern':
        return { steps: action.frames.map((cells, k) => ({ cells: cells.slice(), time: ownTime(action, k) })) };
      default:
        return { error: `this version can't show “${action.type}” actions (kept in the file)`, unknown: true };
    }
  }

  // The actions an action waits for: `after` is one id or a list of them (it starts when they
  // have all ended). null for a fixed start.
  const predsOf = (a) => (a.after === undefined || a.after === null ? null : Array.isArray(a.after) ? a.after : [a.after]);

  // The frames of a project for a layout's rectangles:
  //   seq      the frames and frame times (a Sequence, as saved in OpenDrop files)
  //   spans    action id -> { from, to } frames (cut: it ran past frame 200)
  //   active   active[f] = [{ id, step }] for the actions running in frame f
  //   expanded action id -> what expand() returned
  //   resting  [{ id, cells, from, to }]: droplets left where an action ended, until picked up
  //   touches  Set of 'id|id' pairs of actions whose droplets touch
  //   issues   [{ kind, id, text, ... }]; kinds: invalid, unknown, link, cut, jump, touch, waits
  // Actions start at their `start` frame, or in the last frame of the action(s) they follow
  // (+ delay): the droplet is handed over in that frame. A frame lasts as long as the longest step
  // of the actions in it. A `split` action doesn't hold the others up: its long steps stretch over
  // as many frames as the others take, each step lasting at least its own time.
  function compile(project, rects) {
    const ctx = lines.context(rects);
    const frameTime = project.frameTime || DEFAULT_FRAME_TIME;
    const seq = new Sequence();
    seq.frameTime = frameTime;
    const issues = [];
    const spans = new Map();
    const active = Array.from({ length: MAX_FRAMES + 1 }, () => []);
    const expanded = new Map();
    const actions = project.actions;
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

    const stepTime = (r) => r.steps[r.k].time || r.a.stepTime || frameTime;
    const started = new Set();
    const scheduled = new Map(); // frame -> followers starting there after a delay
    let running = [];
    const begin = (a, f) => {
      if (started.has(a.id)) return null;
      started.add(a.id);
      const r = { a, steps: expanded.get(a.id).steps, k: 0, from: f, remaining: 0 };
      r.remaining = stepTime(r);
      running.push(r);
      return r;
    };

    for (let f = 1; f <= MAX_FRAMES; f++) {
      for (const a of starts.get(f) || []) begin(a, f);
      for (const a of scheduled.get(f) || []) begin(a, f);
      if (!running.length) continue;

      let time = 0;
      let by = null; // the non-split action whose step sets the frame time
      for (const r of running) {
        if (r.a.split) continue;
        const t = stepTime(r);
        if (t > time) {
          time = t;
          by = r;
        }
      }
      if (!by) time = Math.min(...running.map((r) => r.remaining));

      // Actions that end in this frame start their followers here too (once all that a follower
      // waits for have ended); those can only make the frame longer, which may end more split
      // actions.
      const ended = new Set();
      for (let more = true; more; ) {
        more = false;
        for (const r of running.slice()) {
          if (ended.has(r) || r.k !== r.steps.length - 1 || (r.a.split && r.remaining > time)) continue;
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
            if (n && !n.a.split && stepTime(n) > time) {
              time = stepTime(n);
              by = n;
            }
          }
        }
      }

      for (const r of running) {
        for (const e of r.steps[r.k].cells) if (e >= 0 && e < CELLS) seq.set(e, f, true);
        active[f].push({ id: r.a.id, step: r.k });
      }
      seq.setTime(f, time === frameTime ? 0 : time);

      // Actions held up by a longer step: not split, not on their last step (arrived), and with a
      // shorter step of their own.
      if (by) {
        const held = running.filter((r) => r !== by && !r.a.split && r.k < r.steps.length - 1 && stepTime(r) < time);
        if (held.length) issues.push({ kind: 'waits', id: by.a.id, frame: f, time, ids: held.map((r) => r.a.id) });
      }

      const next = [];
      for (const r of running) {
        if (r.a.split) {
          r.remaining -= time;
          if (r.remaining > 0) {
            next.push(r);
            continue;
          }
        }
        r.k++;
        if (r.k >= r.steps.length) {
          spans.set(r.a.id, { from: r.from, to: f });
          continue;
        }
        if (r.a.split) r.remaining = stepTime(r);
        next.push(r);
      }
      running = next;
    }

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
    // (or to the end): it can still be touched there.
    let end = 0;
    for (const s of spans.values()) end = Math.max(end, s.to);
    const resting = [];
    for (const a of ran) {
      const span = spans.get(a.id);
      if (span.cut) continue;
      for (const e of lastCells(a.id)) {
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
    const touches = new Map(); // pair -> { a, b, frame }
    const note = (a, b, f) => {
      const k = key(a, b);
      if (a === b || links.has(k) || touches.has(k)) return;
      touches.set(k, { a, b, frame: f });
    };
    for (let f = 1; f <= end; f++) {
      const now = [...groups[f]];
      for (let i = 0; i < now.length; i++) {
        for (let j = i + 1; j < now.length; j++) if (touching(now[i][1], now[j][1])) note(now[i][0], now[j][0], f);
        for (const [id, cells] of groups[f - 1]) if (id !== now[i][0] && touching(now[i][1], cells)) note(now[i][0], id, f);
      }
    }
    for (const { a, b, frame } of touches.values()) {
      issues.push({ kind: 'touch', id: a, other: b, frame, text: `its droplet touches ${nameOf(b)}'s in frame ${frame}` });
      issues.push({ kind: 'touch', id: b, other: a, frame, text: `its droplet touches ${nameOf(a)}'s in frame ${frame}` });
    }

    return { seq, spans, active, expanded, resting, touches: new Set(touches.keys()), issues, frameTime };
  }

  // A sequence (e.g. a loaded OpenDrop file) as one pattern action covering frame 1 to its last
  // frame, with its frames' own times. Compiling it gives the same frames and times back.
  function importSequence(seq, name = 'Imported') {
    const last = seq.lastFrame();
    const frames = [];
    const times = [];
    for (let f = 1; f <= last; f++) {
      const cells = [];
      for (let e = 0; e < CELLS; e++) if (seq.get(e, f)) cells.push(e);
      frames.push(cells);
      times.push(seq.times[f] || 0);
    }
    const action = { type: 'pattern', name, droplet: '', start: 1, frames };
    if (times.some(Boolean)) action.times = times;
    return action;
  }

  return { compile, expand, importSequence, predsOf, RESERVOIR_STEPS, RESERVOIR_NAMES };
});
