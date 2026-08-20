import path from 'node:path';
import type { Command, CompiledProfile, HeadSnap, ServerEvent, Snapshot, SoftField } from '../shared/types.ts';
import { WS_PORT, clamp, sanitizeProject } from '../shared/types.ts';
import { PROFILES } from '../shared/profiles.ts';
import { EngineState, LOCAL_CLIENT } from './state.ts';
import { Renderer } from './renderer.ts';
import { ArtnetOut } from './artnet.ts';
import { SacnOut } from './sacn.ts';
import { OscIn, type OscMessage } from './osc.ts';
import { Server } from './server.ts';
import type { WebSocket } from 'ws';
import { defaultProject } from './defaultProject.ts';
import * as persist from './persist.ts';
import { parseGdtfBase64, parseMvrBase64 } from './wasmProfiles.ts';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import type { MvrBundle, Project } from '../shared/types.ts';
import { uid } from '../shared/types.ts';

/** set when the saved project could not be read, shown to the first client */
let bootWarning: string | null = null;

/** Mirror of the Rust engine's apply_mvr — keep them in step. */

/** A cheap, float-free fingerprint of what a profile does on the wire.
 *  Footprint alone is not enough: an MVR-exported stub (every channel named
 *  "Dimmer1..N") and the real manufacturer GDTF can share a footprint and mean
 *  entirely different things — exactly the case an operator re-imports to fix.
 *  Mirrors layout_sig in core/src/state.rs. */
function layoutSig(p: CompiledProfile): string {
  // The head layout signs too (B1): since the layout editor, offsets and
  // row/col are operator-authored state — a re-import that changes them is a
  // replacement worth announcing. Engine-local strings, never compared across
  // engines, so the float formatting needs no parity discipline.
  const heads = p.heads
    .map((h) => `${h.offset.toFixed(4)},${(h.offsetY ?? 0).toFixed(4)},${h.row ?? 0},${h.col ?? 0}`)
    .join(';');
  return `${p.footprint}|${p.heads.length}|${p.channels.map((c: CompiledProfile['channels'][number]) => c.name).join(',')}|${heads}`;
}

/** An operator-authored pixel layout must survive a re-import that brings no
 *  layout of its own. The flat fallback is recognisable — every head at
 *  (row 0, col 0) — and a stored non-flat layout on a same-shape profile is
 *  strictly better informed, so it wins silently. A file carrying REAL parsed
 *  geometry has non-flat heads and stays authoritative.
 *  Mirrors preserve_authored_layout in core/src/state.rs. */
function preserveAuthoredLayout(p: Project, incoming: CompiledProfile): void {
  const existing = Object.hasOwn(p.profiles ?? {}, incoming.id) ? p.profiles![incoming.id] : undefined;
  if (!existing || existing.heads.length !== incoming.heads.length) return;
  const flat = (hs: CompiledProfile['heads']) => hs.every((h) => !(h.row ?? 0) && !(h.col ?? 0));
  if (flat(incoming.heads) && !flat(existing.heads)) {
    incoming.heads = incoming.heads.map((h, i) => ({
      ...h,
      offset: existing.heads[i].offset,
      offsetY: existing.heads[i].offsetY,
      row: existing.heads[i].row,
      col: existing.heads[i].col,
    }));
  }
}

/** Replacing a profile that fixtures are patched to rewrites what every one of
 *  their addresses means. Overwriting is correct — it is the point of
 *  re-importing a corrected file — but it must never be silent.
 *  Mirrors describe_profile_replacement in core/src/state.rs. */
function describeProfileReplacement(p: Project, incoming: CompiledProfile): string | null {
  const existing = Object.hasOwn(p.profiles ?? {}, incoming.id) ? p.profiles![incoming.id] : undefined;
  if (!existing) return null;
  if (layoutSig(existing) === layoutSig(incoming)) return null;
  const users = p.fixtures.filter((f) => f.profileId === incoming.id).map((f) => f.name);
  if (users.length === 0) return null; // nothing patched to it — a library update
  const shown = users.slice(0, 3);
  const more = users.length - shown.length;
  const grew =
    incoming.footprint > existing.footprint
      ? ' · footprint GREW — check the patch for address overlaps'
      : '';
  return (
    `${incoming.manufacturer} ${incoming.model} · ${incoming.mode} replaced in place ` +
    `(${existing.footprint}ch → ${incoming.footprint}ch): ${users.length} patched fixture(s) ` +
    `now use the new layout — ${shown.join(', ')}${more > 0 ? ` +${more} more` : ''}${grew}`
  );
}

