// Shared data model for LIGHT — used by both the engine (Node) and the UI (browser).

export type Vec3 = { x: number; y: number; z: number };

export type UniverseCfg = {
  id: string;
  label: string;
  /** Art-Net 15-bit port-address exactly as it appears on the wire (0-based). */
  artnetUniverse: number;
  /** sACN universe, 1..63999. */
  sacnUniverse: number;
  artnet: boolean;
  sacn: boolean;
  /** null → broadcast 255.255.255.255 */
  unicast: string | null;
};

export type Fixture = {
  id: string;
  name: string;
  profileId: string;
  universeId: string;
  /** 1-based DMX start address */
  address: number;
  /** metres; x = stage left→right, y = up, z = toward audience */
  pos: Vec3;
  /** radians, yaw for previz aim */
  rotY: number;
  /** mounting tilt (pitch, radians) — composes on the kind's default aim */
  rotX?: number;
  /** mounting roll (radians) */
  rotZ?: number;
  /** Base aim for moving heads, 0..1 in the fixture's own pan/tilt range.
   *  This is FOCUS, not an override: a look's pan/tilt is applied as a delta
   *  from centre on top of it (resolved = base + (look - 0.5)), so a rig
   *  focused fixture-by-fixture keeps its focus while looks move around it.
   *  Absent = 0.5 = centre, which is exactly today's behaviour. */
  pan?: number;
  tilt?: number;
  /** How this head's own axes are wired and how far it may swing. Absent on
   *  every show written before it existed, and absent means "no calibration",
   *  which renders byte for byte as it always did. */
  cal?: FixtureCal;
  /** id of the stage structure this fixture is rigged on.
   *
   *  `pos` stays in ROOM coordinates — it is the one source of truth, so
   *  nothing migrates and the patch table never starts lying about where a
   *  fixture is. The offset along the bar is derived from the parent when it is
   *  wanted, not stored. Moving or rotating the parent rewrites the children's
   *  world positions, which is what "it moves with the truss" actually means. */
  parentId?: string;
};

/** Where a fixture sits on its parent: along the bar, across it, and above or
 *  below it — all in metres, in the parent's own rotated frame. Derived, never
 *  stored.
 *
 *  Canonical yaw convention (shared/geometry.ts, both 3D previzes, mvr.rs):
 *  the parent's local +X ("along") points at world (cos θ, 0, −sin θ). These
 *  two functions are exact inverses of each other under it. */
export function offsetOnParent(
  f: { pos: Vec3 },
  parent: { pos: { x: number; z: number }; rotY?: number; y?: number },
): { along: number; across: number; drop: number } {
  const dx = f.pos.x - parent.pos.x;
  const dz = f.pos.z - parent.pos.z;
  const a = parent.rotY ?? 0;
  return {
    along: dx * Math.cos(a) - dz * Math.sin(a),
    across: dx * Math.sin(a) + dz * Math.cos(a),
    drop: f.pos.y - (parent.y ?? 0),
  };
}

/** Inverse of offsetOnParent: put a fixture at an offset on its parent. */
export function posFromOffset(
  o: { along: number; across: number; drop: number },
  parent: { pos: { x: number; z: number }; rotY?: number; y?: number },
): Vec3 {
  const a = -(parent.rotY ?? 0);
  return {
    x: parent.pos.x + o.along * Math.cos(a) - o.across * Math.sin(a),
    z: parent.pos.z + o.along * Math.sin(a) + o.across * Math.cos(a),
    y: (parent.y ?? 0) + o.drop,
  };
}

export type HeadRef = { fixtureId: string; head: number };

export type StagePropKind =
  | 'vocalist' | 'guitarist' | 'bassist' | 'drummer' | 'keyboardist'
  // structure: the stage itself, drawn by hand. A real MVR carries this as
  // thousands of binary 3DS meshes, which is a different project; these
  // primitives cover the shapes that actually matter for judging a beam.
  | 'trussBar' | 'trussLeg' | 'riser' | 'screen';

/** Structural kinds carry dimensions; performers do not. */
export const STRUCTURE_KINDS: StagePropKind[] = ['trussBar', 'trussLeg', 'riser', 'screen'];
export const isStructure = (k: string): boolean =>
  (STRUCTURE_KINDS as string[]).includes(k);

/** Default size and hang height per structural kind, in metres. The truss bar
 *  matches the fixed goalpost it replaces, so drawing one changes nothing until
 *  you move it. */
export const STRUCTURE_DEFAULTS: Record<string, { w: number; h: number; d: number; y: number }> = {
  trussBar: { w: 7, h: 0.3, d: 0.3, y: 3.05 },
  trussLeg: { w: 0.3, h: 3.05, d: 0.3, y: 0 },
  riser: { w: 2, h: 0.4, d: 1.5, y: 0 },
  screen: { w: 4, h: 2.25, d: 0.12, y: 0.5 },
};
/** The stage as a box, in metres: `w` across (x), `d` toward the audience
 *  (z), `h` up to the grid (y), centred on the plan's origin. Optional —
 *  absent, every view fits itself to whatever is placed, the way the native
 *  previz always has (shared/stageExtent.ts). Twin of StageSize in
 *  core/src/types.rs. */
export type StageSize = { w: number; d: number; h: number };
export const STAGE_LIMITS = { w: [1, 500], d: [1, 500], h: [1, 100] } as const;

/** The one repair rule both engines apply — the twin of `de_stage` in
 *  core/src/types.rs, and the parity suite holds them to it: every side a
 *  finite positive number or the field is dropped; sides clamped to
 *  STAGE_LIMITS. */
export function sanitizeStage(v: unknown): StageSize | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const side = (k: 'w' | 'd' | 'h'): number | undefined => {
    const n = o[k];
    if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return undefined;
    const [lo, hi] = STAGE_LIMITS[k];
    return Math.min(hi, Math.max(lo, n));
  };
  const w = side('w');
  const d = side('d');
  const h = side('h');
  return w !== undefined && d !== undefined && h !== undefined ? { w, d, h } : undefined;
}

/** A dummy performer on the stage — previz-only scenery, placed like a
 *  fixture in the 2D plan, rendered as a figure in both 3D views. */
export type StageProp = {
  id: string;
  kind: StagePropKind;
  pos: { x: number; z: number };
  rotY?: number;
  /** structural kinds only, metres — w across, h tall, d deep (before rotY) */
  size?: { w: number; h: number; d: number };
  /** structural kinds only — height of the base off the floor; a truss bar hangs */
  y?: number;
};
/** `auto` is the provenance tag for derived groups (B3): "type:<profileId>"
 *  or "truss:<propId>". Tagged groups may be rewritten by an explicit
 *  regenerate; the UI clears the tag the moment the operator renames or edits
 *  one (promotion to authored). Inert to the engine. */
export type Group = { id: string; name: string; heads: HeadRef[]; auto?: string };

export type ColorHS = { h: number; s: number }; // hue 0..360, sat 0..1
export type MotorMode = 'off' | 'aim' | 'rotate';

/** How the shutter strobes while `strobe` is above zero: a plain strobe (the
 *  default, and all an older save knows), a pulse that ramps each flash open
 *  and shut, or random flashes around the set rate. A fixture without the
 *  pattern falls back to its plain strobe band. Mirrors StrobeMode in
 *  core/src/types.rs. */
