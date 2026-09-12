import type { MidiAction, MidiMapping, Project, SoftField } from '../shared/types.ts';
import { SOFT_FIELDS, clamp, sanitizeProject, softClamp, uid } from '../shared/types.ts';
import { BeatClock } from './clock.ts';

export type LayerLive = {
  lookId: string | null;
  prevId: string | null;
  col: number | null;
  fadeStart: number;
  fadeDur: number; // seconds
  /** Which client is holding this momentary look, if any. A hold started by
   *  MIDI/OSC is owned by LOCAL_CLIENT so no browser disconnect drops it. */
  heldBy: number | null;
};

/** Owner for holds started by MIDI, OSC or any non-socket source. No WS client
 *  ever gets this id, so such a hold survives every browser disconnect. */
export const LOCAL_CLIENT = Number.MAX_SAFE_INTEGER;

const freshLive = (): LayerLive => ({ lookId: null, prevId: null, col: null, fadeStart: 0, fadeDur: 0, heldBy: null });

/** Authoritative engine state: the project plus everything live. */
/** Route one soft part-field onto PartParams. Hue/sat address the colour
 *  components, creating the colour with the other component at its default
 *  (s 1 / h 0) when the look never set one. Mirrors apply_soft_param in
 *  core/src/state.rs — identical routing or stored shows diverge. */
export function applySoftParam(params: Project['looks'][string]['parts'][number]['params'], field: SoftField, v: number): void {
  switch (field) {
    case 'hue':
      params.color = { h: v, s: params.color?.s ?? 1 };
      break;
    case 'sat':
      params.color = { h: params.color?.h ?? 0, s: v };
      break;
    case 'dimmer': case 'white': case 'ringFx': case 'strobe': case 'motorValue':
    case 'pan': case 'tilt': case 'haze': case 'fan':
    case 'zoom': case 'focus': case 'iris': case 'frost': case 'cto':
    case 'goboRotate': case 'prismRotate': case 'flower':
      params[field] = v;
      break;
    default:
      break; // effect-only fields never reach a params patch (setSoft routes)
  }
}

/** Route one soft effect-field onto an Effect. */
export function applySoftEffect(e: import('../shared/types.ts').Effect, field: SoftField, v: number): void {
  switch (field) {
    case 'rate': case 'size': case 'spread': case 'width': case 'phase': case 'mix':
      e[field] = v;
      break;
    default:
      break;
  }
}

/** One step of the engine's undo history: the project as it was BEFORE the
 *  edit named by `label` (review M16, backlog #12). Mirrors HistoryEntry in
 *  core/src/state.rs. */
export type HistoryEntry = { label: string; project: Project };
/** Steps kept — each is a whole project, which bounds the memory. */
export const HISTORY_CAP = 100;

