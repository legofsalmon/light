import type { MotorMode } from './types.ts';
import { clamp } from './types.ts';
import { derbyQuantize, rgbToHsv } from './color.ts';

export type HeadKind = 'rgb' | 'derby' | 'hazer' | 'dimmer' | 'mover';

export type HeadDef = {
  label: string;
  kind: HeadKind;
  /** metres along the fixture's local X axis (for multi-head bars) */
  offset: number;
};

/** Fully-resolved per-head parameters after the layer merge — profile input.
 *  Colour is RGB here so crossfades behave exactly like the wire channels. */
export type ResolvedParams = {
  dimmer: number;
  r: number;
  g: number;
  b: number;
  white: number;
  ringFx: number;
  strobe: number;
  motorMode: MotorMode;
  motorValue: number;
  macro: number | null;
  pan: number;
  tilt: number;
  haze: number;
  fan: number;
};

export function defaultResolved(): ResolvedParams {
  return {
    dimmer: 0, r: 1, g: 1, b: 1, white: 0, ringFx: 0, strobe: 0,
    motorMode: 'off', motorValue: 0, macro: null, pan: 0.5, tilt: 0.5,
    haze: 0, fan: 0,
  };
}

export type Profile = {
  id: string;
  manufacturer: string;
  model: string;
  mode: string;
  channels: number;
  heads: HeadDef[];
  channelNames: string[];
  beamDeg: number;
  render: (heads: ResolvedParams[], buf: Uint8Array, base: number) => void;
};

const b255 = (v: number) => Math.round(clamp(v) * 255);
const strobeByte = (s: number) => (s <= 0.01 ? 0 : 6 + Math.round(clamp(s) * 249));

// ---------------------------------------------------------------------------
// Varytec LED Derby ST — 4CH mode
// CH1 colour macro (17 bands, no RGB mix) / CH2 strobe (0-5 open, 6-255 rate)
// CH3 motor (0 off, 1-127 static aim, 128-255 rotate) / CH4 white LED ring
// (0-9 off, 10-179 strobe patterns 1-17, 180-255 full-on blinder).
// ---------------------------------------------------------------------------
const derbySt4ch: Profile = {
  id: 'varytec-derby-st-4ch',
  manufacturer: 'Varytec',
  model: 'LED Derby ST',
  mode: '4 Channel',
  channels: 4,
  heads: [{ label: 'Derby', kind: 'derby', offset: 0 }],
  channelNames: ['Colour macro', 'Strobe', 'Motor', 'White ring'],
  beamDeg: 5,
  render(heads, buf, base) {
    const p = heads[0];
    const lit = p.dimmer > 0.02;
    if (!lit) buf[base] = 0;
    else if (p.macro !== null) buf[base] = Math.max(0, Math.min(255, Math.round(p.macro)));
    else {
      const [h, s] = rgbToHsv(p.r, p.g, p.b);
      buf[base] = derbyQuantize(h, s).value;
    }
    buf[base + 1] = strobeByte(p.strobe);
    buf[base + 2] =
      p.motorMode === 'off' ? 0 :
      p.motorMode === 'aim' ? 1 + Math.round(clamp(p.motorValue) * 126) :
      128 + Math.round(clamp(p.motorValue) * 127);
    buf[base + 3] = p.white >= 0.5 ? 220 : p.ringFx > 0.01 ? 10 + Math.round(clamp(p.ringFx) * 169) : 0;
  },
};

// ---------------------------------------------------------------------------
// KAM Power Partybar WFS (KML305) — 20CH mode: 4 pars × R/G/B/Dimmer/Flash.
// ---------------------------------------------------------------------------
const partybar20ch: Profile = {
  id: 'kam-partybar-wfs-20ch',
  manufacturer: 'KAM',
  model: 'Power Partybar WFS',
  mode: '20 Channel',
  channels: 20,
  heads: [
    { label: 'Par 1', kind: 'rgb', offset: -0.39 },
    { label: 'Par 2', kind: 'rgb', offset: -0.13 },
    { label: 'Par 3', kind: 'rgb', offset: 0.13 },
    { label: 'Par 4', kind: 'rgb', offset: 0.39 },
  ],
  channelNames: Array.from({ length: 4 }, (_, i) => [
    `Par ${i + 1} Red`, `Par ${i + 1} Green`, `Par ${i + 1} Blue`, `Par ${i + 1} Dimmer`, `Par ${i + 1} Flash`,
  ]).flat(),
  beamDeg: 15,
  render(heads, buf, base) {
    for (let i = 0; i < 4; i++) {
      const p = heads[i];
      const o = base + i * 5;
      buf[o] = b255(p.r);
      buf[o + 1] = b255(p.g);
      buf[o + 2] = b255(p.b);
      buf[o + 3] = b255(p.dimmer);
      buf[o + 4] = strobeByte(p.strobe);
    }
  },
};

