// The band, in three.js — the same figures the native previz draws.
//
// Every number here comes from `shared/figure.json`, which previz/src/figure.rs
// also reads. That file exists because these two renderers were independent
// hand-copies, and the web one was still drawing an armless capsule pawn three
// commits after the native figures grew limbs, arms and instruments they could
// actually hold. There is nothing to keep in step now: change the JSON and both
// views change.
//
// The one thing that IS duplicated is the maths, and it is duplicated
// deliberately and minimally: `bone`, `chain`, and the two hash functions. Each
// has a comment saying what it must agree with.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import FIG from '../../../shared/figure.json';

type V3 = [number, number, number];
const v3 = (a: number[]) => new THREE.Vector3(a[0], a[1], a[2]);

/** Materials, from the shared file so both views shade the same.
 *
 *  Hoisted and SHARED, not rebuilt per band: the prop teardown in Previz3D
 *  disposes every mesh's material, so a fresh set each rebuild would either
 *  churn five programs a frame during a drag or — once shared — be disposed out
 *  from under the meshes still using them. Anything holding these is tagged
 *  `userData.shared` and the teardown skips it. */
const MATS: Record<string, THREE.MeshStandardMaterial> = Object.fromEntries(
  Object.entries(FIG.materials).map(([name, m]) => [
    name,
    new THREE.MeshStandardMaterial({
      color: new THREE.Color(m.color),
      roughness: m.roughness,
      metalness: m.metallic,
    }),
  ]),
);

/** Body-part geometry, built once and cloned per use.
 *
 *  Bevy's `Capsule3d(radius, length)` and three's `CapsuleGeometry(radius,
 *  height)` both mean the CYLINDRICAL SECTION, not the total height, so the two
 *  numbers in the shared file transcribe 1:1 with no conversion. Getting that
 *  wrong would silently change every limb length. */
const partGeo = (() => {
  const g: Record<string, THREE.BufferGeometry> = {};
  for (const [name, m] of Object.entries(FIG.meshes)) {
    g[name] =
      m.kind === 'capsule'
        ? new THREE.CapsuleGeometry((m as { radius: number }).radius, (m as { length: number }).length, 3, 8)
        : new THREE.BoxGeometry(...((m as { size: number[] }).size as [number, number, number]));
  }
  // unit primitives — the scale IS the size
  g.ball = new THREE.SphereGeometry(0.5, 12, 8);
  g.cube = new THREE.BoxGeometry(1, 1, 1);
  g.cyl = new THREE.CylinderGeometry(0.5, 0.5, 1, 10);
  return g;
})();

const UP = new THREE.Vector3(0, 1, 0);

/** Place a Y-up, origin-centred segment so it runs from joint `a` to `b`.
 *
 *  Twin of `bone` in previz/src/figure.rs. `setFromUnitVectors` is the same
 *  minimal arc as bevy's `Quat::from_rotation_arc`. */
function bone(a: THREE.Vector3, b: THREE.Vector3): THREE.Matrix4 {
  const d = b.clone().sub(a);
  const len = d.length();
  const q = new THREE.Quaternion();
  if (len > 1e-6) q.setFromUnitVectors(UP, d.clone().divideScalar(len));
  return new THREE.Matrix4().compose(a.clone().add(b).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1));
}

/** Walk a chain of (length, direction) from `start`, returning every joint.
 *  Twin of `chain` in previz/src/figure.rs — directions are normalised HERE, so
 *  the tables stay readable. */
function chain(start: THREE.Vector3, segs: [number, THREE.Vector3][]): THREE.Vector3[] {
  const out = [start.clone()];
  let p = start.clone();
  for (const [len, dir] of segs) {
    const n = dir.clone();
    if (n.lengthSq() > 1e-12) n.normalize();
    else n.set(0, -1, 0);
    p = p.clone().add(n.multiplyScalar(len));
    out.push(p);
  }
  return out;
}

