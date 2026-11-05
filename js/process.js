/* The process: a top-down tree of tiles joined by arrows, for designing what happens before
 * placing it on the board. Tiles are steps that have work on the board (a step, a dispense, a
 * move, a mix, a merge, a split, a wait), stops where a run waits or chooses (start, end, measure,
 * ask, decision, repeat), and parallel/join, which split the way into lanes that run at the same
 * time and end them again (a merge can end lanes too: one per droplet it puts together). Arrows
 * go from a tile's output port to another tile; one going back up is a
 * loop. A run goes through the process stretch by stretch: a stretch is the steps between two
 * stops, and has one board and timeline. No DOM here. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else (root.OD = root.OD || {}).process = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // What each kind of tile is: its name, what it does in a sentence (tooltips and Properties show
  // it), its output ports, whether it has work on the board, and whether it is a stop (where a
  // stretch ends: the run waits, asks or chooses there). The ids stay as they are in files: a
  // 'join' is shown as "Wait for all".
  const KINDS = {
    start: { name: 'Start', about: 'Where a run begins.', ports: ['next'], stop: true, input: false },
    end: { name: 'End', about: 'Where a run finishes.', ports: [], stop: true },
    step: { name: 'Step', about: 'Any work you draw on the board yourself: paths, holds, templates.', ports: ['next'], work: true },
    dispense: { name: 'Dispense', about: 'Pulls a new droplet out of a reservoir.', ports: ['next'], work: true },
    move: { name: 'Move', about: 'Moves a droplet along a path you draw.', ports: ['next'], work: true },
    mix: { name: 'Mix', about: 'Mixes one droplet in place (circle, back and forth, split & merge).', ports: ['next'], work: true },
    merge: { name: 'Merge', about: 'Two droplets become one: their lanes end here.', ports: ['next'], work: true },
    split: { name: 'Split', about: 'One droplet becomes two.', ports: ['next'], work: true },
    wait: { name: 'Wait', about: 'Holds the droplets where they are for a set time.', ports: ['next'], work: true },
    measure: { name: 'Measure', about: 'The run stops and asks you for a measured value.', ports: ['next'], stop: true },
    ask: { name: 'Ask', about: 'The run stops and asks you a question: yes or no, or a number.', ports: ['next'], stop: true },
    decision: { name: 'Decision', about: 'Goes the yes or the no way, by a measured or asked value.', ports: ['yes', 'no'], stop: true },
    repeat: { name: 'Repeat', about: 'Goes round what follows “again” a number of times, then on by “done”.', ports: ['again', 'done'], stop: true },
    parallel: { name: 'Parallel', about: 'Splits the way into lanes that run at the same time, on one board.', ports: null },
    join: { name: 'Wait for all', about: 'Waits until every lane has finished; the droplets stay apart.', ports: ['next'] },
  };
  // How they are listed in the palette, in groups.
  const PALETTE_GROUPS = [
    { name: 'On the board', kinds: ['step', 'dispense', 'move', 'mix', 'merge', 'split', 'wait'] },
    { name: 'Measure and decide', kinds: ['measure', 'ask', 'decision', 'repeat'] },
    { name: 'Lanes', kinds: ['parallel', 'join'] },
    { name: 'Start and end', kinds: ['start', 'end'] },
  ];
  const PALETTE = PALETTE_GROUPS.flatMap((group) => group.kinds);
  const OPS = { '<': '<', '<=': '≤', '>': '>', '>=': '≥', '=': '=', '!=': '≠', is: 'is' };
  const MAX_LANES = 6;

  // A tile's size on the canvas, [width, height] in units; x and y are its centre.
  const SIZE = { start: [120, 40], end: [120, 40], decision: [190, 84], repeat: [170, 52], parallel: [230, 20], join: [230, 20] };
  const sizeOf = (t) => (SIZE[t.kind] || [210, 60]).slice();

  const isTile = (t) => Boolean(t && typeof t === 'object' && KINDS[t.kind] && typeof t.id === 'string');
  const lanesOf = (t) => Math.min(MAX_LANES, Math.max(2, Number.isInteger(t.lanes) ? t.lanes : 2));
  const portsOf = (t) => (t.kind === 'parallel' ? Array.from({ length: lanesOf(t) }, (_, i) => `lane${i + 1}`) : KINDS[t.kind].ports);
  const isStop = (t) => Boolean(KINDS[t.kind].stop);
  const hasWork = (t) => Boolean(KINDS[t.kind].work);
  const takesInput = (t) => KINDS[t.kind].input !== false;
  const portName = (port) => (/^lane\d+$/.test(port) ? `lane ${port.slice(4)}` : port);
  // Tiles where lanes end and that wait for all of them: a join, and a merge (one lane per droplet).
  const endsLanes = (t) => t.kind === 'join' || t.kind === 'merge';

  // How many input points a tile shows: none on Start; on a merge or join one per arrow coming in
  // (counted in `process` when given), and at least two; one on everything else.
  function inputsOf(tile, process = null) {
    if (!takesInput(tile)) return 0;
    if (!endsLanes(tile)) return 1;
    const arrows = process ? process.links.filter((l) => l.to === tile.id).length : 0;
    return Math.max(2, arrows);
  }

  function emptyProcess() {
    return { tiles: [], links: [] };
  }

  // --- tiles and arrows -------------------------------------------------------------------------

  const tileById = (process, id) => process.tiles.find((t) => t.id === id) || null;

  function nextTileId(process) {
    let n = 0;
    for (const t of process.tiles) {
      const m = /^p(\d+)$/.exec(t.id);
      if (m) n = Math.max(n, Number(m[1]));
    }
    return `p${n + 1}`;
  }

  // Settings a new tile of each kind starts with.
  function defaults(kind, process) {
    const count = (k) => process.tiles.filter((t) => t.kind === k).length + 1;
    switch (kind) {
      case 'step':
        return { name: `Step ${count('step')}` };
      case 'dispense':
        return { name: 'Dispense', reservoir: 'reservoirLeftTop' };
      case 'mix':
        return { name: 'Mix', params: { kind: 'circle', size: 2, rounds: 3 } };
      case 'wait':
        return { name: 'Wait', seconds: 60 };
      case 'measure': {
        const used = new Set(process.tiles.map((t) => t.value));
        let value = 'conc';
        for (let i = 2; used.has(value); i++) value = `value${i}`;
        return { name: 'Measure', value, unit: '' };
      }
      case 'ask':
        return { name: 'Ask', question: 'Go on?', answer: 'yesno', value: 'ok' };
      case 'decision': {
        const measured = process.tiles.filter((t) => (t.kind === 'measure' || t.kind === 'ask') && t.value);
        const last = measured[measured.length - 1];
        if (last && last.kind === 'ask' && last.answer === 'yesno') return { value: last.value, op: 'is', than: 'yes' };
        return { value: last ? last.value : '', op: '<', than: 0 };
      }
      case 'repeat':
        return { name: 'Repeat', times: 3 };
      case 'parallel':
        return { lanes: 2 };
      default:
        return { name: KINDS[kind].name };
    }
  }

  function addTile(process, kind, x = 0, y = 0, fields = {}) {
    if (!KINDS[kind]) throw new Error(`no tile kind ${kind}`);
    const tile = { id: nextTileId(process), kind, ...defaults(kind, process), x: Math.round(x), y: Math.round(y), ...fields };
    process.tiles.push(tile);
    return tile;
  }

  function moveTile(process, id, x, y) {
    const t = tileById(process, id);
    if (!t) return false;
    t.x = Math.round(x);
    t.y = Math.round(y);
    return true;
  }

  // A tile goes, with its arrows.
  function removeTile(process, id) {
    const before = process.tiles.length;
    process.tiles = process.tiles.filter((t) => t.id !== id);
    process.links = process.links.filter((l) => l.from !== id && l.to !== id);
    return process.tiles.length < before;
  }

  // An arrow from `from`'s output `port` to `to`: one per output port, so it replaces the arrow
  // that port had. Returns a reason if it can't be made.
  function link(process, from, port, to) {
    const a = tileById(process, from);
    const b = tileById(process, to);
    if (!a || !b) return "that tile isn't there";
    if (!portsOf(a).includes(port)) return `${KINDS[a.kind].name} has no ${portName(port)} output`;
    if (from === to) return 'a tile can’t lead to itself';
    if (!takesInput(b)) return 'nothing leads into Start';
    process.links = process.links.filter((l) => !(l.from === from && l.port === port));
    process.links.push({ from, port, to });
    return null;
  }

  function unlink(process, from, port) {
    const before = process.links.length;
    process.links = process.links.filter((l) => !(l.from === from && l.port === port));
    return process.links.length < before;
  }

  // The number of lanes of a parallel tile; arrows from lanes that go are dropped.
  function setLanes(process, id, n) {
    const t = tileById(process, id);
    if (!t || t.kind !== 'parallel') return false;
    t.lanes = Math.min(MAX_LANES, Math.max(2, Math.round(n)));
    const ports = portsOf(t);
    process.links = process.links.filter((l) => l.from !== id || ports.includes(l.port));
    return true;
  }

  // --- the shape of it -----------------------------------------------------------------------------

  // Arrows in and out of every tile, in the order the tiles' ports list them.
  function graph(process) {
    const byId = new Map(process.tiles.map((t) => [t.id, t]));
    const out = new Map(process.tiles.map((t) => [t.id, []]));
    const into = new Map(process.tiles.map((t) => [t.id, []]));
    for (const t of process.tiles) {
      for (const port of portsOf(t)) {
        const l = process.links.find((x) => x.from === t.id && x.port === port);
        if (l && byId.has(l.to)) {
          out.get(t.id).push(l);
          into.get(l.to).push(l);
        }
      }
    }
    return { byId, out, into };
  }

  const linkKey = (l) => `${l.from}|${l.port}`;

  // Arrows going back up: to a tile still being walked from (depth first from Start, then from
  // any tile not reached that way).
  function backLinks(process, g = graph(process)) {
    const back = new Set();
    const state = new Map(); // id -> 1 walking, 2 done
    const walk = (id) => {
      state.set(id, 1);
      for (const l of g.out.get(id)) {
        const s = state.get(l.to);
        if (s === 1) back.add(linkKey(l));
        else if (!s) walk(l.to);
      }
      state.set(id, 2);
    };
    for (const t of process.tiles) if (t.kind === 'start' && !state.get(t.id)) walk(t.id);
    for (const t of process.tiles) if (!state.get(t.id)) walk(t.id);
    return back;
  }

  // Stretches: the steps between two stops, each with one board and timeline. A stretch starts at
  // a step that comes after a stop, that an arrow comes back up to, that is reached from two places
  // (a join or merge only when its lanes come from different stretches), or that nothing leads
  // to. It takes in what follows without passing a stop or another stretch's start. Returns
  // { of: Map(tile id -> stretch id), list: [{ id, start, tiles }] }; a stretch's id is its first
  // tile's.
  function stretches(process, g = graph(process), back = backLinks(process, g)) {
    const starts = new Set();
    for (const t of process.tiles) {
      if (isStop(t)) continue;
      const ins = g.into.get(t.id);
      if (!ins.length || ins.some((l) => isStop(g.byId.get(l.from)) || back.has(linkKey(l)))) starts.add(t.id);
      else if (ins.length > 1 && !endsLanes(t)) starts.add(t.id);
    }
    let of = new Map();
    for (let again = true; again; ) {
      again = false;
      of = new Map();
      for (const t of process.tiles) {
        if (!starts.has(t.id)) continue;
        const queue = [t.id];
        of.set(t.id, t.id);
        for (let i = 0; i < queue.length; i++) {
          for (const l of g.out.get(queue[i])) {
            const next = g.byId.get(l.to);
            if (isStop(next) || starts.has(next.id) || of.has(next.id)) continue;
            of.set(next.id, t.id);
            queue.push(next.id);
          }
        }
      }
      for (const t of process.tiles) {
        if (!endsLanes(t) || starts.has(t.id) || isStop(t)) continue;
        const from = new Set(g.into.get(t.id).map((l) => of.get(l.from)));
        if (from.size !== 1 || from.has(undefined)) {
          starts.add(t.id);
          again = true;
        }
      }
    }
    const list = [];
    for (const t of process.tiles) if (starts.has(t.id)) list.push({ id: t.id, start: t.id, tiles: process.tiles.filter((x) => of.get(x.id) === t.id).map((x) => x.id) });
    return { of, list };
  }

  // Where a stretch leads: the arrows from its tiles to tiles outside it.
  function exitsOf(stretch, g) {
    const inside = new Set(stretch.tiles);
    const out = [];
    for (const id of stretch.tiles) for (const l of g.out.get(id)) if (!inside.has(l.to)) out.push(l);
    return out;
  }

  // --- conditions ---------------------------------------------------------------------------------

  // "conc < 5 mM", "ok is yes".
  function conditionText(tile, process = null) {
    if (!tile.value) return 'no value chosen';
    const op = OPS[tile.op] || tile.op;
    if (tile.op === 'is') return `${tile.value} is ${tile.than === 'no' ? 'no' : 'yes'}`;
    const measure = process && process.tiles.find((t) => t.kind === 'measure' && t.value === tile.value && t.unit);
    return `${tile.value} ${op} ${tile.than}${measure ? ` ${measure.unit}` : ''}`;
  }

  // Whether a decision's condition holds for `values` (undefined if its value isn't known yet).
  function evaluate(tile, values) {
    if (!tile.value || !(tile.value in values)) return undefined;
    const v = values[tile.value];
    if (tile.op === 'is') return (v === true || v === 'yes') === (tile.than !== 'no');
    const x = Number(v);
    const y = Number(tile.than);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
    switch (tile.op) {
      case '<':
        return x < y;
      case '<=':
        return x <= y;
      case '>':
        return x > y;
      case '>=':
        return x >= y;
      case '=':
        return x === y;
      case '!=':
        return x !== y;
      default:
        return undefined;
    }
  }

  // --- loops ---------------------------------------------------------------------------------------

  // Every loop: an arrow going back up, the tiles it goes round (on a way from where it goes back
  // to, to where it comes from), and its label: "repeat until conc < 5" from the decision that
  // leads out of it, "repeat 3×" for a repeat tile, or a warning if nothing leads out.
  function loops(process, g = graph(process), back = backLinks(process, g)) {
    const out = [];
    for (const t of process.tiles) {
      for (const l of g.out.get(t.id)) {
        if (!back.has(linkKey(l))) continue;
        const forward = reach(l.to, (id) => g.out.get(id).map((x) => x.to));
        const backward = reach(l.from, (id) => g.into.get(id).map((x) => x.from));
        const tiles = process.tiles.map((x) => x.id).filter((id) => forward.has(id) && backward.has(id));
        const inside = new Set(tiles);
        let label = null;
        let endless = false;
        const head = g.byId.get(l.to);
        if (head.kind === 'repeat') label = `repeat ${Math.max(1, head.times || 1)}×`;
        else {
          for (const id of tiles) {
            const x = g.byId.get(id);
            if (x.kind !== 'decision') continue;
            const ports = g.out.get(id);
            const leaving = ports.filter((p) => !inside.has(p.to));
            if (leaving.length === 1 && ports.length === 2) {
              label = leaving[0].port === 'yes' ? `repeat until ${conditionText(x, process)}` : `repeat while ${conditionText(x, process)}`;
              break;
            }
          }
          if (!label) {
            endless = !tiles.some((id) => g.out.get(id).some((p) => !inside.has(p.to)));
            label = endless ? 'repeats forever: nothing leads out' : 'repeat';
          }
        }
        out.push({ from: l.from, port: l.port, to: l.to, tiles, label, endless });
      }
    }
    return out;
  }

  function reach(id, next) {
    const seen = new Set([id]);
    const queue = [id];
    for (let i = 0; i < queue.length; i++) for (const n of next(queue[i])) if (!seen.has(n)) {
      seen.add(n);
      queue.push(n);
    }
    return seen;
  }

  // --- checks ---------------------------------------------------------------------------------------

  // What is wrong or missing: [{ tile, text, level: 'error' | 'warn' }] (tile null: the process
  // as a whole).
  function check(process) {
    const issues = [];
    const add = (tile, text, level = 'warn') => issues.push({ tile, text, level });
    const g = graph(process);
    const back = backLinks(process, g);
    const starts = process.tiles.filter((t) => t.kind === 'start');
    if (!starts.length) add(null, 'There is no Start tile', 'error');
    for (const s of starts.slice(1)) add(s.id, 'Only one Start is used: this one is extra', 'error');

    // Outputs going nowhere, tiles never reached.
    for (const t of process.tiles) {
      const used = new Set(g.out.get(t.id).map((l) => l.port));
      for (const port of portsOf(t)) {
        if (used.has(port)) continue;
        const ports = portsOf(t);
        add(t.id, ports.length > 1 ? `Its ${portName(port)} arrow goes nowhere` : 'Nothing comes after it: connect it to the next tile, or to End');
      }
    }
    const reached = starts.length ? reach(starts[0].id, (id) => g.out.get(id).map((l) => l.to)) : new Set();
    for (const t of process.tiles) if (starts.length && !reached.has(t.id)) add(t.id, 'A run never gets here: nothing leads to it from Start');

    // Values used before they are measured on some way here: what is surely known after a tile
    // is what all the ways into it know, plus what it measures.
    const all = new Set(process.tiles.filter((t) => (t.kind === 'measure' || t.kind === 'ask') && t.value).map((t) => t.value));
    const known = new Map(process.tiles.map((t) => [t.id, t.kind === 'start' ? new Set() : new Set(all)]));
    for (let changed = true, rounds = 0; changed && rounds < 100; rounds++) {
      changed = false;
      for (const t of process.tiles) {
        if (t.kind === 'start') continue;
        const ins = g.into.get(t.id);
        const inner = ins.length ? ins.map((l) => outOf(l.from)) : [new Set()];
        const next = new Set([...inner[0]].filter((v) => inner.every((s) => s.has(v))));
        const cur = known.get(t.id);
        if (next.size !== cur.size || [...next].some((v) => !cur.has(v))) {
          known.set(t.id, next);
          changed = true;
        }
      }
    }
    function outOf(id) {
      const t = g.byId.get(id);
      const s = new Set(known.get(id));
      if ((t.kind === 'measure' || t.kind === 'ask') && t.value) s.add(t.value);
      return s;
    }
    for (const t of process.tiles) {
      if (t.kind !== 'decision') continue;
      if (!t.value) add(t.id, 'Choose the value it decides by', 'error');
      else if (!all.has(t.value)) add(t.id, `No Measure or Ask tile gives ${t.value}`, 'error');
      else if (!known.get(t.id).has(t.value)) add(t.id, `${t.value} isn't measured before this on every way here: a run will ask for it`);
    }

    // Parallel lanes: they must end again, in a Wait for all or a Merge, with no stop on the way.
    for (const t of process.tiles) {
      if (t.kind !== 'parallel') continue;
      const lanes = g.out.get(t.id);
      if (lanes.length < portsOf(t).length) continue; // reported above
      let joins = 0;
      let ended = false;
      let stop = null;
      const seen = new Set();
      const walk = (id) => {
        if (seen.has(id)) return;
        seen.add(id);
        const x = g.byId.get(id);
        if (endsLanes(x)) {
          joins++;
          return;
        }
        if (x.kind === 'end') ended = true;
        else if (isStop(x)) stop = stop || x;
        if (isStop(x)) return;
        for (const l of g.out.get(id)) if (!back.has(linkKey(l))) walk(l.to);
      };
      for (const l of lanes) walk(l.to);
      if (stop) add(t.id, `${KINDS[stop.kind].name} can't be inside parallel lanes: put it after the lanes end, in a Wait for all or a Merge`, 'error');
      else if (!joins || ended) add(t.id, "Its lanes don't join again: end them in a Wait for all, or in a Merge to put their droplets together", 'error');
    }
    for (const t of process.tiles) {
      if (t.kind !== 'join') continue;
      if (g.into.get(t.id).length < 2) add(t.id, 'Only one lane comes into it');
      // A merge waits for its lanes itself.
      const next = g.out.get(t.id).map((l) => g.byId.get(l.to));
      if (next.some((x) => x.kind === 'merge')) add(t.id, "The Merge already waits for its lanes: this Wait for all isn't needed");
    }

    // A stretch leading to two places at once.
    const st = stretches(process, g, back);
    for (const s of st.list) {
      const exits = exitsOf(s, g);
      if (exits.length > 1) add(s.start, 'This part leads to two places at once: end its lanes first', 'error');
    }
    for (const lp of loops(process, g, back)) if (lp.endless) add(lp.to, 'This loop never ends: nothing leads out of it', 'error');
    return issues;
  }

  // --- layout ----------------------------------------------------------------------------------------

  const COL = 250; // a column's step for tiles added by hand (tidy measures its own)
  const ROW = 100; // ... and a row's
  const GAP_X = 40; // units between the widest tiles of two columns
  const GAP_Y = 38; // ... and between the tallest tiles of two rows
  // How far a loop's dashed outline reaches beyond its tiles (the view draws it so, its label on
  // top), and how far tidy keeps it from the tiles around it.
  const LOOP = { top: 34, bottom: 16, left: 18, right: 58, clear: 22 };

  // A tidy top-down layout: a tile goes one row below the lowest tile leading to it (arrows going
  // back up left out); a tile's later outputs (no, lane 2, ...) go to the columns on the right.
  // Each row is as tall as its tallest tile and each column as wide as its widest, with short gaps;
  // around a loop there is room for its outline. x and y are tile centres; the first tile's is 0, 0.
  function tidy(process) {
    if (!process.tiles.length) return;
    const g = graph(process);
    const back = backLinks(process, g);
    const order = [];
    const seen = new Set();
    const visit = (id) => {
      if (seen.has(id)) return;
      seen.add(id);
      for (const l of g.out.get(id)) if (!back.has(linkKey(l))) visit(l.to);
      order.push(id);
    };
    for (const t of process.tiles) if (t.kind === 'start') visit(t.id);
    for (const t of process.tiles) visit(t.id);
    order.reverse(); // a topological order of the arrows going down
    const row = new Map();
    for (const id of order) {
      const ins = g.into.get(id).filter((l) => !back.has(linkKey(l)));
      row.set(id, ins.length ? Math.max(...ins.map((l) => (row.get(l.from) || 0) + 1)) : 0);
    }
    // Columns: walk down from Start; the first output keeps the column, the others take new
    // columns to the right of everything placed so far in the rows below.
    const col = new Map();
    let right = 0;
    const place = (id, c) => {
      if (col.has(id)) return;
      col.set(id, c);
      right = Math.max(right, c);
      g.out.get(id).filter((l) => !back.has(linkKey(l))).forEach((l, i) => {
        if (col.has(l.to)) return;
        place(l.to, i === 0 ? c : right + 1);
      });
    };
    for (const id of order) if (!g.into.get(id).filter((l) => !back.has(linkKey(l))).length) place(id, col.size ? right + 1 : 0);
    for (const id of order) place(id, right + 1);

    // Sizes: the tallest tile of each row, the widest of each column.
    const heights = [];
    const widths = [];
    for (const t of process.tiles) {
      const [w, h] = sizeOf(t);
      const r = row.get(t.id);
      const c = col.get(t.id);
      heights[r] = Math.max(heights[r] || 0, h);
      widths[c] = Math.max(widths[c] || 0, w);
    }
    // Loops: the rows and columns their outlines start and end in.
    const edges = { top: new Set(), bottom: new Set(), left: new Set(), right: new Set() };
    for (const lp of loops(process, g, back)) {
      const rows = lp.tiles.map((id) => row.get(id));
      const cols = lp.tiles.map((id) => col.get(id));
      edges.top.add(Math.min(...rows));
      edges.bottom.add(Math.max(...rows));
      edges.left.add(Math.min(...cols));
      edges.right.add(Math.max(...cols));
    }
    // The gap after row or column i: the usual one, or more to fit a loop's outline before the next.
    const gap = (i, usual, end, start, endRoom, startRoom) => {
      const room = (edges[end].has(i) ? endRoom : 0) + (edges[start].has(i + 1) ? startRoom : 0);
      return room ? Math.max(usual, room + LOOP.clear) : usual;
    };
    const centres = (sizes, gapAfter) => {
      const out = [];
      let at = 0;
      for (let i = 0; i < sizes.length; i++) {
        const size = sizes[i] || 0;
        out.push(at + size / 2);
        at += size + gapAfter(i);
      }
      return out.map((x) => Math.round(x - out[0]));
    };
    const ys = centres(heights, (i) => gap(i, GAP_Y, 'bottom', 'top', LOOP.bottom, LOOP.top));
    const xs = centres(widths, (i) => gap(i, GAP_X, 'right', 'left', LOOP.right, LOOP.left));
    for (const t of process.tiles) {
      t.x = xs[col.get(t.id)];
      t.y = ys[row.get(t.id)];
    }
  }

  // --- a run -------------------------------------------------------------------------------------------

  // Going through the process. `step` says what is next: { kind: 'stretch', stretch } (play it,
  // then go()), { kind: 'ask', tile } (answer(value)), { kind: 'end' }, or { kind: 'stuck', text }.
  // Decisions and repeats are taken on the way; `log` says what happened.
  class Walk {
    constructor(process) {
      this.process = process;
      this.g = graph(process);
      this.back = backLinks(process, this.g);
      this.st = stretches(process, this.g, this.back);
      this.values = {};
      this.counts = new Map();
      this.log = [];
      this.idle = 0; // moves without playing or asking, against going round for ever
      const start = process.tiles.find((t) => t.kind === 'start');
      this.step = null;
      if (!start) this.stuck('There is no Start tile');
      else this.arrive(start.id);
    }

    stuck(text) {
      this.step = { kind: 'stuck', text };
      this.log.push({ kind: 'stuck', text });
    }

    // Following the arrow from `id`'s `port`.
    follow(id, port) {
      const l = this.g.out.get(id).find((x) => x.port === port);
      if (!l) {
        const t = this.g.byId.get(id);
        this.stuck(`${t.name || KINDS[t.kind].name}: its ${portName(port)} arrow goes nowhere`);
        return;
      }
      this.arrive(l.to);
    }

    arrive(id) {
      if (++this.idle > 1000) {
        this.stuck('The process goes round without doing anything');
        return;
      }
      const t = this.g.byId.get(id);
      this.at = id;
      switch (t.kind) {
        case 'start':
          this.log.push({ kind: 'start', tile: id });
          this.follow(id, 'next');
          return;
        case 'end':
          this.log.push({ kind: 'end', tile: id });
          this.step = { kind: 'end', tile: id };
          return;
        case 'measure':
        case 'ask':
          this.step = { kind: 'ask', tile: t };
          return;
        case 'decision': {
          const holds = evaluate(t, this.values);
          if (holds === undefined) {
            this.step = { kind: 'ask', tile: t, missing: t.value };
            return;
          }
          this.log.push({ kind: 'decision', tile: id, text: `${conditionText(t, this.process)}: ${holds ? 'yes' : 'no'}` });
          this.follow(id, holds ? 'yes' : 'no');
          return;
        }
        case 'repeat': {
          const times = Math.max(1, Number(t.times) || 1);
          const left = this.counts.has(id) ? this.counts.get(id) : times;
          if (left > 0) {
            this.counts.set(id, left - 1);
            this.log.push({ kind: 'repeat', tile: id, text: `round ${times - left + 1} of ${times}` });
            this.follow(id, 'again');
          } else {
            this.counts.delete(id);
            this.log.push({ kind: 'repeat', tile: id, text: 'done' });
            this.follow(id, 'done');
          }
          return;
        }
        default: {
          const sid = this.st.of.get(id);
          const stretch = this.st.list.find((s) => s.id === sid);
          this.idle = 0;
          this.step = { kind: 'stretch', stretch };
        }
      }
    }

    // After playing a stretch: on to where it leads.
    go() {
      if (!this.step || this.step.kind !== 'stretch') return;
      const s = this.step.stretch;
      this.log.push({ kind: 'stretch', tile: s.start });
      const exits = exitsOf(s, this.g);
      if (!exits.length) {
        this.stuck(`${this.g.byId.get(s.start).name || 'A step'}: nothing comes after it`);
        return;
      }
      this.arrive(exits[0].to);
    }

    // A value for a Measure or Ask tile (or for a decision whose value wasn't measured).
    answer(value) {
      if (!this.step || this.step.kind !== 'ask') return;
      const t = this.step.tile;
      const name = t.kind === 'decision' ? this.step.missing : t.value;
      this.values[name] = value;
      this.log.push({ kind: 'value', tile: t.id, text: `${name} = ${value === true ? 'yes' : value === false ? 'no' : value}` });
      this.idle = 0;
      if (t.kind === 'decision') this.arrive(t.id);
      else this.follow(t.id, 'next');
    }
  }

  return {
    KINDS, PALETTE, PALETTE_GROUPS, OPS, MAX_LANES, emptyProcess, isTile, portsOf, portName, lanesOf, isStop, hasWork,
    takesInput, endsLanes, inputsOf, sizeOf, tileById, addTile, moveTile, removeTile, link, unlink, setLanes, graph,
    linkKey, backLinks, stretches, exitsOf, conditionText, evaluate, loops, check, tidy, Walk, COL, ROW, GAP_X, GAP_Y, LOOP,
  };
});
