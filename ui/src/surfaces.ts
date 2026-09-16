// What the LEDs on an Akai control surface should say, with no connection and
// no store: the surface table, the palette, and the map from engine state to
// (channel, note) → (channel, velocity). Split out of apcFeedback.ts so the
// Node suite can
// test the same function the browser runs and hold it against the Rust mirror
// (core/src/apc.rs) — the two have to paint the same picture, and until this
// split nothing checked that.
//
// The pad grid mirrors the look grid: bright = what the layer is playing, in
// the colour of what is playing; dim = available pads, coloured by each look's
// swatch. Layer buttons light when their layer has something to clear, the
// blackout button blinks while blackout is armed, and tap pulses on the beat.
//
// Two surfaces, one picture, two encodings. The APC40 mk2 takes a palette index
// as velocity on channel 0, and brightness is baked into the palette: each hue
// has a bright index and a dim one. The APC mini mk2 takes the same palette
// index but the MIDI CHANNEL selects the behaviour — channel 6 is full
// brightness, channel 1 is 25%. So the map is computed once and each surface
// encodes the same decision its own way.
//
// The APC40's grid is 5 x 8 and the screen is laid out to match it exactly:
// FOUR layer rows plus the control row underneath them. That is why the layer
// cap below is 4 and not 5 — the fifth row belongs to the controls, and a fifth
// layer would silently steal it. The column row lives OUTSIDE that grid on this
// surface: the CLIP STOP buttons underneath it, one note on eight channels. The
// mini's 8 x 8 has room for its column row inside the grid. (An even earlier
// layout put cue columns on the APC40's bottom PAD row; don't "restore" that.)
//
// Single-colour buttons are velocity 0 off / 1 on / 2 blink on both. Velocity 2
// is the HARDWARE blink at a fixed rate, which is why the tap pulse is driven
// from the beat here rather than handed to the device.

import type { Project, Snapshot } from '../../shared/types.ts';
import { lookSwatch } from './lookColors.ts';

/** The clip grid's shape, and the contract the on-screen grid keeps with it:
 *  APC_ROWS = 4 layer rows + 1 control row. */
export const APC_LAYER_ROWS = 4;
export const APC_COLS = 8;
export const APC_ROWS = APC_LAYER_ROWS + 1;
/** Track-selection banks the DEVICE CONTROL knobs are spread across in generic
 *  mode — the knobs send on a different MIDI channel per bank, so a binding is
 *  only gig-proof if it covers all nine. */
export const APC_KNOB_BANKS = 9;

/** Where a surface's buttons live and how it wants a pad lit. Data, not a
 *  class: the two surfaces differ in note numbers and in one encoding
 *  decision, and nothing else. Mirror of `Surface` in core/src/apc.rs. */
export type Surface = {
  name: string;
  /** lowercased substrings that identify the port */
  matches: string[];
  /** note of column 0 in the TOP layer row; each row down is 8 lower */
  layerBase: number;
  /** layer-clear buttons, top row first */
  sceneBase: number;
  /** blackout / stop-all-clips */
  blackout: number;
  /** tap tempo, pulsed on the beat */
  tap: number;
  /** An RGB PAD row that fires whole columns: eight consecutive notes from
   *  here on channel 0, lit dim / bright like any other pad (mini mk2). */
  columnBase?: number;
  /** A single-colour BUTTON row that fires whole columns: one note, and the
   *  channel is the column — the APC40 mk2's CLIP STOP row, where the channel
   *  IS the track. Not a second base note: the eight buttons all carry note 52
   *  and differ only by channel, which is why the LED map is keyed by the pair.
   *  Single-colour, so the two-brightness pad rule reduces to one bit here: lit
   *  while the whole column is on stage, dark otherwise. */
  columnRow?: { note: number; channels: number[] };
  /** [playing, available] when brightness is the CHANNEL and the palette index
   *  is just the hue (mini mk2); absent when the palette index carries the
   *  brightness itself (APC40 mk2, channel 0 throughout). */
  brightChannels?: [number, number];
  /** inclusive note ranges to blank on attach */
  clear: [number, number][];
};

/** The APC40 mk2's CLIP STOP row, named once so the LED table and the input
 *  preset cannot drift: one note (0x34), and the channel is the track. */
export const APC40_COLUMN_ROW: { note: number; channels: number[] } = {
  note: 52,
  channels: [0, 1, 2, 3, 4, 5, 6, 7],
};