/** FNV-1a over the prop's stable id. Twin of `seed_of` in figure.rs.
 *
 *  Must agree BIT FOR BIT or the same musician is a different height in the two
 *  windows — hence `Math.imul` and the `>>> 0` after every step, which is how
 *  you get Rust's `wrapping_mul` on u32 out of JavaScript's doubles. Prop ids
 *  are ASCII, so `charCodeAt` and Rust's `as_bytes` agree. */
function seedOf(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h = (h ^ (id.charCodeAt(i) & 0xff)) >>> 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** The k-th uniform in [0, 1) for a seed. Twin of `rnd` in figure.rs. */
function rnd(seed: number, k: number): number {
  let h = (seed ^ Math.imul(k, 0x9e3779b9)) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  h = Math.imul(h, 0x7feb352d) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  h = Math.imul(h, 0x846ca68b) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return (h >>> 8) / 16777216;
}
const stream = (seed: number, name: keyof typeof FIG.variation.streams) =>
  rnd(seed, FIG.variation.streams[name]);

type Bucket = Record<string, THREE.BufferGeometry[]>;
const push = (b: Bucket, mat: string, geo: THREE.BufferGeometry, m: THREE.Matrix4) => {
  (b[mat] ??= []).push(geo.clone().applyMatrix4(m));
};

type Leg = { thigh: number[]; shank: number[]; toe: number };
type KindSpec = (typeof FIG.kinds)[keyof typeof FIG.kinds];

function legsOf(sp: Leg[]): Leg[] {
  return sp;
}
function mirrorLegs(l: Leg[]): Leg[] {
  const f = (x: Leg): Leg => ({
    thigh: [-x.thigh[0], x.thigh[1], x.thigh[2]],
    shank: [-x.shank[0], x.shank[1], x.shank[2]],
    toe: -x.toe,
  });
  return [f(l[1]), f(l[0])];
}

/** Resolve a kind's pose. Twin of `pose_for` in figure.rs, including which
 *  kinds are allowed to be mirrored (only the fallback — a guitarist reversed
 *  would hold the instrument on the wrong side). */
function poseFor(kind: string, seed: number) {
  const k = ((FIG.kinds as Record<string, KindSpec>)[kind] ?? FIG.kinds.default) as KindSpec & {
    pelvis?: number[];
    legs?: Leg[];
    feet?: { pos: number[]; rotX: number; rotY: number }[];
  };
  let pelvis: THREE.Vector3;
  let legs: Leg[];
  if (k.pelvis && k.legs) {
    pelvis = v3(k.pelvis);
    legs = legsOf(k.legs);
  } else {
    const named = (FIG.stances as Record<string, { pelvisY: number; legs: Leg[] }>)[k.stance];
    if (named) {
      pelvis = new THREE.Vector3(0, named.pelvisY, 0);
      legs = legsOf(named.legs);
    } else {
      const names = ['even', 'shift', 'wide'] as const;
      const pick = Math.min(2, Math.floor(stream(seed, 'stance') * 3));
      const st = (FIG.stances as Record<string, { pelvisY: number; legs: Leg[] }>)[names[pick]];
      pelvis = new THREE.Vector3(0, st.pelvisY, 0);
      legs = legsOf(st.legs);
      if (stream(seed, 'mirror') < 0.5) legs = mirrorLegs(legs);
    }
  }
  return { ...k, pelvis, legs };
}

/** Emit one figure's body into the world-space buckets. */
function emitBody(b: Bucket, pose: ReturnType<typeof poseFor>, seed: number, root: THREE.Matrix4) {
  const S = FIG.segments;
  const stature = FIG.variation.statureBase + FIG.variation.statureRange * stream(seed, 'stature');
  // The stature node is a pure scale about the origin, so the sole stays at
  // y = 0 for every height — which is what lets the prop root's Y be the deck.
  const body = root.clone().multiply(new THREE.Matrix4().makeScale(stature, stature, stature));
  const put = (mat: string, geo: string, m: THREE.Matrix4) => push(b, mat, partGeo[geo], body.clone().multiply(m));

  put('cloth', 'pelvis', new THREE.Matrix4().setPosition(pose.pelvis));
  pose.legs.forEach((leg, i) => {
    const sx = i === 0 ? -1 : 1;
    const hip = pose.pelvis.clone().add(new THREE.Vector3(sx * S.hipX, 0, 0));
    const j = chain(hip, [
      [S.thigh, v3(leg.thigh)],
      [S.shank, v3(leg.shank)],
    ]);
    put('cloth', 'thigh', bone(j[0], j[1]));
    put('cloth', 'shank', bone(j[1], j[2]));
    const f = pose.feet?.[i];
    const m = new THREE.Matrix4();
    if (f) {
      m.makeRotationFromEuler(new THREE.Euler(f.rotX, f.rotY, 0, 'YXZ')).setPosition(v3(f.pos));
    } else {
      // Sole pinned to the deck; the shank's lower cap covers the slack. This
      // is what gives the figure a contact shadow instead of floating above it.
      m.makeRotationY(leg.toe).setPosition(new THREE.Vector3(j[2].x, S.footLift, j[2].z + 0.075));
    }
    put('cloth', 'foot', m);
  });

  const n = (a: number[]) => {
    const x = v3(a);
    return x.lengthSq() > 1e-12 ? x.normalize() : new THREE.Vector3(0, 1, 0);
  };
  const waist = pose.pelvis.clone().add(n(pose.spine.lumbar).multiplyScalar(S.lumbar));
  const flatten = (s: number[]) => new THREE.Matrix4().makeScale(s[0], s[1], s[2]);
  put('cloth', 'abdomen', bone(pose.pelvis, waist).multiply(flatten(FIG.trunkFlatten.abdomen)));

  // Everything above the waist rides one node so the per-figure shoulder turn
  // is an exact parent rotation. It must NOT be baked into joint positions: the
  // trunk capsules carry a non-uniform scale and the minimal-arc rotation would
  // tilt the flattening.
  const yaw = (stream(seed, 'torsoYaw') - 0.5) * FIG.variation.torsoYawRange;
  const nbW = waist.clone().add(n(pose.spine.thorax).multiplyScalar(S.thorax));
  const chinW = nbW.clone().add(n(pose.spine.neck).multiplyScalar(S.neck));
  const headW = chinW.clone().add(n(pose.spine.head).multiplyScalar(S.head));
  const upper = body
    .clone()
    .multiply(new THREE.Matrix4().makeTranslation(waist.x, waist.y, waist.z))
    .multiply(new THREE.Matrix4().makeRotationY(yaw));
  const nb = nbW.clone().sub(waist);
  const chin = chinW.clone().sub(waist);
  const headC = headW.clone().sub(waist);
  const up = (mat: string, geo: string, m: THREE.Matrix4) => push(b, mat, partGeo[geo], upper.clone().multiply(m));

  up('cloth', 'chest', bone(new THREE.Vector3(), nb).multiply(flatten(FIG.trunkFlatten.chest)));
  up('skin', 'neck', bone(nb, chin));
  const hp = pose.headPitch + (stream(seed, 'headPitch') - 0.5) * FIG.variation.headPitchRange;
  const hy = pose.headYaw + (stream(seed, 'headYaw') - 0.5) * FIG.variation.headYawRange;
  up(
    'skin',
    'ball',
    new THREE.Matrix4()
      .makeRotationFromEuler(new THREE.Euler(hp, hy, 0, 'YXZ'))
      .setPosition(headC)
      .scale(v3(FIG.head.scale)),
  );
  for (const sx of [-1, 1]) {
    const o = FIG.deltoid.offset;
    up(
      'skin',
      'ball',
      new THREE.Matrix4()
        .makeScale(FIG.deltoid.scale, FIG.deltoid.scale, FIG.deltoid.scale)
        .setPosition(nb.clone().add(new THREE.Vector3(sx * o[0], o[1], o[2]))),
    );
  }
  for (const [arm, sx] of [
    [pose.armR, -1],
    [pose.armL, 1],
  ] as [number[][], number][]) {
    const o = FIG.shoulder.offset;
    const sho = nb.clone().add(new THREE.Vector3(sx * o[0], o[1], o[2]));
    const j = chain(sho, [
      [S.uarm, v3(arm[0])],
      [S.farm, v3(arm[1])],
      [S.hand, v3(arm[2])],
    ]);
    up('cloth', 'uarm', bone(j[0], j[1]));
    up('cloth', 'farm', bone(j[1], j[2]));
    up('skin', 'hand', bone(j[2], j[3]));
  }
  return stature;
}

type PartSpec = {
  mesh: string;
  mat: string;
  size?: number[];
  pos?: number[];
  from?: number[];
  to?: number[];
  thick?: number;
  rotX?: number;
  rotY?: number;
  rotZ?: number;
  alignTo?: number[][];
};

function emitPart(b: Bucket, sp: PartSpec, frame: THREE.Matrix4) {
  if (sp.from && sp.to && sp.thick) {
    const a = v3(sp.from);
    const z = v3(sp.to);
    const m = bone(a, z).multiply(
      new THREE.Matrix4().makeScale(sp.thick, z.clone().sub(a).length(), sp.thick),
    );
    push(b, sp.mat, partGeo[sp.mesh], frame.clone().multiply(m));
    return;
  }
  const q = new THREE.Quaternion();
  if (sp.alignTo) {
    const m = bone(v3(sp.alignTo[0]), v3(sp.alignTo[1]));
    m.decompose(new THREE.Vector3(), q, new THREE.Vector3());
  }
  // alignTo first, then the local rotations on top — a headstock follows the
  // neck it is on the end of, and is then angled back from it.
  q.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(sp.rotX ?? 0, sp.rotY ?? 0, sp.rotZ ?? 0, 'ZYX')));
  const s = sp.size ? v3(sp.size) : new THREE.Vector3(1, 1, 1);
  const m = new THREE.Matrix4().compose(sp.pos ? v3(sp.pos) : new THREE.Vector3(), q, s);
  push(b, sp.mat, partGeo[sp.mesh], frame.clone().multiply(m));
}

