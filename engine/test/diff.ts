// Differential parity test: boots the Node reference engine and the Rust core
// side-by-side, drives both with identical protocol commands, and requires
// byte-identical DMX output. Run `cargo build -p light-core` first.
//
//   npm run test:parity

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { defaultProject } from '../defaultProject.ts';
import type { Command, Project, Snapshot } from '../../shared/types.ts';

const ROOT = process.cwd();
const TMP = path.join(ROOT, '.parity-tmp');
const RUST_BIN = path.join(ROOT, 'target', 'debug', 'light-engine');

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

class Client {
  ws!: WebSocket;
  snap: Snapshot | null = null;
  project: Project | null = null;

  async connect(port: number): Promise<void> {
    for (let i = 0; i < 50; i++) {
      try {
        await new Promise<void>((resolve, reject) => {
          const ws = new WebSocket(`ws://127.0.0.1:${port}`);
          ws.on('open', () => {
            this.ws = ws;
            resolve();
          });
          ws.on('error', reject);
        });
        this.ws.on('message', (d) => {
          const ev = JSON.parse(String(d));
          if (ev.type === 'snap') this.snap = ev;
          if (ev.type === 'project') this.project = ev.project;
        });
        return;
      } catch {
        await sleep(200);
      }
    }
    throw new Error(`cannot connect to :${port}`);
  }

  send(cmd: Command): void {
    this.ws.send(JSON.stringify(cmd));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function currentProject(c: Client): Promise<Project> {
  for (let i = 0; i < 30; i++) {
    if (c.project) return c.project;
    await sleep(100);
  }
  throw new Error('no project received');
}

function compareDmx(name: string, a: Snapshot | null, b: Snapshot | null): void {
  const da = a?.dmx['u1'];
  const db = b?.dmx['u1'];
  if (!da || !db) {
    check(name, false, 'missing snapshot');
    return;
  }
  const diffs: string[] = [];
  for (let i = 0; i < 512; i++) {
    if (da[i] !== db[i]) diffs.push(`ch${i + 1}: node=${da[i]} rust=${db[i]}`);
  }
  check(name, diffs.length === 0, diffs.slice(0, 8).join(', '));
}

async function main(): Promise<void> {
  // Pristine identical projects with network output disabled.
  const proj = defaultProject();
  for (const u of proj.universes) {
    u.artnet = false;
    u.sacn = false;
  }
  const dirs = { node: path.join(TMP, 'node'), rust: path.join(TMP, 'rust') };
  for (const d of Object.values(dirs)) {
    fs.rmSync(d, { recursive: true, force: true });
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'default.project.json'), JSON.stringify(proj, null, 1));
  }
  if (!fs.existsSync(RUST_BIN)) {
    console.error('rust engine not built — run: cargo build -p light-core');
    process.exit(1);
  }

  const procs: ChildProcess[] = [];
  const kill = () => procs.forEach((p) => p.kill('SIGKILL'));
  process.on('exit', kill);

  procs.push(
    spawn(process.execPath, ['engine/index.ts'], {
      env: { ...process.env, LIGHT_PORT: '9902', LIGHT_PROJECT_DIR: dirs.node, LIGHT_NO_ARTPOLL: '1' },
      stdio: 'ignore',
    }),
    spawn(RUST_BIN, [], {
      env: { ...process.env, LIGHT_PORT: '9901', LIGHT_PROJECT_DIR: dirs.rust, LIGHT_NO_MIDI: '1', LIGHT_NO_ARTPOLL: '1' },
      stdio: 'ignore',
    })
  );

  const node = new Client();
  const rust = new Client();
  await node.connect(9902);
  await rust.connect(9901);
  console.log('both engines up');

  const both = (cmd: Command) => {
    node.send(cmd);
    rust.send(cmd);
  };

  await sleep(400);
  compareDmx('idle output identical', node.snap, rust.snap);

  both({ type: 'column', col: 0 }); // Intro: amber wash (no effects)
  await sleep(1400); // > 0.8 s fade
  compareDmx('column 1 (amber wash)', node.snap, rust.snap);

  both({ type: 'trigger', layerId: 'layer-derby', col: 2 }); // R+B spin: macro 88, motor 192
  await sleep(1100);
  compareDmx('derby macro + motor', node.snap, rust.snap);

