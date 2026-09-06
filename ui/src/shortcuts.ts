// The keyboard, written down once.
//
// The handler used to be a ladder of `if (e.key === ...)` branches and the
// documentation a hand-kept table beside it, which is exactly the arrangement
// that drifts: the guide said keys 1–8 fire columns long after the handler had
// grown to 1–9, and it never mentioned `[` / `]` at all. Nobody notices,
// because the only person who reads a keyboard reference is someone who has
// already failed to guess.
//
// So this is the single list. The handler runs it, the shortcut sheet renders
// it, and a test in the engine suite reads the published table out of
// docs/website/10-reference.md and requires it to match — key for key, word
// for word. Adding a shortcut without documenting it fails the build.

import type { Command } from '../../shared/types.ts';

/** Just the fields a binding reads.
 *
 *  Not the DOM's KeyboardEvent. A real one satisfies this structurally, and so
 *  does a plain object — which is what lets the engine's test suite, which
 *  runs under Node with no DOM at all, import this file and press keys at it.
 *  Nothing else here wants the browser. */
export type KeyPress = {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  repeat?: boolean;
  preventDefault?: () => void;
};

/** The slice of the app the bindings touch, structural for the same reason.
 *
 *  Importing the store's own type would pull the store — and the browser it
 *  lives in — into every compile that reads this file, including the engine
 *  suite that has no DOM. The real store satisfies this, and TypeScript checks
 *  that where it is handed over in App.tsx, so a mismatch is caught there
 *  rather than assumed away here. */
export type State = {
  project: { columns: unknown[]; decks?: { id: string }[]; activeDeckId?: string } | null;
  snap: { blackout: boolean } | null;
  send: (cmd: Command) => void;
  /** the same union as ViewMode in store.ts; the call site enforces it */
  setView: (v: 'pads' | 'previz' | 'patch' | 'split') => void;
  setSel: (s: null) => void;
  undo: () => void;
  redo: () => void;
};

/** Where a shortcut is shown in the sheet. Presentation only. */
export type ShortcutGroup = 'Cues and tempo' | 'Getting around' | 'The show file';

export type Shortcut = {
  /** exactly as the published table writes it */
  keys: string;
  /** exactly as the published table describes it */
  label: string;
  group: ShortcutGroup;
  /** Runs BEFORE the held-key and modifier gate, and calls preventDefault:
   *  these are the ones that shadow a browser or system shortcut. */
  modified?: boolean;
  match: (e: KeyPress) => boolean;
  run: (st: State, e: KeyPress) => void;
};

/** Declared in the order the published table lists them, so the two can be
 *  compared line by line. Execution order does not depend on it: no two
 *  entries can match the same event. */
export const SHORTCUTS: Shortcut[] = [
  {
    keys: '`1`–`9`',
    label: 'fire that column as a cue',
    group: 'Cues and tempo',
    match: (e) => e.key >= '1' && e.key <= '9',
    run: (st, e) => {
      const col = Number(e.key) - 1;
      if (st.project && col < st.project.columns.length) st.send({ type: 'column', col });
    },
  },
  {
    keys: '`T`',
    label: 'tap tempo',
    group: 'Cues and tempo',
    match: (e) => e.key.toLowerCase() === 't',
    run: (st) => st.send({ type: 'tap' }),
  },
  {
    keys: '`B`',
    label: 'blackout on/off',
    group: 'Cues and tempo',
    match: (e) => e.key.toLowerCase() === 'b',
    run: (st) => st.send({ type: 'setBlackout', v: !st.snap?.blackout }),
  },
  {
    keys: '`[` `]`',
    label: 'previous / next song',
    group: 'Getting around',
    match: (e) => e.key === '[' || e.key === ']',
    run: (st, e) => {
      const decks = st.project?.decks ?? [];
      if (decks.length <= 1) return;
      const i = decks.findIndex((d) => d.id === st.project?.activeDeckId);
      // clamp, don't wrap — matches deck_step in both engines
      const j = Math.max(0, Math.min(decks.length - 1, (i < 0 ? 0 : i) + (e.key === ']' ? 1 : -1)));
      if (j !== i) st.send({ type: 'switchDeck', deckId: decks[j].id });
    },
  },
  {
    keys: '`Esc`',
    label: 'deselect',
    group: 'Getting around',
    match: (e) => e.key === 'Escape',
    run: (st) => st.setSel(null),
  },
  {
    keys: '`⌘S`',
    label: 'save now',
    group: 'The show file',
    modified: true,
    match: (e) => !!(e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's',
    run: (st) => st.send({ type: 'save' }),
  },
  {
    keys: '`⌘Z` / `⇧⌘Z`',
    label: 'undo / redo',
    group: 'The show file',
    modified: true,
    match: (e) => !!(e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z',
    run: (st, e) => (e.shiftKey ? st.redo() : st.undo()),
  },
  {
    // Alt rather than plain digits because 1–9 fire columns, and a mis-hit
    // that changes the layout mid-song is cheap while a mis-hit that fires the
    // wrong cue is not.
    keys: '`⌥1`–`⌥4`',
    label: 'Pads / Stage / Rig / Build',
    group: 'Getting around',
    modified: true,
    match: (e) => e.altKey === true && !e.metaKey && !e.ctrlKey && e.key >= '1' && e.key <= '4',
    run: (st, e) => st.setView((['pads', 'previz', 'patch', 'split'] as const)[Number(e.key) - 1]),
  },
];

/** Run whatever this key means, or nothing. Returns true if it was ours.
 *
 *  The two passes are the point. A modified binding shadows a browser or
 *  system shortcut and has to win before anything else looks at the event;
 *  everything after the gate is a bare key, and a bare key must not repeat
 *  (a held `1` machine-gunning a cue) or fire because a modifier chord
 *  happened to contain its letter. */
export function runShortcut(e: KeyPress, st: State): boolean {
  for (const s of SHORTCUTS) {
    if (!s.modified || !s.match(e)) continue;
    e.preventDefault?.();
    s.run(st, e);
    return true;
  }
  if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return false;
  for (const s of SHORTCUTS) {
    if (s.modified || !s.match(e)) continue;
    s.run(st, e);
    return true;
  }
  return false;
}

/** The sheet's sections, in the order it shows them. */
export const SHORTCUT_GROUPS: ShortcutGroup[] = ['Cues and tempo', 'Getting around', 'The show file'];

/** `⌘S` → ⌘S. The table is written in the documentation's voice, backticks
 *  and all, because that is the copy the test compares. */
export const plainKeys = (s: Shortcut): string => s.keys.replace(/`/g, '');