/** Only the 5 x 8 clip grid is RGB; scene LEDs are single-colour. The bottom
 *  row of the grid is left dark for the control row the screen draws there. */
export const APC40_MK2: Surface = {
  name: 'APC40 mk2',
  matches: ['apc40'],
  layerBase: 32,
  sceneBase: 82,
  blackout: 81,
  tap: 99,
  columnRow: APC40_COLUMN_ROW,
  clear: [[0, 39], [81, 86], [99, 99]],
};

/** 8 x 8 RGB grid with the bottom row firing columns, and a scene column down
 *  the right. Brightness is the channel here: 6 is 100%, 1 is 25%. */
export const APC_MINI_MK2: Surface = {
  name: 'APC mini mk2',
  matches: ['apc mini', 'apcmini'],
  layerBase: 56,
  sceneBase: 112,
  blackout: 119,
  tap: 118,
  columnBase: 0,
  brightChannels: [6, 1],
  clear: [[0, 63], [112, 119]],
};

export const SURFACES: Surface[] = [APC40_MK2, APC_MINI_MK2];

/** One "playing or available" decision, encoded the way this surface wants. */
function pad(s: Surface, palette: { bright: number; dim: number }, active: boolean): [number, number] {
  if (s.brightChannels) return [active ? s.brightChannels[0] : s.brightChannels[1], palette.bright];
  return [0, active ? palette.bright : palette.dim];
}

/** White, as the palette's bright and dim anchors — the column row is not
 *  coloured by a look, because a column holds one per layer. */
const WHITE = { bright: 3, dim: 1 };

// Palette anchors (APC40 mk2 shares the Launchpad-style 128 palette):
// {rgb → bright index, dim index}
const PALETTE: { r: number; g: number; b: number; bright: number; dim: number }[] = [
  { r: 255, g: 0, b: 0, bright: 5, dim: 7 },
  { r: 255, g: 127, b: 0, bright: 9, dim: 11 },
  { r: 255, g: 255, b: 0, bright: 13, dim: 15 },
  { r: 127, g: 255, b: 0, bright: 17, dim: 19 },
  { r: 0, g: 255, b: 0, bright: 21, dim: 23 },
  { r: 0, g: 255, b: 127, bright: 25, dim: 27 },
  { r: 0, g: 255, b: 255, bright: 37, dim: 39 },
  { r: 0, g: 127, b: 255, bright: 41, dim: 43 },
  { r: 0, g: 0, b: 255, bright: 45, dim: 47 },
  { r: 127, g: 0, b: 255, bright: 49, dim: 51 },
  { r: 255, g: 0, b: 255, bright: 53, dim: 55 },
  { r: 255, g: 0, b: 127, bright: 57, dim: 59 },
  { r: 255, g: 255, b: 255, bright: 3, dim: 1 },
];

export function nearest(hex: string): { bright: number; dim: number } {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  // low-chroma greys read best as white on the pads
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max - min < 40) return { bright: 3, dim: 1 };
  let best = PALETTE[0];
  let bd = Infinity;
  for (const p of PALETTE) {
    const d = (r - p.r) ** 2 + (g - p.g) ** 2 + (b - p.b) ** 2;
    if (d < bd) {
      bd = d;
      best = p;
    }
  }
  return best;
}

/** One button's ADDRESS as a single map key. The APC40's eight CLIP STOP
 *  buttons all carry note 52 and differ only by channel, so the note alone
 *  stopped being an identity the moment that row was lit. Mirrors the
 *  `(u8, u8)` key in core/src/apc.rs. */
export const ledKey = (channel: number, note: number): number => channel * 128 + note;
export const ledChannel = (key: number): number => Math.floor(key / 128);
export const ledNote = (key: number): number => key % 128;

/** Every (channel, note) the attach has to blank, so that nothing the map can
 *  light is left burning after LIGHT quits. The ranges are channel 0 — a
 *  velocity-0 note clears a pad whatever channel lit it — plus the column row,
 *  whose channel IS its address and which no channel-0 message would reach.
 *  Mirror of `clear_addresses` in core/src/apc.rs. */
export function clearAddresses(s: Surface): [number, number][] {
  const out: [number, number][] = [];
  for (const [from, to] of s.clear) for (let n = from; n <= to; n++) out.push([0, n]);
  if (s.columnRow) for (const ch of s.columnRow.channels) out.push([ch, s.columnRow.note]);
  return out;
}

