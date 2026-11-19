/* Editing and playback behaviour, ported from mousePressed, mouseDragged, mouseWheel, keyPressed
 * and animate in OpenDropController4_25.pde. What you draw is kept as actions in a project (a path
 * as a line, a template where it was dropped, a dispense, a painted pattern), and the frames are
 * compiled from them after every change. A change that would make droplets of different actions
 * touch is refused. No DOM here: app.js passes in grid coordinates. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./model.js'), require('./layout.js'), require('./paths.js'), require('./templates.js'),
      require('./lines.js'), require('./compile.js'), require('./project.js'), require('./process.js'), require('./stretch.js'),
      require('./heat.js')
    );
  } else {
    const OD = root.OD;
    (root.OD = root.OD || {}).editor = factory(OD.model, OD.layout, OD.paths, OD.templates, OD.lines, OD.compile, OD.project, OD.process, OD.stretch, OD.heat);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (model, layout, paths, templates, lines, compiler, projects, processes, stretches, heat) {
  'use strict';

  const { CELLS, MAX_FRAMES, clampTime } = model;
  const { hitTest, inArray, inRect } = layout;
  const { PathDraft, electrodeAt, straightRoute } = paths;
  const { place } = templates;
  const { compile, expand, importSequence, importControls, predsOf, RESERVOIR_STEPS, RESERVOIR_NAMES } = compiler;

  const DROPLET_CELLS = 128; // electrodes below this carry droplets; 128-143 are control lines

  // Click areas in grid units, copied from the original's inRect() checks. The device-only
  // controls (life, feedback, reconnect, temperatures) are left out.
  const CONTROLS = [
    { action: 'play', x: 34, y: -9, w: 9, h: 2 }, // labelled 'simulate'
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
    // The device, where OpenDropController had its buttons: live (its "life": the device shows
    // the frame on screen) and feedback (V4.2 boards); connecting is in the Device tab. The page
    // handles these; the editor only reports them.
    { action: 'live', x: 34, y: -6, w: 6, h: 2, device: true },
    { action: 'feedback', x: 34, y: -3, w: 9, h: 2, device: true },
    // New on the left: what a drag does, and undo/redo. The label comes first and the box (at
    // box, y) sits on the side facing the array, mirroring the right-hand buttons. The label is
    // clickable too.
    { action: 'toolFreehand', x: -45, y: -9, w: 11, h: 2, box: -36, label: 'freehand', tool: 'freehand' },
    { action: 'toolPaint', x: -45, y: -6, w: 11, h: 2, box: -36, label: 'paint', tool: 'paint' },
    { action: 'toolSelect', x: -45, y: -3, w: 11, h: 2, box: -36, label: 'select', tool: 'select' },
    { action: 'undo', x: -45, y: 4, w: 11, h: 2, box: -36, label: 'undo' },
    { action: 'redo', x: -45, y: 7, w: 11, h: 2, box: -36, label: 'redo' },
  ];

  // What a drag on the array does: draw a droplet path that follows the pointer, switch
  // electrodes in the current frame (the original's drag), or pick and move what is drawn. The
  // selected path can be reshaped with the path tool too.
  const TOOLS = ['freehand', 'paint', 'select'];
  const FRAME_HELD = 'A run is going: the board follows it, so frames can’t be stepped through until it stops';
  const UNDO_LIMIT = 100;
  const MIN_SPEED = 5; // frames per minute
  const MAX_SPEED = 600;
  const DRAG_STEP = 0.25; // grid units between paint samples, so fast drags don't skip electrodes
  const PITCH = 2; // grid units from one standard electrode to the next

  const quote = (a) => `“${a.name}”`;
  // With a process, the actions of a tile that does one kind of thing (a dispense, a move, a
  // mix...) are called by the tile's name; a Step tile's actions keep names of their own.
  const namedByTile = (t) => Boolean(t) && processes.hasWork(t) && t.kind !== 'step';
  const tileName = (t) => t.name || processes.KINDS[t.kind].name;
  // A merged droplet's name is its droplets' short names ("D1 + D2"): with droplet `from`
  // renamed `to`, the name it becomes, or null if `from` isn't one of its parts.
  const mergedRenamed = (name, from, to) => {
    const parts = name.split(' + ');
    const was = projects.shortDroplet(from);
    if (parts.length < 2 || !from || !to || !parts.includes(was)) return null;
    return parts.map((p) => (p === was ? projects.shortDroplet(to) : p)).join(' + ');
  };
  const pairKey = (x, y) => (x < y ? `${x}|${y}` : `${y}|${x}`);
  const extrasOf = ({ e, ...extra }) => extra;

  class Editor {
    constructor(lay, project = projects.newProject({ layout: lay.id })) {
      this.layout = lay;
      this.ctx = lines.context(lay.rects);
      // The whole project is `doc`; `project` is what the board shows: all of it, or with a
      // process, the stretch of the open tile (written back into `doc` on every recompile).
      this.project = project;
      this.doc = project;
      this.scope = null; // with a process: { tile, stretch, tiles: Set of tile ids }
      // Called when playing reaches the last frame; returning true means it went on elsewhere (the
      // page moves to the next step of the process) instead of back to frame 1.
      this.onPlayEnd = null;
      this.arrive = []; // the droplets coming into that stretch (actions of type 'arrive')
      this.controlsIn = null; // the heaters and magnets coming into it (null: nothing set)
      // Other lanes' droplets while it plays (compile()'s `context`): they can't be changed here,
      // and mustn't be touched.
      this.context = [];
      // The page can say what comes into a stretch the way the timeline shows it (stretch id ->
      // { state, controls, context } or null); otherwise it is the first way a run gets there.
      this.contextOf = null;
      // The heaters' temperatures from a live device (°C or null ×3), or null without one: the page
      // sets it. Playing, a frame that waits for the heaters then lasts until they get there.
      this.readings = () => null;
      this.holding = null; // the hold playback is waiting in ({ targets, tolerance }), if any
      this.frozen = null; // why nothing can be changed now (a run is going), or null
      this.runElsewhere = null; // the same for a run going in another tab, or null
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
      this.flush();
      this.syncNames();
      this.revision = (this.revision || 0) + 1; // goes up with every change, for keeping the work
      this.compiled = compile(this.project, this.layout.rects, { arrive: this.arrive, controls: this.controlsIn, context: this.context });
      if (this.playing) this.playLast = this.compiled.seq.lastFrame();
    }

    // --- the process ------------------------------------------------------------------------------
    // With a process, the board shows one stretch (the steps between two stops) of it, with the
    // droplets coming in where the stretch before leaves them. Actions belong to tiles.

    // Writes what the board shows back into the whole project.
    flush() {
      if (!this.scope || this.project === this.doc) {
        this.doc = this.project;
        return;
      }
      const inside = (a) => this.scope.tiles.has(a.tile);
      const out = [];
      let put = false;
      for (const a of this.doc.actions) {
        if (!inside(a)) out.push(a);
        else if (!put) {
          out.push(...this.project.actions);
          put = true;
        }
      }
      if (!put) out.push(...this.project.actions);
      this.doc.actions = out;
      this.doc.templates = this.project.templates;
      this.doc.frameTime = this.project.frameTime;
      if (this.project.heatRates) this.doc.heatRates = this.project.heatRates;
      if (this.project.hv) this.doc.hv = this.project.hv;
      else delete this.doc.hv;
    }

    // One name per step: an action of a tile that does one kind of thing is called by the tile's
    // name, the others of the same tile "Name · 2", "Name · 3"... A Step tile's actions keep their
    // own. It follows from the rest, so doing it again changes nothing (undo stays right).
    syncNames() {
      const p = this.doc.process;
      if (!p) return;
      const byId = new Map(p.tiles.map((t) => [t.id, t]));
      const count = new Map();
      for (const a of this.doc.actions) {
        const t = a.tile && byId.get(a.tile);
        if (!namedByTile(t)) continue;
        const n = (count.get(t.id) || 0) + 1;
        count.set(t.id, n);
        const name = n > 1 ? `${tileName(t)} · ${n}` : tileName(t);
        if (a.name !== name) a.name = name;
      }
    }

    // The process tile action a belongs to, or null.
    tileOf(a) {
      return a && a.tile && this.doc.process ? processes.tileById(this.doc.process, a.tile) : null;
    }

    // Whether action a is called by its tile's name (see syncNames).
    namedByTile(a) {
      return namedByTile(this.tileOf(a));
    }

    // The next free droplet name, "Droplet N", besides those on the board and those the Dispense
    // tiles will make.
    freeDroplet() {
      const tiles = this.doc.process ? this.doc.process.tiles.filter((t) => t.kind === 'dispense' && t.droplet).map((t) => ({ droplet: t.droplet })) : [];
      return projects.nextDroplet({ actions: [...this.doc.actions, ...this.project.actions, ...this.arrive, ...tiles] });
    }

    workingProject() {
      const { process, ...rest } = this.doc;
      void process;
      return { ...rest, actions: this.doc.actions.filter((a) => this.scope.tiles.has(a.tile)) };
    }

    get hasProcess() {
      return Boolean(this.doc.process);
    }

    // Why nothing in the project may change now, or null: a run is going, here or in another tab
    // (a template being made isn't the project, so a run elsewhere leaves it alone).
    get readOnly() {
      return this.frozen || (this.saved ? null : this.runElsewhere) || null;
    }

    // While a run is going nothing changes: `notice` says so and this returns true.
    refused() {
      if (!this.readOnly) return false;
      this.notice = this.readOnly;
      return true;
    }

    // Why the board can't be changed now, or null: a run is going, or with a process no tile is
    // open.
    get locked() {
      if (this.readOnly) return this.readOnly;
      if (this.doc.process && !(this.scope && this.scope.tile)) return 'Open a step of the process first: double-click it in the process view';
      return null;
    }

    // Everything about the process on the board (stretches, droplets coming in, each tile's frames).
    analyze() {
      this.flush();
      return stretches.analyze(this.doc, this.layout.rects);
    }

    // Opens tile id's stretch on the board, the droplets coming in where the stretch before leaves
    // them (or as `state` says, in a run). False if it is a stop (nothing on the board).
    openTile(id, { state = null, controls = null, context = null } = {}) {
      if (!this.doc.process) return false;
      this.cancel();
      const info = this.analyze();
      const sid = info.st.of.get(id);
      if (!sid) return false;
      const s = info.stretch.get(sid);
      const given = state ? null : this.contextOf && this.contextOf(sid);
      this.scope = { tile: id, stretch: sid, tiles: new Set(s.tiles) };
      this.arrive = stretches.arrivals(state || (given ? given.state : s.state));
      this.controlsIn = controls || (given ? given.controls : s.controls);
      this.context = context || (given ? given.context : []) || [];
      this.project = this.workingProject();
      if (this.selection && !this.action(this.selection)) this.selection = null;
      this.recompile();
      if (this.frame > Math.max(1, this.seq.lastFrame())) this.frame = 1;
      return true;
    }

    // After the process or the whole project changed (undo, a process edit, another tab): the
    // board shows the open tile's stretch again, or the first one if that tile is gone.
    rescope() {
      if (!this.doc.process) {
        if (this.scope) {
          this.scope = null;
          this.arrive = [];
          this.controlsIn = null;
          this.context = [];
          this.project = this.doc;
          this.recompile();
        }
        return;
      }
      const want = this.scope && this.scope.tile;
      if (want && this.openTile(want)) return;
      const st = processes.stretches(this.doc.process);
      if (st.list.length && this.openTile(st.list[0].start)) return;
      this.scope = { tile: null, stretch: null, tiles: new Set() };
      this.arrive = [];
      this.controlsIn = null;
      this.context = [];
      this.project = this.workingProject();
      this.recompile();
    }

    // A run shows stretch `sid` with the droplets as they really are.
    showStretch(sid, state, controls = null, context = []) {
      this.flush();
      const s = processes.stretches(this.doc.process).list.find((x) => x.id === sid);
      if (!s) return false;
      this.cancel();
      this.scope = { tile: s.start, stretch: sid, tiles: new Set(s.tiles) };
      this.arrive = stretches.arrivals(state);
      this.controlsIn = controls;
      this.context = context;
      this.project = this.workingProject();
      this.selection = null;
      this.recompile();
      return true;
    }

    // Gives the project a process: Start, one step holding everything drawn so far, End; and
    // opens that step on the board.
    makeProcess() {
      if (this.doc.process || this.saved || this.refused()) return false;
      this.cancel();
      this.flush();
      const p = processes.emptyProcess();
      const start = processes.addTile(p, 'start', 0, 0);
      const step = processes.addTile(p, 'step', 0, processes.ROW, { name: 'Step 1' });
      const end = processes.addTile(p, 'end', 0, 2 * processes.ROW);
      processes.link(p, start.id, 'next', step.id);
      processes.link(p, step.id, 'next', end.id);
      this.change(() => {
        this.doc.process = p;
        for (const a of this.doc.actions) a.tile = step.id;
      }, { check: false });
      this.openTile(step.id);
      return true;
    }

    // A change to the process (fn edits it): undoable like drawing; the board follows.
    processChange(fn) {
      if (!this.doc.process || this.refused()) return false;
      if (this.scope) this.project = this.workingProject();
      const done = this.change(() => fn(this.doc.process), { check: false });
      if (done) this.rescope();
      return done;
    }

    // A tile's settings; what is placed of it on the board follows (its name, a dispense's
    // reservoir and droplet, a wait's time). Undoable.
    tileSettings(id, fields) {
      return this.processChange((p) => {
        const t = processes.tileById(p, id);
        if (!t) return;
        const { droplet, ...rest } = fields;
        Object.assign(t, rest);
        if (t.kind === 'parallel' && fields.lanes !== undefined) processes.setLanes(p, id, fields.lanes);
        for (const a of this.doc.actions) {
          if (a.tile !== id) continue;
          if (a.type === 'dispense' && fields.reservoir && RESERVOIR_STEPS[fields.reservoir]) a.reservoir = fields.reservoir;
          if (a.type === 'wait' && Number.isFinite(fields.seconds)) a.duration = Math.max(1, Math.round(fields.seconds * 1000));
          if (a.type === 'temp') {
            if (fields.targets !== undefined && heat.cleanTargets(fields.targets).some((x) => x !== null)) a.targets = heat.cleanTargets(fields.targets);
            if (fields.wait !== undefined) {
              if (fields.wait) a.wait = true;
              else delete a.wait;
            }
            if (a.wait) a.tolerance = heat.cleanTolerance(fields.tolerance !== undefined ? fields.tolerance : a.tolerance);
            else delete a.tolerance;
          }
          if (a.type === 'magnet') {
            if (fields.magnet !== undefined) a.magnet = fields.magnet === 2 ? 2 : 1;
            if (fields.on !== undefined) a.on = Boolean(fields.on);
          }
        }
        if (droplet !== undefined && t.kind === 'dispense') {
          // The droplet it makes: renamed down its chain once placed; until then just the tile's.
          const value = String(droplet).trim().slice(0, 60);
          const made = this.doc.actions.filter((a) => a.tile === id && a.type === 'dispense');
          if (!made.length) {
            if (value) t.droplet = value;
            else delete t.droplet;
          } else if (value) for (const a of made) this.renameDroplet(a, value);
        }
      });
    }

    // A mix tile's kind, size, rounds or direction; the mixer placed on the board changes with it
    // (as Properties would change it there). Undoable, in one step.
    setTileParams(id, params) {
      if (this.refused()) return false;
      const t = this.doc.process && processes.tileById(this.doc.process, id);
      if (!t) return false;
      const next = templates.cleanParams({ ...(t.params || { kind: 'circle' }), ...params });
      if (!next) return false;
      const placed = this.doc.actions.find((a) => a.tile === id && a.type === 'template');
      if (placed) {
        if (!this.openTile(id) || !this.setParams(placed.id, next)) return false;
        t.params = next; // part of the step just recorded: undo goes back to the state before it
        this.recompile();
        return true;
      }
      return this.processChange(() => {
        t.params = next;
      });
    }

    // The project as another tab changed it (actions, templates, process, default frame time):
    // taken in as an undo step here, the open tile staying open. False while something is being
    // dragged, run or made, when it has to wait.
    applyRemote(shared) {
      if (this.dragging || this.readOnly || this.saved || this.placement) return false;
      const tile = this.scope && this.scope.tile;
      const selection = this.selection;
      this.cancel();
      this.leaveScope();
      this.change(() => {
        this.doc.actions = shared.actions;
        this.doc.templates = shared.templates;
        if (shared.process) this.doc.process = shared.process;
        else delete this.doc.process;
        if (shared.frameTime) this.doc.frameTime = shared.frameTime;
        if (shared.heatRates) this.doc.heatRates = shared.heatRates;
        if (shared.hv) this.doc.hv = shared.hv;
        else delete this.doc.hv;
      }, { check: false });
      if (this.doc.process && tile && this.openTile(tile)) {
        // the same tile
      } else this.rescope();
      this.selection = selection && this.action(selection) ? selection : null;
      return true;
    }

    // A tile goes, with its actions on the board.
    removeTile(id) {
      return this.processChange((p) => {
        processes.removeTile(p, id);
        this.doc.actions = this.doc.actions.filter((a) => a.tile !== id);
        if (this.scope) this.project = this.workingProject();
      });
    }

    // Several tiles go, with their arrows and their actions on the board: one undo step.
    removeTiles(ids) {
      const gone = new Set(ids);
      return this.processChange((p) => {
        for (const id of gone) processes.removeTile(p, id);
        this.doc.actions = this.doc.actions.filter((a) => !gone.has(a.tile));
        if (this.scope) this.project = this.workingProject();
      });
    }

    // The last actions of the tiles before tile `id` in its stretch (the nearest ones with
    // something on the board): what its actions start after.
    orderAfter(id) {
      const p = this.doc.process;
      if (!p || !id || !this.scope) return [];
      const g = processes.graph(p);
      const back = processes.backLinks(p, g);
      const inside = this.scope.tiles;
      const groups = [];
      const seen = new Set();
      const walk = (tid) => {
        for (const l of g.into.get(tid) || []) {
          if (back.has(processes.linkKey(l)) || seen.has(l.from) || !inside.has(l.from)) continue;
          seen.add(l.from);
          const mine = this.project.actions.filter((a) => a.tile === l.from);
          if (mine.length) groups.push(mine);
          else walk(l.from);
        }
      };
      walk(id);
      const out = [];
      for (const mine of groups) {
        const ids = new Set(mine.map((a) => a.id));
        const followed = new Set(mine.flatMap((a) => (predsOf(a) || []).filter((x) => ids.has(x))));
        for (const a of mine) if (!followed.has(a.id) && this.span(a.id)) out.push(a.id);
      }
      return out;
    }

    // The frame a tile's work starts in: where the tiles before it end (1 if nothing is before).
    tileStart(id) {
      const ends = this.orderAfter(id).map((x) => this.span(x)).filter(Boolean).map((s) => s.to);
      return ends.length ? Math.max(...ends) : 1;
    }

    // Puts the open tile's operation on the board: a dispense or a wait is added at once; a mix,
    // merge or split starts being placed (the page lets the pointer drop it); a move picks the
    // freehand tool. Returns { kind: 'added' | 'placing' | 'draw', text } or null (with a notice).
    placeTile() {
      const id = this.scope && this.scope.tile;
      const t = id && processes.tileById(this.doc.process, id);
      if (!t || this.locked) {
        this.notice = this.locked || 'Open a step of the process first';
        return null;
      }
      this.frame = Math.min(MAX_FRAMES, this.tileStart(id));
      const droplets = this.arrive.map((a) => a.droplet);
      switch (t.kind) {
        case 'dispense':
          if (!this.layout.hasReservoirs) {
            this.notice = 'This layout has no reservoirs';
            return null;
          }
          if (!this.dispense(t.reservoir || 'reservoirLeftTop')) return null;
          return { kind: 'added', text: `${t.name}: dispensing from the ${RESERVOIR_NAMES[t.reservoir] || 'left top'} reservoir` };
        case 'wait': {
          const seconds = Math.max(0.01, Number(t.seconds) || 1);
          const done = this.change(() => this.addAction({ type: 'wait', name: t.name || 'Wait', droplet: '', duration: Math.round(seconds * 1000) }, this.frame, []));
          return done ? { kind: 'added', text: `${t.name}: everything waits ${seconds} s here` } : null;
        }
        case 'temperature': {
          const targets = heat.cleanTargets(t.targets);
          const a = this.addTemp(this.frame, { targets, wait: Boolean(t.wait), tolerance: t.tolerance, name: t.name || 'Temperature' });
          return a ? { kind: 'added', text: `${t.name}: ${heat.targetsText(targets)}${t.wait ? ', waiting until the heaters get there' : ''}` } : null;
        }
        case 'magnet': {
          const a = this.addMagnet(this.frame, t.magnet, t.on !== false, { name: t.name || 'Magnet' });
          return a ? { kind: 'added', text: `${t.name}: magnet ${t.magnet === 2 ? 2 : 1} ${t.on !== false ? 'on' : 'off'}` } : null;
        }
        case 'mix':
        case 'merge':
        case 'split': {
          const template = t.kind === 'mix' ? templates.fromParams(t.params || { kind: 'circle' }) : templates.BUILT_IN.find((x) => x.id === t.kind);
          if (!template) {
            this.notice = 'Choose what kind of mix it is first';
            return null;
          }
          this.startPlacement(template);
          return { kind: 'placing', text: `${t.name}: click where the droplet is to drop the ${template.name.toLowerCase()} (R turns it, Esc cancels)` };
        }
        case 'move':
          this.setTool('freehand');
          return { kind: 'draw', text: `${t.name}: draw the path${droplets.length ? ` from where ${droplets.join(' or ')} ${droplets.length === 1 ? 'is' : 'are'}` : ''}` };
        default:
          return { kind: 'draw', text: `${t.name || 'This step'}: draw on the board whatever happens in it` };
      }
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
      if (this.refused()) return false;
      this.cancel();
      this.layout = lay;
      this.ctx = lines.context(lay.rects);
      this.project.layout = lay.id;
      this.doc.layout = lay.id;
      this.recompile();
      if (this.scope) this.rescope(); // the droplets coming in depend on the layout too
      return true;
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
    // Nothing may make droplets of different actions touch, or run past the frame guard, that didn't
    // before. Taking things away (deleting, clearing) is always allowed.

    // Why compile result `next` (of a project with `actions`) can't be kept, compared with the
    // project as it is; null if it can.
    // The first touch in `next` (a compiled project) that isn't there now, or null.
    newTouch(next) {
      const pair = [...next.touches].find((k) => !this.compiled.touches.has(k));
      return pair ? next.issues.find((i) => i.kind === 'touch' && pairKey(i.id, i.other) === pair) : null;
    }

    blockReason(next, actions = this.project.actions) {
      const name = (id) => {
        const a = actions.find((x) => x.id === id);
        return a ? quote(a) : id;
      };
      const t = this.newTouch(next);
      if (t) {
        // Which droplets, and where: the two actions are often called the same ("Move").
        const who = (id) => {
          const lane = this.context.find((c) => c.id === id);
          if (lane) return `${lane.droplet ? projects.shortDroplet(lane.droplet) : 'a droplet'} of another lane`;
          const a = actions.find((x) => x.id === id) || this.arrive.find((x) => x.id === id);
          const d = a && a.droplet ? projects.shortDroplet(a.droplet) : '';
          return a ? `${quote(a)}${d ? ` (${d})` : ''}` : id;
        };
        const at = (id) => (t.cells[id] || []).join('+');
        const when = t.before ? `in frame ${t.frame}, next to where ${who(t.other)} was a frame before` : `in frame ${t.frame}`;
        return `${who(t.id)} and ${who(t.other)} would touch ${when} (electrodes ${at(t.id)} and ${at(t.other)}, dark red)`;
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
      const compiled = compile(trial, this.layout.rects, { arrive: this.arrive, controls: this.controlsIn, context: this.context });
      const ids = new Set([...changes.keys(), ...extra.map((a) => a.id)]);
      const bad = compiled.issues.find((i) => ids.has(i.id) && i.kind === 'invalid');
      const reason = bad ? `It can't go there: ${bad.text}` : this.blockReason(compiled, actions);
      // Where droplets would touch, to show on the board.
      const touch = !bad && reason ? this.newTouch(compiled) : null;
      const clash = touch ? Object.values(touch.cells).flat() : [];
      return { changes, extra, compiled, valid: !reason, reason, clash };
    }

    // --- adding actions -----------------------------------------------------------------------

    // What a new action starting in frame `frame` with `cells` on carries on from: for each of
    // those electrodes, the latest action that ended on it by then, unless something has taken
    // that droplet since. { after (an id, or a list for a merge), delay, droplet } or null.
    linkFor(cells, frame) {
      const found = new Map(); // electrode -> { a, to }
      for (const a of [...this.arrive, ...this.project.actions]) {
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
      // Droplets that merge give a name of their short names, "D1 + D2", so it stays readable.
      const parts = names.length > 1 ? names.flatMap((n) => projects.shortDroplet(n).split(' + ')) : names;
      return {
        after: picked.length === 1 ? picked[0].id : picked.map((a) => a.id),
        delay: frame - last,
        droplet: [...new Set(parts)].join(' + '),
      };
    }

    // An action that starts in frame `frame` with `cells` on in its first step: after the action
    // it carries on from (taking its droplet name), or at that frame with a new droplet name.
    // `fields.droplet`, if given, is kept.
    // With a process, it belongs to the open tile, and also starts after the tiles before it.
    newAction(fields, frame, cells) {
      const all = { actions: [...this.doc.actions, ...this.project.actions, ...this.arrive] };
      const a = { id: projects.nextId(all), ...fields };
      const tile = this.scope && this.scope.tile;
      if (tile) a.tile = tile;
      const t = this.tileOf(a);
      if (namedByTile(t)) a.name = tileName(t); // syncNames numbers it if the tile has more
      const link = this.linkFor(cells, frame);
      const after = [...new Set([...(link ? [].concat(link.after) : []), ...(tile ? this.orderAfter(tile) : [])])];
      const fresh = () => (cells.some((e) => e < DROPLET_CELLS) ? projects.nextDroplet(all) : '');
      if (after.length) {
        a.after = after.length === 1 ? after[0] : after;
        const ends = after.map((id) => this.span(id)).filter(Boolean).map((s) => s.to);
        const delay = ends.length ? frame - Math.max(...ends) : 0;
        if (delay > 0) a.delay = delay;
        if (a.droplet === undefined) a.droplet = link ? link.droplet : fresh();
      } else {
        a.start = frame;
        if (a.droplet === undefined) a.droplet = fresh();
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

    // --- heaters and magnets ----------------------------------------------------------------------
    // A 'temp' action sets heater targets from its frame on (and can wait until they are reached),
    // a 'magnet' action switches a magnet; both last until the next one.

    // The heaters and magnets in frame f (what the frame before had, past the end).
    controlsAt(f) {
      const seq = this.seq;
      for (let k = Math.min(f, seq.controls.length - 1); k >= 1; k--) if (seq.controls[k]) return seq.controls[k];
      return this.controlsIn ? heat.copyControls(this.controlsIn) : heat.emptyControls();
    }

    // Adds a temperature setting in frame `frame`: { targets, wait, tolerance }. Undoable.
    addTemp(frame, { targets, wait = false, tolerance = heat.DEFAULT_TOLERANCE, name = 'Temperature' } = {}) {
      if (this.locked) {
        this.notice = this.locked;
        return null;
      }
      const clean = heat.cleanTargets(targets);
      if (!clean.some((t) => t !== null)) {
        this.notice = 'Set at least one heater';
        return null;
      }
      const fields = { type: 'temp', name, droplet: '', targets: clean };
      if (wait) Object.assign(fields, { wait: true, tolerance: heat.cleanTolerance(tolerance) });
      let added = null;
      const done = this.change(() => {
        added = this.addAction(fields, Math.max(1, Math.round(frame)), []);
      });
      return done ? added : null;
    }

    // Switches magnet n (1 or 2) on or off from frame `frame`. Undoable.
    addMagnet(frame, n, on, { name = 'Magnet' } = {}) {
      if (this.locked) {
        this.notice = this.locked;
        return null;
      }
      let added = null;
      const done = this.change(() => {
        added = this.addAction({ type: 'magnet', name, droplet: '', magnet: n === 2 ? 2 : 1, on: Boolean(on) }, Math.max(1, Math.round(frame)), []);
      });
      return done ? added : null;
    }

    // A temperature or magnet action's settings (targets, wait, tolerance; magnet, on). Undoable.
    setControl(id, fields) {
      const a = this.action(id);
      if (!a || (a.type !== 'temp' && a.type !== 'magnet')) return false;
      const next = { ...a };
      if (a.type === 'temp') {
        if (fields.targets !== undefined) next.targets = heat.cleanTargets(fields.targets);
        if (!next.targets.some((t) => t !== null)) {
          this.notice = 'A temperature setting needs at least one heater: delete it instead';
          return false;
        }
        if (fields.wait !== undefined) next.wait = Boolean(fields.wait);
        if (fields.tolerance !== undefined) next.tolerance = fields.tolerance;
        if (next.wait) next.tolerance = heat.cleanTolerance(next.tolerance);
        else {
          delete next.wait;
          delete next.tolerance;
        }
      } else {
        if (fields.magnet !== undefined) next.magnet = fields.magnet === 2 ? 2 : 1;
        if (fields.on !== undefined) next.on = Boolean(fields.on);
      }
      return this.commit(this.tryChanges(new Map([[id, next]])));
    }

    // How fast the heaters are assumed to warm up and cool down (°C/min), for estimating waits
    // when no device says. A setting of the project, like the default frame time.
    // The project's high voltage (volts, hz, mode; empty parts = the device's own), merged into what
    // is set. Kept in the project file; the page sends it to a connected device.
    setHV(hv) {
      if (this.refused()) return false;
      const next = projects.cleanHV({ ...(this.project.hv || {}), ...hv });
      if (next) this.project.hv = next;
      else delete this.project.hv;
      this.recompile();
      return true;
    }

    setHeatRates(rates) {
      if (this.refused()) return false;
      this.project.heatRates = heat.cleanRates({ ...heat.cleanRates(this.project.heatRates), ...rates });
      this.recompile();
      return true;
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
      if (this.locked) {
        if (inArray(mx, my)) this.notice = this.locked;
        return null;
      }
      const drawing = this.tool === 'freehand';
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
      this.draft = new PathDraft(this.layout.rects, e, this.frame, { mx, my });
      this.dragging = true;
    }

    // Drawing on from the selected path's free end: it follows the pointer and goes back along
    // the path when the pointer does.
    startDrawingOn(path, mx, my) {
      const { built } = this.compiled.expanded.get(path.id);
      const span = this.span(path.id);
      const draft = new PathDraft(this.layout.rects, built.cells[0], span.from, { mx, my });
      draft.cells = built.cells.slice();
      draft.extends = path.id;
      this.draft = draft;
      this.dragging = true;
    }

    // The path a draft gives, and whether it may be added: { changes or extra, compiled, valid, reason }.
    checkDraft(draft = this.draft) {
      if (draft.extends) {
        const path = this.action(draft.extends);
        const { built } = this.compiled.expanded.get(path.id);
        const cells = draft.cells;
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

    // Paths attached to action id: those that end on its first electrodes, and those that start
    // on its last electrodes. They follow it when it moves. A path it is linked to (one it waits
    // for, or one that waits for it) counts however long its droplet waits in between, such as
    // the droplet that gets to a merge first; one that isn't linked counts if it hands over in
    // the same frame or the next.
    attachedPaths(id) {
      const span = this.span(id);
      const steps = this.stepsOf(id);
      const incoming = [];
      const outgoing = [];
      if (!span || !steps) return { incoming, outgoing };
      const first = steps[0].cells;
      const last = steps[steps.length - 1].cells;
      const preds = predsOf(this.action(id)) || [];
      for (const p of this.project.actions) {
        const ps = this.span(p.id);
        const x = this.compiled.expanded.get(p.id);
        if (p.type !== 'path' || p.id === id || !ps || !x || !x.built) continue;
        const cells = x.built.cells;
        const into = (preds.includes(p.id) && ps.to <= span.from) || ps.to === span.from || ps.to === span.from - 1;
        const outOf = ((predsOf(p) || []).includes(id) && ps.from >= span.to) || ps.from === span.to || ps.from === span.to + 1;
        if (into && first.includes(cells[cells.length - 1])) incoming.push(p.id);
        if (outOf && last.includes(cells[0])) outgoing.push(p.id);
      }
      return { incoming, outgoing };
    }

    // Why a prepared change (tryChanges) would lose a droplet: one of the actions it moves, or
    // one linked after them, would no longer start where what it follows left its droplet.
    // null if none would.
    strandReason(check, skip = null) {
      if (!check.valid) return null;
      const ids = new Set(check.changes.keys());
      for (const id of [...ids]) for (const f of this.followersOf(id)) ids.add(f.id);
      ids.delete(skip);
      const before = new Set(this.compiled.issues.filter((i) => i.kind === 'jump').map((i) => i.id));
      const jump = check.compiled.issues.find((i) => i.kind === 'jump' && ids.has(i.id) && !before.has(i.id));
      if (!jump) return null;
      const name = (x) => (this.action(x) ? quote(this.action(x)) : x);
      return `${name(jump.id)} wouldn't start where ${name(jump.other)} leaves its droplet, so that droplet would be lost`;
    }

    // A prepared change to a template or pattern (moved, turned, resized), refused if it would
    // lose a droplet.
    unlessStranded(check, skip = null) {
      const why = this.strandReason(check, skip);
      return why ? { ...check, valid: false, reason: why } : check;
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
        return a.type === 'path' ? this.tryChanges(changes) : this.unlessStranded(this.tryChanges(changes));
      }
      if (a.type === 'path') {
        let points;
        if (g.kind === 'whole') points = lines.moveLine(this.ctx, a.points, d);
        else if (g.kind === 'piece') points = lines.dragPiece(this.ctx, a.points, g.index, d);
        else if (g.kind === 'start' || g.kind === 'end') points = lines.dragEnd(this.ctx, a.points, g.kind, d);
        else points = lines.dragPoint(this.ctx, a.points, g.index, d);
        if (!points) return invalid('That would go off the array');
        changes.set(a.id, { ...a, points });
        const why = g.kind === 'whole' ? null : this.carryEnds(changes, a);
        if (why) return invalid(why);
        // What came along mustn't lose a droplet; the path itself may be moved away (its start
        // then shows as a problem).
        return changes.size > 1 ? this.unlessStranded(this.tryChanges(changes), a.id) : this.tryChanges(changes);
      }
      const moved = this.movedAction(a, d);
      if (!moved) return invalid("It doesn't fit there");
      const next = { ...a, ...moved };
      changes.set(a.id, next);
      const why = this.followAttached(changes, a, next, ed.attached);
      return why ? invalid(why) : this.unlessStranded(this.tryChanges(changes));
    }

    // What is attached to path id's end (which = 'end': what carries on from its last electrode
    // when it ends) or its start ('start': what ends on its first electrode when it starts).
    // A dispense isn't: it stays at its reservoir.
    attachedAt(id, which) {
      const span = this.span(id);
      const x = this.compiled.expanded.get(id);
      if (!span || !x || !x.built) return [];
      const cells = x.built.cells;
      const path = this.action(id);
      return this.project.actions.filter((b) => {
        const sb = b.id !== id && b.type !== 'dispense' && this.span(b.id);
        if (!sb) return false;
        if (which === 'end') {
          const linked = (predsOf(b) || []).includes(id) || sb.from === span.to || sb.from === span.to + 1;
          return linked && sb.from >= span.to && this.firstCells(b.id).includes(cells[cells.length - 1]);
        }
        const linked = (predsOf(path) || []).includes(b.id) || sb.to === span.from || sb.to === span.from - 1;
        return linked && sb.to <= span.from && this.lastCells(b.id).includes(cells[0]);
      });
    }

    // Path `path` is reshaped (its new version is in `changes`): where its start or end moved,
    // what is attached there comes along. A template or pattern moves with it (and the other
    // paths attached to that follow); a path that carries on from it (or leads into it)
    // stretches to meet it. Adds them to `changes`; returns a reason if one can't come along.
    carryEnds(changes, path) {
      const old = this.compiled.expanded.get(path.id);
      if (!old || !old.built) return null;
      const before = old.built.cells;
      const points = changes.get(path.id).points;
      const ends = [
        ['end', before[before.length - 1], points[points.length - 1].e],
        ['start', before[0], points[0].e],
      ];
      for (const [which, from, to] of ends) {
        if (from === to) continue;
        const d = this.offset(from, to);
        for (const b of this.attachedAt(path.id, which)) {
          if (changes.has(b.id)) continue;
          if (b.type === 'path') {
            const other = which === 'end' ? 'start' : 'end';
            const moved = lines.dragEnd(this.ctx, b.points, other, d);
            const meets = moved && moved[other === 'start' ? 0 : moved.length - 1].e === to;
            if (!meets) return `${quote(b)} can't follow it there`;
            changes.set(b.id, { ...b, points: moved });
            continue;
          }
          const moved = this.movedAction(b, d);
          const next = moved && { ...b, ...moved };
          const x = next && expand(next, this.project, this.ctx);
          if (!x || !x.steps) return `${quote(b)} would come along, but doesn't fit there`;
          const cells = (which === 'end' ? x.steps[0] : x.steps[x.steps.length - 1]).cells;
          if (!cells.includes(to)) return `${quote(b)} can't come along there`;
          changes.set(b.id, next);
          const { incoming, outgoing } = this.attachedPaths(b.id);
          const others = { incoming: incoming.filter((id) => id !== path.id), outgoing: outgoing.filter((id) => id !== path.id) };
          const why = this.followAttached(changes, b, next, others);
          if (why) return why;
        }
      }
      return null;
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
      const done = { kind: 'edit', name: a.name, reshaped: a.type === 'path' && ed.grab.kind !== 'whole' && ed.grab.kind !== 'chain' };
      // What came along (`along`, names): attached templates first, then paths that stretched.
      const along = [...ed.preview.changes.keys()].filter((id) => id !== ed.id).map((id) => this.action(id));
      along.sort((x, y) => (x.type === 'path') - (y.type === 'path'));
      if (along.length) done.along = along.map((x) => x.name);
      return done;
    }

    applyChanges(changes, templatesToo = null) {
      return this.change(() => {
        if (templatesToo) this.project.templates = { ...this.project.templates, ...templatesToo };
        this.project.actions = this.project.actions.map((a) => changes.get(a.id) || a);
      });
    }

    // Runs a prepared check: applies it if it may be kept, otherwise says why.
    commit(check, templatesToo = null) {
      if (this.refused()) return false; // a run is going: that is the reason, whatever the check says
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
      return this.commit(a.type === 'path' ? this.tryChanges(changes) : this.unlessStranded(this.tryChanges(changes)));
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
      const defs = { [key]: { name: t.name, frames: t.frames } };
      const changes = new Map([[id, next]]);
      const why = this.followAttached(changes, a, next, this.attachedPaths(id), defs);
      if (why) {
        this.notice = why;
        return false;
      }
      return this.commit(this.unlessStranded(this.tryChanges(changes, [], defs)), defs);
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
      return this.commit(this.tryChanges(new Map([[id, next]])));
    }

    // Renames action id; one called by its tile's name renames the tile (and so all of its).
    rename(id, name) {
      const a = this.action(id);
      const value = String(name).trim().slice(0, 80);
      if (!a || !value) return false;
      const t = this.tileOf(a);
      if (namedByTile(t)) return value.slice(0, 60) === tileName(t) || this.tileSettings(t.id, { name: value.slice(0, 60) });
      return this.change(() => (a.name = value));
    }

    // A new droplet name for action id and what follows it under the same name (renameDroplet).
    setDroplet(id, name) {
      const a = this.action(id);
      if (!a) return false;
      const value = String(name).trim().slice(0, 60);
      return this.change(() => this.renameDroplet(a, value));
    }

    // Names the droplet action a moves `value`, from a on (inside a change): a and the actions
    // after it that had the same name; merged droplets named after it ("D1 + D2") follow its short
    // name. With a process this goes over the whole project: the parts of the process further
    // down that take the droplet in ("in:<old name>") follow, on down, and a Dispense tile making
    // it gets the new name.
    renameDroplet(a, value) {
      this.flush();
      const all = this.doc.process ? this.doc.actions : this.project.actions;
      const followers = (x) => all.filter((y) => (predsOf(y) || []).includes(x.id));
      const later = this.doc.process ? this.laterStretches() : null;
      const seen = new Set();
      const visit = (x, from, to) => {
        if (seen.has(x.id)) return;
        seen.add(x.id);
        x.droplet = to;
        const t = x.type === 'dispense' && this.tileOf(x);
        if (t && t.kind === 'dispense') t.droplet = to;
        for (const f of followers(x)) {
          const name = f.droplet || '';
          if (name === from) visit(f, from, to);
          else {
            const merged = mergedRenamed(name, from, to);
            if (merged) visit(f, name, merged);
          }
        }
        // Further down the process, where the droplet comes in by its name.
        if (!later || !from || !to || !x.tile) return;
        const below = later(x.tile);
        for (const f of all) {
          if (!below.has(f.tile) || !(predsOf(f) || []).includes(`in:${from}`)) continue;
          const after = [].concat(f.after).map((id) => (id === `in:${from}` ? `in:${to}` : id));
          f.after = after.length === 1 ? after[0] : after;
          if ((f.droplet || '') === from) visit(f, from, to);
        }
      };
      visit(a, a.droplet || '', value);
    }

    // For the parts of the process after a tile's: tile id -> the set of tiles in the stretches
    // further down from its stretch (by arrows going down, not those going back up).
    laterStretches() {
      const p = this.doc.process;
      const g = processes.graph(p);
      const back = processes.backLinks(p, g);
      const st = processes.stretches(p, g, back);
      const memo = new Map();
      return (tileId) => {
        const sid = st.of.get(tileId);
        if (memo.has(sid)) return memo.get(sid);
        const s = st.list.find((x) => x.id === sid);
        const seen = new Set(s ? s.tiles : [tileId]);
        const stack = [...seen];
        while (stack.length) {
          const id = stack.pop();
          for (const l of g.out.get(id) || []) {
            if (back.has(processes.linkKey(l)) || seen.has(l.to)) continue;
            seen.add(l.to);
            stack.push(l.to);
          }
        }
        const out = new Set([...seen].filter((id) => st.of.get(id) && st.of.get(id) !== sid));
        memo.set(sid, out);
        return out;
      };
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
      if (this.locked) {
        this.notice = this.locked;
        return false;
      }
      this.playing = false;
      this.placement = { template, turns: Number.isInteger(template.turns) ? ((template.turns % 4) + 4) % 4 : 0, spot: null };
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
      return { name: t.name, frames: t.frames };
    }

    // The action a dropped template becomes (not yet added).
    templateAction(p, spot) {
      const t = p.template;
      const key = projects.embedTemplate({ templates: { ...this.project.templates } }, t);
      const fields = { type: 'template', name: t.name, template: key, at: spot.anchor, turns: p.turns };
      if (t.params) fields.params = { ...t.params };
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
      if (this.refused()) return false;
      this.cancel();
      this.flush();
      if (!this.saved) {
        this.saved = {
          project: this.doc, scope: this.scope, arrive: this.arrive, controlsIn: this.controlsIn,
          frame: this.frame, undoStack: this.undoStack, redoStack: this.redoStack, selection: this.selection,
        };
      }
      this.project = projects.newProject({ layout: this.layout.id, frameTime: this.project.frameTime });
      this.doc = this.project;
      this.scope = null;
      this.arrive = [];
      this.controlsIn = null;
      this.context = [];
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
      return true;
    }

    // --- keeping the work between visits -----------------------------------------------------------
    // What is kept when the page is left or reloaded: the project with its frame on screen,
    // selection and last `history` undo and redo steps; while a template is being made, that
    // too (`making`), the project being set aside. Plain data, for JSON.

    snapshot(history = UNDO_LIMIT) {
      this.flush();
      const part = (s, project) => ({
        project,
        frame: s.frame,
        selection: s.selection,
        tile: s.scope && s.scope.tile ? s.scope.tile : null,
        undo: history > 0 ? s.undoStack.slice(-history) : [],
        redo: history > 0 ? s.redoStack.slice(-history) : [],
      });
      const out = this.saved ? part(this.saved, this.saved.project) : part(this, this.doc);
      if (this.saved) out.making = part(this, this.doc);
      return out;
    }

    // Takes up work kept with snapshot() (after a trip through JSON) in place of the current
    // project. Anything malformed is cleaned up or left out; returns warnings about that. Throws
    // if there is no project in it.
    resume(data) {
      if (!data || typeof data !== 'object') throw new Error('nothing kept');
      const usable = (p) => {
        if (!p || typeof p.state !== 'string' || !Number.isInteger(p.frame)) return false;
        try {
          const s = JSON.parse(p.state);
          return Array.isArray(s.actions) && Boolean(s.templates) && typeof s.templates === 'object';
        } catch {
          return false;
        }
      };
      const steps = (list) => (Array.isArray(list) ? list.filter(usable).slice(-UNDO_LIMIT) : []);
      const take = (s) => {
        const { project, warnings } = projects.parse(s.project);
        project.layout = this.layout.id;
        const frame = Number.isInteger(s.frame) ? Math.min(MAX_FRAMES, Math.max(1, s.frame)) : 1;
        const selection = project.actions.some((a) => a.id === s.selection) ? s.selection : null;
        const tile = typeof s.tile === 'string' ? s.tile : null;
        return { project, frame, selection, tile, undoStack: steps(s.undo), redoStack: steps(s.redo), warnings };
      };
      const main = take(data);
      const making = data.making ? take(data.making) : null;
      this.cancel();
      this.playing = false;
      const { warnings: w1, tile, ...mainState } = main;
      this.saved = null;
      this.scope = null;
      this.arrive = [];
      this.controlsIn = null;
      this.context = [];
      Object.assign(this, mainState);
      this.doc = this.project;
      if (this.doc.process && !(tile && this.openTile(tile))) this.rescope();
      if (making) {
        const { warnings: w2, tile: unused, ...makingState } = making;
        void unused;
        this.flush();
        this.saved = { ...mainState, project: this.doc, scope: this.scope, arrive: this.arrive, controlsIn: this.controlsIn, frame: this.frame, selection: this.selection };
        this.scope = null;
        this.arrive = [];
        this.controlsIn = null;
        this.context = [];
        Object.assign(this, makingState);
        this.doc = this.project;
        w1.push(...w2);
      }
      this.recompile();
      return w1;
    }

    endTemplate() {
      if (!this.saved) return;
      this.cancel();
      this.saved.project.frameTime = this.project.frameTime; // the default frame time is a setting
      ({ project: this.doc, scope: this.scope, arrive: this.arrive, controlsIn: this.controlsIn, frame: this.frame, undoStack: this.undoStack, redoStack: this.redoStack, selection: this.selection } = this.saved);
      this.project = this.scope ? this.workingProject() : this.doc;
      if (this.scope) this.project.frameTime = this.doc.frameTime;
      this.saved = null;
      this.playing = false;
      this.recompile();
    }

    // --- undo ----------------------------------------------------------------------------------
    // Each change keeps a copy of the whole project's actions, the templates they use and the
    // process, from before it, with the frame and selection of that moment.

    state() {
      this.flush();
      const d = this.doc;
      return JSON.stringify(d.process ? { actions: d.actions, templates: d.templates, process: d.process } : { actions: d.actions, templates: d.templates });
    }

    checkpoint() {
      return { state: this.state(), frame: this.frame, selection: this.selection };
    }

    restore(point) {
      const { actions, templates: kept, process } = JSON.parse(point.state);
      this.doc.actions = actions;
      this.doc.templates = kept;
      if (process) this.doc.process = process;
      else delete this.doc.process;
      // The board's part is taken from the restored project before anything writes it back.
      this.project = this.scope ? this.workingProject() : this.doc;
      this.frame = point.frame;
      if (this.scope || this.doc.process) this.rescope();
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
    // change that makes droplets touch, or runs something past the frame guard, that didn't before is
    // taken back and `notice` says why. Returns whether anything changed.
    change(fn, { check = true } = {}) {
      if (this.refused()) return false;
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
      if (from.length && this.refused()) return false;
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
    // While a run goes, the frame on screen is the run's: stepping, scrolling and playing are
    // refused (`notice` says so). The run itself sets `frame` directly.
    frameHeld() {
      if (!this.frozen) return false;
      this.notice = FRAME_HELD;
      return true;
    }

    wheel(count) {
      if (this.frameHeld()) return;
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
      if (this.frameHeld()) return;
      if (this.frame < MAX_FRAMES) this.frame++;
    }

    prevFrame() {
      if (this.frameHeld()) return;
      if (this.frame > 1) this.frame--;
    }

    togglePlay(now) {
      if (this.playing) {
        this.playing = false;
        return;
      }
      if (this.frameHeld()) return;
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
      if (this.refused()) return false;
      this.project.frameTime = clampTime(ms);
      this.recompile();
      return true;
    }

    // Advances playback, each frame staying for its own time; returns true when the frame
    // changed. Loops back to frame 1.
    tick(now) {
      if (!this.playing) {
        this.holding = null;
        return false;
      }
      const hold = this.seq.holds.get(this.frame);
      const temps = hold ? this.readings() : null;
      // With a live device, a frame waiting for the heaters lasts until they get there.
      const waiting = Boolean(temps) && !heat.reached(temps, hold.targets, hold.tolerance);
      this.holding = waiting ? hold : null;
      if (waiting) return false;
      // (once there, it lasts at least the default frame time; without a device, its estimate)
      if (now - this.playStart <= (temps ? this.seq.frameTime : this.frameMs)) return false;
      this.playStart = now;
      if (this.frame < this.playLast) this.frame++;
      else if (!(this.onPlayEnd && this.onPlayEnd())) this.frame = 1;
      return true;
    }

    // --- buttons ---------------------------------------------------------------------------------

    run(action, now = 0) {
      const f = this.frame;
      const changes = ['copy', 'clearFrame', 'clearAll', 'undo', 'redo'].includes(action) || Boolean(RESERVOIR_STEPS[action]);
      if (this.locked && (changes || (this.frozen && (action === 'play' || action === 'next' || action === 'prev')))) {
        this.notice = changes ? this.locked : FRAME_HELD;
        return;
      }
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
    // In an open Dispense tile with nothing placed yet, the droplet gets the tile's droplet name (a
    // free one, kept on the tile, if it has none).
    dispense(reservoir) {
      const done = this.change(() => {
        const t = this.scope && this.scope.tile ? processes.tileById(this.doc.process, this.scope.tile) : null;
        const first = t && t.kind === 'dispense' && !this.doc.actions.some((a) => a.tile === t.id && a.type === 'dispense') ? t : null;
        const droplet = (first && first.droplet) || this.freeDroplet();
        if (first) first.droplet = droplet;
        this.addAction({ type: 'dispense', name: `Dispense ${RESERVOIR_NAMES[reservoir]}`, droplet, reservoir }, this.frame, []);
      });
      const span = done && this.span(this.selection);
      if (span) this.frame = span.to;
      return done;
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
        for (const { id, step } of this.compiled.active[f] || []) {
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
      if (this.refused()) return false;
      this.cancel();
      this.leaveScope();
      this.change(() => {
        for (const k of Object.keys(project)) if (k !== 'frameTime' && k !== 'layout') this.project[k] = project[k];
        if (!project.process) delete this.project.process;
        this.selection = null;
        this.frame = 1;
      }, { check: false });
      this.project.frameTime = project.frameTime;
      this.recompile();
      this.rescope();
      return true;
    }

    // Back to showing the whole project (before it is replaced).
    leaveScope() {
      this.flush();
      this.scope = null;
      this.arrive = [];
      this.controlsIn = null;
      this.context = [];
      this.project = this.doc;
    }

    // Opening an OpenDrop file: one pattern holding all its frames. A file with frame times also
    // brings its default frame time; one without keeps the current default.
    openSequence(seq, { timed = false, name = 'Imported' } = {}) {
      if (this.refused()) return false;
      this.cancel();
      this.leaveScope();
      this.change(() => {
        const empty = seq.lastFrame() === 1 && seq.isEmpty(1);
        this.project.actions = empty ? [] : [{ id: 'a1', ...importSequence(seq, name) }];
        // Heater targets in the file become temperature settings where they change.
        for (const t of importControls(seq)) this.project.actions.push({ id: projects.nextId(this.project), ...t });
        this.project.templates = {};
        delete this.project.process;
        this.selection = null;
        this.frame = 1;
      }, { check: false });
      if (timed) this.setDefaultTime(seq.frameTime);
      return true;
    }

    // Adding an OpenDrop file to the project: one pattern from the frame on screen (leading empty
    // frames left out). Refused if it would touch what is there.
    addSequence(seq, name = 'Imported') {
      if (this.refused()) return false;
      const block = importSequence(seq, name);
      const first = block.frames.findIndex((cells) => cells.length);
      if (first < 0) {
        this.notice = 'The file has nothing switched on';
        return false;
      }
      block.frames = block.frames.slice(first);
      const { start, ...fields } = block;
      void start;
      const a = this.newAction(fields, this.frame, []);
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
