import React, { useEffect, useRef } from 'react';
import type { HeadSnap } from '../../../shared/types.ts';
import { profileMeta } from '../profileInfo.ts';
import { useStore } from '../store.ts';

const WORLD_W = 11; // metres shown horizontally
const WORLD_Z0 = -3; // top of view
const WORLD_D = 9; // metres shown vertically

/** Top-down plan: stage-left→right on X, audience toward the bottom. */
export function Previz2D() {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<{ id: string; lastSend: number } | null>(null);

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

    const mapping = () => {
      const scale = Math.min(w / WORLD_W, h / WORLD_D);
      const mx = (w - WORLD_W * scale) / 2;
      const my = (h - WORLD_D * scale) / 2;
      return {
        scale,
        toX: (x: number) => mx + (x + WORLD_W / 2) * scale,
        toY: (z: number) => my + (z - WORLD_Z0) * scale,
        fromPx: (px: number, py: number) => ({
          x: (px - mx) / scale - WORLD_W / 2,
          z: (py - my) / scale + WORLD_Z0,
        }),
      };
    };

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const { project, snap } = useStore.getState();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = '#101013';
      ctx.fillRect(0, 0, w, h);
      if (!project) return;
      const m = mapping();
      const t = performance.now();

      // 1 m grid
      ctx.strokeStyle = 'rgba(255,255,255,0.045)';
      ctx.lineWidth = 1;
      for (let gx = -Math.floor(WORLD_W / 2); gx <= WORLD_W / 2; gx++) {
        ctx.beginPath();
        ctx.moveTo(m.toX(gx), m.toY(WORLD_Z0));
        ctx.lineTo(m.toX(gx), m.toY(WORLD_Z0 + WORLD_D));
        ctx.stroke();
      }
      for (let gz = WORLD_Z0; gz <= WORLD_Z0 + WORLD_D; gz++) {
        ctx.beginPath();
        ctx.moveTo(m.toX(-WORLD_W / 2), m.toY(gz));
        ctx.lineTo(m.toX(WORLD_W / 2), m.toY(gz));
        ctx.stroke();
      }
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.font = '10px -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('A U D I E N C E', w / 2, m.toY(WORLD_Z0 + WORLD_D) - 8);

      const headMap = new Map<string, HeadSnap>();
      for (const hs of snap?.heads ?? []) headMap.set(`${hs.f}:${hs.h}`, hs);

      for (const f of project.fixtures) {
        const prof = profileMeta(project, f.profileId);
        if (!prof) continue;
        const fx = m.toX(f.pos.x);
        const fy = m.toY(f.pos.z);
        const cos = Math.cos(f.rotY);
        const sin = Math.sin(f.rotY);

        // body
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

          // glow
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

          // derby spokes + ring
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

        // name
        ctx.fillStyle = 'rgba(255,255,255,0.28)';
        ctx.textAlign = 'center';
        ctx.font = '9px -apple-system, sans-serif';
        ctx.fillText(f.name, fx, fy + 0.42 * m.scale + 8);
      }
    };
    raf = requestAnimationFrame(draw);

    const onPointerDown = (e: PointerEvent) => {
      const { project } = useStore.getState();
      if (!project) return;
      const rect = canvas.getBoundingClientRect();
      const m = mapping();
      const pos = m.fromPx(e.clientX - rect.left, e.clientY - rect.top);
      let best: { id: string; d: number } | null = null;
      for (const f of project.fixtures) {
        const d = Math.hypot(f.pos.x - pos.x, f.pos.z - pos.z);
        if (d < 0.6 && (!best || d < best.d)) best = { id: f.id, d };
      }
      if (best) {
        dragRef.current = { id: best.id, lastSend: 0 };
        canvas.setPointerCapture(e.pointerId);
      }
    };
    const onPointerMove = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || !(e.buttons & 1)) return;
      const rect = canvas.getBoundingClientRect();
      const m = mapping();
      const pos = m.fromPx(e.clientX - rect.left, e.clientY - rect.top);
      const now = performance.now();
      if (now - drag.lastSend < 90) return;
      drag.lastSend = now;
      useStore.getState().mutate((p) => {
        const f = p.fixtures.find((x) => x.id === drag.id);
        if (f) {
          f.pos.x = Math.round(pos.x * 20) / 20;
          f.pos.z = Math.round(pos.z * 20) / 20;
        }
      });
    };
    const onPointerUp = () => {
      dragRef.current = null;
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
