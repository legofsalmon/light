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

let projectWriteTimer: ReturnType<typeof setTimeout> | null = null;
let projectWriteFirst = 0;

/** Throttle full-project writes to ~20/s with a bounded 250 ms max latency so
 *  a continuous drag cannot postpone the authoritative echo indefinitely. */
function queueProjectWrite(send: () => void): void {
  const now = Date.now();
  if (projectWriteTimer) {
    if (now - projectWriteFirst < 250) return; // already scheduled, still fresh
    clearTimeout(projectWriteTimer);
  } else {
    projectWriteFirst = now;
  }
  projectWriteTimer = setTimeout(() => {
    projectWriteTimer = null;
    projectWriteFirst = 0;
    send();
  }, 50);
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
  engineMidiNames: [],
  webMidiNames: [],
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
    // Local state updates every event so the UI stays live, but the wire send
    // is trailing-edge throttled: a scrub or fader drag emits dozens of edits
    // a second and each one is a whole project.
    queueProjectWrite(() => get().send({ type: 'updateProject', project: get().project! }));
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
  if (lastProjectWrite) ws?.send(lastProjectWrite);
  for (const m of others) ws?.send(m);
  if (dropped > 0) {
    const at = Date.now();
    useStore.setState({
      toast: { ok: false, text: `${dropped} offline edit(s) discarded — the engine changed project`, at },
    });
    // toasts set outside the WS 'toast' handler had no expiry and stuck forever
    setTimeout(() => {
      const t = useStore.getState().toast;
      if (t && t.at === at) useStore.setState({ toast: null });
    }, 6000);
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
