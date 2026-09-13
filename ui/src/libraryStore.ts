// The look library's own small state: what is armed, and whether the library
// is a sheet over the grid rather than a column beside it (design 2.7, #29).
//
// It is deliberately NOT part of the app store. Nothing here reaches the rig
// or the project — arming a tile is a pointer mode, the way a paintbrush is —
// and a mode that can never fire a cue should not sit in the same place as the
// commands that can.
//
// Arm-then-place is the touch (and narrow-window) answer to drag: tap a tile,
// then tap a pad's NAME strip — never its body, which fires. The arm survives
// the placement, so six pads are one arm and six taps rather than six drags.

import { create } from 'zustand';
import type { Project } from '../../shared/types.ts';
import { notify, useStore } from './store.ts';

type LibraryStore = {
  /** the look a tap armed, waiting for a pad's name strip; null = nothing */
  armed: string | null;
  arm: (lookId: string) => void;
  disarm: () => void;
  /** the library laid over the grid from the right */
  sheet: boolean;
  /** the search box, shared so find can open the library on one look */
  q: string;
  setQ: (q: string) => void;
  /** a look the library was asked to show: it takes the bank that holds it and
   *  wears the ring until the next interaction */
  reveal: string | null;
  setReveal: (lookId: string | null) => void;
};

export const useLibraryStore = create<LibraryStore>()((set) => ({
  armed: null,
  // Arming clears any reveal: the two both draw a ring, and two rings would be
  // two answers to "which one is this about".
  arm: (lookId) => set({ armed: lookId, reveal: null }),
  disarm: () => set({ armed: null }),
  sheet: false,
  q: '',
  setQ: (q) => set({ q }),
  reveal: (null as string | null),
  setReveal: (lookId) => set({ reveal: lookId }),
}));

/** The song the grid is SHOWING, which is not always the one on stage.
 *
 *  Design #26 puts `editingDeckId` in the app store; it is another lane's
 *  change, and until it lands the grid always shows the live song. Read
 *  through one place so that when the field appears, every reader gets it at
 *  once rather than one by one. */
export function useEditingDeckId(): string | null {
  return useStore((s) => (s as unknown as { editingDeckId?: string | null }).editingDeckId ?? null);
}

/** Open the library as a sheet over the grid — the `L` key, the reveal strip
 *  and the label-cell chip all land here. `lookId` shows that look. */
export function openLibrarySheet(lookId?: string): void {
  useLibraryStore.setState({ sheet: true, ...(lookId ? { reveal: lookId, q: '' } : {}) });
}

/** Close it, and drop the arm with it: an armed tile the operator cannot see
 *  is a pointer mode with nothing to point at. */
export function closeLibrarySheet(): void {
  useLibraryStore.setState({ sheet: false, armed: null, reveal: null });
}

/** Put the armed look on a pad, by the same rules as the library's drag
 *  (`placeLook` in LookGrid): the look is re-checked at placement time, the
 *  song cannot change underneath it, cells never grow holes, and the active
 *  song's stored copy is mirrored because the engine only syncs it on a
 *  switch-away.
 *
 *  `editingDeckId` is the page the grid is SHOWING — null while that is
 *  whatever is live. Naming the page rather than assuming the live one is what
 *  keeps a placement on an editing page out of the running show.
 *
 *  Returns true when a look was placed. The arm stays: the next pad is one
 *  tap, not another trip to the library.
 */
export function placeArmed(
  project: Project,
  layerId: string,
  col: number,
  editingDeckId: string | null,
): boolean {
  const lookId = useLibraryStore.getState().armed;
  if (!lookId) return false;
  const st = useStore.getState();
  // The pool can change under an arm that lasts minutes — another operator
  // pruning looks. Re-check at placement time, and say so: a tap that silently
  // does nothing reads as a broken grid.
  if (!st.project || !Object.hasOwn(st.project.looks, lookId)) {
    notify('that look no longer exists — the library changed while it was armed');
    useLibraryStore.setState({ armed: null });
    return false;
  }
  // A (layerId, col) pair is stable across a song change but its MEANING is
  // not. Placing onto the live page while an APC bank arrow or another client
  // switches songs would write into whatever is now on stage; refuse instead.
  if (editingDeckId === null && project.activeDeckId !== st.project.activeDeckId) {
    notify('the song changed as you placed that — nothing was placed');
    return false;
  }
  const onLivePage = editingDeckId === null || editingDeckId === st.project.activeDeckId;
  st.mutate((p) => {
    if (onLivePage) {
      const l = p.layers.find((x) => x.id === layerId);
      if (!l) return;
      while (l.cells.length < col) l.cells.push(null); // never leave holes for JSON to invent
      l.cells[col] = lookId;
      const deck = (p.decks ?? []).find((d) => d.id === p.activeDeckId);
      if (deck) deck.cells = Object.fromEntries(p.layers.map((x) => [x.id, [...x.cells]]));
      return;
    }
    // An editing page: its stored cells are the only thing that changes, so
    // nothing on stage moves.
    const deck = (p.decks ?? []).find((d) => d.id === editingDeckId);
    if (!deck) return;
    const cells = deck.cells[layerId] ?? [];
    while (cells.length < col) cells.push(null);
    cells[col] = lookId;
    deck.cells[layerId] = cells;
  }, 'put a look on a pad');
  if (onLivePage) st.setSel({ layerId, col }); // the pad you just filled is what you edit next
  return true;
}
