// What the library knows about a look, all of it computed from the project.
//
// Nothing here is a tag the operator maintains (design A7, A25): "flash",
// "steps", "unused", "on stage" and the counts are read off the show every
// time it changes, so a filter can never be wrong about it. The old panel
// counted `×N` in the current song only (LookLibrary.tsx before this), which
// is the one number that cannot answer "is this look safe to delete".

import type { Look, Project } from '../../../../shared/types.ts';
import type { LookKind } from '../../labels.ts';
import { lookFace, type LookFace } from '../../lookColors.ts';

/** One look, as the library reads it. */
export type LibraryEntry = {
  look: Look;
  face: LookFace;
  /** the families it enables, in I·C·P·B order */
  kinds: LookKind[];
  /** The FIRST PART's group — the look's own order, not the stage order the
   *  face is drawn in. Two looks of one name are usually two takes on the same
   *  groups in a different order (the shipped show has eight such pairs), and
   *  the order they were built in is the one thing that differs. */
  group: string;
  /** pads pointing at it across EVERY song */
  pads: number;
  /** songs that carry it on at least one pad */
  songs: number;
  /** pads in the song the grid is showing */
  here: number;
  /** a layer is playing it right now */
  onStage: boolean;
  /** it names groups, and none of them are in this rig */
  orphan: boolean;
};

/** The filter chips, in the order the design writes them. `group` is the one
 *  that carries a value; the rest are predicates. */
export type LibraryFilter = 'all' | 'here' | 'stage' | 'flash' | 'steps' | 'unused';
export const FILTERS: readonly LibraryFilter[] = ['all', 'here', 'stage', 'flash', 'steps', 'unused'];
export const FILTER_LABEL: Record<LibraryFilter, string> = {
  all: 'all',
  here: 'this song',
  stage: 'on stage',
  flash: 'flash',
  steps: 'steps',
  unused: 'unused',
};
export const FILTER_HELP: Record<LibraryFilter, string> = {
  all: 'every look in the show',
  here: 'looks on a pad in the song the grid is showing',
  stage: 'looks a layer is playing right now',
  flash: 'looks that hold only while the pad is held',
  steps: 'looks that play a list of other looks in order',
  unused: 'looks on no pad in any song — nothing would notice if they went',
};

/** Which of the four families a look enables. A steps look enables whatever
 *  its steps do, so it is the union of the ones that resolve. */
export function lookKinds(look: Look, project: Project, seen = new Set<string>()): LookKind[] {
  const on = new Set<LookKind>();
  if (look.steps?.length) {
    if (seen.has(look.id)) return [];
    seen.add(look.id);
    for (const st of look.steps) {
      const target = Object.hasOwn(project.looks, st.lookId) ? project.looks[st.lookId] : undefined;
      if (target) for (const k of lookKinds(target, project, seen)) on.add(k);
    }
    return order(on);
  }
  for (const part of look.parts) {
    const p = part.params;
    if (p.dimmer !== undefined) on.add('I');
    if (p.color || p.macro !== undefined || p.white !== undefined || p.ringFx !== undefined) on.add('C');
    if (p.pan !== undefined || p.tilt !== undefined || p.motorMode !== undefined || p.motorValue !== undefined) on.add('P');
    if (
      p.strobe !== undefined || p.zoom !== undefined || p.focus !== undefined || p.iris !== undefined ||
      p.frost !== undefined || p.gobo !== undefined || p.goboRotate !== undefined || p.prism !== undefined ||
      p.prismRotate !== undefined || p.flower !== undefined || p.cto !== undefined || p.haze !== undefined
    ) on.add('B');
    for (const fx of part.effects) {
      if (fx.target === 'dimmer') on.add('I');
      else if (fx.target === 'hue' || fx.target === 'white' || fx.target === 'cto') on.add('C');
      else if (fx.target === 'pan' || fx.target === 'tilt' || fx.target === 'shape') on.add('P');
      else on.add('B');
    }
  }
  return order(on);
}

