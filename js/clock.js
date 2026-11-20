/* Timers that keep time while the page is in the background. Chrome slows the timers of a hidden
 * tab (at most one a second, after 5 minutes one a minute) and stops animation frames, which
 * would stall a run and the device's frames when you switch to another window. A worker's timers
 * aren't slowed, so here setTimeout is kept by a small worker made from a blob (this also works
 * from file://). Same shape as the global one: { setTimeout(fn, ms) -> id, clearTimeout(id) }.
 * Where there are no workers (node, tests), it is the global one. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else (root.OD = root.OD || {}).clock = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const WORKER = `const t = new Map();
onmessage = (e) => {
  const [op, id, ms] = e.data;
  if (op === 'set') t.set(id, setTimeout(() => { t.delete(id); postMessage(id); }, ms));
  else { clearTimeout(t.get(id)); t.delete(id); }
};`;

  function workerTimers(root) {
    if (typeof root.Worker !== 'function' || typeof root.Blob !== 'function' || !root.URL) return null;
    let worker;
    try {
      const url = root.URL.createObjectURL(new root.Blob([WORKER], { type: 'text/javascript' }));
      worker = new root.Worker(url);
    } catch (e) {
      return null; // not allowed here: the page's own timers
    }
    const waiting = new Map();
    let next = 1;
    worker.onmessage = (e) => {
      const fn = waiting.get(e.data);
      waiting.delete(e.data);
      if (fn) fn();
    };
    return {
      setTimeout(fn, ms = 0) {
        const id = next++;
        waiting.set(id, fn);
        worker.postMessage(['set', id, Math.max(0, Number(ms) || 0)]);
        return id;
      },
      clearTimeout(id) {
        if (!waiting.has(id)) return;
        waiting.delete(id);
        worker.postMessage(['clear', id]);
      },
    };
  }

  const fallback = { setTimeout: (fn, ms) => root.setTimeout(fn, ms), clearTimeout: (id) => root.clearTimeout(id) };
  let made = null;
  // The timers to use; made once, on first use.
  function timers() {
    if (!made) made = workerTimers(root) || fallback;
    return made;
  }

  return { timers, workerTimers };
});
