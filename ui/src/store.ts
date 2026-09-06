import { create } from 'zustand';
import type {
  Command, HeadSnap, MidiAction, OscLogEntry, Project, ServerEvent, Snapshot,
} from '../../shared/types.ts';
import { WS_PORT } from '../../shared/types.ts';
import { coarsePointer } from './touch.ts';
import { describeEdit } from './editNames.ts';

export type Tab = 'look' | 'patch' | 'controls' | 'output' | 'sync';

/** Which panels are on screen.
 *
 *  A laptop at FOH has no room for three panels at once, and the three jobs are
 *  rarely simultaneous: you run the show from the pads, you aim and check from
 *  the previz, you patch before doors. `split` is all three at once — the
 *  original layout, and still the default. */
export type ViewMode = 'pads' | 'previz' | 'patch' | 'split';
/** Views that carry the previz as a top band (all but the full-screen previz),
 *  each with its own remembered hide state — hiding it on the pads to perform
 *  full-height must not also hide the plan you patch against. */
export type BandView = 'pads' | 'patch' | 'split';
export type Sel = { layerId: string; col: number } | null;
/** Touch mode (review M14/M15). 'auto' follows the pointer the browser
 *  reports — a fingertip is coarse, a mouse or trackpad fine — and can be
 *  forced either way, because a touchscreen laptop or a tablet with a trackpad
 *  reports whichever it feels like. */
export type TouchPref = 'auto' | 'on' | 'off';
/** What a drag does in the 2D plan on a tablet, where ⌥ and ⇧ do not exist. */
export type PlanTool = 'move' | 'rotate' | 'select';

