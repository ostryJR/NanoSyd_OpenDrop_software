/* Editing and playback behaviour, ported from mousePressed, mouseDragged, mouseWheel, keyPressed
 * and animate in OpenDropController4_25.pde. What you draw is kept as actions in a project (a path
 * as a line, a template where it was dropped, a dispense, a painted pattern), and the frames are
 * compiled from them after every change. A change that would make droplets of different actions
 * touch is refused. No DOM here: app.js passes in grid coordinates. */
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
  const { PathDraft, electrodeAt, straightRoute } = paths;
  const { place } = templates;
  const { compile, expand, importSequence, predsOf, RESERVOIR_STEPS, RESERVOIR_NAMES } = compiler;

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
  // move what is drawn. The selected path can be reshaped with the path tools too.
  const TOOLS = ['freehand', 'straight', 'paint', 'select'];
  const UNDO_LIMIT = 100;
  const MIN_SPEED = 5; // frames per minute
  const MAX_SPEED = 600;
  const DRAG_STEP = 0.25; // grid units between paint samples, so fast drags don't skip electrodes
  const PITCH = 2; // grid units from one standard electrode to the next

  const quote = (a) => `“${a.name}”`;
  const pairKey = (x, y) => (x < y ? `${x}|${y}` : `${y}|${x}`);
  const extrasOf = ({ e, ...extra }) => extra;

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
      this.draft = null; // the path being drawn (or a path being drawn on), shown but not yet added
      this.paint = null; // a paint drag: { before, on, id }
      this.edit = null; // a move or reshape drag: { id, grab, from, at, cycle, attached, preview }
      this.placement = null; // a template being dragged over the array
      this.pending = null; // Shift+click drawing: the start of the next path, { e, frame }
      this.selection = null; // id of the selected action
      this.saved = null; // the main project, set aside while a template is being made
      this.undoStack = [];
      this.redoStack = [];
      this.notice = null; // a warning for the status line from the last operation, if any
      this.info = null; // what the last operation did, for the status line, if any
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

    firstCells(id) {
      const steps = this.stepsOf(id);
      return steps ? steps[0].cells : [];
    }

    followersOf(id) {
      return this.project.actions.filter((a) => (predsOf(a) || []).includes(id));
    }

    // Action id and everything that follows it, directly or through others.
    chainOf(id) {
      const out = [id];
      for (let i = 0; i < out.length; i++) for (const f of this.followersOf(out[i])) if (!out.includes(f.id)) out.push(f.id);
      return out;
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

    centre(e) {
      return this.ctx.graph.centres.get(e);
    }

    // Grid units from electrode a's centre to electrode b's.
    offset(a, b) {
      const ca = this.centre(a);
      const cb = this.centre(b);
      return { dx: cb.x - ca.x, dy: cb.y - ca.y };
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

    // --- checking changes ---------------------------------------------------------------------
    // Nothing may make droplets of different actions touch, or run past frame 200, that didn't
    // before. Taking things away (deleting, clearing) is always allowed.

    // Why compile result `next` (of a project with `actions`) can't be kept, compared with the
    // project as it is; null if it can.
    blockReason(next, actions = this.project.actions) {
      const name = (id) => {
        const a = actions.find((x) => x.id === id);
        return a ? quote(a) : id;
      };
      const pair = [...next.touches].find((k) => !this.compiled.touches.has(k));
      if (pair) {
        const t = next.issues.find((i) => i.kind === 'touch' && pairKey(i.id, i.other) === pair);
        return `${name(t.id)} and ${name(t.other)} would touch in frame ${t.frame}`;
      }
      const cutBefore = new Set(this.compiled.issues.filter((i) => i.kind === 'cut').map((i) => i.id));
      const cut = next.issues.find((i) => i.kind === 'cut' && !cutBefore.has(i.id));
      return cut ? `${name(cut.id)} would run past frame ${MAX_FRAMES}` : null;
    }

    // The project with `changes` (Map id -> action) and `extra` new actions, compiled, and whether
    // that may be kept: { changes, extra, compiled, valid, reason }.
    tryChanges(changes, extra = [], templatesToo = null) {
      const actions = this.project.actions.map((a) => changes.get(a.id) || a).concat(extra);
      const trial = { ...this.project, actions, templates: templatesToo ? { ...this.project.templates, ...templatesToo } : this.project.templates };
      const compiled = compile(trial, this.layout.rects);
      const ids = new Set([...changes.keys(), ...extra.map((a) => a.id)]);
      const bad = compiled.issues.find((i) => ids.has(i.id) && i.kind === 'invalid');
      const reason = bad ? `It can't go there: ${bad.text}` : this.blockReason(compiled, actions);
      return { changes, extra, compiled, valid: !reason, reason };
    }

    // --- adding actions -----------------------------------------------------------------------

    // What a new action starting in frame `frame` with `cells` on carries on from: for each of
    // those electrodes, the latest action that ended on it by then, unless something has taken
    // that droplet since. { after (an id, or a list for a merge), delay, droplet } or null.
    linkFor(cells, frame) {
      const found = new Map(); // electrode -> { a, to }
      for (const a of this.project.actions) {
        const span = this.span(a.id);
        if (!span || span.cut || span.to > frame) continue;
        for (const e of this.lastCells(a.id)) {
          if (e >= DROPLET_CELLS || !cells.includes(e)) continue;
          const taken = this.project.actions.some((b) => {
            const sb = b !== a && this.span(b.id);
            return sb && sb.from >= span.to && sb.from <= frame && this.firstCells(b.id).includes(e);
          });
          const prev = found.get(e);
          if (!taken && (!prev || span.to >= prev.to)) found.set(e, { a, to: span.to });
        }
      }
      const picked = [...new Set([...found.values()].map((x) => x.a))];
      if (!picked.length) return null;
      const last = Math.max(...picked.map((a) => this.span(a.id).to));
      const names = [...new Set(picked.map((a) => a.droplet).filter(Boolean))];
      return {
        after: picked.length === 1 ? picked[0].id : picked.map((a) => a.id),
        delay: frame - last,
        droplet: names.join(' + '),
      };
    }

    // An action that starts in frame `frame` with `cells` on in its first step: after the action
    // it carries on from (taking its droplet name), or at that frame with a new droplet name.
    // `fields.droplet`, if given, is kept.
    newAction(fields, frame, cells) {
      const a = { id: projects.nextId(this.project), ...fields };
      const link = this.linkFor(cells, frame);
      if (link) {
        a.after = link.after;
        if (link.delay) a.delay = link.delay;
        if (a.droplet === undefined) a.droplet = link.droplet;
      } else {
        a.start = frame;
        if (a.droplet === undefined) a.droplet = cells.some((e) => e < DROPLET_CELLS) ? projects.nextDroplet(this.project) : '';
      }
      return a;
    }

    // Adds an action (see newAction) and selects it.
    addAction(fields, frame, cells) {
      const a = this.newAction(fields, frame, cells);
      this.project.actions.push(a);
      this.selection = a.id;
      return a;
    }

    // --- pointer --------------------------------------------------------------------------------

    // Button pressed at (mx, my). Shift with a path tool draws corner by corner, Shift with the
    // select tool (or Alt+Shift) moves a whole chain; Alt with any tool moves or reshapes like the
    // select tool. Returns the control that was hit, if any; 'save', 'load' and 'export' need a
    // file dialog, which the caller opens.
    pointerDown(mx, my, { shift = false, alt = false, now = 0 } = {}) {
      if (this.dragging) this.pointerUp();
      this.notice = null;
      this.info = null;
      const action = this.controlAt(mx, my);
      if (action) {
        this.run(action, now);
        return action;
      }
      const drawing = this.tool === 'freehand' || this.tool === 'straight';
      if (!(drawing && shift && !alt)) this.pending = null;
      if (this.tool === 'select' || alt) {
        this.startEdit(mx, my, shift);
        return null;
      }
      if (drawing && shift) {
        this.cornerClick(mx, my);
        return null;
      }
      if (drawing) {
        this.startDrawing(mx, my);
        return null;
      }
      this.startPaint(mx, my, shift);
      return null;
    }

    pointerMove(mx, my) {
      if (!this.dragging) return false;
      if (this.draft) {
        const before = this.draft.cells.join(',');
        this.draft.moveTo(mx, my);
        if (this.draft.moved) this.playing = false; // drawing over a moving picture would confuse
        if (this.draft.cells.join(',') !== before) this.draft.check = this.draft.moved && this.draft.steps > 0 ? this.checkDraft() : null;
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

    // Button released. A drawn path is added now (or the selected path is drawn on); an edit or
    // move is applied if it fits. Returns { kind: 'path', from, to, steps, extended } or
    // { kind: 'edit', name, reshaped } for what changed, otherwise null.
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
        this.clickSelect(draft.extends ? this.lastCellOf(draft) : draft.start);
        return null;
      }
      if (draft.steps === 0) {
        if (draft.extends) this.notice = 'A path needs at least one step';
        return null; // dragged back to the start
      }
      const check = this.checkDraft(draft);
      if (!check.valid) {
        this.notice = check.reason;
        return null;
      }
      const done = check.extra.length
        ? this.change(() => {
            this.project.actions.push(check.extra[0]);
            this.selection = check.extra[0].id;
          })
        : this.applyChanges(check.changes);
      if (!done) return null;
      const span = this.span(this.selection);
      if (span) this.frame = span.to;
      return { kind: 'path', from: draft.frame, to: draft.endFrame, steps: draft.steps, extended: Boolean(draft.extends) };
    }

    lastCellOf(draft) {
      return draft.cells[draft.cells.length - 1];
    }

    // Esc: drops the path, edit or template being dragged, or takes back the paint drag in
    // progress. Returns whether there was anything to cancel.
    cancel() {
      if (this.placement) {
        this.placement = null;
        return true;
      }
      if (this.pending) {
        this.pending = null;
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

    // --- drawing paths ---------------------------------------------------------------------------

    // A path tool pressed on the array: on the selected path's line it reshapes it (from its free
    // end it draws on, or back); anywhere else it starts a new path. Nothing changes until the
    // button is released; a click without a drag selects.
    startDrawing(mx, my) {
      const e = electrodeAt(this.layout.rects, mx, my);
      if (e === null) {
        this.selection = null;
        return;
      }
      const sel = this.selected;
      const grab = sel && sel.type === 'path' ? this.grabOn(sel, e, false) : null;
      if (grab && grab.kind === 'end' && !this.followersOf(sel.id).length) {
        this.startDrawingOn(sel, mx, my);
        return;
      }
      if (grab) {
        this.beginEdit(sel, grab, e, true);
        return;
      }
      this.draft = new PathDraft(this.layout.rects, this.tool, e, this.frame, { mx, my });
      this.dragging = true;
    }

    // Drawing on from the selected path's free end: freehand follows the pointer and goes back
    // along the path when the pointer does; straight adds lines from the end.
    startDrawingOn(path, mx, my) {
      const { built } = this.compiled.expanded.get(path.id);
      const span = this.span(path.id);
      let draft;
      if (this.tool === 'freehand') {
        draft = new PathDraft(this.layout.rects, 'freehand', built.cells[0], span.from, { mx, my });
        draft.cells = built.cells.slice();
      } else {
        draft = new PathDraft(this.layout.rects, 'straight', built.cells[built.cells.length - 1], span.to, { mx, my });
        draft.base = built.cells;
      }
      draft.extends = path.id;
      this.draft = draft;
      this.dragging = true;
    }

    // The path a draft gives, and whether it may be added: { changes or extra, compiled, valid, reason }.
    checkDraft(draft = this.draft) {
      if (draft.extends) {
        const path = this.action(draft.extends);
        const { built } = this.compiled.expanded.get(path.id);
        const cells = draft.base ? [...draft.base, ...draft.cells.slice(1)] : draft.cells;
        const keep = new Map();
        path.points.forEach((p, i) => {
          const k = built.steps[i];
          if (Object.keys(extrasOf(p)).length && cells[k] === built.cells[k]) keep.set(k, extrasOf(p));
        });
        return this.tryChanges(new Map([[path.id, { ...path, points: lines.pointsFromRoute(this.ctx.graph, cells, keep) }]]));
      }
      const fields = { type: 'path', name: projects.nextName(this.project, 'Path'), points: lines.pointsFromRoute(this.ctx.graph, draft.cells) };
      return this.tryChanges(new Map(), [this.newAction(fields, draft.frame, [draft.start])]);
    }

    // Shift+click with a path tool, corner by corner: the first click picks where a new path
    // starts (in the frame on screen), each next one adds a straight piece to the clicked
    // electrode (two at a right angle if it isn't in line). With a path selected whose end is
    // free, the clicks carry on from its end.
    cornerClick(mx, my) {
      const e = electrodeAt(this.layout.rects, mx, my);
      if (e === null) return;
      // Two pieces at a right angle: the first carries on the way the path was going (or, at the
      // start, along the longer side).
      const route = (from, to, before = null) => {
        const { dx, dy } = before === null ? this.offset(from, to) : this.offset(before, from);
        return straightRoute(this.ctx.graph, from, to, Math.abs(dx) >= Math.abs(dy) ? 'h' : 'v');
      };
      const p = this.pending;
      if (p) {
        if (e === p.e) {
          this.pending = null;
          return;
        }
        const cells = route(p.e, e);
        if (!cells) {
          this.notice = `A droplet can't get from ${p.e} to ${e}`;
          return;
        }
        const fields = { type: 'path', name: projects.nextName(this.project, 'Path'), points: lines.pointsFromRoute(this.ctx.graph, cells) };
        const check = this.tryChanges(new Map(), [this.newAction(fields, p.frame, [p.e])]);
        if (!check.valid) {
          this.notice = check.reason;
          return;
        }
        this.pending = null;
        this.change(() => {
          this.project.actions.push(check.extra[0]);
          this.selection = check.extra[0].id;
        });
      } else {
        const sel = this.selected;
        if (!sel || sel.type !== 'path' || this.followersOf(sel.id).length) {
          this.pending = { e, frame: this.frame };
          this.selection = null;
          this.notice = 'Shift+click where the droplet goes next; Esc stops';
          return;
        }
        const { built } = this.compiled.expanded.get(sel.id);
        const end = built.cells[built.cells.length - 1];
        if (e === end) return;
        const cells = route(end, e, built.cells.length > 1 ? built.cells[built.cells.length - 2] : null);
        if (!cells) {
          this.notice = `A droplet can't get from ${end} to ${e}`;
          return;
        }
        const keep = new Map(sel.points.map((q, i) => [built.steps[i], extrasOf(q)]).filter(([, x]) => Object.keys(x).length));
        const points = lines.pointsFromRoute(this.ctx.graph, [...built.cells, ...cells.slice(1)], keep);
        const check = this.tryChanges(new Map([[sel.id, { ...sel, points }]]));
        if (!check.valid) {
          this.notice = check.reason;
          return;
        }
        this.applyChanges(check.changes);
      }
      const span = this.span(this.selection);
      if (span) this.frame = span.to;
      const a = this.selected;
      if (a && span) this.info = `${quote(a)}: frames ${span.from} to ${span.to}. Shift+click the next corner, Esc to stop`;
    }

    // --- moving actions and reshaping lines ------------------------------------------------------

    // What part of action a electrode e grabs: a path's start, end, point or piece; anything else
    // is moved whole, except a dispense, which stays put. With `chain`, the action and everything
    // that follows it move together.
    grabOn(a, e, chain) {
      const x = this.compiled.expanded.get(a.id);
      if (!x || !x.steps) return null;
      if (a.type === 'path') {
        const part = lines.partAt(x.built, a.points, e, this.stepNear(a.id));
        return part && (chain ? { kind: 'chain' } : part);
      }
      if (!x.steps.some((s) => s.cells.includes(e))) return null;
      if (a.type === 'dispense') return { kind: 'fixed' };
      return chain ? { kind: 'chain' } : { kind: 'move' };
    }

    startEdit(mx, my, chain) {
      const e = electrodeAt(this.layout.rects, mx, my);
      if (e === null) {
        this.selection = null;
        return;
      }
      let a = this.selected;
      let grab = a ? this.grabOn(a, e, chain) : null;
      const cycle = Boolean(grab);
      if (!grab) {
        const list = this.candidates(e);
        if (!list.length) {
          this.selection = null;
          return;
        }
        this.selection = list[0];
        a = this.selected;
        grab = this.grabOn(a, e, chain);
        if (!grab) return;
      }
      this.beginEdit(a, grab, e, cycle);
    }

    beginEdit(a, grab, e, cycle) {
      const attached = grab.kind === 'move' || grab.kind === 'chain' ? this.attachedPaths(a.id) : { incoming: [], outgoing: [] };
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
      ed.preview = e === ed.from ? null : this.previewEdit(ed, this.offset(ed.from, e));
    }

    // The attached paths of `station` (its old version in the project) re-routed so they still
    // meet its new version `moved`: each path's end moves with the electrode it was on. Adds them
    // to `changes`; returns a reason if one can't follow.
    followAttached(changes, station, moved, attached, templatesToo = null) {
      const oldSteps = this.stepsOf(station.id);
      const trial = templatesToo ? { ...this.project, templates: { ...this.project.templates, ...templatesToo } } : this.project;
      const x = expand(moved, trial, this.ctx);
      if (!oldSteps || !x.steps) return null;
      const ends = [
        [attached.incoming, 'end', oldSteps[0].cells, x.steps[0].cells],
        [attached.outgoing, 'start', oldSteps[oldSteps.length - 1].cells, x.steps[x.steps.length - 1].cells],
      ];
      for (const [ids, which, before, after] of ends) {
        for (const id of ids) {
          if (changes.has(id) && changes.get(id).moved) continue; // moves with a chain
          const path = changes.get(id) || this.action(id);
          const { built } = this.compiled.expanded.get(id);
          const cell = which === 'end' ? built.cells[built.cells.length - 1] : built.cells[0];
          const i = before.indexOf(cell);
          if (i < 0 || after[i] === undefined) continue;
          const points = lines.dragEnd(this.ctx, path.points, which, this.offset(cell, after[i]));
          if (!points) return `${quote(path)} can't follow it there`;
          changes.set(id, { ...path, points });
        }
      }
      return null;
    }

    // The actions an edit changes, moved by d grid units, and whether the result may be kept:
    // { changes: Map(id -> action), compiled, valid, reason }.
    previewEdit(ed, d) {
      const a = this.action(ed.id);
      const changes = new Map();
      const invalid = (reason) => ({ changes, valid: false, reason });
      const g = ed.grab;
      if (g.kind === 'fixed') return invalid('A dispense stays at its reservoir');
      if (g.kind === 'chain') {
        for (const id of this.chainOf(a.id)) {
          const x = this.action(id);
          if (x.type === 'dispense') return invalid(`${quote(x)} stays at its reservoir`);
          const moved = x.type === 'path' ? this.movedLine(x, d) : this.movedAction(x, d);
          if (!moved) return invalid(`${quote(x)} would go off the array`);
          changes.set(id, { ...x, ...moved, moved: true });
        }
        const head = changes.get(a.id);
        const why = this.followAttached(changes, a, head, { incoming: ed.attached.incoming, outgoing: [] });
        if (why) return invalid(why);
        for (const [id, x] of changes) {
          const { moved, ...rest } = x;
          changes.set(id, rest);
        }
        return this.tryChanges(changes);
      }
      if (a.type === 'path') {
        let points;
        if (g.kind === 'whole') points = lines.moveLine(this.ctx, a.points, d);
        else if (g.kind === 'piece') points = lines.dragPiece(this.ctx, a.points, g.index, d);
        else if (g.kind === 'start' || g.kind === 'end') points = lines.dragEnd(this.ctx, a.points, g.kind, d);
        else points = lines.dragPoint(this.ctx, a.points, g.index, d);
        if (!points) return invalid('That would go off the array');
        changes.set(a.id, { ...a, points });
        return this.tryChanges(changes);
      }
      const moved = this.movedAction(a, d);
      if (!moved) return invalid("It doesn't fit there");
      const next = { ...a, ...moved };
      changes.set(a.id, next);
      const why = this.followAttached(changes, a, next, ed.attached);
      return why ? invalid(why) : this.tryChanges(changes);
    }

    movedLine(path, d) {
      const points = lines.moveLine(this.ctx, path.points, d);
      return points && { points };
    }

    // A moved copy of a template or pattern (only the fields that change), or null if it would
    // be off the array. Control lines (magnets) don't move.
    movedAction(a, d) {
      if (a.type === 'template') {
        const at = lines.shift(this.ctx, a.at, d.dx, d.dy);
        return at === null ? null : { at };
      }
      if (a.type !== 'pattern') return null;
      const frames = this.mapPattern(a, (e) => lines.shift(this.ctx, e, d.dx, d.dy));
      return frames && { frames };
    }

    // A pattern's frames with each droplet electrode passed through fn (control lines stay), or
    // null if one lands off the array.
    mapPattern(a, fn) {
      const frames = [];
      for (const cells of a.frames) {
        const out = [];
        for (const e of cells) {
          const n = e >= DROPLET_CELLS ? e : fn(e);
          if (n === null || n === undefined || (e < DROPLET_CELLS && n >= DROPLET_CELLS)) return null;
          if (!out.includes(n)) out.push(n);
        }
        frames.push(out);
      }
      return frames;
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
      return { kind: 'edit', name: a.name, reshaped: a.type === 'path' && ed.grab.kind !== 'whole' && ed.grab.kind !== 'chain' };
    }

    applyChanges(changes, templatesToo = null) {
      return this.change(() => {
        if (templatesToo) this.project.templates = { ...this.project.templates, ...templatesToo };
        this.project.actions = this.project.actions.map((a) => changes.get(a.id) || a);
      });
    }

    // Runs a prepared check: applies it if it may be kept, otherwise says why.
    commit(check, templatesToo = null) {
      if (!check.valid) {
        this.notice = check.reason;
        return false;
      }
      return this.applyChanges(check.changes, templatesToo);
    }

    // ⌥/Alt + arrow keys: the selected action one electrode across (dx) or down (dy); with
    // `chain`, together with everything that follows it.
    nudge(dx, dy, { chain = false } = {}) {
      const a = this.selected;
      if (!a || this.dragging) return false;
      let grab = a.type === 'dispense' ? { kind: 'fixed' } : a.type === 'path' ? { kind: 'whole' } : { kind: 'move' };
      if (chain && a.type !== 'dispense') grab = { kind: 'chain' };
      const attached = grab.kind === 'move' || grab.kind === 'chain' ? this.attachedPaths(a.id) : { incoming: [], outgoing: [] };
      return this.commit(this.previewEdit({ id: a.id, grab, attached }, { dx: dx * PITCH, dy: dy * PITCH }));
    }

    // R: the selected action a quarter turn (dir 1 = clockwise, -1 = back): a template around the
    // electrode it was dropped on, a path around its start, a pattern around its first electrode.
    // Paths attached to a template or pattern follow it.
    rotateSelected(dir = 1) {
      const a = this.selected;
      if (!a || this.dragging) return false;
      if (a.type === 'dispense') {
        this.notice = 'A dispense stays at its reservoir';
        return false;
      }
      const turn = (around, e) => {
        const { dx, dy } = this.offset(around, e);
        const [rx, ry] = dir > 0 ? [-dy, dx] : [dy, -dx];
        const c = this.centre(around);
        return electrodeAt(this.layout.rects, c.x + rx, c.y + ry);
      };
      let moved;
      if (a.type === 'template') moved = { turns: (((a.turns || 0) + dir) % 4 + 4) % 4 };
      else if (a.type === 'path') {
        const start = a.points[0].e;
        const points = a.points.map((p) => ({ ...p, e: turn(start, p.e) }));
        moved = points.every((p) => p.e !== null) ? { points } : null;
      } else {
        const anchor = a.frames.flat().find((e) => e < DROPLET_CELLS);
        const frames = anchor === undefined ? null : this.mapPattern(a, (e) => turn(anchor, e));
        moved = frames && { frames };
      }
      if (!moved) {
        this.notice = "It doesn't fit there turned";
        return false;
      }
      const next = { ...a, ...moved };
      const changes = new Map([[a.id, next]]);
      if (a.type !== 'path') {
        const why = this.followAttached(changes, a, next, this.attachedPaths(a.id));
        if (why) {
          this.notice = why;
          return false;
        }
      }
      return this.commit(this.tryChanges(changes));
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
      return this.commit(this.tryChanges(new Map([[a.id, { ...a, points }]])));
    }

    // Deletes the selected action. Actions that followed it keep their frames.
    deleteSelected() {
      const a = this.selected;
      if (!a || this.dragging) return false;
      return this.change(() => {
        for (const f of this.followersOf(a.id)) {
          // Still after the others it waits for, if that keeps its frames; else at its frame.
          const preds = predsOf(f).filter((id) => id !== a.id);
          const span = this.span(f.id);
          const ends = preds.map((id) => this.span(id)).filter(Boolean).map((s) => s.to);
          const delay = span && ends.length === preds.length && ends.length ? span.from - Math.max(...ends) : -1;
          if (delay >= 0) {
            f.after = preds.length === 1 ? preds[0] : preds;
            if (delay) f.delay = delay;
            else delete f.delay;
            continue;
          }
          delete f.after;
          delete f.delay;
          f.start = span ? span.from : 1;
        }
        this.project.actions = this.project.actions.filter((x) => x !== a);
        this.selection = null;
      }, { check: false });
    }

    // --- time ---------------------------------------------------------------------------------------
    // An action starts at a fixed frame, or after the action(s) it follows plus a delay. Moving a
    // linked action in time changes its delay, which can't go below 0: it can't start before
    // what it follows has ended.

    // The fields that make action id start in `frame`, or null (with a notice) if it can't.
    startFields(id, frame) {
      const a = this.action(id);
      const preds = predsOf(a);
      if (!preds) return { start: Math.min(MAX_FRAMES, Math.max(1, frame)) };
      const ends = preds.map((p) => this.span(p)).filter(Boolean).map((s) => s.to);
      if (ends.length < preds.length) {
        this.notice = `${quote(a)} follows something that doesn't run, so it can't be moved in time`;
        return null;
      }
      const delay = frame - Math.max(...ends);
      if (delay < 0) {
        this.notice = `${quote(a)} starts when ${preds.map((p) => quote(this.action(p))).join(' and ')} ${preds.length === 1 ? 'ends' : 'end'}: to start it earlier, set it to a fixed frame in Properties`;
        return null;
      }
      return { delay };
    }

    // Action id starting in `frame` instead (a preview: { valid, reason, compiled }).
    previewTime(id, frame) {
      const fields = this.startFields(id, frame);
      if (!fields) return { valid: false, reason: this.notice, changes: new Map() };
      const a = { ...this.action(id), ...fields };
      if (!a.delay) delete a.delay;
      return this.tryChanges(new Map([[id, a]]));
    }

    moveToFrame(id, frame) {
      const span = this.span(id);
      if (!span || span.from === frame) return false;
      return this.commit(this.previewTime(id, frame));
    }

    // [ and ]: the selected action a frame earlier or later.
    shiftInTime(df) {
      const a = this.selected;
      const span = a && this.span(a.id);
      return Boolean(span) && this.moveToFrame(a.id, span.from + df);
    }

    // Starts action id at a fixed frame (it no longer follows anything).
    setStart(id, frame) {
      const a = this.action(id);
      if (!a) return false;
      const next = { ...a, start: Math.min(MAX_FRAMES, Math.max(1, Math.round(frame))) };
      delete next.after;
      delete next.delay;
      return this.commit(this.tryChanges(new Map([[id, next]])));
    }

    // Makes action id start after `preds` (ids; all of them, for a merge) plus `delay` frames.
    setAfter(id, preds, delay = 0) {
      const a = this.action(id);
      const list = [...new Set(preds)].filter((p) => p !== id && this.action(p));
      if (!a || !list.length) return false;
      const later = this.chainOf(id);
      const loop = list.find((p) => later.includes(p));
      if (loop) {
        this.notice = `${quote(this.action(loop))} already comes after ${quote(a)}`;
        return false;
      }
      const next = { ...a, after: list.length === 1 ? list[0] : list };
      delete next.start;
      if (delay > 0) next.delay = Math.round(delay);
      else delete next.delay;
      return this.commit(this.tryChanges(new Map([[id, next]])));
    }

    // --- properties ---------------------------------------------------------------------------------

    // New parameters for a template made from a built-in operation (a circle mix's size and
    // rounds, ...). Its name follows if it was the operation's own name.
    setParams(id, params) {
      const a = this.action(id);
      const t = a && a.type === 'template' && templates.fromParams({ ...(a.params || {}), ...params });
      if (!t) return false;
      const old = this.project.templates[a.template];
      const key = projects.embedTemplate({ templates: { ...this.project.templates } }, t);
      const next = { ...a, template: key, params: t.params };
      if (!old || a.name === old.name) next.name = t.name;
      if (Array.isArray(a.times) && a.times.length !== t.frames.length) delete next.times;
      const defs = { [key]: { name: t.name, frames: t.frames } };
      const changes = new Map([[id, next]]);
      const why = this.followAttached(changes, a, next, this.attachedPaths(id), defs);
      if (why) {
        this.notice = why;
        return false;
      }
      return this.commit(this.tryChanges(changes, [], defs), defs);
    }

    // How many frames a pattern lasts: longer repeats its last frame, shorter drops frames at
    // the end.
    setFrames(id, n) {
      const a = this.action(id);
      if (!a || a.type !== 'pattern') return false;
      const count = Math.min(MAX_FRAMES, Math.max(1, Math.round(n)));
      const frames = a.frames.slice(0, count);
      while (frames.length < count) frames.push(frames[frames.length - 1].slice());
      const next = { ...a, frames };
      if (Array.isArray(a.times)) {
        const times = a.times.slice(0, count);
        while (times.length < count) times.push(times.length ? times[times.length - 1] : 0);
        if (times.some(Boolean)) next.times = times;
        else delete next.times;
      }
      return this.commit(this.tryChanges(new Map([[id, next]])));
    }

    // How long the droplet stays at a path's end (ms; 0 = no wait).
    setEndWait(id, ms) {
      const a = this.action(id);
      if (!a || a.type !== 'path') return false;
      const points = a.points.map((p) => ({ ...p }));
      const end = points[points.length - 1];
      if (ms) end.wait = clampTime(ms);
      else delete end.wait;
      return this.commit(this.tryChanges(new Map([[id, { ...a, points }]])));
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
        this.recompile();
        return;
      }
      if (!a && p.id) return; // the pattern being painted no longer covers this frame
      if (a) {
        const k = target.grow ? a.frames.length : target.k;
        if (!target.grow && a.frames[k].includes(e)) return;
        const frames = a.frames.map((cells) => cells.slice());
        if (target.grow) frames.push([]);
        frames[k].push(e);
        const check = this.tryChanges(new Map([[a.id, { ...a, frames }]]));
        if (!check.valid) {
          this.notice = check.reason;
          return;
        }
        a.frames = frames;
      } else {
        const made = this.newAction({ type: 'pattern', name: projects.nextName(this.project, 'Pattern'), frames: [[e]] }, this.frame, [e]);
        const check = this.tryChanges(new Map(), [made]);
        if (!check.valid) {
          this.notice = check.reason;
          return;
        }
        this.project.actions.push(made);
        this.selection = made.id;
        p.id = made.id;
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
    // in the frame on screen. Nothing changes until it is dropped; where it doesn't fit, or would
    // touch another droplet, it shows red and dropping does nothing.

    startPlacement(template) {
      this.cancel();
      this.playing = false;
      this.placement = { template, turns: 0, spot: null };
    }

    hoverPlacement(mx, my) {
      const p = this.placement;
      if (!p) return;
      const anchor = electrodeAt(this.layout.rects, mx, my);
      p.spot = anchor === null ? null : this.placeSpot(p, anchor, this.frame);
    }

    placeSpot(p, anchor, frame) {
      const spot = place(p.template, p.turns, anchor, frame, this.layout.rects);
      if (!spot.valid) return spot;
      const action = this.templateAction(p, spot);
      const check = this.tryChanges(new Map(), [action], { [action.template]: this.templateDef(p.template) });
      if (!check.valid) Object.assign(spot, { valid: false, reason: check.reason });
      return spot;
    }

    // A quarter turn clockwise.
    rotatePlacement() {
      const p = this.placement;
      if (!p) return;
      p.turns = (p.turns + 1) % 4;
      if (p.spot) p.spot = this.placeSpot(p, p.spot.anchor, p.spot.frame);
    }

    templateDef(t) {
      const def = { name: t.name, frames: t.frames };
      if (t.times && t.times.some(Boolean)) def.times = t.times.slice();
      return def;
    }

    // The action a dropped template becomes (not yet added).
    templateAction(p, spot) {
      const t = p.template;
      const key = projects.embedTemplate({ templates: { ...this.project.templates } }, t);
      const fields = { type: 'template', name: t.name, template: key, at: spot.anchor, turns: p.turns };
      if (t.params) fields.params = { ...t.params };
      if (t.times && t.times.some(Boolean)) fields.times = t.times.slice();
      return this.newAction(fields, spot.frame, spot.frames[0]);
    }

    // Adds the template where it is (a copy goes into the project file) and moves to its last
    // frame. Returns { from, to, steps }, or null if it doesn't fit.
    dropPlacement() {
      const p = this.placement;
      const spot = p && p.spot;
      this.placement = null;
      if (!spot || !spot.valid) return null;
      const done = this.change(() => {
        const action = this.templateAction(p, spot);
        projects.embedTemplate(this.project, p.template);
        this.project.actions.push(action);
        this.selection = action.id;
      });
      if (!done) return null;
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

    // Makes a change (fn edits the project) and keeps it for undo. Unless `check` is off, a
    // change that makes droplets touch, or runs something past frame 200, that didn't before is
    // taken back and `notice` says why. Returns whether anything changed.
    change(fn, { check = true } = {}) {
      const before = this.checkpoint();
      const old = this.compiled;
      fn();
      this.recompile();
      if (check) {
        const now = this.compiled;
        this.compiled = old;
        const reason = this.blockReason(now);
        this.compiled = now;
        if (reason) {
          this.restore(before);
          this.notice = reason;
          return false;
        }
      }
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

    // --- playback and frame times ---------------------------------------------------------------

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
    // was set on (empty if nothing runs in frame f, or the change was refused).
    setFrameTime(f, ms) {
      const act = this.compiled.active[f] || [];
      let targets = act.filter((x) => x.id === this.selection);
      if (!targets.length) targets = act.filter((x) => !this.action(x.id).split);
      if (!targets.length) targets = act;
      if (!targets.length) return [];
      const done = this.change(() => {
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
      return done ? targets.map(({ id }) => this.action(id)) : [];
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
          }, { check: false });
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
      const done = this.change(() => {
        this.addAction({ type: 'dispense', name: `Dispense ${RESERVOIR_NAMES[reservoir]}`, droplet: projects.nextDroplet(this.project), reservoir }, this.frame, []);
      });
      const span = done && this.span(this.selection);
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
      }, { check: false });
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
      }, { check: false });
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
      }, { check: false });
      if (timed) this.setDefaultTime(seq.frameTime);
    }

    // Adding an OpenDrop file to the project: one pattern from the frame on screen (leading empty
    // frames left out). Refused if it would touch what is there.
    addSequence(seq, name = 'Imported') {
      const block = importSequence(seq, name);
      const first = block.frames.findIndex((cells) => cells.length);
      if (first < 0) {
        this.notice = 'The file has nothing switched on';
        return false;
      }
      block.frames = block.frames.slice(first);
      if (block.times) block.times = block.times.slice(first);
      const a = { id: projects.nextId(this.project), ...block, start: this.frame };
      const check = this.tryChanges(new Map(), [a]);
      if (!check.valid) {
        this.notice = check.reason;
        return false;
      }
      return this.change(() => {
        this.project.actions.push(a);
        this.selection = a.id;
      });
    }
  }

  return { Editor, CONTROLS, RESERVOIR_STEPS, TOOLS, UNDO_LIMIT, MIN_SPEED, MAX_SPEED };
});
