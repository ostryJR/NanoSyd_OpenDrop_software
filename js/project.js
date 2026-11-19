/* The project file (*.odproj.json): what was drawn, kept as named actions, plus the layout, the
 * default frame time, copies of the templates the actions use, and the process (tiles and
 * arrows; each action names the tile it belongs to). Reading checks and cleans a file; parts this
 * version doesn't know are kept as they are and written back. No DOM here. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./model.js'), require('./templates.js'), require('./compile.js'), require('./process.js'), require('./heat.js'), require('./device.js'));
  } else {
    (root.OD = root.OD || {}).project = factory(root.OD.model, root.OD.templates, root.OD.compile, root.OD.process, root.OD.heat, root.OD.device);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (model, templates, compiler, processes, heat, device) {
  'use strict';

  const { CELLS, MAX_FRAMES, DEFAULT_FRAME_TIME, clampTime } = model;
  const { RESERVOIR_STEPS } = compiler;

  // A project's high voltage, cleaned (the device's limits): null when nothing is set.
  function cleanHV(raw) {
    const hv = device.cleanHV(raw);
    return hv.volts === null && hv.hz === null && hv.mode === null ? null : hv;
  }

  const TAG = 'openDropGeneratorProject';
  const VERSION = 1;
  const EXTENSION = '.odproj.json';
  const TYPE_NAMES = { path: 'Path', template: 'Template', dispense: 'Dispense', pattern: 'Pattern', wait: 'Wait', temp: 'Temperature', magnet: 'Magnet' };
  const MAX_WAIT = 24 * 3600 * 1000; // a wait (hold) may last up to a day
  // Key order in saved files; other keys follow in the order they came.
  const KEY_ORDER = ['id', 'type', 'name', 'droplet', 'tile', 'start', 'after', 'delay', 'points', 'template', 'at', 'turns',
    'reservoir', 'frames', 'duration', 'targets', 'wait', 'tolerance', 'magnet', 'on'];
  const TILE_ORDER = ['id', 'kind', 'name', 'x', 'y'];

  function newProject({ layout = 'electrodes', frameTime = DEFAULT_FRAME_TIME } = {}) {
    return { [TAG]: VERSION, layout, frameTime, templates: {}, actions: [] };
  }

  const isProject = (data) => Boolean(data) && typeof data === 'object' && !Array.isArray(data) && TAG in data;

  const isElectrode = (e) => Number.isInteger(e) && e >= 0 && e < CELLS;
  const goodTime = (ms) => typeof ms === 'number' && Number.isFinite(ms) && ms > 0;

  function cleanPoint(p) {
    const raw = typeof p === 'number' ? { e: p } : p;
    if (!raw || typeof raw !== 'object' || !isElectrode(raw.e)) return null;
    const point = { ...raw };
    delete point.wait; // waits on a path's points are gone: a Wait does that
    return point;
  }

  // Step times of older files (time per step, frames' own times, waits on a path's points, letting
  // the others keep moving): gone, every step lasts the default frame time. Whether `a` had any.
  function hadStepTimes(a) {
    const points = Array.isArray(a.points) && a.points.some((p) => p && typeof p === 'object' && goodTime(p.wait));
    const had = goodTime(a.stepTime) || a.split === true || (Array.isArray(a.times) && a.times.some(goodTime)) || points;
    delete a.stepTime;
    delete a.split;
    delete a.times;
    return had;
  }

  // One action from a file, checked; null (with a warning) if it can't be used. Its id is
  // settled afterwards, when all the ids are known.
  function cleanAction(raw, n, warn) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof raw.type !== 'string' || !raw.type) {
      warn(`action ${n} has no type and was left out`);
      return null;
    }
    const a = { ...raw };
    a.id = typeof a.id === 'string' ? a.id.trim() : typeof a.id === 'number' ? String(a.id) : '';
    a.name = typeof a.name === 'string' && a.name.trim() ? a.name.trim().slice(0, 80) : TYPE_NAMES[a.type] || a.type;
    a.droplet = typeof a.droplet === 'string' ? a.droplet.trim().slice(0, 60) : '';
    if (typeof a.tile !== 'string' || !a.tile) delete a.tile;

    if (Array.isArray(a.after)) {
      const list = [...new Set(a.after.map((id) => (typeof id === 'number' ? String(id) : id)).filter((id) => typeof id === 'string' && id))];
      if (list.length > 1) a.after = list;
      else if (list.length === 1) a.after = list[0];
      else delete a.after;
    }
    if (a.after !== undefined && a.after !== null) {
      if (typeof a.after === 'number') a.after = String(a.after);
      delete a.start;
      if (!(Number.isInteger(a.delay) && a.delay > 0 && a.delay <= MAX_FRAMES)) delete a.delay;
    } else {
      delete a.after;
      delete a.delay;
      if (!(Number.isInteger(a.start) && a.start >= 1 && a.start <= MAX_FRAMES)) {
        if (a.start !== undefined) warn(`“${a.name}” had an unusable start frame and now starts in frame 1`);
        a.start = 1;
      }
    }
    if (hadStepTimes(a)) warn.times = (warn.times || 0) + 1;

    switch (a.type) {
      case 'path': {
        const points = Array.isArray(a.points) ? a.points.map(cleanPoint).filter(Boolean) : [];
        if (!points.length) {
          warn(`the path “${a.name}” has no points and was left out`);
          return null;
        }
        a.points = points;
        break;
      }
      case 'template':
        if (typeof a.template !== 'string' || !isElectrode(a.at)) {
          warn(`the template “${a.name}” is incomplete and was left out`);
          return null;
        }
        a.turns = Number.isInteger(a.turns) ? ((a.turns % 4) + 4) % 4 : 0;
        break;
      case 'dispense':
        if (!RESERVOIR_STEPS[a.reservoir]) {
          warn(`the dispense “${a.name}” names no known reservoir and was left out`);
          return null;
        }
        break;
      case 'pattern': {
        const frames = Array.isArray(a.frames)
          ? a.frames.slice(0, MAX_FRAMES).map((cells) => (Array.isArray(cells) ? [...new Set(cells.filter(isElectrode))] : []))
          : [];
        if (!frames.length) {
          warn(`the pattern “${a.name}” has no frames and was left out`);
          return null;
        }
        a.frames = frames;
        break;
      }
      case 'wait':
        if (!goodTime(a.duration)) {
          warn(`the wait “${a.name}” has no time and was left out`);
          return null;
        }
        a.duration = Math.min(MAX_WAIT, Math.round(a.duration));
        break;
      case 'temp':
        a.targets = heat.cleanTargets(a.targets);
        if (!a.targets.some((t) => t !== null)) {
          warn(`the temperature “${a.name}” sets nothing and was left out`);
          return null;
        }
        if (a.wait === true) a.tolerance = heat.cleanTolerance(a.tolerance);
        else {
          delete a.wait;
          delete a.tolerance;
        }
        a.droplet = '';
        break;
      case 'magnet':
        a.magnet = a.magnet === 2 ? 2 : 1;
        a.on = a.on !== false;
        a.droplet = '';
        break;
      default:
        break; // kept as it is: a later version may know it
    }
    return a;
  }

  // The process from a file, checked: tiles of known kinds with ids of their own, and arrows
  // between them from ports their tiles have (one per port). Undefined if there is none.
  function cleanProcess(raw, warn) {
    if (raw === undefined) return undefined;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      warn('its process is unusable and was left out');
      return undefined;
    }
    const out = { ...raw, tiles: [], links: [] };
    const ids = new Set();
    for (const t of Array.isArray(raw.tiles) ? raw.tiles : []) {
      if (!t || typeof t !== 'object' || !processes.KINDS[t.kind] || typeof t.id !== 'string' || !t.id || ids.has(t.id)) {
        warn(`a tile of the process${t && t.kind ? ` (${t.kind})` : ''} is unusable and was left out`);
        continue;
      }
      ids.add(t.id);
      const tile = { ...t, x: Number.isFinite(t.x) ? Math.round(t.x) : 0, y: Number.isFinite(t.y) ? Math.round(t.y) : 0 };
      if (typeof tile.name !== 'string') delete tile.name;
      // Ask used to take a number too; that is a Measure now (typed in, its question as the prompt).
      if (tile.kind === 'ask' && tile.answer === 'number') {
        tile.kind = 'measure';
        tile.prompt = typeof tile.question === 'string' ? tile.question : '';
        tile.unit = '';
        tile.source = 'typed';
        if (tile.name === 'Ask') tile.name = 'Measure';
        delete tile.question;
      }
      if (tile.kind === 'ask' || tile.kind === 'measure') delete tile.answer;
      // The droplet a Dispense tile makes.
      if (tile.droplet !== undefined) {
        const ok = tile.kind === 'dispense' && typeof tile.droplet === 'string' && tile.droplet.trim();
        if (ok) tile.droplet = tile.droplet.trim().slice(0, 60);
        else {
          warn(`the droplet name of the tile “${tile.name || tile.id}” is unusable and was left out`);
          delete tile.droplet;
        }
      }
      out.tiles.push(tile);
    }
    const byId = new Map(out.tiles.map((t) => [t.id, t]));
    const used = new Set();
    for (const l of Array.isArray(raw.links) ? raw.links : []) {
      const from = l && byId.get(l.from);
      const to = l && byId.get(l.to);
      const port = l && (l.port || 'next');
      if (!from || !to || !processes.portsOf(from).includes(port) || !processes.takesInput(to) || used.has(`${l.from}|${port}`)) {
        warn('an arrow of the process is unusable and was left out');
        continue;
      }
      used.add(`${l.from}|${port}`);
      out.links.push({ from: l.from, port, to: l.to });
    }
    return out;
  }

  // Reads a project from its text (or parsed JSON). Returns { project, warnings }; throws if it
  // isn't a project file.
  function parse(input) {
    const data = typeof input === 'string' ? JSON.parse(input) : input;
    if (!isProject(data)) throw new Error('not an OpenDrop Generator project');
    const warnings = [];
    const warn = (text) => warnings.push(text);
    const version = Number.isInteger(data[TAG]) && data[TAG] > 0 ? data[TAG] : VERSION;
    if (version > VERSION) warn("it comes from a newer version of this app: parts this version doesn't know are kept but not shown");

    const project = { ...data, [TAG]: Math.max(version, VERSION) };
    project.layout = typeof data.layout === 'string' ? data.layout : 'electrodes';
    project.frameTime = goodTime(data.frameTime) ? clampTime(data.frameTime) : DEFAULT_FRAME_TIME;
    if (data.heatRates !== undefined) project.heatRates = heat.cleanRates(data.heatRates);
    // The high voltage the experiment uses (volts, hz, mode; null = the device's own), if set.
    delete project.hv;
    if (data.hv !== undefined) {
      const hv = cleanHV(data.hv);
      if (hv) project.hv = hv;
      else if (data.hv !== null) warn('its high-voltage settings are unusable and were left out');
    }

    project.templates = {};
    if (data.templates && typeof data.templates === 'object' && !Array.isArray(data.templates)) {
      for (const [key, raw] of Object.entries(data.templates)) {
        const t = templates.clean(raw);
        if (t) project.templates[key] = t;
        else warn(`the template ${key} in the file is unusable and was left out`);
      }
    }

    const flow = cleanProcess(data.process, warn);
    if (flow) project.process = flow;
    else delete project.process;

    const list = Array.isArray(data.actions) ? data.actions : [];
    project.actions = list.map((raw, i) => cleanAction(raw, i + 1, warn)).filter(Boolean);
    if (warn.times) warn(`${warn.times} action(s) had times of their own (time per step, frame times or waits on a path): every step now lasts the default frame time; add a Wait where it should pause`);
    // Every id is kept the first time it is used (links refer to it); missing and repeated ones
    // get new ids that clash with none of them.
    const seen = new Set();
    const unnamed = [];
    for (const a of project.actions) {
      if (a.id && !seen.has(a.id)) seen.add(a.id);
      else {
        if (a.id) warn(`two actions were called ${a.id}: the second one was renamed`);
        unnamed.push(a);
      }
    }
    let n = 1;
    for (const a of unnamed) {
      while (seen.has(`a${n}`)) n++;
      a.id = `a${n}`;
      seen.add(a.id);
    }
    const unknown = project.actions.filter((a) => !TYPE_NAMES[a.type]).length;
    if (unknown) warn(`${unknown} action(s) of a kind this version doesn't know are kept but not shown`);
    return { project, warnings };
  }

  function ordered(a) {
    const out = {};
    for (const k of KEY_ORDER) if (a[k] !== undefined) out[k] = a[k];
    for (const k of Object.keys(a)) if (!(k in out) && a[k] !== undefined) out[k] = a[k];
    return out;
  }

  // The file text: one line per field, values (points, frames, templates) kept compact.
  function serialize(project) {
    const used = new Set(project.actions.map((a) => a.template).filter((k) => typeof k === 'string'));
    const kept = {};
    for (const [key, t] of Object.entries(project.templates || {})) if (used.has(key)) kept[key] = t;
    const top = {
      [TAG]: project[TAG] || VERSION,
      layout: project.layout,
      frameTime: project.frameTime,
      templates: kept,
      actions: project.actions.map(ordered),
    };
    for (const k of Object.keys(project)) if (!(k in top) && project[k] !== undefined) top[k] = project[k];

    const q = JSON.stringify;
    const block = (open, close, items) => (items.length ? `${open}\n${items.join(',\n')}\n  ${close}` : `${open}${close}`);
    const lines = Object.entries(top).map(([key, value]) => {
      if (key === 'templates') {
        return `  ${q(key)}: ${block('{', '}', Object.entries(value).map(([k, t]) => `    ${q(k)}: ${q(t)}`))}`;
      }
      if (key === 'actions') {
        const items = value.map((a) => {
          const fields = Object.entries(a).map(([k, v]) => `      ${q(k)}: ${q(v)}`);
          return `    {\n${fields.join(',\n')}\n    }`;
        });
        return `  ${q(key)}: ${block('[', ']', items)}`;
      }
      if (key === 'process' && value && Array.isArray(value.tiles)) {
        const tile = (t) => {
          const o = {};
          for (const k of TILE_ORDER) if (t[k] !== undefined) o[k] = t[k];
          for (const k of Object.keys(t)) if (!(k in o) && t[k] !== undefined) o[k] = t[k];
          return `      ${q(o)}`;
        };
        const parts = [`    "tiles": ${block('[', ']', value.tiles.map(tile)).replace(/\n {2}]$/, '\n    ]')}`];
        parts.push(`    "links": ${block('[', ']', (value.links || []).map((l) => `      ${q(l)}`)).replace(/\n {2}]$/, '\n    ]')}`);
        for (const k of Object.keys(value)) if (k !== 'tiles' && k !== 'links') parts.push(`    ${q(k)}: ${q(value[k])}`);
        return `  ${q(key)}: {\n${parts.join(',\n')}\n  }`;
      }
      return `  ${q(key)}: ${q(value)}`;
    });
    return `{\n${lines.join(',\n')}\n}\n`;
  }

  const numbered = (values, prefix) => {
    let max = 0;
    for (const v of values) {
      const m = typeof v === 'string' && v.startsWith(prefix) ? /^(\d+)$/.exec(v.slice(prefix.length)) : null;
      if (m) max = Math.max(max, Number(m[1]));
    }
    return max + 1;
  };

  const nextId = (project) => `a${numbered(project.actions.map((a) => a.id), 'a')}`;
  const nextName = (project, word) => `${word} ${numbered(project.actions.map((a) => a.name), `${word} `)}`;
  const nextDroplet = (project) => `Droplet ${numbered(project.actions.map((a) => a.droplet), 'Droplet ')}`;

  // A droplet name's short form, for merged names and where space is tight: "Droplet 12" is
  // D12; a short one-word name stays as it is; a longer name gives its words' initials, numbers
  // kept whole ("Sample buffer 2" is SB2); a merged name "A + B" shortens each part.
  function shortDroplet(name) {
    const text = String(name || '').trim().replace(/\s+/g, ' ');
    if (!text) return '';
    if (text.includes('+')) return text.split('+').map(shortDroplet).filter(Boolean).join(' + ');
    const numberedDroplet = /^droplet ?(\d+)$/i.exec(text);
    if (numberedDroplet) return `D${numberedDroplet[1]}`;
    if (text.length <= 6 && !text.includes(' ')) return text;
    return text.split(' ').map((w) => (/^\d+$/.test(w) ? w : [...w][0].toUpperCase())).join('');
  }

  // Copies a template into the project (once) and returns its key: a built-in one keeps its id,
  // others get t1, t2, ...
  function embedTemplate(project, t) {
    project.templates = project.templates || {};
    const def = { name: t.name, frames: t.frames };
    for (const [key, have] of Object.entries(project.templates)) if (templates.sameTemplate(have, def)) return key;
    let key = t.builtIn && t.id ? t.id : `t${numbered(Object.keys(project.templates), 't')}`;
    if (project.templates[key]) key = `t${numbered(Object.keys(project.templates), 't')}`;
    project.templates[key] = def;
    return key;
  }

  return {
    TAG, VERSION, EXTENSION, TYPE_NAMES, newProject, isProject, parse, serialize, nextId, nextName, nextDroplet, shortDroplet,
    embedTemplate, cleanHV,
  };
});