export class EngineState {
  project: Project;
  /** Undo history: the project before each recorded edit, newest last. One
   *  history per engine — every client shares it, whoever made the edit. */
  history: HistoryEntry[] = [];
  /** Steps undone and not yet redone; the next recorded edit drops them. */
  redone: HistoryEntry[] = [];
  /** Who opened the newest step, when it was a client's project write — only
   *  that client's next write may coalesce into it. */
  private lastPushOwner: number | null = null;
  onHistory: (() => void) | null = null; // the history changed → `history` event
  live = new Map<string, LayerLive>();
  /** Silenced fixtures — a stuck or dead unit is taken out of the show
   *  without touching the patch (which would re-fan every chase). Transient:
   *  a mute is for tonight, not a property of the show. */
  muted = new Set<string>();
  /** Fixture driven to full white so it can be found on the truss. */
  identify: string | null = null;
  /** Look being auditioned in the previz. Transient, never persisted, and it
   *  never reaches DMX — the renderer resolves it into a separate head set that
   *  only the snapshot carries. */
  previewLook: string | null = null;
  /** universeId -> channel(0-511) -> value. Raw override applied last. */
  overrides = new Map<string, Map<number, number>>();
  /** P1 soft overrides: live rides over stored look data, keyed
   *  JSON.stringify([lookId, partId]) — unambiguous for ANY id content, unlike
   *  a delimiter join — and carrying the ids in the VALUE so nothing ever
   *  parses a key back (the Rust twin keys a tuple; both engines must agree
   *  on every accepted input). Grouped per part so the renderer resolves a
   *  whole part with ONE lookup. Runtime-only — Store (softCommit) writes
   *  them into the project, Discard/ALL STOP/project switch drops them. */
  soft = new Map<string, { lookId: string; partId: string; params: Map<SoftField, number>; effects: Map<string, Map<SoftField, number>> }>();
  /** Live Named Control positions (P3). Runtime-only; the STORED position is
   *  Control.value in the project. Cleared with the soft layer. */
  controlLive = new Map<string, number>();
  clock = new BeatClock();
  master = 1;
  speed = 1;
  blackout = false;
  /** Whether rendered frames reach the wire at all (engine/output.ts).
   *  Runtime-only and OFF at every boot, whatever the show says. */
  transmit = false;
  /** Group submasters, 0..1, keyed by group id. Only entries BELOW full are
   *  stored, so an empty map is the common case and the renderer's pass skips
   *  entirely.
   *
   *  Runtime-only and never saved (backlog decision 4): one stored at zero
   *  would kill that group on the next boot, and "comes up dark and safe" has
   *  to mean dark for a reason an operator can see. A fixture that must stay
   *  out of the show across a restart is a MUTE, a different tool that
   *  survives a panic where a level does not. */
  submasters = new Map<string, number>();
  /** Whether the rig is holding the frame it was showing while the show
   *  carries on underneath (engine/output.ts). Runtime-only, and released by
   *  blackout, ALL STOP and a project switch: a hold that could swallow a
   *  panic is not a hold anyone should trust. */
  frozen = false;
  learnTarget: MidiAction | null = null;
  /** Monotonic project generation. Bumped once per project-changing command by
   *  the transport layer (engine/index.ts) — matching the per-command bump in
   *  core/src/engine.rs — and echoed to clients, which quote it back as
   *  updateProject.baseGen so a stale write can be rejected. Runtime-only. */
  gen = 1;
  onChange: (() => void) | null = null; // structural project change → broadcast
  onLearned: ((mapping: MidiMapping) => void) | null = null;

  bumpGen(): void {
    this.gen = (this.gen + 1) >>> 0; // wrap like the Rust u64 counter (32-bit is plenty)
  }

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

  trigger(layerId: string, col: number, t = performance.now(), owner: number = LOCAL_CLIENT): void {
    const layer = this.project.layers.find((l) => l.id === layerId);
    if (!layer) return;
    const lookId = layer.cells[col] ?? null;
    if (!lookId) return;
    const look = this.project.looks[lookId];
    if (!look) return;
    const live = this.layerLive(layerId);
    // Retriggering the already-active look is a no-op — a double column press
    // mid-fade must not snap the crossfade by discarding the outgoing look.
    if (live.lookId === lookId && !look.flash) return;
    live.prevId = live.lookId;
    live.lookId = lookId;
    live.col = col;
    live.fadeStart = t;
    live.fadeDur = Math.max(0, look.fade ?? layer.fade);
    live.heldBy = look.flash ? owner : null;
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
    live.heldBy = null;
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
    live.heldBy = null;
  }

  /** Switch the active grid page: store the current cells into the outgoing
   *  deck, load the target's. Playing looks keep playing (live state holds
   *  look ids, not cells) — exactly like switching decks in Resolume. */
  switchDeck(deckId: string): boolean {
    const decks = this.project.decks ?? [];
    const target = decks.find((d) => d.id === deckId);
    if (!target || deckId === this.project.activeDeckId) return false;
    EngineState.storePage(this.project);
    this.project.activeDeckId = deckId;
    this.loadPage();
    // Held flashes must not survive a page change: the cell they were taken
    // from is swapped out, so the note-off can never find them again and the
    // blinder stays lit for the rest of the show.
    this.releaseAllHeld();
    this.notify();
    return true;
  }

  /** Write the live page (columns and every layer's cells) into its deck, so
   *  the project carries every song complete. switchDeck does it for the
   *  outgoing deck; a history snapshot needs it for the active one. */
  static storePage(p: Project): void {
    const current = (p.decks ?? []).find((d) => d.id === p.activeDeckId);
    if (!current) return;
    current.columns = [...p.columns];
    current.cells = Object.fromEntries(p.layers.map((l) => [l.id, [...l.cells]]));
  }

