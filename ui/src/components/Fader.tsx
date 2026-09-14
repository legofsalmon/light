import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { MidiAction } from '../../../shared/types.ts';
import { clamp } from '../../../shared/types.ts';
import { useStore } from '../store.ts';
import { hardwareAt } from '../midiPos.ts';
import { bindingOf } from '../midiBindings.ts';
import { size } from '../tokens.ts';
import '../styles/editor.css';

/** The one unit rule (design 3.2): a percentage reads `45 %` with a thin
 *  space before the sign. Masters use no formatter and read bare — `100` is
 *  full. Every fader that shows a percentage formats with this. */
export const fmtPct = (v: number): string => `${Math.round(v * 100)}\u2009%`;

/** How far the hardware may sit from the value before it is worth saying so.
 *  Two percent is under one step of a 7-bit CC, so a fader the operator has
 *  just moved by hand never accuses itself. */
const HW_SLOP = 0.02;

/** The digits out of a readout — `45 %` is 45, `3200K` is 3200, `1.00×` is 1.
 *  What the operator types back is what the readout showed them. */
const digitsOf = (s: string): number => Number(s.replace(/[^0-9.eE+-]/g, ''));

/** The accessible name. The caption when there is one; otherwise the first
 *  clause of the help string, because `title` is a whole sentence and a screen
 *  reader wants the control's name rather than its paragraph. */
const nameOf = (label?: string, help?: string): string => {
  const l = label?.trim();
  if (l) return l;
  const h = help?.trim();
  if (!h) return 'level';
  return h.split(/ — |\. /)[0];
};

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
  /** double-click and right-click reset */
  def?: number;
  width?: number | string;
  variant?: 'accent' | 'dim' | 'hue';
  /** midi-learn action for this control */
  learn?: MidiAction;
};

