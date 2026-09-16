// The small pieces the Rig page's sections share: the live pair, the address
// cell, a popover that stays on screen, and the calibration controls.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Glyph } from '../../glyphs.tsx';
import type { Fixture } from '../../../../shared/types.ts';
import { LONG_PRESS_MS } from '../../touch.ts';
import { useStore } from '../../store.ts';
import { ScrubNumInput } from '../inputs.tsx';

/** true when the pointer event originated inside an editing control */
export function onControl(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest('input,select,button,label,option');
}

/** A panel hung off a button, pulled back into the window once it has a real
 *  size. Padding and borders make an estimate wrong by tens of pixels, which is
 *  exactly enough to leave an edge off the screen. */
export function usePopover() {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  React.useLayoutEffect(() => {
    const el = popRef.current;
    if (!open || !el) return;
    const r = el.getBoundingClientRect();
    const left = Math.max(8, Math.min(pos.left, window.innerWidth - r.width - 8));
    const top = Math.max(8, Math.min(pos.top, window.innerHeight - r.height - 8));
    if (Math.abs(left - pos.left) > 0.5 || Math.abs(top - pos.top) > 0.5) setPos({ top, left });
  }, [open, pos.left, pos.top]);
  const toggle = useCallback(() => {
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setPos({ top: r.bottom + 2, left: r.left });
    setOpen((o) => !o);
  }, []);
  return { open, setOpen, pos, btnRef, popRef, toggle };
}

/** Mute: this fixture receives all zeros until it is brought back. A click,
 *  because a stuck unit during a show is something you kill now. */
export function MuteButton({ fixtureId, muted }: { fixtureId: string; muted: boolean }): React.ReactElement {
  const send = useStore((s) => s.send);
  return (
    <button
      type="button"
      className={`livebtn ${muted ? 'muted' : ''}`}
      aria-pressed={muted}
      title={muted
        ? 'muted — this fixture is receiving all zeros. Click to bring it back.'
        : 'mute: silence this fixture without touching the rig (a stuck or dead unit)'}
      onClick={() => send({ type: 'setFixtureMute', fixtureId, on: !muted })}
    >
      <i className="lamp" />
    </button>
  );
}

/** Find this light: drive it to full white so you can spot it on the truss.
 *
 *  Behind a hold, and the only control on this page that is: it overrides
 *  blackout, so on a dark stage mid-set a mis-click is a lit fixture nobody
 *  asked for. The ring fills over --motion-hold, which is the same number the
 *  timer counts (touch.ts reads the token). Turning it OFF is a plain click —
 *  stopping something is never worth a wait. */
export function FindButton({ fixtureId, on }: { fixtureId: string; on: boolean }): React.ReactElement {
  const send = useStore((s) => s.send);
  const [holding, setHolding] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = useRef({ x: 0, y: 0 });
  const stop = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setHolding(false);
  }, []);
  useEffect(() => stop, [stop]);
  const begin = (x: number, y: number) => {
    if (on) {
      send({ type: 'identify', fixtureId: null });
      return;
    }
    start.current = { x, y };
    setHolding(true);
    timer.current = setTimeout(() => {
      timer.current = null;
      setHolding(false);
      send({ type: 'identify', fixtureId });
    }, LONG_PRESS_MS);
  };
  return (
    <button
      type="button"
      className={`livebtn ${on ? 'on' : ''} ${holding ? 'holding' : ''}`}
      aria-pressed={on}
      title={on
        ? 'this light is lit so you can find it on the truss — click to stop'
        : 'find this light: hold to drive it to full white. It overrides blackout, so it is a hold, not a click.'}
      onPointerDown={(e) => { if (e.button === 0) begin(e.clientX, e.clientY); }}
      onPointerMove={(e) => { if (timer.current && Math.hypot(e.clientX - start.current.x, e.clientY - start.current.y) > 8) stop(); }}
      onPointerUp={stop}
      onPointerCancel={stop}
      onPointerLeave={stop}
      onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) { e.preventDefault(); begin(0, 0); } }}
      onKeyUp={stop}
    >
      <Glyph name="find" alone />
      <span className="ring" aria-hidden="true" />
    </button>
  );
}

/** The address as one mono span — `1–49`, the range the fixture answers to —
 *  that becomes an input when you click it. Commits on Enter or blur, never
 *  per keystroke, so a half-typed address never reaches the rig and a sorted
 *  table does not jump mid-edit. */