function applyMvrBundle(p: Project, bundle: MvrBundle, replace: boolean): string {
  if (replace) {
    p.fixtures = [];
    p.groups = [];
    for (const layer of p.layers) layer.cells = layer.cells.map(() => null);
    p.looks = {};
  }
  p.profiles ??= {};
  const replaced: string[] = [];
  for (const [id, prof] of Object.entries(bundle.profiles)) {
    preserveAuthoredLayout(p, prof);
    const note = describeProfileReplacement(p, prof);
    if (note) replaced.push(note);
    p.profiles[id] = prof;
  }

  const fixtureIds: string[] = [];
  let newUniverses = 0;
  for (const f of bundle.fixtures) {
    let u = p.universes.find((x) => x.artnetUniverse === f.universe);
    if (!u) {
      newUniverses++;
      u = {
        id: uid('u'),
        label: `MVR U${f.universe}`,
        artnetUniverse: f.universe,
        sacnUniverse: Math.max(1, f.universe),
        // Output OFF until the operator says otherwise — see the Rust core.
        artnet: false,
        sacn: false,
        unicast: null,
      };
      p.universes.push(u);
    }
    const fid = uid('fx');
    fixtureIds.push(fid);
    p.fixtures.push({
      id: fid,
      name: f.name,
      profileId: f.profileId,
      universeId: u.id,
      address: f.address,
      pos: { x: f.pos[0], y: f.pos[1], z: f.pos[2] },
      rotY: f.rotY,
    });
  }
  for (const g of bundle.groups) {
    const heads = g.fixtures.flatMap((fi) => {
      const fid = fixtureIds[fi];
      const f = bundle.fixtures[fi];
      if (!fid || !f) return [];
      const n = p.profiles?.[f.profileId]?.heads.length ?? 1;
      return Array.from({ length: n }, (_, h) => ({ fixtureId: fid, head: h }));
    });
    if (heads.length) p.groups.push({ id: uid('g'), name: g.name, heads });
  }
  let msg = `imported ${bundle.fixtures.length} fixture(s), ${bundle.groups.length} group(s)`;
  for (const note of replaced) msg += ` · ${note}`;
  if (newUniverses > 0) {
    // the operator has to switch these on deliberately — say so, or the rig
    // looks dead after a clean import
    msg += ` · ${newUniverses} new universe(s) created with output OFF — enable them in Output`;
  }
  if (bundle.warnings.length) msg += ` · ${bundle.warnings.length} warning(s): ${bundle.warnings.join('; ')}`;
  return msg;
}

function spawnPreviz(): [boolean, string] {
  const candidates = [
    process.env.LIGHT_PREVIZ_BIN,
    'target/release/light-previz',
    'target/debug/light-previz',
  ].filter((c): c is string => !!c);
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      try {
        // Tell the child which port this engine is on. It reads LIGHT_PORT
        // from its own environment and otherwise falls back to 9900 — which,
        // when this engine has been moved, is a DIFFERENT copy of LIGHT.
        // Mirrors spawn_previz in core/src/engine.rs.
        const child = spawn(c, [], {
          detached: true,
          stdio: 'ignore',
          env: { ...process.env, LIGHT_PORT: String(PORT) },
        });
        // spawn errors (EACCES, ENOENT-at-exec) arrive async — an unhandled
        // 'error' event would take down the whole engine.
        child.on('error', (e) => {
          server.broadcast({ type: 'toast', ok: false, message: `previz failed to start: ${e.message}` });
        });
        child.unref();
        return [true, 'previz launched'];
      } catch (err) {
        return [false, `previz failed to start: ${(err as Error).message}`];
      }
    }
  }
  return [false, 'previz binary not found — build it with: cargo build --release -p light-previz'];
}

const TICK_MS = 25; // 40 Hz DMX refresh
const PORT = Number(process.env.LIGHT_PORT ?? WS_PORT);

// --- boot ---
let project = persist.loadProject();
if (!project) {
  project = sanitizeProject(defaultProject())!;
  bootWarning = 'saved project could not be read — started from the demo show (your file was left untouched)';
  try {
    persist.saveProjectNow(project);
    console.log(`[light] created default project at ${persist.projectPath()}`);
  } catch (err) {
    console.error('[light] could not write default project:', (err as Error).message);
  }
}

