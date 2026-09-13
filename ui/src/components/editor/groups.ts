// What a fixture group can actually take, and which of the editor's five
// features that puts on the screen.
//
// Every one of these asks the CHANNELS, not the head kind: a head kind
// describes what one emitter is, and a fixture can be a moving head whose
// emitters are pixels — a Robin Spiider is exactly that, two `rgb` heads with
// a Pan channel wired to `source: "pan"`. Gating the controls on the head kind
// hid them on a fixture that plainly has them, while the rig table — which
// asks the channels — showed the aim fields perfectly.

import type { EffectTarget, PartParams, Project, SoftField, StrobeMode } from '../../../../shared/types.ts';
import { STROBE_MODES } from '../../../../shared/types.ts';
import type { HeadKind } from '../../../../shared/profiles.ts';
import { BEAM_PARAMS, type BeamCaps, type ProfileMeta, noBeamCaps, profileMeta } from '../../profileInfo.ts';
import type { Feature } from '../../editorStore.ts';
import { hasUndrivenBeamChannels } from '../../../../shared/gdtfShare.ts';

export function groupKinds(project: Project, groupId: string): Set<HeadKind> {
  const kinds = new Set<HeadKind>();
  const group = project.groups.find((g) => g.id === groupId);
  if (!group) return kinds;
  for (const ref of group.heads) {
    const fixture = project.fixtures.find((f) => f.id === ref.fixtureId);
    const head = fixture ? profileMeta(project, fixture.profileId)?.heads[ref.head] : null;
    if (head) kinds.add(head.kind);
  }
  return kinds;
}

/** Can anything in this group actually move? */
export function groupCanAim(project: Project, groupId: string): boolean {
  const group = project.groups.find((g) => g.id === groupId);
  if (!group) return false;
  return group.heads.some((ref) => {
    const fixture = project.fixtures.find((f) => f.id === ref.fixtureId);
    const meta = fixture ? profileMeta(project, fixture.profileId) : null;
    return !!meta?.hasPan || !!meta?.hasTilt;
  });
}

/** Does anything in this group drive a white emitter? A derby's white ring is
 *  a different thing — on/off hardware, already offered as `ring blinder` — so
 *  this asks for a real, faded White channel, which every RGBW wash imported
 *  from GDTF has and which the editor never offered a way to set. */
export function groupCanWhite(project: Project, groupId: string): boolean {
  const group = project.groups.find((g) => g.id === groupId);
  if (!group) return false;
  return group.heads.some((ref) => {
    const fixture = project.fixtures.find((f) => f.id === ref.fixtureId);
    const meta = fixture ? profileMeta(project, fixture.profileId) : null;
    return !!meta?.hasWhite;
  });
}

/** Does anything in this group have beam channels with no function behind
 *  them? Distinguishes "this fixture has no zoom" from "this fixture has a zoom
 *  channel that the stored profile never wired up", which look identical in an
 *  editor that only shows what it can drive. */
export function groupHasDeadBeamChannels(project: Project, groupId: string): boolean {
  const group = project.groups.find((g) => g.id === groupId);
  if (!group) return false;
  return group.heads.some((ref) => {
    const fixture = project.fixtures.find((f) => f.id === ref.fixtureId);
    const compiled = fixture ? project.profiles?.[fixture.profileId] : undefined;
    return !!compiled && hasUndrivenBeamChannels(compiled);
  });
}

export function groupBeamCaps(project: Project, groupId: string): BeamCaps {
  const out: BeamCaps = noBeamCaps();
  const group = project.groups.find((g) => g.id === groupId);
  if (!group) return out;
  for (const ref of group.heads) {
    const fixture = project.fixtures.find((f) => f.id === ref.fixtureId);
    const meta = fixture ? profileMeta(project, fixture.profileId) : null;
    if (!meta) continue;
    for (const k of BEAM_PARAMS) if (meta.beam[k]) out[k] = true;
  }
  return out;
}

export type GroupOptics = { gobos: string[]; prisms: string[]; strobeModes: StrobeMode[]; ctoK?: [number, number] };

/** Kelvin at each end of the warmth fader for this group — only when every
 *  fixture in it that HAS a warmth channel states the same range. Two heads
 *  with different ranges would make one number a lie about the other, and a
 *  percentage is at least honestly vague. */
function groupKelvin(metas: (ProfileMeta | null)[]): [number, number] | undefined {
  const ranges = metas.map((m) => m?.ctoK).filter((k): k is [number, number] => !!k);
  if (ranges.length === 0) return undefined;
  const [a, b] = ranges[0];
  return ranges.every((r) => r[0] === a && r[1] === b) ? [a, b] : undefined;
}

/** The wheel slots and shutter patterns something in this group can take.
 *  Slot names come from the first fixture that has the wheel — a slot is an
 *  index, so the same pick lands on every fixture in the group, "the second
 *  gobo" on each — and the patterns are the union. */
