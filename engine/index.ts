import path from 'node:path';
import type { Command, Snapshot } from '../shared/types.ts';
import { WS_PORT, clamp, sanitizeProject } from '../shared/types.ts';
import { EngineState } from './state.ts';
import { Renderer } from './renderer.ts';
import { ArtnetOut } from './artnet.ts';
import { SacnOut } from './sacn.ts';
import { OscIn, type OscMessage } from './osc.ts';
import { Server } from './server.ts';
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
function applyMvrBundle(p: Project, bundle: MvrBundle, replace: boolean): string {
  if (replace) {
    p.fixtures = [];
    p.groups = [];
    for (const layer of p.layers) layer.cells = layer.cells.map(() => null);
    p.looks = {};
  }
  p.profiles ??= {};
  for (const [id, prof] of Object.entries(bundle.profiles)) p.profiles[id] = prof;

  const fixtureIds: string[] = [];
  for (const f of bundle.fixtures) {
    let u = p.universes.find((x) => x.artnetUniverse === f.universe);
    if (!u) {
      u = {
        id: uid('u'),
        label: `MVR U${f.universe}`,
        artnetUniverse: f.universe,
        sacnUniverse: Math.max(1, f.universe),
        artnet: true,
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
        const child = spawn(c, [], { detached: true, stdio: 'ignore' });
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

const state = new EngineState(project);
const renderer = new Renderer(state);
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

state.onChange = () => {
  projectDirty = true;
  persist.saveProjectDebounced(() => state.project);
  osc.listen(state.project.sync.oscPort, state.project.sync.oscEnabled);
};

/** Flush a coalesced project echo — called once per tick. */
function flushProject(): void {
  if (!projectDirty) return;
  projectDirty = false;
  server.broadcast({ type: 'project', project: state.project });
}

server.onConnect = (ws) => {
  server.send(ws, { type: 'project', project: state.project });
  if (bootWarning) server.send(ws, { type: 'toast', ok: false, message: bootWarning });
  server.send(ws, { type: 'midiInputs', names: [] }); // Node dev engine has no native MIDI
};

// If the client holding a flash look crashes, nothing will ever release it.
// The protocol doesn't attribute holds to clients, so release on ANY
// disconnect: a spurious release beats a blinder latched on stage.
server.onDisconnect = () => {
  state.releaseAllHeld();
};

state.onLearned = (mapping) => {
  server.broadcast({ type: 'learned', mapping });
};

function handleCommand(cmd: Command): void {
  switch (cmd.type) {
    case 'hello':
      break; // project already sent on connect
    case 'trigger':
      state.trigger(cmd.layerId, cmd.col);
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
        for (const p of profiles) state.project.profiles[p.id] = p;
        state.onChange?.();
        server.broadcast({
          type: 'importResult',
          ok: true,
          message: `${cmd.name}: imported ${profiles.length} mode(s)`,
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
    const dmx: Record<string, number[]> = {};
    for (const [id, buf] of res.buffers) dmx[id] = Array.from(buf);
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
      dmx,
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
      stats,
    };
    server.broadcast(snap);
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
console.log(`  ██   osc in    ${state.project.sync.oscEnabled ? `:${state.project.sync.oscPort}` : 'off'}`);
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
