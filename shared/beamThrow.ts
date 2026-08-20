// How far a beam travels before it lands on something.
//
// A cone of fixed length says nothing about the room. The same fixture 2 m off
// a riser and 9 m off the back wall drew the same stub, which is exactly the
// judgement previz exists to support. So each beam is cut at the first opaque
// thing along its axis: the floor, and whatever structure the plot places.
//
// Pure, and free of any renderer: this runs for every beam of every moving head
// on every frame — a 128-fixture rig is ~500 beams — so it is analytic slab
// tests rather than a scene-graph raycaster, and it lives here so it can be
// tested against numbers instead of eyeballed in a 3D view.
//
// Performers are deliberately NOT occluders. A capsule is a poor stand-in for a
// person, and a beam clipped on someone's shoulder reads worse than one that
// passes through.

import { STRUCTURE_DEFAULTS, isStructure, type Project } from './types.ts';

export type Vec3 = { x: number; y: number; z: number };
export type Occluder = { min: Vec3; max: Vec3 };

/** Longest beam drawn when nothing is in the way — past this the cone is
 *  scenery rather than information, and an unbounded one hides the rig. */
export const MAX_THROW = 14;
/** A fixture buried in a riser still shows a stub, so it stays selectable. */
export const MIN_THROW = 0.35;

/** Axis-aligned boxes for the structural props in a project.
 *
 *  A rotated prop is kept axis-aligned by expanding its footprint. That is a
 *  conservative error on purpose: stopping a beam slightly early is a better
 *  failure than punching one through a screen. */
export function buildOccluders(project: Project): Occluder[] {
  const out: Occluder[] = [];
  for (const pr of project.props ?? []) {
    if (!isStructure(pr.kind)) continue;
    const d = STRUCTURE_DEFAULTS[pr.kind];
    const s = pr.size ?? d;
    if (!s) continue;
    const ry = pr.rotY ?? 0;
    const c = Math.abs(Math.cos(ry));
    const sn = Math.abs(Math.sin(ry));
    const hx = (s.w / 2) * c + (s.d / 2) * sn;
    const hz = (s.w / 2) * sn + (s.d / 2) * c;
    const y0 = pr.y ?? d?.y ?? 0;
    out.push({
      min: { x: pr.pos.x - hx, y: y0, z: pr.pos.z - hz },
      max: { x: pr.pos.x + hx, y: y0 + s.h, z: pr.pos.z + hz },
    });
  }
  return out;
}

const AXES = ['x', 'y', 'z'] as const;

/** Distance along a unit `dir` from `o` to the first surface, else MAX_THROW. */
export function throwDistance(o: Vec3, dir: Vec3, occ: Occluder[]): number {
  let best = MAX_THROW;

  // the floor at y = 0, which a climbing beam never reaches
  if (dir.y < -1e-4) {
    const t = -o.y / dir.y;
    if (t > 0 && t < best) best = t;
  }

  for (const b of occ) {
    let t0 = 0;
    let t1 = best;
    let hit = true;
    for (const ax of AXES) {
      const dd = dir[ax];
      if (Math.abs(dd) < 1e-9) {
        // parallel to this slab: only a ray already inside it can hit
        if (o[ax] < b.min[ax] || o[ax] > b.max[ax]) {
          hit = false;
          break;
        }
        continue;
      }
      const inv = 1 / dd;
      let a = (b.min[ax] - o[ax]) * inv;
      let z = (b.max[ax] - o[ax]) * inv;
      if (a > z) {
        const tmp = a;
        a = z;
        z = tmp;
      }
      if (a > t0) t0 = a;
      if (z < t1) t1 = z;
      if (t0 > t1) {
        hit = false;
        break;
      }
    }
    // t0 <= 0 means the origin is inside the box; a fixture rigged on a truss
    // must not clip itself to nothing, so only forward hits count
    if (hit && t0 > 1e-4 && t0 < best) best = t0;
  }
  return Math.max(MIN_THROW, best);
}
