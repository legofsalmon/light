// Where a moving head actually ends up: the look's request, through the
// fixture's calibration, onto its channels.
//
// A rig is not a diagram. Heads get hung backwards, upside down and on their
// sides, and one of them is always the one that sweeps the wrong way when
// every other head sweeps right. Before this the only cure was to re-focus
// that head and accept that every look moved it wrongly, or to fix it in the
// patch and watch the stage view disagree with the rig.
//
// The order is deliberate and both engines share it:
//
//   1. take the look's pan and tilt as DELTAS from centre — that is what they
//      already were, so a fixture with nothing calibrated is untouched;
//   2. swap them, if the head is on its side;
//   3. invert either, naming the FIXTURE's axis (so it reads the same whether
//      or not the swap happened);
//   4. add the base aim — the operator's focus, which never moves when the
//      calibration changes, because they set it by looking at the rig;
//   5. clamp into the soft limits.
//
// Inverting the DELTA rather than the result is the whole point: the head
// stays where it was focused and only the movement mirrors. It is the same
// trick the effect engine already plays on the mirrored half of a folded pan
// spread (shared/effects.ts).
//
// Mirrors core/src/aim.rs. The two must agree to the last bit.

import type { FixtureCal } from './types.ts';
import { clamp } from './types.ts';

/** Does this fixture need the aim pass at all? Centred base and no
 *  calibration is arithmetically identical to leaving it alone, and saying so
 *  keeps a 129-fixture rig off this path entirely. */
export function aimIsIdentity(basePan: number, baseTilt: number, cal: FixtureCal | undefined): boolean {
  if (basePan !== 0.5 || baseTilt !== 0.5) return false;
  if (!cal) return true;
  return (
    !cal.invertPan && !cal.invertTilt && !cal.swap &&
    (cal.panMin ?? 0) <= 0 && (cal.panMax ?? 1) >= 1 &&
    (cal.tiltMin ?? 0) <= 0 && (cal.tiltMax ?? 1) >= 1
  );
}

/** The resolved look values, mapped onto what this fixture's channels get. */
export function applyAim(
  pan: number,
  tilt: number,
  basePan: number,
  baseTilt: number,
  cal: FixtureCal | undefined,
): { pan: number; tilt: number } {
  let dp = pan - 0.5;
  let dt = tilt - 0.5;
  if (cal?.swap) {
    const t = dp;
    dp = dt;
    dt = t;
  }
  if (cal?.invertPan) dp = -dp;
  if (cal?.invertTilt) dt = -dt;
  // Limits are a fraction of travel and default to the whole of it. A pair
  // given the wrong way round would otherwise clamp everything to one value
  // and park the head; low wins, so a mistake reads as "stuck at the low
  // limit" rather than as a fixture that has died.
  const pLo = clamp(cal?.panMin ?? 0);
  const pHi = Math.max(pLo, clamp(cal?.panMax ?? 1));
  const tLo = clamp(cal?.tiltMin ?? 0);
  const tHi = Math.max(tLo, clamp(cal?.tiltMax ?? 1));
  return {
    pan: clamp(basePan + dp, pLo, pHi),
    tilt: clamp(baseTilt + dt, tLo, tHi),
  };
}
