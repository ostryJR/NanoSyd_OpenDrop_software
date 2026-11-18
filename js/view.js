/* SVG drawing of the original controller screen (drawPlane and Electrode.drawElectrode), plus the
 * drag tool switch, undo/redo, the droplet paths' lines, the selected action, and the path,
 * template or edit being dragged. */
(function (root) {
  'use strict';

  const OD = root.OD;
  const G = OD.layout.GEOMETRY;
  const { CONTROLS } = OD.editor;
  const { electrodeGraph } = OD.paths;
  const { flow } = OD.templates;
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

  const xy = (p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`;

  // The steps of a line through `points` (px), each listed once as [from, to, both]; both = the
  // droplet also goes back along it.
  function movesAlong(points) {
    const seen = new Map();
    for (let i = 1; i < points.length; i++) {
      const [a, b] = [points[i - 1], points[i]];
      if (xy(a) !== xy(b)) seen.set(`${xy(a)}>${xy(b)}`, [a, b]);
    }
    const out = [];
    const listed = new Set();
    for (const [key, [a, b]] of seen) {
      if (listed.has(key)) continue;
      const back = `${xy(b)}>${xy(a)}`;
      listed.add(back);
      out.push([a, b, seen.has(back)]);
    }
    return out;
  }

  // Small arrowheads showing which way the droplet goes: one in the middle of each move
  // ([from, to, both], px), or two apart, each nearer its own end, where it goes both ways.
  // As one SVG path.
  function arrowHeads(moves, size) {
    const h = size / 2;
    const w = size * 0.5;
    let d = '';
    const head = (a, b, t) => {
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const len = Math.hypot(dx, dy);
      if (len < size) return;
      const [ux, uy] = [dx / len, dy / len];
      const [mx, my] = [a[0] + dx * t, a[1] + dy * t];
      const tip = [mx + ux * h, my + uy * h];
      const left = [mx - ux * h - uy * w, my - uy * h + ux * w];
      const right = [mx - ux * h + uy * w, my - uy * h - ux * w];
      d += `M${xy(tip)}L${xy(left)}L${xy(right)}Z`;
    };
    for (const [a, b, both] of moves) {
      if (both) {
        head(a, b, 0.72);
        head(b, a, 0.72);
      } else head(a, b, 0.5);
    }
    return d;
  }

  const segments = (moves) => moves.map(([a, b]) => `M${xy(a)}L${xy(b)}`).join('');

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
      // Over the electrodes: an outline in each heater's colour round the electrodes over it.
      this.zoneLayer = el('g', { class: 'heat-zones' }, svg);
      // Rings where a droplet waits on an electrode that isn't on: left there, or coming in.
      this.ringLayer = el('g', { class: 'rings' }, svg);
      this.ringsKey = '';
      // Droplet paths as lines through their electrodes' centres, and the selected path's points.
      this.lineLayer = el('g', { class: 'lines' }, svg);
      // Where the device senses a droplet (feedback), as dots.
      this.sensedLayer = el('g', { class: 'sensed' }, svg);
      this.handleLayer = el('g', { class: 'handles' }, svg);

      // The path being drawn: a line through the electrodes' centres, a dot at its start and
      // the step count next to its end. The badge also labels templates and edits.
      // A template being placed shows how its droplet goes, the same way.
      this.pathLayer = el('g', { class: 'path-layer' }, svg);
      this.pathLine = el('polyline', { class: 'path-line', points: '' }, this.pathLayer);
      this.pathArrows = el('path', { class: 'path-arrows', d: '' }, this.pathLayer);
      this.spotLine = el('path', { class: 'path-line', d: '' }, this.pathLayer);
      this.spotArrows = el('path', { class: 'path-arrows', d: '' }, this.pathLayer);
      this.pathStart = el('circle', { class: 'path-start', r: 10 }, this.pathLayer);
      this.badge = el('g', { class: 'path-badge' }, this.pathLayer);
      this.badgeBox = el('rect', { rx: 20, height: 40 }, this.badge);
      this.badgeText = el('text', {}, this.badge);
      this.pathLayer.style.display = 'none';

      this.numberLayer = el('g', { class: 'numbers' }, svg);

      // Under the board: the heaters (target, and what the device measures) and the magnets in the
      // frame on screen.
      this.heatStrip = el('g', { class: 'heat-strip' }, svg);
      this.heatKey = '';
      // Magnet electrodes (magnet layout): labelled M1 and M2.
      this.magnetLabels = el('g', { class: 'magnet-labels' }, svg);

      const controls = el('g', { class: 'controls' }, svg);
      const box = (u, v, parent = controls) =>
        el('rect', { x: px(u), y: py(v), width: BOX, height: BOX, fill: COLOR.button }, parent);
      this.playBox = box(34, -9);
      // Its hover tip, over the box and label: with a process, play is a preview of the timeline
      // (▶ Run is the real run).
      this.playTip = el('title', {}, el('rect', { class: 'hit', x: px(34), y: py(-9), width: G.UNIT * 6, height: G.UNIT * 2 }, controls));
      box(34, 4); // copy last frame
      box(34, 7); // clear frame
      box(34, 10); // clear all
      this.reservoirButtons = el('g', {}, controls);
      for (const [u, v] of [[28, -6], [28, 4], [-30, -6], [-30, 4]]) box(u, v, this.reservoirButtons);

      // The device, where OpenDropController had it: live and feedback under play (white when
      // on; feedback only for boards that have it), and a dot by the title: gray = not connected,
      // amber = connecting, green = answering, red = not answering. Connecting is in the Device tab.
      // A hover tip over a box and its label (w grid units wide).
      const tip = (u, v, w, parent) => el('title', {}, el('rect', { class: 'hit', x: px(u), y: py(v), width: G.UNIT * w, height: G.UNIT * 2 }, parent));
      this.liveBox = box(34, -6);
      label('live', 37, -4.5, controls);
      tip(34, -6, 6, controls).textContent = 'Live: the device shows the frame on screen, so stepping, playing and editing go straight to it';
      this.feedbackGroup = el('g', {}, controls);
      this.feedbackBox = box(34, -3, this.feedbackGroup);
      label('feedback', 37, -1.5, this.feedbackGroup);
      tip(34, -3, 9, this.feedbackGroup).textContent = 'Show where the device senses droplets';
      this.deviceDot = el('circle', { class: 'device-dot', cx: px(-44.5), cy: py(-18.5), r: BOX / 4 }, controls);
      this.deviceTip = el('title', {}, this.deviceDot);
      this.deviceKey = '';

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
      this.graph = null;
      this.flows = new WeakMap(); // a template's expanded steps -> its moves (grid units)
      this.overlayKey = '';
      this.linesKey = '';
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
      this.graph = electrodeGraph(lay.rects);
      this.centres = this.graph.centres;
      this.flows = new WeakMap();
      this.overlayKey = '';
      this.linesKey = '';
      this.pathLayer.style.display = 'none';
      this.reservoirButtons.style.display = lay.hasReservoirs ? '' : 'none';
      this.layoutId = lay.id;
      this.heatKey = '';
      this.magnetLabels.replaceChildren();
      for (const m of OD.heat.MAGNETS) {
        const r = lay.rects.find((x) => x.e === m.e);
        if (r) el('text', { x: px(r.x + r.h / 2), y: py(r.y + r.v / 2) }, this.magnetLabels).textContent = `M${m.n}`;
      }
    }

    // heat: { targets: [°C or null ×3], magnets: [bool, bool], temps: [°C or null ×3] from a
    // device (or null), waiting (a hold being waited for: { targets }) , show } or null.
    renderHeat(info) {
      const key = JSON.stringify(info);
      if (key === this.heatKey) return;
      this.heatKey = key;
      const strip = this.heatStrip;
      strip.replaceChildren();
      this.zoneLayer.replaceChildren();
      if (!info || !info.show) return;
      const H = OD.heat;

      // Zones: an outline round each heater's electrodes, in the colour of its target (only on
      // the layouts of the cartridge the heaters are known for).
      const zones = H.HEATER_LAYOUTS.includes(this.layoutId);
      info.targets.forEach((t, i) => {
        const zone = H.HEATER_ZONES[i];
        if (!zones || !zone || t === null) return;
        const boxes = this.rects.filter((r) => zone.includes(r.e)).map((r) => ['x', 'y', 'width', 'height'].map((k) => Number(r.node.getAttribute(k))));
        if (!boxes.length) return;
        const x0 = Math.min(...boxes.map((b) => b[0]));
        const y0 = Math.min(...boxes.map((b) => b[1]));
        const x1 = Math.max(...boxes.map((b) => b[0] + b[2]));
        const y1 = Math.max(...boxes.map((b) => b[1] + b[3]));
        el('rect', { x: x0 - 3, y: y0 - 3, width: x1 - x0 + 6, height: y1 - y0 + 6, rx: 6, style: `stroke:${H.colour(t)}` }, this.zoneLayer);
      });

      // The strip: one pill per heater and magnet, centred under the board.
      const pills = [];
      info.targets.forEach((t, i) => {
        const now = info.temps && typeof info.temps[i] === 'number' ? info.temps[i] : null;
        const text = t === null ? (now === null ? `T${i + 1}  —` : `T${i + 1}  ${now.toFixed(1)} °C`) : `T${i + 1}  ${t} °C${now === null ? '' : `  ·  ${now.toFixed(1)}`}`;
        const there = t !== null && now !== null && Math.abs(now - t) <= (info.tolerance || H.DEFAULT_TOLERANCE);
        pills.push({ text, colour: t === null ? null : H.colour(t), cls: t === null ? 'off' : there ? 'there' : '', title: t === null ? `T${i + 1}: not set by the sequence` : `T${i + 1}: target ${t} °C${now === null ? '' : `, measured ${now.toFixed(1)} °C`}` });
      });
      info.magnets.forEach((on, i) => pills.push({ text: `M${i + 1}  ${on ? 'on' : 'off'}`, colour: on ? '#52514e' : null, cls: on ? 'magnet on' : 'magnet off', title: `Magnet ${i + 1} ${on ? 'on' : 'off'}` }));
      const charW = 15;
      const widths = pills.map((p) => 44 + p.text.length * charW);
      const gap = 16;
      const total = widths.reduce((a, b) => a + b, 0) + gap * (pills.length - 1);
      let x = G.CX - total / 2;
      const y = py(21.2);
      pills.forEach((p, k) => {
        const g = el('g', { class: `pill ${p.cls}` }, strip);
        el('title', {}, g).textContent = p.title;
        el('rect', { x, y, width: widths[k], height: 40, rx: 20 }, g);
        el('circle', { cx: x + 22, cy: y + 20, r: 8, style: p.colour ? `fill:${p.colour}` : '' }, g);
        el('text', { x: x + 38, y: y + 21 }, g).textContent = p.text;
        x += widths[k] + gap;
      });
      if (info.waiting) {
        el('text', { x: G.CX, y: y + 66, class: 'heat-wait' }, strip).textContent = `Waiting for the heaters: ${H.targetsText(info.waiting.targets)}…`;
      }
    }

    at(e) {
      const c = this.centres.get(e);
      return c ? [px(c.x), py(c.y)] : null;
    }

    // How the droplets of a template go (frames of electrodes), as moves in px.
    flowOf(frames) {
      return flow(frames, this.graph).map((m) => [[px(m.from.x), py(m.from.y)], [px(m.to.x), py(m.to.y)], m.both]);
    }

    // device: { state ('off', 'connecting', 'on', 'silent'), live, feedback, canFeedback, name,
    // sensed (electrodes) } or null.
    renderDevice(device) {
      const d = device || { state: 'off' };
      const key = JSON.stringify([d.state, d.live, d.feedback, d.canFeedback, d.name, d.sensed]);
      if (key === this.deviceKey) return;
      this.deviceKey = key;
      const on = d.state === 'on' || d.state === 'silent';
      this.liveBox.setAttribute('fill', d.live ? COLOR.active : COLOR.button);
      this.feedbackGroup.style.display = on && d.canFeedback ? '' : 'none';
      this.feedbackBox.setAttribute('fill', d.feedback ? COLOR.active : COLOR.button);
      this.deviceDot.setAttribute('class', `device-dot ${d.state}`);
      const states = { off: 'Not connected', connecting: 'Connecting…', on: d.name || 'Connected', silent: `${d.name || 'The device'} is not answering` };
      this.deviceTip.textContent = states[d.state] || '';
      this.sensedLayer.replaceChildren();
      for (const e of d.sensed || []) {
        const c = this.at(e);
        if (c) el('circle', { cx: c[0], cy: c[1], r: 11 }, this.sensedLayer);
      }
    }

    // rings: [{ e, colour }] — a droplet waits on electrode e.
    renderRings(rings) {
      const key = JSON.stringify(rings);
      if (key === this.ringsKey) return;
      this.ringsKey = key;
      this.ringLayer.replaceChildren();
      for (const r of rings) {
        const c = this.at(r.e);
        if (c) el('circle', { cx: c[0], cy: c[1], r: 15, style: `stroke: ${r.colour}` }, this.ringLayer);
      }
    }

    render(ed, { numbers = false, lines = true, device = null, rings = [], heat = null, frameOffset = 0 } = {}) {
      this.renderDevice(device);
      this.renderHeat(heat);
      this.renderRings(rings);
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
      this.frameLabel.textContent = frame + frameOffset; // with a process: the whole timeline's frame
      this.speedLabel.textContent = perMinute(ed.speed);
      this.playBox.setAttribute('fill', ed.playing ? COLOR.active : COLOR.button);
      const playText = ed.doc && ed.doc.process
        ? 'Preview: plays the timeline, step after step, without asking anything (▶ Run at the top asks at Measure and Ask) (Space)'
        : 'Play the frames with their times, round and round (Space)';
      if (this.playTip.textContent !== playText) this.playTip.textContent = playText;
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
        // Where it would touch another droplet (that frame's electrodes of both), dark red.
        if (bad) for (const e of draft.check.clash || []) if (!cls.has(e)) cls.set(e, 'clash');
        if (draft.steps > 0) {
          cls.set(draft.end, bad ? 'bad-end' : 'path-end');
          const a = this.centres.get(draft.end);
          const b = this.centres.get(draft.cells[draft.cells.length - 2]);
          // After a step up or down the badge goes beside the end, after a step sideways above
          // it, so it never hides the path's last step.
          badge = {
            text: bad ? draft.check.reason : plural(draft.steps, 'step') + (draft.limited ? ` · frame ${OD.model.MAX_FRAMES} limit` : ''),
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
          text: spot.valid ? plural(spot.steps, 'step') : spot.reason || (spot.fits ? `runs past frame ${OD.model.MAX_FRAMES}` : "doesn't fit here"),
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
        if (!edit.valid) for (const e of edit.clash || []) if (!cls.has(e)) cls.set(e, 'clash');
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

      const key = JSON.stringify([[...cls], badge, draft ? draft.cells : null, spot ? spot.frames : null]);
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
      this.pathArrows.style.display = draft ? '' : 'none';
      this.pathStart.style.display = draft ? '' : 'none';
      if (draft) {
        const bad = Boolean(draft.check && !draft.check.valid);
        this.pathLine.classList.toggle('bad', bad);
        this.pathArrows.classList.toggle('bad', bad);
        const points = draft.cells.map((e) => this.at(e));
        this.pathLine.setAttribute('points', points.map((p) => p.join(',')).join(' '));
        this.pathArrows.setAttribute('d', arrowHeads(movesAlong(points), 17));
        const [sx, sy] = this.at(draft.start);
        this.pathStart.setAttribute('cx', sx);
        this.pathStart.setAttribute('cy', sy);
      }
      const moves = spot ? this.flowOf(spot.frames) : [];
      for (const node of [this.spotLine, this.spotArrows]) {
        node.style.display = moves.length ? '' : 'none';
        node.classList.toggle('bad', Boolean(spot && !spot.valid));
      }
      this.spotLine.setAttribute('d', segments(moves));
      this.spotArrows.setAttribute('d', arrowHeads(moves, 17));
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

    // Every path as a thin line in its droplet's colour, with small arrows the way the droplet
    // goes, and every template as lines between the places its droplets go round or through
    // (only the selected one when `all` is off). The selected path is thicker, with its points:
    // start (ring), end (dot) and corners (squares). What is being moved or
    // reshaped follows the edit; where a path's edit can't be built, its points are joined in red.
    renderLines(ed, shown, all) {
      const edit = ed.edit && ed.edit.preview;
      const items = [];
      let handles = null;
      for (const a of ed.project.actions) {
        if (a.type !== 'path' && a.type !== 'template') continue;
        const changed = Boolean(edit && edit.changes.has(a.id));
        const selected = a.id === ed.selection;
        if (!all && !selected && !changed) continue;
        let cls = a.type === 'path' ? 'line' : 'line mix';
        if (selected) cls += ' selected';
        if (changed && edit.valid) cls += ' moving';
        const colour = dropletColour(a.droplet);
        if (a.type === 'template') {
          const x = shown.expanded.get(a.id);
          if (!x || !x.steps) continue;
          if (!this.flows.has(x)) this.flows.set(x, this.flowOf(x.steps.map((s) => s.cells)));
          const moves = this.flows.get(x);
          if (moves.length) items.push({ moves, cls, colour });
          continue;
        }
        let cells = null;
        let points = a.points;
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
        items.push({ cells, cls, colour });
        if (selected) handles = points;
      }
      const key = JSON.stringify([items, handles]);
      if (key === this.linesKey) return;
      this.linesKey = key;

      this.lineLayer.replaceChildren();
      for (const it of items) {
        const size = it.cls.includes('selected') ? 22 : 16;
        const stroke = `stroke: ${it.colour}`;
        const fill = `fill: ${it.colour}`;
        const arrows = it.cls.replace('line', 'arrows');
        if (it.moves) {
          el('path', { class: it.cls, d: segments(it.moves), style: stroke }, this.lineLayer);
          el('path', { class: arrows, d: arrowHeads(it.moves, size), style: fill }, this.lineLayer);
          continue;
        }
        const pts = it.cells.map((e) => this.at(e)).filter(Boolean);
        if (pts.length === 1) pts.push(pts[0]);
        el('polyline', { class: it.cls, points: pts.map((p) => p.join(',')).join(' '), style: stroke }, this.lineLayer);
        el('path', { class: arrows, d: arrowHeads(movesAlong(pts), size), style: fill }, this.lineLayer);
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
        else el('rect', { class: 'handle corner', x: x - 9, y: y - 9, width: 18, height: 18 }, this.handleLayer);
      });
    }
  }

  OD.view = { BoardView, COLOR, dropletColour };
})(globalThis);
