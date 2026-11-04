# OpenDrop Generator

A browser app for drawing electrode sequences for the OpenDrop V4 digital-microfluidics platform
and exporting them as the `.json` frame files used by GaudiLabs' **OpenDropController4_25**. It
started as a port of that controller's editor and adds drag-to-draw droplet paths, templates for
operations such as mixing or splitting, frame times, and undo. What you draw is kept as
**actions** (a path, a template, a dispense, a painted pattern) in a project file, shown in a
**timeline** under the board, one track per droplet, like a video editor. Actions can be moved and
reshaped later, and nothing is allowed to make two droplets touch by accident. The frames are
worked out from the actions and written out on export. It does not talk to the device.

## Run

Open `index.html` in Chrome or Edge. Double-clicking the file works: there is no server, nothing
to install, and it runs offline. Safari and Firefox work too, but there save and export ask for a
file name and download the file instead of showing a save dialog.

## Controls

| To | Do |
|---|---|
| Draw a droplet path | Drag from the droplet's electrode. Every electrode you pass is the next frame. The path shows in blue with its step count until you let go, and is added then. **Esc** cancels; going back along the path takes steps back |
| Draw a path in straight lines | Choose **straight** on the left (or press **S**). The path runs along the row or column you start dragging in, then turns once to the blue end electrode |
| Draw a path corner by corner | Shift+click where it starts, then Shift+click each corner (two pieces at a right angle when a click isn't in line). With a path selected, Shift+clicks carry on from its end. **Esc** stops |
| Select something drawn | Click its clip in the timeline, or click it on the board (any tool but paint): the action on that electrode in the frame on screen, or a path's line. Clicking again picks the next one below. **Esc** lets go |
| Reshape the selected path | With freehand, straight or select: drag a straight piece sideways, or drag a corner or its start. Dragging its free end draws it on (freehand also goes back along it). Where something is attached to its start or end, dragging that end takes it along: a mixer there moves with it. Double-click on the line adds a point; double-click a point removes it |
| Move something | ⌥/Alt + drag (any tool), **select** (**V**) + drag, or ⌥/Alt + arrow keys. Paths leading into and out of a template or pattern follow it, including one whose droplet got there early and waits (as at a merge), and what is linked after it moves in time. A move, turn or size change that would still leave a droplet behind (a mixer straight after a dispense, say) is refused. With Shift, everything that follows it moves too |
| Turn it | **R** (Shift+R turns back), or the Turn buttons in Properties |
| Move it in time | Drag its clip in the timeline, **[** / **]**, or the Starts field in Properties |
| Change it | The **Properties** tab: name, droplet, when it starts (a frame, or after other actions), time per step, letting others keep moving, a mixer's size and rounds, which way a circle mix goes round, a pattern's frames, a path's waits |
| Make a droplet wait on its way | Right-click the path's line on that electrode (on a Mac also Ctrl+click), type the seconds, Enter. **No wait** takes it off. Properties lists the path's waits; click one to see the droplet there |
| Delete it | Delete or Backspace, or **Delete** in Properties |
| Switch electrodes on or off | Choose **paint** (**P**) and click or drag, as in the original; the first electrode decides on or off. What you paint is kept as a pattern. With paint, Shift+click goes to the next frame and switches an electrode on |
| Undo / redo | ⌘Z / ⇧⌘Z (Ctrl+Z / Ctrl+Y on Windows and Linux), or **undo** / **redo** on the left |
| Change frame | ← / →, the mouse wheel (up = next), the arrows under the array, or click/drag the timeline's ruler |
| Play / stop | Space or the **play** button; loops up to the last frame with anything on |
| Change playback speed | Mouse wheel while playing (5–600 frames/min); this sets the default frame time |
| Set frame times | The bar above the timeline: a default frame time, and the frame on screen's own time (empty = the default) |
| See frame times | **Step time** instead of **Timeline** |
| Drop a template | Drag it from the Templates tab onto the electrode the droplet is on; **R** turns it, **Esc** cancels |
| Make a template | **+ New** in the Templates tab, or ✎ on a template to change it (or a copy of a built-in one) |
| Add an OpenDrop file to the project | **Add file…** above the timeline: it comes in as one block from the frame on screen |
| Make room for the board | **▾ Timeline** folds the timeline to one line; **›** shrinks the side panel to a tab; Ctrl/⌘ + wheel zooms the timeline (double-click empty space to fit it again) |
| Copy the previous frame, clear the frame, clear everything | Buttons on the right |
| Dispense a droplet from a reservoir | The four buttons beside the reservoirs (6 frames) |
| Save / open a project | **save** (⌘S / Ctrl+S) / **load**, top right. **load** also opens OpenDrop `.json` files |
| Export for the OpenDrop controller | **export**, top right |
| Show electrode numbers / paths' lines | `N` / `L`, or the checkboxes in the bottom bar |
| Use another cartridge layout | The Layout menu (all layouts from the original repository) |

## Actions and the timeline

Everything you draw becomes an action, a clip in the timeline from its first to its last frame:

- **Path**: drawn with freehand or straight, or corner by corner. It is kept as a line, its start,
  end and corners; the electrodes in between are worked out from the layout, so reshaping it
  changes them.
- **Template**: dropped from the Templates tab. The project keeps its own copy of the template. A
  built-in mixer keeps its size, rounds and (a circle mix) which way it goes round, which
  Properties can change.
- **Dispense**: a reservoir button. It stays at its reservoir.
- **Pattern**: electrodes switched on with paint, Shift+click or copy last frame, frame by frame.
  An OpenDrop file you open or add becomes one pattern.

Each action starts in a frame, or **after other actions**: once they have ended, plus a delay. That
link is made when you carry on from where a droplet is: the new action starts on the electrode
where an action left its droplet (in that frame or later, as long as nothing else took it since),
and takes its droplet name. A merge template dropped where two droplets arrive waits for both, and
its droplet is named after their short names, "D1 + D2". So when an action gets longer, everything
after it moves later.
A linked action can't be moved earlier than what it follows; Properties can set it to a fixed frame
instead.

The timeline has one track per droplet name, the actions of a droplet end to end on its track; an
action without a droplet name gets a track of its own. When an action carries on from a droplet on
another track, a dashed curve in that droplet's colour ends in a small arrow into its clip: where
droplets meet (a merge), an arrow comes in from each of them. The red line is the frame on screen. Clips with a
problem have a red outline; an action that can't run at all (it doesn't fit the layout, say) is
shown as a dashed clip where it would start. Hover a clip for its frames and problems.

