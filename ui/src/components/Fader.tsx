import React, { useCallback, useRef } from 'react';
import type { MidiAction } from '../../../shared/types.ts';
import { clamp } from '../../../shared/types.ts';
import { useStore } from '../store.ts';

type Props = {
  value: number;
  onChange: (v: number) => void;
  label?: string;
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

export function Fader({ value, onChange, label, fmt, min = 0, max = 1, def, width, variant = 'accent', learn }: Props) {
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
      const n = clamp((e.clientX - r.left) / r.width);
      onChange(min + n * (max - min));
    },
    [onChange, min, max]
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
      title={label}
    >
      {variant === 'hue' ? (
        <div className="marker" style={{ left: `${norm * 100}%` }} />
      ) : (
        <div className="fill" style={{ width: `${norm * 100}%` }} />
      )}
      <div className="val">
        <span>{label}</span>
        <b>{fmt ? fmt(value) : `${Math.round(norm * 100)}`}</b>
      </div>
    </div>
  );
}
