/* Two browser tabs on the same project, e.g. the process in one and the board in the other: each
 * change in one is sent to the other (a BroadcastChannel; tabs of the same page share it), which
 * takes it in as an undo step of its own. A run's progress is sent too, so the other tab can show
 * it, and a tab can ask whether another one has the OpenDrop connected. */
(function (root) {
  'use strict';

  // JSON with every object's keys in order, so the same project gives the same text in any tab.
  const canon = (value) =>
    JSON.stringify(value, (k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((key) => [key, v[key]])) : v));

  // What tabs share of a project (the layout and the rest of the view are each tab's own).
  const shared = (doc) => ({ actions: doc.actions, templates: doc.templates, process: doc.process || null, frameTime: doc.frameTime, heatRates: doc.heatRates || null, hv: doc.hv || null });

  class TabSync {
    // on: { doc(shared) — another tab changed the project; run(state) — a run in another tab;
    //       holdsDevice() -> whether this tab has the OpenDrop connected }
    constructor(on) {
      this.on = on;
      this.id = Math.random().toString(36).slice(2);
      this.last = null; // the text last sent or taken in
      this.pending = null;
      this.timer = null;
      this.answers = [];
      try {
        this.channel = new root.BroadcastChannel('opendrop-generator');
        this.channel.onmessage = (evt) => this.receive(evt.data);
      } catch {
        this.channel = null;
      }
    }

    post(message) {
      if (this.channel) this.channel.postMessage({ ...message, from: this.id });
    }

    // After a change here: the project goes to the other tabs shortly (changes made in quick
    // succession, such as a drag, go as one).
    changed(doc) {
      const text = canon(shared(doc));
      if (text === this.last || text === this.pending) return;
      this.pending = text;
      clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        this.last = this.pending;
        this.pending = null;
        this.post({ kind: 'doc', text: this.last });
      }, 150);
    }

    // Takes the current project as the one in step (after opening or taking one in).
    settle(doc) {
      this.last = canon(shared(doc));
    }

    run(state) {
      this.post({ kind: 'run', state });
    }

    receive(message) {
      if (!message || message.from === this.id) return;
      if (message.kind === 'doc') {
        if (this.pending) return; // a change of this tab's goes out in a moment and wins
        this.last = message.text;
        this.on.doc(JSON.parse(message.text));
      } else if (message.kind === 'run') this.on.run(message.state);
      else if (message.kind === 'device?') {
        if (this.on.holdsDevice()) this.post({ kind: 'device!' });
      } else if (message.kind === 'device!') for (const resolve of this.answers.splice(0)) resolve(true);
    }

    // Whether another tab has the OpenDrop connected (asked, then waited for a moment).
    deviceElsewhere(wait = 250) {
      if (!this.channel) return Promise.resolve(false);
      return new Promise((resolve) => {
        this.answers.push(resolve);
        this.post({ kind: 'device?' });
        setTimeout(() => resolve(false), wait);
      });
    }
  }

  (root.OD = root.OD || {}).sync = { TabSync, canon, shared };
})(globalThis);
