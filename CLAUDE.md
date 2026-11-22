# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

OpenDrop Generator (nanoSYD software) is a static browser app for designing and running electrode
sequences on the OpenDrop V4 digital-microfluidics board, and for driving the board over USB. It
started as a port of GaudiLabs' Processing app OpenDropController4_25 and still reads and writes
its `.json` frame files.

## Commands

- Run: open `index.html` in Chrome or Edge (double-click works; no server, no build, no
  dependencies). `index.html#sim` adds a **Simulated OpenDrop** button to the Device tab;
  `#sim1` simulates one that also speaks protocol 1, `#simstock` one with stock firmware.
- All tests: `node --test` (Node 20+); or `node --test tests/*.test.js`.
- One file: `node --test tests/device.test.js`. One test: `node --test --test-name-pattern="screen message" tests/device.test.js`.
- Syntax check: `node --check js/<file>.js` (there is no linter or package.json).
- Browser check from here: the chrome-devtools MCP needs Chrome's remote debugging switched on
  (usually it isn't). Instead start headless Chrome yourself
  (`"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --user-data-dir=<tmp>
  --remote-debugging-port=93xx "file://$PWD/index.html#sim"`) and drive it from node 24 with the
  built-in `WebSocket` (`Runtime.evaluate`, `awaitPromise`). `--dump-dom` is useless: it dumps
  before any timer fires. In the page, `OD.app` exposes editor, runner, device, redraw.
- Regenerate `js/layouts-data.js`: `node tools/convert-layouts.js <path to OpenDropController4_25>`.

Tests that open a device `Session` run on real timers and poll; always `t.after(() => s.detach())`
or a failing test leaves a timer running and `node --test` hangs instead of finishing.

## Architecture

**Modules.** Plain scripts, no bundler and no ES modules, so the page works from `file://`. Each
file is a UMD-style factory: in node it `require`s its dependencies and exports; in the page it
registers on `globalThis.OD.<name>`. Script order in `index.html` is the dependency order. Files
with no DOM (clock, model, compile, lines, paths, templates, project, process, stretch, schedule, editor,
heat, device, device-sim, runner, jsonio, layout) are tested in node; `view`, `chart`, `timeline`,
`tempchart`, `serial`, `devicepanel`, `seriallog`, `processview`, `processpanel`, `sync` and
`app` are browser-only (`app.js` wires everything to the page).

**Actions → frames.** A project (`js/project.js`, `*.odproj`) holds *actions*, not frames:
paths (kept as corner points, `js/lines.js`), templates (mixers, merge/split), dispenses, painted
patterns, waits, and settings (`temp`, `magnet`, `message`). Actions start at a frame or `after`
other actions. `js/compile.js` turns them into a `Sequence` (`js/model.js`: per-frame electrodes,
times, holds, and per-frame *controls* = heater targets, magnets, screen message) and checks that
no two droplets touch; editing is refused if it would. Frames exist only as compiled output and
on export (`js/jsonio.js`). `js/editor.js` is the editing state (selection, drags, undo, notices);
every change goes through it and is recompiled.

**The process.** Optionally a project has a flowchart (`js/process.js`: tiles, arrows, checks,
`Walk`). *Stops* (Start, Measure, Ask, Decision, Repeat, End) split it into *stretches*; the work
tiles of one stretch share one board and one timeline (`js/stretch.js`: which actions belong to
which tile, droplets and controls carried in from the stretch before). Placing a tile on the board
creates its actions with `tile: <id>`, linked `after` the last actions of the steps before it
(`editor.orderAfter`). Setting steps (Wait, Message, Temperature, Magnet: `SETTING_KINDS` in
`js/editor.js`) are never placed by hand: every `ed.processChange` runs `placeSettings()` inside
the same undo step, which places them once an arrow leads to them, makes the next step's actions
follow one dropped between two placed steps, and re-links one whose arrows moved. Process edits
must go through `ed.processChange` for this (and undo) to work. `js/schedule.js` lays the whole process out in time,
including parallel lanes that run side by side and stops inside lanes; the timeline shows the
whole process along one route. `js/runner.js` runs a process (it still walks with `P.Walk`; moving
it to `schedule.js` is unfinished work). While a run goes, `editor.frozen` makes everything
read-only and frames can't be stepped. **▶ Run** runs on the OpenDrop (needs it connected;
`device.follow()` turns the session's `live` on, `allOff()` at the end) and **simulate** (the board's
play box and Space, `toggleSimulate` in `app.js`) is the same run in the browser only; without a process both play the sequence once
(`runner.playSequence`). There is no live switch in the UI: the device follows the board only
during ▶ Run. The editor's looping `togglePlay` is no longer reachable from the page (user's
choice: no ▶ Simulate in the top bar, no looping preview; the board box labelled simulate runs it). A run in another tab locks this one via `js/sync.js`
(BroadcastChannel, two tabs of the page stay in step).

