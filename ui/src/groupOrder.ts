// The order the GROUPS row draws groups in, and so the order a controller
// layout hands them to faders (design A14, decision 2).
//
// A rig's groups sit in the order they were made — auto-groups one per fixture
// type and one per truss — which is not the order a hand wants under four
// faders. Pinned groups come first, in the order they were pinned, and the rest
// follow in the show's own order. The row and the busk layout read this one
// rule, or the faders would ride different groups from the ones first on the
// screen.
//
// Pure, and outside store.ts, which opens a socket when it is imported.
import type { Group, Project } from '../../shared/types.ts';

/** The pins that still mean something: each names a group the show has, once. */
export function livePins(p: Pick<Project, 'groups' | 'pinnedGroups'>): string[] {
  const have = new Set(p.groups.map((g) => g.id));
  return (p.pinnedGroups ?? []).filter((id, i, all) => have.has(id) && all.indexOf(id) === i);
}

/** Pinned groups first, in pin order, then the rest in the show's order. */
export function groupsInRowOrder(p: Pick<Project, 'groups' | 'pinnedGroups'>): Group[] {
  const pins = livePins(p);
  const byId = new Map(p.groups.map((g) => [g.id, g]));
  const pinned = pins.map((id) => byId.get(id)!);
  const rest = p.groups.filter((g) => !pins.includes(g.id));
  return [...pinned, ...rest];
}

/** Pin a group after the ones already pinned, or unpin it. Writes into the
 *  project it is given, so a caller runs it inside one `mutate`. A show with
 *  nothing pinned carries no list at all, as a show from before pins did. */
export function togglePin(p: Pick<Project, 'groups' | 'pinnedGroups'>, groupId: string): void {
  const pins = livePins(p);
  const at = pins.indexOf(groupId);
  if (at >= 0) pins.splice(at, 1);
  else if (p.groups.some((g) => g.id === groupId)) pins.push(groupId);
  if (pins.length > 0) p.pinnedGroups = pins;
  else delete p.pinnedGroups;
}
