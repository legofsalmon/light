import type { MidiAction, MidiMapping, Project } from '../shared/types.ts';
import { clamp, uid } from '../shared/types.ts';
import { BeatClock } from './clock.ts';

export type LayerLive = {
  lookId: string | null;
  prevId: string | null;
  col: number | null;
  fadeStart: number;
  fadeDur: number; // seconds
  held: boolean;
};

const freshLive = (): LayerLive => ({ lookId: null, prevId: null, col: null, fadeStart: 0, fadeDur: 0, held: false });

/** Authoritative engine state: the project plus everything live. */
export class EngineState {
  project: Project;
  live = new Map<string, LayerLive>();
  clock = new BeatClock();
  master = 1;
  speed = 1;
  blackout = false;
  learnTarget: MidiAction | null = null;
  onChange: (() => void) | null = null; // structural project change → broadcast
  onLearned: ((mapping: MidiMapping) => void) | null = null;

  constructor(project: Project) {
    this.project = project;
    this.reconcile();
  }

  private notify(): void {
    this.onChange?.();
  }

  layerLive(layerId: string): LayerLive {
    let l = this.live.get(layerId);
    if (!l) {
      l = freshLive();
      this.live.set(layerId, l);
    }
    return l;
  }

  trigger(layerId: string, col: number, t = performance.now()): void {
    const layer = this.project.layers.find((l) => l.id === layerId);
    if (!layer) return;
    const lookId = layer.cells[col] ?? null;
    if (!lookId) return;
    const look = this.project.looks[lookId];
    if (!look) return;
    const live = this.layerLive(layerId);
    live.prevId = live.lookId;
    live.lookId = lookId;
    live.col = col;
    live.fadeStart = t;
    live.fadeDur = Math.max(0, look.fade ?? layer.fade);
    live.held = !!look.flash;
  }

  release(layerId: string, col: number, t = performance.now()): void {
    const layer = this.project.layers.find((l) => l.id === layerId);
    if (!layer) return;
    const lookId = layer.cells[col] ?? null;
    const live = this.layerLive(layerId);
    if (!lookId || live.lookId !== lookId) return;
    const look = this.project.looks[lookId];
    if (!look?.flash) return;
    live.prevId = live.lookId;
    live.lookId = null;
    live.col = null;
    live.fadeStart = t;
    live.fadeDur = Math.max(0.02, look.fade ?? 0.05);
    live.held = false;
  }

  clearLayer(layerId: string, t = performance.now()): void {
    const layer = this.project.layers.find((l) => l.id === layerId);
    if (!layer) return;
    const live = this.layerLive(layerId);
    if (live.lookId === null && live.prevId === null) return;
    live.prevId = live.lookId;
    live.lookId = null;
    live.col = null;
    live.fadeStart = t;
    live.fadeDur = layer.fade;
    live.held = false;
  }

  /** Column = cue: layers with a look in this column fire it, empty cells clear the layer.
   *  Flash (momentary) looks are skipped — a cue must never latch a blinder on. */
  triggerColumn(col: number, t = performance.now()): void {
    for (const layer of this.project.layers) {
      const lookId = layer.cells[col];
      const look = lookId ? this.project.looks[lookId] : null;
      if (look && !look.flash) this.trigger(layer.id, col, t);
      else this.clearLayer(layer.id, t);
    }
  }

  applyMidi(status: number, d1: number, d2: number): void {
    const kind = status & 0xf0;
    const channel = status & 0x0f;
    const isNoteOn = kind === 0x90 && d2 > 0;
    const isNoteOff = kind === 0x80 || (kind === 0x90 && d2 === 0);
    const isCC = kind === 0xb0;
    if (!isNoteOn && !isNoteOff && !isCC) return;

    if (this.learnTarget && (isNoteOn || isCC)) {
      const mapping: MidiMapping = {
        id: uid('midi'),
        type: isCC ? 'cc' : 'note',
        channel,
        number: d1,
        action: this.learnTarget,
      };
      this.learnTarget = null;
      this.project.midi.push(mapping);
      this.notify();
      this.onLearned?.(mapping);
      return;
    }

    for (const m of this.project.midi) {
      if (m.channel !== channel || m.number !== d1) continue;
      if (m.type === 'note' && (isNoteOn || isNoteOff)) this.runAction(m.action, isNoteOn, d2 / 127);
      else if (m.type === 'cc' && isCC) this.runAction(m.action, d2 > 63, d2 / 127);
    }
  }

  runAction(a: MidiAction, pressed: boolean, value: number): void {
    switch (a.kind) {
      case 'cell':
        if (pressed) this.trigger(a.layerId, a.col);
        else this.release(a.layerId, a.col);
        break;
      case 'column':
        if (pressed) this.triggerColumn(a.col);
        break;
      case 'layerClear':
        if (pressed) this.clearLayer(a.layerId);
        break;
      case 'layerMaster': {
        const layer = this.project.layers.find((l) => l.id === a.layerId);
        if (layer) {
          layer.master = clamp(value);
          this.notify();
        }
        break;
      }
      case 'grand':
        this.master = clamp(value);
        break;
      case 'speed':
        this.speed = 0.25 * Math.pow(16, clamp(value)); // 0.25×..4×, centre 1×
        break;
      case 'haze':
        this.project.settings.haze = clamp(value);
        this.notify();
        break;
      case 'tap':
        if (pressed) this.clock.tap();
        break;
      case 'blackout':
        if (pressed) this.blackout = !this.blackout;
        break;
    }
  }

  /** Replace the project (UI edit) and drop any live references that no longer exist. */
  updateProject(p: Project): void {
    this.project = p;
    this.reconcile();
    this.notify();
  }

  private reconcile(): void {
    const layerIds = new Set(this.project.layers.map((l) => l.id));
    for (const id of [...this.live.keys()]) {
      if (!layerIds.has(id)) this.live.delete(id);
    }
    for (const [id, live] of this.live) {
      void id;
      if (live.lookId && !this.project.looks[live.lookId]) live.lookId = null;
      if (live.prevId && !this.project.looks[live.prevId]) live.prevId = null;
    }
  }
}
