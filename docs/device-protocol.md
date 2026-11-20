# Talking to the OpenDrop over USB

How OpenDrop Generator talks to an OpenDrop V4 from the browser (Web Serial, Chrome or Edge), and
a proposal for firmware that can take a whole sequence. The first part is what today's firmware
does: it was read from GaudiLabs' `OpenDropController4_25.pde` (`transmit()`) and
`OpenDropV4/Software/OpenDropV42/OpenDropV42.ino` (`loop()`), plus the high-voltage bytes the
custom firmware (OpenDropVCustom) adds.

The code is in `js/device.js` (bytes, lining up, the session), `js/serial.js` (Web Serial) and
`js/device-sim.js` (a simulated device that counts bytes the way the firmware does).

## Today's protocol

The OpenDrop is a USB serial device. The original controller opens it at **115200 baud**. There is
no start marker, no command byte and no checksum: the firmware counts incoming bytes, and on every
32nd byte it drives the electrodes and answers with 24 bytes. The PC drives the timing: the device
holds what it was last sent until the next packet comes.

### PC → device: 32 bytes

| Byte | Meaning |
|---|---|
| 0–15 | Electrode columns 0–15: one byte per column, bit r = row r (electrode e = column × 8 + row) |
| 16 | Control lines, electrodes 128–135. The V4.2 firmware reads bit 0x2 as magnet 1 (electrode 129) and 0x1 as magnet 2 (electrode 128) |
| 17 | Message on the device's screen (custom firmware): N = 1–254 text bytes follow the packet, 255 clears it, 0 leaves it. Once electrodes 136–143, which the V4.2 firmware doesn't use |
| 18–22 | 0 |
| 23 | 0 (protocol 1: the command, see below) |
| 24 | Feedback: 1 = sense where droplets are (V4.2) |
| 25 | 1 = save the settings to flash (custom firmware; 0 = don't) |
| 26–28 | Temperature targets T1–T3 in °C, for the temperature adapter (20–120; 0 = heater off). The original sends 25 unless they are set; this page sends 0, since the adapter's PID controller holds 25 °C by heating a cooler cartridge, while with 0 its output stays at 0. Not "0 = keep": applied every packet |
| 29 | High voltage in V, 50–240 (custom firmware; 0 = keep the device's) |
| 30 | Frequency / 10: 10–100 = 100–1000 Hz (custom firmware; 0 = keep) |
| 31 | 1 = DC, 2 = AC (custom firmware; 0 = keep) |

**Message (byte 17, `ControlBytesIn[1]`):** with N = 1–254, N plain ASCII bytes come straight after
byte 31 and the device reads them all (within 1 s) before it acts on the packet and answers. Its
screen shows the first 20 characters, centred in a white bar, until another message or a clear
(255, no text); its "INSERT CARTRIDGE" and "UNDER VOLTAGE!" warnings are drawn over it. The page
sends at most 20 characters (accents dropped, other characters as ?), and only when the screen
should change: a frame whose Message action sets other text (during ▶ Run), a run's question (an Ask or
Measure tile set to show on the device), or a clear when there is nothing to show any more (the
end of a run, Switch all off, disconnecting, the page closing). Every other packet has 0 there.

Bytes 25 and 29–31 are read by the custom firmware (`firmware_custom/customFirmware/OpenDropVCustom/OpenDropVCustom.ino`, byte map in
`firmware_custom/customFirmware/SERIAL_PROTOCOL.md`;
`ControlBytesIn[9]` and `[13..15]`): it clamps 29–31 and calls `set_voltage()` when one differs from
what it has; 0 keeps the current setting. With byte 25 = 1 it then calls `save_settings()`, which
writes the high voltage, sound and feedback (byte 24 of that packet) to flash, only if they differ
from what is stored. The original firmware and controller send and ignore 0 there.

The page sends 0 in bytes 25 and 29–31 in ordinary frames. The project's high voltage (Properties,
under the frame time) goes in one packet when the device connects and whenever it changes; the
Device tab's **Save to device** sends it once more with byte 25 = 1.

In the firmware, bytes 16–31 are `ControlBytesIn[0..15]`; the controller sends bytes 18–31 as
`control_data_out[0..13]`.

### Device → PC: 24 bytes

