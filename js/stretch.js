/* Stretches on the board: the steps of the process between two stops share one board and
 * timeline. Here: which actions a stretch has, the droplets coming into it (where the stretch
 * before left them), compiling it, and for every tile its frames, time and problems: not placed
 * yet, out of order on the board, droplets arriving differently by two ways in; and the whole
 * process laid out as one timeline along one way through it. No DOM here. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./compile.js'), require('./process.js'), require('./model.js'));
  else (root.OD = root.OD || {}).stretch = factory(root.OD.compile, root.OD.process, root.OD.model);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (compiler, processes, model) {
  'use strict';

  const { compile } = compiler;
  const { graph, backLinks, stretches, linkKey, isStop, hasWork, exitsOf, conditionText, KINDS } = processes;

  // Droplets as arrivals: actions of type 'arrive' that can be linked to by id ("in:Droplet 1").
  const arrivals = (state) => state.map((d) => ({ id: `in:${d.droplet}`, type: 'arrive', name: `${d.droplet} arriving`, droplet: d.droplet, cells: d.cells.slice(), start: 1 }));

  // The part of a project a stretch shows: its tiles' actions.
  function stretchProject(doc, tiles) {
    const set = tiles instanceof Set ? tiles : new Set(tiles);
    return { ...doc, actions: doc.actions.filter((a) => set.has(a.tile)) };
  }

  const sameState = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const describe = (state) => (state.length ? state.map((d) => `${d.droplet} on ${d.cells.join(', ')}`).join('; ') : 'no droplets');

  // Everything about the process on the board: { g, back, st, stretch: Map(stretch id -> { tiles,
  // state, compiled }), tile: Map(tile id -> { stretch, from, to, ms, placed, problems, droplets }) }.
  // `state` is what comes into a stretch the first way a run gets there (not round a loop).
  function analyze(doc, rects) {
    const process = doc.process;
    const g = graph(process);
    const back = backLinks(process, g);
    const st = stretches(process, g, back);
    const byStretch = new Map();
    const making = new Set();

    const stateInto = (tileId) => {
      const ins = g.into.get(tileId).filter((l) => !back.has(linkKey(l)));
      return ins.length ? stateOutOf(ins[0].from) : [];
    };
    function stateOutOf(tileId) {
      const t = g.byId.get(tileId);
      if (isStop(t)) return t.kind === 'start' ? [] : stateInto(tileId);
      const info = stretchInfo(st.of.get(tileId));
      return info ? info.compiled.left : [];
    }
    // The heaters and magnets coming in, the same way (the first way in, not round a loop).
    const controlsInto = (tileId) => {
      const ins = g.into.get(tileId).filter((l) => !back.has(linkKey(l)));
      return ins.length ? controlsOutOf(ins[0].from) : null;
    };
    function controlsOutOf(tileId) {
      const t = g.byId.get(tileId);
      if (isStop(t)) return t.kind === 'start' ? null : controlsInto(tileId);
      const info = stretchInfo(st.of.get(tileId));
      return info ? info.compiled.controls : null;
    }
    function stretchInfo(sid) {
      if (byStretch.has(sid)) return byStretch.get(sid);
      if (making.has(sid)) return null; // going round: no answer this way
      making.add(sid);
      const s = st.list.find((x) => x.id === sid);
      const state = stateInto(s.start);
      const controls = controlsInto(s.start);
      const compiled = compile(stretchProject(doc, s.tiles), rects, { arrive: arrivals(state), controls });
      const info = { id: sid, tiles: s.tiles, start: s.start, state, controls, compiled, problems: [] };
      byStretch.set(sid, info);
      making.delete(sid);
      return info;
    }
    for (const s of st.list) stretchInfo(s.id);

    // Every way into a stretch should bring the droplets to the same places.
    for (const info of byStretch.values()) {
      for (const l of g.into.get(info.start)) {
        const other = stateOutOf(l.from);
        if (!sameState(other, info.state)) {
          const from = g.byId.get(l.from);
          info.problems.push(`Coming from “${from.name || KINDS[from.kind].name}”, the droplets are elsewhere: ${describe(other)} instead of ${describe(info.state)}`);
        }
      }
    }

    // Each tile: its frames on its stretch's timeline, its time, whether anything of it is placed.
    const byTile = new Map();
    for (const t of process.tiles) {
      const sid = st.of.get(t.id);
      const info = sid ? byStretch.get(sid) : null;
      // droplets: the names of the droplets its actions move (an unplaced Dispense: the one it will make).
      const mine = doc.actions.filter((a) => a.tile === t.id);
      const droplets = [...new Set(mine.map((a) => a.droplet).filter(Boolean))];
      if (!mine.length && t.kind === 'dispense' && t.droplet) droplets.push(t.droplet);
      const entry = { stretch: sid || null, from: 0, to: 0, ms: 0, placed: false, problems: [], droplets };
      if (info) {
        const spans = doc.actions.filter((a) => a.tile === t.id).map((a) => info.compiled.spans.get(a.id)).filter(Boolean);
        entry.placed = doc.actions.some((a) => a.tile === t.id);
        if (spans.length) {
          entry.from = Math.min(...spans.map((x) => x.from));
          entry.to = Math.max(...spans.map((x) => x.to));
          const seq = info.compiled.seq;
          entry.ms = seq.elapsed(entry.to) - seq.elapsed(entry.from - 1);
        }
        const ids = new Set(doc.actions.filter((a) => a.tile === t.id).map((a) => a.id));
        for (const i of info.compiled.issues) if (ids.has(i.id) && i.kind !== 'waits') entry.problems.push(i.text);
        if (info.start === t.id) entry.problems.push(...info.problems);
      }
      byTile.set(t.id, entry);
    }

    // The board's order against the process's: a tile shouldn't start before the tiles leading to
    // it have ended.
    for (const t of process.tiles) {
      const me = byTile.get(t.id);
      if (!me.stretch || !me.from) continue;
      for (const p of before(t.id)) {
        const them = byTile.get(p);
        if (them.to && them.stretch === me.stretch && me.from < them.to) {
          me.problems.push(`On the board it starts in frame ${me.from}, before “${g.byId.get(p).name}” ends (frame ${them.to})`);
        }
      }
    }
    function before(id) {
      const out = [];
      const seen = new Set();
      const walk = (tid) => {
        for (const l of g.into.get(tid)) {
          if (back.has(linkKey(l)) || seen.has(l.from)) continue;
          seen.add(l.from);
          const x = g.byId.get(l.from);
          if (st.of.get(x.id) !== st.of.get(id)) continue;
          if (hasWork(x) && byTile.get(x.id).placed) out.push(x.id);
          else walk(x.id);
        }
      };
      walk(id);
      return out;
    }

    return { g, back, st, stretch: byStretch, tile: byTile, before };
  }

  // --- the whole process as one timeline ------------------------------------------------------

  const MAX_STOPS = 500; // stops along the way before it counts as going round for ever
  const tileName = (t) => t.name || KINDS[t.kind].name;

  // The project's process laid out along one way from Start to End, as a run would go if every
  // decision went on instead of back (a loop that waits for an answer is shown once; where both
  // ways go on, "yes") and every Repeat ran its rounds. Each stretch on the way is compiled with
  // the droplets, heaters and magnets the one before it left, and their frames are put one after
  // another. Returns { project, compiled, parts, ended }:
  //   project: the actions along the way (ids "<visit>:<id>", `visit` and `of`: the real id), for
  //     showing (nothing here is to be changed);
  //   compiled: like compile()'s, over the whole way;
  //   parts: in order, { kind: 'stretch', visit, stretch, tile, tiles, from, to, state, controls }
  //     (to = from - 1 if nothing of it is placed; state and controls: the droplets, heaters and
  //     magnets coming in) and { kind: 'stop', tile, frame, text } (between frame and frame + 1;
  //     kind 'end' for the End tile);
  //   ended: 'end', 'stuck' (an arrow goes nowhere, or there is no Start) or 'cut' (too long).
  function route(doc, rects) {
    const process = doc.process;
    const g = graph(process);
    const back = backLinks(process, g);
    const st = stretches(process, g, back);
    const seq = new model.Sequence();
    seq.frameTime = doc.frameTime || seq.frameTime;
    const actions = [];
    const spans = new Map();
    const expanded = new Map();
    const active = [];
    const issues = [];
    const resting = [];
    const parts = [];
    let droplets = [];
    let controls = null;
    let offset = 0;
    let rates = null;
    let ended = 'end';
    const rounds = new Map(); // repeat tile -> rounds left
    const cache = new Map(); // stretch + what comes in -> compiled
    const pid = (v, id) => `${v}:${id}`;

    const stop = (t, text, kind = 'stop') => parts.push({ kind, tile: t.id, frame: offset, text });
    const port = (id, name) => {
      const l = g.out.get(id).find((x) => x.port === name);
      return l ? l.to : null;
    };

    let at = (process.tiles.find((t) => t.kind === 'start') || {}).id;
    if (!at) ended = 'stuck';
    let visit = 0;
    for (let steps = 0; at; steps++) {
      if (steps > MAX_STOPS) {
        ended = 'cut';
        break;
      }
      const t = g.byId.get(at);
      let next = null;
      if (t.kind === 'start') next = port(t.id, 'next');
      else if (t.kind === 'end') {
        stop(t, tileName(t), 'end');
        break;
      } else if (t.kind === 'measure' || t.kind === 'ask') {
        stop(t, `${tileName(t)}${t.value ? `: ${t.value}` : ''}`);
        next = port(t.id, 'next');
      } else if (t.kind === 'decision') {
        // On, rather than back round a loop; "yes" where both go on.
        const ways = ['yes', 'no'].map((name) => g.out.get(t.id).find((l) => l.port === name)).filter(Boolean);
        const pick = ways.find((l) => !back.has(linkKey(l))) || ways[0];
        if (pick) {
          stop(t, `${conditionText(t, process)}: ${pick.port}`);
          next = pick.to;
        }
      } else if (t.kind === 'repeat') {
        const times = Math.max(1, Number(t.times) || 1);
        const left = rounds.has(t.id) ? rounds.get(t.id) : times;
        if (left > 0) {
          rounds.set(t.id, left - 1);
          stop(t, `${tileName(t)}: round ${times - left + 1} of ${times}`);
          next = port(t.id, 'again');
        } else {
          rounds.delete(t.id);
          next = port(t.id, 'done');
        }
      } else {
        // A stretch: its frames after the ones before.
        const sid = st.of.get(t.id);
        const s = st.list.find((x) => x.id === sid);
        const key = JSON.stringify([sid, droplets, controls]);
        if (!cache.has(key)) cache.set(key, compile(stretchProject(doc, s.tiles), rects, { arrive: arrivals(droplets), controls }));
        const c = cache.get(key);
        const mine = doc.actions.filter((a) => s.tiles.includes(a.tile));
        const length = Math.max(0, ...mine.map((a) => (c.spans.get(a.id) || { to: 0 }).to));
        if (offset + length > model.MAX_FRAMES) {
          ended = 'cut';
          break;
        }
        visit++;
        rates = c.rates;
        for (let f = 1; f <= length; f++) {
          const F = offset + f;
          seq.grow(F);
          seq.frames[F].set(c.seq.cells(f));
          if (c.seq.times[f]) seq.setTime(F, c.seq.times[f]);
          if (c.seq.controls[f]) seq.controls[F] = c.seq.controls[f];
          active[F] = (c.active[f] || []).map((x) => ({ ...x, id: pid(visit, x.id) }));
        }
        for (const [f, h] of c.seq.holds) if (f <= length) seq.holds.set(offset + f, h);
        for (const a of mine) {
          const id = pid(visit, a.id);
          const after = a.after === undefined ? undefined : Array.isArray(a.after) ? a.after.map((x) => pid(visit, x)) : pid(visit, a.after);
          actions.push({ ...a, id, of: a.id, visit, ...(after === undefined ? {} : { after }) });
          const span = c.spans.get(a.id);
          if (span) spans.set(id, { from: span.from + offset, to: span.to + offset });
          if (c.expanded.has(a.id)) expanded.set(id, c.expanded.get(a.id));
        }
        // Droplets left lying (rings on the board), with the droplet's name for their colour.
        const named = new Map([...arrivals(droplets), ...mine].map((a) => [a.id, a.droplet]));
        for (const r of c.resting) {
          if (r.from > length) continue;
          resting.push({ id: pid(visit, r.id), droplet: named.get(r.id) || '', cells: r.cells, from: r.from + offset, to: Math.min(r.to, length) + offset });
        }
        for (const i of c.issues) issues.push({ ...i, id: i.id ? pid(visit, i.id) : i.id });
        parts.push({ kind: 'stretch', visit, stretch: sid, tile: s.start, tiles: s.tiles, from: offset + 1, to: offset + length, state: droplets, controls });
        offset += length;
        droplets = c.left;
        controls = c.controls;
        const exits = exitsOf(s, g);
        next = exits.length ? exits[0].to : null;
      }
      if (!next) {
        ended = 'stuck';
        break;
      }
      at = next;
    }
    seq.end = offset;
    const project = { ...doc, actions };
    delete project.process;
    const compiled = {
      seq, spans, active, expanded, resting, touches: new Set(), left: droplets, issues,
      frameTime: seq.frameTime, controls: controls || null, rates,
    };
    return { project, compiled, parts, ended };
  }

  return { arrivals, stretchProject, analyze, sameState, describe, route };
});
