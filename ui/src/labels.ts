// The words a person reads for values the engine stores as identifiers. The
// wire keeps `sawUp`; the screen says "ramp up". Retired desk words live in
// scripts/check-language.mjs, which fails the build if one comes back.
import type { EffectTarget, ShapeKind, SoftField, StagePropKind, Wave } from '../../shared/types.ts';

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

/** Everything a nudge or a control can move, by the name a person reads —
 *  the wire says `cto` and `goboRotate`; the screen says warmth and gobo spin. */
export const FIELD_LABEL: Record<SoftField, string> = {
  dimmer: 'dimmer',
  white: 'white',
  ringFx: 'ring fx',
  strobe: 'strobe',
  motorValue: 'motor',
  pan: 'pan',
  tilt: 'tilt',
  haze: 'haze',
  fan: 'haze fan',
  zoom: 'zoom',
  focus: 'focus',
  iris: 'beam size',
  frost: 'soften',
  cto: 'warmth',
  goboRotate: 'gobo spin',
  prismRotate: 'prism spin',
  flower: 'flower spin',
  hue: 'hue',
  sat: 'saturation',
  rate: 'rate',
  size: 'size',
  spread: 'spread',
  width: 'width',
  phase: 'phase',
  mix: 'mix',
};

/** The effect targets, likewise. */
export const TARGET_LABEL: Record<EffectTarget, string> = {
  dimmer: 'dimmer',
  hue: 'hue',
  white: 'white',
  strobe: 'strobe',
  pan: 'pan',
  tilt: 'tilt',
  zoom: 'zoom',
  focus: 'focus',
  iris: 'beam size',
  frost: 'soften',
  cto: 'warmth',
  goboRotate: 'gobo spin',
  prismRotate: 'prism spin',
  flower: 'flower spin',
  shape: 'shape',
};

/** The figures a shape effect traces, by the name a person would say. */
export const SHAPE_LABEL: Record<ShapeKind, string> = {
  circle: 'circle',
  figure8: 'figure of eight',
  square: 'square',
};
