/* Temperatures and magnets: what the temperature adapter's three heaters (T1-T3) and the two
 * magnets can be set to, how long a heater takes to get somewhere (an estimate, for designing
 * without a device), and which electrodes sit over each heater (for tinting the board). No DOM
 * here.
 *
 * The device takes the three temperature targets in every packet (bytes 26-28) and the magnets as
 * control lines (electrodes 129 = magnet 1, 128 = magnet 2): nothing here needs new firmware. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else (root.OD = root.OD || {}).heat = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const HEATERS = 3;
  const TEMP_RANGE = [20, 120]; // °C the original controller lets you set
  const AMBIENT = 25; // what the original controller sends when nothing is set, and where estimates start
  const DEFAULT_TOLERANCE = 1; // °C: a heater within this of its target has reached it
  const MAX_TOLERANCE = 20;
  // How fast a heater is assumed to warm up or cool down (°C per minute), until the project says.
  const DEFAULT_RATES = { up: 10, down: 4 };
  const RATE_RANGE = [0.1, 600];

  // Magnet n's control line (the V4.2 firmware reads bit 0x2 of byte 16 as magnet 1, 0x1 as 2).
  const MAGNETS = [
    { n: 1, e: 129 },
    { n: 2, e: 128 },
  ];
  const magnetCell = (n) => (MAGNETS.find((m) => m.n === n) || MAGNETS[0]).e;

  // The electrodes over each heater, T1 first, for tinting the board by its target. From GaudiLabs'
  // heater cartridge (OpenDropV4/Electronics/DIMMCartridge_heaters): each heater is two 1206
  // resistors with an NTC between them under two electrode pads, wired by the universal adapter as
  // T1 = H1/H2 + TH1, T2 = H3/H4 + TH2, T3 = H5/H6 + TH3. On the PCB they sit under FLUXL_4_2/4_3,
  // FLUXL_8_2/8_3 and FLUXL_13_2/13_3 (PCB column N, row R = electrode (N-1) × 8 + R-1 here).
  // Only the layouts of that cartridge have them there.
  const HEATER_ZONES = [[25, 26], [57, 58], [97, 98]];
  const HEATER_LAYOUTS = ['electrodes', 'electrodes_magnet'];

  const clampTemp = (t) => Math.min(TEMP_RANGE[1], Math.max(TEMP_RANGE[0], Math.round(t)));
  const goodTemp = (t) => typeof t === 'number' && Number.isFinite(t);

  // Targets as saved: three entries, each a whole °C in range or null (left as it was).
  function cleanTargets(raw) {
    const list = Array.isArray(raw) ? raw : [];
    return Array.from({ length: HEATERS }, (_, i) => (goodTemp(list[i]) ? clampTemp(list[i]) : null));
  }

  function cleanRates(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const one = (v, d) => (goodTemp(v) && v > 0 ? Math.min(RATE_RANGE[1], Math.max(RATE_RANGE[0], v)) : d);
    return { up: one(r.up, DEFAULT_RATES.up), down: one(r.down, DEFAULT_RATES.down) };
  }

  const cleanTolerance = (t) => (goodTemp(t) && t > 0 ? Math.min(MAX_TOLERANCE, Math.round(t * 10) / 10) : DEFAULT_TOLERANCE);

  // What the heaters and magnets are set to: targets (°C, or null: not set by the project) and
  // magnets on or off; and once a Message action has run, `message`, the text on the device's
  // screen ('' = cleared).
  const emptyControls = () => ({ targets: [null, null, null], magnets: [false, false] });
  const copyControls = (c) => ({ targets: c.targets.slice(), magnets: c.magnets.slice(), ...(typeof c.message === 'string' ? { message: c.message } : {}) });
  const sameControls = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const usesControls = (c) => c.targets.some((t) => t !== null) || c.magnets.some(Boolean) || typeof c.message === 'string';
  // A Message action's text, as kept: one line, at most MESSAGE_LENGTH characters (the screen
  // shows 20; the device keeps plain ASCII of it).
  const MESSAGE_LENGTH = 20;
  const cleanText = (t) => String(t === null || t === undefined ? '' : t).replace(/\s+/g, ' ').trim().slice(0, MESSAGE_LENGTH).trim();

  // Applies a temperature or magnet action to controls `c` (in place).
  function apply(c, action) {
    if (action.type === 'temp') {
      action.targets.forEach((t, i) => {
        if (t !== null && t !== undefined) c.targets[i] = t;
      });
    } else if (action.type === 'magnet') {
      c.magnets[(action.magnet === 2 ? 2 : 1) - 1] = action.on !== false;
    } else if (action.type === 'message') {
      c.message = cleanText(action.text);
    }
    return c;
  }

  // How long (ms) the heaters take from `from` to `to` (targets; null = ambient / unchanged) at
  // `rates`: the slowest heater counts.
  function estimateMs(from, to, rates = DEFAULT_RATES) {
    let ms = 0;
    for (let i = 0; i < HEATERS; i++) {
      if (to[i] === null || to[i] === undefined) continue;
      const a = from[i] === null || from[i] === undefined ? AMBIENT : from[i];
      const d = to[i] - a;
      if (!d) continue;
      const perMin = d > 0 ? rates.up : rates.down;
      ms = Math.max(ms, (Math.abs(d) / perMin) * 60000);
    }
    return Math.round(ms);
  }

  // The temperature a heater is estimated to have `ms` after it was at `from` and set to `to`.
  function rampAt(from, to, ms, rates = DEFAULT_RATES) {
    const d = to - from;
    if (!d) return to;
    const perMs = (d > 0 ? rates.up : rates.down) / 60000;
    const moved = perMs * ms;
    return moved >= Math.abs(d) ? to : from + Math.sign(d) * moved;
  }

  // Whether readings `temps` (°C or null) are within `tolerance` of every target that is set.
  // Heaters without a reading count as not there yet.
  function reached(temps, targets, tolerance = DEFAULT_TOLERANCE) {
    return targets.every((t, i) => t === null || t === undefined || (goodTemp(temps[i]) && Math.abs(temps[i] - t) <= tolerance));
  }

  // "T1 60 °C, T3 37 °C"; "nothing" if no target is set.
  function targetsText(targets) {
    const parts = targets.map((t, i) => (t === null || t === undefined ? null : `T${i + 1} ${t} °C`)).filter(Boolean);
    return parts.length ? parts.join(', ') : 'nothing';
  }

  // A colour for a temperature: dark amber at ambient through orange to red at the top of the
  // range (warm hues only, so no step in between turns gray; dark enough to show on the yellow
  // electrodes).
  function colour(t) {
    if (!goodTemp(t)) return '#9c9a92';
    const k = Math.min(1, Math.max(0, (t - AMBIENT) / (TEMP_RANGE[1] - AMBIENT)));
    const stops = [
      [0, [201, 133, 0]],
      [0.4, [235, 104, 52]],
      [1, [192, 38, 43]],
    ];
    let i = 0;
    while (i < stops.length - 2 && k > stops[i + 1][0]) i++;
    const [k0, c0] = stops[i];
    const [k1, c1] = stops[i + 1];
    const f = (k - k0) / (k1 - k0);
    const c = c0.map((v, j) => Math.round(v + (c1[j] - v) * f));
    return `rgb(${c[0]},${c[1]},${c[2]})`;
  }

  return {
    HEATERS, TEMP_RANGE, AMBIENT, DEFAULT_TOLERANCE, DEFAULT_RATES, RATE_RANGE, MAGNETS, HEATER_ZONES, HEATER_LAYOUTS,
    magnetCell, clampTemp, cleanTargets, cleanRates, cleanTolerance, emptyControls, copyControls, sameControls, MESSAGE_LENGTH, cleanText,
    usesControls, apply, estimateMs, rampAt, reached, targetsText, colour,
  };
});