// The hazer must never start pumping on its own: opening the app in an empty
// room the afternoon after a gig used to restore last night's haze level.
if (project.settings) project.settings.haze = 0;
const state = new EngineState(project);
const renderer = new Renderer(state);
// Its own instance: the audition must not advance the show's effect phase.
const previewRenderer = new Renderer(state);

/** Resolve one look as if it were the only thing running: full master, no
 *  blackout, nothing else live.
 *
 *  It goes through the SAME renderer that drives the rig, which is the point —
 *  an audition computed by a second implementation could quietly disagree with
 *  what actually fires, and you would only find out on stage.
 *
 *  The live map is swapped out and put back rather than cloning the project:
 *  `live` holds one entry per layer, the project holds the whole show. Mutes,
 *  channel overrides and identify are deliberately left in force, because they
 *  are things the operator switched on and the audition should show the rig as
 *  it would really respond. Mirrors preview_heads() in core/src/engine.rs. */
function previewHeads(t: number): { previewHeads: HeadSnap[] } | null {
  const lookId = state.previewLook;
  if (!lookId || !Object.hasOwn(state.project.looks, lookId)) return null;
  const layer =
    state.project.layers.find((l) => l.cells.some((c) => c === lookId)) ?? state.project.layers[0];
  if (!layer) return null;

  const savedLive = state.live;
  const savedMaster = state.master;
  const savedBlackout = state.blackout;
  state.live = new Map();
  state.master = 1;
  state.blackout = false;
  state.live.set(layer.id, {
    lookId,
    prevId: null,
    col: null,
    fadeStart: t - 60_000, // long since faded in
    fadeDur: 0,
    heldBy: null,
  });
  try {
    return { previewHeads: previewRenderer.tick(t).heads };
  } finally {
    state.live = savedLive;
    state.master = savedMaster;
    state.blackout = savedBlackout;
  }
}
const artnet = new ArtnetOut();

// a failed write is the one error the operator MUST see: their show is not
// on disk, and everything still looks normal
persist.setSaveReporter((error) => {
  if (error) {
    server.broadcast({ type: 'toast', ok: false, message: `SAVE FAILED — ${error}` });
  }
});

function broadcastProjects(): void {
  server.broadcast({
    type: 'projects',
    current: persist.currentSlug(),
    list: persist.listProjects(),
  });
}
const sacn = new SacnOut();

const server = new Server(PORT, path.join(process.cwd(), 'ui', 'dist'), handleCommand);

const osc = new OscIn(handleOsc);
osc.listen(state.project.sync.oscPort, state.project.sync.oscEnabled);

/** Continuous controls (faders, MIDI CC) call onChange per input event; each
 *  broadcast is the WHOLE project, so a fader ride used to flood every client
 *  with hundreds of full-project frames. Coalesce to at most one per tick. */
let projectDirty = false;
/** The sole client whose edits made the project dirty, or null when more than
 *  one source contributed (a controller, OSC, a second window) and so nobody
 *  can be skipped. Mirrors EchoTo in core/src/engine.rs. */
let echoSkip: unknown = null;
/** The socket whose command we are inside, if any. */
let currentCommandWs: unknown = null;
/** Whether the command currently executing changed the project — drives one
 *  gen bump per command, matching the Rust engine. */
let changedThisCommand = false;

// Per-client transport subscriptions. Deliberately NOT on EngineState: these
// are facts about sockets, not about the show, they never persist, and they
// must vanish when a client goes away. Mirrors `Subs` in core/src/engine.rs.
const dmxSubs = new Map<unknown, string[]>();
/** the one client auditioning a look, if any */
let previewWs: unknown = null;

state.onChange = () => {
  changedThisCommand = true;
  if (!projectDirty) echoSkip = currentCommandWs;
  else if (echoSkip !== currentCommandWs) echoSkip = null;
  // A repaired submission must reach its sender — it holds the unrepaired copy
  // and would re-send it forever otherwise. Fold that in HERE, at change time,
  // not in flushProject: repairedSubmission is reset per command, and by the
  // time the coalesced flush runs (up to 100 ms later) any command in the
  // window could have cleared it. core/src/engine.rs bakes the decision in at
  // command time the same way.
  if (state.repairedSubmission) echoSkip = null;
  projectDirty = true;
  persist.saveProjectDebounced(() => state.project);
  osc.listen(state.project.sync.oscPort, state.project.sync.oscEnabled);
};

