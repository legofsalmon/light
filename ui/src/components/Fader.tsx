import React, { useCallback, useRef } from 'react';
import type { MidiAction } from '../../../shared/types.ts';
import { clamp } from '../../../shared/types.ts';
import { useStore } from '../store.ts';
import { size } from '../tokens.ts';

/** The one unit rule (design 3.2): a percentage reads `45 %` with a thin
 *  space before the sign. Masters use no formatter and read bare — `100` is
 *  full. Every fader that shows a percentage formats with this. */
export const fmtPct = (v: number): string => `${Math.round(v * 100)}\u2009%`;

type Props = {
  value: number;
  onChange: (v: number) => void;
  label?: string;
  /** tooltip. Falls back to the label — but a fader whose caption is drawn
   *  outside it has no label at all, and those are the ones that most need to
   *  say what they do. */
  help?: string;
  /** value formatter shown right-aligned */
  fmt?: (v: number) => string;
  min?: number;
  max?: number;
  /** double-click reset */
  def?: number;
  width?: number | string;
  variant?: 'accent' | 'dim' | 'hue';
  /** midi-learn action for this control */
  learn?: MidiAction;
};

export function Fader({ value, onChange, label, help, fmt, min = 0, max = 1, def, width, variant = 'accent', learn }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const norm = clamp((value - min) / (max - min));
  const learnMode = useStore((s) => s.learnMode);
  const learnTarget = useStore((s) => s.learnTarget);
  const armed = !!learn && !!learnTarget && JSON.stringify(learnTarget) === JSON.stringify(learn);

  const setFromEvent = useCallback(
    (e: PointerEvent | React.PointerEvent) => {
      const el = ref.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      // the pointer runs the track, not the value column beside it, so the
      // fill's edge stays under the finger and the right end of the track is full
      const trackW = variant === 'hue' ? r.width : r.width - size['value-w'];
      const n = clamp((e.clientX - r.left) / Math.max(1, trackW));
      onChange(min + n * (max - min));
    },
    [onChange, min, max, variant]
  );

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if (learn && learnMode) {
      useStore.getState().armLearn(learn);
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    setFromEvent(e);
  };

  return (
    <div
      ref={ref}
      className={`fader ${variant === 'dim' ? 'dim' : ''} ${variant === 'hue' ? 'hue' : ''} ${learn ? 'learnable' : ''} ${armed ? 'learn-armed' : ''}`}
      style={{ width }}
      onPointerDown={onPointerDown}
      onPointerMove={(e) => {
        if (e.buttons & 1 && e.currentTarget.hasPointerCapture(e.pointerId)) setFromEvent(e);
      }}
      onDoubleClick={() => def !== undefined && onChange(def)}
      title={help ?? label}
    >
      {variant === 'hue' ? (
        <div className="marker" style={{ left: `${norm * 100}%` }} />
      ) : (
        // The fill runs over the track only: the value has a mono column of
        // its own at the right edge (--size-value-w) that the fill never
        // reaches, so a reading is never struck through by the fill's edge.
        <div className="fill" style={{ width: `calc((100% - var(--size-value-w)) * ${norm})` }} />
      )}
      <div className="val">
        <span>{label}</span>
        <b style={{ flex: '0 0 var(--size-value-w)', textAlign: 'right' }}>{fmt ? fmt(value) : `${Math.round(norm * 100)}`}</b>
      </div>
    </div>
  );
}
