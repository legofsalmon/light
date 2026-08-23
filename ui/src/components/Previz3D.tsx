import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { isStructure } from '../../../shared/types.ts';
import type { HeadSnap, Project } from '../../../shared/types.ts';
import { profileMeta } from '../profileInfo.ts';
import { useStore } from '../store.ts';
import { buildOccluders, standingHeightAt, throwDistance, type Occluder } from '../../../shared/beamThrow.ts';

type HeadHandle = {
  key: string;
  kind: string;
  beams: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshBasicMaterial>[];
  glow: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial> | null;
  ring: THREE.Mesh<THREE.TorusGeometry, THREE.MeshBasicMaterial> | null;
  fan: THREE.Group | null;
  pan: THREE.Group | null;
  tilt: THREE.Group | null;
  /** Beams carried by a FIXTURE-level yoke (a pixel mover like a Spiider):
   *  every one of them has to re-cut when the fixture turns, not just the
   *  head that happens to own the yoke handle. */
  aimBeams?: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshBasicMaterial>[];
  spin: number;
  /** last zoom applied to this head's cones, so static beams re-cut only on change */
  lastZoom: number | undefined;
  cur: { r: number; g: number; b: number; i: number };
};

/** How far an emitter may sit from the pan anchor on a fixture that aims.
 *  A moving head is a head, not a bar: everything it emits from is within
 *  ~120 mm of the yoke. */
const AIM_EMITTER_RADIUS = 0.12;

/** Eye adaptation.
 *
 *  Beams are additive volumes, so the light in the frame adds up without any
 *  ceiling: metered by reading the framebuffer back on the demo rig, a
 *  full-blast look accumulates more than 60× display white across most of the
 *  picture. No tone curve rescues that on its own — PBR Neutral is inside 1%
 *  of white by an input of 6 — so the exposure has to move, the way a camera's
 *  does walking from a verse into a chorus.
 *
 *  `exposure = KEY / lum ^ STRENGTH`, where `lum` is the perceptual light the
 *  rig is putting into the room this frame, scaled by the beam-viz setting
 *  because that is genuinely how much of it the "camera" can see.
 *
 *  KEY was fitted by eye against the demo show's 153 heads, metered per cue
 *  across five decks: the brightest cue in the show is the Drop on every deck,
 *  at lum 11.7–19.5, and it photographs correctly at exposure ≈ 0.023; the
 *  Intro meters 4.1 and lands at 0.058.
 *
 *  Re-fit if the tone curve below changes — the constant is curve-specific and
 *  not even comparable across a swap, because three.js pre-divides ACES's
 *  exposure by 0.6 and Neutral's not at all. Neutral's usable window is also
 *  TIGHT: on the Drop, 0.022 is a photograph and 0.042 is a white sheet. It is
 *  near-identity below its 0.76 shoulder and then compresses hard, where ACES
 *  rolled off over decades — so the metering has to be more accurate than it
 *  used to be, and when in doubt it should err dark, because a dark frame
 *  still shows colour and structure and a blown one shows neither. A cue
 *  carrying a strobe swings a good part of that window on its own (the Drop
 *  runs 0.27–0.50 of display scale), so the target sits low enough that the
 *  LIT frames still hold.
 *
 *  Known limit: `lum` is the light LEAVING the rig, not the light landing on
 *  the camera, so it cannot see how CONCENTRATED a look is. A tight warm wash
 *  can read brighter on screen than a Drop carrying three times the light
 *  spread across the room. Metering the frame itself would fix it and costs a
 *  readback or a second render pass — not worth it on a surface that shares a
 *  laptop with a live show.
 *
 *  STRENGTH is PARTIAL on purpose. At 1 the adaptation would cancel every
 *  change and the previz would be useless as a lighting tool — you would push
 *  the master and watch nothing happen. At 0.6, 3.5× the light on stage still
 *  reads about 1.7× brighter: the direction and the feel survive, the clipping
 *  does not.
 *
 *  The ceiling is 1.0 — never brighter than an unadapted frame. A real eye
 *  keeps opening up in the dark, but a previz that quietly brightens a blackout
 *  makes "is the rig actually out?" impossible to answer at a glance. */
const ADAPT_KEY = 0.135;
const ADAPT_STRENGTH = 0.6;
const ADAPT_DOWN_S = 0.25;
const ADAPT_UP_S = 1.2;
const clampExposure = (e: number) => Math.min(1, Math.max(0.006, e));

function makeBeam(deg: number, len: number): THREE.Mesh<THREE.CylinderGeometry, THREE.MeshBasicMaterial> {
  const rad = (deg * Math.PI) / 180;
  const geo = new THREE.CylinderGeometry(0.012, Math.tan(rad / 2) * len + 0.02, len, 18, 1, true);
  geo.translate(0, -len / 2, 0);
  // fitBeam scales against this, so the cone can be re-cut without rebuilding
  // geometry every time a mover turns
  const mat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.userData.baseLen = len;
  return mesh;
}

