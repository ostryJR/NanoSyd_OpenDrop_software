# OpenDrop Generator

A browser app for drawing electrode sequences for the OpenDrop V4 digital-microfluidics platform
and saving them as the `.json` frame files used by GaudiLabs' **OpenDropController4_25**. It is a
port of that controller's editor, plus drag-to-draw droplet paths, frame times with a timing
chart, and undo. It does not talk to the device.

## Run

Open `index.html` in Chrome or Edge. Double-clicking the file works: there is no server, nothing
to install, and it runs offline. Safari and Firefox work too, but there Save asks for a file name
and downloads the file instead of showing a save dialog.

## Controls

| To | Do |
|---|---|
| Draw a droplet path | Drag from the droplet's electrode. Every electrode you pass is the next frame. The path shows in blue with its step count until you let go, and is added then. **Esc** cancels; going back along the path takes steps back |
| Draw a path in straight lines | Choose **straight** on the left (or press **S**). The path runs along the row or column you start dragging in, then turns once to the blue end electrode |
| Switch an electrode on or off | Click it |
| Switch several on (or off) in one frame | Choose **paint** (**P**) and drag across them, as in the original; the first electrode decides on or off. **freehand** (**F**) goes back to drawing paths |
| Undo / redo | ⌘Z / ⇧⌘Z (Ctrl+Z / Ctrl+Y on Windows and Linux), or **undo** / **redo** on the left |
| Go to the next frame and switch an electrode on | Shift+click |
| Change frame | ← / →, the mouse wheel (up = next), or the arrows under the array |
| Play / stop | Space or the **play** button; loops up to the last frame with anything on |
| Change playback speed | Mouse wheel while playing (5–600 frames/min); this sets the default frame time |
| Set frame times | The timing strip under the board: a default frame time, and the frame on screen's own time (empty = the default) |
| Copy the previous frame, clear the frame, clear everything | Buttons on the right |
| Dispense a droplet from a reservoir | The four buttons beside the reservoirs (writes 6 frames) |
| Save / load a sequence | **save** / **load**, top right |
| Show electrode numbers | `N` or the checkbox in the bottom bar |
| Use another cartridge layout | The Layout menu (all layouts from the original repository) |

## Paths

- A path starts in the frame on screen, on the electrode you press, and moves one electrode per
  frame: a path of n steps fills that frame and the n after it.
- Paths are added on top of what those frames already hold, so several droplets can move at once:
  go back to the start frame and draw the next droplet's path.
- When a path is added, the view moves to its last frame, so the next drag carries on from there.
- Droplets only step between electrodes that share an edge. Diagonal or fast drags are filled in
  with the shortest route, and electrodes a droplet can't reach (such as the magnets) are skipped.
  The reservoirs join the grid where their dispense sequences do.
- Paths stop at frame 200.

## Frame times and the chart

- Each frame lasts the **default frame time** (0.5 s, the original's 120 frames/min) unless it has
  **its own time**. Own times are undoable like drawing; the default is a setting. Playback holds
  every frame for its time.
- The chart under the board shows each step's time (gray = default, blue = its own) or the total
  time so far, against the step number. Hover for the numbers, click or drag to go to a step, or
  switch to **Table** for the list.

## File format

The same layout as OpenDropController4_25, with each frame's time added:

```json
[
  {
    "y0": "010000000000000000",
    "y1": "000000000000000000",
    …
    "y7": "000000000000000000",
    "frame": 1,
    "time": 500
  },
  …
]
```

- One object per frame, from frame 1 to the last frame with any electrode on (at most 200).
- `"yR"` is row R (0 = top). Character k of it is column k, `1` = on. Electrode ID = column × 8 + row.
- Columns 0 and 15 are the left and right reservoirs, 1–14 the 14 × 8 grid, and 16–17 control
  lines (16 drives the magnets in the magnet layout).
- `"time"` is how long the frame lasts, in milliseconds. The original controller and the device
  firmware don't read it yet: the original ignores it, so files still open there. When loading, the
  most common time becomes the default frame time and the others the frames' own times; files
  without times keep the current default.

## Differences from the original

- Dragging draws droplet paths (freehand or straight) that are added when you let go; the original
  drag is the **paint** tool. A click still toggles an electrode, but when the button is released.
- Undo and redo, and frame times with a chart.
- Works without a device. The live-control parts (connect, life, feedback, temperatures) are left out.
- Loading replaces the current sequence; the original merged the file into whatever was on screen.
- Save doesn't add a second `.json` to the name.
- Loading skips frames after 200 instead of crashing, and also reads files from controller 3.2.
- A fast paint drag paints every electrode along the way.

## Development

- Tests: `node --test` (Node 20 or later).
- `js/layouts-data.js` is generated from the original layout files:
  `node tools/convert-layouts.js <path to OpenDrop/OpenDropController4_25>`.
- `js/editor.js` holds the editing behaviour and undo, `js/paths.js` the droplet routes and the
  path being drawn, `js/model.js` the frames and their times, `js/jsonio.js` the file format,
  `js/view.js` the board, `js/chart.js` the timing chart and `js/app.js` the page wiring. The
  first five run without a browser.

## License

GPL-3.0, see `LICENSE`. Based on [OpenDrop](https://github.com/GaudiLabs/OpenDrop) by GaudiLabs:
the frame image, the electrode layouts and the editor behaviour come from OpenDropController4_25.

