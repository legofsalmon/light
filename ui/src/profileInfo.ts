// Unified fixture-profile metadata: built-ins (code) + imported GDTF (data).
// The UI never renders DMX — it only needs shape, names, and previz hints.

import type { Project, StrobeMode } from '../../shared/types.ts';
import { STROBE_MODES } from '../../shared/types.ts';
import type { HeadKind } from '../../shared/profiles.ts';
import { PROFILES, PROFILE_LIST } from '../../shared/profiles.ts';

export type ProfileMeta = {
  id: string;
  label: string;
  channels: number;
  heads: { kind: HeadKind; offset: number; offsetY?: number; row?: number; col?: number; label: string }[];
  /** one name per channel of the footprint, for the DMX monitor */
  channelNames: string[];
  /** moving heads only: whether this profile actually has a pan / tilt axis,
   *  so the patch offers a base aim for the fixtures that can use one */
  hasPan: boolean;
  /** drives a dedicated white emitter (RGBW), as opposed to a derby's on/off ring */
  hasWhite: boolean;
  hasTilt: boolean;
  /** which beam parameters this profile actually drives — read off the
   *  compiled channels rather than their names, so a channel merely *called*
   *  "Zoom Mode" does not put a zoom fader on a fixture that has none */
  beam: BeamCaps;
  /** the gobo wheel's slot names in index order (0 = open); empty = no wheel
   *  LIGHT drives. A look stores the index, so the names are the picker. */
  gobos: string[];
  /** likewise the prism wheel (0 = no prism) */
  prisms: string[];
  /** shutter patterns with a band of their own — the plain strobe is always
   *  there and is not listed */
  strobeModes: StrobeMode[];
  beamDeg: number;
  /** How far the head swings, in degrees, from the fixture's own definition.
   *  540 and 270 stand in where it does not say — what both stage views used
   *  to assume for every mover. Also what the Rig table reads a base aim
   *  against, so "50%" can be shown as an angle. */
  panDeg: number;
  tiltDeg: number;
  /** Kelvin at each end of the warmth channel, low DMX first; absent where the
   *  fixture's definition does not say, and the fader stays a percentage. */
  ctoK?: [number, number];
  imported: boolean;
};

/** Imported profiles describe channels by offset, and a coarse/fine pair is one
 *  entry covering two slots — flatten that back to one name per wire channel. */
function compiledChannelNames(c: NonNullable<Project['profiles']>[string]): string[] {
  const names = new Array<string>(c.footprint).fill('—');
  for (const ch of c.channels) {
    ch.offsets.forEach((off, i) => {
      if (off >= 0 && off < c.footprint) {
        names[off] = ch.offsets.length > 1 ? `${ch.name} ${i === 0 ? '(coarse)' : '(fine)'}` : ch.name;
      }
    });
  }
  return names;
}

/** The optional, continuous beam parameters — every one a 0..1 fader with an
 *  enable, in the order they are offered in the editor. The two rotations
 *  belong to the optics block and sit beside their wheel's slot picker. */
export const BEAM_PARAMS = ['zoom', 'focus', 'iris', 'frost', 'cto', 'goboRotate', 'prismRotate'] as const;
export type BeamParam = (typeof BEAM_PARAMS)[number];
export type BeamCaps = Record<BeamParam, boolean>;
/** The ones that are beam shaping proper, offered as a run of faders. */
export const BEAM_FADERS: readonly BeamParam[] = ['zoom', 'focus', 'iris', 'frost', 'cto'];

export const BEAM_LABELS: Record<BeamParam, string> = {
  zoom: 'zoom',
  focus: 'focus',
  iris: 'beam size',
  frost: 'soften',
  cto: 'warmth',
  goboRotate: 'gobo spin',
  prismRotate: 'prism spin',
};

export const noBeamCaps = (): BeamCaps =>
  Object.fromEntries(BEAM_PARAMS.map((k) => [k, false])) as BeamCaps;
/** Built-ins predate these parameters and none of them has one. */
const NO_BEAM: BeamCaps = noBeamCaps();

/** A driven White source — the RGBW emitter. Asks the channels, not the name,
 *  so a "ColorAdd_W" reads as white and an undriven channel does not. */
function hasWhiteSource(c: NonNullable<Project['profiles']>[string]): boolean {
  return c.channels.some((ch) =>
    (ch.cases as { func?: { source?: string } }[]).some((k) => k?.func?.source === 'white'),
  );
}

function beamCaps(c: NonNullable<Project['profiles']>[string]): BeamCaps {
  const out: BeamCaps = { ...NO_BEAM };
  for (const ch of c.channels) {
    for (const k of ch.cases as { func?: { kind?: string; source?: string } }[]) {
      // a slot function's source is the wheel index, not a fader
      if (k?.func?.kind === 'slot') continue;
      const src = k?.func?.source;
      if (src && src in out) out[src as BeamParam] = true;
    }
  }
  return out;
}

