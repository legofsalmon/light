// The lock (design 2.11, backlog #13 layer 1).
//
// A tablet at front of house, or a phone in a pocket, is a client that can fire
// cues. Locked, it is the pads and nothing else: no Rig page, no sheets but
// help, levels and the picker — and every performing control still works,
// because a lock that stopped the show would be worse than the elbow it exists
// to stop.
//
// **Two honest limits, both said out loud in the Lock section's help.** It is a
// deterrent, not security: the passcode lives in this browser's localStorage,
// and nothing stops a WebSocket client sending `updateProject` until the
// server-enforced role exists. And it protects a page, not the rig.
//
// The default is ON when touch is on, or when this client's host is not the
// engine's own — never keyed on "no Tauri bridge", because the owner runs the
// UI in a browser against the Node reference engine every day (`npm run dev`,
// `npm start`) and that must not boot locked.
//
// Only the passcode persists. The UNLOCKED state never does: a reload, a
// reconnect or 30 s idle re-locks, so "on by default" holds at every show
// rather than until the first unlock.

import { create } from 'zustand';
import { useStore } from './store.ts';
import { coarsePointer } from './touch.ts';

const PASSCODE = 'light.lockPasscode';
/** how long an unlocked remote may sit untouched before it locks itself again */
const IDLE_MS = 30_000;

/** Hosts that ARE the machine running the show: the Tauri shell's own origins,
 *  and a page served from this same computer. Everything else is a client that
 *  arrived over the network. */
export function onEngineHost(): boolean {
  try {
    const h = location.hostname;
    // tauri:// has no hostname at all; Windows' shell serves tauri.localhost
    return h === '' || h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]'
      || h === 'tauri.localhost' || h.endsWith('.tauri.localhost');
  } catch {
    return true; // no location to read: assume the show's own machine and do not lock it out
  }
}

/** Does this client start locked, and go back to locked when it is left alone?
 *  Read at boot and at every re-lock, so switching touch on arms it. */
export function lockedByDefault(): boolean {
  try {
    return useStore.getState().touch || !onEngineHost();
  } catch {
    return !onEngineHost();
  }
}

const loadPasscode = (): string | null => {
  try {
    return localStorage.getItem(PASSCODE) || null;
  } catch {
    return null;
  }
};

type LockStore = {
  locked: boolean;
  /** the deterrent, held in this browser — null means a hold is the whole unlock */
  passcode: string | null;
  /** lock it now: the operator asking, or the idle timer, or a reconnect */
  lock: () => void;
  /** only ever called once the hold has completed AND the passcode matched */
  unlock: () => void;
  setPasscode: (v: string | null) => void;
};

export const useLock = create<LockStore>()((set) => ({
  locked: lockedByDefault(),
  passcode: loadPasscode(),
  lock: () => set({ locked: true }),
  unlock: () => set({ locked: false }),
  setPasscode: (passcode) => {
    try {
      if (passcode) localStorage.setItem(PASSCODE, passcode);
      else localStorage.removeItem(PASSCODE);
    } catch { /* a passcode that cannot be saved is simply not set */ }
    set({ passcode });
  },
}));

/** Is this client locked to the pads? The one thing the rest of the app reads. */
export const useLocked = (): boolean => useLock((s) => s.locked);

/** Locked again, but only where the lock is the default — an operator who
 *  locked their own laptop by hand keeps that too, and one who never wanted a
 *  lock is not handed one by walking away from the desk. */
function relock(): void {
  if (lockedByDefault()) useLock.getState().lock();
}

if (typeof window !== 'undefined') {
  useStore.subscribe((s, prev) => {
    // A reconnect is a new session as far as the lock is concerned: the engine
    // may have been restarted, or this tablet carried to a different show. Both
    // edges count — the drop is where the show left, the return is where it
    // came back, and an unlocked remote must not sit through either.
    if (s.connected !== prev.connected) relock();
    // Switching touch on arms the lock on a client that was not locked before.
    else if (s.touch && !prev.touch) relock();
  });
  let idle: ReturnType<typeof setTimeout> | null = null;
  const poke = () => {
    if (idle) clearTimeout(idle);
    if (useLock.getState().locked) return;
    idle = setTimeout(relock, IDLE_MS);
  };
  for (const ev of ['pointerdown', 'keydown', 'wheel'] as const) {
    window.addEventListener(ev, poke, { passive: true, capture: true });
  }
  useLock.subscribe(poke);
}
