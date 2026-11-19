# OpenDrop Generator

nanoSYD software · source code: https://github.com/ostryJR/NanoSyd_OpenDrop_software

A browser app for drawing electrode sequences for the OpenDrop V4 digital-microfluidics platform
and exporting them as the `.json` frame files used by GaudiLabs' **OpenDropController4_25**. It
started as a port of that controller's editor and adds drag-to-draw droplet paths, templates for
operations such as mixing or splitting, waits, and undo. What you draw is kept as
**actions** (a path, a template, a dispense, a painted pattern) in a project file, shown in a
**timeline** under the board, one track per droplet, like a video editor. Actions can be moved and
reshaped later, and nothing is allowed to make two droplets touch by accident. The frames are
worked out from the actions and written out on export. In Chrome or Edge it can also drive the
OpenDrop itself over USB: live, the device shows the frame on screen.

## Run

Open `index.html` in Chrome or Edge. Double-clicking the file works: there is no server, nothing
to install, and it runs offline. Safari and Firefox work too, but there save and export ask for a
file name and download the file instead of showing a save dialog.

**Manual:** `manual.html` (the **Manual** link at the top of the app) explains how to use it in
plain words, with worked process examples. It is kept up to date with every change to the app.

**Help from an AI:** attach `ai-help.md` with a photo of the screen (or a description) to a chat
with an AI assistant: it describes the screen, every message and the usual fixes, so the AI can
explain what is going wrong. It is kept up to date with the app, like the manual.

## Controls

