/* Turns a project's actions into frames: the 200 x 144 on/off table and frame times that the
 * OpenDrop file format holds. Nothing else in the project is frames; this runs again after every
 * change, and on export. No DOM here. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./model.js'), require('./templates.js'), require('./lines.js'));
  } else {
    (root.OD = root.OD || {}).compile = factory(root.OD.model, root.OD.templates, root.OD.lines);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (model, templates, lines) {
  'use strict';

  const { CELLS, MAX_FRAMES, DEFAULT_FRAME_TIME, Sequence } = model;

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
  function expand(action, project, ctx) {
    switch (action.type) {
      case 'path': {
        const built = lines.build(ctx.graph, action.points);
        if (built.error) return { error: built.error };
        const waits = new Map();
        action.points.forEach((p, i) => {
          if (p.wait > 0) waits.set(built.steps[i], Math.max(waits.get(built.steps[i]) || 0, p.wait));
        });
        return { steps: built.cells.map((e, k) => ({ cells: [e], time: waits.get(k) || 0 })), built };
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

  // The frames of a project for a layout's rectangles:
  //   seq      the frames and frame times (a Sequence, as saved in OpenDrop files)
  //   spans    action id -> { from, to } frames (cut: it ran past frame 200)
  //   active   active[f] = [{ id, step }] for the actions running in frame f
  //   expanded action id -> what expand() returned
  //   issues   [{ kind, id, text, frame?, ids?, time? }]; kinds: invalid, unknown, link, cut, jump, waits
  // Actions start at their `start` frame, or in the last frame of the action they follow (+ delay):
  // the droplet is handed over in that frame. A frame lasts as long as the longest step of the
  // actions in it. A `split` action doesn't hold the others up: its long steps stretch over as many
  // frames as the others take, each step lasting at least its own time.
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
    for (const a of runnable) {
      if (a.after === undefined || a.after === null) push(starts, a.start || 1, a);
      else if (typeof a.after !== 'string') issues.push({ kind: 'unknown', id: a.id, text: "this version can't start an action after several others" });
      else if (!byId.has(a.after)) issues.push({ kind: 'link', id: a.id, text: `it follows an action that isn't there (${a.after})` });
      else push(followers, a.after, a);
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

      // Actions that end in this frame start their followers here too; those can only make the
      // frame longer, which may end more split actions.
      const ended = new Set();
      for (let more = true; more; ) {
        more = false;
        for (const r of running.slice()) {
          if (ended.has(r) || r.k !== r.steps.length - 1 || (r.a.split && r.remaining > time)) continue;
          ended.add(r);
          more = true;
          for (const s of followers.get(r.a.id) || []) {
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
        const waiting = running.filter((r) => r !== by && !r.a.split && r.k < r.steps.length - 1 && stepTime(r) < time);
        if (waiting.length) issues.push({ kind: 'waits', id: by.a.id, frame: f, time, ids: waiting.map((r) => r.a.id) });
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
      if (started.has(a.id) || typeof a.after !== 'string' || !byId.has(a.after)) continue; // the last two: reported above
      const late = [...scheduled].some(([f, list]) => f > MAX_FRAMES && list.includes(a));
      if (late) issues.push({ kind: 'cut', id: a.id, text: `it would start after frame ${MAX_FRAMES}` });
      else if (!started.has(a.after)) issues.push({ kind: 'link', id: a.id, text: `it follows ${nameOf(a.after)}, which doesn't run` });
      else issues.push({ kind: 'link', id: a.id, text: `it follows ${nameOf(a.after)}, which never ends` });
    }

    // A follower should start where the action before it ends: otherwise its droplet would jump.
    for (const a of runnable) {
      if (typeof a.after !== 'string' || a.type === 'dispense' || !spans.has(a.id) || !spans.has(a.after)) continue;
      const prev = expanded.get(a.after).steps;
      const lastCells = prev[prev.length - 1].cells;
      const firstCells = expanded.get(a.id).steps[0].cells;
      if (lastCells.length && firstCells.length && !firstCells.some((e) => lastCells.includes(e))) {
        issues.push({ kind: 'jump', id: a.id, text: `it doesn't start where ${nameOf(a.after)} ends, so the droplet would jump` });
      }
    }

    return { seq, spans, active, expanded, issues, frameTime };
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

  return { compile, expand, importSequence, RESERVOIR_STEPS, RESERVOIR_NAMES };
});