type SlotCase = { func?: { kind?: string; source?: string; sets?: { name?: string }[] } };

/** The slot names of the wheel a `slot` function reads, in index order. */
function slotNames(c: NonNullable<Project['profiles']>[string], source: 'gobo' | 'prism'): string[] {
  for (const ch of c.channels) {
    for (const k of ch.cases as SlotCase[]) {
      if (k?.func?.kind === 'slot' && k.func.source === source) {
        return (k.func.sets ?? []).map((s, i) => s?.name || `slot ${i}`);
      }
    }
  }
  return [];
}

/** The shutter patterns the profile has a band for, in the canonical order. */
function strobeModesOf(c: NonNullable<Project['profiles']>[string]): StrobeMode[] {
  const found = new Set<string>();
  for (const ch of c.channels) {
    for (const k of ch.cases as { cond?: { kind?: string; mode?: string } }[]) {
      if (k?.cond?.kind === 'strobeModeIs' && k.cond.mode) found.add(k.cond.mode);
    }
  }
  return STROBE_MODES.filter((m) => found.has(m));
}

/** A 16-bit axis shows up as "Pan (coarse)"/"Pan (fine)", so match the stem.
 *  The patterns are module-scope so a 129-fixture conflict scan does not compile
 *  two RegExps per fixture per pass. */
const AXIS_RE = { pan: /^pan\b/i, tilt: /^tilt\b/i };
const hasAxis = (names: string[], axis: 'pan' | 'tilt', heads: { kind: HeadKind }[]): boolean =>
  heads.some((h) => h.kind === 'mover') || names.some((n) => AXIS_RE[axis].test(n));

// profileMeta for an imported profile rebuilds channel-name and beam-capability
// tables from scratch, and the patch view calls it thousands of times per
// render (an O(n^2) conflict scan, plus a full profile dropdown per row). Cache
// per project: the key is the profiles object, which is replaced wholesale on
// every edit, so a WeakMap entry is naturally invalidated when the project
// changes and collected when it is dropped.
const META_CACHE = new WeakMap<object, Map<string, ProfileMeta | null>>();
function metaCacheFor(project: Project | null): Map<string, ProfileMeta | null> | null {
  const profiles = project?.profiles;
  if (!profiles) return null;
  let m = META_CACHE.get(profiles);
  if (!m) {
    m = new Map();
    META_CACHE.set(profiles, m);
  }
  return m;
}

export function profileMeta(project: Project | null, id: string): ProfileMeta | null {
  const cache = metaCacheFor(project);
  if (cache?.has(id)) return cache.get(id)!;
  const meta = computeProfileMeta(project, id);
  cache?.set(id, meta);
  return meta;
}

function computeProfileMeta(project: Project | null, id: string): ProfileMeta | null {
  const b = PROFILES[id];
  if (b) {
    return {
      id,
      label: `${b.manufacturer} ${b.model} · ${b.mode}`,
      channels: b.channels,
      heads: b.heads.map((h) => ({ kind: h.kind, offset: h.offset, label: h.label })),
      channelNames: b.channelNames,
      hasPan: hasAxis(b.channelNames, 'pan', b.heads),
      hasTilt: hasAxis(b.channelNames, 'tilt', b.heads),
      hasWhite: b.channelNames.some((n) => /^white\b/i.test(n)),
      beam: NO_BEAM,
      gobos: [],
      prisms: [],
      strobeModes: [],
      beamDeg: b.beamDeg,
      panDeg: 540,
      tiltDeg: 270,
      imported: false,
    };
  }
  const c = project?.profiles?.[id];
  if (c) {
    const names = compiledChannelNames(c);
    return {
      id,
      label: `${c.manufacturer} ${c.model} · ${c.mode}`,
      channels: c.footprint,
      heads: c.heads,
      channelNames: names,
      hasPan: hasAxis(names, 'pan', c.heads),
      hasTilt: hasAxis(names, 'tilt', c.heads),
      hasWhite: hasWhiteSource(c),
      beam: beamCaps(c),
      gobos: slotNames(c, 'gobo'),
      prisms: slotNames(c, 'prism'),
      strobeModes: strobeModesOf(c),
      beamDeg: c.beamDeg,
      panDeg: c.panDeg && c.panDeg > 0 ? c.panDeg : 540,
      tiltDeg: c.tiltDeg && c.tiltDeg > 0 ? c.tiltDeg : 270,
      ctoK: c.ctoK,
      imported: true,
    };
  }
  return null;
}

export function allProfileMetas(project: Project | null): ProfileMeta[] {
  const builtins = PROFILE_LIST.map((b) => profileMeta(project, b.id)!);
  const imported = Object.keys(project?.profiles ?? {})
    .sort()
    .map((id) => profileMeta(project, id)!)
    .filter(Boolean);
  return [...builtins, ...imported];
}
