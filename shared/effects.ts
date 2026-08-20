import type { Effect, PartParams } from './types.ts';
import type { HeadGeom } from './geometry.ts';
import { clamp } from './types.ts';

/** Deterministic 0..1 hash for sample-and-hold randomness. */
function hash01(a: number, b: number): number {
  let h = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
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
      return hash01(Math.floor(phase), headIdx * 7919 + 13);
    default:
      return 0;
  }
}

/** Waves whose value is centred (0.5 = rest) when applied to hue/pan/tilt. */
function isCentred(e: Effect): boolean {
  return e.wave === 'sine' || e.wave === 'triangle' || e.wave === 'square' || e.wave === 'random';
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
 * (headIdx, headCount, _g) together are the HeadCtx — flattened into three
 * arguments so the hot loop allocates nothing: _g is the renderer's cached
 * HeadGeom, passed by reference. Carried since B2, consumed from A1 (spatial
 * fan); until then it must not influence output, which the golden byte suites
 * gate.
 */
export function applyEffects(
  params: PartParams,
  effects: Effect[],
  beat: number,
  phaseCorr: readonly number[],
  headIdx: number,
  headCount: number,
  _g: HeadGeom
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
    const phase = beat / e.rate + corr + e.phase + (headCount > 1 ? (headIdx / headCount) * spread : 0);
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
        out.pan = applyMix(dry, clamp(dry + (v - 0.5) * e.size), mix);
        break;
      }
      case 'tilt': {
        const dry = out.tilt ?? 0.5;
        out.tilt = applyMix(dry, clamp(dry + (v - 0.5) * e.size), mix);
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
      case 'cto': {
        const dry = out[e.target] ?? 0.5;
        out[e.target] = applyMix(dry, clamp(dry + (v - 0.5) * e.size), mix);
        break;
      }
    }
  }
  return out;
}