Each action has a **name** and a **droplet** name (renaming a droplet renames it down the chain).
The droplet names colour the lines on the board and the tracks. Each droplet also has a short
name, shown before its name on its track and next to the Droplet field: Droplet 12 is D12, a
one-word name of up to six letters stays as it is, and a longer name gives its initials
("Sample buffer 2" is SB2). Merged droplets are named with them, so "D1 + D2" stays readable.

On the board, each path is a line with small arrows the way its droplet goes, and each template is
drawn as lines between the places its droplets go, with arrows: round a square for a circle mix,
both ways along a back-and-forth, out of a split and into a merge. A template being dragged over
the board shows them too. **Lines** (`L`) in the bottom bar hides all but the selected one.

## Droplets mustn't touch

Two droplets touch when they are on the same or neighbouring electrodes, diagonals included, in the
same frame, or when one moves next to where another one was the frame before. They would merge.
So anything that would make droplets of different actions touch is refused: a template being
dragged turns red and isn't dropped, a path being drawn turns red and isn't added, and moves,
reshaping, time moves, turns, Properties changes and paint are taken back, with the reason in the
status line. A droplet stays where its action left it until something carries on from there, and
it can be touched there too. Droplets that are meant to meet do so in a merge template, or by an
action carrying on from where a droplet is. Deleting is always allowed; a project opened with
touching droplets shows them as problems.

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
- Dragging an end takes along what is attached there. A template or pattern that carries on from
  the path's end (or that the path carries on from, at its start) moves with it, and the other
  paths attached to it follow; a path that carries on from the end stretches to meet it. If one of
  them can't come along (it would leave the array, or touch another droplet), the drag is refused.
  ⌥/Alt + arrow keys move only the path; Shift+drag moves it with everything that follows.
- The selected path can be reshaped with any tool. To draw a new path over it, press **Esc** first.
- Paths stop at frame 200.

## Frame times and the chart

- Each frame lasts the **default frame time** (0.5 s, the original's 120 frames/min) unless an
  action in it says otherwise: its **time per step**, a wait on a path, or the time set for that
  frame in the bar above the timeline. That time goes on the selected action if it runs in the
  frame, otherwise on the actions in the frame. Times are undoable like drawing; the default is a
  setting.
- A **wait** on a path comes on top of its step: the droplet arrives, then stays that much longer
  (a 3 s wait with 0.5 s steps holds it there 3.5 s), so a wait always shows, however slow the steps
  are. Right-click the line to set one; the board shows it as an orange diamond with "+3 s" beside
  it, and it stays on its electrode when the path is reshaped. A frame time set in the bar on a
  path becomes the wait that makes the frame that long.
- A frame lasts as long as the longest step in it. When that makes other actions wait, the bar
  says so and offers **Let the others keep moving**: the long step then stretches over as
  many frames as the others take (it may end up to one frame later than asked). **Make them wait**
  turns that off.
- Playback holds every frame for its time.
- **Step time** (instead of the timeline) shows each step's time against the step number (gray =
  default, blue = its own). Hover for the numbers and the total so far; click or drag to go to a
  step. The bar above shows the total time.

