// Shared data model for LIGHT — used by both the engine (Node) and the UI (browser).

export type Vec3 = { x: number; y: number; z: number };

export type UniverseCfg = {
  id: string;
  label: string;
  /** Art-Net 15-bit port-address exactly as it appears on the wire (0-based). */
  artnetUniverse: number;
  /** sACN universe, 1..63999. */
  sacnUniverse: number;
  artnet: boolean;
  sacn: boolean;
  /** null → broadcast 255.255.255.255 */
  unicast: string | null;
};

export type Fixture = {
  id: string;
  name: string;
  profileId: string;
  universeId: string;
  /** 1-based DMX start address */
  address: number;
  /** metres; x = stage left→right, y = up, z = toward audience */
  pos: Vec3;
  /** radians, yaw for previz aim */
  rotY: number;
  /** mounting tilt (pitch, radians) — composes on the kind's default aim */
  rotX?: number;
  /** mounting roll (radians) */
  rotZ?: number;
  /** Base aim for moving heads, 0..1 in the fixture's own pan/tilt range.
   *  This is FOCUS, not an override: a look's pan/tilt is applied as a delta
   *  from centre on top of it (resolved = base + (look - 0.5)), so a rig
   *  focused fixture-by-fixture keeps its focus while looks move around it.
   *  Absent = 0.5 = centre, which is exactly today's behaviour. */
  pan?: number;
  tilt?: number;
};

export type HeadRef = { fixtureId: string; head: number };

export type StagePropKind = 'vocalist' | 'guitarist' | 'bassist' | 'drummer' | 'keyboardist';
/** A dummy performer on the stage — previz-only scenery, placed like a
 *  fixture in the 2D plan, rendered as a figure in both 3D views. */
export type StageProp = {
  id: string;
  kind: StagePropKind;
  pos: { x: number; z: number };
  rotY?: number;
};
export type Group = { id: string; name: string; heads: HeadRef[] };

export type ColorHS = { h: number; s: number }; // hue 0..360, sat 0..1
export type MotorMode = 'off' | 'aim' | 'rotate';

export type PartParams = {
  dimmer?: number;
  color?: ColorHS;
  /** derby white ring — hardware is on/off (≥0.5 = on / blinder) */
  white?: number;
  /** derby ring strobe patterns, 0 = off, 0..1 sweeps pattern+speed bands */
  ringFx?: number;
  /** shutter strobe, 0 = open, 0..1 = slow..fast */
  strobe?: number;
  motorMode?: MotorMode;
  /** aim position (motorMode 'aim') or rotation speed ('rotate'), 0..1 */
  motorValue?: number;
  /** explicit derby colour-macro DMX value; when set, overrides colour quantisation */
  macro?: number;
  pan?: number;
  tilt?: number;
  haze?: number;
  fan?: number;
};

export type EffectTarget = 'dimmer' | 'hue' | 'white' | 'strobe' | 'pan' | 'tilt';
export type Wave = 'sine' | 'triangle' | 'sawUp' | 'sawDown' | 'square' | 'chase' | 'random';

export type Effect = {
  id: string;
  target: EffectTarget;
  wave: Wave;
  /** beats per cycle (4 = one cycle per bar in 4/4) */
  rate: number;
  /** depth 0..1 */
  size: number;
  /** phase fan across the group 0..1 (chase forces 1) */
  spread: number;
  /** duty width for square/chase */
  width: number;
  /** phase offset 0..1 */
  phase: number;
};

export type LookPart = {
  id: string;
  groupId: string;
  params: PartParams;
  effects: Effect[];
};

/** One entry of a cue list: play `lookId` for `beats` beats, then advance. */
export type CueStep = { lookId: string; beats: number };

export type Look = {
  id: string;
  name: string;
  parts: LookPart[];
  /** momentary — releases on mouse-up / note-off */
  flash?: boolean;
  /** crossfade seconds, overrides the layer default */
  fade?: number;
  /** when present the look is a cue list: steps play in order, hard cuts on
   *  the beat, anchored at trigger time; `parts` is unused while set */
  steps?: CueStep[];
};

export type LayerBlend = 'normal' | 'multiply' | 'htp';

/** A page of the grid — one per song. Looks are shared across decks; a deck
 *  is just cell assignments (per layer) + column names. `layer.cells` always
 *  holds the ACTIVE deck; switching swaps pages in and out. */
export type Deck = {
  id: string;
  name: string;
  columns: string[];
  cells: Record<string, (string | null)[]>;
};

export type Layer = {
  id: string;
  name: string;
  blend: LayerBlend;
  master: number;
  /** default crossfade seconds */
  fade: number;
  /** look id per column */
  cells: (string | null)[];
};

