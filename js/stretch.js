/* Stretches on the board: the steps of the process between two stops share one board and
 * timeline. Here: which actions a stretch has, the droplets coming into it (where the stretch
 * before left them), compiling it, and for every tile its frames, time and problems: not placed
 * yet, out of order on the board, droplets arriving differently by two ways in. No DOM here. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./compile.js'), require('./process.js'));
  else (root.OD = root.OD || {}).stretch = factory(root.OD.compile, root.OD.process);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (compiler, processes) {
  'use strict';

  const { compile } = compiler;
  const { graph, backLinks, stretches, linkKey, isStop, hasWork, KINDS } = processes;

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

  return { arrivals, stretchProject, analyze, sameState, describe };
});
