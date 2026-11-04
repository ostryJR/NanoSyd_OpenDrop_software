/* SVG drawing of the original controller screen (drawPlane and Electrode.drawElectrode), plus the
 * drag tool switch, undo/redo, the droplet paths' lines, the selected action, and the path,
 * template or edit being dragged. */
(function (root) {
  'use strict';

  const OD = root.OD;
  const G = OD.layout.GEOMETRY;
  const { CONTROLS } = OD.editor;
  const { electrodeGraph } = OD.paths;
  const NS = 'http://www.w3.org/2000/svg';
  const px = (u) => G.CX + G.UNIT * u; // the original's coX()
  const py = (v) => G.CY + G.UNIT * v; // the original's coY()
  const BOX = 2 * G.UNIT; // button size (eSize)

  const COLOR = {
    on: 'rgb(0,200,0)',
    off: 'rgb(250,200,0)',
    previous: 'rgb(210,200,0)', // off now, on in the previous frame
    button: 'rgb(255,0,0)',
    active: 'rgb(255,255,255)',
    idle: 'rgb(150,150,150)',
  };

  // Hover text for the controls on the left.
  const TIPS = {
    toolFreehand: 'Drag draws a droplet path through each electrode you pass, one frame per step (F)',
    toolStraight: 'Drag draws a droplet path along rows and columns to the blue electrode (S)',
    toolPaint: 'Drag switches electrodes on or off in this frame, kept as a pattern (P)',
    toolSelect: 'Click picks what is drawn; drag moves it, or reshapes a path: its pieces, corners and ends (V)',
    undo: 'Undo (⌘Z or Ctrl+Z)',
    redo: 'Redo (⇧⌘Z or Ctrl+Y)',
  };

  // Each droplet name gets a colour (the same in the actions list), dark enough to stand out on
  // the yellow and green electrodes; unnamed ones are gray.
  const DROPLET_COLOURS = ['#1f4fd1', '#8e24aa', '#c2185b', '#00796b', '#6d4c41', '#283593', '#e65100', '#455a64'];
  function dropletColour(name) {
    if (!name) return 'rgb(105,105,105)';
    let h = 7;
    for (const ch of name) h = (Math.imul(h, 31) + ch.codePointAt(0)) >>> 0;
    return DROPLET_COLOURS[h % DROPLET_COLOURS.length];
  }

  function el(tag, attrs, parent) {
    const node = document.createElementNS(NS, tag);
    for (const k of Object.keys(attrs)) node.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(node);
    return node;
  }

  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  // Frames per minute, as a whole number when it is one.
  const perMinute = (speed) => (Math.abs(speed - Math.round(speed)) < 0.05 ? String(Math.round(speed)) : speed.toFixed(1));

  // Every electrode an action uses, in any frame.
  const footprint = (compiled, id) => {
    const x = compiled.expanded.get(id);
    const cells = new Set();
    if (x && x.steps) for (const s of x.steps) for (const e of s.cells) cells.add(e);
    return cells;
  };

  class BoardView {
    constructor(svg, imageHref) {
      svg.setAttribute('viewBox', `0 0 ${G.IMG_W} ${G.IMG_H}`);
      el('image', { href: imageHref, x: 0, y: 0, width: G.IMG_W, height: G.IMG_H }, svg);

      const labels = el('g', { class: 'labels' }, svg);
      const label = (text, u, v, parent = labels) => {
        const t = el('text', { x: px(u), y: py(v) }, parent);
        t.textContent = text;
        return t;
      };
      label('OpenDrop Generator', -43, -18);
      // In the notch in the frame's top edge (y 80-135 px of the image), centred, level with the
      // title on the left.
      this.cutoutTitle = label('Path Generator', 0, -18.8);
      this.cutoutTitle.setAttribute('class', 'cutout-title');
      label('export', 25, -18.5);
      label('save', 32, -18.5);
      label('load', 38, -18.5);
      label('play', 37, -7.5);
      label('copy last frame', 37, 5.5);
      label('clear frame', 37, 8.5);
      label('clear all', 37, 11.5);
      label('frame_no:', -20, 16);
      label('frames/min:', 10, 16);
      label('drag:', -34, -10.5).setAttribute('class', 'end'); // right-aligned over the boxes
      this.frameLabel = label('', -12, 16);
      this.speedLabel = label('', 18, 16);

      this.electrodeLayer = el('g', { class: 'electrodes' }, svg);
      // Droplet paths as lines through their electrodes' centres, and the selected path's points.
      this.lineLayer = el('g', { class: 'lines' }, svg);
      this.handleLayer = el('g', { class: 'handles' }, svg);

      // The path being drawn: a line through the electrodes' centres, a dot at its start and
      // the step count next to its end. The badge also labels templates and edits.
      this.pathLayer = el('g', { class: 'path-layer' }, svg);
      this.pathLine = el('polyline', { class: 'path-line', points: '' }, this.pathLayer);
      this.pathStart = el('circle', { class: 'path-start', r: 10 }, this.pathLayer);
      this.badge = el('g', { class: 'path-badge' }, this.pathLayer);
      this.badgeBox = el('rect', { rx: 20, height: 40 }, this.badge);
      this.badgeText = el('text', {}, this.badge);
      this.pathLayer.style.display = 'none';

      this.numberLayer = el('g', { class: 'numbers' }, svg);

      const controls = el('g', { class: 'controls' }, svg);
      const box = (u, v, parent = controls) =>
        el('rect', { x: px(u), y: py(v), width: BOX, height: BOX, fill: COLOR.button }, parent);
      this.playBox = box(34, -9);
      box(34, 4); // copy last frame
      box(34, 7); // clear frame
      box(34, 10); // clear all
      this.reservoirButtons = el('g', {}, controls);
      for (const [u, v] of [[28, -6], [28, 4], [-30, -6], [-30, 4]]) box(u, v, this.reservoirButtons);

      // On the left: the drag tool switch (the chosen tool's box is white) and undo/redo, each
      // label right-aligned against its box.
      this.toolBoxes = [];
      this.historyButtons = {};
      for (const c of CONTROLS.filter((control) => control.label)) {
        const group = el('g', {}, controls);
        const node = box(c.box, c.y, group);
        label(c.label, c.box - 1, c.y + 1.5, group).setAttribute('class', 'end');
        const hit = el('rect', { class: 'hit', x: px(c.x), y: py(c.y), width: G.UNIT * c.w, height: G.UNIT * c.h }, group);
        el('title', {}, hit).textContent = TIPS[c.action] || '';
        if (c.tool) this.toolBoxes.push({ tool: c.tool, node });
        else this.historyButtons[c.action] = group;
      }

      // Frame dots 1..17 and the previous/next arrows.
      this.dots = [];
      for (let i = 1; i < 18; i++) this.dots.push(el('circle', { cx: px(-18 + i * 2), cy: py(19.5), r: 15 }, controls));
      const y = py(19.5);
      const arrow = (tipU, dir) => {
        const tip = px(tipU);
        const base = tip + dir * BOX;
        return el('polygon', { points: `${tip},${y} ${base},${y - BOX / 2} ${base},${y + BOX / 2}`, fill: COLOR.idle }, controls);
      };
      arrow(-20, 1);
      this.nextArrow = arrow(20, -1);

      this.rects = [];
      this.centres = new Map();
      this.overlayKey = '';
      this.linesKey = '';
    }

    setCutoutTitle(text) {
      this.cutoutTitle.textContent = text;
    }

    setLayout(lay) {
      this.electrodeLayer.replaceChildren();
      this.numberLayer.replaceChildren();
      this.rects = lay.rects.map((r) => {
        const node = el('rect', { x: px(r.x), y: py(r.y), width: G.UNIT * r.h, height: G.UNIT * r.v }, this.electrodeLayer);
        const number = el('text', { x: px(r.x + r.h / 2), y: py(r.y + r.v / 2) }, this.numberLayer);
        number.textContent = r.e;
        return { node, e: r.e, fill: null, cls: '' };
      });
      this.centres = electrodeGraph(lay.rects).centres;
      this.overlayKey = '';
      this.linesKey = '';
      this.pathLayer.style.display = 'none';
      this.reservoirButtons.style.display = lay.hasReservoirs ? '' : 'none';
    }

    at(e) {
      const c = this.centres.get(e);
      return c ? [px(c.x), py(c.y)] : null;
    }

    render(ed, { numbers = false, lines = true } = {}) {
      const shown = ed.shown;
      const { seq } = shown;
      const { frame } = ed;
      for (const r of this.rects) {
        const fill = seq.get(r.e, frame) ? COLOR.on : seq.get(r.e, frame - 1) ? COLOR.previous : COLOR.off;
        if (fill !== r.fill) {
          r.node.setAttribute('fill', fill);
          r.fill = fill;
        }
      }
      this.frameLabel.textContent = frame;
      this.speedLabel.textContent = perMinute(ed.speed);
      this.playBox.setAttribute('fill', ed.playing ? COLOR.active : COLOR.button);
      this.dots.forEach((dot, i) => dot.setAttribute('fill', i + 1 === frame ? COLOR.button : COLOR.idle));
      this.nextArrow.setAttribute('fill', frame >= 18 ? COLOR.button : COLOR.idle);
      this.numberLayer.style.display = numbers ? '' : 'none';
      for (const { tool, node } of this.toolBoxes) node.setAttribute('fill', ed.tool === tool ? COLOR.active : COLOR.button);
      this.historyButtons.undo.classList.toggle('unavailable', !ed.canUndo);
      this.historyButtons.redo.classList.toggle('unavailable', !ed.canRedo);
      this.renderOverlay(ed, shown);
      this.renderLines(ed, shown, lines);
    }

    // Electrode highlights: the path or template being placed (light blue, or light red where a
    // template doesn't fit, its end or anchor darker), an edit being dragged (light blue where it
    // goes, red on what can't move there), or the selected action (outlined in the frame on
    // screen, faint in its other frames). A badge says how many steps, or why it doesn't fit.
    renderOverlay(ed, shown) {
      const draft = ed.draft && ed.draft.moved ? ed.draft : null;
      const spot = !draft && ed.placement ? ed.placement.spot : null;
      const edit = !draft && !spot && ed.edit ? ed.edit.preview : null;
      const pending = !draft && !spot && !edit ? ed.pending : null;
      const sel = !draft && !spot && !edit && !pending ? ed.selected : null;

      const cls = new Map();
      let badge = null; // { text, bad, cells, end, beside }
      if (draft) {
        // A path that would touch another droplet shows red, with the reason.
        const bad = Boolean(draft.check && !draft.check.valid);
        for (const e of draft.cells) cls.set(e, bad ? 'bad' : 'path');
        if (draft.steps > 0) {
          cls.set(draft.end, bad ? 'bad-end' : 'path-end');
          const a = this.centres.get(draft.end);
          const b = this.centres.get(draft.cells[draft.cells.length - 2]);
          // After a step up or down the badge goes beside the end, after a step sideways above
          // it, so it never hides the path's last step.
          badge = {
            text: bad ? draft.check.reason : plural(draft.steps, 'step') + (draft.limited ? ' · frame 200 limit' : ''),
            bad,
            end: draft.end,
            beside: Math.abs(a.y - b.y) > Math.abs(a.x - b.x),
          };
        }
      } else if (spot) {
        const bad = !spot.valid;
        for (const e of spot.frames.flat()) cls.set(e, bad ? 'bad' : 'path');
        cls.set(spot.anchor, bad ? 'bad-end' : 'path-end');
        badge = {
          text: spot.valid ? plural(spot.steps, 'step') : spot.reason || (spot.fits ? 'runs past frame 200' : "doesn't fit here"),
          bad,
          cells: [...spot.frames.flat(), spot.anchor],
        };
      } else if (pending) {
        cls.set(pending.e, 'path-end');
        badge = { text: 'Shift+click the next corner', end: pending.e };
      } else if (edit) {
        const ids = edit.valid ? [...edit.changes.keys()] : [ed.edit.id];
        const source = edit.valid ? shown : ed.compiled;
        for (const id of ids) for (const e of footprint(source, id)) cls.set(e, edit.valid ? 'path' : 'bad');
        const a = ed.action(ed.edit.id);
        const span = shown.spans.get(ed.edit.id);
        badge = {
          text: edit.valid ? `${a.name}${span ? `: frames ${span.from}–${span.to}` : ''}` : edit.reason || "doesn't fit here",
          bad: !edit.valid,
          cells: [...cls.keys()],
        };
      } else if (sel) {
        if (sel.type !== 'path') for (const e of footprint(ed.compiled, sel.id)) cls.set(e, 'footprint');
        for (const e of ed.cellsIn(sel.id)) cls.set(e, 'selected');
      }

      const key = JSON.stringify([[...cls], badge, draft ? draft.cells : null]);
      if (key === this.overlayKey) return;
      this.overlayKey = key;

      for (const r of this.rects) {
        const c = cls.get(r.e) || '';
        if (c !== r.cls) {
          r.node.setAttribute('class', c);
          r.cls = c;
        }
      }
      this.pathLayer.style.display = draft || badge ? '' : 'none';
      this.pathLine.style.display = draft ? '' : 'none';
      this.pathStart.style.display = draft ? '' : 'none';
      if (draft) {
        this.pathLine.setAttribute('points', draft.cells.map((e) => this.at(e).join(',')).join(' '));
        const [sx, sy] = this.at(draft.start);
        this.pathStart.setAttribute('cx', sx);
        this.pathStart.setAttribute('cy', sy);
      }
      this.badge.style.display = badge ? '' : 'none';
      if (!badge) return;
      this.badge.classList.toggle('bad', Boolean(badge.bad));
      this.badgeText.textContent = badge.text;
      const width = this.badgeText.getComputedTextLength() + 28;
      let x;
      let y;
      if (badge.cells && badge.cells.length) {
        // Above the whole thing, so it covers none of its electrodes.
        const points = badge.cells.map((e) => this.at(e)).filter(Boolean);
        x = (Math.min(...points.map((p) => p[0])) + Math.max(...points.map((p) => p[0]))) / 2;
        y = Math.min(...points.map((p) => p[1])) - 2.1 * G.UNIT;
      } else {
        [x, y] = this.at(badge.end);
        const centre = this.centres.get(badge.end);
        if (badge.beside) x += (centre.x > 14 ? -1 : 1) * (1.4 * G.UNIT + width / 2); // right, or left near the edge
        else y -= 2.1 * G.UNIT;
      }
      x = Math.min(G.IMG_W - width / 2 - 8, Math.max(width / 2 + 8, x));
      y = Math.max(28, y);
      this.badgeText.setAttribute('x', x);
      this.badgeText.setAttribute('y', y);
      this.badgeBox.setAttribute('x', x - width / 2);
      this.badgeBox.setAttribute('y', y - 20);
      this.badgeBox.setAttribute('width', width);
    }

    // Every path as a thin line in its droplet's colour (only the selected one when `all` is
    // off), the selected path thicker with its points: start (ring), end (dot), corners (squares)
    // and waits (diamonds). A path being reshaped follows the edit; where the edit can't be built,
    // its points are joined in red.
    renderLines(ed, shown, all) {
      const edit = ed.edit && ed.edit.preview;
      const items = [];
      let handles = null;
      for (const a of ed.project.actions) {
        if (a.type !== 'path') continue;
        const changed = Boolean(edit && edit.changes.has(a.id));
        const selected = a.id === ed.selection;
        if (!all && !selected && !changed) continue;
        let cells = null;
        let points = a.points;
        let cls = 'line';
        if (changed && !edit.valid) {
          points = edit.changes.get(a.id).points;
          cells = points.map((p) => p.e);
          cls += ' bad';
        } else {
          const x = shown.expanded.get(a.id);
          if (x && x.built) cells = x.built.cells;
          if (changed) points = edit.changes.get(a.id).points;
        }
        if (!cells) continue;
        if (selected) cls += ' selected';
        if (changed && edit.valid) cls += ' moving';
        items.push({ cells, cls, colour: dropletColour(a.droplet) });
        if (selected) handles = points;
      }
      const key = JSON.stringify([items, handles]);
      if (key === this.linesKey) return;
      this.linesKey = key;

      this.lineLayer.replaceChildren();
      for (const it of items) {
        const pts = it.cells.map((e) => this.at(e)).filter(Boolean);
        if (pts.length === 1) pts.push(pts[0]);
        el('polyline', { class: it.cls, points: pts.map((p) => p.join(',')).join(' '), style: `stroke: ${it.colour}` }, this.lineLayer);
      }
      this.handleLayer.replaceChildren();
      if (!handles) return;
      const last = handles.length - 1;
      handles.forEach((p, i) => {
        const c = this.at(p.e);
        if (!c) return;
        const [x, y] = c;
        if (i === 0) el('circle', { class: 'handle start', cx: x, cy: y, r: 13 }, this.handleLayer);
        else if (i === last) el('circle', { class: 'handle end', cx: x, cy: y, r: 13 }, this.handleLayer);
        else if (p.wait) el('rect', { class: 'handle wait', x: x - 10, y: y - 10, width: 20, height: 20, transform: `rotate(45 ${x} ${y})` }, this.handleLayer);
        else el('rect', { class: 'handle corner', x: x - 9, y: y - 9, width: 18, height: 18 }, this.handleLayer);
      });
    }
  }

  OD.view = { BoardView, COLOR, dropletColour };
})(globalThis);