type Store = {
  connected: boolean;
  /** The socket is open but snapshots have stopped arriving — the engine's tick
   *  loop is wedged. Distinct from `connected`, and the more dangerous state of
   *  the two: everything looks normal while nothing reaches the rig. */
  engineStalled: boolean;
  project: Project | null;
  snap: Snapshot | null;
  /** Raw DMX for the universes this client subscribed to, keyed by universe id.
   *  Arrives as its own event now: only the Output tab wants it, so nothing
   *  else pays for ~8 KB a frame. */
  dmx: Record<string, number[]>;
  /** The audition head set, sent only to the client that asked for it. */
  previewHeads: HeadSnap[] | null;
  oscLog: OscLogEntry[];
  savedFlash: number;
  sel: Sel;
  tab: Tab;
  view: ViewMode;
  /** Per-view previz band collapse (default shown everywhere). */
  previzHidden: Record<BandView, boolean>;
  /** Look library collapse (pads view) — the performance grid gets its full
   *  width back the same way the previz band does. */
  libraryHidden: boolean;
  /** Look-editor column collapse (pads view). Same bargain as the library:
   *  the performance grid can always have its width back. */
  editorHidden: boolean;
  /** The audition pane at the band's right edge. On by default, but it is a
   *  SECOND renderer that appears whenever a pad is selected — and firing a pad
   *  selects it — so a show run from the pads can switch it off and give the
   *  live rig the whole band. */
  previewPane: boolean;
  /** Eye adaptation in the 3D previz: the exposure follows how much light is
   *  on stage, the way an eye or a camera would. Partial, so a brighter look
   *  still reads brighter — off gives a fixed exposure for judging absolute
   *  levels. */
  previzAutoExposure: boolean;
  touchPref: TouchPref;
  /** Touch mode is on: 24px targets, hold-to-edit, the ? help button. Derived
   *  from touchPref and the pointer the browser reports. */
  touch: boolean;
  /** The on-screen ?: the next tap on any control shows its help instead of
   *  operating it. */
  helpMode: boolean;
  previz2dTool: PlanTool;
  previzMode: '3d' | '2d';
  /** What the previz was showing before the patch view borrowed it for the
   *  plan, so leaving patch gives back the view the operator was steering by.
   *  Both fields: '2d' is two different screens, and the front elevation drags
   *  fixture HEIGHT where the plan drags position. Cleared when they pick a
   *  mode themselves — an explicit choice outranks a restore. */
  prePatch: { mode: '3d' | '2d'; view2d: 'plan' | 'front' } | null;
  /** 2D sub-view: top-down plan or front elevation (drag sets height) */
  previz2dView: 'plan' | 'front';
  /** fixtures selected in the 2D previz (shift-click / marquee) for group building */
  fxSel: string[];
  /** selected stage structures (truss, risers, screens) — shared between the
   *  2D plan and the Stage table, the same way fxSel is for fixtures */
  propSel: string[];
  hazeViz: number;
  /** dummy band figures in the 3D previz views */
  showBand: boolean;
  /** Metre grid and dimension labels in the previz — off by default so the
   *  view stays clean during a show, on while you are building a stage. */
  showMeasure: boolean;
  /** dragging a fixture near a truss bar clamps it on and rigs it there */
  snapToTruss: boolean;
  learnMode: boolean;
  learnTarget: MidiAction | null;
  /** derived display list: the engine's ports when it owns MIDI, else the browser's */
  midiInputs: string[];
  /** ports reported by the engine (native MIDI); empty = engine has none */
  engineMidiNames: string[];
  /** ports seen by WebMIDI in this browser */
  webMidiNames: string[];
  /** true when the engine owns native MIDI (Rust core) — the browser must not double-forward */
  engineMidi: boolean;
  lastMidi: string | null;
  /** last GDTF/MVR import outcome, shown in the Fixtures tab */
  importMsg: { ok: boolean; text: string } | null;
  /** notices, oldest first — failures stay until dismissed, the rest expire */
  toasts: Toast[];
  dismissToast: (id: number) => void;
  /** known project files on the engine's disk (for the project menu) */
  projects: { current: string; list: { slug: string; name: string }[] } | null;
  /** undo depth available (for button/menu state) */
  undoDepth: number;
  redoDepth: number;
  /** What ⌘Z will revert / ⇧⌘Z restore, in the operator's words — "rename
   *  song", "move “Spot 3”" (review M16). null when there is nothing. */
  undoLabel: string | null;
  redoLabel: string | null;
  /** P1 ride mode: numeric look-editor controls send soft overrides instead of
   *  project writes. Global so ALL STOP can disarm it from the top bar. */
  ride: boolean;
  setRide: (on: boolean) => void;
  /** set when ALL STOP disarms ride: look-editor writes are dropped for a
   *  moment so a fader drag in flight cannot re-create the rides the panic
   *  just cleared, NOR silently rewrite the stored show mid-gesture */
  rideCutAt: number;
  /** Snapshot the current project into undo history — for engine-side commits
   *  the UI initiates (Store on a ride), which arrive as echoes that undo
   *  deliberately does not capture. Bypasses the drag-coalescing window. */
  captureUndo: (label?: string) => void;

  send: (cmd: Command) => void;
  /** Clone-mutate-commit a project edit; optimistic locally, authoritative echo follows. */
  /** `label` names the edit for the undo tooltip; left out, the name is
   *  derived from what the edit changed (editNames.ts). */
  mutate: (fn: (p: Project) => void, label?: string) => void;
  /** Send any pending throttled project write to the engine right now. Needed
   *  before a command that depends on a just-mutated project already being on
   *  the engine — e.g. switching to a deck you created this tick. */
  flushProjectWrite: () => void;
  undo: () => void;
  redo: () => void;
  setSel: (s: Sel) => void;
  setTab: (t: Tab) => void;
  setView: (v: ViewMode) => void;
  togglePreviz: (v: BandView) => void;
  /** Set rather than toggle: a panel can be folded by the WINDOW (too narrow
   *  for it beside its neighbour) while its preference still says shown, and a
   *  toggle in that state flips the wrong way — tapping "show me" hides it. */
  setLibraryHidden: (v: boolean) => void;
  setEditorHidden: (v: boolean) => void;
  togglePreviewPane: () => void;
  togglePrevizAutoExposure: () => void;
  setTouchPref: (p: TouchPref) => void;
  setHelpMode: (v: boolean) => void;
  setPreviz2dTool: (t: PlanTool) => void;
  setPrevizMode: (m: '3d' | '2d') => void;
  setPreviz2dView: (v: 'plan' | 'front') => void;
  setFxSel: (ids: string[]) => void;
  setPropSel: (ids: string[]) => void;
  setHazeViz: (v: number) => void;
  setShowBand: (v: boolean) => void;
  setShowMeasure: (v: boolean) => void;
  setSnapToTruss: (v: boolean) => void;
  toggleLearnMode: () => void;
  /** In learn mode, a click on a mappable control arms it as the learn target. */
  armLearn: (a: MidiAction) => boolean;
  handleMidi: (status: number, d1: number, d2: number) => void;
  setMidiInputs: (names: string[]) => void;
};

/** Last chosen layout, or the three-panel split for a first run. */
function loadView(): ViewMode {
  try {
    const v = localStorage.getItem('view');
    if (v === 'pads' || v === 'previz' || v === 'patch' || v === 'split') return v;
  } catch { /* fall through */ }
  return 'split';
}