| Byte | Meaning |
|---|---|
| 0–15 | Sensed electrodes per column (with feedback on): **bit b = row 7 − b** (the other way round from the PC's bytes) |
| 16 | 0 (used for the protocol version below) |
| 17–18 | T1 = byte 17 / 100 + byte 18 (°C); 150 or more means there is no sensor |
| 19–20 | T2, the same way |
| 21–22 | T3, the same way |
| 23 | Board ID: high four bits the OpenDrop version (0 = V4.1, 1 = V4.2), low four bits the adapter (0 = none, 1 = magnet, 2 = magnet and temperature) |

So the IDs the original controller knows are 0x00 (V4.1), 0x01 (V4.1, magnet), 0x10 (V4.2), 0x11 (V4.2,
magnet) and 0x12 (V4.2, magnet and temperature adapter). It switches between the `electrodes` and
`electrodes_magnet` layouts by it; so does this app (only between those two).

### The confirmation byte (nanoSYD firmware)

A **command frame** is one that asks the custom firmware for something the original doesn't
know: a message (byte 17 ≠ 0), save (byte 25 = 1) or high voltage (any of bytes 29–31 ≠ 0). The
nanoSYD firmware answers it with the 24 bytes, then **one more byte, 0xA0 | flags**. Ordinary
frames are still answered with 24 bytes, and stock firmware never sends the 25th byte (the
original controller never sends a command frame, so it never sees one).

| Bit | Mask | Meaning |
|---|---|---|
| 7–4 | 0xA0 | Always 1010: a byte with another high nibble is not a confirmation |
| 0 | 0x01 | High voltage applied (bytes 29–31 are now in use) |
| 1 | 0x02 | Saved: flash holds the current settings (written, or already the same) |
| 2 | 0x04 | Message done: cleared (255), or all N text bytes came and it is stored (also while the menu is open) |
| 3 | 0x08 | Someone is in the device's menu: high voltage and save were ignored |

So high voltage and save in one packet give 0xA3; a message while the menu is open, 0xA4 (with
high voltage too, 0xAC). Byte 16 of the answer stays 0.

What this app does: after a command frame it reads the 24 bytes, then waits up to 300 ms for the
25th.
- **None** (or its high nibble isn't 0xA): the firmware isn't nanoSYD's. High voltage and save
  say "not confirmed (no nanoSYD firmware?)". For a message, a stock device took the text bytes
  for the start of the next packet: the app lines the stream up again (below) and sends no more
  messages to that device until it reconnects.
- **0x08**: "menu open on the device, try again".
- **A message without 0x04**: the text arrived incomplete; it is sent again, twice at most, then
  "Message not shown on the device: it arrived incomplete".
- High voltage without 0x01, or save without 0x02: "not confirmed by the device".

### Start-up

When the board starts, it prints its ID as a line of text, then after about two seconds
"Welcome to OpenDrop", before it reads anything. Bytes that arrive meanwhile wait in its USB
buffer. This app drops that text.

### Lining the byte stream up

Because the device only counts bytes, a packet cut short (a program closed while writing, a serial
monitor) leaves it out of step: every later packet would be read from the wrong byte on, and the
answers wouldn't show it, because they don't repeat the frame. So on connecting, this app:

1. Sends 31 zero bytes and waits 150 ms. If the device answers, it was part-way through a packet,
   which those bytes completed; it is now one byte nearer the start of a packet than before.
   Repeat.
2. If it doesn't answer, it was at the start of a packet and now needs one more byte. Send one
   zero byte: it answers.
3. Steps 1–2 must come out that way twice in a row, so an answer that came late can't fool it.
4. If the device doesn't answer at all, it may still be starting: wait 2.5 s and try once more.

The packets it completes are all zeros: everything off. A device that stops answering later (500 ms
without an answer) is lined up again the same way.

**Magnets slow the answer.** The firmware switches a magnet before it answers: `set_Magnet` pulses
the coil with two `delay(150)`, about 300 ms for each magnet whose bit in byte 16 changed (600 ms
for both). The page knows which magnet bits the device has, and waits 300 ms longer per magnet a
frame switches (lining up too, where the zeros switch magnets that are on off). Otherwise the
answer came after the 500 ms, the device was taken for not answering and lined up again, and
those zeros switched the magnet off: it went on and off instead of staying on.

Only command frames get the 25th byte. Lining up sends zeros, which never are one, so it always
expects 24 bytes. A confirmation that comes too late is dropped with any other leftover bytes
before the next packet goes.

### What this app sends, and when

- **On connecting:** the device gets an all-off frame.
- **During ▶ Run** (the session's `live` is on only then): the run's frame on screen, whenever its
  bytes change. One packet is in flight at a time; while one waits for its answer, only the newest
  frame waits behind it. Frame times are kept by the PC: the run holds each frame for its own time.
  Stepping, editing and simulate send nothing new (the device stays all off).
- **End of a run, Switch all off, Disconnect:** an all-off frame first.
- **Polling:** every second (every 300 ms with feedback on), it sends again what the device should
  have: the run's frame during ▶ Run, all off otherwise. That keeps the temperatures, feedback and
  connection state fresh.
- **Closing or reloading the page:** an all-off frame, if there is time to send it.

## Protocol 1 (proposed, for new firmware)

Today's firmware can't run anything on its own: the PC sends every frame. Protocol 1 lets the PC
load a whole sequence, with each frame's time, and the device run it on its own clock. It keeps
today's framing, so the same app works with both.

### Telling the versions apart

Byte 16 of every answer is the **protocol version**: 0 for today's firmware, 1 for this. The
browser only sends the commands below to a device that answered with 1 or more. Old firmware would
take them for electrode data.

### Commands

A command is a 32-byte packet like a frame, with the **command in byte 23** (`ControlBytesIn[7]`,
unused; bytes 25 and 31 are the custom firmware's save flag and AC/DC): 0 = a frame to show
(as today), 1 = load a sequence, 2 = run it, 3 = stop, 4 = status. For commands 1–4 the electrode
bytes are ignored; feedback and the temperature targets (bytes 24, 26–28) apply as for a frame; the high-voltage bytes are 0.

A frame (command 0) is answered with 24 bytes, as today. Commands 1–4 are answered with 32 bytes:
the usual 24, then:

| Byte | Meaning |
|---|---|
| 24 | Result: 0 ok, 1 bad checksum, 2 too long, 3 busy (running), 4 unknown command, 5 nothing loaded |
| 25 | State: 0 idle, 1 running, 2 done |
| 26 | The frame running now (1–200), 0 when not running |
| 27 | Frames stored |
| 28–29 | Checksum of the stored sequence (little-endian), 0 if none |
| 30–31 | 0 |

### Load (command 1)

Straight after the command packet comes the sequence block. The device answers once it has all of
it (or as soon as the header says it is too long):

| Bytes | Meaning |
|---|---|
| 0–1 | "OD" (0x4F 0x44) |
| 2 | Format: 1 |
| 3 | N, the number of frames (1–200) |
| 4 … | N frames of 22 bytes: the 18 electrode bytes of a packet (columns 0–17, bit r = row r), then the frame's time in ms (uint32, little-endian) |
| last 2 | CRC-16/CCITT-FALSE (polynomial 0x1021, start 0xFFFF, no reflection) of everything before, little-endian |

At most 4 + 200 × 22 + 2 = 4406 bytes. "123456789" gives the CRC 0x29B1. The device keeps the
sequence (in RAM is enough: 4.4 kB) and answers with result 0, frames stored and the checksum. The
browser checks both before it lets you run it.

### Run (2), stop (3), status (4)

- **Run:** shows frame 1 and holds it for its time, then frame 2, and so on, on the device's own
  clock. After the last frame it switches everything off and its state is "done".
- **While running:** frames (command 0) are ignored (answered as usual); load answers "busy".
- **Stop:** ends a run and switches everything off.
- **Status:** just the answer. The browser asks every 500 ms while a run goes on, to show "frame n
  of N".

### Firmware sketch

On top of today's `loop()`:

```text
on the 32nd byte of a packet:
  command = ControlBytesIn[7]
  feedback, temperature targets, high voltage as today
  if command == 0: if not running: drive the frame as today. Answer 24 bytes (byte 16 = 1).
  if command == 1: if running: answer busy; else the next bytes are a block: read 4, check
                   "OD", format 1, N <= 200 (else answer "too long" and go back to packets);
                   read the rest, check the CRC, keep it, answer.
  if command == 2: if nothing loaded: answer "nothing loaded"; else start at frame 1, answer.
  if command == 3: stop, drive all off, answer.
  if command == 4: answer.
while running: when the frame's time is up, drive the next one; after the last, all off, "done".
```

Use `millis()` for the timing rather than `delay()`, so packets keep being read during a run.

## Trying it without the device

Open `index.html#sim` (or `#sim1` for protocol 1): the Device tab then has **Simulated OpenDrop**.
It counts bytes the way the firmware does, answers as a V4.2 board with magnets and the temperature
adapter, reports the electrodes that are on as sensed, and with protocol 1 runs loaded sequences.
It runs nanoSYD's firmware (messages, high voltage, save, the confirmation byte); `#simstock`
simulates stock firmware instead, which does none of that and never confirms.
`tests/device.test.js` uses it too.
