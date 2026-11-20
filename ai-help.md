# OpenDrop Generator: guide for an AI assistant

You are helping someone use **OpenDrop Generator**, a browser app (one HTML page, `index.html`) for
drawing electrode sequences and processes for the **OpenDrop V4** digital-microfluidics board. The
person attached this file together with a **photo or screenshot** of the app, or a description of
what happens. Your job: work out what they are looking at, explain in plain words what is going on
or going wrong, and say exactly what to click or change to fix it.

How to answer:

- Name things as the app does (the words in **bold** below), and say where they are on screen.
- Start with the cause in one or two sentences, then numbered steps to fix it.
- Read every message visible in the photo first: the **bottom bar** message, a red badge on the
  board, a tile's **!**, the text in the top bar. Most problems are explained by one of them; this
  guide lists them all with their causes (section 6).
- Photos of a laptop screen are often blurry. If a number or message you need can't be read, say
  what you can see and ask for that one thing (or for a screenshot).
- If you can't tell from the photo, ask for the **project file**: **save** (top right of the board)
  downloads a `*.odproj` file; its text describes everything (section 7).
- The app refuses anything that would make droplets touch, and shows why. It is almost always right
  about that; look for the reason before suspecting a bug. If it does look like a bug, say so and
  suggest saving the project file and reporting it.
- Don't invent buttons or settings that aren't in this guide.

The person's own manual is `manual.html` (the **Manual** link, top right). You can point to its
sections: Getting started, Drawing on the board, Droplets mustn't touch, Timeline and time,
Heaters and magnets, Processes, Process examples, Connecting the OpenDrop, Questions and problems.

---

## 1. The screen, part by part

The page has two views, switched at the top left: **Process** and **Board**.

### Top bar (across the top)

- **Process | Board**: the two views.
- Text beside them (board view, with a process): "On the board: *Step name* · with N more steps of
  the process · frames a–b": which step is open on the board and where it sits on the whole
  timeline. "not on the way the timeline follows" means that step is on the other side of a
  decision from the way the timeline is laid out (section 3.4).
- **▶ Run** (green, only with a process), then **⏸ Pause** and **■ Stop** while running, and a
  state text: "Running: *step* · frame f of n · m:ss".
- **Process in a new tab ↗** / **Board in a new tab ↗**: the other view in a second tab.
- **Manual**: opens the manual.

### The board (the large red panel in board view)

It imitates GaudiLabs' original OpenDropController window.

- **The array** in the middle, inside a grey rounded frame: the electrodes.
  - **Yellow** = off. **Green** = on in the frame on screen. **Olive / darker yellow** = was on in
    the frame before (it just switched off).
  - Larger electrodes at the far left and right are the **reservoirs** (where droplets are
    dispensed from).
  - Small labels **M1** / **M2** under the array (magnet layout only): the two magnets.
  - **Dashed circles** on an electrode: a droplet sitting there while its electrode is off
    (left there by an action, or coming in from the step before).
  - **Coloured lines with arrows**: the paths droplets take (one colour per droplet). With the
    **Lines** box (bottom bar) unticked, only the selected one is drawn.
  - The **selected** path is thicker, with a ring at its start, a dot at its end, squares at corners.
  - **Outlines in amber / orange / red around two electrodes**: a heater zone that has a target
    (only on the standard and magnet layouts); warmer colour = hotter target.
  - **Dark dots**: where the device senses droplets (with **feedback** on).
- While drawing or moving something:
  - **Light blue** electrodes = where the new path or template goes, **dark blue** = its end.
  - **Light red / red** = it can't go there; a **red badge** beside it says why.
  - **Dark red** = the *other* droplet it would touch, where that droplet is in the frame named in
    the message (which may be later than the frame on screen).
  - A white badge "N steps" = fine; let go to add it.
