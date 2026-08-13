import React, { useEffect, useRef } from 'react';
import type { HeadSnap } from '../../../shared/types.ts';
import { profileMeta } from '../profileInfo.ts';
import { useStore } from '../store.ts';

const WORLD_W = 11; // metres shown horizontally (both views)
// plan: depth axis (z), audience at the bottom
const PLAN_Z0 = -3;
const PLAN_D = 9;
// front: height axis (y), floor near the bottom
const FRONT_Y_TOP = 6.5;
const FRONT_H = 7;
const TRUSS_Y = 3.05; // matches the 3D scene truss

type ViewKind = 'plan' | 'front';

/** 2D previz: top-down plan (drag places x/z) or front elevation (drag sets x/height). */
export function Previz2D() {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<{
    id: string;
    kind: 'move' | 'rotate';
    lastSend: number;
    x: number;
    v: number;
    rot: number;
  } | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;
    const ctx = canvas.getContext('2d')!;
    let raf = 0;
    let w = 0, h = 0, dpr = 1;

    const ro = new ResizeObserver(() => {
      const r = host.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = Math.max(1, r.width);
      h = Math.max(1, r.height);
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    });
    ro.observe(host);

    const mapping = (view: ViewKind) => {
      const depth = view === 'plan' ? PLAN_D : FRONT_H;
      const scale = Math.min(w / WORLD_W, h / depth);
      const mx = (w - WORLD_W * scale) / 2;
      const my = (h - depth * scale) / 2;
      const toY = (v: number) =>
        view === 'plan' ? my + (v - PLAN_Z0) * scale : my + (FRONT_Y_TOP - v) * scale;
      return {
        scale,
        toX: (x: number) => mx + (x + WORLD_W / 2) * scale,
        toY,
        fromPx: (px: number, py: number) => ({
          x: (px - mx) / scale - WORLD_W / 2,
          v: view === 'plan' ? (py - my) / scale + PLAN_Z0 : FRONT_Y_TOP - (py - my) / scale,
        }),
      };
    };

    /** the world coordinate shown on this view's vertical axis */
    const vertOf = (pos: { y: number; z: number }, view: ViewKind) =>
      view === 'plan' ? pos.z : pos.y;

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const { project, snap, previz2dView: view } = useStore.getState();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = '#101013';
      ctx.fillRect(0, 0, w, h);
      if (!project) return;
      const m = mapping(view);
      const t = performance.now();

      // 1 m grid
      ctx.strokeStyle = 'rgba(255,255,255,0.045)';
      ctx.lineWidth = 1;
      const vTop = view === 'plan' ? PLAN_Z0 : FRONT_Y_TOP - FRONT_H;
      const vBot = view === 'plan' ? PLAN_Z0 + PLAN_D : FRONT_Y_TOP;
      for (let gx = -Math.floor(WORLD_W / 2); gx <= WORLD_W / 2; gx++) {
        ctx.beginPath();
        ctx.moveTo(m.toX(gx), m.toY(vTop));
        ctx.lineTo(m.toX(gx), m.toY(vBot));
        ctx.stroke();
      }
      for (let gv = Math.ceil(Math.min(vTop, vBot)); gv <= Math.max(vTop, vBot); gv++) {
        ctx.beginPath();
        ctx.moveTo(m.toX(-WORLD_W / 2), m.toY(gv));
        ctx.lineTo(m.toX(WORLD_W / 2), m.toY(gv));
        ctx.stroke();
      }

      ctx.font = '10px -apple-system, sans-serif';
      ctx.textAlign = 'center';
      if (view === 'plan') {
        ctx.fillStyle = 'rgba(255,255,255,0.12)';
        ctx.fillText('A U D I E N C E', w / 2, m.toY(PLAN_Z0 + PLAN_D) - 8);
      } else {
        // floor + truss reference lines
        ctx.strokeStyle = 'rgba(255,255,255,0.22)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(m.toX(-WORLD_W / 2), m.toY(0));
        ctx.lineTo(m.toX(WORLD_W / 2), m.toY(0));
        ctx.stroke();
        ctx.strokeStyle = 'rgba(255,255,255,0.1)';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(m.toX(-3.5), m.toY(TRUSS_Y));
        ctx.lineTo(m.toX(3.5), m.toY(TRUSS_Y));
        ctx.stroke();
        ctx.fillStyle = 'rgba(255,255,255,0.14)';
        ctx.textAlign = 'left';
        ctx.fillText('floor', m.toX(-WORLD_W / 2) + 6, m.toY(0) - 5);
        ctx.fillText(`truss ${TRUSS_Y} m`, m.toX(-3.5) + 6, m.toY(TRUSS_Y) - 6);
        ctx.textAlign = 'center';
      }

      const headMap = new Map<string, HeadSnap>();
      for (const hs of snap?.heads ?? []) headMap.set(`${hs.f}:${hs.h}`, hs);

      for (const f of project.fixtures) {
        const prof = profileMeta(project, f.profileId);
        if (!prof) continue;
        const fx = m.toX(f.pos.x);
        const fy = m.toY(vertOf(f.pos, view));
        // head offsets fan out along local X; in plan view they rotate with
        // rotY, in front view they project onto X directly
        const cos = view === 'plan' ? Math.cos(f.rotY) : 1;
        const sin = view === 'plan' ? Math.sin(f.rotY) : 0;

        if (prof.heads.length > 1) {
          const half = 0.55 * m.scale;
          ctx.strokeStyle = '#3c3c44';
          ctx.lineWidth = 6;
          ctx.beginPath();
          ctx.moveTo(fx - half * cos, fy - half * sin);
          ctx.lineTo(fx + half * cos, fy + half * sin);
          ctx.stroke();
        }

        for (let hi = 0; hi < prof.heads.length; hi++) {
          const hd = prof.heads[hi];
          const hx = fx + hd.offset * m.scale * cos;
          const hy = fy + hd.offset * m.scale * sin;
          const hs = headMap.get(`${f.id}:${hi}`);
          const i = hs?.i ?? 0;
          let strobeGate = 1;
          if (hs && hs.st > 0.01) strobeGate = (t / (1000 / (2 + hs.st * 12))) % 1 < 0.5 ? 1 : 0.15;
          const r = Math.round((hs?.r ?? 0.2) * 255);
          const g = Math.round((hs?.g ?? 0.2) * 255);
          const b = Math.round((hs?.b ?? 0.2) * 255);
          const alpha = 0.18 + 0.82 * i * strobeGate;
          const rad = (hd.kind === 'derby' ? 0.17 : hd.kind === 'hazer' ? 0.14 : 0.11) * m.scale;

          if (i > 0.03) {
            const glow = ctx.createRadialGradient(hx, hy, rad * 0.4, hx, hy, rad * 3.2);
            glow.addColorStop(0, `rgba(${r},${g},${b},${0.4 * i * strobeGate})`);
            glow.addColorStop(1, 'rgba(0,0,0,0)');
            ctx.fillStyle = glow;
            ctx.beginPath();
            ctx.arc(hx, hy, rad * 3.2, 0, Math.PI * 2);
            ctx.fill();
          }

          ctx.beginPath();
          ctx.arc(hx, hy, rad, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(${r},${g},${b},${alpha})`;
          ctx.fill();
          ctx.strokeStyle = '#4a4a52';
          ctx.lineWidth = 1;
          ctx.stroke();

          if (hd.kind === 'derby' && hs) {
            const spin = hs.mm === 'rotate' ? (t / 1000) * hs.mv * 4 : hs.mv * Math.PI;
            ctx.strokeStyle = `rgba(${r},${g},${b},${0.25 + 0.75 * i})`;
            ctx.lineWidth = 1.5;
            for (let k = 0; k < 6; k++) {
              const a = spin + (k * Math.PI) / 3;
              ctx.beginPath();
              ctx.moveTo(hx + Math.cos(a) * rad * 0.4, hy + Math.sin(a) * rad * 0.4);
              ctx.lineTo(hx + Math.cos(a) * rad * 1.35, hy + Math.sin(a) * rad * 1.35);
              ctx.stroke();
            }
            const ringOn = hs.ring >= 1 || (hs.ring > 0 && (t / 260) % 1 < 0.5);
            if (ringOn && hs.ring > 0) {
              ctx.beginPath();
              ctx.arc(hx, hy, rad * 1.7, 0, Math.PI * 2);
              ctx.strokeStyle = 'rgba(255,255,255,0.95)';
              ctx.lineWidth = 2.5;
              ctx.stroke();
            }
          }
        }

        ctx.fillStyle = 'rgba(255,255,255,0.28)';
        ctx.textAlign = 'center';
        ctx.font = '9px -apple-system, sans-serif';
        const label = view === 'front' ? `${f.name} · ${f.pos.y.toFixed(1)}m` : f.name;
        ctx.fillText(label, fx, fy + 0.42 * m.scale + 8);
      }
    };
    raf = requestAnimationFrame(draw);

    const applyDrag = (id: string, x: number, v: number) => {
      const view = useStore.getState().previz2dView;
      useStore.getState().mutate((p) => {
        const f = p.fixtures.find((fx) => fx.id === id);
        if (!f) return;
        f.pos.x = Math.round(x * 20) / 20;
        if (view === 'plan') {
          f.pos.z = Math.round(v * 20) / 20;
        } else {
          f.pos.y = Math.round(Math.min(6, Math.max(0, v)) * 20) / 20;
        }
      });
    };

    const applyRotate = (id: string, rot: number) => {
      useStore.getState().mutate((p) => {
        const f = p.fixtures.find((fx) => fx.id === id);
        if (f) f.rotY = rot;
      });
    };

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const { project, previz2dView: view } = useStore.getState();
      if (!project) return;
      const rect = canvas.getBoundingClientRect();
      const m = mapping(view);
      const pos = m.fromPx(e.clientX - rect.left, e.clientY - rect.top);
      let best: { id: string; d: number } | null = null;
      for (const f of project.fixtures) {
        const d = Math.hypot(f.pos.x - pos.x, vertOf(f.pos, view) - pos.v);
        if (d < 0.6 && (!best || d < best.d)) best = { id: f.id, d };
      }
      if (best) {
        // ⌥-drag rotates (plan view only — yaw isn't meaningful in elevation)
        const kind = e.altKey && view === 'plan' ? 'rotate' : 'move';
        dragRef.current = { id: best.id, kind, lastSend: 0, x: pos.x, v: pos.v, rot: 0 };
        canvas.setPointerCapture(e.pointerId);
      }
    };
    const onPointerMove = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || !(e.buttons & 1)) return;
      const view = useStore.getState().previz2dView;
      const rect = canvas.getBoundingClientRect();
      const m = mapping(view);
      const pos = m.fromPx(e.clientX - rect.left, e.clientY - rect.top);
      if (drag.kind === 'rotate') {
        const f = useStore.getState().project?.fixtures.find((fx) => fx.id === drag.id);
        if (!f) return;
        const raw = Math.atan2(pos.v - f.pos.z, pos.x - f.pos.x);
        // snap to 5° so bars land on tidy angles
        const step = (5 * Math.PI) / 180;
        drag.rot = Math.round(raw / step) * step;
      } else {
        drag.x = pos.x;
        drag.v = pos.v;
      }
      const now = performance.now();
      if (now - drag.lastSend < 90) return;
      drag.lastSend = now;
      if (drag.kind === 'rotate') applyRotate(drag.id, drag.rot);
      else applyDrag(drag.id, drag.x, drag.v);
    };
    const onPointerUp = () => {
      const drag = dragRef.current;
      dragRef.current = null;
      // flush the final value — the move throttle must not drop it
      if (!drag) return;
      if (drag.kind === 'rotate') applyRotate(drag.id, drag.rot);
      else applyDrag(drag.id, drag.x, drag.v);
    };
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
    };
  }, []);

  return (
    <div ref={hostRef} style={{ position: 'absolute', inset: 0 }}>
      <canvas ref={canvasRef} />
    </div>
  );
}
