import React, { useEffect, useState } from 'react';

/** Number editor that commits on blur/Enter — universe numbers route live
 *  output, so half-typed values must never leave the field. */
export function NumInput({ value, min, max, width, onCommit }: {
  value: number;
  min: number;
  max: number;
  width?: number;
  onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const ref = React.useRef<HTMLInputElement>(null);
  useEffect(() => {
    // never clobber a draft mid-edit (an undo elsewhere changing this value
    // must not erase what the user is typing; blur re-syncs)
    if (document.activeElement !== ref.current) setDraft(String(value));
  }, [value]);
  const commit = () => {
    const v = Math.max(min, Math.min(max, Math.round(Number(draft)) || min));
    setDraft(String(v));
    if (v !== value) onCommit(v);
  };
  return (
    <input
      ref={ref}
      className="num"
      type="number"
      min={min}
      max={max}
      style={{ width: width ?? 58 }}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
    />
  );
}

export const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** Unicast IP editor — empty = broadcast; the engines only send to literal
 *  IPv4 addresses, so anything else is flagged rather than silently dropped. */
export function UnicastInput({ value, onCommit }: {
  value: string | null;
  onCommit: (v: string | null) => void;
}) {
  const [draft, setDraft] = useState(value ?? '');
  const ref = React.useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (document.activeElement !== ref.current) setDraft(value ?? '');
  }, [value]);
  const bad = draft !== '' && !IPV4.test(draft);
  const commit = () => {
    const v = draft.trim() === '' ? null : draft.trim();
    if (v !== (value ?? null)) onCommit(v);
  };
  return (
    <input
      ref={ref}
      className="text"
      style={{ width: 110, ...(bad ? { borderColor: 'var(--hot)', color: 'var(--hot)' } : {}) }}
      placeholder="broadcast"
      title={bad ? 'not an IPv4 address — output will fall back to broadcast' : 'unicast IP (empty = broadcast)'}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
    />
  );
}


/** Numeric field for the patch table: type freely (negatives and decimals
 *  commit on blur/Enter — per-keystroke parsing ate the minus sign), or
 *  press-and-drag horizontally on the field to scrub the value. A drag past
 *  4 px becomes a scrub and never focuses the input; a plain click edits.
 *  `onDelta` receives throttled increments so a multi-selection can move
 *  together; `onSet` receives typed absolute values. */
export function ScrubNumInput({ value, scrubStep, decimals, width, title, onSet, onDelta }: {
  value: number;
  /** value change per pixel of horizontal drag */
  scrubStep: number;
  decimals: number;
  width?: number;
  title?: string;
  onSet: (v: number) => void;
  onDelta: (d: number) => void;
}) {
  const fmt = (v: number) => v.toFixed(decimals).replace(/\.0+$|(\.\d*?)0+$/, '$1');
  const [draft, setDraft] = useState(fmt(value));
  const ref = React.useRef<HTMLInputElement>(null);
  const drag = React.useRef<{
    x: number;
    scrubbing: boolean;
    pending: number;
    lastEmit: number;
  } | null>(null);
  /** true while a scrub is in progress — the field must keep tracking the
   *  value even though the press focused the input */
  const scrubbing = React.useRef(false);
  /** set when a scrub ends: the programmatic blur that follows must NOT
   *  commit the pre-drag text over the value the scrub just produced */
  const skipCommit = React.useRef(false);

  useEffect(() => {
    if (scrubbing.current || document.activeElement !== ref.current) setDraft(fmt(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, decimals]);

  const commit = () => {
    if (skipCommit.current) {
      skipCommit.current = false; // the scrub already applied its deltas
      return;
    }
    const v = Number(draft);
    if (!Number.isFinite(v) || draft.trim() === '') {
      setDraft(fmt(value)); // unparseable or cleared — restore, never commit 0
      return;
    }
    // no-op guard: focusing a field and clicking away must not stamp this
    // row's value across a multi-selection
    if (v !== value) onSet(v);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLInputElement>) => {
    if (e.button !== 0 || document.activeElement === ref.current) return;
    drag.current = { x: e.clientX, scrubbing: false, pending: 0, lastEmit: 0 };
    const el = e.currentTarget;
    const onMove = (me: PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      if (!(me.buttons & 1)) {
        // the button came up outside the window — end the scrub, don't stick
        onUp();
        return;
      }
      const dx = me.clientX - d.x;
      if (!d.scrubbing) {
        if (Math.abs(dx) < 4) return;
        d.scrubbing = true;
        scrubbing.current = true;
        try { el.setPointerCapture(me.pointerId); } catch { /* synthetic */ }
      }
      d.pending += (me.clientX - d.x) * scrubStep;
      d.x = me.clientX;
      const now = performance.now();
      if (now - d.lastEmit >= 90 && d.pending !== 0) {
        d.lastEmit = now;
        onDelta(d.pending);
        d.pending = 0;
      }
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      const d = drag.current;
      drag.current = null;
      if (d?.scrubbing) {
        if (d.pending !== 0) onDelta(d.pending); // flush the tail
        scrubbing.current = false;
        skipCommit.current = true; // the blur below must not revert the drag
        el.blur();
      }
      // plain click: fall through to normal focus/caret behaviour
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  return (
    <input
      ref={ref}
      className="num"
      type="text"
      inputMode="decimal"
      style={{ width: width ?? 52, cursor: 'ew-resize' }}
      title={title ? `${title} — drag to scrub` : 'drag to scrub, click to type'}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
      onPointerDown={onPointerDown}
      onDragStart={(e) => e.preventDefault()}
    />
  );
}
