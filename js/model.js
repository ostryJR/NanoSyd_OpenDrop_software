/* Frame data: the same 200 x 144 on/off table as the original's fluxels[fluxel][frame]. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else (root.OD = root.OD || {}).model = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const ROWS = 8;
  const COLS = 18; // 16 electrode columns + 2 control columns (column 16 = magnets)
  const CELLS = COLS * ROWS; // electrode ID e = column * 8 + row
  const MAX_FRAMES = 200;

  class Sequence {
    constructor() {
      // Frames are numbered 1..200. Index 0 is never written: it is the empty
      // "previous frame" of frame 1, as in the original.
      this.frames = Array.from({ length: MAX_FRAMES + 1 }, () => new Uint8Array(CELLS));
    }

    get(e, f) {
      return this.frames[f][e] === 1;
    }

    set(e, f, on) {
      this.frames[f][e] = on ? 1 : 0;
    }

    clearFrame(f) {
      this.frames[f].fill(0);
    }

    clearAll() {
      for (const frame of this.frames) frame.fill(0);
    }

    copyFrame(from, to) {
      this.frames[to].set(this.frames[from]);
    }

    isEmpty(f) {
      return !this.frames[f].includes(1);
    }

    // Last frame with any electrode on, or 1 (the original's frameMax()).
    lastFrame() {
      for (let f = MAX_FRAMES; f > 1; f--) if (!this.isEmpty(f)) return f;
      return 1;
    }
  }

  return { ROWS, COLS, CELLS, MAX_FRAMES, Sequence };
});
