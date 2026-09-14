// The FOH remote's own small state (design 2.11, #36).
//
// Three facts: whether this client is the remote at all, which page of four
// columns is under the thumb, and whether the edit latch is armed.
//
// Deliberately NOT part of the app store, for the same reason the library's
// arm is not (libraryStore.ts): nothing here reaches the rig. A page is which
// four columns are on screen, and the latch is a pointer mode — neither can
// fire a cue, and neither belongs beside the commands that can.
//
// The remote is a LAYOUT STATE, not a fork: `touch` on and the window under
// 900px. Everything above that — the tablet at 1024×768 included — is the
// ordinary Pads view at touch density.

import { create } from 'zustand';
import { useStore } from './store.ts';
import { useLock } from './lockStore.ts';

/** Under this window width, with touch on, Pads is the remote (design 2.11).
 *  Not a token: the design names the number and there is no `size/*` for it —
 *  the same standing as NARROW_HEAD_BELOW and LIBRARY_SHEET_BELOW. */
export const REMOTE_BELOW = 900;

/** How many columns a thumb gets at a time. Four, because a head plus four
 *  pads in one grid is the widest row that cannot overflow a 390px phone
 *  (design 2.11's arithmetic), and column 8 is one page key away. */
export const REMOTE_PAGE_COLS = 4;

/** The layout question, written down once. */
export const isRemote = (windowWidth: number, touch: boolean): boolean =>
  touch && windowWidth < REMOTE_BELOW;

/** How long an armed latch may sit untouched before it drops — the same idle
 *  the lock uses, and for the same reason: a mode nobody is holding is a mode
 *  the next person to pick the phone up does not know they are in. */
const IDLE_MS = 30_000;

type RemoteStore = {
  /** this client is the remote: touch, under 900px */
  remote: boolean;
  /** which page of four columns the grid is showing */
  page: number;
  setPage: (page: number) => void;
  /** the edit latch: the grid selects and nothing fires (design 2.11) */
  latch: boolean;
  setLatch: (on: boolean) => void;
  toggleLatch: () => void;
};

const computeRemote = (): boolean => {
  try {
    return isRemote(window.innerWidth, useStore.getState().touch);
  } catch {
    return false; // no window to measure: the desk, not a phone
  }
};

export const useRemote = create<RemoteStore>()((set, get) => ({
  remote: computeRemote(),
  page: 0,
  setPage: (page) => set({ page: Math.max(0, page) }),
  // Locked is the pads and nothing else, so there is no latch to arm; and the
  // latch is the same arm shape as MIDI learn, which may not be armed twice.
  setLatch: (on) => {
    if (on) {
      if (useLock.getState().locked) return;
      if (useStore.getState().learnMode) useStore.getState().toggleLearnMode();
    }
    set({ latch: on });
  },
  latch: false,
  toggleLatch: () => get().setLatch(!get().latch),
}));

/** Is the grid latched for editing? The one thing the rest of the app reads. */
export const useLatched = (): boolean => useRemote((s) => s.latch);

/** Drop the latch. Every caller below is one of the four things design 2.11
 *  says clears it, and each of them is a moment the operator's attention has
 *  moved somewhere the latch would be a surprise. */
const drop = (): void => {
  if (useRemote.getState().latch) useRemote.setState({ latch: false });
};

if (typeof window !== 'undefined') {
  const sync = () => {
    const remote = computeRemote();
    if (remote === useRemote.getState().remote) return;
    // Leaving the remote takes the page with it: the eight columns are all on
    // screen again, and a page-2 offset would hide the first four.
    useRemote.setState({ remote, page: 0 });
  };
  window.addEventListener('resize', sync);
  useStore.subscribe((s, prev) => {
    if (s.touch !== prev.touch) sync();
    // ALL STOP. The panic sets `rideCutAt` as it disarms nudging (TopBar), and
    // it is the only thing that does — so it is the honest signal that the
    // operator has just stopped everything, which is not a moment to leave a
    // mode armed that withholds cues.
    if (s.rideCutAt !== prev.rideCutAt) drop();
    // The song the room is playing changed under the grid.
    else if (s.project?.activeDeckId !== prev.project?.activeDeckId) drop();
    // Left Pads.
    else if (s.view !== prev.view && s.view !== 'pads') drop();
    // MIDI learn is the same arm shape; two arms is one too many.
    else if (s.learnMode && !prev.learnMode) drop();
  });
  // Locking is the strongest of the four: locked, there is no latch at all.
  useLock.subscribe((s, prev) => { if (s.locked && !prev.locked) drop(); });
  let idle: ReturnType<typeof setTimeout> | null = null;
  const poke = () => {
    if (idle) clearTimeout(idle);
    if (!useRemote.getState().latch) return;
    idle = setTimeout(drop, IDLE_MS);
  };
  for (const ev of ['pointerdown', 'keydown', 'wheel'] as const) {
    window.addEventListener(ev, poke, { passive: true, capture: true });
  }
  useRemote.subscribe(poke);
}