export type StrobeMode = 'strobe' | 'pulse' | 'random';
export const STROBE_MODES: readonly StrobeMode[] = ['strobe', 'pulse', 'random'];

export type PartParams = {
  dimmer?: number;
  color?: ColorHS;
  /** derby white ring — hardware is on/off (≥0.5 = on / blinder) */
  white?: number;
  /** derby ring strobe patterns, 0 = off, 0..1 sweeps pattern+speed bands */
  ringFx?: number;
  /** shutter strobe, 0 = open, 0..1 = slow..fast */
  strobe?: number;
  motorMode?: MotorMode;
  /** aim position (motorMode 'aim') or rotation speed ('rotate'), 0..1 */
  motorValue?: number;
  /** explicit derby colour-macro DMX value; when set, overrides colour quantisation */
  macro?: number;
  pan?: number;
  tilt?: number;
  haze?: number;
  fan?: number;
  // Beam shaping. Absent means the look says nothing about this parameter and
  // the fixture keeps whatever its own profile parks it at — NOT that the
  // parameter is zero. A saved show opened after this landed must not find
  // every moving head snapped to its narrowest beam.
  /** beam angle, 0 = narrowest the fixture offers .. 1 = widest */
  zoom?: number;
  /** 0..1 across the fixture's focus travel */
  focus?: number;
  /** 0 = closed .. 1 = fully open */
  iris?: number;
  /** 0 = none .. 1 = full diffusion */
  frost?: number;
  /** colour temperature correction, 0..1 across the fixture's range */
  cto?: number;
  /** shutter pattern while strobing — absent is a plain strobe */
  strobeMode?: StrobeMode;
  // Optics. A slot is an INDEX into the fixture's own wheel (0 = open, no
  // prism), never a DMX value, so one look reads the same on two different
  // fixtures: "the second gobo" on each. Absent leaves the wheel where the
  // profile parks it, exactly like the beam parameters above.
  /** gobo wheel slot, 0 = open */
  gobo?: number;
  /** gobo rotation, 0..1 across the fixture's rotate band — on most heads the
   *  middle of the band is stopped and either end is full speed one way */
  goboRotate?: number;
  /** prism slot, 0 = no prism */
  prism?: number;
  /** prism rotation, 0..1 across the fixture's rotate band */
  prismRotate?: number;
};

export type EffectTarget =
  | 'dimmer' | 'hue' | 'white' | 'strobe' | 'pan' | 'tilt'
  | 'zoom' | 'focus' | 'iris' | 'frost' | 'cto' | 'goboRotate' | 'prismRotate'
  // The one target that drives TWO parameters. Pan and tilt have always been
  // separate targets with a free phase, so a circle could be hand-built from
  // two effects a quarter-cycle apart — and then it was two rows that had to
  // be edited in step, could not be saved to the pool as one thing, and fell
  // apart the moment somebody changed the rate of one of them.
  | 'shape';

/** The figures a `shape` effect can trace. Each one reads differently on a
 *  rig, which is the bar for being here: a circle sweeps, a figure-8 crosses
 *  itself, and a square has corners you can see the heads hit. */
export type ShapeKind = 'circle' | 'figure8' | 'square';
export const SHAPE_KINDS: readonly ShapeKind[] = ['circle', 'figure8', 'square'];
export type Wave = 'sine' | 'triangle' | 'sawUp' | 'sawDown' | 'square' | 'chase' | 'random';
/** How an effect's phase fans across the group: patch order (the legacy
 *  behaviour), a world-position sweep, a ripple from the group's centre, a
 *  seeded scatter, or the fixture's own pixel grid (row/col fan WITHIN each
 *  fixture, so every strobe runs the same pixel wave by construction). */
export type Distribute = 'index' | 'x' | 'y' | 'z' | 'radial' | 'shuffle' | 'row' | 'col';
/** Symmetry fold on the fan: mirror = ends in phase sweeping toward the
 *  centre (MA "wings"); centre = centre leads, ends trail. */
export type Fold = 'none' | 'mirror' | 'centre';

/** Runtime membership sets for sanitize/repair — the string unions above have
 *  no runtime form, so these are the single source both the type and the
 *  validator draw from. */
export const EFFECT_TARGETS: ReadonlySet<EffectTarget> = new Set<EffectTarget>([
  'dimmer', 'hue', 'white', 'strobe', 'pan', 'tilt', 'zoom', 'focus', 'iris', 'frost', 'cto',
  'goboRotate', 'prismRotate', 'shape',
]);
export const WAVES: ReadonlySet<Wave> = new Set<Wave>([
  'sine', 'triangle', 'sawUp', 'sawDown', 'square', 'chase', 'random',
]);
export const DISTRIBUTES: ReadonlySet<Distribute> = new Set<Distribute>([
  'index', 'x', 'y', 'z', 'radial', 'shuffle', 'row', 'col',
]);
export const FOLDS: ReadonlySet<Fold> = new Set<Fold>(['none', 'mirror', 'centre']);

/** Parameters a soft override can ride (P1). Part fields are the numeric
 *  PartParams (hue/sat address the colour components); effect fields are the
 *  numeric Effect knobs. One vocabulary, shared with P2/P3 bindings later. */
export type SoftField =
  | 'dimmer' | 'white' | 'ringFx' | 'strobe' | 'motorValue' | 'pan' | 'tilt'
  | 'haze' | 'fan' | 'zoom' | 'focus' | 'iris' | 'frost' | 'cto' | 'goboRotate' | 'prismRotate'
  | 'hue' | 'sat' | 'rate' | 'size' | 'spread' | 'width' | 'phase' | 'mix';

/** Runtime membership set — the Node engine must reject an unknown field the
 *  same way Rust's typed SoftField deserialization drops the whole frame. */
export const SOFT_FIELDS: ReadonlySet<SoftField> = new Set<SoftField>([
  'dimmer', 'white', 'ringFx', 'strobe', 'motorValue', 'pan', 'tilt',
  'haze', 'fan', 'zoom', 'focus', 'iris', 'frost', 'cto', 'goboRotate', 'prismRotate',
  'hue', 'sat', 'rate', 'size', 'spread', 'width', 'phase', 'mix',
]);

/** Per-field clamp for soft values — the engine validates at the door, so the
 *  renderer never meets an out-of-range ride. Mirrors soft_clamp in
 *  core/src/state.rs. */
export function softClamp(field: SoftField, v: number): number | null {
  if (!Number.isFinite(v)) return null;
  switch (field) {
    case 'hue':
      return clamp(v, 0, 360);
    case 'rate':
      return clamp(v, 0.05, 64);
    default:
      return clamp(v, 0, 1);
  }
}

