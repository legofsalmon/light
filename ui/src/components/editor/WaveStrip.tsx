// The wave, drawn, with where it is right now — and for a drawn wave, the
// place it is drawn.
//
// Every effect row had a word for its wave and nothing else: "ramp up" said
// what the shape was and nothing about where the rig was in it. This strip
// draws one cycle of the effect exactly as the engine computes it (the same
// waveValue), and a playhead in the live colour rides along it from the
// snapshot's beat, so the rig and the picture are the one thing.
//
// For a curve wave the strip is the editor: drag a point, drag a segment's
// middle to bend it, double-click to add a point, right-click or hold alt to
// remove one. The dashed run after the last point is the hold — the value the
// wave keeps until the cycle restarts — which is the whole reason a drawn wave
// exists.
import React, { useRef } from 'react';
import type { CurvePoint, Effect } from '../../../../shared/types.ts';
import { CURVE_MAX_POINTS, DEFAULT_CURVE, clamp } from '../../../../shared/types.ts';
import { curveEase, waveValue } from '../../../../shared/effects.ts';
import { useStore } from '../../store.ts';

/** samples across one cycle for the trace */
const SAMPLES = 96;
/** how close a pointer has to come to a point or a bend handle, in px */
const HIT_PX = 9;

/** Where the effect is in its cycle for the first head: `beat / rate + phase`,
 *  as the engine does it, with the engine's own rate correction — when the
 *  rate changes on a live look the renderer folds the jump into an offset so
 *  the wave stays continuous, and a playhead that did not do the same would
 *  leap while the rig did not. */
function useLivePhase(fx: Effect, rate: number): number {
  const beat = useStore((s) => s.snap?.beat ?? 0);
  const corr = useRef({ lastRate: rate, corr: 0 });
  const c = corr.current;
  if (c.lastRate !== rate) {
    if (c.lastRate > 0 && rate > 0) c.corr += beat * (1 / c.lastRate - 1 / rate);
    c.lastRate = rate;
  }
  return rate > 0 ? beat / rate + c.corr + fx.phase : fx.phase;
}

/** The segment a curve's bend handle sits on: its middle, and where it lands. */
function bendHandle(a: CurvePoint, b: CurvePoint): { t: number; v: number } {
  return { t: (a.t + b.t) / 2, v: a.v + (b.v - a.v) * curveEase(0.5, a.bend) };
}