export type MidiAction =
  | { kind: 'cell'; layerId: string; col: number }
  | { kind: 'column'; col: number }
  | { kind: 'layerMaster'; layerId: string }
  | { kind: 'layerClear'; layerId: string }
  | { kind: 'grand' }
  | { kind: 'speed' }
  | { kind: 'haze' }
  | { kind: 'tap' }
  | { kind: 'blackout' }
  | { kind: 'deckNext' }
  | { kind: 'deckPrev' };

export type MidiMapping = {
  id: string;
  type: 'note' | 'cc';
  channel: number; // 0..15
  number: number;
  action: MidiAction;
};

export type SyncCfg = {
  oscEnabled: boolean;
  /** follow an Ableton Link session (native engine only) */
  linkEnabled?: boolean;
  oscPort: number;
  /** Resolume column connect → trigger the same column here */
  followColumns: boolean;
  bpmFromOsc: boolean;
};

export type Settings = {
  /** manual hazer output/fan, merged HTP with looks */
  haze: number;
  hazeFan: number;
};

/** Imported (GDTF-compiled) fixture profile — pure data, interpreted by the
 *  Rust core natively and by the Node engine via the shared WASM build.
 *  The UI only reads metadata (heads/footprint/channel names). */
export type CompiledProfile = {
  id: string;
  manufacturer: string;
  model: string;
  mode: string;
  footprint: number;
  heads: { kind: 'rgb' | 'derby' | 'hazer' | 'dimmer' | 'mover'; offset: number; label: string }[];
  channels: { offsets: number[]; head: number; name: string; default: number; cases: unknown[] }[];
  beamDeg: number;
  virtualDimmer: boolean;
};

export type Project = {
  version: 1;
  name: string;
  universes: UniverseCfg[];
  fixtures: Fixture[];
  groups: Group[];
  /** dummy performers for the previz (optional; absent = empty stage) */
  props?: StageProp[];
  looks: Record<string, Look>;
  /** stack order: index 0 = bottom of the stack (UI shows it as the last row) */
  layers: Layer[];
  columns: string[];
  midi: MidiMapping[];
  sync: SyncCfg;
  settings: Settings;
  /** imported fixture profiles, keyed by profile id — travel with the project */
  profiles?: Record<string, CompiledProfile>;
  /** grid pages (one per song); layer.cells mirrors the active deck */
  decks?: Deck[];
  activeDeckId?: string;
};

// ---------- live wire types ----------

export type HeadSnap = {
  f: string;
  h: number;
  r: number; g: number; b: number; // resolved colour 0..1
  i: number; // intensity 0..1, post grand-master
  st: number;
  ring: number;
  mm: MotorMode;
  mv: number;
  pan: number;
  tilt: number;
  /** derby macro component colours (0..255 triples), for multi-colour beam fans */
  mc?: [number, number, number][];
};

export type LayerSnap = {
  id: string;
  lookId: string | null;
  prevId: string | null;
  /** live column, if the active look came from a cell */
  col: number | null;
  /** crossfade progress 0..1 */
  t: number;
};

export type EngineStats = { fps: number; jitter: number; artnet: number; sacn: number };

export type Snapshot = {
  type: 'snap';
  now: number;
  beat: number;
  bpm: number;
  speed: number;
  master: number;
  blackout: boolean;
  haze: number;
  /** Ableton Link session state — native (Rust) engine only */
  link?: { on: boolean; peers: number };
  /** Art-Net nodes discovered via ArtPoll (present when polling is active) */
  artnetNodes?: { ip: string; name: string; ageMs: number }[];
  /** 'failed' = reply port 6454 is held by another app — discovery unavailable */
  artnetPoll?: 'on' | 'failed';
  /** OSC input socket: 'failed' = the port is held by another app (a second
   *  engine? QLC+?) so nothing from Resolume will ever arrive. Absent = off. */
  oscIn?: 'on' | 'failed';
  /** Heads as they WOULD look if the previewed look were running on its own:
   *  full master, no blackout, nothing else live. Present only while a client
   *  has asked for a preview. Never touches DMX. */
  previewHeads?: HeadSnap[];
  /** fixtures currently silenced */
  muted?: string[];
  /** fixture being identified (driven to full white), if any */
  identify?: string | null;
  /** number of raw channel overrides in force */
  overrides?: number;
  /** Fixtures whose profile id resolves to nothing — they render as silently
   *  dark, so the UI has to say so. Reachable by undoing past a GDTF import,
   *  or by a hand-edited/older project file. */
  unknownProfiles?: string[];
  hazeFan: number;
  heads: HeadSnap[];
  layers: LayerSnap[];
  dmx: Record<string, number[]>;
  stats: EngineStats;
};