// Beam cones are cut at the first opaque surface; the geometry lives in
// shared/beamThrow.ts so it can be tested against numbers.

const _o = new THREE.Vector3();
const _d = new THREE.Vector3();

/** How much wider or narrower a zoom value makes the beam.
 *
 *  A compiled profile carries ONE beam angle — GDTF's physical zoom range is
 *  not surfaced by the interpreter — so there is no honest way to compute the
 *  real angle at a given zoom. This is a deliberate visual approximation: zoom
 *  0 reads about half the profile's angle, 1 about double, 0.5 leaves it as
 *  drawn. It shows the operator that zoom is doing something and roughly how
 *  much, which is the judgement the previz exists for; it is not a photometric
 *  claim. If profiles ever carry the physical range, this becomes real. */
function zoomSpread(zm: number | undefined): number {
  if (zm === undefined) return 1; // nobody asked — keep the profile's own angle
  return 0.5 + Math.max(0, Math.min(1, zm)) * 1.5;
}

/** Scale one beam so its cone ends where the light lands, at the current zoom.
 *
 *  The cone is built along local -Y with its spread proportional to its length,
 *  so scaling all three axes together keeps the beam angle as built. Widening
 *  is therefore a separate factor on the two lateral axes only. */
function fitBeam(
  beam: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshBasicMaterial>,
  occ: Occluder[],
  spread = 1,
): void {
  const base = (beam.userData.baseLen as number) || 1;
  const m = beam.matrixWorld.elements;
  _o.set(m[12], m[13], m[14]);
  // -Y column, normalised out of the parent's scale
  _d.set(-m[4], -m[5], -m[6]).normalize();
  const k = throwDistance(_o, _d, occ) / base;
  beam.scale.set(k * spread, k, k * spread);
}

function basicBox(w: number, h: number, d: number, color: number): THREE.Mesh {
  return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshBasicMaterial({ color }));
}

function fixtureSignature(p: Project): string {
  return JSON.stringify([
    p.fixtures.map((f) => [f.id, f.profileId, f.pos, f.rotY, f.rotX ?? 0, f.rotZ ?? 0]),
    // imported profiles can change shape (e.g. pixel-head upgrades) without
    // any fixture field changing — and since B1's layout editor, the OFFSETS
    // can change without the head count changing, so they sign too
    Object.entries(p.profiles ?? {}).map(([id, cp]) => [
      id,
      cp.heads.length,
      cp.beamDeg,
      cp.heads.map((h) => [h.offset, h.offsetY ?? 0]),
    ]),
  ]);
}

