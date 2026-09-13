// Patching helpers shared by the Rig view and the fixture library: where the
// next fixture goes, what it is called, what the table reads — and where a head
// has to point to land on a musician.
import type { FixtureCal, Project, StageProp, Vec3 } from '../../shared/types.ts';
import { STRUCTURE_DEFAULTS, clamp, isStructure, uid } from '../../shared/types.ts';
import { standingHeightAt } from '../../shared/beamThrow.ts';
import { PROP_LABEL } from './labels.ts';
import { profileMeta } from './profileInfo.ts';

/** The lowest address in `universeId` where `channels` fit without
 *  overlapping a patched fixture; 1 when nothing fits. */
export function nextFreeAddress(p: Project, universeId: string, channels: number): number {
  const used: [number, number][] = p.fixtures
    .filter((f) => f.universeId === universeId)
    .map((f) => [f.address, f.address + (profileMeta(p, f.profileId)?.channels ?? 1) - 1]);
  for (let a = 1; a + channels - 1 <= 512; a++) {
    if (used.every(([lo, hi]) => a + channels - 1 < lo || a > hi)) return a;
  }
  return 1;
}

/** What `+ add fixture…` asks for, all at once: the type, how many, which
 *  universe and where the first one starts (design #34, item 7). */
export type AddSpec = {
  profileId: string;
  model: string;
  channels: number;
  count: number;
  universeId: string;
  /** start address of the first one; the rest follow on consecutively */
  address: number;
};

/** Patch `count` fixtures of one type, consecutively addressed from
 *  `spec.address`, named after the model and numbered on from whatever this
 *  show already has. Returns the new ids, in the order they were added, so the
 *  caller can select them.
 *
 *  Anything that would run past channel 512 is not patched: a silently wrapped
 *  address is a fixture that answers to someone else's channels. */
export function addFixtures(p: Project, spec: AddSpec): string[] {
  const universeId = p.universes.some((u) => u.id === spec.universeId)
    ? spec.universeId
    : p.universes[0]?.id ?? 'u1';
  const channels = Math.max(1, spec.channels);
  let n = p.fixtures.filter((f) => f.profileId === spec.profileId).length;
  let addr = Math.max(1, Math.min(512, spec.address));
  const ids: string[] = [];
  for (let i = 0; i < Math.max(1, spec.count); i++) {
    if (addr + channels - 1 > 512) break;
    const id = uid('fx');
    n += 1;
    p.fixtures.push({
      id,
      name: `${spec.model} ${n}`,
      profileId: spec.profileId,
      universeId,
      address: addr,
      // spread along the front of the stage so a run of adds does not stack on
      // one spot — the same placement a single add has always used
      pos: { x: Math.round(((p.fixtures.length % 12) - 5.5) * 60) / 100, y: 2, z: 0 },
      rotY: 0,
    });
    ids.push(id);
    addr += channels;
  }
  return ids;
}

/** Add one fixture on `profileId` at the next free address of the first
 *  universe, named after its model and numbered. Returns its id. */
export function addFixture(p: Project, profileId: string, channels: number, model: string): string {
  const universeId = p.universes[0]?.id ?? 'u1';
  const [id] = addFixtures(p, {
    profileId,
    model,
    channels,
    count: 1,
    universeId,
    address: nextFreeAddress(p, universeId, channels),
  });
  return id;
}

/** A fixture's channels as the table prints them: one mono span, en dash, no
 *  spaces — `1–49`, never `1` over `–49` (design 2.9, R3). */
export function addressRange(address: number, channels: number): string {
  return `${address}–${address + Math.max(1, channels) - 1}`;
}

/** Does this fixture answer to what someone typed into `find…`? Name, address
 *  and universe, because those are the three things you are ever looking a
 *  fixture up by: what it is called, what it answers to, and where it is
 *  plugged. A bare number matches any fixture whose range covers it, so typing
 *  the address off a node's display finds the fixture on it. */
export function matchesFind(p: Project, fixtureId: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const f = p.fixtures.find((x) => x.id === fixtureId);
  if (!f) return false;
  const meta = profileMeta(p, f.profileId);
  const channels = meta?.channels ?? 1;
  if (f.name.toLowerCase().includes(q)) return true;
  if ((meta?.label ?? '').toLowerCase().includes(q)) return true;
  const uni = p.universes.find((u) => u.id === f.universeId);
  const uniIndex = p.universes.findIndex((u) => u.id === f.universeId) + 1;
  if ((uni?.label ?? '').toLowerCase().includes(q)) return true;
  if (addressRange(f.address, channels).includes(q)) return true;
  const n = Number(q);
  if (Number.isInteger(n) && n > 0) {
    if (n >= f.address && n <= f.address + channels - 1) return true;
    if (n === uniIndex) return true;
  }
  return false;
}

