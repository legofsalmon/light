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
- Tempo follows Arena's tempo slider; Ableton Link support is planned (Arena supports Link natively).

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
