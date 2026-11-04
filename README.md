# OpenDrop Generator

A browser app for drawing electrode sequences for the OpenDrop V4 digital-microfluidics platform
and exporting them as the `.json` frame files used by GaudiLabs' **OpenDropController4_25**. It
started as a port of that controller's editor and adds drag-to-draw droplet paths, templates for
operations such as mixing or splitting, frame times with a timing chart, and undo. What you draw is
kept as **actions** (a path, a template, a dispense, a painted pattern) in a project file, so it can
be moved and reshaped later; the frames are worked out from the actions, and written out on export.
It does not talk to the device.

## Run

Open `index.html` in Chrome or Edge. Double-clicking the file works: there is no server, nothing
to install, and it runs offline. Safari and Firefox work too, but there save and export ask for a
file name and download the file instead of showing a save dialog.

## Controls

| To | Do |
|---|---|
| Draw a droplet path | Drag from the droplet's electrode. Every electrode you pass is the next frame. The path shows in blue with its step count until you let go, and is added then. **Esc** cancels; going back along the path takes steps back |
| Draw a path in straight lines | Choose **straight** on the left (or press **S**). The path runs along the row or column you start dragging in, then turns once to the blue end electrode |
| Select something drawn | Click it (with any tool but paint): the action on that electrode in the frame on screen, or a path's line. Clicking again picks the next one below. Or click it in the Actions list. **Esc** lets go |
| Move it | Choose **select** (**V**) and drag it, or ⌥/Alt + arrow keys. Paths leading into and out of a template or pattern follow it. Where it doesn't fit it shows red and nothing changes |
| Reshape a path | With **select**, drag a straight piece of the selected path sideways, or drag a corner, its start or its end. Shift+drag moves the whole path. Double-click on the line adds a point; double-click a point removes it |
| Delete it | Delete or Backspace, × in the Actions list, or **Delete** under it |
| Name it | The Name and Droplet fields under the Actions list |
| Switch electrodes on or off | Choose **paint** (**P**) and click or drag, as in the original; the first electrode decides on or off. What you paint is kept as a pattern |
| Go to the next frame and switch an electrode on | Shift+click |
| Undo / redo | ⌘Z / ⇧⌘Z (Ctrl+Z / Ctrl+Y on Windows and Linux), or **undo** / **redo** on the left |
| Change frame | ← / →, the mouse wheel (up = next), or the arrows under the array |
| Play / stop | Space or the **play** button; loops up to the last frame with anything on |
| Change playback speed | Mouse wheel while playing (5–600 frames/min); this sets the default frame time |
| Set frame times | The timing strip under the board: a default frame time, and the frame on screen's own time (empty = the default). Each action can also have a time per step, under the Actions list |
| Drop a template | Drag it from the Templates tab onto the electrode the droplet is on; **R** turns it, **Esc** cancels |
| Make a template | **+ New** in the Templates tab, or ✎ on a template to change it (or a copy of a built-in one) |
| Make room for the board | **▾ Timing** folds the timing strip to one line; **›** shrinks the side panel to a tab |
| Copy the previous frame, clear the frame, clear everything | Buttons on the right |
| Dispense a droplet from a reservoir | The four buttons beside the reservoirs (6 frames) |
| Save / open a project | **save** (⌘S / Ctrl+S) / **load**, top right. **load** also opens OpenDrop `.json` files |
| Export for the OpenDrop controller | **export**, top right |
| Show electrode numbers / paths' lines | `N` / `L`, or the checkboxes in the bottom bar |
| Use another cartridge layout | The Layout menu (all layouts from the original repository) |

## Actions

Everything you draw becomes an action, listed in the **Actions** tab in the order they start:

- **Path**: drawn with freehand or straight. It is kept as a line, its start, end and corners;
  the electrodes in between are worked out from the layout, so reshaping it changes them.
- **Template**: dropped from the Templates tab. The project keeps its own copy of the template.
- **Dispense**: a reservoir button. It stays at its reservoir.
- **Pattern**: electrodes switched on with paint, Shift+click or copy last frame, frame by frame.
  An OpenDrop file you open becomes one pattern.

