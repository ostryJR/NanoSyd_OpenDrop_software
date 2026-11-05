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
  const NUDGE = 5; // units an arrow key moves the selected tiles (with Shift, five times as far)

  // Size [w, h] of each kind of tile, and its glyph.
  const SIZE = { start: [120, 40], end: [120, 40], decision: [190, 84], repeat: [170, 52], parallel: [230, 20], join: [230, 20] };
  const sizeOf = (t) => (P.sizeOf ? P.sizeOf(t) : SIZE[t.kind] || [210, 60]);
  const IN_R = 4.5; // radius of an input point
  const SNAP_PX = 40; // how near (on screen) a new arrow's end snaps to an input point
  const DROP_PX = 12; // ... and a dragged tile's pointer must be to an arrow to go on it

  // How many input points a tile has: none on Start, one per arrow coming in (at least 2) on a
  // merge or join, one on the others.
  function inputCount(t, process) {
    if (P.inputsOf) {
      const n = P.inputsOf(t, process);
      return Array.isArray(n) ? n.length : n;
    }
    if (!P.takesInput(t)) return 0;
    if (t.kind === 'merge' || t.kind === 'join') return Math.max(2, process.links.filter((l) => l.to === t.id).length);
    return 1;
  }

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

  // A path from `start` through segments ['L', end] or ['C', control1, control2, end]: its SVG
  // `d`, and points along it (to find the arrow under the pointer).
  function trace(start, segs) {
    const f = (pt) => `${Math.round(pt[0] * 10) / 10},${Math.round(pt[1] * 10) / 10}`;
    let d = `M${f(start)}`;
    const pts = [start];
    let cur = start;
    for (const s of segs) {
      if (s[0] === 'L') {
        d += ` L${f(s[1])}`;
        pts.push(s[1]);
      } else {
        d += ` C${f(s[1])} ${f(s[2])} ${f(s[3])}`;
        for (let i = 1; i <= 12; i++) pts.push(bezier(cur, s[1], s[2], s[3], i / 12));
      }
      cur = s[s.length - 1];
    }
    return { d, pts };
  }

  function bezier(a, b, c, e, t) {
    const u = 1 - t;
    return [0, 1].map((k) => u * u * u * a[k] + 3 * u * u * t * b[k] + 3 * u * t * t * c[k] + t * t * t * e[k]);
  }

  // Segments through the corners of a path of straight runs, each corner rounded off (radius up
  // to r; the first and last runs may be used up whole, the others half from each end).
  function rounded(pts, r) {
    const segs = [];
    const K = 0.55; // a quarter circle's control length, as a part of its radius
    for (let i = 1; i < pts.length - 1; i++) {
      const [a, b, c] = [pts[i - 1], pts[i], pts[i + 1]];
      const l1 = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const l2 = Math.hypot(c[0] - b[0], c[1] - b[1]);
      const re = Math.min(r, i === 1 ? l1 : l1 / 2, i === pts.length - 2 ? l2 : l2 / 2);
      const d1 = [(b[0] - a[0]) / (l1 || 1), (b[1] - a[1]) / (l1 || 1)];
      const d2 = [(c[0] - b[0]) / (l2 || 1), (c[1] - b[1]) / (l2 || 1)];
      const s = [b[0] - d1[0] * re, b[1] - d1[1] * re];
      const e = [b[0] + d2[0] * re, b[1] + d2[1] * re];
      segs.push(['L', s], ['C', [s[0] + d1[0] * re * K, s[1] + d1[1] * re * K], [e[0] - d2[0] * re * K, e[1] - d2[1] * re * K], e]);
    }
    segs.push(['L', pts[pts.length - 1]]);
    return segs;
  }

  const linkName = (t) => (t ? t.name || P.KINDS[t.kind].name : '?');
  const GLYPH = {
    start: '▶', end: '■', step: '□', dispense: '⬚', move: '→', mix: '↻', merge: '∨', split: '∧', wait: '⧗',
    measure: '⌖', ask: '?', decision: '◇', repeat: '↺', parallel: '⇉', join: '⇊',
  };
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

  // Where a tile's output ports are, relative to its centre: at the bottom, except a decision's
  // "no" and a repeat's "done", which go out on the right.
  function portAt(t, port) {
    const [w, h] = sizeOf(t);
    if ((t.kind === 'decision' && port === 'no') || (t.kind === 'repeat' && port === 'done')) return [w / 2, 0];
    const ports = P.portsOf(t).filter((p) => !((t.kind === 'decision' && p === 'no') || (t.kind === 'repeat' && p === 'done')));
    const i = ports.indexOf(port);
    const n = ports.length;
    const gap = Math.min(70, (w - 20) / Math.max(1, n));
    return [(i - (n - 1) / 2) * gap, h / 2];
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
      this.wires = []; // the arrows as drawn: [{ link, pts }], to find the one under a dragged tile
      this.space = false; // Space held: dragging pans

      this.palette = document.createElement('div');
      this.palette.className = 'pv-palette';
      this.palette.setAttribute('aria-label', 'Tiles: drag one onto the process, or click to add it under the selected tile');
      for (const group of P.PALETTE_GROUPS || [{ name: null, kinds: P.PALETTE }]) {
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
          const g = document.createElement('span');
          g.className = 'pv-glyph';
          g.textContent = GLYPH[kind] || '□';
          b.append(g, P.KINDS[kind].name);
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

    // Each tile's input points and which arrow ends at which: Map(id -> { n, pts, of: Map(arrow
    // key -> point) }). Arrows take a tile's points left to right by where they come from; `extra`
    // is an arrow being drawn, counted in for its target.
    inputLayouts(p, g, extra = null) {
      const out = new Map();
      for (const t of p.tiles) {
        let ins = g.into.get(t.id);
        let proc = p;
        if (extra && extra.to === t.id) {
          ins = [...ins.filter((l) => !(l.from === extra.from && l.port === extra.port)), extra];
          proc = { ...p, links: [...p.links.filter((l) => !(l.from === extra.from && l.port === extra.port)), extra] };
        }
        out.set(t.id, this.inputLayout(t, ins, proc, g.byId));
      }
      return out;
    }

    inputLayout(t, ins, proc, byId) {
      const n = inputCount(t, proc);
      const pts = Array.from({ length: n }, (_, i) => inAt(t, i, n));
      const of = new Map();
      const [tx] = this.posOf(t);
      const from = ins
        .map((l) => {
          const s = byId.get(l.from);
          return { key: P.linkKey(l), x: this.posOf(s)[0] + portAt(s, l.port)[0], y: this.posOf(s)[1] };
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
      const issues = P.check(p);
      const byId = g.byId;

      // Loops: a dashed frame round their tiles, the condition on top.
      const frames = el('g', { class: 'pv-loops' }, this.svg);
      const loopRight = new Map(); // back link key -> x to go up at
      for (const lp of P.loops(p, g, back)) {
        const box = this.bounds(lp.tiles.map((id) => byId.get(id)));
        // Room inside above and below the tiles for the arrow going back round.
        const x = box.x - 18;
        const y = box.y - 42;
        const width = box.w + 36 + 40;
        const height = box.h + 42 + 32;
        el('rect', { x, y, width, height, rx: 14, class: `pv-loop${lp.endless ? ' bad' : ''}` }, frames);
        // The label goes left of where the arrows come into the loop if it fits there, else right
        // of it, so the arrows don't cross it.
        const head = byId.get(lp.to);
        const label = `↻ ${lp.label}`;
        const hx = this.posOf(head)[0];
        const fits = hx - 12 - (x + 14) >= label.length * 7.2;
        text(frames, fits ? x + 14 : Math.max(x + 14, hx + 12), y + 30, label, 'pv-loop-label');
        loopRight.set(`${lp.from}|${lp.port}`, x + width - 20);
      }

      // Input points: one per tile, or one per arrow coming in on a merge or join (with the arrow
      // being drawn counted in when it needs a point more).
      const d = this.drag;
      const wire = d && d.kind === 'wire' ? d : null;
      const ins = this.inputLayouts(p, g, wire && wire.snap && wire.snap.extra ? { from: wire.from, port: wire.port, to: wire.snap.tile } : null);

      // Arrows: from the middle of their output dot to the top of their input dot.
      const links = el('g', { class: 'pv-links' }, this.svg);
      this.wires = [];
      for (const t of p.tiles) {
        for (const l of g.out.get(t.id)) {
          const to = byId.get(l.to);
          const [fx, fy] = this.posOf(t);
          const [ox, oy] = portAt(t, l.port);
          const [tx, ty] = this.posOf(to);
          const [tw, th] = sizeOf(to);
          const lay = ins.get(to.id);
          const [ix, iy] = lay.pts[lay.of.get(P.linkKey(l))] || [0, -th / 2];
          const ex = tx + ix; // where it ends
          const ey = ty + iy - IN_R;
          const sx = fx + ox;
          const sy = fy + oy;
          const side = ox !== 0 && oy === 0; // leaves on the right
          const up = back.has(P.linkKey(l)) || ty - th / 2 < sy + 12;
          const end = [ex, ey - 8]; // where the line meets the arrowhead
          let way;
          if (up) {
            // Round the right side (inside the loop's frame), over the tile and down into its point.
            const right = Math.max(loopRight.get(`${l.from}|${l.port}`) || -Infinity, sx + 30, tx + tw / 2 + 30);
            const above = ty + iy - 30;
            const pts = side ? [[sx, sy], [right, sy]] : [[sx, sy], [sx, sy + 20], [right, sy + 20]];
            pts.push([right, above], [ex, above], end);
            way = trace([sx, sy], rounded(pts, 26));
          } else {
            // An S-curve: out of the port (down, or right from a side port), into the point from above.
            const k = Math.max(24, (end[1] - sy) / 2);
            const c1 = side ? [sx + Math.max(30, (ex - sx) / 2), sy] : [sx, sy + k];
            way = Math.abs(ex - sx) < 1 && !side ? trace([sx, sy], [['L', end]]) : trace([sx, sy], [['C', c1, [ex, end[1] - k], end]]);
          }
          const path = way.d;
          this.wires.push({ link: { from: l.from, port: l.port, to: l.to }, pts: [...way.pts, [ex, ey]] });
          const sel = this.selected && this.selected.link && this.selected.link.from === l.from && this.selected.link.port === l.port;
          const drop = d && d.onLink && d.onLink.from === l.from && d.onLink.port === l.port;
          const group = el('g', { class: `pv-link${sel ? ' selected' : ''}${up ? ' back' : ''}${drop ? ' drop' : ''}`, 'data-from': l.from, 'data-port': l.port }, links);
          el('path', { d: path, class: 'pv-wire' }, group);
          el('path', { d: path, class: 'pv-hit' }, group);
          el('polygon', { points: arrowHead(ex, ey, 'down'), class: 'pv-tip' }, group);
          if (P.portsOf(t).length > 1) text(group, sx + 6, sy + (side ? -6 : 14), P.portName(l.port), 'pv-port-label');
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
        if (wire && wire.snap && wire.snap.tile === t.id) cls.push('target');
        if (this.ed.scope && this.ed.scope.tile === t.id) cls.push('open');
        if (running.has(t.id) || (run && run.tile === t.id)) cls.push('running');
        if (P.hasWork(t) && info && info.tile.get(t.id) && !info.tile.get(t.id).placed) cls.push('unplaced');
        const group = el('g', { class: cls.join(' '), 'data-tile': t.id, transform: `translate(${x},${y})` }, tiles);
        if (cls.includes('target')) el('rect', { x: -w / 2 - 7, y: -hh / 2 - 7, width: w + 14, height: hh + 14, rx: 14, class: 'pv-target' }, group);
        shape(group, t, w, hh);
        const name = t.kind === 'decision' ? '' : t.name || P.KINDS[t.kind].name;
        if (t.kind === 'parallel' || t.kind === 'join') {
          text(group, w / 2 + 10, 5, `${GLYPH[t.kind]} ${P.KINDS[t.kind].name}`, 'pv-bar-label');
          text(group, w / 2 + 10, 20, summary(t, info, p), 'pv-sub');
        } else if (t.kind === 'start' || t.kind === 'end') {
          text(group, 0, 5, `${GLYPH[t.kind]} ${name}`, 'pv-name centre');
        } else if (t.kind === 'decision') {
          text(group, 0, -4, '◇ if', 'pv-sub centre');
          text(group, 0, 14, summary(t, info, p), 'pv-name centre');
        } else {
          text(group, -w / 2 + 14, -6, `${GLYPH[t.kind]} ${name}`, 'pv-name');
          text(group, -w / 2 + 14, 14, clip(summary(t, info, p), w), 'pv-sub');
        }
        if (errors.length || warns.length) {
          const badge = el('g', { class: `pv-badge${errors.length ? ' error' : ''}`, transform: `translate(${w / 2 - 4},${-hh / 2 + 2})` }, group);
          el('circle', { r: 9 }, badge);
          text(badge, 0, 4, '!', 'centre');
          el('title', {}, badge).textContent = [...errors, ...warns].join('\n');
        }
        el('title', {}, group).textContent = `${P.KINDS[t.kind].name}${t.name && t.kind !== 'decision' ? `: ${t.name}` : ''}${P.hasWork(t) ? ' (double-click to open on the board)' : ''}`;
        for (const port of P.portsOf(t)) {
          const [px, py] = portAt(t, port);
          el('circle', { cx: px, cy: py, r: 7, class: 'pv-port', 'data-port': port }, group);
        }
        const lay = ins.get(t.id);
        lay.pts.forEach(([ix, iy], i) => {
          const snapped = wire && wire.snap && wire.snap.tile === t.id && wire.snap.index === i;
          el('circle', { cx: ix, cy: iy, r: snapped ? 7 : IN_R, class: `pv-in${snapped ? ' snap' : ''}` }, group);
        });
      }

      // A connection, a new tile or a selection box being dragged.
      if (wire) {
        const [ex, ey] = wire.snap ? [wire.snap.x, wire.snap.y] : [wire.x, wire.y];
        const k = Math.max(20, Math.abs(ey - wire.sy) / 2);
        el('path', { d: trace([wire.sx, wire.sy], [['C', [wire.sx, wire.sy + k], [ex, ey - k], [ex, ey]]]).d, class: 'pv-rubber' }, this.svg);
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
        const [ox, oy] = portAt(t, hit.port);
        this.drag = { kind: 'wire', from: hit.tile, port: hit.port, sx: t.x + ox, sy: t.y + oy, x, y, snap: null };
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

    // The input point a new arrow being dragged snaps to, with the pointer at x, y: the nearest
    // one within SNAP_PX on screen, else the nearest free one of the tile under the pointer.
    // { tile, index, x, y, extra } (extra: a merge or join shows one point more for it) or null.
    snapTarget(d, x, y) {
      const p = this.process;
      const g = P.graph(p);
      const mine = (l) => l.from === d.from && l.port === d.port; // the arrow this one replaces
      const spots = (t) => {
        if (t.id === d.from) return [];
        const ins = g.into.get(t.id).filter((l) => !mine(l));
        const links = p.links.filter((l) => !mine(l));
        const now = this.inputLayout(t, ins, { ...p, links }, g.byId);
        if (!now.n) return [];
        const extra = { from: d.from, port: d.port, to: t.id };
        const withIt = this.inputLayout(t, [...ins, extra], { ...p, links: [...links, extra] }, g.byId);
        const [tx, ty] = this.posOf(t);
        const at = (lay, i, more) => ({ tile: t.id, index: i, x: tx + lay.pts[i][0], y: ty + lay.pts[i][1], extra: more });
        // Every point taken on a merge or join: it gets one more, where the new arrow will go.
        if (withIt.n > now.n) return [at(withIt, withIt.of.get(P.linkKey(extra)), true)];
        const taken = new Set(now.of.values());
        const free = now.pts.map((_, i) => i).filter((i) => !taken.has(i));
        // A tile with one input point takes any number of arrows there.
        return (free.length ? free : now.pts.map((_, i) => i)).map((i) => at(now, i, false));
      };
      const dist = (s) => Math.hypot(s.x - x, s.y - y);
      const nearest = (list) => list.reduce((best, s) => (!best || dist(s) < dist(best) ? s : best), null);
      const close = nearest(p.tiles.flatMap(spots).filter((s) => dist(s) <= SNAP_PX / this.view.zoom));
      if (close) return close;
      const under = this.tileAt(x, y);
      return under ? nearest(spots(under)) : null;
    }

    // While a loose tile (or a new one) is dragged: the arrow near the pointer, if any, in
    // d.onLink, and the nearest point on it in d.hint.
    overLink(d, x, y) {
      d.onLink = null;
      d.hint = null;
      if (!(d.kind === 'new' ? d.over && P.takesInput({ kind: d.tileKind }) : d.loose && d.moved)) return;
      let best = null;
      for (const w of this.wires) {
        const near = nearOnLine(w.pts, x, y);
        if (near.dist <= DROP_PX / this.view.zoom && (!best || near.dist < best.near.dist)) best = { link: w.link, near };
      }
      if (best) {
        d.onLink = best.link;
        d.hint = [Math.round(best.near.x), Math.round(best.near.y)];
      }
    }

    // Puts a tile (make(p) gives it: a loose one, or a new one) at x, y on the arrow `link`:
    // from --port--> tile --its first output--> where the arrow went. One undoable change.
    putOnLink(link, make, x, y) {
      let tile = null;
      let why = null;
      this.ed.processChange((p) => {
        tile = make(p);
        P.moveTile(p, tile.id, x, y);
        why = P.link(p, link.from, link.port, tile.id);
        if (!why && P.portsOf(tile).length) why = P.link(p, tile.id, P.portsOf(tile)[0], link.to);
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
      const kinds = P.PALETTE_GROUPS ? P.PALETTE_GROUPS.flatMap((group) => group.kinds) : P.PALETTE;
      for (const kind of kinds.filter((k) => k !== 'start' && P.KINDS[k])) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = `${GLYPH[kind] || '□'} ${P.KINDS[kind].name}`;
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

  function arrowHead(x, y, dir) {
    if (dir === 'left') return `${x},${y} ${x + 10},${y - 6} ${x + 10},${y + 6}`;
    return `${x},${y} ${x - 6},${y - 10} ${x + 6},${y - 10}`;
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

  OD.processView = { ProcessView, GLYPH, summary, RESERVOIRS };
})(globalThis);
