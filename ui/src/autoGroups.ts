import type { Group, Project } from '../../shared/types.ts';
import { offsetOnParent } from '../../shared/types.ts';
import { profileMeta } from './profileInfo.ts';

/** Derived groups (B3, slice 1): per-TYPE and per-TRUSS. Deliberately no
 *  clustering and no name heuristics — type and rigging are the signals that
 *  produce groups operators keep. Ids are deterministic so a regenerate
 *  updates in place instead of duplicating. */
export function desiredAutoGroups(p: Project): Group[] {
  const out: Group[] = [];

  // Per-type: every profile patched with ≥ 2 heads in total, all its heads in
  // patch order (fixtures array order = the order the rig was patched in).
  const byProfile = new Map<string, { fixtureId: string; head: number }[]>();
  const labelOf = new Map<string, string>();
  for (const f of p.fixtures) {
    const meta = profileMeta(p, f.profileId);
    if (!meta) continue;
    let refs = byProfile.get(f.profileId);
    if (!refs) {
      refs = [];
      byProfile.set(f.profileId, refs);
      labelOf.set(f.profileId, meta.label);
    }
    meta.heads.forEach((_, hi) => refs.push({ fixtureId: f.id, head: hi }));
  }
  for (const [profileId, heads] of byProfile) {
    if (heads.length < 2) continue;
    out.push({
      id: `auto-type-${profileId}`,
      name: `All ${labelOf.get(profileId) ?? profileId}`,
      heads,
      auto: `type:${profileId}`,
    });
  }

  // Per-truss: fixtures rigged on each truss bar (the explicit parentId link),
  // ordered ALONG the bar — chase order is walk-the-truss order, not patch
  // order. Heads within a fixture keep head order.
  const trusses = (p.props ?? []).filter((pr) => pr.kind === 'trussBar');
  trusses.forEach((truss, ti) => {
    const riders = p.fixtures
      .filter((f) => f.parentId === truss.id)
      .map((f) => ({ f, along: offsetOnParent(f, truss).along }))
      .sort((a, b) => a.along - b.along || (a.f.id < b.f.id ? -1 : 1));
    const heads = riders.flatMap(({ f }) => {
      const meta = profileMeta(p, f.profileId);
      return meta ? meta.heads.map((_, hi) => ({ fixtureId: f.id, head: hi })) : [];
    });
    if (heads.length < 2) return;
    out.push({
      id: `auto-truss-${truss.id}`,
      name: `Truss ${ti + 1}`,
      heads,
      auto: `truss:${truss.id}`,
    });
  });

  return out;
}

export type AutoGroupPlan = {
  create: Group[];
  /** tagged groups whose membership changed — heads are rewritten, the name
   *  (possibly still the generated one) is left alone */
  update: { existing: Group; heads: Group['heads'] }[];
  /** tagged groups whose source is gone (type unpatched, truss deleted) */
  remove: Group[];
};

const sameHeads = (a: Group['heads'], b: Group['heads']): boolean =>
  a.length === b.length && a.every((h, i) => h.fixtureId === b[i].fixtureId && h.head === b[i].head);

/** What a regenerate would do. Groups WITHOUT the auto tag are never touched —
 *  renaming or editing a derived group promotes it to authored, and authored
 *  groups are the operator's. */
export function planAutoGroups(p: Project): AutoGroupPlan {
  const desired = desiredAutoGroups(p);
  const tagged = p.groups.filter((g) => g.auto !== undefined);
  const desiredById = new Map(desired.map((g) => [g.id, g]));
  const existingById = new Map(tagged.map((g) => [g.id, g]));

  const create = desired.filter((g) => !existingById.has(g.id));
  const update = desired
    .filter((g) => existingById.has(g.id) && !sameHeads(existingById.get(g.id)!.heads, g.heads))
    .map((g) => ({ existing: existingById.get(g.id)!, heads: g.heads }));
  const remove = tagged.filter((g) => !desiredById.has(g.id));
  return { create, update, remove };
}

export function applyAutoGroups(p: Project, plan: AutoGroupPlan): void {
  const removeIds = new Set(plan.remove.map((g) => g.id));
  p.groups = p.groups.filter((g) => !removeIds.has(g.id));
  for (const { existing, heads } of plan.update) {
    const g = p.groups.find((x) => x.id === existing.id);
    if (g) g.heads = heads;
  }
  for (const g of plan.create) p.groups.push(g);
}