  /** Load the active deck's columns and cells into the live grid — the second
   *  half of switchDeck, shared with the history restore. */
  private loadPage(): void {
    const target = (this.project.decks ?? []).find((d) => d.id === this.project.activeDeckId);
    if (!target) return;
    this.project.columns = [...target.columns];
    for (const l of this.project.layers) {
      const cells = [...(target.cells[l.id] ?? [])];
      while (cells.length < this.project.columns.length) cells.push(null);
      cells.length = this.project.columns.length;
      l.cells = cells;
    }
  }

  // --- undo history (review M16, backlog #12). One history per engine, fed by
  // every recorded edit whoever made it. Steps hold the project BEFORE the
  // edit; what is played rather than edited — song switches, masters, haze,
  // nudges, blackout — is not a step and is kept when a step is undone.
  // Mirrors core/src/state.rs; the parity suite holds the two to it.

  /** The project as a history entry holds it: a copy with the live page
   *  stored into its deck. */
  snapshot(): Project {
    const p = structuredClone(this.project);
    EngineState.storePage(p);
    return p;
  }

  private pushEntry(project: Project, label: string): void {
    this.history.push({ label, project });
    if (this.history.length > HISTORY_CAP) this.history.shift();
    this.redone.length = 0;
    this.onHistory?.();
  }

  /** Record the state before an edit that is not a client's project write —
   *  an import, a Keep, a learned mapping. Never coalesces. */
  record(label: string): void {
    this.pushEntry(this.snapshot(), label);
    this.lastPushOwner = null;
  }

  /** Record the state before a client's project write. `coalesce` is the
   *  client saying this write continues its previous one (a drag): the open
   *  step keeps its snapshot and its name — but only if that step is this
   *  client's and nothing was undone since. Returns whether a step opened. */
  recordEdit(label: string, owner: number, coalesce: boolean): boolean {
    if (coalesce && this.redone.length === 0 && this.lastPushOwner === owner && this.history.length > 0) return false;
    this.pushEntry(this.snapshot(), label);
    this.lastPushOwner = owner;
    return true;
  }

  /** A step opened for a write the sanitiser then refused: take it back. */
  dropLastEntry(): void {
    this.history.pop();
    this.lastPushOwner = null;
    this.onHistory?.();
  }

  /** Put a history snapshot back as the project, keeping what is live rather
   *  than edited: the page the operator is on (a song switch is navigation),
   *  the layer masters, the haze and the Link switch. The snapshot's copy of
   *  the current page is loaded into the grid, so an edit made on song 1 is
   *  undone even while song 2 is up. */
  private restore(p: Project): void {
    p.activeDeckId = this.project.activeDeckId;
    for (const l of p.layers) {
      const now = this.project.layers.find((x) => x.id === l.id);
      if (now) l.master = now.master;
    }
    p.settings.haze = this.project.settings.haze;
    p.settings.hazeFan = this.project.settings.hazeFan;
    p.sync.linkEnabled = this.project.sync.linkEnabled;
    p.sync.midiClockEnabled = this.project.sync.midiClockEnabled;
    // the page may not exist in the snapshot (undoing "new song" while on it)
    if (!(p.decks ?? []).some((d) => d.id === p.activeDeckId)) p.activeDeckId = p.decks?.[0]?.id;
    this.project = sanitizeProject(p) ?? p;
    this.loadPage();
    this.reconcile();
    this.lastPushOwner = null;
    this.notify();
  }

  /** Step back. False when there is nothing to undo. */
  undo(): boolean {
    const entry = this.history.pop();
    if (!entry) return false;
    this.redone.push({ label: entry.label, project: this.snapshot() });
    this.restore(entry.project);
    this.onHistory?.();
    return true;
  }

  /** Step forward again. False when there is nothing to redo. */
  redo(): boolean {
    const entry = this.redone.pop();
    if (!entry) return false;
    this.history.push({ label: entry.label, project: this.snapshot() });
    if (this.history.length > HISTORY_CAP) this.history.shift();
    this.restore(entry.project);
    this.onHistory?.();
    return true;
  }

  clearHistory(): void {
    this.history.length = 0;
    this.redone.length = 0;
    this.lastPushOwner = null;
    this.onHistory?.();
  }

  undoLabel(): string | null {
    return this.history.at(-1)?.label ?? null;
  }

  redoLabel(): string | null {
    return this.redone.at(-1)?.label ?? null;
  }