export type Effect = {
  id: string;
  target: EffectTarget;
  wave: Wave;
  /** beats per cycle (4 = one cycle per bar in 4/4) */
  rate: number;
  /** depth 0..1 */
  size: number;
  /** phase fan across the group 0..1 (chase forces 1) */
  spread: number;
  /** duty width for square/chase */
  width: number;
  /** phase offset 0..1 */
  phase: number;
  /** parked: retained but contributes nothing this tick */
  bypass: boolean;
  /** wet/dry 0..1 (1 = full effect, the pre-A2 behaviour) */
  mix: number;
  /** fan basis (A1). 'index' with fold 'none', reverse off and parts/buddy 1
   *  is byte-identical to the pre-A1 fan. */
  distribute: Distribute;
  /** symmetry fold on the fan */
  fold: Fold;
  /** run the fan backwards */
  reverse: boolean;
  /** tile the fan into k repeats across the group (1 = off) */
  parts: number;
  /** clump size: adjacent heads (in fan order) share a phase (1 = off) */
  buddy: number;
  /** seed for the shuffle basis — re-roll for a different reproducible scatter */
  seed: number;
  // --- `shape` target only; ignored by every other target, and absent on
  // --- every effect written before shapes existed. Absent means the default,
  // --- so nothing is added to an effect that has no use for it.
  /** which figure to trace (default: circle) */
  shape?: ShapeKind;
  /** 0 = all pan and no tilt, 0.5 = even, 1 = all tilt (default: 0.5) */
  shapeAspect?: number;
  /** turn the whole figure, 0..1 = 0..360 degrees (default: 0) */
  shapeRotate?: number;
  /** trace it the other way round (default: false) */
  shapeCcw?: boolean;
};

/** Per-fixture pan and tilt calibration.
 *
 *  A rig is not a diagram: heads get hung backwards, upside down and on their
 *  sides, and one of them is always the one that sweeps the wrong way when
 *  every other head sweeps right. This is where that is written down, per
 *  fixture, so a look can go on saying "pan left" and mean it everywhere.
 *
 *  It is NOT where the head points — that is the base aim above, which an
 *  operator sets by eye and which stays put when this changes. Every field is
 *  optional and absent means "nothing to correct".
 */
export type FixtureCal = {
  /** a look's pan delta drives this head the other way */
  invertPan?: boolean;
  invertTilt?: boolean;
  /** the head is hung on its side: a look's tilt drives pan, and the reverse.
   *  Applied BEFORE the inversions, which name the fixture's own axes. */
  swap?: boolean;
  /** Soft limits as a fraction of travel, 0..1. The head may not be driven
   *  outside them, whatever a look or an effect asks for — the fixture that
   *  must not sweep into the video wall, or down into the front row. */
  panMin?: number;
  panMax?: number;
  tiltMin?: number;
  tiltMax?: number;
};

export type LookPart = {
  id: string;
  groupId: string;
  params: PartParams;
  effects: Effect[];
};

/** A named entry in the FX pool: a reusable effect template that references no
 *  fixtures. Applying it copies the effect into a look part with a fresh id
 *  (copy-on-apply), so editing the pool never reaches a running show. */
export type FxPreset = {
  id: string;
  name: string;
  effect: Effect;
};

/** One entry of a cue list: play `lookId` for `beats` beats, then advance. */
export type CueStep = { lookId: string; beats: number };

export type Look = {
  id: string;
  name: string;
  parts: LookPart[];
  /** momentary — releases on mouse-up / note-off */
  flash?: boolean;
  /** crossfade seconds, overrides the layer default */
  fade?: number;
  /** when present the look is a cue list: steps play in order, hard cuts on
   *  the beat, anchored at trigger time; `parts` is unused while set */
  steps?: CueStep[];
};

export type LayerBlend = 'normal' | 'multiply' | 'htp';

/** A page of the grid — one per song. Looks are shared across decks; a deck
 *  is just cell assignments (per layer) + column names. `layer.cells` always
 *  holds the ACTIVE deck; switching swaps pages in and out. */
export type Deck = {
  id: string;
  name: string;
  columns: string[];
  cells: Record<string, (string | null)[]>;
};

export type Layer = {
  id: string;
  name: string;
  blend: LayerBlend;
  master: number;
  /** default crossfade seconds */
  fade: number;
  /** look id per column */
  cells: (string | null)[];
};

/** One fan-out of a Named Control (P3): drives a single soft address through
 *  a per-link bracket. value v (0..1) maps to min + (max − min)·v — set
 *  min > max to invert. The engine clamps the mapped value per-field at the
 *  soft door, so a bracket can never push a parameter out of range. */
export type ControlLink = {
  lookId: string;
  partId: string;
  effectId?: string;
  field: SoftField;
  min: number;
  max: number;
};

/** A Named Control (P3) — the macro answer: a typed live fader fanning out to
 *  parameters through per-link brackets. No strings, no conditionals; what
 *  drives what is data you can read. `value` is the SAVED position; the live
 *  position is runtime state carried in the snapshot. */
export type Control = {
  id: string;
  name: string;
  value: number;
  links: ControlLink[];
};

/** One binding of a modulator (P2): adds a beat-driven offset to a soft
 *  address. depth −1..1 scales the swing (±half range at |depth| 1); the
 *  combined value clamps per-field, and the operator always keeps the knob —
 *  the offset rides ON TOP of stored → soft. */
export type ModBinding = {
  lookId: string;
  partId: string;
  effectId?: string;
  field: SoftField;
  depth: number;
};

/** A global modulator (P2, LFO slice): a pure function of the shared effect
 *  beat, so it inherits the speed master and tap alignment for free. `rate`
 *  is beats per cycle, like an effect's. */
export type Modulator = {
  id: string;
  name: string;
  wave: Wave;
  rate: number;
  phase: number;
  on: boolean;
  bindings: ModBinding[];
};

export type MidiAction =
  | { kind: 'cell'; layerId: string; col: number }
  /** move a Named Control (CC value scales 0..1) */
  | { kind: 'control'; controlId: string }
  | { kind: 'column'; col: number }
  | { kind: 'layerMaster'; layerId: string }
  /** a group submaster on a fader */
  | { kind: 'submaster'; groupId: string }
  | { kind: 'layerClear'; layerId: string }
  | { kind: 'grand' }
  | { kind: 'speed' }
  | { kind: 'haze' }
  | { kind: 'tap' }
  | { kind: 'blackout' }
  | { kind: 'deckNext' }
  | { kind: 'deckPrev' };

export type MidiMapping = {
  id: string;
  type: 'note' | 'cc';
  channel: number; // 0..15
  number: number;
  action: MidiAction;
};

export type SyncCfg = {
  oscEnabled: boolean;
  /** follow an Ableton Link session (native engine only) */
  linkEnabled?: boolean;
  oscPort: number;
  /** Resolume column connect → trigger the same column here */
  followColumns: boolean;
  bpmFromOsc: boolean;
};

export type Settings = {
  /** manual hazer output/fan, merged HTP with looks */
  haze: number;
  hazeFan: number;
};

/** Imported (GDTF-compiled) fixture profile — pure data, interpreted by the
 *  Rust core natively and by the Node engine via the shared WASM build.
 *  The UI only reads metadata (heads/footprint/channel names). */
// GDTF Share catalogue types live in gdtfShare.ts with the matching logic;
// re-exported here so UI code has one import for "the shapes on the wire".
export type { ShareEntry, ShareList, ShareMatch, MissingFixture } from './gdtfShare.ts';