/** (channel, note) → [channel, velocity]; everything not present = off.
 *
 *  The KEY is the button's address; the VALUE still carries the channel the
 *  message goes out on, and the two are not always the same number. On the mini
 *  the channel is the BRIGHTNESS, so one button changes channel while staying
 *  one button — folding that into the key would turn every brightness change
 *  into an off on the old channel and an on on the new one. On the APC40's
 *  CLIP STOP row the channel is the TRACK, so there the address and the send
 *  channel are the same thing.
 *
 *  Mirror of `compute_leds` in core/src/apc.rs. */
export function computeLeds(project: Project, snap: Snapshot | null, s: Surface): Map<number, [number, number]> {
  const leds = new Map<number, [number, number]>();
  const visual = [...project.layers].reverse();
  const liveOf = (id: string) => snap?.layers.find((l) => l.id === id);

  visual.slice(0, APC_LAYER_ROWS).forEach((layer, row) => {
    const base = s.layerBase - row * 8;
    const live = liveOf(layer.id);
    for (let col = 0; col < Math.min(APC_COLS, project.columns.length); col++) {
      const lookId = layer.cells[col];
      if (!lookId) continue;
      const look = project.looks[lookId];
      if (!look) continue;
      const pal = nearest(lookSwatch(look, project.looks)[0] ?? '#666666');
      const active = live?.lookId === lookId && live?.col === col;
      // The pad can hold a look the layer is NOT playing while still being the
      // live column — a library drag onto a live pad, where the engine keeps
      // playing what it captured at trigger time. Dim would report "idle" on a
      // layer that is lighting the rig, and a fixed "stale" colour collides
      // with any look that happens to use it (white looks land on the same
      // index — a Rust test pins this). So the surface reports the STAGE:
      // bright, in the colour of whatever is actually playing. The screen
      // carries the nuance that the pad holds something else.
      const stalePlaying =
        !active && live?.col === col && live?.lookId
          ? project.looks[live.lookId] ?? null
          : null;
      leds.set(
        ledKey(0, base + col),
        stalePlaying
          ? pad(s, nearest(lookSwatch(stalePlaying, project.looks)[0] ?? '#666666'), true)
          : pad(s, pal, active),
      );
    }
    // layer button (single-colour): on when the layer has something to clear
    if (live?.lookId) leds.set(ledKey(0, s.sceneBase + row), [0, 1]);
  });

  // The column row, where the surface has one. A column button fires every
  // layer at once, so it reports the same thing back: it is bright while every
  // layer holding something there is actually playing it — the whole column up,
  // which is exactly what pressing it does. Change one pad afterwards and it
  // drops, which is true: the column is no longer what is on stage.
  //
  // One rule, two encodings, as everywhere else on these surfaces. The mini's
  // column row is eight RGB PADS, so it can say both halves: dim while the
  // column merely holds something, bright while it is up — white rather than a
  // look colour, because a column holds one look per layer. The APC40's CLIP
  // STOP row is eight SINGLE-COLOUR buttons (0 off / 1 on / 2 blink), so it
  // says the half that matters with the house lights down: lit while the column
  // is on stage. The grid above it already shows which columns hold content,
  // and a blink means "armed" on this surface — blackout owns that.
  if (s.columnBase !== undefined || s.columnRow) {
    for (let col = 0; col < Math.min(APC_COLS, project.columns.length); col++) {
      const holders = project.layers.filter((l) => l.cells[col]);
      if (holders.length === 0) continue;
      const allUp = holders.every((l) => {
        const live = liveOf(l.id);
        return live?.col === col && live?.lookId === l.cells[col];
      });
      if (s.columnRow) {
        const ch = s.columnRow.channels[col];
        if (ch !== undefined && allUp) leds.set(ledKey(ch, s.columnRow.note), [ch, 1]);
      } else if (s.columnBase !== undefined) {
        leds.set(ledKey(0, s.columnBase + col), pad(s, WHITE, allUp));
      }
    }
  }

  // stop-all-clips = blackout: blink while armed
  if (snap?.blackout) leds.set(ledKey(0, s.blackout), [0, 2]);

  // Tap pulses on the beat rather than using the hardware blink, which runs at
  // its own fixed rate and would sit there contradicting the tempo. A quarter
  // of a beat is longer than the 66 ms update period at any tempo a rig runs
  // at, so no beat is skipped.
  const beat = snap?.beat ?? 0;
  if (beat - Math.floor(beat) < 0.25) leds.set(ledKey(0, s.tap), [0, 1]);

  return leds;
}