/** Fixtures whose address range overlaps another on the same universe, or runs
 *  off the end of it. O(n²) over the patch — call it behind a memo on the
 *  project, never per render. */
export function findConflicts(p: Project): Set<string> {
  const conflicts = new Set<string>();
  for (const a of p.fixtures) {
    const pa = profileMeta(p, a.profileId);
    if (!pa) continue;
    if (a.address < 1 || a.address + pa.channels - 1 > 512) {
      conflicts.add(a.id);
      continue;
    }
    for (const b of p.fixtures) {
      if (a.id === b.id || a.universeId !== b.universeId) continue;
      const pb = profileMeta(p, b.profileId);
      if (!pb) continue;
      if (a.address < b.address + pb.channels && b.address < a.address + pa.channels) {
        conflicts.add(a.id);
      }
    }
  }
  return conflicts;
}

// ---------------------------------------------------------------------------
// Aim: where a head has to point to land on something on the plan.
// ---------------------------------------------------------------------------

/** How high up a performer a beam is aimed, metres above whatever they are
 *  standing on. The shared figure is about 1.57 m to the crown
 *  (shared/figure.json segments), so this is the face and upper chest — where
 *  you point a light at a person, rather than at their feet or over their
 *  head. */
const PERSON_AIM_Y = 1.5;

/** Something on the plan a head can be pointed at. */
export type AimTarget = {
  /** the prop's id */
  id: string;
  /** what the menu calls it — numbered when the plan carries more than one */
  label: string;
  /** the world point to aim at, metres */
  point: Vec3;
  person: boolean;
};

/** The plan's musicians and structures, in stage order (left to right), each
 *  with the point a beam should land on: a person's face, the top of a riser
 *  you would light someone on, and the middle of anything else. */
export function aimTargets(project: Project): AimTarget[] {
  const props = project.props ?? [];
  const seen = new Map<string, number>();
  const count = new Map<string, number>();
  for (const pr of props) count.set(pr.kind, (count.get(pr.kind) ?? 0) + 1);
  return [...props]
    .sort((a, b) => a.pos.x - b.pos.x)
    .map((pr) => {
      const n = (seen.get(pr.kind) ?? 0) + 1;
      seen.set(pr.kind, n);
      const many = (count.get(pr.kind) ?? 1) > 1;
      const label = `${PROP_LABEL[pr.kind] ?? pr.kind}${many ? ` ${n}` : ''}`;
      return { id: pr.id, label, point: aimPointOf(props, pr), person: !isStructure(pr.kind) };
    });
}

/** The point on a prop a beam is aimed at. */
function aimPointOf(props: readonly StageProp[], pr: StageProp): Vec3 {
  if (!isStructure(pr.kind)) {
    return { x: pr.pos.x, y: standingHeightAt(props, pr.pos.x, pr.pos.z) + PERSON_AIM_Y, z: pr.pos.z };
  }
  const d = STRUCTURE_DEFAULTS[pr.kind];
  const size = pr.size ?? d ?? { w: 1, h: 1, d: 1 };
  const base = pr.y ?? d?.y ?? 0;
  // A riser is lit where people stand on it; everything else is lit where it is.
  const y = pr.kind === 'riser' ? base + size.h : base + size.h / 2;
  return { x: pr.pos.x, y, z: pr.pos.z };
}

/** What a head would be set to, and whether it can actually get there. */
export type AimSolution = {
  pan: number;
  tilt: number;
  /** false when the fixture's own limits stopped it short of the target */
  reach: boolean;
};

/**
 * The base aim that points a fixture at a world point — the inverse of the
 * render chain, clamped by the same calibration `shared/aim.ts` clamps by.
 *
 * `applyAim` takes a look's pan and tilt as deltas from centre, so a look that
 * asks for nothing (0.5, 0.5) resolves to exactly the base aim, clamped into
 * the head's soft limits. That is the whole of the inverse: solve for the
 * values the head must be DRIVEN to, then store them as the base. Which is
 * also why `swap` and the two inversions do not appear here — they mirror the
 * look's movement, never the focus (shared/aim.ts, step 3).
 *
 * The forward chain both stage views draw is
 *
 *     world = Ry(rotY)·Rx(rotX)·Rz(rotZ) · Ry(φ)·Rx(θ) · (0, −1, 0)
 *     φ = (0.5 − pan) · panDeg,  θ = (tilt − 0.5) · tiltDeg
 *
 * — the yoke sits between the fixture and its heads, so every head of a
 * multi-pixel mover swings with the body and the fixture's own origin is the
 * pivot to solve from.
 */