  both({ type: 'setMaster', v: 0.5 });
  await sleep(300);
  compareDmx('grand master 50%', node.snap, rust.snap);

  both({ type: 'setBlackout', v: true });
  await sleep(300);
  compareDmx('blackout', node.snap, rust.snap);
  both({ type: 'setBlackout', v: false });
  both({ type: 'setMaster', v: 1 });

  both({ type: 'setHaze', v: 0.5 });
  await sleep(300);
  compareDmx('manual haze', node.snap, rust.snap);

  both({ type: 'setBpm', bpm: 150 });
  await sleep(300);
  check(
    'bpm parity',
    Math.abs((node.snap?.bpm ?? 0) - (rust.snap?.bpm ?? 1)) < 1e-6,
    `node=${node.snap?.bpm} rust=${rust.snap?.bpm}`
  );

  both({ type: 'trigger', layerId: 'layer-strobe', col: 1 }); // ring blinder flash
  await sleep(300);
  compareDmx('blinder held', node.snap, rust.snap);
  both({ type: 'release', layerId: 'layer-strobe', col: 1 });
  await sleep(400);
  compareDmx('blinder released', node.snap, rust.snap);

  const colsN = node.snap?.layers.map((l) => `${l.id}:${l.col}`).join(' ');
  const colsR = rust.snap?.layers.map((l) => `${l.id}:${l.col}`).join(' ');
  check('live column state parity', colsN === colsR, `node=[${colsN}] rust=[${colsR}]`);

  // --- GDTF import parity: Node renders via WASM, Rust natively — same file,
  // --- same bytes required.
  const gdtf = fs.readFileSync(path.join(ROOT, 'core', 'tests', 'data', 'synthetic.gdtf'));
  both({ type: 'importGdtf', name: 'synthetic.gdtf', data: gdtf.toString('base64') });
  await sleep(500);

  const projN = structuredClone(await currentProject(node));
  const profileId = 'gdtf-acme-testspot-100-standard';
  check('import landed in project (node)', !!projN.looks && !!projN.profiles?.[profileId]);

  // patch the imported fixture + a look targeting it, identically on both
  const patchIn = (p: Project) => {
    p.fixtures.push({
      id: 'spot1', name: 'Test Spot', profileId, universeId: 'u1', address: 200,
      pos: { x: 0, y: 3, z: 0 }, rotY: 0,
    });
    p.groups.push({ id: 'g-spot', name: 'Spot', heads: [{ fixtureId: 'spot1', head: 0 }] });
    p.looks['look-spot'] = {
      id: 'look-spot', name: 'Spot test',
      parts: [{ id: 'p-spot', groupId: 'g-spot',
        params: { dimmer: 1, color: { h: 0, s: 1 }, pan: 0.5, tilt: 1 }, effects: [] }],
    };
    p.layers[0].cells[0] = 'look-spot';
    return p;
  };
  node.send({ type: 'updateProject', project: patchIn(structuredClone(projN)) });
  const projR = structuredClone(await currentProject(rust));
  rust.send({ type: 'updateProject', project: patchIn(projR) });
  await sleep(300);
  both({ type: 'trigger', layerId: 'layer-wash', col: 0 });
  await sleep(1400);
  compareDmx('imported GDTF fixture (wasm vs native)', node.snap, rust.snap);
  const spot = node.snap?.dmx['u1']?.slice(199, 210);
  check(
    'imported fixture bytes correct',
    JSON.stringify(spot) === JSON.stringify([128, 0, 255, 255, 255, 8, 255, 0, 0, 128, 23]),
    `got ${JSON.stringify(spot)}`
  );