Each action starts in a frame, or **after another action**: in that action's last frame, where it
hands the droplet over. That link is made when you carry on from where an action ends (the frame on
screen and the electrode match), and the new action takes that action's droplet name. So when a
path gets longer, everything linked after it moves later. Drawing on from the free end of the
selected path makes that path longer instead of adding a new one.

Each action has a **name** and a **droplet** name (renaming a droplet renames it down the chain).
The droplet names colour the paths' lines and the list.

The list shows problems in red, such as an action that doesn't fit the layout, runs past frame
200, or doesn't start where the action it follows ends (the droplet would jump).

## Paths

- A path starts in the frame on screen, on the electrode you press, and moves one electrode per
  frame: a path of n steps fills that frame and the n after it.
- Paths are added on top of what those frames already hold, so several droplets can move at once:
  go back to the start frame and draw the next droplet's path.
- When a path is added, the view moves to its last frame, so the next drag carries on from there.
- Droplets only step between electrodes that share an edge. Diagonal or fast drags are filled in
  with the shortest route, and electrodes a droplet can't reach (such as the magnets) are skipped.
  The reservoirs join the grid where their dispense sequences do.
- A straight piece runs one way on screen, left, right, up or down, between neighbouring electrodes.
  Dragging a piece sideways stretches the pieces next to it; at the start or end, or where the line
  carries on straight, a short connecting piece is added. The ends only move when you drag them.
- Paths stop at frame 200.

## Frame times and the chart