  deckStep(dir: 1 | -1): void {
    const decks = this.project.decks ?? [];
    if (decks.length < 2) return;
    const i = decks.findIndex((d) => d.id === this.project.activeDeckId);
    // CLAMP, do not wrap — see deck_step in core/src/state.rs. The bank arrows
    // are eyes-off, and wrapping past the last song lands on the opener.
    const j = Math.max(0, Math.min(decks.length - 1, (i < 0 ? 0 : i) + dir));
    if (j === i) return; // already at the end
    this.switchDeck(decks[j].id);
  }

  /** Gig safety: if the client holding a momentary flash look vanishes, its
   *  release will never arrive — drop the holds it owned. `owner` null drops
   *  every hold whoever started it (all-stop, project reload). */
  releaseAllHeld(t = performance.now(), owner: number | null = null): void {
    for (const [layerId, live] of this.live) {
      if (live.heldBy === null || !live.lookId) continue;
      if (owner !== null && live.heldBy !== owner) continue; // someone else's
      const look = Object.hasOwn(this.project.looks, live.lookId)
        ? this.project.looks[live.lookId]
        : undefined;
      live.prevId = live.lookId;
      live.lookId = null;
      live.col = null;
      live.fadeStart = t;
      live.fadeDur = Math.max(0.02, look?.fade ?? 0.05);
      live.heldBy = null;
      void layerId;
    }
  }

  /** Column = cue: layers with a look in this column fire it, empty cells clear the layer.
   *  Flash (momentary) looks are skipped — a cue must never latch a blinder on. */
  triggerColumn(col: number, t = performance.now()): void {
    // A column this show does not have is not "a column of empty cells" — it
    // is not addressed to us at all. Resolume compositions routinely run wider
    // than the light show, and treating the overshoot as empty would clear
    // every layer and black the rig out for as long as the VJ worked above our
    // last column. The empty-cell clear below is untouched: it is what makes a
    // "Blackout" column work.
    if (!(col >= 0) || col >= this.project.columns.length) return;
    for (const layer of this.project.layers) {
      const lookId = layer.cells[col];
      const look = lookId ? this.project.looks[lookId] : null;
      if (look?.flash) continue; // momentary looks are untouched by cues
      if (look) this.trigger(layer.id, col, t);
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
      this.record('map a MIDI control');
      this.project.midi.push(mapping);
      this.notify();
      this.onLearned?.(mapping);
      return;
    }

    const CONTINUOUS = new Set(['layerMaster', 'grand', 'speed', 'haze', 'control']);
    for (const m of this.project.midi) {
      if (m.channel !== channel || m.number !== d1) continue;
      if (m.type === 'note' && (isNoteOn || isNoteOff)) {
        // A pad mapped to a fader-style target must not slam it to zero on
        // release — notes drive continuous targets by velocity, press only.
        if (CONTINUOUS.has(m.action.kind) && !isNoteOn) continue;
        this.runAction(m.action, isNoteOn, d2 / 127);
      } else if (m.type === 'cc' && isCC) {
        this.runAction(m.action, d2 > 63, d2 / 127);
      }
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
        if (pressed) this.setBlackout(!this.blackout);
        break;
      case 'submaster':
        this.setSubmaster(a.groupId, value);
        break;
      case 'deckNext':
        if (pressed) this.deckStep(1);
        break;
      case 'deckPrev':
        if (pressed) this.deckStep(-1);
        break;
      case 'control':
        this.setControl(a.controlId, value);
        break;
    }
  }

  /** Move a Named Control (P3): resolve every link through the soft layer.
   *  Each link maps v (0..1) onto its bracket min + (max − min)·v; the soft
   *  door clamps per-field, so a bracket cannot push a parameter out of
   *  range. Dangling links (deleted look/part/effect) are skipped — they stay
   *  inspectable in the control's data. Mirrors set_control in
   *  core/src/state.rs. */
  setControl(controlId: string, value: number): boolean {
    if (!Number.isFinite(value)) return false;
    const v = clamp(value);
    const control = this.project.controls?.find((c) => c.id === controlId);
    if (!control) return false;
    for (const l of control.links) {
      const mapped = l.min + (l.max - l.min) * v;
      this.setSoft(l.lookId, l.partId, l.effectId, l.field, mapped);
    }
    this.controlLive.set(controlId, v);
    return true;
  }