| To | Do |
|---|---|
| Draw a droplet path | Drag from the droplet's electrode. Every electrode you pass is the next frame. The path shows in blue with its step count until you let go, and is added then. **Esc** cancels; going back along the path takes steps back |
| Draw a path corner by corner | Shift+click where it starts, then Shift+click each corner (two pieces at a right angle when a click isn't in line). With a path selected, Shift+clicks carry on from its end. **Esc** stops |
| Select something drawn | Click its clip in the timeline, or click it on the board (any tool but paint): the action on that electrode in the frame on screen, or a path's line. Clicking again picks the next one below. **Esc** lets go |
| Reshape the selected path | With freehand or select: drag a straight piece sideways, or drag a corner or its start. Dragging its free end draws it on, or back along it. Where something is attached to its start or end, dragging that end takes it along: a mixer there moves with it. Double-click on the line adds a point; double-click a point removes it |
| Move something | ⌥/Alt + drag (any tool), **select** (**V**) + drag, or ⌥/Alt + arrow keys. Paths leading into and out of a template or pattern follow it, including one whose droplet got there early and waits (as at a merge), and what is linked after it moves in time. A move, turn or size change that would still leave a droplet behind (a mixer straight after a dispense, say) is refused. With Shift, everything that follows it moves too |
| Turn it | **R** (Shift+R turns back), or the Turn buttons in Properties |
| Move it in time | Drag its clip in the timeline, **[** / **]**, or the Starts field in Properties |
| Change it | The **Properties** tab: name, droplet, when it starts (a frame, or after other actions), a mixer's size and rounds, which way a circle mix goes round, a pattern's frames |
| Make a droplet wait | A **Wait** tile in the process, placed on the board: it lasts its time while the others keep moving |
| Delete it | Delete or Backspace, or **Delete** in Properties |
| Switch electrodes on or off | Choose **paint** (**P**) and click or drag, as in the original; the first electrode decides on or off. What you paint is kept as a pattern. With paint, Shift+click goes to the next frame and switches an electrode on |
| Undo / redo | ⌘Z / ⇧⌘Z (Ctrl+Z / Ctrl+Y on Windows and Linux), or **undo** / **redo** on the left |
| Change frame | ← / →, the mouse wheel (up = next), the arrows under the array, or click/drag the timeline's ruler |
| Play / stop | Space or the **simulate** button; loops up to the last frame with anything on |
| Change playback speed | Mouse wheel while playing (5–600 frames/min); this sets the frame time |
| Set the frame time | **Properties** with nothing selected: **Frame time** (how long every step lasts) |
| Set the project's high voltage | **Properties** with nothing selected, under the frame time: **Voltage** (50–240 V), **Frequency** (100–1000 Hz, AC only), **Mode** (AC/DC). Empty = the device's own setting. Saved in the project and sent to a connected device (custom firmware) when it connects or the setting changes |
| See how long frames last | **Step time** instead of **Timeline** |
| Drop a template | Drag it from the Templates tab onto the electrode the droplet is on; **R** turns it, **Esc** cancels |
| Make a template | **+ New** in the Templates tab, or ✎ on a template to change it (or a copy of a built-in one) |
| Add an OpenDrop file to the project | **Add file…** above the timeline: it comes in as one block from the frame on screen |
| Make room for the board | Drag the timeline panel's top edge to make it taller or shorter (double-click the edge for the usual height; it is kept between visits); **▾ Timeline** folds it to one line; **›** shrinks the side panel to a tab; Ctrl/⌘ + wheel zooms the timeline (double-click empty space to fit it again) |
| Copy the previous frame, clear the frame, clear everything | Buttons on the right |
| Dispense a droplet from a reservoir | The four buttons beside the reservoirs (6 frames) |
| Save / open a project | **save** (⌘S / Ctrl+S) / **load**, top right. **load** also opens OpenDrop `.json` files |
| Export for the OpenDrop controller | **export**, top right |
| Design the process: steps, decisions, loops, lanes | **Process** at the top (see "The process"); **Board** goes back. **▶ Run** runs it |
| Connect the OpenDrop (Chrome, Edge) | **Connect…** in the Device tab, then pick its port. The dot by the title is green while it answers |
| Send what is on screen to the device | **live** under simulate (white when on; only on the board). Stepping, playing and editing then go straight to the device; live off switches everything on it off |
| See where the device senses droplets | **feedback** under live (OpenDrop V4.2): dark dots on the board |
| Show electrode numbers / paths' lines | `N` / `L`, or the checkboxes in the bottom bar |
| Use another cartridge layout | The Layout menu (all layouts from the original repository) |

## Actions and the timeline

Everything you draw becomes an action, a clip in the timeline from its first to its last frame:

- **Path**: drawn with freehand, or corner by corner. It is kept as a line, its start,
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

## The process

**Process** (the switch at the top) shows the process as a top-down tree of tiles, in the board's
place; **Board** goes back. The first time, the project gets Start → "Step 1" → End, Step 1 holding
everything drawn so far.

| Tile | What it is | In a run |
|---|---|---|
| Start, End | Where it begins and ends | |
| Step, Dispense, Move, Mix, Split, Wait | A step with work on the board: anything (Step), a dispense from its reservoir, a path, a mixer that keeps one droplet (kind, size, rounds, direction), a split, a hold (seconds) | Plays on the board |
| Merge | Two droplets become one, on the board. It takes an arrow from each droplet's lane and waits for them, so it ends those lanes | Plays on the board |
| Measure | A named number with a unit, e.g. `conc` in mM, and the text to ask with | Asks you to type it in (a connected instrument comes later) |
| Ask | A yes-or-no question | Asks you |
| Decision | `value` compared with a number (or `value is yes`), with a yes and a no arrow | Takes the arrow that holds |
| Repeat | Its "again" arrow goes to what is repeated, which leads back to it; "done" goes on | Goes round that many times |
| Parallel, Wait for all | Lanes that run at the same time, on one board. Wait for all waits until every lane has finished, its droplets staying apart (lanes whose droplets go together end in a Merge instead) | |

- **Building it:**
  - The palette on the left groups the tiles: on the board, measure and decide, lanes, start and
    end. Hover one for what it does.
  - Drag a tile onto the canvas. Clicking one instead puts it under the selected tile, in between it
    and what came after.
  - Drag a tile onto an arrow to put it there: the arrow lights up with "Drop to put it here". The
    tile goes in between, under the tile the arrow came from, and the tiles below move down to make
    room. A tile with no arrows yet can be moved onto an arrow the same way.
  - Drag from a tile's dot at the bottom (its output) onto another tile to connect them. Near a tile
    the arrow snaps to the input point it will use: the point grows, the tile gets an outline, and
    the arrow shows as it will be drawn. A Merge or Wait for all has an input point for each arrow
    coming in (at least two); with all of them taken it shows one more. Dragging into empty space
    offers a tile to add there.
  - Drag tiles to move them. There is no grid: they go where you drop them. Click to select,
    **Delete** to remove (a tile's work on the board goes with it; undo brings it back), arrow keys
    to nudge (with Shift, further).
  - **Several tiles:** drag a box round them on empty space (with Shift it adds to the selection),
    or Shift+click to add or remove one. Dragging one of them moves them all; arrow keys and
    **Delete** work on all of them.
  - **Tidy** lays it out top-down and compact: each row and column as big as its tiles, short arrows
    between them, room round loops, loose tiles to the right. **Fit** shows all of it.
  - Ctrl/⌘ + wheel zooms. The wheel, Space + drag, a middle-button drag or ⌥/Alt + drag pans.
- **Arrows** are curves from an output to an input point. **Loops** are arrows going back up, in
  purple, round the side of the loop. On a decision or a repeat, the output that goes back up leaves
  on its right side and the way on goes straight down. A loop's tiles get a dashed outline with the
  condition on top: "repeat until conc < 5 mM" from the decision that leads out, or "repeat 3×".
- **Properties** (with a tile selected) show its settings, where its work is on the board, and its
  problems: an arrow going nowhere, a value used before it is measured, a decision inside parallel
  lanes, lanes that don't join, a step not placed yet, steps out of order on the board, droplets
  arriving at different places by two ways in, two Dispense tiles of one part making a droplet of
  the same name.
- **Names:**
  - One name per step. What a Dispense, Move, Mix, Merge, Split or Wait tile puts on the board is
    called by the tile's name, in Properties and in the timeline. Renaming it there renames the tile,
    and the other way round. When a tile has two things on the board, the second is "Name · 2".
  - A Step tile can hold any number of things, so they keep names of their own. The timeline shows
    them after the step's name: "Step 1 · Sample to mixer".
  - Droplets are named on the Dispense tile that makes them (its **Droplet** field). Left empty, the
    droplet gets the next free "Droplet N" when it is placed.
  - Renaming a droplet renames it from there on: on the board and in the later parts of the process
    that take it in. Merged droplets named after it follow too ("D1 + D2" becomes "Sample + D2").
    Renamed on the board, the Dispense tile follows.
  - Each tile shows the droplets it works on after its name, by their short names: "Dilute · Sample".
- **On the board:**
  - Double-click a step, or **Open on the board**, to draw its work.
  - The board shows that step with the steps that run with it up to the next stop (a decision,
    Measure, Ask, Repeat or End). Its own clips are bright in the timeline and the others dim.
  - The droplets coming in from the step before wait where it left them, shown as dashed rings. You
    draw from them as from any droplet.
  - What you draw goes into the open step, after the steps before it.
  - **Place on the board** does a typed tile's job: it adds a dispense or a hold, starts placing
    the mixer, merge or split (click where the droplet is, R turns it), or picks freehand for a
    move.
- **The timeline shows the whole process**, the stretches one after another, with the frame
  numbers counting on from Start:
  - It follows one way through: at every decision it goes on rather than back round the loop (a
    loop that waits for an answer is shown once; where both ways go on, "yes"), and a Repeat runs
    all its rounds. Each stretch starts with the droplets, heaters and magnets the one before left.
  - The board edits the stretch the frame on screen is in; the other stretches' clips are dimmed.
    Clicking or scrubbing into another stretch, or clicking one of its clips or bands, opens it.
    Playing runs on from one stretch into the next.
  - A band above the tracks shows each step every time the way goes through it. A purple ◆ between
    two frames marks a stop (Measure, Ask, decision, Repeat round; hover for which), and ■ marks End.
  - The total under the board is the whole way's frames and time, and says where it stops short
    (an arrow going nowhere). The Step time chart shows the whole way too.
  - A step the way doesn't go through (the other side of a decision) opens on its own, as the bar
    at the top says.
- **Run** (at the top) goes through the process from Start:
  - Each stretch plays on the board with its frame times, and the running tile glows. With
    **live** on (the board's switch under simulate) and the device connected, the
    device follows the run and is switched all off at the end.
  - **simulate** on the board is only a preview: it goes through the timeline without asking anything
    (the top bar says "Previewing"). **▶ Run** is the real run.
  - Measure and Ask tiles ask you; a yes/no question also takes the keys 1 or , (yes) and 2 or .
    (no). Decisions and Repeat choose the way.
  - The log at the bottom right lists the values, decisions and times; **Pause** and **Stop** are
    at the top.
  - Nothing in the project can be changed while it runs (board, tiles, Properties, frame time,
    layout, opening a file, undo, new templates), in a second tab either; those fields are greyed
    out, and so are the Device tab's Send to device and Run on the device, and the board's red frame is greyed a bit.
    Frames can't be stepped or scrolled through (wheel, arrow keys, ◀ ▶, timeline, charts): the board
    follows the run. Keep the page in front: a hidden tab runs slowly.
- **Two tabs:**
  - **Board in a new tab** (or **Process in a new tab**) opens the other view in a second browser
    tab, e.g. the process on one screen and the board on the other.
  - A change in one shows in the other within a moment, as an undo step there too.
  - A run happens in one tab; the other follows it.
- **Export** with a process writes the open step's board only. A process with decisions can't be one
  OpenDrop file; run it from here instead.

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
- There is no 200-frame limit: sequences can run as long as you need when played live (a guard
  stops them at frame 100,000). Exported files and *upload for later* still matter to the original
  200: see [Exported files](#exported-files-opendrop-json).

## Frame times and the chart

- Every step lasts the **frame time** (0.5 s, the original's 120 frames/min; **Properties** with
  nothing selected). There are no times per step or per frame: to make something wait, add a
  **Wait** tile to the process and place it. It switches nothing on and doesn't hold up the others, which keep moving at the
  frame time; when nothing else runs, its frame lasts the rest of the wait. Waiting for the heaters
  works the same way.
- Older project files with times of their own (time per step, a frame's own time, waits on a
  path's points, "let the others keep moving") open with those left out, and say so.
- Playback holds every frame for its time.
- **Step time** (instead of the timeline) shows each frame's time against its number (gray = a
  step, blue = a wait). Hover for the numbers and the total so far; click or drag to go to a frame.
  The bar above shows the total time.

## Heaters and magnets

The temperature adapter has three heaters (T1–T3); the board has two magnets. Both are set from a
frame on and stay that way until set again, so they can change during a process.

- **Temperature** shows them against time, under the board (the third view next to Timeline and
  Step time): each heater's target (solid), how warm it is estimated to be (dashed), what a live
  device measured (dots), frames that wait for the heaters (hatched), and the magnets as two lanes
  underneath. Pick T1, T2 or T3 above it, then **click** in the plot to set that heater from that
  frame on (a click in a frame that already has a setting adds the heater to it). **Drag** a point
  up or down to change its temperature, sideways to move it to another frame. **Click a magnet
  lane** to switch that magnet from that frame on; clicking a switch's frame again takes it away.
- A setting is an action on the timeline (tracks *Heaters*, *Magnet 1*, *Magnet 2*, *Screen*); Properties
  shows its heaters (empty = stays as it was), and **Wait until the heaters get there** with how
  close is close enough. Settings take no time and hold nothing up, except one that waits: it lasts
  as long as the heaters are estimated to take (the warming and cooling rates, °C/min, above the
  chart, kept with the project), while the other actions keep moving.
- Played **live** (or in a run on the OpenDrop), a frame that waits lasts until the device reads
  every set heater within the tolerance, however long that takes; without a device it lasts the
  estimate. The device gets each frame's targets; heaters the sequence doesn't set keep the targets
  in the Device tab, which shows which ones the sequence sets.
- In the **process**: the *Temperature*, *Magnet* and *Message* tiles (group *Heat, magnets,
  screen*) are placed as such settings. What they set carries on into the following steps, past Measure and Ask stops,
  the way droplets do.
- At the top of the board, in the dip of the red frame, a strip shows each heater's target and reading (green ring: there) and each
  magnet, for the frame on screen, once the project sets any or a device with the adapter is
  connected. On the standard and magnet layouts, the electrodes over each heater get a halo in the
  colour of its target: T1 under electrodes 25 and 26, T2 under 57 and 58, T3 under 97 and 98.
  That is where GaudiLabs' heater cartridge (`OpenDropV4/Electronics/DIMMCartridge_heaters` in
  their repository) has each heater's two resistors and its thermistor, under pads FLUXL_4_2/4_3,
  FLUXL_8_2/8_3 and FLUXL_13_2/13_3; the universal adapter wires them as T1–T3
  (`HEATER_ZONES` in `js/heat.js`).
- Magnets are the control lines 129 (magnet 1) and 128 (magnet 2); the magnet layout labels them
  M1 and M2 on the board.
- **Messages on the device's screen** (custom firmware OpenDropVCustom): a *Message* tile (or action)
  puts up to 20 characters of plain text on the OpenDrop's screen from its frame on, until the next
  one; empty text clears it. It goes to the device while live and in a run, and shows as a pill on
  the board. **Ask** and **Measure** tiles have **Show it on the device's screen** (on for new
  tiles): while a run waits there, the screen shows their **Screen text** (up to 20 characters,
  starting as the question or prompt cut to fit; a counter shows how many are used), then goes
  back to the Message. Every text for the screen is limited to 20 characters as you type. Live off, Switch all off and disconnecting clear it.

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
  the view moves to its last frame. Where it doesn't fit (off the array) it
  shows red and nothing is added.
- **+ New** sets the project aside and gives you a blank board: draw the operation from frame 1
  with any tool, name it and save it. The project comes back as it was.
  Changing a template opens it as a pattern that paint edits.
- Your templates are kept in the browser. **Export…** writes them to a file and **Import…** reads
  one back, to move them to another browser or computer or to share them.

## Connecting the OpenDrop

The app talks to the OpenDrop over USB the way OpenDropController does, with the same buttons where
it had them, and a **Device** tab for the rest. It needs Chrome or Edge on a computer (Web Serial);
opening `index.html` from disk is fine. Close OpenDropController first: only one program can use
the port.

- **Connect…** in the Device tab opens the browser's port picker (the OpenDrop shows up as a Feather M0). The
  board's type is read from the device and shown: V4.1 or V4.2, with magnets or the temperature
  adapter. For a magnet board the layout switches to the magnet one, and back for a board without,
  as the original did. **Reconnect automatically** finds the same device again when the page opens
  or it is plugged back in.
- **live** (under simulate): the device shows the frame on screen. Stepping, playing (with each frame's
  own time: the computer keeps the time), painting, drawing, undo, loading: all go straight to the
  device. After connecting or reconnecting, live is off and everything on the device is off.
  Switching live off, **Switch all off**, disconnecting and closing the page switch everything off
  first. Keep the page in front while playing live: a hidden tab stops playback.
- **feedback** (V4.2 boards): the device senses where droplets are; dark dots show them on the
  board and the Device tab counts them.
- **High voltage** (custom firmware, OpenDropVCustom): shows the project's settings (set in
  Properties). They are sent when the device connects and when they change, and last until it is
  switched off; **Save to device** writes them to its memory, so it starts with them (its sound
  and the feedback switch are saved too). Ordinary frames leave them alone.
- **Temperatures** (temperature adapter): the three readings, and targets (20–120 °C) for heaters
  the sequence doesn't set. Empty or 0 = **off**, which is how they start on every visit: an unset
  heater is sent as 0. (The original controller sends 25 °C, but the adapter's PID controller then
  keeps heating a cooler cartridge to 25; with 0 its output stays at 0.) **Switch all off**,
  disconnecting and closing the page switch the heaters off too.
- **Sequence on the device:** **Send to device**, **Run on the device** and **Stop** load the whole sequence,
  with each frame's time, into the device and run it on its own clock, with progress. Today's
  firmware can't do that: it only follows live frames, so these stay off and say so. The protocol a
  new firmware would need is written up in `docs/device-protocol.md`, which also describes the
  live protocol.
- Without a device: open `index.html#sim` (or `#sim1`, which can also take a whole sequence) and
  use **Simulated OpenDrop** in the Device tab.
- **Traffic log** (Device tab, for debugging): with **Log what is sent and what comes back** on,
  every packet written to the port and every answer is listed with the time, what it says
  (`describeOut` / `describeIn` in `js/device.js`) and its bytes in hex; also answers that never
  came, the device's start-up text and stray bytes. Repeats (the same packet and answer, like the
  status check every second) fold into "×N"; temperature readings, which change a little every
  time, don't count as a difference, and the entry shows the latest. **Copy** and **Save…** give it as text; it keeps the
  last 3000 entries and costs nothing while off. The port can only be open in one program at a
  time, so this is the way to see the traffic while the page is connected (`js/seriallog.js`).

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
      "points": [{"e":9},{"e":41},{"e":44}]
    },
    {
      "id": "a3",
      "type": "template",
      "name": "Circle mix 2×2, 3 rounds",
      "droplet": "Sample",
      "after": "a2",
      "template": "circle-2x2",
      "at": 44,
      "turns": 0
    },
    {
      "id": "a4",
      "type": "pattern",
      "name": "old.json",
      "droplet": "",
      "start": 1,
      "frames": [[8,9],[16,128],[]]
    }
  ]
}
```

- `openDropGeneratorProject` is the format version; `layout` the cartridge layout; `frameTime`
  the frame time in ms; `templates` copies of the templates the actions use; `hv` (optional) the
  high voltage, `{ volts, hz, mode }` (`mode` `ac` or `dc`; `null` = the device's own).
- Every action has an `id`, a `type`, a `name` and a `droplet` name, and **either** `start` (its
  first frame, from 1) **or** `after` (the id of the action it follows, or a list of ids: it starts in
  the last frame of the one that ends last) with an optional `delay` in frames.
- `path`: `points` are electrodes (`e` = column × 8 + row), joined by straight pieces.
- `template`: dropped with its anchor on electrode `at`, turned `turns` quarter turns clockwise;
  `template` is a key into `templates`, whose frames list `[column, row]` offsets from the anchor.
  A built-in mixer also has `params`, e.g. `{"kind":"circle","size":3,"rounds":5}`; a circle mix
  that goes round counter-clockwise adds `"dir":"ccw"` (left out for clockwise).
- `dispense`: `reservoir` is one of `reservoirLeftTop`, `reservoirLeftBottom`, `reservoirRightTop`,
  `reservoirRightBottom`.
- `pattern`: `frames` lists the electrodes on in each of its frames, control lines (128–143)
  included; they don't move when the pattern does.
- `wait`: a hold of `duration` ms where nothing is switched on; the other actions keep moving.
- `tile` (on any action): the process tile it belongs to.
- `process` (top level, optional):
  - `tiles`: `{ id, kind, name, x, y, … }` with the kind's settings: `reservoir` and `droplet` (the
    name of the droplet it makes) for a dispense,
    `params` (mix), `seconds` (wait), `value`, `unit`, `source` (`typed`) and `prompt` (measure), `question` and
    `value` (ask), `value`, `op` (`<`, `<=`, `>`, `>=`, `=`, `!=`, `is`) and `than` (decision),
    `times` (repeat), `lanes` (parallel). The kinds are `start`, `end`, `step`, `dispense`,
    `move`, `mix`, `merge`, `split`, `wait`, `measure`, `ask`, `decision`, `repeat`, `parallel`
    and `join` (shown as Wait for all).
  - `links`: `{ from, port, to }`. The ports are `next`; `yes`/`no` for a decision; `again`/`done`
    for a repeat; `lane1`… for a parallel tile.
- Room for later: action types and fields this version doesn't know are kept when a file is opened
  and written back when it is saved. Not built yet: functions (a sub-process used in several
  places), reading a measuring instrument directly (Measure asks you for now). An Ask from older files
  that took a number opens as a Measure, its question as the prompt.

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

- One object per frame, from frame 1 to the last frame with any electrode on (any number of them).
  The original controller reads only the first 200, so exporting a longer sequence warns about
  that; *upload for later* (protocol 1) refuses one: play it live instead.
- `"yR"` is row R (0 = top). Character k of it is column k, `1` = on. Electrode ID = column × 8 + row.
- Columns 0 and 15 are the left and right reservoirs, 1–14 the 14 × 8 grid, and 16–17 control
  lines (16 drives the magnets in the magnet layout).
- `"time"` is how long the frame lasts, in milliseconds (longer for a frame a Wait makes longer).
  The original controller and the device firmware don't read it yet: the original ignores it, so
  files still open there. When loading, the most common time becomes the frame time; frames with
  another time play at it too (with a warning: add a Wait where it should pause). Files without
  times keep the current frame time.
- `"temp"` (only when the project sets a heater) is the heater targets in °C, `null` for one it
  doesn't set; `"waitTemp"` marks a frame that waits for them, with the tolerance in °C. The
  original ignores both. Loading turns them back into temperature settings.
- If some actions won't come out as drawn, the first press of **export** says so; press it again
  within 10 s to export anyway.

## Differences from the original

- What you draw is kept as actions in a project file, shown in a timeline, and can be moved,
  reshaped or moved in time; droplets can't be made to touch by accident; the frames are exported
  separately.
- Dragging draws droplet paths (freehand) that are added when you let go; the original
  drag is the **paint** tool. A click selects; paint switches single electrodes.
- Undo and redo, templates, Wait blocks, and a chart of how long frames last.
- Works without a device too. Its "life" button is **live** here; connecting, feedback and
  temperatures work as in the original, the temperatures in the Device tab. Connecting lines the
  byte stream up first, and live, disconnecting and closing switch everything off.
- Loading replaces the current project; the original merged the file into whatever was on screen.
- Export doesn't add a second `.json` to the name.
- Loading keeps frames after 200 (the original skipped or crashed on them), and also reads files from controller 3.2.
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
  wiring. `js/device.js` talks to the OpenDrop (bytes, lining up, the session), `js/device-sim.js`
  is a simulated OpenDrop, `js/serial.js` the Web Serial port and `js/devicepanel.js` the Device
  tab (`js/seriallog.js` its traffic log); see `docs/device-protocol.md`. `js/process.js` is the process (tiles, arrows, stretches,
  loops, checks, layout, a run's way through it), `js/stretch.js` puts it on the board (droplets
  coming in, each tile's frames, the whole process laid out along one way), `js/runner.js` runs it, `js/processview.js` and
  `js/processpanel.js` are the process view and its Properties, and `js/sync.js` keeps two tabs in
  step. The view, chart, timeline, serial, device panel, process view and panel, sync and app run
  in the browser; the rest runs in node too.

## License

GPL-3.0, see `LICENSE`. Based on [OpenDrop](https://github.com/GaudiLabs/OpenDrop) by GaudiLabs:
the frame image, the electrode layouts and the editor behaviour come from OpenDropController4_25.