let lastEcho = 0;

/** Flush a coalesced project echo — called every tick, but rate-limited to
 *  ~10/s: continuous controls dirty the project per input event and each echo
 *  is the whole project (12x the snapshot stream during a fader ride). */
function flushProject(): void {
  // Also run when a client is owed a project make-good, even if nothing changed
  // this window — otherwise a client that missed the echo while backed up never
  // gets it. Mirrors `project_echo != Idle || bc.has_missed()` in the Rust loop.
  if (!projectDirty && !server.hasMissed()) return;
  const now = performance.now();
  if (now - lastEcho < 100) return;
  lastEcho = now;
  const ev: ServerEvent = { type: 'project', project: state.project, gen: state.gen };
  // Make good the project for any client skipped while backed up. Skipping is
  // right for disposable snapshots and wrong for the project: the client would
  // hold a stale show and write it back. `resend` re-marks a client that is
  // still full, so this retries every window until it lands.
  for (const ws of server.takeMissed()) server.resend(ws, ev);
  if (projectDirty) {
    projectDirty = false;
    // echoSkip already accounts for a repaired submission (folded in at
    // onChange time), so the sender that needs its repair is not skipped.
    server.broadcastExcept(echoSkip, ev);
    echoSkip = null;
  }
}

server.onConnect = (ws) => {
  server.send(ws, { type: 'project', project: state.project, gen: state.gen });
  if (bootWarning) server.send(ws, { type: 'toast', ok: false, message: bootWarning });
  server.send(ws, { type: 'midiInputs', names: [] }); // Node dev engine has no native MIDI
};

// If the client holding a flash look crashes, nothing will ever release it.
// The protocol doesn't attribute holds to clients, so release on ANY
// disconnect: a spurious release beats a blinder latched on stage.
server.onDisconnect = (clientId, ws) => {
  // A socket that has gone must not keep a DMX subscription or hold the
  // audition — otherwise the engine keeps serialising payloads for nobody.
  dmxSubs.delete(ws);
  if (previewWs === ws) previewWs = null;
  // Release exactly what this client held. Waiting for the last client to go
  // was the wrong half of the trade: a tablet dropping off the WiFi mid-flash
  // left its blinder latched on stage while the console stayed connected.
  state.releaseAllHeld(undefined, clientId);
};

state.onLearned = (mapping) => {
  server.broadcast({ type: 'learned', mapping });
};

function handleCommand(cmd: Command, _ws?: unknown, clientId: number = LOCAL_CLIENT): void {
  // Staleness gate (mirrors core/src/engine.rs): a full-project write composed
  // against an older generation must not clobber whatever changed underneath it
  // — a deck switch, an openProject, another client's edit. Reject it and
  // re-sync the sender. A write with no base (a blind submitter) skips this.
  if (cmd.type === 'updateProject' && cmd.baseGen !== undefined && cmd.baseGen !== state.gen) {
    if (_ws) server.send(_ws as WebSocket, { type: 'project', project: state.project, gen: state.gen });
    return;
  }
  // Transport-level subscription: never reaches the state machine.
  if (cmd.type === 'watchDmx') {
    if (_ws) {
      if (cmd.universeIds.length === 0) dmxSubs.delete(_ws);
      else dmxSubs.set(_ws, cmd.universeIds);
    }
    return;
  }
  // TEST ONLY, LIGHT_TEST_CLOCK gated: pin the effect clock so a moving effect
  // is byte-comparable between the two engines. Ignored in a show.
  if (cmd.type === '_pinClock') {
    if (process.env.LIGHT_TEST_CLOCK) renderer.pinClock(cmd.effBeat);
    return;
  }
  // Record WHO is auditioning so the preview head set goes to them alone; the
  // look id itself still reaches the state machine below.
  if (cmd.type === 'previewLook') {
    if (!cmd.lookId) {
      // One last event so the client drops the head set — it has no other way
      // to learn the audition is over, and would keep drawing the last frame.
      if (previewWs) server.send(previewWs as never, { type: 'preview', heads: null });
      previewWs = null;
    } else {
      previewWs = _ws ?? null;
    }
  }

  // Only an updateProject echo may be withheld from its sender: that client
  // composed the exact state. Any other command can change the project in ways
  // the sender did not compute (an import adding fixtures, sanitize repairing
  // one), and the sender needs that result like everyone else.
  currentCommandWs = cmd.type === 'updateProject' ? (_ws ?? null) : null;
  // Reset per command; updateProject sets it if the sanitiser changed anything.
  state.repairedSubmission = false;
  changedThisCommand = false;
  try {
    handleCommandInner(cmd, clientId);
  } finally {
    // One bump per project-changing command, matching the Rust engine's
    // per-command bump so the two engines' generation counters stay in step.
    if (changedThisCommand) state.bumpGen();
    currentCommandWs = null;
  }
}

