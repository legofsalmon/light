// The words a person reads for values the engine stores as identifiers. The
// wire keeps `sawUp`; the screen says "ramp up". Retired desk words live in
// scripts/check-language.mjs, which fails the build if one comes back.
import type {
  EffectTarget, MidiAction, MidiMapping, Project, ShapeKind, SoftField, StagePropKind, Wave,
} from '../../shared/types.ts';

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

/** The four families a look can drive, in the letters every desk prints them
 *  as — the library tile shows one per family the look actually enables, so
 *  "this one only moves heads" is readable without opening it. Computed from
 *  the look's own parts; nothing is tagged by hand. */
export type LookKind = 'I' | 'C' | 'P' | 'B';
export const LOOK_KINDS: readonly LookKind[] = ['I', 'C', 'P', 'B'];
export const KIND_LABEL: Record<LookKind, string> = {
  I: 'brightness',
  C: 'colour',
  P: 'position',
  B: 'beam',
};

/** What a MIDI mapping drives, in the app's words — `Layer 2 · pad 3`, not
 *  `cell layer-2 col 2`. The mapping table prints it and so does the line that
 *  confirms a learn, so the two can never disagree. */
export function describeMidiAction(p: Project, a: MidiAction): string {
  const layerName = (id: string) => p.layers.find((l) => l.id === id)?.name ?? '?';
  switch (a.kind) {
    case 'cell': {
      const layer = p.layers.find((l) => l.id === a.layerId);
      const lookId = layer?.cells[a.col];
      const look = lookId ? p.looks[lookId] : null;
      return `${layer?.name ?? '?'} · pad ${a.col + 1}${look ? ` (${look.name})` : ''}`;
    }
    case 'column':
      return `Column ${a.col + 1}`;
    case 'layerMaster':
      return `Layer master · ${layerName(a.layerId)}`;
    case 'layerClear':
      return `Clear layer · ${layerName(a.layerId)}`;
    case 'control':
      return `Dial · ${p.controls?.find((c) => c.id === a.controlId)?.name ?? a.controlId}`;
    case 'submaster':
      return `Group level · ${p.groups.find((g) => g.id === a.groupId)?.name ?? a.groupId}`;
    case 'grand':
      return 'Grand master';
    case 'speed':
      return 'Effect speed';
    case 'haze':
      return 'Haze output';
    case 'tap':
      return 'Tap tempo';
    case 'blackout':
      return 'Blackout';
    case 'deckNext':
      return 'Next song';
    case 'deckPrev':
      return 'Previous song';
  }
}

/** Where a mapping comes from, on the wire — `note 53`, or `CC 7 · ch 3` when
 *  the channel is the part that tells two controls apart. Channel 1 is the
 *  common case and is left off; the numbers a person reads are 1-based. */
export function describeMidiSource(m: Pick<MidiMapping, 'type' | 'number' | 'channel'>): string {
  return `${m.type === 'note' ? 'note' : 'CC'} ${m.number}${m.channel === 0 ? '' : ` · ch ${m.channel + 1}`}`;
}

/** The confirmation a learn earns: `note 53 → Layer 2 · pad 3` (design 2.10).
 *  "mapped ✓" said that something had happened, not what. */
export function describeLearned(p: Project, m: MidiMapping): string {
  return `${describeMidiSource(m)} → ${describeMidiAction(p, m.action)}`;
}
