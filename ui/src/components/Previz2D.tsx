import React, { useEffect, useRef } from 'react';
import type { HeadSnap } from '../../../shared/types.ts';
import { profileMeta } from '../profileInfo.ts';
import { useStore } from '../store.ts';
import { askConfirm } from '../dialog.tsx';

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
export function Previz2D({ source = 'live' }: { source?: 'live' | 'preview' } = {}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<{
    id: string;
    kind: 'move' | 'rotate' | 'prop';
    lastSend: number;
    x: number;
    v: number;
    rot: number;
    /** other selected fixtures move with the grabbed one, keeping offsets */
    others: { id: string; dx: number; dv: number }[];
  } | null>(null);
  // marquee box in world coords for the active view; null when not dragging
  const marqueeRef = useRef<{
    x0: number;
    v0: number;
    x1: number;
    v1: number;
    additive: boolean;
    moved: boolean;
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
      // measure on demand — RO-cached w/h can be stale/zero in a freshly
      // (re)mounted effect closure (StrictMode double-mount), and a wrong
      // scale here silently breaks hit-testing with NaN/Infinity coords
      const hr = host.getBoundingClientRect();
      const w = Math.max(1, hr.width);
      const h = Math.max(1, hr.height);
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
      const { project, snap, previz2dView: view, fxSel } = useStore.getState();
      // refresh cached size every frame — see mapping() for why
      const hr = host.getBoundingClientRect();
      w = Math.max(1, hr.width);
      h = Math.max(1, hr.height);
      if (canvas.width !== Math.round(w * dpr)) canvas.width = Math.round(w * dpr);
      if (canvas.height !== Math.round(h * dpr)) canvas.height = Math.round(h * dpr);
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
      const headSrc = source === 'preview' ? (snap?.previewHeads ?? []) : (snap?.heads ?? []);
      for (const hs of headSrc) headMap.set(`${hs.f}:${hs.h}`, hs);

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

        // selection ring (marquee-hover counts as selected-in-progress)
        const mq = marqueeRef.current;
        const inMarquee =
          mq && mq.moved &&
          f.pos.x >= Math.min(mq.x0, mq.x1) && f.pos.x <= Math.max(mq.x0, mq.x1) &&
          vertOf(f.pos, view) >= Math.min(mq.v0, mq.v1) &&
          vertOf(f.pos, view) <= Math.max(mq.v0, mq.v1);
        if (fxSel.includes(f.id) || inMarquee) {
          ctx.beginPath();
          const selHalf = (prof.heads.length > 1 ? 0.72 : 0.3) * m.scale;
          ctx.setLineDash([4, 3]);
          ctx.strokeStyle = 'rgba(110,180,255,0.9)';
          ctx.lineWidth = 1.5;
          ctx.rect(fx - selHalf, fy - 0.3 * m.scale, selHalf * 2, 0.6 * m.scale);
          ctx.stroke();
          ctx.setLineDash([]);
        }

        ctx.fillStyle = 'rgba(255,255,255,0.28)';
        ctx.textAlign = 'center';
        ctx.font = '9px -apple-system, sans-serif';
        const label = view === 'front' ? `${f.name} · ${f.pos.y.toFixed(1)}m` : f.name;
        ctx.fillText(label, fx, fy + 0.42 * m.scale + 8);
      }

      // stage props (musicians) — plan view only; front view stays fixtures
      if (view === 'plan') {
        const LETTER: Record<string, string> = {
          vocalist: 'V', guitarist: 'G', bassist: 'B', drummer: 'D', keyboardist: 'K',
        };
        for (const pr of project.props ?? []) {
          const px = m.toX(pr.pos.x);
          const py = m.toY(pr.pos.z);
          const rad = 0.24 * m.scale;
          // shoulders + head silhouette
          ctx.beginPath();
          ctx.ellipse(px, py, rad, rad * 0.62, pr.rotY ?? 0, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(214,188,150,0.28)';
          ctx.fill();
          ctx.strokeStyle = 'rgba(214,188,150,0.75)';
          ctx.lineWidth = 1.2;
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(px, py, rad * 0.4, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(214,188,150,0.85)';
          ctx.fill();
          ctx.fillStyle = 'rgba(20,20,24,0.9)';
          ctx.font = `bold ${Math.max(8, rad * 0.55)}px -apple-system, sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(LETTER[pr.kind] ?? '?', px, py + 0.5);
          ctx.textBaseline = 'alphabetic';
        }
      }

      // marquee rectangle
      const mq = marqueeRef.current;
      if (mq && mq.moved) {
        const x0 = m.toX(Math.min(mq.x0, mq.x1));
        const x1 = m.toX(Math.max(mq.x0, mq.x1));
        const yA = m.toY(mq.v0);
        const yB = m.toY(mq.v1);
        const y0 = Math.min(yA, yB);
        const y1 = Math.max(yA, yB);
        ctx.fillStyle = 'rgba(110,180,255,0.08)';
        ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
        ctx.setLineDash([5, 4]);
        ctx.strokeStyle = 'rgba(110,180,255,0.7)';
        ctx.lineWidth = 1;
        ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
        ctx.setLineDash([]);
      }
    };
    raf = requestAnimationFrame(draw);

    const applyDrag = (
      id: string,
      x: number,
      v: number,
      others: { id: string; dx: number; dv: number }[],
    ) => {
      const view = useStore.getState().previz2dView;
      useStore.getState().mutate((p) => {
        const place = (fid: string, px: number, pv: number) => {
          const f = p.fixtures.find((fx) => fx.id === fid);
          if (!f) return;
          f.pos.x = Math.round(px * 20) / 20;
          if (view === 'plan') {
            f.pos.z = Math.round(pv * 20) / 20;
          } else {
            f.pos.y = Math.round(Math.min(6, Math.max(0, pv)) * 20) / 20;
          }
        };
        place(id, x, v);
        // a selected fixture drags the rest of the selection with it
        for (const o of others) place(o.id, x + o.dx, v + o.dv);
      });
    };

    const applyPropDrag = (id: string, x: number, v: number) => {
      useStore.getState().mutate((p) => {
        const pr = (p.props ?? []).find((y) => y.id === id);
        if (!pr) return;
        pr.pos.x = Math.round(x * 20) / 20;
        pr.pos.z = Math.round(v * 20) / 20;
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
      const { project, previz2dView: view, fxSel, setFxSel } = useStore.getState();
      if (!project) return;
      const rect = canvas.getBoundingClientRect();
      const m = mapping(view);
      const pos = m.fromPx(e.clientX - rect.left, e.clientY - rect.top);
      const additive = e.shiftKey || e.metaKey || e.ctrlKey;
      // stage props hit-test first (plan view only) — they render on top
      if (view === 'plan' && !additive) {
        let bestProp: { id: string; d: number } | null = null;
        for (const pr of project.props ?? []) {
          const d = Math.hypot(pr.pos.x - pos.x, pr.pos.z - pos.v);
          if (d < 0.35 && (!bestProp || d < bestProp.d)) bestProp = { id: pr.id, d };
        }
        if (bestProp) {
          const hit = bestProp;
          if (e.detail >= 2) {
            // double-click removes the musician
            const pr = project.props?.find((x) => x.id === hit.id);
            if (pr) {
              void askConfirm(`Remove this ${pr.kind}?`, { confirmLabel: 'Remove', danger: true }).then((ok) => {
                if (!ok) return;
                useStore.getState().mutate((p) => {
                  p.props = (p.props ?? []).filter((x) => x.id !== hit.id);
                  if (p.props.length === 0) delete p.props;
                });
              });
            }
            return;
          }
          dragRef.current = { id: hit.id, kind: 'prop', lastSend: 0, x: pos.x, v: pos.v, rot: 0, others: [] };
          try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic pointers */ }
          return;
        }
      }
      let best: { id: string; d: number } | null = null;
      for (const f of project.fixtures) {
        const d = Math.hypot(f.pos.x - pos.x, vertOf(f.pos, view) - pos.v);
        if (d < 0.6 && (!best || d < best.d)) best = { id: f.id, d };
      }
      if (best && additive) {
        // ⇧/⌘-click toggles membership — selection only, no drag
        setFxSel(
          fxSel.includes(best.id) ? fxSel.filter((id) => id !== best.id) : [...fxSel, best.id],
        );
        return;
      }
      if (best) {
        // ⌥-drag rotates (plan view only — yaw isn't meaningful in elevation)
        const kind = e.altKey && view === 'plan' ? 'rotate' : 'move';
        // clicking an unselected fixture makes it the sole selection;
        // dragging a selected one moves the whole selection together
        const sel = fxSel.includes(best.id) ? fxSel : [best.id];
        if (sel !== fxSel) setFxSel(sel);
        const grabbed = project.fixtures.find((f) => f.id === best.id)!;
        const others =
          kind === 'move'
            ? sel
                .filter((id) => id !== best.id)
                .flatMap((id) => {
                  const f = project.fixtures.find((fx) => fx.id === id);
                  return f
                    ? [{
                        id,
                        dx: f.pos.x - grabbed.pos.x,
                        dv: vertOf(f.pos, view) - vertOf(grabbed.pos, view),
                      }]
                    : [];
                })
            : [];
        dragRef.current = { id: best.id, kind, lastSend: 0, x: pos.x, v: pos.v, rot: 0, others };
        try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic pointers */ }
        return;
      }
      // empty space: marquee select
      marqueeRef.current = { x0: pos.x, v0: pos.v, x1: pos.x, v1: pos.v, additive, moved: false };
      try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic pointers */ }
    };
    const onPointerMove = (e: PointerEvent) => {
      const mq = marqueeRef.current;
      if (mq && e.buttons & 1) {
        const view = useStore.getState().previz2dView;
        const rect = canvas.getBoundingClientRect();
        const m = mapping(view);
        const pos = m.fromPx(e.clientX - rect.left, e.clientY - rect.top);
        mq.x1 = pos.x;
        mq.v1 = pos.v;
        if (Math.hypot(mq.x1 - mq.x0, mq.v1 - mq.v0) > 0.12) mq.moved = true;
        return;
      }
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
      else if (drag.kind === 'prop') applyPropDrag(drag.id, drag.x, drag.v);
      else applyDrag(drag.id, drag.x, drag.v, drag.others);
    };
    const onPointerUp = () => {
      const mq = marqueeRef.current;
      if (mq) {
        marqueeRef.current = null;
        const { project, previz2dView: view, fxSel, setFxSel } = useStore.getState();
        if (!project) return;
        if (!mq.moved) {
          // plain click on empty space clears the selection
          if (!mq.additive) setFxSel([]);
          return;
        }
        const inBox = project.fixtures
          .filter(
            (f) =>
              f.pos.x >= Math.min(mq.x0, mq.x1) && f.pos.x <= Math.max(mq.x0, mq.x1) &&
              vertOf(f.pos, view) >= Math.min(mq.v0, mq.v1) &&
              vertOf(f.pos, view) <= Math.max(mq.v0, mq.v1),
          )
          .map((f) => f.id);
        setFxSel(mq.additive ? [...new Set([...fxSel, ...inBox])] : inBox);
        return;
      }
      const drag = dragRef.current;
      dragRef.current = null;
      // flush the final value — the move throttle must not drop it
      if (!drag) return;
      if (drag.kind === 'rotate') applyRotate(drag.id, drag.rot);
      else if (drag.kind === 'prop') applyPropDrag(drag.id, drag.x, drag.v);
      else applyDrag(drag.id, drag.x, drag.v, drag.others);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
      if (e.key === 'Escape') useStore.getState().setFxSel([]);
    };
    window.addEventListener('keydown', onKeyDown);
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener('keydown', onKeyDown);
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