function handleCommandInner(cmd: Command, clientId: number = LOCAL_CLIENT): void {
  switch (cmd.type) {
    case 'hello':
      break; // project already sent on connect
    case 'trigger':
      state.trigger(cmd.layerId, cmd.col, undefined, clientId);
      break;
    case 'release':
      state.release(cmd.layerId, cmd.col);
      break;
    case 'clearLayer':
      state.clearLayer(cmd.layerId);
      break;
    case 'column':
      state.triggerColumn(cmd.col);
      break;
    case 'setBpm':
      state.clock.setBpm(cmd.bpm);
      break;
    case 'tap':
      state.clock.tap();
      renderer.alignPhase();
      break;
    case 'resync':
      state.clock.resync();
      renderer.alignPhase();
      break;
    case 'setSpeed':
      state.speed = clamp(cmd.v, 0.1, 8);
      break;
    case 'setMaster':
      state.master = clamp(cmd.v);
      break;
    case 'setLayerMaster': {
      const layer = state.project.layers.find((l) => l.id === cmd.layerId);
      if (layer) {
        layer.master = clamp(cmd.v);
        state.onChange?.();
      }
      break;
    }
    case 'setBlackout':
      state.blackout = !!cmd.v;
      break;
    case 'setHaze':
      state.project.settings.haze = clamp(cmd.v);
      state.onChange?.();
      break;
    case 'setHazeFan':
      state.project.settings.hazeFan = clamp(cmd.v);
      state.onChange?.();
      break;
    case 'setFixtureMute': {
      if (cmd.on) state.muted.add(cmd.fixtureId);
      else state.muted.delete(cmd.fixtureId);
      break;
    }
    case 'identify':
      state.identify = cmd.fixtureId;
      break;
    // Not an edit, so no project echo: a selection click must not broadcast the
    // whole show to every client.
    case 'previewLook':
      state.previewLook = cmd.lookId;
      break;
    case 'allStop': {
      // panic: everything dark and quiet, right now
      state.blackout = true;
      for (const l of state.project.layers) state.clearLayer(l.id);
      state.releaseAllHeld();
      state.identify = null;
      state.overrides.clear();
      state.soft.clear(); // rides are transient state; panic drops them too
      state.controlLive.clear();
      state.project.settings.haze = 0;
      state.project.settings.hazeFan = 0; // the fan is the audible one
      state.onChange?.();
      break;
    }
    case 'soft': {
      // serde equivalence with the Rust engine: its Option fields read null
      // AND absent as None, and a frame with wrong-typed fields never
      // deserializes at all — the same bytes must produce the same state
      const c = cmd as { lookId?: unknown; partId?: unknown; effectId?: unknown; field: SoftField; value?: unknown };
      if (typeof c.lookId !== 'string' || typeof c.partId !== 'string') break;
      if (c.effectId !== undefined && c.effectId !== null && typeof c.effectId !== 'string') break;
      if (c.value !== undefined && c.value !== null && typeof c.value !== 'number') break;
      state.setSoft(c.lookId, c.partId, c.effectId ?? undefined, c.field, (c.value as number | null | undefined) ?? null);
      break;
    }
    case 'softCommit':
      state.softCommit(); // onChange fires inside when anything was written
      break;
    case 'softClear':
      state.soft.clear();
      break;
    case 'setControl':
      if (typeof cmd.controlId === 'string' && typeof cmd.value === 'number') {
        state.setControl(cmd.controlId, cmd.value);
      }
      break;
    case 'setChannel': {
      const ch = Math.round(cmd.channel) - 1; // protocol is 1-512
      if (ch < 0 || ch > 511) break;
      let map = state.overrides.get(cmd.universeId);
      if (cmd.value === null) {
        map?.delete(ch);
        if (map && map.size === 0) state.overrides.delete(cmd.universeId);
      } else {
        if (!map) {
          map = new Map<number, number>();
          state.overrides.set(cmd.universeId, map);
        }
        map.set(ch, Math.max(0, Math.min(255, Math.round(cmd.value))));
      }
      break;
    }
    case 'clearChannelOverrides':
      state.overrides.clear();
      break;
    case 'setLink':
      // Ableton Link runs in the native (Rust) engine only — the reference
      // engine records the preference so the project stays in sync
      state.project.sync.linkEnabled = cmd.on;
      state.updateProject(state.project);
      break;
    case 'updateProject':
      state.updateProject(cmd.project);
      break;
    case 'projects':
      broadcastProjects();
      break;
    case 'newProject': {
      const name = cmd.name.trim() || 'Untitled';
      const slug = persist.uniqueSlug(name);
      const fresh = sanitizeProject(defaultProject())!;
      fresh.name = name;
      // flush the outgoing project under its OWN slug first — an edit inside
      // the autosave debounce window must not vanish with the switch
      persist.cancelPendingSave();
      persist.saveProjectNow(state.project);
      persist.saveSlugNow(slug, fresh);
      persist.setCurrentSlug(slug);
      state.replaceProject(fresh);
      server.broadcast({ type: 'toast', ok: true, message: `created "${name}"` });
      broadcastProjects();
      break;
    }
    case 'openProject': {
      if (cmd.slug === persist.currentSlug()) {
        // already open — flush live edits rather than reverting to the
        // possibly-stale disk copy
        persist.cancelPendingSave();
        persist.saveProjectNow(state.project);
        server.broadcast({ type: 'toast', ok: true, message: 'already open' });
        break;
      }
      const p = persist.loadSlug(cmd.slug);
      if (!p) {
        server.broadcast({ type: 'toast', ok: false, message: `cannot open "${cmd.slug}"` });
        break;
      }
      persist.cancelPendingSave();
      persist.saveProjectNow(state.project); // flush pending edits, old slug
      persist.setCurrentSlug(cmd.slug);
      state.replaceProject(p);
      server.broadcast({ type: 'toast', ok: true, message: `opened "${p.name}"` });
      broadcastProjects();
      break;
    }
    case 'saveProjectAs': {
      const name = cmd.name.trim() || 'Untitled';
      const slug = persist.slugify(name);
      state.project.name = name;
      persist.saveSlugNow(slug, state.project);
      persist.setCurrentSlug(slug);
      state.onChange?.(); // name changed — echo + autosave under the new slug
      server.broadcast({ type: 'toast', ok: true, message: `saved as "${name}"` });
      broadcastProjects();
      break;
    }
    case 'midi':
      state.applyMidi(cmd.status, cmd.d1, cmd.d2);
      break;
    case 'learn':
      state.learnTarget = cmd.action;
      break;
    case 'importGdtf': {
      try {
        const profiles = parseGdtfBase64(cmd.data);
        state.project.profiles ??= {};
        const replacedGdtf: string[] = [];
        for (const p of profiles) {
          // Attribution travels with the profile into the project file — a GDTF
          // carries no author attribute, so this can only come from the source.
          if (cmd.credit) p.credit = cmd.credit;
          preserveAuthoredLayout(state.project, p);
          const note = describeProfileReplacement(state.project, p);
          if (note) replacedGdtf.push(note);
          state.project.profiles[p.id] = p;
        }
        state.onChange?.();
        server.broadcast({
          type: 'importResult',
          ok: true,
          message:
            `${cmd.name}: imported ${profiles.length} mode(s)` +
            replacedGdtf.map((n) => ` · ${n}`).join(''),
          profileIds: profiles.map((p) => p.id),
        });
      } catch (err) {
        server.broadcast({
          type: 'importResult',
          ok: false,
          message: `${cmd.name}: ${(err as Error).message}`,
          profileIds: [],
        });
      }
      break;
    }
    case 'importMvr': {
      try {
        const bundle = parseMvrBase64(cmd.data);
        const summary = applyMvrBundle(state.project, bundle, cmd.replace);
        state.updateProject(state.project);
        server.broadcast({ type: 'importResult', ok: true, message: `${cmd.name}: ${summary}`, profileIds: [] });
      } catch (err) {
        server.broadcast({ type: 'importResult', ok: false, message: `${cmd.name}: ${(err as Error).message}`, profileIds: [] });
      }
      break;
    }
    case 'switchDeck':
      state.switchDeck(cmd.deckId);
      break;
    case 'launchPreviz': {
      const [ok, message] = spawnPreviz();
      server.broadcast({ type: 'toast', ok, message });
      break;
    }
    case 'save': {
      const p = persist.saveProjectNow(state.project);
      server.broadcast({ type: 'saved', path: p });
      break;
    }
  }
}