export function groupOptics(project: Project, groupId: string): GroupOptics {
  const out: GroupOptics = { gobos: [], prisms: [], strobeModes: [] };
  const group = project.groups.find((g) => g.id === groupId);
  if (!group) return out;
  for (const ref of group.heads) {
    const fixture = project.fixtures.find((f) => f.id === ref.fixtureId);
    const meta = fixture ? profileMeta(project, fixture.profileId) : null;
    if (!meta) continue;
    if (out.gobos.length === 0) out.gobos = meta.gobos;
    if (out.prisms.length === 0) out.prisms = meta.prisms;
    for (const m of meta.strobeModes) if (!out.strobeModes.includes(m)) out.strobeModes.push(m);
  }
  out.strobeModes = STROBE_MODES.filter((m) => out.strobeModes.includes(m));
  out.ctoK = groupKelvin(
    (group.heads ?? []).map((ref) => {
      const fixture = project.fixtures.find((f) => f.id === ref.fixtureId);
      return fixture ? profileMeta(project, fixture.profileId) : null;
    }),
  );
  return out;
}

/** How many emitters one fixture in this group has, when they all agree and
 *  there is more than one — a pixel strip's head count, which is what "per
 *  strip" means to a spread. Undefined when the group is single-emitter
 *  fixtures, or a mix of shapes where one number would be a lie about the
 *  others (same discipline as the warmth range above). */
export function groupHeadsPerFixture(project: Project, groupId: string): number | undefined {
  const group = project.groups.find((g) => g.id === groupId);
  if (!group) return undefined;
  const counts = new Set<number>();
  for (const ref of group.heads) {
    const fixture = project.fixtures.find((f) => f.id === ref.fixtureId);
    const meta = fixture ? profileMeta(project, fixture.profileId) : null;
    if (meta) counts.add(meta.heads.length);
  }
  if (counts.size !== 1) return undefined;
  const n = [...counts][0];
  return n > 1 ? n : undefined;
}

/** Which effect targets the rig in this group can actually take. One answer,
 *  shared by the target menu and the catalogue picker — two of them would drift
 *  and the picker would flag things the menu was happy with. */
export function capableTargets(kinds: Set<HeadKind>, canAim: boolean, beamCaps: BeamCaps): EffectTarget[] {
  const capable: EffectTarget[] = ['dimmer'];
  if (kinds.has('rgb') || kinds.has('derby') || kinds.has('mover')) capable.push('hue', 'strobe');
  if (kinds.has('derby')) capable.push('white');
  // `shape` drives pan AND tilt from one effect, so it needs both.
  if (canAim) capable.push('pan', 'tilt', 'shape');
  for (const k of BEAM_PARAMS) if (beamCaps[k]) capable.push(k);
  return capable;
}

/** What each feature owns, so the dot beside its name can say whether the look
 *  sets anything there and whether a nudge is riding it. Every soft address the
 *  part body can move belongs to exactly one family. */
export const FEATURE_PARAMS: Record<Feature, readonly (keyof PartParams)[]> = {
  intensity: ['dimmer', 'strobe', 'strobeMode'],
  colour: ['color', 'white', 'ringFx', 'macro'],
  position: ['pan', 'tilt', 'motorMode', 'motorValue'],
  beam: ['zoom', 'focus', 'iris', 'frost', 'cto', 'gobo', 'goboRotate', 'prism', 'prismRotate', 'flower'],
  haze: ['haze', 'fan'],
};

export const FEATURE_FIELDS: Record<Feature, readonly SoftField[]> = {
  intensity: ['dimmer', 'strobe'],
  colour: ['hue', 'sat', 'white', 'ringFx'],
  position: ['pan', 'tilt', 'motorValue'],
  beam: ['zoom', 'focus', 'iris', 'frost', 'cto', 'goboRotate', 'prismRotate', 'flower'],
  haze: ['haze', 'fan'],
};

export const FEATURE_ORDER: readonly Feature[] = ['intensity', 'colour', 'position', 'beam', 'haze'];

export type GroupCaps = {
  kinds: Set<HeadKind>;
  canAim: boolean;
  canWhite: boolean;
  beamCaps: BeamCaps;
  optics: GroupOptics;
  deadBeam: boolean;
  headsPerFixture?: number;
};

export function groupCaps(project: Project, groupId: string): GroupCaps {
  const kinds = groupKinds(project, groupId);
  return {
    kinds,
    canAim: groupCanAim(project, groupId),
    // a derby's ring is on/off hardware and has its own control; this is the
    // faded white emitter on an RGBW head
    canWhite: !kinds.has('derby') && groupCanWhite(project, groupId),
    beamCaps: groupBeamCaps(project, groupId),
    optics: groupOptics(project, groupId),
    deadBeam: groupHasDeadBeamChannels(project, groupId),
    headsPerFixture: groupHeadsPerFixture(project, groupId),
  };
}

/** The features this group can take — the ones with at least one control
 *  behind them. A feature with nothing to show is not a tab that greys out;
 *  it is not there, because an editor full of controls that go nowhere is
 *  worse than one that is honest about the rig. */
export function featuresFor(caps: GroupCaps): Feature[] {
  const { kinds, canAim, canWhite, beamCaps, optics, deadBeam } = caps;
  const hasColour = kinds.has('rgb') || kinds.has('derby') || kinds.has('mover');
  const out: Feature[] = [];
  if (kinds.size > 0 && !(kinds.size === 1 && kinds.has('hazer'))) out.push('intensity');
  if (hasColour || canWhite) out.push('colour');
  if (canAim || kinds.has('derby')) out.push('position');
  if (BEAM_PARAMS.some((k) => beamCaps[k]) || optics.gobos.length > 0 || optics.prisms.length > 0 || deadBeam) {
    out.push('beam');
  }
  if (kinds.has('hazer')) out.push('haze');
  return out;
}
