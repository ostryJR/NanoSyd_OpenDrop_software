// The background clock: timers kept by a worker, so a hidden tab's run doesn't slow down.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const clock = require('../js/clock.js');

// A page stand-in whose Worker runs the blob's code in a sandbox, messages going both ways.
function fakePage() {
  const blobs = new Map();
  let made = 0;
  class Blob {
    constructor(parts) {
      this.code = parts.join('');
    }
  }
  const URL = {
    createObjectURL(blob) {
      const url = `blob:${++made}`;
      blobs.set(url, blob.code);
      return url;
    },
  };
  class Worker {
    constructor(url) {
      const sandbox = { setTimeout, clearTimeout, postMessage: (data) => setImmediate(() => this.onmessage && this.onmessage({ data })) };
      vm.createContext(sandbox);
      vm.runInContext(blobs.get(url), sandbox);
      this.sandbox = sandbox;
    }
    postMessage(data) {
      setImmediate(() => this.sandbox.onmessage({ data }));
    }
  }
  return { Worker, Blob, URL };
}

test('worker timers call back after their time, and cleared ones never', async () => {
  const t = clock.workerTimers(fakePage());
  assert.ok(t);
  const calls = [];
  const from = Date.now();
  await new Promise((resolve) => {
    const gone = t.setTimeout(() => calls.push('cleared'), 5);
    t.clearTimeout(gone);
    t.setTimeout(() => calls.push('late'), 30);
    t.setTimeout(() => calls.push('soon'), 10);
    t.setTimeout(resolve, 60);
  });
  assert.deepEqual(calls, ['soon', 'late']);
  assert.ok(Date.now() - from >= 55);
});

test('without workers (or when one is refused) the page timers are used', () => {
  assert.equal(clock.workerTimers({}), null);
  const refusing = { ...fakePage(), Worker: class { constructor() { throw new Error('no'); } } };
  assert.equal(clock.workerTimers(refusing), null);
  const t = clock.timers(); // node has no Worker global
  assert.equal(typeof t.setTimeout, 'function');
  t.clearTimeout(t.setTimeout(() => assert.fail('cleared'), 1));
});