/** Remembered per view, like the view itself — a hidden previz that comes back
 *  on every launch would be re-hidden every launch. */
function loadPrevizHidden(): Record<BandView, boolean> {
  try {
    const s = JSON.parse(localStorage.getItem('previzHidden') ?? 'null');
    if (s && typeof s === 'object') return { pads: !!s.pads, patch: !!s.patch, split: !!s.split };
  } catch { /* fall through */ }
  return { pads: false, patch: false, split: false };
}

const loadFlag = (key: string, def = false) => {
  try {
    const v = localStorage.getItem(key);
    return v === null ? def : v === '1';
  } catch { return def; }
};

const saveFlag = (key: string, v: boolean) => {
  try { localStorage.setItem(key, v ? '1' : '0'); } catch { /* non-essential */ }
};

const loadTouchPref = (): TouchPref => {
  try {
    const v = localStorage.getItem('touchPref');
    return v === 'on' || v === 'off' ? v : 'auto';
  } catch { return 'auto'; }
};
const touchFor = (pref: TouchPref): boolean => (pref === 'auto' ? coarsePointer() : pref === 'on');

export type Toast = { id: number; ok: boolean; text: string; at: number; sticky: boolean };

/** A notice from this window. Same rules as the engine's: a failure stays
 *  until dismissed — SAVE FAILED must not vanish while nobody is looking — and
 *  anything else expires, because one set without an expiry stuck forever. */
export function notify(text: string, ok = false) {
  pushToast(text, ok);
}

let toastSeq = 0;
export function pushToast(text: string, ok: boolean) {
  const id = ++toastSeq;
  const toast: Toast = { id, ok, text, at: Date.now(), sticky: !ok };
  // six at most: a burst of notices must not paper the screen
  useStore.setState((s) => ({ toasts: [...s.toasts.slice(-5), toast] }));
  if (!toast.sticky) setTimeout(() => useStore.getState().dismissToast(id), 5000);
}

let ws: WebSocket | null = null;
const pending: { slug: string | null; msg: string }[] = [];

// Only edits are worth replaying after a reconnect — queued live commands
// (triggers, tap, masters) would fire as a stale burst.
const QUEUEABLE = new Set(['updateProject', 'save', 'learn', 'importGdtf', 'importMvr']);

function wsSend(msg: string): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(msg);
    return;
  }
  try {
    const type = (JSON.parse(msg) as { type: string }).type;
    if (!QUEUEABLE.has(type)) return;
  } catch {
    return;
  }
  // keep the NEWEST edits: dropping incoming writes would silently discard
  // the tail of an offline session (the part the operator just did)
  pending.push({ slug: currentSlug, msg });
  while (pending.length > 50) pending.shift();
}

// --- undo history: snapshots taken ONLY at the mutate() choke point — this
// window's own edits. Engine-originated changes (imports, APC deck switches,
// fader/CC commands) are deliberately NOT captured: inferring them from echo
// diffs proved unsafe (review: cross-project overwrites, fader floods).
// Every snapshot is tagged with the project slug it belongs to; a slug
// mismatch clears history instead of ever sending another project's state.
const UNDO_CAP = 30;
type HistoryEntry = { slug: string | null; project: Project; label: string };
const undoStack: HistoryEntry[] = [];
const redoStack: HistoryEntry[] = [];
let lastPushAt = 0;
/** current project slug per the engine's `projects` events; null until known */
let currentSlug: string | null = null;

/** The last project generation the engine told us about. Every updateProject we
 *  send quotes this as its base, and we advance it optimistically on send: the
 *  engine bumps its own generation by one per accepted write, so a lone editor
 *  stays in lockstep. Any change from elsewhere (another client, an APC deck
 *  switch, an openProject) arrives as a project echo that resets this to the
 *  authoritative value, and an edit composed against a base that no longer
 *  matches is rejected and re-synced rather than clobbering the newer state. */
let lastGen = 0;

/** Send a full-project write stamped with the base it was composed against, and
 *  optimistically advance the local generation. All updateProject sends go
 *  through here so the base is never forgotten. */
function sendProjectUpdate(send: (cmd: Command) => void, project: Project): void {
  const base = lastGen;
  lastGen = (base + 1) >>> 0;
  send({ type: 'updateProject', project, baseGen: base });
}

function clearHistory(): void {
  undoStack.length = 0;
  redoStack.length = 0;
  lastPushAt = 0;
}

/** `label` is called only when an entry is actually pushed — a coalesced
 *  push keeps the name of the edit that opened its window. */