// ---------------------------------------------------------------------------
// Generic hazer, 2CH (output / fan).
// ---------------------------------------------------------------------------
const hazer2ch: Profile = {
  id: 'generic-hazer-2ch',
  manufacturer: 'Generic',
  model: 'Hazer',
  mode: '2 Channel',
  channels: 2,
  heads: [{ label: 'Hazer', kind: 'hazer', offset: 0 }],
  channelNames: ['Haze output', 'Fan speed'],
  beamDeg: 0,
  render(heads, buf, base) {
    buf[base] = b255(heads[0].haze);
    buf[base + 1] = b255(heads[0].fan);
  },
};

// ---------------------------------------------------------------------------
// Generics for growth.
// ---------------------------------------------------------------------------
const dimmer1ch: Profile = {
  id: 'generic-dimmer-1ch',
  manufacturer: 'Generic',
  model: 'Dimmer',
  mode: '1 Channel',
  channels: 1,
  heads: [{ label: 'Dim', kind: 'dimmer', offset: 0 }],
  channelNames: ['Dimmer'],
  beamDeg: 25,
  render(heads, buf, base) {
    buf[base] = b255(heads[0].dimmer);
  },
};

const rgbPar3ch: Profile = {
  id: 'generic-rgb-par-3ch',
  manufacturer: 'Generic',
  model: 'RGB Par',
  mode: '3 Channel',
  channels: 3,
  heads: [{ label: 'Par', kind: 'rgb', offset: 0 }],
  channelNames: ['Red', 'Green', 'Blue'],
  beamDeg: 20,
  render(heads, buf, base) {
    const p = heads[0];
    buf[base] = b255(p.r * p.dimmer);
    buf[base + 1] = b255(p.g * p.dimmer);
    buf[base + 2] = b255(p.b * p.dimmer);
  },
};

const rgbwPar4ch: Profile = {
  id: 'generic-rgbw-par-4ch',
  manufacturer: 'Generic',
  model: 'RGBW Par',
  mode: '4 Channel',
  channels: 4,
  heads: [{ label: 'Par', kind: 'rgb', offset: 0 }],
  channelNames: ['Red', 'Green', 'Blue', 'White'],
  beamDeg: 20,
  render(heads, buf, base) {
    const p = heads[0];
    buf[base] = b255(p.r * p.dimmer);
    buf[base + 1] = b255(p.g * p.dimmer);
    buf[base + 2] = b255(p.b * p.dimmer);
    buf[base + 3] = b255(p.white * p.dimmer);
  },
};

const mover10ch: Profile = {
  id: 'generic-mover-10ch',
  manufacturer: 'Generic',
  model: 'Moving Head RGBW',
  mode: '10 Channel',
  channels: 10,
  heads: [{ label: 'Head', kind: 'mover', offset: 0 }],
  channelNames: ['Pan', 'Pan fine', 'Tilt', 'Tilt fine', 'Dimmer', 'Strobe', 'Red', 'Green', 'Blue', 'White'],
  beamDeg: 12,
  render(heads, buf, base) {
    const p = heads[0];
    const pan16 = Math.round(clamp(p.pan) * 65535);
    const tilt16 = Math.round(clamp(p.tilt) * 65535);
    buf[base] = pan16 >> 8;
    buf[base + 1] = pan16 & 0xff;
    buf[base + 2] = tilt16 >> 8;
    buf[base + 3] = tilt16 & 0xff;
    buf[base + 4] = b255(p.dimmer);
    buf[base + 5] = strobeByte(p.strobe);
    buf[base + 6] = b255(p.r);
    buf[base + 7] = b255(p.g);
    buf[base + 8] = b255(p.b);
    buf[base + 9] = b255(p.white);
  },
};

export const PROFILES: Record<string, Profile> = Object.fromEntries(
  [derbySt4ch, partybar20ch, hazer2ch, dimmer1ch, rgbPar3ch, rgbwPar4ch, mover10ch].map((p) => [p.id, p])
);

export const PROFILE_LIST: Profile[] = Object.values(PROFILES);
