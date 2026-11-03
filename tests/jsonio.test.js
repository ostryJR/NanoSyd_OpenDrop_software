'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { encode, decode } = require('../js/jsonio.js');
const { Sequence, MAX_FRAMES, CELLS, DEFAULT_FRAME_TIME, MAX_TIME, MIN_TIME } = require('../js/model.js');

const Z = '0'.repeat(18);

// Small seeded random generator so failures can be reproduced.
function random(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomSequence(rand, last) {
  const seq = new Sequence();
  for (let f = 1; f <= last; f++) for (let e = 0; e < CELLS; e++) if (rand() < 0.06) seq.set(e, f, true);
  seq.set(Math.floor(rand() * CELLS), last, true);
  return seq;
}

// Line-by-line port of the original's fileSaved() with frameMax(), fluxValue() and binary(),
// used as an independent reference for encode().
function originalSave(seq) {
  let x = 0;
  let z = MAX_FRAMES;
  while (!seq.get(x, z) && z > 1) {
    if (x < CELLS - 1) x++;
    else {
      x = 0;
      z--;
    }
  }
  const values = [];
  for (let i = 1; i < z + 1; i++) {
    const item = { frame: i };
    for (let y = 0; y < 8; y++) {
      let val = 0;
      for (let j = 0; j < 18; j++) val += (seq.get((17 - j) * 8 + y, i) ? 1 : 0) * 2 ** j;
      item['y' + y] = val.toString(2).padStart(18, '0');
    }
    values.push(item);
  }
  return values;
}

// Line-by-line port of the original's fileLoad(): every '1' goes into frame (position + 1).
function originalLoad(values) {
  const seq = new Sequence();
  values.forEach((item, i) => {
    for (let y = 0; y < 8; y++) {
      const name = item['y' + y];
      for (let j = 0; j < name.length; j++) if (name.charAt(j) === '1') seq.set(j * 8 + y, i + 1, true);
    }
  });
  return seq;
}

// The original's output has no "time"; compare everything else.
const withoutTime = (values) => values.map(({ time, ...rest }) => rest);

const assertSameFrames = (a, b) => {
  for (let f = 1; f <= MAX_FRAMES; f++) assert.deepEqual(a.frames[f], b.frames[f], `frame ${f}`);
};

test('each electrode is the character at its column in the row of its row number', () => {
  const seq = new Sequence();
  seq.set(9, 1, true); // column 1, row 1
  seq.set(0, 1, true); // column 0 (left reservoirs), row 0
  seq.set(128, 1, true); // column 16 (magnets), row 0
  seq.set(143, 1, true); // column 17, row 7
  const [frame] = JSON.parse(encode(seq));
  assert.equal(frame.y0, '100000000000000010');
  assert.equal(frame.y1, '010000000000000000');
  assert.equal(frame.y7, '000000000000000001');
  for (const r of [2, 3, 4, 5, 6]) assert.equal(frame['y' + r], Z);
  assert.equal(frame.frame, 1);
});

test('a single frame is laid out like Processing writes it, with the frame time last', () => {
  const seq = new Sequence();
  seq.set(9, 1, true);
  assert.equal(
    encode(seq),
    `[{
  "y0": "${Z}",
  "y1": "010000000000000000",
  "y2": "${Z}",
  "y3": "${Z}",
  "y4": "${Z}",
  "y5": "${Z}",
  "y6": "${Z}",
  "y7": "${Z}",
  "frame": 1,
  "time": ${DEFAULT_FRAME_TIME}
}]`
  );
});

test('several frames are laid out like Processing writes them, each with its time', () => {
  const seq = new Sequence();
  seq.set(8, 1, true);
  seq.set(143, 2, true);
  seq.frameTime = 300;
  seq.setTime(2, 2000);
  assert.equal(
    encode(seq),
    `[
  {
    "y0": "010000000000000000",
    "y1": "${Z}",
    "y2": "${Z}",
    "y3": "${Z}",
    "y4": "${Z}",
    "y5": "${Z}",
    "y6": "${Z}",
    "y7": "${Z}",
    "frame": 1,
    "time": 300
  },
  {
    "y0": "${Z}",
    "y1": "${Z}",
    "y2": "${Z}",
    "y3": "${Z}",
    "y4": "${Z}",
    "y5": "${Z}",
    "y6": "${Z}",
    "y7": "000000000000000001",
    "frame": 2,
    "time": 2000
  }
]`
  );
});

test('key order is the iteration order of the Java HashMap Processing uses', () => {
  const javaHash = (s) => {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
    return h;
  };
  const buckets = Array.from({ length: 16 }, () => []);
  for (const key of ['frame', 'y0', 'y1', 'y2', 'y3', 'y4', 'y5', 'y6', 'y7']) {
    const h = javaHash(key);
    buckets[(h ^ (h >>> 16)) & 15].push(key);
  }
  assert.deepEqual(Object.keys(JSON.parse(encode(new Sequence()))[0]), [...buckets.flat(), 'time']);
});

test('encode matches the original fileSaved() on random sequences, apart from the times', () => {
  const rand = random(42);
  for (const last of [1, 2, 3, 17, 64, 199, MAX_FRAMES]) {
    const seq = randomSequence(rand, last);
    assert.deepEqual(withoutTime(JSON.parse(encode(seq))), originalSave(seq), `last frame ${last}`);
  }
  assert.deepEqual(withoutTime(JSON.parse(encode(new Sequence()))), originalSave(new Sequence()), 'empty sequence');
});

test('frame times round-trip: the default and each frame of its own', () => {
  const seq = new Sequence();
  for (let f = 1; f <= 6; f++) seq.set(8 + f, f, true);
  seq.frameTime = 250;
  seq.setTime(2, 2000);
  seq.setTime(5, 40);
  const values = JSON.parse(encode(seq));
  assert.deepEqual(values.map((v) => v.time), [250, 2000, 250, 250, 40, 250]);
  const { seq: back, timed } = decode(encode(seq));
  assert.ok(timed);
  assert.equal(back.frameTime, 250);
  assert.deepEqual([...back.times.slice(1, 7)], [0, 2000, 0, 0, 40, 0]);
  assert.equal(back.elapsed(6), 250 * 4 + 2000 + 40);
});

test('loading times: the most common is the default, odd values are clamped or ignored', () => {
  const frame = (f, time) => `{"y0": "1", "frame": ${f}${time === undefined ? '' : `, "time": ${JSON.stringify(time)}`}}`;
  const text = `[${[frame(1, 1000), frame(2, 700), frame(3, 700), frame(4, 5), frame(5, 1e12), frame(6, -3), frame(7, '9'), frame(8)].join(',')}]`;
  const { seq, timed } = decode(text);
  assert.ok(timed);
  assert.equal(seq.frameTime, 700);
  assert.deepEqual([...seq.times.slice(1, 9)], [1000, 0, 0, MIN_TIME, MAX_TIME, 0, 0, 0]);

  const untimed = decode('[{"y0": "1", "frame": 1}]');
  assert.equal(untimed.timed, false);
  assert.equal(untimed.seq.frameTime, DEFAULT_FRAME_TIME);
});

test('decode reads saved files like the original fileLoad(), and round-trips', () => {
  const rand = random(7);
  for (const last of [1, 5, 120, MAX_FRAMES]) {
    const seq = randomSequence(rand, last);
    const text = encode(seq);
    const result = decode(text);
    assertSameFrames(result.seq, seq);
    assertSameFrames(result.seq, originalLoad(JSON.parse(text)));
    assert.equal(result.frames, last);
    assert.deepEqual(result.warnings, []);
  }
});

test('reads files from controller 3.2 (leading null, 16-character rows)', () => {
  const text = `[
  null,
  {
    "y0": "0100000000000000",
    "y1": "0000000000000000",
    "y2": "0000000000000000",
    "y3": "0000000000000000",
    "y4": "0000000000000000",
    "y5": "0000000000000000",
    "y6": "0000000000000000",
    "y7": "0000000000000000",
    "frame": 1
  },
  {
    "y0": "0000000000000000",
    "y1": "0000000000000000",
    "y2": "0000000000000000",
    "y3": "0000000000000001",
    "y4": "0000000000000000",
    "y5": "0000000000000000",
    "y6": "0000000000000000",
    "y7": "0000000000000000",
    "frame": 2
  }
]`;
  const { seq, frames, warnings } = decode(text);
  assert.equal(frames, 2);
  assert.deepEqual(warnings, []);
  assert.ok(seq.get(8, 1));
  assert.ok(seq.get(15 * 8 + 3, 2));
  assert.equal(seq.lastFrame(), 2);
});

test('accepts trailing commas, as Processing does', () => {
  const { seq } = decode('[{"y0": "01", "frame": 1,},]');
  assert.ok(seq.get(8, 1));
});

test('frames after 200 and columns after 17 are skipped with a warning', () => {
  const rows = (y0) => `"y0": "${y0}", "y1": "0", "y2": "0", "y3": "0", "y4": "0", "y5": "0", "y6": "0", "y7": "0"`;
  const text = `[{${rows('1' + '0'.repeat(17) + '1')}, "frame": 1}, {${rows('1')}, "frame": 201}]`;
  const { seq, frames, warnings } = decode(text);
  assert.ok(seq.get(0, 1));
  assert.equal(frames, 1);
  assert.equal(warnings.length, 2);
  assert.match(warnings.join(' '), /after frame 200/);
  assert.match(warnings.join(' '), /after column 17/);
});

test('rejects text that is not a list of frames', () => {
  assert.throws(() => decode('{"y0": "1"}'), /list of frames/);
  assert.throws(() => decode('[1, 2, null]'), /no frames found/);
  assert.throws(() => decode('not json'), SyntaxError);
});