export type OscLogEntry = { t: number; addr: string; args: (number | string)[] };

// ---------- commands (ui → engine) ----------

export type Command =
  | { type: 'hello' }
  | { type: 'trigger'; layerId: string; col: number }
  | { type: 'release'; layerId: string; col: number }
  | { type: 'clearLayer'; layerId: string }
  | { type: 'setLink'; on: boolean }
  /** silence one fixture without touching the patch (stuck/dead unit) */
  | { type: 'setFixtureMute'; fixtureId: string; on: boolean }
  /** drive one fixture to full white to find it on the truss */
  | { type: 'identify'; fixtureId: string | null }
  /** Audition a look in the previz without sending it to the rig. null stops.
   *  The engine resolves it with the SAME renderer that drives the show, so the
   *  preview cannot quietly disagree with what actually fires. */
  | { type: 'previewLook'; lookId: string | null }
  /** panic: blackout, clear every layer, release holds, haze + motors off */
  | { type: 'allStop' }
  /** raw channel override, applied last into the DMX buffer (channel is 1-512;
   *  value null clears). Not persisted — a check tool, not show data. */
  | { type: 'setChannel'; universeId: string; channel: number; value: number | null }
  | { type: 'clearChannelOverrides' }
  | { type: 'projects' }
  | { type: 'newProject'; name: string }
  | { type: 'openProject'; slug: string }
  | { type: 'saveProjectAs'; name: string }
  | { type: 'column'; col: number }
  | { type: 'setBpm'; bpm: number }
  | { type: 'tap' }
  | { type: 'resync' }
  | { type: 'setSpeed'; v: number }
  | { type: 'setMaster'; v: number }
  | { type: 'setLayerMaster'; layerId: string; v: number }
  | { type: 'setBlackout'; v: boolean }
  | { type: 'setHaze'; v: number }
  | { type: 'setHazeFan'; v: number }
  | { type: 'updateProject'; project: Project }
  | { type: 'midi'; status: number; d1: number; d2: number }
  /** arm (or cancel with null) engine-side MIDI learn — next note/cc maps to the action */
  | { type: 'learn'; action: MidiAction | null }
  /** import a .gdtf file (base64) — engine parses and adds its modes to project.profiles */
  | { type: 'importGdtf'; name: string; data: string }
  /** import a .mvr scene (base64) — patch, positions, groups; replace clears the current patch */
  | { type: 'importMvr'; name: string; data: string; replace: boolean }
  /** spawn the native previz window next to the engine */
  | { type: 'launchPreviz' }
  /** switch the active grid page (deck) */
  | { type: 'switchDeck'; deckId: string }
  | { type: 'save' };

// ---------- events (engine → ui) ----------

export type ServerEvent =
  | { type: 'project'; project: Project }
  | Snapshot
  | { type: 'osc'; entry: OscLogEntry }
  | { type: 'saved'; path: string }
  /** native MIDI inputs owned by the engine (Rust core); empty for the Node dev engine */
  | { type: 'midiInputs'; names: string[] }
  | { type: 'learned'; mapping: MidiMapping }
  | { type: 'importResult'; ok: boolean; message: string; profileIds: string[] }
  | { type: 'toast'; ok: boolean; message: string }
  | { type: 'projects'; current: string; list: { slug: string; name: string }[] };

/** Neutral MVR import bundle produced by the shared parser. */
export type MvrBundle = {
  profiles: Record<string, CompiledProfile>;
  fixtures: { name: string; profileId: string; universe: number; address: number; pos: [number, number, number]; rotY: number }[];
  groups: { name: string; fixtures: number[] }[];
  warnings: string[];
};

export const WS_PORT = 9900;

