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