- **Left side** (labels with square boxes; the chosen one is white): **drag:** **freehand**,
  **paint**, **select** (what dragging on the array does), then **undo**, **redo**.
  The two boxes nearer the array on each side are the **reservoir buttons** (dispense a droplet
  from that reservoir).
- **Right side**: **simulate** (plays the frames on screen), **live** (the only live switch; the Device tab has none), **feedback** (only shown with a V4.2 board connected), then
  **copy last frame**, **clear frame**, **clear all**.
- **Top of the board**: "OpenDrop Generator" with a small **dot** before it = the device:
  grey = not connected, amber = connecting, green = connected and answering, red = not answering.
  **export**, **save**, **load** at the top right.
- **Bottom of the board**: **frame_no:** the frame on screen (with a process, counted over the
  whole process), **frames/min:** playback speed, and a row of dots with ◀ ▶ arrows to step frames.
- **Pills at the top of the board** (in the white dip of the red frame): **T1 T2 T3** (heater targets, "–" = not set by the sequence) and
  **M1 / M2 on/off**. A green ring on a heater pill = the live reading has reached the target.
  "Waiting for the heaters: …" appears in white under them while playback waits for them.

### Timeline panel (under the board)

- Bar: **▾ Timeline** (folds the panel), **Frame N**, **Total X s over N frames**, **Add file…**,
  and **Timeline | Step time | Temperature** (what the panel shows).