/** The importer's current version — mirrors COMPILER_VERSION in
 *  core/src/cprofile.rs, where the history of what changed at each step lives.
 *  A profile stamped lower than this was compiled by an older build. */
export const COMPILER_VERSION = 1;

export type CompiledProfile = {
  id: string;
  manufacturer: string;
  model: string;
  mode: string;
  footprint: number;
  /** offsetY/row/col are B1 pixel-layout fields; absent on pre-B1 saves (and
   *  Rust skips serializing zeros), so they are optional with 0 defaults.
   *  When every head of a profile is (row 0, col 0), the geometry builder
   *  falls back to col = head index, one row. */
  heads: { kind: 'rgb' | 'derby' | 'hazer' | 'dimmer' | 'mover'; offset: number; offsetY?: number; row?: number; col?: number; label: string }[];
  channels: { offsets: number[]; head: number; name: string; default: number; cases: unknown[] }[];
  /** BEAM angle: full cone angle in degrees at 50 % of axial intensity. */
  beamDeg: number;
  /** FIELD angle: full cone angle at 10 % — the edge of the usable light,
   *  where beamDeg is the hot core. GDTF carries both; the ratio between them
   *  is the fixture's character (~1.2 a hard-edged beam, ~2.0 a soft wash).
   *  Absent on everything imported before it was kept, and on the built-ins. */
  fieldDeg?: number;
  /** Total luminous flux in lumens, summed over the file's Beam elements — a
   *  fixture with more than one is describing layers of itself, not
   *  alternatives. Absent when the file does not declare it. */
  lumens?: number;
  /** Radius of the emitting surface in metres. Small, and what keeps a
   *  1/r² beam integral finite when the camera looks straight at a lamp. */
  beamRadius?: number;
  virtualDimmer: boolean;
  /** Total pan travel in degrees, read from the fixture's own definition.
   *  Absent on built-ins and on anything imported before it was read, where
   *  540 and 270 — what both stage views used to assume for every mover —
   *  stand in. Magnitude only: which WAY a head swings is the operator's
   *  `invertPan`, because the file describes the fixture's axes, not the room's. */
  panDeg?: number;
  tiltDeg?: number;
  /** Colour temperature at each end of the warmth channel, low DMX first,
   *  straight from the fixture's own definition. Absent where it does not
   *  say, and the warmth fader then reads as a percentage rather than
   *  inventing Kelvin. Not sorted: which end is warm is the useful half. */
  ctoK?: [number, number];
  /** Which importer wrote this profile — COMPILER_VERSION at the time. A
   *  project stores compiled profiles, so an old one keeps whatever the
   *  compiler understood the day it was imported; the Rig view offers a
   *  rebuild from the fixture library when this is behind. Absent (0) on
   *  anything compiled before the stamp existed, which is what it should say. */
  compiler?: number;
  /** who authored the fixture definition — carried so the credit travels with
   *  the project, which is what GDTF Share's terms ask for. */
  credit?: string;
  /** An operator's override of the inferred fixture form. Normally absent —
   *  only the override is stored, never the guess, so a re-import cannot
   *  clobber a hand correction and improving the heuristic improves shows
   *  that already exist. Presentation only: it changes how a fixture is drawn
   *  and lit in the previz and touches no DMX byte. */
  formOverride?: FixtureForm;
};

/** What SHAPE of fixture a profile describes — the box, not the emitter.
 *
 *  `heads[].kind` says what one emitter does; this says what the thing on the
 *  truss physically is. A CLF Nero is a rectangular blinder plate that happens
 *  to tilt; a Robe Spiider is a moving head that happens to have nineteen
 *  pixels. Neither is knowable from the head kinds alone.
 *
 *  Mirrors `FixtureForm` in core/src/cprofile.rs. */
export type FixtureForm =
  | 'mover'
  | 'par'
  | 'bar'
  | 'panel'
  | 'strobe'
  | 'derby'
  | 'hazer';

export const FIXTURE_FORMS: { value: FixtureForm; label: string }[] = [
  { value: 'mover', label: 'moving head' },
  { value: 'par', label: 'par' },
  { value: 'bar', label: 'bar / batten' },
  { value: 'panel', label: 'panel / blinder' },
  { value: 'strobe', label: 'strobe' },
  { value: 'derby', label: 'derby' },
  { value: 'hazer', label: 'hazer' },
];

/** The Node mirror of `CompiledProfile::infer_form` (core/src/cprofile.rs).
 *
 *  Both engines must land on the same answer or the two previz views draw the
 *  same rig differently, so this is a twin and has to be kept one. Ordered
 *  identically; see the Rust doc comment for why the beam angle is tested
 *  before the head count. */
export function inferFixtureForm(prof: CompiledProfile): FixtureForm {
  const kinds = new Set((prof.heads ?? []).map((h) => h.kind));
  if (kinds.has('hazer')) return 'hazer';
  if (kinds.has('derby')) return 'derby';
  const drives = (src: string) =>
    (prof.channels ?? []).some((ch) =>
      (ch.cases as { func?: { kind?: string; source?: string } }[] ?? []).some(
        (c) => c?.func?.kind === 'linear' && c.func.source === src,
      ),
    );
  if (drives('pan') && drives('tilt')) return 'mover';
  if ((prof.beamDeg ?? 0) >= 90) return 'panel';
  if ((prof.heads?.length ?? 0) >= 4) {
    const spread = (key: 'offset' | 'offsetY') => {
      const vs = (prof.heads ?? []).map((h) => h[key] ?? 0);
      return vs.length ? Math.max(...vs) - Math.min(...vs) : 0;
    };
    const span = spread('offset');
    return span > 0 && spread('offsetY') <= span * 0.35 ? 'bar' : 'panel';
  }
  if (drives('strobe') && !drives('colorR')) return 'strobe';
  return 'par';
}

/** The form to draw a profile as: the override if set, otherwise the guess. */
export function fixtureFormOf(prof: CompiledProfile): FixtureForm {
  return prof.formOverride ?? inferFixtureForm(prof);
}

export type Project = {
  version: 1;
  name: string;
  universes: UniverseCfg[];
  fixtures: Fixture[];
  groups: Group[];
  /** dummy performers for the previz (optional; absent = empty stage) */
  props?: StageProp[];
  /** the stage as a box; absent = every view fits itself to the rig */
  stage?: StageSize;
  looks: Record<string, Look>;
  /** stack order: index 0 = bottom of the stack (UI shows it as the last row) */
  layers: Layer[];
  columns: string[];
  midi: MidiMapping[];
  sync: SyncCfg;
  settings: Settings;
  /** imported fixture profiles, keyed by profile id — travel with the project */
  profiles?: Record<string, CompiledProfile>;
  /** grid pages (one per song); layer.cells mirrors the active deck */
  decks?: Deck[];
  activeDeckId?: string;
  /** FX pool: named, reusable effect templates (copy-on-apply) */
  fxPool?: FxPreset[];
  /** Named Controls (P3): live faders fanning to parameters via soft links */
  controls?: Control[];
  /** Global modulators (P2): beat-locked LFOs bound to parameters */
  modulators?: Modulator[];
};

// ---------- live wire types ----------