/** One performer and their instrument, emitted into world-space buckets. */
export function emitPerformer(b: Bucket, kind: string, id: string, root: THREE.Matrix4) {
  const seed = seedOf(id);
  const pose = poseFor(kind, seed);
  const stature = emitBody(b, pose, seed, root);

  for (const sp of ((FIG.instruments as Record<string, PartSpec[]>)[kind] ?? [])) {
    emitPart(b, sp, root);
  }
  if (kind !== 'drummer') return;

  // The stool is the one instrument part that scales WITH the player, or a tall
  // drummer floats above their own seat.
  const body = root.clone().multiply(new THREE.Matrix4().makeScale(stature, stature, stature));
  const st = FIG.drumStool;
  emitPart(b, st.seat as PartSpec, body);
  emitPart(b, st.post as PartSpec, body);
  for (let k = 0; k < st.legs.count; k++) {
    const t = Math.PI / 2 + (k * Math.PI * 2) / st.legs.count;
    const from = v3(st.legs.from);
    emitPart(
      b,
      {
        mesh: 'cyl',
        mat: 'metal',
        from: st.legs.from,
        to: [from.x + st.legs.radius * Math.cos(t), st.legs.y, from.z + st.legs.radius * Math.sin(t)],
        thick: st.legs.thick,
      },
      body,
    );
  }
  for (const sp of FIG.drumKit as PartSpec[]) emitPart(b, sp, root);

  // Sticks, aimed from each hand at what that hand is about to hit.
  const S = FIG.segments;
  const n = (a: number[]) => {
    const x = v3(a);
    return x.lengthSq() > 1e-12 ? x.normalize() : new THREE.Vector3(0, 1, 0);
  };
  const waist = pose.pelvis.clone().add(n(pose.spine.lumbar).multiplyScalar(S.lumbar));
  const nb = waist.clone().add(n(pose.spine.thorax).multiplyScalar(S.thorax));
  const sk = FIG.sticks;
  for (const [arm, sx, target] of [
    [pose.armR, -1, sk.targetR],
    [pose.armL, 1, sk.targetL],
  ] as [number[][], number, number[]][]) {
    const o = FIG.shoulder.offset;
    const sho = nb.clone().add(new THREE.Vector3(sx * o[0], o[1], o[2]));
    const j = chain(sho, [
      [S.uarm, v3(arm[0])],
      [S.farm, v3(arm[1])],
      [S.hand, v3(arm[2])],
    ]);
    // The hands live under the stature-scaled body; the kit does not.
    const hand = j[3].clone().multiplyScalar(stature);
    const tip = hand.clone().add(v3(target).sub(hand).normalize().multiplyScalar(sk.length));
    emitPart(
      b,
      { mesh: 'cyl', mat: sk.mat, from: [hand.x, hand.y, hand.z], to: [tip.x, tip.y, tip.z], thick: sk.thick },
      root,
    );
  }
}