- **Timeline**: like a video editor.
  - Ruler with frame numbers on top; the **red vertical line** is the frame on screen.
  - With a process, a **Steps** row: a grey band per step over its frames, the **open step in
    blue**. A purple **◆** between two frames = a stop (Measure, Ask, decision, Repeat round; hover
    shows which). **■** with a dark line = End.
  - One row per droplet (**D1 Droplet 1**, …), plus rows for **Heaters** and **Magnet 1/2**.
    Rows go in order of their first clip unless reordered: dragging a row's name up or down moves
    it (a blue line shows where), and the project keeps that order. A dimmed row with a blue line
    across = a row being dragged.
  - While a clip is dragged in time: a dashed outline where it would go (red = it can't), and
    **dashed vertical lines** at its start and end over all rows; a line turns **solid** where
    another clip starts or ends there (so it starts right after that one, or ends as it starts).
  - Each action is a **clip** (bar) from its first to its last frame, with a mark: → path,
    ◎ template (mix/merge/split), ⬚ dispense, ▦ painted pattern, ⧗ wait, ° temperature, ⊓ magnet.
  - **Faded clips** belong to other steps (click one to open that step).
  - **Red outline** = the action has a problem (hover it to read it). **Dashed red** = it can't run
    at all; shown where it would start.
  - Curves with arrows between rows: where one droplet's action carries on from another's (merges).
- **Step time**: a bar per frame, its length = how long that frame lasts. Grey = a normal step,
  blue = a frame made longer by a **Wait** or by waiting for the heaters.
- **Temperature**: heater targets over time (solid), estimated temperature (dashed), live
  readings (dots), and the magnets' on/off lanes. Clicking adds a temperature setting.

### Side panel (right), tabs **Properties | Templates | Device**

- **Properties**: the selected action's settings (name, droplet, when it starts, mixer size and
  rounds, a pattern's frames, heater targets, magnet). With nothing selected: a summary
  ("N actions · N frames · X s") and **Project → Frame time** (how long every step lasts), then the project's **Voltage**,
  **Frequency** and **Mode** (high voltage; empty = the device's own; sent to a connected device
  with the custom firmware when it connects or they change).
  In the Process view it shows the selected tile's settings and its problems instead.
- **Templates**: built-in mixers, merge and split, plus your own; drag one onto the array.
- **Device**: **Connect…**, board type, live/feedback, **High voltage** (shows the project's
  settings from Properties; **Save to device** keeps them on the device after it is switched off,
  with its sound and feedback; needs the custom firmware OpenDropVCustom), temperatures, **Send to device** and
  **Run on the device** (the device plays the sent sequence on its own, without the page; not the
  same as ▶ Run), **Switch all off**.

### Bottom bar

**Layout** (which cartridge: Standard, Magnet, …), **Electrode numbers**, **Lines**, then the
**message** (the most important text for troubleshooting: amber = warning, red = error), a
line of keyboard hints with "nanoSYD software · GitHub" at the right end of their last line (the source code:
https://github.com/ostryJR/NanoSyd_OpenDrop_software).

### Process view

A flowchart on a canvas (palette of tiles on the left, settings in Properties on the right).

- Tiles: rounded boxes (work), dark pills (**Start**, **End**), parallelogram (**Ask**, **Measure**,
  yellowish), diamond (**Decision**, purple), dark bar (**Parallel**, with lane ports),
  **Repeat**, **Wait for all**.
- Under a work tile's name: what it does and where it is on the board, e.g. "frames 6–13 · 4 s",
  or **"not placed yet"** (its work isn't on the board).
- After the name: the droplets it works on, by short name ("Mix · D2").
- Badges: **orange !** = warning, **red !** = error. Selecting the tile shows the text in
  Properties.
- A loop is drawn as a dashed box labelled "↻ repeat until *condition*" (or "repeat N×").
- The tile that is open on the board has a blue outline; a running tile glows green.
- A **run log** box (bottom right) lists what happened during a run; its heading folds it.

---

## 2. Core ideas

- **Frames**: a sequence is a list of frames; each frame says which electrodes are on. A droplet
  moves one electrode per frame. Every frame lasts the **frame time** (0.5 s by default, set in
  Properties with nothing selected). There are no separate times per step or per frame. To pause,
  use a **Wait** (a Wait tile). Older files with their own times open with those times dropped,
  with a message saying so.
- **Actions**: what you draw is kept as actions: **paths**, **templates** (mixers, merge, split),
  **dispenses**, **painted patterns**, **waits**, **temperature** and **magnet** settings. Each
  starts at a frame, or **after** another action (in the frame that one ends: the droplet is
  handed over), optionally "then wait *N* frames (*time*)": the time those frames take.
- **Droplets** have names (Droplet 1 … or your own) and short names (D1, D2, …; merged ones
  "D1 + D2"). Each droplet gets a timeline row and a colour.
- **A droplet stays where its action ends** until something carries on from there (shown as a
  dashed circle when its electrode is off). It still counts for touching while it waits.
- **Droplets mustn't touch**: two droplets on the same or neighbouring electrodes, **diagonals
  included**, would flow together. Also counted: stepping next to an electrode another droplet
  was on **in the frame before**. Anything that would cause that is refused. Only a **Merge**
  joins droplets on purpose.
- **Live**: the connected device shows the frame on screen; **simulate** plays the frames;
  **▶ Run** runs a process for real (asks the questions, follows the answers).

---

## 3. Processes

### 3.1 Tiles

| Tile | Does | Kind |
|---|---|---|
| Start | where a run begins | stop |
| End | where a run finishes | stop |
| Step | any work you draw yourself | work |
| Dispense | pulls a droplet out of a reservoir (names the droplet) | work |
| Move | moves a droplet along a path you draw | work |
| Mix | mixes one droplet in place (circle, back and forth, split & merge) | work |
| Merge | two droplets become one; ends their lanes | work |
| Split | one droplet becomes two | work |
| Wait | holds the droplets for a set time; the way to pause | work |
| Temperature | sets heaters T1–T3; can wait until reached | work |
| Magnet | switches a magnet on/off until the next Magnet tile | work |
| Message | shows up to 20 characters on the OpenDrop's screen (custom firmware) until the next Message tile; empty clears it | work |
| Measure | the run stops for a measured number, typed in by you (its **Ask with** text is shown; a connected instrument comes later) | stop |
| Ask | the run stops and asks a yes/no question (Ask and Measure: **Show it on the device's screen** puts its **Screen text**, up to 20 characters, on the OpenDrop's screen while the run waits) | stop |
| Decision | goes the yes or no way, by a measured or asked value | stop |
| Repeat | goes round "again" N times, then on by "done" | stop |
| Parallel | splits the way into lanes that run at the same time | lanes |
| Wait for all | waits until every lane has finished | lanes |

A work tile must be **placed**: open it on the board (double-click it, or **Open on the board**,
or **Place on the board** in Properties) and draw or drop its work. **Wait, Message, Temperature
and Magnet** place themselves once an arrow leads to them (a Temperature once it sets a heater):
"not placed yet" on one of these means no arrow leads to it, or a Temperature sets no heater.

### 3.2 Stretches: why steps are grouped on the board

The board shows a **stretch**: the work tiles between two stops, played as one piece. A new
stretch starts at a tile that:

- comes right after a stop (Start, Ask, Measure, Decision, Repeat), or
- has an arrow looping back into it (a loop's first tile), or
- has several arrows coming in from different places.

So "Dispense → Move" shows together, but a **Mix that a decision loops back to is a stretch of
its own** (it must be able to play again by itself). Opening a tile shows its whole stretch;
its own clips are bright, the others in the stretch faded.

**Consequence:** a stop pauses **everything**. Nothing in one lane can keep moving while the run
waits at an Ask or a decision, and work after a stop can't overlap with work before it. To make
something overlap with another lane, put it **before** the stop, inside the lanes.

### 3.3 Lanes

- **Parallel** splits into lanes that play at the same time on one board. Lanes must **join
  again**: in a **Wait for all** (droplets stay apart) or a **Merge** (droplets join).
- **No stops inside lanes**: an Ask, Measure, Decision or Repeat inside a lane is an error.
  Put it after the lanes join.
- Lanes ending in separate End tiles is an error ("lanes don't join").

### 3.4 The whole timeline

With a process, the timeline always shows **the whole process**: the stretches one after another
along **one way through it**, with frames counted from Start:

- At every decision it takes the way that **goes on** rather than back round the loop (a loop
  that waits for an answer is shown **once**); where both ways go on, "yes".
- A Repeat runs all its rounds.
- Each stretch starts with the droplets, heaters and magnets the one before left.

The board edits the stretch the red frame line is in; moving the line (or clicking a faded clip
or a band) into another stretch opens it. **simulate** goes through all of it as a **preview** (asks
nothing). A step on a branch the timeline doesn't follow opens on its own.

### 3.5 Running

**▶ Run** goes from Start: each stretch plays, **Measure**/**Ask** ask (a yes/no question also
takes keys **1** or **,** = yes, **2** or **.** = no), decisions and Repeats choose the way.
With **live** on and the device connected, the device follows and is switched off at the end.
Nothing in the project can be changed while a run goes, in this tab or a second one: the board,
tiles, Properties (greyed out), frame time, high voltage, heater rates, layout, opening or adding a file, undo,
and starting a template are all refused. The Device tab's **Send to device** and **Run on the
device** are greyed out too, and the red frame of the board is greyed a bit. Frames can't be stepped through either (wheel,
←/→, Space, ◀ ▶, clicking the timeline or charts): the board follows the run. A hidden browser tab runs slowly.

---

## 4. Heaters and magnets

- Heaters nothing sets are **off** (sent as 0): the Device tab's targets start empty (= off) on
  every visit; Switch all off, disconnecting and closing the page switch them off too. A heater
  warming with nothing set means old firmware/app or a target typed in the Device tab.
- Three heaters **T1–T3** (temperature adapter), targets 20–120 °C; two magnets **M1/M2**
  (magnet board). Set by **Temperature** and **Magnet** tiles or actions; they last until changed, on the device
  too (a magnet stays on past the last frame and at stops, until switched off or the run ends).
- **Message** tiles put text on the OpenDrop's screen (custom firmware OpenDropVCustom only; with
  other firmware the page says "Message not confirmed (no nanoSYD firmware?)" and sends no more
  messages until it reconnects). It is only sent while **live** is on or in a run. Nothing on the screen?
  Check live is on, the firmware is the custom one, and the text isn't hidden by its "INSERT
  CARTRIDGE" / "UNDER VOLTAGE!" warnings, which are drawn over it. Accents are dropped.
- A temperature that **waits**: offline, it lasts the estimated time (ramp rates in the
  Temperature view: warms/cools °C per minute); live, playback holds that frame until the
  readings are within the tolerance.
- Heater zones (standard and magnet layouts): T1 under electrodes 25/26, T2 57/58, T3 97/98.

---

## 5. The device

- Needs **Chrome or Edge** (Web Serial). Close OpenDropController first: only one program can use
  the port. **Device → Connect…**, pick **Feather M0** in the browser's list.
- Dot by the title: grey/amber/green/red (section 1). Board type shows in the Device tab.
- **live** on the board makes the device show the frame on screen; **Switch all off** turns
  everything off. Without a device: open `index.html#sim` and use **Simulated OpenDrop**
  (`#simstock`: one with the original firmware, which confirms nothing).
- Not in the list: wrong browser, another program has the port, or a charge-only USB cable.
- Exported `.json` files open in the original controller, which only reads the first 200 frames.
- **Traffic log** (Device tab, bottom): tick **Log what is sent and what comes back**, reproduce the
  problem, then **Copy** or **Save…** and paste it. Each entry: time, → sent / ← answer / × no
  answer, what it says in words (electrodes, magnets, feedback, targets, message, high voltage,
  save) and the bytes in hex; "×N" = the same packet and answer N times (status checks; temperature readings
  may differ, the latest is shown). Useful
  readings: × no answer after → = the device isn't answering (wrong firmware, busy in its menu,
  or the byte count is off); a message "…" packet followed by × = the firmware didn't read the
  text bytes; the board id in ← answers says which board and adapter it reports. Answers to
  message / high voltage / save packets are 25 bytes with nanoSYD firmware: "confirmed 0xa…:
  high voltage applied, saved, message stored", or "menu open: high voltage and save ignored";
  "no confirmation byte (stock firmware?)" = the firmware isn't nanoSYD's. Ask the user
  for this log when a device problem isn't clear from the photo.

---

## 6. Messages and what they mean

The message usually appears in the **bottom bar**, on a red badge while dragging, on a timeline
clip (hover), or in Properties for a selected tile. *Italic* parts vary.

### Drawing and moving (board)

| Message | Cause | Fix |
|---|---|---|
| "*A* (D1) and *B* (D2) would touch in frame *f* (electrodes *x* and *y*, dark red)" | Two droplets would be on the same or neighbouring electrodes (diagonals count) in frame *f*. Often *f* is later than the frame on screen: one droplet **waits where its path ended** and the other passes by later; or it moves next to where the other was **a frame before**. The dark-red electrodes show the other droplet at frame *f*. | Keep at least one electrode free between them, diagonally too: end the path one step further away, start it in another frame, or route the other droplet differently. To join them, use a Merge. |
| "… would touch in frame *f*, next to where *B* was a frame before" | Stepping onto an electrode beside one another droplet just left. | Wait a frame, or keep a gap. |
| "It can't go there: …" | The action can't be built there (off the array, not a straight line, a reservoir the layout lacks). | Draw it elsewhere. |
| "… would run past frame 100000" | Too long. | Shorten it. |
| "Open a step of the process first: double-click it in the process view" | With a process, drawing needs an open step. | Open a work tile. |
| "A run is going: stop it to change things" | Editing during a run. | **■ Stop** first. |
| "A run is going: the board follows it, so frames can’t be stepped through until it stops" | Scrolling, arrow keys, ◀ ▶ or clicking the timeline during a run. | Wait, or **■ Stop** the run. |
| "High voltage not sent: …" / "Not saved: …" | No device connected, it didn't answer, or a sequence is running on it. | Connect (Device tab) and try again; the project's settings go again on reconnecting. |
| "… not confirmed (no nanoSYD firmware?)" | The device answered but didn't confirm the high voltage, save or message: it runs the original (or an older custom) firmware. Messages then stop being sent to it until it reconnects. | Install the nanoSYD firmware (OpenDropVCustom), or do without high voltage, save and messages. |
| "… menu open on the device, try again" | Someone is in the OpenDrop's own menu, so it ignored the high voltage / save. | Close the menu on the device, then **Save to device** again or change the setting (it also goes again on reconnecting). |
| "… not confirmed by the device" | The firmware confirmed the packet but not the high voltage or save in it. | Try again; if it stays, update the firmware. |
| "Message not shown on the device: it arrived incomplete" | The message's text was cut short three times (USB trouble). | Check the cable; the next message change sends it again. |
| "A run is going in the other tab: stop it there to change things" | Another tab of the page is running the process. | Stop it in that tab (closing that tab ends the lock too). |
| "This layout has no reservoirs" | Dispense on a layout without reservoirs. | Choose another **Layout**. |
| "*N* frame(s) with a time of their own play at the default *t* s: add a Wait where it should pause" | A loaded OpenDrop file had frames of different lengths. | Add Wait tiles where it should pause. |
| "*N* action(s) had times of their own …: every step now lasts the default frame time" | An older project used per-step times, which no longer exist. | Add Waits where needed. |

### Clips and tiles (timeline clip on hover, tile in Properties)

| Message | Cause | Fix |
|---|---|---|
| "its droplet touches *X*'s in frame *f*" | As above, already in the project (e.g. after loading). | Move one of them. |
| "it doesn't start where *X* ends, so the droplet would jump" | It follows an action but starts on another electrode. | Start it where the droplet is (drag its start), or remove the link. |
| "it follows *X*, which doesn't run" / "which never ends" / "an action that isn't there" | Its start depends on something broken or deleted. | Fix that action, or set a start frame in Properties. |
| "it runs past frame 100000 and is cut short there" | Too long. | Shorten it. |
| "it sets no temperature" | A Temperature with no target. | Set at least one of T1–T3. |
| "Not placed on the board yet." / "not placed yet" (orange !) | A work tile has nothing on the board. | Open it and place its work. Wait/Message/Temperature/Magnet: connect an arrow to it (Temperature: set a heater). |
| "On the board it starts in frame *a*, before *X* ends (frame *b*)" | Order on the board differs from the process. | Move it later on the timeline. |
| "Coming from *X*, the droplets are elsewhere: …" | Two ways into a step bring droplets to different places. | Make both ways leave the droplets in the same places. |
| "Another Dispense in this part also makes *name*" | Two Dispense tiles make a droplet with the same name. | Rename one droplet. |

### Process checks (tile badges; red = error, orange = warning)

| Message | Fix |
|---|---|
| "There is no Start tile" / "Only one Start is used: this one is extra" | Exactly one Start. |
| "Nothing comes after it: connect it to the next tile, or to End" / "Its *yes/no/again/done* arrow goes nowhere" | Connect the port (drag from its dot). |
| "A run never gets here: nothing leads to it from Start" | Connect it, or delete it. |
| "Choose the value it decides by" / "No Measure or Ask tile gives *v*" | Set the decision's value to one a Measure or Ask gives. |
| "*v* isn't measured before this on every way here: a run will ask for it" | Fine to leave; or measure it on every way. |
| "*Ask/Measure/Decision/Repeat* can't be inside parallel lanes: put it after the lanes end, in a Wait for all or a Merge" | Move the stop after the lanes join (section 3.3). |
| "Its lanes don't join again: end them in a Wait for all, or in a Merge …" | Lead every lane into one Wait for all or Merge, not separate Ends. |
| "Only one lane comes into it" | A Wait for all needs two or more lanes. |
| "The Merge already waits for its lanes: this Wait for all isn't needed" | Remove the Wait for all. |
| "This part leads to two places at once: end its lanes first" | Join lanes before branching. |
| "This loop never ends: nothing leads out of it" | Give the loop a way out (decision "yes", Repeat "done"). |

### During a run

| Message | Fix |
|---|---|
| "*Step*: nothing on the board" | That step isn't placed; it is skipped. |
| "Stopped: … arrow goes nowhere" / "The process goes round without doing anything" | Fix the arrows / the loop. |
| "Waiting for the heaters: T1 60 °C …" | Normal: live, the run waits until readings reach the targets. Check the adapter is connected and heating. |
| A connected device doesn't follow the run | Switch **live** on before ▶ Run. |

---

## 7. Common situations

- **"I can't draw / nothing happens when I drag."** Read the bottom bar. With a process a step must
  be open (top bar says "On the board: …"); a run may be going; the tool may be **select** or
  **paint** (left side, white box).
- **"Two droplets would touch but they never meet."** The waiting droplet: a path's end stays
  occupied until something carries that droplet on, and diagonals count. Look at the dark-red
  electrodes and the frame number in the message; move to that frame (click the ruler) to see it.
- **"Why are Dispense and Move shown together but Mix separately?"** Stretches (section 3.2): a
  loop's first tile starts its own stretch.
- **"I can't make X happen at the same time as Y."** If a stop (Ask, Measure, Decision, Repeat)
  lies between them, they can't overlap: a stop pauses everything (3.2). Put the overlapping work
  inside Parallel lanes before the stop, and the stop after the lanes join (3.3). For a "mix until
  mixed" loop next to other lanes: do the first Mix inside the lane, then Wait for all → Ask →
  Decision; "no" → a second "Mix again" tile → back to the Ask.
- **"A tile has an orange !"** Usually "not placed yet". A red ! is an error (section 6).
- **"The timeline shows the loop only once / not the other branch."** By design (3.4); Run follows
  the real answers.
- **"simulate doesn't ask my question."** simulate is a preview; use **▶ Run**.
- **"The device doesn't do anything."** Dot by the title green? **live** on? Chrome/Edge? Port free
  (OpenDropController closed)? Cable carries data?
- **"Frames last different times."** Only Waits and heater waits make frames longer (see **Step
  time**). Everything else lasts the frame time.
- **"My work is gone."** It is kept in that browser only; other browsers or cleared data lose it.
  **save** writes a project file.

---

## 8. The project file (`*.odproj`)

If the person pastes it, read:

- `frameTime`: ms per step; `layout`: cartridge.
- `actions`: each `{ id, type, name, droplet, start | after (+ delay), tile? }` plus by type:
  `path` → `points` (electrode `e` = column × 8 + row; columns 1–14 the grid, 0 and 15 the
  reservoirs, rows 0–7 top to bottom); `template` → `template`, `at`, `turns`; `dispense` →
  `reservoir`; `pattern` → `frames` (electrodes on per frame); `wait` → `duration` ms; `temp` →
  `targets` [T1,T2,T3] (null = unchanged), `wait`, `tolerance`; `magnet` → `magnet` 1|2, `on`.
- `templates`: frames as [column, row] offsets.
- `process` (if any): `tiles` `{ id, kind, name, x, y, … }` and `links` `{ from, port, to }`.
  Kinds as in section 3.1 (`join` = Wait for all).

To find a touch by hand: list each droplet's electrode per frame; two droplets touch when their
electrodes are equal or neighbours on screen (on the standard grid: column and row each differ by
at most 1, diagonals included) in the same frame, or one is next to where the other was the frame
before. Other layouts go by where the electrodes are drawn, not by their numbers.