function buildRig(project: Project): {
  group: THREE.Group;
  handles: HeadHandle[];
  occ: Occluder[];
} {
  const group = new THREE.Group();
  const handles: HeadHandle[] = [];

  for (const f of project.fixtures) {
    const prof = profileMeta(project, f.profileId);
    if (!prof) continue;
    const fg = new THREE.Group();
    fg.position.set(f.pos.x, f.pos.y, f.pos.z);
    fg.rotation.order = 'YXZ'; // yaw, then mounting tilt, then roll
    fg.rotation.set(f.rotX ?? 0, f.rotY, f.rotZ ?? 0);

    // body — a bar for a bar, a head for a head. A multi-pixel fixture that
    // AIMS is a moving head with a pixel face, not a metre of truss: drawing
    // the bar made a Spiider look like a static bar whose beams pivoted around
    // its middle, which is exactly the wrong story about where the light comes
    // from. (canAim is computed just below; hoisted for the body.)
    const bodyAims = !!prof.hasPan || !!prof.hasTilt;
    if (prof.heads.length > 1 && !bodyAims) fg.add(basicBox(1.06, 0.09, 0.09, 0x2c2c33));
    else if (prof.heads.length > 1) fg.add(basicBox(0.3, 0.24, 0.24, 0x2c2c33));
    else if (prof.heads[0]?.kind === 'derby') fg.add(basicBox(0.26, 0.2, 0.2, 0x2c2c33));
    else if (prof.heads[0]?.kind === 'hazer') fg.add(basicBox(0.34, 0.26, 0.26, 0x232328));
    else fg.add(basicBox(0.16, 0.14, 0.16, 0x2c2c33));

    // Can this fixture AIM? Ask the channels, not the head kind — the same
    // test the look editor and the patch table use. A Robin Spiider is a
    // moving head whose emitters are pixels: its compiled profile is `rgb`
    // heads with a Pan channel, so gating the yoke on `kind === 'mover'` left
    // the beams nailed in place while the editor set pan/tilt, the snapshot
    // carried them and the real fixture moved. Only the previz disagreed.
    //
    // The yoke goes between the fixture and its heads, because that is where
    // it is on the truss: panning a Spiider swings every pixel with it.
    const canAim = !!prof.hasPan || !!prof.hasTilt;
    const hasMoverHead = prof.heads.some((h) => h.kind === 'mover');
    let panG: THREE.Group | null = null;
    let tiltG: THREE.Group | null = null;
    if (canAim && !hasMoverHead) {
      panG = new THREE.Group();
      tiltG = new THREE.Group();
      panG.add(tiltG);
      fg.add(panG);
    }
    const aimBeams: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshBasicMaterial>[] = [];

    // Emitters on a moving head sit ON the head, within a hand's width of the
    // pivot — but a synthesised pixel layout spreads them across the fixture's
    // nominal width with no idea of its real size (a Robin Spiider's two zones
    // come out 600 mm apart). Swinging those on the yoke puts each beam's
    // origin on a 300 mm arm around the pan anchor, which reads as the light
    // starting somewhere other than where it pivots. Compress the spread to
    // head scale for fixtures that aim; a static bar keeps its real layout,
    // where the spread IS the fixture.
    const spread = prof.heads.reduce((m, h) => Math.max(m, Math.abs(h.offset)), 0);
    const aimScale = tiltG && spread > AIM_EMITTER_RADIUS ? AIM_EMITTER_RADIUS / spread : 1;

    prof.heads.forEach((hd, hi) => {
      const headRoot = new THREE.Group();
      // 2D pixel layouts (B1): offsetY lifts a head up the fixture's local Y,
      // so a Spiider's rings and a matrix panel read as their real shape
      headRoot.position.set(hd.offset * aimScale, (hd.offsetY ?? 0) * aimScale, 0);
      (tiltG ?? fg).add(headRoot);

      const handle: HeadHandle = {
        key: `${f.id}:${hi}`,
        kind: hd.kind,
        beams: [],
        glow: null,
        ring: null,
        fan: null,
        pan: null,
        tilt: null,
        spin: 0,
        lastZoom: undefined,
        cur: { r: 0, g: 0, b: 0, i: 0 },
      };

      const glow = new THREE.Mesh(
        new THREE.SphereGeometry(0.055, 12, 12),
        new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false })
      );
      headRoot.add(glow);
      handle.glow = glow;

      if (hd.kind === 'derby') {
        const aim = new THREE.Group();
        aim.rotation.x = -0.55; // down + toward the audience
        headRoot.add(aim);
        const fan = new THREE.Group();
        aim.add(fan);
        for (let k = 0; k < 6; k++) {
          const armY = new THREE.Group();
          armY.rotation.y = (k * Math.PI) / 3;
          const armZ = new THREE.Group();
          armZ.rotation.z = 0.42;
          const beam = makeBeam(prof.beamDeg, 3.2);
          armZ.add(beam);
          armY.add(armZ);
          fan.add(armY);
          handle.beams.push(beam);
        }
        handle.fan = fan;
        const ring = new THREE.Mesh(
          new THREE.TorusGeometry(0.17, 0.02, 8, 26),
          new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false })
        );
        ring.rotation.x = Math.PI / 2;
        headRoot.add(ring);
        handle.ring = ring;
      } else if (hd.kind === 'hazer') {
        const beam = makeBeam(26, 2.2);
        beam.rotation.x = Math.PI; // haze plume rises
        headRoot.add(beam);
        handle.beams.push(beam);
      } else if (hd.kind === 'mover') {
        const pan = new THREE.Group();
        const tilt = new THREE.Group();
        pan.add(tilt);
        headRoot.add(pan);
        const beam = makeBeam(prof.beamDeg, 5);
        tilt.add(beam);
        handle.beams.push(beam);
        handle.pan = pan;
        handle.tilt = tilt;
      } else {
        const aim = new THREE.Group();
        // A fixture that aims gets its direction from the yoke above; the
        // fixed downward tip is for things that cannot move.
        aim.rotation.x = tiltG ? 0 : f.pos.y > 1.2 ? -0.38 : -0.1;
        headRoot.add(aim);
        const beam = makeBeam(prof.beamDeg, tiltG ? 5 : 4.2);
        aim.add(beam);
        handle.beams.push(beam);
        if (tiltG) aimBeams.push(beam);
      }

      handles.push(handle);
    });

    // Hand the yoke to the head whose channels actually carry the aim. GDTF
    // binds Pan/Tilt to the fixture's Base geometry, which compiles to head 0,
    // so that is the head whose snapshot values are the ones the rig obeys —
    // the other pixels sit at their default 0.5 and would freeze the yoke
    // mid-travel if they drove it. Every beam under the yoke re-cuts with it.
    if (panG && tiltG) {
      const owner = handles[handles.length - prof.heads.length];
      if (owner) {
        owner.pan = panG;
        owner.tilt = tiltG;
        owner.aimBeams = aimBeams;
      }
    }

    group.add(fg);
  }
  // Static heads are cut once, here; movers and derbies are re-cut as they turn.
  const rig = { group, handles, occ: buildOccluders(project) };
  refitBeams(rig, project);
  return rig;
}