export type HeadSnap = {
  f: string;
  h: number;
  r: number; g: number; b: number; // resolved colour 0..1
  i: number; // intensity 0..1, post grand-master
  st: number;
  ring: number;
  mm: MotorMode;
  mv: number;
  pan: number;
  tilt: number;
  /** Resolved zoom 0..1, present only when a look is actually driving zoom on
   *  this head. The previz widens or narrows its beam cone from it; absent
   *  means "nobody asked", and the cone keeps the profile's own beam angle. */
  zm?: number;
  /** derby macro component colours (0..255 triples), for multi-colour beam fans */
  mc?: [number, number, number][];
};

export type LayerSnap = {
  id: string;
  lookId: string | null;
  prevId: string | null;
  /** live column, if the active look came from a cell */
  col: number | null;
  /** crossfade progress 0..1 */
  t: number;
};

export type EngineStats = { fps: number; jitter: number; artnet: number; sacn: number };

export type Snapshot = {
  type: 'snap';
  now: number;
  beat: number;
  bpm: number;
  speed: number;
  master: number;
  blackout: boolean;
  /** Whether the rig is holding the frame it was showing while the show runs
   *  on underneath. The stage view and the pads follow the edits; the wire
   *  does not. */
  frozen: boolean;
  /** Whether the engine is putting DMX on the wire. Not derivable from the
   *  project: the universes say WHERE output would go, this says whether any
   *  of it leaves the machine. Off at every boot. */
  transmit: boolean;
  haze: number;
  /** Ableton Link session state — native (Rust) engine only */
  link?: { on: boolean; peers: number };
  /** live soft overrides (P1) — present only while something is ridden, so
   *  the UI can draw dual-state faders and offer Store/Discard */
  soft?: { lookId: string; partId: string; effectId?: string; field: SoftField; value: number }[];
  /** live Named Control positions (P3) — present only while any differ from
   *  their stored value */
  controls?: { id: string; value: number }[];
  /** Group submasters — present only while any is below full, because that is
   *  the only time one is doing anything. */
  submasters?: { id: string; v: number }[];
  /** Art-Net nodes discovered via ArtPoll (present when polling is active) */
  artnetNodes?: { ip: string; name: string; ageMs: number }[];
  /** 'failed' = reply port 6454 is held by another app — discovery unavailable */
  artnetPoll?: 'on' | 'failed';
  /** OSC input socket: 'failed' = the port is held by another app (a second
   *  engine? QLC+?) so nothing from Resolume will ever arrive. Absent = off. */
  oscIn?: 'on' | 'failed';
  /** fixtures currently silenced */
  muted?: string[];
  /** fixture being identified (driven to full white), if any */
  identify?: string | null;
  /** number of raw channel overrides in force */
  overrides?: number;
  /** Fixtures whose profile id resolves to nothing — they render as silently
   *  dark, so the UI has to say so. Reachable by undoing past a GDTF import,
   *  or by a hand-edited/older project file. */
  unknownProfiles?: string[];
  hazeFan: number;
  heads: HeadSnap[];
  layers: LayerSnap[];
  stats: EngineStats;
};

// The snapshot is IDENTICAL for every client, so the engine serialises it once
// and broadcasts one string. The two payloads below used to ride inside it even
// though each is wanted by at most one client at a time — raw DMX (only the
// Output tab reads it, one universe) and the audition head set. At arena scale
// that was ~9 KB of the ~28 KB snapshot, 20x a second, to every client
// including the previz and the tablet, which pay for data they never read.
// They are targeted events instead: sent only to the client that asked.

/** Raw DMX for the universes this client subscribed to via `watchDmx`. */
export type DmxEvent = { type: 'dmx'; u: Record<string, number[]> };

/** Heads as they WOULD look if the previewed look were running on its own: full
 *  master, no blackout, nothing else live. Sent only to the client that asked
 *  for the audition. `heads: null` means the preview ended. Never touches DMX. */
export type PreviewEvent = { type: 'preview'; heads: HeadSnap[] | null };

export type OscLogEntry = { t: number; addr: string; args: (number | string)[] };

// ---------- commands (ui → engine) ----------

export type Command =
  | { type: 'hello' }
  | { type: 'trigger'; layerId: string; col: number }
  | { type: 'release'; layerId: string; col: number }
  | { type: 'clearLayer'; layerId: string }
  | { type: 'setLink'; on: boolean }
  /** silence one fixture without touching the patch (stuck/dead unit) */
  | { type: 'setFixtureMute'; fixtureId: string; on: boolean }
  /** drive one fixture to full white to find it on the truss */
  | { type: 'identify'; fixtureId: string | null }
  /** Audition a look in the previz without sending it to the rig. null stops.
   *  The engine resolves it with the SAME renderer that drives the show, so the
   *  preview cannot quietly disagree with what actually fires. */
  | { type: 'previewLook'; lookId: string | null }
  /** panic: blackout, clear every layer, release holds, haze + motors off */
  | { type: 'allStop' }
  /** raw channel override, applied last into the DMX buffer (channel is 1-512;
   *  value null clears). Not persisted — a check tool, not show data. */
  | { type: 'setChannel'; universeId: string; channel: number; value: number | null }
  | { type: 'clearChannelOverrides' }
  | { type: 'projects' }
  | { type: 'newProject'; name: string }
  | { type: 'openProject'; slug: string }
  | { type: 'saveProjectAs'; name: string }
  | { type: 'column'; col: number }
  | { type: 'setBpm'; bpm: number }
  | { type: 'tap' }
  | { type: 'resync' }
  | { type: 'setSpeed'; v: number }
  | { type: 'setMaster'; v: number }
  | { type: 'setLayerMaster'; layerId: string; v: number }
  /** Pull a whole group's intensity down without touching a look.
   *
   *  Runtime-only and never saved (backlog decision 4): a submaster stored at
   *  zero would kill that group on the next boot, and "comes up dark and safe"
   *  has to mean dark for a reason you can see. */
  | { type: 'setSubmaster'; groupId: string; v: number }
  | { type: 'setBlackout'; v: boolean }
  /** Open or close the transmit gate: whether rendered frames reach the wire
   *  at all. Blackout is the show being dark and is still transmitted; this is
   *  LIGHT not speaking to the network. Runtime-only and off at every boot,
   *  whatever the show says — engine/output.ts. */
  | { type: 'setTransmit'; v: boolean }
  /** Hold the frame the rig is showing while the show carries on underneath,
   *  so a look can be edited live without the room watching it being built.
   *  Runtime-only; blackout and ALL STOP release it — engine/output.ts. */
  | { type: 'setFreeze'; v: boolean }
  | { type: 'setHaze'; v: number }
  | { type: 'setHazeFan'; v: number }
  // baseGen: the project generation this edit was composed against. The engine
  // rejects (and re-syncs) a write whose baseGen is stale — i.e. the project
  // changed underneath it via another client, an APC deck switch, or an
  // openProject — instead of letting last-write-wins clobber the newer state.
  // Optional so a non-UI writer (a test, a script) can still submit blind.
  // label: what this edit is, in the operator's words ("rename song “Intro”") —
  // the name the engine's history gives the step, and the undo tooltip shows.
  // coalesce: this write continues the sender's previous one (a fader drag)
  // and must join the step already open rather than start another. The
  // engine honours it only for the same client, and never across an undo.
  | { type: 'updateProject'; project: Project; baseGen?: number; label?: string; coalesce?: boolean }
  /** Step the engine's history back or forward. One history per engine —
   *  every client shares it, whoever made the edit — and the restored
   *  project goes to everyone. Not an edit itself: the page, masters, haze
   *  and Link stay where they are. */
  | { type: 'undo' }
  | { type: 'redo' }
  // Subscribe this client to raw DMX for the given universes; [] unsubscribes.
  // Only the Output tab wants it, so nothing else pays for it.
  | { type: 'watchDmx'; universeIds: string[] }
  // TEST ONLY (LIGHT_TEST_CLOCK gated) — pin the effect clock so a moving effect
  // is byte-comparable between the two engines. Ignored otherwise.
  | { type: '_pinClock'; effBeat: number }
  /** P1 soft override: ride one stored parameter live without a project
   *  write (~40 bytes per knob-turn instead of two full project clones).
   *  Keys are STORAGE-shaped — (look, part[, effect], field) — so a ride
   *  applies wherever the look plays, and Store writes exactly there.
   *  value null clears the single override. */
  | { type: 'soft'; lookId: string; partId: string; effectId?: string; field: SoftField; value: number | null }
  /** Store: write every soft value into the project (one gen bump), clear */
  | { type: 'softCommit' }
  /** Discard: drop every soft value, stored data untouched */
  | { type: 'softClear' }
  /** move a Named Control: resolves through the soft layer per link */
  | { type: 'setControl'; controlId: string; value: number }
  | { type: 'midi'; status: number; d1: number; d2: number }
  /** arm (or cancel with null) engine-side MIDI learn — next note/cc maps to the action */
  | { type: 'learn'; action: MidiAction | null }
  /** import a .gdtf file (base64) — engine parses and adds its modes to project.profiles */
  | {
      type: 'importGdtf';
      name: string;
      data: string;
      /** who authored the definition. A GDTF file carries no author attribute,
       *  so this can only come from where the file came from — the Share
       *  catalogue knows, a hand-picked file does not. */
      credit?: string;
    }
  /** import a .mvr scene (base64) — patch, positions, groups; replace clears the current patch */
  | { type: 'importMvr'; name: string; data: string; replace: boolean }
  /** spawn the native previz window next to the engine */
  | { type: 'launchPreviz' }
  /** switch the active grid page (deck) */
  | { type: 'switchDeck'; deckId: string }
  | { type: 'save' };

