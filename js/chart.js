/* The timing chart under the board: how long each step lasts (bars) against the step number.
 * Click or drag on it to go to a step, hover for the numbers. Plain SVG, no library. */
(function (root) {
  'use strict';

  const NS = 'http://www.w3.org/2000/svg';
  // Emphasis: steps with their own time in the accent, steps on the default in a recessive gray.
  const INK = {
    own: '#2a78d6',
    plain: '#9c9a92',
    wash: 'rgba(42, 120, 214, 0.1)',
    grid: '#e1e0d9',
    axis: '#c3c2b7',
    muted: '#898781',
    primary: '#0b0b0b',
    surface: '#fcfcfb',
  };
  const PAD = { left: 58, right: 16, top: 30, bottom: 24 }; // the legend sits in the top strip
  const MIN_SLOTS = 10; // a short sequence sits at the left instead of spreading out

  function el(tag, attrs, parent) {
    const node = document.createElementNS(NS, tag);
    for (const k of Object.keys(attrs)) node.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(node);
    return node;
  }

  // "0.5 s", "12.5 s", "2 min 5 s".
  function formatTime(ms) {
    const s = ms / 1000;
    if (s < 10) return `${+s.toFixed(2)} s`;
    if (s < 59.95) return `${+s.toFixed(1)} s`;
    const whole = Math.round(s);
    const min = Math.floor(whole / 60);
    return whole % 60 ? `${min} min ${whole % 60} s` : `${min} min`;
  }

  // Round tick values from 0 up to at least `max`.
  function ticks(max, target = 4) {
    if (!(max > 0)) return [0, 1];
    const raw = max / target;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw * 0.999);
    const out = [];
    for (let i = 0; out.length === 0 || out[out.length - 1] < max * 0.999; i++) out.push(+(i * step).toFixed(10));
    return out;
  }

  // A bar with a rounded top and a square foot on the baseline.
  function barPath(x, y, w, h) {
    const r = Math.max(0, Math.min(4, w / 2, h));
    return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
  }

  class TimingChart {
    // onPick(step) is called when a step is clicked or dragged over.
    constructor(host, { onPick } = {}) {
      this.host = host;
      this.onPick = onPick || (() => {});
      this.data = null;
      this.key = '';
      this.svg = el('svg', { class: 'chart-svg', tabindex: 0, role: 'img' }, host);
      this.tip = document.createElement('div');
      this.tip.className = 'chart-tip';
      this.tip.hidden = true;
      host.appendChild(this.tip);
      this.geometry = null;
      this.pressed = false;
      this.hovered = null;

      new ResizeObserver(() => this.draw()).observe(host);
      this.svg.addEventListener('pointerdown', (evt) => {
        if (evt.button !== 0 || !this.geometry) return;
        this.pressed = true;
        this.svg.setPointerCapture(evt.pointerId);
        this.pick(evt);
      });
      this.svg.addEventListener('pointermove', (evt) => {
        if (!this.geometry) return;
        if (this.pressed) this.pick(evt);
        this.hover(this.stepAt(evt), evt);
      });
      for (const type of ['pointerup', 'pointercancel']) this.svg.addEventListener(type, () => (this.pressed = false));
      this.svg.addEventListener('pointerleave', () => {
        if (!this.pressed) this.hover(null);
      });
      // Keyboard focus shows the same readout as hover, for the step on screen.
      this.svg.addEventListener('focus', () => this.hover(this.data && this.data.current));
      this.svg.addEventListener('blur', () => this.hover(null));
    }

    // data: { times: [ms of step 1, 2, ...], own: [true where a step has its own time], current }
    update(data) {
      const key = `${data.current}|${data.times.join(',')}|${data.own.map(Number).join('')}`;
      if (key === this.key) return;
      this.key = key;
      this.data = data;
      this.draw();
    }

    stepAt(evt) {
      const { plot, slot, steps } = this.geometry;
      const rect = this.svg.getBoundingClientRect();
      const s = Math.floor((evt.clientX - rect.left - plot.x) / slot) + 1;
      return Math.min(steps, Math.max(1, s));
    }

    pick(evt) {
      const s = this.stepAt(evt);
      if (s !== this.data.current) this.onPick(s);
    }

    draw() {
      if (!this.data) return;
      const { times, own, current } = this.data;
      const steps = times.length;
      const width = this.host.clientWidth;
      const height = this.host.clientHeight;
      if (!width || !height) return;
      const svg = this.svg;
      svg.replaceChildren();
      svg.setAttribute('viewBox', `0 0 ${width} ${height}`);

      const totals = [];
      times.forEach((t, i) => totals.push((totals[i - 1] || 0) + t));
      const max = Math.max(...times);
      const minutes = max >= 120000;
      const unit = minutes ? 60000 : 1000;
      const yTicks = ticks(max / unit);
      const top = yTicks[yTicks.length - 1] * unit;

      const plot = { x: PAD.left, y: PAD.top, w: width - PAD.left - PAD.right, h: height - PAD.top - PAD.bottom };
      const slot = plot.w / Math.max(steps, MIN_SLOTS);
      const base = plot.y + plot.h;
      const xOf = (s) => plot.x + (s - 0.5) * slot;
      const yOf = (ms) => base - (ms / top) * plot.h;
      this.geometry = { plot, slot, steps, xOf, yOf, totals };

      // Gridlines and y labels (round values, muted, one unit per axis).
      for (const v of yTicks) {
        const y = yOf(v * unit);
        if (v > 0) el('line', { x1: plot.x, x2: plot.x + plot.w, y1: y, y2: y, class: 'grid' }, svg);
        el('text', { x: plot.x - 8, y, class: 'tick y' }, svg).textContent = `${v}${minutes ? ' min' : ' s'}`;
      }

      // The step on screen: a wash over its column.
      if (current >= 1 && current <= steps) {
        el('rect', { x: plot.x + (current - 1) * slot, y: plot.y, width: slot, height: plot.h, class: 'current' }, svg);
      }

      this.marks = [];
      const w = Math.max(1, Math.min(24, slot - 2)); // thin bars with a 2px gap between them
      times.forEach((t, i) => {
        const y = yOf(t);
        this.marks.push(el('path', { d: barPath(xOf(i + 1) - w / 2, y, w, base - y), class: own[i] ? 'bar own' : 'bar' }, svg));
      });
      el('line', { x1: plot.x, x2: plot.x + plot.w, y1: base, y2: base, class: 'baseline' }, svg);

      // Step numbers: round intervals that don't crowd, plus the step on screen in dark ink.
      const every = [1, 2, 5, 10, 20, 25, 50, 100].find((n) => n * slot >= 30) || 100;
      const label = (s, cls) => el('text', { x: xOf(s), y: base + 16, class: cls }, svg).textContent = s;
      for (let s = 1; s <= steps; s++) {
        if ((s === 1 || s % every === 0) && Math.abs(s - current) * slot >= 26) label(s, 'tick x');
      }
      if (current >= 1 && current <= steps) label(current, 'tick x now');

      const total = totals[totals.length - 1];
      svg.setAttribute('aria-label', `Time of each step for ${steps} steps; ${formatTime(total)} in all.`);
      this.hover(this.hovered);
    }

    // The readout for step s (null hides it), beside the pointer or above the step.
    hover(s, evt) {
      this.hovered = s;
      for (const m of this.marks || []) m.classList.remove('hover');
      if (!s || !this.geometry || s > this.geometry.steps) {
        this.tip.hidden = true;
        return;
      }
      const { xOf, yOf, totals, plot } = this.geometry;
      const time = this.data.times[s - 1];
      const own = this.data.own[s - 1];
      if (this.marks[s - 1]) this.marks[s - 1].classList.add('hover');

      const strong = document.createElement('strong');
      strong.textContent = formatTime(time);
      const first = document.createElement('div');
      first.append(strong, ` step ${s}`);
      const second = document.createElement('div');
      second.className = 'sub';
      second.textContent = `${own ? 'its own time' : 'the default time'} · ${formatTime(totals[s - 1])} in all`;
      this.tip.replaceChildren(first, second);
      this.tip.hidden = false;

      const hostRect = this.host.getBoundingClientRect();
      const x = evt ? evt.clientX - hostRect.left : xOf(s);
      const y = evt ? evt.clientY - hostRect.top : yOf(time);
      const tipW = this.tip.offsetWidth;
      const left = x + 14 + tipW > hostRect.width ? x - 14 - tipW : x + 14;
      this.tip.style.left = `${Math.max(0, left)}px`;
      this.tip.style.top = `${Math.max(0, Math.min(y - 20, plot.y + plot.h - this.tip.offsetHeight))}px`;
    }
  }

  (root.OD = root.OD || {}).chart = { TimingChart, formatTime, ticks, MIN_SLOTS };
})(globalThis);