**The device.** `js/device.js` is the protocol and session, with no DOM: 32-byte packets out,
24-byte answers back, lining up the byte stream, one frame in flight, polling. The firmware is the
user's own custom firmware (separate repo, `../firmware_custom`; its byte map is
`customFirmware/SERIAL_PROTOCOL.md`), on top of the original V4.2 protocol (`docs/device-protocol.md`):
- byte 17 = screen message length (text follows the packet; 255 clears), so electrodes 136–143
  are never sent; byte 25 = save settings to flash; bytes 29–31 = high voltage V, Hz/10, DC/AC
  (0 = keep). Ordinary frames send 0 in all of these; the high voltage goes once on connect or
  change, the message only when the screen should change.
- heater targets (26–28) are applied every packet: 0 = off (the default), never 25.
- magnets are bits of byte 16 (electrodes 129 = M1, 128 = M2), also applied every packet: a packet
  without the bit switches the magnet off. So `devicepanel.paint` sends `cellsIn(seq, f,
  ed.controlsAt(f))`, which adds a magnet that is on even where the sequence has no frame f.
  Switching a magnet keeps the firmware busy ~300 ms per magnet before it answers (`set_Magnet`:
  two `delay(150)`); `Link` tracks the device's magnet bits and waits `MAGNET_MS` more per magnet
  a frame (or lining up's zeros) switches, else it timed out, re-lined up with zeros and the magnet
  flipped off. The simulator does the same (`magnetMs`).
- command frames (a message, save or high voltage: `isCommand`) get a 25th answer byte,
  `0xA0 | flags` (0x01 HV applied, 0x02 saved, 0x04 message stored, 0x08 menu open: HV/save
  ignored); ordinary frames and lining up stay at 24. No 25th byte = stock firmware: no more
  messages to it (their text would knock it out of step).
- byte 23 is the command of "protocol 1" (whole sequence run on the device's clock), a proposal
  that no firmware implements yet.
`js/device-sim.js` mirrors the firmware byte for byte (`firmware: 'stock'`, `#simstock`, for the original); when the firmware's protocol changes,
change `device.js`, the simulator, `docs/device-protocol.md` and the tests together.
`js/serial.js` is Web Serial; `js/devicepanel.js` the Device tab; `js/seriallog.js` its traffic
log (`Link.tap` sees every packet and answer).

**Background tab.** Chrome slows a hidden tab's timers (1/s, then 1/min) and stops its animation
frames, and frames reach the device only from `paint()`. So the runner, the device `Session` and
the simulator get `OD.clock.timers()` (`js/clock.js`: setTimeout kept by a blob worker, works from
`file://`), and `redraw()` in `app.js` uses that clock instead of `requestAnimationFrame` while
`document.hidden`. New timing that must go on in the background uses the same clock.

## Rules for changes

- Every user-facing change also updates `manual.html` (the user manual, plain words) and
  `ai-help.md` (a guide an AI reads with a photo of the screen to troubleshoot: screen parts,
  every message and its fix). Update `README.md` where it describes the feature or file format.
- Text in the UI, status messages and docs is short and plain; UI strings say what happens and
  what to do.
- Project files keep fields this version doesn't know (`js/project.js`); older files must keep
  opening (convert old fields on load, as Ask-with-a-number becomes Measure).

## Open items (as of 2026-11-22)

- **Droplet electrodes go off during a Wait:** in Start → Dispense → Magnet → Wait 10 s, the
  Wait frame sends only the magnet (`[129]`), no droplet electrodes, though a Wait "holds the
  droplets where they are". Asked the user whether this is what they meant by "it isn't turned on
  when there's just a wait"; not fixed yet.
- In the same run the magnet came on at frame 1 (before the Dispense it follows), and the 10 s
  Wait lasted ~7 s on the board. Not looked into.
- Not tried on the real board yet: background runs (`js/clock.js`), ▶ Run on the device, both
  magnet fixes (user said the magnet still didn't stay on; the cause wasn't reproduced in node or
  the simulator after the fixes).