  /** Live control positions for the snapshot — only those that moved. */
  controlEntries(): { id: string; value: number }[] {
    const out: { id: string; value: number }[] = [];
    for (const [id, value] of this.controlLive) out.push({ id, value });
    out.sort((a, b) => (a.id < b.id ? -1 : 1));
    return out;
  }

  /** Replace the project (UI edit) and drop any live references that no longer exist. */
  /** Swap in a different project wholesale (open/new): live look state,
   *  fades, and held flashes all reset — a fresh show, not an edit. */
  // Opening a show is a boot into that show: everything transient from the last
  // one has to go. Clearing `live` alone is not enough. `overrides`, `identify`
  // and `muted` are keyed by ids that every project derived from the shipped
  // default shares — `u1`, `u0`, `derby1`, `hazer` — so they do not go stale on
  // a switch, they silently re-bind to the incoming show and keep forcing.
  // all-stop already treats all three as panic state; the switch path never did.
  //
  // Haze is zeroed for the same reason index.ts zeroes it at boot: the hazer
  // must never start pumping on its own, and the operator's reflex will not
  // stop it, because blackout deliberately leaves haze alone. The fan goes with
  // it — it runs independently of the haze level and it is the audible one.
  /** Blackout always wins. Turning it on releases any freeze, because a hold
   *  that could keep a lit frame on the rig through a blackout is exactly the
   *  thing blackout exists to be incapable of. */
  /** Set one group's submaster. Full is the ABSENCE of an entry, so a strip
   *  pushed back up leaves nothing behind for the renderer to walk. */
  setSubmaster(groupId: string, v: number): void {
    const x = clamp(v);
    if (x >= 1) this.submasters.delete(groupId);
    else this.submasters.set(groupId, x);
  }

  /** Drop submasters whose group is gone. Called from the renderer's
   *  per-generation rebuild, beside sweepSoft, for the same reason. */
  sweepSubmasters(): void {
    if (this.submasters.size === 0) return;
    const live = new Set(this.project.groups.map((g) => g.id));
    for (const id of [...this.submasters.keys()]) {
      if (!live.has(id)) this.submasters.delete(id);
    }
  }

