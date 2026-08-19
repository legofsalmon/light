import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { HeadSnap, Project } from '../../../shared/types.ts';
import { profileMeta } from '../profileInfo.ts';
import { useStore } from '../store.ts';

type HeadHandle = {
  key: string;
  kind: string;
  beams: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshBasicMaterial>[];
  glow: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial> | null;
  ring: THREE.Mesh<THREE.TorusGeometry, THREE.MeshBasicMaterial> | null;
  fan: THREE.Group | null;
  pan: THREE.Group | null;
  tilt: THREE.Group | null;
  spin: number;
  cur: { r: number; g: number; b: number; i: number };
};

function makeBeam(deg: number, len: number): THREE.Mesh<THREE.CylinderGeometry, THREE.MeshBasicMaterial> {
  const rad = (deg * Math.PI) / 180;
  const geo = new THREE.CylinderGeometry(0.012, Math.tan(rad / 2) * len + 0.02, len, 18, 1, true);
  geo.translate(0, -len / 2, 0);
  const mat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  return new THREE.Mesh(geo, mat);
}

function basicBox(w: number, h: number, d: number, color: number): THREE.Mesh {
  return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshBasicMaterial({ color }));
}

function fixtureSignature(p: Project): string {
  return JSON.stringify([
    p.fixtures.map((f) => [f.id, f.profileId, f.pos, f.rotY, f.rotX ?? 0, f.rotZ ?? 0]),
    // imported profiles can change shape (e.g. pixel-head upgrades) without
    // any fixture field changing
    Object.entries(p.profiles ?? {}).map(([id, cp]) => [id, cp.heads.length, cp.beamDeg]),
  ]);
}

function buildRig(project: Project): { group: THREE.Group; handles: HeadHandle[] } {
  const group = new THREE.Group();
  const handles: HeadHandle[] = [];

  for (const f of project.fixtures) {
    const prof = profileMeta(project, f.profileId);
    if (!prof) continue;
    const fg = new THREE.Group();
    fg.position.set(f.pos.x, f.pos.y, f.pos.z);
    fg.rotation.order = 'YXZ'; // yaw, then mounting tilt, then roll
    fg.rotation.set(f.rotX ?? 0, f.rotY, f.rotZ ?? 0);

    // body
    if (prof.heads.length > 1) fg.add(basicBox(1.06, 0.09, 0.09, 0x2c2c33));
    else if (prof.heads[0]?.kind === 'derby') fg.add(basicBox(0.26, 0.2, 0.2, 0x2c2c33));
    else if (prof.heads[0]?.kind === 'hazer') fg.add(basicBox(0.34, 0.26, 0.26, 0x232328));
    else fg.add(basicBox(0.16, 0.14, 0.16, 0x2c2c33));

    prof.heads.forEach((hd, hi) => {
      const headRoot = new THREE.Group();
      headRoot.position.set(hd.offset, 0, 0);
      fg.add(headRoot);

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
        aim.rotation.x = f.pos.y > 1.2 ? -0.38 : -0.1; // rigged fixtures tip toward the crowd
        headRoot.add(aim);
        const beam = makeBeam(prof.beamDeg, 4.2);
        aim.add(beam);
        handle.beams.push(beam);
      }

      handles.push(handle);
    });

    group.add(fg);
  }
  return { group, handles };
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
function buildProps(props: { kind: string; pos: { x: number; z: number }; rotY?: number }[]): THREE.Group {
  const g = new THREE.Group();
  const cloth = new THREE.MeshStandardMaterial({ color: 0x232328, roughness: 0.92 });
  const skin = new THREE.MeshStandardMaterial({ color: 0x9e7861, roughness: 0.75 });
  const wood = new THREE.MeshStandardMaterial({ color: 0x591f1a, roughness: 0.55 });
  const metal = new THREE.MeshStandardMaterial({ color: 0x8c8c99, roughness: 0.35, metalness: 0.85 });
  const brass = new THREE.MeshStandardMaterial({ color: 0xb5944a, roughness: 0.3, metalness: 0.9 });

  const legsGeo = new THREE.CapsuleGeometry(0.13, 0.55, 4, 10);
  const torsoGeo = new THREE.CapsuleGeometry(0.17, 0.4, 4, 10);
  const headGeo = new THREE.SphereGeometry(0.11, 14, 10);

  for (const pr of props) {
    const root = new THREE.Group();
    root.position.set(pr.pos.x, 0, pr.pos.z);
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

    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    host.appendChild(renderer.domElement);

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

    // truss
    const trussMat = new THREE.MeshBasicMaterial({ color: 0x37373e });
    const trussBar = new THREE.Mesh(new THREE.BoxGeometry(7, 0.09, 0.09), trussMat);
    trussBar.position.set(0, 3.05, 0);
    scene.add(trussBar);
    for (const lx of [-3.5, 3.5]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.09, 3.05, 0.09), trussMat);
      leg.position.set(lx, 3.05 / 2, 0);
      scene.add(leg);
    }

    // dummy musicians from placed props — scale/blocking reference (true
    // illumination lives in the native previz window)
    let band = new THREE.Group();
    scene.add(band);
    let propsSig = '';
    const bandLight = new THREE.HemisphereLight(0x9aa4c0, 0x1a1a20, 1.1);
    scene.add(bandLight);

    let rig: { group: THREE.Group; handles: HeadHandle[] } | null = null;
    let lastProject: Project | null = null;
    let lastSig = '';

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
      const now = performance.now();
      const dt = Math.min(0.1, (now - lastT) / 1000);
      lastT = now;

      const { project, snap, hazeViz, showBand } = useStore.getState();
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
        for (const hs of source === 'preview' ? (snap.previewHeads ?? []) : snap.heads) {
          heads.set(`${hs.f}:${hs.h}`, hs);
        }
        const beamGain = 0.07 + hazeViz * 0.5;

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
              b.material.color.setRGB(0.7, 0.72, 0.78);
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
            b.material.color.setRGB(r, g, bl);
            b.material.opacity = h.cur.i * beamGain * gate;
          });

          if (h.glow) {
            h.glow.material.color.setRGB(h.cur.r, h.cur.g, h.cur.b);
            h.glow.material.opacity = h.cur.i * 0.9 * gate;
            const s = 1 + h.cur.i * 1.6;
            h.glow.scale.set(s, s, s);
          }

          if (h.fan && hs) {
            if (hs.mm === 'rotate') h.spin += dt * (0.4 + hs.mv * 5.2);
            else if (hs.mm === 'aim') h.spin += (hs.mv * Math.PI - h.spin) * 0.2;
            h.fan.rotation.y = h.spin;
          }

          if (h.ring && hs) {
            const blink = hs.ring >= 1 || (hs.ring > 0 && (now / 260) % 1 < 0.5);
            h.ring.material.opacity = blink && hs.ring > 0 ? 0.95 : 0;
          }

          if (h.pan && h.tilt && hs) {
            h.pan.rotation.y = (0.5 - hs.pan) * Math.PI * 3; // 540°
            h.tilt.rotation.x = (hs.tilt - 0.5) * Math.PI * 1.5; // 270°
          }
        }
      }

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
      renderer.dispose();
      host.removeChild(renderer.domElement);
    };
  }, []);

  return <div ref={hostRef} style={{ position: 'absolute', inset: 0, overflow: 'hidden' }} />;
}