function pushUndo(p: Project, force: boolean, label: () => string): void {
  const now = Date.now();
  // pushes within 800 ms coalesce into the earlier snapshot — a continuous
  // drag lands as one step (rapid distinct edits may merge too; the cap on
  // surprise is the 800 ms window). `force` is for deliberate one-shot
  // captures (Keep on a nudge) that must never be swallowed by the window.
  if (!force && now - lastPushAt < 800) return;
  lastPushAt = now;
  undoStack.push({ slug: currentSlug, project: structuredClone(p), label: label() });
  if (undoStack.length > UNDO_CAP) undoStack.shift();
  redoStack.length = 0;
}

/** the history as the UI sees it: depths for the buttons, names for their tooltips */
const hist = () => ({
  undoDepth: undoStack.length,
  redoDepth: redoStack.length,
  undoLabel: undoStack.at(-1)?.label ?? null,
  redoLabel: redoStack.at(-1)?.label ?? null,
});

let projectWriteTimer: ReturnType<typeof setTimeout> | null = null;
let projectWriteFirst = 0;

/** Throttle full-project writes to ~20/s with a bounded 250 ms max latency so
 *  a continuous drag cannot postpone the authoritative echo indefinitely. */
function queueProjectWrite(send: () => void): void {
  const now = Date.now();
  if (projectWriteTimer) {
    if (now - projectWriteFirst < 250) return; // already scheduled, still fresh
    // Past the deadline: send NOW. The old code cleared the timer and armed a
    // fresh 50 ms one WITHOUT refreshing projectWriteFirst, so the next call
    // took this branch again and cancelled the send that was about to happen.
    // The documented 250 ms bound became "as long as the operator keeps
    // moving" — the exact opposite of what it claims.
    clearTimeout(projectWriteTimer);
    projectWriteTimer = null;
    projectWriteFirst = 0;
    send();
    return;
  }
  projectWriteFirst = now;
  projectWriteTimer = setTimeout(() => {
    projectWriteTimer = null;
    projectWriteFirst = 0;
    send();
  }, 50);
}

/** Drop any pending throttled write without sending it. Returns whether one was
 *  actually pending, so a caller can decide whether a follow-up send is needed. */
function cancelProjectWrite(): boolean {
  if (!projectWriteTimer) return false;
  clearTimeout(projectWriteTimer);
  projectWriteTimer = null;
  projectWriteFirst = 0;
  return true;
}

/** Live show state lives inside the project blob — which song is up, the column
 *  labels, and every layer's cells. A snapshot taken during song 1 and applied
 *  during song 3 therefore drags the operator back to song 1: the grid repaints,
 *  the APC LED page repaints, and the next column trigger fires the wrong song's
 *  looks. Deck switching never goes through mutate(), so the top-of-stack
 *  snapshot stays stale across song changes and the slug check cannot see it.
 *
 *  So: revert the document, stay on the page actually being run. Within one song
 *  the snapshot still applies whole, which is what makes cell edits undo
 *  normally — only a cross-song apply is rewritten. */
function keepCurrentPage(entry: Project, cur: Project): Project {
  if (entry.activeDeckId === cur.activeDeckId) return entry;
  return {
    ...entry,
    activeDeckId: cur.activeDeckId,
    columns: [...cur.columns],
    decks: cur.decks,
    layers: entry.layers.map((l) => {
      const now = cur.layers.find((x) => x.id === l.id);
      return now ? { ...l, cells: [...now.cells] } : l;
    }),
  };
}

/** entry usable only if it provably belongs to the current project */
function entryUsable(e: HistoryEntry | undefined): e is HistoryEntry {
  return !!e && e.slug !== null && e.slug === currentSlug;
}