  /** Group submasters for the wire, lowest id first so the two engines
   *  serialise the same bytes. */
  submasterEntries(): { id: string; v: number }[] {
    return [...this.submasters.entries()]
      .map(([id, v]) => ({ id, v }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  setBlackout(v: boolean): void {
    this.blackout = v;
    if (v) this.frozen = false;
  }

  replaceProject(p: Project): void {
    const clean = sanitizeProject(p);
    if (!clean) return;
    this.project = clean;
    this.clearHistory(); // history belongs to the show it was made in
    this.live.clear();
    this.overrides.clear();
    this.soft.clear(); // rides belong to the show they were ridden in
    this.controlLive.clear();
    this.identify = null;
    this.muted.clear();
    this.previewLook = null;
    this.submasters.clear(); // levels belong to the show they were set in
    // A hold belongs to the show it was taken in; repeating the old show's
    // frame over the new one would be nobody's idea of frozen.
    this.frozen = false;
    this.project.settings.haze = 0;
    this.project.settings.hazeFan = 0;
    this.onChange?.();
  }

  /** Ingest one soft override (P1). Validates the address against the CURRENT
   *  project and clamps the value at the door, so the renderer never meets a
   *  dangling or out-of-range ride. value null clears the single entry. */
  setSoft(lookId: string, partId: string, effectId: string | undefined, field: SoftField, value: number | null): boolean {
    // an unknown field must be REJECTED, exactly as Rust's typed SoftField
    // deserialization drops the whole frame — not clamped into a phantom ride
    if (!SOFT_FIELDS.has(field)) return false;
    const look = Object.hasOwn(this.project.looks, lookId) ? this.project.looks[lookId] : undefined;
    const part = look?.parts.find((pt) => pt.id === partId);
    if (!part) return false;
    if (effectId !== undefined && !part.effects.some((e) => e.id === effectId)) return false;
    const key = JSON.stringify([lookId, partId]);
    if (value === null) {
      const patch = this.soft.get(key);
      if (!patch) return false;
      if (effectId !== undefined) {
        const ef = patch.effects.get(effectId);
        ef?.delete(field);
        if (ef && ef.size === 0) patch.effects.delete(effectId);
      } else {
        patch.params.delete(field);
      }
      if (patch.params.size === 0 && patch.effects.size === 0) this.soft.delete(key);
      return true;
    }
    const v = softClamp(field, value);
    if (v === null) return false;
    let patch = this.soft.get(key);
    if (!patch) {
      patch = { lookId, partId, params: new Map(), effects: new Map() };
      this.soft.set(key, patch);
    }
    if (effectId !== undefined) {
      let ef = patch.effects.get(effectId);
      if (!ef) {
        ef = new Map();
        patch.effects.set(effectId, ef);
      }
      ef.set(field, v);
    } else {
      patch.params.set(field, v);
    }
    return true;
  }

  /** Flat view of the live rides, for the snapshot. */
  softEntries(): { lookId: string; partId: string; effectId?: string; field: SoftField; value: number }[] {
    const out: { lookId: string; partId: string; effectId?: string; field: SoftField; value: number }[] = [];
    for (const patch of this.soft.values()) {
      const { lookId, partId } = patch;
      for (const [field, value] of patch.params) out.push({ lookId, partId, field, value });
      for (const [effectId, fields] of patch.effects) {
        for (const [field, value] of fields) out.push({ lookId, partId, effectId, field, value });
      }
    }
    return out;
  }

  /** Store: write every soft value into the project, then clear. Returns
   *  whether anything was written (→ gen bump + broadcast). Mirrors
   *  soft_commit in core/src/state.rs — the two engines must apply the
   *  identical field routing or their stored shows diverge. */
  softCommit(): boolean {
    const before = this.snapshot();
    let changed = false;
    for (const patch of this.soft.values()) {
      const { lookId, partId } = patch;
      const look = Object.hasOwn(this.project.looks, lookId) ? this.project.looks[lookId] : undefined;
      const part = look?.parts.find((pt) => pt.id === partId);
      if (!part) continue; // swept-away address — nothing to store
      for (const [field, v] of patch.params) {
        applySoftParam(part.params, field, v);
        changed = true;
      }
      for (const [effectId, fields] of patch.effects) {
        const e = part.effects.find((x) => x.id === effectId);
        if (!e) continue;
        for (const [field, v] of fields) {
          applySoftEffect(e, field, v);
          changed = true;
        }
      }
    }
    this.soft.clear();
    if (changed) {
      this.pushEntry(before, 'keep the nudged values');
      this.lastPushOwner = null;
      this.onChange?.();
    }
    return changed;
  }

  /** Drop rides whose look/part/effect no longer exists — called from the
   *  renderer's gen-gated rebuild, so every project change sweeps exactly
   *  once, in both engines, with the same discipline as the geometry cache. */
  sweepSoft(): void {
    // deleted controls must not stream stale live positions in every snapshot
    if (this.controlLive.size > 0) {
      for (const id of this.controlLive.keys()) {
        if (!this.project.controls?.some((c) => c.id === id)) this.controlLive.delete(id);
      }
    }
    if (this.soft.size === 0) return;
    for (const [key, patch] of this.soft) {
      const { lookId, partId } = patch;
      const look = Object.hasOwn(this.project.looks, lookId) ? this.project.looks[lookId] : undefined;
      const part = look?.parts.find((pt) => pt.id === partId);
      if (!part) {
        this.soft.delete(key);
        continue;
      }
      for (const effectId of patch.effects.keys()) {
        if (!part.effects.some((e) => e.id === effectId)) patch.effects.delete(effectId);
      }
      if (patch.params.size === 0 && patch.effects.size === 0) this.soft.delete(key);
    }
  }

  /** Sets `repairedSubmission` when the sanitiser changed what arrived — the
   *  sender is then the one client that must NOT be spared the echo, because
   *  everybody else gets the repair and it would keep re-sending the original.
   *  Mirrors update_project in core/src/state.rs, where only ensure_decks can
   *  rewrite a submission; here the whole sanitiser can. */
  repairedSubmission = false;

  updateProject(p: Project): boolean {
    const before = JSON.stringify(p);
    const clean = sanitizeProject(p);
    if (!clean) {
      console.error('[state] rejected malformed project update');
      return false;
    }
    // sanitizeProject mutates in place and returns the same object, so the
    // comparison has to be against the string taken before the call
    this.repairedSubmission = JSON.stringify(clean) !== before;
    this.project = clean;
    this.reconcile();
    this.notify();
    return true;
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
