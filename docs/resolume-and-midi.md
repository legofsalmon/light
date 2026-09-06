# Resolume & MIDI integration

Wiring Arena's clip grid and a MIDI controller into LIGHT.

## Resolume Arena over OSC

LIGHT listens for OSC on UDP port **7700** by default (change it in **Sync · MIDI**).

### One-time Arena setup

1. Arena ▸ **Preferences ▸ OSC**.
2. Enable **OSC Output**.
3. Output address: `127.0.0.1` (same machine), port: **7700**.

That's all. With **follow columns** and **bpm from resolume** enabled in LIGHT's Sync tab (both default on):

- **Launching an Arena column fires the matching LIGHT column** as a cue — Arena column 3 fires LIGHT column 3. Keep the two grids arranged in parallel and one button runs video and lights together. (Arena emits the column connect for mouse launches too, so this catches everything.)
- **Arena's BPM drives every LIGHT effect.** Arena sends its tempo slider normalised 0–1 over its 20–500 BPM range; LIGHT converts back automatically. Arena's *resync* also snaps LIGHT's downbeat.

### Addresses LIGHT understands

| Address | Args | Effect |
|---|---|---|
| `/composition/columns/N/connect` | int ≥ 1 (or none) | Fire column N (1-based) |
| `/composition/tempocontroller/tempo` | float 0–1 (or raw BPM > 1) | Set BPM |
| `/composition/tempocontroller/resync` | — | Snap phase to downbeat |
| `/light/bpm` | float | Set BPM directly |
| `/light/column` | int (1-based) | Fire a column |
| `/light/blackout` | 0 / 1 | Blackout off / on |

The `/light/*` addresses are for anything else that speaks OSC — TouchOSC layouts, QLab, custom scripts.

### Debugging

The **OSC monitor** (Sync tab) shows the last messages received live. If nothing appears: check Arena's OSC output is enabled and pointed at the right port, and that LIGHT's listener is on (the OSC status dot in the top bar lights while messages arrive).

### Current limits

- Clip-level follows (`/composition/layers/N/clips/M/connect`) aren't mapped yet — columns are the sync unit. Per-clip mapping is on the roadmap.
- Tempo follows Arena's tempo slider. Two other sources can take it instead, both native-engine only: **Ableton Link**, where a local tap or BPM drag is pushed back to the session, and **MIDI beat clock**, where the first input sending clock owns the tempo until it goes quiet. Link and beat clock are one choice, not two, and while the beat clock is following it wins over Arena.

## MIDI

### How learn works

1. Arm **MIDI LEARN** in the top bar.
2. Click the thing to map: a grid cell, a column header, a layer master, the grand master, speed, haze, tap, or blackout.
3. Touch your controller. The **engine** captures the next note or CC and stores the mapping in the project.

Because the engine owns the mapping, it works identically whether the MIDI arrives through the browser (WebMIDI) or natively in the app (CoreMIDI) — and in the app, your controller keeps working even if the window is closed.

### Behaviour

- **Notes** act like fingers: note-on fires the cell (or column/tap/blackout), note-off releases it — so a pad held on a *flash* look behaves exactly like holding the mouse button.
- **CCs** drive continuous targets (masters, speed, haze) with the full 0–127 range. A CC mapped to a button-style target treats > 63 as pressed.
- Mappings are per-project. View and delete them in **Sync · MIDI**.

### Browser vs app

- **Browser (dev)**: Chrome's WebMIDI is used; the page will ask for MIDI permission once. The browser forwards events to the engine.
- **App**: the Rust core talks to CoreMIDI directly and hot-plugs devices (rescan every few seconds). When the engine has native inputs, the UI stops forwarding WebMIDI so a device connected to both paths can't double-trigger.

### Firing pads from a DAW

A MIDI clip in Ableton, Logic or Bitwig can fire pads and columns exactly like a
controller pad, in the next 40 Hz frame. Nothing in LIGHT needs enabling: the
app connects to **every** CoreMIDI input it finds and rescans for new ones, so a
virtual bus is just another controller as far as the mapping is concerned.

**There is nothing to set up.** While the app is running it publishes a MIDI
port of its own called **LIGHT**, so it is already in your DAW's list of MIDI
outputs. Point a track at it, put notes on the track, then in LIGHT arm MIDI
LEARN, click the pad you want, and play the note. That is the whole recipe — the
mapping stores in the project like any other. Beat clock sent to the same port
drives the tempo, and the beat clock button names *LIGHT* as its source.

The port exists only while the app is running, so start LIGHT before you go
looking for it in the DAW. It is a destination, not a source: it appears where
your DAW lists MIDI **outputs**, and LIGHT never lists it among its own inputs
because the console would only be talking to itself.

**If you would rather use an IAC bus** — routing to several apps at once, or
keeping the DAW's output pointed somewhere stable across restarts — that still
works, and it is the only option in a browser session, where LIGHT has no native
MIDI to publish. Open *Audio MIDI Setup* (in Applications ▸ Utilities), choose
*Window ▸ Show MIDI Studio*, and double-click **IAC Driver**. Tick *Device is
online*, and add a bus if there is none. The bus appears to every app on the Mac
as both an input and an output, named for the device and the bus together — "IAC
Driver Bus 1", say. It will show up under *inputs* in LIGHT's **Sync · MIDI**
tab; if it does not, the driver is offline or the bus has not been added.

Two things to know before you build a show on it.

**A pad mapping is a position, not a look.** A mapping points at a layer and a
column, and each song has its own page of pads at those positions. So the same
note fires a different look after a song switch, which is either exactly what
you want (the DAW plays the same arrangement of hits through every song) or a
trap (you wanted *that* look). If you want one note to mean one look, keep it in
one song, or map the song switch to the DAW too and let the two move together.

**There is no timeline lock.** LIGHT reads MIDI beat clock for tempo, and a
transport start lands the downbeat, so a DAW can drive the tempo and the
downbeat (see *Tempo* in the [user guide](user-guide.md)). It does **not** read
song position pointer or MIDI timecode, so starting playback from the middle of
a song gives you the tempo but not the position — nothing chases the timeline.
Notes fire when they arrive and that is all. Locking a show to a timeline is
meant to come through Arena's column follow rather than a direct DAW hook, which
is why the OSC path above is the one with the sequencing in it.

### Suggested starter layout (pad + fader controller)

| Control | Map to |
|---|---|
| 8 pads, top row | Columns 1–8 |
| Pads, second row | STROBE layer cells (flash looks — hold to hit) |
| Fader 1 | Grand master |
| Fader 2 | WASH layer master |
| Fader 3 | FX layer master |
| Fader 4 | Haze |
| Encoder / fader 5 | Effect speed |
| A spare pad | Tap tempo |
| A guarded pad | Blackout |

Map it once with learn; it saves with the project.
