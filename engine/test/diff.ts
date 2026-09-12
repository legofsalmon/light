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
import type { Command, ControlLink, Effect, FxPreset, PartParams, Project, Snapshot } from '../../shared/types.ts';
import { COMPILER_VERSION } from '../../shared/types.ts';

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
  gen = 0;
  /** Raw DMX now arrives as its own event, only for the universes this client
   *  subscribed to — see watchAllDmx below. Latest wins, same as a snapshot. */
  dmx: Record<string, number[]> = {};
  /** The audition head set, likewise now targeted at the requesting client. */
  previewHeads: unknown = null;
  /** The engine's undo history as the buttons see it — one per engine. */
  history: { undo: string | null; redo: string | null; undoDepth: number; redoDepth: number } | null = null;

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
          if (ev.type === 'dmx') this.dmx = ev.u;
          if (ev.type === 'preview') this.previewHeads = ev.heads;
          if (ev.type === 'project') {
            this.project = ev.project;
            this.gen = ev.gen;
          }
          if (ev.type === 'history') {
            this.history = { undo: ev.undo, redo: ev.redo, undoDepth: ev.undoDepth, redoDepth: ev.redoDepth };
          }
        });
        return;
      } catch {
        await sleep(200);
      }
    }
    throw new Error(`cannot connect to :${port}`);
  }

  send(cmd: Command): void {
    // Hold our own writes locally, exactly as the real UI does. The engines no
    // longer echo an updateProject back to the client that sent it — that echo
    // was landing on top of edits the operator had made in the intervening
    // milliseconds and silently discarding them. A thin client that learned
    // about its own writes from the echo would now never see them, so it has to
    // model the optimistic local state the UI has always kept.
    if (cmd.type === 'updateProject') this.project = cmd.project;
    this.ws.send(JSON.stringify(cmd));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Subscribe a client to EVERY universe's raw DMX.
 *
 *  DMX is opt-in per client now, because only the Output tab reads it. The
 *  whole point of this suite is byte-comparing DMX, so the harness has to ask
 *  for all of it — and compareDmx fails loudly on an empty map rather than
 *  quietly comparing nothing, which is the way this change could have turned
 *  the entire parity suite into a no-op. */
async function watchAllDmx(c: Client, p: Project): Promise<void> {
  c.send({ type: 'watchDmx', universeIds: p.universes.map((u) => u.id) });
  await sleep(150);
}

async function currentProject(c: Client): Promise<Project> {
  for (let i = 0; i < 30; i++) {
    if (c.project) return c.project;
    await sleep(100);
  }
  throw new Error('no project received');
}

/** Wait until both engines have stopped changing, then compare.
 *
 *  Several scenarios end in a crossfade — all-stop, for one, leaves pan/tilt
 *  travelling back to centre even though blackout has already killed
 *  intensity. Comparing after a fixed sleep only works if that fade happens to
 *  have finished, and the two engines start their fades a few milliseconds
 *  apart because the commands arrive over separate sockets. Mid-fade, that
 *  skew is a real byte difference and the suite fails on a slow runner while
 *  passing on a fast one. Settling first removes the race instead of hiding it
 *  behind a longer sleep: if the engines genuinely disagree, they still
 *  disagree once both are still. */
async function settle(a: Client, b: Client, maxMs = 4000): Promise<void> {
  const snapshot = (c: Client) =>
    Object.keys(c.dmx)
      .sort()
      .map((u) => (c.dmx[u] ?? []).join(','))
      .join('|');
  let prevA = snapshot(a);
  let prevB = snapshot(b);
  let stable = 0;
  for (let waited = 0; waited < maxMs; waited += 100) {
    await sleep(100);
    const nowA = snapshot(a);
    const nowB = snapshot(b);
    // two consecutive identical frames on both sides = nothing is moving
    stable = nowA === prevA && nowB === prevB ? stable + 1 : 0;
    prevA = nowA;
    prevB = nowB;
    if (stable >= 2) return;
  }
}

/** One client's whole DMX state as a stable string — same shape settle() uses,
 *  so a before/after comparison on ONE engine proves a frame did or didn't move
 *  (compareDmx only ever compares the two engines to each other). */
function frameOf(c: Client): string {
  return Object.keys(c.dmx)
    .sort()
    .map((u) => (c.dmx[u] ?? []).join(','))
    .join('|');
}

function compareDmx(name: string, a: Client | null, b: Client | null): void {
  // An empty map is a HARNESS failure, not a pass: DMX is opt-in per client
  // now, so a missing watchDmx subscription would otherwise turn every byte
  // comparison below into a silent no-op.
  if (!a?.dmx || !b?.dmx || Object.keys(a.dmx).length === 0 || Object.keys(b.dmx).length === 0) {
    check(name, false, 'no DMX received — is the client subscribed via watchDmx?');
    return;
  }
  // EVERY universe, not just u1. Indexing dmx['u1'] literally meant a second
  // universe was never byte-compared at all — and a second universe is where
  // the 8-head imported GDTF profiles live on the real rig.
  const ids = [...new Set([...Object.keys(a.dmx), ...Object.keys(b.dmx)])].sort();
  const diffs: string[] = [];
  for (const u of ids) {
    const da = a.dmx[u];
    const db = b.dmx[u];
    if (!da || !db) {
      diffs.push(`${u}: present on only one engine`);
      continue;
    }
    for (let i = 0; i < 512; i++) {
      if (da[i] !== db[i]) diffs.push(`${u} ch${i + 1}: node=${da[i]} rust=${db[i]}`);
    }
  }
  check(name, diffs.length === 0, diffs.slice(0, 8).join(', '));
}

async function main(): Promise<void> {
  // A fixed demo show, NOT the shipped default. Parity asserts exact bytes at
  // named addresses on named looks, so pinning it to whatever show currently
  // ships would mean the suite breaks whenever the set list is edited — and a
  // real edit would look like a parity regression.
  const proj = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'core', 'tests', 'data', 'demo_project.json'), 'utf8'),
  ) as Project;
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
      env: { ...process.env, LIGHT_PORT: '9902', LIGHT_PROJECT_DIR: dirs.node, LIGHT_NO_ARTPOLL: '1', LIGHT_TEST_CLOCK: '1' },
      stdio: 'ignore',
    }),
    spawn(RUST_BIN, [], {
      env: { ...process.env, LIGHT_PORT: '9901', LIGHT_PROJECT_DIR: dirs.rust, LIGHT_NO_MIDI: '1', LIGHT_NO_ARTPOLL: '1', LIGHT_TEST_CLOCK: '1' },
      stdio: 'ignore',
    })
  );

  const node = new Client();
  const rust = new Client();
  await node.connect(9902);
  await rust.connect(9901);
  // Read-only observers. Client.send() now stores the project it just wrote, so
  // that a client models the UI's optimistic local state — which means the
  // sending client is no longer a witness to what the ENGINE holds. Anything
  // asserting engine truth has to ask a socket that never writes. The Art-Net
  // safety check at the end of this file is exactly such an assertion, and
  // without this it silently became a tautology about our own variable.
  const nodeObs = new Client();
  const rustObs = new Client();
  await nodeObs.connect(9902);
  await rustObs.connect(9901);
  // DMX is opt-in per client now — every client this suite compares bytes with
  // has to ask for all of it, or compareDmx fails loudly (by design).
  for (const c of [node, rust, nodeObs, rustObs]) await watchAllDmx(c, proj);
  console.log('both engines up');

  const both = (cmd: Command) => {
    node.send(cmd);
    rust.send(cmd);
  };

  // Put a named look live on layer-wash col 6 with the effect clock pinned.
  // Earlier scenarios rewrite the grid (the cue-list block parks its test looks
  // on cols 6/7), so the cell is reset first and the live look is asserted -
  // triggering a stale column silently fires the wrong look, which is exactly
  // how the rate/mix checks below could have passed against nothing.
  const armWash = async (lookId: string, beat: number): Promise<void> => {
    both({ type: 'allStop' });
    both({ type: 'setBlackout', v: false });
    await settle(node, rust);
    const p = structuredClone(await currentProject(node));
    const wash = p.layers.find((l) => l.id === 'layer-wash');
    if (wash) wash.cells[6] = lookId;
    both({ type: 'updateProject', project: p });
    await sleep(400);
    both({ type: '_pinClock', effBeat: beat });
    both({ type: 'trigger', layerId: 'layer-wash', col: 6 });
    await settle(node, rust);
    const live = node.snap?.layers.find((l) => l.id === 'layer-wash')?.lookId;
    check(`arm: ${lookId} live on layer-wash (col 6)`, live === lookId, `live=${live}`);
  };

  await sleep(400);
  compareDmx('idle output identical', node, rust);

  // --- the transmit gate (backlog #1). Both engines must boot OFFLINE, agree
  // --- on the state, and keep rendering the show either way: the gate decides
  // --- what reaches the wire, not what the show is doing. Every universe here
  // --- has Art-Net and sACN off, so this drives the state, never a socket.
  {
    check(
      'transmit: both engines boot offline, whatever the show says',
      node.snap?.transmit === false && rust.snap?.transmit === false,
      `node=${node.snap?.transmit} rust=${rust.snap?.transmit}`,
    );
    const dmxBefore = JSON.stringify(node.dmx);
    both({ type: 'setTransmit', v: true });
    await settle(node, rust);
    check(
      'transmit: going live is agreed by both engines',
      node.snap?.transmit === true && rust.snap?.transmit === true,
      `node=${node.snap?.transmit} rust=${rust.snap?.transmit}`,
    );
    compareDmx('transmit: live parity', node, rust);
    check(
      'transmit: the gate changes the wire, not the render',
      JSON.stringify(node.dmx) === dmxBefore,
      'the rendered frame moved when the gate opened',
    );
    check(
      'transmit: blackout is a separate question from being offline',
      node.snap?.blackout === false && rust.snap?.blackout === false,
      `node=${node.snap?.blackout} rust=${rust.snap?.blackout}`,
    );
    both({ type: 'setTransmit', v: false });
    await settle(node, rust);
    check(
      'transmit: going offline is agreed by both engines',
      node.snap?.transmit === false && rust.snap?.transmit === false,
      `node=${node.snap?.transmit} rust=${rust.snap?.transmit}`,
    );
    compareDmx('transmit: offline parity', node, rust);
  }

  both({ type: 'column', col: 0 }); // Intro: amber wash (no effects)
  await sleep(1400); // > 0.8 s fade
  compareDmx('column 1 (amber wash)', node, rust);

  both({ type: 'trigger', layerId: 'layer-derby', col: 2 }); // R+B spin: macro 88, motor 192
  await sleep(1100);
  compareDmx('derby macro + motor', node, rust);

  both({ type: 'setMaster', v: 0.5 });
  await sleep(300);
  compareDmx('grand master 50%', node, rust);

  both({ type: 'setBlackout', v: true });
  await sleep(300);
  compareDmx('blackout', node, rust);
  both({ type: 'setBlackout', v: false });
  both({ type: 'setMaster', v: 1 });

  both({ type: 'setHaze', v: 0.5 });
  await sleep(300);
  compareDmx('manual haze', node, rust);

  both({ type: 'setBpm', bpm: 150 });
  await sleep(300);
  check(
    'bpm parity',
    Math.abs((node.snap?.bpm ?? 0) - (rust.snap?.bpm ?? 1)) < 1e-6,
    `node=${node.snap?.bpm} rust=${rust.snap?.bpm}`
  );

  both({ type: 'trigger', layerId: 'layer-strobe', col: 1 }); // ring blinder flash
  await sleep(300);
  compareDmx('blinder held', node, rust);
  both({ type: 'release', layerId: 'layer-strobe', col: 1 });
  await sleep(400);
  compareDmx('blinder released', node, rust);

  const colsN = node.snap?.layers.map((l) => `${l.id}:${l.col}`).join(' ');
  const colsR = rust.snap?.layers.map((l) => `${l.id}:${l.col}`).join(' ');
  check('live column state parity', colsN === colsR, `node=[${colsN}] rust=[${colsR}]`);

  // --- a column this show does not have must not black the rig out ----------
  // Resolume compositions routinely run wider than the light show. An
  // out-of-range column used to read as "every cell empty", which is the
  // clear-the-layer path — so working above the last column killed the rig and
  // kept it dead. Both engines did it identically, so parity alone never saw it.
  {
    both({ type: 'column', col: 0 }); // Intro: something is lit
    await settle(node, rust);
    const lit = (c: Client) => (c.dmx['u1'] ?? []).some((v: number) => v > 0);
    check('out-of-range column: rig lit to begin with', lit(node) && lit(rust));

    both({ type: 'column', col: 99 }); // far past the last column
    await settle(node, rust);
    check(
      'out-of-range column does not black out the rig',
      lit(node) && lit(rust),
      `node lit=${lit(node)} rust lit=${lit(rust)}`,
    );
    compareDmx('out-of-range column parity', node, rust);
  }

  // --- a MIDI deck step must release whatever is held ------------------------
  // Holding a flash and pressing the APC bank arrow swapped the cells out from
  // under the hold, so the note-off resolved a different look and returned
  // early — the blinder stayed lit for the rest of the show. Rust released only
  // on the switchDeck command, Node released inside switchDeck itself. The
  // harness had never sent a `midi` command at all, which is why it went unseen.
  {
    const before = structuredClone(await currentProject(node));
    const withDeckStep = structuredClone(before);
    withDeckStep.midi = [
      ...(withDeckStep.midi ?? []),
      { id: 'm-decknext', type: 'note', channel: 0, number: 94, action: { kind: 'deckNext' } },
    ];
    both({ type: 'updateProject', project: withDeckStep });
    await sleep(300);

    both({ type: 'trigger', layerId: 'layer-strobe', col: 1 }); // hold the blinder
    await sleep(300);
    const heldN = (node.dmx['u1'] ?? []).some((v) => v > 0);
    check('deck step: blinder is held first', heldN);

    both({ type: 'midi', status: 0x90, d1: 94, d2: 127 }); // bank arrow, still held
    await settle(node, rust);
    compareDmx('deck step while holding a flash: parity', node, rust);

    // Assert here, with the pad still DOWN and no release sent. The deck step
    // itself must have dropped the hold. Checking after a release instead would
    // pass either way, because the same look sits at that cell on both decks —
    // the assertion has to be about the hold, not about the bytes.
    const held = (c: Client) =>
      (c.snap?.layers ?? []).some(
        (l) => l.id === 'layer-strobe' && l.col !== null && l.col !== undefined,
      );
    check(
      'deck step released the held flash (no latched blinder)',
      !held(node) && !held(rust),
      `still held — node=${JSON.stringify(node.snap?.layers)} rust=${JSON.stringify(rust.snap?.layers)}`,
    );
    compareDmx('deck step: released parity', node, rust);
    both({ type: 'release', layerId: 'layer-strobe', col: 1 }); // the late note-off
    await settle(node, rust);

    // Put the show back: this block moved to another deck, and everything after
    // it assumes the original page.
    both({ type: 'updateProject', project: before });
    await settle(node, rust);
  }

  // --- the audition must resolve identically in both engines ----------------
  // A preview that disagrees with what fires is worse than no preview: you would
  // only find out on stage. Pick a look with no effects so the comparison is of
  // a settled frame rather than two samples of a moving one.
  {
    const p = await currentProject(node);
    const staticLook = Object.entries(p.looks).find(
      ([, l]) => (l.parts ?? []).every((pt) => (pt.effects ?? []).length === 0),
    )?.[0];
    if (!staticLook) {
      console.log('  --   no effect-free look in the fixture; preview parity skipped');
    } else {
      const dmxBefore = JSON.stringify(node.dmx);
      both({ type: 'previewLook', lookId: staticLook });
      await sleep(500);
      const pn = JSON.stringify(node.previewHeads ?? null);
      const pr = JSON.stringify(rust.previewHeads ?? null);
      check('preview: engine resolved the look', pn !== 'null' && pn !== '[]', `node=${pn.slice(0, 90)}`);
      check('preview: parity', pn === pr, `node=${pn.slice(0, 140)}\nrust=${pr.slice(0, 140)}`);
      // the whole point: auditioning must not reach the rig
      check(
        'preview does not change live DMX',
        JSON.stringify(node.dmx) === dmxBefore,
        'auditioning a look altered live output',
      );
      compareDmx('preview: live output parity while auditioning', node, rust);

      both({ type: 'previewLook', lookId: null });
      await sleep(400);
      check(
        'preview: cleared on deselect',
        !node.previewHeads && !rust.previewHeads,
        `node=${JSON.stringify(node.previewHeads)?.slice(0, 60)}`,
      );
    }
  }

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
  compareDmx('imported GDTF fixture (wasm vs native)', node, rust);
  const spot = node.dmx['u1']?.slice(199, 210);
  check(
    'imported fixture bytes correct',
    JSON.stringify(spot) === JSON.stringify([128, 0, 255, 255, 255, 8, 255, 0, 0, 128, 23]),
    `got ${JSON.stringify(spot)}`
  );

  // --- per-fixture base aim (focus): a look's pan/tilt is a DELTA on top ---
  {
    const withBase = (p: Project, pan: number | undefined, tilt: number | undefined) => {
      const f = p.fixtures.find((x) => x.id === 'spot1')!;
      f.pan = pan;
      f.tilt = tilt;
      return p;
    };
    // base 0.5 must be arithmetically identical to no base at all
    both({ type: 'updateProject', project: withBase(structuredClone(await currentProject(node)), 0.5, 0.5) });
    await sleep(400);
    const same = node.dmx['u1']?.slice(199, 210);
    check(
      'focus: base 0.5 leaves output unchanged',
      JSON.stringify(same) === JSON.stringify([128, 0, 255, 255, 255, 8, 255, 0, 0, 128, 23]),
      `got ${JSON.stringify(same)}`,
    );
    compareDmx('focus: base 0.5 parity', node, rust);

    // pan base 0.25 with the look at centre (0.5) -> resolved 0.25
    // tilt base 0.25 with the look at 1.0        -> resolved 0.75 (clamped delta)
    both({ type: 'updateProject', project: withBase(structuredClone(await currentProject(node)), 0.25, 0.25) });
    await sleep(400);
    compareDmx('focus: offset parity', node, rust);
    const aimed = node.dmx['u1'] ?? [];
    const near = (got: number, want: number) => Math.abs(got - want) <= 1;
    check(
      'focus: pan base shifts pan (0.5 -> 0.25)',
      near(aimed[199], 63),
      `pan coarse ${aimed[199]} (expected ~63)`,
    );
    check(
      'focus: look tilt applies as a delta from centre (1.0 -> 0.75)',
      near(aimed[201], 191),
      `tilt coarse ${aimed[201]} (expected ~191)`,
    );

    // back to unset for the scenarios that follow
    both({ type: 'updateProject', project: withBase(structuredClone(await currentProject(node)), undefined, undefined) });
    await sleep(400);
    compareDmx('focus: cleared parity', node, rust);
  }

  // --- pan/tilt calibration (backlog #5). The look aims pan centre, tilt full,
  // --- so every case below is read off the tilt delta of +0.5 and the pan
  // --- delta of 0. shared/aim.ts and core/src/aim.rs must agree to the bit.
  {
    const withCal = (p: Project, cal: unknown) => {
      const f = p.fixtures.find((x) => x.id === 'spot1')!;
      if (cal === undefined) delete f.cal;
      else f.cal = cal as NonNullable<Project['fixtures'][number]['cal']>;
      return p;
    };
    const aim = () => {
      const u = node.dmx['u1'] ?? [];
      return [u[199], u[200], u[201], u[202]];
    };
    const set = async (cal: unknown) => {
      both({ type: 'updateProject', project: withCal(structuredClone(await currentProject(node)), cal) });
      await sleep(400);
    };

    await set({ invertTilt: true });
    compareDmx('cal: inverted tilt parity', node, rust);
    check(
      'cal: inverting tilt mirrors the look delta about the focus',
      JSON.stringify(aim()) === JSON.stringify([128, 0, 0, 0]),
      `got ${JSON.stringify(aim())} (expected pan centre, tilt bottom)`,
    );

    await set({ swap: true });
    compareDmx('cal: swapped parity', node, rust);
    check(
      'cal: swap sends the look tilt to the pan channel and back',
      JSON.stringify(aim()) === JSON.stringify([255, 255, 128, 0]),
      `got ${JSON.stringify(aim())}`,
    );

    await set({ tiltMax: 0.75 });
    compareDmx('cal: soft limit parity', node, rust);
    check(
      'cal: a soft limit holds the head whatever the look asks for',
      aim()[2] === 191 && aim()[3] === 255,
      `got ${JSON.stringify(aim())} (expected tilt clamped to 75% = 191,255)`,
    );

    // A block that corrects nothing must RENDER as no calibration at all in
    // both engines. Whether each one also rewrites the stored shape is a
    // different question and not one parity can ask here: an updateProject
    // echo is deliberately withheld from the client that sent it, so this
    // harness would be reading back its own submission rather than the
    // engine's repair. Each sanitizer is pinned in its own suite instead
    // (engine/test/smoke.ts, core/src/types.rs).
    await set({ invertPan: false });
    compareDmx('cal: a calibration that corrects nothing changes no byte', node, rust);
    check(
      'cal: and leaves the head exactly where the look put it',
      JSON.stringify(aim()) === JSON.stringify([128, 0, 255, 255]),
      `got ${JSON.stringify(aim())}`,
    );

    await set(undefined);
    compareDmx('cal: cleared parity', node, rust);
    check(
      'cal: clearing it returns the head to the uncalibrated bytes',
      JSON.stringify(aim()) === JSON.stringify([128, 0, 255, 255]),
      `got ${JSON.stringify(aim())}`,
    );
  }

  // --- beam parameters: a look that never mentions zoom must leave the zoom
  // --- channel exactly where the fixture's own GDTF parks it. The golden bytes
  // --- above already pin that (offset 10 = 128); this drives it and back.
  {
    const setZoom = (p: Project, zoom: number | undefined) => {
      const part = p.looks['look-spot'].parts[0];
      if (zoom === undefined) delete part.params.zoom;
      else part.params.zoom = zoom;
      return p;
    };

    both({ type: 'updateProject', project: setZoom(structuredClone(await currentProject(node)), 1) });
    await sleep(400);
    compareDmx('zoom: driven parity', node, rust);
    check(
      'zoom: a look driving zoom to 1 opens the channel fully',
      node.dmx['u1']?.[208] === 255,
      `zoom byte ${node.dmx['u1']?.[208]} (expected 255)`,
    );

    both({ type: 'updateProject', project: setZoom(structuredClone(await currentProject(node)), 0.25) });
    await sleep(400);
    compareDmx('zoom: quarter parity', node, rust);
    check(
      'zoom: 0.25 lands a quarter up the channel',
      Math.abs((node.dmx['u1']?.[208] ?? -1) - 64) <= 1,
      `zoom byte ${node.dmx['u1']?.[208]} (expected ~64)`,
    );

    // The previz reads zoom off the snapshot to widen its cone, so the two
    // engines must agree on that too — it is the only head field that is
    // present-or-absent rather than always numeric.
    const zmOf = (c: Client) =>
      JSON.stringify((c.snap?.heads ?? []).map((h) => (h as { zm?: number }).zm ?? null));
    check(
      'zoom: snapshot zm parity while driven',
      zmOf(node) === zmOf(rust),
      `node=${zmOf(node).slice(0, 80)} rust=${zmOf(rust).slice(0, 80)}`,
    );
    check(
      'zoom: a driven head reports zm on the wire',
      (node.snap?.heads ?? []).some((h) => (h as { zm?: number }).zm !== undefined),
      'no head carried zm — the previz cannot show zoom',
    );

    // and releasing it returns the channel to the fixture's parked value,
    // rather than to zero — the whole reason these params are optional
    both({ type: 'updateProject', project: setZoom(structuredClone(await currentProject(node)), undefined) });
    await sleep(400);
    compareDmx('zoom: released parity', node, rust);
    check(
      'zoom: released heads report no zm (previz falls back to the profile angle)',
      (node.snap?.heads ?? []).every((h) => (h as { zm?: number }).zm === undefined) &&
        (rust.snap?.heads ?? []).every((h) => (h as { zm?: number }).zm === undefined),
      'zm lingered after release',
    );
    check(
      'zoom: releasing it parks the channel again, it does not fall to 0',
      node.dmx['u1']?.[208] === 128,
      `zoom byte ${node.dmx['u1']?.[208]} (expected 128, the GDTF default)`,
    );
  }

  // --- optics: gobo and prism wheels, their rotation, and shutter patterns.
  // --- Slots snap, rotations crossfade, an unset one parks — in both engines,
  // --- byte for byte. Node renders through the WASM interpreter, Rust natively.
  {
    const optics = fs.readFileSync(path.join(ROOT, 'core', 'tests', 'data', 'synthetic-optics.gdtf'));
    both({ type: 'importGdtf', name: 'synthetic-optics.gdtf', data: optics.toString('base64') });
    await sleep(500);
    const opticsId = 'gdtf-acme-testspot-200-standard';
    const pN = structuredClone(await currentProject(node));
    const pR = structuredClone(await currentProject(rust));
    check('optics: import landed in both engines', !!pN.profiles?.[opticsId] && !!pR.profiles?.[opticsId]);
    check(
      'optics: the importer stamps its version, the same on both engines',
      pN.profiles?.[opticsId]?.compiler === COMPILER_VERSION && pR.profiles?.[opticsId]?.compiler === COMPILER_VERSION,
      `node=${pN.profiles?.[opticsId]?.compiler} rust=${pR.profiles?.[opticsId]?.compiler}`,
    );
    type SlotCase = { func?: { kind?: string; sets?: { name: string }[] } };
    const gobos = (pN.profiles?.[opticsId]?.channels.find((c) => c.name === 'Gobo1')?.cases as SlotCase[] | undefined)
      ?.find((k) => k.func?.kind === 'slot')?.func?.sets?.map((s) => s.name);
    check(
      'optics: gobo slots read off the wheel, the nameless set named from its wheel slot',
      JSON.stringify(gobos) === JSON.stringify(['Open', 'Breakup', 'Stars', 'Dots']),
      `got ${JSON.stringify(gobos)}`,
    );

    // a pad of its own on the wash layer, so the spot look above is untouched
    const col = Math.max(1, pN.layers[0].cells.findIndex((c, i) => i > 0 && c === null));
    const patchOptics = (p: Project) => {
      p.fixtures.push({
        id: 'opt1', name: 'Optics', profileId: opticsId, universeId: 'u1', address: 400,
        pos: { x: 1, y: 3, z: 0 }, rotY: 0,
      });
      p.groups.push({ id: 'g-opt', name: 'Optics', heads: [{ fixtureId: 'opt1', head: 0 }] });
      p.looks['look-opt'] = {
        id: 'look-opt', name: 'Optics test',
        parts: [{ id: 'p-opt', groupId: 'g-opt', params: { dimmer: 1, pan: 0.5, tilt: 0.5 }, effects: [] }],
      };
      while (p.layers[0].cells.length <= col) p.layers[0].cells.push(null);
      p.layers[0].cells[col] = 'look-opt';
      return p;
    };
    node.send({ type: 'updateProject', project: patchOptics(pN) });
    rust.send({ type: 'updateProject', project: patchOptics(pR) });
    await sleep(300);
    both({ type: 'trigger', layerId: 'layer-wash', col });
    await sleep(1400);
    const bytes = () => node.dmx['u1']?.slice(399, 407);
    compareDmx('optics: parked parity', node, rust);
    check(
      'optics: nothing asked → every wheel rests where the file parks it (shutter open per InitialFunction, prism rotate at stop)',
      JSON.stringify(bytes()) === JSON.stringify([128, 128, 255, 12, 0, 0, 0, 128]),
      `got ${JSON.stringify(bytes())}`,
    );

    const setOptics = async (params: Record<string, unknown>) => {
      const p = structuredClone(await currentProject(node));
      p.looks['look-opt'].parts[0].params = { dimmer: 1, pan: 0.5, tilt: 0.5, ...params } as unknown as PartParams;
      both({ type: 'updateProject', project: p });
      await sleep(400);
    };
    await setOptics({ gobo: 2, goboRotate: 0.5, prism: 1, prismRotate: 0.25, strobe: 0.5, strobeMode: 'pulse' });
    compareDmx('optics: driven parity', node, rust);
    check(
      'optics: slot 2 = its band midpoint, rotations sweep the rotate bands, pulse strobes in the pulse band',
      JSON.stringify(bytes()) === JSON.stringify([128, 128, 255, 164, 24, 192, 95, 64]),
      `got ${JSON.stringify(bytes())}`,
    );
    // The flower channel is the ninth: parked off until asked, then the fader
    // sweeps 1..255 with its middle on the still point. Both engines render it
    // through the same compiled profile, and this is the checkpoint that says so.
    const flowerByte = () => node.dmx['u1']?.[407]; // address 400 + channel 9, zero-based
    check('optics: flower rests off until a look asks', flowerByte() === 0, `got ${flowerByte()}`);
    await setOptics({ flower: 0.5 });
    compareDmx('optics: flower still-point parity', node, rust);
    check('optics: flower at the middle is exactly the still point', flowerByte() === 128, `got ${flowerByte()}`);
    await setOptics({ flower: 1 });
    compareDmx('optics: flower full-speed parity', node, rust);
    check('optics: flower at the end is full speed', flowerByte() === 255, `got ${flowerByte()}`);
    await setOptics({ strobe: 0.5, strobeMode: 'random', gobo: 9 });
    compareDmx('optics: random pattern + clamped slot parity', node, rust);
    check(
      'optics: random strobes in its own band; a slot past the wheel clamps to the last',
      bytes()?.[3] === 228 && bytes()?.[4] === 34,
      `got ${JSON.stringify(bytes())}`,
    );
    await setOptics({ strobe: 0.5, strobeMode: 'bogus', gobo: 1.4 });
    compareDmx('optics: unknown pattern + fractional slot parity', node, rust);
    check(
      'optics: an unknown pattern strobes plain and a fractional slot rounds, in both engines',
      bytes()?.[3] === 72 && bytes()?.[4] === 14,
      `got ${JSON.stringify(bytes())}`,
    );
    await setOptics({});
    compareDmx('optics: released parity', node, rust);
    check(
      'optics: releasing parks every wheel again, it does not fall to 0',
      JSON.stringify(bytes()) === JSON.stringify([128, 128, 255, 12, 0, 0, 0, 128]),
      `got ${JSON.stringify(bytes())}`,
    );
  }

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
        // 4/2/2 beats rather than 2/1/1, and the reason is the harness, not the
        // engine. At 120 BPM the old shape gave steps 2 and 3 a width of 500 ms,
        // so the widest possible margin to a boundary was 250 ms — and the
        // checkpoints were reached by CUMULATIVE sleeps, so an overshoot in one
        // wait pushed every later one closer to a boundary. Under CI load that
        // landed the two engines on opposite sides of a step change and the
        // comparison reported a colour swap: a harness flake dressed up as a
        // parity failure. Doubling the beats doubles every margin to 500 ms and
        // leaves the tempo alone, so nothing downstream shifts.
        steps: [
          { lookId: stepIds[0], beats: 4 },
          { lookId: stepIds[1], beats: 2 },
          { lookId: stepIds[2], beats: 2 },
        ],
      };
      wash.cells[7] = 'look-cue-test';
      both({ type: 'updateProject', project: p });
      await sleep(300);
      both({ type: 'setBpm', bpm: 120 }); // 500 ms/beat; also aligns phase
      await sleep(200);
      const cueAt = Date.now();
      both({ type: 'trigger', layerId: 'layer-wash', col: 7 });
      // Absolute deadlines from the trigger, never a chain of sleeps: a late
      // wakeup then costs that one checkpoint its slack instead of spending
      // everyone else's too.
      const atCue = async (ms: number) => {
        const wait = cueAt + ms - Date.now();
        if (wait > 0) await sleep(wait);
      };
      // steps of 4/2/2 beats → boundaries at 2000/3000/4000 ms after the
      // trigger, and it loops. Every checkpoint sits dead centre of its step.
      await atCue(1000);
      compareDmx('cue list: step 1 parity', node, rust);
      await atCue(2500);
      compareDmx('cue list: step 2 parity', node, rust);
      await atCue(3500);
      compareDmx('cue list: step 3 parity', node, rust);
      await atCue(5000);
      compareDmx('cue list: loop back to step 1 parity', node, rust);
      // tap while the cue runs: alignPhase must shift anchors so both
      // engines stay in the same step (regression: permanent desync)
      both({ type: 'tap' });
      await sleep(900);
      compareDmx('cue list: step parity after tap/align', node, rust);

      // cue-to-cue crossfade: firing a second chaser must not corrupt the
      // first one's anchor (regression: outgoing cue snapped to step 1)
      p.looks['look-cue-test-b'] = {
        id: 'look-cue-test-b',
        name: 'Cue Test B',
        parts: [],
        // 2 beats a step for the same reason as above: 1000 ms wide, so the
        // checkpoint below clears the 0.8 s fade AND sits 500 ms from either
        // boundary. At 1 beat neither of those was true at once.
        steps: [
          { lookId: stepIds[2], beats: 2 },
          { lookId: stepIds[0], beats: 2 },
        ],
      };
      const wash2 = p.layers.find((l) => l.id === 'layer-wash');
      if (wash2) wash2.cells[6] = 'look-cue-test-b';
      both({ type: 'updateProject', project: p });
      await sleep(300);
      const bAt = Date.now();
      both({ type: 'trigger', layerId: 'layer-wash', col: 6 });
      // B's boundaries are at 1000/2000 ms; 1500 is mid-step-2 and 700 ms clear
      // of the fade.
      const wait = bAt + 1500 - Date.now();
      if (wait > 0) await sleep(wait);
      compareDmx('cue list: cue-to-cue crossfade parity', node, rust);

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
      compareDmx('cue list: prototype-key step renders dark in both', node, rust);
      const nodeAlive = (node.snap?.now ?? 0);
      await sleep(400);
      check(
        'node engine still ticking after poisoned cue',
        (node.snap?.now ?? 0) > nodeAlive,
        'snapshot clock stopped'
      );

      both({ type: 'clearLayer', layerId: 'layer-wash' });
      await sleep(1200); // > 0.8 s fade — mid-fade bytes are skew-sensitive
      compareDmx('cue list: released parity', node, rust);
    } else {
      check('cue list scenario prerequisites', false, 'wash layer content missing');
    }
  }

  // --- gig tools: mute / identify / all-stop must be byte-identical ---
  {
    both({ type: 'column', col: 0 });
    await sleep(1200);
    compareDmx('gig tools: baseline cue parity', node, rust);

    both({ type: 'setFixtureMute', fixtureId: 'bar1', on: true });
    await sleep(600);
    compareDmx('mute: silenced fixture parity', node, rust);
    // a muted fixture's whole span must be zero — not merely "dimmer 0", which
    // trusts a fixture that is by definition misbehaving
    const bar1Span = (node.dmx['u1'] ?? []).slice(20, 40);
    check('mute: bar1 whole channel span is zero', bar1Span.every((v) => v === 0),
      `still emitting: ${bar1Span.map((v, i) => (v ? `${i + 21}:${v}` : '')).filter(Boolean).join(' ')}`);

    both({ type: 'identify', fixtureId: 'derby1' });
    await sleep(600);
    compareDmx('identify: full-white override parity', node, rust);

    // identify must beat blackout — that is the point at load-in
    both({ type: 'setBlackout', v: true });
    await sleep(600);
    compareDmx('identify: survives blackout parity', node, rust);
    const derbyLit = (node.dmx['u1'] ?? [])[0] > 0;
    check('identify: derby1 still lit under blackout', derbyLit, 'identify lost to blackout');

    both({ type: 'identify', fixtureId: null });
    both({ type: 'setFixtureMute', fixtureId: 'bar1', on: false });
    both({ type: 'setBlackout', v: false });
    await sleep(600);
    compareDmx('gig tools: cleared parity', node, rust);

    // raw channel override is the last word in the buffer
    both({ type: 'setChannel', universeId: 'u1', channel: 5, value: 200 });
    await sleep(600);
    compareDmx('channel override parity', node, rust);
    check(
      'channel override reaches the wire',
      (node.dmx['u1'] ?? [])[4] === 200,
      `ch5 = ${(node.dmx['u1'] ?? [])[4]}`
    );

    // all-stop: dark, quiet, and no overrides left behind
    both({ type: 'allStop' });
    await settle(node, rust);
    compareDmx('all-stop parity', node, rust);
    // all-stop is about the room going dark and QUIET: every dimmer at zero,
    // the hazer and its fan stopped, derby motors stopped. (Colour channels
    // may still hold their last value behind a zero dimmer — harmless.)
    const dmx = node.dmx['u1'] ?? [];
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

  // --- pinned-clock effect parity: the FIRST byte comparison of moving effects.
  // Both engines integrate effBeat from their own first tick, and settle() can
  // never converge on a running effect, so until now none of the demo project's
  // effect looks was ever byte-compared. _pinClock (LIGHT_TEST_CLOCK gated)
  // freezes effBeat identically on both, turning every wave into a static frame.
  {
    // pin BEFORE firing, so the effect starts frozen while only the crossfade
    // (wall-time) moves — settle() then converges once the fade completes.
    both({ type: '_pinClock', effBeat: 0 });
    both({ type: 'trigger', layerId: 'layer-wash', col: 6 }); // wash-rainbow: hue sawUp
    both({ type: 'trigger', layerId: 'layer-fx', col: 2 });   // fx-chase: dimmer chase
    await settle(node, rust);
    compareDmx('pinned beat 0.00 (chase + rainbow)', node, rust);

    // step the frozen beat and re-compare — the effect value jumps each pin,
    // then holds, so settle converges and the bytes must match at every phase
    for (const beat of [0.125, 0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 3.33]) {
      both({ type: '_pinClock', effBeat: beat });
      await settle(node, rust);
      compareDmx(`pinned beat ${beat.toFixed(3)} (chase + rainbow)`, node, rust);
    }

    // the strongest case: a RANDOM wave is byte-comparable only because its
    // hash is a deterministic function of the (now pinned) beat + head index
    both({ type: '_pinClock', effBeat: 0 });
    both({ type: 'trigger', layerId: 'layer-fx', col: 5 }); // fx-flicker: dimmer random
    await settle(node, rust);
    for (const beat of [0, 0.5, 1.0, 2.5, 7.0]) {
      both({ type: '_pinClock', effBeat: beat });
      await settle(node, rust);
      compareDmx(`pinned beat ${beat.toFixed(3)} (random flicker)`, node, rust);
    }

    // the sine wave is the ONLY one calling cos(), and JS (V8 fdlibm) vs Rust
    // (libm) cos are not guaranteed bit-identical — this is the case that would
    // surface such a divergence. Non-round beats push the argument off the easy
    // exact points.
    both({ type: '_pinClock', effBeat: 0 });
    both({ type: 'trigger', layerId: 'layer-fx', col: 3 }); // fx-swell: dimmer sine
    await settle(node, rust);
    for (const beat of [0.137, 1.618, 2.718, 5.0, 11.11]) {
      both({ type: '_pinClock', effBeat: beat });
      await settle(node, rust);
      compareDmx(`pinned beat ${beat.toFixed(3)} (sine swell — cos path)`, node, rust);
    }

    // hand back a clean slate for the scenarios below
    both({ type: 'allStop' });
    both({ type: 'setBlackout', v: false });
    await settle(node, rust);
  }

  // --- P4 phase-continuous rate: editing an effect's rate on a LIVE look must
  // not jump its waveform (the old code set phase = beat/rate, which snapped),
  // and both engines must apply the identical correction.
  //
  // wash-rainbow (hue sawUp, rate 16, over a lit red part) is used because its
  // value reaches the RGB bytes — so "frame unchanged" is a real assertion, not
  // a comparison of two dark frames. The clock is pinned, so the write must be
  // given time to land (settle would return the frozen pre-write frame).
  {
    await armWash('wash-rainbow', 4);
    compareDmx('rate-cont: baseline (rate 16) parity', node, rust);
    const baseline = frameOf(node);

    const setRate = async (rate: number): Promise<void> => {
      const p = structuredClone(await currentProject(node));
      p.looks['wash-rainbow'].parts[0].effects[0].rate = rate;
      both({ type: 'updateProject', project: p });
      await sleep(400);
    };

    // 16 -> 8 at beat 4: corr = 4*(1/16 - 1/8) = -0.25, so phase = 4/8 - 0.25
    // = 0.25, exactly where it was — every head's hue is unchanged.
    await setRate(8);
    check(
      'rate-cont: frame unchanged after 16->8 (no phase jump)',
      frameOf(node) === baseline,
      'the rate edit moved the waveform — phase was not corrected',
    );
    compareDmx('rate-cont: rate 16->8 parity', node, rust);

    // 8 -> 4: the correction must COMPOSE. corr += 4*(1/8 - 1/4) = -0.5 ->
    // -0.75, phase = 4/4 - 0.75 = 0.25 — still unchanged.
    await setRate(4);
    check(
      'rate-cont: frame unchanged after 8->4 (correction accumulates)',
      frameOf(node) === baseline,
      'a second rate edit moved the waveform — correction did not accumulate',
    );
    compareDmx('rate-cont: rate 8->4 parity', node, rust);

    both({ type: 'allStop' });
    both({ type: 'setBlackout', v: false });
    await settle(node, rust);
  }

  // --- A2: per-effect bypass + wet/dry mix. The defaults (bypass off, mix 1)
  // render byte-identically to pre-A2 — every test above already proves that.
  // Here we exercise the blend and the park and prove both engines agree.
  //
  // wash-rainbow is the look to test on: hue sawUp over a LIT part (dimmer 1,
  // saturated red base), so the effect's value actually reaches the RGB bytes.
  // (fx-swell drives dimmer on a colourless part — nothing to scale, so
  // mix/bypass would be invisible there.)
  {
    // beat 4, rate 16 -> phase 0.25 -> hue rotates 90°; a partial mix lands the
    // base red somewhere short of that, a bypass leaves it at the base hue.
    await armWash('wash-rainbow', 4);
    const wet = frameOf(node);
    compareDmx('fx mix/bypass: full-wet baseline parity', node, rust);

    // the clock is pinned so nothing moves; a fixed sleep lets the write land
    // (settle() would return the still-frozen pre-write frame as "stable").
    const setRainbowFx = async (patch: Partial<Effect>): Promise<void> => {
      const p = structuredClone(await currentProject(node));
      Object.assign(p.looks['wash-rainbow'].parts[0].effects[0], patch);
      both({ type: 'updateProject', project: p });
      await sleep(400);
    };

    // half wet eases the hue back toward the dry base; identical on both.
    await setRainbowFx({ mix: 0.5 });
    compareDmx('fx mix/bypass: mix 0.5 parity', node, rust);
    check(
      'fx mix/bypass: mix 0.5 moves the frame off full-wet',
      frameOf(node) !== wet,
      'mix 0.5 produced the same bytes as full wet',
    );

    // park: the effect contributes nothing, so the part shows its base hue.
    await setRainbowFx({ mix: 1, bypass: true });
    const dry = frameOf(node);
    compareDmx('fx mix/bypass: bypassed parity', node, rust);
    check(
      'fx mix/bypass: bypass differs from full-wet',
      dry !== wet,
      'a bypassed effect still changed the output',
    );

    // mix 0 is the same fully-dry state as bypass, reached the other way.
    await setRainbowFx({ bypass: false, mix: 0 });
    compareDmx('fx mix/bypass: mix 0 parity', node, rust);
    check(
      'fx mix/bypass: mix 0 equals bypass (both fully dry)',
      frameOf(node) === dry,
      'mix 0 and bypass produced different frames',
    );

    both({ type: 'allStop' });
    both({ type: 'setBlackout', v: false });
    await settle(node, rust);
  }

  // --- A1 spatial fan: the fan fields must produce byte-identical output on
  // both engines. The demo's wash-rainbow (hue sawUp over g-pars' 8 heads,
  // spread across two bars in x) gives the spatial bases real geometry to
  // sweep; the pinned clock makes every config a static frame.
  {
    await armWash('wash-rainbow', 1.35); // non-round beat: phase off easy points

    const setFan = async (patch: Partial<Effect>): Promise<void> => {
      const p = structuredClone(await currentProject(node));
      // reset EVERYTHING a previous scenario may have left on this effect —
      // the A2 block above parks it at mix 0, and a matrix running against a
      // parked effect compares dry frames against dry frames and proves
      // nothing (the P4 lesson, again). Then apply the case.
      Object.assign(p.looks['wash-rainbow'].parts[0].effects[0], {
        bypass: false, mix: 1,
        distribute: 'index', fold: 'none', reverse: false, parts: 1, buddy: 1, seed: 0,
        ...patch,
      });
      both({ type: 'updateProject', project: p });
      await sleep(400);
    };

    await setFan({}); // normalized legacy state
    const legacy = frameOf(node);
    compareDmx('fan: legacy baseline parity', node, rust);

    const cases: [string, Partial<Effect>][] = [
      ['x', { distribute: 'x' }],
      ['x+mirror', { distribute: 'x', fold: 'mirror' }],
      ['x+centre', { distribute: 'x', fold: 'centre' }],
      ['x+reverse', { distribute: 'x', reverse: true }],
      ['radial', { distribute: 'radial' }],
      ['radial+mirror', { distribute: 'radial', fold: 'mirror' }],
      ['shuffle seed 7', { distribute: 'shuffle', seed: 7 }],
      ['index+parts2+buddy2', { parts: 2, buddy: 2 }],
      ['x+mirror+parts2+reverse', { distribute: 'x', fold: 'mirror', parts: 2, reverse: true }],
      // B1: col fans within each fixture (both demo bars run the same wave);
      // row is degenerate on flat bars (single row) — the uniform path
      ['col (per-fixture)', { distribute: 'col' }],
      ['row (degenerate on flat bars)', { distribute: 'row' }],
    ];
    for (const [name, patch] of cases) {
      await setFan(patch);
      compareDmx(`fan: ${name} parity`, node, rust);
      both({ type: '_pinClock', effBeat: 3.7 });
      await sleep(300);
      compareDmx(`fan: ${name} parity at beat 3.7`, node, rust);
      both({ type: '_pinClock', effBeat: 1.35 });
      await sleep(300);
    }

    // Degenerate basis: every g-pars head shares z = 0, so a z-fan collapses
    // to uniform phase. Compared for parity AND captured — it is exactly the
    // frame a broken extents wiring would produce for EVERY spatial basis.
    await setFan({ distribute: 'z' });
    compareDmx('fan: degenerate z parity (uniform phase)', node, rust);
    const uniform = frameOf(node);

    // the spatial fan genuinely moves the frame — different from the legacy
    // patch-order fan AND from the uniform frame, so a broken extents lookup
    // (which would collapse x to uniform) cannot satisfy this
    await setFan({ distribute: 'x' });
    const xFrame = frameOf(node);
    check(
      'fan: x-distribute produces different bytes than the legacy fan',
      xFrame !== legacy,
      'spatial fan rendered identically to patch-order fan',
    );
    check(
      'fan: x-distribute differs from the degenerate uniform frame',
      xFrame !== uniform,
      'x-fan collapsed to uniform phase — extents wiring broken?',
    );

    // End-to-end y and z with REAL variation: raise and pull one bar so both
    // axes genuinely order the heads (the unit twins cover the maths; this
    // proves the geometry → extents → fan path through both live engines).
    {
      const p = structuredClone(await currentProject(node));
      const bar2 = p.fixtures.find((f) => f.id === 'bar2');
      if (bar2) {
        bar2.pos = { x: bar2.pos.x, y: 4.5, z: 1.5 };
      }
      both({ type: 'updateProject', project: p });
      await sleep(400);
    }
    await setFan({ distribute: 'y' });
    compareDmx('fan: y parity (raised bar)', node, rust);
    const yFrame = frameOf(node);
    check('fan: y-distribute moves the frame once y varies', yFrame !== uniform, 'y-fan stayed uniform');
    await setFan({ distribute: 'z' });
    compareDmx('fan: z parity (pulled bar)', node, rust);
    check('fan: z-distribute moves the frame once z varies', frameOf(node) !== uniform, 'z-fan stayed uniform');

    both({ type: 'allStop' });
    both({ type: 'setBlackout', v: false });
    await settle(node, rust);
  }

  // --- P1 soft overrides: a ride must move DMX identically on both engines
  // WITHOUT a project write; Store must land the identical stored show; and
  // Discard/ALL STOP must drop rides byte-cleanly.
  {
    await armWash('wash-rainbow', 1.35);
    const setFan = async (): Promise<void> => {
      const p = structuredClone(await currentProject(node));
      Object.assign(p.looks['wash-rainbow'].parts[0].effects[0], {
        bypass: false, mix: 1,
        distribute: 'index', fold: 'none', reverse: false, parts: 1, buddy: 1, seed: 0,
      });
      both({ type: 'updateProject', project: p });
      await sleep(400);
    };
    await setFan(); // normalize whatever earlier scenarios left on fx18
    const stored = frameOf(node);
    compareDmx('soft: stored baseline parity', node, rust);

    const partId = (await currentProject(node)).looks['wash-rainbow'].parts[0].id;

    // ride the part's saturation down — a ~40-byte command, no gen bump
    const genBefore = nodeObs.gen;
    both({ type: 'soft', lookId: 'wash-rainbow', partId, field: 'sat', value: 0.25 });
    await sleep(400);
    compareDmx('soft: sat ride parity', node, rust);
    const ridden = frameOf(node);
    check('soft: the ride moves DMX', ridden !== stored, 'sat ride changed nothing');
    check('soft: a ride is NOT a project write', nodeObs.gen === genBefore, `gen moved ${genBefore} -> ${nodeObs.gen}`);

    // ride an effect field too (the rainbow's rate) — phase-continuity holds
    // (P4 reads the EFFECTIVE effects), and both engines agree
    const effectId = (await currentProject(node)).looks['wash-rainbow'].parts[0].effects[0].id;
    both({ type: 'soft', lookId: 'wash-rainbow', partId, effectId, field: 'rate', value: 4 });
    await sleep(400);
    compareDmx('soft: effect-rate ride parity', node, rust);

    // Discard: byte-identical return to the stored show
    both({ type: 'softClear' });
    await sleep(400);
    compareDmx('soft: discard parity', node, rust);
    check('soft: discard restores the stored bytes', frameOf(node) === stored, 'discard did not restore');

    // ride again, then Store: one gen bump, stored looks updated identically
    both({ type: 'soft', lookId: 'wash-rainbow', partId, field: 'sat', value: 0.25 });
    await sleep(300);
    both({ type: 'softCommit' });
    await sleep(400);
    compareDmx('soft: post-commit parity', node, rust);
    check('soft: commit still renders the ridden bytes', frameOf(node) === ridden, 'commit changed the frame');
    const nSat = (await currentProject(nodeObs)).looks['wash-rainbow'].parts[0].params.color?.s;
    const rSat = (await currentProject(rustObs)).looks['wash-rainbow'].parts[0].params.color?.s;
    check('soft: commit stored the same value in both engines', nSat === 0.25 && rSat === 0.25, `node=${nSat} rust=${rSat}`);
    check('soft: commit bumped the generation once', nodeObs.gen !== genBefore, 'no gen bump on commit');

    // ALL STOP drops any ride
    both({ type: 'soft', lookId: 'wash-rainbow', partId, field: 'dimmer', value: 0.1 });
    await sleep(300);
    both({ type: 'allStop' });
    both({ type: 'setBlackout', v: false });
    await settle(node, rust);
    await armWash('wash-rainbow', 1.35);
    compareDmx('soft: post-allStop parity (ride dropped)', node, rust);

    // --- wire-shape equivalence: the Rust engine deserializes with serde
    // (Option fields read null AND absent as None; an unknown field drops the
    // whole frame). The Node engine must behave identically on the same BYTES,
    // or scripted clients drive the two engines apart.
    const raw = (obj: object): void => {
      node.ws.send(JSON.stringify(obj));
      rust.ws.send(JSON.stringify(obj));
    };
    await armWash('wash-rainbow', 1.35);
    const base2 = frameOf(node);
    // effectId: null must mean "part-level ride" on both (serde: None)
    // 0.6, NOT the 0.25 the commit above stored — riding the stored value
    // would leave the frame identical and prove nothing
    raw({ type: 'soft', lookId: 'wash-rainbow', partId, effectId: null, field: 'sat', value: 0.6 });
    await sleep(400);
    compareDmx('soft-wire: effectId null rides the part on both', node, rust);
    check('soft-wire: the null-effectId ride landed', frameOf(node) !== base2, 'node ignored effectId:null');
    // value ABSENT must clear on both (serde: missing Option -> None -> clear)
    raw({ type: 'soft', lookId: 'wash-rainbow', partId, field: 'sat' });
    await sleep(400);
    compareDmx('soft-wire: absent value clears on both', node, rust);
    check('soft-wire: the clear restored stored bytes', frameOf(node) === base2, 'absent-value clear did not restore');
    // an unknown field must be ignored by both — no ride, no phantom commit
    raw({ type: 'soft', lookId: 'wash-rainbow', partId, field: 'lasers', value: 0.5 });
    await sleep(300);
    const genBeforePhantom = nodeObs.gen;
    both({ type: 'softCommit' });
    await sleep(400);
    compareDmx('soft-wire: unknown field ignored on both', node, rust);
    check(
      'soft-wire: no phantom gen bump from an unknown-field commit',
      nodeObs.gen === genBeforePhantom && nodeObs.gen === rustObs.gen,
      `node=${nodeObs.gen} rust=${rustObs.gen} before=${genBeforePhantom}`,
    );

    // --- ids containing spaces: legal in a hand-edited show; the two engines
    // must ride, sweep and commit them identically (the Node store used to
    // re-parse a space-joined key)
    {
      const p = structuredClone(await currentProject(node));
      p.looks['sp aced'] = {
        id: 'sp aced',
        name: 'Spaced',
        parts: [{ id: 'pa rt', groupId: 'g-pars', params: { dimmer: 1, color: { h: 200, s: 1 } }, effects: [] }],
      };
      const wash = p.layers.find((l) => l.id === 'layer-wash');
      if (wash) wash.cells[6] = 'sp aced';
      both({ type: 'updateProject', project: p });
      await sleep(400);
      both({ type: '_pinClock', effBeat: 1.35 });
      both({ type: 'trigger', layerId: 'layer-wash', col: 6 });
      await settle(node, rust);
      both({ type: 'soft', lookId: 'sp aced', partId: 'pa rt', field: 'sat', value: 0.3 });
      await sleep(400);
      compareDmx('soft-ids: spaced-id ride parity', node, rust);
      both({ type: 'softCommit' });
      await sleep(400);
      const nS = (await currentProject(nodeObs)).looks['sp aced']?.parts[0].params.color?.s;
      const rS = (await currentProject(rustObs)).looks['sp aced']?.parts[0].params.color?.s;
      check('soft-ids: spaced-id commit stores identically', nS === 0.3 && rS === 0.3, `node=${nS} rust=${rS}`);
      // clean up: remove the test look, restore the cell
      const q = structuredClone(await currentProject(node));
      delete q.looks['sp aced'];
      const w2 = q.layers.find((l) => l.id === 'layer-wash');
      if (w2) w2.cells[6] = 'wash-rainbow';
      both({ type: 'updateProject', project: q });
      await sleep(300);
    }

    // restore the stored sat for later scenarios
    {
      const p = structuredClone(await currentProject(node));
      const c = p.looks['wash-rainbow'].parts[0].params.color;
      if (c) c.s = 1;
      both({ type: 'updateProject', project: p });
      await sleep(300);
    }
    both({ type: 'allStop' });
    both({ type: 'setBlackout', v: false });
    await settle(node, rust);
  }

  // --- P3 Named Controls: one fader fanning to several soft addresses through
  // per-link brackets, resolved through P1's layer — byte-identical on both
  // engines, including via a MIDI mapping and past a dangling link.
  {
    await armWash('wash-rainbow', 1.35);
    const partId = (await currentProject(node)).looks['wash-rainbow'].parts[0].id;
    const effectId = (await currentProject(node)).looks['wash-rainbow'].parts[0].effects[0].id;
    {
      const p = structuredClone(await currentProject(node));
      Object.assign(p.looks['wash-rainbow'].parts[0].effects[0], {
        bypass: false, mix: 1, distribute: 'index', fold: 'none', reverse: false, parts: 1, buddy: 1, seed: 0,
      });
      p.controls = [{
        id: 'ctl-1',
        name: 'Chorus feel',
        value: 0,
        links: [
          // inverted bracket: v 0..1 maps sat 1 -> 0.2
          { lookId: 'wash-rainbow', partId, field: 'sat', min: 1, max: 0.2 },
          // effect-field link: rate 16 -> 2 as the fader rises
          { lookId: 'wash-rainbow', partId, effectId, field: 'rate', min: 16, max: 2 },
          // dangling link: must be skipped identically, not break the fan
          { lookId: 'no-such-look', partId: 'nope', field: 'dimmer', min: 0, max: 1 },
        ],
      }];
      // and a MIDI mapping driving the control from CC 20 ch1
      p.midi = [...p.midi, { id: 'm-ctl', type: 'cc', channel: 0, number: 20, action: { kind: 'control', controlId: 'ctl-1' } }];
      both({ type: 'updateProject', project: p });
      await sleep(400);
    }
    const stored = frameOf(node);
    compareDmx('controls: baseline parity', node, rust);

    both({ type: 'setControl', controlId: 'ctl-1', value: 0.5 });
    await sleep(400);
    compareDmx('controls: half-fader fan-out parity', node, rust);
    check('controls: the fan-out moves DMX', frameOf(node) !== stored, 'setControl changed nothing');

    both({ type: 'setControl', controlId: 'ctl-1', value: 1 });
    await sleep(400);
    compareDmx('controls: full-fader parity (inverted + effect brackets)', node, rust);

    // the same fan-out via MIDI: CC 20 = 32/127
    both({ type: 'midi', status: 0xb0, d1: 20, d2: 32 });
    await sleep(400);
    compareDmx('controls: MIDI-driven parity', node, rust);

    // discard drops the whole fan; bytes return to stored
    both({ type: 'softClear' });
    await sleep(400);
    compareDmx('controls: discard parity', node, rust);
    check('controls: discard restores stored bytes', frameOf(node) === stored, 'discard did not restore');

    // review regressions:
    // (a) effectId:null in a STORED link ≡ absent (part-level) on BOTH engines
    //     — TS sanitize used to drop the whole link while Rust kept it;
    // (b) a NOTE-mapped control ignores the release on both — the Rust
    //     continuous gate used to slam the fan to 0 on note-off;
    // (c) a 'rate' modulator binding is dropped by both sanitizers.
    {
      const p = structuredClone(await currentProject(node));
      p.controls = [{
        id: 'ctl-null', name: 'NullFx', value: 0,
        links: [
          { lookId: 'wash-rainbow', partId, effectId: null, field: 'sat', min: 1, max: 0.2 } as unknown as ControlLink,
        ],
      }];
      p.midi = [...p.midi.filter((m) => m.id !== 'm-ctl'),
        { id: 'm-note', type: 'note', channel: 0, number: 60, action: { kind: 'control', controlId: 'ctl-null' } }];
      p.modulators = [{ id: 'lfo-r', name: 'R', wave: 'sine', rate: 4, phase: 0, on: true,
        bindings: [{ lookId: 'wash-rainbow', partId, effectId, field: 'rate', depth: 0.5 }] }];
      both({ type: 'updateProject', project: p });
      await sleep(400);
      const nCtl = (await currentProject(nodeObs)).controls?.[0];
      const rCtl = (await currentProject(rustObs)).controls?.[0];
      check(
        'controls-regr: effectId null loads as a part-level link on BOTH',
        nCtl?.links.length === 1 && rCtl?.links.length === 1 &&
          nCtl?.links[0].effectId === undefined && rCtl?.links[0].effectId === undefined,
        `node=${JSON.stringify(nCtl?.links)} rust=${JSON.stringify(rCtl?.links)}`,
      );
      check(
        'controls-regr: a rate modulator binding is dropped by both sanitizers',
        (await currentProject(nodeObs)).modulators?.[0]?.bindings.length === 0 &&
          (await currentProject(rustObs)).modulators?.[0]?.bindings.length === 0,
      );
      // note-on drives the fan; note-off must NOT slam it
      both({ type: 'midi', status: 0x90, d1: 60, d2: 100 });
      await sleep(400);
      compareDmx('controls-regr: note-on fan parity', node, rust);
      const held = frameOf(node);
      both({ type: 'midi', status: 0x80, d1: 60, d2: 0 });
      await sleep(400);
      compareDmx('controls-regr: note-off parity', node, rust);
      check('controls-regr: the release does not slam the control', frameOf(node) === held, 'note-off moved the fan');
      both({ type: 'softClear' });
      await sleep(300);
    }

    // clean up the control + mapping
    {
      const p = structuredClone(await currentProject(node));
      delete p.controls;
      delete p.modulators;
      p.midi = p.midi.filter((m) => m.id !== 'm-ctl' && m.id !== 'm-note');
      both({ type: 'updateProject', project: p });
      await sleep(300);
    }
    both({ type: 'allStop' });
    both({ type: 'setBlackout', v: false });
    await settle(node, rust);
  }

  // --- group submasters (backlog #6). The cases the entry names: one group,
  // --- two overlapping groups, and stacked with a layer master and blackout.
  {
    await armWash('wash-rainbow', 0);
    both({ type: '_pinClock', effBeat: 0 });
    await settle(node, rust);
    const p0 = await currentProject(node);
    const wash = p0.layers.find((l) => l.id === 'layer-wash')!;
    const live = wash.cells[6];
    const groupId = p0.looks[live!].parts[0].groupId;
    const lit = () => (node.snap?.heads ?? []).filter((h) => h.i > 0).length;
    const peak = () => Math.max(0, ...(node.snap?.heads ?? []).map((h) => h.i));

    check('submaster: something is lit to pull down', lit() > 0 && peak() > 0.5, `peak ${peak()}`);
    check(
      'submaster: both engines start with none set',
      (node.snap?.submasters ?? []).length === 0 && (rust.snap?.submasters ?? []).length === 0,
    );
    const full = peak();

    both({ type: 'setSubmaster', groupId, v: 0.5 });
    await settle(node, rust);
    compareDmx('submaster: one group at half parity', node, rust);
    check(
      'submaster: half means half',
      Math.abs(peak() - full * 0.5) < 0.02,
      `peak ${peak()} against ${full}`,
    );
    check(
      'submaster: and both engines report it',
      JSON.stringify(node.snap?.submasters) === JSON.stringify(rust.snap?.submasters),
      `node=${JSON.stringify(node.snap?.submasters)} rust=${JSON.stringify(rust.snap?.submasters)}`,
    );

    // A second group over the same heads. Auto-groups put every head in a
    // per-type group AND a per-truss one, so this is the normal case, not the
    // exotic one: the LOWEST fader wins. Multiplying would give 0.25 here,
    // which is what neither fader says.
    const overlap = structuredClone(await currentProject(node));
    overlap.groups.push({ id: 'g-overlap', name: 'Overlap', heads: [...overlap.groups.find((g) => g.id === groupId)!.heads] });
    both({ type: 'updateProject', project: overlap });
    await sleep(400);
    both({ type: 'setSubmaster', groupId: 'g-overlap', v: 0.8 });
    await settle(node, rust);
    compareDmx('submaster: overlapping groups parity', node, rust);
    check(
      'submaster: the lowest fader wins, it does not multiply',
      Math.abs(peak() - full * 0.5) < 0.02,
      `peak ${peak()} — 0.5 expected, ${full * 0.25} would be the product`,
    );
    both({ type: 'setSubmaster', groupId, v: 1 });
    await settle(node, rust);
    check(
      'submaster: releasing one leaves the other in charge',
      Math.abs(peak() - full * 0.8) < 0.02,
      `peak ${peak()} against ${full * 0.8}`,
    );
    check(
      'submaster: full is stored as absent, not as 1',
      (node.snap?.submasters ?? []).every((x) => x.id !== groupId),
      JSON.stringify(node.snap?.submasters),
    );

    // stacked with the layer master, and then blackout over the lot
    both({ type: 'setLayerMaster', layerId: 'layer-wash', v: 0.5 });
    await settle(node, rust);
    compareDmx('submaster: stacked under a layer master parity', node, rust);
    check(
      'submaster: it multiplies with the layer master, which is a different stage',
      Math.abs(peak() - full * 0.8 * 0.5) < 0.02,
      `peak ${peak()} against ${full * 0.4}`,
    );
    both({ type: 'setBlackout', v: true });
    await settle(node, rust);
    compareDmx('submaster: blackout over the lot parity', node, rust);
    check('submaster: blackout still wins', peak() === 0, `peak ${peak()}`);
    both({ type: 'setBlackout', v: false });
    both({ type: 'setLayerMaster', layerId: 'layer-wash', v: 1 });

    // a panic clears levels; a deleted group takes its level with it
    both({ type: 'setSubmaster', groupId: 'g-overlap', v: 0.3 });
    await settle(node, rust);
    both({ type: 'allStop' });
    await settle(node, rust);
    check(
      'submaster: a panic clears every level on both engines',
      (node.snap?.submasters ?? []).length === 0 && (rust.snap?.submasters ?? []).length === 0,
      `node=${JSON.stringify(node.snap?.submasters)} rust=${JSON.stringify(rust.snap?.submasters)}`,
    );
    both({ type: 'setBlackout', v: false });
    both({ type: 'setSubmaster', groupId: 'g-overlap', v: 0.3 });
    await sleep(300);
    const pruned = structuredClone(await currentProject(node));
    pruned.groups = pruned.groups.filter((g) => g.id !== 'g-overlap');
    both({ type: 'updateProject', project: pruned });
    await settle(node, rust);
    check(
      'submaster: deleting a group takes its level with it',
      (node.snap?.submasters ?? []).length === 0 && (rust.snap?.submasters ?? []).length === 0,
      `node=${JSON.stringify(node.snap?.submasters)} rust=${JSON.stringify(rust.snap?.submasters)}`,
    );
    compareDmx('submaster: cleared parity', node, rust);
  }

  // --- movement shapes (backlog #9). One effect writing pan AND tilt from a
  // --- parametric figure, so the two engines have to agree on trig they each
  // --- get from their own platform. Pinned at several points of the lap,
  // --- because a disagreement would show at some phases and not others.
  {
    await armWash('wash-rainbow', 0);
    const partId = (await currentProject(node)).looks['wash-rainbow'].parts[0].id;
    const setShape = async (over: Record<string, unknown>): Promise<void> => {
      const p = structuredClone(await currentProject(node));
      const part = p.looks['wash-rainbow'].parts.find((x) => x.id === partId)!;
      part.params.pan = 0.5;
      part.params.tilt = 0.5;
      part.effects = [{
        id: 'fx-shape', target: 'shape', wave: 'sine', rate: 4, size: 0.8, spread: 0,
        width: 0.5, phase: 0, bypass: false, mix: 1, distribute: 'index', fold: 'none',
        reverse: false, parts: 1, buddy: 1, seed: 0, ...over,
      }] as Project['looks'][string]['parts'][number]['effects'];
      both({ type: 'updateProject', project: p });
      await sleep(400);
    };

    for (const shape of ['circle', 'figure8', 'square'] as const) {
      await setShape({ shape });
      for (const beat of [0, 0.37, 1.0, 2.6, 3.9]) {
        both({ type: '_pinClock', effBeat: beat });
        await settle(node, rust);
        compareDmx(`shape: ${shape} at beat ${beat}`, node, rust);
      }
    }

    // the knobs, each at a phase where it changes the answer
    await setShape({ shape: 'circle', shapeAspect: 0.15 });
    both({ type: '_pinClock', effBeat: 1.1 });
    await settle(node, rust);
    compareDmx('shape: a squashed circle', node, rust);

    await setShape({ shape: 'figure8', shapeRotate: 0.25 });
    both({ type: '_pinClock', effBeat: 1.1 });
    await settle(node, rust);
    compareDmx('shape: a turned figure', node, rust);

    await setShape({ shape: 'circle', shapeCcw: true });
    both({ type: '_pinClock', effBeat: 1.1 });
    await settle(node, rust);
    compareDmx('shape: traced the other way', node, rust);

    await setShape({ shape: 'circle', spread: 1, distribute: 'x', fold: 'mirror' });
    both({ type: '_pinClock', effBeat: 1.1 });
    await settle(node, rust);
    compareDmx('shape: spread and folded across the group', node, rust);

    // and the point of the whole thing: ONE effect moved BOTH axes
    await setShape({ shape: 'circle' });
    both({ type: '_pinClock', effBeat: 1.1 });
    await settle(node, rust);
    const heads = () => (node.snap?.heads ?? []).filter((h) => h.pan !== undefined);
    const movedPan = heads().some((h) => Math.abs(h.pan - 0.5) > 0.02);
    const movedTilt = heads().some((h) => Math.abs(h.tilt - 0.5) > 0.02);
    check('shape: one effect moved pan', movedPan, `pans ${heads().map((h) => h.pan).join(',')}`);
    check('shape: and the same effect moved tilt', movedTilt, `tilts ${heads().map((h) => h.tilt).join(',')}`);

    // an unknown figure from a newer build degrades rather than dropping the
    // effect, the same way an unknown distribute does
    await setShape({ shape: 'dodecahedron' });
    await settle(node, rust);
    compareDmx('shape: an unknown figure degrades to the default on both', node, rust);
  }

  // --- freeze: the rig holds while the show carries on underneath (backlog
  // --- #7). The point of the feature is that the wire stops moving and
  // --- nothing else does, so the DMX has to be provably unchanged across an
  // --- edit that provably reached the engine.
  {
    await armWash('wash-rainbow', 0.9);
    both({ type: '_pinClock', effBeat: 0.9 });
    await settle(node, rust);
    const wire = () => JSON.stringify(node.dmx['u1'] ?? []);
    const lit = wire();
    check('freeze: something is actually lit to hold', lit !== JSON.stringify([]) && /[1-9]/.test(lit));
    check(
      'freeze: both engines start unfrozen',
      node.snap?.frozen === false && rust.snap?.frozen === false,
      `node=${node.snap?.frozen} rust=${rust.snap?.frozen}`,
    );

    both({ type: 'setFreeze', v: true });
    await sleep(300);
    check(
      'freeze: both engines agree they are holding',
      node.snap?.frozen === true && rust.snap?.frozen === true,
      `node=${node.snap?.frozen} rust=${rust.snap?.frozen}`,
    );

    // an edit big enough that nothing could mistake it for rounding
    const dim = async (v: number) => {
      const p = structuredClone(await currentProject(node));
      p.looks['wash-rainbow'].parts[0].params.dimmer = v;
      both({ type: 'updateProject', project: p });
      await sleep(600);
    };
    await dim(0.05);
    check(
      'freeze: the edit reached the engines',
      (await currentProject(node)).looks['wash-rainbow'].parts[0].params.dimmer === 0.05,
    );
    check('freeze: and the wire did not move', wire() === lit, 'the held frame changed under an edit');
    compareDmx('freeze: held parity', node, rust);
    check(
      'freeze: the stage view followed the edit even though the wire did not',
      (node.snap?.heads ?? []).some((h) => h.i > 0 && h.i < 0.2),
      'no head dimmed in the snapshot — the renderer stopped instead of the wire',
    );

    both({ type: 'setFreeze', v: false });
    await settle(node, rust);
    check('freeze: releasing lets the edit through', wire() !== lit);
    compareDmx('freeze: released parity', node, rust);

    // blackout always wins, and so does the panic key
    both({ type: 'setFreeze', v: true });
    await sleep(300);
    both({ type: 'setBlackout', v: true });
    await sleep(300);
    check(
      'freeze: blackout releases the hold on both engines',
      node.snap?.frozen === false && rust.snap?.frozen === false,
      `node=${node.snap?.frozen} rust=${rust.snap?.frozen}`,
    );
    both({ type: 'setBlackout', v: false });
    both({ type: 'setFreeze', v: true });
    await sleep(300);
    both({ type: 'allStop' });
    await settle(node, rust);
    check(
      'freeze: ALL STOP releases it too — a hold cannot swallow a panic',
      node.snap?.frozen === false && rust.snap?.frozen === false,
      `node=${node.snap?.frozen} rust=${rust.snap?.frozen}`,
    );
    compareDmx('freeze: after the panic, parity', node, rust);
    both({ type: 'setBlackout', v: false });
    await settle(node, rust);
  }

  // --- P2 modulators (LFO slice): beat-locked offsets over stored → soft,
  // byte-identical on both engines at pinned beats, across part fields,
  // effect knobs, hue scaling, the disabled path and a dangling binding.
  {
    await armWash('wash-rainbow', 0.9);
    const partId = (await currentProject(node)).looks['wash-rainbow'].parts[0].id;
    const effectId = (await currentProject(node)).looks['wash-rainbow'].parts[0].effects[0].id;
    const setMods = async (mods: Project['modulators']): Promise<void> => {
      const p = structuredClone(await currentProject(node));
      Object.assign(p.looks['wash-rainbow'].parts[0].effects[0], {
        bypass: false, mix: 1, distribute: 'index', fold: 'none', reverse: false, parts: 1, buddy: 1, seed: 0,
      });
      if (mods) p.modulators = mods;
      else delete p.modulators;
      both({ type: 'updateProject', project: p });
      await sleep(400);
    };
    await setMods(undefined);
    const stored = frameOf(node);
    compareDmx('mods: baseline parity', node, rust);

    await setMods([
      {
        id: 'lfo-1', name: 'Breath', wave: 'sine', rate: 4, phase: 0, on: true,
        bindings: [
          { lookId: 'wash-rainbow', partId, field: 'sat', depth: 0.8 },
          { lookId: 'wash-rainbow', partId, field: 'hue', depth: 0.2 },
          { lookId: 'wash-rainbow', partId, effectId, field: 'phase', depth: 0.5 },
          { lookId: 'gone', partId: 'nope', field: 'dimmer', depth: 1 }, // dangling: skipped
        ],
      },
    ]);
    compareDmx('mods: LFO parity at beat 0.9', node, rust);
    check('mods: the LFO moves DMX', frameOf(node) !== stored, 'modulator changed nothing');
    for (const beat of [1.7, 2.5, 3.3]) {
      both({ type: '_pinClock', effBeat: beat });
      await sleep(300);
      compareDmx(`mods: LFO parity at beat ${beat}`, node, rust);
    }

    // disabled modulator: byte-identical to no modulator at the same beat
    both({ type: '_pinClock', effBeat: 0.9 });
    await sleep(300);
    await setMods([
      { id: 'lfo-1', name: 'Breath', wave: 'sine', rate: 4, phase: 0, on: false,
        bindings: [{ lookId: 'wash-rainbow', partId, field: 'sat', depth: 0.8 }] },
    ]);
    compareDmx('mods: disabled parity', node, rust);
    check('mods: disabled renders the stored bytes', frameOf(node) === stored, 'off modulator still modulated');

    await setMods(undefined);
    both({ type: 'allStop' });
    both({ type: 'setBlackout', v: false });
    await settle(node, rust);
  }

  // --- A2 pool: the FX pool is data the engine never renders from, but it must
  // survive the save/broadcast round-trip identically on both engines, and both
  // must repair it the same way (drop a malformed preset, clamp an out-of-range
  // mix). Compared field-by-field so serialisation key-order can't matter.
  {
    const mkEffect = (over: Partial<Effect>): Effect => ({
      id: 'tpl', target: 'hue', wave: 'sawUp', rate: 8, size: 1, spread: 0.5,
      width: 0.5, phase: 0, bypass: false, mix: 1,
      distribute: 'index', fold: 'none', reverse: false, parts: 1, buddy: 1, seed: 0, ...over,
    });
    const p = structuredClone(await currentProject(node));
    p.fxPool = [
      // non-default fan fields: the canon comparison below proves the Rust
      // enums serialize back with EXACTLY the TS spellings ('radial','mirror')
      { id: 'fp1', name: 'Rainbow', effect: mkEffect({ id: 'tpl1', distribute: 'radial', fold: 'mirror', reverse: true, parts: 3, buddy: 2, seed: 99 }) },
      // unknown target -> both engines drop this whole preset
      { id: 'fp-bad', name: 'Bad', effect: mkEffect({ id: 'tpl2', target: 'laser' as Effect['target'] }) },
      // out-of-range mix -> clamped to 1 by both
      { id: 'fp2', name: 'Dim', effect: mkEffect({ id: 'tpl3', target: 'dimmer', wave: 'sine', mix: 3 }) },
    ];
    both({ type: 'updateProject', project: p });
    await sleep(400);
    const canon = (proj: Project) =>
      (proj.fxPool ?? [])
        .map((fp) => {
          const e = fp.effect;
          // EVERY effect field — a field left out of this string is a field a
          // serialization divergence could mangle unobserved
          return `${fp.id}|${fp.name}|${e.id}|${e.target}|${e.wave}|${e.rate}|${e.size}|${e.spread}|${e.width}|${e.phase}|${e.bypass}|${e.mix}|${e.distribute}|${e.fold}|${e.reverse}|${e.parts}|${e.buddy}|${e.seed}`;
        })
        .join(';');
    const nPool = canon(await currentProject(nodeObs));
    const rPool = canon(await currentProject(rustObs));
    check('pool: survives the round-trip identically on both engines', nPool === rPool, `node=${nPool} rust=${rPool}`);
    const ids = (await currentProject(nodeObs)).fxPool?.map((fp) => fp.id) ?? [];
    check('pool: the malformed preset is dropped by both', !ids.includes('fp-bad') && ids.length === 2, `ids=${ids.join(',')}`);
    const dim = (await currentProject(rustObs)).fxPool?.find((fp) => fp.id === 'fp2');
    check('pool: out-of-range mix clamped to 1', dim?.effect.mix === 1, `got ${dim?.effect.mix}`);
  }

  // --- project-generation staleness: both engines must reject a write whose
  // --- base generation is stale, and their generation counters must agree.
  {
    await settle(node, rust);
    await sleep(300); // let the last coalesced project echo reach the observers
    // The OBSERVER clients never send, so they are never skipped by the
    // sender-suppressed echo and their gen tracks the engine exactly. This is
    // the strongest single parity check in the suite: the counters only match
    // if both engines bumped identically through every command above.
    check(
      'gen: the two engines agree on the project generation',
      nodeObs.gen === rustObs.gen && nodeObs.gen > 0,
      `node=${nodeObs.gen} rust=${rustObs.gen}`,
    );

    // send a rename to each engine with a given base, over the raw socket (so
    // the client's optimistic-project shortcut does not mask the engine's answer)
    const rename = async (name: string, baseGen: number): Promise<void> => {
      for (const c of [node, rust]) {
        const p = structuredClone(await currentProject(c));
        p.name = name;
        c.ws.send(JSON.stringify({ type: 'updateProject', project: p, baseGen }));
      }
    };

    // a FRESH write (correct base, from the observers' accurate gen) is accepted
    await rename('Gen Fresh', nodeObs.gen);
    await sleep(400);
    check(
      'gen: a write with the current base is applied by both',
      (await currentProject(nodeObs)).name === 'Gen Fresh' &&
        (await currentProject(rustObs)).name === 'Gen Fresh',
      `node="${(await currentProject(nodeObs)).name}" rust="${(await currentProject(rustObs)).name}"`,
    );

    // a STALE write (base 0, long superseded) is rejected by both — the name
    // stays what the fresh write set, not what the stale write tried
    await rename('Gen Stale SHOULD NOT STICK', 0);
    await sleep(400);
    check(
      'gen: a write with a stale base is rejected by both',
      (await currentProject(nodeObs)).name === 'Gen Fresh' &&
        (await currentProject(rustObs)).name === 'Gen Fresh',
      `node="${(await currentProject(nodeObs)).name}" rust="${(await currentProject(rustObs)).name}"`,
    );
    // and the engines are still in lockstep after the rejection
    check(
      'gen: still in agreement after a rejected write',
      nodeObs.gen === rustObs.gen,
      `node=${nodeObs.gen} rust=${rustObs.gen}`,
    );
  }

  // --- Engine-side undo parity (backlog #12): one history per engine, the
  // --- same names, the same restore — the page kept, the live state kept.
  {
    const hist = (c: Client) => JSON.stringify(c.history);
    const p0 = structuredClone(await currentProject(node));
    const nameBefore = p0.name;
    const deck2 = p0.decks?.[1]?.id ?? null;
    const layerId = p0.layers[0].id;
    const cellBefore = p0.layers[0].cells[0] ?? null;
    const edit = (p: Project) => {
      p.name = 'Parity Renamed';
      p.layers[0].cells[0] = 'look-parity';
      return p;
    };
    node.send({ type: 'updateProject', project: edit(structuredClone(await currentProject(node))), label: 'rename the show' });
    rust.send({ type: 'updateProject', project: edit(structuredClone(await currentProject(rust))), label: 'rename the show' });
    await sleep(300);
    check('history: the step is named the same on both', hist(node) === hist(rust) && node.history?.undo === 'rename the show', `node=${hist(node)} rust=${hist(rust)}`);
    if (deck2) both({ type: 'switchDeck', deckId: deck2 }); // played, not edited
    await sleep(300);
    check('history: a song switch is not a step', node.history?.undoDepth === rust.history?.undoDepth && hist(node) === hist(rust), `node=${hist(node)} rust=${hist(rust)}`);
    node.project = null;
    rust.project = null;
    both({ type: 'undo' });
    await sleep(400);
    const un = await currentProject(node);
    const ur = await currentProject(rust);
    check('undo: the write is reverted on both', un.name === nameBefore && ur.name === nameBefore, `node=${un.name} rust=${ur.name}`);
    if (deck2) {
      check('undo: the song switch is kept on both', un.activeDeckId === deck2 && ur.activeDeckId === deck2, `node=${un.activeDeckId} rust=${ur.activeDeckId}`);
      const padOf = (p: Project) => p.decks?.find((d) => d.id === p0.activeDeckId)?.cells[layerId]?.[0] ?? null;
      check("undo: the other song's pad is back on both", padOf(un) === cellBefore && padOf(ur) === cellBefore, `node=${padOf(un)} rust=${padOf(ur)}`);
    }
    check('history: redo is named the same on both', hist(node) === hist(rust) && node.history?.redo === 'rename the show', `node=${hist(node)} rust=${hist(rust)}`);
    check('gen: in agreement after an undo', node.gen === rust.gen, `node=${node.gen} rust=${rust.gen}`);
    node.project = null;
    rust.project = null;
    both({ type: 'redo' });
    await sleep(400);
    check('redo: the write is back on both', (await currentProject(node)).name === 'Parity Renamed' && (await currentProject(rust)).name === 'Parity Renamed');
    node.project = null;
    rust.project = null;
    both({ type: 'undo' });
    await sleep(400);
    check('undo: reverted again on both', (await currentProject(node)).name === nameBefore && (await currentProject(rust)).name === nameBefore);
    await settle(node, rust);
    compareDmx('undo/redo: output parity', node, rust);
    if (deck2 && p0.activeDeckId) both({ type: 'switchDeck', deckId: p0.activeDeckId }); // back to the page the rest of the suite expects
    await sleep(300);
  }

  // --- Stage size (backlog #14): the one repair rule, on both engines.
  {
    const withStage = async (c: Client, stage: unknown) => ({ ...structuredClone(await currentProject(c)), stage }) as Project;
    // by value: the Rust echo passes through a key-sorted JSON map, so {w,d,h}
    // comes back as {d,h,w} — the same stage, not the same string
    const sides = (st: { w: number; d: number; h: number } | undefined) => (st ? `${st.w}x${st.d}x${st.h}` : 'none');
    node.send({ type: 'updateProject', project: await withStage(node, { w: 20, d: 12, h: 8 }) });
    rust.send({ type: 'updateProject', project: await withStage(rust, { w: 20, d: 12, h: 8 }) });
    await sleep(400);
    const sn = (await currentProject(nodeObs)).stage;
    const sr = (await currentProject(rustObs)).stage;
    check('stage: both engines keep a manual size', sides(sn) === '20x12x8' && sides(sr) === '20x12x8', `node=${sides(sn)} rust=${sides(sr)}`);
    node.send({ type: 'updateProject', project: await withStage(node, { w: 9000, d: 0.5, h: 'tall' }) });
    rust.send({ type: 'updateProject', project: await withStage(rust, { w: 9000, d: 0.5, h: 'tall' }) });
    await sleep(400);
    const bn = (await currentProject(nodeObs)).stage;
    const br = (await currentProject(rustObs)).stage;
    check('stage: both engines drop a size with a bad side', bn === undefined && br === undefined, `node=${JSON.stringify(bn)} rust=${JSON.stringify(br)}`);
    node.send({ type: 'updateProject', project: await withStage(node, { w: 9000, d: 0.5, h: 3 }) });
    rust.send({ type: 'updateProject', project: await withStage(rust, { w: 9000, d: 0.5, h: 3 }) });
    await sleep(400);
    const cn = (await currentProject(nodeObs)).stage;
    const cr = (await currentProject(rustObs)).stage;
    check('stage: both engines clamp the sides the same way', sides(cn) === '500x1x3' && sides(cr) === '500x1x3', `node=${sides(cn)} rust=${sides(cr)}`);
    node.send({ type: 'updateProject', project: await withStage(node, undefined) });
    rust.send({ type: 'updateProject', project: await withStage(rust, undefined) });
    await sleep(300);
  }

  // --- Beat clock (backlog #10): the FOLLOWER is native-only, like Link — a
  // --- browser cannot see a timestamp worth averaging. What both engines must
  // --- agree on is the flag and the rule that only one thing drives the
  // --- tempo, because a client has to get the same project back whichever
  // --- engine it is talking to.
  {
    const sync = async (c: Client) => (await currentProject(c)).sync;
    const pair = (a: { linkEnabled?: boolean; midiClockEnabled?: boolean }) =>
      `link=${a.linkEnabled === true} clock=${a.midiClockEnabled === true}`;
    both({ type: 'setLink', on: true });
    await sleep(400);
    check(
      'beat clock: both engines start from Link leading',
      pair(await sync(nodeObs)) === 'link=true clock=false' && pair(await sync(rustObs)) === 'link=true clock=false',
      `node=${pair(await sync(nodeObs))} rust=${pair(await sync(rustObs))}`,
    );
    both({ type: 'setMidiClock', on: true });
    await sleep(400);
    check(
      'beat clock: switching it on takes the tempo from Link in both engines',
      pair(await sync(nodeObs)) === 'link=false clock=true' && pair(await sync(rustObs)) === 'link=false clock=true',
      `node=${pair(await sync(nodeObs))} rust=${pair(await sync(rustObs))}`,
    );
    both({ type: 'setLink', on: true });
    await sleep(400);
    check(
      'beat clock: and Link takes it back the same way',
      pair(await sync(nodeObs)) === 'link=true clock=false' && pair(await sync(rustObs)) === 'link=true clock=false',
      `node=${pair(await sync(nodeObs))} rust=${pair(await sync(rustObs))}`,
    );
    // switching one OFF is not a claim on the tempo, so it leaves the other
    both({ type: 'setMidiClock', on: true });
    await sleep(300);
    both({ type: 'setMidiClock', on: false });
    await sleep(400);
    check(
      'beat clock: switching it off claims nothing',
      pair(await sync(nodeObs)) === 'link=false clock=false' && pair(await sync(rustObs)) === 'link=false clock=false',
      `node=${pair(await sync(nodeObs))} rust=${pair(await sync(rustObs))}`,
    );
    both({ type: 'setLink', on: false });
    await sleep(300);
    // With nothing sending clock, an armed follower must leave the tempo alone
    // rather than free-run it somewhere — a stall is not a tempo change.
    both({ type: 'setBpm', bpm: 132 });
    both({ type: 'setMidiClock', on: true });
    await sleep(700);
    check(
      'beat clock: armed with nothing sending, the tempo stays where it was',
      Math.abs((node.snap?.bpm ?? 0) - 132) < 0.01 && Math.abs((rust.snap?.bpm ?? 0) - 132) < 0.01,
      `node=${node.snap?.bpm} rust=${rust.snap?.bpm}`,
    );
    compareDmx('beat clock: an armed follower with no source changes no byte', node, rust);
    both({ type: 'setMidiClock', on: false });
    await sleep(300);
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
  check(
    'history: an import is a step, named the same on both',
    node.history?.undo === 'import “synthetic.mvr”' && rust.history?.undo === 'import “synthetic.mvr”',
    `node=${node.history?.undo} rust=${rust.history?.undo}`,
  );

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
    (await currentProject(nodeObs)).universes.every((u) => !u.artnet && !u.sacn) &&
      (await currentProject(rustObs)).universes.every((u) => !u.artnet && !u.sacn),
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
