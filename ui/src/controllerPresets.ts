// The controller layouts the Sync panel loads. Kept out of the view so the
// Node suite can hold them against the LED tables in surfaces.ts: a button that
// lights up has to do the thing its light claims, and the two note tables were
// written months apart in different files.

import type { MidiAction, MidiMapping, Project } from '../../shared/types.ts';
import { uid } from '../../shared/types.ts';
import { APC40_COLUMN_ROW, APC_COLS, APC_KNOB_BANKS, APC_LAYER_ROWS } from './surfaces.ts';
import { groupsInRowOrder } from './groupOrder.ts';

/** METRONOME, the APC40 mk2's own "now is the top of the bar" key (0x5A). Not
 *  in the surface table because nothing lights it — it is an input only. */
const APC40_METRONOME = 90;

/**
 * Akai APC40 mk2 (generic mode 0):
 * clip grid 5×8, notes 0–39 (bottom-left = 0, rows ascend); scene launch
 * column notes 82–86 (top→bottom); STOP ALL CLIPS note 81; CLIP STOP note 52
 * on channels 0–7 (the channel is the track!); track faders CC 7 on channels
 * 0–7 likewise; master fader CC 14 ch 0; bank ◀ ▶ notes 97/96; tap tempo note
 * 99; METRONOME note 90.
 *
 * Mapping (see apc40Mk2Mappings for the authority): the FOUR upper grid rows
 * mirror the on-screen layers and the bottom row is reserved for the control
 * row the look grid draws beneath them; the CLIP STOP row under the grid fires
 * whole columns; four scene buttons clear their layer;
 * STOP ALL CLIPS = blackout (the surface's closest thing to a panic key);
 * METRONOME = sync;
 * track faders 1–4 = layer masters, 6 = haze, 7 = effect speed; master fader =
 * grand master; bank ◀ ▶ = previous / next song; TAP TEMPO = tap; the eight
 * DEVICE CONTROL knobs drive the eight Named Controls of the control row, bound
 * on every track-selection bank so the knobs cannot be banked away. (An earlier
 * layout put cues on the bottom row and blackout on a scene button — the mini
 * preset still does — so don't "restore" that here.)
 */
