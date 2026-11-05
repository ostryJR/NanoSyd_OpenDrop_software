/* The timeline under the board, like a video editor's: one track per droplet, each action a clip
 * from its first to its last frame, links between droplets drawn as curves, and a playhead on the
 * frame on screen. Click a clip to select it, drag it to move it in time, double-click it to go
 * to its first frame; click or drag the ruler to go to a frame; Ctrl/⌘ + wheel zooms. Plain DOM. */
(function (root) {
  'use strict';

  const HEAD = 118; // px for the track names on the left
  const LANE = 26; // px per row of clips
  const CLIP = 20; // px: a clip's height
  const ARROW = 7; // px: an arrowhead's length
  const BANDS = 20; // px: the row of the process's tiles
  const RULER = 22;
  const MIN_PX = 6; // px per frame
  const MAX_PX = 60;
  const NS = 'http://www.w3.org/2000/svg';

  function div(cls, parent, text) {
    const node = document.createElement('div');
    node.className = cls;
    if (text !== undefined) node.textContent = text;
    if (parent) parent.appendChild(node);
    return node;
  }

  const TYPE_MARK = { path: '→', template: '◎', dispense: '⬚', pattern: '▦' };

  class Timeline {
    // onSelect(id or null), onFrame(frame), onPreview(id, frame) -> { valid, reason, from, to },
    // onMove(id, frame).
    constructor(host, callbacks = {}) {
      this.host = host;
      this.cb = callbacks;
      this.zoom = null; // px per frame set with Ctrl/⌘ + wheel; null fits the frames to the width
      this.data = null;
      this.key = '';
      this.px = 12;
      this.layout = new Map(); // clip id -> { x0, x1, y } once drawn
      this.drag = null;

      this.scroller = div('tl-scroll', host);
      this.canvas = div('tl-canvas', this.scroller);
      this.ruler = div('tl-ruler', this.canvas);
      this.body = div('tl-body', this.canvas);
      this.links = document.createElementNS(NS, 'svg');
      this.links.setAttribute('class', 'tl-links');
      this.canvas.appendChild(this.links);
      this.playhead = div('tl-playhead', this.canvas);
      this.ghost = div('tl-ghost', this.canvas);
      this.ghost.hidden = true;
      this.tip = div('tl-tip', host);
      this.tip.hidden = true;
      this.empty = div('tl-empty', host, 'Nothing drawn yet: draw a path, drop a template, paint, or press a reservoir button.');

      new ResizeObserver(() => this.render(true)).observe(host);

      // The ruler: click or drag to go to a frame.
      let scrubbing = false;
      this.ruler.addEventListener('pointerdown', (evt) => {
        if (evt.button !== 0) return;
        evt.preventDefault(); // no text selection while scrubbing
        scrubbing = true;
        this.ruler.setPointerCapture(evt.pointerId);
        this.cb.onFrame(this.frameAt(evt.clientX));
      });
      this.ruler.addEventListener('pointermove', (evt) => {
        if (scrubbing) this.cb.onFrame(this.frameAt(evt.clientX));
      });
      for (const type of ['pointerup', 'pointercancel']) this.ruler.addEventListener(type, () => (scrubbing = false));

      // Empty space in the tracks: go to that frame and let go of the selection.
      this.body.addEventListener('pointerdown', (evt) => {
        if (evt.button !== 0 || evt.target.closest('.tl-clip') || evt.target.closest('.tl-head')) return;
        evt.preventDefault();
        this.cb.onSelect(null);
        this.cb.onFrame(this.frameAt(evt.clientX));
      });

      this.scroller.addEventListener(
        'wheel',
        (evt) => {
          if (!(evt.ctrlKey || evt.metaKey)) return;
          evt.preventDefault();
          const factor = evt.deltaY < 0 ? 1.25 : 0.8;
          this.zoom = Math.min(MAX_PX, Math.max(MIN_PX, this.px * factor));
          this.render(true);
        },
        { passive: false }
      );
      this.scroller.addEventListener('dblclick', (evt) => {
        if (!evt.target.closest('.tl-clip') && !evt.target.closest('.tl-ruler')) {
          this.zoom = null; // double-click on empty space: fit again
          this.render(true);
        }
      });
    }

    // data: { frames, frame, selection, clips: [{ id, name, type, track, trackName, trackShort,
    //   colour, from, to, problem, broken, split, handIn, handOut, preds, dim }], bands } (trackShort:
    //   the droplet's short name, D1 ...; broken: it can't run; shown where it would start; dim:
    //   another tile's; bands: [{ id, name, from, to, open }] the process's tiles on this board)
    update(data) {
      const key = JSON.stringify([data.frames, data.selection, data.clips, data.bands]);
      this.data = data;
      if (key !== this.key) {
        this.key = key;
        this.render(false);
      }
      this.movePlayhead();
    }

    frameAt(clientX) {
      const rect = this.canvas.getBoundingClientRect();
      const f = Math.floor((clientX - rect.left - HEAD) / this.px) + 1;
      return Math.min(this.data ? this.data.frames : 1, Math.max(1, f));
    }

    xOf(frame) {
      return HEAD + (frame - 1) * this.px;
    }

    // Tracks in order of their first clip, each with its clips in rows so they don't overlap
    // (a clip may start in the frame where the one before it hands over).
    tracks() {
      const tracks = new Map();
      for (const c of this.data.clips) {
        if (!tracks.has(c.track)) tracks.set(c.track, { name: c.trackName, short: c.trackShort || '', colour: c.colour, clips: [], first: c.from });
        const t = tracks.get(c.track);
        t.clips.push(c);
        t.first = Math.min(t.first, c.from);
      }
      const list = [...tracks.values()].sort((a, b) => a.first - b.first);
      for (const t of list) {
        t.clips.sort((a, b) => a.from - b.from || a.to - b.to);
        t.rows = [];
        for (const c of t.clips) {
          let row = t.rows.findIndex((r) => r.end < c.from || (r.end === c.from && c.handIn));
          if (row < 0) {
            row = t.rows.length;
            t.rows.push({ end: 0 });
          }
          t.rows[row].end = c.to;
          c.row = row;
        }
      }
      return list;
    }

    render(resized) {
      if (!this.data) return;
      const { clips, frames, selection } = this.data;
      this.empty.hidden = clips.length > 0;
      const width = this.scroller.clientWidth;
      const fit = (width - HEAD - 12) / frames;
      this.px = Math.min(MAX_PX, Math.max(MIN_PX, this.zoom || fit));
      const total = HEAD + frames * this.px + 12;
      this.canvas.style.width = `${Math.max(width, total)}px`;

      // Ruler: frame numbers at round intervals that don't crowd.
      this.ruler.replaceChildren();
      const every = [1, 2, 5, 10, 20, 25, 50].find((n) => n * this.px >= 28) || 50;
      for (let f = 1; f <= frames; f++) {
        if (f !== 1 && f % every) continue;
        const tick = div('tl-tick', this.ruler, String(f));
        tick.style.left = `${this.xOf(f) + this.px / 2}px`;
      }

      this.body.replaceChildren();
      this.layout.clear();
      let y = 0;
      // The process's tiles on this board: a band over each one's frames; a click opens it.
      if (this.data.bands && this.data.bands.length) {
        const row = div('tl-bands', this.body);
        row.style.height = `${BANDS}px`;
        div('tl-head tl-bands-head', row, 'Steps');
        for (const b of this.data.bands) {
          const band = div(`tl-band${b.open ? ' open' : ''}`, row, b.name);
          band.style.left = `${this.xOf(b.from)}px`;
          band.style.width = `${Math.max(14, (b.to - b.from + 1) * this.px - 2)}px`;
          band.title = `${b.name}: frames ${b.from}–${b.to}${b.open ? '' : ' (click to open it)'}`;
          band.addEventListener('pointerdown', (evt) => {
            evt.stopPropagation();
            if (!b.open && this.cb.onTile) this.cb.onTile(b.id);
          });
        }
        y += BANDS;
      }
      for (const t of this.tracks()) {
        const height = Math.max(1, t.rows.length) * LANE;
        const track = div('tl-track', this.body);
        track.style.height = `${height}px`;
        const head = div('tl-head', track);
        head.style.setProperty('--c', t.colour);
        head.title = t.short && t.short !== t.name ? `${t.name} (${t.short})` : t.name;
        div('tl-chip', head);
        // The short name (D1 ...) first, as merged droplets are named by it, then the full name.
        if (t.short && t.short !== t.name) div('tl-short', head, t.short);
        div('tl-name', head, t.name);
        for (const c of t.clips) {
          const x0 = this.xOf(c.from) + (c.handIn ? this.px / 2 : 0);
          const x1 = this.xOf(c.to) + this.px - (c.handOut ? this.px / 2 : 0);
          const clip = div(`tl-clip ${c.type}`, track);
          clip.dataset.id = c.id;
          clip.classList.toggle('selected', c.id === selection);
          clip.classList.toggle('problem', Boolean(c.problem));
          clip.classList.toggle('broken', Boolean(c.broken));
          clip.classList.toggle('split', Boolean(c.split));
          clip.classList.toggle('dim', Boolean(c.dim));
          clip.style.setProperty('--c', c.colour);
          clip.style.left = `${x0}px`;
          clip.style.width = `${Math.max(4, x1 - x0 - 1)}px`;
          clip.style.top = `${c.row * LANE + 3}px`;
          const frameText = c.from === c.to ? `frame ${c.from}` : `frames ${c.from}–${c.to}`;
          clip.title = `${c.name} (${frameText})${c.problem ? `\n${c.problem}` : ''}`;
          div('tl-mark', clip, TYPE_MARK[c.type] || '?');
          div('tl-label', clip, c.name);
          const top = y + c.row * LANE + 3;
          this.layout.set(c.id, { x0, x1, y: y + c.row * LANE + LANE / 2 + 1, top, bottom: top + CLIP });
          this.wireClip(clip, c);
        }
        y += height;
      }
      const height = RULER + y;
      this.canvas.style.height = `${height}px`;
      this.drawLinks(y);
      this.movePlayhead(resized);
    }

    // Links between droplets: from the end of each action an action follows, when they aren't in
    // the same row of the same track (there the clips meet anyway), a curve in the colour of the
    // droplet coming in, with an arrow into the top or bottom of the clip near its start. Where
    // droplets meet, their arrows point into the same clip.
    drawLinks(height) {
      const svg = this.links;
      svg.replaceChildren();
      svg.setAttribute('width', this.canvas.style.width);
      svg.setAttribute('height', height);
      svg.style.top = `${RULER}px`;
      const colours = new Map(this.data.clips.map((c) => [c.id, c.colour]));
      const add = (tag, attrs) => {
        const node = document.createElementNS(NS, tag);
        for (const k of Object.keys(attrs)) node.setAttribute(k, attrs[k]);
        svg.appendChild(node);
        return node;
      };
      for (const c of this.data.clips) {
        const to = this.layout.get(c.id);
        const preds = (c.preds || []).filter((id) => {
          const from = this.layout.get(id);
          return from && to && Math.abs(from.y - to.y) >= 2;
        });
        for (const id of preds) {
          const from = this.layout.get(id);
          const down = to.y > from.y; // coming from a track above
          // Side by side where several come in from the same side.
          const same = preds.filter((p) => this.layout.get(p).y > to.y !== down);
          const x = Math.min(to.x0 + 7 + same.indexOf(id) * 9, Math.max(to.x0 + 3, to.x1 - 4));
          const tip = down ? to.top : to.bottom;
          const base = tip + (down ? -ARROW : ARROW);
          const bend = Math.max(8, Math.abs(x - from.x1) / 2);
          const fall = Math.max(6, Math.abs(base - from.y) / 2) * (down ? 1 : -1);
          const colour = colours.get(id) || '#777';
          add('path', { class: 'tl-link', d: `M${from.x1},${from.y} C${from.x1 + bend},${from.y} ${x},${base - fall} ${x},${base}`, style: `stroke: ${colour}` });
          add('path', { class: 'tl-arrow', d: `M${x},${tip} L${x - 4.5},${base} L${x + 4.5},${base} Z`, style: `fill: ${colour}` });
        }
      }
    }

    movePlayhead(recentre = false) {
      if (!this.data) return;
      const x = this.xOf(this.data.frame) + this.px / 2;
      this.playhead.style.left = `${x}px`;
      this.playhead.style.height = this.canvas.style.height;
      const view = this.scroller;
      const left = view.scrollLeft + HEAD;
      if (recentre || x < left || x > view.scrollLeft + view.clientWidth - 8) {
        if (x < left || x > view.scrollLeft + view.clientWidth - 8) view.scrollLeft = Math.max(0, x - (view.clientWidth + HEAD) / 2);
      }
    }

    // A clip: click selects, double-click goes to its first frame, drag moves it in time (the
    // ghost shows where it would go, red where it can't).
    wireClip(node, c) {
      node.addEventListener('pointerdown', (evt) => {
        if (evt.button !== 0) return;
        evt.stopPropagation();
        node.setPointerCapture(evt.pointerId);
        this.drag = { id: c.id, x0: evt.clientX, from: c.from, df: 0, result: null };
      });
      node.addEventListener('pointermove', (evt) => {
        const d = this.drag;
        if (!d || d.id !== c.id) return;
        const df = Math.round((evt.clientX - d.x0) / this.px);
        if (df === d.df) return;
        d.df = df;
        if (!df) {
          this.ghost.hidden = true;
          this.tip.hidden = true;
          return;
        }
        d.result = this.cb.onPreview(c.id, d.from + df);
        this.showGhost(c, d.result, evt);
      });
      const finish = (apply) => {
        const d = this.drag;
        if (!d || d.id !== c.id) return;
        this.drag = null;
        this.ghost.hidden = true;
        this.tip.hidden = true;
        if (!apply) return;
        if (d.df) this.cb.onMove(c.id, d.from + d.df);
        else this.cb.onSelect(c.id);
      };
      node.addEventListener('pointerup', () => finish(true));
      node.addEventListener('pointercancel', () => finish(false));
      node.addEventListener('dblclick', (evt) => {
        evt.stopPropagation();
        this.cb.onFrame(c.from);
      });
    }

    showGhost(c, result, evt) {
      const at = this.layout.get(c.id);
      if (!at) return;
      const from = result && result.from ? result.from : c.from + this.drag.df;
      const to = result && result.to ? result.to : c.to + this.drag.df;
      this.ghost.hidden = false;
      this.ghost.classList.toggle('bad', !(result && result.valid));
      this.ghost.style.left = `${this.xOf(from)}px`;
      this.ghost.style.width = `${Math.max(4, (to - from + 1) * this.px - 1)}px`;
      this.ghost.style.top = `${RULER + at.y - LANE / 2 + 2}px`;
      this.tip.hidden = false;
      this.tip.textContent = result && result.valid ? `frames ${from}–${to}` : (result && result.reason) || "can't go there";
      this.tip.classList.toggle('bad', !(result && result.valid));
      const host = this.host.getBoundingClientRect();
      this.tip.style.left = `${Math.min(host.width - 220, Math.max(0, evt.clientX - host.left + 12))}px`;
      this.tip.style.top = `${Math.max(0, evt.clientY - host.top - 30)}px`;
    }
  }

  (root.OD = root.OD || {}).timeline = { Timeline };
})(globalThis);
