// The lock line (design 2.11): `[lock] locked · hold to unlock`.
//
// The key is the unlock control and a hold is the whole gesture — half a
// second with the ring drawing round the key, then the passcode if one is set.
// A tap does nothing, deliberately: this sits on the bottom bar of a tablet at
// front of house, where a brushed elbow is the exact thing it exists to catch.
//
// Nothing here reaches the rig. Unlocking opens the Rig page; it fires no cue,
// clears no layer and sends no command.

import React, { useEffect, useRef, useState } from 'react';
import { useLock, lockedByDefault } from '../../lockStore.ts';
import { askPrompt } from '../../dialog.tsx';
import { notify } from '../../store.ts';
import { LONG_PRESS_MS } from '../../touch.ts';
import '../../styles/setup.css';

/** a finger wobbles on a hold; a swipe is somebody scrolling */
const SLOP_PX = 8;

export function LockBar(): React.ReactElement {
  const locked = useLock((s) => s.locked);
  const passcode = useLock((s) => s.passcode);
  const [holding, setHolding] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const from = useRef({ x: 0, y: 0 });
  // The hold can outlive the element (an unlock re-renders the whole bar away),
  // so the timer is cleared on the way out rather than left to fire into
  // nothing.
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const stop = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setHolding(false);
  };

  const held = () => {
    stop();
    if (!passcode) {
      useLock.getState().unlock();
      return;
    }
    void (async () => {
      const typed = await askPrompt('Passcode', '', {
        body: 'The passcode set on this client. It is a deterrent held in this browser, not security.',
        placeholder: 'passcode',
        confirmLabel: 'Unlock',
      });
      if (typed === null) return; // they changed their mind; stay locked, say nothing
      if (typed === passcode) useLock.getState().unlock();
      else notify('That is not the passcode — still locked', false);
    })();
  };

  const start = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0 || !locked) return;
    from.current = { x: e.clientX, y: e.clientY };
    stop();
    setHolding(true);
    timer.current = setTimeout(held, LONG_PRESS_MS);
  };

  return (
    <div className="lockbar">
      <button
        className={`btn lockkey ${holding ? 'holding' : ''}`}
        aria-pressed={locked}
        title={
          locked
            ? 'hold this to unlock — the Rig page comes back. A tap does nothing, so a leaning elbow cannot open it'
            : 'lock this client to the pads again. It locks itself on a reconnect, a reload, or thirty seconds untouched'
        }
        onPointerDown={start}
        onPointerMove={(e) => {
          if (timer.current && Math.hypot(e.clientX - from.current.x, e.clientY - from.current.y) > SLOP_PX) stop();
        }}
        onPointerUp={stop}
        onPointerCancel={stop}
        onPointerLeave={stop}
        onContextMenu={(e) => e.preventDefault()}
        onClick={() => { if (!locked) useLock.getState().lock(); }}
      >
        <svg className="holdring" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="10" pathLength="100" />
        </svg>
        lock
      </button>
      <span className="label">
        {locked
          ? 'locked · hold to unlock'
          : lockedByDefault()
            ? 'unlocked · locks itself when left alone'
            : 'unlocked · tap to lock'}
      </span>
    </div>
  );
}
