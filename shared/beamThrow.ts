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

/** Is a plan-view click inside a structural prop's footprint?
 *
 *  Shared with the 2D plan's hit-test. It used to be a circle of radius
 *  max(w,d)/2, which for the default 7 x 0.3 m truss bar is a 3.5 m grab radius
 *  — ~38 m² instead of ~2 m². Every plain click near centre stage selected the
 *  truss, fixtures rigged on it could not be picked, and a hurried double-click
 *  popped a removal dialog. Rotating the click into the prop's own frame and
 *  testing the rectangle is both correct and cheap.
 *
 *  `margin` keeps a thin bar grabbable — a 0.3 m-deep truss is under two pixels
 *  of tolerance at typical zoom without it. */
/** Height of the surface a performer standing at (x, z) is actually standing
 *  ON, in metres — 0 for the deck, or the top of the riser they are inside.
 *
 *  DERIVED, not authored, and that is the whole point. A performer has no
 *  height of their own: `sanitizeProject` deletes `y` from every non-structural
 *  prop, and it should keep doing so. The operator drags a drummer around a
 *  plan that already draws the risers; asking them to ALSO type a height that
 *  has to match whichever riser they happened to land on is a number that goes
 *  stale the first time the riser moves. Reading it from the scenery cannot go
 *  stale, needs no control, and moves the drummer when the riser moves.
 *
 *  Only risers count. A truss bar lying at deck level is not a thing you stand
 *  on, and a screen is not either.
 *
 *  Stacking falls out: a riser on a riser has the higher top, and the highest
 *  containing surface wins.
 *
 *  Twin of `floor_height_at` in previz/src/scene.rs — the native and web views
 *  must lift a figure by the same amount or the same show looks different in
 *  the two windows.
 */
export function standingHeightAt(
  // The minimal shape this actually reads, not `StageProp[]` — the previz's
  // own prop list is structurally typed and carries no id.
  props: readonly {
    kind: string;
    pos: { x: number; z: number };
    rotY?: number;
    size?: { w: number; h: number; d: number };
    y?: number;
  }[] | undefined,
  x: number,
  z: number,
): number {
  let top = 0;
  for (const pr of props ?? []) {
    if (pr.kind !== 'riser') continue;
    const s = pr.size ?? STRUCTURE_DEFAULTS.riser;
    // margin 0, unlike the click test this shares its maths with: being within
    // 15 cm of a riser's edge should not levitate someone standing beside it.
    if (!hitsPropFootprint({ x, z }, { pos: pr.pos, rotY: pr.rotY, size: s }, 0)) continue;
    top = Math.max(top, (pr.y ?? 0) + s.h);
  }
  return top;
}

export function hitsPropFootprint(
  click: { x: number; z: number },
  prop: { pos: { x: number; z: number }; rotY?: number; size: { w: number; d: number } },
  margin = 0.15,
): boolean {
  const dx = click.x - prop.pos.x;
  const dz = click.z - prop.pos.z;
  // canonical yaw (local +X → (cos θ, 0, −sin θ)): rotate the click into the
  // prop's frame with the inverse rotation, matching how the plan view now
  // paints the rectangle
  const ry = prop.rotY ?? 0;
  const c = Math.cos(ry);
  const s = Math.sin(ry);
  const lx = dx * c - dz * s;
  const lz = dx * s + dz * c;
  return Math.abs(lx) <= prop.size.w / 2 + margin && Math.abs(lz) <= prop.size.d / 2 + margin;
}
