/* Editing and playback behaviour, ported from mousePressed, mouseDragged, mouseWheel, keyPressed
 * and animate in OpenDropController4_25.pde. What you draw is kept as actions in a project (a path
 * as a line, a template where it was dropped, a dispense, a painted pattern), and the frames are
 * compiled from them after every change. No DOM here: app.js passes in grid coordinates. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./model.js'), require('./layout.js'), require('./paths.js'), require('./templates.js'),
      require('./lines.js'), require('./compile.js'), require('./project.js')
    );
  } else {
    const OD = root.OD;
    (root.OD = root.OD || {}).editor = factory(OD.model, OD.layout, OD.paths, OD.templates, OD.lines, OD.compile, OD.project);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (model, layout, paths, templates, lines, compiler, projects) {
  'use strict';

  const { CELLS, MAX_FRAMES, clampTime } = model;
  const { hitTest, inArray, inRect } = layout;
  const { PathDraft, electrodeAt } = paths;
  const { place } = templates;
  const { compile, importSequence, RESERVOIR_STEPS, RESERVOIR_NAMES } = compiler;

  const DROPLET_CELLS = 128; // electrodes below this carry droplets; 128-143 are control lines

  // Click areas in grid units, copied from the original's inRect() checks. The device-only
  // controls (life, feedback, reconnect, temperatures) are left out.
  const CONTROLS = [
    { action: 'play', x: 34, y: -9, w: 6, h: 2 },
    { action: 'copy', x: 34, y: 4, w: 2, h: 2 },
    { action: 'clearFrame', x: 34, y: 7, w: 2, h: 2 },
    { action: 'clearAll', x: 34, y: 10, w: 2, h: 2 },
    { action: 'load', x: 38, y: -20, w: 4, h: 2 },
    { action: 'save', x: 32, y: -20, w: 4, h: 2 },
    { action: 'export', x: 25, y: -20, w: 5, h: 2 },
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
    { action: 'toolSelect', x: -45, y: 0, w: 11, h: 2, box: -36, label: 'select', tool: 'select' },
    { action: 'undo', x: -45, y: 4, w: 11, h: 2, box: -36, label: 'undo' },
    { action: 'redo', x: -45, y: 7, w: 11, h: 2, box: -36, label: 'redo' },
  ];

  // What a drag on the array does: draw a droplet path that follows the pointer, draw one along
  // rows and columns, switch electrodes in the current frame (the original's drag), or pick and
  // move what is drawn.
  const TOOLS = ['freehand', 'straight', 'paint', 'select'];
  const UNDO_LIMIT = 100;
  const MIN_SPEED = 5; // frames per minute
  const MAX_SPEED = 600;
  const DRAG_STEP = 0.25; // grid units between paint samples, so fast drags don't skip electrodes
  const PITCH = 2; // grid units from one standard electrode to the next

  const quote = (a) => `“${a.name}”`;

  class Editor {
    constructor(lay, project = projects.newProject({ layout: lay.id })) {
      this.layout = lay;
      this.ctx = lines.context(lay.rects);
      this.project = project;
      this.project.layout = lay.id;
      this.frame = 1;
      this.playing = false;
      this.playStart = 0;
      this.playLast = 1; // last frame of the play loop, fixed when play starts
      this.tool = 'freehand';
      this.dragging = false; // a drag of any kind is in progress
      this.lastPoint = null;
      this.draft = null; // the path being drawn, shown but not yet added
      this.paint = null; // a paint drag: { before, on, id }
      this.edit = null; // a select-tool drag: { id, grab, from, at, cycle, attached, preview }
      this.placement = null; // a template being dragged over the array
      this.selection = null; // id of the selected action
      this.saved = null; // the main project, set aside while a template is being made
      this.undoStack = [];
      this.redoStack = [];
      this.notice = null; // a message for the status line from the last operation, if any
      this.recompile();
    }

    // --- the project and its frames -----------------------------------------------------------

    recompile() {
      this.compiled = compile(this.project, this.layout.rects);
      if (this.playing) this.playLast = this.compiled.seq.lastFrame();
    }

    // The frames: compiled from the actions, so changing them changes nothing that lasts.
    get seq() {
      return this.compiled.seq;
    }

    // What the board shows: the edit being dragged if it fits, otherwise the project as it is.
    get shown() {
      const p = this.edit && this.edit.preview;
      return p && p.valid ? p.compiled : this.compiled;
    }

    action(id) {
      return this.project.actions.find((a) => a.id === id) || null;
    }

    get selected() {
      return this.selection ? this.action(this.selection) : null;
    }

    select(id) {
      this.selection = id && this.action(id) ? id : null;
    }

    span(id) {
      return this.compiled.spans.get(id) || null;
    }

    stepsOf(id) {
      const x = this.compiled.expanded.get(id);
      return x && x.steps ? x.steps : null;
    }

    lastCells(id) {
      const steps = this.stepsOf(id);
      return steps ? steps[steps.length - 1].cells : [];
    }

    followersOf(id) {
      return this.project.actions.filter((a) => a.after === id);
    }

    issuesOf(id) {
      return this.compiled.issues.filter((i) => i.id === id);
    }

    // Action id's step in frame f, or -1 if it doesn't run then.
    stepIn(id, f = this.frame) {
      const hit = this.compiled.active[f] ? this.compiled.active[f].find((x) => x.id === id) : null;
      return hit ? hit.step : -1;
    }

    cellsIn(id, f = this.frame) {
      const k = this.stepIn(id, f);
      return k < 0 ? [] : this.stepsOf(id)[k].cells;
    }

    // The step of action id nearest to the frame on screen.
    stepNear(id) {
      const k = this.stepIn(id);
      if (k >= 0) return k;
      const span = this.span(id);
      const steps = this.stepsOf(id);
      return span && steps && this.frame > span.to ? steps.length - 1 : 0;
    }

    setLayout(lay) {
      this.cancel();
      this.layout = lay;
      this.ctx = lines.context(lay.rects);
      this.project.layout = lay.id;
      this.recompile();
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

    // --- adding actions -----------------------------------------------------------------------

    // The action a new one starting in frame `frame` with `cells` on carries on from: one that
    // ends on one of those electrodes in that frame (the droplet is handed over) or the frame
    // before. { after, delay, droplet } or null.
    linkFor(cells, frame) {
      let best = null;
      for (const a of this.project.actions) {
        const span = this.span(a.id);
        if (!span || span.cut) continue;
        const delay = frame - span.to;
        if (delay !== 0 && delay !== 1) continue;
        const last = this.lastCells(a.id);
        if (!cells.some((e) => last.includes(e))) continue;
        if (!best || delay <= best.delay) best = { a, delay }; // later actions win ties
      }
      return best ? { after: best.a.id, delay: best.delay, droplet: best.a.droplet || '' } : null;
    }

    // Adds an action that starts in frame `frame` with `cells` on in its first step: after the
    // action it carries on from (taking its droplet name), or at that frame with a new droplet
    // name. The new action is selected. `fields.droplet`, if given, is kept.
    addAction(fields, frame, cells) {
      const p = this.project;
      const a = { id: projects.nextId(p), ...fields };
      const link = this.linkFor(cells, frame);
      if (link) {
        a.after = link.after;
        if (link.delay) a.delay = link.delay;
        if (a.droplet === undefined) a.droplet = link.droplet;
      } else {
        a.start = frame;
        if (a.droplet === undefined) a.droplet = cells.some((e) => e < DROPLET_CELLS) ? projects.nextDroplet(p) : '';
      }
      p.actions.push(a);
      this.selection = a.id;
      return a;
    }

    // --- pointer --------------------------------------------------------------------------------

    // Button pressed at (mx, my). Returns the control that was hit, if any; 'save', 'load' and
    // 'export' need a file dialog, which the caller opens.
    pointerDown(mx, my, { shift = false, now = 0 } = {}) {
      if (this.dragging) this.pointerUp();
      this.notice = null;
      const action = this.controlAt(mx, my);
      if (action) {
        this.run(action, now);
        return action;
      }
      if (this.tool === 'select') {
        this.startEdit(mx, my, shift);
        return null;
      }
      // The path tools start a path on the electrode under the pointer. Nothing changes until
      // the button is released; a click without a drag selects.
      if (this.tool !== 'paint' && !shift) {
        const start = electrodeAt(this.layout.rects, mx, my);
        if (start === null) {
          this.selection = null;
          return null;
        }
        this.draft = new PathDraft(this.layout.rects, this.tool, start, this.frame, { mx, my });
        this.dragging = true;
        return null;
      }
      this.startPaint(mx, my, shift);
      return null;
    }

    pointerMove(mx, my) {
      if (!this.dragging) return false;
      if (this.draft) {
        this.draft.moveTo(mx, my);
        if (this.draft.moved) this.playing = false; // drawing over a moving picture would confuse
      } else if (this.edit) {
        this.moveEdit(mx, my);
      } else if (this.paint) {
        const { mx: x0, my: y0 } = this.lastPoint;
        const samples = Math.max(1, Math.ceil(Math.hypot(mx - x0, my - y0) / DRAG_STEP));
        for (let i = 1; i <= samples; i++) {
          const x = x0 + ((mx - x0) * i) / samples;
          const y = y0 + ((my - y0) * i) / samples;
          if (inArray(x, y)) for (const e of hitTest(this.layout.rects, x, y)) this.paintCell(e);
        }
        this.lastPoint = { mx, my };
      }
      return true;
    }

    // Button released. A drawn path is added now (or extends the selected path, when it was drawn
    // on from that path's free end); an edit or move is applied if it fits. Returns
    // { kind: 'path', from, to, steps, extended } or { kind: 'edit', name, reshaped } for what
    // changed, otherwise null.
    pointerUp() {
      if (!this.dragging) return null;
      this.dragging = false;
      this.lastPoint = null;
      if (this.edit) return this.endEdit();
      if (this.paint) return this.endPaint();
      const draft = this.draft;
      this.draft = null;
      if (!draft) return null;
      if (!draft.moved) {
        this.clickSelect(draft.start);
        return null;
      }
      if (draft.steps === 0) return null; // dragged back to the start
      const sel = this.selected;
      const selSpan = sel && this.span(sel.id);
      const extend = Boolean(
        sel && sel.type === 'path' && selSpan && !selSpan.cut && draft.frame === selSpan.to &&
          this.lastCells(sel.id)[0] === draft.start && !this.followersOf(sel.id).length
      );
      this.change(() => {
        if (extend) {
          const { built } = this.compiled.expanded.get(sel.id);
          const keep = new Map();
          sel.points.forEach((p, i) => {
            const { e, ...extra } = p;
            if (Object.keys(extra).length) keep.set(built.steps[i], extra);
          });
          sel.points = lines.pointsFromRoute(this.ctx.graph, [...built.cells, ...draft.cells.slice(1)], keep);
        } else {
          const points = lines.pointsFromRoute(this.ctx.graph, draft.cells);
          this.addAction({ type: 'path', name: projects.nextName(this.project, 'Path'), points }, draft.frame, [draft.start]);
        }
      });
      const span = this.span(this.selection);
      if (span) this.frame = span.to;
      return { kind: 'path', from: draft.frame, to: draft.endFrame, steps: draft.steps, extended: extend };
    }

    // Esc: drops the path, edit or template being dragged, or takes back the paint drag in
    // progress. Returns whether there was anything to cancel.
    cancel() {
      if (this.placement) {
        this.placement = null;
        return true;
      }
      if (!this.dragging) return false;
      this.dragging = false;
      this.lastPoint = null;
      this.draft = null;
      this.edit = null;
      if (this.paint) {
        this.restore(this.paint.before);
        this.paint = null;
      }
      return true;
    }

    // Esc without anything to cancel lets go of the selection.
    escape() {
      if (this.cancel()) return 'cancelled';
      if (this.selection) {
        this.selection = null;
        return 'deselected';
      }
      return null;
    }

    // --- selecting --------------------------------------------------------------------------------

    // Actions on electrode e: first those with it on in frame f (the latest drawn first), else
    // the paths whose line passes it.
    candidates(e, f = this.frame) {
      const list = [];
      const acts = this.project.actions;
      for (let i = acts.length - 1; i >= 0; i--) if (this.cellsIn(acts[i].id, f).includes(e)) list.push(acts[i].id);
      if (list.length) return list;
      for (let i = acts.length - 1; i >= 0; i--) {
        const x = this.compiled.expanded.get(acts[i].id);
        if (acts[i].type === 'path' && x && x.built && x.built.cells.includes(e)) list.push(acts[i].id);
      }
      return list;
    }

    // A click on electrode e selects what is there; clicking again picks the next one below.
    clickSelect(e) {
      const list = e === null ? [] : this.candidates(e);
      if (!list.length) {
        this.selection = null;
        return null;
      }
      const at = list.indexOf(this.selection);
      this.selection = at >= 0 ? list[(at + 1) % list.length] : list[0];
      return this.selection;
    }

    // --- the select tool: moving actions and reshaping lines --------------------------------

    // What part of action a electrode e grabs: a path's start, end, point or piece (or the whole
    // path with Shift); anything else is moved whole, except a dispense, which stays put.
    grabOn(a, e, whole) {
      const x = this.compiled.expanded.get(a.id);
      if (!x || !x.steps) return null;
      if (a.type === 'path') {
        const part = lines.partAt(x.built, a.points, e, this.stepNear(a.id));
        return part && (whole ? { kind: 'whole' } : part);
      }
      if (!x.steps.some((s) => s.cells.includes(e))) return null;
      return a.type === 'dispense' ? { kind: 'fixed' } : { kind: 'move' };
    }

    startEdit(mx, my, whole) {
      const e = electrodeAt(this.layout.rects, mx, my);
      if (e === null) {
        this.selection = null;
        return;
      }
      let a = this.selected;
      let grab = a ? this.grabOn(a, e, whole) : null;
      const cycle = Boolean(grab);
      if (!grab) {
        const list = this.candidates(e);
        if (!list.length) {
          this.selection = null;
          return;
        }
        this.selection = list[0];
        a = this.selected;
        grab = this.grabOn(a, e, whole);
        if (!grab) return;
      }
      const attached = grab.kind === 'move' ? this.attachedPaths(a.id) : { incoming: [], outgoing: [] };
      this.edit = { id: a.id, grab, from: e, at: e, cycle, attached, preview: null };
      this.dragging = true;
    }

    // Paths attached to action id: those that end on its first electrodes when it starts, and
    // those that start on its last electrodes when it ends. They follow it when it moves.
    attachedPaths(id) {
      const span = this.span(id);
      const steps = this.stepsOf(id);
      const incoming = [];
      const outgoing = [];
      if (!span || !steps) return { incoming, outgoing };
      const first = steps[0].cells;
      const last = steps[steps.length - 1].cells;
      for (const p of this.project.actions) {
        const ps = this.span(p.id);
        const x = this.compiled.expanded.get(p.id);
        if (p.type !== 'path' || p.id === id || !ps || !x || !x.built) continue;
        const cells = x.built.cells;
        if ((ps.to === span.from || ps.to === span.from - 1) && first.includes(cells[cells.length - 1])) incoming.push(p.id);
        if ((ps.from === span.to || ps.from === span.to + 1) && last.includes(cells[0])) outgoing.push(p.id);
      }
      return { incoming, outgoing };
    }

    moveEdit(mx, my) {
      const ed = this.edit;
      const e = electrodeAt(this.layout.rects, mx, my);
      if (e === null || e === ed.at) return;
      ed.at = e;
      this.playing = false;
      if (e === ed.from) {
        ed.preview = null;
        return;
      }
      const c0 = this.ctx.graph.centres.get(ed.from);
      const c1 = this.ctx.graph.centres.get(e);
      ed.preview = this.previewEdit(ed, { dx: c1.x - c0.x, dy: c1.y - c0.y });
    }

    // The actions an edit changes, moved by d grid units, and whether the result fits:
    // { changes: Map(id -> action), compiled, valid, reason, points (for a path that can't be built) }.
    previewEdit(ed, d) {
      const a = this.action(ed.id);
      const changes = new Map();
      const put = (id, fields) => changes.set(id, { ...(changes.get(id) || this.action(id)), ...fields });
      const g = ed.grab;
      if (g.kind === 'fixed') return { changes, valid: false, reason: 'A dispense stays at its reservoir' };
      if (a.type === 'path') {
        let points;
        if (g.kind === 'whole') points = lines.moveLine(this.ctx, a.points, d);
        else if (g.kind === 'piece') points = lines.dragPiece(this.ctx, a.points, g.index, d);
        else if (g.kind === 'start' || g.kind === 'end') points = lines.dragEnd(this.ctx, a.points, g.kind, d);
        else points = lines.dragPoint(this.ctx, a.points, g.index, d);
        if (!points) return { changes, valid: false, reason: 'That would go off the array' };
        put(a.id, { points });
      } else {
        const moved = this.movedAction(a, d);
        if (!moved) return { changes, valid: false, reason: "It doesn't fit there" };
        put(a.id, moved);
        for (const [ids, which] of [[ed.attached.incoming, 'end'], [ed.attached.outgoing, 'start']]) {
          for (const id of ids) {
            const points = lines.dragEnd(this.ctx, (changes.get(id) || this.action(id)).points, which, d);
            if (!points) return { changes, valid: false, reason: `${quote(this.action(id))} can't follow it there` };
            put(id, { points });
          }
        }
      }
      return this.tryChanges(changes);
    }

    // A moved copy of a template or pattern (only the fields that change), or null if it would
    // be off the array. Control lines (magnets) don't move.
    movedAction(a, d) {
      if (a.type === 'template') {
        const at = lines.shift(this.ctx, a.at, d.dx, d.dy);
        return at === null ? null : { at };
      }
      if (a.type !== 'pattern') return null;
      const frames = [];
      for (const cells of a.frames) {
        const out = [];
        for (const e of cells) {
          const n = e >= DROPLET_CELLS ? e : lines.shift(this.ctx, e, d.dx, d.dy);
          if (n === null || (e < DROPLET_CELLS && n >= DROPLET_CELLS)) return null;
          if (!out.includes(n)) out.push(n);
        }
        frames.push(out);
      }
      return { frames };
    }

    // Compiles the project with `changes`: they fit if none of them becomes impossible and nothing
    // new runs past frame 200.
    tryChanges(changes) {
      const trial = { ...this.project, actions: this.project.actions.map((a) => changes.get(a.id) || a) };
      const compiled = compile(trial, this.layout.rects);
      const cutBefore = new Set(this.compiled.issues.filter((i) => i.kind === 'cut').map((i) => i.id));
      const bad = compiled.issues.find(
        (i) => (changes.has(i.id) && i.kind === 'invalid') || (i.kind === 'cut' && !cutBefore.has(i.id))
      );
      let reason = null;
      if (bad) reason = bad.kind === 'cut' ? `${quote(trial.actions.find((x) => x.id === bad.id))} would run past frame ${MAX_FRAMES}` : `It can't go there: ${bad.text}`;
      return { changes, compiled, valid: !bad, reason };
    }

    endEdit() {
      const ed = this.edit;
      this.edit = null;
      if (!ed.preview) {
        if (ed.cycle && ed.at === ed.from) this.clickSelect(ed.from); // a click on it: the next one below
        return null;
      }
      if (!ed.preview.valid) {
        this.notice = ed.preview.reason || "It doesn't fit there";
        return null;
      }
      this.applyChanges(ed.preview.changes);
      const a = this.action(ed.id);
      return { kind: 'edit', name: a.name, reshaped: a.type === 'path' && ed.grab.kind !== 'whole' };
    }

    applyChanges(changes) {
      return this.change(() => {
        this.project.actions = this.project.actions.map((a) => changes.get(a.id) || a);
      });
    }

    // ⌥/Alt + arrow keys: the selected action one electrode across (dx) or down (dy).
    nudge(dx, dy) {
      const a = this.selected;
      if (!a || this.dragging) return false;
      const grab = a.type === 'path' ? { kind: 'whole' } : a.type === 'dispense' ? { kind: 'fixed' } : { kind: 'move' };
      const attached = grab.kind === 'move' ? this.attachedPaths(a.id) : { incoming: [], outgoing: [] };
      const preview = this.previewEdit({ id: a.id, grab, attached }, { dx: dx * PITCH, dy: dy * PITCH });
      if (!preview.valid) {
        this.notice = preview.reason;
        return false;
      }
      return this.applyChanges(preview.changes);
    }

    // Double-click on the selected path: on a piece it adds a point, on a point it removes it.
    doubleClick(mx, my) {
      const a = this.selected;
      if (!a || a.type !== 'path' || this.dragging) return false;
      const e = electrodeAt(this.layout.rects, mx, my);
      const x = this.compiled.expanded.get(a.id);
      if (e === null || !x || !x.built) return false;
      const part = lines.partAt(x.built, a.points, e, this.stepNear(a.id));
      if (!part) return false;
      if (part.kind === 'piece') return this.change(() => (a.points = lines.addPointAt(a.points, x.built, part.step)));
      if (part.kind !== 'point') return false;
      const points = lines.removePoint(this.ctx.graph, a.points, part.index);
      if (!points) {
        this.notice = "That point can't go: the line wouldn't be straight without it";
        return false;
      }
      return this.change(() => (a.points = points));
    }

    // Deletes the selected action. Actions that followed it keep their frames.
    deleteSelected() {
      const a = this.selected;
      if (!a || this.dragging) return false;
      return this.change(() => {
        for (const f of this.followersOf(a.id)) {
          const span = this.span(f.id);
          delete f.after;
          delete f.delay;
          f.start = span ? span.from : 1;
        }
        this.project.actions = this.project.actions.filter((x) => x !== a);
        this.selection = null;
      });
    }

    rename(id, name) {
      const a = this.action(id);
      const value = String(name).trim().slice(0, 80);
      if (!a || !value) return false;
      return this.change(() => (a.name = value));
    }

    // A new droplet name for action id and the actions after it that had the same name.
    setDroplet(id, name) {
      const a = this.action(id);
      if (!a) return false;
      const value = String(name).trim().slice(0, 60);
      const old = a.droplet || '';
      return this.change(() => {
        const seen = new Set();
        const visit = (x) => {
          if (seen.has(x.id)) return;
          seen.add(x.id);
          x.droplet = value;
          for (const f of this.followersOf(x.id)) if ((f.droplet || '') === old) visit(f);
        };
        visit(a);
      });
    }

    // How long each step of action id lasts (ms; 0 = the default frame time).
    setStepTime(id, ms) {
      const a = this.action(id);
      if (!a) return false;
      return this.change(() => {
        if (ms) a.stepTime = clampTime(ms);
        else delete a.stepTime;
      });
    }

    // Whether action id's long steps stretch over frames instead of holding the others up.
    setSplit(id, on) {
      const a = this.action(id);
      if (!a) return false;
      return this.change(() => {
        if (on) a.split = true;
        else delete a.split;
      });
    }

    // --- painting ---------------------------------------------------------------------------------
    // Paint switches electrodes in a pattern: the selected one if it runs in the frame on screen,
    // or ends just before it (it then grows by a frame); otherwise a new one.

    paintTarget(f = this.frame) {
      const a = this.selected;
      if (!a || a.type !== 'pattern') return null;
      const span = this.span(a.id);
      if (!span || span.cut) return null;
      if (f >= span.from && f <= span.to) return { a, k: this.stepIn(a.id, f) };
      if (f === span.to + 1) return { a, k: a.frames.length, grow: true };
      return null;
    }

    startPaint(mx, my, shift) {
      const before = this.checkpoint();
      if (shift) this.nextFrame(); // Shift+click: go to the next frame, then switch on
      if (!inArray(mx, my)) return;
      const hits = hitTest(this.layout.rects, mx, my);
      if (!hits.length) return;
      const target = this.paintTarget();
      const has = target && !target.grow && target.a.frames[target.k].includes(hits[0]);
      this.paint = { before, on: shift || !has, id: target ? target.a.id : null };
      this.dragging = true;
      this.lastPoint = { mx, my };
      for (const e of hits) this.paintCell(e);
    }

    paintCell(e) {
      const p = this.paint;
      const target = this.paintTarget();
      const a = target && target.a.id === p.id ? target.a : null;
      if (!p.on) {
        const i = a && !target.grow ? a.frames[target.k].indexOf(e) : -1;
        if (i < 0) {
          this.ownerNotice(e);
          return;
        }
        a.frames[target.k].splice(i, 1);
      } else if (!a) {
        if (p.id) return; // the pattern being painted no longer covers this frame
        const made = this.addAction({ type: 'pattern', name: projects.nextName(this.project, 'Pattern'), frames: [[e]] }, this.frame, [e]);
        p.id = made.id;
      } else {
        if (target.grow) a.frames.push([]);
        const cells = a.frames[target.grow ? a.frames.length - 1 : target.k];
        if (cells.includes(e)) return;
        cells.push(e);
      }
      this.recompile();
    }

    // Paint-off over another action's electrode: say whose it is.
    ownerNotice(e) {
      const owners = this.candidates(e).map((id) => this.action(id)).filter((a) => a.id !== (this.paint && this.paint.id));
      if (owners.length) this.notice = `Electrode ${e} is part of ${owners.map(quote).join(' and ')}: select it to move or delete it`;
    }

    endPaint() {
      const p = this.paint;
      this.paint = null;
      const a = p.id ? this.action(p.id) : null;
      if (a) this.tidyPattern(a);
      this.recompile();
      this.record(p.before);
      return null;
    }

    // Drops a pattern's empty frames at the end, and the pattern itself if nothing is left.
    tidyPattern(a) {
      while (a.frames.length > 1 && !a.frames[a.frames.length - 1].length) a.frames.pop();
      if (Array.isArray(a.times)) a.times = a.times.slice(0, a.frames.length);
      if (!a.frames.some((cells) => cells.length)) {
        this.project.actions = this.project.actions.filter((x) => x !== a);
        if (this.selection === a.id) this.selection = null;
      }
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

    // Adds the template where it is (a copy goes into the project file) and moves to its last
    // frame. Returns { from, to, steps }, or null if it doesn't fit.
    dropPlacement() {
      const p = this.placement;
      const spot = p && p.spot;
      this.placement = null;
      if (!spot || !spot.valid) return null;
      const t = p.template;
      this.change(() => {
        const fields = { type: 'template', name: t.name, template: projects.embedTemplate(this.project, t), at: spot.anchor, turns: p.turns };
        if (t.times && t.times.some(Boolean)) fields.times = t.times.slice();
        this.addAction(fields, spot.frame, spot.frames[0]);
      });
      const span = this.span(this.selection);
      if (span) this.frame = span.to;
      return { from: spot.frame, to: span ? span.to : spot.endFrame, steps: spot.steps };
    }

    // --- making a template -----------------------------------------------------------------------
    // The main project is set aside with its undo history, and the template is drawn in a blank
    // one with all the usual tools. An existing template comes in as a selected pattern.

    get makingTemplate() {
      return this.saved !== null;
    }

    startTemplate(seq = null) {
      this.cancel();
      if (!this.saved) {
        this.saved = { project: this.project, frame: this.frame, undoStack: this.undoStack, redoStack: this.redoStack, selection: this.selection };
      }
      this.project = projects.newProject({ layout: this.layout.id, frameTime: this.project.frameTime });
      this.selection = null;
      if (seq) {
        const a = { id: projects.nextId(this.project), ...importSequence(seq, 'Template') };
        this.project.actions.push(a);
        this.selection = a.id;
      }
      this.frame = 1;
      this.undoStack = [];
      this.redoStack = [];
      this.playing = false;
      this.recompile();
    }

    endTemplate() {
      if (!this.saved) return;
      this.cancel();
      this.saved.project.frameTime = this.project.frameTime; // the default frame time is a setting
      ({ project: this.project, frame: this.frame, undoStack: this.undoStack, redoStack: this.redoStack, selection: this.selection } = this.saved);
      this.saved = null;
      this.playing = false;
      this.recompile();
    }

    // --- undo ----------------------------------------------------------------------------------
    // Each change keeps a copy of the actions (and the templates they use) from before it, with
    // the frame and selection of that moment.

    state() {
      return JSON.stringify({ actions: this.project.actions, templates: this.project.templates });
    }

    checkpoint() {
      return { state: this.state(), frame: this.frame, selection: this.selection };
    }

    restore(point) {
      const { actions, templates: kept } = JSON.parse(point.state);
      this.project.actions = actions;
      this.project.templates = kept;
      this.frame = point.frame;
      this.selection = point.selection && this.action(point.selection) ? point.selection : null;
      this.recompile();
    }

    // Keeps `before` for undo if the project has changed since it was taken.
    record(before) {
      if (!before || before.state === this.state()) return false;
      this.undoStack.push(before);
      if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
      this.redoStack.length = 0;
      return true;
    }

    change(fn) {
      const before = this.checkpoint();
      fn();
      this.recompile();
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
      this.restore(target);
      return true;
    }

    // --- playback and time -------------------------------------------------------------------------

    // The original's "interval": the default frame time as frames per minute.
    get speed() {
      return 60000 / this.project.frameTime;
    }

    // One wheel step: +1 = towards you (down), -1 = away (up). While playing it changes the
    // speed by 5 frames/min, as in the original; otherwise up goes to the next frame and down
    // to the previous one.
    wheel(count) {
      if (this.playing) {
        const speed = Math.min(MAX_SPEED, Math.max(MIN_SPEED, Math.round(this.speed) - count * 5));
        this.setDefaultTime(Math.round(60000 / speed));
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

    // The default frame time is a setting: it isn't undone.
    setDefaultTime(ms) {
      this.project.frameTime = clampTime(ms);
      this.recompile();
    }

    // Frame f's time (ms; 0 = back to the default), set on the selected action if it runs in
    // frame f, otherwise on the actions in it that aren't split. On a path it is a wait at the
    // electrode the droplet is on, on other actions that step's own time. Returns the actions it
    // was set on (empty if nothing runs in frame f).
    setFrameTime(f, ms) {
      const act = this.compiled.active[f] || [];
      let targets = act.filter((x) => x.id === this.selection);
      if (!targets.length) targets = act.filter((x) => !this.action(x.id).split);
      if (!targets.length) targets = act;
      if (!targets.length) return [];
      this.change(() => {
        for (const { id, step } of targets) {
          const a = this.action(id);
          if (a.type === 'path') {
            const { built } = this.compiled.expanded.get(id);
            a.points = ms ? lines.addPointAt(a.points, built, step, { wait: clampTime(ms) }) : lines.clearWaitAt(this.ctx.graph, a.points, built, step);
            continue;
          }
          const n = this.stepsOf(id).length;
          const times = Array.isArray(a.times) ? a.times.slice(0, n) : [];
          while (times.length < n) times.push(0);
          times[step] = ms ? clampTime(ms) : 0;
          if (times.some(Boolean)) a.times = times;
          else delete a.times;
        }
      });
      return targets.map(({ id }) => this.action(id));
    }

    // Advances playback, each frame staying for its own time; returns true when the frame
    // changed. Loops back to frame 1.
    tick(now) {
      if (!this.playing || now - this.playStart <= this.frameMs) return false;
      this.playStart = now;
      this.frame = this.frame < this.playLast ? this.frame + 1 : 1;
      return true;
    }

    // --- buttons ---------------------------------------------------------------------------------

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
          if (f > 1) this.copyLastFrame(f);
          break;
        case 'clearFrame':
          this.clearFrame(f);
          break;
        case 'clearAll':
          this.playing = false; // nothing is left to play
          this.change(() => {
            this.project.actions = [];
            this.selection = null;
            this.frame = 1;
          });
          break;
        default: {
          const control = CONTROLS.find((c) => c.action === action);
          if (control && control.tool) this.setTool(control.tool);
          else if (RESERVOIR_STEPS[action]) this.dispense(action);
        }
      }
    }

    // A reservoir button: a dispense action from the frame on screen; the view moves to its end.
    dispense(reservoir) {
      this.change(() => {
        this.addAction({ type: 'dispense', name: `Dispense ${RESERVOIR_NAMES[reservoir]}`, droplet: projects.nextDroplet(this.project), reservoir }, this.frame, []);
      });
      const span = this.span(this.selection);
      if (span) this.frame = span.to;
    }

    // Everything on in the previous frame goes into the pattern being painted (a new one if none).
    copyLastFrame(f) {
      const prev = [];
      for (let e = 0; e < CELLS; e++) if (this.seq.get(e, f - 1)) prev.push(e);
      if (!prev.length) return false;
      return this.change(() => {
        const target = this.paintTarget(f);
        if (!target) {
          this.addAction({ type: 'pattern', name: projects.nextName(this.project, 'Pattern'), frames: [prev] }, f, prev);
          return;
        }
        if (target.grow) target.a.frames.push([]);
        const cells = target.a.frames[target.grow ? target.a.frames.length - 1 : target.k];
        for (const e of prev) if (!cells.includes(e)) cells.push(e);
      });
    }

    // Empties frame f of the patterns in it. Other actions can't lose a frame: the status line
    // names them.
    clearFrame(f) {
      const others = [];
      this.change(() => {
        for (const { id, step } of this.compiled.active[f]) {
          const a = this.action(id);
          if (a.type !== 'pattern') {
            others.push(a);
            continue;
          }
          a.frames[step] = [];
          this.tidyPattern(a);
        }
      });
      if (others.length) this.notice = `Still on in frame ${f}: ${others.map(quote).join(', ')}. Select to move or delete.`;
    }

    // --- files -------------------------------------------------------------------------------------

    // Opening a project: undoable, like loading was. Its default frame time comes along (a
    // setting); its layout is set by the caller.
    openProject(project) {
      this.cancel();
      this.change(() => {
        for (const k of Object.keys(project)) if (k !== 'frameTime' && k !== 'layout') this.project[k] = project[k];
        this.selection = null;
        this.frame = 1;
      });
      this.project.frameTime = project.frameTime;
      this.recompile();
    }

    // Opening an OpenDrop file: one pattern holding all its frames. A file with frame times also
    // brings its default frame time; one without keeps the current default.
    openSequence(seq, { timed = false, name = 'Imported' } = {}) {
      this.cancel();
      this.change(() => {
        const empty = seq.lastFrame() === 1 && seq.isEmpty(1);
        this.project.actions = empty ? [] : [{ id: 'a1', ...importSequence(seq, name) }];
        this.project.templates = {};
        this.selection = null;
        this.frame = 1;
      });
      if (timed) this.setDefaultTime(seq.frameTime);
    }
  }

  return { Editor, CONTROLS, RESERVOIR_STEPS, TOOLS, UNDO_LIMIT, MIN_SPEED, MAX_SPEED };
});
