/* Connects the page (mouse, wheel, keys, file dialogs, status, bottom bar) to the editor and the
 * view. */
(function (root) {
  'use strict';

  const { layout, jsonio } = root.OD;
  const { Editor } = root.OD.editor;
  const { BoardView } = root.OD.view;
  const G = layout.GEOMETRY;

  const svg = document.getElementById('board');
  const layoutSelect = document.getElementById('layout');
  const numbersBox = document.getElementById('numbers');
  const statusText = document.getElementById('status');
  const fileInput = document.getElementById('file-input');

  // Layout, number overlay and drag tool are remembered between visits.
  const PREFS_KEY = 'opendrop-generator.prefs';
  const prefs = (() => {
    try {
      return JSON.parse(localStorage.getItem(PREFS_KEY)) || {};
    } catch {
      return {};
    }
  })();
  const savePrefs = () => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ layout: current.id, numbers: showNumbers, tool: ed.tool }));
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
      board.render(ed, showNumbers);
      if (ed.draft && ed.draft.moved) showDraft(ed.draft);
      if (ed.playing) redraw();
    });
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

  // --- mouse / touch ---------------------------------------------------------------------

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

  async function save() {
    const text = jsonio.encode(ed.seq);
    const count = ed.seq.lastFrame();
    const suggested = withJson(fileName || 'opendrop-sequence');

    if (typeof root.showSaveFilePicker === 'function') {
      let handle;
      try {
        handle = await root.showSaveFilePicker({
          suggestedName: suggested,
          types: [{ description: 'OpenDrop sequence', accept: { 'application/json': ['.json'] } }],
        });
      } catch (err) {
        if (err.name !== 'AbortError') setStatus(`Could not save: ${err.message}`, 'error');
        return;
      }
      try {
        const out = await handle.createWritable();
        await out.write(text);
        await out.close();
      } catch (err) {
        setStatus(`Could not save ${handle.name}: ${err.message}`, 'error');
        return;
      }
      fileName = handle.name;
    } else {
      // Browsers without a save dialog (Safari, Firefox): ask for a name, then download.
      const name = root.prompt('Save as', suggested);
      if (!name || !name.trim()) return;
      fileName = withJson(name.trim());
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    setStatus(`Saved ${fileName} (${plural(count, 'frame')})`);
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
    ed.replaceSequence(result.seq);
    fileName = file.name;
    const loaded = `Loaded ${file.name} (${plural(result.frames, 'frame')})`;
    if (result.warnings.length) setStatus(`${loaded}. ${result.warnings.join('; ')}.`, 'warn');
    else setStatus(loaded);
    redraw();
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

  // Shortcut hints: Cmd on a Mac, Ctrl elsewhere.
  if (!/Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent)) {
    for (const k of document.querySelectorAll('kbd[data-pc]')) k.textContent = k.dataset.pc;
  }

  root.OD.app = { editor: ed, board, save }; // handy from the browser console
  board.render(ed, showNumbers); // the first picture straight away, not at the next animation frame
})(globalThis);

