// Unified fixture-profile metadata: built-ins (code) + imported GDTF (data).
// The UI never renders DMX — it only needs shape, names, and previz hints.

import type { Project } from '../../shared/types.ts';
import type { HeadKind } from '../../shared/profiles.ts';
import { PROFILES, PROFILE_LIST } from '../../shared/profiles.ts';

export type ProfileMeta = {
  id: string;
  label: string;
  channels: number;
  heads: { kind: HeadKind; offset: number; label: string }[];
  /** one name per channel of the footprint, for the DMX monitor */
  channelNames: string[];
  /** moving heads only: whether this profile actually has a pan / tilt axis,
   *  so the patch offers a base aim for the fixtures that can use one */
  hasPan: boolean;
  hasTilt: boolean;
  /** which beam parameters this profile actually drives — read off the
   *  compiled channels rather than their names, so a channel merely *called*
   *  "Zoom Mode" does not put a zoom fader on a fixture that has none */
  beam: BeamCaps;
  beamDeg: number;
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

/** The optional beam parameters, in the order they are offered in the editor. */
export const BEAM_PARAMS = ['zoom', 'focus', 'iris', 'frost', 'cto'] as const;
export type BeamParam = (typeof BEAM_PARAMS)[number];
export type BeamCaps = Record<BeamParam, boolean>;

export const BEAM_LABELS: Record<BeamParam, string> = {
  zoom: 'zoom',
  focus: 'focus',
  iris: 'iris',
  frost: 'frost',
  cto: 'cto',
};

/** Built-ins predate these parameters and none of them has one. */
const NO_BEAM: BeamCaps = { zoom: false, focus: false, iris: false, frost: false, cto: false };

function beamCaps(c: NonNullable<Project['profiles']>[string]): BeamCaps {
  const out: BeamCaps = { ...NO_BEAM };
  for (const ch of c.channels) {
    for (const k of ch.cases as { func?: { source?: string } }[]) {
      const src = k?.func?.source;
      if (src && src in out) out[src as BeamParam] = true;
    }
  }
  return out;
}

/** A 16-bit axis shows up as "Pan (coarse)"/"Pan (fine)", so match the stem. */
const hasAxis = (names: string[], axis: 'pan' | 'tilt', heads: { kind: HeadKind }[]): boolean =>
  heads.some((h) => h.kind === 'mover') ||
  names.some((n) => new RegExp(`^${axis}\\b`, 'i').test(n));

export function profileMeta(project: Project | null, id: string): ProfileMeta | null {
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
      beam: NO_BEAM,
      beamDeg: b.beamDeg,
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
      beam: beamCaps(c),
      beamDeg: c.beamDeg,
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
