import React, { useEffect, useRef, useState } from 'react';
import { useStore } from '../store.ts';

/** One thing standing between the show and the room, and the verb that ends it.
 *
 *  `release` is the action; when it is null the hold is not something a button
 *  here can end (a muted fixture is un-muted in the rig, a held channel in the
 *  output check) and the row navigates instead. */
type Hold = {
  id: string;
  /** what is held, in the app's words */
  what: string;
  /** why it matters, for the row's help */
  why: string;
  /** the verb, and what it does */
  actions: { label: string; title: string; run: () => void }[];
  /** a hold that overrides blackout: the chip pulses while one is on */
  overridesBlackout?: boolean;
};

/**
 * Everything holding the rig away from the show, in one chip (design A4, P12).
 *
 * Before this the bar grew a chip per kind — `N muted`, `N dark`,
 * `N overrides`, `◎ finding`, `NUDGED N · Keep · Discard` — each with its own
 * treatment, and group levels below full showed only in the Pads groups row
 * while a held channel showed only in the output check. Five chips competing
 * for the same corner is how the bar came to wrap; and the one thing that
 * genuinely overrides blackout was the same shape as the four that do not.
 *
 * So: one amber chip that counts, and a list behind it with a row per kind
 * carrying the verb that already existed. The chip pulses only while something
 * is overriding blackout, because that is the state you must not be able to
 * leave on by accident.
 */
export function HeldChip() {
  const snap = useStore((s) => s.snap);
  const project = useStore((s) => s.project);
  const send = useStore((s) => s.send);
  const setView = useStore((s) => s.setView);
  const setTab = useStore((s) => s.setTab);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const boxRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', esc);
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', esc); };
  }, [open]);

  const holds: Hold[] = [];
  const nudged = snap?.soft?.length ?? 0;
  if (nudged > 0) {
    holds.push({
      id: 'nudged',
      what: `${nudged} nudged`,
      why: 'live values are driving the rig instead of what the looks have stored.',
      actions: [
        {
          label: 'Keep',
          title: 'write these live values into the show, so the looks keep them next time they fire (undoable)',
          run: () => send({ type: 'softCommit' }),
        },
        {
          label: 'Discard',
          title: 'throw the live values away and snap back to what the looks have stored',
          run: () => send({ type: 'softClear' }),
        },
      ],
    });
  }
  if (snap?.frozen) {
    holds.push({
      id: 'frozen',
      what: 'frame held',
      why: 'the rig is repeating one frame while the show runs on underneath.',
      actions: [{ label: 'release', title: 'let the show through to the rig again', run: () => send({ type: 'setFreeze', v: false }) }],
    });
  }
  if (snap?.identify) {
    const name = project?.fixtures.find((f) => f.id === snap.identify)?.name ?? 'a fixture';
    holds.push({
      id: 'finding',
      what: `finding ${name}`,
      why: 'held at full white so you can find it on the truss — the one thing that ignores blackout.',
      overridesBlackout: true,
      actions: [{ label: 'release', title: 'stop holding it at full white', run: () => send({ type: 'identify', fixtureId: null }) }],
    });
  }
  const down = (snap?.submasters ?? []).filter((s) => s.v < 1);
  if (down.length > 0) {
    const names = down
      .map((s) => project?.groups.find((g) => g.id === s.id)?.name)
      .filter((n): n is string => !!n);
    holds.push({
      id: 'groups',
      what: down.length === 1 ? `${names[0] ?? 'a group'} pulled down` : `${down.length} groups pulled down`,
      why: 'a group level below full scales every head in it, whatever the looks ask for.',
      actions: [{
        label: 'all up',
        title: 'put every group level back to full',
        run: () => { for (const s of down) send({ type: 'setSubmaster', groupId: s.id, v: 1 }); },
      }],
    });
  }
  const muted = snap?.muted?.length ?? 0;
  if (muted > 0) {
    holds.push({
      id: 'muted',
      what: `${muted} muted`,
      why: 'these fixtures are being sent all zeros whatever the show does.',
      actions: [{ label: 'show in Rig', title: 'open the rig and find them', run: () => setView('patch') }],
    });
  }
  const dark = snap?.unknownProfiles?.length ?? 0;
  if (dark > 0) {
    holds.push({
      id: 'dark',
      what: `${dark} dark`,
      why: 'these fixtures name a profile that is not in this show, so they render as nothing at all.',
      actions: [{ label: 'show in Rig', title: 'open the rig and re-assign them', run: () => setView('patch') }],
    });
  }
  const overrides = snap?.overrides ?? 0;
  if (overrides > 0) {
    holds.push({
      id: 'overrides',
      what: `${overrides} channel${overrides === 1 ? '' : 's'} held`,
      why: 'raw channel values are written last into the buffer — the show is not driving them.',
      actions: [{
        label: 'show in Output',
        title: 'open the channel check, where a held channel is released',
        run: () => { setView('split'); setTab('output'); },
      }],
    });
  }

  if (holds.length === 0) return null;
  const pulsing = holds.some((h) => h.overridesBlackout);

  return (
    <div ref={boxRef} style={{ position: 'relative' }}>
      <button
        ref={btnRef}
        className={`chip heldchip ${pulsing ? 'overriding' : ''}`}
        aria-haspopup="true"
        aria-expanded={open}
        title={`${holds.length} thing${holds.length === 1 ? '' : 's'} holding the rig away from the show — ${holds.map((h) => h.what).join(', ')}. Click for the list.`}
        onClick={() => {
          const r = btnRef.current?.getBoundingClientRect();
          if (r) setPos({ top: r.bottom + 2, left: Math.max(8, r.right - 320) });
          setOpen((o) => !o);
        }}
      >
        held · {holds.length}
      </button>
      {open && (
        <div className="popover heldlist" style={{ top: pos.top, left: pos.left }}>
          {holds.map((h) => (
            <div key={h.id} className="heldrow">
              <div className="grow">
                <div className="heldwhat">{h.what}</div>
                <div className="prose">{h.why}</div>
              </div>
              {h.actions.map((a) => (
                <button
                  key={a.label}
                  className="btn small ghost"
                  title={a.title}
                  onClick={() => { a.run(); setOpen(false); }}
                >
                  {a.label}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
