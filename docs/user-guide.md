# User guide

How to operate LIGHT: looks, layers, cues, effects, and the controls that matter mid-set.

## The mental model

- A **look** is a lighting state: colour, intensity, positions, and effects for one or more fixture groups.
- Looks live in a **grid**: rows are **layers**, columns are **cues**. The layer stack runs bottom-to-top (WASH at the bottom, STROBE on top — the UI shows the top of the stack as the top row).
- Clicking a cell fires its look on that layer with a crossfade. Clicking a **column header** fires the whole column as a cue.
- Everything time-based (effects, fades shown in beats) follows the **beat clock** — tap it, drag it, or let Resolume drive it.

## Firing looks

| Action | How |
|---|---|
| Fire a cell | Click it (also selects it for editing) |
| Fire a column (cue) | Click the column header, or keys `1`–`8` |
| Hold a flash look | Press and hold the cell — it releases on mouse-up |
| Clear a layer | `✕` in the layer header |
| From MIDI | Map pads/faders with MIDI learn (below) |
| From Resolume | Enable OSC output in Arena — column launches follow automatically |

**Column = cue.** Firing a column fires every layer's cell in that column and *clears* layers whose cell is empty — so a column fully describes the stage. Momentary **flash** looks are skipped by cues on purpose: a cue can never latch a blinder on.

**Flash looks** are momentary: active only while the mouse button or mapped MIDI note is held. If the client holding a flash look disconnects entirely, the engine releases it automatically.

## Crossfades

Each layer has a default fade (seconds) in the project; a look can override it with its own **fade** field in the look editor. Colours fade through RGB space (exactly what the fixture's channels do), intensities fade linearly, and *banded* values — derby colour macros, motor modes — snap at the start of the fade because the hardware can't fade between bands.

## Layers and blend modes

Layers apply bottom-to-top. Each has a **master** (scales that layer's intensity contribution) and a **blend mode**:

- **normal** — replaces what's below on the channels the look touches. For base washes.
- **multiply** — multiplies intensity (dimmer/white) below. This is the FX layer's mode: a chase or pulse modulates *whatever colour the wash is showing* without owning colour itself.
- **htp** — highest takes precedence on intensity. For strobes and blinders that ride on top.

The **grand master** (top bar) scales all dimmer/white output. **Blackout** (top bar or `B`) zeroes intensity and strobing instantly — it always wins.

## The look editor

Select a cell → the Look tab shows its editor. A look is a list of **parts**; each part targets one fixture **group** and carries:

- **Dimmer** — intensity 0–100%.
- **Colour** — hue + saturation faders plus swatches. Derbies can't mix colour: they quantise to the nearest of their 14 fixed macros ("auto"), or pick an explicit macro from the dropdown.
- **Derby extras** — *ring blinder* toggle (the white LED ring is on/off hardware — there is no ring dimmer), *ring FX* (the ring's built-in strobe patterns), *motor* (off / static aim / rotate + speed).
- **Strobe** — shutter rate, slow → fast.
- **Position** — pan/tilt for moving heads.
- **Haze** — output + fan for hazer-type fixtures (merged highest-wins with the manual haze slider in the top bar).

Enable a parameter with the checkbox to its left; a look only writes the parameters it has enabled, which is what lets layers combine cleanly.

### Effects

Each part can stack effects. An effect modulates one target (`dimmer`, `hue`, `white`, `strobe`, `pan`, `tilt`) with a wave:

| Wave | Feels like |
|---|---|
| sine / triangle | smooth swells |
| sawUp / sawDown | builds / beat-pulses |
| square | on/off gate (set *width* for duty) |
| chase | one-at-a-time run across the group (*width* = how many are lit) |
| random | sample-and-hold flicker |

- **rate** is musical: 1/4 beat up to 8 bars.
- **size** is depth.
- **spread** fans the phase across the group's heads — spread on a saw = a wipe; chase forces full spread.
- Chase/spread order = the order of heads in the group (see the Fixtures tab; chip order is chase order).

The **speed** fader in the top bar multiplies all effect rates (0.25×–4×) without jumping their phase.

## Tempo

- **TAP** (or `T`) — tap tempo; every tap also lands the downbeat.
- Drag the BPM number vertically for fine adjustment.
- **SYNC** snaps the phase to the next downbeat (matches Arena's resync).
- With Resolume connected via OSC, Arena's tempo drives the clock (see [resolume-and-midi.md](resolume-and-midi.md)).

## MIDI learn

1. Click **MIDI LEARN** in the top bar (it arms).
2. Click any cell, column header, layer master, or top-bar control.
3. Touch the control on your device — pad or encoder. Done; the mapping is stored in the project.

Notes fire cells (note-off releases flash looks); CCs drive faders. Manage or delete mappings in the **Sync · MIDI** tab.

## Saving

Everything autosaves ~1 second after any edit, with five rotating backups (`.bak1`–`.bak5`) next to the project file. `⌘S` (or the save button) forces a save. Live-performance state (which looks are active, grand master, blackout) is deliberately *not* saved — a restart always comes up dark and safe.

## Keyboard reference

`1`–`8` fire columns · `T` tap tempo · `B` blackout · `⌘S` save · `Esc` deselect. Shortcuts are ignored while you're typing in a field.
