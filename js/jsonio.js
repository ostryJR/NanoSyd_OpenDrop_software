/* Save/load in the JSON format of OpenDropController4_25 (its fileSaved and fileLoad). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./model.js'));
  else (root.OD = root.OD || {}).jsonio = factory(root.OD.model);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (model) {
  'use strict';

  const { ROWS, COLS, MAX_FRAMES, Sequence } = model;

  // "yR": one character per column 0..17, '1' = electrode (column * 8 + R) on.
  function rowString(seq, f, r) {
    let s = '';
    for (let c = 0; c < COLS; c++) s += seq.get(c * ROWS + r, f) ? '1' : '0';
    return s;
  }

  // One frame object as Processing writes it: keys y0..y7 then "frame" (Java HashMap order).
  function formatFrame(seq, f, indent) {
    const pad = ' '.repeat(indent + 2);
    const lines = [];
    for (let r = 0; r < ROWS; r++) lines.push(`${pad}"y${r}": "${rowString(seq, f, r)}"`);
    lines.push(`${pad}"frame": ${f}`);
    return `{\n${lines.join(',\n')}\n${' '.repeat(indent)}}`;
  }

  // Frames 1..last non-empty frame, byte-for-byte what Processing's saveJSONArray() writes:
  // 2-space indent, no newline at the end, and a single frame written as "[{...}]".
  function encode(seq) {
    const last = seq.lastFrame();
    if (last === 1) return `[${formatFrame(seq, 1, 0)}]`;
    const items = [];
    for (let f = 1; f <= last; f++) items.push('  ' + formatFrame(seq, f, 2));
    return `[\n${items.join(',\n')}\n]`;
  }

  // Processing's JSON reader also accepts trailing commas; JSON.parse doesn't.
  function parseLenient(text) {
    try {
      return JSON.parse(text);
    } catch (err) {
      try {
        return JSON.parse(text.replace(/,\s*([}\]])/g, '$1'));
      } catch {
        throw err;
      }
    }
  }

  // Reads a saved sequence into a new Sequence (the original merged it into the current one).
  // Frames go by their "frame" number, falling back to their position in the list; that also
  // reads files from controller 3.2, which start with null and have 16-character rows.
  // Returns { seq, frames, warnings }; throws if the text isn't a list of frames.
  function decode(text) {
    const data = parseLenient(text);
    if (!Array.isArray(data)) throw new Error('expected a JSON list of frames');

    const seq = new Sequence();
    let found = 0;
    let frames = 0;
    let tooHigh = 0;
    let tooLong = false;

    data.forEach((item, i) => {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) return;
      const rows = [];
      for (let r = 0; r < ROWS; r++) if (typeof item['y' + r] === 'string') rows.push(r);
      if (!rows.length) return;
      found++;

      const f = Number.isInteger(item.frame) && item.frame >= 1 ? item.frame : i + 1;
      if (f > MAX_FRAMES) {
        tooHigh++;
        return;
      }
      for (const r of rows) {
        const s = item['y' + r];
        for (let c = 0; c < s.length; c++) {
          if (s[c] !== '1') continue;
          if (c >= COLS) tooLong = true;
          else seq.set(c * ROWS + r, f, true);
        }
      }
      frames = Math.max(frames, f);
    });

    if (!found) throw new Error('no frames found (expected objects with "y0" to "y7")');
    const warnings = [];
    if (tooHigh) warnings.push(`${tooHigh} frame(s) after frame ${MAX_FRAMES} were skipped`);
    if (tooLong) warnings.push(`columns after column ${COLS - 1} were skipped`);
    return { seq, frames, warnings };
  }

  return { encode, decode, rowString, parseLenient };
});
