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

  // How long each frame lasts, in milliseconds. The default is the original's 120 frames/min.
  const DEFAULT_FRAME_TIME = 500;
  const MIN_TIME = 10;
  const MAX_TIME = 3600000; // an hour
  const clampTime = (ms) => Math.min(MAX_TIME, Math.max(MIN_TIME, Math.round(ms)));

  class Sequence {
    constructor() {
      // Frames are numbered 1..200. Index 0 is never written: it is the empty
      // "previous frame" of frame 1, as in the original.
      this.frames = Array.from({ length: MAX_FRAMES + 1 }, () => new Uint8Array(CELLS));
      // A frame's own time in ms, or 0 for the default. The default is a setting, not part of
      // what undo restores.
      this.times = new Uint32Array(MAX_FRAMES + 1);
      this.frameTime = DEFAULT_FRAME_TIME;
    }

    timeOf(f) {
      return this.times[f] || this.frameTime;
    }

    // ms = 0 (or null) goes back to the default.
    setTime(f, ms) {
      this.times[f] = ms ? clampTime(ms) : 0;
    }

    // Time from the start of frame 1 to the end of frame f, in ms.
    elapsed(f) {
      let total = 0;
      for (let i = 1; i <= f; i++) total += this.timeOf(i);
      return total;
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
      this.times.fill(0);
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

    // Electrodes (29 KB) and frame times, for undo.
    snapshot() {
      const cells = new Uint8Array(this.frames.length * CELLS);
      this.frames.forEach((frame, f) => cells.set(frame, f * CELLS));
      return { cells, times: this.times.slice() };
    }

    restore(snapshot) {
      this.frames.forEach((frame, f) => frame.set(snapshot.cells.subarray(f * CELLS, (f + 1) * CELLS)));
      this.times.set(snapshot.times);
    }
  }

  const sameSnapshot = (a, b) => {
    for (let i = 0; i < a.cells.length; i++) if (a.cells[i] !== b.cells[i]) return false;
    for (let i = 0; i < a.times.length; i++) if (a.times[i] !== b.times[i]) return false;
    return true;
  };

  return {
    ROWS, COLS, CELLS, MAX_FRAMES, DEFAULT_FRAME_TIME, MIN_TIME, MAX_TIME, clampTime, sameSnapshot, Sequence,
  };
});
