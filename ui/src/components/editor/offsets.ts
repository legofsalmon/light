// The four per-look offset dials, without the screen (design A41, #44).
//
// What each dial is called, the span it rides over, how it reads, which of a
// look's addresses it reaches and the value it drives each of them at. All of
// it pure, so the arithmetic that ends up on the rig is testable on its own —
// the component beside this one is only the row of faders.
//
// A dial offsets what the look ACTUALLY CARRIES. Riding a soft dimmer onto a
// part that deliberately left dimmer alone would not be an offset: it would
// newly block the layers below it, which is a different look rather than a
// nudged one. So a look with nothing to offset greys its dial and says why.

import type { Look, Project, SoftField } from '../../../../shared/types.ts';
import { clamp } from '../../../../shared/types.ts';
import { groupCaps } from './groups.ts';

export type OffsetDial = 'hue' | 'dimmer' | 'pan' | 'size';
export type LookOffsets = Record<OffsetDial, number>;

/** Where each dial does nothing — a hue turned by zero, a level times one. */
export const OFFSET_NEUTRAL: LookOffsets = { hue: 0, dimmer: 1, pan: 0, size: 1 };

/** One soft address a dial rides, and the stored value it rides from. */
export type OffsetAddress = { partId: string; effectId?: string; field: SoftField; base: number };

export type OffsetSpec = {
  dial: OffsetDial;
  label: string;
  min: number;
  max: number;
  /** the reading, under the one number rule: `+30°`, `0.50×`, `+12 %` */
  fmt: (v: number) => string;
  /** the stored value, offset by the dial's position */
  at: (base: number, v: number) => number;
  help: string;
  /** the help when the look carries nothing this dial can reach */
  empty: string;
};

const RIDES = 'It drives the rig live, like any nudge: Keep writes it into the look, Discard drops it';

export const OFFSET_DIALS: readonly OffsetSpec[] = [
  {
    dial: 'hue', label: 'hue', min: -180, max: 180,
    fmt: (v) => `${v > 0 ? '+' : ''}${Math.round(v)}°`,
    // the wheel comes round: a hue is an angle, and the engine's own door
    // clamps 0..360 rather than wrapping, so the wrap happens here
    at: (base, v) => (((base + v) % 360) + 360) % 360,
    help: `turn the colour of every part that sets one, round the wheel and back. ${RIDES}`,
    empty: 'hue — nothing in this look sets a colour, so there is none to turn',
  },
  {
    dial: 'dimmer', label: 'dimmer', min: 0, max: 2,
    fmt: (v) => `${v.toFixed(2)}×`,
    at: (base, v) => clamp(base * v),
    help: `scale the brightness of every part that sets one — half at 0.50×, as stored at 1.00×. ${RIDES}`,
    empty: 'dimmer — nothing in this look sets a brightness, so there is none to scale',
  },
  {
    dial: 'pan', label: 'pan', min: -0.5, max: 0.5,
    fmt: (v) => `${v > 0 ? '+' : ''}${Math.round(v * 100)}\u2009%`,
    at: (base, v) => clamp(base + v),
    help: `swing every head this look aims, left or right of where it aims them. ${RIDES}`,
    empty: 'pan — nothing in this look aims a head, so there is nothing to swing',
  },
  {
    dial: 'size', label: 'size', min: 0, max: 2,
    fmt: (v) => `${v.toFixed(2)}×`,
    at: (base, v) => clamp(base * v),
    help: `scale how far every effect in this look swings — flat at 0.00×, as stored at 1.00×. ${RIDES}`,
    empty: 'size — this look has no effects, so there is no swing to scale',
  },
];

/** Which addresses each dial rides, with the stored value each starts from.
 *
 *  A part is reached only where it carries the thing being offset AND its
 *  group can take it: a colour stored on a group with no colour emitter is a
 *  value that never reaches a lamp, and riding it would count as held while
 *  changing nothing in the room. */
export function offsetTakers(project: Project, look: Look): Record<OffsetDial, OffsetAddress[]> {
  const out: Record<OffsetDial, OffsetAddress[]> = { hue: [], dimmer: [], pan: [], size: [] };
  if (look.steps?.length) return out; // a steps look has no parts of its own
  for (const part of look.parts) {
    const caps = groupCaps(project, part.groupId);
    const colour = caps.kinds.has('rgb') || caps.kinds.has('derby') || caps.kinds.has('mover');
    const lit = caps.kinds.size > 0 && !(caps.kinds.size === 1 && caps.kinds.has('hazer'));
    const p = part.params;
    if (colour && p.color) out.hue.push({ partId: part.id, field: 'hue', base: p.color.h });
    if (lit && p.dimmer !== undefined) out.dimmer.push({ partId: part.id, field: 'dimmer', base: p.dimmer });
    if (caps.canAim && p.pan !== undefined) out.pan.push({ partId: part.id, field: 'pan', base: p.pan });
    for (const fx of part.effects) {
      out.size.push({ partId: part.id, effectId: fx.id, field: 'size', base: fx.size });
    }
  }
  return out;
}
