/* Frame data: the original's fluxels[fluxel][frame] on/off table (144 electrodes), but with as many
 * frames as are used: the table grows when a later frame is written. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else (root.OD = root.OD || {}).model = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const ROWS = 8;
  const COLS = 18; // 16 electrode columns + 2 control columns (column 16 = magnets)
  const CELLS = COLS * ROWS; // electrode ID e = column * 8 + row
  // The original controller (and its .json files, and protocol 1's upload) stops at frame 200.
  // Here a sequence can run longer, for live use; MAX_FRAMES only guards against runaway growth.
  const ORIGINAL_FRAMES = 200;
  const MAX_FRAMES = 100000;

  // How long each frame lasts, in milliseconds. The default is the original's 120 frames/min.
  const DEFAULT_FRAME_TIME = 500;
  const MIN_TIME = 10;
  const MAX_TIME = 3600000; // an hour
  const clampTime = (ms) => Math.min(MAX_TIME, Math.max(MIN_TIME, Math.round(ms)));

  class Sequence {
    constructor() {
      // Frames are numbered from 1. Index 0 is never written: it is the empty "previous frame" of
      // frame 1, as in the original. Frames past the end of the table are empty.
      this.frames = Array.from({ length: ORIGINAL_FRAMES + 1 }, () => new Uint8Array(CELLS));
      // A frame's own time in ms, or 0 for the default. The default is a setting, not part of
      // what undo restores.
      this.times = new Uint32Array(ORIGINAL_FRAMES + 1);
      this.frameTime = DEFAULT_FRAME_TIME;
      // Heater targets and magnets per frame ({ targets: [°C or null ×3], magnets: [bool, bool] }),
      // for frames where the project sets them; sparse. Magnets are also on as electrodes 128/129.
      this.controls = [];
      // Frames where playing waits until the heaters reach targets: frame -> { targets, tolerance }.
      this.holds = new Map();
      // The last frame something runs in, even with nothing on (a wait for the heaters at the end):
      // lastFrame() is at least this.
      this.end = 0;
    }

    // Frame f's heater targets and magnets, or null if the project doesn't set them.
    controlsAt(f) {
      return this.controls[f] || null;
    }

    // Whether any frame has a heater target set.
    get heated() {
      return this.controls.some((c) => c && c.targets.some((t) => t !== null));
    }

    // Frames in the table (1..length-1); later ones are empty.
    get length() {
      return this.frames.length - 1;
    }

    // Makes room for frame f (up to MAX_FRAMES).
    grow(f) {
      if (f < this.frames.length) return;
      if (f > MAX_FRAMES) throw new RangeError(`frame ${f} is past the ${MAX_FRAMES}-frame guard`);
      const size = Math.min(MAX_FRAMES + 1, Math.max(f + 1, this.frames.length * 2));
      while (this.frames.length < size) this.frames.push(new Uint8Array(CELLS));
      const times = new Uint32Array(size);
      times.set(this.times);
      this.times = times;
    }

    timeOf(f) {
      return this.times[f] || this.frameTime;
    }

    // ms = 0 (or null) goes back to the default.
    setTime(f, ms) {
      if (!ms && f >= this.times.length) return;
      this.grow(f);
      this.times[f] = ms ? clampTime(ms) : 0;
    }

    // Time from the start of frame 1 to the end of frame f, in ms.
    elapsed(f) {
      let total = 0;
      for (let i = 1; i <= f; i++) total += this.timeOf(i);
      return total;
    }

    get(e, f) {
      const frame = this.frames[f];
      return frame !== undefined && frame[e] === 1;
    }

    set(e, f, on) {
      if (!on && f >= this.frames.length) return;
      this.grow(f);
      this.frames[f][e] = on ? 1 : 0;
    }

    // Frame f's electrodes (a 144-byte view; all off past the end of the table). Don't write to it.
    cells(f) {
      return this.frames[f] || EMPTY;
    }

    clearFrame(f) {
      if (f < this.frames.length) this.frames[f].fill(0);
    }

    clearAll() {
      for (const frame of this.frames) frame.fill(0);
      this.times.fill(0);
      this.controls = [];
      this.holds.clear();
      this.end = 0;
    }

    copyFrame(from, to) {
      if (to >= this.frames.length && this.isEmpty(from)) return;
      this.grow(to);
      this.frames[to].set(this.cells(from));
    }

    isEmpty(f) {
      return f >= this.frames.length || !this.frames[f].includes(1);
    }

    // Last frame with any electrode on, or 1 (the original's frameMax()); at least `end`.
    lastFrame() {
      for (let f = this.frames.length - 1; f > Math.max(1, this.end); f--) if (!this.isEmpty(f)) return f;
      return Math.max(1, this.end);
    }

    // Electrodes (144 bytes a frame) and frame times, for undo.
    snapshot() {
      const cells = new Uint8Array(this.frames.length * CELLS);
      this.frames.forEach((frame, f) => cells.set(frame, f * CELLS));
      return { cells, times: this.times.slice() };
    }

    restore(snapshot) {
      const n = snapshot.cells.length / CELLS;
      if (n > this.frames.length) this.grow(n - 1);
      this.frames.length = Math.max(n, ORIGINAL_FRAMES + 1);
      this.frames.forEach((frame, f) => (f < n ? frame.set(snapshot.cells.subarray(f * CELLS, (f + 1) * CELLS)) : frame.fill(0)));
      this.times = new Uint32Array(this.frames.length);
      this.times.set(snapshot.times.subarray(0, this.frames.length));
    }
  }

  const EMPTY = new Uint8Array(CELLS);

  // Snapshots of tables of different lengths are the same if the longer one's extra frames are
  // empty.
  const sameSnapshot = (a, b) => {
    const same = (x, y) => {
      for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return false;
      return true;
    };
    return same(a.cells, b.cells) && same(a.times, b.times);
  };

  return {
    ROWS, COLS, CELLS, ORIGINAL_FRAMES, MAX_FRAMES, DEFAULT_FRAME_TIME, MIN_TIME, MAX_TIME, clampTime, sameSnapshot, Sequence,
  };
});
