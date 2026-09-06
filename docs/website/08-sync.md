# Tempo, MIDI and Resolume

## The beat clock

Everything time-based follows it: effect rates in beats, fades measured in
beats, steps.

- **TAP** (or `T`) — tap the tempo. Every tap also lands the downbeat.
- Drag the BPM number vertically for fine adjustment.
- **SYNC** makes the moment you press it the top of a bar — the bar count and every effect cycle restart there. Arena's own resync over OSC does the same.
- **LINK** joins an Ableton Link session and shows the peer count. Tapping in
  LIGHT leads the session.

Because rates are musical, changing tempo moves the whole rig in time without
any effect jumping phase.

## Resolume, over OSC

Enable OSC in the Sync · MIDI tab and point Arena at the port. Two things then
work on their own:

- **follow columns** — a column launch in Arena fires the matching cue in LIGHT.
- **bpm from resolume** — Arena's tempo and downbeat drive the clock instead of
  the tap.

There is a live monitor of incoming OSC in the same tab, which is the fastest
way to find out whether Arena is actually sending what you think.

## MIDI learn

1. Click **MIDI LEARN** in the top bar.
2. Click the thing you want to control — a pad, a column header, a layer master,
   a control's fader, blackout.
3. Touch the control on your device.

Notes fire pads and release flash looks on note-off. CCs drive faders. Mappings
are stored in the project, and the Sync · MIDI tab lists them for editing or
deletion.

## The APC40 mk2

There is a preset. It maps:

- the **top four pad rows** to the four layer rows of the grid, with matching
  colours on the pads;
- the **eight device knobs** to the eight dials, bound across all nine
  track-selection banks so a stray track button cannot unbind them;
- **scene buttons** to layer clears, **STOP ALL CLIPS** to blackout,
  **TAP TEMPO** to tap, the **bank arrows** to previous/next song;
- **track faders** to layer masters, then haze and effect speed, and the
  **master fader** to grand master.

The bottom pad row is deliberately left unmapped: it is the control row on
screen, and a pad cannot drive a continuous dial in both directions.

The pad LEDs mirror the grid — bright is what the layer is playing, dim is
available, coloured by each look's own swatch. A pad in the live column that no
longer holds the playing look keeps reporting the **stage**, not the pad, so the
surface never says "idle" about a layer that is lighting the room.

## The APC mini mk2

Also presetted, with a smaller layout: four pad rows for layers, the bottom row
firing columns, scene buttons for clears, tap and blackout.
