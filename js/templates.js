/* Templates: reusable operations (mixing, splitting, merging, ...) that are dropped onto the
 * array. A template is a list of frames; each frame lists electrodes as [column, row] offsets from
 * the anchor, the electrode the template is dropped on. It can also carry frame times (ms, 0 =
 * the default). No DOM here. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./model.js'), require('./paths.js'));
  } else {
    (root.OD = root.OD || {}).templates = factory(root.OD.model, root.OD.paths);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (model, paths) {
  'use strict';

  const { ROWS, MAX_FRAMES, Sequence, clampTime } = model;
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

  const BUILT_IN = [
    { id: 'circle-2x2', name: 'Circle mix 2×2, 3 rounds', frames: rounds([[0, 0], [1, 0], [1, 1], [0, 1]], 3) },
    {
      id: 'circle-3x3',
      name: 'Circle mix 3×3, 2 rounds',
      frames: rounds([[0, 0], [1, 0], [2, 0], [2, 1], [2, 2], [1, 2], [0, 2], [0, 1]], 2),
    },
    { id: 'back-and-forth', name: 'Back-and-forth mix', frames: rounds([[0, 0], [1, 0], [2, 0], [3, 0], [2, 0], [1, 0]], 2) },
    { id: 'split', name: 'Split in two', frames: SPLIT },
    { id: 'merge', name: 'Merge two droplets', frames: [[[0, 0], [2, 0]], [[0, 0], [1, 0], [2, 0]], [[1, 0]]] },
    { id: 'split-merge', name: 'Split & merge, 2 rounds', frames: [...SPLIT, ...MERGE_BACK, ...SPLIT, ...MERGE_BACK, [[0, 0]]] },
  ].map((t) => ({ ...t, builtIn: true }));

  const stepsOf = (template) => template.frames.length - 1;

  // A quarter turn clockwise on screen (rows count downwards).
  function rotate(frames, quarterTurns) {
    let out = frames;
    for (let i = 0; i < ((quarterTurns % 4) + 4) % 4; i++) out = out.map((cells) => cells.map(([dc, dr]) => [-dr, dc]));
    return out;
  }

  // Where a template lands with its anchor on electrode `anchor` in frame `frame`: the electrodes
  // of each frame, and whether it fits on the array (`fits`) and before frame 200 (`inTime`).
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
    const times = template.times || null;
    return { anchor, frame, frames, times, steps, endFrame: frame + steps, fits, inTime, valid: fits && inTime };
  }

  const dropletFrame = (seq, f) => seq.frames[f].subarray(0, DROPLET_CELLS).includes(1);

  // The template drawn in a sequence: the frames from the first to the last with a droplet
  // electrode on, as offsets from the first frame's first electrode (leftmost column, then the
  // top one), and those frames' own times if any. Control lines (magnets) are left out.
  // Returns { frames, times? }, or null if nothing is drawn.
  function fromSequence(seq) {
    let first = 0;
    let last = 0;
    for (let f = 1; f <= MAX_FRAMES; f++) {
      if (!dropletFrame(seq, f)) continue;
      if (!first) first = f;
      last = f;
    }
    if (!first) return null;
    const anchor = seq.frames[first].indexOf(1);
    const c0 = Math.floor(anchor / ROWS);
    const r0 = anchor % ROWS;
    const frames = [];
    for (let f = first; f <= last; f++) {
      const cells = [];
      for (let e = 0; e < DROPLET_CELLS; e++) if (seq.get(e, f)) cells.push([Math.floor(e / ROWS) - c0, (e % ROWS) - r0]);
      frames.push(cells);
    }
    const times = Array.from(seq.times.subarray(first, last + 1));
    return times.some(Boolean) ? { frames, times } : { frames };
  }

  // A sequence showing the template from frame 1, centred on the main grid if it fits there.
  function toSequence({ frames, times }) {
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
      if (times && times[i]) seq.setTime(i + 1, times[i]);
    });
    return seq;
  }

  // --- storage ------------------------------------------------------------------------------------
  // Saved as { name, frames, times? }. Anything malformed is dropped rather than trusted.

  const isCell = (c) =>
    Array.isArray(c) && c.length === 2 && Number.isInteger(c[0]) && Number.isInteger(c[1]) &&
    Math.abs(c[0]) < DROPLET_COLUMNS && Math.abs(c[1]) < ROWS;

  function clean(raw) {
    if (!raw || typeof raw !== 'object' || typeof raw.name !== 'string' || !Array.isArray(raw.frames)) return null;
    const frames = raw.frames
      .slice(0, MAX_FRAMES)
      .map((cells) => (Array.isArray(cells) ? cells.filter(isCell).map(([c, r]) => [c, r]) : []));
    if (!frames.length || !frames[0].length) return null;
    const template = { name: raw.name.trim().slice(0, 60) || 'Template', frames };
    if (Array.isArray(raw.times) && raw.times.length === frames.length) {
      const times = raw.times.map((ms) => (Number.isFinite(ms) && ms > 0 ? clampTime(ms) : 0));
      if (times.some(Boolean)) template.times = times;
    }
    return template;
  }

  const FILE_TAG = 'openDropGeneratorTemplates';

  function exportText(list) {
    return JSON.stringify({ [FILE_TAG]: 1, templates: list.map(({ name, frames, times }) => (times ? { name, frames, times } : { name, frames })) }, null, 1);
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

  const sameTemplate = (a, b) =>
    a.name === b.name && JSON.stringify(a.frames) === JSON.stringify(b.frames) &&
    JSON.stringify(a.times || null) === JSON.stringify(b.times || null);

  return {
    BUILT_IN, stepsOf, rotate, place, fromSequence, toSequence, clean, exportText, importText, sameTemplate,
  };
});
