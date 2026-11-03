/* Droplet paths: which electrodes a droplet can step between, routes from one electrode to
 * another, and the path being drawn with a drag. No DOM here. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./model.js'), require('./layout.js'));
  } else {
    (root.OD = root.OD || {}).paths = factory(root.OD.model, root.OD.layout);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (model, layout) {
  'use strict';

  const { MAX_FRAMES } = model;
  const { hitTest, inArray } = layout;

  // A droplet can step between two electrodes that share an edge: at most GAP apart on one axis
  // and overlapping by at least OVERLAP on the other (grid units). Touching corners don't count.
  // Standard cartridge electrodes touch, and the reservoirs and magnets sit 1 unit away from the
  // grid except where they connect to it. The other layouts leave up to about 0.57 units
  // between neighbours.
  const GAP = 0.6;
  const OVERLAP = 0.3;
  const SAMPLE_STEP = 0.25; // grid units between pointer samples, so fast drags skip nothing

  const graphs = new WeakMap();

  // Neighbours and a centre point for each electrode of a layout, cached per rectangle list.
  function electrodeGraph(rects) {
    let graph = graphs.get(rects);
    if (graph) return graph;
    const neighbours = new Map();
    const centres = new Map();
    const areas = new Map();
    for (const r of rects) {
      if (!neighbours.has(r.e)) neighbours.set(r.e, []);
      // An electrode drawn as several rectangles is centred on its (first) largest one.
      if (!(areas.get(r.e) >= r.h * r.v)) {
        areas.set(r.e, r.h * r.v);
        centres.set(r.e, { x: r.x + r.h / 2, y: r.y + r.v / 2 });
      }
    }
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i];
        const b = rects[j];
        if (a.e === b.e) continue;
        const gapX = Math.max(a.x, b.x) - Math.min(a.x + a.h, b.x + b.h);
        const gapY = Math.max(a.y, b.y) - Math.min(a.y + a.v, b.y + b.v);
        if (!((gapX <= GAP && gapY <= -OVERLAP) || (gapY <= GAP && gapX <= -OVERLAP))) continue;
        const na = neighbours.get(a.e);
        const nb = neighbours.get(b.e);
        if (!na.includes(b.e)) na.push(b.e);
        if (!nb.includes(a.e)) nb.push(a.e);
      }
    }
    for (const list of neighbours.values()) list.sort((p, q) => p - q);
    graph = { neighbours, centres };
    graphs.set(rects, graph);
    return graph;
  }

  // The electrode under a point, or null. Only inside the array box, as for clicks.
  function electrodeAt(rects, mx, my) {
    if (!inArray(mx, my)) return null;
    const hits = hitTest(rects, mx, my);
    return hits.length ? hits[0] : null;
  }

  const axisOf = (dx, dy) => (Math.abs(dx) >= Math.abs(dy) ? 'h' : 'v');

  // Shortest list of electrodes from `from` to `to`, each one a neighbour of the one before;
  // null if `to` can't be reached.
  function shortestRoute(graph, from, to) {
    if (from === to) return [from];
    const prev = new Map([[from, null]]);
    const queue = [from];
    for (let i = 0; i < queue.length; i++) {
      for (const v of graph.neighbours.get(queue[i]) || []) {
        if (prev.has(v)) continue;
        prev.set(v, queue[i]);
        if (v === to) {
          const route = [];
          for (let e = to; e !== null; e = prev.get(e)) route.push(e);
          return route.reverse();
        }
        queue.push(v);
      }
    }
    return null;
  }

  // Shortest route that first moves only along `first` ('h' or 'v'), then only along the other
  // axis: one straight line, or two at a right angle. null if there is no such route.
  function rightAngleRoute(graph, from, to, first) {
    const axes = [first, first === 'h' ? 'v' : 'h'];
    // Search states are (electrode, leg) pairs, packed as electrode * 2 + leg.
    const prev = new Map([[from * 2, -1]]);
    const queue = [from * 2];
    for (let i = 0; i < queue.length; i++) {
      const state = queue[i];
      const u = state >> 1;
      if (u === to) {
        const route = [];
        for (let s = state; s !== -1; s = prev.get(s)) route.push(s >> 1);
        return route.reverse();
      }
      const cu = graph.centres.get(u);
      for (const v of graph.neighbours.get(u) || []) {
        const cv = graph.centres.get(v);
        const axis = axisOf(cv.x - cu.x, cv.y - cu.y);
        for (let leg = state & 1; leg < 2; leg++) {
          const next = v * 2 + leg;
          if (axes[leg] !== axis || prev.has(next)) continue;
          prev.set(next, state);
          queue.push(next);
        }
      }
    }
    return null;
  }

  // Route for the straight tool: along `first`, then the other axis; if the layout has no such
  // route, the other way round; failing that, the shortest route.
  function straightRoute(graph, from, to, first) {
    return (
      rightAngleRoute(graph, from, to, first) ||
      rightAngleRoute(graph, from, to, first === 'h' ? 'v' : 'h') ||
      shortestRoute(graph, from, to)
    );
  }

  // The path being drawn: the start electrode in the start frame, then the next electrode in
  // each following frame. Nothing goes into the sequence until the editor adds it.
  class PathDraft {
    constructor(rects, mode, start, frame, point) {
      this.rects = rects;
      this.graph = electrodeGraph(rects);
      this.mode = mode; // 'freehand' or 'straight'
      this.frame = frame;
      this.cells = [start];
      this.maxSteps = MAX_FRAMES - frame;
      this.limited = false; // the path was cut short at frame 200
      this.moved = false; // the pointer has been over another electrode
      this.axis = null; // straight tool: direction of the first line, from the drag's start
      this.point = point; // last pointer position, { mx, my }
    }

    get start() {
      return this.cells[0];
    }

    get end() {
      return this.cells[this.cells.length - 1];
    }

    get steps() {
      return this.cells.length - 1;
    }

    get endFrame() {
      return this.frame + this.steps;
    }

    moveTo(mx, my) {
      if (this.mode === 'straight') {
        this.aimAt(electrodeAt(this.rects, mx, my), mx, my);
      } else {
        const { mx: x0, my: y0 } = this.point;
        const n = Math.max(1, Math.ceil(Math.hypot(mx - x0, my - y0) / SAMPLE_STEP));
        for (let i = 1; i <= n; i++) {
          const e = electrodeAt(this.rects, x0 + ((mx - x0) * i) / n, y0 + ((my - y0) * i) / n);
          if (e !== null) this.enter(e);
        }
      }
      this.point = { mx, my };
    }

    // Freehand: the pointer has entered electrode e.
    enter(e) {
      const { cells } = this;
      const last = cells[cells.length - 1];
      if (e === last) return;
      this.moved = true;
      if (e === cells[cells.length - 2]) {
        cells.pop(); // going back over the last step takes it back
        this.limited = false;
        return;
      }
      // A fast drag can skip electrodes, and a diagonal move isn't a droplet step: fill in the
      // shortest route. Electrodes that can't be reached are ignored.
      const route = shortestRoute(this.graph, last, e);
      if (!route) return;
      for (const next of route.slice(1)) {
        if (this.steps >= this.maxSteps) {
          this.limited = true;
          return;
        }
        cells.push(next);
      }
    }

    // Straight: horizontal and vertical lines from the start to electrode e (null = between
    // electrodes, which keeps the current route).
    aimAt(e, mx, my) {
      if (e === null) return;
      if (e === this.start) {
        this.cells = [this.start];
        this.axis = null; // back on the start: the next direction picks the first line again
        this.limited = false;
        return;
      }
      this.moved = true;
      if (!this.axis) {
        const c = this.graph.centres.get(this.start);
        this.axis = axisOf(mx - c.x, my - c.y);
      }
      const route = straightRoute(this.graph, this.start, e, this.axis);
      if (!route) return;
      this.limited = route.length - 1 > this.maxSteps;
      this.cells = route.slice(0, this.maxSteps + 1);
    }
  }

  return { electrodeGraph, electrodeAt, shortestRoute, rightAngleRoute, straightRoute, PathDraft, GAP };
});