- Each frame lasts the **default frame time** (0.5 s, the original's 120 frames/min) unless an
  action in it says otherwise: its **time per step**, or the time set for that frame in the timing
  strip. That time goes on the selected action if it runs in the frame (on a path it is a wait on
  the electrode the droplet is on, which stays there when the path is reshaped), otherwise on the
  actions in the frame. Times are undoable like drawing; the default is a setting.
- A frame lasts as long as the longest step in it. When that makes other actions wait, the timing
  strip says so and offers **Let the others keep moving**: the long step then stretches over as
  many frames as the others take (it may end up to one frame later than asked). **Make them wait**
  turns that off.
- Playback holds every frame for its time.
- The chart under the board shows each step's time (gray = default, blue = its own) or the total
  time so far, against the step number. Hover for the numbers, click or drag to go to a step, or
  switch to **Table** for the list.

## Templates

- Built in: circle mixing on 2 × 2 and 3 × 3 squares, back-and-forth mixing, split, merge, and
  split & merge. Each shows its number of steps.
- A template is dropped by its first frame's leftmost electrode (the top one if there are several),
  starting in the frame on screen. Like a path, it is added on top of what those frames hold, then
  the view moves to its last frame. Where it doesn't fit (off the array, or past frame 200) it
  shows red and nothing is added.
- **+ New** sets the project aside and gives you a blank board: draw the operation from frame 1
  with any tool (own frame times are kept), name it and save it. The project comes back as it was.
  Changing a template opens it as a pattern that paint edits.
- Your templates are kept in the browser. **Export…** writes them to a file and **Import…** reads
  one back, to move them to another browser or computer or to share them.

## Project files (`*.odproj.json`)

What **save** writes and **load** opens. JSON, one field per line:

```json
{
  "openDropGeneratorProject": 1,
  "layout": "electrodes",
  "frameTime": 500,
  "templates": {
    "circle-2x2": {"name":"Circle mix 2×2, 3 rounds","frames":[[[0,0]],[[1,0]],[[1,1]],…]}
  },
  "actions": [
    {
      "id": "a1",
      "type": "dispense",
      "name": "Dispense left top",
      "droplet": "Sample",
      "start": 1,
      "reservoir": "reservoirLeftTop"
    },
    {
      "id": "a2",
      "type": "path",
      "name": "Sample to mixer",
      "droplet": "Sample",
      "after": "a1",
      "points": [{"e":9},{"e":41,"wait":5000},{"e":44}],
      "stepTime": 500
    },
    {
      "id": "a3",
      "type": "template",
      "name": "Circle mix 2×2, 3 rounds",
      "droplet": "Sample",
      "after": "a2",
      "template": "circle-2x2",
      "at": 44,
      "turns": 0,
      "split": true
    },
    {
      "id": "a4",
      "type": "pattern",
      "name": "old.json",
      "droplet": "",
      "start": 1,
      "frames": [[8,9],[16,128],[]],
      "times": [0,2000,0]
    }
  ]
}
```

- `openDropGeneratorProject` is the format version; `layout` the cartridge layout; `frameTime`
  the default frame time in ms; `templates` copies of the templates the actions use.
- Every action has an `id`, a `type`, a `name` and a `droplet` name, and **either** `start` (its
  first frame, 1–200) **or** `after` (the id of the action it follows; it starts in that action's
  last frame) with an optional `delay` in frames.
- Optional on every action: `stepTime` (ms per step; default `frameTime`), `times` (own ms per step,
  0 = default; templates, dispenses and patterns), and `split: true` (long steps stretch over frames
  instead of making the others wait).
- `path`: `points` are electrodes (`e` = column × 8 + row), joined by straight pieces; `wait` is how
  long the droplet stays on that point, in ms.
- `template`: dropped with its anchor on electrode `at`, turned `turns` quarter turns clockwise;
  `template` is a key into `templates`, whose frames list `[column, row]` offsets from the anchor.
- `dispense`: `reservoir` is one of `reservoirLeftTop`, `reservoirLeftBottom`, `reservoirRightTop`,
  `reservoirRightBottom`.
- `pattern`: `frames` lists the electrodes on in each of its frames, control lines (128–143)
  included; they don't move when the pattern does.
- Room for later: action types and fields this version doesn't know are kept when a file is opened
  and written back when it is saved (the list shows them as not supported). Reserved for logic and
  conditions: `measure` (a value from an external instrument), `prompt` (ask the operator), `loop`
  (`children`, `until`, `max`), `branch` (`if`/`then`/`else`), `when` on links, `after` as a list
  (start when several actions have all ended), and a top-level `inputs`.

## Exported files (OpenDrop `.json`)

What **export** writes: the same layout as OpenDropController4_25, with each frame's time added.
**load** opens these too, as one pattern.

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
- If some actions won't come out as drawn, the first press of **export** says so; press it again
  within 10 s to export anyway.

## Differences from the original

- What you draw is kept as actions in a project file and can be moved or reshaped; the frames are
  exported separately.
- Dragging draws droplet paths (freehand or straight) that are added when you let go; the original
  drag is the **paint** tool. A click selects; paint switches single electrodes.
- Undo and redo, templates, and frame times with a chart.
- Works without a device. The live-control parts (connect, life, feedback, temperatures) are left out.
- Loading replaces the current project; the original merged the file into whatever was on screen.
- Export doesn't add a second `.json` to the name.
- Loading skips frames after 200 instead of crashing, and also reads files from controller 3.2.
- A fast paint drag paints every electrode along the way.

## Development

- Tests: `node --test` (Node 20 or later).
- `js/layouts-data.js` is generated from the original layout files:
  `node tools/convert-layouts.js <path to OpenDrop/OpenDropController4_25>`.
- `js/project.js` is the project file, `js/compile.js` turns actions into frames, `js/lines.js`
  holds paths as lines and their edits, `js/editor.js` the editing behaviour and undo,
  `js/paths.js` the droplet routes and the path being drawn, `js/templates.js` the templates,
  `js/model.js` the frames and their times, `js/jsonio.js` the OpenDrop file format, `js/view.js`
  the board, `js/chart.js` the timing chart and `js/app.js` the page wiring. All but the last three
  run without a browser.

## License

GPL-3.0, see `LICENSE`. Based on [OpenDrop](https://github.com/GaudiLabs/OpenDrop) by GaudiLabs:
the frame image, the electrode layouts and the editor behaviour come from OpenDropController4_25.
