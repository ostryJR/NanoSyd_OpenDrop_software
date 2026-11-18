/* The temperature chart under the board: the heaters' targets (T1-T3, solid steps), how warm
 * they are estimated to be (dashed, at the project's heating and cooling rates), what a live
 * device measured (dots), frames that wait for the heaters (hatched), and the two magnets as
 * lanes underneath, against time. It is also where they are set: a click in the plot sets the
 * chosen heater from that frame on, a point can be dragged (up and down: its temperature; left
 * and right: its frame), and a click in a magnet lane switches that magnet from that frame on.
 * Plain SVG, no library. */
(function (root) {
  'use strict';

  const OD = root.OD;
  const heat = OD.heat;
  const { formatTime, ticks } = OD.chart;
  const NS = 'http://www.w3.org/2000/svg';
  // T1-T3 in the categorical order (blue, orange, aqua); each line is labelled T1-T3 as well.
  const SERIES = ['#2a78d6', '#eb6834', '#1baf7a'];
  const PAD = { left: 52, right: 40, top: 12, bottom: 22 };
  const LANE = 14; // a magnet lane's height
  const LANE_GAP = 4;
  const MIN_SPAN = 10000; // ms: a short sequence sits at the left instead of spreading out

  function el(tag, attrs, parent) {
    const node = document.createElementNS(NS, tag);
    for (const k of Object.keys(attrs)) node.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(node);
    return node;
  }

  class TempChart {
    // host: the element to draw in. on: { pick(frame), add(frame, heater, °C), move(id, frame),
    //   set(id, heater, °C), magnet(frame, n), select(id) }
    constructor(host, on) {
      this.host = host;
      this.on = on;
      this.data = null;
      this.key = '';
      this.heater = 0; // the heater a click sets
      this.svg = el('svg', { class: 'temp-svg', tabindex: 0, role: 'img' }, host);
      this.tip = document.createElement('div');
      this.tip.className = 'chart-tip';
      this.tip.hidden = true;
      host.appendChild(this.tip);
      this.g = null; // geometry of the last drawing
      this.drag = null;
      new ResizeObserver(() => this.draw()).observe(host);

      this.svg.addEventListener('pointerdown', (evt) => this.down(evt));
      this.svg.addEventListener('pointermove', (evt) => this.moveTo(evt));
      this.svg.addEventListener('pointerup', (evt) => this.up(evt));
      this.svg.addEventListener('pointercancel', () => {
        this.drag = null;
        this.draw();
      });
      this.svg.addEventListener('pointerleave', () => {
        if (!this.drag) this.tip.hidden = true;
      });
    }

    setHeater(i) {
      this.heater = i;
      this.draw();
    }

    // data: { frames, times: [ms per frame], current, controls: [{ targets, magnets } per frame],
    //   start: { targets, magnets } coming in, holds: [{ frame, targets }], points: [{ id, frame,
    //   targets, wait, selected }], switches: [{ id, frame, magnet, on, selected }],
    //   readings: [{ ms, temps }] (ms from the start of frame 1), rates, holding }
    update(data) {
      const key = JSON.stringify(data);
      if (key === this.key) return;
      this.key = key;
      this.data = data;
      if (!this.drag) this.draw();
    }

    // --- geometry -------------------------------------------------------------------------------

    point(evt) {
      const r = this.svg.getBoundingClientRect();
      return { x: evt.clientX - r.left, y: evt.clientY - r.top };
    }

    // The frame at x (1..frames), by time.
    frameAt(x) {
      const { plot, scale, starts, frames } = this.g;
      const ms = (x - plot.x) / scale;
      let f = 1;
      while (f < frames && starts[f] <= ms) f++;
      return Math.max(1, f);
    }

    tempAt(y) {
      const { plot, lo, hi } = this.g;
      return heat.clampTemp(hi - ((y - plot.y) / plot.h) * (hi - lo));
    }

    // What is under p: a point ({ kind: 'point', id, heater }), a switch, a magnet lane, the plot.
    hit(p) {
      const g = this.g;
      if (!g) return null;
      let best = null;
      for (const m of g.marks) {
        const d = Math.hypot(m.x - p.x, m.y - p.y);
        if (d <= 11 && (!best || d < best.d)) best = { ...m, d };
      }
      if (best) return best;
      for (let n = 1; n <= 2; n++) {
        const y = g.laneY(n);
        if (p.y >= y - 2 && p.y <= y + LANE + 2 && p.x >= g.plot.x && p.x <= g.plot.x + g.plot.w) return { kind: 'lane', magnet: n };
      }
      if (p.x >= g.plot.x && p.x <= g.plot.x + g.plot.w && p.y >= g.plot.y && p.y <= g.plot.y + g.plot.h) return { kind: 'plot' };
      return null;
    }

    // --- pointer --------------------------------------------------------------------------------

    down(evt) {
      if (evt.button !== 0 || !this.g) return;
      const p = this.point(evt);
      const h = this.hit(p);
      if (!h) return;
      this.svg.setPointerCapture(evt.pointerId);
      if (h.kind === 'point' || h.kind === 'switch') {
        this.on.select(h.id);
        this.drag = { ...h, from: p, at: p, moved: false };
        return;
      }
      if (h.kind === 'lane') {
        this.on.magnet(this.frameAt(p.x), h.magnet);
        return;
      }
      this.on.add(this.frameAt(p.x), this.heater, this.tempAt(p.y));
    }

    moveTo(evt) {
      if (!this.g) return;
      const p = this.point(evt);
      if (this.drag) {
        this.drag.at = p;
        if (Math.hypot(p.x - this.drag.from.x, p.y - this.drag.from.y) > 3) this.drag.moved = true;
        this.draw();
        this.showTip(p, this.drag.kind === 'point' ? `${this.tempAt(p.y)} °C · frame ${this.frameAt(p.x)}` : `frame ${this.frameAt(p.x)}`);
        return;
      }
      this.hover(p);
    }

    up(evt) {
      const d = this.drag;
      this.drag = null;
      if (!d || !this.g) return;
      const p = this.point(evt);
      if (d.moved) {
        const frame = this.frameAt(p.x);
        const vertical = Math.abs(p.y - d.from.y) > Math.abs(p.x - d.from.x);
        if (d.kind === 'point' && vertical) this.on.set(d.id, d.heater, this.tempAt(p.y));
        else if (frame !== d.frame) this.on.move(d.id, frame);
      } else this.on.pick(d.frame);
      this.draw();
    }

    hover(p) {
      const h = this.hit(p);
      this.svg.style.cursor = h && (h.kind === 'point' || h.kind === 'switch') ? 'grab' : h ? 'crosshair' : '';
      if (!h) {
        this.tip.hidden = true;
        return;
      }
      const g = this.g;
      const f = h.frame || this.frameAt(p.x);
      const c = this.data.controls[f] || this.data.start;
      const lines = [];
      if (h.kind === 'point') lines.push([`T${h.heater + 1} → ${h.targets[h.heater]} °C`, `frame ${h.frame}${h.wait ? ' · waits until reached' : ''} · drag to change`]);
      else if (h.kind === 'switch') lines.push([`Magnet ${h.magnet} ${h.on ? 'on' : 'off'}`, `frame ${h.frame} · drag to move`]);
      else if (h.kind === 'lane') lines.push([`Magnet ${h.magnet}: ${c.magnets[h.magnet - 1] ? 'on' : 'off'}`, `click: switch it ${c.magnets[h.magnet - 1] ? 'off' : 'on'} from frame ${f}`]);
      else {
        const est = g.estimate(f);
        const set = c.targets.map((t, i) => (t === null ? null : `T${i + 1} ${t} °C (≈${Math.round(est[i])})`)).filter(Boolean);
        lines.push([set.length ? set.join(' · ') : 'No heater set', `frame ${f} · ${formatTime(g.starts[f - 1])} · click: T${this.heater + 1} → ${this.tempAt(p.y)} °C`]);
      }
      this.showTip(p, lines[0][0], lines[0][1]);
    }

    showTip(p, text, sub = '') {
      const strong = document.createElement('strong');
      strong.textContent = text;
      const first = document.createElement('div');
      first.append(strong);
      this.tip.replaceChildren(first);
      if (sub) {
        const second = document.createElement('div');
        second.className = 'sub';
        second.textContent = sub;
        this.tip.append(second);
      }
      this.tip.hidden = false;
      const w = this.tip.offsetWidth;
      const width = this.host.clientWidth;
      this.tip.style.left = `${Math.max(0, p.x + 14 + w > width ? p.x - 14 - w : p.x + 14)}px`;
      this.tip.style.top = `${Math.max(0, p.y - 34)}px`;
    }

    // --- drawing --------------------------------------------------------------------------------

    draw() {
      const data = this.data;
      const width = this.host.clientWidth;
      const height = this.host.clientHeight;
      if (!data || !width || !height) return;
      const svg = this.svg;
      svg.replaceChildren();
      svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
      const { frames, times, current, controls, start, rates } = data;

      // Time: where each frame starts (ms); frame f runs from starts[f - 1] to starts[f].
      const starts = [0];
      for (let f = 1; f <= frames; f++) starts.push(starts[f - 1] + times[f - 1]);
      const total = Math.max(MIN_SPAN, starts[frames]);
      const lanes = 2 * (LANE + LANE_GAP);
      const plot = { x: PAD.left, y: PAD.top, w: width - PAD.left - PAD.right, h: height - PAD.top - PAD.bottom - lanes - 6 };
      if (plot.h < 30 || plot.w < 60) return;
      const scale = plot.w / total;
      const xOf = (ms) => plot.x + ms * scale;

      // °C: from ambient (or lower readings) to a round value above the highest target.
      const all = [heat.AMBIENT];
      for (const c of [start, ...controls]) if (c) for (const t of c.targets) if (t !== null) all.push(t);
      for (const r of data.readings) for (const t of r.temps) if (typeof t === 'number') all.push(t);
      const yTicks = ticks(Math.max(...all), 4);
      const lo = Math.max(0, Math.min(heat.TEMP_RANGE[0], Math.floor(Math.min(...all) / 10) * 10));
      const hi = Math.max(lo + 20, yTicks[yTicks.length - 1]);
      const yOf = (t) => plot.y + plot.h - ((t - lo) / (hi - lo)) * plot.h;
      const base = plot.y + plot.h;
      const laneY = (n) => base + 8 + (n - 1) * (LANE + LANE_GAP);

      // Estimated temperatures at each frame boundary (and where they get there inside one).
      const est = [start.targets.map((t) => (t === null ? heat.AMBIENT : t))];
      const curves = [[], [], []];
      for (let i = 0; i < 3; i++) curves[i].push([xOf(0), yOf(est[0][i])]);
      let targets = start.targets;
      for (let f = 1; f <= frames; f++) {
        if (controls[f]) targets = controls[f].targets;
        const prev = est[f - 1];
        const next = prev.map((t, i) => {
          const to = targets[i] === null ? t : targets[i];
          const reachedAt = to === t ? 0 : (Math.abs(to - t) / (to > t ? rates.up : rates.down)) * 60000;
          if (reachedAt > 0 && reachedAt < times[f - 1]) curves[i].push([xOf(starts[f - 1] + reachedAt), yOf(to)]);
          const v = heat.rampAt(t, to, times[f - 1], rates);
          curves[i].push([xOf(starts[f]), yOf(v)]);
          return v;
        });
        est.push(next);
      }
      const targetAt = (f, i) => {
        for (let k = f; k >= 1; k--) if (controls[k]) return controls[k].targets[i];
        return start.targets[i];
      };
      this.g = {
        plot, scale, starts, frames, lo, hi, laneY, marks: [],
        estimate: (f) => est[Math.max(0, f - 1)],
      };

      // Grid and °C labels (recessive), the time axis.
      for (const v of ticks(hi, 4)) {
        if (v < lo) continue;
        const y = yOf(v);
        if (v > lo) el('line', { x1: plot.x, x2: plot.x + plot.w, y1: y, y2: y, class: 'grid' }, svg);
        el('text', { x: plot.x - 8, y, class: 'tick y' }, svg).textContent = `${v} °C`;
      }
      el('line', { x1: plot.x, x2: plot.x + plot.w, y1: base, y2: base, class: 'baseline' }, svg);
      const minutes = total >= 180000;
      const unit = minutes ? 60000 : 1000;
      for (const v of ticks(total / unit, 6)) {
        const x = xOf(v * unit);
        if (x > plot.x + plot.w + 1) continue;
        el('text', { x, y: laneY(2) + LANE + 14, class: 'tick x' }, svg).textContent = `${v}${minutes ? ' min' : ' s'}`;
      }

      // The frame on screen: a wash over its time.
      if (current >= 1 && current <= frames) {
        el('rect', { x: xOf(starts[current - 1]), y: plot.y, width: Math.max(2, times[current - 1] * scale), height: base - plot.y + lanes + 4, class: 'current' }, svg);
      }

      // Frames that wait for the heaters: hatched, labelled when there is room.
      for (const h of data.holds) {
        const x = xOf(starts[h.frame - 1]);
        const w = Math.max(2, times[h.frame - 1] * scale);
        el('rect', { x, y: plot.y, width: w, height: plot.h, class: 'hold' }, svg);
        if (w > 70) el('text', { x: x + w / 2, y: plot.y + 12, class: 'hold-label' }, svg).textContent = data.holding && data.holding.frame === h.frame ? 'waiting for the heaters…' : 'waits for the heaters';
      }

      // Per heater: the estimate (dashed), the target steps (solid), a label at the right end.
      for (let i = 0; i < 3; i++) {
        let any = false;
        let d = '';
        let lastY = null;
        for (let f = 1; f <= frames; f++) {
          const t = targetAt(f, i);
          if (t === null) {
            lastY = null;
            continue;
          }
          any = true;
          const y = yOf(t);
          d += lastY === null ? `M${xOf(starts[f - 1])},${y}` : `V${y}`;
          d += `H${xOf(starts[f])}`;
          lastY = y;
        }
        if (!any) continue;
        el('polyline', { points: curves[i].map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' '), class: 'estimate', style: `stroke:${SERIES[i]}` }, svg);
        el('path', { d, class: 'target', style: `stroke:${SERIES[i]}` }, svg);
        const end = targetAt(frames, i);
        if (end !== null) el('text', { x: plot.x + plot.w + 6, y: yOf(end), class: 'series-label' }, svg).textContent = `T${i + 1}`;
      }

      // What the device measured: small dots, a surface ring each.
      for (const r of data.readings) {
        r.temps.forEach((t, i) => {
          if (typeof t !== 'number' || !(controls.some((c) => c && c.targets[i] !== null) || start.targets[i] !== null)) return;
          el('circle', { cx: xOf(r.ms), cy: yOf(t), r: 2.5, class: 'reading', style: `fill:${SERIES[i]}` }, svg);
        });
      }

      // Points: one per heater a setting changes, at its frame; drag one to change it.
      const drag = this.drag;
      for (const p of data.points.filter((x) => x.frame <= frames)) {
        p.targets.forEach((t, i) => {
          if (t === null) return;
          let x = xOf(starts[p.frame - 1]);
          let y = yOf(t);
          if (drag && drag.kind === 'point' && drag.id === p.id && drag.heater === i && drag.moved) {
            const vertical = Math.abs(drag.at.y - drag.from.y) > Math.abs(drag.at.x - drag.from.x);
            if (vertical) y = yOf(this.tempAt(drag.at.y));
            else x = xOf(starts[this.frameAt(drag.at.x) - 1]);
          }
          const node = el(p.wait ? 'rect' : 'circle', p.wait
            ? { x: x - 5, y: y - 5, width: 10, height: 10, transform: `rotate(45 ${x} ${y})` }
            : { cx: x, cy: y, r: 5 }, svg);
          node.setAttribute('class', `point${p.selected ? ' selected' : ''}`);
          node.setAttribute('style', `fill:${SERIES[i]}`);
          this.g.marks.push({ kind: 'point', id: p.id, heater: i, frame: p.frame, targets: p.targets, wait: p.wait, x, y });
        });
      }

      // Magnet lanes: on where filled; a tick where a switch is.
      for (let n = 1; n <= 2; n++) {
        const y = laneY(n);
        el('rect', { x: plot.x, y, width: plot.w, height: LANE, class: 'lane' }, svg);
        el('text', { x: plot.x - 8, y: y + LANE / 2, class: 'tick y' }, svg).textContent = `M${n}`;
        let from = null;
        const on = (f) => (controls[f] || (f === 0 ? start : null) || { magnets: [false, false] }).magnets[n - 1];
        for (let f = 1; f <= frames + 1; f++) {
          const is = f <= frames && on(f);
          if (is && from === null) from = f;
          if (!is && from !== null) {
            el('rect', { x: xOf(starts[from - 1]), y: y + 2, width: Math.max(2, xOf(starts[f - 1]) - xOf(starts[from - 1])), height: LANE - 4, rx: 2, class: 'magnet-on' }, svg);
            from = null;
          }
        }
        for (const s of data.switches.filter((x) => x.magnet === n && x.frame <= frames)) {
          let x = xOf(starts[s.frame - 1]);
          if (drag && drag.kind === 'switch' && drag.id === s.id && drag.moved) x = xOf(starts[this.frameAt(drag.at.x) - 1]);
          el('rect', { x: x - 2, y: y - 2, width: 4, height: LANE + 4, rx: 2, class: `switch${s.selected ? ' selected' : ''}` }, svg);
          this.g.marks.push({ kind: 'switch', id: s.id, magnet: n, on: s.on, frame: s.frame, x, y: y + LANE / 2 });
        }
      }

      const any = data.points.length || data.switches.length || start.targets.some((t) => t !== null) || start.magnets.some(Boolean);
      if (!any) {
        el('text', { x: plot.x + plot.w / 2, y: plot.y + plot.h / 2, class: 'empty-label' }, svg).textContent =
          `Click to set T${this.heater + 1} from that frame on · click a magnet lane to switch it`;
      }
      svg.setAttribute('aria-label', `Heater targets and magnets over ${formatTime(starts[frames])}, ${frames} frames.`);
    }
  }

  OD.tempChart = { TempChart, SERIES };
})(globalThis);
