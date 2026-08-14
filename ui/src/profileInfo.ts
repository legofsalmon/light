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

export function profileMeta(project: Project | null, id: string): ProfileMeta | null {
  const b = PROFILES[id];
  if (b) {
    return {
      id,
      label: `${b.manufacturer} ${b.model} · ${b.mode}`,
      channels: b.channels,
      heads: b.heads.map((h) => ({ kind: h.kind, offset: h.offset, label: h.label })),
      channelNames: b.channelNames,
      beamDeg: b.beamDeg,
      imported: false,
    };
  }
  const c = project?.profiles?.[id];
  if (c) {
    return {
      id,
      label: `${c.manufacturer} ${c.model} · ${c.mode}`,
      channels: c.footprint,
      heads: c.heads,
      channelNames: compiledChannelNames(c),
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