/** Recompute the occluder set and re-cut every beam against it.
 *
 *  Called on rig build and again whenever the STRUCTURE moves. Static heads are
 *  cut exactly once, so without this a riser dragged in the 2D plan left their
 *  beams terminating on geometry that is no longer there — while beams crossing
 *  its new position punched straight through. Movers and derbies re-cut every
 *  frame anyway, but they still need the fresh occluder list. */
function refitBeams(
  rig: { group: THREE.Group; handles: HeadHandle[]; occ: Occluder[] },
  project: Project,
): void {
  rig.occ = buildOccluders(project);
  rig.group.updateMatrixWorld(true);
  for (const h of rig.handles) {
    for (const b of h.beams) fitBeam(b, rig.occ);
  }
}

function disposeDeep(obj: THREE.Object3D): void {
  obj.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
    else mat?.dispose();
  });
}

/** Dummy musicians from the project's placed props — figures at real human
 *  scale for judging blocking and throw distances. */
/** A length of box truss along X: four chords and a zig-zag of braces.
 *
 *  Drawn rather than boxed because a truss is mostly holes — a solid bar reads
 *  as a wall in the previz and hides everything behind it, which is exactly
 *  wrong for judging what the rig lights. */
function buildTrussRun(len: number, section: number, mat: THREE.Material): THREE.Group {
  const g = new THREE.Group();
  const r = Math.max(0.012, section * 0.075);
  const half = section / 2 - r;
  const chordGeo = new THREE.CylinderGeometry(r, r, len, 6);
  for (const [dy, dz] of [[half, half], [half, -half], [-half, half], [-half, -half]] as const) {
    const c = new THREE.Mesh(chordGeo, mat);
    c.rotation.z = Math.PI / 2; // lie along X
    c.position.set(0, dy, dz);
    g.add(c);
  }
  // braces: one zig per ~section length, on both vertical faces
  const bay = Math.max(section, 0.35);
  const n = Math.max(1, Math.round(len / bay));
  const braceLen = Math.hypot(len / n, section - 2 * r);
  const braceGeo = new THREE.CylinderGeometry(r * 0.7, r * 0.7, braceLen, 5);
  for (let i = 0; i < n; i++) {
    const cx = -len / 2 + (i + 0.5) * (len / n);
    for (const dz of [half, -half]) {
      const b = new THREE.Mesh(braceGeo, mat);
      b.position.set(cx, 0, dz);
      b.rotation.z = (i % 2 ? 1 : -1) * (Math.PI / 2 - Math.atan2(len / n, section));
      g.add(b);
    }
  }
  return g;
}

