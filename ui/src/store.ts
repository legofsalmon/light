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
  hazeViz: number;
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

  send: (cmd: Command) => void;
  /** Clone-mutate-commit a project edit; optimistic locally, authoritative echo follows. */
  mutate: (fn: (p: Project) => void) => void;
  setSel: (s: Sel) => void;
  setTab: (t: Tab) => void;
  setPrevizMode: (m: '3d' | '2d') => void;
  setHazeViz: (v: number) => void;
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

export const useStore = create<Store>()((set, get) => ({
  connected: false,
  project: null,
  snap: null,
  oscLog: [],
  savedFlash: 0,
  sel: null,
  tab: 'look',
  previzMode: '3d',
  hazeViz: 0.7,
  learnMode: false,
  learnTarget: null,
  midiInputs: [],
  engineMidi: false,
  lastMidi: null,
  importMsg: null,
  toast: null,

  send: (cmd) => wsSend(JSON.stringify(cmd)),

  mutate: (fn) => {
    const cur = get().project;
    if (!cur) return;
    const next = structuredClone(cur);
    fn(next);
    set({ project: next });
    get().send({ type: 'updateProject', project: next });
  },

  setSel: (sel) => set({ sel }),
  setTab: (tab) => set({ tab }),
  setPrevizMode: (previzMode) => set({ previzMode }),
  setHazeViz: (hazeViz) => set({ hazeViz }),
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
  };
  ws.onmessage = (e) => {
    let ev: ServerEvent;
    try {
      ev = JSON.parse(String(e.data)) as ServerEvent;
    } catch {
      return;
    }
    if (ev.type === 'project') useStore.setState({ project: ev.project });
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
