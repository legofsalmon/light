import path from 'node:path';
import type { Command, Snapshot } from '../shared/types.ts';
import { WS_PORT, clamp } from '../shared/types.ts';
import { EngineState } from './state.ts';
import { Renderer } from './renderer.ts';
import { ArtnetOut } from './artnet.ts';
import { SacnOut } from './sacn.ts';
import { OscIn, type OscMessage } from './osc.ts';
import { Server } from './server.ts';
import { defaultProject } from './defaultProject.ts';
import { loadProject, projectPath, saveProjectDebounced, saveProjectNow } from './persist.ts';
import { parseGdtfBase64 } from './wasmProfiles.ts';

const TICK_MS = 25; // 40 Hz DMX refresh
const PORT = Number(process.env.LIGHT_PORT ?? WS_PORT);

// --- boot ---
let project = loadProject();
if (!project) {
  project = defaultProject();
  try {
    saveProjectNow(project);
    console.log(`[light] created default project at ${projectPath()}`);
  } catch (err) {
    console.error('[light] could not write default project:', (err as Error).message);
  }
}

const state = new EngineState(project);
const renderer = new Renderer(state);
const artnet = new ArtnetOut();
const sacn = new SacnOut();

const server = new Server(PORT, path.join(process.cwd(), 'ui', 'dist'), handleCommand);

const osc = new OscIn(handleOsc);
osc.listen(state.project.sync.oscPort, state.project.sync.oscEnabled);

state.onChange = () => {
  server.broadcast({ type: 'project', project: state.project });
  saveProjectDebounced(() => state.project);
  osc.listen(state.project.sync.oscPort, state.project.sync.oscEnabled);
};

server.onConnect = (ws) => {
  server.send(ws, { type: 'project', project: state.project });
  server.send(ws, { type: 'midiInputs', names: [] }); // Node dev engine has no native MIDI
};

// If the client holding a flash look crashes, nothing will ever release it —
// drop all held flash looks once no client is connected.
server.onDisconnect = () => {
  if (server.clientCount === 0) state.releaseAllHeld();
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
      break;
    case 'resync':
      state.clock.resync();
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
    case 'updateProject':
      state.updateProject(cmd.project);
      break;
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
    case 'save': {
      const p = saveProjectNow(state.project);
      server.broadcast({ type: 'saved', path: p });
      break;
    }
  }
}

function handleOsc(msg: OscMessage): void {
  server.broadcast({ type: 'osc', entry: { t: Date.now(), addr: msg.addr, args: msg.args } });
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
  // Direct control addresses for anything that can send OSC.
  if (msg.addr === '/light/bpm' && typeof msg.args[0] === 'number') state.clock.setBpm(msg.args[0]);
  if (msg.addr === '/light/column' && typeof msg.args[0] === 'number') state.triggerColumn(msg.args[0] - 1);
  if (msg.addr === '/light/blackout') state.blackout = Number(msg.args[0]) >= 1;
}

// --- 40 Hz output loop with drift correction ---
let target = performance.now() + TICK_MS;
let tickCount = 0;
let jitterMax = 0;
let windowStart = performance.now();
let stats = { fps: 40, jitter: 0, artnet: 0, sacn: 0 };

function loop(): void {
  const now = performance.now();
  jitterMax = Math.max(jitterMax, Math.abs(now - target));

  const res = renderer.tick(now);
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
      stats,
    };
    server.broadcast(snap);
  }

  target += TICK_MS;
  if (target < now - 250) target = now + TICK_MS; // recover after sleep/suspend
  setTimeout(loop, Math.max(0, target - performance.now()));
}

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
    saveProjectNow(state.project);
  } catch {
    // nothing more we can do on the way out
  }
  artnet.close();
  sacn.close();
  osc.stop();
  server.close();
  process.exit(0);
});