/** One figure's merged geometry, in its OWN frame, cached by kind and id.
 *
 *  three does not batch, so 21 body parts plus a drum kit is ~40 draw calls per
 *  player if left as separate meshes. Merged per material it is three, or five
 *  for the drummer.
 *
 *  Cached and built in the figure's own frame rather than baked into world
 *  space, and that is the load-bearing part. Baking the root in meant every
 *  prop drag re-emitted and re-merged the whole band — measured at 5.8 ms a
 *  frame for five players and rising linearly, on the thread that serves the
 *  live console. In its own frame the geometry does not change when the figure
 *  moves, so a drag is an Object3D transform and costs nothing.
 *
 *  The cache owns these buffers for the life of the page. Meshes built from
 *  them are tagged `userData.shared` so the prop teardown does not dispose
 *  geometry that other rebuilds still need. */
const CACHE = new Map<string, { mat: string; geo: THREE.BufferGeometry }[]>();

function figureGeometry(kind: string, id: string) {
  const key = `${kind}|${id}`;
  const hit = CACHE.get(key);
  if (hit) return hit;
  const b: Bucket = {};
  emitPerformer(b, kind, id, new THREE.Matrix4());
  const built: { mat: string; geo: THREE.BufferGeometry }[] = [];
  for (const [mat, geos] of Object.entries(b)) {
    if (!geos.length) continue;
    const merged = mergeGeometries(geos, false);
    for (const g of geos) g.dispose();
    if (!merged) {
      // mergeGeometries only console.errors and returns null, which would drop
      // a whole material silently — a limbless figure mid-show and a log line
      // nobody reads.
      console.error(`[figure] could not merge ${geos.length} ${mat} parts for ${key}`);
      continue;
    }
    merged.computeVertexNormals();
    built.push({ mat, geo: merged });
  }
  CACHE.set(key, built);
  return built;
}

/** One posed musician with their instrument, ready to position. */
export function buildFigure(kind: string, id: string): THREE.Group {
  const g = new THREE.Group();
  for (const { mat, geo } of figureGeometry(kind, id)) {
    const m = new THREE.Mesh(geo, MATS[mat] ?? MATS.cloth);
    m.userData.shared = true; // the teardown must not dispose these
    g.add(m);
  }
  return g;
}

// The shared file is the only thing standing between a typo and a silently
// empty band: TypeScript checks the shape at build time but nothing checks that
// the file on disk still has these keys at run time.
for (const k of ['segments', 'meshes', 'stances', 'kinds', 'variation', 'instruments'] as const) {
  if (!FIG[k]) throw new Error(`shared/figure.json is missing "${k}"`);
}

export const _test = { seedOf, rnd, figureGeometry };