export function AddressCell({ value, channels, conflict, onCommit }: {
  value: number;
  channels: number;
  conflict: boolean;
  onCommit: (v: number) => void;
}): React.ReactElement {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(value));
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (document.activeElement !== ref.current) setDraft(String(value));
  }, [value]);
  useEffect(() => {
    if (editing) ref.current?.select();
  }, [editing]);
  const commit = () => {
    const v = Math.max(1, Math.min(512, Number(draft) || 1));
    setDraft(String(v));
    setEditing(false);
    if (v !== value) onCommit(v);
  };
  if (editing) {
    return (
      <input
        ref={ref}
        className={`num mono ${conflict ? 'conflict' : ''}`}
        type="number"
        min={1}
        max={512}
        style={{ width: '100%' }}
        value={draft}
        title="DMX start address in this universe (1–512). Commits on Enter or when you click away."
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') { setDraft(String(value)); setEditing(false); }
        }}
      />
    );
  }
  return (
    <span
      className={`mono addr ${conflict ? 'conflict' : ''}`}
      role="button"
      tabIndex={0}
      title={conflict
        ? 'address overlap — another fixture on this universe already uses part of this range. Click to change it.'
        : 'the channels this fixture answers to. Click to set its start address.'}
      onClick={() => setEditing(true)}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); setEditing(true); } }}
    >
      {value}–{value + Math.max(1, channels) - 1}
    </span>
  );
}

/** The base aim as an angle, beside the percentage it is stored as. A
 *  percentage is what the wire carries; an angle is what someone standing
 *  under the truss can check. */
export function AimDegrees({ value, travel }: { value: number | undefined; travel: number }): React.ReactElement {
  const deg = ((value ?? 0.5) - 0.5) * travel;
  const shown = Math.abs(deg) < 0.5 ? '0°' : `${deg > 0 ? '+' : '−'}${Math.round(Math.abs(deg))}°`;
  return (
    <span
      className="label dim mono"
      title={`${Math.round(travel)}° of travel on this fixture, centre to centre`}
    >
      {shown}
    </span>
  );
}

/** How this head is WIRED — which way its axes run and how far it may swing.
 *  Nothing to do with where it points: the base aim stays exactly where it was
 *  focused. In the inspector, so the row does not have to carry it. */
export function CalControls({ fixture }: { fixture: Fixture }): React.ReactElement {
  const mutate = useStore((s) => s.mutate);
  const cal = fixture.cal;
  const edit = (fn: (c: NonNullable<Fixture['cal']>) => void, label: string) =>
    mutate((p) => {
      const f = p.fixtures.find((x) => x.id === fixture.id);
      if (!f) return;
      const c = { ...(f.cal ?? {}) };
      fn(c);
      // A block that corrects nothing is removed rather than stored: both
      // engines drop it on the way in, so keeping it would mean the same show
      // had two shapes depending on who last touched it.
      const live = Object.entries(c).filter(([k, v]) =>
        typeof v === 'boolean' ? v : k.endsWith('Min') ? (v as number) > 0 : (v as number) < 1);
      if (live.length === 0) delete f.cal;
      else f.cal = Object.fromEntries(live) as Fixture['cal'];
    }, label);
  const pct = (v: number | undefined, def: number) => Math.round((v ?? def) * 100);
  const setLimit = (key: 'panMin' | 'panMax' | 'tiltMin' | 'tiltMax', v: number) =>
    edit((c) => {
      c[key] = Math.min(1, Math.max(0, v / 100));
    }, `set ${fixture.name} ${key.startsWith('pan') ? 'pan' : 'tilt'} limit`);
  return (
    <div className="inspectgrid">
      {([
        ['invertPan', 'pan runs backwards'],
        ['invertTilt', 'tilt runs backwards'],
        ['swap', 'hung on its side'],
      ] as const).map(([k, label]) => (
        <button
          key={k}
          className={`btn small ${cal?.[k] ? 'on' : 'ghost'}`}
          title={`${label} — how the head is wired. The base aim stays where you focused it.`}
          onClick={() => edit((c) => {
            if (c[k]) delete c[k];
            else c[k] = true;
          }, `${cal?.[k] ? 'clear' : 'set'} ${fixture.name} ${label}`)}
        >
          {cal?.[k] ? <Glyph name="tick" /> : null}{label}
        </button>
      ))}
      {([
        ['pan', 'panMin', 'panMax'],
        ['tilt', 'tiltMin', 'tiltMax'],
      ] as const).map(([axis, lo, hi]) => (
        <span className="inspectfield" key={axis}>
          <span className="label">{axis} limits</span>
          <ScrubNumInput
            value={pct(cal?.[lo], 0)}
            scrubStep={0.5}
            decimals={0}
            width={44}
            title={`lowest this head may be driven, as a percentage of its ${axis} travel`}
            onSet={(v) => setLimit(lo, v)}
            onDelta={(d) => setLimit(lo, pct(cal?.[lo], 0) + d)}
          />
          <span className="label dim">to</span>
          <ScrubNumInput
            value={pct(cal?.[hi], 1)}
            scrubStep={0.5}
            decimals={0}
            width={44}
            title={`highest this head may be driven, as a percentage of its ${axis} travel`}
            onSet={(v) => setLimit(hi, v)}
            onDelta={(d) => setLimit(hi, pct(cal?.[hi], 1) + d)}
          />
        </span>
      ))}
      {fixture.cal && (
        <button
          className="btn small ghost"
          title="clear every correction on this head"
          onClick={() => mutate((p) => {
            const f = p.fixtures.find((x) => x.id === fixture.id);
            if (f) delete f.cal;
          }, `clear ${fixture.name} calibration`)}
        >
          clear all
        </button>
      )}
    </div>
  );
}