  // --- cue lists: trigger-anchored steps must advance identically ---
  {
    const p = structuredClone(await currentProject(node));
    const wash = p.layers.find((l) => l.id === 'layer-wash');
    const stepIds = (wash?.cells ?? []).filter((c): c is string => !!c).slice(0, 3);
    if (wash && stepIds.length === 3) {
      p.looks['look-cue-test'] = {
        id: 'look-cue-test',
        name: 'Cue Test',
        parts: [],
        steps: [
          { lookId: stepIds[0], beats: 2 },
          { lookId: stepIds[1], beats: 1 },
          { lookId: stepIds[2], beats: 1 },
        ],
      };
      wash.cells[7] = 'look-cue-test';
      both({ type: 'updateProject', project: p });
      await sleep(300);
      both({ type: 'setBpm', bpm: 120 }); // 500 ms/beat; also aligns phase
      await sleep(200);
      both({ type: 'trigger', layerId: 'layer-wash', col: 7 });
      // steps of 2/1/1 beats → boundaries at 1000/1500/2000 ms after trigger;
      // checkpoints sit mid-step so snapshot lag and trigger skew can't bite
      await sleep(700);
      compareDmx('cue list: step 1 parity', node.snap, rust.snap);
      await sleep(550);
      compareDmx('cue list: step 2 parity', node.snap, rust.snap);
      await sleep(500);
      compareDmx('cue list: step 3 parity', node.snap, rust.snap);
      await sleep(500);
      compareDmx('cue list: loop back to step 1 parity', node.snap, rust.snap);
      // tap while the cue runs: alignPhase must shift anchors so both
      // engines stay in the same step (regression: permanent desync)
      both({ type: 'tap' });
      await sleep(450);
      compareDmx('cue list: step parity after tap/align', node.snap, rust.snap);

      // cue-to-cue crossfade: firing a second chaser must not corrupt the
      // first one's anchor (regression: outgoing cue snapped to step 1)
      p.looks['look-cue-test-b'] = {
        id: 'look-cue-test-b',
        name: 'Cue Test B',
        parts: [],
        steps: [
          { lookId: stepIds[2], beats: 1 },
          { lookId: stepIds[0], beats: 1 },
        ],
      };
      const wash2 = p.layers.find((l) => l.id === 'layer-wash');
      if (wash2) wash2.cells[6] = 'look-cue-test-b';
      both({ type: 'updateProject', project: p });
      await sleep(300);
      both({ type: 'trigger', layerId: 'layer-wash', col: 6 });
      await sleep(1250); // past the 0.8 s fade, mid-step of B
      compareDmx('cue list: cue-to-cue crossfade parity', node.snap, rust.snap);

      // poisoned step id: "constructor" resolves via Object.prototype in JS —
      // both engines must render it dark and KEEP TICKING (regression: the
      // Node tick loop crashed and froze DMX output)
      p.looks['look-cue-test'] = {
        id: 'look-cue-test',
        name: 'Cue Poisoned',
        parts: [],
        steps: [{ lookId: 'constructor', beats: 1 }],
      };
      both({ type: 'updateProject', project: p });
      await sleep(200);
      both({ type: 'trigger', layerId: 'layer-wash', col: 7 });
      await sleep(1300);
      compareDmx('cue list: prototype-key step renders dark in both', node.snap, rust.snap);
      const nodeAlive = (node.snap?.now ?? 0);
      await sleep(400);
      check(
        'node engine still ticking after poisoned cue',
        (node.snap?.now ?? 0) > nodeAlive,
        'snapshot clock stopped'
      );

      both({ type: 'clearLayer', layerId: 'layer-wash' });
      await sleep(1200); // > 0.8 s fade — mid-fade bytes are skew-sensitive
      compareDmx('cue list: released parity', node.snap, rust.snap);
    } else {
      check('cue list scenario prerequisites', false, 'wash layer content missing');
    }
  }

