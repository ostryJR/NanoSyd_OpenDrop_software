/* The project file (*.odproj.json): what was drawn, kept as named actions, plus the layout, the
 * default frame time and copies of the templates the actions use. Reading checks and cleans a
 * file; parts this version doesn't know are kept as they are and written back. No DOM here. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./model.js'), require('./templates.js'), require('./compile.js'));
  } else {
    (root.OD = root.OD || {}).project = factory(root.OD.model, root.OD.templates, root.OD.compile);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (model, templates, compiler) {
  'use strict';

  const { CELLS, MAX_FRAMES, DEFAULT_FRAME_TIME, clampTime } = model;
  const { RESERVOIR_STEPS } = compiler;

  const TAG = 'openDropGeneratorProject';
  const VERSION = 1;
  const EXTENSION = '.odproj.json';
  const TYPE_NAMES = { path: 'Path', template: 'Template', dispense: 'Dispense', pattern: 'Pattern' };
  // Key order in saved files; other keys follow in the order they came.
  const KEY_ORDER = ['id', 'type', 'name', 'droplet', 'start', 'after', 'delay', 'points', 'template', 'at', 'turns',
    'reservoir', 'frames', 'stepTime', 'times', 'split'];

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
    if ('wait' in point) {
      if (goodTime(point.wait)) point.wait = clampTime(point.wait);
      else delete point.wait;
    }
    return point;
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
    if ('stepTime' in a) {
      if (goodTime(a.stepTime)) a.stepTime = clampTime(a.stepTime);
      else delete a.stepTime;
    }
    if (a.split !== true) delete a.split;
    if ('times' in a) {
      const times = Array.isArray(a.times) ? a.times.map((ms) => (goodTime(ms) ? clampTime(ms) : 0)) : [];
      if (times.some(Boolean)) a.times = times;
      else delete a.times;
    }

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
      default:
        break; // kept as it is: a later version may know it
    }
    return a;
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

    project.templates = {};
    if (data.templates && typeof data.templates === 'object' && !Array.isArray(data.templates)) {
      for (const [key, raw] of Object.entries(data.templates)) {
        const t = templates.clean(raw);
        if (t) project.templates[key] = t;
        else warn(`the template ${key} in the file is unusable and was left out`);
      }
    }

    const list = Array.isArray(data.actions) ? data.actions : [];
    project.actions = list.map((raw, i) => cleanAction(raw, i + 1, warn)).filter(Boolean);
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

  // Copies a template into the project (once) and returns its key: a built-in one keeps its id,
  // others get t1, t2, ...
  function embedTemplate(project, t) {
    project.templates = project.templates || {};
    const def = { name: t.name, frames: t.frames };
    if (t.times && t.times.some(Boolean)) def.times = t.times.slice();
    for (const [key, have] of Object.entries(project.templates)) if (templates.sameTemplate(have, def)) return key;
    let key = t.builtIn && t.id ? t.id : `t${numbered(Object.keys(project.templates), 't')}`;
    if (project.templates[key]) key = `t${numbered(Object.keys(project.templates), 't')}`;
    project.templates[key] = def;
    return key;
  }

  return {
    TAG, VERSION, EXTENSION, TYPE_NAMES, newProject, isProject, parse, serialize, nextId, nextName, nextDroplet, embedTemplate,
  };
});