// ---------- events (engine → ui) ----------

export type ServerEvent =
  // gen: a monotonic counter the engine bumps on every project change. A client
  // echoes the last gen it saw back as updateProject.baseGen, which is how the
  // engine detects and rejects a stale write.
  | { type: 'project'; project: Project; gen: number }
  /** The engine's undo history as the buttons see it: the names of the next
   *  step back and forward, and the depths. Sent on connect and whenever the
   *  history changes. */
  | { type: 'history'; undo: string | null; redo: string | null; undoDepth: number; redoDepth: number }
  | DmxEvent
  | PreviewEvent
  | Snapshot
  | { type: 'osc'; entry: OscLogEntry }
  | { type: 'saved'; path: string }
  /** native MIDI inputs owned by the engine (Rust core); empty for the Node dev engine */
  | { type: 'midiInputs'; names: string[] }
  | { type: 'learned'; mapping: MidiMapping }
  | { type: 'importResult'; ok: boolean; message: string; profileIds: string[] }
  | { type: 'toast'; ok: boolean; message: string }
  | { type: 'projects'; current: string; list: { slug: string; name: string }[] };

/** Neutral MVR import bundle produced by the shared parser. */
export type MvrBundle = {
  profiles: Record<string, CompiledProfile>;
  fixtures: { name: string; profileId: string; universe: number; address: number; pos: [number, number, number]; rotY: number }[];
  groups: { name: string; fixtures: number[] }[];
  warnings: string[];
};

export const WS_PORT = 9900;