  // --- gig tools: mute / identify / all-stop must be byte-identical ---
  {
    both({ type: 'column', col: 0 });
    await sleep(1200);
    compareDmx('gig tools: baseline cue parity', node.snap, rust.snap);

    both({ type: 'setFixtureMute', fixtureId: 'bar1', on: true });
    await sleep(600);
    compareDmx('mute: silenced fixture parity', node.snap, rust.snap);
    // a muted fixture's whole span must be zero — not merely "dimmer 0", which
    // trusts a fixture that is by definition misbehaving
    const bar1Span = (node.snap?.dmx['u1'] ?? []).slice(20, 40);
    check('mute: bar1 whole channel span is zero', bar1Span.every((v) => v === 0),
      `still emitting: ${bar1Span.map((v, i) => (v ? `${i + 21}:${v}` : '')).filter(Boolean).join(' ')}`);

    both({ type: 'identify', fixtureId: 'derby1' });
    await sleep(600);
    compareDmx('identify: full-white override parity', node.snap, rust.snap);

    // identify must beat blackout — that is the point at load-in
    both({ type: 'setBlackout', v: true });
    await sleep(600);
    compareDmx('identify: survives blackout parity', node.snap, rust.snap);
    const derbyLit = (node.snap?.dmx['u1'] ?? [])[0] > 0;
    check('identify: derby1 still lit under blackout', derbyLit, 'identify lost to blackout');

    both({ type: 'identify', fixtureId: null });
    both({ type: 'setFixtureMute', fixtureId: 'bar1', on: false });
    both({ type: 'setBlackout', v: false });
    await sleep(600);
    compareDmx('gig tools: cleared parity', node.snap, rust.snap);

    // raw channel override is the last word in the buffer
    both({ type: 'setChannel', universeId: 'u1', channel: 5, value: 200 });
    await sleep(600);
    compareDmx('channel override parity', node.snap, rust.snap);
    check(
      'channel override reaches the wire',
      (node.snap?.dmx['u1'] ?? [])[4] === 200,
      `ch5 = ${(node.snap?.dmx['u1'] ?? [])[4]}`
    );

    // all-stop: dark, quiet, and no overrides left behind
    both({ type: 'allStop' });
    await sleep(900);
    compareDmx('all-stop parity', node.snap, rust.snap);
    // all-stop is about the room going dark and QUIET: every dimmer at zero,
    // the hazer and its fan stopped, derby motors stopped. (Colour channels
    // may still hold their last value behind a zero dimmer — harmless.)
    const dmx = node.snap?.dmx['u1'] ?? [];
    check('all-stop: hazer output and fan are off', dmx[100] === 0 && dmx[101] === 0,
      `hazer=${dmx[100]} fan=${dmx[101]}`);
    check('all-stop: derbies fully zeroed (motors stopped)',
      dmx.slice(0, 20).every((v) => v === 0),
      `derby bytes: ${dmx.slice(0, 20).join(',')}`);
    check('all-stop: no head is lit', (node.snap?.heads ?? []).every((h) => h.i === 0),
      'a head still has intensity');

    both({ type: 'setBlackout', v: false });
    await sleep(400);
  }

  // --- MVR import parity: both engines apply the same scene identically.
  const mvr = fs.readFileSync(path.join(ROOT, 'core', 'tests', 'data', 'synthetic.mvr'));
  node.project = null;
  rust.project = null;
  both({ type: 'importMvr', name: 'synthetic.mvr', replace: false, data: mvr.toString('base64') });
  await sleep(600);
  const shape = (p: Project) =>
    JSON.stringify({
      fixtures: p.fixtures
        .map((f) => {
          const u = p.universes.find((x) => x.id === f.universeId);
          return [f.name, u?.artnetUniverse, f.address, f.pos];
        })
        .sort(),
      groups: p.groups.map((g) => [g.name, g.heads.length]).sort(),
      universes: p.universes.map((u) => u.artnetUniverse).sort(),
      profiles: Object.keys(p.profiles ?? {}).sort(),
    });
  const shapeN = shape(await currentProject(node));
  const shapeR = shape(await currentProject(rust));
  check('mvr import shape parity', shapeN === shapeR, `node=${shapeN}\nrust=${shapeR}`);

  // the import added artnet-enabled universes — disable ALL outputs in both
  // engines immediately (universe 0 is the factory default on most nodes;
  // a test run must never black out a real rig)
  for (const c of [node, rust]) {
    const p = structuredClone(await currentProject(c));
    for (const u of p.universes) {
      u.artnet = false;
      u.sacn = false;
    }
    c.send({ type: 'updateProject', project: p });
  }
  await sleep(300);
  check(
    'no output universes remain enabled after import',
    (await currentProject(node)).universes.every((u) => !u.artnet && !u.sacn),
    'artnet leaked on'
  );

  kill();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(failures === 0 ? '\nParity: Rust core matches the Node reference.' : `\n${failures} parity FAILURE(S).`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