export const useStore = create<Store>()((set, get) => ({
  connected: false,
  engineStalled: false,
  project: null,
  snap: null,
  dmx: {},
  previewHeads: null,
  oscLog: [],
  savedFlash: 0,
  sel: null,
  tab: 'look',
  view: loadView(),
  previzHidden: loadPrevizHidden(),
  libraryHidden: loadFlag('libraryHidden'),
  editorHidden: loadFlag('editorHidden'),
  previewPane: loadFlag('previewPane', true),
  previzAutoExposure: loadFlag('previzAutoExposure', true),
  touchPref: loadTouchPref(),
  touch: touchFor(loadTouchPref()),
  helpMode: false,
  previz2dTool: 'move',
  // Launching straight back into the patch view must give the plan the view
  // exists for, the same way arriving there from anywhere else does — and must
  // record the loan, or the borrowed 2D leaks into every other view on exit.
  previzMode: loadView() === 'patch' ? '2d' : '3d',
  prePatch: loadView() === 'patch' ? { mode: '3d' as const, view2d: 'plan' as const } : null,
  previz2dView: 'plan',
  fxSel: [],
  propSel: [],
  hazeViz: 0.7,
  showBand: true,
  showMeasure: false,
  snapToTruss: true,
  learnMode: false,
  learnTarget: null,
  midiInputs: [],
  engineMidiNames: [],
  webMidiNames: [],
  engineMidi: false,
  lastMidi: null,
  importMsg: null,
  toasts: [],
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  projects: null,
  undoDepth: 0,
  redoDepth: 0,
  undoLabel: null,
  redoLabel: null,

  send: (cmd) => wsSend(JSON.stringify(cmd)),

  ride: false,
  rideCutAt: 0,
  setRide: (on) => set({ ride: on }),
  captureUndo: (label = 'the last edit') => {
    const p = get().project;
    if (!p) return;
    pushUndo(p, true, () => label);
    set(hist());
  },

  mutate: (fn, label) => {
    const cur = get().project;
    if (!cur) return;
    const next = structuredClone(cur);
    fn(next);
    // named after the fact: the difference says what fn did, unless the
    // caller already said
    pushUndo(cur, false, () => label ?? describeEdit(cur, next));
    set({ project: next, ...hist() });
    // Local state updates every event so the UI stays live, but the wire send
    // is trailing-edge throttled: a scrub or fader drag emits dozens of edits
    // a second and each one is a whole project.
    // Slug-guarded. The send is deferred, and a timer armed just before an
    // openProject fires just after it — writing the previous show's project
    // into the new slug. The undo stack tags every entry and the offline queue
    // tags every message for exactly this reason; the live path had neither.
    const slugAtEdit = currentSlug;
    queueProjectWrite(() => {
      if (currentSlug !== slugAtEdit) return; // a different show is open now
      sendProjectUpdate(get().send, get().project!);
    });
  },

  flushProjectWrite: () => {
    // Cancel the pending deferred write and send the authoritative project
    // NOW, so a follow-up command (switchDeck onto a just-created deck) can't
    // outrun it on the wire and be dropped by the engine as an unknown target.
    if (!cancelProjectWrite()) return;
    sendProjectUpdate(get().send, get().project!);
  },

  undo: () => {
    const cur = get().project;
    const prev = undoStack.at(-1);
    if (!cur) return;
    if (!entryUsable(prev)) {
      // unknown or foreign snapshot — never send another project's state
      clearHistory();
      set(hist());
      return;
    }
    undoStack.pop();
    // the redo entry restores the edit this undo reverts, so it keeps its name
    redoStack.push({ slug: currentSlug, project: structuredClone(cur), label: prev.label });
    lastPushAt = 0; // the next edit must not coalesce across a history apply
    const restored = keepCurrentPage(prev.project, cur);
    set({ project: restored, ...hist() });
    // Through sendProjectUpdate, not a bare send: a write without baseGen is
    // applied blind AND its echo is withheld from the sender, so the engine's
    // generation runs one ahead of ours and the NEXT edit is rejected and
    // silently reverted. An undo is an edit like any other — quote the base.
    sendProjectUpdate(get().send, restored);
  },

  redo: () => {
    const cur = get().project;
    const next = redoStack.at(-1);
    if (!cur) return;
    if (!entryUsable(next)) {
      clearHistory();
      set(hist());
      return;
    }
    redoStack.pop();
    undoStack.push({ slug: currentSlug, project: structuredClone(cur), label: next.label });
    if (undoStack.length > UNDO_CAP) undoStack.shift();
    lastPushAt = 0;
    const restored = keepCurrentPage(next.project, cur);
    set({ project: restored, ...hist() });
    sendProjectUpdate(get().send, restored); // same reasoning as undo above
  },

  setSel: (sel) => {
    set({ sel });
    // Ask the engine to resolve whatever is now selected so the preview pane can
    // show it. Nothing reaches DMX — the engine renders it into a separate head
    // set that only the snapshot carries.
    const p = get().project;
    const layer = sel && p ? p.layers.find((l) => l.id === sel.layerId) : null;
    const lookId = layer?.cells[sel!.col] ?? null;
    wsSend(JSON.stringify({ type: 'previewLook', lookId: lookId ?? null }));
  },
  setTab: (tab) => set({ tab }),
  setView: (view) => {
    // Remembered across launches: an operator who works full-screen on the pads
    // should not have to set that up again every time the app opens.
    try { localStorage.setItem('view', view); } catch { /* non-essential */ }
    const s = get();
    if (view === 'patch') {
      // Choosing "patch" means the fixtures table, not whichever editor tab
      // happened to be open behind it — and the 2D PLAN above it, because the
      // patch workflow is drag-a-row-into-the-plan. The front elevation is not
      // that screen: dragging there sets trim height, not position.
      //
      // Only on ARRIVAL: re-picking Patch while already there must not undo a
      // mode chosen inside it. The loan is recorded even when the band is
      // collapsed — revealing it mid-patch must still show the plan — and is
      // handed back on the way out, because the 3D rig is what an operator
      // steers by and checking an address should not cost them that view.
      const entering = s.view !== 'patch';
      set({
        view,
        tab: 'patch',
        ...(entering
          ? {
              previzMode: '2d' as const,
              previz2dView: 'plan' as const,
              prePatch: { mode: s.previzMode, view2d: s.previz2dView },
            }
          : {}),
      });
      return;
    }
    set({
      view,
      ...(s.view === 'patch' && s.prePatch
        ? { previzMode: s.prePatch.mode, previz2dView: s.prePatch.view2d, prePatch: null }
        : {}),
    });
  },
  togglePreviz: (v) =>
    set((s) => {
      const previzHidden = { ...s.previzHidden, [v]: !s.previzHidden[v] };
      try { localStorage.setItem('previzHidden', JSON.stringify(previzHidden)); } catch { /* non-essential */ }
      return { previzHidden };
    }),
  setLibraryHidden: (libraryHidden) =>
    set(() => {
      saveFlag('libraryHidden', libraryHidden);
      return { libraryHidden };
    }),
  setEditorHidden: (editorHidden) =>
    set(() => {
      saveFlag('editorHidden', editorHidden);
      return { editorHidden };
    }),
  togglePreviewPane: () =>
    set((s) => {
      const previewPane = !s.previewPane;
      saveFlag('previewPane', previewPane);
      return { previewPane };
    }),
  togglePrevizAutoExposure: () =>
    set((s) => {
      const previzAutoExposure = !s.previzAutoExposure;
      saveFlag('previzAutoExposure', previzAutoExposure);
      return { previzAutoExposure };
    }),
  setTouchPref: (touchPref) =>
    set(() => {
      try { localStorage.setItem('touchPref', touchPref); } catch { /* non-essential */ }
      const touch = touchFor(touchPref);
      // the ? lives in touch mode; leaving it must not strand a help session
      return { touchPref, touch, ...(touch ? {} : { helpMode: false }) };
    }),
  setHelpMode: (helpMode) => set({ helpMode }),
  setPreviz2dTool: (previz2dTool) => set({ previz2dTool }),
  // An explicit pick outranks the pending patch restore — otherwise leaving the
  // view would overwrite the screen they just chose.
  setPrevizMode: (previzMode) => set({ previzMode, prePatch: null }),
  setPreviz2dView: (previz2dView) => set({ previz2dView, prePatch: null }),
  setFxSel: (fxSel) => set({ fxSel }),
  setPropSel: (propSel) => set({ propSel }),
  setHazeViz: (hazeViz) => set({ hazeViz }),
  setShowBand: (showBand) => set({ showBand }),
  setShowMeasure: (showMeasure) => set({ showMeasure }),
  setSnapToTruss: (snapToTruss) => set({ snapToTruss }),
  toggleLearnMode: () =>
    set((s) => {
      if (s.learnMode) get().send({ type: 'learn', action: null });
      return { learnMode: !s.learnMode, learnTarget: null };
    }),

  armLearn: (a) => {
    if (!get().learnMode) return false;
    set({ learnTarget: a });
    get().send({ type: 'learn', action: a }); // the engine captures the next note/cc
    return true;
  },

  handleMidi: (status, d1, d2) => {
    const kind = status & 0xf0;
    const isNoteOn = kind === 0x90 && d2 > 0;
    const isCC = kind === 0xb0;
    const ch = (status & 0x0f) + 1;
    const label = isCC ? `CC ${d1} ch${ch} = ${d2}` : kind === 0x90 || kind === 0x80 ? `Note ${d1} ch${ch} ${isNoteOn ? 'on' : 'off'}` : null;
    if (label) set({ lastMidi: label });
    get().send({ type: 'midi', status, d1, d2 });
  },

  setMidiInputs: (names) =>
    set((s) => ({
      webMidiNames: names,
      // the engine wins when it has ports; otherwise show what the browser sees
      midiInputs: s.engineMidiNames.length > 0 ? s.engineMidiNames : names,
    })),
}));