function buildProps(
  props: {
    kind: string;
    pos: { x: number; z: number };
    rotY?: number;
    size?: { w: number; h: number; d: number };
    y?: number;
  }[],
): THREE.Group {
  const g = new THREE.Group();
  const cloth = new THREE.MeshStandardMaterial({ color: 0x232328, roughness: 0.92 });
  const skin = new THREE.MeshStandardMaterial({ color: 0x9e7861, roughness: 0.75 });
  const wood = new THREE.MeshStandardMaterial({ color: 0x591f1a, roughness: 0.55 });
  const metal = new THREE.MeshStandardMaterial({ color: 0x8c8c99, roughness: 0.35, metalness: 0.85 });
  const brass = new THREE.MeshStandardMaterial({ color: 0xb5944a, roughness: 0.3, metalness: 0.9 });
  // structure reads as aluminium: bright enough to catch a beam, dull enough
  // not to compete with the fixtures for attention
  const truss = new THREE.MeshStandardMaterial({ color: 0x8d8d97, roughness: 0.42, metalness: 0.75 });
  const skirtMat = new THREE.MeshStandardMaterial({ color: 0x191920, roughness: 0.95 });
  const deckTop = new THREE.MeshStandardMaterial({ color: 0x2b2b33, roughness: 0.88 });
  // a dark panel that still shows the light falling on it
  const screenFace = new THREE.MeshStandardMaterial({ color: 0x0d0d12, roughness: 0.6 });

  const legsGeo = new THREE.CapsuleGeometry(0.13, 0.55, 4, 10);
  const torsoGeo = new THREE.CapsuleGeometry(0.17, 0.4, 4, 10);
  const headGeo = new THREE.SphereGeometry(0.11, 14, 10);

  for (const pr of props) {
    const root = new THREE.Group();
    // Structure positions itself off its own `y`; a performer is stood on
    // whatever the scenery puts under their feet, so a musician dragged onto a
    // riser stands ON it instead of inside it. Derived rather than authored —
    // see standingHeightAt.
    const base = isStructure(pr.kind) ? 0 : standingHeightAt(props, pr.pos.x, pr.pos.z);
    root.position.set(pr.pos.x, base, pr.pos.z);
    root.rotation.y = pr.rotY ?? 0;
    g.add(root);
    const addStanding = () => {
      const legs = new THREE.Mesh(legsGeo, cloth);
      legs.position.y = 0.5;
      const torso = new THREE.Mesh(torsoGeo, cloth);
      torso.position.y = 1.17;
      const head = new THREE.Mesh(headGeo, skin);
      head.position.y = 1.62;
      root.add(legs, torso, head);
    };
    switch (pr.kind) {
      case 'vocalist': {
        addStanding();
        const mic = new THREE.Mesh(new THREE.CylinderGeometry(0.013, 0.013, 1.55, 8), metal);
        mic.position.set(0.3, 0.775, 0.25);
        const micHead = new THREE.Mesh(new THREE.SphereGeometry(0.04, 8, 6), cloth);
        micHead.position.set(0.3, 1.56, 0.25);
        root.add(mic, micHead);
        break;
      }
      case 'guitarist':
      case 'bassist': {
        addStanding();
        const guitar = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.9, 0.09), wood);
        guitar.position.set(0, 1.0, 0.22);
        guitar.rotation.z = 0.55;
        root.add(guitar);
        break;
      }
      case 'keyboardist': {
        addStanding();
        const board = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.09, 0.32), cloth);
        board.position.set(0, 0.93, 0.35);
        root.add(board);
        for (const dx of [-0.45, 0.45]) {
          const leg = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.9, 0.05), metal);
          leg.position.set(dx, 0.45, 0.35);
          root.add(leg);
        }
        break;
      }
      case 'drummer': {
        const stool = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.45, 10), cloth);
        stool.position.set(0, 0.225, -0.45);
        const dtorso = new THREE.Mesh(torsoGeo, cloth);
        dtorso.position.set(0, 0.85, -0.45);
        const dhead = new THREE.Mesh(headGeo, skin);
        dhead.position.set(0, 1.3, -0.45);
        const kick = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.45, 16), wood);
        kick.position.set(0, 0.28, 0.15);
        kick.rotation.x = Math.PI / 2;
        const snare = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.14, 12), metal);
        snare.position.set(-0.32, 0.55, -0.15);
        root.add(stool, dtorso, dhead, kick, snare);
        for (const [cx, cy] of [[-0.5, 1.15], [0.5, 1.05]] as const) {
          const cymbal = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.19, 0.015, 16), brass);
          cymbal.position.set(cx, cy, -0.05);
          cymbal.rotation.z = 0.08;
          const stand = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, cy, 6), metal);
          stand.position.set(cx, cy / 2, -0.05);
          root.add(cymbal, stand);
        }
        break;
      }
      // ---- structure -----------------------------------------------------
      case 'trussBar': {
        const s = pr.size ?? { w: 7, h: 0.3, d: 0.3 };
        const run = buildTrussRun(s.w, Math.max(s.h, s.d), truss);
        run.position.y = (pr.y ?? 3.05) + s.h / 2;
        root.add(run);
        break;
      }
      case 'trussLeg': {
        const s = pr.size ?? { w: 0.3, h: 3.05, d: 0.3 };
        const run = buildTrussRun(s.h, Math.max(s.w, s.d), truss);
        run.rotation.z = Math.PI / 2; // stand it up
        run.position.y = (pr.y ?? 0) + s.h / 2;
        const foot = new THREE.Mesh(new THREE.BoxGeometry(s.w * 2.2, 0.04, s.d * 2.2), truss);
        foot.position.y = (pr.y ?? 0) + 0.02;
        root.add(run, foot);
        break;
      }
      case 'riser': {
        const s = pr.size ?? { w: 2, h: 0.4, d: 1.5 };
        const y = pr.y ?? 0;
        // The slab is the TOP 5 cm of the riser, not 2.5 cm proud of it.
        // Centred on y + s.h it stood the walking surface at y + s.h + 0.025,
        // so a performer stood at the declared height sank 25 mm into it — and
        // the native view, which draws the riser as one box topping out at
        // y + s.h, disagreed with this one by that much.
        const deck = new THREE.Mesh(new THREE.BoxGeometry(s.w, 0.05, s.d), deckTop);
        deck.position.y = y + s.h - 0.025;
        const skirt = new THREE.Mesh(new THREE.BoxGeometry(s.w, s.h, s.d), skirtMat);
        skirt.position.y = y + s.h / 2;
        root.add(skirt, deck);
        break;
      }
      case 'screen': {
        const s = pr.size ?? { w: 4, h: 2.25, d: 0.12 };
        const y = pr.y ?? 0.5;
        const panel = new THREE.Mesh(new THREE.BoxGeometry(s.w, s.h, s.d * 0.4), screenFace);
        panel.position.y = y + s.h / 2;
        const frame = new THREE.Mesh(new THREE.BoxGeometry(s.w + 0.08, s.h + 0.08, s.d), truss);
        frame.position.y = y + s.h / 2;
        frame.position.z = -s.d * 0.35;
        root.add(frame, panel);
        break;
      }
      default:
        addStanding();
    }
  }
  return g;
}

