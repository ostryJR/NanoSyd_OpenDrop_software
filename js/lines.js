/* Droplet paths saved as lines: a list of points (electrodes) joined by straight pieces. The
 * electrodes between two points are worked out from the layout, so a line can be reshaped by
 * moving its points instead of redrawing it. Straight means one direction on screen (left, right,
 * up or down), stepping between neighbouring electrodes; it goes by where the electrodes are drawn,
 * not by their numbers, because on several layouts neighbours aren't one column or row apart.
 * A point is { e: electrode, wait?: ms }; other fields on a point are kept as they are. No DOM. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./paths.js'));
  } else {
    (root.OD = root.OD || {}).lines = factory(root.OD.paths);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (paths) {
  'use strict';

  const { electrodeGraph, electrodeAt } = paths;

  // The layout's rectangles and electrode graph, which everything here works from.
  const context = (rects) => ({ rects, graph: electrodeGraph(rects) });

  // Direction from electrode a to electrode b on screen: 'R', 'L', 'D' or 'U' (null if a === b).
  function dirOf(graph, a, b) {
    if (a === b) return null;
    const ca = graph.centres.get(a);
    const cb = graph.centres.get(b);
    if (!ca || !cb) return null;
    const dx = cb.x - ca.x;
    const dy = cb.y - ca.y;
    if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? 'R' : 'L';
    return dy > 0 ? 'D' : 'U';
  }

  const axisOf = (dir) => (dir === 'L' || dir === 'R' ? 'h' : dir ? 'v' : null);
  const otherAxis = (axis) => (axis === 'h' ? 'v' : 'h');
  const axisBetween = (graph, a, b) => axisOf(dirOf(graph, a, b));

  // A straight piece from `from` to `to`: every step goes the same way on screen as `to` lies from
  // `from`, between neighbouring electrodes. The shortest such route, or null if there is none.
  function lineRoute(graph, from, to) {
    const { neighbours, centres } = graph;
    if (!centres.has(from) || !centres.has(to)) return null;
    if (from === to) return [from];
    const dir = dirOf(graph, from, to);
    const prev = new Map([[from, null]]);
    const queue = [from];
    for (let i = 0; i < queue.length; i++) {
      const u = queue[i];
      for (const v of neighbours.get(u) || []) {
        if (prev.has(v) || dirOf(graph, u, v) !== dir) continue;
        prev.set(v, u);
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

  const hasExtras = (point) => Object.keys(point).some((k) => k !== 'e');

  // The electrodes a line passes, one per step, and the step each point is on. `error` says why a
  // line can't be built (a point off the layout, or a piece that isn't straight or is blocked);
  // `bad` is then the index of the point or piece at fault.
  function build(graph, points) {
    if (!Array.isArray(points) || !points.length) return { cells: null, steps: null, error: 'the line has no points', bad: 0 };
    const cells = [];
    const steps = [];
    for (let i = 0; i < points.length; i++) {
      const e = points[i].e;
      if (!graph.centres.has(e)) return { cells: null, steps: null, error: `electrode ${e} isn't on this layout`, bad: i };
      if (i === 0) {
        cells.push(e);
        steps.push(0);
        continue;
      }
      const route = lineRoute(graph, points[i - 1].e, e);
      if (!route) {
        return { cells: null, steps: null, error: `the piece from ${points[i - 1].e} to ${e} isn't a straight line`, bad: i - 1 };
      }
      for (let j = 1; j < route.length; j++) cells.push(route[j]);
      steps.push(cells.length - 1);
    }
    return { cells, steps, error: null, bad: -1 };
  }

  const sameRun = (route, cells, a, b) =>
    route !== null && route.length === b - a + 1 && route.every((e, j) => e === cells[a + j]);

  // The points of a drawn route: its ends and every electrode where the direction changes, plus
  // the step indices in `keep` (a Map of step -> extra point fields, such as waits). Each piece
  // is rebuilt and compared with what was drawn; one that doesn't come back the same keeps all its
  // electrodes as points, so the line always gives back exactly the drawn route.
  function pointsFromRoute(graph, cells, keep = new Map()) {
    const n = cells.length;
    if (!n) return [];
    const must = new Set([0, n - 1]);
    for (const k of keep.keys()) if (k >= 0 && k < n) must.add(k);
    for (let i = 1; i < n - 1; i++) {
      if (dirOf(graph, cells[i - 1], cells[i]) !== dirOf(graph, cells[i], cells[i + 1])) must.add(i);
    }
    const marks = [...must].sort((a, b) => a - b);
    const chosen = [marks[0]];
    for (let k = 1; k < marks.length; k++) {
      const a = marks[k - 1];
      const b = marks[k];
      if (!sameRun(lineRoute(graph, cells[a], cells[b]), cells, a, b)) for (let j = a + 1; j < b; j++) chosen.push(j);
      chosen.push(b);
    }
    return chosen.map((i) => ({ e: cells[i], ...(keep.get(i) || {}) }));
  }

  // Zero-length pieces are dropped (a wait on either point is kept), and a point in the middle of
  // a straight run goes if the line is the same without it. Points with a wait (or any other field)
  // and the two ends always stay.
  function tidy(graph, points) {
    const out = [];
    for (const p of points) {
      const last = out[out.length - 1];
      if (last && last.e === p.e) {
        for (const k of Object.keys(p)) {
          if (k === 'wait') last.wait = Math.max(last.wait || 0, p.wait || 0) || undefined;
          else if (k !== 'e' && !(k in last)) last[k] = p[k];
        }
        if (last.wait === undefined) delete last.wait;
        continue;
      }
      out.push({ ...p });
    }
    for (let i = 1; i < out.length - 1; ) {
      const [a, b, c] = [out[i - 1].e, out[i].e, out[i + 1].e];
      let removable = !hasExtras(out[i]) && dirOf(graph, a, b) === dirOf(graph, b, c);
      if (removable) {
        const r1 = lineRoute(graph, a, b);
        const r2 = lineRoute(graph, b, c);
        const whole = r1 && r2 ? [...r1, ...r2.slice(1)] : null;
        removable = whole !== null && sameRun(lineRoute(graph, a, c), whole, 0, whole.length - 1);
      }
      if (removable) out.splice(i, 1);
      else i++;
    }
    return out;
  }

  // The electrode under electrode e's centre moved by (dx, dy) grid units, or null. Moves snap to
  // whole electrodes: on the standard grid, 2 units is one column or row.
  function shift(ctx, e, dx, dy) {
    if (!dx && !dy) return e;
    const c = ctx.graph.centres.get(e);
    return c ? electrodeAt(ctx.rects, c.x + dx, c.y + dy) : null;
  }

  function movePoint(ctx, point, off) {
    const e = shift(ctx, point.e, off.dx, off.dy);
    return e === null ? null : { ...point, e };
  }

  const across = (axis, d) => (axis === 'h' ? { dx: 0, dy: d.dy } : { dx: d.dx, dy: 0 });
  const along = (axis, d) => (axis === 'h' ? { dx: d.dx, dy: 0 } : { dx: 0, dy: d.dy });
  const isZero = (off) => !off.dx && !off.dy;

  // Piece i (points i to i+1) moved sideways by the part of d across it. A neighbouring piece at a
  // right angle stretches to stay connected; at the start or end, or where the line carries on
  // straight, the old point stays and a short connecting piece is added. Returns { points,
  // insertedLeft } (insertedLeft: a point was added before the piece), or null off the layout.
  function shiftPiece(ctx, points, i, d) {
    const g = ctx.graph;
    const axis = axisBetween(g, points[i].e, points[i + 1].e);
    const off = axis ? across(axis, d) : { dx: 0, dy: 0 };
    if (isZero(off)) return { points: points.map((p) => ({ ...p })), insertedLeft: false };
    const a = points[i];
    const b = points[i + 1];
    const na = movePoint(ctx, a, off);
    const nb = movePoint(ctx, b, off);
    if (!na || !nb) return null;
    const last = points.length - 1;
    const prevAxis = i > 0 ? axisBetween(g, points[i - 1].e, a.e) : null;
    const nextAxis = i + 1 < last ? axisBetween(g, b.e, points[i + 2].e) : null;
    const keepA = i === 0 || prevAxis !== otherAxis(axis);
    const keepB = i + 1 === last || nextAxis !== otherAxis(axis);
    const out = points.slice(0, i).map((p) => ({ ...p }));
    if (keepA) out.push({ ...a }, { e: na.e });
    else out.push(na);
    if (keepB) out.push({ e: nb.e }, { ...b });
    else out.push(nb);
    out.push(...points.slice(i + 2).map((p) => ({ ...p })));
    return { points: out, insertedLeft: keepA };
  }

  // Each edit returns the new points (tidied), or null if a point would land off the layout.
  // d = { dx, dy } in grid units. Whether the new line can be built is checked with build().

  function dragPiece(ctx, points, i, d) {
    const moved = shiftPiece(ctx, points, i, d);
    return moved && tidy(ctx.graph, moved.points);
  }

  // The start or end: along its piece it gets longer or shorter. Across it, the next corner moves
  // along if there is one (its other piece is at a right angle); otherwise the old end becomes a
  // corner and a connecting piece goes to the new end.
  function dragEnd(ctx, points, which, d) {
    const g = ctx.graph;
    const last = points.length - 1;
    if (last === 0) {
      const p = movePoint(ctx, points[0], d);
      return p && [p];
    }
    const end = which === 'start' ? 0 : last;
    const next = which === 'start' ? 1 : last - 1;
    let out = points.map((p) => ({ ...p }));
    const axis = axisBetween(g, out[next].e, out[end].e) || (Math.abs(d.dx) >= Math.abs(d.dy) ? 'h' : 'v');
    const al = along(axis, d);
    if (!isZero(al)) {
      const p = movePoint(ctx, out[end], al);
      if (!p) return null;
      out[end] = p;
    }
    const ac = across(axis, d);
    if (!isZero(ac)) {
      const interior = next > 0 && next < last;
      const beyond = which === 'start' ? next + 1 : next - 1;
      if (interior && axisBetween(g, out[next].e, out[beyond].e) === otherAxis(axis)) {
        const pe = movePoint(ctx, out[end], ac);
        const pn = movePoint(ctx, out[next], ac);
        if (!pe || !pn) return null;
        out[end] = pe;
        out[next] = pn;
      } else {
        const moved = movePoint(ctx, out[end], ac);
        if (!moved) return null;
        const corner = { e: out[end].e };
        out = which === 'start' ? [moved, corner, ...out.slice(1)] : [...out.slice(0, last), corner, moved];
      }
    }
    return tidy(g, out);
  }

  // A corner moves both its pieces, each by the part of the move across it. A point on a straight
  // run (or where the line turns back) slides along the run. The ends use dragEnd.
  function dragPoint(ctx, points, i, d) {
    const last = points.length - 1;
    if (i === 0) return dragEnd(ctx, points, 'start', d);
    if (i === last) return dragEnd(ctx, points, 'end', d);
    const g = ctx.graph;
    const inAxis = axisBetween(g, points[i - 1].e, points[i].e);
    const outAxis = axisBetween(g, points[i].e, points[i + 1].e);
    if (inAxis && outAxis && inAxis !== outAxis) {
      const first = shiftPiece(ctx, points, i - 1, d);
      if (!first) return null;
      const second = shiftPiece(ctx, first.points, i + (first.insertedLeft ? 1 : 0), d);
      return second && tidy(g, second.points);
    }
    const axis = inAxis || outAxis;
    if (!axis) return tidy(g, points);
    const p = movePoint(ctx, points[i], along(axis, d));
    if (!p) return null;
    const out = points.map((q) => ({ ...q }));
    out[i] = p;
    return tidy(g, out);
  }

  // Every point moved by d (the whole line).
  function moveLine(ctx, points, d) {
    const out = [];
    for (const p of points) {
      const q = movePoint(ctx, p, d);
      if (!q) return null;
      out.push(q);
    }
    return out;
  }

  // A point on step k of the line (given its built cells and point steps), with `extra` fields
  // merged in. If a point is already on that step, it gets the fields.
  function addPointAt(points, built, k, extra = {}) {
    const out = points.map((p) => ({ ...p }));
    const at = built.steps.indexOf(k);
    if (at >= 0) {
      Object.assign(out[at], extra);
      return out;
    }
    let i = 0;
    while (i + 1 < built.steps.length && built.steps[i + 1] < k) i++;
    out.splice(i + 1, 0, { e: built.cells[k], ...extra });
    return out;
  }

  // Removes point i, if it isn't an end and the line stays straight without it; null otherwise.
  function removePoint(graph, points, i) {
    if (i <= 0 || i >= points.length - 1) return null;
    if (!lineRoute(graph, points[i - 1].e, points[i + 1].e)) return null;
    return tidy(graph, [...points.slice(0, i), ...points.slice(i + 1)]);
  }

  // Takes the wait off the point on step k (and the point itself, if it is no longer needed).
  function clearWaitAt(graph, points, built, k) {
    const at = built.steps.indexOf(k);
    if (at < 0 || !points[at].wait) return points.map((p) => ({ ...p }));
    const out = points.map((p) => ({ ...p }));
    delete out[at].wait;
    return tidy(graph, out);
  }

  // What part of a line electrode e is on: { kind: 'start' | 'end' | 'point' | 'piece', index },
  // or null. Where the line passes e more than once, the visit nearest to step `near` counts.
  function partAt(built, points, e, near = 0) {
    const { cells, steps } = built;
    let best = -1;
    for (let k = 0; k < cells.length; k++) {
      if (cells[k] === e && (best < 0 || Math.abs(k - near) < Math.abs(best - near))) best = k;
    }
    if (best < 0) return null;
    const last = points.length - 1;
    const at = steps.indexOf(best);
    if (at >= 0) return { kind: at === 0 ? 'start' : at === last ? 'end' : 'point', index: at, step: best };
    let i = 0;
    while (i + 1 < steps.length && steps[i + 1] < best) i++;
    return { kind: 'piece', index: i, step: best };
  }

  return {
    context,
    dirOf,
    lineRoute,
    build,
    pointsFromRoute,
    tidy,
    shift,
    dragPiece,
    dragEnd,
    dragPoint,
    moveLine,
    addPointAt,
    removePoint,
    clearWaitAt,
    partAt,
  };
});