let oscLogWindow = 0;
let oscLogCount = 0;

function handleOsc(msg: OscMessage): void {
  // The monitor is best-effort — never let an OSC flood amplify into the
  // WS broadcast path (cap ~25 events/s, drop the rest).
  const now = Date.now();
  if (now - oscLogWindow > 1000) {
    oscLogWindow = now;
    oscLogCount = 0;
  }
  if (oscLogCount++ < 25) {
    server.broadcast({ type: 'osc', entry: { t: now, addr: msg.addr, args: msg.args } });
  }
  const sync = state.project.sync;

  if (sync.bpmFromOsc && msg.addr === '/composition/tempocontroller/tempo') {
    const v = msg.args[0];
    if (typeof v === 'number' && Number.isFinite(v)) {
      // Resolume sends its tempo slider normalised 0..1 over 20..500 BPM;
      // tolerate tools that send the BPM directly.
      const bpm = v <= 1.0001 ? 20 + v * 480 : v;
      state.clock.setBpm(bpm);
    }
  }
  if (msg.addr === '/composition/tempocontroller/resync') {
    state.clock.resync();
  }
  if (sync.followColumns) {
    const m = msg.addr.match(/^\/composition\/columns\/(\d+)\/connect$/);
    if (m && (msg.args.length === 0 || Number(msg.args[0]) >= 1)) {
      state.triggerColumn(parseInt(m[1], 10) - 1);
    }
  }
  // Direct control addresses for anything that can send OSC. All args are
  // untrusted network input: finite-checked, range-checked, and identical in
  // behaviour to the Rust core.
  const a0 = msg.args[0];
  if (msg.addr === '/light/bpm' && typeof a0 === 'number' && Number.isFinite(a0) && a0 >= 20 && a0 <= 999) {
    state.clock.setBpm(a0);
  }
  if (msg.addr === '/light/column' && typeof a0 === 'number' && Number.isFinite(a0) && a0 >= 1) {
    state.triggerColumn(Math.floor(a0) - 1);
  }
  if (msg.addr === '/light/blackout' && typeof a0 === 'number' && Number.isFinite(a0)) {
    state.blackout = a0 >= 1;
  }
}

