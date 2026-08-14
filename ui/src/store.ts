import { create } from 'zustand';
import type {
  Command, MidiAction, OscLogEntry, Project, ServerEvent, Snapshot,
} from '../../shared/types.ts';
import { WS_PORT } from '../../shared/types.ts';

export type Tab = 'look' | 'patch' | 'output' | 'sync';
export type Sel = { layerId: string; col: number } | null;

type Store = {
  connected: boolean;
  project: Project | null;
  snap: Snapshot | null;
  oscLog: OscLogEntry[];
  savedFlash: number;
  sel: Sel;
  tab: Tab;
  previzMode: '3d' | '2d';
  /** 2D sub-view: top-down plan or front elevation (drag sets height) */
  previz2dView: 'plan' | 'front';
  /** fixtures selected in the 2D previz (shift-click / marquee) for group building */
  fxSel: string[];
  hazeViz: number;
  /** dummy band figures in the 3D previz views */
  showBand: boolean;
  learnMode: boolean;
  learnTarget: MidiAction | null;
  midiInputs: string[];
  /** true when the engine owns native MIDI (Rust core) — the browser must not double-forward */
  engineMidi: boolean;
  lastMidi: string | null;
  /** last GDTF/MVR import outcome, shown in the Fixtures tab */
  importMsg: { ok: boolean; text: string } | null;
  /** transient engine notice shown in the top bar */
  toast: { ok: boolean; text: string; at: number } | null;
  /** known project files on the engine's disk (for the project menu) */
  projects: { current: string; list: { slug: string; name: string }[] } | null;
  /** undo depth available (for button/menu state) */
  undoDepth: number;
  redoDepth: number;

  send: (cmd: Command) => void;
  /** Clone-mutate-commit a project edit; optimistic locally, authoritative echo follows. */
  mutate: (fn: (p: Project) => void) => void;
  undo: () => void;
  redo: () => void;
  setSel: (s: Sel) => void;
  setTab: (t: Tab) => void;
  setPrevizMode: (m: '3d' | '2d') => void;
  setPreviz2dView: (v: 'plan' | 'front') => void;
  setFxSel: (ids: string[]) => void;
  setHazeViz: (v: number) => void;
  setShowBand: (v: boolean) => void;
  toggleLearnMode: () => void;
  /** In learn mode, a click on a mappable control arms it as the learn target. */
  armLearn: (a: MidiAction) => boolean;
  handleMidi: (status: number, d1: number, d2: number) => void;
  setMidiInputs: (names: string[]) => void;
};

let ws: WebSocket | null = null;
const pending: string[] = [];

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
  if (pending.length < 50) pending.push(msg);
}

// --- undo history: snapshots taken ONLY at the mutate() choke point — this
// window's own edits. Engine-originated changes (imports, APC deck switches,
// fader/CC commands) are deliberately NOT captured: inferring them from echo
// diffs proved unsafe (review: cross-project overwrites, fader floods).
// Every snapshot is tagged with the project slug it belongs to; a slug
// mismatch clears history instead of ever sending another project's state.
const UNDO_CAP = 30;
type HistoryEntry = { slug: string | null; project: Project };
const undoStack: HistoryEntry[] = [];
const redoStack: HistoryEntry[] = [];
let lastPushAt = 0;
/** current project slug per the engine's `projects` events; null until known */
let currentSlug: string | null = null;

function clearHistory(): void {
  undoStack.length = 0;
  redoStack.length = 0;
  lastPushAt = 0;
}

function pushUndo(p: Project): void {
  const now = Date.now();
  // pushes within 800 ms coalesce into the earlier snapshot — a continuous
  // drag lands as one step (rapid distinct edits may merge too; the cap on
  // surprise is the 800 ms window)
  if (now - lastPushAt < 800) return;
  lastPushAt = now;
  undoStack.push({ slug: currentSlug, project: structuredClone(p) });
  if (undoStack.length > UNDO_CAP) undoStack.shift();
  redoStack.length = 0;
}

/** entry usable only if it provably belongs to the current project */
function entryUsable(e: HistoryEntry | undefined): e is HistoryEntry {
  return !!e && e.slug !== null && e.slug === currentSlug;
}

