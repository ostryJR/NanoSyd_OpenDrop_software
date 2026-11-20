/* Connects the page to the editor and the views: the board (mouse, touch, wheel, keys), file
 * dialogs, the timing strip and its chart, the actions and templates panel, and the bottom bar. */
(function (root) {
  'use strict';

  const { layout, jsonio, templates, project: projects } = root.OD;
  const { Editor } = root.OD.editor;
  const { BoardView, dropletColour } = root.OD.view;
  const { TimingChart, formatTime } = root.OD.chart;
  const { TempChart } = root.OD.tempChart;
  const heat = root.OD.heat;
  const { Timeline } = root.OD.timeline;
  const { DevicePanel } = root.OD.devicePanel;
  const P = root.OD.process;
  const { ProcessView } = root.OD.processView;
  const { ProcessPanel, ask: askRun, renderLog } = root.OD.processPanel;
  const { Runner } = root.OD.runner;
  const { TabSync } = root.OD.sync;
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

  // Layout, overlays, drag tool, minimised panels, panel tab, chart view and the device settings
  // (reconnecting, the port, temperature targets) are remembered between visits.
  const PREFS_KEY = 'opendrop-generator.prefs';
  const stored = readStored(PREFS_KEY, {});
  const prefs = {
    timingMin: false, templatesMin: false, chart: 'timeline', lines: true, tab: 'properties',
    ...(stored && typeof stored === 'object' ? stored : {}),
  };
  if (!prefs.device || typeof prefs.device !== 'object' || Array.isArray(prefs.device)) prefs.device = {};
  const savePrefs = () => {
    try {
      const { timingMin, templatesMin, chart: chartView, tab, device: dev, view: shown, timelineHeight } = prefs;
      localStorage.setItem(
        PREFS_KEY,
        JSON.stringify({ layout: current.id, numbers: showNumbers, lines: showLines, tool: ed.tool, timingMin, templatesMin, chart: chartView, tab, device: dev, view: shown, timelineHeight })
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
  let device = null; // the Device tab and the board's device boxes, set up at the end

  // The process view (tiles of the process, in the board's place), its side panel, runs, and a
  // second tab kept in step: set up at the end.
  let view = /process/.test(location.hash) ? 'process' : /board/.test(location.hash) ? 'board' : prefs.view === 'process' ? 'process' : 'board';
  let processView = null;
  let processPanel = null;
  let runner = null;
  let sync = null;
  let syncRev = -1;
  let remoteRun = null; // a run going on in another tab: { tile, stretch, frame, frames, done }
  let pendingRemote = null; // a change from another tab, waiting for a drag or run to end
  let placingTile = null; // a tile whose template is being placed from its Properties
  let selectedTile = null;
  let analysisRev = -1;
  let analysisCache = null;
  // The process on the board: stretches, droplets coming in, each tile's frames (worked out again
  // after each change).
  const analysis = () => {
    if (!ed.doc.process) return null;
    if (analysisRev !== ed.revision) {
      analysisCache = ed.analyze();
      analysisRev = ed.revision;
    }
    return analysisCache;
  };

  function setStatus(text, kind = 'info') {
    statusText.textContent = text;
    statusText.title = text; // whole on hover, if it is cut short
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

  // While a run is going (here or in another tab) nothing in the project changes: says so, true.
  function refused() {
    return ed.refused() && showNotice();
  }

  // While a path is being drawn, the status line counts its steps.
  let draftInStatus = false;
  function showDraft(draft) {
    const limit = draft.limited ? ` (stopped at frame ${OD.model.MAX_FRAMES})` : '';
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
  // A hidden tab gets no animation frames, so there the background clock (js/clock.js) takes
  // over: playing, a run and the device's frames go on while another window is in front.
  let frameRequested = false;
  function redraw() {
    if (frameRequested) return;
    frameRequested = true;
    const draw = () => {
      frameRequested = false;
      ed.tick(performance.now());
      paint();
      if (ed.playing) redraw();
    };
    if (document.hidden) OD.clock.timers().setTimeout(draw, 20);
    else requestAnimationFrame(draw);
  }

  function paint() {
    if (pendingRemote && !ed.makingTemplate && ed.applyRemote(pendingRemote)) {
      pendingRemote = null;
      if (sync) sync.settle(ed.doc);
      syncRev = ed.revision;
    }
    svg.classList.toggle('running', Boolean(ed.readOnly)); // a run is going: its red frame greyed a bit
    if (view === 'board') {
      board.render(ed, { numbers: showNumbers, lines: showLines, device: device && device.boardState(), rings: rings(), heat: heatInfo(), frameOffset: offset() });
    } else if (processView) processView.render();
    if (ed.draft && ed.draft.moved) showDraft(ed.draft);
    showTiming();
    showProperties();
    if (ed.makingTemplate) showMakerInfo();
    if (device) device.paint(); // live: the frame on screen goes to the device
    sendProjectHV();
    noteReading();
    showViewbar();
    showReadOnly();
    noteWork();
    shareWork();
  }

  // While a run is going, the fields and buttons that change the project are greyed out (the
  // editor refuses changes anyway; this says so before they are tried). Properties are filled in
  // anew as the selection changes, so they are gone over at every paint.
  const EDITING = '#props input, #props select, #props button, #time-default, #hv-volts, #hv-hz, #hv-mode, #rate-up, #rate-down, #add-file, #layout, #template-new';
  let shownReadOnly = null;
  function showReadOnly() {
    const why = ed.readOnly;
    if (!why && !shownReadOnly) return;
    for (const el of document.querySelectorAll(EDITING)) {
      if (why) {
        if (!('wasTitle' in el.dataset)) el.dataset.wasTitle = el.title;
        el.disabled = true;
        el.title = why;
      } else if ('wasTitle' in el.dataset) {
        el.disabled = false;
        el.title = el.dataset.wasTitle;
        delete el.dataset.wasTitle;
      }
    }
    shownReadOnly = why;
    document.body.classList.toggle('read-only', Boolean(why));
  }

  // The heaters and magnets in the frame on screen, for the strip under the board: shown once the
  // project sets any, or a device with a temperature adapter is connected.
  function heatInfo() {
    const c = ed.controlsAt(ed.frame);
    const s = device && device.session;
    const adapter = Boolean(s && s.connected && s.board && s.board.temperature);
    const used = ed.doc.actions.some((a) => a.type === 'temp' || a.type === 'magnet' || a.type === 'message') || heat.usesControls(c);
    const hold = ed.holding || (runner && runner.state && !runner.state.done && runner.state.heating) || null;
    const hereHold = ed.seq.holds.get(ed.frame);
    return {
      show: used || adapter,
      targets: c.targets,
      magnets: c.magnets,
      message: typeof c.message === 'string' ? c.message : null,
      temps: adapter ? s.temps.slice() : null,
      tolerance: hereHold ? hereHold.tolerance : heat.DEFAULT_TOLERANCE,
      waiting: hold ? { targets: hold.targets } : null,
    };
  }

  // A change here goes to the other tabs (also from a timer: a tab that isn't in front doesn't
  // paint).
  function shareWork() {
    if (sync && syncRev !== ed.revision && !ed.makingTemplate && !ed.dragging) {
      syncRev = ed.revision;
      sync.changed(ed.doc);
    }
  }

  const openTile = () => (ed.doc.process && ed.scope && ed.scope.tile ? P.tileById(ed.doc.process, ed.scope.tile) : null);
  const openTileName = () => {
    const t = openTile();
    return t ? t.name || P.KINDS[t.kind].name : '';
  };

  // Rings where a droplet waits on an electrode that isn't switched on in the frame on screen: left
  // there by an action, or coming in from the step before.
  function rings() {
    const c = ed.shown;
    const f = ed.frame;
    const byId = new Map([...ed.arrive, ...ed.project.actions].map((a) => [a.id, a]));
    const out = [];
    const seen = new Set();
    const add = (id, cells) => {
      const a = byId.get(id);
      for (const e of cells) {
        if (e >= 128 || c.seq.get(e, f) || seen.has(e)) continue;
        seen.add(e);
        out.push({ e, colour: dropletColour(a ? a.droplet : '') });
      }
    };
    for (const r of c.resting) if (r.from <= f && f <= r.to) add(r.id, r.cells);
    if (f === 1) for (const a of ed.arrive) add(a.id, a.cells);
    return out;
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
    if (!showNotice()) clearDraftStatus(drawing ? 'Cancelled' : ''); // whatever the status said may no longer be true
    redraw();
  }

  function deleteSelected() {
    const a = ed.selected;
    if (a && ed.deleteSelected()) setStatus(`Deleted ${quote(a)}`);
    else showNotice();
    redraw();
  }

  // --- board: mouse / touch --------------------------------------------------------------

  function toGrid(evt) {
    const p = new DOMPoint(evt.clientX, evt.clientY).matrixTransform(svg.getScreenCTM().inverse());
    return { mx: (p.x - G.CX) / G.UNIT, my: (p.y - G.CY) / G.UNIT };
  }

  // Actions that open a browser dialog (a file).
  const DIALOGS = {
    save: () => save(),
    load: () => {
      if (refused()) return;
      fileInput.click();
    },
    export: () => exportFrames(),
  };
  let pendingDialog = null;
  const MAC = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);

  svg.addEventListener('pointerdown', (evt) => {
    if (evt.button !== 0 || !evt.isPrimary) return;
    if (MAC && evt.ctrlKey) return; // a right-click on a Mac: nothing to do
    evt.preventDefault();
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    const { mx, my } = toGrid(evt);
    if (placingTile && ed.placement && !carried) {
      // A tile's template, placed from its Properties: a click drops it where it shows.
      ed.hoverPlacement(mx, my);
      const spot = ed.placement && ed.placement.spot;
      const added = ed.dropPlacement();
      placingTile = null;
      if (added) setStatus(`Placed: frames ${added.from} to ${added.to}`);
      else setStatus(spot && spot.reason ? `It can't go there: ${spot.reason}` : "It doesn't fit there: place it again from the tile's Properties", 'warn');
      redraw();
      return;
    }
    const action = ed.pointerDown(mx, my, { shift: evt.shiftKey, alt: evt.altKey, now: performance.now() });
    if (DIALOGS[action]) {
      // Browsers only open file dialogs during a user gesture: a mouse press counts,
      // a touch only once the finger lifts.
      if (evt.pointerType === 'mouse') DIALOGS[action]();
      else pendingDialog = action;
    } else if (action === 'live' || action === 'feedback') {
      device.action(action);
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
    if (placingTile && ed.placement && !carried) {
      ed.hoverPlacement(mx, my);
      redraw();
      return;
    }
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
      showNotice(); // a run is going: frames can't be scrolled through
      redraw();
    },
    { passive: false }
  );

  // --- keyboard --------------------------------------------------------------------------

  const NUDGE = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

  window.addEventListener('keydown', (evt) => {
    if (evt.target instanceof HTMLInputElement || evt.target instanceof HTMLSelectElement) return;
    const key = evt.key.length === 1 ? evt.key.toLowerCase() : evt.key;
    if (placingTile && ed.placement) {
      // Placing a tile's template: R turns it, Esc stops.
      if (key === 'r' && !evt.repeat) ed.rotatePlacement();
      if (key === 'Escape') {
        ed.cancel();
        placingTile = null;
        setStatus('Cancelled');
      }
      evt.preventDefault();
      redraw();
      return;
    }
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
    if (view === 'process') {
      // The process view has keys of its own: Delete, Enter, Esc, arrows.
      if (processView && processView.key(evt)) {
        evt.preventDefault();
        redraw();
      }
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
        showNotice();
        break;
      case 'ArrowLeft':
        ed.prevFrame();
        showNotice();
        break;
      case ' ':
        if (!evt.repeat) ed.togglePlay(performance.now());
        showNotice();
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
  const withProject = (name) => (/\.(odproj|json)$/i.test(name) ? name : `${name}${projects.EXTENSION}`);
  const baseOf = (name) => name.replace(/\.odproj\.json$/i, '').replace(/\.(odproj|json)$/i, '');

  // Saves text with the browser's save dialog, or (Safari, Firefox) asks for a name and
  // downloads it. Returns the file name, or null if cancelled or failed (the status says why).
  async function saveText(text, suggested, description, fixName = withJson, ext = '.json') {
    if (typeof root.showSaveFilePicker === 'function') {
      let handle;
      try {
        handle = await root.showSaveFilePicker({
          suggestedName: suggested,
          types: [{ description, accept: { 'application/json': [ext] } }],
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
    ed.flush();
    const name = await saveText(projects.serialize(ed.doc), suggested, 'OpenDrop Generator project', withProject, projects.EXTENSION);
    if (!name) return;
    if (!ed.makingTemplate) baseName = baseOf(name);
    setStatus(`Saved ${name} (${plural(ed.doc.actions.length, 'action')}${ed.doc.process ? `, ${plural(ed.doc.process.tiles.length, 'tile')}` : ''})`);
  }

  // Export writes the frames for the OpenDrop controller. If some actions won't come out as
  // drawn, the first press says so and a second one (within 10 s) exports anyway.
  let exportWarnedAt = null;
  async function exportFrames() {
    const problems = ed.compiled.issues;
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
    const part = ed.doc.process && openTile() ? `: “${openTileName()}” and what runs with it on its board (a process with decisions can't be one file; run it from here instead)` : '';
    const n = ed.seq.lastFrame();
    const long = n > OD.model.ORIGINAL_FRAMES;
    if (name) {
      setStatus(
        long
          ? `Exported ${name} (${plural(n, 'frame')}). The original OpenDrop controller and “upload for later” read only the first ${OD.model.ORIGINAL_FRAMES}; play it live from here to use them all${part}`
          : `Exported ${name} (${plural(n, 'frame')}) for the OpenDrop controller${part}`,
        long ? 'warn' : undefined
      );
    }
  }

  function switchLayout(lay) {
    if (!ed.setLayout(lay)) {
      layoutSelect.value = current.id;
      showNotice();
      return false;
    }
    current = lay;
    board.setLayout(lay);
    layoutSelect.value = lay.id;
    savePrefs();
    return true;
  }

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    fileInput.value = ''; // so choosing the same file again still triggers a load
    if (!file || refused()) return;
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
  const frameNo = $('time-frame-no');
  const totalText = $('time-total');
  const seconds = (ms) => String(+(ms / 1000).toFixed(3));

  const chart = new TimingChart($('chart'), {
    onPick(step) {
      if (ed.dragging || ed.placement) return;
      goToFrame(step);
      redraw();
    },
  });

  function showTiming() {
    const { seq } = ed;
    if (document.activeElement !== defaultInput) defaultInput.value = seconds(seq.frameTime);
    showHV();
    const off = offset();
    frameNo.textContent = off + ed.frame;
    // With a process: the whole of it, along the way the timeline shows.
    const w = whole();
    const shown = w && boardPart() ? w.compiled.seq : seq;
    const last = shown.lastFrame();
    const short = w && w.ended === 'stuck' ? ' (it stops short: an arrow goes nowhere)' : w && w.ended === 'cut' ? ' (cut short: too long)' : '';
    totalText.textContent = `Total ${formatTime(shown.elapsed(last))} over ${plural(last, 'frame')}${short}`;
    if (prefs.timingMin) return; // the chart and timeline are folded away
    if (prefs.chart === 'timeline') {
      showTimeline();
      return;
    }
    if (prefs.chart === 'temp') {
      showTemps();
      return;
    }
    const times = [];
    const own = [];
    for (let f = 1; f <= Math.max(last, off + ed.frame); f++) {
      times.push(shown.timeOf(f));
      own.push(shown.times[f] > 0);
    }
    chart.update({ times, own, current: off + ed.frame });
  }

  const readSeconds = (input) => {
    const s = parseFloat(input.value);
    return Number.isFinite(s) && s > 0 ? s * 1000 : null;
  };

  defaultInput.addEventListener('change', () => {
    const ms = readSeconds(defaultInput);
    if (ms) {
      if (ed.setDefaultTime(ms)) setStatus(`Frame time: ${formatTime(ed.seq.frameTime)}`);
      else showNotice();
    } else {
      setStatus('The frame time is in seconds, more than 0', 'warn');
    }
    defaultInput.value = seconds(ed.seq.frameTime); // shows a clamped value, or undoes a bad one
    redraw();
  });

  // The project's high voltage, beside the frame time: empty = the device's own setting.
  const hvInputs = { volts: $('hv-volts'), hz: $('hv-hz'), mode: $('hv-mode') };
  function showHV() {
    const hv = ed.project.hv || {};
    for (const [key, input] of Object.entries(hvInputs)) {
      if (document.activeElement !== input) input.value = hv[key] === null || hv[key] === undefined ? '' : String(hv[key]);
    }
    if (!ed.readOnly) hvInputs.hz.disabled = hv.mode === 'dc'; // DC has no frequency
  }
  const hvText = (hv) =>
    hv ? [hv.volts ? `${hv.volts} V` : '', hv.mode ? hv.mode.toUpperCase() : '', hv.hz && hv.mode !== 'dc' ? `${hv.hz} Hz` : ''].filter(Boolean).join(', ') : '';
  for (const [key, input] of Object.entries(hvInputs)) {
    input.addEventListener('change', () => {
      const v = input.value.trim();
      if (!ed.setHV({ [key]: v === '' ? null : key === 'mode' ? v : Number(v) })) showNotice();
      else setStatus(ed.project.hv ? `High voltage for this project: ${hvText(ed.project.hv)}` : 'High voltage: the device keeps its own settings');
      showHV(); // shows a clamped value, or undoes a refused one
      redraw();
    });
  }

  // A connected device gets the project's high voltage once when it connects, and again when the
  // project's changes (another project opened, a field changed). Ordinary frames leave it alone.
  let hvSent = null;
  function sendProjectHV() {
    const s = device && device.session;
    if (!s || s.state !== 'on' || s.run || typeof s.sendHV !== 'function') {
      if (!s || !s.connected) hvSent = null;
      return;
    }
    const hv = ed.project.hv || null;
    const key = JSON.stringify(hv);
    if (key === hvSent) return;
    hvSent = key;
    if (!hv) return; // nothing set: the device keeps its own
    s.sendHV(hv).then((r) => {
      if (r && r.ok) setStatus(`Sent to the device: ${hvText(hv)}`);
      else if (r) setStatus(`High voltage not sent: ${r.reason} (it goes again when the device reconnects or the setting changes)`, 'warn');
    });
  }

  // Enter keeps the value and gives the keys back to the board; Esc puts the old value back.
  function editKeys(input) {
    input.addEventListener('focus', () => (input.dataset.before = input.value));
    input.addEventListener('keydown', (evt) => {
      if (evt.key === 'Escape') input.value = input.dataset.before || '';
      if (evt.key === 'Enter' || evt.key === 'Escape') input.blur();
    });
  }
  editKeys(defaultInput);
  for (const input of Object.values(hvInputs)) editKeys(input);

  const viewButtons = [...document.querySelectorAll('#timing .segmented button')];
  const chartBox = $('chart');
  const timelineBox = $('timeline');
  const tempBox = $('temp-box');
  function setChartView(view) {
    prefs.chart = view === 'step' || view === 'temp' ? view : 'timeline'; // older settings may say 'total' or 'table'
    for (const b of viewButtons) b.setAttribute('aria-pressed', String(b.dataset.view === prefs.chart));
    timelineBox.hidden = prefs.chart !== 'timeline';
    chartBox.hidden = prefs.chart !== 'step';
    tempBox.hidden = prefs.chart !== 'temp';
    savePrefs();
    redraw();
  }
  for (const b of viewButtons) {
    b.addEventListener('click', () => {
      setChartView(b.dataset.view);
      b.blur();
    });
  }

  // --- temperatures and magnets ------------------------------------------------------------
  // The Temperature view: heater targets, estimates and readings, and the magnets, against time;
  // clicking and dragging in it adds and changes temperature and magnet settings.

  const tempChart = new TempChart($('temp-chart'), {
    pick(f) {
      if (ed.frameHeld()) return showNotice();
      ed.frame = f;
      redraw();
    },
    select(id) {
      ed.select(id);
      redraw();
    },
    add(frame, i, t) {
      // A setting already starting in that frame gets the heater; otherwise a new one.
      const there = ed.project.actions.find((a) => a.type === 'temp' && ed.span(a.id) && ed.span(a.id).from === frame);
      if (there) {
        const targets = there.targets.slice();
        targets[i] = t;
        propChange(ed.setControl(there.id, { targets }), () => `${quote(there)}: T${i + 1} ${t} °C from frame ${frame}`);
        ed.select(there.id);
        return;
      }
      const targets = [null, null, null];
      targets[i] = t;
      const a = ed.addTemp(frame, { targets });
      if (a) setStatus(`T${i + 1} ${t} °C from frame ${frame}. Drag the point to change it; in Properties it can wait until the heater gets there`);
      else showNotice();
      redraw();
    },
    set(id, i, t) {
      const a = ed.action(id);
      if (!a) return;
      const targets = a.targets.slice();
      targets[i] = t;
      propChange(ed.setControl(id, { targets }), () => `${quote(a)}: T${i + 1} ${t} °C`);
    },
    move(id, frame) {
      if (ed.moveToFrame(id, frame)) setStatus(`${quote(ed.action(id))} from frame ${frame}`);
      else showNotice();
      redraw();
    },
    magnet(frame, n) {
      // Switching it where a switch of that magnet already is takes that switch away.
      const there = ed.project.actions.find((a) => a.type === 'magnet' && (a.magnet || 1) === n && ed.span(a.id) && ed.span(a.id).from === frame);
      if (there) {
        ed.select(there.id);
        if (ed.deleteSelected()) setStatus(`Magnet ${n}: the switch in frame ${frame} is gone`);
        redraw();
        return;
      }
      const on = !ed.controlsAt(frame).magnets[n - 1];
      const a = ed.addMagnet(frame, n, on);
      if (a) setStatus(`Magnet ${n} ${on ? 'on' : 'off'} from frame ${frame}`);
      else showNotice();
      redraw();
    },
  });
  for (const b of document.querySelectorAll('#temp-box [data-heater]')) {
    b.addEventListener('click', () => {
      const i = Number(b.dataset.heater);
      for (const x of document.querySelectorAll('#temp-box [data-heater]')) x.setAttribute('aria-pressed', String(x === b));
      tempChart.setHeater(i);
      b.blur();
    });
  }
  const rateUp = $('rate-up');
  const rateDown = $('rate-down');
  for (const [input, key] of [[rateUp, 'up'], [rateDown, 'down']]) {
    editKeys(input);
    input.addEventListener('change', () => {
      const v = Number(input.value);
      if (v > 0 && !ed.setHeatRates({ [key]: v })) showNotice();
      else if (v > 0) {
        setStatus(`The heaters are assumed to ${key === 'up' ? 'warm up' : 'cool down'} by ${heat.cleanRates(ed.project.heatRates)[key]} °C a minute`);
      } else setStatus('Rates are in °C per minute, more than 0', 'warn');
      redraw();
    });
  }

  // What a live device measured while frames were on screen: { ms from frame 1's start, temps }.
  let readings = [];
  let readingFrom = { frame: 0, at: 0 };
  function noteReading() {
    const temps = liveReadings();
    if (!temps) return;
    const now = performance.now();
    if (readingFrom.frame !== ed.frame) readingFrom = { frame: ed.frame, at: now };
    const seq = ed.seq;
    const ms = seq.elapsed(ed.frame - 1) + Math.min(seq.timeOf(ed.frame), now - readingFrom.at);
    const last = readings[readings.length - 1];
    if (last && last.ms === ms && JSON.stringify(last.temps) === JSON.stringify(temps)) return;
    if (last && ms < last.ms) readings = []; // back to the start: a new curve
    readings.push({ ms: Math.round(ms), temps: temps.map((t) => (typeof t === 'number' ? Math.round(t * 10) / 10 : null)) });
    if (readings.length > 3000) readings = readings.slice(-3000);
  }
  // The heaters' temperatures when a live device measures them, otherwise null.
  function liveReadings() {
    const s = device && device.session;
    if (!s || !s.live || !s.board || !s.board.temperature) return null;
    return s.temps.some((t) => typeof t === 'number') ? s.temps.slice() : null;
  }
  ed.readings = liveReadings;

  function showTemps() {
    const { seq, compiled } = ed;
    const frames = Math.max(1, seq.lastFrame(), ed.frame);
    const times = [];
    const controls = [];
    for (let f = 1; f <= frames; f++) {
      times.push(seq.timeOf(f));
      controls[f] = seq.controlsAt(f);
    }
    const spanFrom = (a) => (compiled.spans.get(a.id) || { from: a.start || 1 }).from;
    const holding = ed.holding ? [...seq.holds].find(([, h]) => h === ed.holding) : null;
    const runHeat = runner && runner.state && runner.state.heating;
    if (document.activeElement !== rateUp) rateUp.value = String(compiled.rates.up);
    if (document.activeElement !== rateDown) rateDown.value = String(compiled.rates.down);
    tempChart.update({
      frames,
      times,
      current: ed.frame,
      controls,
      start: ed.controlsIn ? heat.copyControls(ed.controlsIn) : heat.emptyControls(),
      holds: [...seq.holds].map(([frame, h]) => ({ frame, targets: h.targets })),
      points: ed.project.actions.filter((a) => a.type === 'temp').map((a) => ({ id: a.id, frame: spanFrom(a), targets: a.targets, wait: Boolean(a.wait), selected: a.id === ed.selection })),
      switches: ed.project.actions.filter((a) => a.type === 'magnet').map((a) => ({ id: a.id, frame: spanFrom(a), magnet: a.magnet || 1, on: a.on !== false, selected: a.id === ed.selection })),
      readings,
      rates: compiled.rates,
      holding: holding ? { frame: holding[0] } : runHeat ? { frame: runHeat.frame } : null,
    });
  }

  // One track per droplet, each action a clip; actions without a droplet name get a track each.
  const KIND = { path: 'Path', template: 'Template', dispense: 'Dispense', pattern: 'Pattern', wait: 'Wait', temp: 'Temperature', magnet: 'Magnet', message: 'Message' };
  // Heater, magnet and screen settings share a track each, under the droplets'.
  const controlTrack = (a) =>
    a.type === 'temp' ? ['c:heat', 'Heaters', '°C'] : a.type === 'magnet' ? [`c:m${a.magnet || 1}`, `Magnet ${a.magnet || 1}`, `M${a.magnet || 1}`] : a.type === 'message' ? ['c:screen', 'Screen', '▭'] : null;
  // --- the whole process on the timeline -------------------------------------------------
  // With a process, the timeline shows all of it: the stretches one after another along the way a
  // run goes on (stretch.route: on at every decision, Repeats all their rounds). The board edits
  // the stretch the frame on screen is in; its frame 1 is the whole timeline's frame offset() + 1.

  let wholeKey = '';
  let wholeRoute = null;
  let visit = null; // which time through the open stretch the board is at (a Repeat's rounds)

  function whole() {
    if (!ed.doc.process || ed.makingTemplate) return null;
    const key = `${ed.revision}|${ed.layout.id}`;
    if (key !== wholeKey) {
      wholeKey = key;
      wholeRoute = OD.schedule.route(ed.doc, ed.layout.rects);
    }
    return wholeRoute;
  }

  const playedParts = (w) => w.parts.filter((p) => p.kind === 'stretch' && p.to >= p.from);

  // The part of the whole process the board shows, or null (a step the way doesn't go through).
  function boardPart() {
    const w = whole();
    if (!w || !ed.scope || !ed.scope.stretch) return null;
    const mine = w.parts.filter((p) => p.kind === 'stretch' && p.stretch === ed.scope.stretch);
    return mine.find((p) => p.visit === visit) || mine[0] || null;
  }

  const offset = () => {
    const part = boardPart();
    return part ? part.from - 1 : 0;
  };

  // Opens `part` of the whole process on the board, at `tile` if that is in it, with the droplets,
  // heaters and magnets coming in as they come that time.
  function openPart(part, tile = null) {
    const keep = ed.scope && ed.scope.tile;
    const id = tile && part.tiles.includes(tile) ? tile : keep && part.tiles.includes(keep) ? keep : part.tile;
    if (!ed.openTile(id, { state: part.state, controls: part.controls, context: part.context })) return false;
    visit = part.visit;
    selectedTile = id;
    if (processPanel) processPanel.show(id);
    return true;
  }

  // Frame g of the whole timeline: the stretch it is in opens on the board.
  function goToFrame(g) {
    if (ed.frameHeld()) return showNotice(); // a run is going: the board follows it
    const w = whole();
    const here = boardPart();
    if (w && here && !ed.frozen) {
      const part = playedParts(w).find((p) => p.from <= g && g <= p.to);
      if (part && part.visit !== here.visit) openPart(part);
    }
    ed.frame = Math.max(1, g - offset());
  }

  // Opening a step any other way: the droplets, heaters and other lanes as the timeline has them.
  ed.contextOf = (sid) => {
    const w = whole();
    const mine = w ? w.parts.filter((p) => p.kind === 'stretch' && p.stretch === sid) : [];
    const part = mine.find((p) => p.visit === visit) || mine[0];
    return part ? { state: part.state, controls: part.controls, context: part.context } : null;
  };

  // Playing on from the end of a stretch into the next one (from the last, back to the first).
  ed.onPlayEnd = () => {
    const w = whole();
    const here = boardPart();
    if (!w || !here || ed.frozen) return false;
    const parts = playedParts(w);
    if (!parts.length || (parts.length === 1 && parts[0] === here)) return false;
    const next = parts[(parts.indexOf(here) + 1) % parts.length];
    if (!openPart(next)) return false;
    ed.frame = 1;
    return true;
  };

  // --- timeline --------------------------------------------------------------------------

  let otherClips = new Map(); // clip id -> { part, tile, of } for the clips of other stretches

  const timeline = new Timeline(timelineBox, {
    onSelect(id) {
      if (ed.dragging) return;
      const other = id && otherClips.get(id);
      if (other) {
        // Another stretch's clip: that stretch opens on the board, the action selected.
        if (ed.frozen || !openPart(other.part, other.tile)) return;
        ed.select(other.of);
        const span = ed.span(other.of);
        if (span) ed.frame = span.from;
        setStatus(`On the board: ${openTileName()}`);
        redraw();
        return;
      }
      ed.select(id);
      redraw();
    },
    onFrame(g) {
      if (ed.dragging || ed.placement) return;
      goToFrame(g);
      redraw();
    },
    onPreview(id, g) {
      const off = offset();
      const check = ed.previewTime(id, g - off);
      const span = check.valid ? check.compiled.spans.get(id) : null;
      return { valid: check.valid, reason: check.reason, from: span ? span.from + off : null, to: span ? span.to + off : null };
    },
    onMove(id, g) {
      ed.select(id);
      const off = offset();
      if (ed.moveToFrame(id, g - off)) {
        const span = ed.span(id);
        setStatus(`${quote(ed.action(id))}: frames ${span.from + off} to ${span.to + off}`);
      } else showNotice();
      redraw();
    },
    onReorder(keys) {
      if (ed.dragging) return;
      if (ed.setTrackOrder(keys)) setStatus('Track moved: the timeline keeps this order');
      else showNotice();
      redraw();
    },
    onTile(id, v) {
      if (ed.dragging || ed.frozen) return;
      const w = whole();
      const part = w && v !== undefined ? w.parts.find((p) => p.kind === 'stretch' && p.visit === v) : null;
      if (part ? openPart(part, id) : ed.openTile(id)) setStatus(`On the board: ${openTileName()}`);
      selectedTile = id;
      if (processPanel) processPanel.show(id);
      redraw();
    },
  });

  const preds = (a) => (a.after === undefined ? [] : Array.isArray(a.after) ? a.after : [a.after]);

  // Clips for `actions` as `compiled` has them, `shift` frames later.
  function clipsOf(actions, compiled, shift, extra) {
    const out = [];
    for (const a of actions) {
      // An action that can't run still gets a clip, one frame long where it would start, so it
      // can be found and fixed.
      let span = compiled.spans.get(a.id);
      const broken = !span;
      if (broken) {
        const ends = preds(a).map((id) => compiled.spans.get(id)).filter(Boolean).map((s) => s.to);
        const from = a.start || (ends.length ? Math.max(...ends) + (a.delay || 0) : 1);
        span = { from: Math.min(OD.model.MAX_FRAMES, from), to: Math.min(OD.model.MAX_FRAMES, from) };
      }
      const followers = actions.filter((b) => preds(b).includes(a.id));
      const problem = compiled.issues.filter((i) => i.id === a.id).map((i) => i.text).join('; ');
      const step = ed.tileOf(a); // a Step tile's actions show its name before their own
      out.push({
        id: a.id,
        name: step && !ed.namedByTile(a) ? `${step.name || P.KINDS[step.kind].name} · ${a.name}` : a.name,
        type: a.type,
        track: controlTrack(a) ? controlTrack(a)[0] : a.droplet ? `d:${a.droplet}` : `a:${a.id}`,
        trackName: controlTrack(a) ? controlTrack(a)[1] : a.droplet || a.name,
        trackShort: controlTrack(a) ? controlTrack(a)[2] : a.droplet ? projects.shortDroplet(a.droplet) : '',
        colour: dropletColour(a.droplet),
        from: span.from + shift,
        to: span.to + shift,
        problem: problem || null,
        broken,
        handIn: preds(a).some((id) => compiled.spans.get(id) && compiled.spans.get(id).to === span.from),
        handOut: followers.some((b) => compiled.spans.get(b.id) && compiled.spans.get(b.id).from === span.to),
        preds: preds(a),
        ...extra(a),
      });
    }
    return out;
  }

  // A band over a tile's frames, from the spans of its actions.
  function bandOf(t, spans, shift, fields) {
    if (!spans.length) return null;
    return { id: t.id, name: t.name || P.KINDS[t.kind].name, from: Math.min(...spans.map((x) => x.from)) + shift, to: Math.max(...spans.map((x) => x.to)) + shift, ...fields };
  }

  function showTimeline() {
    const { compiled, project } = ed;
    const opened = ed.scope && ed.scope.tile;
    const w = whole();
    const here = boardPart();
    const off = here ? here.from - 1 : 0;
    const clips = clipsOf(project.actions, compiled, off, (a) => ({ dim: Boolean(opened && a.tile !== opened), locked: Boolean(ed.readOnly) }));
    const bands = [];
    const stops = [];
    otherClips = new Map();
    if (w && here) {
      // The other stretches along the way, dimmed: a click opens one.
      const others = w.project.actions.filter((a) => a.visit !== here.visit);
      clips.push(...clipsOf(others, w.compiled, 0, () => ({ dim: true, locked: true })));
      const byVisit = new Map(w.parts.filter((p) => p.kind === 'stretch').map((p) => [p.visit, p]));
      for (const a of others) otherClips.set(a.id, { part: byVisit.get(a.visit), tile: a.tile, of: a.of });
      for (const part of w.parts) {
        if (part.kind !== 'stretch') {
          // Stops with no frames between them (an Ask and its decision) share one mark.
          const same = stops.find((x) => x.frame === part.frame);
          if (same) {
            same.text += ` → ${part.text}`;
            same.end = same.end || part.kind === 'end';
          } else stops.push({ frame: part.frame, text: part.text, end: part.kind === 'end' });
          continue;
        }
        const mine = part.visit === here.visit;
        for (const id of part.tiles) {
          const t = P.tileById(ed.doc.process, id);
          if (!t || !P.hasWork(t)) continue;
          const spans = mine
            ? project.actions.filter((a) => a.tile === id).map((a) => compiled.spans.get(a.id)).filter(Boolean)
            : w.project.actions.filter((a) => a.visit === part.visit && a.tile === id).map((a) => w.compiled.spans.get(a.id)).filter(Boolean);
          const band = bandOf(t, spans, mine ? off : 0, { visit: part.visit, open: mine && id === opened });
          if (band) bands.push(band);
        }
      }
    } else if (ed.doc.process && ed.scope) {
      // A step the way doesn't go through (a decision goes the other way): its stretch alone.
      for (const t of ed.doc.process.tiles) {
        if (!ed.scope.tiles.has(t.id) || !P.hasWork(t)) continue;
        const band = bandOf(t, project.actions.filter((a) => a.tile === t.id).map((a) => compiled.spans.get(a.id)).filter(Boolean), 0, { open: t.id === opened });
        if (band) bands.push(band);
      }
    }
    const last = clips.reduce((m, c) => Math.max(m, c.to), 0);
    const end = Math.max(last, ...stops.map((x) => x.frame));
    const frame = off + ed.frame;
    timeline.update({ frames: Math.min(OD.model.MAX_FRAMES, Math.max(30, end + 10, frame + 5)), frame, selection: ed.selection, clips, bands, stops, order: ed.doc.trackOrder || null });
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
  const sizeField = $('prop-size');
  const dirField = $('prop-dir');
  const lengthField = $('prop-length');
  const roundsField = $('prop-rounds');
  const framesField = $('prop-frames');
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

  let shownView = null;
  function showProperties() {
    const inProcess = view === 'process' && Boolean(ed.doc.process) && Boolean(processPanel);
    $('tile-props').hidden = !inProcess;
    if (shownView !== inProcess) {
      shownView = inProcess;
      propsKey = '';
    }
    if (inProcess) {
      propsNone.hidden = true;
      props.hidden = true;
      processPanel.render();
      return;
    }
    const a = ed.selected;
    if ((a && a.id) !== propsFor) {
      propsFor = a && a.id;
      afterDraft = null;
    }
    const span = a && ed.span(a.id);
    const key = JSON.stringify([a, span, ed.project.actions.map((x) => [x.id, x.name]), ed.compiled.issues.filter((i) => a && i.id === a.id), afterDraft, ed.tileOf(a)]);
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
    // With a process: an action of a tile that does one kind of thing goes by its tile's name
    // (renaming it renames the tile); a Step tile's actions have their own, in that step.
    const tile = ed.tileOf(a);
    const byTile = ed.namedByTile(a);
    keep(nameField, byTile ? tile.name || P.KINDS[tile.kind].name : a.name);
    show($('prop-tile'), Boolean(tile));
    $('prop-tile').textContent = !tile ? '' : byTile ? 'Named after its step in the process: renaming it here renames the step.' : `Part of the step “${tile.name || P.KINDS[tile.kind].name}” in the process.`;
    keep(dropletField, a.droplet || '');
    const short = projects.shortDroplet(a.droplet);
    $('prop-droplet-short').textContent = short && short !== a.droplet ? `· short ${short}` : '';
    dropletNames.replaceChildren(...[...new Set(ed.project.actions.map((x) => x.droplet).filter(Boolean))].map((n) => new Option(n)));

    // Starts: at a frame, or after other actions (and a delay).
    const preds = afterDraft || predsOf(a);
    const linked = preds.length > 0 || afterDraft !== null;
    if (document.activeElement !== startMode) startMode.value = linked ? 'after' : 'frame';
    show(startField, !linked);
    keep(startField, String(a.start || (span ? span.from : 1)));
    show(afterBox, linked);
    keep(delayField, String(a.delay || 0));
    $('prop-delay-time').textContent = linked && a.delay && span ? `(${formatTime(delayTime(span.from, a.delay))})` : '';
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

    // Heaters and magnets have no droplet, no steps of their own and nothing to turn.
    const control = a.type === 'temp' || a.type === 'magnet' || a.type === 'message';
    show(dropletField.closest('.field'), !control && a.type !== 'wait');
    show($('prop-temps-row'), a.type === 'temp');
    show($('prop-heatwait-row'), a.type === 'temp');
    show($('prop-tolerance-row'), a.type === 'temp' && Boolean(a.wait));
    show($('prop-magnet-row'), a.type === 'magnet');
    show($('prop-message-row'), a.type === 'message');
    if (a.type === 'message') {
      keep($('prop-message'), a.text || '');
      $('prop-message-count').textContent = `${$('prop-message').value.length} / ${heat.MESSAGE_LENGTH}`;
    }
    if (a.type === 'temp') {
      a.targets.forEach((t, i) => keep(heaterFields[i], t === null ? '' : String(t)));
      $('prop-heatwait').checked = Boolean(a.wait);
      keep($('prop-tolerance'), String(a.tolerance || heat.DEFAULT_TOLERANCE));
    }
    if (a.type === 'magnet') {
      $('prop-magnet').value = String(a.magnet || 1);
      $('prop-magnet-on').value = a.on === false ? 'off' : 'on';
    }
    show($('prop-turn'), !['dispense', 'wait', 'temp', 'magnet', 'message'].includes(a.type));
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
    const notes = ed.issuesOf(a.id).map((i) => i.text);
    if (a.type === 'temp' && a.wait && span) notes.push(`without a device it is estimated to take ${formatTime(ed.seq.elapsed(span.to) - ed.seq.elapsed(span.from - 1))}; live, the frame lasts until the heaters get there`);
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

  // Heaters and magnets.
  const heaterFields = [$('prop-t1'), $('prop-t2'), $('prop-t3')];
  heaterFields.forEach((input, i) => {
    editKeys(input);
    input.addEventListener('change', () => {
      const a = ed.selected;
      if (!a || a.type !== 'temp') return;
      const v = input.value.trim();
      const targets = a.targets.slice();
      targets[i] = v === '' ? null : heat.clampTemp(Number(v));
      if (v !== '' && !Number.isFinite(Number(v))) return;
      propChange(ed.setControl(a.id, { targets }), () => `${quote(a)}: ${heat.targetsText(targets)}`);
    });
  });
  $('prop-heatwait').addEventListener('change', (evt) => {
    const a = ed.selected;
    if (a && a.type === 'temp') propChange(ed.setControl(a.id, { wait: evt.target.checked }), () => (evt.target.checked ? `${quote(a)} waits until the heaters get there` : `${quote(a)} doesn't wait`));
  });
  editKeys($('prop-tolerance'));
  $('prop-tolerance').addEventListener('change', (evt) => {
    const a = ed.selected;
    const v = Number(evt.target.value);
    if (a && a.type === 'temp' && v > 0) propChange(ed.setControl(a.id, { tolerance: v }), () => `${quote(a)}: close enough within ${heat.cleanTolerance(v)} °C`);
  });
  $('prop-magnet').addEventListener('change', (evt) => {
    const a = ed.selected;
    if (a && a.type === 'magnet') propChange(ed.setControl(a.id, { magnet: Number(evt.target.value) }), () => `${quote(a)} switches magnet ${evt.target.value}`);
  });
  editKeys($('prop-message'));
  $('prop-message').addEventListener('input', (evt) => ($('prop-message-count').textContent = `${evt.target.value.length} / ${heat.MESSAGE_LENGTH}`));
  $('prop-message').addEventListener('change', (evt) => {
    const a = ed.selected;
    if (!a || a.type !== 'message') return;
    const text = heat.cleanText(evt.target.value);
    propChange(ed.setControl(a.id, { text }), () => (text ? `${quote(a)} shows “${text}” on the device's screen` : `${quote(a)} clears the device's screen`));
  });
  $('prop-magnet-on').addEventListener('change', (evt) => {
    const a = ed.selected;
    if (a && a.type === 'magnet') propChange(ed.setControl(a.id, { on: evt.target.value === 'on' }), () => `${quote(a)} switches it ${evt.target.value}`);
  });

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
  // How long the `delay` frames before frame `from` take.
  const delayTime = (from, delay) => ed.seq.elapsed(from - 1) - ed.seq.elapsed(Math.max(0, from - 1 - delay));
  delayField.addEventListener('change', () => {
    const a = ed.selected;
    const preds = a ? predsOf(a) : [];
    if (preds.length) propChange(ed.setAfter(a.id, preds, Math.max(0, Math.round(Number(delayField.value) || 0))), () => {
      const d = ed.action(a.id).delay || 0;
      const span = ed.span(a.id);
      return `${quote(a)} waits ${plural(d, 'frame')}${d && span ? ` (${formatTime(delayTime(span.from, d))})` : ''} first`;
    });
  });
  $('prop-after-add').addEventListener('click', () => {
    const a = ed.selected;
    if (!a) return;
    afterDraft = [...predsOf(a), ''];
    propsKey = '';
    redraw();
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
  for (const input of [nameField, dropletField, startField, delayField, lengthField, roundsField, framesField]) editKeys(input);
  $('prop-delete').addEventListener('click', (evt) => {
    evt.currentTarget.blur();
    deleteSelected();
  });

  // --- adding a file ---------------------------------------------------------------------

  const addFileInput = $('add-file-input');
  $('add-file').addEventListener('click', (evt) => {
    evt.currentTarget.blur();
    if (refused()) return;
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
    steps.textContent = plural(templates.stepsOf(t), 'step');
    text.append(name, steps);
    li.append(miniPreview(t), text);
    li.append(iconButton('✎', t.builtIn ? 'Copy it to change' : 'Change it', () => openMaker(t)));
    if (!t.builtIn) li.append(iconButton('×', 'Delete it', () => deleteTemplate(t)));
    li.addEventListener('pointerdown', (evt) => startTemplateDrag(evt, t, li));
    return li;
  }

  function renderTemplates() {
    $('my-templates').replaceChildren(...myTemplates.map(templateCard));
    // Built in: a heading for each group (merge and split, mixers), its templates below.
    $('builtin-templates').replaceChildren(
      ...templates.GROUPS.flatMap((group) => {
        const heading = document.createElement('h4');
        heading.className = 'template-group';
        heading.textContent = group;
        const list = document.createElement('ul');
        list.className = 'template-list';
        list.append(...templates.BUILT_IN.filter((t) => t.group === group).map(templateCard));
        return [heading, list];
      })
    );
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
    if (evt.button !== 0 || !evt.isPrimary || evt.target.closest('button') || ed.makingTemplate || refused()) return;
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
            ? `“${t.name}” would run past frame ${OD.model.MAX_FRAMES} if it started in frame ${spot.frame}`
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
    if (!ed.startTemplate(t ? templates.toSequence(t) : null)) {
      showNotice();
      return;
    }
    editing = t && !t.builtIn ? t : null;
    nameInput.value = t ? (t.builtIn ? `${t.name} (copy)` : t.name) : `Template ${myTemplates.length + 1}`;
    makerTitle.textContent = editing ? 'Change the template' : t ? 'Copy of a built-in template' : 'New template';
    showMaker();
    setStatus('Making a template: draw it on the array, then press Save template');
    redraw();
  }

  // The maker panel in place of the side panel (the editor is already making a template).
  function showMaker() {
    panel.hidden = true;
    maker.hidden = false;
    applyPanels();
  }

  function closeMaker() {
    ed.endTemplate();
    editing = null;
    panel.hidden = false;
    maker.hidden = true;
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
    if (editing) Object.assign(editing, { name: t.name, frames: t.frames });
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
    prefs.tab = ['templates', 'device'].includes(tab) ? tab : 'properties';
    for (const b of tabButtons) b.setAttribute('aria-selected', String(b.dataset.tab === prefs.tab));
    $('properties').hidden = prefs.tab !== 'properties';
    library.hidden = prefs.tab !== 'templates';
    $('device').hidden = prefs.tab !== 'device';
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

  // The timeline's height (the chart's too): drag the panel's top edge, or focus it and use the
  // arrow keys; double-click it for the usual height. Kept between visits.
  const resizeEdge = $('timing-resize');
  resizeEdge.tabIndex = 0;
  function setTimelineHeight(px) {
    const max = Math.max(120, Math.round(root.innerHeight * 0.7));
    const h = Number.isFinite(px) ? Math.round(Math.min(max, Math.max(80, px))) : null;
    if (h) timingSection.style.setProperty('--timeline-h', `${h}px`);
    else timingSection.style.removeProperty('--timeline-h');
    prefs.timelineHeight = h;
  }
  const timelineHeight = () => ['timeline', 'chart', 'temp-box'].map($).find((x) => !x.hidden).offsetHeight || 168;
  let resizing = null;
  resizeEdge.addEventListener('pointerdown', (evt) => {
    if (evt.button !== 0) return;
    evt.preventDefault();
    resizeEdge.setPointerCapture(evt.pointerId);
    resizing = { y: evt.clientY, h: timelineHeight() };
    resizeEdge.classList.add('dragging');
  });
  resizeEdge.addEventListener('pointermove', (evt) => {
    if (resizing) setTimelineHeight(resizing.h + (resizing.y - evt.clientY));
  });
  const endResize = () => {
    if (!resizing) return;
    resizing = null;
    resizeEdge.classList.remove('dragging');
    savePrefs();
  };
  resizeEdge.addEventListener('pointerup', endResize);
  resizeEdge.addEventListener('pointercancel', endResize);
  resizeEdge.addEventListener('dblclick', () => {
    setTimelineHeight(null);
    savePrefs();
  });
  resizeEdge.addEventListener('keydown', (evt) => {
    const step = { ArrowUp: 20, ArrowDown: -20 }[evt.key];
    if (!step) return;
    evt.preventDefault();
    evt.stopPropagation();
    setTimelineHeight(timelineHeight() + step);
    savePrefs();
  });
  if (Number.isFinite(prefs.timelineHeight)) setTimelineHeight(prefs.timelineHeight);

  // Shortcut hints: Cmd on a Mac, Ctrl elsewhere.
  if (!/Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent)) {
    for (const k of document.querySelectorAll('kbd[data-pc]')) k.textContent = k.dataset.pc;
  }

  // --- keeping the work between visits ---------------------------------------------------
  // The project, with its undo history, the frame on screen, the selection and its file name,
  // is kept in the browser half a second after each change and whenever the page is left or
  // hidden, and comes back when the page is opened or reloaded. A template being made comes
  // back too, with the project set aside behind it. If it is too big to keep with all its undo
  // history, less history is kept.

  const WORK_KEY = 'opendrop-generator.work';
  const WORK_VERSION = 1;
  let workKey = null;
  let workTimer = null;
  let workWarned = false;

  // After each picture: if anything that is kept changed, keep it shortly (not during a drag or
  // playback, which change it all the time).
  function noteWork() {
    const key = [ed.revision, ed.frame, ed.selection, ed.makingTemplate, baseName].join('|');
    if (key === workKey) return;
    workKey = key;
    clearTimeout(workTimer);
    workTimer = ed.dragging || ed.playing ? null : setTimeout(keepWork, 500);
  }

  function keepWork() {
    clearTimeout(workTimer);
    workTimer = null;
    for (const history of [undefined, 20, 0]) {
      try {
        const data = { version: WORK_VERSION, baseName, ...ed.snapshot(history) };
        if (ed.makingTemplate) {
          const at = editing ? myTemplates.indexOf(editing) : -1;
          data.maker = { name: nameInput.value, title: makerTitle.textContent, editing: at, editingName: editing ? editing.name : null };
        }
        localStorage.setItem(WORK_KEY, JSON.stringify(data));
        return true;
      } catch {
        // too big for the browser's storage (or storage is off): try with less undo history
      }
    }
    if (!workWarned) {
      workWarned = true;
      setStatus("This browser won't keep your work between visits (it is too big, or storage is off): use save", 'warn');
    }
    return false;
  }

  function restoreWork() {
    const data = readStored(WORK_KEY, null);
    if (!data || data.version !== WORK_VERSION || !data.project) return;
    const lay = layout.LAYOUTS.find((l) => l.id === data.project.layout);
    if (lay && lay.id !== current.id) switchLayout(lay);
    let warnings;
    try {
      warnings = ed.resume(data);
    } catch {
      setStatus('The work kept from last time could not be read, so this is a new project', 'warn');
      return;
    }
    baseName = typeof data.baseName === 'string' ? data.baseName : null;
    if (ed.makingTemplate) {
      const m = data.maker || {};
      const mine = Number.isInteger(m.editing) ? myTemplates[m.editing] : null;
      editing = mine && mine.name === m.editingName ? mine : null;
      nameInput.value = typeof m.name === 'string' ? m.name : `Template ${myTemplates.length + 1}`;
      makerTitle.textContent = typeof m.title === 'string' && m.title ? m.title : 'New template';
      showMaker();
    }
    const main = ed.saved ? ed.saved.project : ed.doc;
    const n = main.actions.length;
    if (!n && !ed.makingTemplate && !ed.canUndo) return;
    const what = ed.makingTemplate ? 'the template you were making, and the project behind it,' : `your work from last time (${plural(n, 'action')})`;
    const text = `Picked up ${what} where you left off`;
    if (warnings.length) setStatus(`${text}. ${warnings.join('; ')}.`, 'warn');
    else setStatus(text);
  }

  addEventListener('pagehide', () => {
    keepWork();
    // A run that goes with this tab: the other tab can change things again.
    if (runner && runner.running && sync) sync.run({ tile: null, stretch: null, frame: 0, frames: 0, done: 'closed' });
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') keepWork();
    // A picture asked for just before the tab was hidden waits for an animation frame that won't
    // come while it is: ask again, on the background clock.
    if (document.hidden && frameRequested) {
      frameRequested = false;
      redraw();
    }
  });

  // --- a second tab --------------------------------------------------------------------------
  // The process in one tab and the board in another (or two of either): every change goes to the
  // other tab, which takes it in as an undo step of its own.

  sync = new TabSync({
    doc(shared) {
      if (ed.makingTemplate || !ed.applyRemote(shared)) {
        pendingRemote = shared;
        return;
      }
      syncRev = ed.revision;
      setStatus('Changed in the other tab');
      redraw();
    },
    run(state) {
      remoteRun = state;
      // Nothing changes here either until it ends (or its tab closes).
      const was = ed.runElsewhere;
      ed.runElsewhere = state && !state.done ? 'A run is going in the other tab: stop it there to change things' : null;
      if (!was && ed.readOnly) ed.cancel(); // a drag going on here is dropped
      redraw();
    },
    holdsDevice: () => Boolean(device && device.session.connected),
  });

  // --- the device --------------------------------------------------------------------------
  // Connecting the OpenDrop over USB (Chrome, Edge): see js/devicepanel.js and js/device.js.

  device = new DevicePanel({
    editor: ed,
    setStatus,
    redraw,
    prefs: prefs.device,
    savePrefs,
    layoutId: () => current.id,
    useLayout: (id) => {
      switchLayout(layout.getLayout(id));
      redraw();
    },
    formatTime,
    deviceElsewhere: () => sync.deviceElsewhere(),
  });
  addEventListener('pagehide', () => device.leave());

  // --- the process view ----------------------------------------------------------------------
  // The process as tiles (in the board's place), Properties for its tiles, running it.

  const processHost = $('process-view');
  const stageArea = $('stage-area');
  const runLog = $('run-log');
  const switchButtons = [...document.querySelectorAll('#viewbar [data-view]')];

  // Opens tile id on the board (stops have nothing there).
  function openOnBoard(id) {
    const t = ed.doc.process && P.tileById(ed.doc.process, id);
    if (!t) return;
    if (!P.hasWork(t)) {
      setStatus(`${t.name || P.KINDS[t.kind].name} is a stop of the process: it has nothing on the board`);
      return;
    }
    if (ed.frozen) {
      setStatus(ed.frozen, 'warn');
      return;
    }
    if (ed.openTile(id)) {
      selectedTile = id;
      setView('board');
      const arriving = ed.arrive.map((a) => a.droplet);
      setStatus(`On the board: ${openTileName()}${arriving.length ? `; coming in: ${arriving.join(', ')} (rings)` : ''}`);
    }
  }

  // Opens tile id on the board and puts its operation there.
  function placeOnBoard(id) {
    if (refused() || !ed.openTile(id)) return;
    selectedTile = id;
    setView('board');
    const done = ed.placeTile();
    if (!done) showNotice();
    else {
      setStatus(done.text);
      if (done.kind === 'placing') placingTile = id;
    }
    redraw();
  }

  processView = new ProcessView(processHost, {
    editor: ed,
    analysis,
    select(id) {
      selectedTile = id;
      const t = id && P.tileById(ed.doc.process, id);
      if (t && P.hasWork(t) && !ed.frozen && !(ed.scope && ed.scope.tile === id)) ed.openTile(id);
      processPanel.show(id);
      redraw();
    },
    open: openOnBoard,
    status: setStatus,
    changed() {
      showNotice(); // a change that was refused says why
      processPanel.key = '';
      redraw();
    },
    running: () => (runner && runner.running ? { tile: runner.state.tile, stretch: runner.state.stretch } : remoteRun && !remoteRun.done ? remoteRun : null),
  });
  processPanel = new ProcessPanel($('tile-props'), { editor: ed, analysis, status: setStatus, changed: () => (showNotice(), redraw()), open: openOnBoard, place: placeOnBoard });

  function setView(next) {
    if (next === 'process' && !ed.doc.process) {
      if (ed.makingTemplate) {
        setStatus('Save or cancel the template first', 'warn');
        return;
      }
      if (!ed.makeProcess()) {
        showNotice();
        return;
      }
      setStatus('This project now has a process: what was drawn is in “Step 1”. Add tiles from the left, connect them, and double-click a step to draw it on the board');
    }
    view = next;
    prefs.view = next;
    savePrefs();
    svg.style.display = view === 'board' ? '' : 'none';
    processHost.hidden = view !== 'process';
    for (const b of switchButtons) b.setAttribute('aria-pressed', String(b.dataset.view === view));
    if (view === 'process') {
      if (!selectedTile && ed.scope && ed.scope.tile) selectedTile = ed.scope.tile;
      processPanel.show(selectedTile);
      setTab('properties');
    }
    redraw();
  }
  for (const b of switchButtons) {
    b.addEventListener('click', () => {
      b.blur();
      if (view !== b.dataset.view) setView(b.dataset.view);
    });
  }

  $('open-tab').addEventListener('click', (evt) => {
    evt.currentTarget.blur();
    keepWork(); // the new tab starts from what is here now
    root.open(`${location.href.split('#')[0]}#${view === 'process' ? 'board' : 'process'}`, '_blank');
  });

  // The bar over the stage: where the board is in the process, and the run.
  const mmss = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;
  function showViewbar() {
    const where = $('viewbar-where');
    const t = openTile();
    if (ed.makingTemplate) where.textContent = 'Making a template';
    else if (view === 'board' && t) {
      const part = boardPart();
      const frames = !part ? ' · not on the way the timeline follows (a decision goes the other way)' : part.to >= part.from ? ` · frames ${part.from}–${part.to}` : '';
      where.textContent = `On the board: ${t.name || P.KINDS[t.kind].name}${ed.scope.tiles.size > 1 ? ` · with ${ed.scope.tiles.size - 1} more step${ed.scope.tiles.size === 2 ? '' : 's'} of the process` : ''}${frames}`;
    }
    else if (view === 'board' && ed.doc.process) where.textContent = 'Open a step of the process to draw it';
    else where.textContent = '';
    $('run-controls').hidden = !ed.doc.process || ed.makingTemplate;
    const running = runner && runner.running;
    $('run-start').hidden = running;
    $('run-pause').hidden = !running;
    $('run-stop').hidden = !running;
    if (running) $('run-pause').textContent = runner.state.paused ? '▶ Go on' : '⏸ Pause';
    const connected = Boolean(device && device.session.connected);
    const state = $('run-state');
    if (running) {
      const s = runner.state;
      const tile = s.tile && P.tileById(ed.doc.process, s.tile);
      const name = tile ? (tile.kind === 'decision' ? P.conditionText(tile, ed.doc.process) : tile.name || P.KINDS[tile.kind].name) : '';
      state.textContent = `${s.paused ? 'Paused' : 'Running'}: ${name}${s.stretch ? ` · frame ${s.frame} of ${s.frames}` : ''} · ${mmss(Date.now() - s.started)}`;
    } else if (remoteRun && !remoteRun.done) state.textContent = `Running in the other tab: frame ${remoteRun.frame || 0}`;
    else if (ed.playing && ed.doc.process) state.textContent = 'Previewing: play goes through the timeline without asking anything; ▶ Run asks';
    else state.textContent = '';
    where.title = where.textContent; // whole on hover, if it is cut short
    state.title = state.textContent;
    $('open-tab').textContent = view === 'process' ? 'Board in a new tab ↗' : 'Process in a new tab ↗';
    renderLog(runLog, view === 'process' && runner ? runner.state : null);
  }

  runner = new Runner({
    editor: ed,
    timers: OD.clock.timers(), // a run keeps going in a background tab
    readings: liveReadings,
    ask: async (step) => {
      // An Ask or Measure set to show on the device: its text on the OpenDrop's screen meanwhile.
      const note = P.screenText(step.tile);
      const s = device && device.session;
      if (note && s && s.connected) s.setNote(note);
      try {
        return await askRun(stageArea, step, ed.doc.process);
      } finally {
        if (note && s) s.setNote(null);
      }
    },
    changed() {
      const s = runner.state;
      if (s) sync.run({ tile: s.tile, stretch: s.stretch, frame: s.frame, frames: s.frames, done: s.done });
      redraw();
    },
  });
  $('run-start').addEventListener('click', async (evt) => {
    evt.currentTarget.blur();
    if (refused()) return; // one run at a time, also over two tabs
    const errors = P.check(ed.doc.process).filter((i) => i.level === 'error');
    if (errors.length) {
      setStatus(`The process can't run yet: ${errors[0].text}`, 'warn');
      return;
    }
    if (ed.dragging || ed.placement) ed.cancel();
    // With live on, the OpenDrop follows the run (and is switched off at the end).
    const onDevice = Boolean(device.session.live && device.session.connected);
    setStatus(`Running${onDevice ? ' on the OpenDrop (live)' : ''}: each step plays on the board; you are asked at Measure and Ask tiles${onDevice || !device.session.connected ? '' : '. Switch live on for the OpenDrop to follow'}`);
    const ended = await runner.start();
    if (onDevice) device.allOff();
    if (ended === 'end') setStatus(`The run is done (${mmss(Date.now() - runner.state.started)})`);
    else if (ended === 'stuck') setStatus(`The run stopped: ${runner.state.text}`, 'warn');
    else if (ended === 'stopped') setStatus(`The run was stopped${onDevice ? ': everything on the OpenDrop is switched off' : ''}`, 'warn');
    redraw();
  });
  $('run-pause').addEventListener('click', (evt) => {
    evt.currentTarget.blur();
    runner.pause();
  });
  $('run-stop').addEventListener('click', (evt) => {
    evt.currentTarget.blur();
    runner.stop();
  });

  renderTemplates();
  restoreWork();
  sync.settle(ed.doc);
  syncRev = ed.revision;
  setInterval(() => {
    shareWork();
    if (pendingRemote) redraw();
  }, 400);
  applyPanels();
  setChartView(prefs.chart);
  setTab(prefs.tab);
  setView(view);
  root.OD.app = { editor: ed, board, chart, timeline, redraw, save, exportFrames, templates: () => myTemplates, device, processView, runner, setView }; // for the console
  paint(); // the first picture straight away, not at the next animation frame
})(globalThis);