export function apc40Mk2Mappings(p: Project): MidiMapping[] {
  const maps: MidiMapping[] = [];
  const add = (type: 'note' | 'cc', channel: number, number: number, action: MidiAction) =>
    maps.push({ id: uid('midi'), type, channel, number, action });

  // FOUR layer rows. The fifth belongs to the control row, so that the surface
  // and the screen are the same 5 x 8 shape — and so the LED feedback, which
  // lights four rows (ui/src/apcFeedback.ts, core/src/apc.rs), can never leave
  // a row that fires cues permanently dark. The bottom row is deliberately left
  // UNMAPPED rather than bound to the controls: a note drives a continuous
  // target by its velocity on press only (release is ignored so a pad release
  // cannot slam a macro to zero), so a pad could push a control to full and
  // never bring it back. Controls belong on an encoder — learn one from the
  // control row itself.
  const visual = [...p.layers].reverse(); // top grid row = top layer
  visual.slice(0, APC_LAYER_ROWS).forEach((layer, row) => {
    const base = 32 - row * 8; // top row = notes 32–39, bottom = 0–7
    for (let col = 0; col < Math.min(8, p.columns.length); col++) {
      add('note', 0, base + col, { kind: 'cell', layerId: layer.id, col });
    }
    add('note', 0, 82 + row, { kind: 'layerClear', layerId: layer.id });
  });
  // The CLIP STOP row — the eight buttons directly under the grid — is the GO
  // row: CLIP STOP under column N fires column N. It is the one row on this
  // surface that can carry the cues without taking the control row, because it
  // is not part of the 5 x 8 grid at all. Note 52 on every one of them: on this
  // surface a per-track button carries the TRACK in its channel, which is why
  // the LED map is keyed by (channel, note) and why the loop below varies the
  // channel and not the number.
  for (let col = 0; col < Math.min(APC_COLS, p.columns.length); col++) {
    add('note', APC40_COLUMN_ROW.channels[col], APC40_COLUMN_ROW.note, { kind: 'column', col });
  }
  // Blackout moves to STOP ALL CLIPS: the five scene buttons are now all layer
  // clears, and stop-all is the closest thing the surface has to a panic key.
  add('note', 0, 81, { kind: 'blackout' });
  // METRONOME is the surface's own name for what LIGHT calls SYNC, and it runs
  // the same path: the clock AND the effect phase land on the bar.
  add('note', 0, APC40_METRONOME, { kind: 'sync' });
  add('note', 0, 99, { kind: 'tap' }); // dedicated TAP TEMPO button
  add('note', 0, 97, { kind: 'deckPrev' }); // bank ◀ = previous song page
  add('note', 0, 96, { kind: 'deckNext' }); // bank ▶ = next song page
  // Layer masters take one track fader each — and must cover the SAME four
  // layers the pad rows and the LEDs do, or a show with a fifth layer gets a
  // fader riding a layer that has no pads while the top row has no fader at
  // all. Hence: take the capped VISUAL list, then put it back in project order,
  // because track fader 1 has always been the bottom layer and flipping that
  // would move every operator's hand to the wrong fader. With four layers this
  // is exactly what it has always produced.
  visual
    .slice(0, APC_LAYER_ROWS)
    .reverse()
    .forEach((layer, i) => add('cc', i, 7, { kind: 'layerMaster', layerId: layer.id }));
  add('cc', 5, 7, { kind: 'haze' }); // track 6 fader
  add('cc', 6, 7, { kind: 'speed' }); // track 7 fader
  add('cc', 0, 14, { kind: 'grand' }); // master fader

  // The eight DEVICE CONTROL knobs (CC 0x10-0x17) drive the eight Named
  // Controls of the grid's control row — the surface's only continuous bank,
  // and the right home for a macro. Pads cannot do this job: a note drives a
  // continuous target by velocity on press only, so a pad can push a macro to
  // full and never bring it back.
  //
  // Mapped on ALL NINE channels, deliberately. In generic mode the knobs are
  // BANKED by the [TRACK SELECTION] buttons — protocol v1.2: "these knobs and
  // switches will output on a different MIDI channel based on the current Track
  // Selection (track 1 = MIDI channel 0, track 8 = MIDI channel 7, MASTER =
  // MIDI channel 8)". Bind one channel only and a stray press of a track button
  // silently kills all eight knobs mid-show. Binding every bank makes knob N
  // drive control N whatever the surface thinks is selected — LIGHT has no use
  // for nine banks of macros, and an operator has no way to see which bank they
  // are in.
  (p.controls ?? []).slice(0, APC_COLS).forEach((control, i) => {
    for (let bank = 0; bank < APC_KNOB_BANKS; bank++) {
      add('cc', bank, 0x10 + i, { kind: 'control', controlId: control.id });
    }
  });
  return maps;
}

/** The APC40 mk2's track faders are CC 7, one channel per track. */
const APC40_TRACK_FADER = 7;

/**
 * The APC40 mk2 as a busking desk (design decision 2, A28). Everything the
 * default layout does, except the four right-hand track faders: those ride the
 * level of the first four groups on the GROUPS row — pinned groups first — so a
 * hand can pull the strips down under a drop without reaching for the mouse.
 * Haze and effect speed give up their faders and stay on the screen.
 *
 * A second layout rather than a change to the default, because a hand that
 * already knows fader 6 is haze should not find it has become a group. The
 * groups are the row's at the moment the layout is loaded: pin different ones
 * and load it again to move the faders.
 */
