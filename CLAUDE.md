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
- Regenerate `js/layouts-data.js`: `node tools/convert-layouts.js <path to OpenDropController4_25>`.

Tests that open a device `Session` run on real timers and poll; always `t.after(() => s.detach())`
or a failing test leaves a timer running and `node --test` hangs instead of finishing.

## Architecture

**Modules.** Plain scripts, no bundler and no ES modules, so the page works from `file://`. Each
file is a UMD-style factory: in node it `require`s its dependencies and exports; in the page it
registers on `globalThis.OD.<name>`. Script order in `index.html` is the dependency order. Files
with no DOM (model, compile, lines, paths, templates, project, process, stretch, schedule, editor,
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
read-only and frames can't be stepped; a run in another tab locks this one via `js/sync.js`
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

## Rules for changes

- Every user-facing change also updates `manual.html` (the user manual, plain words) and
  `ai-help.md` (a guide an AI reads with a photo of the screen to troubleshoot: screen parts,
  every message and its fix). Update `README.md` where it describes the feature or file format.
- Text in the UI, status messages and docs is short and plain; UI strings say what happens and
  what to do.
- Project files keep fields this version doesn't know (`js/project.js`); older files must keep
  opening (convert old fields on load, as Ask-with-a-number becomes Measure).
