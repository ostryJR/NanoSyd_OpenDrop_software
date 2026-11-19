/* The process view's side of things: Properties for the selected tile (its settings, where its
 * work is on the board, its problems), the run log, and the question a run asks at a Measure or
 * Ask tile. Plain DOM; changes go through the editor, so they can be undone. */
(function (root) {
  'use strict';

  const OD = root.OD;
  const P = OD.process;
  const { icon, RESERVOIRS } = OD.processView;
  const OPS = [['<', '<'], ['<=', '≤'], ['>', '>'], ['>=', '≥'], ['=', '='], ['!=', '≠']];
  const seconds = (ms) => (ms >= 60000 ? `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s` : `${Math.round(ms / 100) / 10} s`);

  function node(tag, attrs = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    }
    for (const kid of kids) if (kid !== null && kid !== undefined) n.append(kid);
    return n;
  }

  class ProcessPanel {
    // host: where the tile's properties go. app: { editor, analysis(), status(text, kind),
    // changed(), open(id), place(id), runner }
    constructor(host, app) {
      this.host = host;
      this.app = app;
      this.ed = app.editor;
      this.tile = null;
      this.key = '';
    }

    show(tileId) {
      this.tile = tileId;
      this.render();
    }

    // A field: a label with an input; `apply(value)` runs when it is left or Enter is pressed.
    field(label, input, apply) {
      const done = () => {
        apply(input.type === 'checkbox' ? input.checked : input.value);
        this.key = '';
        this.app.changed();
      };
      input.addEventListener('change', done);
      input.addEventListener('keydown', (evt) => {
        if (evt.key === 'Enter' || evt.key === 'Escape') input.blur();
        evt.stopPropagation();
      });
      return node('label', { class: 'field' }, label, input);
    }

    text(value, attrs = {}) {
      const input = node('input', { type: 'text', autocomplete: 'off', ...attrs });
      input.value = value === undefined || value === null ? '' : String(value);
      return input;
    }

    number(value, attrs = {}) {
      const input = node('input', { type: 'number', step: 'any', ...attrs });
      input.value = value === undefined || value === null ? '' : String(value);
      return input;
    }

    select(options, value) {
      const s = node('select');
      for (const [v, label] of options) s.add(new Option(label, v));
      s.value = value;
      return s;
    }

    // Ask and Measure: whether a run waiting here shows it on the device's screen, and with what.
    screenFields(h, t) {
      const H = OD.heat;
      const box = node('input', { type: 'checkbox' });
      box.checked = Boolean(t.screen);
      box.addEventListener('change', () => {
        // Switched on: the screen text starts as the question or prompt, cut to what fits.
        const fields = box.checked && !t.screenText ? { screen: true, screenText: H.cleanText(P.screenText({ ...t, screen: true, screenText: '' })) } : { screen: box.checked };
        this.set(fields, box.checked ? `${t.name}: shown on the device's screen while a run waits here` : `${t.name}: not shown on the device`);
        this.key = '';
        this.app.changed();
      });
      h.append(node('label', { class: 'check' }, box, 'Show it on the device’s screen'));
      if (!t.screen) return;
      const input = this.text(t.screenText || '', { maxlength: H.MESSAGE_LENGTH });
      h.append(this.field(`Screen text (up to ${H.MESSAGE_LENGTH} characters)`, input, (v) => {
        const text = H.cleanText(v);
        if (!text) {
          this.app.status('The screen text can’t be empty: untick “Show it on the device’s screen” instead', 'warn');
          input.value = t.screenText || '';
          return;
        }
        this.set({ screenText: text }, 'Screen text set');
      }), counter(input, H.MESSAGE_LENGTH));
      h.append(node('p', { class: 'hint', text: 'While a run waits here, the OpenDrop’s screen (custom firmware) shows this; afterwards it goes back to what a Message tile set.' }));
    }

    set(fields, text) {
      if (this.ed.tileSettings(this.tile, fields) && text) this.app.status(text);
    }

    render() {
      const p = this.ed.doc.process;
      const t = p && this.tile ? P.tileById(p, this.tile) : null;
      const info = t ? this.app.analysis() : null;
      const key = JSON.stringify([t, info && t ? info.tile.get(t.id) : null, this.ed.revision, this.ed.readOnly]);
      if (key === this.key) return;
      if (this.host.contains(document.activeElement) && document.activeElement !== document.body) return; // don't redraw under typing
      this.key = key;
      this.host.replaceChildren();
      if (!t) {
        this.host.append(node('p', { class: 'hint', text: 'Click a tile to see and change it here. Drag tiles in from the left; drag from a tile’s dot at the bottom to the next tile to connect them. Double-click a step to draw its work on the board.' }));
        return;
      }
      const kind = P.KINDS[t.kind];
      this.host.append(node('h3', { class: 'with-icon' }, icon(t.kind), kind.name));
      this.host.append(node('p', { class: 'hint about', text: kind.about }));
      if (!['start', 'end', 'parallel', 'join', 'decision'].includes(t.kind)) {
        this.host.append(this.field('Name', this.text(t.name, { maxlength: 60 }), (v) => this.set({ name: String(v).trim() || kind.name }, 'Renamed')));
      }
      this.settings(t, p);

      if (P.hasWork(t)) {
        const me = info.tile.get(t.id);
        const where = !me.placed ? 'Not placed on the board yet.' : me.to ? `On the board: frames ${me.from}–${me.to} of its stretch, ${seconds(me.ms)}.` : 'On the board, but it doesn’t run.';
        this.host.append(node('p', { class: me.placed ? 'info ok' : 'info' }, where));
        const row = node('div', { class: 'row' });
        if (t.kind !== 'step') row.append(node('button', { type: 'button', class: me.placed ? '' : 'primary', text: me.placed ? 'Place again' : 'Place on the board', onclick: () => this.app.place(t.id) }));
        row.append(node('button', { type: 'button', text: 'Open on the board', 'data-look': '', onclick: () => this.app.open(t.id) }));
        this.host.append(row);
      }

      const problems = [...P.check(p).filter((i) => i.tile === t.id).map((i) => i.text), ...(info.tile.get(t.id) ? info.tile.get(t.id).problems : [])];
      if (problems.length) this.host.append(node('ul', { class: 'problems' }, ...problems.map((x) => node('li', { text: x }))));

      if (t.kind !== 'start' || p.tiles.filter((x) => x.kind === 'start').length > 1) {
        this.host.append(node('div', { class: 'maker-buttons' }, node('button', {
          type: 'button',
          text: 'Delete tile',
          onclick: (evt) => {
            evt.currentTarget.blur();
            const count = this.ed.doc.actions.filter((a) => a.tile === t.id).length;
            if (this.ed.removeTile(t.id)) this.app.status(`Deleted ${t.name || kind.name}${count ? ` and its ${count} action${count === 1 ? '' : 's'} on the board` : ''} (undo brings it back)`);
            this.tile = null;
            this.app.changed();
          },
        })));
      }

      // While a run is going nothing can be changed: only looking at the board is left.
      const why = this.ed.readOnly;
      if (why) {
        this.host.insertBefore(node('p', { class: 'info warn', text: why }), this.host.children[2] || null);
        for (const el of this.host.querySelectorAll('input, select, textarea, button')) {
          if ('look' in el.dataset) continue;
          el.disabled = true;
          el.title = why;
        }
      }
    }

    // The settings of each kind of tile.
    settings(t, p) {
      const h = this.host;
      switch (t.kind) {
        case 'dispense': {
          h.append(this.field('Reservoir', this.select(Object.entries(RESERVOIRS), t.reservoir || 'reservoirLeftTop'), (v) => this.set({ reservoir: v }, `${t.name} dispenses from the ${RESERVOIRS[v]} reservoir`)));
          // The droplet it makes: named here, carried down the process (and the same on the board).
          const placed = this.ed.doc.actions.some((a) => a.tile === t.id && a.type === 'dispense');
          const input = this.text(t.droplet, { maxlength: 60, placeholder: this.ed.freeDroplet(), list: 'droplet-names' });
          const short = OD.project.shortDroplet(t.droplet || '');
          const label = node('span', {}, 'Droplet ', short && short !== t.droplet ? node('span', { class: 'short-name', text: `· short ${short}` }) : null);
          h.append(this.field(label, input, (v) => {
            const name = String(v).trim();
            if (!name && placed) return; // a placed droplet keeps a name
            this.set({ droplet: name }, name ? `${t.name} makes the droplet “${name}”${placed ? ', renamed down the process' : ''}` : 'Its droplet gets a name when it is placed');
          }));
          h.append(node('p', { class: 'hint', text: placed ? 'Renaming it renames the droplet everywhere after this, on the board too.' : `The name of the droplet it makes; empty, it will be “${this.ed.freeDroplet()}”.` }));
          break;
        }
        case 'mix': {
          const params = t.params || { kind: 'circle', size: 2, rounds: 3 };
          const apply = (change, text) => {
            if (this.ed.setTileParams(t.id, change)) this.app.status(text);
            else this.app.status(this.ed.notice || 'That doesn’t fit there', 'warn');
            this.ed.notice = null;
          };
          h.append(this.field('Kind', this.select([['circle', 'Circle'], ['backforth', 'Back and forth'], ['splitmerge', 'Split & merge']], params.kind), (v) => apply({ kind: v }, `${t.name}: ${v === 'circle' ? 'circle' : v === 'backforth' ? 'back and forth' : 'split & merge'}`)));
          if (params.kind === 'circle') {
            h.append(this.field('Size', this.select([['2', '2 × 2'], ['3', '3 × 3']], String(params.size || 2)), (v) => apply({ size: Number(v) }, `${t.name}: ${v} × ${v}`)));
            h.append(this.field('Goes round', this.select([['cw', '↻ clockwise'], ['ccw', '↺ counter-clockwise']], params.dir || 'cw'), (v) => apply({ dir: v }, `${t.name} goes round ${v === 'ccw' ? 'counter-clockwise' : 'clockwise'}`)));
          }
          if (params.kind === 'backforth') h.append(this.field('Over (electrodes)', this.number(params.length || 4, { min: 2, max: 6, step: 1 }), (v) => apply({ length: Math.round(Number(v)) }, `${t.name}: over ${v}`)));
          h.append(this.field('Rounds', this.number(params.rounds || 3, { min: 1, max: 20, step: 1 }), (v) => apply({ rounds: Math.round(Number(v)) }, `${t.name}: ${v} rounds`)));
          h.append(node('p', { class: 'hint', text: 'It stays one droplet. To put two droplets together, use a Merge.' }));
          break;
        }
        case 'merge': {
          const ins = p.links.filter((l) => l.to === t.id).length;
          h.append(node('p', { class: 'hint', text: ins > 1
            ? `${ins} arrows bring its droplets in: it waits for all of them, then puts the two droplets together. No Wait for all is needed before it.`
            : 'Its arrows bring the droplets in: draw one from the end of each droplet’s lane, and it waits for all of them. If both droplets come the same way, one arrow is enough.' }));
          break;
        }
        case 'wait':
          h.append(this.field('Wait (s)', this.number(t.seconds, { min: 0.01, max: 86400 }), (v) => {
            const s = Number(v);
            if (s > 0) this.set({ seconds: s }, `${t.name}: ${s} s`);
          }));
          break;
        case 'temperature': {
          const H = OD.heat;
          const targets = H.cleanTargets(t.targets);
          targets.forEach((v, i) => {
            const input = this.number(v === null ? '' : v, { min: H.TEMP_RANGE[0], max: H.TEMP_RANGE[1], step: 1, placeholder: '—' });
            h.append(this.field(`T${i + 1} (°C)`, input, (x) => {
              const next = targets.slice();
              next[i] = String(x).trim() === '' ? null : H.clampTemp(Number(x));
              if (!next.some((y) => y !== null)) {
                this.app.status('Set at least one heater', 'warn');
                return;
              }
              this.set({ targets: next }, `${t.name}: ${H.targetsText(next)}`);
            }));
          });
          const wait = node('input', { type: 'checkbox' });
          wait.checked = Boolean(t.wait);
          // Only the box and its words switch it, not the empty space beside them.
          wait.addEventListener('change', () => {
            this.set({ wait: wait.checked }, wait.checked ? `${t.name} waits until the heaters get there` : `${t.name} doesn't wait`);
            this.key = '';
            this.app.changed();
          });
          h.append(node('label', { class: 'check' }, wait, 'Wait until the heaters get there'));
          if (t.wait) h.append(this.field('Close enough within (°C)', this.number(t.tolerance || H.DEFAULT_TOLERANCE, { min: 0.1, max: 20, step: 'any' }), (x) => {
            if (Number(x) > 0) this.set({ tolerance: H.cleanTolerance(Number(x)) }, `${t.name}: within ${H.cleanTolerance(Number(x))} °C`);
          }));
          h.append(node('p', { class: 'hint', text: 'Empty heaters stay as they were. Waiting, a run on the OpenDrop goes on once the readings get there; without one, the wait is estimated from the heating rates in the Temperature view.' }));
          break;
        }
        case 'message': {
          const H = OD.heat;
          const input = this.text(t.text, { maxlength: H.MESSAGE_LENGTH, placeholder: 'empty: clears the screen' });
          h.append(this.field(`Text (up to ${H.MESSAGE_LENGTH} characters)`, input, (v) => {
            const text = H.cleanText(v);
            this.set({ text }, text ? `${t.name}: “${text}” on the device's screen` : `${t.name}: clears the device's screen`);
          }), counter(input, H.MESSAGE_LENGTH));
          h.append(node('p', { class: 'hint', text: 'Shown on the OpenDrop’s screen (custom firmware, OpenDropVCustom) from here until another Message tile, while live or in a run. Plain letters: accents are dropped.' }));
          break;
        }
        case 'magnet':
          h.append(this.field('Magnet', this.select([['1', 'Magnet 1'], ['2', 'Magnet 2']], String(t.magnet === 2 ? 2 : 1)), (v) => this.set({ magnet: Number(v) }, `${t.name}: magnet ${v}`)));
          h.append(this.field('Switch it', this.select([['on', 'on'], ['off', 'off']], t.on === false ? 'off' : 'on'), (v) => this.set({ on: v === 'on' }, `${t.name}: ${v}`)));
          h.append(node('p', { class: 'hint', text: 'It stays that way through the steps after it, until another Magnet tile.' }));
          break;
        case 'measure':
          h.append(this.field('Value', this.text(t.value, { maxlength: 30 }), (v) => this.set({ value: clean(v) || t.value }, `${t.name} gives ${clean(v) || t.value}`)));
          h.append(this.field('Unit', this.text(t.unit, { maxlength: 12 }), (v) => this.set({ unit: String(v).trim() }, 'Unit set')));
          {
            const source = this.select([['typed', 'typed in by you'], ['device', 'an instrument (later)']], 'typed');
            source.options[1].disabled = true;
            h.append(this.field('Get it by', source, () => {}));
          }
          h.append(this.field('Ask with', this.text(t.prompt, { maxlength: 120, placeholder: `Measure ${t.value || 'it'}${t.unit ? ` (${t.unit})` : ''} and type it in.` }), (v) => this.set({ prompt: String(v).trim() }, 'Prompt set')));
          h.append(node('p', { class: 'hint', text: 'A run stops here and asks you to type the value in, with this text (empty: the default shown). Reading it from a connected instrument comes later.' }));
          this.screenFields(h, t);
          break;
        case 'ask':
          h.append(this.field('Question', this.text(t.question, { maxlength: 120 }), (v) => this.set({ question: String(v).trim() || 'Go on?' }, 'Question set')));
          h.append(this.field('Value', this.text(t.value, { maxlength: 30 }), (v) => this.set({ value: clean(v) || t.value }, `${t.name} gives ${clean(v) || t.value}`)));
          this.screenFields(h, t);
          break;
        case 'decision': {
          const sources = p.tiles.filter((x) => (x.kind === 'measure' || x.kind === 'ask') && x.value);
          const values = [...new Set(sources.map((x) => x.value))];
          const yesno = sources.some((x) => x.value === t.value && x.kind === 'ask');
          h.append(this.field('Value', this.select([['', '— choose —'], ...values.map((v) => [v, v])], t.value || ''), (v) => {
            const isYesNo = sources.some((x) => x.value === v && x.kind === 'ask');
            this.set(isYesNo ? { value: v, op: 'is', than: 'yes' } : { value: v, op: t.op === 'is' ? '<' : t.op || '<', than: t.op === 'is' ? 0 : t.than }, `Decides by ${v}`);
          }));
          if (yesno) h.append(this.field('Is', this.select([['yes', 'yes'], ['no', 'no']], t.than === 'no' ? 'no' : 'yes'), (v) => this.set({ op: 'is', than: v }, `If ${t.value} is ${v}`)));
          else {
            h.append(this.field('Compared', this.select(OPS, t.op && t.op !== 'is' ? t.op : '<'), (v) => this.set({ op: v }, 'Comparison set')));
            h.append(this.field('With', this.number(t.than, {}), (v) => this.set({ than: Number(v) || 0 }, 'Number set')));
          }
          h.append(node('p', { class: 'info ok', text: `If ${P.conditionText(t, p)}: the yes arrow, otherwise no.` }));
          if (!values.length) h.append(node('p', { class: 'hint', text: 'Add a Measure or Ask tile before it: it gives the value this decides by.' }));
          break;
        }
        case 'repeat':
          h.append(this.field('Times', this.number(t.times, { min: 1, max: 1000, step: 1 }), (v) => this.set({ times: Math.max(1, Math.round(Number(v)) || 1) }, `Repeats ${v} times`)));
          h.append(node('p', { class: 'hint', text: 'Its “again” arrow goes to what is repeated; the last tile of that leads back here. “done” goes on.' }));
          break;
        case 'parallel':
          h.append(this.field('Lanes', this.number(P.lanesOf(t), { min: 2, max: P.MAX_LANES, step: 1 }), (v) => this.set({ lanes: Math.round(Number(v)) }, `${v} lanes`)));
          h.append(node('p', { class: 'hint', text: 'Its lanes run at the same time, on one board. End them in a Wait for all (the droplets stay apart) or in a Merge (two droplets become one).' }));
          break;
        case 'join':
          h.append(node('p', { class: 'hint', text: 'The run goes on once every lane coming in has finished. To put two droplets together instead, end their lanes in a Merge.' }));
          break;
        default:
          break;
      }
    }
  }

  // "n / max" under a text field, kept up to date as you type.
  function counter(input, max) {
    const out = node('p', { class: 'hint count' });
    const update = () => (out.textContent = `${input.value.length} / ${max}`);
    input.addEventListener('input', update);
    update();
    return out;
  }

  const clean = (v) => String(v).trim().replace(/\s+/g, '_').replace(/[^\w.-]/g, '').slice(0, 30);

  // The question a run asks: a Measure's value (typed in), an Ask's yes/no question, or a value
  // a decision needs that wasn't measured. Resolves with the answer, or null to stop the run.
  function ask(host, step, process) {
    const t = step.tile;
    return new Promise((resolve) => {
      const box = node('div', { class: 'run-ask', role: 'dialog', 'aria-modal': 'true' });
      let keys = null; // the yes/no keys, while they are listened for
      const finish = (value) => {
        if (keys) document.removeEventListener('keydown', keys, true);
        box.remove();
        resolve(value);
      };
      const name = step.missing || t.value;
      const unit = (process.tiles.find((x) => x.kind === 'measure' && x.value === name) || {}).unit || '';
      box.append(t.kind === 'decision' ? node('h3', { text: `${name}?` }) : node('h3', { class: 'with-icon' }, icon(t.kind), t.name || P.KINDS[t.kind].name));
      if (t.kind === 'ask') {
        box.append(node('p', { text: t.question || 'Go on?' }));
        // Keys too: 1 or , for yes, 2 or . for no (side by side, like the buttons).
        const key = (...k) => node('span', { class: 'keys' }, ...k.map((x) => node('kbd', { text: x })));
        box.append(node('div', { class: 'row' },
          node('button', { type: 'button', class: 'primary', title: 'Yes (1 or ,)', onclick: () => finish(true) }, 'Yes ', key('1', ',')),
          node('button', { type: 'button', title: 'No (2 or .)', onclick: () => finish(false) }, 'No ', key('2', '.'))));
        keys = (evt) => {
          if (evt.metaKey || evt.ctrlKey || evt.altKey) return;
          const answer = evt.key === '1' || evt.key === ',' ? true : evt.key === '2' || evt.key === '.' ? false : null;
          if (answer === null) return;
          evt.preventDefault();
          evt.stopPropagation(); // not a shortcut on the board as well
          finish(answer);
        };
        document.addEventListener('keydown', keys, true);
      } else {
        box.append(node('p', { text: t.kind === 'decision' ? `The decision needs ${name}, which wasn't measured on the way here.` : t.prompt || `Measure ${name}${unit ? ` (${unit})` : ''} and type it in.` }));
        const input = node('input', { type: 'number', step: 'any', 'aria-label': name });
        const go = () => {
          if (input.value.trim() === '' || !Number.isFinite(Number(input.value))) {
            input.focus();
            return;
          }
          finish(Number(input.value));
        };
        input.addEventListener('keydown', (evt) => {
          evt.stopPropagation();
          if (evt.key === 'Enter') go();
        });
        box.append(node('div', { class: 'row' }, node('label', { class: 'inline' }, `${name} = `, input, unit ? ` ${unit}` : ''), node('button', { type: 'button', class: 'primary', text: 'Go on', onclick: go })));
        setTimeout(() => input.focus(), 0);
      }
      box.append(node('div', { class: 'row end' }, node('button', { type: 'button', text: 'Stop the run', onclick: () => finish(null) })));
      host.appendChild(box);
    });
  }

  // The run log: what was played, measured and decided, with times.
  function renderLog(host, state) {
    host.replaceChildren();
    if (!state) {
      host.hidden = true;
      return;
    }
    host.hidden = false;
    const mmss = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;
    // The heading folds the log away (kept folded through re-renders and reloads).
    const folded = localStorage.getItem('od.runLogFolded') === '1';
    host.classList.toggle('folded', folded);
    const title = state.done ? (state.done === 'end' ? 'Run: done' : state.done === 'stuck' ? 'Run: stopped, stuck' : 'Run: stopped') : state.paused ? 'Run: paused' : 'Run';
    const head = node('h4', { text: `${folded ? '▸' : '▾'} ${title}` });
    head.title = folded ? 'Show the run log' : 'Hide the run log';
    head.addEventListener('click', () => {
      localStorage.setItem('od.runLogFolded', folded ? '0' : '1');
      renderLog(host, state);
    });
    host.append(head);
    if (folded) return;
    const list = node('ol');
    for (const e of state.log.slice(-60)) list.append(node('li', {}, node('span', { class: 'when', text: mmss(e.ms) }), ` ${e.text}`));
    host.append(list);
    list.scrollTop = list.scrollHeight;
  }

  OD.processPanel = { ProcessPanel, ask, renderLog };
})(globalThis);
