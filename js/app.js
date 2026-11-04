/* Connects the page to the editor and the views: the board (mouse, touch, wheel, keys), file
 * dialogs, the timing strip and its chart, the actions and templates panel, and the bottom bar. */
(function (root) {
  'use strict';

  const { layout, jsonio, templates, project: projects } = root.OD;
  const { Editor } = root.OD.editor;
  const { BoardView, dropletColour } = root.OD.view;
  const { TimingChart, formatTime } = root.OD.chart;
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
    timingMin: false, templatesMin: false, chart: 'step', lines: true, tab: 'actions',
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
    showActions();
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

  svg.addEventListener('pointerdown', (evt) => {
    if (evt.button !== 0 || !evt.isPrimary) return;
    evt.preventDefault();
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    const { mx, my } = toGrid(evt);
    const action = ed.pointerDown(mx, my, { shift: evt.shiftKey, now: performance.now() });
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
    showNotice();
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
      clearDraftStatus(`${done.reshaped ? 'Reshaped' : 'Moved'} “${done.name}”`);
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
      // Option/Alt + arrow keys move the selected action one electrode.
      if (ed.nudge(...NUDGE[key])) setStatus(`Moved ${quote(ed.selected)}`);
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
  const legend = $('chart-legend');
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
    if (prefs.timingMin) return; // the chart is folded away
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
  function setChartView(view) {
    prefs.chart = ['step', 'total', 'table'].includes(view) ? view : 'step';
    for (const b of viewButtons) b.setAttribute('aria-pressed', String(b.dataset.view === prefs.chart));
    legend.style.visibility = prefs.chart === 'step' ? '' : 'hidden';
    chart.setMode(prefs.chart);
    savePrefs();
  }
  for (const b of viewButtons) {
    b.addEventListener('click', () => {
      setChartView(b.dataset.view);
      b.blur();
    });
  }

  // --- actions panel ---------------------------------------------------------------------

  const KIND = { path: 'Path', template: 'Template', dispense: 'Dispense', pattern: 'Pattern' };
  const actionList = $('action-list');
  const actionFields = $('action-fields');
  const kindText = $('action-kind');
  const nameField = $('action-name');
  const dropletField = $('action-droplet');
  const stepField = $('action-step');
  const infoText = $('action-info');
  const dropletNames = $('droplet-names');
  let actionsKey = '';

  function showActions() {
    const { compiled, project } = ed;
    const rows = project.actions
      .map((a, index) => {
        const span = compiled.spans.get(a.id) || null;
        const before = a.after ? project.actions.find((x) => x.id === a.after) : null;
        return {
          id: a.id,
          name: a.name,
          droplet: a.droplet || '',
          type: a.type,
          span: span && [span.from, span.to],
          after: before ? before.name : null,
          problems: compiled.issues.filter((i) => i.id === a.id && i.kind !== 'waits').map((i) => i.text),
          index,
        };
      })
      .sort((p, q) => (p.span ? p.span[0] : 1e9) - (q.span ? q.span[0] : 1e9) || p.index - q.index);
    const key = JSON.stringify([rows, ed.selection]);
    if (key !== actionsKey) {
      actionsKey = key;
      actionList.replaceChildren(...rows.map(actionRow));
      $('no-actions').hidden = rows.length > 0;
      const names = [...new Set(project.actions.map((a) => a.droplet).filter(Boolean))];
      dropletNames.replaceChildren(...names.map((n) => new Option(n)));
    }
    showActionFields();
  }

  function actionRow(row) {
    const li = document.createElement('li');
    li.className = 'action' + (row.id === ed.selection ? ' selected' : '') + (row.problems.length ? ' problem' : '');
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.style.background = dropletColour(row.droplet);
    chip.title = row.droplet ? `Droplet: ${row.droplet}` : 'No droplet name';
    const text = document.createElement('div');
    text.className = 'text';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = row.name; // names come from files: text only
    const meta = document.createElement('div');
    meta.className = 'meta';
    const parts = [KIND[row.type] || row.type];
    if (row.span) parts.push(row.span[0] === row.span[1] ? `frame ${row.span[0]}` : `frames ${row.span[0]}–${row.span[1]}`);
    if (row.after) parts.push(`after ${row.after}`);
    if (row.droplet) parts.push(row.droplet);
    meta.textContent = parts.join(' · ');
    text.append(name, meta);
    for (const p of row.problems) {
      const div = document.createElement('div');
      div.className = 'problem-text';
      div.textContent = p;
      text.appendChild(div);
    }
    li.append(chip, text, iconButton('×', 'Delete it', () => {
      ed.select(row.id);
      deleteSelected();
    }));
    li.addEventListener('click', (evt) => {
      if (evt.target.closest('button')) return;
      ed.select(row.id);
      if (row.span && !ed.playing) ed.frame = row.span[0];
      redraw();
    });
    return li;
  }

  function showActionFields() {
    const a = ed.selected;
    actionFields.hidden = !a;
    if (!a) return;
    const span = ed.span(a.id);
    kindText.textContent = `${KIND[a.type] || a.type}${span ? ` · frames ${span.from}–${span.to}` : ''}`;
    if (document.activeElement !== nameField) nameField.value = a.name;
    if (document.activeElement !== dropletField) dropletField.value = a.droplet || '';
    if (document.activeElement !== stepField) stepField.value = a.stepTime ? seconds(a.stepTime) : '';
    stepField.placeholder = `${seconds(ed.project.frameTime)} (default)`;
    const notes = ed.issuesOf(a.id).filter((i) => i.kind !== 'waits').map((i) => i.text);
    if (a.split) notes.push('Its long steps stretch over frames, so the others keep moving');
    if (a.type === 'dispense') notes.push('A dispense stays at its reservoir');
    infoText.textContent = notes.join('. ');
  }

  nameField.addEventListener('change', () => {
    const a = ed.selected;
    if (a && ed.rename(a.id, nameField.value)) setStatus(`Renamed to ${quote(a)}`);
    redraw();
  });
  dropletField.addEventListener('change', () => {
    const a = ed.selected;
    if (a && ed.setDroplet(a.id, dropletField.value)) setStatus(a.droplet ? `${quote(a)} moves the droplet “${a.droplet}”` : `${quote(a)} has no droplet name`);
    redraw();
  });
  stepField.addEventListener('change', () => {
    const a = ed.selected;
    if (!a) return;
    const ms = stepField.value.trim() === '' ? 0 : readSeconds(stepField);
    if (ms === null) setStatus('Times are in seconds, more than 0', 'warn');
    else if (ed.setStepTime(a.id, ms)) setStatus(ms ? `Each step of ${quote(a)} lasts ${formatTime(a.stepTime)}` : `${quote(a)} uses the default frame time`);
    stepField.value = a.stepTime ? seconds(a.stepTime) : '';
    redraw();
  });
  for (const input of [nameField, dropletField, stepField]) editKeys(input);
  $('action-delete').addEventListener('click', (evt) => {
    evt.currentTarget.blur();
    deleteSelected();
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
        spot.fits
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
    prefs.tab = tab === 'templates' ? 'templates' : 'actions';
    for (const b of tabButtons) b.setAttribute('aria-selected', String(b.dataset.tab === prefs.tab));
    $('actions').hidden = prefs.tab !== 'actions';
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
    timingToggle.title = prefs.timingMin ? 'Show the timing panel' : 'Minimise the timing panel';
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
  root.OD.app = { editor: ed, board, chart, save, exportFrames, templates: () => myTemplates }; // for the console
  paint(); // the first picture straight away, not at the next animation frame
})(globalThis);
