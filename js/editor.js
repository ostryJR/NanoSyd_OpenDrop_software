/* Editing and playback behaviour, ported from mousePressed, mouseDragged, mouseWheel, keyPressed
 * and animate in OpenDropController4_25.pde. No DOM here: app.js passes in grid coordinates. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./model.js'), require('./layout.js'));
  } else {
    (root.OD = root.OD || {}).editor = factory(root.OD.model, root.OD.layout);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (model, layout) {
  'use strict';

  const { MAX_FRAMES, Sequence } = model;
  const { hitTest, inArray, inRect } = layout;

  // Click areas in grid units, copied from the original's inRect() checks. The device-only
  // controls (life, feedback, reconnect, temperatures) are left out.
  const CONTROLS = [
    { action: 'play', x: 34, y: -9, w: 6, h: 2 },
    { action: 'copy', x: 34, y: 4, w: 2, h: 2 },
    { action: 'clearFrame', x: 34, y: 7, w: 2, h: 2 },
    { action: 'clearAll', x: 34, y: 10, w: 2, h: 2 },
    { action: 'load', x: 38, y: -20, w: 4, h: 2 },
    { action: 'save', x: 32, y: -20, w: 4, h: 2 },
    { action: 'next', x: 18, y: 18.5, w: 4, h: 4 },
    { action: 'prev', x: -20, y: 18.5, w: 4, h: 4 },
    { action: 'reservoirRightTop', x: 28, y: -6, w: 2, h: 2, reservoir: true },
    { action: 'reservoirRightBottom', x: 28, y: 4, w: 2, h: 2, reservoir: true },
    { action: 'reservoirLeftTop', x: -30, y: -6, w: 2, h: 2, reservoir: true },
    { action: 'reservoirLeftBottom', x: -30, y: 4, w: 2, h: 2, reservoir: true },
  ];

  // The reservoir buttons' droplet-dispensing sequences: the electrodes switched on in each of
  // six consecutive frames, starting at the current one. Nothing is switched off.
  const RESERVOIR_STEPS = {
    reservoirRightTop: [[123], [123, 122], [122, 121, 120], [120, 113], [113, 123, 122], [113, 123]],
    reservoirRightBottom: [[124], [124, 125], [125, 126, 127], [127, 118], [118, 124, 125], [118, 124]],
    reservoirLeftTop: [[3], [3, 2], [2, 1, 0], [0, 9], [9, 3, 2], [9, 3]],
    reservoirLeftBottom: [[4], [4, 5], [5, 6, 7], [7, 14], [14, 4, 5], [14, 4]],
  };

  const MIN_SPEED = 5; // frames per minute
  const MAX_SPEED = 600;
  const DRAG_STEP = 0.25; // grid units between paint samples, so fast drags don't skip electrodes

  class Editor {
    constructor(lay) {
      this.layout = lay;
      this.seq = new Sequence();
      this.frame = 1;
      this.speed = 120; // the original's "interval", in frames per minute
      this.playing = false;
      this.playStart = 0;
      this.playLast = 1; // last frame of the play loop, fixed when play starts
      this.paintOn = false; // the original's dragg_mode
      this.dragging = false;
      this.lastPoint = null;
    }

    setLayout(lay) {
      this.layout = lay;
    }

    controlAt(mx, my) {
      const hit = CONTROLS.find(
        (c) => (!c.reservoir || this.layout.hasReservoirs) && inRect(mx, my, c.x, c.y, c.w, c.h)
      );
      return hit ? hit.action : null;
    }

    // Button pressed at (mx, my). Returns the control that was hit, if any; 'save' and 'load'
    // need a file dialog, which the caller opens.
    pointerDown(mx, my, { shift = false, now = 0 } = {}) {
      this.dragging = false;
      const action = this.controlAt(mx, my);
      if (action) {
        this.run(action, now);
        return action;
      }
      if (shift) this.nextFrame(); // Shift+click: go to the next frame, then switch on
      if (!inArray(mx, my)) return null;

      this.dragging = true;
      this.lastPoint = { mx, my };
      for (const e of hitTest(this.layout.rects, mx, my)) {
        const on = shift || !this.seq.get(e, this.frame);
        this.seq.set(e, this.frame, on);
        this.paintOn = on;
      }
      return null;
    }

    // Moved with the button held: every electrode passed over gets the state set by the press.
    pointerMove(mx, my) {
      if (!this.dragging) return false;
      const { mx: x0, my: y0 } = this.lastPoint;
      const samples = Math.max(1, Math.ceil(Math.hypot(mx - x0, my - y0) / DRAG_STEP));
      for (let i = 1; i <= samples; i++) {
        const x = x0 + ((mx - x0) * i) / samples;
        const y = y0 + ((my - y0) * i) / samples;
        if (!inArray(x, y)) continue;
        for (const e of hitTest(this.layout.rects, x, y)) this.seq.set(e, this.frame, this.paintOn);
      }
      this.lastPoint = { mx, my };
      return true;
    }

    pointerUp() {
      this.dragging = false;
      this.lastPoint = null;
    }

    // One wheel step: +1 = towards you (down), -1 = away (up). While playing it changes the
    // speed; otherwise up goes to the next frame and down to the previous one.
    wheel(count) {
      if (this.playing) {
        this.speed = Math.min(MAX_SPEED, Math.max(MIN_SPEED, this.speed - count * 5));
      } else if (count < 0) {
        this.nextFrame();
      } else if (count > 0) {
        this.prevFrame();
      }
    }

    nextFrame() {
      if (this.frame < MAX_FRAMES) this.frame++;
    }

    prevFrame() {
      if (this.frame > 1) this.frame--;
    }

    togglePlay(now) {
      if (this.playing) {
        this.playing = false;
        return;
      }
      this.playing = true;
      this.playStart = now;
      this.playLast = this.seq.lastFrame();
    }

    get frameMs() {
      return Math.floor(60000 / this.speed);
    }

    // Advances playback; returns true when the frame changed. Loops back to frame 1.
    tick(now) {
      if (!this.playing || now - this.playStart <= this.frameMs) return false;
      this.playStart = now;
      this.frame = this.frame < this.playLast ? this.frame + 1 : 1;
      return true;
    }

    run(action, now = 0) {
      const f = this.frame;
      switch (action) {
        case 'play':
          this.togglePlay(now);
          break;
        case 'next':
          this.nextFrame();
          break;
        case 'prev':
          this.prevFrame();
          break;
        case 'copy':
          if (f > 1) this.seq.copyFrame(f - 1, f);
          break;
        case 'clearFrame':
          this.seq.clearFrame(f);
          break;
        case 'clearAll':
          this.seq.clearAll();
          this.frame = 1;
          break;
        default:
          if (RESERVOIR_STEPS[action]) this.applySteps(RESERVOIR_STEPS[action]);
      }
    }

    // Switches each step's electrodes on in consecutive frames and stays on the last one.
    applySteps(steps) {
      steps.forEach((electrodes, i) => {
        if (i > 0) this.nextFrame();
        for (const e of electrodes) this.seq.set(e, this.frame, true);
      });
    }

    replaceSequence(seq) {
      this.seq = seq;
      this.frame = 1;
      if (this.playing) this.playLast = seq.lastFrame();
    }
  }

  return { Editor, CONTROLS, RESERVOIR_STEPS, MIN_SPEED, MAX_SPEED };
});
