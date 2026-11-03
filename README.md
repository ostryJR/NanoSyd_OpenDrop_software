# OpenDrop Generator

A browser app for drawing electrode sequences for the OpenDrop V4 digital-microfluidics platform
and saving them as the `.json` frame files used by GaudiLabs' **OpenDropController4_25**. It is a
port of that controller's editor; it does not talk to the device.

## Run

Open `index.html` in Chrome or Edge. Double-clicking the file works: there is no server, nothing
to install, and it runs offline. Safari and Firefox work too, but there Save asks for a file name
and downloads the file instead of showing a save dialog.

## Controls

| To | Do |
|---|---|
| Switch an electrode on or off | Click it |
| Switch several on (or off) | Drag across them; the first electrode decides on or off |
| Go to the next frame and switch an electrode on | Shift+click |
| Change frame | ← / →, the mouse wheel (up = next), or the arrows under the array |
| Play / stop | Space or the **play** button; loops up to the last frame with anything on |
| Change playback speed | Mouse wheel while playing (5–600 frames/min) |
| Copy the previous frame, clear the frame, clear everything | Buttons on the right |
| Dispense a droplet from a reservoir | The four buttons beside the reservoirs (writes 6 frames) |
| Save / load a sequence | **save** / **load**, top right |
| Show electrode numbers | `N` or the checkbox in the bottom bar |
| Use another cartridge layout | The Layout menu (all layouts from the original repository) |

## File format

The same as OpenDropController4_25, byte for byte, so files open in either app:

```json
[
  {
    "y0": "010000000000000000",
    "y1": "000000000000000000",
    …
    "y7": "000000000000000000",
    "frame": 1
  },
  …
]
```

- One object per frame, from frame 1 to the last frame with any electrode on (at most 200).
- `"yR"` is row R (0 = top). Character k of it is column k, `1` = on. Electrode ID = column × 8 + row.
- Columns 0 and 15 are the left and right reservoirs, 1–14 the 14 × 8 grid, and 16–17 control
  lines (16 drives the magnets in the magnet layout).

## Differences from the original

- Works without a device. The live-control parts (connect, life, feedback, temperatures) are left out.
- Loading replaces the current sequence; the original merged the file into whatever was on screen.
- Save doesn't add a second `.json` to the name.
- Loading skips frames after 200 instead of crashing, and also reads files from controller 3.2.
- A fast drag paints every electrode along the way.

## Development

- Tests: `node --test` (Node 20 or later).
- `js/layouts-data.js` is generated from the original layout files:
  `node tools/convert-layouts.js <path to OpenDrop/OpenDropController4_25>`.
- `js/editor.js` holds the editing behaviour, `js/jsonio.js` the file format, `js/view.js` the
  drawing and `js/app.js` the page wiring. The first three have no browser dependencies.

## License

GPL-3.0, see `LICENSE`. Based on [OpenDrop](https://github.com/GaudiLabs/OpenDrop) by GaudiLabs:
the frame image, the electrode layouts and the editor behaviour come from OpenDropController4_25.
