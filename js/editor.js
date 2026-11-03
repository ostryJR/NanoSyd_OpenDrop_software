/* Editing and playback behaviour, ported from mousePressed, mouseDragged, mouseWheel, keyPressed
 * and animate in OpenDropController4_25.pde, plus path drawing and undo. No DOM here: app.js
 * passes in grid coordinates. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./model.js'), require('./layout.js'), require('./paths.js'), require('./templates.js'));
  } else {
    (root.OD = root.OD || {}).editor = factory(root.OD.model, root.OD.layout, root.OD.paths, root.OD.templates);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (model, layout, paths, templates) {
  'use strict';

  const { MAX_FRAMES, Sequence, sameSnapshot, clampTime } = model;
  const { hitTest, inArray, inRect } = layout;
  const { PathDraft, electrodeAt } = paths;
  const { place } = templates;

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
    // New on the left: what a drag does, and undo/redo. The label comes first and the box (at
    // box, y) sits on the side facing the array, mirroring the right-hand buttons. The label is
    // clickable too.
    { action: 'toolFreehand', x: -45, y: -9, w: 11, h: 2, box: -36, label: 'freehand', tool: 'freehand' },
    { action: 'toolStraight', x: -45, y: -6, w: 11, h: 2, box: -36, label: 'straight', tool: 'straight' },
    { action: 'toolPaint', x: -45, y: -3, w: 11, h: 2, box: -36, label: 'paint', tool: 'paint' },
    { action: 'undo', x: -45, y: 4, w: 11, h: 2, box: -36, label: 'undo' },
    { action: 'redo', x: -45, y: 7, w: 11, h: 2, box: -36, label: 'redo' },
  ];

  // What a drag on the array does: draw a droplet path that follows the pointer, draw one along
  // rows and columns, or switch electrodes in the current frame (the original's drag).
  const TOOLS = ['freehand', 'straight', 'paint'];
  const UNDO_LIMIT = 100;

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
      this.playing = false;
      this.playStart = 0;
      this.playLast = 1; // last frame of the play loop, fixed when play starts
      this.tool = 'freehand';
      this.paintOn = false; // the original's dragg_mode
      this.dragging = false; // a paint or path drag is in progress
      this.lastPoint = null;
      this.draft = null; // the path being drawn, shown but not yet in the sequence
      this.dragStart = null; // undo checkpoint from the start of a paint drag
      this.placement = null; // a template being dragged over the array
      this.saved = null; // the main sequence, set aside while a template is being made
      this.undoStack = [];
      this.redoStack = [];
    }

    setLayout(lay) {
      this.cancel();
      this.layout = lay;
    }

    setTool(tool) {
      if (TOOLS.includes(tool) && !this.dragging) this.tool = tool;
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
      if (this.dragging) this.pointerUp();
      const action = this.controlAt(mx, my);
      if (action) {
        this.run(action, now);
        return action;
      }

      // The path tools start a path on the electrode under the pointer. Nothing changes until
      // the button is released, and a click without a drag still toggles, as in the original.
      if (this.tool !== 'paint' && !shift) {
        const start = electrodeAt(this.layout.rects, mx, my);
        if (start === null) return null;
        this.draft = new PathDraft(this.layout.rects, this.tool, start, this.frame, { mx, my });
        this.dragging = true;
        return null;
      }

      // Paint tool, and Shift+click with any tool: the original's behaviour.
      const before = this.checkpoint();
      if (shift) this.nextFrame(); // Shift+click: go to the next frame, then switch on
      if (!inArray(mx, my)) return null;

      this.dragStart = before;
      this.dragging = true;
      this.lastPoint = { mx, my };
      for (const e of hitTest(this.layout.rects, mx, my)) {
        const on = shift || !this.seq.get(e, this.frame);
        this.seq.set(e, this.frame, on);
        this.paintOn = on;
      }
      return null;
    }

    // Moved with the button held. Paint: every electrode passed over gets the state set by the
    // press. Path tools: the path follows the pointer.
    pointerMove(mx, my) {
      if (!this.dragging) return false;
      if (this.draft) {
        this.draft.moveTo(mx, my);
        if (this.draft.moved) this.playing = false; // drawing over a moving picture would confuse
        return true;
      }
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

    // Button released. A path is added to the sequence now: the start electrode in the frame
    // where the drag began, then one electrode per frame, added to whatever those frames already
    // hold. The view moves to the path's last frame, so the next drag carries on from there.
    // Returns { from, to, steps } for an added path, otherwise null.
    pointerUp() {
      if (!this.dragging) return null;
      this.dragging = false;
      this.lastPoint = null;
      const draft = this.draft;
      this.draft = null;
      if (!draft) {
        this.record(this.dragStart);
        this.dragStart = null;
        return null;
      }
      if (!draft.moved) {
        this.change(() => this.seq.set(draft.start, draft.frame, !this.seq.get(draft.start, draft.frame)));
        return null;
      }
      if (draft.steps === 0) return null; // dragged back to the start
      this.change(() => {
        draft.cells.forEach((e, i) => this.seq.set(e, draft.frame + i, true));
        this.frame = draft.endFrame;
      });
      return { from: draft.frame, to: draft.endFrame, steps: draft.steps };
    }

    // Esc: drops the path or template being drawn, or takes back the paint drag in progress.
    cancel() {
      if (this.placement) {
        this.placement = null;
        return true;
      }
      if (!this.dragging) return false;
      this.dragging = false;
      this.lastPoint = null;
      this.draft = null;
      if (this.dragStart) {
        this.seq.restore(this.dragStart.snap);
        this.frame = this.dragStart.frame;
        this.dragStart = null;
      }
      return true;
    }

    // --- templates -------------------------------------------------------------------------------
    // A template being dragged lands with its anchor on the electrode under the pointer, starting
    // in the frame on screen. Nothing changes until it is dropped.

    startPlacement(template) {
      this.cancel();
      this.playing = false;
      this.placement = { template, turns: 0, spot: null };
    }

    hoverPlacement(mx, my) {
      const p = this.placement;
      if (!p) return;
      const anchor = electrodeAt(this.layout.rects, mx, my);
      p.spot = anchor === null ? null : place(p.template, p.turns, anchor, this.frame, this.layout.rects);
    }

    // A quarter turn clockwise.
    rotatePlacement() {
      const p = this.placement;
      if (!p) return;
      p.turns = (p.turns + 1) % 4;
      if (p.spot) p.spot = place(p.template, p.turns, p.spot.anchor, p.spot.frame, this.layout.rects);
    }

    // Adds the template where it is (on top of what the frames hold, its frame times replacing
    // theirs) and moves to its last frame. Returns { from, to, steps }, or null if it doesn't fit.
    dropPlacement() {
      const spot = this.placement && this.placement.spot;
      this.placement = null;
      if (!spot || !spot.valid) return null;
      this.change(() => {
        spot.frames.forEach((cells, i) => {
          for (const e of cells) this.seq.set(e, spot.frame + i, true);
          if (spot.times && spot.times[i]) this.seq.setTime(spot.frame + i, spot.times[i]);
        });
        this.frame = spot.endFrame;
      });
      return { from: spot.frame, to: spot.endFrame, steps: spot.steps };
    }

    // --- making a template -----------------------------------------------------------------------
    // The main sequence is set aside with its undo history, and the template is drawn in a blank
    // one with all the usual tools.

    get makingTemplate() {
      return this.saved !== null;
    }

    startTemplate(seq = new Sequence()) {
      this.cancel();
      if (!this.saved) {
        this.saved = { seq: this.seq, frame: this.frame, undoStack: this.undoStack, redoStack: this.redoStack };
      }
      seq.frameTime = this.seq.frameTime;
      this.seq = seq;
      this.frame = 1;
      this.undoStack = [];
      this.redoStack = [];
      this.playing = false;
    }

    endTemplate() {
      if (!this.saved) return;
      this.cancel();
      this.saved.seq.frameTime = this.seq.frameTime; // the default frame time is a setting
      ({ seq: this.seq, frame: this.frame, undoStack: this.undoStack, redoStack: this.redoStack } = this.saved);
      this.saved = null;
      this.playing = false;
    }

    // --- undo ----------------------------------------------------------------------------------
    // Each change keeps a copy of the whole sequence from before it, and the frame it was made in.

    checkpoint() {
      return { snap: this.seq.snapshot(), frame: this.frame };
    }

    // Keeps `before` for undo if the sequence has changed since it was taken.
    record(before) {
      if (!before || sameSnapshot(before.snap, this.seq.snapshot())) return false;
      this.undoStack.push(before);
      if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
      this.redoStack.length = 0;
      return true;
    }

    change(fn) {
      const before = this.checkpoint();
      fn();
      return this.record(before);
    }

    get canUndo() {
      return this.undoStack.length > 0;
    }

    get canRedo() {
      return this.redoStack.length > 0;
    }

    // During a drag, undo just cancels the drag.
    undo() {
      return this.cancel() || this.travel(this.undoStack, this.redoStack);
    }

    redo() {
      return !this.cancel() && this.travel(this.redoStack, this.undoStack);
    }

    travel(from, to) {
      const target = from.pop();
      if (!target) return false;
      to.push(this.checkpoint());
      this.seq.restore(target.snap);
      this.frame = target.frame;
      if (this.playing) this.playLast = this.seq.lastFrame();
      return true;
    }

    // The original's "interval": the default frame time as frames per minute.
    get speed() {
      return 60000 / this.seq.frameTime;
    }

    // One wheel step: +1 = towards you (down), -1 = away (up). While playing it changes the
    // speed by 5 frames/min, as in the original; otherwise up goes to the next frame and down
    // to the previous one.
    wheel(count) {
      if (this.playing) {
        const speed = Math.min(MAX_SPEED, Math.max(MIN_SPEED, Math.round(this.speed) - count * 5));
        this.seq.frameTime = Math.round(60000 / speed);
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

    // How long the frame on screen lasts.
    get frameMs() {
      return this.seq.timeOf(this.frame);
    }

    // The default frame time is a setting: it isn't undone. A frame's own time is undoable.
    setDefaultTime(ms) {
      this.seq.frameTime = clampTime(ms);
    }

    setFrameTime(f, ms) {
      return this.change(() => this.seq.setTime(f, ms));
    }

    // Advances playback, each frame staying for its own time; returns true when the frame
    // changed. Loops back to frame 1.
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
        case 'undo':
          this.undo();
          break;
        case 'redo':
          this.redo();
          break;
        case 'copy':
          if (f > 1) this.change(() => this.seq.copyFrame(f - 1, f));
          break;
        case 'clearFrame':
          this.change(() => this.seq.clearFrame(f));
          break;
        case 'clearAll':
          this.playing = false; // nothing is left to play
          this.change(() => {
            this.seq.clearAll();
            this.frame = 1;
          });
          break;
        default: {
          const control = CONTROLS.find((c) => c.action === action);
          if (control && control.tool) this.setTool(control.tool);
          else if (RESERVOIR_STEPS[action]) this.change(() => this.applySteps(RESERVOIR_STEPS[action]));
        }
      }
    }

    // Switches each step's electrodes on in consecutive frames and stays on the last one.
    applySteps(steps) {
      steps.forEach((electrodes, i) => {
        if (i > 0) this.nextFrame();
        for (const e of electrodes) this.seq.set(e, this.frame, true);
      });
    }

    // Loading a file: undoable like any other change. A file with frame times also brings its
    // default frame time; one without keeps the current default.
    replaceSequence(seq, { timed = false } = {}) {
      this.cancel();
      this.change(() => {
        this.seq.restore(seq.snapshot());
        this.frame = 1;
      });
      if (timed) this.seq.frameTime = seq.frameTime;
      if (this.playing) this.playLast = this.seq.lastFrame();
    }
  }

  return { Editor, CONTROLS, RESERVOIR_STEPS, TOOLS, UNDO_LIMIT, MIN_SPEED, MAX_SPEED };
});
