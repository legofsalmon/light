// The editor's small fields: the enable lamp, the three number boxes that all
// commit on blur/Enter rather than per keystroke, a wheel-slot picker, and the
// `→ dial` menu that points a dial at the row it sits on.

import React, { useEffect, useState } from 'react';
import type { Control, SoftField } from '../../../../shared/types.ts';
import { uid } from '../../../../shared/types.ts';
import { FIELD_LABEL } from '../../labels.ts';
import { describeDialLink } from '../../editNames.ts';
import { useStore } from '../../store.ts';

export function Enable({ on, toggle }: { on: boolean; toggle: () => void }) {
  return (
    <div
      className={`enable ${on ? 'on' : ''}`}
      role="checkbox"
      aria-checked={on}
      tabIndex={0}
      title={on ? 'this look sets it — click to leave it to the layers below' : 'left to the layers below — click to have this look set it'}
      onClick={toggle}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } }}
    />
  );
}

/** Seconds, committed on blur/Enter — per keystroke, "1.5" passed through "1"
 *  and wrote it to the show (review M12). Empty means "use the layer's fade". */
export function FadeInput({ value, placeholder, onCommit }: {
  value: number | undefined;
  placeholder: number;
  onCommit: (v: number | undefined) => void;
}) {
  const shown = value === undefined ? '' : String(value);
  const [draft, setDraft] = useState(shown);
  const ref = React.useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (document.activeElement !== ref.current) setDraft(value === undefined ? '' : String(value));
  }, [value]);
  const commit = () => {
    const t = draft.trim();
    const v = t === '' ? undefined : Math.max(0, Number(t));
    if (v !== undefined && !Number.isFinite(v)) { setDraft(shown); return; }
    if (v !== value) onCommit(v);
  };
  return (
    <input
      ref={ref}
      className="num"
      type="number"
      step="0.1"
      min="0"
      placeholder={String(placeholder)}
      title="fade in seconds — empty uses the layer's fade. Commits on Enter or when the field loses focus"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') { commit(); e.currentTarget.blur(); } }}
    />
  );
}

/** Small integer editor that commits on blur/Enter — the same discipline as
 *  BeatsInput below: clamping per keystroke makes a controlled field
 *  unclearable and floods a project write (plus an undo entry) per keypress. */