## Templates

- Built in, in two groups: **Merge and split** (merge two droplets, split in two) and **Mixers**
  (circle mixing on 2 × 2 and 3 × 3 squares, back-and-forth mixing, split & merge). Each shows its
  number of steps. Once placed, a mixer's size (2 × 2 or 3 × 3), how many electrodes a
  back-and-forth runs over, and the number of rounds can be changed in Properties.
- The merge is drawn side by side on its card but dropped standing up: the droplets come from
  above and below. **R** turns it while you drag it.
- A circle mix goes round clockwise (right first) or counter-clockwise (down first): **Goes round**
  in Properties. Either way it starts and ends on the electrode it was dropped on, so the paths
  attached to it stay as they are.
- A template is dropped by its first frame's leftmost electrode (the top one if there are several),
  starting in the frame on screen. Like a path, it is added on top of what those frames hold, then
  the view moves to its last frame. Where it doesn't fit (off the array, or past frame 200) it
  shows red and nothing is added.
- **+ New** sets the project aside and gives you a blank board: draw the operation from frame 1
  with any tool (own frame times are kept), name it and save it. The project comes back as it was.
  Changing a template opens it as a pattern that paint edits.
- Your templates are kept in the browser. **Export…** writes them to a file and **Import…** reads
  one back, to move them to another browser or computer or to share them.

## Kept between visits

Your work is kept in the browser half a second after each change and whenever you leave or reload
the page, and comes back when you open it again: the project with its undo history, the frame on
screen, the selection and the file name it was saved under. A template you were making comes back
in the maker, with the project behind it. If the project is too big to keep with all 100 undo
steps, fewer are kept; if it can't be kept at all, the status line says so. To start afresh, use
**clear all** (it can be undone). This is per browser: in two tabs, the one changed last wins.
It is no replacement for **save**: clearing the browser's data removes it.

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
  first frame, 1–200) **or** `after` (the id of the action it follows, or a list of ids: it starts in
  the last frame of the one that ends last) with an optional `delay` in frames.
- Optional on every action: `stepTime` (ms per step; default `frameTime`), `times` (own ms per step,
  0 = default; templates, dispenses and patterns), and `split: true` (long steps stretch over frames
  instead of making the others wait).
- `path`: `points` are electrodes (`e` = column × 8 + row), joined by straight pieces; `wait` is how
  much longer the droplet stays on that point than a step, in ms.
- `template`: dropped with its anchor on electrode `at`, turned `turns` quarter turns clockwise;
  `template` is a key into `templates`, whose frames list `[column, row]` offsets from the anchor.
  A built-in mixer also has `params`, e.g. `{"kind":"circle","size":3,"rounds":5}`; a circle mix
  that goes round counter-clockwise adds `"dir":"ccw"` (left out for clockwise).
- `dispense`: `reservoir` is one of `reservoirLeftTop`, `reservoirLeftBottom`, `reservoirRightTop`,
  `reservoirRightBottom`.
- `pattern`: `frames` lists the electrodes on in each of its frames, control lines (128–143)
  included; they don't move when the pattern does.
- Room for later: action types and fields this version doesn't know are kept when a file is opened
  and written back when it is saved (the list shows them as not supported). Reserved for logic and
  conditions: `measure` (a value from an external instrument), `prompt` (ask the operator), `loop`
  (`children`, `until`, `max`), `branch` (`if`/`then`/`else`), `when` on links, and a top-level
  `inputs`.

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

- What you draw is kept as actions in a project file, shown in a timeline, and can be moved,
  reshaped or retimed; droplets can't be made to touch by accident; the frames are exported
  separately.
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
  `js/paths.js` the droplet routes and the path being drawn, `js/templates.js` the templates and
  how their droplets move,
  `js/model.js` the frames and their times, `js/jsonio.js` the OpenDrop file format, `js/view.js`
  the board, `js/chart.js` the timing chart, `js/timeline.js` the timeline and `js/app.js` the page
  wiring. All but the last four run without a browser.

## License

GPL-3.0, see `LICENSE`. Based on [OpenDrop](https://github.com/GaudiLabs/OpenDrop) by GaudiLabs:
the frame image, the electrode layouts and the editor behaviour come from OpenDropController4_25.
