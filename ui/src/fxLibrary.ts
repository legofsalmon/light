// The factory effects catalogue (backlog #4).
//
// LIGHT composes effects rather than shipping them: any of the targets crossed
// with seven waves, then a spread pipeline on top. That is powerful and it is
// also a blank page — "+ effect" gives you a sine on dimmer at one bar, and
// everything interesting is several knobs away from there.
//
// So: named starting points, in the app rather than in a show, chosen because
// each one is a thing an operator would actually ask for by name. Applying one
// copies it into the part with a fresh id — exactly what the user-authored FX
// pool already does — so nothing here is live, nothing here can be edited by
// accident, and every knob stays where it was.
//
// SINGLE-EFFECT ONLY. A Fire is random dimmer plus a colour drift plus a white
// flicker, which is three effects and a schema change (FxPreset.effect ->
// effects[]) across both engines. That is its own piece of work; this is the
// half that needs no engine change at all.
//
// Authoring notes, because the maths decides what a preset can be:
//   dimmer   multiplies DOWN from whatever the look set — base * (1 - size *
//            (1 - wave)). It can never brighten past the look's own level.
//   hue      rotates. Sine, triangle, square and random swing either side of
//            the look's colour (+/- size * 180 degrees); ramps and chase run
//            one way round the wheel, so size 1 on a ramp is a full circle.
//   white    and strobe only ADD — max(look, wave * size) — so they lift a
//            parameter the look left alone and never cut one it set.
//   pan tilt and every beam parameter swing either side of the set value.
//   rate     is beats per cycle: 4 is one cycle a bar in 4/4, 0.25 is four a
//            beat. Never hertz, so the rig stays with the music.
//   chase    forces a full spread of its own; its width is how many heads are
//            lit at once.

import type { Effect, EffectTarget } from '../../shared/types.ts';

export type FxCategory = 'intensity' | 'colour' | 'movement' | 'beam' | 'strobe';

export const FX_CATEGORIES: { id: FxCategory; label: string }[] = [
  { id: 'intensity', label: 'Intensity' },
  { id: 'colour', label: 'Colour' },
  { id: 'movement', label: 'Movement' },
  { id: 'beam', label: 'Beam' },
  { id: 'strobe', label: 'Strobe and white' },
];

export type FxFactoryPreset = {
  /** stable across builds: it is what a test pins and what search matches */
  id: string;
  name: string;
  category: FxCategory;
  /** what it does and when to reach for it — one sentence, no jargon */
  description: string;
  /** everything but the id, which is minted per copy */
  effect: Omit<Effect, 'id'>;
};

/** The knobs every preset starts from: active, full wet, no spread pipeline.
 *  A preset states only what it changes, so reading one shows its idea. */
const BASE = {
  target: 'dimmer' as EffectTarget,
  wave: 'sine' as Effect['wave'],
  rate: 4,
  size: 1,
  spread: 0,
  width: 0.5,
  phase: 0,
  bypass: false,
  mix: 1,
  distribute: 'index' as Effect['distribute'],
  fold: 'none' as Effect['fold'],
  reverse: false,
  parts: 1,
  buddy: 1,
  seed: 0,
};

const fx = (over: Partial<Omit<Effect, 'id'>>): Omit<Effect, 'id'> => ({ ...BASE, ...over });

