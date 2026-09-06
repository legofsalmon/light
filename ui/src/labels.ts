// The words a person reads for values the engine stores as identifiers. The
// wire keeps `sawUp`; the screen says "ramp up". Retired desk words live in
// scripts/check-language.mjs, which fails the build if one comes back.
import type { Wave } from '../../shared/types.ts';

export const WAVE_LABEL: Record<Wave, string> = {
  sine: 'sine',
  triangle: 'triangle',
  sawUp: 'ramp up',
  sawDown: 'ramp down',
  square: 'square',
  chase: 'chase',
  random: 'random',
};
