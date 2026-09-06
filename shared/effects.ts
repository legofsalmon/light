import type { Effect, PartParams, SoftField, Wave, ShapeKind } from './types.ts';
import type { GroupExtents, HeadGeom } from './geometry.ts';
import { clamp } from './types.ts';

/** Deterministic 0..1 hash for sample-and-hold randomness. */
function hash01(a: number, b: number): number {
  let h = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Where on a figure phase p lands, as offsets in -1..1 on each axis.
 *
 *  Pure, and written in the same operations in the same order as shape_at in
 *  core/src/effects.rs — the two engines have to land on the same f64. That is
 *  already true of the sine wave above, which has been parity-pinned for
 *  months on exactly this arrangement; trig is not required by IEEE-754 to be
 *  correctly rounded, so identical source is the guarantee, not identical
 *  results in principle.
 *
 *  The caller scales, rotates and offsets. This is only the figure. */
export function shapeAt(kind: ShapeKind, phase: number, ccw: boolean): { x: number; y: number } {
  const w = ((phase % 1) + 1) % 1;
  const p = ccw ? 1 - w : w;
  const t = p * Math.PI * 2;
  switch (kind) {
    case 'figure8':
      // Gerono's lemniscate on its side: crosses itself at the centre, which
      // is what makes it read as a figure-8 rather than as a wobble.
      return { x: Math.sin(t), y: Math.sin(t * 2) };
    case 'square': {
      // Perimeter walk, a quarter of the phase per side. Corners are the
      // point: a head visibly stops turning one way and starts the other.
      const q = p * 4;
      const side = Math.min(3, Math.floor(q));
      const f = q - side;
      if (side === 0) return { x: -1 + 2 * f, y: -1 };
      if (side === 1) return { x: 1, y: -1 + 2 * f };
      if (side === 2) return { x: 1 - 2 * f, y: 1 };
      return { x: -1, y: 1 - 2 * f };
    }
    default:
      return { x: Math.cos(t), y: Math.sin(t) };
  }
}

/** Pan and tilt amplitudes for a shape, from its size and aspect.
 *
 *  Aspect 0.5 gives both the full size; 0 is all pan and 1 is all tilt, so the
 *  same knob covers a circle, an ellipse, a flat sweep and a vertical bounce.
 *  Half-amplitude each way, matching the plain pan and tilt targets: a
 *  full-size figure spans the whole of the head's travel and no more. */
export function shapeAmps(size: number, aspect: number): { pan: number; tilt: number } {
  return {
    pan: size * Math.min(1, 2 * (1 - aspect)) * 0.5,
    tilt: size * Math.min(1, 2 * aspect) * 0.5,
  };
}

/** Waveform value 0..1 at phase (wraps), for one head. */
export function waveValue(e: Effect, phase: number, headIdx: number): number {
  const p = ((phase % 1) + 1) % 1;
  switch (e.wave) {
    case 'sine':
      return 0.5 - 0.5 * Math.cos(p * Math.PI * 2);
    case 'triangle':
      return p < 0.5 ? p * 2 : 2 - p * 2;
    case 'sawUp':
      return p;
    case 'sawDown':
      return 1 - p;
    case 'square':
      return p < Math.max(0.02, e.width) ? 1 : 0;
    case 'chase':
      return p < Math.max(0.02, e.width) ? 1 : 0;
    case 'random':
      // clamped for the same wrap-vs-saturate reason as modWave
      return hash01(clamp(Math.floor(phase), -2147483648, 2147483647), headIdx * 7919 + 13);
    default:
      return 0;
  }
}

/** Modulator wave value 0..1 (P2): a pure function of phase — no state, so
 *  it is byte-identical across engines by construction. Square/chase run at a
 *  fixed 0.5 width; random is sample-and-hold keyed by the modulator's index.
 *  Mirrors mod_wave in core/src/effects.rs. */
export function modWave(wave: Wave, phase: number, seedIdx: number): number {
  const p = ((phase % 1) + 1) % 1;
  switch (wave) {
    case 'sine':
      return 0.5 - 0.5 * Math.cos(p * Math.PI * 2);
    case 'triangle':
      return p < 0.5 ? p * 2 : 2 - p * 2;
    case 'sawUp':
      return p;
    case 'sawDown':
      return 1 - p;
    case 'square':
    case 'chase':
      return p < 0.5 ? 1 : 0;
    case 'random':
      // clamp before the 32-bit hash: JS ToInt32 wraps where Rust's cast
      // saturates, so beyond ±2^31 the engines would hash different keys
      return hash01(clamp(Math.floor(phase), -2147483648, 2147483647), seedIdx * 7919 + 13);
    default:
      return 0;
  }
}

/** The neutral a modulator offset rides on when the look never set the part
 *  field — the same defaults the soft layer and effects use. Effect fields
 *  never need this: an effect always carries its knobs.
 *  Mirrors soft_base in core/src/effects.rs. */
export function softBase(params: PartParams, field: SoftField): number {
  switch (field) {
    case 'dimmer':
      return params.dimmer ?? 1;
    case 'hue':
      return params.color?.h ?? 0;
    case 'sat':
      return params.color?.s ?? 1;
    case 'pan':
      return params.pan ?? 0.5;
    case 'tilt':
      return params.tilt ?? 0.5;
    case 'zoom':
      return params.zoom ?? 0.5;
    case 'focus':
      return params.focus ?? 0.5;
    case 'iris':
      return params.iris ?? 0.5;
    case 'frost':
      return params.frost ?? 0.5;
    case 'cto':
      return params.cto ?? 0.5;
    case 'goboRotate':
      return params.goboRotate ?? 0.5;
    case 'prismRotate':
      return params.prismRotate ?? 0.5;
    case 'white':
      return params.white ?? 0;
    case 'ringFx':
      return params.ringFx ?? 0;
    case 'strobe':
      return params.strobe ?? 0;
    case 'motorValue':
      return params.motorValue ?? 0;
    case 'haze':
      return params.haze ?? 0;
    case 'fan':
      return params.fan ?? 0;
    default:
      return 0; // effect-only fields never reach here
  }
}

/** Waves whose value is centred (0.5 = rest) when applied to hue/pan/tilt. */
function isCentred(e: Effect): boolean {
  return e.wave === 'sine' || e.wave === 'triangle' || e.wave === 'square' || e.wave === 'random';
}

/** 0..1 normalisation with a degenerate-extent guard: a single head (or a
 *  perfectly stacked group) has no sweep axis, so everything lands in phase. */
function norm(v: number, lo: number, hi: number): number {
  return hi - lo > 1e-9 ? (v - lo) / (hi - lo) : 0;
}

/**
 * Fan position 0..1 for one head under an effect's spatial config (A1), plus
 * whether the head sits on the mirrored half (pan counter-rotates there).
 * Pipeline: basis (+reverse) → buddy clump → fold → parts tile. Only called on
 * the general path — the all-defaults fan is the verbatim legacy expression in
 * applyEffects, gated by the golden byte suites.
 */
function fanPos(
  e: Effect,
  j: number,
  n: number,
  g: HeadGeom,
  ext: GroupExtents
): { t: number; mirrored: boolean } {
  let t: number;
  switch (e.distribute) {
    case 'x':
      t = norm(g.x, ext.minX, ext.maxX);
      break;
    case 'y':
      t = norm(g.y, ext.minY, ext.maxY);
      break;
    case 'z':
      t = norm(g.z, ext.minZ, ext.maxZ);
      break;
    case 'radial': {
      const dx = g.x - ext.cx, dy = g.y - ext.cy, dz = g.z - ext.cz;
      t = ext.maxR > 1e-9 ? Math.sqrt(dx * dx + dy * dy + dz * dz) / ext.maxR : 0;
      break;
    }
    case 'shuffle':
      // seeded, reproducible scatter — the same bit-exact hash the random
      // wave uses, so busking-safe randomness you can get back
      t = hash01(j, e.seed);
      break;
    case 'row':
      // normalized within the head's OWN fixture: every fixture of a type
      // runs the same pixel wave — "grab one strobe, every strobe is the same"
      t = g.rowT;
      break;
    case 'col':
      t = g.colT;
      break;
    default:
      t = n > 1 ? j / n : 0; // index
  }
  if (e.reverse) {
    // index keeps its grid spacing ((n−1−j)/n); continuous bases just flip
    t = e.distribute === 'index' ? (n > 1 ? (n - 1 - j) / n : 0) : 1 - t;
  }
  if (e.buddy > 1 && n > 1) {
    // clump adjacent-in-fan heads onto ceil(n/buddy) equal steps
    const m = Math.ceil(n / e.buddy);
    t = Math.min(Math.floor(t * m), m - 1) / m;
  }
  // >= so an even buddy grid (which lands a clump exactly on 0.5) splits into
  // two whole wings — with strict > that clump joined the near wing and its
  // pan failed to counter-rotate
  const mirrored = e.fold === 'mirror' && t >= 0.5;
  if (e.fold === 'mirror') t = t <= 0.5 ? 2 * t : 2 * (1 - t);
  else if (e.fold === 'centre') t = Math.abs(2 * t - 1);
  // tile k repeats across the group — phase is circular, so the mod is safe
  if (e.parts > 1) t = (t * e.parts) % 1;
  // A chase deals n distinct slots. The spatial bases (and folds) are
  // INCLUSIVE — the far head sits at exactly t = 1, which under chase's forced
  // full spread wraps onto the near head and locks the two ends together with
  // no operator escape. Compress the finished fan to the index-style exclusive
  // span instead; linear, so slots stay evenly spaced.
  if (e.wave === 'chase' && n > 1) t = t * ((n - 1) / n);
  return { t, mirrored };
}

/** Wet/dry blend of one target. At mix 1 this returns `wet` verbatim (byte-for-
 *  byte the pre-mix behaviour); below 1 it eases back toward the dry value the
 *  target held going into this effect. mix <= 0 is handled by skipping the whole
 *  effect, so the target keeps whatever it had — including staying undriven. */
function applyMix(dry: number, wet: number, mix: number): number {
  return mix >= 1 ? wet : dry + (wet - dry) * mix;
}

/**
 * Apply a part's effects to its resolved params for one head.
 * `beat` is the musical position (already includes the global speed master).
 * `phaseCorr[i]` is a per-effect phase offset that keeps the waveform
 * continuous when an effect's rate is changed on a live look (see the
 * renderer's rate-correction map). It is 0 for every effect of an untouched
 * show, so the output is byte-identical to passing nothing.
 *
 * (headIdx, headCount, g, ext) together are the HeadCtx — flattened into four
 * arguments so the hot loop allocates nothing: g is the renderer's cached
 * HeadGeom and ext the group's cached extents, both passed by reference. The
 * legacy fan (all A1 fields at defaults) runs the pre-A1 expression VERBATIM,
 * gated by the golden byte suites.
 */
export function applyEffects(
  params: PartParams,
  effects: Effect[],
  beat: number,
  phaseCorr: readonly number[],
  headIdx: number,
  headCount: number,
  g: HeadGeom,
  ext: GroupExtents
): PartParams {
  if (effects.length === 0) return params;
  const out: PartParams = { ...params, color: params.color ? { ...params.color } : undefined };
  for (let i = 0; i < effects.length; i++) {
    const e = effects[i];
    // bypass parks the effect entirely; mix 0 is fully dry — both leave every
    // target exactly as it was, including undriven ones (so a bypassed dimmer
    // effect does not force the group to full).
    if (e.bypass || e.mix <= 0 || e.size <= 0 || e.rate <= 0) continue;
    const mix = e.mix;
    const spread = e.wave === 'chase' ? 1 : e.spread;
    const corr = phaseCorr[i] ?? 0;
    const legacyFan =
      e.distribute === 'index' && e.fold === 'none' && !e.reverse && e.parts <= 1 && e.buddy <= 1;
    let mirrored = false;
    let phase: number;
    if (legacyFan) {
      // the pre-A1 expression, byte-for-byte
      phase = beat / e.rate + corr + e.phase + (headCount > 1 ? (headIdx / headCount) * spread : 0);
    } else {
      const f = fanPos(e, headIdx, headCount, g, ext);
      mirrored = f.mirrored;
      phase = beat / e.rate + corr + e.phase + f.t * spread;
    }
    const v = waveValue(e, phase, headIdx);
    switch (e.target) {
      case 'dimmer': {
        const base = out.dimmer ?? 1;
        out.dimmer = applyMix(base, clamp(base * (1 - e.size * (1 - v))), mix);
        break;
      }
      case 'hue': {
        if (!out.color) out.color = { h: 0, s: 1 };
        const delta = (isCentred(e) ? v - 0.5 : v) * e.size * 360 * mix;
        out.color.h = ((out.color.h + delta) % 360 + 360) % 360;
        break;
      }
      case 'white': {
        const dry = out.white ?? 0;
        out.white = applyMix(dry, clamp(Math.max(dry, v * e.size)), mix);
        break;
      }
      case 'strobe': {
        const dry = out.strobe ?? 0;
        out.strobe = applyMix(dry, clamp(Math.max(dry, v * e.size)), mix);
        break;
      }
      case 'pan': {
        const dry = out.pan ?? 0.5;
        // value-sign mirror: the mirrored half counter-rotates, so a folded
        // pan sweep opens and closes symmetrically instead of shearing
        const dir = mirrored ? -1 : 1;
        out.pan = applyMix(dry, clamp(dry + (v - 0.5) * e.size * dir), mix);
        break;
      }
      case 'tilt': {
        const dry = out.tilt ?? 0.5;
        out.tilt = applyMix(dry, clamp(dry + (v - 0.5) * e.size), mix);
        break;
      }
      // The one target that writes two parameters. `wave` and `width` say
      // nothing here — the figure IS the waveform — so the phase goes to the
      // shape directly rather than through waveValue.
      case 'shape': {
        const f = shapeAt(e.shape ?? 'circle', phase, e.shapeCcw === true);
        const rot = (e.shapeRotate ?? 0) * Math.PI * 2;
        const ca = Math.cos(rot);
        const sa = Math.sin(rot);
        const rx = f.x * ca - f.y * sa;
        const ry = f.x * sa + f.y * ca;
        const amp = shapeAmps(e.size, e.shapeAspect ?? 0.5);
        // the same value-sign mirror the plain pan target uses, so a folded
        // spread opens and closes instead of shearing
        const dir = mirrored ? -1 : 1;
        const dryPan = out.pan ?? 0.5;
        const dryTilt = out.tilt ?? 0.5;
        out.pan = applyMix(dryPan, clamp(dryPan + rx * amp.pan * dir), mix);
        out.tilt = applyMix(dryTilt, clamp(dryTilt + ry * amp.tilt), mix);
        break;
      }
      // Beam parameters swing about their set value, like pan and tilt. Adding
      // the effect at all is the operator saying they want this parameter
      // driven, so an unset one starts from the middle of its travel rather
      // than staying parked.
      case 'zoom':
      case 'focus':
      case 'iris':
      case 'frost':
      case 'cto':
      case 'goboRotate':
      case 'prismRotate': {
        const dry = out[e.target] ?? 0.5;
        out[e.target] = applyMix(dry, clamp(dry + (v - 0.5) * e.size), mix);
        break;
      }
    }
  }
  return out;
}