/** Replay offline edits only if the engine still has the project they were
 *  made against; consecutive project writes coalesce to the last one. */
function flushPending(engineSlug: string): void {
  if (pending.length === 0) return;
  // Do not empty the queue into a socket that cannot carry it. `send` on a
  // CLOSING/CLOSED WebSocket drops silently, so if the connection died between
  // the open event and this call, splicing first discarded the operator's whole
  // offline session. Every queued message is slug-tagged, so leaving them for
  // the next reconnect is safe.
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const queued = pending.splice(0);
  const usable = queued.filter((q) => q.slug === null || q.slug === engineSlug);
  const dropped = queued.length - usable.length;
  // only the newest full-project write matters; earlier ones are supersets
  let lastProjectWrite: string | null = null;
  const others: string[] = [];
  for (const q of usable) {
    try {
      if ((JSON.parse(q.msg) as { type: string }).type === 'updateProject') lastProjectWrite = q.msg;
      else others.push(q.msg);
    } catch {
      /* unparseable — drop */
    }
  }
  // the project write must land BEFORE a queued save, or ⌘S persists the
  // pre-edit project
  if (lastProjectWrite) {
    ws?.send(lastProjectWrite);
    // Adopt what we just sent. On reconnect the engine pushes ITS project
    // first, so the store is now holding the pre-reconnect state — and the
    // engine no longer echoes an updateProject back to its sender, so nothing
    // else will correct it. Without this the console displays one show while
    // the engine and the rig run another, with no indication which is which.
    try {
      const sent = (JSON.parse(lastProjectWrite) as { project?: Project }).project;
      if (sent) useStore.setState({ project: sent });
    } catch {
      /* unparseable — the send still stands */
    }
  }
  for (const m of others) ws?.send(m);
  if (dropped > 0) {
    pushToast(`${dropped} offline edit(s) discarded — the engine changed project`, false);
  }
}

