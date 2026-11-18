/* Templates: reusable operations (mixing, splitting, merging, ...) that are dropped onto the
 * array. A template is a list of frames; each frame lists electrodes as [column, row] offsets from
 * the anchor, the electrode the template is dropped on. Every frame lasts the frame time. No DOM
 * here. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./model.js'), require('./paths.js'));
  } else {
    (root.OD = root.OD || {}).templates = factory(root.OD.model, root.OD.paths);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (model, paths) {
  'use strict';

  const { ROWS, MAX_FRAMES, Sequence } = model;
  const { electrodeGraph } = paths;

  const DROPLET_COLUMNS = 16; // columns 0-15 hold the droplet electrodes; 16-17 are control lines
  const DROPLET_CELLS = DROPLET_COLUMNS * ROWS;
  const GRID = { first: 1, last: 14 }; // the main grid's columns on the standard cartridge

  // One droplet going round `cells` `rounds` times, ending where it started.
  const rounds = (cells, times) => {
    const frames = [];
    for (let i = 0; i < times; i++) for (const cell of cells) frames.push([cell]);
    frames.push([cells[0]]);
    return frames;
  };

  // Split: stretch the droplet over three electrodes, switch the middle one off so it pinches
  // in two, and pull the halves apart. Merge: the reverse, for two droplets one electrode apart.
  const SPLIT = [[[0, 0]], [[-1, 0], [0, 0], [1, 0]], [[-1, 0], [1, 0]], [[-2, 0], [2, 0]]];
  const MERGE_BACK = [[[-1, 0], [1, 0]], [[-1, 0], [0, 0], [1, 0]]];

  // The edge of a size x size square from its top-left electrode: clockwise on screen (right
  // first), or counter-clockwise (down first).
  function ring(size, ccw = false) {
    const cells = [];
    for (let c = 0; c < size; c++) cells.push([c, 0]);
    for (let r = 1; r < size; r++) cells.push([size - 1, r]);
    for (let c = size - 2; c >= 0; c--) cells.push([c, size - 1]);
    for (let r = size - 2; r > 0; r--) cells.push([0, r]);
    return ccw ? [cells[0], ...cells.slice(1).reverse()] : cells;
  }

  const roundsText = (n) => `${n} round${n === 1 ? '' : 's'}`;
  const clampInt = (v, [lo, hi], fallback) => (Number.isInteger(v) ? Math.min(hi, Math.max(lo, v)) : fallback);

  // Built-in operations that take parameters: what can be set (numbers with limits and defaults;
  // choices, whose first value is the default and is left out of the parameters), the frames,
  // the name, and a key for the copy kept in project files.
  const FAMILIES = {
    circle: {
      limits: { size: [2, 3, 2], rounds: [1, 20, 3] },
      choices: { dir: ['cw', 'ccw'] },
      frames: (p) => rounds(ring(p.size, p.dir === 'ccw'), p.rounds),
      name: (p) => `Circle mix ${p.size}×${p.size}${p.dir === 'ccw' ? ' counter-clockwise' : ''}, ${roundsText(p.rounds)}`,
      key: (p) => `circle-${p.size}x${p.size}-r${p.rounds}${p.dir === 'ccw' ? '-ccw' : ''}`,
    },
    backforth: {
      limits: { length: [2, 6, 4], rounds: [1, 20, 2] },
      frames: (p) => {
        const there = Array.from({ length: p.length }, (_, i) => [i, 0]);
        return rounds([...there, ...there.slice(1, -1).reverse()], p.rounds);
      },
      name: (p) => (p.length === 4 && p.rounds === 2 ? 'Back-and-forth mix' : `Back-and-forth mix over ${p.length}, ${roundsText(p.rounds)}`),
      key: (p) => `back-and-forth-${p.length}-r${p.rounds}`,
    },
    splitmerge: {
      limits: { rounds: [1, 10, 2] },
      frames: (p) => [...Array.from({ length: p.rounds }, () => [...SPLIT, ...MERGE_BACK]).flat(), [[0, 0]]],
      name: (p) => `Split & merge, ${roundsText(p.rounds)}`,
      key: (p) => `split-merge-r${p.rounds}`,
    },
  };

  // Parameters checked against their family's limits ({ kind, ... }), or null for an unknown kind.
  function cleanParams(params) {
    const fam = params && FAMILIES[params.kind];
    if (!fam) return null;
    const out = { kind: params.kind };
    for (const [k, [lo, hi, def]] of Object.entries(fam.limits)) out[k] = clampInt(params[k], [lo, hi], def);
    for (const [k, values] of Object.entries(fam.choices || {})) {
      if (values.indexOf(params[k]) > 0) out[k] = params[k];
    }
    return out;
  }

  const sameParams = (a, b) => Boolean(a && b) && Object.keys({ ...a, ...b }).every((k) => a[k] === b[k]);

  // The built-in templates, in the order and groups the Templates tab lists them.
  const GROUPS = ['Merge and split', 'Mixers'];
  const BUILT_IN = [
    // Drawn side by side (as its card shows it), but dropped standing up: `turns` is how many
    // quarter turns it starts with when dragged onto the array (R still turns it).
    { id: 'merge', group: 'Merge and split', name: 'Merge two droplets', frames: [[[0, 0], [2, 0]], [[0, 0], [1, 0], [2, 0]], [[1, 0]]], turns: 1 },
    { id: 'split', group: 'Merge and split', name: 'Split in two', frames: SPLIT },
    { id: 'circle-2x2', group: 'Mixers', params: { kind: 'circle', size: 2, rounds: 3 } },
    { id: 'circle-3x3', group: 'Mixers', params: { kind: 'circle', size: 3, rounds: 2 } },
    { id: 'back-and-forth', group: 'Mixers', params: { kind: 'backforth', length: 4, rounds: 2 } },
    { id: 'split-merge', group: 'Mixers', params: { kind: 'splitmerge', rounds: 2 } },
  ].map((t) => {
    if (!t.params) return { ...t, builtIn: true };
    const fam = FAMILIES[t.params.kind];
    return { id: t.id, group: t.group, name: fam.name(t.params), frames: fam.frames(t.params), params: t.params, builtIn: true };
  });

  // A built-in operation made with other parameters: { id, name, frames, params, builtIn }. The
  // id is the built-in one when the parameters are its own, so files keep one copy of it.
  function fromParams(params) {
    const p = cleanParams(params);
    if (!p) return null;
    const fam = FAMILIES[p.kind];
    const same = BUILT_IN.find((t) => sameParams(t.params, p));
    return { id: same ? same.id : fam.key(p), name: fam.name(p), frames: fam.frames(p), params: p, builtIn: true };
  }

  const stepsOf = (template) => template.frames.length - 1;

  // A quarter turn clockwise on screen (rows count downwards).
  function rotate(frames, quarterTurns) {
    let out = frames;
    for (let i = 0; i < ((quarterTurns % 4) + 4) % 4; i++) out = out.map((cells) => cells.map(([dc, dr]) => [-dr, dc]));
    return out;
  }

  // Where a template lands with its anchor on electrode `anchor` in frame `frame`: the electrodes
  // of each frame, and whether it fits on the array (`fits`) and before the MAX_FRAMES guard
  // (`inTime`).
  function place(template, quarterTurns, anchor, frame, rects) {
    const { centres } = electrodeGraph(rects);
    const c0 = Math.floor(anchor / ROWS);
    const r0 = anchor % ROWS;
    let fits = anchor < DROPLET_CELLS;
    const frames = rotate(template.frames, quarterTurns).map((cells) => {
      const list = [];
      for (const [dc, dr] of cells) {
        const c = c0 + dc;
        const r = r0 + dr;
        const e = c * ROWS + r;
        if (c < 0 || c >= DROPLET_COLUMNS || r < 0 || r >= ROWS || !centres.has(e)) fits = false;
        else if (!list.includes(e)) list.push(e);
      }
      return list;
    });
    const steps = frames.length - 1;
    const inTime = frame + steps <= MAX_FRAMES;
    return { anchor, frame, frames, steps, endFrame: frame + steps, fits, inTime, valid: fits && inTime };
  }

  // How the droplets of a placed template move, for drawing it as lines. In each frame a droplet
  // is a group of electrodes that touch; it comes from each droplet of the frame before that it
  // overlaps or sits next to (two, where droplets merge; one droplet gives two where it splits).
  // `frames` are lists of electrodes. Returns each move once, between the droplets' centres in
  // grid units: [{ from: { x, y }, to: { x, y }, both }], both = it is also made the other way.
  function flow(frames, graph) {
    const { neighbours, centres } = graph;
    const groups = (cells) => {
      const left = new Set(cells.filter((e) => centres.has(e)));
      const out = [];
      for (const start of left) {
        const set = new Set([start]);
        left.delete(start);
        for (const e of set) {
          for (const n of neighbours.get(e) || []) {
            if (left.has(n)) {
              left.delete(n);
              set.add(n);
            }
          }
        }
        const list = [...set].map((e) => centres.get(e));
        out.push({
          cells: set,
          x: list.reduce((s, c) => s + c.x, 0) / list.length,
          y: list.reduce((s, c) => s + c.y, 0) / list.length,
        });
      }
      return out;
    };
    const near = (a, b) => [...b.cells].some((e) => a.cells.has(e) || (neighbours.get(e) || []).some((n) => a.cells.has(n)));
    const at = (g) => `${g.x.toFixed(2)},${g.y.toFixed(2)}`;
    const moves = new Map();
    let before = [];
    for (const cells of frames) {
      const now = groups(cells);
      for (const b of now) {
        for (const a of before) {
          if (at(a) !== at(b) && near(a, b)) moves.set(`${at(a)}>${at(b)}`, { from: { x: a.x, y: a.y }, to: { x: b.x, y: b.y } });
        }
      }
      before = now;
    }
    const out = [];
    const listed = new Set();
    for (const [key, m] of moves) {
      if (listed.has(key)) continue;
      const [p, q] = key.split('>');
      const back = `${q}>${p}`;
      listed.add(back);
      out.push({ ...m, both: moves.has(back) });
    }
    return out;
  }

  const dropletFrame = (seq, f) => seq.cells(f).subarray(0, DROPLET_CELLS).includes(1);

  // The template drawn in a sequence: the frames from the first to the last with a droplet
  // electrode on, as offsets from the first frame's first electrode (leftmost column, then the
  // top one). Control lines (magnets) are left out. Returns { frames }, or null if nothing is
  // drawn.
  function fromSequence(seq) {
    let first = 0;
    let last = 0;
    for (let f = 1; f <= seq.lastFrame(); f++) {
      if (!dropletFrame(seq, f)) continue;
      if (!first) first = f;
      last = f;
    }
    if (!first) return null;
    const anchor = seq.cells(first).indexOf(1);
    const c0 = Math.floor(anchor / ROWS);
    const r0 = anchor % ROWS;
    const frames = [];
    for (let f = first; f <= last; f++) {
      const cells = [];
      for (let e = 0; e < DROPLET_CELLS; e++) if (seq.get(e, f)) cells.push([Math.floor(e / ROWS) - c0, (e % ROWS) - r0]);
      frames.push(cells);
    }
    return { frames };
  }

  // A sequence showing the template from frame 1, centred on the main grid if it fits there.
  function toSequence({ frames }) {
    const cells = frames.flat();
    const seq = new Sequence();
    if (!cells.length) return seq;
    const span = (i) => [Math.min(...cells.map((c) => c[i])), Math.max(...cells.map((c) => c[i]))];
    const [minC, maxC] = span(0);
    const [minR, maxR] = span(1);
    const width = maxC - minC + 1;
    const gridWidth = GRID.last - GRID.first + 1;
    const c0 = (width <= gridWidth ? GRID.first + Math.floor((gridWidth - width) / 2) : 0) - minC;
    const r0 = Math.max(0, Math.floor((ROWS - (maxR - minR + 1)) / 2)) - minR;
    frames.slice(0, MAX_FRAMES).forEach((list, i) => {
      for (const [dc, dr] of list) {
        const c = c0 + dc;
        const r = r0 + dr;
        if (c >= 0 && c < DROPLET_COLUMNS && r >= 0 && r < ROWS) seq.set(c * ROWS + r, i + 1, true);
      }
    });
    return seq;
  }

  // --- storage ------------------------------------------------------------------------------------
  // Saved as { name, frames } (frame times that older files have are left out). Anything malformed
  // is dropped rather than trusted.

  const isCell = (c) =>
    Array.isArray(c) && c.length === 2 && Number.isInteger(c[0]) && Number.isInteger(c[1]) &&
    Math.abs(c[0]) < DROPLET_COLUMNS && Math.abs(c[1]) < ROWS;

  function clean(raw) {
    if (!raw || typeof raw !== 'object' || typeof raw.name !== 'string' || !Array.isArray(raw.frames)) return null;
    const frames = raw.frames
      .slice(0, MAX_FRAMES)
      .map((cells) => (Array.isArray(cells) ? cells.filter(isCell).map(([c, r]) => [c, r]) : []));
    if (!frames.length || !frames[0].length) return null;
    return { name: raw.name.trim().slice(0, 60) || 'Template', frames };
  }

  const FILE_TAG = 'openDropGeneratorTemplates';

  function exportText(list) {
    return JSON.stringify({ [FILE_TAG]: 1, templates: list.map(({ name, frames }) => ({ name, frames })) }, null, 1);
  }

  // Templates from an export file (or a bare list of them). Throws if there are none.
  function importText(text) {
    const data = JSON.parse(text);
    const list = Array.isArray(data) ? data : data && Array.isArray(data.templates) ? data.templates : null;
    if (!list) throw new Error('not a templates file');
    const good = list.map(clean).filter(Boolean);
    if (!good.length) throw new Error('no templates found in it');
    return good;
  }

  const sameTemplate = (a, b) => a.name === b.name && JSON.stringify(a.frames) === JSON.stringify(b.frames);

  return {
    BUILT_IN, GROUPS, FAMILIES, stepsOf, rotate, place, flow, fromSequence, toSequence, clean, exportText, importText, sameTemplate,
    fromParams, cleanParams, sameParams, DROPLET_CELLS,
  };
});