// --- 40 Hz output loop with drift correction ---
let target = performance.now() + TICK_MS;
let tickCount = 0;
let jitterMax = 0;
let windowStart = performance.now();
let stats = { fps: 40, jitter: 0, artnet: 0, sacn: 0 };

let lastLoopError = 0;

function loop(): void {
  try {
    loopBody();
  } catch (err) {
    // A render error must never stop the show: nodes hold their last frame,
    // we log (throttled) and keep ticking.
    const now = Date.now();
    if (now - lastLoopError > 1000) {
      lastLoopError = now;
      console.error('[light] tick error (output holding):', err);
    }
  } finally {
    target += TICK_MS;
    if (target < performance.now() - 250) target = performance.now() + TICK_MS;
    setTimeout(loop, Math.max(0, target - performance.now()));
  }
}

function loopBody(): void {
  const now = performance.now();
  jitterMax = Math.max(jitterMax, Math.abs(now - target));

  flushProject(); // one project echo per tick, however many edits arrived
  const res = renderer.tick(now);
  artnet.pollTick(
    state.project.universes.some((u) => u.artnet),
    state.project.universes.filter((u) => u.artnet).map((u) => u.unicast),
  );
  for (const u of state.project.universes) {
    const buf = res.buffers.get(u.id);
    if (!buf) continue;
    if (u.artnet) artnet.send(u.artnetUniverse, buf, u.unicast);
    if (u.sacn) sacn.send(u.sacnUniverse, buf, u.unicast);
  }

  tickCount++;
  if (now - windowStart >= 2000) {
    stats = {
      fps: Math.round((tickCount * 1000) / (now - windowStart)),
      jitter: Math.round(jitterMax * 10) / 10,
      artnet: artnet.packets,
      sacn: sacn.packets,
    };
    tickCount = 0;
    jitterMax = 0;
    windowStart = now;
  }

  // Snapshots to the UI at 20 fps — the UI interpolates.
  if ((tickCount & 1) === 0 && server.clientCount > 0) {
    const snap: Snapshot = {
      type: 'snap',
      now,
      beat: res.beat,
      bpm: state.clock.bpm,
      speed: state.speed,
      master: state.master,
      blackout: state.blackout,
      haze: state.project.settings.haze,
      hazeFan: state.project.settings.hazeFan,
      heads: res.heads,
      layers: res.layers,
      ...(state.muted.size > 0 ? { muted: [...state.muted] } : {}),
      ...(state.soft.size > 0 ? { soft: state.softEntries() } : {}),
      ...(state.controlLive.size > 0 ? { controls: state.controlEntries() } : {}),
      ...(state.identify ? { identify: state.identify } : {}),
      ...((() => {
        let n = 0;
        for (const m of state.overrides.values()) n += m.size;
        return n > 0 ? { overrides: n } : {};
      })()),
      ...(() => {
        // include discovery state whenever polling is (or was) relevant, and
        // call nodesSnapshot exactly once per snapshot
        const status = artnet.pollStatus();
        if (status === 'off' && !state.project.universes.some((u) => u.artnet)) return {};
        const nodes = artnet.nodesSnapshot();
        return {
          artnetNodes: nodes,
          ...(status === 'failed' ? { artnetPoll: 'failed' as const } : { artnetPoll: 'on' as const }),
        };
      })(),
      ...(osc.status() ? { oscIn: osc.status() as 'on' | 'failed' } : {}),
      ...((() => {
        // a fixture pointing at a profile that no longer exists renders as
        // nothing at all — surface it rather than leaving an operator hunting
        // a dead fixture on the truss
        const bad = state.project.fixtures
          .filter(
            (f) =>
              !PROFILES[f.profileId] &&
              !(state.project.profiles && Object.hasOwn(state.project.profiles, f.profileId)),
          )
          .map((f) => f.id);
        return bad.length > 0 ? { unknownProfiles: bad } : {};
      })()),
      stats,
    };
    // Identical for every client, so one serialisation, one broadcast.
    server.broadcast(snap);

    // Raw DMX only to clients that asked: the Output tab reads one universe,
    // and it used to ride in every snapshot to every client (~8 KB of ~28 KB at
    // arena scale, 20x a second) including ones that never read a byte.
    for (const [ws, ids] of dmxSubs) {
      if (ids.length === 0) continue;
      const u: Record<string, number[]> = {};
      for (const id of ids) {
        const buf = res.buffers.get(id);
        if (buf) u[id] = Array.from(buf);
      }
      server.send(ws as never, { type: 'dmx', u });
    }

    // The audition head set goes only to whoever asked for it.
    if (previewWs) {
      const pv = previewHeads(now);
      server.send(previewWs as never, { type: 'preview', heads: pv ? pv.previewHeads ?? null : null });
    }
  }

}

