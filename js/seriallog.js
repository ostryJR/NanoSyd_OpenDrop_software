/* The Device tab's traffic log: every packet sent to the OpenDrop and every answer, with the time,
 * the bytes in hex and what they say (js/device.js describeOut / describeIn), for debugging the
 * firmware and the connection. Off unless switched on; repeated status packets (the same packet
 * and the same answer as the time before) fold into one entry with a count. Copy and Save give it
 * as plain text. Plain DOM; the page makes one in the Device tab. */
(function (root) {
  'use strict';

  const D = root.OD.device;
  const MAX_ENTRIES = 3000; // the oldest go first
  const TEMP_BYTES = [D.IN.temps, D.IN.temps + 6]; // an answer's temperature readings (bytes 17-22)

  // The same answer, temperatures aside: readings change a little every time (and drift with no
  // sensor), so comparing them too would never fold anything.
  const sameAnswer = (a, b) => a.length === b.length && a.every((v, i) => v === b[i] || (i >= TEMP_BYTES[0] && i < TEMP_BYTES[1]));

  const clock = (t) => {
    const d = new Date(t);
    const two = (n) => String(n).padStart(2, '0');
    return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
  };
  const ascii = (bytes) => String.fromCharCode(...Array.from(bytes, (b) => (b >= 32 && b < 127 ? b : 46))).replace(/\.+$/, '');

  // One logged event as words: { arrow, title, text }.
  function describe(e) {
    switch (e.dir) {
      case 'out':
        return { arrow: '→', title: `sent ${e.bytes.length} bytes`, text: D.describeOut(e.bytes) };
      case 'in':
        return { arrow: '←', title: `answer, ${e.bytes.length} bytes`, text: D.describeIn(e.bytes) + (e.noAck ? ' · no confirmation byte (stock firmware?)' : '') };
      case 'none':
        return { arrow: '×', title: 'no answer', text: `nothing came back within ${e.wait} ms` };
      case 'text':
        return { arrow: '←', title: 'text from the device', text: `“${ascii(e.bytes).trim()}” (dropped: not an answer)` };
      default:
        return { arrow: '←', title: `${e.bytes.length} bytes nothing asked for`, text: 'dropped' };
    }
  }

  class SerialLog {
    // dom: { on, fold, clear, copy, save, list, count }; app: { setStatus(text, kind) }
    constructor(dom, app) {
      this.dom = dom;
      this.app = app;
      this.entries = []; // { t, dir, bytes, wait, count, row }
      this.held = null; // an 'out' like the last one, kept until its answer shows whether it folds
      this.on = false;
      dom.on.addEventListener('change', () => this.setOn(dom.on.checked));
      dom.clear.addEventListener('click', () => this.clear());
      dom.copy.addEventListener('click', () => this.copy());
      dom.save.addEventListener('click', () => this.save());
      this.showCount();
    }

    setOn(on) {
      this.on = Boolean(on);
      this.dom.on.checked = this.on;
      if (!this.on) this.flush();
      this.app.setStatus(this.on ? 'Logging what is sent to the device and what comes back (Device tab)' : 'Traffic log stopped');
    }

    // From the link (Session.tap).
    add(e) {
      if (!this.on) return;
      const entry = { t: Date.now(), dir: e.dir, bytes: e.bytes, wait: e.wait, noAck: Boolean(e.noAck), count: 1, row: null };
      const fold = this.dom.fold.checked;
      const n = this.entries.length;
      const last = this.entries[n - 1];
      const before = this.entries[n - 2];
      if (this.held) {
        const out = this.held;
        this.held = null;
        // The same answer (temperatures aside) to the same packet as last time: one more of that
        // pair; the answer shows the latest readings.
        if (fold && entry.dir === 'in' && last && last.dir === 'in' && sameAnswer(entry.bytes, last.bytes)) {
          before.count++;
          last.count++;
          before.t = out.t;
          last.t = entry.t;
          if (!D.sameBytes(entry.bytes, last.bytes)) last.varied = true;
          last.bytes = entry.bytes;
          this.render(before);
          this.render(last);
          return;
        }
        this.push(out);
      }
      if (fold && entry.dir === 'out' && last && last.dir === 'in' && before && before.dir === 'out' && D.sameBytes(entry.bytes, before.bytes)) {
        this.held = entry;
        return;
      }
      this.push(entry);
    }

    flush() {
      if (!this.held) return;
      const out = this.held;
      this.held = null;
      this.push(out);
    }

    push(entry) {
      this.entries.push(entry);
      if (this.entries.length > MAX_ENTRIES) {
        const gone = this.entries.splice(0, this.entries.length - MAX_ENTRIES);
        for (const g of gone) if (g.row) g.row.remove();
      }
      const list = this.dom.list;
      const atEnd = list.scrollTop + list.clientHeight >= list.scrollHeight - 4;
      this.render(entry);
      list.appendChild(entry.row);
      if (atEnd) list.scrollTop = list.scrollHeight;
      this.showCount();
    }

    render(entry) {
      const { arrow, title, text } = describe(entry);
      const row = entry.row || document.createElement('div');
      row.className = `log-entry ${entry.dir}`;
      row.replaceChildren();
      const head = document.createElement('div');
      head.className = 'log-head';
      head.textContent = `${clock(entry.t)}  ${arrow} ${title}${entry.count > 1 ? `  ×${entry.count}` : ''}${entry.varied ? ' (temperatures: the latest)' : ''}`;
      const words = document.createElement('div');
      words.className = 'log-words';
      words.textContent = text;
      row.append(head, words);
      if (entry.bytes.length) {
        const bytes = document.createElement('div');
        bytes.className = 'log-bytes';
        bytes.textContent = D.hex(entry.bytes);
        row.append(bytes);
      }
      entry.row = row;
    }

    showCount() {
      const n = this.entries.length;
      this.dom.count.textContent = n ? `${n} entr${n === 1 ? 'y' : 'ies'}${n >= MAX_ENTRIES ? ` (the last ${MAX_ENTRIES})` : ''}` : 'Nothing logged yet';
    }

    clear() {
      this.entries = [];
      this.held = null;
      this.dom.list.replaceChildren();
      this.showCount();
    }

    // The whole log as text: a line per entry, its bytes in hex on the next.
    text() {
      this.flush();
      return this.entries
        .map((e) => {
          const { arrow, title, text } = describe(e);
          const head = `${clock(e.t)} ${arrow} ${title}${e.count > 1 ? ` ×${e.count}` : ''}${e.varied ? ' (temperatures: the latest)' : ''}: ${text}`;
          return e.bytes.length ? `${head}\n    ${D.hex(e.bytes)}` : head;
        })
        .join('\n');
    }

    async copy() {
      const text = this.text();
      if (!text) return this.app.setStatus('The traffic log is empty', 'warn');
      try {
        await navigator.clipboard.writeText(text);
        this.app.setStatus(`Copied the traffic log (${this.entries.length} entries)`);
      } catch {
        this.app.setStatus('Could not copy: use Save instead', 'warn');
      }
    }

    save() {
      const text = this.text();
      if (!text) return this.app.setStatus('The traffic log is empty', 'warn');
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([`${text}\n`], { type: 'text/plain' }));
      a.download = `opendrop-traffic-${stamp}.txt`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      this.app.setStatus(`Saved the traffic log as ${a.download}`);
    }
  }

  (root.OD = root.OD || {}).serialLog = { SerialLog, describe };
})(typeof globalThis !== 'undefined' ? globalThis : this);
