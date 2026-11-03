/* Connects the page (mouse, wheel, keys, file dialogs, bottom bar) to the editor and the view. */
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

  // Layout choice and the number overlay are remembered between visits.
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
      localStorage.setItem(PREFS_KEY, JSON.stringify({ layout: current.id, numbers: showNumbers }));
    } catch {
      // storage unavailable: preferences just aren't kept
    }
  };

  let current = layout.getLayout(prefs.layout);
  let showNumbers = Boolean(prefs.numbers);
  let fileName = null;

  const ed = new Editor(current);
  const board = new BoardView(svg, 'assets/OpenDropFrame.png');
  board.setLayout(current);

  // Drawing happens once per animation frame; playback keeps requesting frames while it runs.
  let frameRequested = false;
  function redraw() {
    if (frameRequested) return;
    frameRequested = true;
    requestAnimationFrame((now) => {
      frameRequested = false;
      ed.tick(now);
      board.render(ed, showNumbers);
      if (ed.playing) redraw();
    });
  }

  function setStatus(text, kind = 'info') {
    statusText.textContent = text;
    statusText.className = kind;
  }

  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  // --- mouse / touch ---------------------------------------------------------------------

  function toGrid(evt) {
    const p = new DOMPoint(evt.clientX, evt.clientY).matrixTransform(svg.getScreenCTM().inverse());
    return { mx: (p.x - G.CX) / G.UNIT, my: (p.y - G.CY) / G.UNIT };
  }

  const openDialog = (action) => (action === 'save' ? save() : fileInput.click());
  let pendingDialog = null;

  svg.addEventListener('pointerdown', (evt) => {
    if (evt.button !== 0) return;
    evt.preventDefault();
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    const { mx, my } = toGrid(evt);
    const action = ed.pointerDown(mx, my, { shift: evt.shiftKey, now: performance.now() });
    if (action === 'save' || action === 'load') {
      // Browsers only open file dialogs during a user gesture: a mouse press counts,
      // a touch only once the finger lifts.
      if (evt.pointerType === 'mouse') openDialog(action);
      else pendingDialog = action;
    }
    if (ed.dragging) svg.setPointerCapture(evt.pointerId);
    redraw();
  });

  svg.addEventListener('pointerup', () => {
    if (pendingDialog) openDialog(pendingDialog);
    pendingDialog = null;
  });
  svg.addEventListener('pointercancel', () => {
    pendingDialog = null;
  });

  svg.addEventListener('pointermove', (evt) => {
    const { mx, my } = toGrid(evt);
    if (ed.dragging) {
      ed.pointerMove(mx, my);
      redraw();
    } else {
      svg.style.cursor = ed.controlAt(mx, my) ? 'pointer' : '';
    }
  });

  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    svg.addEventListener(type, () => ed.pointerUp());
  }

  // Wheel and trackpad: one step per notch-sized amount of scrolling.
  let wheelTotal = 0;
  svg.addEventListener(
    'wheel',
    (evt) => {
      evt.preventDefault();
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
    if (evt.metaKey || evt.ctrlKey || evt.altKey) return;
    if (evt.target instanceof HTMLInputElement || evt.target instanceof HTMLSelectElement) return;
    switch (evt.key) {
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
      case 'N':
        setNumbers(!showNumbers);
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

  root.OD.app = { editor: ed, board, save }; // handy from the browser console
  redraw();
})(globalThis);
