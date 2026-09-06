// The words a person reads for values the engine stores as identifiers. The
// wire keeps `sawUp`; the screen says "ramp up". Retired desk words live in
// scripts/check-language.mjs, which fails the build if one comes back.
import type { StagePropKind, Wave } from '../../shared/types.ts';

export const WAVE_LABEL: Record<Wave, string> = {
  sine: 'sine',
  triangle: 'triangle',
  sawUp: 'ramp up',
  sawDown: 'ramp down',
  square: 'square',
  chase: 'chase',
  random: 'random',
};

/** The stage props by the name a person would say — the plan's remove dialog
 *  used to print the raw kind ("Remove this trussBar?"). */
export const PROP_LABEL: Record<StagePropKind, string> = {
  vocalist: 'vocalist',
  guitarist: 'guitarist',
  bassist: 'bassist',
  drummer: 'drummer',
  keyboardist: 'keyboardist',
  trussBar: 'truss bar',
  trussLeg: 'truss leg',
  riser: 'riser',
  screen: 'screen',
};
