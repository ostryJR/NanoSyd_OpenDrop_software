/* The process view: the process as a top-down tree of tiles on an SVG canvas, in place of the
 * board. Drag a tile from the palette (or click one to add it under the selected tile), drag tiles
 * to move them, drag from a tile's output port to another tile to connect them (the arrow snaps to
 * its input points; into empty space it offers a tile to add there), drop a loose tile onto an
 * arrow to put it there, click to select (Shift+click or drag a box round them for several),
 * Delete to remove, double-click or Enter to open a step on the board. Space+drag, the middle
 * button or Alt+drag pans. Arrows going back up are loops: their tiles get a dashed frame labelled
 * with the loop's condition. Plain DOM; every change goes through the editor, so it can be undone. */
(function (root) {
  'use strict';

  const OD = root.OD;
  const P = OD.process;
  const NS = 'http://www.w3.org/2000/svg';
  const NUDGE = 10; // units an arrow key moves the selected tiles (with Shift, five times that)

  // Size [w, h] of each kind of tile (from the model), and its glyph.
  const sizeOf = (t) => P.sizeOf(t);
  const IN_R = 4.5; // radius of an input point
  const SNAP_PX = 40; // how near (on screen) a new arrow's end snaps to an input point
  const DROP_PX = 12; // ... and a dragged tile's pointer must be to an arrow to go on it

  // Where input point i of n is, relative to the tile's centre: spread along the top edge.
  function inAt(t, i, n) {
    const [w, h] = sizeOf(t);
    if (n <= 1) return [0, -h / 2];
    const gap = Math.min(60, (w - 40) / (n - 1));
    return [(i - (n - 1) / 2) * gap, -h / 2];
  }

  // Distance from (x, y) to a polyline, and the nearest point on it.
  function nearOnLine(pts, x, y) {
    let best = { dist: Infinity, x: 0, y: 0 };
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = pts[i - 1];
      const [bx, by] = pts[i];
      const len = (bx - ax) ** 2 + (by - ay) ** 2;
      const f = len ? Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / len)) : 0;
      const px = ax + f * (bx - ax);
      const py = ay + f * (by - ay);
      const dist = Math.hypot(x - px, y - py);
      if (dist < best.dist) best = { dist, x: px, y: py };
    }
    return best;
  }

  // Points along a drawn SVG path, to find the arrow under the pointer.
  function along(path, n = 24) {
    const len = path.getTotalLength();
    return Array.from({ length: n + 1 }, (_, i) => {
      const pt = path.getPointAtLength((len * i) / n);
      return [pt.x, pt.y];
    });
  }

  const linkName = (t) => (t ? t.name || P.KINDS[t.kind].name : '?');
  // Each kind of tile's icon: line drawings on a 24 × 24 grid, all drawn the same way (one stroke
  // width, round ends, the text's colour), so they look alike at any size; `fill` parts are solid.
  const ICONS = {
    start: [{ d: 'M7 4.5 19 12 7 19.5Z', fill: true }],
    end: [{ d: 'M6 6h12v12H6Z', fill: true }],
    step: [{ d: 'M7 5h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z' }],
    dispense: [{ d: 'M12 3c-2.5 3.6-6 7.6-6 11a6 6 0 0 0 12 0c0-3.4-3.5-7.4-6-11Z' }],
    move: [{ d: 'M4 12h15M13 6l6 6-6 6' }],
    mix: [{ d: 'M20 12a8 8 0 1 1-2.34-5.66L20 8.5M20 3.5v5h-5' }],
    merge: [{ d: 'M5 4l7 7 7-7M12 11v9' }],
    split: [{ d: 'M12 4v9M12 13l-7 7M12 13l7 7' }],
    wait: [{ d: 'M6 3h12M6 21h12M8 3c0 5 8 4 8 9s-8 4-8 9M16 3c0 5-8 4-8 9s8 4 8 9' }],
    temperature: [{ d: 'M10 14.5V5a2 2 0 0 1 4 0v9.5a4 4 0 1 1-4 0ZM12 14v3' }],
    magnet: [{ d: 'M5 4v8a7 7 0 0 0 14 0V4h-4v8a3 3 0 0 1-6 0V4ZM5 8h4M15 8h4' }],
    measure: [{ d: 'M3.5 17a8.5 8.5 0 0 1 17 0M12 17l4.5-5.5' }],
    ask: [{ d: 'M9 9a3 3 0 1 1 4.2 2.75c-.75.35-1.2 1.1-1.2 1.95V15M12 19v.01' }],
    decision: [{ d: 'M12 3l9 9-9 9-9-9Z' }],
    repeat: [{ d: 'M17 2l3 3-3 3M4 11V9a4 4 0 0 1 4-4h12M7 22l-3-3 3-3M20 13v2a4 4 0 0 1-4 4H4' }],
    parallel: [{ d: 'M4 8h14M15 5l3 3-3 3M4 16h14M15 13l3 3-3 3' }],
    join: [{ d: 'M8 4v11M5 12l3 3 3-3M16 4v11M13 12l3 3 3-3M4 20h16' }],
  };

  // A kind's icon as an <svg> (in a tile at x, y; or for HTML when no parent is given).
  function icon(kind, size = 16, parent = null, x = 0, y = 0) {
    const svg = el('svg', { class: 'pv-icon', viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': 'true' }, parent);
    if (parent) {
      svg.setAttribute('x', x);
      svg.setAttribute('y', y);
    }
    for (const part of ICONS[kind] || ICONS.step) el('path', { d: part.d, class: part.fill ? 'solid' : '' }, svg);
    return svg;
  }

  // An icon and a label centred on (0, y) in a tile: `chars` wide at `charW` px a character.
  function centredLabel(group, kind, y, value, cls, size, charW) {
    const width = size + 5 + value.length * charW;
    icon(kind, size, group, -width / 2, y - size * 0.82);
    return text(group, -width / 2 + size + 5, y, value, cls);
  }
  const RESERVOIRS = { reservoirLeftTop: 'left top', reservoirLeftBottom: 'left bottom', reservoirRightTop: 'right top', reservoirRightBottom: 'right bottom' };

  function el(tag, attrs = {}, parent = null) {
    const node = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    if (parent) parent.appendChild(node);
    return node;
  }

  function text(parent, x, y, value, cls) {
    const t = el('text', { x, y, class: cls }, parent);
    t.textContent = value;
    return t;
  }

  // Where a tile's output ports are, relative to its centre: at the bottom, except a decision's or
  // a repeat's `side` output (see sidePort), which goes out on the right.
  function portAt(t, port, side = sidePort(t)) {
    const [w, h] = sizeOf(t);
    if (side && port === side) return [w / 2, 0];
    const ports = P.portsOf(t).filter((p) => p !== side);
    const i = ports.indexOf(port);
    const n = ports.length;
    const gap = Math.min(70, (w - 20) / Math.max(1, n));
    return [(i - (n - 1) / 2) * gap, h / 2];
  }

  // Which output of a decision or a repeat goes out on the right side, the other going out at the
  // bottom: "no" or "done"; but "yes" or "again" when only that one goes back up (`back`: the keys
  // of the arrows going back up), so a loop's arrow leaves on the side and the way on goes down.
  function sidePort(t, links = null, back = null) {
    if (t.kind !== 'decision' && t.kind !== 'repeat') return null;
    const [first, second] = P.portsOf(t);
    if (!links || !back) return second;
    const up = (port) => links.some((l) => l.from === t.id && l.port === port && back.has(P.linkKey(l)));
    return up(first) && !up(second) ? first : second;
  }

  // What a tile shows under its name.
  function summary(t, info, process) {
    switch (t.kind) {
      case 'start':
      case 'end':
        return '';
      case 'measure':
        return `${t.value || '?'}${t.unit ? ` (${t.unit})` : ''}`;
      case 'ask':
        return t.answer === 'number' ? `${t.question || ''} → ${t.value}` : `${t.question || ''} (yes/no)`;
      case 'decision':
        return P.conditionText(t, process);
      case 'repeat':
        return `${Math.max(1, t.times || 1)} times`;
      case 'parallel':
        return `${P.lanesOf(t)} lanes at the same time`;
      case 'join':
        return 'waits for every lane';
      default: {
        const bits = [];
        if (t.kind === 'dispense') bits.push(RESERVOIRS[t.reservoir] || 'left top');
        if (t.kind === 'mix' && t.params) {
          const p = t.params;
          bits.push(p.kind === 'backforth' ? `back & forth ×${p.rounds || 2}` : p.kind === 'splitmerge' ? `split & merge ×${p.rounds || 2}` : `circle ${p.size || 2}×${p.size || 2}${p.dir === 'ccw' ? ' ↺' : ''} ×${p.rounds || 3}`);
        }
        if (t.kind === 'wait') bits.push(`${t.seconds || 0} s`);
        if (t.kind === 'temperature') bits.push(`${OD.heat.targetsText(OD.heat.cleanTargets(t.targets))}${t.wait ? ', waits' : ''}`);
        if (t.kind === 'magnet') bits.push(`magnet ${t.magnet === 2 ? 2 : 1} ${t.on === false ? 'off' : 'on'}`);
        const me = info && info.tile.get(t.id);
        if (me && me.placed && me.to) bits.push(`frames ${me.from}–${me.to} · ${seconds(me.ms)}`);
        else if (P.hasWork(t)) bits.push('not placed yet');
        return bits.join(' · ');
      }
    }
  }

  const seconds = (ms) => (ms >= 60000 ? `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s` : `${Math.round(ms / 100) / 10} s`);

  class ProcessView {
    // host: the element it fills. app: { editor, analysis() -> stretch.analyze result,
    // select(id) (a tile was selected), open(id) (open a tile on the board), status(text, kind),
    // changed() (redraw everything), running() -> { tile, stretch } or null }
    constructor(host, app) {
      this.host = host;
      this.app = app;
      this.ed = app.editor;
      this.selected = null; // { tile: id }, { tiles: [id, ...] } (several) or { link: { from, port } }
      this.view = { x: -300, y: -60, zoom: 1 };
      this.fitted = false;
      this.drag = null;
      this.renderKey = '';
      this.wires = []; // the arrows as drawn: [{ link, path }], to find the one under a dragged tile
      this.back = new Set(); // as last drawn: the keys of the arrows going back up (loops)...
      this.sides = new Map(); // ... and tile id -> its output going out on the right (see sidePort)
      this.space = false; // Space held: dragging pans

      this.palette = document.createElement('div');
      this.palette.className = 'pv-palette';
      this.palette.setAttribute('aria-label', 'Tiles: drag one onto the process, or click to add it under the selected tile');
      for (const group of P.PALETTE_GROUPS) {
        const box = document.createElement('div');
        box.className = 'pv-group';
        if (group.name) {
          const head = document.createElement('div');
          head.className = 'pv-group-name';
          head.textContent = group.name;
          box.appendChild(head);
        }
        for (const kind of group.kinds) {
          if (!P.KINDS[kind]) continue;
          const b = document.createElement('button');
          b.type = 'button';
          b.dataset.kind = kind;
          b.className = `pv-kind ${kind}`;
          const about = P.KINDS[kind].about;
          b.title = `${P.KINDS[kind].name}${about ? `: ${about}` : ''}\nDrag it onto the process (or onto an arrow), or click to add it under the selected tile`;
          b.append(icon(kind), P.KINDS[kind].name);
          b.addEventListener('pointerdown', (evt) => this.paletteDown(evt, kind));
          box.appendChild(b);
        }
        this.palette.appendChild(box);
      }
      this.tools = document.createElement('div');
      this.tools.className = 'pv-tools';
      for (const [label, title, fn] of [
        ['Tidy', 'Lay the tiles out top-down', () => this.tidy()],
        ['Fit', 'Show the whole process', () => this.fit()],
      ]) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = label;
        b.title = title;
        b.addEventListener('click', (evt) => {
          evt.currentTarget.blur();
          fn();
        });
        this.tools.appendChild(b);
      }
      this.svg = el('svg', { class: 'pv-canvas' });
      this.svg.setAttribute('tabindex', '0');
      this.menu = document.createElement('div');
      this.menu.className = 'pv-menu';
      this.menu.hidden = true;
      this.empty = document.createElement('p');
      this.empty.className = 'pv-empty';
      host.append(this.svg, this.palette, this.tools, this.menu);

      this.svg.addEventListener('pointerdown', (evt) => this.down(evt));
      this.svg.addEventListener('pointermove', (evt) => this.move(evt));
      this.svg.addEventListener('pointerup', (evt) => this.up(evt));
      this.svg.addEventListener('pointercancel', () => this.cancelDrag());
      this.svg.addEventListener('auxclick', (evt) => evt.preventDefault()); // no middle-click paste or scroll
      const spaceUp = () => {
        this.space = false;
        this.host.classList.remove('pv-space');
      };
      window.addEventListener('keyup', (evt) => {
        if (evt.key === ' ') spaceUp();
      });
      window.addEventListener('blur', spaceUp);
      this.svg.addEventListener('dblclick', (evt) => {
        const hit = this.hit(evt.target);
        if (hit && hit.tile) this.app.open(hit.tile);
      });
      this.svg.addEventListener(
        'wheel',
        (evt) => {
          evt.preventDefault();
          if (evt.ctrlKey || evt.metaKey) {
            const [mx, my] = this.toWorld(evt.clientX, evt.clientY);
            const zoom = Math.min(2.5, Math.max(0.3, this.view.zoom * (evt.deltaY < 0 ? 1.12 : 0.89)));
            this.view.x = mx - (mx - this.view.x) * (this.view.zoom / zoom);
            this.view.y = my - (my - this.view.y) * (this.view.zoom / zoom);
            this.view.zoom = zoom;
          } else {
            this.view.x += evt.deltaX / this.view.zoom;
            this.view.y += evt.deltaY / this.view.zoom;
          }
          this.render(true);
        },
        { passive: false }
      );
      new ResizeObserver(() => this.render(true)).observe(host);
    }

    get process() {
      return this.ed.doc.process;
    }

    // --- coordinates ----------------------------------------------------------------------------

    size() {
      return [this.host.clientWidth || 800, this.host.clientHeight || 600];
    }

    toWorld(cx, cy) {
      const r = this.svg.getBoundingClientRect();
      return [this.view.x + (cx - r.left) / this.view.zoom, this.view.y + (cy - r.top) / this.view.zoom];
    }

    fit() {
      const p = this.process;
      if (!p || !p.tiles.length) return;
      const [w, h] = this.size();
      const box = this.bounds(p.tiles);
      const zoom = Math.min(1.6, Math.max(0.3, Math.min((w - 220) / (box.w + 120), (h - 40) / (box.h + 120))));
      this.view.zoom = zoom;
      this.view.x = box.x - 60 - (w / zoom - box.w - 120) / 2 - 80 / zoom;
      this.view.y = box.y - 60 - Math.max(0, (h / zoom - box.h - 120) / 2);
      this.render(true);
    }

    bounds(tiles) {
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const t of tiles) {
        const [w, h] = sizeOf(t);
        const [x, y] = this.posOf(t);
        x0 = Math.min(x0, x - w / 2);
        y0 = Math.min(y0, y - h / 2);
        x1 = Math.max(x1, x + w / 2);
        y1 = Math.max(y1, y + h / 2);
      }
      return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }

    // A tile's position, following a drag in progress (every selected tile moves the same way).
    posOf(t) {
      const d = this.drag;
      if (d && d.kind === 'move' && d.moved && d.ids.includes(t.id)) return [Math.round(t.x + d.dx), Math.round(t.y + d.dy)];
      return [t.x, t.y];
    }

    // The selected tiles' ids.
    selectedIds() {
      const s = this.selected;
      return s ? (s.tile ? [s.tile] : s.tiles || []) : [];
    }

    // Whether tile id shows as selected (also while a box is dragged round it).
    isSelected(id) {
      const d = this.drag;
      if (d && d.kind === 'box' && (d.hits.includes(id) || (d.add && d.base.includes(id)))) return true;
      return this.selectedIds().includes(id);
    }

    // Where output `port` of tile t is, relative to its centre, as drawn.
    portOf(t, port) {
      return portAt(t, port, this.sides.has(t.id) ? this.sides.get(t.id) : sidePort(t));
    }

    // Whether the arrow from tile t's output `port` to tile `to` goes back up: a loop's, or one
    // into a tile placed higher than the output. It comes into the tile's side. (`drawn`: a new
    // arrow being drawn from that output, not the one it has now.)
    goesUp(t, port, to, drawn = false) {
      if (!drawn && this.back.has(P.linkKey({ from: t.id, port }))) return true;
      const [, sy] = this.posOf(t);
      const [, ty] = this.posOf(to);
      return ty - sizeOf(to)[1] / 2 < sy + this.portOf(t, port)[1] + 12;
    }

    // Each tile's input points on top and which arrow ends at which: Map(id -> { n, pts, of:
    // Map(arrow key -> point) }). Arrows take a tile's points left to right by where they come
    // from; arrows going back up come into its side instead. `extra` is an arrow being drawn,
    // counted in for its target.
    inputLayouts(p, g, extra = null) {
      const out = new Map();
      for (const t of p.tiles) {
        let ins = g.into.get(t.id).filter((l) => !this.goesUp(g.byId.get(l.from), l.port, t));
        if (extra && extra.to === t.id) ins = [...ins.filter((l) => !(l.from === extra.from && l.port === extra.port)), extra];
        out.set(t.id, this.inputLayout(t, ins, g.byId));
      }
      return out;
    }

    // One tile's input points (ins: the arrows coming in on top).
    inputLayout(t, ins, byId) {
      const n = P.inputsOf(t, { links: ins });
      const pts = Array.from({ length: n }, (_, i) => inAt(t, i, n));
      const of = new Map();
      const [tx] = this.posOf(t);
      const from = ins
        .map((l) => {
          const s = byId.get(l.from);
          return { key: P.linkKey(l), x: this.posOf(s)[0] + this.portOf(s, l.port)[0], y: this.posOf(s)[1] };
        })
        .sort((a, b) => a.x - b.x || a.y - b.y || (a.key < b.key ? -1 : 1));
      const k = from.length;
      let prev = -1;
      from.forEach((f, i) => {
        if (k >= n) {
          of.set(f.key, Math.min(i, n - 1));
          return;
        }
        // Fewer arrows than points: each takes the nearest point that leaves room for the rest.
        let best = prev + 1;
        for (let j = prev + 1; j <= n - (k - i); j++) if (Math.abs(f.x - tx - pts[j][0]) < Math.abs(f.x - tx - pts[best][0])) best = j;
        of.set(f.key, best);
        prev = best;
      });
      return { n, pts, of };
    }

    // How the arrow from tile t's output `port` to tile `to` goes: { d, tip, dir, up, onSide, at },
    // `at` being the input point it ends on, relative to the tile's centre. Going down it ends on
    // its point on top (in `ins`, from inputLayouts). Going back up it goes round the right of the
    // loop (`loops`: arrow key -> { right, left }, the x to go up at) into the tile's right side;
    // round the left into its left side when the tile has an output on its right (a decision, a
    // repeat), or when a tile is in its way and none is on the left. An arrow leaving on the right
    // always goes round the right; into a tile with an output there too, over the top. (`drawn`:
    // a new arrow being drawn, see goesUp.)
    route(t, port, to, ins, loops, drawn = false) {
      const [fx, fy] = this.posOf(t);
      const [ox, oy] = this.portOf(t, port);
      const sx = fx + ox;
      const sy = fy + oy;
      const side = ox !== 0 && oy === 0;
      const [tx, ty] = this.posOf(to);
      const [tw, th] = sizeOf(to);
      const key = P.linkKey({ from: t.id, port });
      if (!this.goesUp(t, port, to, drawn)) {
        const lay = ins.get(to.id);
        const [ix, iy] = (lay && lay.pts[lay.of.get(key)]) || [0, -th / 2];
        return { ...downArrow(sx, sy, side, tx + ix, ty + iy), up: false, onSide: false, at: [ix, iy] };
      }
      const loop = loops.get(key);
      const rightAt = Math.max(loop ? loop.right : -Infinity, sx + 30, tx + tw / 2 + 30);
      const leftAt = Math.min(loop ? loop.left : Infinity, tx - tw / 2 - 24, sx - 40);
      const sidePorted = to.kind === 'decision' || to.kind === 'repeat';
      if (side && sidePorted) return { ...overArrow(sx, sy, tx, ty - th / 2, rightAt), up: true, onSide: false, at: [0, -th / 2] };
      // Another tile in the way, on the tile's row between it and x0..x1.
      const blocked = (x0, x1) =>
        this.process.tiles.some((o) => {
          if (o.id === to.id || o.id === t.id) return false;
          const [ow, oh] = sizeOf(o);
          const [cx, cy] = this.posOf(o);
          return cx + ow / 2 > x0 && cx - ow / 2 < x1 && Math.abs(cy - ty) < oh / 2 + 8;
        });
      let left = !side && sidePorted;
      if (!side) {
        const rightFree = !blocked(tx + tw / 2, rightAt);
        const leftFree = !blocked(leftAt, tx - tw / 2);
        if (left ? !leftFree && rightFree : !rightFree && leftFree) left = !left;
      }
      const ex = left ? tx - tw / 2 : tx + tw / 2;
      return { ...upArrow(sx, sy, side, ex, ty, left ? leftAt : rightAt, left), up: true, onSide: true, at: [ex - tx, 0] };
    }

    // --- drawing ----------------------------------------------------------------------------------

    render(force = false) {
      const p = this.process;
      if (!p) return;
      if (!this.fitted && this.host.clientWidth) {
        this.fitted = true;
        this.fit();
        return;
      }
      const info = this.app.analysis();
      const run = this.app.running();
      const key = JSON.stringify([p, this.selected, this.view, this.drag, run, this.ed.revision]);
      if (!force && key === this.renderKey) return;
      this.renderKey = key;
      const [w, h] = this.size();
      this.svg.setAttribute('viewBox', `${this.view.x} ${this.view.y} ${w / this.view.zoom} ${h / this.view.zoom}`);
      this.svg.replaceChildren();
      const g = P.graph(p);
      const back = P.backLinks(p, g);
      this.back = back;
      this.sides = new Map(p.tiles.map((t) => [t.id, sidePort(t, p.links, back)]));
      const issues = P.check(p);
      const byId = g.byId;

      // Loops: a dashed frame round their tiles, the condition on top.
      const frames = el('g', { class: 'pv-loops' }, this.svg);
      const loops = new Map(); // key of the arrow going back up -> { right, left }: the x it goes up at
      for (const lp of P.loops(p, g, back)) {
        const box = this.bounds(lp.tiles.map((id) => byId.get(id)));
        const x = box.x - 18;
        const y = box.y - 34;
        const width = box.w + 36 + 40;
        const height = box.h + 50;
        el('rect', { x, y, width, height, rx: 14, class: `pv-loop${lp.endless ? ' bad' : ''}` }, frames);
        // The label goes right of where the arrow comes into the loop, so the arrow doesn't cross it.
        const head = byId.get(lp.to);
        text(frames, Math.max(x + 14, this.posOf(head)[0] + 12), y + 22, `↻ ${lp.label}`, 'pv-loop-label');
        loops.set(P.linkKey(lp), { right: x + width - 20, left: x + 9 });
      }

      // Input points on top: one per tile, or one per arrow coming in on a merge or join. A new
      // arrow being drawn that snaps to a tile's top is counted in, so they show where it goes.
      const d = this.drag;
      const wire = d && d.kind === 'wire' ? d : null;
      const snap = wire ? wire.snap : null;
      const ins = this.inputLayouts(p, g, snap && !snap.up ? { from: wire.from, port: wire.port, to: snap.tile } : null);

      // Arrows: from the middle of their output dot to their input dot, the arrowhead's tip on its
      // edge. Going down they end at their point on top; going back up they come into the tile's
      // side, where a point is drawn for them (in sideIns: tile id -> [[x, y] relative]).
      const links = el('g', { class: 'pv-links' }, this.svg);
      const sideIns = new Map();
      this.wires = [];
      for (const t of p.tiles) {
        for (const l of g.out.get(t.id)) {
          const to = byId.get(l.to);
          const r = this.route(t, l.port, to, ins, loops);
          if (r.onSide) {
            if (!sideIns.has(to.id)) sideIns.set(to.id, []);
            sideIns.get(to.id).push(r.at);
          }
          const sel = this.selected && this.selected.link && this.selected.link.from === l.from && this.selected.link.port === l.port;
          const drop = d && d.onLink && d.onLink.from === l.from && d.onLink.port === l.port;
          const group = el('g', { class: `pv-link${sel ? ' selected' : ''}${back.has(P.linkKey(l)) ? ' back' : ''}${drop ? ' drop' : ''}`, 'data-from': l.from, 'data-port': l.port }, links);
          const wirePath = el('path', { d: r.d, class: 'pv-wire' }, group);
          el('path', { d: r.d, class: 'pv-hit' }, group);
          el('polygon', { points: arrowHead(r.tip[0], r.tip[1], r.dir[0], r.dir[1]), class: 'pv-tip' }, group);
          this.wires.push({ link: { from: l.from, port: l.port, to: l.to }, path: wirePath });
        }
      }

      // Tiles.
      const tiles = el('g', { class: 'pv-tiles' }, this.svg);
      const running = run && run.stretch ? new Set((info.st.list.find((s) => s.id === run.stretch) || { tiles: [] }).tiles) : new Set();
      for (const t of p.tiles) {
        const [x, y] = this.posOf(t);
        const [w, hh] = sizeOf(t);
        const mine = issues.filter((i) => i.tile === t.id);
        const board = info && info.tile.get(t.id) ? info.tile.get(t.id).problems : [];
        const errors = mine.filter((i) => i.level === 'error').map((i) => i.text);
        const warns = [...mine.filter((i) => i.level !== 'error').map((i) => i.text), ...board];
        const cls = ['pv-tile', t.kind];
        if (this.isSelected(t.id)) cls.push('selected');
        if (snap && snap.tile === t.id) cls.push('target');
        if (this.ed.scope && this.ed.scope.tile === t.id) cls.push('open');
        if (running.has(t.id) || (run && run.tile === t.id)) cls.push('running');
        if (P.hasWork(t) && info && info.tile.get(t.id) && !info.tile.get(t.id).placed) cls.push('unplaced');
        const group = el('g', { class: cls.join(' '), 'data-tile': t.id, transform: `translate(${x},${y})` }, tiles);
        if (cls.includes('target')) el('rect', { x: -w / 2 - 7, y: -hh / 2 - 7, width: w + 14, height: hh + 14, rx: 14, class: 'pv-target' }, group);
        shape(group, t, w, hh);
        const name = t.kind === 'decision' ? '' : t.name || P.KINDS[t.kind].name;
        if (t.kind === 'parallel' || t.kind === 'join') {
          // On the bar itself, so nothing sticks out where arrows come in at its ends.
          const what = t.kind === 'parallel' ? ` · ${P.lanesOf(t)} lanes` : '';
          centredLabel(group, t.kind, 3.5, `${P.KINDS[t.kind].name}${what}`, 'pv-bar-label', 11, 6.3);
        } else if (t.kind === 'start' || t.kind === 'end') {
          centredLabel(group, t.kind, 5, name, 'pv-name', 13, 7.6);
        } else if (t.kind === 'decision') {
          centredLabel(group, 'decision', -4, 'if', 'pv-sub', 11, 6);
          text(group, 0, 14, summary(t, info, p), 'pv-name centre');
        } else {
          icon(t.kind, 14, group, -w / 2 + 14, -6 - 11.5);
          const head = text(group, -w / 2 + 33, -6, name, 'pv-name');
          // The droplets it works on, by their short names, after its name where they fit.
          const me = info && info.tile.get(t.id);
          const drops = me && me.droplets ? [...new Set(me.droplets.map((n) => OD.project.shortDroplet(n)))].join(', ') : '';
          const room = Math.floor((w - 28 - (name.length + 2) * 7.6) / 6.2) - 3;
          if (drops && room >= 2) el('tspan', { class: 'pv-drops' }, head).textContent = ` · ${drops.length > room ? `${drops.slice(0, room - 1)}…` : drops}`;
          text(group, -w / 2 + 14, 14, clip(summary(t, info, p), w), 'pv-sub');
        }
        if (errors.length || warns.length) {
          const badge = el('g', { class: `pv-badge${errors.length ? ' error' : ''}`, transform: `translate(${w / 2 - 4},${-hh / 2 + 2})` }, group);
          el('circle', { r: 9 }, badge);
          text(badge, 0, 4, '!', 'centre');
          el('title', {}, badge).textContent = [...errors, ...warns].join('\n');
        }
        el('title', {}, group).textContent = `${P.KINDS[t.kind].name}${t.name && t.kind !== 'decision' ? `: ${t.name}` : ''}${P.hasWork(t) ? ' (double-click to open on the board)' : ''}`;
        const ports = P.portsOf(t);
        for (const port of ports) {
          const [px, py] = this.portOf(t, port);
          el('circle', { cx: px, cy: py, r: 7, class: 'pv-port', 'data-port': port }, group);
          // Which output is which, connected or not: by it, above one on the side, below one at the bottom.
          if (ports.length > 1) text(group, px + 8, py + (py === 0 ? -8 : 17), P.portName(port), 'pv-port-label');
        }
        ins.get(t.id).pts.forEach(([ix, iy], i) => {
          const snapped = snap && !snap.up && snap.tile === t.id && snap.index === i;
          el('circle', { cx: ix, cy: iy, r: snapped ? 7 : IN_R, class: `pv-in${snapped ? ' snap' : ''}` }, group);
        });
        for (const [ix, iy] of sideIns.get(t.id) || []) el('circle', { cx: ix, cy: iy, r: IN_R, class: 'pv-in' }, group);
        if (snap && snap.up && snap.tile === t.id) el('circle', { cx: snap.x - x, cy: snap.y - y, r: 7, class: 'pv-in snap' }, group);
      }

      // A connection, a new tile or a selection box being dragged. A connection snapped to a tile
      // is drawn as the arrow it will be.
      if (wire && snap) {
        const r = this.route(byId.get(wire.from), wire.port, byId.get(snap.tile), ins, new Map(), true);
        el('path', { d: r.d, class: 'pv-rubber' }, this.svg);
        el('polygon', { points: arrowHead(r.tip[0], r.tip[1], r.dir[0], r.dir[1]), class: 'pv-rubber-tip' }, this.svg);
      } else if (wire) {
        const k = Math.max(20, Math.abs(wire.y - wire.sy) / 2);
        const c1 = wire.side ? `${wire.sx + Math.max(30, Math.abs(wire.x - wire.sx) * 0.6)},${wire.sy}` : `${wire.sx},${wire.sy + k}`;
        el('path', { d: `M${wire.sx},${wire.sy} C${c1} ${wire.x},${wire.y - k} ${wire.x},${wire.y}`, class: 'pv-rubber' }, this.svg);
      }
      if (d && d.kind === 'new' && d.over) {
        const [w, hh] = sizeOf({ kind: d.tileKind });
        el('rect', { x: d.x - w / 2, y: d.y - hh / 2, width: w, height: hh, rx: 10, class: 'pv-ghost' }, this.svg);
      }
      if (d && d.onLink && d.hint) {
        // Over an arrow: say what dropping does.
        const hint = el('g', { class: 'pv-hint', transform: `translate(${d.hint[0] + 14},${d.hint[1] - 14})` }, this.svg);
        el('rect', { x: -6, y: -15, width: 134, height: 21, rx: 6 }, hint);
        text(hint, 0, 0, 'Drop to put it here', '');
      }
      if (d && d.kind === 'box') {
        el('rect', { x: Math.min(d.x0, d.x), y: Math.min(d.y0, d.y), width: Math.abs(d.x - d.x0), height: Math.abs(d.y - d.y0), class: 'pv-box' }, this.svg);
      }
    }

    // --- pointer ------------------------------------------------------------------------------------

    hit(target) {
      const port = target.closest && target.closest('.pv-port');
      const tile = target.closest && target.closest('.pv-tile');
      const link = target.closest && target.closest('.pv-link');
      if (port && tile) return { tile: tile.dataset.tile, port: port.dataset.port };
      if (tile) return { tile: tile.dataset.tile };
      if (link) return { link: { from: link.dataset.from, port: link.dataset.port } };
      return null;
    }

    tileAt(x, y) {
      const p = this.process;
      for (let i = p.tiles.length - 1; i >= 0; i--) {
        const t = p.tiles[i];
        const [w, h] = sizeOf(t);
        if (Math.abs(x - t.x) <= w / 2 + 6 && Math.abs(y - t.y) <= h / 2 + 6) return t;
      }
      return null;
    }

    down(evt) {
      if (evt.button !== 0 && evt.button !== 1) return;
      evt.preventDefault(); // no text selection while dragging on the canvas
      this.menu.hidden = true;
      this.svg.focus({ preventScroll: true });
      const [x, y] = this.toWorld(evt.clientX, evt.clientY);
      const hit = this.hit(evt.target);
      this.svg.setPointerCapture(evt.pointerId);
      if (evt.button === 1 || this.space || (evt.altKey && !hit)) {
        // Panning: middle button, Space+drag, or Alt+drag on empty space.
        this.drag = { kind: 'pan', cx: evt.clientX, cy: evt.clientY, vx: this.view.x, vy: this.view.y };
        this.host.classList.add('pv-panning');
        this.render();
        return;
      }
      if (hit && hit.tile && evt.shiftKey) {
        // Shift+click: the tile joins the selection, or leaves it.
        const ids = this.selectedIds();
        const on = !ids.includes(hit.tile);
        const next = on ? [...ids, hit.tile] : ids.filter((id) => id !== hit.tile);
        this.select(next.length ? { tiles: next } : null);
        if (on && !this.ed.frozen) this.startMove(hit.tile, x, y, false);
        this.render();
        return;
      }
      if (this.ed.frozen) {
        if (hit && hit.tile) this.select({ tile: hit.tile });
        else if (!hit) this.select(null);
        return;
      }
      if (hit && hit.port) {
        const t = P.tileById(this.process, hit.tile);
        const [ox, oy] = this.portOf(t, hit.port);
        this.drag = { kind: 'wire', from: hit.tile, port: hit.port, sx: t.x + ox, sy: t.y + oy, side: ox !== 0 && oy === 0, x, y, snap: null };
      } else if (hit && hit.tile) {
        // On a tile of a selection of several, they all move; a click without moving keeps just it.
        const ids = this.selectedIds();
        const group = ids.length > 1 && ids.includes(hit.tile);
        if (!group) this.select({ tile: hit.tile });
        this.startMove(hit.tile, x, y, group);
      } else if (hit && hit.link) {
        this.select({ link: hit.link });
      } else {
        // Empty space: a box selects every tile it touches (with Shift, adds them).
        const base = evt.shiftKey ? this.selectedIds() : [];
        if (!evt.shiftKey) this.select(null);
        this.drag = { kind: 'box', x0: x, y0: y, x, y, add: evt.shiftKey, base, hits: [] };
      }
      this.render();
    }

    // Starts moving the selected tiles, grabbed by tile id at x, y.
    startMove(id, x, y, collapse) {
      const p = this.process;
      const ids = this.selectedIds().filter((s) => P.tileById(p, s));
      // A single tile with no arrows in or out can be dropped onto an arrow.
      const loose = ids.length === 1 && P.takesInput(P.tileById(p, id)) && !p.links.some((l) => l.from === id || l.to === id);
      this.drag = { kind: 'move', grab: id, ids, x0: x, y0: y, dx: 0, dy: 0, moved: false, collapse, loose, onLink: null, hint: null };
    }

    move(evt) {
      const d = this.drag;
      if (!d) return;
      const [x, y] = this.toWorld(evt.clientX, evt.clientY);
      if (d.kind === 'pan') {
        this.view.x = d.vx - (evt.clientX - d.cx) / this.view.zoom;
        this.view.y = d.vy - (evt.clientY - d.cy) / this.view.zoom;
      } else if (d.kind === 'move') {
        // Free movement, no grid; it counts as a move after 3 pixels on screen.
        d.dx = Math.round(x - d.x0);
        d.dy = Math.round(y - d.y0);
        if (Math.hypot(d.dx, d.dy) * this.view.zoom > 3) d.moved = true;
        this.overLink(d, x, y);
      } else if (d.kind === 'wire') {
        d.x = x;
        d.y = y;
        d.snap = this.snapTarget(d, x, y);
      } else if (d.kind === 'box') {
        d.x = x;
        d.y = y;
        const [x0, x1] = [Math.min(d.x0, x), Math.max(d.x0, x)];
        const [y0, y1] = [Math.min(d.y0, y), Math.max(d.y0, y)];
        d.hits = this.process.tiles
          .filter((t) => {
            const [w, h] = sizeOf(t);
            return t.x + w / 2 >= x0 && t.x - w / 2 <= x1 && t.y + h / 2 >= y0 && t.y - h / 2 <= y1;
          })
          .map((t) => t.id);
      }
      this.render();
    }

    up(evt) {
      const d = this.drag;
      this.drag = null;
      this.host.classList.remove('pv-panning');
      if (!d) return;
      const [x, y] = this.toWorld(evt.clientX, evt.clientY);
      if (d.kind === 'move' && d.moved) {
        const t = P.tileById(this.process, d.grab);
        if (d.onLink && t) this.putOnLink(d.onLink, (p) => P.tileById(p, d.grab), t.x + d.dx, t.y + d.dy);
        else {
          this.ed.processChange((p) => {
            for (const id of d.ids) {
              const s = P.tileById(p, id);
              if (s) P.moveTile(p, id, s.x + d.dx, s.y + d.dy);
            }
          });
          if (d.ids.length > 1) this.app.status(`Moved ${d.ids.length} tiles`);
          this.app.changed();
        }
      } else if (d.kind === 'move' && d.collapse) {
        this.select({ tile: d.grab });
      } else if (d.kind === 'wire') {
        const target = d.snap ? P.tileById(this.process, d.snap.tile) : this.tileAt(x, y);
        if (target && target.id !== d.from) this.connect(d.from, d.port, target.id);
        else if (!target) this.offerTiles(evt.clientX, evt.clientY, (kind) => this.addTile(kind, Math.round(x), Math.round(y) + 30, { from: d.from, port: d.port }));
      } else if (d.kind === 'box') {
        const ids = d.add ? [...d.base, ...d.hits.filter((id) => !d.base.includes(id))] : d.hits;
        this.select(ids.length ? { tiles: ids } : null);
      }
      this.render(true);
    }

    // Where a new arrow being dragged would end, with the pointer at x, y: on the tile whose input
    // point is nearest, within SNAP_PX on screen, else on the tile under the pointer. The point is
    // the one the arrow will really take: its place among a merge's points on top (`extra`: a
    // merge or join with every point taken gets one more), or one on the tile's side for an arrow
    // going back up (`up`). { tile, index, x, y, up, extra } or null.
    snapTarget(d, x, y) {
      const p = this.process;
      const g = P.graph(p);
      const from = g.byId.get(d.from);
      const spot = (t) => {
        if (t.id === d.from || !P.takesInput(t)) return null;
        const [tx, ty] = this.posOf(t);
        if (this.goesUp(from, d.port, t, true)) {
          const r = this.route(from, d.port, t, new Map(), new Map(), true);
          return { tile: t.id, index: null, x: tx + r.at[0], y: ty + r.at[1], up: true, extra: false };
        }
        const link = { from: d.from, port: d.port, to: t.id };
        const mine = (l) => l.from === d.from && l.port === d.port; // the arrow this one replaces
        const ins = g.into.get(t.id).filter((l) => !mine(l) && !this.goesUp(g.byId.get(l.from), l.port, t));
        const now = this.inputLayout(t, ins, g.byId);
        const withIt = this.inputLayout(t, [...ins, link], g.byId);
        const index = withIt.of.get(P.linkKey(link));
        const [ix, iy] = withIt.pts[index];
        return { tile: t.id, index, x: tx + ix, y: ty + iy, up: false, extra: withIt.n > now.n };
      };
      const spots = p.tiles.map(spot).filter(Boolean);
      const dist = (s) => Math.hypot(s.x - x, s.y - y);
      const close = spots.filter((s) => dist(s) <= SNAP_PX / this.view.zoom).sort((a, b) => dist(a) - dist(b));
      if (close.length) return close[0];
      const under = this.tileAt(x, y);
      return (under && spots.find((s) => s.tile === under.id)) || null;
    }

    // While a loose tile (or a new one) is dragged: the arrow near the pointer, if any, in
    // d.onLink, and the nearest point on it in d.hint.
    overLink(d, x, y) {
      d.onLink = null;
      d.hint = null;
      if (!(d.kind === 'new' ? d.over && P.takesInput({ kind: d.tileKind }) : d.loose && d.moved)) return;
      let best = null;
      for (const w of this.wires) {
        if (!w.pts) w.pts = along(w.path);
        const near = nearOnLine(w.pts, x, y);
        if (near.dist <= DROP_PX / this.view.zoom && (!best || near.dist < best.near.dist)) best = { link: w.link, near };
      }
      if (best) {
        d.onLink = best.link;
        d.hint = [Math.round(best.near.x), Math.round(best.near.y)];
      }
    }

    // Puts a tile (make(p) gives it: a loose one, or a new one) at x, y on the arrow `link`:
    // from --port--> tile --its first output--> where the arrow went, with room made for it. One
    // undoable change.
    putOnLink(link, make, x, y) {
      let tile = null;
      let why = null;
      this.ed.processChange((p) => {
        tile = make(p);
        P.moveTile(p, tile.id, x, y);
        why = P.link(p, link.from, link.port, tile.id);
        if (!why && P.portsOf(tile).length) {
          why = P.link(p, tile.id, P.portsOf(tile)[0], link.to);
          if (!why) this.makeRoom(p, tile.id, link);
        }
      });
      if (!tile) return;
      const p = this.process;
      const name = linkName(P.tileById(p, tile.id));
      const fromName = linkName(P.tileById(p, link.from));
      const toName = linkName(P.tileById(p, link.to));
      if (why) this.app.status(`Put ${name} there; not connected: ${why}`, 'warn');
      else if (P.portsOf(tile).length) this.app.status(`Put ${name} between ${fromName} and ${toName}`);
      else this.app.status(`Put ${name} after ${fromName}: it has no way out, so the arrow to ${toName} is gone`);
      this.select({ tile: tile.id });
      this.app.changed();
    }

    // Room for tile `id`, just put on an arrow going down (link: from --port--> to): it lines up
    // under the tile the arrow came from (under the tile it went to, when it came from a side
    // output or a lane), at least a gap below it; and when the tile the arrow went to is now too
    // near under it, that tile and every tile as low or lower move down to make room.
    makeRoom(p, id, link) {
      const t = P.tileById(p, id);
      const from = P.tileById(p, link.from);
      const to = P.tileById(p, link.to);
      if (!t || !from || !to) return;
      const [px, py] = this.portOf(from, link.port);
      const top = to.y - sizeOf(to)[1] / 2;
      if (top < from.y + py + 12) return; // an arrow going back up or across: it stays where it was dropped
      const [, h] = sizeOf(t);
      t.x = px === 0 && from.kind !== 'parallel' ? from.x : to.x;
      t.y = Math.round(Math.max(t.y, from.y + sizeOf(from)[1] / 2 + P.GAP_Y + h / 2));
      const need = Math.round(t.y + h / 2 + P.GAP_Y - top);
      if (need > 0) for (const o of p.tiles) if (o.id !== id && o.y >= top) o.y += need;
    }

    cancelDrag() {
      this.drag = null;
      this.host.classList.remove('pv-panning');
      this.render(true);
    }

    connect(from, port, to) {
      let why = null;
      const done = this.ed.processChange((p) => {
        why = P.link(p, from, port, to);
      });
      if (why) this.app.status(`Not connected: ${why}`, 'warn');
      else if (done) this.app.status('Connected');
      this.app.changed();
    }

    // A small menu of tile kinds at the pointer (after dragging an arrow into empty space).
    offerTiles(cx, cy, pick) {
      const host = this.host.getBoundingClientRect();
      this.menu.replaceChildren();
      const kinds = P.PALETTE;
      for (const kind of kinds.filter((k) => k !== 'start' && P.KINDS[k])) {
        const b = document.createElement('button');
        b.type = 'button';
        b.append(icon(kind), P.KINDS[kind].name);
        if (P.KINDS[kind].about) b.title = P.KINDS[kind].about;
        b.addEventListener('click', () => {
          this.menu.hidden = true;
          pick(kind);
        });
        this.menu.appendChild(b);
      }
      this.menu.style.left = `${Math.min(host.width - 160, cx - host.left)}px`;
      this.menu.style.top = `${Math.min(host.height - 300, cy - host.top)}px`;
      this.menu.hidden = false;
    }

    // --- adding tiles -----------------------------------------------------------------------------

    paletteDown(evt, kind) {
      if (evt.button !== 0 || this.ed.frozen) return;
      evt.preventDefault();
      const button = evt.currentTarget;
      button.setPointerCapture(evt.pointerId);
      const drag = { kind: 'new', tileKind: kind, over: false, x: 0, y: 0, moved: false, onLink: null, hint: null };
      this.drag = drag;
      const sx = evt.clientX;
      const sy = evt.clientY;
      const moveTo = (e) => {
        const r = this.svg.getBoundingClientRect();
        drag.over = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom && e.clientX > this.palette.getBoundingClientRect().right;
        const [wx, wy] = this.toWorld(e.clientX, e.clientY);
        [drag.x, drag.y] = [Math.round(wx), Math.round(wy)];
        if (Math.hypot(e.clientX - sx, e.clientY - sy) > 6) drag.moved = true;
        this.overLink(drag, wx, wy);
        this.render();
      };
      const finish = (e) => {
        button.removeEventListener('pointermove', moveTo);
        button.removeEventListener('pointerup', finish);
        button.removeEventListener('pointercancel', cancel);
        this.drag = null;
        if (drag.moved && drag.over && drag.onLink) this.putOnLink(drag.onLink, (p) => P.addTile(p, kind, drag.x, drag.y), drag.x, drag.y);
        else if (drag.moved && drag.over) this.addTile(kind, drag.x, drag.y);
        else if (!drag.moved) this.addBelow(kind);
        this.render(true);
        void e;
      };
      const cancel = () => {
        this.drag = null;
        this.render(true);
      };
      button.addEventListener('pointermove', moveTo);
      button.addEventListener('pointerup', finish);
      button.addEventListener('pointercancel', cancel);
    }

    // A clicked palette tile goes under the selected one, joined to its first free output, or in
    // between it and the tile it led to; with nothing selected, under the lowest tile.
    addBelow(kind) {
      const p = this.process;
      const sel = this.selected && this.selected.tile ? P.tileById(p, this.selected.tile) : null;
      const base = sel || p.tiles.reduce((low, t) => (!low || t.y > low.y ? t : low), null);
      const x = base ? base.x : 0;
      const y = base ? base.y + P.ROW : 0;
      let from = null;
      if (sel && P.portsOf(sel).length) {
        const used = new Set(p.links.filter((l) => l.from === sel.id).map((l) => l.port));
        const port = P.portsOf(sel).find((pt) => !used.has(pt)) || P.portsOf(sel)[0];
        from = { from: sel.id, port };
      }
      this.addTile(kind, x, y, from);
    }

    addTile(kind, x, y, from = null) {
      let tile = null;
      let why = null;
      this.ed.processChange((p) => {
        // Clear room: tiles below this point in its column move down a row.
        if (from) for (const t of p.tiles) if (Math.abs(t.x - x) < 100 && t.y >= y - 10) t.y += P.ROW;
        tile = P.addTile(p, kind, x, y);
        if (from) {
          const old = p.links.find((l) => l.from === from.from && l.port === from.port);
          why = P.link(p, from.from, from.port, tile.id);
          if (old && !why && P.portsOf(tile).length) P.link(p, tile.id, P.portsOf(tile)[0], old.to);
        }
      });
      if (!tile) return;
      this.show(tile.id);
      this.select({ tile: tile.id });
      this.app.status(why ? `Added ${P.KINDS[kind].name}; not connected: ${why}` : `Added ${P.KINDS[kind].name}`);
      this.app.changed();
    }

    tidy() {
      this.ed.processChange((p) => P.tidy(p));
      this.app.status('Tidied: top-down, with lanes and other ways side by side');
      this.fit();
      this.app.changed();
    }

    // Pans so tile id is on screen (after adding it, say).
    show(id) {
      const t = P.tileById(this.process, id);
      if (!t) return;
      const [w, h] = this.size();
      const [tw, th] = sizeOf(t);
      const vw = w / this.view.zoom;
      const vh = h / this.view.zoom;
      const left = this.view.x + 140 / this.view.zoom; // right of the palette
      if (t.x - tw / 2 < left) this.view.x -= left - (t.x - tw / 2) + 20;
      if (t.x + tw / 2 > this.view.x + vw) this.view.x += t.x + tw / 2 - (this.view.x + vw) + 20;
      if (t.y - th / 2 < this.view.y) this.view.y -= this.view.y - (t.y - th / 2) + 30;
      if (t.y + th / 2 > this.view.y + vh) this.view.y += t.y + th / 2 - (this.view.y + vh) + 40;
    }

    // --- selection and keys ---------------------------------------------------------------------------

    // Selects one tile ({ tile }), several ({ tiles: [...] }), an arrow ({ link }) or nothing.
    select(sel) {
      if (sel && sel.tiles) sel = sel.tiles.length > 1 ? { tiles: [...sel.tiles] } : sel.tiles.length ? { tile: sel.tiles[0] } : null;
      this.selected = sel;
      this.app.select(sel && sel.tile ? sel.tile : null);
      if (sel && sel.tiles) this.app.status(`${sel.tiles.length} tiles selected`);
      this.render();
    }

    // A key while the process view is on; true if it was used.
    key(evt) {
      const sel = this.selected;
      if (evt.key === ' ') {
        // Held, dragging pans.
        this.space = true;
        this.host.classList.add('pv-space');
        return true;
      }
      if (evt.key === 'Escape') {
        this.menu.hidden = true;
        if (this.drag) this.cancelDrag();
        else this.select(null);
        return true;
      }
      if (!sel || this.ed.frozen) return false;
      const ids = this.selectedIds().filter((id) => P.tileById(this.process, id));
      if (ids.length > 1) return this.keyMany(evt, ids);
      if (evt.key === 'Delete' || evt.key === 'Backspace') {
        if (sel.tile) {
          const t = P.tileById(this.process, sel.tile);
          const count = this.ed.doc.actions.filter((a) => a.tile === sel.tile).length;
          if (this.ed.removeTile(sel.tile)) {
            this.app.status(`Deleted ${t.name || P.KINDS[t.kind].name}${count ? ` and its ${count} action${count === 1 ? '' : 's'} on the board` : ''} (undo brings it back)`);
          }
        } else if (sel.link) {
          this.ed.processChange((p) => P.unlink(p, sel.link.from, sel.link.port));
          this.app.status('Arrow removed');
        }
        this.select(null);
        this.app.changed();
        return true;
      }
      if (evt.key === 'Enter' && sel.tile) {
        this.app.open(sel.tile);
        return true;
      }
      const step = { ArrowLeft: [-NUDGE, 0], ArrowRight: [NUDGE, 0], ArrowUp: [0, -NUDGE], ArrowDown: [0, NUDGE] }[evt.key];
      if (step && sel.tile) {
        const t = P.tileById(this.process, sel.tile);
        this.ed.processChange((p) => P.moveTile(p, t.id, t.x + step[0] * (evt.shiftKey ? 5 : 1), t.y + step[1] * (evt.shiftKey ? 5 : 1)));
        this.app.changed();
        return true;
      }
      return false;
    }

    // Keys with several tiles selected: Delete removes them all, arrows nudge them all (each one
    // undo step).
    keyMany(evt, ids) {
      if (evt.key === 'Delete' || evt.key === 'Backspace') {
        const gone = new Set(ids);
        const count = this.ed.doc.actions.filter((a) => gone.has(a.tile)).length;
        if (this.ed.removeTiles(ids)) {
          this.app.status(`Deleted ${ids.length} tiles${count ? ` and their ${count} action${count === 1 ? '' : 's'} on the board` : ''} (undo brings them back)`);
        }
        this.select(null);
        this.app.changed();
        return true;
      }
      const step = { ArrowLeft: [-NUDGE, 0], ArrowRight: [NUDGE, 0], ArrowUp: [0, -NUDGE], ArrowDown: [0, NUDGE] }[evt.key];
      if (!step) return false;
      const k = evt.shiftKey ? 5 : 1;
      this.ed.processChange((p) => {
        for (const id of ids) {
          const t = P.tileById(p, id);
          P.moveTile(p, id, t.x + step[0] * k, t.y + step[1] * k);
        }
      });
      this.app.changed();
      return true;
    }
  }

  // Arrows are smooth curves. Each returns { d, tip, dir }: the path stops 8 short of the tip, and
  // the arrowhead, its tip at `tip` pointing along `dir`, covers the rest.

  // An arrow going down: from an output at (sx, sy) facing down (or right: `side`) into the input
  // point at (px, py) on top of a tile, coming in from above; the tip touches the point.
  function downArrow(sx, sy, side, px, py) {
    const tip = [px, py - IN_R];
    const end = tip[1] - 8;
    const k = Math.max(20, (end - sy) / 2);
    const c1 = side ? [sx + Math.max(30, Math.abs(px - sx) * 0.6), sy] : [sx, sy + k];
    return { d: `M${sx},${sy} C${c1[0]},${c1[1]} ${px},${end - k} ${px},${end}`, tip, dir: [0, 1] };
  }

  // An arrow going back up, from an output at (sx, sy) facing down (or right: `side`), round the
  // loop at x = `at` and into the input point at (ex, ey) on a tile's right side (or with `left`,
  // its left side). A long quarter turn up to x = `at`, then a short one (at most 40 high) into
  // the tile's row, so it never reaches past `at` and clears the tiles under that row; from an
  // output facing down it first dips 12 below it (still inside the loop's frame).
  function upArrow(sx, sy, side, ex, ey, at, left) {
    const dir = left ? [1, 0] : [-1, 0];
    const tip = [ex - dir[0] * IN_R, ey];
    const end = tip[0] - dir[0] * 8;
    const r = Math.min(40, Math.max(0, sy - ey) / 2);
    const my = ey + r;
    const out = side ? `C${sx + 0.55 * (at - sx)},${sy} ${at},${my + 0.55 * (sy - my)}` : `C${sx},${sy + 16} ${at},${sy + 16}`;
    return { d: `M${sx},${sy} ${out} ${at},${my} C${at},${ey + 0.45 * r} ${end + 0.55 * (at - end)},${ey} ${end},${ey}`, tip, dir };
  }

  // An arrow going back up from an output on the right to a tile with one there too: round the
  // right at x = `at`, then over the top into its input point at (px, py).
  function overArrow(sx, sy, px, py, at) {
    const tip = [px, py - IN_R];
    const end = tip[1] - 8;
    const my = (sy + end) / 2;
    return { d: `M${sx},${sy} C${sx + 0.55 * (at - sx)},${sy} ${at},${my + 0.55 * (sy - my)} ${at},${my} C${at},${end - 40} ${px},${end - 40} ${px},${end}`, tip, dir: [0, 1] };
  }

  // An arrowhead with its tip at (x, y), pointing along the unit vector (ux, uy).
  function arrowHead(x, y, ux, uy) {
    const bx = x - ux * 10;
    const by = y - uy * 10;
    return `${x},${y} ${bx - uy * 6},${by + ux * 6} ${bx + uy * 6},${by - ux * 6}`;
  }

  function shape(group, t, w, h) {
    const cls = 'pv-shape';
    switch (t.kind) {
      case 'start':
      case 'end':
        el('rect', { x: -w / 2, y: -h / 2, width: w, height: h, rx: h / 2, class: cls }, group);
        break;
      case 'decision':
        el('polygon', { points: `0,${-h / 2} ${w / 2},0 0,${h / 2} ${-w / 2},0`, class: cls }, group);
        break;
      case 'measure':
      case 'ask':
        el('polygon', { points: `${-w / 2 + 12},${-h / 2} ${w / 2},${-h / 2} ${w / 2 - 12},${h / 2} ${-w / 2},${h / 2}`, class: cls }, group);
        break;
      case 'repeat': {
        const c = 16;
        el('polygon', { points: `${-w / 2 + c},${-h / 2} ${w / 2 - c},${-h / 2} ${w / 2},0 ${w / 2 - c},${h / 2} ${-w / 2 + c},${h / 2} ${-w / 2},0`, class: cls }, group);
        break;
      }
      default:
        el('rect', { x: -w / 2, y: -h / 2, width: w, height: h, rx: t.kind === 'parallel' || t.kind === 'join' ? 6 : 10, class: cls }, group);
    }
  }

  // Text cut to fit a tile w wide.
  function clip(value, w) {
    const max = Math.floor((w - 24) / 6.1);
    return value.length > max ? `${value.slice(0, max - 1)}…` : value;
  }

  OD.processView = { ProcessView, icon, summary, RESERVOIRS };
})(globalThis);