function wsUrl(): string {
  // Inside the Tauri shell the page origin is tauri://localhost (or
  // http://tauri.localhost on Windows) — the engine is always local there.
  // Inside the Tauri shell the origin is tauri:// (engine is local). Served
  // over http from the engine itself, reuse that host:port so a non-default
  // LIGHT_PORT and LAN/tablet access both work; the Vite dev server (5173)
  // still points at the default engine port.
  const devServer = location.port === '5173' || location.port === '5177';
  if (location.protocol.startsWith('http') && !location.hostname.endsWith('tauri.localhost') && !devServer) {
    return `ws://${location.host}`;
  }
  const host = !location.protocol.startsWith('http') || location.hostname.endsWith('tauri.localhost')
    ? 'localhost'
    : location.hostname;
  // Legacy escape hatch. The shell no longer sets this: when :9900 is taken it
  // moves the engine and navigates the window to http://127.0.0.1:<port>/, so
  // the port arrives in the origin and the http branch above handles it. Kept
  // because it costs one property read and still works if anything sets it.
  const shellPort = (window as unknown as { __LIGHT_PORT__?: number }).__LIGHT_PORT__;
  return `ws://${host}:${shellPort ?? WS_PORT}`;
}

function connect(): void {
  ws = new WebSocket(wsUrl());
  ws.onopen = () => {
    // A reconnect must not inherit a stale timestamp: after the 1 s backoff it
    // is always older than the trip point, so the banner flashed on every
    // reconnect before the first snapshot could land.
    lastSnapAt = Date.now();
    useStore.setState({ connected: true });
    // Do NOT flush queued edits yet: the engine may have switched projects
    // while we were offline, and a stale updateProject would overwrite a
    // different show. Ask which project is loaded and decide in that handler.
    ws?.send(JSON.stringify({ type: 'projects' }));
  };
  ws.onmessage = (e) => {
    let ev: ServerEvent;
    try {
      ev = JSON.parse(String(e.data)) as ServerEvent;
    } catch {
      return;
    }
    if (ev.type === 'project') {
      // Adopt the authoritative generation. This is what re-syncs us after a
      // rejected write, another client's edit, or an APC deck switch: the next
      // edit we send will quote this base, not the stale one we optimistically
      // advanced to.
      lastGen = ev.gen;
      // authoritative patch may have dropped fixtures (delete elsewhere, MVR
      // replace) — a selection of dangling ids would lie about its count
      const ids = new Set(ev.project.fixtures.map((f) => f.id));
      const cur = useStore.getState().fxSel;
      const pruned = cur.filter((id) => ids.has(id));
      useStore.setState({
        project: ev.project,
        ...(pruned.length === cur.length ? {} : { fxSel: pruned }),
        ...hist(),
      });
    }
    else if (ev.type === 'dmx') {
      useStore.setState({ dmx: ev.u });
    } else if (ev.type === 'preview') {
      useStore.setState({ previewHeads: ev.heads });
    } else if (ev.type === 'snap') {
      lastSnapAt = Date.now();
      useStore.setState((s) => (s.engineStalled ? { snap: ev as Snapshot, engineStalled: false } : { snap: ev as Snapshot }));
    }
    else if (ev.type === 'osc') {
      useStore.setState((s) => ({ oscLog: [ev.entry, ...s.oscLog].slice(0, 40) }));
    } else if (ev.type === 'saved') useStore.setState({ savedFlash: Date.now() });
    else if (ev.type === 'midiInputs') {
      // take the list verbatim — an EMPTY list means the controller was
      // unplugged, and the status dot must go dark within one rescan
      useStore.setState((s) => ({
        engineMidiNames: ev.names,
        engineMidi: ev.names.length > 0,
        midiInputs: ev.names.length > 0 ? ev.names : s.webMidiNames,
      }));
    } else if (ev.type === 'learned') {
      useStore.setState({ learnMode: false, learnTarget: null, lastMidi: 'mapped ✓' });
    } else if (ev.type === 'importResult') {
      useStore.setState({ importMsg: { ok: ev.ok, text: ev.message } });
    } else if (ev.type === 'projects') {
      flushPending(ev.current);
      if (currentSlug !== ev.current) {
        // different project identity — this window's history no longer applies
        clearHistory();
        currentSlug = ev.current;
        useStore.setState({
          projects: { current: ev.current, list: ev.list },
          undoDepth: 0,
          redoDepth: 0,
        });
      } else {
        useStore.setState({ projects: { current: ev.current, list: ev.list } });
      }
    } else if (ev.type === 'toast') {
      pushToast(ev.message, ev.ok);
    }
  };
  ws.onclose = () => {
    useStore.setState({ connected: false });
    setTimeout(connect, 1000);
  };
  ws.onerror = () => ws?.close();
}