export function clamp(v: number, lo = 0, hi = 1): number {
  if (!Number.isFinite(v)) return lo; // NaN must never propagate into the engine
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Structural validation + repair for untrusted project data (updateProject
 * commands, files from disk). Repairs what it can, drops what it can't, and
 * returns null only when the data is unusable — the render loop must never
 * meet a shape it can't survive.
 */
export function sanitizeProject(p: Project): Project | null {
  if (!p || typeof p !== 'object' || p.version !== 1) return null;
  if (
    !Array.isArray(p.universes) || !Array.isArray(p.fixtures) || !Array.isArray(p.groups) ||
    !Array.isArray(p.layers) || !Array.isArray(p.columns)
  ) {
    return null;
  }
  p.midi = Array.isArray(p.midi) ? p.midi : [];
  p.looks = p.looks && typeof p.looks === 'object' ? p.looks : {};
  const sync = (p.sync ?? {}) as Partial<SyncCfg>;
  p.sync = {
    oscEnabled: sync.oscEnabled ?? true,
    linkEnabled: sync.linkEnabled ?? false,
    oscPort: Number.isFinite(sync.oscPort) ? (sync.oscPort as number) : 7700,
    followColumns: sync.followColumns ?? true,
    bpmFromOsc: sync.bpmFromOsc ?? true,
  };
  const settings = (p.settings ?? {}) as Partial<Settings>;
  p.settings = {
    haze: Number.isFinite(settings.haze) ? (settings.haze as number) : 0,
    hazeFan: Number.isFinite(settings.hazeFan) ? (settings.hazeFan as number) : 0.35,
  };
  for (const [id, lk] of Object.entries(p.looks)) {
    if (!lk || typeof lk !== 'object' || !Array.isArray(lk.parts)) {
      delete p.looks[id];
      continue;
    }
    for (const part of lk.parts) {
      if (!part.params || typeof part.params !== 'object') part.params = {};
      if (!Array.isArray(part.effects)) part.effects = [];
    }
    if (lk.steps !== undefined) {
      if (!Array.isArray(lk.steps)) delete lk.steps;
      else {
        lk.steps = lk.steps
          .filter((st): st is CueStep => !!st && typeof st === 'object' && typeof st.lookId === 'string')
          // prototype keys ("constructor", "__proto__", ...) must never reach
          // the renderer as look references - they resolve to inherited values
          .filter((st) => Object.hasOwn(p.looks, st.lookId) || !(st.lookId in p.looks))
          .map((st) => ({
            lookId: st.lookId,
            beats: Number.isFinite(st.beats) && st.beats > 0 ? Math.min(st.beats, 512) : 1,
          }));
        if (lk.steps.length === 0) delete lk.steps;
      }
    }
  }
  for (const layer of p.layers) {
    if (!Array.isArray(layer.cells)) layer.cells = p.columns.map(() => null);
    layer.cells = layer.cells.map((c) =>
      typeof c === 'string' && Object.hasOwn(p.looks, c) && p.looks[c] ? c : null,
    );
    if (!Number.isFinite(layer.master)) layer.master = 1;
    if (!Number.isFinite(layer.fade)) layer.fade = 0.5;
  }
  // decks migration: older projects have no pages — the current grid becomes
  // deck 1, and the active deck id must always resolve
  if (!Array.isArray(p.decks) || p.decks.length === 0) {
    p.decks = [{
      id: 'deck-1',
      name: 'Song 1',
      columns: [...p.columns],
      cells: Object.fromEntries(p.layers.map((l) => [l.id, [...l.cells]])),
    }];
    p.activeDeckId = 'deck-1';
  }
  if (!p.decks.some((d) => d.id === p.activeDeckId)) p.activeDeckId = p.decks[0].id;
  for (const g of p.groups) {
    if (!Array.isArray(g.heads)) g.heads = [];
  }
  if (p.props !== undefined) {
    if (!Array.isArray(p.props)) delete p.props;
    else {
      const KINDS = new Set(['vocalist', 'guitarist', 'bassist', 'drummer', 'keyboardist']);
      p.props = p.props.filter(
        (pr): pr is StageProp =>
          !!pr && typeof pr === 'object' && typeof pr.id === 'string' && KINDS.has(pr.kind as string),
      );
      for (const pr of p.props) {
        if (!pr.pos || typeof pr.pos !== 'object') pr.pos = { x: 0, z: 1 };
        if (!Number.isFinite(pr.pos.x)) pr.pos.x = 0;
        if (!Number.isFinite(pr.pos.z)) pr.pos.z = 1;
        if (pr.rotY !== undefined && !Number.isFinite(pr.rotY)) delete pr.rotY;
      }
      if (p.props.length === 0) delete p.props;
    }
  }
  for (const f of p.fixtures) {
    if (!Number.isFinite(f.address)) f.address = 1;
    if (!f.pos || typeof f.pos !== 'object') f.pos = { x: 0, y: 2, z: 0 };
    if (!Number.isFinite(f.rotY)) f.rotY = 0;
    if (f.rotX !== undefined && !Number.isFinite(f.rotX)) delete f.rotX;
    if (f.rotZ !== undefined && !Number.isFinite(f.rotZ)) delete f.rotZ;
  }
  return p;
}

let idCounter = 0;
export function uid(prefix = 'id'): string {
  idCounter = (idCounter + 1) % 46656;
  return `${prefix}-${Date.now().toString(36)}${idCounter.toString(36)}`;
}
