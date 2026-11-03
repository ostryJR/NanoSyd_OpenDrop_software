/* SVG drawing of the original controller screen (drawPlane and Electrode.drawElectrode), plus the
 * drag tool switch, undo/redo and the path or template being placed. */
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
    toolPaint: 'Drag switches electrodes on or off in this frame, like the original (P)',
    undo: 'Undo (⌘Z or Ctrl+Z)',
    redo: 'Redo (⇧⌘Z or Ctrl+Y)',
  };

  function el(tag, attrs, parent) {
    const node = document.createElementNS(NS, tag);
    for (const k of Object.keys(attrs)) node.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(node);
    return node;
  }

  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  // Frames per minute, as a whole number when it is one.
  const perMinute = (speed) => (Math.abs(speed - Math.round(speed)) < 0.05 ? String(Math.round(speed)) : speed.toFixed(1));

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
      label('save', 32, -18.5);
      label('load', 38, -18.5);
      label('play', 37, -7.5);
      label('copy last frame', 37, 5.5);
      label('clear frame', 37, 8.5);
      label('clear all', 37, 11.5);
      label('frame_no:', -20, 16);
      label('frames/min:', 10, 16);
      label('drag:', -43, -10.5);
      this.frameLabel = label('', -12, 16);
      this.speedLabel = label('', 18, 16);

      this.electrodeLayer = el('g', { class: 'electrodes' }, svg);

      // The path being drawn: a line through the electrodes' centres, a dot at its start and
      // the step count next to its end.
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

      // On the left: the drag tool switch (the chosen tool's box is white) and undo/redo.
      this.toolBoxes = [];
      this.historyButtons = {};
      for (const c of CONTROLS.filter((control) => control.label)) {
        const group = el('g', {}, controls);
        const node = box(c.x, c.y, group);
        label(c.label, c.x + 3, c.y + 1.5, group);
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
      this.pathLayer.style.display = 'none';
      this.reservoirButtons.style.display = lay.hasReservoirs ? '' : 'none';
    }

    render(ed, showNumbers) {
      const { seq, frame } = ed;
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
      this.numberLayer.style.display = showNumbers ? '' : 'none';
      for (const { tool, node } of this.toolBoxes) node.setAttribute('fill', ed.tool === tool ? COLOR.active : COLOR.button);
      this.historyButtons.undo.classList.toggle('unavailable', !ed.canUndo);
      this.historyButtons.redo.classList.toggle('unavailable', !ed.canRedo);
      this.renderOverlay(ed);
    }

    // The path or template being placed, until it is added: its electrodes light blue (light red
    // where a template doesn't fit), the path's end or the template's anchor blue (red), and the
    // step count beside it.
    renderOverlay(ed) {
      const draft = ed.draft && ed.draft.moved ? ed.draft : null;
      const spot = !draft && ed.placement ? ed.placement.spot : null;
      const key = draft
        ? `path|${draft.cells.join(',')}|${draft.limited}`
        : spot
          ? `template|${spot.anchor}|${spot.frame}|${spot.valid}|${spot.frames.map((c) => c.join(',')).join(';')}`
          : '';
      if (key === this.overlayKey) return;
      this.overlayKey = key;

      let cells = [];
      let end = null;
      const bad = Boolean(spot && !spot.valid);
      if (draft) {
        cells = draft.cells;
        if (draft.steps > 0) end = draft.end;
      } else if (spot) {
        cells = spot.frames.flat();
        end = spot.anchor;
      }
      const inPath = new Set(cells);
      for (const r of this.rects) {
        const cls = r.e === end ? (bad ? 'bad-end' : 'path-end') : inPath.has(r.e) ? (bad ? 'bad' : 'path') : '';
        if (cls !== r.cls) {
          r.node.setAttribute('class', cls);
          r.cls = cls;
        }
      }
      this.pathLayer.style.display = draft || spot ? '' : 'none';
      if (!draft && !spot) return;

      const at = (e) => {
        const c = this.centres.get(e);
        return [px(c.x), py(c.y)];
      };
      // A path also gets a line through its electrodes and a dot where it starts.
      this.pathLine.style.display = draft ? '' : 'none';
      this.pathStart.style.display = draft ? '' : 'none';
      if (draft) {
        this.pathLine.setAttribute('points', cells.map((e) => at(e).join(',')).join(' '));
        const [sx, sy] = at(draft.start);
        this.pathStart.setAttribute('cx', sx);
        this.pathStart.setAttribute('cy', sy);
      }

      let text = null;
      let beside = false;
      if (draft && draft.steps > 0) {
        text = plural(draft.steps, 'step') + (draft.limited ? ' · frame 200 limit' : '');
        // After a step up or down the badge goes beside the end, after a step sideways above
        // it, so it never hides the path's last step.
        const a = this.centres.get(draft.end);
        const b = this.centres.get(draft.cells[draft.cells.length - 2]);
        beside = Math.abs(a.y - b.y) > Math.abs(a.x - b.x);
      } else if (spot) {
        text = spot.valid ? plural(spot.steps, 'step') : spot.fits ? 'runs past frame 200' : "doesn't fit here";
      }
      this.badge.style.display = text ? '' : 'none';
      this.badge.classList.toggle('bad', bad);
      if (!text) return;
      this.badgeText.textContent = text;
      const width = this.badgeText.getComputedTextLength() + 28;
      const centre = this.centres.get(end);
      let [x, y] = at(end);
      if (spot) {
        // Above the whole template, so it covers none of its electrodes.
        const points = [...inPath, end].map(at);
        x = (Math.min(...points.map((p) => p[0])) + Math.max(...points.map((p) => p[0]))) / 2;
        y = Math.min(...points.map((p) => p[1])) - 2.1 * G.UNIT;
      } else if (beside) {
        x += (centre.x > 14 ? -1 : 1) * (1.4 * G.UNIT + width / 2); // right, or left near the edge
      } else {
        y -= 2.1 * G.UNIT;
      }
      this.badgeText.setAttribute('x', x);
      this.badgeText.setAttribute('y', y);
      this.badgeBox.setAttribute('x', x - width / 2);
      this.badgeBox.setAttribute('y', y - 20);
      this.badgeBox.setAttribute('width', width);
    }
  }

  OD.view = { BoardView, COLOR };
})(globalThis);
