/* Connects the page to the editor and the views: the board (mouse, touch, wheel, keys), file
 * dialogs, the timing strip and its chart, the actions and templates panel, and the bottom bar. */
(function (root) {
  'use strict';

  const { layout, jsonio, templates, project: projects } = root.OD;
  const { Editor } = root.OD.editor;
  const { BoardView, dropletColour } = root.OD.view;
  const { TimingChart, formatTime } = root.OD.chart;
  const { Timeline } = root.OD.timeline;
  const G = layout.GEOMETRY;
  const $ = (id) => document.getElementById(id);

  const svg = $('board');
  const layoutSelect = $('layout');
  const numbersBox = $('numbers');
  const linesBox = $('lines');
  const statusText = $('status');
  const fileInput = $('file-input');

  function readStored(key, fallback) {
    try {
      const value = JSON.parse(localStorage.getItem(key));
      return value === null ? fallback : value;
    } catch {
      return fallback;
    }
  }

  // Layout, overlays, drag tool, minimised panels, panel tab and chart view are remembered
  // between visits.
  const PREFS_KEY = 'opendrop-generator.prefs';
  const stored = readStored(PREFS_KEY, {});
  const prefs = {
    timingMin: false, templatesMin: false, chart: 'timeline', lines: true, tab: 'properties',
    ...(stored && typeof stored === 'object' ? stored : {}),
  };
  const savePrefs = () => {
    try {
      const { timingMin, templatesMin, chart: view, tab } = prefs;
      localStorage.setItem(
        PREFS_KEY,
        JSON.stringify({ layout: current.id, numbers: showNumbers, lines: showLines, tool: ed.tool, timingMin, templatesMin, chart: view, tab })
      );
    } catch {
      // storage unavailable: preferences just aren't kept
    }
  };

  let current = layout.getLayout(prefs.layout);
  let showNumbers = Boolean(prefs.numbers);
  let showLines = prefs.lines !== false;
  let baseName = null; // the project's file name without its extension, once saved or opened

  const ed = new Editor(current);
  ed.setTool(prefs.tool);
  const board = new BoardView(svg, 'assets/OpenDropFrame.png');
  board.setLayout(current);

  function setStatus(text, kind = 'info') {
    statusText.textContent = text;
    statusText.className = kind;
  }

  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const quote = (a) => `“${a.name}”`;

  // A message from the editor about what it couldn't do (paint-off on a path, a move that
  // doesn't fit, ...).
  function showNotice() {
    if (!ed.notice) return false;
    setStatus(ed.notice, 'warn');
    ed.notice = null;
    return true;
  }

  // While a path is being drawn, the status line counts its steps.
  let draftInStatus = false;
  function showDraft(draft) {
    const limit = draft.limited ? ' (stopped at frame 200)' : '';
    setStatus(
      draft.steps === 0
        ? 'Back on the start electrode: letting go adds nothing'
        : `${plural(draft.steps, 'step')}, frames ${draft.frame} to ${draft.endFrame}${limit}. Let go to add it, Esc to cancel.`
    );
    draftInStatus = true;
  }
  // Replaces the step count with `text`; with no text, just removes the step count, if shown.
  function clearDraftStatus(text) {
    if (text !== undefined || draftInStatus) setStatus(text || '');
    draftInStatus = false;
  }

  // Drawing happens once per animation frame; playback keeps requesting frames while it runs.
  let frameRequested = false;
  function redraw() {
    if (frameRequested) return;
    frameRequested = true;
    requestAnimationFrame((now) => {
      frameRequested = false;
      ed.tick(now);
      paint();
      if (ed.playing) redraw();
    });
  }

  function paint() {
    board.render(ed, { numbers: showNumbers, lines: showLines });
    if (ed.draft && ed.draft.moved) showDraft(ed.draft);
    showTiming();
    showProperties();
    if (ed.makingTemplate) showMakerInfo();
  }

  function setTool(tool) {
    ed.setTool(tool);
    savePrefs();
    redraw();
  }

  function undoRedo(kind) {
    const drawing = ed.dragging; // during a drag, undo and redo just cancel it
    if (kind === 'undo') ed.undo();
    else ed.redo();
    clearDraftStatus(drawing ? 'Cancelled' : ''); // whatever the status said may no longer be true
    redraw();
  }

  function deleteSelected() {
    const a = ed.selected;
    if (a && ed.deleteSelected()) setStatus(`Deleted ${quote(a)}`);
    redraw();
  }

  // --- board: mouse / touch --------------------------------------------------------------

  function toGrid(evt) {
    const p = new DOMPoint(evt.clientX, evt.clientY).matrixTransform(svg.getScreenCTM().inverse());
    return { mx: (p.x - G.CX) / G.UNIT, my: (p.y - G.CY) / G.UNIT };
  }

  const DIALOGS = { save: () => save(), load: () => fileInput.click(), export: () => exportFrames() };
  let pendingDialog = null;
  const MAC = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);

  svg.addEventListener('pointerdown', (evt) => {
    if (evt.button !== 0 || !evt.isPrimary) return;
    if (MAC && evt.ctrlKey) return; // a right-click on a Mac: see 'contextmenu'
    evt.preventDefault();
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    const { mx, my } = toGrid(evt);
    const action = ed.pointerDown(mx, my, { shift: evt.shiftKey, alt: evt.altKey, now: performance.now() });
    if (DIALOGS[action]) {
      // Browsers only open file dialogs during a user gesture: a mouse press counts,
      // a touch only once the finger lifts.
      if (evt.pointerType === 'mouse') DIALOGS[action]();
      else pendingDialog = action;
    } else if (action === 'undo' || action === 'redo') {
      clearDraftStatus('');
    } else if (action && action.startsWith('tool')) {
      savePrefs();
    }
    if (!showNotice() && ed.info) setStatus(ed.info);
    if (ed.dragging) svg.setPointerCapture(evt.pointerId);
    redraw();
  });

  // Letting go adds the path being drawn, or applies the edit being dragged.
  function finishDrag() {
    const done = ed.pointerUp();
    const a = ed.selected;
    if (done && done.kind === 'path' && a) {
      const span = ed.span(a.id);
      const frames = span ? `frames ${span.from} to ${span.to}` : '';
      if (done.extended) clearDraftStatus(`Extended ${quote(a)}: ${frames}`);
      else {
        const after = a.after && ed.action(a.after) ? `, after ${quote(ed.action(a.after))}` : '';
        clearDraftStatus(`Added ${quote(a)}: ${plural(done.steps, 'step')}, ${frames}${after}`);
      }
    } else if (done && done.kind === 'edit') {
      const along = done.along || [];
      const names = along.slice(0, 3).map((n) => `“${n}”`).join(', ') + (along.length > 3 ? ` and ${along.length - 3} more` : '');
      clearDraftStatus(`${done.reshaped ? 'Reshaped' : 'Moved'} “${done.name}”${along.length ? `; ${names} came along` : ''}`);
    } else if (!showNotice()) {
      clearDraftStatus();
    }
    redraw();
  }

  svg.addEventListener('pointerup', (evt) => {
    if (!evt.isPrimary) return;
    if (pendingDialog) DIALOGS[pendingDialog]();
    pendingDialog = null;
    finishDrag();
  });
  svg.addEventListener('pointercancel', (evt) => {
    if (!evt.isPrimary) return;
    pendingDialog = null;
    ed.cancel(); // the browser took the touch over: drop the drag rather than add half of it
    clearDraftStatus();
    redraw();
  });
  svg.addEventListener('lostpointercapture', finishDrag); // normally after pointerup: nothing left

  svg.addEventListener('pointermove', (evt) => {
    if (!evt.isPrimary) return;
    const { mx, my } = toGrid(evt);
    if (ed.dragging) {
      ed.pointerMove(mx, my);
      showNotice();
      redraw();
    } else {
      svg.style.cursor = ed.controlAt(mx, my) ? 'pointer' : '';
    }
  });

  // Double-click on the selected path: on a piece it adds a point, on a point it removes it.
  svg.addEventListener('dblclick', (evt) => {
    const { mx, my } = toGrid(evt);
    if (ed.doubleClick(mx, my)) setStatus(`Changed the points of ${quote(ed.selected)}`);
    else showNotice();
    redraw();
  });

  // Wheel and trackpad: one step per notch-sized amount of scrolling.
  let wheelTotal = 0;
  svg.addEventListener(
    'wheel',
    (evt) => {
      evt.preventDefault();
      if (ed.draft) return; // the path being drawn starts in the frame on screen: keep it there
      wheelTotal += evt.deltaY * (evt.deltaMode === 1 ? 40 : evt.deltaMode === 2 ? 800 : 1);
      if (Math.abs(wheelTotal) < 40) return;
      ed.wheel(Math.sign(wheelTotal));
      wheelTotal = 0;
      redraw();
    },
    { passive: false }
  );

  // --- keyboard --------------------------------------------------------------------------

  const NUDGE = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

  window.addEventListener('keydown', (evt) => {
    if (evt.target instanceof HTMLInputElement || evt.target instanceof HTMLSelectElement) return;
    const key = evt.key.length === 1 ? evt.key.toLowerCase() : evt.key;
    if (carried) {
      // Dragging a template: R turns it, Esc drops it back; nothing else while it's in hand.
      if (key === 'r' && !evt.repeat) ed.rotatePlacement();
      if (key === 'Escape') {
        ed.cancel();
        endTemplateDrag();
        setStatus('Cancelled');
      }
      evt.preventDefault();
      redraw();
      return;
    }
    if ((evt.metaKey || evt.ctrlKey) && !evt.altKey) {
      // Cmd+Z / Ctrl+Z undo; with Shift, or Ctrl+Y, redo. Cmd+S / Ctrl+S saves the project.
      if (evt.code === 'KeyZ' || key === 'z') undoRedo(evt.shiftKey ? 'redo' : 'undo');
      else if (key === 'y' && evt.ctrlKey) undoRedo('redo');
      else if (evt.code === 'KeyS' || key === 's') save();
      else return;
      evt.preventDefault();
      return;
    }
    if (evt.altKey && !evt.metaKey && !evt.ctrlKey && NUDGE[key]) {
      // Option/Alt + arrow keys move the selected action one electrode; with Shift, together with
      // everything that follows it.
      if (ed.nudge(...NUDGE[key], { chain: evt.shiftKey })) setStatus(`Moved ${quote(ed.selected)}${evt.shiftKey ? ' and what follows it' : ''}`);
      else showNotice();
      evt.preventDefault();
      redraw();
      return;
    }
    if (evt.metaKey || evt.ctrlKey || evt.altKey) return;
    if (ed.draft && (key === 'ArrowLeft' || key === 'ArrowRight' || key === ' ')) {
      evt.preventDefault(); // keep the frame on screen while a path is being drawn from it
      return;
    }
    switch (key) {
      case 'ArrowRight':
        ed.nextFrame();
        break;
      case 'ArrowLeft':
        ed.prevFrame();
        break;
      case ' ':
        if (!evt.repeat) ed.togglePlay(performance.now());
        break;
      case 'n':
        setNumbers(!showNumbers);
        break;
      case 'l':
        setLines(!showLines);
        break;
      case 'f':
        setTool('freehand');
        break;
      case 's':
        setTool('straight');
        break;
      case 'p':
        setTool('paint');
        break;
      case 'v':
        setTool('select');
        break;
      case 'r':
        if (ed.rotateSelected(evt.shiftKey ? -1 : 1)) setStatus(`Turned ${quote(ed.selected)}`);
        else showNotice();
        break;
      case '[':
      case ']':
        if (ed.shiftInTime(key === '[' ? -1 : 1)) {
          const span = ed.span(ed.selection);
          setStatus(`${quote(ed.selected)}: frames ${span.from} to ${span.to}`);
        } else showNotice();
        break;
      case 'Delete':
      case 'Backspace':
        deleteSelected();
        break;
      case 'Escape': {
        const what = ed.escape();
        if (what === 'cancelled') clearDraftStatus('Cancelled');
        else if (what === 'deselected') clearDraftStatus('');
        break;
      }
      default:
        return;
    }
    evt.preventDefault();
    redraw();
  });

  // --- save / open / export --------------------------------------------------------------

  const withJson = (name) => (/\.json$/i.test(name) ? name : `${name}.json`);
  const withProject = (name) => (/\.json$/i.test(name) ? name : `${name}${projects.EXTENSION}`);
  const baseOf = (name) => name.replace(/\.odproj\.json$/i, '').replace(/\.json$/i, '');

  // Saves text with the browser's save dialog, or (Safari, Firefox) asks for a name and
  // downloads it. Returns the file name, or null if cancelled or failed (the status says why).
  async function saveText(text, suggested, description, fixName = withJson) {
    if (typeof root.showSaveFilePicker === 'function') {
      let handle;
      try {
        handle = await root.showSaveFilePicker({
          suggestedName: suggested,
          types: [{ description, accept: { 'application/json': ['.json'] } }],
        });
      } catch (err) {
        if (err.name !== 'AbortError') setStatus(`Could not save: ${err.message}`, 'error');
        return null;
      }
      try {
        const out = await handle.createWritable();
        await out.write(text);
        await out.close();
      } catch (err) {
        setStatus(`Could not save ${handle.name}: ${err.message}`, 'error');
        return null;
      }
      return handle.name;
    }
    const name = root.prompt('Save as', suggested);
    if (!name || !name.trim()) return null;
    const file = fixName(name.trim());
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = file;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return file;
  }

  // save and open work on whatever is on the board: while a template is being made, that is the
  // template.
  async function save() {
    const suggested = withProject(ed.makingTemplate ? nameInput.value.trim() || 'template' : baseName || 'opendrop-project');
    const name = await saveText(projects.serialize(ed.project), suggested, 'OpenDrop Generator project', withProject);
    if (!name) return;
    if (!ed.makingTemplate) baseName = baseOf(name);
    setStatus(`Saved ${name} (${plural(ed.project.actions.length, 'action')})`);
  }

  // Export writes the frames for the OpenDrop controller. If some actions won't come out as
  // drawn, the first press says so and a second one (within 10 s) exports anyway.
  let exportWarnedAt = null;
  async function exportFrames() {
    const problems = ed.compiled.issues.filter((i) => i.kind !== 'waits');
    if (problems.length && (exportWarnedAt === null || performance.now() - exportWarnedAt > 10000)) {
      exportWarnedAt = performance.now();
      const first = problems[0];
      const who = ed.action(first.id) ? quote(ed.action(first.id)) : first.id;
      setStatus(`${plural(problems.length, 'problem')}, e.g. ${who}: ${first.text}. Press export again to export anyway.`, 'warn');
      return;
    }
    exportWarnedAt = null;
    const base = ed.makingTemplate ? nameInput.value.trim() || 'template' : baseName || 'opendrop-sequence';
    const name = await saveText(jsonio.encode(ed.seq), withJson(base), 'OpenDrop sequence');
    if (name) setStatus(`Exported ${name} (${plural(ed.seq.lastFrame(), 'frame')}) for the OpenDrop controller`);
  }

  function switchLayout(lay) {
    current = lay;
    ed.setLayout(lay);
    board.setLayout(lay);
    layoutSelect.value = lay.id;
    savePrefs();
  }

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    fileInput.value = ''; // so choosing the same file again still triggers a load
    if (!file) return;
    const text = await file.text();
    let data;
    try {
      data = jsonio.parseLenient(text);
    } catch (err) {
      setStatus(`Could not open ${file.name}: ${err.message}`, 'error');
      return;
    }
    const opened = (message, warnings) => {
      if (!ed.makingTemplate) baseName = baseOf(file.name);
      if (warnings.length) setStatus(`${message}. ${warnings.join('; ')}.`, 'warn');
      else setStatus(message);
      redraw();
    };
    if (projects.isProject(data)) {
      let parsed;
      try {
        parsed = projects.parse(data);
      } catch (err) {
        setStatus(`Could not open ${file.name}: ${err.message}`, 'error');
        return;
      }
      const { project, warnings } = parsed;
      const lay = layout.LAYOUTS.find((l) => l.id === project.layout);
      if (!lay) warnings.push(`its layout (${project.layout}) isn't available, so it is shown on ${current.label}`);
      else if (lay.id !== current.id) switchLayout(lay);
      ed.openProject(project);
      opened(`Opened ${file.name} (${plural(project.actions.length, 'action')})`, warnings);
      return;
    }
    let result;
    try {
      result = jsonio.decode(text);
    } catch (err) {
      setStatus(`Could not open ${file.name}: ${err.message}`, 'error');
      return;
    }
    ed.openSequence(result.seq, { timed: result.timed, name: file.name });
    opened(`Opened ${file.name} as one block (${plural(result.frames, 'frame')})`, result.warnings);
  });

  // --- timing strip ----------------------------------------------------------------------

  const defaultInput = $('time-default');
  const frameInput = $('time-frame');
  const frameNo = $('time-frame-no');
  const frameReset = $('time-frame-reset');
  const totalText = $('time-total');
  const warningBox = $('time-warning');
  const warningText = $('time-warning-text');
  const splitButton = $('time-split');
  const seconds = (ms) => String(+(ms / 1000).toFixed(3));
  let warningFix = null; // what the warning's button does

  const chart = new TimingChart($('chart'), {
    onPick(step) {
      if (ed.dragging || ed.placement) return;
      ed.frame = step;
      redraw();
    },
  });

  // A step that makes other actions wait (or one already split) in the frame on screen.
  function showWarning() {
    const f = ed.frame;
    const issue = ed.compiled.issues.find((i) => i.kind === 'waits' && i.frame === f);
    let text = '';
    warningFix = null;
    if (issue) {
      const long = ed.action(issue.id);
      const waiting = issue.ids.map((id) => quote(ed.action(id)));
      text = `${waiting.join(', ')} ${waiting.length === 1 ? 'waits' : 'wait'} for ${quote(long)} (${formatTime(issue.time)})`;
      splitButton.textContent = 'Let the others keep moving';
      warningFix = () => {
        ed.setSplit(long.id, true);
        setStatus(`${quote(long)} no longer holds up the others: its long steps stretch over their frames`);
      };
    } else {
      const split = (ed.compiled.active[f] || []).map(({ id }) => ed.action(id)).find((a) => a && a.split);
      if (split) {
        text = `${quote(split)} lets the others keep moving`;
        splitButton.textContent = 'Make them wait';
        warningFix = () => {
          ed.setSplit(split.id, false);
          setStatus(`Actions running with ${quote(split)} wait for its long steps again`);
        };
      }
    }
    warningBox.hidden = !text;
    warningBox.classList.toggle('waits', Boolean(issue));
    warningText.textContent = text;
  }

  splitButton.addEventListener('click', () => {
    if (warningFix) warningFix();
    splitButton.blur();
    redraw();
  });

  function showTiming() {
    const { seq } = ed;
    const runs = (ed.compiled.active[ed.frame] || []).length > 0;
    if (document.activeElement !== defaultInput) defaultInput.value = seconds(seq.frameTime);
    frameNo.textContent = ed.frame;
    const ownTime = seq.times[ed.frame];
    if (document.activeElement !== frameInput) frameInput.value = ownTime ? seconds(ownTime) : '';
    frameInput.placeholder = runs ? seconds(seq.frameTime) : '—';
    frameInput.disabled = !runs;
    frameInput.title = runs ? '' : 'Nothing happens in this frame';
    frameReset.disabled = !ownTime || !runs;
    const last = seq.lastFrame();
    totalText.textContent = `Total ${formatTime(seq.elapsed(last))} over ${plural(last, 'frame')}`;
    showWarning();
    if (prefs.timingMin) return; // the chart and timeline are folded away
    if (prefs.chart === 'timeline') {
      showTimeline();
      return;
    }
    const times = [];
    const own = [];
    for (let f = 1; f <= Math.max(last, ed.frame); f++) {
      times.push(seq.timeOf(f));
      own.push(seq.times[f] > 0);
    }
    chart.update({ times, own, current: ed.frame });
  }

  const readSeconds = (input) => {
    const s = parseFloat(input.value);
    return Number.isFinite(s) && s > 0 ? s * 1000 : null;
  };

  defaultInput.addEventListener('change', () => {
    const ms = readSeconds(defaultInput);
    if (ms) {
      ed.setDefaultTime(ms);
      setStatus(`Default frame time: ${formatTime(ed.seq.frameTime)}`);
    } else {
      setStatus('Frame times are in seconds, more than 0', 'warn');
    }
    defaultInput.value = seconds(ed.seq.frameTime); // shows a clamped value, or undoes a bad one
    redraw();
  });

  // The frame on screen's own time; empty means the default. It goes on the selected action if
  // it runs in this frame (on a path: a wait where the droplet is), otherwise on the actions in it.
  function setFrameTime(ms) {
    const f = ed.frame;
    const set = ed.setFrameTime(f, ms);
    if (!set.length) return;
    const on = set.map(quote).join(', ');
    if (ms) setStatus(`Frame ${f} lasts ${formatTime(ed.seq.timeOf(f))} (set on ${on})`);
    else if (ed.seq.times[f]) setStatus(`Frame ${f} still lasts ${formatTime(ed.seq.timeOf(f))}: that is the time per step of ${on}`, 'warn');
    else setStatus(`Frame ${f} uses the default time again (${on})`);
  }

  frameInput.addEventListener('change', () => {
    const ms = frameInput.value.trim() === '' ? 0 : readSeconds(frameInput);
    if (ms === null) setStatus('Frame times are in seconds, more than 0', 'warn');
    else setFrameTime(ms);
    frameInput.value = ed.seq.times[ed.frame] ? seconds(ed.seq.times[ed.frame]) : '';
    redraw();
  });

  frameReset.addEventListener('click', () => {
    setFrameTime(0);
    frameReset.blur();
    redraw();
  });

  // Enter keeps the value and gives the keys back to the board; Esc puts the old value back.
  function editKeys(input) {
    input.addEventListener('focus', () => (input.dataset.before = input.value));
    input.addEventListener('keydown', (evt) => {
      if (evt.key === 'Escape') input.value = input.dataset.before || '';
      if (evt.key === 'Enter' || evt.key === 'Escape') input.blur();
    });
  }
  for (const input of [defaultInput, frameInput]) editKeys(input);

  const viewButtons = [...document.querySelectorAll('#timing .segmented button')];
  const chartBox = $('chart');
  const timelineBox = $('timeline');
  function setChartView(view) {
    prefs.chart = view === 'step' ? 'step' : 'timeline'; // older settings may say 'total' or 'table'
    for (const b of viewButtons) b.setAttribute('aria-pressed', String(b.dataset.view === prefs.chart));
    timelineBox.hidden = prefs.chart !== 'timeline';
    chartBox.hidden = prefs.chart === 'timeline';
    savePrefs();
    redraw();
  }
  for (const b of viewButtons) {
    b.addEventListener('click', () => {
      setChartView(b.dataset.view);
      b.blur();
    });
  }

  // --- timeline --------------------------------------------------------------------------
  // One track per droplet, each action a clip; actions without a droplet name get a track each.

  const KIND = { path: 'Path', template: 'Template', dispense: 'Dispense', pattern: 'Pattern' };
  const timeline = new Timeline(timelineBox, {
    onSelect(id) {
      if (ed.dragging) return;
      ed.select(id);
      redraw();
    },
    onFrame(f) {
      if (ed.dragging || ed.placement) return;
      ed.frame = f;
      redraw();
    },
    onPreview(id, frame) {
      const check = ed.previewTime(id, frame);
      const span = check.valid ? check.compiled.spans.get(id) : null;
      return { valid: check.valid, reason: check.reason, from: span ? span.from : null, to: span ? span.to : null };
    },
    onMove(id, frame) {
      ed.select(id);
      if (ed.moveToFrame(id, frame)) {
        const span = ed.span(id);
        setStatus(`${quote(ed.action(id))}: frames ${span.from} to ${span.to}`);
      } else showNotice();
      redraw();
    },
  });

  function showTimeline() {
    const { compiled, project } = ed;
    const preds = (a) => (a.after === undefined ? [] : Array.isArray(a.after) ? a.after : [a.after]);
    const clips = [];
    for (const a of project.actions) {
      // An action that can't run still gets a clip, one frame long where it would start, so it
      // can be found and fixed.
      let span = compiled.spans.get(a.id);
      const broken = !span;
      if (broken) {
        const ends = preds(a).map((id) => compiled.spans.get(id)).filter(Boolean).map((s) => s.to);
        const from = a.start || (ends.length ? Math.max(...ends) + (a.delay || 0) : 1);
        span = { from: Math.min(200, from), to: Math.min(200, from) };
      }
      const followers = project.actions.filter((b) => preds(b).includes(a.id));
      const problem = compiled.issues.filter((i) => i.id === a.id && i.kind !== 'waits').map((i) => i.text).join('; ');
      clips.push({
        id: a.id,
        name: a.name,
        type: a.type,
        track: a.droplet ? `d:${a.droplet}` : `a:${a.id}`,
        trackName: a.droplet || a.name,
        colour: dropletColour(a.droplet),
        from: span.from,
        to: span.to,
        problem: problem || null,
        broken,
        split: Boolean(a.split),
        handIn: preds(a).some((id) => compiled.spans.get(id) && compiled.spans.get(id).to === span.from),
        handOut: followers.some((b) => compiled.spans.get(b.id) && compiled.spans.get(b.id).from === span.to),
        preds: preds(a),
      });
    }
    const last = clips.reduce((m, c) => Math.max(m, c.to), 0);
    timeline.update({ frames: Math.min(200, Math.max(30, last + 10, ed.frame + 5)), frame: ed.frame, selection: ed.selection, clips });
  }

  // --- properties ------------------------------------------------------------------------
  // The selected action's name, droplet, start, times and settings. Each field changes it when
  // it is left (or Enter is pressed); a change that doesn't fit is refused and the field shows
  // the old value again.

  const propsNone = $('props-none');
  const props = $('props');
  const summary = $('props-summary');
  const kindText = $('prop-kind');
  const nameField = $('prop-name');
  const dropletField = $('prop-droplet');
  const startMode = $('prop-start-mode');
  const startField = $('prop-start');
  const afterBox = $('prop-after');
  const afterList = $('prop-after-list');
  const delayField = $('prop-delay');
  const stepField = $('prop-step');
  const splitBox = $('prop-split');
  const sizeField = $('prop-size');
  const dirField = $('prop-dir');
  const lengthField = $('prop-length');
  const roundsField = $('prop-rounds');
  const framesField = $('prop-frames');
  const endWaitField = $('prop-endwait');
  const infoText = $('prop-info');
  const dropletNames = $('droplet-names');
  const show = (node, on) => (node.hidden = !on);
  let propsKey = '';
  let afterDraft = null; // predecessors being picked in the "after" list, not yet applied
  let propsFor = null; // the action the fields show

  const predsOf = (a) => (a.after === undefined ? [] : Array.isArray(a.after) ? a.after : [a.after]);
  const keep = (input, value) => {
    if (document.activeElement !== input) input.value = value;
  };

  function showProperties() {
    const a = ed.selected;
    if ((a && a.id) !== propsFor) {
      propsFor = a && a.id;
      afterDraft = null;
    }
    const span = a && ed.span(a.id);
    const key = JSON.stringify([a, span, ed.project.actions.map((x) => [x.id, x.name]), ed.compiled.issues.filter((i) => a && i.id === a.id), afterDraft]);
    if (key === propsKey) return;
    propsKey = key;
    show(propsNone, !a);
    show(props, Boolean(a));
    if (!a) {
      afterDraft = null;
      const last = ed.seq.lastFrame();
      summary.textContent = ed.project.actions.length
        ? `${plural(ed.project.actions.length, 'action')} · ${plural(last, 'frame')} · ${formatTime(ed.seq.elapsed(last))}`
        : '';
      return;
    }
    kindText.textContent = `${KIND[a.type] || a.type}${span ? ` · ${span.from === span.to ? `frame ${span.from}` : `frames ${span.from}–${span.to}`}` : ''}`;
    keep(nameField, a.name);
    keep(dropletField, a.droplet || '');
    dropletNames.replaceChildren(...[...new Set(ed.project.actions.map((x) => x.droplet).filter(Boolean))].map((n) => new Option(n)));

    // Starts: at a frame, or after other actions (and a delay).
    const preds = afterDraft || predsOf(a);
    const linked = preds.length > 0 || afterDraft !== null;
    if (document.activeElement !== startMode) startMode.value = linked ? 'after' : 'frame';
    show(startField, !linked);
    keep(startField, String(a.start || (span ? span.from : 1)));
    show(afterBox, linked);
    keep(delayField, String(a.delay || 0));
    const others = ed.project.actions.filter((x) => x.id !== a.id);
    const rows = (preds.length ? preds : ['']).map((id, i) => {
      const row = document.createElement('span');
      row.className = 'row';
      const select = document.createElement('select');
      select.add(new Option('— pick an action —', ''));
      for (const x of others) select.add(new Option(x.name, x.id));
      select.value = id;
      select.addEventListener('change', () => setPreds(preds.map((p, j) => (j === i ? select.value : p)).concat(preds.length ? [] : [select.value]).filter(Boolean)));
      row.appendChild(select);
      if (preds.length > 1) row.appendChild(iconButton('×', 'Stop waiting for it', () => setPreds(preds.filter((_, j) => j !== i))));
      return row;
    });
    afterList.replaceChildren(...rows);

    keep(stepField, a.stepTime ? seconds(a.stepTime) : '');
    stepField.placeholder = `${seconds(ed.project.frameTime)} (default)`;
    splitBox.checked = Boolean(a.split);
    show($('prop-turn'), a.type !== 'dispense');
    const p = a.type === 'template' && a.params ? a.params : null;
    const family = p && templates.FAMILIES[p.kind];
    const turnsRound = Boolean(family && family.choices && family.choices.dir);
    show($('prop-size-row'), Boolean(p && p.size !== undefined));
    show($('prop-dir-row'), turnsRound);
    show($('prop-length-row'), Boolean(p && p.length !== undefined));
    show($('prop-rounds-row'), Boolean(p && p.rounds !== undefined));
    if (p) {
      if (turnsRound) dirField.value = p.dir || family.choices.dir[0];
      if (p.size !== undefined) sizeField.value = String(p.size);
      if (p.length !== undefined) keep(lengthField, String(p.length));
      if (p.rounds !== undefined) keep(roundsField, String(p.rounds));
    }
    show($('prop-frames-row'), a.type === 'pattern');
    if (a.type === 'pattern') keep(framesField, String(a.frames.length));
    show($('prop-endwait-row'), a.type === 'path');
    show($('prop-waits-row'), a.type === 'path');
    if (a.type === 'path') {
      const end = a.points[a.points.length - 1];
      keep(endWaitField, end.wait ? seconds(end.wait) : '');
      showWaits(a);
    }
    const notes = ed.issuesOf(a.id).filter((i) => i.kind !== 'waits').map((i) => i.text);
    infoText.className = notes.length ? 'info' : 'info ok';
    if (!notes.length && a.type === 'dispense') notes.push('A dispense stays at its reservoir');
    infoText.textContent = notes.map((n) => n[0].toUpperCase() + n.slice(1)).join('. ');
  }

  // Applies a property change: ok -> status text, refused -> the editor's reason.
  function propChange(done, text) {
    if (done) setStatus(text());
    else showNotice();
    propsKey = '';
    redraw();
  }

  function setPreds(preds) {
    const a = ed.selected;
    if (!a) return;
    if (!preds.length) {
      afterDraft = [];
      propsKey = '';
      redraw();
      return;
    }
    afterDraft = null;
    propChange(ed.setAfter(a.id, preds, Number(delayField.value) || 0), () => `${quote(a)} starts after ${preds.map((id) => quote(ed.action(id))).join(' and ')}`);
  }

  nameField.addEventListener('change', () => {
    const a = ed.selected;
    if (a) propChange(ed.rename(a.id, nameField.value), () => `Renamed to ${quote(ed.selected)}`);
  });
  dropletField.addEventListener('change', () => {
    const a = ed.selected;
    if (a) propChange(ed.setDroplet(a.id, dropletField.value), () => (dropletField.value.trim() ? `${quote(a)} moves the droplet “${dropletField.value.trim()}”` : `${quote(a)} has no droplet name`));
  });
  startMode.addEventListener('change', () => {
    const a = ed.selected;
    if (!a) return;
    if (startMode.value === 'frame') {
      afterDraft = null;
      const span = ed.span(a.id);
      propChange(ed.setStart(a.id, span ? span.from : 1), () => `${quote(a)} starts in frame ${ed.span(a.id).from}`);
    } else {
      afterDraft = predsOf(a);
      propsKey = '';
      redraw();
    }
  });
  startField.addEventListener('change', () => {
    const a = ed.selected;
    const f = Math.round(Number(startField.value));
    if (a && f >= 1) propChange(ed.setStart(a.id, f), () => `${quote(a)} starts in frame ${f}`);
  });
  delayField.addEventListener('change', () => {
    const a = ed.selected;
    const preds = a ? predsOf(a) : [];
    if (preds.length) propChange(ed.setAfter(a.id, preds, Math.max(0, Math.round(Number(delayField.value) || 0))), () => `${quote(a)} waits ${plural(ed.action(a.id).delay || 0, 'frame')} first`);
  });
  $('prop-after-add').addEventListener('click', () => {
    const a = ed.selected;
    if (!a) return;
    afterDraft = [...predsOf(a), ''];
    propsKey = '';
    redraw();
  });
  stepField.addEventListener('change', () => {
    const a = ed.selected;
    if (!a) return;
    const ms = stepField.value.trim() === '' ? 0 : readSeconds(stepField);
    if (ms === null) setStatus('Times are in seconds, more than 0', 'warn');
    else propChange(ed.setStepTime(a.id, ms), () => (ms ? `Each step of ${quote(a)} lasts ${formatTime(ed.action(a.id).stepTime)}` : `${quote(a)} uses the default frame time`));
  });
  splitBox.addEventListener('change', () => {
    const a = ed.selected;
    if (a) propChange(ed.setSplit(a.id, splitBox.checked), () => (splitBox.checked ? `${quote(a)} lets the others keep moving` : `Actions running with ${quote(a)} wait for its long steps`));
  });
  $('prop-turn-left').addEventListener('click', () => propChange(ed.rotateSelected(-1), () => `Turned ${quote(ed.selected)}`));
  $('prop-turn-right').addEventListener('click', () => propChange(ed.rotateSelected(1), () => `Turned ${quote(ed.selected)}`));
  for (const [field, name] of [[sizeField, 'size'], [lengthField, 'length'], [roundsField, 'rounds']]) {
    field.addEventListener('change', () => {
      const a = ed.selected;
      if (a) propChange(ed.setParams(a.id, { [name]: Math.round(Number(field.value)) }), () => `${quote(ed.selected)}: ${plural(ed.stepsOf(a.id).length - 1, 'step')}`);
    });
  }
  dirField.addEventListener('change', () => {
    const a = ed.selected;
    const ccw = dirField.value === 'ccw';
    dirField.blur();
    if (a) propChange(ed.setParams(a.id, { dir: dirField.value }), () => `${quote(ed.selected)} goes round ${ccw ? 'counter-clockwise' : 'clockwise'}`);
  });
  framesField.addEventListener('change', () => {
    const a = ed.selected;
    if (a) propChange(ed.setFrames(a.id, Number(framesField.value)), () => `${quote(a)} lasts ${plural(ed.action(a.id).frames.length, 'frame')}`);
  });
  endWaitField.addEventListener('change', () => {
    const a = ed.selected;
    if (!a) return;
    const ms = endWaitField.value.trim() === '' || Number(endWaitField.value) === 0 ? 0 : readSeconds(endWaitField);
    if (ms === null) setStatus('Times are in seconds', 'warn');
    else propChange(ed.setEndWait(a.id, ms), () => (ms ? `${quote(a)} waits ${formatTime(ms)} at its end` : `${quote(a)} doesn't wait at its end`));
  });
  for (const input of [nameField, dropletField, startField, delayField, stepField, lengthField, roundsField, framesField, endWaitField]) editKeys(input);
  $('prop-delete').addEventListener('click', (evt) => {
    evt.currentTarget.blur();
    deleteSelected();
  });

  // --- waits -----------------------------------------------------------------------------
  // Right-click (on a Mac also Ctrl+click) on a path's line opens a small form for how much
  // longer the droplet stays on that electrode. Properties lists a path's waits on the way.

  const waitPop = $('wait-pop');
  const waitPopTitle = $('wait-pop-title');
  const waitPopInput = $('wait-pop-input');
  const waitPopClear = $('wait-pop-clear');
  let waitSpot = null; // { id, step, e, wait } the form is for
  for (const node of document.querySelectorAll('.mac-only')) node.hidden = !MAC;

  // The first frame in which path id's droplet is on step k, or null.
  function frameOfStep(id, k) {
    const span = ed.span(id);
    if (span) for (let f = span.from; f <= span.to; f++) if (ed.stepIn(id, f) === k) return f;
    return null;
  }

  const spotText = (spot) => {
    const f = frameOfStep(spot.id, spot.step);
    return `electrode ${spot.e}${f ? ` (frame ${f})` : ''}`;
  };

  function closeWaitPop() {
    waitPop.hidden = true;
    waitSpot = null;
  }

  // Opens the form next to the pointer, with the path selected and the droplet shown there.
  function openWaitPop(spot, clientX, clientY) {
    ed.select(spot.id);
    const f = frameOfStep(spot.id, spot.step);
    if (f) ed.frame = f;
    waitSpot = spot;
    waitPopTitle.textContent = `${quote(ed.action(spot.id))} on ${spotText(spot)}`;
    waitPopInput.value = spot.wait ? seconds(spot.wait) : '';
    waitPopClear.disabled = !spot.wait;
    waitPop.hidden = false;
    const box = waitPop.getBoundingClientRect();
    waitPop.style.left = `${Math.max(8, Math.min(window.innerWidth - box.width - 8, clientX + 12))}px`;
    waitPop.style.top = `${Math.max(8, Math.min(window.innerHeight - box.height - 8, clientY + 12))}px`;
    waitPopInput.focus();
    waitPopInput.select();
    setStatus('How many seconds more should the droplet stay here? Enter sets it, Esc closes');
    redraw();
  }

  // A wait of `ms` (0 = none) at a spot on a path.
  function applyWait(spot, ms) {
    const a = ed.action(spot.id);
    if (!a) return;
    const where = spotText(spot);
    if (ed.setWaitAt(spot.id, spot.step, ms)) setStatus(ms ? `${quote(a)} waits ${formatTime(ms)} on ${where}` : `${quote(a)} doesn't wait on ${where} any more`);
    else showNotice();
    propsKey = '';
    redraw();
  }

  // Seconds typed in a wait field: ms (0 for empty), or null if it isn't a number of seconds.
  function waitMs(input) {
    if (input.validity && input.validity.badInput) return null;
    const text = input.value.trim();
    if (text === '') return 0;
    const s = parseFloat(text);
    return Number.isFinite(s) && s >= 0 ? Math.round(s * 1000) : null;
  }

  svg.addEventListener('contextmenu', (evt) => {
    evt.preventDefault();
    if (ed.dragging || ed.placement) return;
    const { mx, my } = toGrid(evt);
    const e = root.OD.paths.electrodeAt(ed.layout.rects, mx, my);
    const spot = e === null ? null : ed.waitSpot(e);
    if (!spot) {
      closeWaitPop();
      setStatus(`Right-click${MAC ? ' (or Ctrl+click)' : ''} on a path's line where its droplet should wait`);
      redraw();
      return;
    }
    openWaitPop(spot, evt.clientX, evt.clientY);
  });

  waitPop.addEventListener('submit', (evt) => {
    evt.preventDefault();
    const ms = waitMs(waitPopInput);
    if (ms === null) {
      setStatus('Waits are in seconds', 'warn');
      return;
    }
    const spot = waitSpot;
    closeWaitPop();
    if (spot && (ms || spot.wait)) applyWait(spot, ms);
    else setStatus('');
  });
  waitPopClear.addEventListener('click', () => {
    const spot = waitSpot;
    closeWaitPop();
    if (spot) applyWait(spot, 0);
  });
  waitPop.addEventListener('keydown', (evt) => {
    if (evt.key !== 'Escape') return;
    evt.preventDefault();
    evt.stopPropagation();
    closeWaitPop();
    setStatus('');
    redraw();
  });
  // A press anywhere else closes it (a right-click on another spot opens it there).
  document.addEventListener('pointerdown', (evt) => {
    if (!waitPop.hidden && !waitPop.contains(evt.target)) closeWaitPop();
  }, true);

  // The selected path's waits on the way (the one at its end has its own field): where, and how
  // long. The place goes to the frame where the droplet is there.
  function showWaits(a) {
    const steps = ed.stepsOf(a.id);
    const end = steps ? steps.length - 1 : -1;
    const rows = ed.waitsOf(a.id).filter((w) => w.step !== end).map((w) => {
      const spot = { id: a.id, step: w.step, e: w.e, wait: w.wait };
      const row = document.createElement('span');
      row.className = 'row wait-row';
      const place = document.createElement('button');
      place.type = 'button';
      place.className = 'place';
      place.textContent = `electrode ${w.e}${w.frame ? ` · frame ${w.frame}` : ''}`; // numbers stay with their word
      place.title = 'Show the droplet there';
      place.addEventListener('click', () => {
        place.blur();
        if (w.frame) ed.frame = w.frame;
        redraw();
      });
      const input = document.createElement('input');
      Object.assign(input, { type: 'number', min: '0', max: '3600', step: 'any', value: seconds(w.wait) });
      input.inputMode = 'decimal';
      input.setAttribute('aria-label', `Wait on electrode ${w.e}, in seconds`);
      editKeys(input);
      input.addEventListener('change', () => {
        const ms = waitMs(input);
        if (ms === null) setStatus('Waits are in seconds', 'warn');
        else applyWait(spot, ms);
      });
      const unit = document.createElement('span');
      unit.textContent = 's';
      row.append(place, input, unit, iconButton('×', 'No wait here', () => applyWait(spot, 0)));
      return row;
    });
    if (!rows.length) {
      const none = document.createElement('span');
      none.className = 'none';
      none.textContent = 'None';
      rows.push(none);
    }
    $('prop-waits-list').replaceChildren(...rows);
  }

  // --- adding a file ---------------------------------------------------------------------

  const addFileInput = $('add-file-input');
  $('add-file').addEventListener('click', (evt) => {
    evt.currentTarget.blur();
    addFileInput.click();
  });
  addFileInput.addEventListener('change', async () => {
    const file = addFileInput.files[0];
    addFileInput.value = '';
    if (!file) return;
    let result;
    try {
      result = jsonio.decode(await file.text());
    } catch (err) {
      setStatus(`Could not add ${file.name}: ${err.message}`, 'error');
      return;
    }
    if (ed.addSequence(result.seq, file.name)) {
      const span = ed.span(ed.selection);
      setStatus(`Added ${file.name} as one block: frames ${span.from} to ${span.to}`);
    } else showNotice();
    redraw();
  });

  // --- templates panel -------------------------------------------------------------------

  const TEMPLATES_KEY = 'opendrop-generator.templates';
  const NS = 'http://www.w3.org/2000/svg';
  let serial = 0;
  const mine = (t) => ({ ...t, id: `mine-${++serial}` });
  let myTemplates = (() => {
    const list = readStored(TEMPLATES_KEY, []);
    return Array.isArray(list) ? list.map(templates.clean).filter(Boolean).map(mine) : [];
  })();

  function storeTemplates() {
    try {
      const list = myTemplates.map(({ name, frames, times }) => (times ? { name, frames, times } : { name, frames }));
      localStorage.setItem(TEMPLATES_KEY, JSON.stringify(list));
    } catch {
      setStatus('This browser would not keep the templates: use Export… to save them to a file', 'error');
    }
  }

  // A small picture of every electrode the template uses, its drop point in blue.
  function miniPreview(t) {
    const cells = new Map();
    for (const frame of t.frames) for (const [c, r] of frame) cells.set(`${c},${r}`, [c, r]);
    const list = [...cells.values()];
    const cs = list.map((p) => p[0]);
    const rs = list.map((p) => p[1]);
    const minC = Math.min(...cs);
    const minR = Math.min(...rs);
    const span = Math.max(Math.max(...cs) - minC, Math.max(...rs) - minR) + 1;
    const pitch = Math.min(12, Math.floor(46 / span));
    const w = (Math.max(...cs) - minC + 1) * pitch;
    const h = (Math.max(...rs) - minR + 1) * pitch;
    const node = document.createElementNS(NS, 'svg');
    node.setAttribute('class', 'mini');
    node.setAttribute('width', 46);
    node.setAttribute('height', 46);
    node.setAttribute('viewBox', `${(w - 46) / 2} ${(h - 46) / 2} 46 46`);
    for (const [c, r] of list) {
      const rect = document.createElementNS(NS, 'rect');
      const attrs = { x: (c - minC) * pitch, y: (r - minR) * pitch, width: pitch - 2, height: pitch - 2, rx: 1.5 };
      for (const k of Object.keys(attrs)) rect.setAttribute(k, attrs[k]);
      rect.setAttribute('fill', c === 0 && r === 0 ? 'rgb(0,90,255)' : 'rgb(140,190,255)');
      node.appendChild(rect);
    }
    return node;
  }

  function iconButton(text, title, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.title = title;
    b.setAttribute('aria-label', title);
    b.addEventListener('click', (evt) => {
      evt.currentTarget.blur();
      onClick();
    });
    return b;
  }

  function templateCard(t) {
    const li = document.createElement('li');
    li.className = 'template';
    li.title = `${t.name}: drag it onto the array`;
    const text = document.createElement('div');
    text.className = 'text';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = t.name; // names come from storage or imported files: text only
    const steps = document.createElement('div');
    steps.className = 'steps';
    steps.textContent = plural(templates.stepsOf(t), 'step') + (t.times ? ' · own frame times' : '');
    text.append(name, steps);
    li.append(miniPreview(t), text);
    li.append(iconButton('✎', t.builtIn ? 'Copy it to change' : 'Change it', () => openMaker(t)));
    if (!t.builtIn) li.append(iconButton('×', 'Delete it', () => deleteTemplate(t)));
    li.addEventListener('pointerdown', (evt) => startTemplateDrag(evt, t, li));
    return li;
  }

  function renderTemplates() {
    $('my-templates').replaceChildren(...myTemplates.map(templateCard));
    $('builtin-templates').replaceChildren(...templates.BUILT_IN.map(templateCard));
    $('no-templates').hidden = myTemplates.length > 0;
  }

  function deleteTemplate(t) {
    if (!root.confirm(`Delete the template “${t.name}”?`)) return;
    myTemplates = myTemplates.filter((x) => x !== t);
    storeTemplates();
    renderTemplates();
    setStatus(`Deleted “${t.name}”`);
  }

  // Dragging a template from the panel onto the array. The card keeps the pointer, so the
  // board shows where the template would land and nothing changes until it is dropped.
  const ghost = $('drag-ghost');
  let carried = null;

  function startTemplateDrag(evt, t, li) {
    if (evt.button !== 0 || !evt.isPrimary || evt.target.closest('button') || ed.makingTemplate) return;
    evt.preventDefault();
    li.setPointerCapture(evt.pointerId);
    carried = { template: t };
    ed.startPlacement(t);
    document.body.classList.add('dragging-template');
    ghost.textContent = `${t.name} · ${plural(templates.stepsOf(t), 'step')}`;
    moveGhost(evt);
    redraw();
  }

  function moveGhost(evt) {
    ghost.hidden = Boolean(ed.placement && ed.placement.spot); // over the array, the board shows it
    ghost.style.left = `${evt.clientX + 14}px`;
    ghost.style.top = `${evt.clientY + 12}px`;
  }

  function endTemplateDrag() {
    carried = null;
    ghost.hidden = true;
    document.body.classList.remove('dragging-template');
  }

  document.addEventListener('pointermove', (evt) => {
    if (!carried || !evt.isPrimary) return;
    const { mx, my } = toGrid(evt);
    ed.hoverPlacement(mx, my);
    moveGhost(evt);
    redraw();
  });

  document.addEventListener('pointerup', (evt) => {
    if (!carried || !evt.isPrimary) return;
    const t = carried.template;
    const spot = ed.placement && ed.placement.spot;
    const added = ed.dropPlacement();
    endTemplateDrag();
    if (added) {
      const a = ed.selected;
      const after = a && a.after && ed.action(a.after) ? `, after ${quote(ed.action(a.after))}` : '';
      setStatus(`Added “${t.name}”: ${plural(added.steps, 'step')}, frames ${added.from} to ${added.to}${after}`);
    } else if (spot) {
      setStatus(
        spot.reason
          ? `“${t.name}” can't go there: ${spot.reason}`
          : spot.fits
            ? `“${t.name}” would run past frame 200 if it started in frame ${spot.frame}`
            : `“${t.name}” doesn't fit there: part of it would be off the array`,
        'warn'
      );
    } else {
      setStatus('Drag a template onto the electrode the droplet is on');
    }
    redraw();
  });

  document.addEventListener('pointercancel', (evt) => {
    if (!carried || !evt.isPrimary) return;
    ed.cancel(); // e.g. a touch that turned into scrolling the list
    endTemplateDrag();
    redraw();
  });

  // Making a template: a blank board (the project is set aside), drawn with the usual tools.
  const panel = $('panel');
  const library = $('library');
  const maker = $('maker');
  const makerTitle = $('maker-title');
  const nameInput = $('template-name');
  const makerInfo = $('maker-info');
  const saveTemplateButton = $('template-save');
  let editing = null; // the template of yours being changed, or null for a new one or a copy

  function openMaker(t) {
    if (ed.makingTemplate) return;
    ed.startTemplate(t ? templates.toSequence(t) : null);
    editing = t && !t.builtIn ? t : null;
    nameInput.value = t ? (t.builtIn ? `${t.name} (copy)` : t.name) : `Template ${myTemplates.length + 1}`;
    makerTitle.textContent = editing ? 'Change the template' : t ? 'Copy of a built-in template' : 'New template';
    panel.hidden = true;
    maker.hidden = false;
    board.setCutoutTitle('Making a template');
    applyPanels();
    setStatus('Making a template: draw it on the array, then press Save template');
    redraw();
  }

  function closeMaker() {
    ed.endTemplate();
    editing = null;
    panel.hidden = false;
    maker.hidden = true;
    board.setCutoutTitle('Path Generator');
    applyPanels();
    redraw();
  }

  function showMakerInfo() {
    const made = templates.fromSequence(ed.seq);
    makerInfo.textContent = made ? `${plural(made.frames.length - 1, 'step')} so far` : 'Nothing drawn yet';
    saveTemplateButton.disabled = !made;
  }

  function saveTemplate() {
    const made = templates.fromSequence(ed.seq);
    if (!made) {
      setStatus('The template is empty: draw something first', 'warn');
      return;
    }
    const t = templates.clean({ name: nameInput.value, ...made });
    if (editing) Object.assign(editing, { name: t.name, frames: t.frames, times: t.times });
    else myTemplates.push(mine(t));
    storeTemplates();
    renderTemplates();
    closeMaker();
    setStatus(`Saved the template “${t.name}”: ${plural(templates.stepsOf(t), 'step')}`);
  }

  $('template-new').addEventListener('click', (evt) => {
    evt.currentTarget.blur();
    openMaker(null);
  });
  saveTemplateButton.addEventListener('click', saveTemplate);
  nameInput.addEventListener('keydown', (evt) => {
    if (evt.key === 'Enter') saveTemplate();
  });
  $('template-cancel').addEventListener('click', () => {
    if (ed.canUndo && !root.confirm('Leave without saving this template?')) return;
    closeMaker();
    setStatus('');
  });

  $('template-export').addEventListener('click', async (evt) => {
    evt.currentTarget.blur();
    if (!myTemplates.length) {
      setStatus('There are no templates of your own to export yet', 'warn');
      return;
    }
    const name = await saveText(templates.exportText(myTemplates), 'opendrop-templates.json', 'OpenDrop templates');
    if (name) setStatus(`Exported ${plural(myTemplates.length, 'template')} to ${name}`);
  });

  const templateFile = $('template-file');
  $('template-import').addEventListener('click', (evt) => {
    evt.currentTarget.blur();
    templateFile.click();
  });
  templateFile.addEventListener('change', async () => {
    const file = templateFile.files[0];
    templateFile.value = '';
    if (!file) return;
    let list;
    try {
      list = templates.importText(await file.text());
    } catch (err) {
      setStatus(`Could not import ${file.name}: ${err.message}`, 'error');
      return;
    }
    const fresh = list.filter((t) => !myTemplates.some((m) => templates.sameTemplate(m, t)));
    myTemplates.push(...fresh.map(mine));
    storeTemplates();
    renderTemplates();
    const skipped = list.length - fresh.length;
    setStatus(`Imported ${plural(fresh.length, 'template')} from ${file.name}${skipped ? ` (${skipped} already here)` : ''}`);
  });

  // --- panel tabs ------------------------------------------------------------------------

  const tabButtons = [...document.querySelectorAll('#panel [role="tab"]')];
  function setTab(tab) {
    prefs.tab = tab === 'templates' ? 'templates' : 'properties';
    for (const b of tabButtons) b.setAttribute('aria-selected', String(b.dataset.tab === prefs.tab));
    $('properties').hidden = prefs.tab !== 'properties';
    library.hidden = prefs.tab !== 'templates';
    savePrefs();
  }
  for (const b of tabButtons) {
    b.addEventListener('click', () => {
      setTab(b.dataset.tab);
      b.blur();
    });
  }

  // --- bottom bar ------------------------------------------------------------------------

  for (const l of layout.LAYOUTS) layoutSelect.add(new Option(l.label, l.id));
  layoutSelect.value = current.id;
  layoutSelect.addEventListener('change', () => {
    switchLayout(layout.getLayout(layoutSelect.value));
    layoutSelect.blur(); // give the arrow keys back to the frame controls
    redraw();
  });

  function setNumbers(on) {
    showNumbers = on;
    numbersBox.checked = on;
    savePrefs();
    redraw();
  }
  numbersBox.checked = showNumbers;
  numbersBox.addEventListener('change', () => {
    setNumbers(numbersBox.checked);
    numbersBox.blur();
  });

  function setLines(on) {
    showLines = on;
    linesBox.checked = on;
    savePrefs();
    redraw();
  }
  linesBox.checked = showLines;
  linesBox.addEventListener('change', () => {
    setLines(linesBox.checked);
    linesBox.blur();
  });

  // --- minimising the panels -------------------------------------------------------------
  // The timing strip folds down to one line with the total; the side panel to a thin tab.
  // Either gives the board more room. The side panel opens while a template is being made:
  // its Save and Cancel are there.

  const timingSection = $('timing');
  const timingToggle = $('timing-toggle');
  const templatesPanel = $('templates');
  const templatesMin = $('templates-min');
  const templatesTab = $('templates-tab');

  function applyPanels() {
    const templatesSmall = prefs.templatesMin && !ed.makingTemplate;
    timingSection.classList.toggle('minimised', prefs.timingMin);
    timingToggle.querySelector('.arrow').textContent = prefs.timingMin ? '▸' : '▾';
    timingToggle.title = prefs.timingMin ? 'Show the timeline panel' : 'Minimise the timeline panel';
    timingToggle.setAttribute('aria-expanded', String(!prefs.timingMin));
    templatesPanel.classList.toggle('minimised', templatesSmall);
    templatesTab.setAttribute('aria-expanded', String(!templatesSmall));
  }

  function setMinimised(name, minimised) {
    prefs[name] = minimised;
    applyPanels();
    savePrefs();
    redraw();
  }
  timingToggle.addEventListener('click', () => {
    setMinimised('timingMin', !prefs.timingMin);
    timingToggle.blur();
  });
  templatesMin.addEventListener('click', () => setMinimised('templatesMin', true));
  templatesTab.addEventListener('click', () => {
    setMinimised('templatesMin', false);
    templatesTab.blur();
  });

  // Shortcut hints: Cmd on a Mac, Ctrl elsewhere.
  if (!/Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent)) {
    for (const k of document.querySelectorAll('kbd[data-pc]')) k.textContent = k.dataset.pc;
  }

  renderTemplates();
  applyPanels();
  setChartView(prefs.chart);
  setTab(prefs.tab);
  root.OD.app = { editor: ed, board, chart, timeline, redraw, save, exportFrames, templates: () => myTemplates }; // for the console
  paint(); // the first picture straight away, not at the next animation frame
})(globalThis);
