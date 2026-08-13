import type { Effect, PartParams } from './types.ts';
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

/**
 * Apply a part's effects to its resolved params for one head.
 * `beat` is the musical position (already includes the global speed master).
 */
export function applyEffects(
  params: PartParams,
  effects: Effect[],
  beat: number,
  headIdx: number,
  headCount: number
): PartParams {
  if (effects.length === 0) return params;
  const out: PartParams = { ...params, color: params.color ? { ...params.color } : undefined };
  for (const e of effects) {
    if (e.size <= 0 || e.rate <= 0) continue;
    const spread = e.wave === 'chase' ? 1 : e.spread;
    const phase = beat / e.rate + e.phase + (headCount > 1 ? (headIdx / headCount) * spread : 0);
    const v = waveValue(e, phase, headIdx);
    switch (e.target) {
      case 'dimmer': {
        const base = out.dimmer ?? 1;
        out.dimmer = clamp(base * (1 - e.size * (1 - v)));
        break;
      }
      case 'hue': {
        if (!out.color) out.color = { h: 0, s: 1 };
        const delta = (isCentred(e) ? v - 0.5 : v) * e.size * 360;
        out.color.h = ((out.color.h + delta) % 360 + 360) % 360;
        break;
      }
      case 'white':
        out.white = clamp(Math.max(out.white ?? 0, v * e.size));
        break;
      case 'strobe':
        out.strobe = clamp(Math.max(out.strobe ?? 0, v * e.size));
        break;
      case 'pan':
        out.pan = clamp((out.pan ?? 0.5) + (v - 0.5) * e.size);
        break;
      case 'tilt':
        out.tilt = clamp((out.tilt ?? 0.5) + (v - 0.5) * e.size);
        break;
    }
  }
  return out;
}