export const FX_LIBRARY: FxFactoryPreset[] = [
  // ---------------------------------------------------------------- intensity
  {
    id: 'pulse-bar',
    name: 'Pulse',
    category: 'intensity',
    description: 'One swell a bar, down to black and back. The one you reach for first.',
    effect: fx({ rate: 4 }),
  },
  {
    id: 'pulse-beat',
    name: 'Pulse on the beat',
    category: 'intensity',
    description: 'The same swell, once a beat. Fast enough to feel like the kick without being a strobe.',
    effect: fx({ rate: 1 }),
  },
  {
    id: 'pulse-half',
    name: 'Pulse (half bar)',
    category: 'intensity',
    description: 'Two swells a bar — the middle setting between the bar and the beat.',
    effect: fx({ rate: 2 }),
  },
  {
    id: 'breathe',
    name: 'Breathe',
    category: 'intensity',
    description: 'A slow two-bar rise and fall that never reaches black. For beds that should move without drawing the eye.',
    effect: fx({ rate: 8, size: 0.55 }),
  },
  {
    id: 'kick',
    name: 'Kick',
    category: 'intensity',
    description: 'Full on the beat, then a decay to black. Reads as a hit rather than a wave.',
    effect: fx({ wave: 'sawDown', rate: 1 }),
  },
  {
    id: 'kick-bar',
    name: 'Kick (bar)',
    category: 'intensity',
    description: 'One hit a bar with a long decay — the downbeat, left to fall away.',
    effect: fx({ wave: 'sawDown', rate: 4 }),
  },
  {
    id: 'build',
    name: 'Build',
    category: 'intensity',
    description: 'Two bars from black to full, then straight back. Put it under a riser and let the room do the rest.',
    effect: fx({ wave: 'sawUp', rate: 8 }),
  },
  {
    id: 'stutter',
    name: 'Stutter',
    category: 'intensity',
    description: 'Hard on and off twice a beat, even duty. Blunt on purpose.',
    effect: fx({ wave: 'square', rate: 0.5 }),
  },
  {
    id: 'gate',
    name: 'Gate',
    category: 'intensity',
    description: 'Four hard cuts a beat. The fastest thing here that is still counted rather than random.',
    effect: fx({ wave: 'square', rate: 0.25 }),
  },
  {
    id: 'flicker',
    name: 'Flicker',
    category: 'intensity',
    description: 'Sample-and-hold jitter around the look level. Reproducible from its seed, so it looks the same every night.',
    effect: fx({ wave: 'random', rate: 0.25, size: 0.45 }),
  },
  {
    id: 'chase-bar',
    name: 'Chase',
    category: 'intensity',
    description: 'One head at a time across the group, a lap a bar. Width sets how many are lit at once.',
    effect: fx({ wave: 'chase', rate: 4, width: 0.25 }),
  },
  {
    id: 'chase-fast',
    name: 'Chase (fast)',
    category: 'intensity',
    description: 'A lap every two beats, tighter. Wants a group with some heads in it.',
    effect: fx({ wave: 'chase', rate: 2, width: 0.2 }),
  },
  {
    id: 'chase-wide',
    name: 'Chase (soft)',
    category: 'intensity',
    description: 'Half the group lit at once, so it reads as a moving block rather than a single point.',
    effect: fx({ wave: 'chase', rate: 4, width: 0.5 }),
  },
  {
    id: 'sweep-across',
    name: 'Sweep across',
    category: 'intensity',
    description: 'A swell that crosses the rig left to right, spread by where each head actually stands.',
    effect: fx({ rate: 4, spread: 1, distribute: 'x' }),
  },
  {
    id: 'ripple-out',
    name: 'Ripple from the centre',
    category: 'intensity',
    description: 'The swell starts at the middle of the group and travels outward. Needs heads at different distances from the centre.',
    effect: fx({ rate: 4, spread: 1, distribute: 'radial' }),
  },
  {
    id: 'wings',
    name: 'Wings',
    category: 'intensity',
    description: 'Both ends together, sweeping in toward the middle. The symmetrical version of a sweep.',
    effect: fx({ rate: 4, spread: 1, distribute: 'x', fold: 'mirror' }),
  },
  {
    id: 'scatter',
    name: 'Scatter',
    category: 'intensity',
    description: 'Every head on its own part of the cycle, shuffled rather than in order. Re-roll the seed for a different arrangement.',
    effect: fx({ rate: 2, spread: 1, distribute: 'shuffle', seed: 7 }),
  },
  {
    id: 'two-arm',
    name: 'Two-arm chase',
    category: 'intensity',
    description: 'The chase tiled twice across the group, so two points run at once from opposite halves.',
    effect: fx({ wave: 'chase', rate: 4, width: 0.25, parts: 2 }),
  },
  {
    id: 'pairs',
    name: 'In pairs',
    category: 'intensity',
    description: 'Neighbouring heads share a phase and move as one, so a long bar reads as half as many, twice as big.',
    effect: fx({ rate: 2, spread: 1, buddy: 2 }),
  },
  {
    id: 'roll-up',
    name: 'Roll up the rig',
    category: 'intensity',
    description: 'The swell climbs from the lowest head to the highest. Only says anything on a rig hung at more than one height.',
    effect: fx({ rate: 4, spread: 1, distribute: 'y' }),
  },

  // ------------------------------------------------------------------- colour
  {
    id: 'rainbow',
    name: 'Rainbow',
    category: 'colour',
    description: 'The whole colour wheel every two bars, every head together.',
    effect: fx({ target: 'hue', wave: 'sawUp', rate: 8 }),
  },
  {
    id: 'rainbow-fast',
    name: 'Rainbow (fast)',
    category: 'colour',
    description: 'A full turn of the wheel every half bar. Loud, and it wants a fast track.',
    effect: fx({ target: 'hue', wave: 'sawUp', rate: 2 }),
  },
  {
    id: 'rainbow-across',
    name: 'Rainbow across',
    category: 'colour',
    description: 'The colour wheel laid along the rig, turning. The classic wide-stage look.',
    effect: fx({ target: 'hue', wave: 'sawUp', rate: 8, spread: 1, distribute: 'x' }),
  },
  {
    id: 'rainbow-radial',
    name: 'Rainbow from the centre',
    category: 'colour',
    description: 'Colour travelling outward from the middle of the group instead of along it.',
    effect: fx({ target: 'hue', wave: 'sawUp', rate: 8, spread: 1, distribute: 'radial' }),
  },
  {
    id: 'hue-drift',
    name: 'Colour drift',
    category: 'colour',
    description: 'A slow wander a few degrees either side of the look colour. Stops a long bed looking like a still photograph.',
    effect: fx({ target: 'hue', rate: 32, size: 0.12 }),
  },
  {
    id: 'hue-wobble',
    name: 'Colour wobble',
    category: 'colour',
    description: 'A wider swing either side of the look colour, once a bar — still recognisably the colour you chose.',
    effect: fx({ target: 'hue', rate: 4, size: 0.25 }),
  },
  {
    id: 'two-tone',
    name: 'Two-tone flip',
    category: 'colour',
    description: 'Hard alternation between two colours either side of the one the look set. Twice a bar.',
    effect: fx({ target: 'hue', wave: 'square', rate: 2, size: 0.33 }),
  },
  {
    id: 'colour-chase',
    name: 'Colour chase',
    category: 'colour',
    description: 'Colour running head to head instead of intensity — the group stays lit throughout.',
    effect: fx({ target: 'hue', wave: 'chase', rate: 4, width: 0.25 }),
  },

  // ----------------------------------------------------------------- movement
  {
    id: 'pan-sweep',
    name: 'Pan sweep',
    category: 'movement',
    description: 'A slow swing left and right around wherever the heads are aimed.',
    effect: fx({ target: 'pan', rate: 8, size: 0.6 }),
  },
  {
    id: 'pan-wings',
    name: 'Pan wings',
    category: 'movement',
    description: 'The two halves of the rig swing toward each other and apart. The mirrored half counter-rotates, so it opens and closes rather than shearing.',
    effect: fx({ target: 'pan', rate: 8, size: 0.6, spread: 1, distribute: 'x', fold: 'mirror' }),
  },
  {
    id: 'tilt-bounce',
    name: 'Tilt bounce',
    category: 'movement',
    description: 'Up and down once a bar around the aim. Smaller than it sounds — a little tilt goes a long way.',
    effect: fx({ target: 'tilt', rate: 4, size: 0.4 }),
  },
  {
    id: 'tilt-wave',
    name: 'Tilt wave',
    category: 'movement',
    description: 'The bounce spread along the rig, so the beams roll rather than move together.',
    effect: fx({ target: 'tilt', rate: 4, size: 0.4, spread: 1, distribute: 'x' }),
  },
  {
    id: 'slow-drift',
    name: 'Slow drift',
    category: 'movement',
    description: 'Eight bars to cross and come back, barely moving. For heads that should not sit perfectly still.',
    effect: fx({ target: 'pan', rate: 32, size: 0.25 }),
  },
  {
    id: 'pan-scatter',
    name: 'Pan scatter',
    category: 'movement',
    description: 'Every head somewhere different in the same swing, shuffled. Busy without being chaotic.',
    effect: fx({ target: 'pan', rate: 8, size: 0.5, spread: 1, distribute: 'shuffle', seed: 3 }),
  },

  // --------------------------------------------------------------------- beam
  {
    id: 'zoom-breathe',
    name: 'Zoom breathe',
    category: 'beam',
    description: 'The beam widens and narrows around whatever the look set. Two bars a cycle.',
    effect: fx({ target: 'zoom', rate: 8, size: 0.5 }),
  },
  {
    id: 'zoom-punch',
    name: 'Zoom punch',
    category: 'beam',
    description: 'Snap wide on the beat, then close back down. Reads as a hit from the beam rather than the dimmer.',
    effect: fx({ target: 'zoom', wave: 'sawDown', rate: 1, size: 0.6 }),
  },
  {
    id: 'beam-size-pulse',
    name: 'Beam size pulse',
    category: 'beam',
    description: 'Opens and closes the beam size around the set value, once a bar.',
    effect: fx({ target: 'iris', rate: 4, size: 0.5 }),
  },
  {
    id: 'soften-swell',
    name: 'Soften swell',
    category: 'beam',
    description: 'Drifts in and out of a soft edge over four bars. Hard beams to a wash and back.',
    effect: fx({ target: 'frost', rate: 16, size: 0.4 }),
  },
  {
    id: 'warmth-drift',
    name: 'Warmth drift',
    category: 'beam',
    description: 'A very slow wander of colour temperature. Almost invisible on its own, and it stops white looking flat.',
    effect: fx({ target: 'cto', rate: 32, size: 0.3 }),
  },
  {
    id: 'gobo-rock',
    name: 'Gobo rock',
    category: 'beam',
    description: 'Rocks the gobo rotation one way and back instead of spinning it. Wants a slot picked in the look first.',
    effect: fx({ target: 'goboRotate', rate: 8, size: 0.6 }),
  },
  {
    id: 'prism-rock',
    name: 'Prism rock',
    category: 'beam',
    description: 'The same, on the prism. Wants a prism slot picked in the look first.',
    effect: fx({ target: 'prismRotate', rate: 8, size: 0.6 }),
  },

  // ------------------------------------------------------------ strobe, white
  {
    id: 'strobe-stab',
    name: 'Strobe stab',
    category: 'strobe',
    description: 'Fast at the downbeat, slowing away across the bar. Only ever adds, so it cannot silence a look that set its own rate.',
    effect: fx({ target: 'strobe', wave: 'sawDown', rate: 4 }),
  },
  {
    id: 'strobe-random',
    name: 'Random strobe hits',
    category: 'strobe',
    description: 'Bursts landing on unpredictable beats, the same ones every night.',
    effect: fx({ target: 'strobe', wave: 'random', rate: 1, size: 0.8 }),
  },
  {
    id: 'strobe-chase',
    name: 'Strobe chase',
    category: 'strobe',
    description: 'The burst travels head to head rather than hitting the whole group.',
    effect: fx({ target: 'strobe', wave: 'chase', rate: 4, width: 0.2 }),
  },
  {
    id: 'white-flicker',
    name: 'White flicker',
    category: 'strobe',
    description: 'Jitter on the white emitter only, leaving the colour alone underneath.',
    effect: fx({ target: 'white', wave: 'random', rate: 0.5, size: 0.6 }),
  },
  {
    id: 'white-accent',
    name: 'White accent',
    category: 'strobe',
    description: 'A white hit every half bar that decays away. Lifts a coloured look without washing it out.',
    effect: fx({ target: 'white', wave: 'sawDown', rate: 2 }),
  },
];

/** Presets whose target this group cannot take, for the picker to flag. The
 *  set comes from the look editor, which already works it out for the target
 *  menu — one answer to "what can this group do", not two. */
export const unusable = (p: FxFactoryPreset, capable: ReadonlySet<EffectTarget>): boolean =>
  !capable.has(p.effect.target);

/** Free-text match over the name, the description and the category label —
 *  what an operator would type is as often "slow" or "beat" as "chase". */
export function fxSearch(list: FxFactoryPreset[], q: string): FxFactoryPreset[] {
  const t = q.trim().toLowerCase();
  if (!t) return list;
  const cat = new Map(FX_CATEGORIES.map((c) => [c.id, c.label.toLowerCase()]));
  return list.filter((p) =>
    `${p.name} ${p.description} ${cat.get(p.category) ?? ''} ${p.effect.wave} ${p.effect.target}`
      .toLowerCase()
      .includes(t),
  );
}