export const useStore = create<Store>()((set, get) => ({
  connected: false,
  project: null,
  snap: null,
  oscLog: [],
  savedFlash: 0,
  sel: null,
  tab: 'look',
  previzMode: '3d',
  previz2dView: 'plan',
  fxSel: [],
  hazeViz: 0.7,
  showBand: true,
  learnMode: false,
  learnTarget: null,
  midiInputs: [],
  engineMidi: false,
  lastMidi: null,
  importMsg: null,
  toast: null,
  projects: null,
  undoDepth: 0,
  redoDepth: 0,

  send: (cmd) => wsSend(JSON.stringify(cmd)),

  mutate: (fn) => {
    const cur = get().project;
    if (!cur) return;
    pushUndo(cur);
    const next = structuredClone(cur);
    fn(next);
    set({ project: next, undoDepth: undoStack.length, redoDepth: redoStack.length });
    get().send({ type: 'updateProject', project: next });
  },

  undo: () => {
    const cur = get().project;
    const prev = undoStack.at(-1);
    if (!cur) return;
    if (!entryUsable(prev)) {
      // unknown or foreign snapshot — never send another project's state
      clearHistory();
      set({ undoDepth: 0, redoDepth: 0 });
      return;
    }
    undoStack.pop();
    redoStack.push({ slug: currentSlug, project: structuredClone(cur) });
    lastPushAt = 0; // the next edit must not coalesce across a history apply
    set({ project: prev.project, undoDepth: undoStack.length, redoDepth: redoStack.length });
    get().send({ type: 'updateProject', project: prev.project });
  },

  redo: () => {
    const cur = get().project;
    const next = redoStack.at(-1);
    if (!cur) return;
    if (!entryUsable(next)) {
      clearHistory();
      set({ undoDepth: 0, redoDepth: 0 });
      return;
    }
    redoStack.pop();
    undoStack.push({ slug: currentSlug, project: structuredClone(cur) });
    if (undoStack.length > UNDO_CAP) undoStack.shift();
    lastPushAt = 0;
    set({ project: next.project, undoDepth: undoStack.length, redoDepth: redoStack.length });
    get().send({ type: 'updateProject', project: next.project });
  },

  setSel: (sel) => set({ sel }),
  setTab: (tab) => set({ tab }),
  setPrevizMode: (previzMode) => set({ previzMode }),
  setPreviz2dView: (previz2dView) => set({ previz2dView }),
  setFxSel: (fxSel) => set({ fxSel }),
  setHazeViz: (hazeViz) => set({ hazeViz }),
  setShowBand: (showBand) => set({ showBand }),
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

  setMidiInputs: (midiInputs) => set({ midiInputs }),
}));

function connect(): void {
  // Inside the Tauri shell the page origin is tauri://localhost (or
  // http://tauri.localhost on Windows) — the engine is always local there.
  const host = !location.protocol.startsWith('http') || location.hostname.endsWith('tauri.localhost')
    ? 'localhost'
    : location.hostname;
  const url = `ws://${host}:${WS_PORT}`;
  ws = new WebSocket(url);
  ws.onopen = () => {
    useStore.setState({ connected: true });
    for (const m of pending.splice(0)) ws?.send(m);
    // learn the current project slug right away — undo refuses to act on
    // snapshots it cannot attribute to the loaded project
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
      // authoritative patch may have dropped fixtures (delete elsewhere, MVR
      // replace) — a selection of dangling ids would lie about its count
      const ids = new Set(ev.project.fixtures.map((f) => f.id));
      const cur = useStore.getState().fxSel;
      const pruned = cur.filter((id) => ids.has(id));
      useStore.setState({
        project: ev.project,
        ...(pruned.length === cur.length ? {} : { fxSel: pruned }),
        undoDepth: undoStack.length,
        redoDepth: redoStack.length,
      });
    }
    else if (ev.type === 'snap') useStore.setState({ snap: ev as Snapshot });
    else if (ev.type === 'osc') {
      useStore.setState((s) => ({ oscLog: [ev.entry, ...s.oscLog].slice(0, 40) }));
    } else if (ev.type === 'saved') useStore.setState({ savedFlash: Date.now() });
    else if (ev.type === 'midiInputs') {
      if (ev.names.length > 0) useStore.setState({ midiInputs: ev.names, engineMidi: true });
      else useStore.setState({ engineMidi: false });
    } else if (ev.type === 'learned') {
      useStore.setState({ learnMode: false, learnTarget: null, lastMidi: 'mapped ✓' });
    } else if (ev.type === 'importResult') {
      useStore.setState({ importMsg: { ok: ev.ok, text: ev.message } });
    } else if (ev.type === 'projects') {
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
      useStore.setState({ toast: { ok: ev.ok, text: ev.message, at: Date.now() } });
      setTimeout(() => {
        const t = useStore.getState().toast;
        if (t && Date.now() - t.at >= 4900) useStore.setState({ toast: null });
      }, 5000);
    }
  };
  ws.onclose = () => {
    useStore.setState({ connected: false });
    setTimeout(connect, 1000);
  };
  ws.onerror = () => ws?.close();
}

connect();

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