/** `source` picks which head set to draw: the live rig, or the audition the
 *  engine resolves for the selected look. Same renderer, same scene, same
 *  everything — only the numbers differ, so the preview cannot drift away from
 *  the live view in appearance. */
export function Previz3D({ source = 'live' }: { source?: 'live' | 'preview' } = {}) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    // No preserveDrawingBuffer: it forces the driver to keep a copy of every
    // frame, and this canvas shares a laptop with a live show. Turn it on
    // temporarily if you need to capture the previz with toDataURL — see
    // docs/website/README.md.
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    // Beams are additive cones, and on a real rig a lot of them overlap. With
    // no tone mapping every sum past 1.0 clips to flat white, so a busy look
    // reads as a white hole with a few coloured edges — precisely when you most
    // need to see what the rig is doing. A tone curve rolls the highlights off
    // instead, so twenty overlapping beams stay coloured and separable.
    //
    // Khronos PBR Neutral rather than ACES Filmic. A lighting previz lives in
    // the overdrive part of the curve — the beam stack runs 20-60x display
    // white — and that is exactly where the two disagree. Measured on this
    // three.js build, at 20x over: ACES swings a saturated red +53 degrees of
    // OKLab hue (red reads orange), takes amber +27 with its saturation
    // crushed to 0.09, and collapses a cyan beam to 0.03 saturation where
    // Neutral holds 0.26. ACES also ends in a hard clip; Neutral asymptotes,
    // so the hot core keeps a little information instead of none.
    //
    // Not a clean win, and worth knowing before someone "fixes" it back:
    // NEITHER curve preserves hue perceptually, and on BLUE specifically ACES
    // is the better of the two (max -13 degrees OKLab against Neutral's +19).
    // The trade is taken on saturation, because saturation is what decides
    // whether a colour reads as that colour at all, and on red/amber/cyan,
    // which are the cases that fail worst under ACES.
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.toneMappingExposure = 1.0;
    // Live exposure, adapted below. Kept out here so it survives frames.
    let exposure = 1.0;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    host.appendChild(renderer.domElement);

    // A lost context is recoverable, but only if the default is prevented —
    // otherwise the canvas stays black for the rest of the session with no way
    // back short of reloading the UI, mid-show. Causes are real and not
    // hypothetical: too many live contexts, a GPU driver reset, the OS
    // reclaiming memory, or the tab being backgrounded on iPadOS. The listeners
    // are attached further down, once the rig-cache variables they reset exist.
    let contextLost = false;
    const onContextLost = (e: Event) => {
      e.preventDefault(); // ask the browser to give it back
      contextLost = true;
      console.warn('[previz] WebGL context lost — waiting for restore');
    };

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0d0d10);
    scene.fog = new THREE.FogExp2(0x0d0d10, 0.028);

    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
    camera.position.set(0, 2.4, 8.2);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 1.6, 0);
    // restore the last camera pose — switching to 2D and back (or reloading)
    // must not reset the view
    try {
      const saved = JSON.parse(localStorage.getItem('previz3d.camera') ?? 'null');
      if (saved?.pos && saved?.target) {
        camera.position.set(saved.pos[0], saved.pos[1], saved.pos[2]);
        controls.target.set(saved.target[0], saved.target[1], saved.target[2]);
      }
    } catch { /* corrupt/absent — defaults stand */ }
    controls.update();
    let lastCamSave = 0;
    controls.addEventListener('change', () => {
      const now = performance.now();
      if (now - lastCamSave < 500) return;
      lastCamSave = now;
      try {
        localStorage.setItem('previz3d.camera', JSON.stringify({
          pos: camera.position.toArray(),
          target: controls.target.toArray(),
        }));
      } catch { /* storage full/blocked — non-essential */ }
    });
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.maxPolarAngle = Math.PI * 0.55;
    controls.minDistance = 2;
    controls.maxDistance = 20;

    // room
    const grid = new THREE.GridHelper(14, 14, 0x2c2c34, 0x1b1b20);
    scene.add(grid);
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(14, 10),
      new THREE.MeshBasicMaterial({ color: 0x131316 })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.01;
    scene.add(floor);

    // Metre grid — the cheapest possible answer to "how big is that?", and the
    // reason a 7 m truss and a 2 m riser can be placed by eye.
    const measureGrid = new THREE.GridHelper(20, 20, 0x4a4a58, 0x2a2a33);
    measureGrid.position.y = 0.002; // just off the floor, no z-fighting
    measureGrid.visible = false;
    scene.add(measureGrid);

    // dummy musicians from placed props — scale/blocking reference (true
    // illumination lives in the native previz window)
    let band = new THREE.Group();
    scene.add(band);
    let propsSig = '';
    const bandLight = new THREE.HemisphereLight(0x9aa4c0, 0x1a1a20, 1.1);
    scene.add(bandLight);

    let rig: ReturnType<typeof buildRig> | null = null;
    let lastProject: Project | null = null;
    let lastSig = '';

    // Now that the rig-cache variables exist, wire the recovery path: every
    // GPU-side resource died with the context, so the caches that would
    // short-circuit a rebuild have to be invalidated before the next frame.
    const onContextRestored = () => {
      contextLost = false;
      rig = null;
      lastProject = null;
      lastSig = '';
      propsSig = '';
      console.warn('[previz] WebGL context restored — rebuilding');
    };
    renderer.domElement.addEventListener('webglcontextlost', onContextLost);
    renderer.domElement.addEventListener('webglcontextrestored', onContextRestored);

    const ro = new ResizeObserver(() => {
      const r = host.getBoundingClientRect();
      const w = Math.max(1, r.width);
      const h = Math.max(1, r.height);
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    });
    ro.observe(host);

    let raf = 0;
    let lastT = performance.now();

    const tick = () => {
      raf = requestAnimationFrame(tick);
      // Keep the loop alive but do no GL work while the context is gone —
      // every draw would throw until it comes back.
      if (contextLost) return;
      const now = performance.now();
      const dt = Math.min(0.1, (now - lastT) / 1000);
      lastT = now;

      const { project, snap, hazeViz, showBand, showMeasure, previzAutoExposure: autoExposure } =
        useStore.getState();
      measureGrid.visible = showMeasure;
      const sig = JSON.stringify(project?.props ?? []);
      if (sig !== propsSig) {
        propsSig = sig;
        scene.remove(band);
        // free the GPU buffers — rebuilding on every prop drag otherwise
        // leaks a geometry + material set per frame of the drag
        band.traverse((o) => {
          const mesh = o as THREE.Mesh;
          mesh.geometry?.dispose?.();
          const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
          if (Array.isArray(mat)) mat.forEach((mm) => mm.dispose());
          else mat?.dispose?.();
        });
        band = buildProps(project?.props ?? []);
        scene.add(band);
        // The structure just moved, so the beam-cutting geometry is stale:
        // rebuild the occluders and re-cut every beam, including the static
        // heads that are otherwise only ever cut at rig-build time.
        if (rig && project) refitBeams(rig, project);
      }
      band.visible = showBand;

      if (project && project !== lastProject) {
        lastProject = project;
        const sig = fixtureSignature(project);
        if (sig !== lastSig) {
          lastSig = sig;
          if (rig) {
            scene.remove(rig.group);
            disposeDeep(rig.group);
          }
          rig = buildRig(project);
          scene.add(rig.group);
        }
      }

      if (rig && snap) {
        const heads = new Map<string, HeadSnap>();
        for (const hs of source === 'preview' ? (useStore.getState().previewHeads ?? []) : snap.heads) {
          heads.set(`${hs.f}:${hs.h}`, hs);
        }
        const beamGain = 0.07 + hazeViz * 0.5;
        let lumAcc = 0;

        for (const h of rig.handles) {
          const hs = heads.get(h.key);
          const ti = hs?.i ?? 0;
          // fast attack, softer release
          const k = ti > h.cur.i ? 0.55 : 0.28;
          h.cur.i += (ti - h.cur.i) * k;
          h.cur.r += ((hs?.r ?? 0) - h.cur.r) * 0.5;
          h.cur.g += ((hs?.g ?? 0) - h.cur.g) * 0.5;
          h.cur.b += ((hs?.b ?? 0) - h.cur.b) * 0.5;

          let gate = 1;
          if (hs && hs.st > 0.01) gate = (now / (1000 / (2 + hs.st * 12))) % 1 < 0.5 ? 1 : 0.06;

          if (h.kind === 'hazer') {
            const haze = snap.haze;
            for (const b of h.beams) {
              b.material.opacity = haze * 0.09;
              b.material.color.setRGB(0.7, 0.72, 0.78, THREE.SRGBColorSpace);
            }
            if (h.glow) h.glow.material.opacity = 0;
            continue;
          }

          const mc = hs?.mc;
          h.beams.forEach((b, bi) => {
            let r = h.cur.r, g = h.cur.g, bl = h.cur.b;
            if (mc && mc.length > 0) {
              const c = mc[bi % mc.length];
              r = c[0] / 255;
              g = c[1] / 255;
              bl = c[2] / 255;
            }
            // sRGB, explicitly — the two previz views disagreed about this.
            //
            // three's `setRGB` defaults to the WORKING colour space, which is
            // linear-sRGB, so a look's RGB was being taken as already-linear
            // here while the native window decodes it as sRGB. Saturated
            // primaries matched and everything in between did not: an amber at
            // (1, 0.6, 0) came out linear 0.6 in the browser and 0.32 natively,
            // which is the difference between a washed yellow and an orange.
            //
            // Decoding is the right side of that argument. A look's RGB comes
            // from an sRGB colour picker, and it leaves the engine as a DMX
            // level into a fixture whose default dimmer curve is square-law or
            // thereabouts — sRGB decode lands at 0.60 where square law lands at
            // 0.64, and the linear reading lands at 0.80.
            b.material.color.setRGB(r, g, bl, THREE.SRGBColorSpace);
            b.material.opacity = h.cur.i * beamGain * gate;
          });

          // What this head is contributing to the room, for the eye-adaptation
          // pass below. Perceptual weights, because green reads far brighter
          // than blue at the same value — a deep blue wash should not stop the
          // exposure down the way an open white one does.
          lumAcc += h.cur.i * gate *
            (0.2126 * h.cur.r + 0.7152 * h.cur.g + 0.0722 * h.cur.b);

          if (h.glow) {
            h.glow.material.color.setRGB(h.cur.r, h.cur.g, h.cur.b, THREE.SRGBColorSpace);
            h.glow.material.opacity = h.cur.i * 0.9 * gate;
            const s = 1 + h.cur.i * 1.6;
            h.glow.scale.set(s, s, s);
          }

          if (h.fan && hs) {
            if (hs.mm === 'rotate') h.spin += dt * (0.4 + hs.mv * 5.2);
            else if (hs.mm === 'aim') h.spin += (hs.mv * Math.PI - h.spin) * 0.2;
            h.fan.rotation.y = h.spin;
            h.fan.updateMatrixWorld(true);
            for (const b of h.beams) fitBeam(b, rig.occ, zoomSpread(hs.zm));
          }

          // Static heads (bars, pars, washes) are cut once at rig build, so a
          // zoom change would never reach them. Re-cut only when the value
          // actually moves — a per-frame refit of every static beam is exactly
          // the cost the build-time cut exists to avoid.
          if (hs && !h.pan && !h.fan && hs.zm !== h.lastZoom) {
            h.lastZoom = hs.zm;
            for (const b of h.beams) fitBeam(b, rig.occ, zoomSpread(hs.zm));
          }

          if (h.ring && hs) {
            const blink = hs.ring >= 1 || (hs.ring > 0 && (now / 260) % 1 < 0.5);
            h.ring.material.opacity = blink && hs.ring > 0 ? 0.95 : 0;
          }

          if (h.pan && h.tilt && hs) {
            h.pan.rotation.y = (0.5 - hs.pan) * Math.PI * 3; // 540°
            h.tilt.rotation.x = (hs.tilt - 0.5) * Math.PI * 1.5; // 270°
            // The cone has to follow the aim, or a head pointed at the floor
            // draws the same length as one pointed at the back wall. Update
            // from PAN, not tilt: updateMatrixWorld composes with the parent's
            // matrixWorld as it stands and never refreshes it, so refreshing
            // tilt alone cut every beam against the previous frame's pan.
            // force=true propagates down through tilt to the beam.
            h.pan.updateMatrixWorld(true);
            for (const b of h.aimBeams ?? h.beams) fitBeam(b, rig.occ, zoomSpread(hs.zm));
          }
        }

        // --- eye adaptation ------------------------------------------------
        const lum = Math.max(lumAcc * beamGain, 1e-4);
        const target = clampExposure(ADAPT_KEY / Math.pow(lum, ADAPT_STRENGTH));
        // Stopping down is fast and opening up is slow, which is both what an
        // eye does and what keeps a strobe from pumping the whole picture: the
        // exposure settles on the lit frames and barely lifts in the gaps.
        //
        // Interpolated in LOG space, because the useful range here is two
        // decades wide. A linear lerp covers 1.0 → 0.1 in a blink and then
        // crawls the last stop, so a big cue would snap and then drift.
        const tau = target < exposure ? ADAPT_DOWN_S : ADAPT_UP_S;
        const k = 1 - Math.exp(-dt / tau);
        exposure = Math.exp(Math.log(exposure) + (Math.log(target) - Math.log(exposure)) * k);
      }

      renderer.toneMappingExposure = autoExposure ? exposure : 1.0;
      controls.update();
      renderer.render(scene, camera);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      if (rig) disposeDeep(rig.group);
      disposeDeep(scene);
      renderer.domElement.removeEventListener('webglcontextlost', onContextLost);
      renderer.domElement.removeEventListener('webglcontextrestored', onContextRestored);
      renderer.dispose();
      // dispose() frees three's own objects but leaves the GL context alive
      // until the detached canvas is garbage collected, which browsers do
      // lazily. The audition pane mounts and unmounts a SECOND renderer on
      // every cell selection, so a night of programming can churn past the
      // ~16-context cap — at which point the browser evicts the OLDEST, which
      // is the always-mounted live previz. Release it explicitly.
      renderer.forceContextLoss();
      host.removeChild(renderer.domElement);
    };
  }, []);

  return <div ref={hostRef} style={{ position: 'absolute', inset: 0, overflow: 'hidden' }} />;
}
