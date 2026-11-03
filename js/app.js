/* Connects the page to the editor and the views: the board (mouse, touch, wheel, keys), file
 * dialogs, the timing strip and its chart, the templates panel, and the bottom bar. */
(function (root) {
  'use strict';

  const { layout, jsonio, templates } = root.OD;
  const { Editor } = root.OD.editor;
  const { BoardView } = root.OD.view;
  const { TimingChart, formatTime } = root.OD.chart;
  const G = layout.GEOMETRY;
  const $ = (id) => document.getElementById(id);

  const svg = $('board');
  const layoutSelect = $('layout');
  const numbersBox = $('numbers');
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

  // Layout, number overlay, drag tool, minimised panels and chart view are remembered between
  // visits.
  const PREFS_KEY = 'opendrop-generator.prefs';
  const stored = readStored(PREFS_KEY, {});
  const prefs = { timingMin: false, templatesMin: false, chart: 'step', ...(stored && typeof stored === 'object' ? stored : {}) };
  const savePrefs = () => {
    try {
      const { timingMin, templatesMin, chart: view } = prefs;
      localStorage.setItem(
        PREFS_KEY,
        JSON.stringify({ layout: current.id, numbers: showNumbers, tool: ed.tool, timingMin, templatesMin, chart: view })
      );
    } catch {
      // storage unavailable: preferences just aren't kept
    }
  };

  let current = layout.getLayout(prefs.layout);
  let showNumbers = Boolean(prefs.numbers);
  let fileName = null;

  const ed = new Editor(current);
  ed.setTool(prefs.tool);
  const board = new BoardView(svg, 'assets/OpenDropFrame.png');
  board.setLayout(current);

  function setStatus(text, kind = 'info') {
    statusText.textContent = text;
    statusText.className = kind;
  }

  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

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
    board.render(ed, showNumbers);
    if (ed.draft && ed.draft.moved) showDraft(ed.draft);
    showTiming();
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

  // --- board: mouse / touch --------------------------------------------------------------

  function toGrid(evt) {
    const p = new DOMPoint(evt.clientX, evt.clientY).matrixTransform(svg.getScreenCTM().inverse());
    return { mx: (p.x - G.CX) / G.UNIT, my: (p.y - G.CY) / G.UNIT };
  }

  const openDialog = (action) => (action === 'save' ? save() : fileInput.click());
  let pendingDialog = null;

  svg.addEventListener('pointerdown', (evt) => {
    if (evt.button !== 0 || !evt.isPrimary) return;
    evt.preventDefault();
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    const { mx, my } = toGrid(evt);
    const action = ed.pointerDown(mx, my, { shift: evt.shiftKey, now: performance.now() });
    if (action === 'save' || action === 'load') {
      // Browsers only open file dialogs during a user gesture: a mouse press counts,
      // a touch only once the finger lifts.
      if (evt.pointerType === 'mouse') openDialog(action);
      else pendingDialog = action;
    } else if (action === 'undo' || action === 'redo') {
      clearDraftStatus('');
    } else if (action && action.startsWith('tool')) {
      savePrefs();
    }
    if (ed.dragging) svg.setPointerCapture(evt.pointerId);
    redraw();
  });

  // Letting go adds the path being drawn.
  function finishDrag() {
    const added = ed.pointerUp();
    if (added) clearDraftStatus(`Added a path: ${plural(added.steps, 'step')}, frames ${added.from} to ${added.to}`);
    else clearDraftStatus();
    redraw();
  }

  svg.addEventListener('pointerup', (evt) => {
    if (!evt.isPrimary) return;
    if (pendingDialog) openDialog(pendingDialog);
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
      redraw();
    } else {
      svg.style.cursor = ed.controlAt(mx, my) ? 'pointer' : '';
    }
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
      // Cmd+Z / Ctrl+Z undo; with Shift, or Ctrl+Y, redo.
      if (key === 'z') undoRedo(evt.shiftKey ? 'redo' : 'undo');
      else if (key === 'y' && evt.ctrlKey) undoRedo('redo');
      else return;
      evt.preventDefault();
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
      case 'f':
        setTool('freehand');
        break;
      case 's':
        setTool('straight');
        break;
      case 'p':
        setTool('paint');
        break;
      case 'Escape':
        if (ed.cancel()) clearDraftStatus('Cancelled');
        break;
      default:
        return;
    }
    evt.preventDefault();
    redraw();
  });

  // --- save / load -----------------------------------------------------------------------

  const withJson = (name) => (/\.json$/i.test(name) ? name : `${name}.json`);

  // Saves text with the browser's save dialog, or (Safari, Firefox) asks for a name and
  // downloads it. Returns the file name, or null if cancelled or failed (the status says why).
  async function saveText(text, suggested, description) {
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
    const file = withJson(name.trim());
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

  // The board's save and load work on whatever is on the board: while a template is being
  // made, that is the template, which can be saved as (or loaded from) a sequence file.
  async function save() {
    const text = jsonio.encode(ed.seq);
    const count = ed.seq.lastFrame();
    const suggested = ed.makingTemplate
      ? withJson(nameInput.value.trim() || 'template')
      : withJson(fileName || 'opendrop-sequence');
    const name = await saveText(text, suggested, 'OpenDrop sequence');
    if (!name) return;
    if (!ed.makingTemplate) fileName = name;
    setStatus(`Saved ${name} (${plural(count, 'frame')})`);
  }

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    fileInput.value = ''; // so choosing the same file again still triggers a load
    if (!file) return;
    let result;
    try {
      result = jsonio.decode(await file.text());
    } catch (err) {
      setStatus(`Could not load ${file.name}: ${err.message}`, 'error');
      return;
    }
    ed.replaceSequence(result.seq, { timed: result.timed });
    if (!ed.makingTemplate) fileName = file.name;
    const loaded = `Loaded ${file.name} (${plural(result.frames, 'frame')})`;
    if (result.warnings.length) setStatus(`${loaded}. ${result.warnings.join('; ')}.`, 'warn');
    else setStatus(loaded);
    redraw();
  });

  // --- timing strip ----------------------------------------------------------------------

  const defaultInput = $('time-default');
  const frameInput = $('time-frame');
  const frameNo = $('time-frame-no');
  const frameReset = $('time-frame-reset');
  const totalText = $('time-total');
  const legend = $('chart-legend');
  const seconds = (ms) => String(+(ms / 1000).toFixed(3));

  const chart = new TimingChart($('chart'), {
    onPick(step) {
      if (ed.dragging || ed.placement) return;
      ed.frame = step;
      redraw();
    },
  });

  function showTiming() {
    const { seq } = ed;
    if (document.activeElement !== defaultInput) defaultInput.value = seconds(seq.frameTime);
    frameNo.textContent = ed.frame;
    const ownTime = seq.times[ed.frame];
    if (document.activeElement !== frameInput) frameInput.value = ownTime ? seconds(ownTime) : '';
    frameInput.placeholder = seconds(seq.frameTime);
    frameReset.disabled = !ownTime;
    const last = seq.lastFrame();
    totalText.textContent = `Total ${formatTime(seq.elapsed(last))} over ${plural(last, 'frame')}`;
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

  // A frame's own time; empty means the default. Undoable, like drawing.
  frameInput.addEventListener('change', () => {
    const f = ed.frame;
    const ms = frameInput.value.trim() === '' ? 0 : readSeconds(frameInput);
    if (ms === null) {
      setStatus('Frame times are in seconds, more than 0', 'warn');
    } else {
      ed.setFrameTime(f, ms);
      setStatus(ms ? `Frame ${f} lasts ${formatTime(ed.seq.timeOf(f))}` : `Frame ${f} uses the default time`);
    }
    frameInput.value = ed.seq.times[f] ? seconds(ed.seq.times[f]) : '';
    redraw();
  });

  frameReset.addEventListener('click', () => {
    ed.setFrameTime(ed.frame, 0);
    setStatus(`Frame ${ed.frame} uses the default time`);
    frameReset.blur();
    redraw();
  });

  // Enter keeps the value and gives the keys back to the board; Esc puts the old value back.
  for (const input of [defaultInput, frameInput]) {
    input.addEventListener('focus', () => (input.dataset.before = input.value));
    input.addEventListener('keydown', (evt) => {
      if (evt.key === 'Escape') input.value = input.dataset.before || '';
      if (evt.key === 'Enter' || evt.key === 'Escape') input.blur();
    });
  }

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
      setStatus(`Added “${t.name}”: ${plural(added.steps, 'step')}, frames ${added.from} to ${added.to}`);
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

  // Making a template: a blank board (the sequence is set aside), drawn with the usual tools.
  const library = $('library');
  const maker = $('maker');
  const makerTitle = $('maker-title');
  const nameInput = $('template-name');
  const makerInfo = $('maker-info');
  const saveTemplateButton = $('template-save');
  let editing = null; // the template of yours being changed, or null for a new one or a copy

  function openMaker(t) {
    if (ed.makingTemplate) return;
    ed.startTemplate(t ? templates.toSequence(t) : undefined);
    editing = t && !t.builtIn ? t : null;
    nameInput.value = t ? (t.builtIn ? `${t.name} (copy)` : t.name) : `Template ${myTemplates.length + 1}`;
    makerTitle.textContent = editing ? 'Change the template' : t ? 'Copy of a built-in template' : 'New template';
    library.hidden = true;
    maker.hidden = false;
    board.setCutoutTitle('Making a template');
    applyPanels();
    setStatus('Making a template: draw it on the array, then press Save template');
    redraw();
  }

  function closeMaker() {
    ed.endTemplate();
    editing = null;
    library.hidden = false;
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

  // --- bottom bar ------------------------------------------------------------------------

  for (const l of layout.LAYOUTS) layoutSelect.add(new Option(l.label, l.id));
  layoutSelect.value = current.id;
  layoutSelect.addEventListener('change', () => {
    current = layout.getLayout(layoutSelect.value);
    ed.setLayout(current);
    board.setLayout(current);
    savePrefs();
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

  // --- minimising the panels -------------------------------------------------------------
  // The timing strip folds down to one line with the total; the templates panel to a thin tab.
  // Either gives the board more room. The templates panel opens while a template is being made:
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

  function setMinimised(panel, minimised) {
    prefs[panel] = minimised;
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
  root.OD.app = { editor: ed, board, chart, save, templates: () => myTemplates }; // for the console
  paint(); // the first picture straight away, not at the next animation frame
})(globalThis);