process.on('uncaughtException', (err) => {
  console.error('[light] uncaught exception (engine continues):', err);
});
process.on('unhandledRejection', (err) => {
  console.error('[light] unhandled rejection (engine continues):', err);
});

loop();

console.log('');
console.log('  ██   LIGHT engine');
console.log(`  ██   project   ${state.project.name}`);
console.log(`  ██   ui        http://localhost:${PORT}  (dev: http://localhost:5173)`);
console.log(`  ██   art-net   ${state.project.universes.filter((u) => u.artnet).map((u) => `U${u.artnetUniverse}`).join(', ') || 'off'} @ 40 Hz`);
// the bind is async, so report once it has settled rather than claiming a
// port we may not hold — saying ":7700" after a failure sends you hunting
// through Resolume for a problem that is on this side
setTimeout(() => {
  const st = osc.status();
  console.log(
    `  ██   osc in    ${
      st === 'failed'
        ? `:${state.project.sync.oscPort} UNAVAILABLE (port held by another app)`
        : st === 'on'
          ? `:${state.project.sync.oscPort}`
          : 'off'
    }`,
  );
}, 50);
console.log('');

process.on('SIGINT', () => {
  console.log('\n[light] saving project & shutting down…');
  try {
    persist.saveProjectNow(state.project);
  } catch {
    // nothing more we can do on the way out
  }
  artnet.close();
  sacn.close();
  osc.stop();
  server.close();
  process.exit(0);
});