export function WaveStrip({ fx, rate, onCurve, width, height }: {
  fx: Effect;
  /** the live rate — a nudge may be riding it */
  rate: number;
  /** a drawn wave's points changed; absent for the waves that are not drawn */
  onCurve?: (points: CurvePoint[]) => void;
  width: number;
  height: number;
}): React.ReactElement {
  const editable = fx.wave === 'curve' && !!onCurve;
  const points: readonly CurvePoint[] = fx.curve ?? DEFAULT_CURVE;
  const phase = useLivePhase(fx, rate);
  const p01 = ((phase % 1) + 1) % 1;
  const now = waveValue(fx, phase, 0);
  const svg = useRef<SVGSVGElement>(null);
  /** what a pointer is dragging, if anything */
  const drag = useRef<{ kind: 'point' | 'bend'; i: number } | null>(null);

  // the trace, sampled the way the engine would see it — one extra sample at
  // the very end so a square's last step reaches the edge
  const X = (t: number): number => t * width;
  const Y = (v: number): number => height - v * height;
  const trace: string[] = [];
  for (let i = 0; i <= SAMPLES; i++) {
    const t = Math.min(i / SAMPLES, 0.999999);
    trace.push(`${X(t).toFixed(1)},${Y(waveValue(fx, t, 0)).toFixed(1)}`);
  }

  /** pointer position as (t, v) in the wave's own units */
  const at = (e: React.PointerEvent | React.MouseEvent): { t: number; v: number } => {
    const r = svg.current!.getBoundingClientRect();
    return { t: clamp((e.clientX - r.left) / r.width), v: clamp(1 - (e.clientY - r.top) / r.height) };
  };
  const nearest = (e: React.PointerEvent | React.MouseEvent): { kind: 'point' | 'bend'; i: number } | null => {
    const r = svg.current!.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    let best: { kind: 'point' | 'bend'; i: number; d: number } | null = null;
    points.forEach((pt, i) => {
      const d = Math.hypot(X(pt.t) - px, Y(pt.v) - py);
      if (d <= HIT_PX && (!best || d < best.d)) best = { kind: 'point', i, d };
    });
    for (let i = 0; i < points.length - 1; i++) {
      if (points[i]!.v === points[i + 1]!.v) continue; // a flat segment has nothing to bend
      const h = bendHandle(points[i]!, points[i + 1]!);
      const d = Math.hypot(X(h.t) - px, Y(h.v) - py);
      if (d <= HIT_PX && (!best || d < best.d)) best = { kind: 'bend', i, d };
    }
    return best;
  };
  const write = (next: CurvePoint[]) => onCurve?.(next.map((p) => ({ t: p.t, v: p.v, bend: p.bend })));

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!editable) return;
    const hit = nearest(e);
    if (e.button === 2 || (e.button === 0 && e.altKey)) {
      // remove — but a wave keeps at least one point
      if (hit?.kind === 'point' && points.length > 1) write(points.filter((_, i) => i !== hit.i));
      e.preventDefault();
      return;
    }
    if (e.button !== 0) return;
    if (hit) {
      drag.current = hit;
      // capture so a drag that leaves the strip still lands; a pointer the
      // browser does not know (a synthetic one, in a test) cannot be captured
      // and the drag works without it
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* not a live pointer */ }
      e.preventDefault();
    }
  };
  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (!d || !editable) return;
    const m = at(e);
    if (d.kind === 'point') {
      // a point moves between its neighbours, never past them: the order is the wave
      const lo = d.i > 0 ? points[d.i - 1]!.t : 0;
      const hi = d.i < points.length - 1 ? points[d.i + 1]!.t : 1;
      write(points.map((p, i) => (i === d.i ? { ...p, t: clamp(m.t, lo, hi), v: m.v } : p)));
    } else {
      // the handle sits where the segment passes its middle: with bend b that
      // is 0.5 + b/4 of the way from the start value to the end value, so
      // where the pointer is along that span says what the bend must be
      const a = points[d.i]!;
      const b = points[d.i + 1]!;
      const frac = (m.v - a.v) / (b.v - a.v);
      write(points.map((p, i) => (i === d.i ? { ...p, bend: clamp(4 * (frac - 0.5), -1, 1) } : p)));
    }
  };
  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    if (drag.current) {
      try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* never captured */ }
    }
    drag.current = null;
  };
  const onDoubleClick = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!editable || nearest(e) || points.length >= CURVE_MAX_POINTS) return;
    const m = at(e);
    const next = [...points, { t: m.t, v: m.v, bend: 0 }].sort((a, b) => a.t - b.t);
    write(next);
  };

  const last = points[points.length - 1]!;
  return (
    <svg
      ref={svg}
      className={`wavestrip ${editable ? 'editable' : ''}`}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role={editable ? 'application' : 'img'}
      aria-label={editable ? 'the drawn wave: drag its points' : 'the wave, and where it is now'}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={onDoubleClick}
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* SVG's own tooltip: an svg element has no title attribute */}
      <title>
        {editable
          ? 'the wave you draw — drag a point; drag the middle of a segment to bend it; double-click to add a point; right-click (or alt-click) to remove one. After the last point the value holds until the cycle restarts'
          : 'one cycle of this effect, and where it is right now — the mark travels along the wave as the rig plays it'}
      </title>
      <polyline className="trace" points={trace.join(' ')} />
      {editable && last.t < 1 && (
        // the hold: drawn dashed so it reads as "and stays there"
        <line className="hold" x1={X(last.t)} y1={Y(last.v)} x2={width} y2={Y(last.v)} />
      )}
      {editable && points.slice(0, -1).map((a, i) => {
        const b = points[i + 1]!;
        if (a.v === b.v) return null;
        const h = bendHandle(a, b);
        return <circle key={`b${i}`} className="bend" cx={X(h.t)} cy={Y(h.v)} r={3} />;
      })}
      {editable && points.map((p, i) => <circle key={`p${i}`} className="pt" cx={X(p.t)} cy={Y(p.v)} r={4} />)}
      <line className="playhead" x1={X(p01)} y1={0} x2={X(p01)} y2={height} />
      <circle className="now" cx={X(p01)} cy={Y(now)} r={3} />
    </svg>
  );
}
