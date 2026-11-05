/* The process view: the process as a top-down tree of tiles on an SVG canvas, in place of the
 * board. Drag a tile from the palette (or click one to add it under the selected tile), drag tiles
 * to move them, drag from a tile's output port to another tile to connect them (or into empty
 * space to add a tile there), click to select, Delete to remove, double-click or Enter to open a
 * step on the board. Arrows going back up are loops: their tiles get a dashed frame labelled with
 * the loop's condition. Plain DOM; every change goes through the editor, so it can be undone. */
(function (root) {
  'use strict';

  const OD = root.OD;
  const P = OD.process;
  const NS = 'http://www.w3.org/2000/svg';
  const NUDGE = 10; // units an arrow key moves the selected tile (with Shift, five times that)

  // Size [w, h] of each kind of tile, and its glyph.
  const SIZE = { start: [120, 40], end: [120, 40], decision: [190, 84], repeat: [170, 52], parallel: [230, 20], join: [230, 20] };
  const sizeOf = (t) => SIZE[t.kind] || [210, 60];
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

  // Where a tile's ports are, relative to its centre: the input on top; outputs at the bottom,
  // except a decision's "no" and a repeat's "done", which go out on the right.
  function portAt(t, port) {
    const [w, h] = sizeOf(t);
    if (port === 'in') return [0, -h / 2];
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
      this.selected = null; // { tile: id } or { link: { from, port } }
      this.view = { x: -300, y: -60, zoom: 1 };
      this.fitted = false;
      this.drag = null;
      this.renderKey = '';

      this.palette = document.createElement('div');
      this.palette.className = 'pv-palette';
      this.palette.setAttribute('aria-label', 'Tiles: drag one onto the process, or click to add it under the selected tile');
      for (const kind of P.PALETTE) {
        const b = document.createElement('button');
        b.type = 'button';
        b.dataset.kind = kind;
        b.className = `pv-kind ${kind}`;
        b.title = `${P.KINDS[kind].name}: drag it onto the process, or click to add it under the selected tile`;
        const g = document.createElement('span');
        g.className = 'pv-glyph';
        g.textContent = GLYPH[kind];
        b.append(g, P.KINDS[kind].name);
        b.addEventListener('pointerdown', (evt) => this.paletteDown(evt, kind));
        this.palette.appendChild(b);
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
      const zoom = Math.min(1.4, Math.max(0.3, Math.min((w - 220) / (box.w + 120), (h - 40) / (box.h + 120))));
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

    // A tile's position, following a drag in progress.
    posOf(t) {
      const d = this.drag;
      return d && d.kind === 'move' && d.id === t.id ? [d.x, d.y] : [t.x, t.y];
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
      const loopLeft = new Map(); // ... on the left, for a tile with an output on its right
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
        loopRight.set(`${lp.from}|${lp.port}`, x + width - 20);
        loopLeft.set(`${lp.from}|${lp.port}`, x + 9);
      }

      // Arrows.
      const links = el('g', { class: 'pv-links' }, this.svg);
      for (const t of p.tiles) {
        for (const l of g.out.get(t.id)) {
          const to = byId.get(l.to);
          const [fx, fy] = this.posOf(t);
          const [ox, oy] = portAt(t, l.port);
          const [tx, ty] = this.posOf(to);
          const [, th] = sizeOf(to);
          const sx = fx + ox;
          const sy = fy + oy;
          const side = ox !== 0 && oy === 0; // leaves on the right
          const up = back.has(P.linkKey(l)) || ty - th / 2 < sy + 12;
          const [tw] = sizeOf(to);
          const right = Math.max(loopRight.get(`${l.from}|${l.port}`) || -Infinity, sx + 30, tx + tw / 2 + 30);
          // A tile with an output on its right side (a decision's "no", a repeat's "done") takes an
          // arrow coming back up on its left instead.
          const rightPort = P.portsOf(to).some((pt) => {
            const [px, py] = portAt(to, pt);
            return px !== 0 && py === 0;
          });
          const left = loopLeft.has(`${l.from}|${l.port}`) ? loopLeft.get(`${l.from}|${l.port}`) : null;
          const { d, tip, dir } = curve(sx, sy, side, [tx, ty, tw, th], up, right, rightPort, left);
          const sel = this.selected && this.selected.link && this.selected.link.from === l.from && this.selected.link.port === l.port;
          const group = el('g', { class: `pv-link${sel ? ' selected' : ''}${up ? ' back' : ''}`, 'data-from': l.from, 'data-port': l.port }, links);
          el('path', { d, class: 'pv-wire' }, group);
          el('path', { d, class: 'pv-hit' }, group);
          el('polygon', { points: arrowHead(tip[0], tip[1], dir[0], dir[1]), class: 'pv-tip' }, group);
          if (P.portsOf(t).length > 1) text(group, sx + (side ? 6 : 6), sy + (side ? -6 : 14), P.portName(l.port), 'pv-port-label');
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
        if (this.selected && this.selected.tile === t.id) cls.push('selected');
        if (this.ed.scope && this.ed.scope.tile === t.id) cls.push('open');
        if (running.has(t.id) || (run && run.tile === t.id)) cls.push('running');
        if (P.hasWork(t) && info && info.tile.get(t.id) && !info.tile.get(t.id).placed) cls.push('unplaced');
        const group = el('g', { class: cls.join(' '), 'data-tile': t.id, transform: `translate(${x},${y})` }, tiles);
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
        if (P.takesInput(t)) {
          const [ix, iy] = portAt(t, 'in');
          el('circle', { cx: ix, cy: iy, r: 4, class: 'pv-in' }, group);
        }
      }

      // A connection or a new tile being dragged.
      const d = this.drag;
      if (d && d.kind === 'wire') {
        const k = Math.max(20, Math.abs(d.y - d.sy) / 2);
        const c1 = d.side ? `${d.sx + Math.max(30, Math.abs(d.x - d.sx) * 0.6)},${d.sy}` : `${d.sx},${d.sy + k}`;
        el('path', { d: `M${d.sx},${d.sy} C${c1} ${d.x},${d.y - k} ${d.x},${d.y}`, class: 'pv-rubber' }, this.svg);
      }
      if (d && d.kind === 'new' && d.over) {
        const [w, hh] = sizeOf({ kind: d.tileKind });
        el('rect', { x: d.x - w / 2, y: d.y - hh / 2, width: w, height: hh, rx: 10, class: 'pv-ghost' }, this.svg);
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
      if (evt.button !== 0) return;
      evt.preventDefault(); // no text selection while dragging on the canvas
      this.menu.hidden = true;
      this.svg.focus({ preventScroll: true });
      const [x, y] = this.toWorld(evt.clientX, evt.clientY);
      const hit = this.hit(evt.target);
      if (this.ed.frozen) {
        if (hit && hit.tile) this.select({ tile: hit.tile });
        return;
      }
      this.svg.setPointerCapture(evt.pointerId);
      if (hit && hit.port) {
        const t = P.tileById(this.process, hit.tile);
        const [ox, oy] = portAt(t, hit.port);
        this.drag = { kind: 'wire', from: hit.tile, port: hit.port, sx: t.x + ox, sy: t.y + oy, side: ox !== 0 && oy === 0, x, y };
      } else if (hit && hit.tile) {
        const t = P.tileById(this.process, hit.tile);
        this.select({ tile: hit.tile });
        this.drag = { kind: 'move', id: t.id, dx: x - t.x, dy: y - t.y, x: t.x, y: t.y, moved: false };
      } else if (hit && hit.link) {
        this.select({ link: hit.link });
      } else {
        this.select(null);
        this.drag = { kind: 'pan', cx: evt.clientX, cy: evt.clientY, vx: this.view.x, vy: this.view.y };
      }
      this.render();
    }

    move(evt) {
      const d = this.drag;
      if (!d) return;
      const [x, y] = this.toWorld(evt.clientX, evt.clientY);
      if (d.kind === 'pan') {
        this.view.x = d.vx - (evt.clientX - d.cx) / this.view.zoom;
        this.view.y = d.vy - (evt.clientY - d.cy) / this.view.zoom;
      } else if (d.kind === 'move') {
        const nx = Math.round(x - d.dx);
        const ny = Math.round(y - d.dy);
        if (nx !== d.x || ny !== d.y) d.moved = true;
        d.x = nx;
        d.y = ny;
      } else if (d.kind === 'wire') {
        d.x = x;
        d.y = y;
      }
      this.render();
    }

    up(evt) {
      const d = this.drag;
      this.drag = null;
      if (!d) return;
      const [x, y] = this.toWorld(evt.clientX, evt.clientY);
      if (d.kind === 'move' && d.moved) {
        this.ed.processChange((p) => P.moveTile(p, d.id, d.x, d.y));
        this.app.changed();
      } else if (d.kind === 'wire') {
        const target = this.tileAt(x, y);
        if (target && target.id !== d.from) this.connect(d.from, d.port, target.id);
        else if (!target) this.offerTiles(evt.clientX, evt.clientY, (kind) => this.addTile(kind, Math.round(x), Math.round(y) + 30, { from: d.from, port: d.port }));
      }
      this.render(true);
    }

    cancelDrag() {
      this.drag = null;
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
      for (const kind of P.PALETTE.filter((k) => k !== 'start')) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = `${GLYPH[kind]} ${P.KINDS[kind].name}`;
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
      const drag = { kind: 'new', tileKind: kind, over: false, x: 0, y: 0, moved: false };
      this.drag = drag;
      const sx = evt.clientX;
      const sy = evt.clientY;
      const moveTo = (e) => {
        const r = this.svg.getBoundingClientRect();
        drag.over = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom && e.clientX > this.palette.getBoundingClientRect().right;
        [drag.x, drag.y] = this.toWorld(e.clientX, e.clientY).map(Math.round);
        if (Math.hypot(e.clientX - sx, e.clientY - sy) > 6) drag.moved = true;
        this.render();
      };
      const finish = (e) => {
        button.removeEventListener('pointermove', moveTo);
        button.removeEventListener('pointerup', finish);
        button.removeEventListener('pointercancel', cancel);
        this.drag = null;
        if (drag.moved && drag.over) this.addTile(kind, drag.x, drag.y);
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

    select(sel) {
      this.selected = sel;
      this.app.select(sel && sel.tile ? sel.tile : null);
      this.render();
    }

    // A key while the process view is on; true if it was used.
    key(evt) {
      const sel = this.selected;
      if (evt.key === 'Escape') {
        this.menu.hidden = true;
        if (this.drag) this.cancelDrag();
        else this.select(null);
        return true;
      }
      if (!sel || this.ed.frozen) return false;
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
  }

  // An arrow's smooth curve from an output port at (sx, sy) to a tile [x, y, w, h] (its centre and
  // size): it leaves the way its port faces (down; right for a decision's "no" and a repeat's
  // "done") and comes into the tile from above. An arrow going back up bulges out to the right
  // (half way along it reaches `right`, past the loop's tiles) and comes into the tile's right
  // side; when an output sits on that side (`rightPort`), it goes up on the loop's left instead
  // (at `left`) and comes into the tile's left side. The line stops just short of the tile; the
  // arrowhead at `tip`, pointing along `dir`, covers the rest.
  function curve(sx, sy, side, [tx, ty, tw, th], up, right, rightPort = false, left = null) {
    if (up && rightPort && !side) {
      const tip = [tx - tw / 2, ty];
      const lx = Math.min(left === null ? Infinity : left, tip[0] - 24, sx - 40);
      const by = sy + 16; // dips 12 below the port: inside the loop frame (16 below its tiles)
      // Down from the port and round to the left, then up and round into the tile's left side.
      const d = `M${sx},${sy} C${sx},${by} ${lx},${by} ${lx},${sy} C${lx},${(sy + ty) / 2} ${lx},${ty} ${tip[0] - 8},${ty}`;
      return { d, tip, dir: [1, 0] };
    }
    let tip;
    let c1;
    let c2;
    if (!up) {
      tip = [tx, ty - th / 2];
      const k = Math.max(20, (tip[1] - 8 - sy) / 2);
      c1 = side ? [sx + Math.max(30, Math.abs(tx - sx) * 0.6), sy] : [sx, sy + k];
      c2 = [tx, tip[1] - 8 - k];
    } else if (!rightPort) {
      tip = [tx + tw / 2, ty];
      const ex = tip[0] + 8;
      const k = Math.max(40, (8 * right - 4 * sx - 4 * ex) / (side ? 6 : 3));
      c1 = side ? [sx + k, sy] : [sx, sy + 36];
      c2 = [ex + k, ty];
    } else {
      // From an output on the right into a tile with one there too: in through its top.
      tip = [tx + tw / 4, ty - th / 2];
      c1 = [right + 30, sy];
      c2 = [tip[0], tip[1] - 70];
    }
    const len = Math.hypot(tip[0] - c2[0], tip[1] - c2[1]) || 1;
    const dir = [(tip[0] - c2[0]) / len, (tip[1] - c2[1]) / len];
    const end = [tip[0] - dir[0] * 8, tip[1] - dir[1] * 8];
    return { d: `M${sx},${sy} C${c1[0]},${c1[1]} ${c2[0]},${c2[1]} ${end[0]},${end[1]}`, tip, dir };
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

  OD.processView = { ProcessView, GLYPH, summary, RESERVOIRS };
})(globalThis);