export function clamp(v: number, lo = 0, hi = 1): number {
  if (!Number.isFinite(v)) return lo; // NaN must never propagate into the engine
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Repair one effect at the door, mirroring repair_effect in core/src/types.rs:
 *  drop it (null) if it has no id or an unknown target/wave, force every numeric
 *  field finite (a NaN rate/size otherwise reaches the hue-wrap maths), coerce
 *  bypass and clamp mix. Extra fields survive via the spread, keeping
 *  forward-compatibility as the motion engine adds fields. */
export function repairEffect(e: unknown): Effect | null {
  if (!e || typeof e !== 'object') return null;
  const x = e as Effect;
  if (typeof x.id !== 'string' || !EFFECT_TARGETS.has(x.target) || !WAVES.has(x.wave)) return null;
  return {
    ...x,
    rate: Number.isFinite(x.rate) ? x.rate : 1,
    size: Number.isFinite(x.size) ? x.size : 1,
    spread: Number.isFinite(x.spread) ? x.spread : 0,
    width: Number.isFinite(x.width) ? x.width : 0.5,
    phase: Number.isFinite(x.phase) ? x.phase : 0,
    // A2: absent on pre-A2 saves — default to an active, full-wet effect so
    // those shows render byte-identically to before.
    bypass: x.bypass === true,
    mix: Number.isFinite(x.mix) ? clamp(x.mix, 0, 1) : 1,
    // A1: the fan fields default to the legacy fan. An UNKNOWN distribute or
    // fold degrades to the default rather than dropping the effect — a show
    // authored on a newer build should still run here, just unfanned, which
    // beats going dark.
    distribute: DISTRIBUTES.has(x.distribute) ? x.distribute : 'index',
    fold: FOLDS.has(x.fold) ? x.fold : 'none',
    reverse: x.reverse === true,
    parts: Number.isFinite(x.parts) && x.parts >= 1 ? Math.min(Math.floor(x.parts), 64) : 1,
    buddy: Number.isFinite(x.buddy) && x.buddy >= 1 ? Math.min(Math.floor(x.buddy), 64) : 1,
    // clamped, not wrapped: JS ToInt32 and Rust saturating casts disagree on
    // absurd magnitudes, so both engines clamp to i32 range instead
    seed: Number.isFinite(x.seed) ? clamp(Math.floor(x.seed), -2147483648, 2147483647) : 0,
    // Shape fields are validate-or-DROP, never defaulted in. An effect that is
    // not a shape must come out of here exactly as it went in — the factory
    // catalogue is pinned on that — and the renderer reads its own defaults.
    ...(SHAPE_KINDS.includes(x.shape as ShapeKind) ? { shape: x.shape } : { shape: undefined }),
    shapeAspect: Number.isFinite(x.shapeAspect) ? clamp(x.shapeAspect as number) : undefined,
    shapeRotate: Number.isFinite(x.shapeRotate) ? clamp(x.shapeRotate as number) : undefined,
    shapeCcw: x.shapeCcw === true ? true : undefined,
  };
}

/**
 * Structural validation + repair for untrusted project data (updateProject
 * commands, files from disk). Repairs what it can, drops what it can't, and
 * returns null only when the data is unusable — the render loop must never
 * meet a shape it can't survive.
 */
export function sanitizeProject(p: Project): Project | null {
  if (!p || typeof p !== 'object' || p.version !== 1) return null;
  if (
    !Array.isArray(p.universes) || !Array.isArray(p.fixtures) || !Array.isArray(p.groups) ||
    !Array.isArray(p.layers) || !Array.isArray(p.columns)
  ) {
    return null;
  }
  p.midi = Array.isArray(p.midi) ? p.midi : [];
  p.looks = p.looks && typeof p.looks === 'object' ? p.looks : {};
  const sync = (p.sync ?? {}) as Partial<SyncCfg>;
  p.sync = {
    oscEnabled: sync.oscEnabled ?? true,
    linkEnabled: sync.linkEnabled ?? false,
    oscPort: Number.isFinite(sync.oscPort) ? (sync.oscPort as number) : 7700,
    followColumns: sync.followColumns ?? true,
    bpmFromOsc: sync.bpmFromOsc ?? true,
  };
  const settings = (p.settings ?? {}) as Partial<Settings>;
  p.settings = {
    haze: Number.isFinite(settings.haze) ? (settings.haze as number) : 0,
    hazeFan: Number.isFinite(settings.hazeFan) ? (settings.hazeFan as number) : 0.35,
  };
  for (const [id, lk] of Object.entries(p.looks)) {
    if (!lk || typeof lk !== 'object' || !Array.isArray(lk.parts)) {
      delete p.looks[id];
      continue;
    }
    for (const part of lk.parts) {
      if (!part.params || typeof part.params !== 'object') part.params = {};
      // A shutter pattern from a newer build (or a typo) is dropped, not
      // failed — Rust's de_strobe_mode does the same, so both engines strobe
      // plain. A wheel slot is a finite, non-negative whole number; anything
      // else is dropped the way de_slot drops it.
      const prm = part.params as Record<string, unknown>;
      if (prm.strobeMode !== undefined && !STROBE_MODES.includes(prm.strobeMode as StrobeMode)) delete prm.strobeMode;
      for (const k of ['gobo', 'prism'] as const) {
        const v = prm[k];
        if (v === undefined) continue;
        if (typeof v === 'number' && Number.isFinite(v) && v >= 0) prm[k] = Math.round(v);
        else delete prm[k];
      }
      part.effects = Array.isArray(part.effects)
        ? part.effects.map(repairEffect).filter((e): e is Effect => e !== null)
        : [];
    }
    if (lk.steps !== undefined) {
      if (!Array.isArray(lk.steps)) delete lk.steps;
      else {
        lk.steps = lk.steps
          .filter((st): st is CueStep => !!st && typeof st === 'object' && typeof st.lookId === 'string')
          // prototype keys ("constructor", "__proto__", ...) must never reach
          // the renderer as look references - they resolve to inherited values
          .filter((st) => Object.hasOwn(p.looks, st.lookId) || !(st.lookId in p.looks))
          .map((st) => ({
            lookId: st.lookId,
            beats: Number.isFinite(st.beats) && st.beats > 0 ? Math.min(st.beats, 512) : 1,
          }));
        if (lk.steps.length === 0) delete lk.steps;
      }
    }
  }
  for (const layer of p.layers) {
    if (!Array.isArray(layer.cells)) layer.cells = p.columns.map(() => null);
    layer.cells = layer.cells.map((c) =>
      typeof c === 'string' && Object.hasOwn(p.looks, c) && p.looks[c] ? c : null,
    );
    if (!Number.isFinite(layer.master)) layer.master = 1;
    if (!Number.isFinite(layer.fade)) layer.fade = 0.5;
  }
  // decks migration: older projects have no pages — the current grid becomes
  // deck 1, and the active deck id must always resolve
  if (!Array.isArray(p.decks) || p.decks.length === 0) {
    p.decks = [{
      id: 'deck-1',
      name: 'Song 1',
      columns: [...p.columns],
      cells: Object.fromEntries(p.layers.map((l) => [l.id, [...l.cells]])),
    }];
    p.activeDeckId = 'deck-1';
  }
  if (!p.decks.some((d) => d.id === p.activeDeckId)) p.activeDeckId = p.decks[0].id;
  for (const g of p.groups) {
    if (!Array.isArray(g.heads)) g.heads = [];
    // mirror Rust's de_opt_string: a non-string provenance tag loads as absent
    if (g.auto !== undefined && typeof g.auto !== 'string') delete g.auto;
  }
  // the stage box: repaired by the one rule both engines share, or dropped
  if (p.stage !== undefined) {
    const stage = sanitizeStage(p.stage);
    if (stage) p.stage = stage;
    else delete p.stage;
  }
  if (p.props !== undefined) {
    if (!Array.isArray(p.props)) delete p.props;
    else {
      // Derived from the kind union, NOT hand-listed. A hand-written allow-list
      // silently deleted every truss, leg, riser and screen the moment stage
      // structure was added: stripped on load, on updateProject and on
      // replaceProject, while the UI kept drawing them because the echo is
      // withheld from the sender — so the autosave wrote a show with no stage
      // and it was gone on reload. Adding a kind must never again mean
      // remembering to edit a set literal somewhere else.
      const KINDS = new Set<string>([
        'vocalist', 'guitarist', 'bassist', 'drummer', 'keyboardist',
        ...(STRUCTURE_KINDS as string[]),
      ]);
      p.props = p.props.filter(
        (pr): pr is StageProp =>
          !!pr && typeof pr === 'object' && typeof pr.id === 'string' && KINDS.has(pr.kind as string),
      );
      for (const pr of p.props) {
        if (!pr.pos || typeof pr.pos !== 'object') pr.pos = { x: 0, z: 1 };
        if (!Number.isFinite(pr.pos.x)) pr.pos.x = 0;
        if (!Number.isFinite(pr.pos.z)) pr.pos.z = 1;
        if (pr.rotY !== undefined && !Number.isFinite(pr.rotY)) delete pr.rotY;
        // structural pieces carry dimensions; repair rather than drop them
        if (isStructure(pr.kind)) {
          const d = STRUCTURE_DEFAULTS[pr.kind] ?? { w: 1, h: 1, d: 1, y: 0 };
          const s = pr.size;
          if (!s || typeof s !== 'object') pr.size = { w: d.w, h: d.h, d: d.d };
          else {
            if (!Number.isFinite(s.w) || s.w <= 0) s.w = d.w;
            if (!Number.isFinite(s.h) || s.h <= 0) s.h = d.h;
            if (!Number.isFinite(s.d) || s.d <= 0) s.d = d.d;
          }
          if (pr.y !== undefined && !Number.isFinite(pr.y)) pr.y = d.y;
        } else {
          delete pr.size;
          delete pr.y;
        }
      }
      if (p.props.length === 0) delete p.props;
    }
  }
  for (const f of p.fixtures) {
    if (!Number.isFinite(f.address)) f.address = 1;
    if (!f.pos || typeof f.pos !== 'object') f.pos = { x: 0, y: 2, z: 0 };
    // Per-COMPONENT, not just per-object: a pos like {x:1} used to sail through
    // with y/z undefined. Harmless while nothing in the engine read positions —
    // but the geometry module consumes them now, and Rust serde fills missing
    // components from the Vec3 default (0, 2, 0), so TS must land on the same
    // values or the two engines compute different world positions.
    if (!Number.isFinite(f.pos.x)) f.pos.x = 0;
    if (!Number.isFinite(f.pos.y)) f.pos.y = 2;
    if (!Number.isFinite(f.pos.z)) f.pos.z = 0;
    if (!Number.isFinite(f.rotY)) f.rotY = 0;
    if (f.rotX !== undefined && !Number.isFinite(f.rotX)) delete f.rotX;
    if (f.rotZ !== undefined && !Number.isFinite(f.rotZ)) delete f.rotZ;
    // Calibration: flags become booleans, limits become finite fractions, and
    // anything else is dropped. Rust's de_cal does the same, so a hand-edited
    // file lands on one answer in both engines. A block with nothing left in
    // it is removed rather than stored empty.
    if (f.cal !== undefined) {
      const c = f.cal as Record<string, unknown>;
      if (!c || typeof c !== 'object') delete f.cal;
      else {
        for (const k of ['invertPan', 'invertTilt', 'swap'] as const) {
          if (c[k] === true) c[k] = true;
          else delete c[k];
        }
        for (const k of ['panMin', 'panMax', 'tiltMin', 'tiltMax'] as const) {
          const v = c[k];
          if (typeof v === 'number' && Number.isFinite(v)) c[k] = clamp(v);
          else delete c[k];
        }
        if (Object.keys(c).length === 0) delete f.cal;
      }
    }
  }
  // Profile head spatial fields (B1): geometry consumes offset/offsetY/row/col
  // now, so both engines must land on identical values for any wire shape —
  // Rust's de_metres/de_index repair non-finite to 0 and indices to floor≥0,
  // and this is the Node mirror. Kind/channels stay untouched: they were
  // machine-generated and unvalidated long before B1.
  for (const prof of Object.values(p.profiles ?? {})) {
    if (!prof || !Array.isArray(prof.heads)) continue;
    for (const h of prof.heads) {
      if (!h || typeof h !== 'object') continue;
      if (!Number.isFinite(h.offset)) h.offset = 0;
      if (h.offsetY !== undefined && !Number.isFinite(h.offsetY)) delete h.offsetY;
      if (h.row !== undefined) h.row = Number.isFinite(h.row) ? Math.max(0, Math.floor(h.row)) : 0;
      if (h.col !== undefined) h.col = Number.isFinite(h.col) ? Math.max(0, Math.floor(h.col)) : 0;
    }
    // A form override from a newer build, or a typo in a hand-edited file, is
    // dropped rather than failing the load: it is presentation, and the
    // inference underneath it is always available.
    if (prof.formOverride !== undefined
      && !FIXTURE_FORMS.some((f) => f.value === prof.formOverride)) {
      delete prof.formOverride;
    }
  }
  // FX pool: tolerant like the effect repair above (de_fx_pool in Rust). A
  // preset with no id or an unrepairable effect is dropped, not fatal. Cleared
  // when empty to match the engine's skip-empty serialisation.
  if (p.fxPool !== undefined) {
    p.fxPool = Array.isArray(p.fxPool)
      ? p.fxPool
          .map((fp): FxPreset | null => {
            if (!fp || typeof fp !== 'object' || typeof fp.id !== 'string') return null;
            const effect = repairEffect(fp.effect);
            if (!effect) return null;
            return { id: fp.id, name: typeof fp.name === 'string' ? fp.name : '', effect };
          })
          .filter((fp): fp is FxPreset => fp !== null)
      : [];
    if (p.fxPool.length === 0) delete p.fxPool;
  }
  // Named Controls (P3): tolerant like the pool — drop a control with no id
  // or a link whose field is unknown; force numerics finite; clamp value 0..1.
  if (p.controls !== undefined) {
    p.controls = Array.isArray(p.controls)
      ? p.controls
          .map((c): Control | null => {
            if (!c || typeof c !== 'object' || typeof c.id !== 'string') return null;
            const links = Array.isArray(c.links)
              ? c.links
                  .filter(
                    (l): l is ControlLink =>
                      !!l && typeof l === 'object' && typeof l.lookId === 'string' &&
                      typeof l.partId === 'string' &&
                      SOFT_FIELDS.has(l.field),
                  )
                  .map((l) => ({
                    lookId: l.lookId,
                    partId: l.partId,
                    // null/non-string effectId ≡ absent (a part-level link),
                    // matching Rust's as_str() — the serde convention 3236809
                    // established for the soft command applies to stored data
                    ...(typeof l.effectId === 'string' ? { effectId: l.effectId } : {}),
                    field: l.field,
                    min: Number.isFinite(l.min) ? l.min : 0,
                    max: Number.isFinite(l.max) ? l.max : 1,
                  }))
              : [];
            return {
              id: c.id,
              name: typeof c.name === 'string' ? c.name : '',
              value: Number.isFinite(c.value) ? clamp(c.value, 0, 1) : 0,
              links,
            };
          })
          .filter((c): c is Control => c !== null)
      : [];
    if (p.controls.length === 0) delete p.controls;
  }
  // Modulators (P2): same tolerance discipline.
  if (p.modulators !== undefined) {
    p.modulators = Array.isArray(p.modulators)
      ? p.modulators
          .map((m): Modulator | null => {
            if (!m || typeof m !== 'object' || typeof m.id !== 'string' || !WAVES.has(m.wave)) return null;
            const bindings = Array.isArray(m.bindings)
              ? m.bindings
                  .filter(
                    (b): b is ModBinding =>
                      !!b && typeof b === 'object' && typeof b.lookId === 'string' &&
                      typeof b.partId === 'string' &&
                      // rate is NOT modulatable: a per-tick rate change turns
                      // the P4 phase-continuity map into a tick-schedule-
                      // dependent integrator (ride rate by hand or a Control)
                      b.field !== 'rate' &&
                      SOFT_FIELDS.has(b.field),
                  )
                  .map((b) => ({
                    lookId: b.lookId,
                    partId: b.partId,
                    // null/non-string effectId ≡ absent, matching Rust
                    ...(typeof b.effectId === 'string' ? { effectId: b.effectId } : {}),
                    field: b.field,
                    depth: Number.isFinite(b.depth) ? clamp(b.depth, -1, 1) : 0,
                  }))
              : [];
            return {
              id: m.id,
              name: typeof m.name === 'string' ? m.name : '',
              wave: m.wave,
              rate: Number.isFinite(m.rate) && m.rate > 0 ? Math.min(m.rate, 512) : 4,
              phase: Number.isFinite(m.phase) ? m.phase : 0,
              on: m.on !== false,
              bindings,
            };
          })
          .filter((m): m is Modulator => m !== null)
      : [];
    if (p.modulators.length === 0) delete p.modulators;
  }
  return p;
}

let idCounter = 0;
export function uid(prefix = 'id'): string {
  idCounter = (idCounter + 1) % 46656;
  return `${prefix}-${Date.now().toString(36)}${idCounter.toString(36)}`;
}