export function aimAtPoint(project: Project, fixtureId: string, point: Vec3): AimSolution | null {
  const f = project.fixtures.find((x) => x.id === fixtureId);
  const meta = f && profileMeta(project, f.profileId);
  if (!f || !meta || (!meta.hasPan && !meta.hasTilt)) return null;
  const dx = point.x - f.pos.x;
  const dy = point.y - f.pos.y;
  const dz = point.z - f.pos.z;
  if (Math.hypot(dx, dy, dz) < 1e-6) return null;

  // Into the fixture's own frame: the mount rotation, undone. Ry then Rx then
  // Rz applied in reverse order, each written out so it reads against
  // shared/geometry.ts's forward composition.
  const cy = Math.cos(f.rotY), sy = Math.sin(f.rotY);
  const x1 = cy * dx - sy * dz;
  const y1 = dy;
  const z1 = sy * dx + cy * dz;
  const cx = Math.cos(f.rotX ?? 0), sx = Math.sin(f.rotX ?? 0);
  const x2 = x1;
  const y2 = cx * y1 + sx * z1;
  const z2 = -sx * y1 + cx * z1;
  const cz = Math.cos(f.rotZ ?? 0), sz = Math.sin(f.rotZ ?? 0);
  const x3 = cz * x2 + sz * y2;
  const y3 = -sz * x2 + cz * y2;
  const z3 = z2;
  const len = Math.hypot(x3, y3, z3);
  const lx = x3 / len, ly = y3 / len, lz = z3 / len;

  // (0,−1,0) turned by Ry(φ)·Rx(θ) is (−sinφ·sinθ, −cosθ, −cosφ·sinθ).
  const theta = Math.acos(Math.min(1, Math.max(-1, -ly)));
  const phi = Math.atan2(-lx, -lz);
  const panDeg = Math.PI / 180 * (meta.panDeg || 540);
  const tiltDeg = Math.PI / 180 * (meta.tiltDeg || 270);
  const wrap = (a: number) => (a > Math.PI ? a - 2 * Math.PI : a <= -Math.PI ? a + 2 * Math.PI : a);
  // The same direction twice: over the top, and round the back. A head that
  // cannot pan far enough for one often reaches the other.
  const candidates: AimSolution[] = [
    solve(f.cal, 0.5 - phi / panDeg, 0.5 + theta / tiltDeg),
    solve(f.cal, 0.5 - wrap(phi + Math.PI) / panDeg, 0.5 - theta / tiltDeg),
  ];
  const reachable = candidates.find((c) => c.reach);
  if (reachable) return reachable;
  // Neither reaches: offer the one that misses by least, so the head still
  // turns the right way and the strip can say it cannot get there.
  const miss = (c: AimSolution, want: [number, number]) =>
    Math.abs(c.pan - want[0]) + Math.abs(c.tilt - want[1]);
  const wants: [number, number][] = [
    [0.5 - phi / panDeg, 0.5 + theta / tiltDeg],
    [0.5 - wrap(phi + Math.PI) / panDeg, 0.5 - theta / tiltDeg],
  ];
  return miss(candidates[0], wants[0]) <= miss(candidates[1], wants[1]) ? candidates[0] : candidates[1];
}

/** Clamp a solved pair into 0..1 and into the head's soft limits, exactly as
 *  `applyAim` does — low wins, so a limit pair the wrong way round reads as
 *  "stuck at the low limit" here too. */
function solve(cal: FixtureCal | undefined, pan: number, tilt: number): AimSolution {
  const pLo = clamp(cal?.panMin ?? 0);
  const pHi = Math.max(pLo, clamp(cal?.panMax ?? 1));
  const tLo = clamp(cal?.tiltMin ?? 0);
  const tHi = Math.max(tLo, clamp(cal?.tiltMax ?? 1));
  const p = clamp(pan, pLo, pHi);
  const t = clamp(tilt, tLo, tHi);
  return { pan: p, tilt: t, reach: Math.abs(p - pan) < 1e-6 && Math.abs(t - tilt) < 1e-6 };
}