export function apc40Mk2BuskMappings(p: Project): MidiMapping[] {
  const busk = (m: MidiMapping) =>
    m.type === 'cc' && m.number === APC40_TRACK_FADER && m.channel >= APC_LAYER_ROWS && m.channel < APC_COLS;
  const maps = apc40Mk2Mappings(p).filter((m) => !busk(m));
  groupsInRowOrder(p)
    .slice(0, APC_COLS - APC_LAYER_ROWS)
    .forEach((g, i) => maps.push({
      id: uid('midi'),
      type: 'cc',
      channel: APC_LAYER_ROWS + i, // track faders 5–8
      number: APC40_TRACK_FADER,
      action: { kind: 'submaster', groupId: g.id },
    }));
  return maps;
}

/**
 * Akai APC mini mk2 factory layout (channel 0):
 * pads 0–63 (bottom-left = 0, rows ascend), scene column 112–119,
 * track faders CC 48–55, master fader CC 56.
 *
 * Mapping: top four pad rows mirror the on-screen grid (top row = top layer),
 * bottom pad row fires columns, scene buttons clear layers + tap + blackout,
 * faders 1–4 = layer masters (bottom layer first), 5 = haze, 6 = speed,
 * master fader = grand master.
 */
export function apcMiniMk2Mappings(p: Project): MidiMapping[] {
  const maps: MidiMapping[] = [];
  const add = (type: 'note' | 'cc', number: number, action: MidiAction) =>
    maps.push({ id: uid('midi'), type, channel: 0, number, action });

  const visual = [...p.layers].reverse(); // top row of the UI grid first
  visual.slice(0, 4).forEach((layer, row) => {
    const base = 56 - row * 8;
    for (let col = 0; col < Math.min(8, p.columns.length); col++) {
      add('note', base + col, { kind: 'cell', layerId: layer.id, col });
    }
    add('note', 112 + row, { kind: 'layerClear', layerId: layer.id });
  });
  for (let col = 0; col < Math.min(8, p.columns.length); col++) {
    add('note', col, { kind: 'column', col });
  }
  add('note', 118, { kind: 'tap' });
  add('note', 119, { kind: 'blackout' });
  p.layers.slice(0, 4).forEach((layer, i) => add('cc', 48 + i, { kind: 'layerMaster', layerId: layer.id }));
  add('cc', 52, { kind: 'haze' });
  add('cc', 53, { kind: 'speed' });
  add('cc', 56, { kind: 'grand' });
  return maps;
}


/** The layouts the desk can load, as a table rather than buttons wired by
 *  hand: the Sync section lists it, and the smoke suite walks it and holds
 *  every entry against the LED map it lights. `help` is the map itself — hovering a
 *  preset is how you find out what it will do to your controller before you
 *  ask for it. */
export const CONTROLLER_PRESETS = [
  {
    name: 'apc40mk2',
    label: 'APC40 mk2',
    help: 'top 4 grid rows → layers (the bottom row is the control row, left unmapped) · CLIP STOP row → fire that column · 8 device knobs → the 8 dials, on every track-selection bank · scene buttons → layer clears · STOP ALL CLIPS → blackout · TAP → tempo · METRONOME → sync · bank ◀ ▶ → prev / next song · track faders 1–4 → layer masters, 6 → haze, 7 → speed · master → grand',
    build: apc40Mk2Mappings,
  },
  {
    name: 'apcminimk2',
    label: 'APC mini mk2',
    help: '4 grid rows → layers · bottom row → column cues · round buttons → layer clears · TAP + blackout keys · faders → 4 layer masters, haze, speed, grand',
    build: apcMiniMk2Mappings,
  },
  {
    name: 'apc40mk2busk',
    label: 'APC40 mk2 · busk',
    help: 'the APC40 mk2 layout, with track faders 5–8 → the first four groups on the GROUPS row (pin groups from its head to choose them, then load this again) · haze and speed stay on screen · track faders 1–4 → layer masters · master → grand',
    build: apc40Mk2BuskMappings,
  },
] as const;

export type ControllerPresetName = (typeof CONTROLLER_PRESETS)[number]['name'];

export const controllerPreset = (name: ControllerPresetName) =>
  CONTROLLER_PRESETS.find((p) => p.name === name);