export function IntInput({ value, min, max, width = 44, title, onCommit }: {
  value: number;
  min: number;
  max: number;
  width?: number;
  title?: string;
  onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const ref = React.useRef<HTMLInputElement>(null);
  // never clobber a draft mid-edit — a project echo must not erase typing
  useEffect(() => {
    if (document.activeElement !== ref.current) setDraft(String(value));
  }, [value]);
  const commit = () => {
    const v = Math.floor(Number(draft));
    const clean = Number.isFinite(v) ? Math.min(Math.max(min, v), max) : value;
    setDraft(String(clean));
    if (clean !== value) onCommit(clean);
  };
  return (
    <input
      ref={ref}
      className="num"
      type="number"
      min={min}
      max={max}
      style={{ width }}
      title={title}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
    />
  );
}

/** Beats editor that commits on blur/Enter — per-keystroke clamping made
 *  fractional values untypeable ("0.5" clamped at "0") and the field
 *  unclearable. */
export function BeatsInput({ value, onCommit }: { value: number; onCommit: (v: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  const ref = React.useRef<HTMLInputElement>(null);
  // never clobber a draft mid-edit — a project echo must not erase what is
  // being typed; blur re-syncs (same guard as the other live-routing inputs)
  useEffect(() => {
    if (document.activeElement !== ref.current) setDraft(String(value));
  }, [value]);
  const commit = () => {
    const v = Number(draft);
    const clean = Number.isFinite(v) && v > 0 ? Math.min(v, 512) : 1;
    setDraft(String(clean));
    if (clean !== value) onCommit(clean);
  };
  return (
    <input
      ref={ref}
      className="num"
      title="how long this step holds, in beats — fractions allowed, committed on Enter or blur"
      type="number"
      min={0.25}
      step={0.25}
      style={{ width: 60 }}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
    />
  );
}

/** A wheel slot picker. "Not set" leaves the wheel where the fixture parks
 *  it, the same absent-means-untouched rule as every beam parameter; a slot
 *  past this list still shows, because another fixture in the group may
 *  have it. */
export function SlotRow({ label, title, names, value, onChange }: {
  label: string;
  title: string;
  names: string[];
  value: number | undefined;
  onChange: (v: number | undefined) => void;
}) {
  const beyond = value !== undefined && value >= names.length ? value : null;
  return (
    <div className="paramrow">
      <span className="label" style={{ marginLeft: 20 }}>{label}</span>
      <select
        className="sel"
        title={title}
        value={value === undefined ? '' : String(value)}
        onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
      >
        <option value="">not set — leave it where the fixture parks it</option>
        {names.map((n, i) => (
          <option key={i} value={String(i)}>{i === 0 ? n : `${i} · ${n}`}</option>
        ))}
        {beyond !== null && <option value={String(beyond)}>slot {beyond}</option>}
      </select>
    </div>
  );
}

/** `→ dial ▾` — point a dial at this row (design #41).
 *
 *  One knob driving many parameters is the answer to "I want this and this and
 *  this to move together", and until now the only way to build one was to open
 *  the dials page and rebuild the address by hand from three select menus. The
 *  row already knows its own address, so it offers it: pick a dial and the link
 *  is appended with a full 0→1 bracket, which is the bracket anyone wants first
 *  and the one they can narrow afterwards on the dials page.
 *
 *  It writes the show through the ordinary mutate path, so undo covers it and
 *  says what it undoes. */
export function DialMenu({ lookId, partId, effectId, fields }: {
  lookId: string;
  partId: string;
  effectId?: string;
  /** the addresses this row carries, in the order they are drawn */
  fields: readonly SoftField[];
}) {
  const controls = useStore((s) => s.project?.controls ?? []);
  const mutate = useStore((s) => s.mutate);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const btn = React.useRef<HTMLButtonElement>(null);

  const link = (field: SoftField, control: Control | null) => {
    setOpen(false);
    mutate((p) => {
      const row = { lookId, partId, effectId, field, min: 0, max: 1 };
      if (control) {
        const c = p.controls?.find((x) => x.id === control.id);
        if (c) c.links.push(row);
        return;
      }
      p.controls = [
        ...(p.controls ?? []),
        { id: uid('ctl'), name: `Dial ${(p.controls?.length ?? 0) + 1}`, value: 0, links: [row] },
      ];
    }, describeDialLink(control?.name, fields.length === 1 ? undefined : FIELD_LABEL[field]));
  };

  return (
    <div className="menuwrap">
      <button
        ref={btn}
        className="btn small ghost"
        title="point a dial at this — one knob then moves it along with everything else on that dial. The bracket starts at the full range and narrows on the dials page"
        onClick={() => {
          const r = btn.current?.getBoundingClientRect();
          if (r) setPos({ top: r.bottom + 2, left: Math.max(8, r.right - 200) });
          setOpen((o) => !o);
        }}
      >
        → dial ▾
      </button>
      {open && (
        <>
          <div className="modalveil" style={{ background: 'transparent' }} onPointerDown={() => setOpen(false)} />
          <div className="popover" style={{ top: pos.top, left: pos.left }}>
            {fields.map((f) => (
              <React.Fragment key={f}>
                {fields.length > 1 && <div className="menuhead">{FIELD_LABEL[f]}</div>}
                {controls.map((c) => (
                  <button
                    key={c.id}
                    className="btn small ghost"
                    title={`add ${FIELD_LABEL[f]} to this dial — it keeps whatever it already drives`}
                    onClick={() => link(f, c)}
                  >
                    {c.name}
                  </button>
                ))}
                <button
                  className="btn small ghost"
                  title={`make a new dial driving ${FIELD_LABEL[f]}, ready for more`}
                  onClick={() => link(f, null)}
                >
                  + new dial
                </button>
              </React.Fragment>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