const order = (on: Set<LookKind>): LookKind[] =>
  (['I', 'C', 'P', 'B'] as const).filter((k) => on.has(k));

/** Pads and songs per look, counted across the WHOLE show.
 *
 *  The active song is read from `project.layers`, not from its stored copy in
 *  `decks`: the engine only writes that copy back on a switch-away, so the
 *  stored one is a song behind for as long as you stay on it. */
export function usage(project: Project): Map<string, { pads: number; songs: number }> {
  const out = new Map<string, { pads: number; songs: number }>();
  const add = (id: string | null, deckSeen: Set<string>) => {
    if (!id) return;
    const cur = out.get(id) ?? { pads: 0, songs: 0 };
    cur.pads++;
    if (!deckSeen.has(id)) {
      cur.songs++;
      deckSeen.add(id);
    }
    out.set(id, cur);
  };
  const live = new Set<string>();
  for (const l of project.layers) for (const id of l.cells) add(id, live);
  for (const deck of project.decks ?? []) {
    if (deck.id === project.activeDeckId) continue; // counted from the live layers above
    const seen = new Set<string>();
    for (const cells of Object.values(deck.cells)) for (const id of cells) add(id, seen);
  }
  return out;
}

/** Pads in the song the grid is showing. `editingDeckId` is null while that is
 *  the live one, whose cells are the layers themselves. */
export function usedHere(project: Project, editingDeckId: string | null): Map<string, number> {
  const m = new Map<string, number>();
  const count = (id: string | null) => {
    if (id) m.set(id, (m.get(id) ?? 0) + 1);
  };
  if (editingDeckId === null || editingDeckId === project.activeDeckId) {
    for (const l of project.layers) for (const id of l.cells) count(id);
  } else {
    const deck = (project.decks ?? []).find((d) => d.id === editingDeckId);
    for (const cells of Object.values(deck?.cells ?? {})) for (const id of cells) count(id);
  }
  return m;
}

/** Every look in the pool, as the library reads it, in name order. */
export function entries(
  project: Project,
  editingDeckId: string | null,
  onStage: ReadonlySet<string>,
): LibraryEntry[] {
  const used = usage(project);
  const here = usedHere(project, editingDeckId);
  const rig = new Set(project.groups.map((g) => g.id));
  const name = new Map(project.groups.map((g) => [g.id, g.name]));
  return Object.values(project.looks)
    .map((look) => {
      const face = lookFace(look, project);
      const groups = new Set(look.parts.map((p) => p.groupId).filter(Boolean));
      const u = used.get(look.id);
      return {
        look,
        face,
        kinds: lookKinds(look, project),
        group: name.get(look.parts[0]?.groupId ?? '') ?? '',
        pads: u?.pads ?? 0,
        songs: u?.songs ?? 0,
        here: here.get(look.id) ?? 0,
        onStage: onStage.has(look.id),
        orphan: groups.size > 0 && ![...groups].some((g) => rig.has(g)),
      };
    })
    .sort((a, b) => a.look.name.localeCompare(b.look.name));
}

/** Whether an entry passes one chip. `all` passes everything. */
export function passes(e: LibraryEntry, f: LibraryFilter): boolean {
  switch (f) {
    case 'here': return e.here > 0;
    case 'stage': return e.onStage;
    case 'flash': return !!e.look.flash;
    case 'steps': return !!e.look.steps?.length;
    case 'unused': return e.pads === 0;
    default: return true;
  }
}

/** The chips, the group filter and the search, applied together. */
export function filtered(
  all: LibraryEntry[],
  f: LibraryFilter,
  groupId: string,
  q: string,
): LibraryEntry[] {
  const needle = q.trim().toLowerCase();
  return all.filter((e) => {
    if (!passes(e, f)) return false;
    if (groupId && !e.look.parts.some((p) => p.groupId === groupId)) return false;
    if (needle && !e.look.name.toLowerCase().includes(needle)) return false;
    return true;
  });
}

/** Two rows of the APC's 5×8 — the bank the arrows step through, not a page
 *  size somebody picked. */
export const BANK = 16;