export function Fader({ value, onChange, label, help, fmt, min = 0, max = 1, def, width, variant = 'accent', learn }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const norm = clamp((value - min) / (max - min));
  // Where the controller bound to this fader physically sits, if anything has
  // moved it this session.
  const midiCc = useStore((st) => st.midiCc);
  const project = useStore((st) => st.project);
  const hw = hardwareAt(project, midiCc, learn);
  const learnMode = useStore((s) => s.learnMode);
  const binding = learnMode && learn ? bindingOf(project, learn) : null;
  const learnTarget = useStore((s) => s.learnTarget);
  const armed = !!learn && !!learnTarget && JSON.stringify(learnTarget) === JSON.stringify(learn);

  const show = useCallback(
    (v: number): string => (fmt ? fmt(v) : `${Math.round(clamp((v - min) / (max - min)) * 100)}`),
    [fmt, min, max],
  );

  /** The typed number read back into the value. Every formatter in the app is
   *  affine in the value, so two samples invert it: 45 typed into a percentage
   *  is 0.45, and 3200 typed into a warmth is the position that lands there. */
  const readback = useCallback(
    (typed: number): number => {
      const lo = digitsOf(show(min));
      const hi = digitsOf(show(max));
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi === lo) return typed;
      return min + ((typed - lo) / (hi - lo)) * (max - min);
    },
    [show, min, max],
  );

  // Typing the value. The readout is the field: it opens on a click or on the
  // first digit, commits on Enter or blur, and Esc puts it back.
  const [typing, setTyping] = useState<string | null>(null);
  const typeRef = useRef<HTMLInputElement>(null);
  // Opened by a click: the old reading is selected, so typing replaces it.
  // Opened by a digit: that digit is the first of the new reading, so the
  // caret goes after it — selecting would eat it on the second keystroke.
  const replaceAll = useRef(true);
  const wasTyping = useRef(false);
  const isTyping = typing !== null;
  useEffect(() => {
    const el = typeRef.current;
    if (isTyping && el) {
      el.focus();
      if (replaceAll.current) el.select();
      else el.setSelectionRange(el.value.length, el.value.length);
    }
    // and when the field closes the fader takes the keyboard back, so the
    // arrows are still there straight after a value is typed
    if (!isTyping && wasTyping.current) ref.current?.focus();
    wasTyping.current = isTyping;
  }, [isTyping]);
  // Enter and Esc both take the field away, and removing it blurs it — so the
  // blur handler arrives after the decision has already been made, holding the
  // same text. One latch per opening, so Esc cannot be overruled by the blur
  // behind it and Enter cannot write the show twice.
  const settled = useRef(false);
  const openTyping = (seed?: string) => {
    replaceAll.current = seed === undefined;
    settled.current = false;
    setTyping(seed ?? String(digitsOf(show(value))));
  };
  const closeTyping = (commit: boolean) => {
    if (settled.current) return;
    settled.current = true;
    const t = typing;
    setTyping(null);
    if (!commit || t === null) return;
    const s = t.trim();
    if (s === '') return;
    const n = Number(s);
    if (!Number.isFinite(n)) return;
    const v = readback(n);
    const lo = Math.min(min, max);
    const hi = Math.max(min, max);
    onChange(Math.min(Math.max(lo, v), hi));
  };

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
    // The fader KEEPS focus after pointer-up, so the arrows work after a click
    // in the booth (design 2.6). The safety is the guard below and the window
    // handler's own step-aside for [role="slider"], not a dropped focus: the
    // first keydown of a repeat fires before `e.repeat` can be dropped, so
    // letting go of focus would not have closed the hazard anyway.
    ref.current?.focus();
    setFromEvent(e);
  };

  const step = (max - min) / 100;
  /** The arrows, the ends and the digits belong to the fader, and stop here —
   *  a digit that reached the window handler would fire a column (design 2.6).
   *  Same shape as the colour disc's own guard. */
  const onKeyDown = (e: React.KeyboardEvent) => {
    const mul = e.shiftKey ? 10 : 1;
    const lo = Math.min(min, max);
    const hi = Math.max(min, max);
    const put = (v: number) => onChange(Math.min(Math.max(lo, v), hi));
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') put(value - step * mul);
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') put(value + step * mul);
    else if (e.key === 'Home') put(min);
    else if (e.key === 'End') put(max);
    else if (e.key === 'Enter' || e.key === ' ') openTyping();
    else if (/^[0-9.-]$/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) openTyping(e.key);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div
      ref={ref}
      className={`fader ${variant === 'dim' ? 'dim' : ''} ${variant === 'hue' ? 'hue' : ''} ${learn ? 'learnable' : ''} ${armed ? 'learn-armed' : ''}`}
      style={{ width }}
      role="slider"
      tabIndex={0}
      aria-label={nameOf(label, help)}
      aria-valuenow={Number(value.toFixed(4))}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuetext={show(value)}
      onPointerDown={onPointerDown}
      onPointerMove={(e) => {
        if (e.buttons & 1 && e.currentTarget.hasPointerCapture(e.pointerId)) setFromEvent(e);
      }}
      onKeyDown={onKeyDown}
      onDoubleClick={() => def !== undefined && onChange(def)}
      onContextMenu={(e) => {
        if (def === undefined) return;
        e.preventDefault();
        onChange(def);
      }}
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
      {/* Where the hardware is, when that is not where the value is (A35, the
          blue bar Hog draws for the same reason). An APC's faders and knobs are
          absolute: after a song switch, a look change or anyone touching the
          screen, the physical control is wherever it was left, and the next
          touch of it JUMPS the value there. This is the warning that the jump
          is coming, and roughly how far. */}
      {/* While learn is armed, every mappable control says what it already
          answers to — or that nothing does (design #32, A48). Arena prints the
          same thing for the same reason: the questions learn mode cannot
          answer are exactly the ones worth asking at 1 a.m. A key shared with
          a DIFFERENT control reads hot, because a press then does both. */}
      {learnMode && learn && (
        <div className={`bindtag ${binding?.clash ? 'clash' : ''} ${binding ? '' : 'unbound'}`} aria-hidden="true">
          {binding ? binding.text : 'unbound'}
        </div>
      )}
      {hw !== null && Math.abs(hw - norm) > HW_SLOP && (
        <div
          className="hwtick"
          style={{ left: `calc((100% - var(--size-value-w)) * ${hw})` }}
          title={`your controller is at ${Math.round(hw * 100)}\u2009% — touching it will jump this there`}
          aria-hidden="true"
        />
      )}
      <div className="val">
        <span>{label}</span>
        {typing !== null ? (
          <input
            ref={typeRef}
            className="faderin"
            style={{ flex: '0 0 var(--size-value-w)' }}
            value={typing}
            inputMode="decimal"
            aria-label={`${nameOf(label, help)} value`}
            onChange={(e) => setTyping(e.target.value)}
            onBlur={() => closeTyping(true)}
            onPointerDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') closeTyping(true);
              else if (e.key === 'Escape') closeTyping(false);
            }}
          />
        ) : (
          <b
            className="faderval"
            style={{ flex: '0 0 var(--size-value-w)', textAlign: 'right' }}
            title="click to type a value"
            onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); }}
            onClick={() => openTyping()}
          >
            {show(value)}
          </b>
        )}
      </div>
    </div>
  );
}