connect();

// --- engine liveness -------------------------------------------------------
// Liveness used to be inferred from `connected` plus an fps number carried
// INSIDE the snapshot. Both lie in the same failure: if the tick loop wedges
// while the socket stays open, snapshots stop arriving, the last one is
// retained, and the dot reads a healthy 40fps for the rest of the night — while
// every command queues into an engine that is not draining. The metric was
// travelling on the loop that had stopped, so it could report a slowdown but
// never a full stop. Arrival time is the only signal that survives that.
let lastSnapAt = 0;
/** Snapshots run at 20/s, so 1.5 s is thirty missed frames — a stop, not jitter.
 *  Deliberately not tight: the engine SKIPS snapshots for a client whose queue
 *  is backed up (core/src/server.rs), so a slow tablet on venue WiFi is a normal
 *  state, not a wedged engine, and shouting "the show engine has stopped
 *  responding" at someone whose presses are still arriving is worse than saying
 *  nothing. */
const SNAP_STALL_MS = 1500;
/** Clear well before the trip point, so a client hovering around the threshold
 *  cannot flap a full-width banner on and off twice a second — the banner takes
 *  its own grid row, so every toggle reflows the whole console. */
const SNAP_OK_MS = 600;
setInterval(() => {
  const s = useStore.getState();
  if (!s.connected || lastSnapAt === 0) return;
  const age = Date.now() - lastSnapAt;
  // hysteresis: one threshold to raise it, a lower one to drop it
  const stalled = s.engineStalled ? age > SNAP_OK_MS : age > SNAP_STALL_MS;
  if (stalled !== s.engineStalled) useStore.setState({ engineStalled: stalled });
}, 500);

// Convenience selectors
export function lookOf(project: Project | null, layerId: string, col: number) {
  if (!project) return null;
  const layer = project.layers.find((l) => l.id === layerId);
  const lookId = layer?.cells[col];
  return lookId ? project.looks[lookId] ?? null : null;
}

// dev-only handle for debugging/automation (vite strips this in production builds)
if (import.meta.env.DEV) {
  (window as unknown as { __lightStore?: typeof useStore }).__lightStore = useStore;
}

// A tablet that gains a trackpad, or a laptop that gains a touchscreen, changes
// what the browser reports — follow it while the preference is auto.
if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
  try {
    const mq = window.matchMedia('(pointer: coarse)');
    mq.addEventListener('change', () => {
      if (useStore.getState().touchPref === 'auto') useStore.setState({ touch: mq.matches, ...(mq.matches ? {} : { helpMode: false }) });
    });
  } catch { /* an old WebView without the listener form */ }
}
