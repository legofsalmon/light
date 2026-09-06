// Engine smoke test — no framework, exits non-zero on failure.
// Verifies: OSC parsing, look merge → DMX bytes, masters/blackout,
// flash release, column cue semantics, clock, and a real Art-Net
// packet over loopback.

import dgram from 'node:dgram';
import { EngineState, HISTORY_CAP } from '../state.ts';
import { Renderer } from '../renderer.ts';
import fs from 'node:fs';
import path from 'node:path';
import type { Project } from '../../shared/types.ts';
import { sanitizeProject, sanitizeStage } from '../../shared/types.ts';
import { stageExtent } from '../../shared/stageExtent.ts';
import type { ShareList } from '../../shared/gdtfShare.ts';
import { hasUndrivenBeamChannels, isAcceptableList, isPlaceholderProfile, parseGdtfSpec, rankMatches } from '../../shared/gdtfShare.ts';

/** The demo show these tests were written against — five fixtures at known
 *  addresses, looks with known ids. Deliberately NOT the shipped default: that
 *  is a real 20-song set list now, and pinning byte assertions to its artistic
 *  content means editing a song looks like an engine regression. */
const demoProject = (): Project =>
  JSON.parse(fs.readFileSync(path.join(process.cwd(), 'core/tests/data/demo_project.json'), 'utf8'));
import { readFileSync } from 'node:fs';
import { MAX_THROW, buildOccluders, hitsPropFootprint, standingHeightAt, throwDistance, type Occluder } from '../../shared/beamThrow.ts';
import { parseOsc } from '../osc.ts';
import { ArtnetOut } from '../artnet.ts';
import { BeatClock } from '../clock.ts';

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// Outputs are off until someone turns them on — both templates, both engines
// (the Rust twin is core/src/defaults.rs neither_template_sends_dmx_until_asked).
{
  const tpl = (f: string) => JSON.parse(fs.readFileSync(path.join(process.cwd(), 'shared', f), 'utf8')) as Project;
  for (const f of ['defaultProject.json', 'blankProject.json']) {
    check(`${f}: no universe sends Art-Net or sACN out of the box`, tpl(f).universes.every((u) => !u.artnet && !u.sacn));
  }
  const blank = tpl('blankProject.json');
  check('blankProject.json: neutral universe names', blank.universes.map((u) => u.label).join('|') === 'Universe 1|Universe 2');
  check('blankProject.json: the Resolume link waits for the operator', blank.sync.oscEnabled === false);
}

function oscBuf(addr: string, tags: string, args: number[]): Buffer {
  const pad = (s: string) => {
    const len = Math.floor(s.length / 4 + 1) * 4;
    const b = Buffer.alloc(len);
    b.write(s, 'ascii');
    return b;
  };
  const parts = [pad(addr), pad(',' + tags)];
  for (let i = 0; i < tags.length; i++) {
    const b = Buffer.alloc(4);
    if (tags[i] === 'i') b.writeInt32BE(args[i]);
    else b.writeFloatBE(args[i]);
    parts.push(b);
  }
  return Buffer.concat(parts);
}

// ---------- OSC ----------
{
  const m = parseOsc(oscBuf('/composition/columns/3/connect', 'i', [1]));
  check('osc parse address', m.length === 1 && m[0].addr === '/composition/columns/3/connect');
  check('osc parse int arg', m[0]?.args[0] === 1);
  const f = parseOsc(oscBuf('/composition/tempocontroller/tempo', 'f', [0.25]));
  check('osc parse float arg', Math.abs((f[0]?.args[0] as number) - 0.25) < 1e-6);
}

// ---------- merge → DMX ----------
{
  const st = new EngineState(sanitizeProject(demoProject())!);
  const r = new Renderer(st);
  const t0 = 1000;
  r.tick(t0); // prime dt integration

  // Red wash (col 1 of WASH layer), after the 0.8 s fade completes.
  st.trigger('layer-wash', 1, t0);
  const res = r.tick(t0 + 900);
  const u1 = res.buffers.get('u1')!;
  // Bar 1 @21 → base index 20: Par1 R,G,B,Dim,Flash
  check('bar par1 red=255', u1[20] === 255, `got ${u1[20]}`);
  check('bar par1 green=0', u1[21] === 0, `got ${u1[21]}`);
  check('bar par1 dimmer=255', u1[23] === 255, `got ${u1[23]}`);
  check('bar par4 red=255 (whole group)', u1[35] === 255, `got ${u1[35]}`);
  check('bar2 red=255 (second bar)', u1[50] === 255, `got ${u1[50]}`);
  check('derby untouched (macro 0)', u1[0] === 0, `got ${u1[0]}`);

  // Derby Red Spin (col 1 of DERBY layer): macro Red=13, motor rotate 0.35.
  st.trigger('layer-derby', 1, t0 + 1000);
  const res2 = r.tick(t0 + 2000);
  const b2 = res2.buffers.get('u1')!;
  check('derby macro red=13', b2[0] === 13, `got ${b2[0]}`);
  check('derby motor rotate', b2[2] === 128 + Math.round(0.35 * 127), `got ${b2[2]}`);
  check('derby2 same (group)', b2[10] === 13, `got ${b2[10]}`);

  // Grand master scales bar dimmer but macro stays chosen.
  st.master = 0.5;
  const b3 = r.tick(t0 + 2100).buffers.get('u1')!;
  check('grand master halves bar dimmer', Math.abs(b3[23] - 128) <= 1, `got ${b3[23]}`);
  check('grand master keeps derby macro', b3[0] === 13, `got ${b3[0]}`);

  // Blackout kills output instantly.
  st.blackout = true;
  const b4 = r.tick(t0 + 2200).buffers.get('u1')!;
  check('blackout bar dimmer=0', b4[23] === 0, `got ${b4[23]}`);
  check('blackout derby macro=0', b4[0] === 0, `got ${b4[0]}`);
  st.blackout = false;
  st.master = 1;

  // FX multiply layer modulates the wash dimmer without touching colour.
  // (sample off the whole beat — sawDown is exactly 1.0 on the beat)
  st.trigger('layer-fx', 1, t0 + 3000); // Beat Pulse, sawDown rate 1
  const b5 = r.tick(t0 + 4100).buffers.get('u1')!;
  check('fx leaves colour', b5[20] === 255, `got ${b5[20]}`);
  check('fx modulates dimmer', b5[23] > 0 && b5[23] < 255, `got ${b5[23]}`);

  // Flash look latches while held, releases on release().
  st.trigger('layer-strobe', 1, t0 + 5000); // Ring Blinder, fade 0
  const b6 = r.tick(t0 + 5050).buffers.get('u1')!;
  check('blinder ring on (220)', b6[3] === 220, `got ${b6[3]}`);
  st.release('layer-strobe', 1, t0 + 5100);
  const b7 = r.tick(t0 + 5400).buffers.get('u1')!;
  check('blinder released', b7[3] === 0, `got ${b7[3]}`);

  // Column cue: fires non-flash cells, skips flash cells, clears empty layers.
  st.triggerColumn(0, t0 + 6000); // Intro: amber wash, derby empty, fx empty, strobe-all is flash
  const strobeLive = st.layerLive('layer-strobe');
  check('column skips flash look', strobeLive.lookId === null);
  const washLive = st.layerLive('layer-wash');
  check('column fires wash', washLive.lookId === 'wash-gold');
  const derbyLive = st.layerLive('layer-derby');
  check('column clears empty layer', derbyLive.lookId === null);

  // Held flash must drop when the last client disconnects.
  st.trigger('layer-strobe', 1, t0 + 8000);
  const b9 = r.tick(t0 + 8050).buffers.get('u1')!;
  check('held blinder on before disconnect', b9[3] === 220, `got ${b9[3]}`);
  st.releaseAllHeld(t0 + 8100);
  const b10 = r.tick(t0 + 8400).buffers.get('u1')!;
  check('releaseAllHeld drops blinder', b10[3] === 0, `got ${b10[3]}`);

  // Hazer manual settings reach the buffer.
  st.project.settings.haze = 0.5;
  const b8 = r.tick(t0 + 7000).buffers.get('u1')!;
  check('haze output @101', Math.abs(b8[100] - 128) <= 1, `got ${b8[100]}`);
  check('haze fan @102', b8[101] === Math.round(0.35 * 255), `got ${b8[101]}`);
}

// ---------- clock ----------
{
  const nan = new BeatClock();
  nan.setBpm(NaN);
  check('NaN bpm rejected', nan.bpm === 120, `got ${nan.bpm}`);
  nan.setBpm(150);
  check('clock works after NaN rejection', Math.abs(nan.bpm - 150) < 1e-9);

  const c = new BeatClock();
  c.setBpm(120, 0);
  const b = c.beatAt(1000);
  check('clock 120bpm = 2 beats/s', Math.abs(b - c.beatAt(0) - 2) < 1e-6);
  c.tap(10000);
  c.tap(10500);
  c.tap(11000);
  check('tap tempo → 120', Math.abs(c.bpm - 120) < 0.5, `got ${c.bpm}`);
}

// ---------- Art-Net over loopback ----------
await new Promise<void>((resolve) => {
  const rx = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const done = (ok: boolean, detail = '') => {
    check('artnet packet received + valid', ok, detail);
    try {
      rx.close();
    } catch {
      /* already closed */
    }
    resolve();
  };
  const timer = setTimeout(() => done(false, 'timeout — nothing received on :6454'), 2500);
  rx.on('error', (err) => {
    clearTimeout(timer);
    console.log(`  skip artnet loopback (:6454 busy: ${err.message})`);
    clearTimeout(timer);
    resolve();
  });
  rx.on('message', (pkt) => {
    clearTimeout(timer);
    const okId = pkt.toString('latin1', 0, 8) === 'Art-Net\0';
    const okOp = pkt.readUInt16LE(8) === 0x5000;
    const okUni = pkt[14] === 1 && pkt[15] === 0;
    const okLen = pkt.readUInt16BE(16) === 512 && pkt.length === 530;
    const okData = pkt[18 + 20] === 255; // channel 21 = par1 red
    done(okId && okOp && okUni && okLen && okData, `id=${okId} op=${okOp} uni=${okUni} len=${okLen} data=${okData}`);
  });
  rx.bind(6454, '127.0.0.1', () => {
    const st = new EngineState(sanitizeProject(demoProject())!);
    const r = new Renderer(st);
    r.tick(0);
    st.trigger('layer-wash', 1, 0);
    const res = r.tick(2000);
    const tx = new ArtnetOut();
    // give the socket a beat to finish binding, then send twice for safety
    setTimeout(() => {
      tx.send(1, res.buffers.get('u1')!, '127.0.0.1');
      setTimeout(() => tx.close(), 300);
    }, 150);
  });
});


// A truss must survive the sanitiser. It did not: the allow-list was hand
// written and never grew when stage structure was added, so every truss, leg,
// riser and screen was stripped on load, on updateProject and on
// replaceProject — silently, because the echo is withheld from the sender, so
// the UI kept drawing a stage the autosave had already thrown away.
{
  const p = sanitizeProject({
    ...demoProject(),
    props: [
      { id: 'p1', kind: 'trussBar', pos: { x: 0, z: 0 }, size: { w: 7, h: 0.3, d: 0.3 }, y: 3.05 },
      { id: 'p2', kind: 'riser', pos: { x: 1, z: 1 } },
      { id: 'p3', kind: 'vocalist', pos: { x: 0, z: 2 } },
      { id: 'p4', kind: 'nonsense', pos: { x: 0, z: 0 } },
    ],
  } as unknown as Project);
  const kinds = (p?.props ?? []).map((x) => x.kind).sort();
  check(
    'sanitize keeps stage structure',
    JSON.stringify(kinds) === JSON.stringify(['riser', 'trussBar', 'vocalist']),
    `got ${JSON.stringify(kinds)}`,
  );
  const bar = p?.props?.find((x) => x.id === 'p1');
  check('sanitize keeps truss dimensions', bar?.size?.w === 7 && bar?.y === 3.05, JSON.stringify(bar));
  const riser = p?.props?.find((x) => x.id === 'p2');
  check('sanitize fills missing structure size', (riser?.size?.w ?? 0) > 0, JSON.stringify(riser));
}


// --- GDTF Share matching ----------------------------------------------------
// Against a slice of a REAL catalogue response, using the three fixtures from a
// real festival MVR. Exact manufacturer+model lookup fails on two of the three,
// which is why this is a ranked shortlist and not a key lookup.
{
  const sample: ShareList = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'core/tests/data/gdtf-share-list.sample.json'), 'utf8'),
  );

  const spec = parseGdtfSpec('Robe@Robin Spiider@r3045.gdtf');
  check('gdtfSpec: manufacturer parsed', spec.manufacturer === 'Robe', JSON.stringify(spec));
  check('gdtfSpec: revision marker dropped', spec.model === 'Robin Spiider', JSON.stringify(spec));

  const cases: [string, string][] = [
    ['Robe@Robin Spiider@r3045.gdtf', 'Robin Spiider'],
    ['Acme@Lyra@r3006.gdtf', 'LYRA'],
    ['Ayrton@Rivale Profile@r3014.gdtf', 'Rivale Profile'],
  ];
  for (const [gdtfSpec, expectFixture] of cases) {
    const top = rankMatches(parseGdtfSpec(gdtfSpec), sample.list, 5);
    const hit = top[0];
    check(
      `share match: ${gdtfSpec.split('@')[1]}`,
      !!hit && new RegExp(expectFixture, 'i').test(hit.entry.fixture),
      `top was ${hit ? `"${hit.entry.manufacturer}" / "${hit.entry.fixture}" (${hit.score.toFixed(2)})` : 'nothing'}`,
    );
  }

  // the decoy that makes this hard: "LPL" also ships a "Rivale Profile"
  const rivale = rankMatches(parseGdtfSpec('Ayrton@Rivale Profile@r3014.gdtf'), sample.list, 5);
  check(
    'share match: right manufacturer wins over a same-named decoy',
    rivale[0]?.entry.manufacturer === 'Ayrton',
    rivale.map((m) => `${m.entry.manufacturer}/${m.entry.fixture}=${m.score.toFixed(2)}`).join(' '),
  );

  // the guard that stops a bad day at the API wiping the fixture library
  check('share list: empty rejected', !isAcceptableList({ result: true, list: [] }, 100));
  check('share list: collapse rejected', !isAcceptableList({ result: true, list: sample.list.slice(0, 5) }, 100));
  check('share list: healthy accepted', isAcceptableList(sample, 100));
}


// --- placeholder GDTF detection ---------------------------------------------
// A real festival MVR carried five stub fixture definitions: correct addresses,
// no personality. Telling them apart from a genuine dimmer is the whole job.
{
  const stub = {
    channels: Array.from({ length: 65 }, (_, i) => ({ name: `Dimmer${i + 1}` })),
    heads: [{ kind: 'dimmer' }],
  };
  check('placeholder: a 65-channel all-Dimmer profile is a stub', isPlaceholderProfile(stub));

  const realDimmer = { channels: [{ name: 'Dimmer1' }], heads: [{ kind: 'dimmer' }] };
  check('placeholder: a single-channel dimmer is NOT a stub', !isPlaceholderProfile(realDimmer));

  const mover = {
    channels: [{ name: 'Pan' }, { name: 'Tilt' }, { name: 'Dimmer1' }, { name: 'ColorSub_C' }],
    heads: [{ kind: 'mover' }],
  };
  check('placeholder: a real mover is NOT a stub', !isPlaceholderProfile(mover));

  const strip = {
    channels: [{ name: 'ColorAdd_R' }, { name: 'ColorAdd_G' }, { name: 'ColorAdd_B' }],
    heads: [{ kind: 'rgb' }, { kind: 'rgb' }],
  };
  check('placeholder: an rgb strip is NOT a stub', !isPlaceholderProfile(strip));
}

// --- beam throw ------------------------------------------------------------
// A previz cone is only informative if its length is the real throw, so the
// distances are asserted as numbers rather than judged by eye in a 3D view.
{
  const down = { x: 0, y: -1, z: 0 };
  const at = (y: number) => ({ x: 0, y, z: 0 });

  check(
    'throw: a fixture 6 m up lands on the floor at 6 m',
    Math.abs(throwDistance(at(6), down, []) - 6) < 1e-9,
  );
  check(
    'throw: nothing underneath is capped, not infinite',
    throwDistance({ x: 0, y: 2, z: 0 }, { x: 0, y: 0, z: -1 }, []) === MAX_THROW,
  );
  check(
    'throw: a beam climbing away from the floor is capped',
    throwDistance(at(1), { x: 0, y: 1, z: 0 }, []) === MAX_THROW,
  );

  // a riser under the fixture shortens the throw to the riser's top
  const riser: Occluder = { min: { x: -1, y: 0, z: -1 }, max: { x: 1, y: 0.4, z: 1 } };
  check(
    'throw: a 0.4 m riser under a 6 m fixture cuts the beam to 5.6 m',
    Math.abs(throwDistance(at(6), down, [riser]) - 5.6) < 1e-9,
  );
  check(
    'throw: a riser off to the side does not shorten the beam',
    Math.abs(
      throwDistance({ x: 5, y: 6, z: 0 }, down, [riser]) - 6,
    ) < 1e-9,
  );

  // the nearest of several surfaces wins, whatever order they arrive in
  const screen: Occluder = { min: { x: -2, y: 0.5, z: -3 }, max: { x: 2, y: 2.75, z: -2.9 } };
  const far: Occluder = { min: { x: -9, y: 0, z: -9 }, max: { x: 9, y: 9, z: -8.9 } };
  const back = { x: 0, y: 0, z: -1 };
  check(
    'throw: the nearest surface wins regardless of list order',
    Math.abs(throwDistance({ x: 0, y: 1.5, z: 0 }, back, [screen, far]) - 2.9) < 1e-9 &&
      Math.abs(throwDistance({ x: 0, y: 1.5, z: 0 }, back, [far, screen]) - 2.9) < 1e-9,
  );

  // a fixture clamped ON the truss it hangs from must not clip itself to zero
  const truss: Occluder = { min: { x: -3.5, y: 3.0, z: -0.15 }, max: { x: 3.5, y: 3.3, z: 0.15 } };
  check(
    'throw: a fixture inside its own truss still throws to the floor',
    Math.abs(throwDistance(at(3.15), down, [truss]) - 3.15) < 1e-9,
  );

  // rotation is taken into account when boxing a prop
  const rotated: Project = {
    ...demoProject(),
    props: [
      { id: 'p1', kind: 'screen', pos: { x: 0, z: -3 }, rotY: Math.PI / 2, size: { w: 4, h: 3, d: 0.1 }, y: 0 },
    ],
  } as Project;
  const occ = buildOccluders(rotated);
  check(
    'occluders: a screen turned 90° is boxed across z, not x',
    occ.length === 1 && Math.abs(occ[0].max.z - occ[0].min.z - 4) < 1e-6 &&
      Math.abs(occ[0].max.x - occ[0].min.x - 0.1) < 1e-6,
    occ.length ? `got x=${(occ[0].max.x - occ[0].min.x).toFixed(3)} z=${(occ[0].max.z - occ[0].min.z).toFixed(3)}` : 'no occluder',
  );
  check(
    'occluders: performers are not occluders',
    buildOccluders({ ...demoProject(), props: [{ id: 'v', kind: 'vocalist', pos: { x: 0, z: 0 } }] } as Project).length === 0,
  );

  // --- standingHeightAt: the twin of floor_height_at in previz/src/scene.rs.
  // Both previz views must lift a figure by the same amount, and they are
  // hand-copied twins in two languages with no parity test between them. So the
  // CASES live in one file that both sides load, and adding one there adds it
  // to both suites at once. The mirror of this loop is in previz/src/scene.rs
  // (`floor_height_matches_the_shared_corpus`).
  {
    type Case = {
      why: string;
      props: { kind: string; pos: { x: number; z: number }; rotY?: number;
               size?: { w: number; h: number; d: number }; y?: number }[];
      at: [number, number];
      expect: number;
    };
    const corpus = JSON.parse(
      readFileSync(new URL('../../shared/testdata/standingHeight.json', import.meta.url), 'utf8'),
    ) as Case[];
    check('riser: the shared corpus has not shrunk', corpus.length >= 15, `${corpus.length} cases`);
    for (const c of corpus) {
      const got = standingHeightAt(c.props, c.at[0], c.at[1]);
      check(
        `riser: ${c.why}`,
        Math.abs(got - c.expect) < 1e-4,
        `got ${got}, expected ${c.expect}`,
      );
    }
  }
  check(
    'occluders: a riser with a degenerate size falls back to the default footprint',
    (() => {
      const o = buildOccluders({
        ...demoProject(),
        props: [{ id: 'r', kind: 'riser', pos: { x: 0, z: 0 }, size: { w: 0, h: 0.4, d: 1.5 }, y: 0 }],
      } as Project);
      return o.length === 1 && Math.abs(o[0].max.x - o[0].min.x - 2) < 1e-6;
    })(),
  );
}

// --- stale compiled profiles ------------------------------------------------
{
  const spiiderBefore = {
    channels: [
      { name: 'Pan', cases: [{}] },
      { name: 'Tilt', cases: [{}] },
      { name: 'Zoom', cases: [] },
    ],
  };
  check(
    'stale: a profile compiled before zoom existed is offered a rebuild',
    hasUndrivenBeamChannels(spiiderBefore),
  );
  const spiiderAfter = {
    channels: [
      { name: 'Pan', cases: [{}] },
      { name: 'Tilt', cases: [{}] },
      { name: 'Zoom', cases: [{}, {}] },
    ],
  };
  check(
    'stale: a freshly compiled profile is NOT offered a rebuild',
    !hasUndrivenBeamChannels(spiiderAfter),
  );
  check(
    'stale: an undriven channel LIGHT has no parameter for is not staleness',
    !hasUndrivenBeamChannels({ channels: [{ name: 'Effects2Rate', cases: [] }] }),
  );
  check('stale: a profile with no channels is not stale', !hasUndrivenBeamChannels({}));
}

// --- 2D plan hit-test --------------------------------------------------------
// A truss bar is long and thin. Testing a circle of radius max(w,d)/2 made it
// swallow every click within 3.5 m of stage centre, so these assert the
// rectangle — including the rotated case, which the circle ignored entirely.
{
  const truss = { pos: { x: 0, z: 0 }, size: { w: 7, d: 0.3 } };
  check(
    'hit-test: a click on the bar hits it',
    hitsPropFootprint({ x: 3, z: 0 }, truss),
  );
  check(
    'hit-test: a click 2 m downstage of a 0.3 m-deep bar MISSES it',
    !hitsPropFootprint({ x: 0, z: 2 }, truss),
    'the old circle grabbed everything within 3.5 m',
  );
  check(
    'hit-test: a click past the end of the bar misses it',
    !hitsPropFootprint({ x: 4, z: 0 }, truss),
  );
  check(
    'hit-test: the thin axis keeps a grabbable margin',
    hitsPropFootprint({ x: 0, z: 0.2 }, truss),
  );
  // rotated 90 degrees: the long axis now runs across z, not x
  const turned = { pos: { x: 0, z: 0 }, rotY: Math.PI / 2, size: { w: 7, d: 0.3 } };
  check(
    'hit-test: a bar turned 90° is hit along z',
    hitsPropFootprint({ x: 0, z: 3 }, turned),
  );
  check(
    'hit-test: a bar turned 90° is NOT hit along x',
    !hitsPropFootprint({ x: 3, z: 0 }, turned),
    'rotation ignored — the old circle could not tell these apart',
  );
  // SIGN-discriminating case — every test above is 90° or axis-aligned, which
  // is exactly how a mirrored (+sin) frame passed unnoticed for so long. Under
  // the canonical yaw (local +X → (cos θ, 0, −sin θ)) a bar at +30° has its +X
  // end at NEGATIVE z; the mirrored frame puts it at positive z.
  const tilted = { pos: { x: 0, z: 0 }, rotY: Math.PI / 6, size: { w: 7, d: 0.3 } };
  check(
    'hit-test: a bar at +30° is hit on the canonical (−z) side',
    hitsPropFootprint({ x: 1.732, z: -1.0 }, tilted),
    'the +X end of a +30° bar sits at −z under the canonical convention',
  );
  check(
    'hit-test: a bar at +30° is NOT hit on the mirrored (+z) side',
    !hitsPropFootprint({ x: 1.732, z: 1.0 }, tilted),
    'the old +sin frame would have hit here',
  );
}

// --- truss offsets: canonical frame + round-trip -----------------------------
// offsetOnParent/posFromOffset must (a) be exact inverses, and (b) agree with
// the canonical yaw the whole plan view now uses — a fixture at positive
// `along` on a +30° truss sits at NEGATIVE z, matching the drawn rectangle,
// the head fans, and the 3D previz.
{
  const { offsetOnParent, posFromOffset } = await import('../../shared/types.ts');
  const truss = { pos: { x: 0, z: 0 }, rotY: Math.PI / 6, y: 3 };
  const p = posFromOffset({ along: 2, across: 0, drop: 0 }, truss);
  check(
    'truss offsets: +along on a +30° truss lands at −z (canonical)',
    Math.abs(p.x - 1.7320508075688774) < 1e-12 && Math.abs(p.z - -1.0) < 1e-12,
    `got (${p.x}, ${p.z})`,
  );
  const o = offsetOnParent({ pos: { x: p.x, y: 3.4, z: p.z } }, truss);
  check(
    'truss offsets: round-trip is the identity',
    Math.abs(o.along - 2) < 1e-12 && Math.abs(o.across) < 1e-12 && Math.abs(o.drop - 0.4) < 1e-12,
    `got along=${o.along} across=${o.across} drop=${o.drop}`,
  );
}

// --- geometry: the cross-language golden contract ---------------------------
// The vectors were generated by an INDEPENDENT third implementation (Python)
// of the same formula and quantizer, and are asserted EXACTLY here and in
// core/src/geometry.rs. If V8's trig lands a quantization boundary differently
// from libm's, this is where it surfaces — as an exact-value mismatch, not a
// byte drift later.
{
  const { buildGeometry } = await import('../../shared/geometry.ts');
  const golden = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'core/tests/data/geometry_golden.json'), 'utf8'),
  ) as { project: Project; expected: Record<string, { x: number; y: number; z: number; along: number; row: number; col: number; rowT: number; colT: number }> };
  const geom = buildGeometry(golden.project);
  const keys = Object.keys(golden.expected);
  check('geometry: golden head count', geom.size === keys.length, `got ${geom.size}, want ${keys.length}`);
  let bad = '';
  for (const key of keys) {
    const g = geom.get(key);
    const want = golden.expected[key];
    if (!g) { bad = `${key} missing`; break; }
    // exact f64 equality — quantization is the tolerance
    if (g.x !== want.x || g.y !== want.y || g.z !== want.z || g.along !== want.along || g.row !== want.row || g.col !== want.col || g.rowT !== want.rowT || g.colT !== want.colT) {
      bad = `${key}: got ${JSON.stringify(g)}, want ${JSON.stringify(want)}`;
      break;
    }
  }
  check('geometry: golden vectors match exactly', bad === '', bad);
  check(
    'geometry: unknown profile gets no entry',
    ![...geom.keys()].some((k) => k.startsWith('ghost:')),
  );

  // group extents: same cross-language contract, Python-computed over the
  // quantized golden heads in group.heads order, asserted f64-exact
  {
    const { buildGroupExtents } = await import('../../shared/geometry.ts');
    const ext = buildGroupExtents(golden.project, geom);
    const want = (golden as unknown as { expectedExtents: Record<string, Record<string, number>> }).expectedExtents;
    let bad = '';
    for (const [gid, w] of Object.entries(want)) {
      const e = ext.get(gid);
      if (!e) { bad = `${gid} missing`; break; }
      for (const k of ['minX', 'maxX', 'minY', 'maxY', 'minZ', 'maxZ', 'cx', 'cy', 'cz', 'maxR'] as const) {
        if (e[k] !== w[k]) { bad = `${gid}.${k}: got ${e[k]}, want ${w[k]}`; break; }
      }
      if (bad) break;
    }
    check('geometry: group extents match the golden vectors exactly', bad === '', bad);
    check(
      'geometry: a dangling ref does not stretch its group extents',
      ext.get('g-dangling')?.maxR === 0,
      `maxR=${ext.get('g-dangling')?.maxR}`,
    );
  }

  // compiled-profile offsets are consumed, not re-derived — same literals as
  // the Rust twin test (compiled_profile_offsets_are_consumed_not_rederived)
  const strip = {
    id: 'imported-strip', manufacturer: 'T', model: 'Strip', mode: '4px', footprint: 12,
    heads: [-0.5, -0.1667, 0.1667, 0.5].map((o) => ({ kind: 'rgb' as const, offset: o, label: '' })),
    channels: [], beamDeg: 20, virtualDimmer: false,
  };
  const p2 = {
    ...golden.project,
    fixtures: [{ id: 's', name: 'S', profileId: 'imported-strip', universeId: 'u1', address: 1, pos: { x: 0, y: 3, z: 0 }, rotY: 0 }],
    profiles: { 'imported-strip': strip },
  } as unknown as Project;
  const g2 = buildGeometry(p2);
  check(
    'geometry: compiled offsets consumed verbatim',
    g2.size === 4 && g2.get('s:0')?.x === -0.5 && g2.get('s:1')?.x === -0.1667 && g2.get('s:3')?.x === 0.5 && g2.get('s:2')?.along === 0.1667,
    JSON.stringify([...g2.entries()]),
  );
}

// --- spatial fan (A1): twin of core/src/effects.rs fan_tests -----------------
// Identical inputs, identical expected values, asserted f64-exact in BOTH
// engines — the cross-language contract for the fan maths.
{
  const { applyEffects } = await import('../../shared/effects.ts');
  const ext = { minX: 0, maxX: 3, minY: 2, maxY: 2, minZ: 0, maxZ: 0, cx: 1.5, cy: 2, cz: 0, maxR: 1.5 };
  const gAt = (x: number) => ({ x, y: 2, z: 0, along: 0, row: 0, col: 0, rowT: 0, colT: 0 });
  const base = {
    id: 'e', target: 'dimmer', wave: 'sawUp', rate: 1, size: 1, spread: 1, width: 0.5, phase: 0,
    bypass: false, mix: 1, distribute: 'x', fold: 'none', reverse: false, parts: 1, buddy: 1, seed: 0,
  } as import('../../shared/types.ts').Effect;
  const dims = (e: import('../../shared/types.ts').Effect) =>
    [0, 1, 2, 3].map((x, j) => applyEffects({ dimmer: 1 }, [e], 0, [0], j, 4, gAt(x), ext).dimmer);
  const eq = (a: (number | undefined)[], b: number[]) => a.length === b.length && a.every((v, i) => v === b[i]);

  check('fan: x sweep wraps at a full wavelength', eq(dims(base), [0, 0.33333333333333326, 0.6666666666666665, 0]));
  check('fan: mirror folds ends in phase toward centre', eq(dims({ ...base, fold: 'mirror' }), [0, 0.6666666666666665, 0.6666666666666667, 0]));
  check('fan: centre fold leads from the middle', eq(dims({ ...base, fold: 'centre' }), [0, 0.3333333333333335, 0.33333333333333326, 0]));
  check('fan: buddy clumps adjacent heads', eq(dims({ ...base, buddy: 2 }), [0, 0, 0.5, 0.5]));
  check('fan: parts tiles the fan', eq(dims({ ...base, parts: 2 }), [0, 0.6666666666666665, 0.33333333333333326, 0]));
  check('fan: reverse index keeps grid spacing', eq(dims({ ...base, distribute: 'index', reverse: true }), [0.75, 0.5, 0.25, 0]));
  check('fan: radial ripples from the centroid', eq(dims({ ...base, distribute: 'radial' }), [0, 0.33333333333333326, 0.33333333333333326, 0]));
  check(
    'fan: shuffle is seeded and reproducible',
    eq(dims({ ...base, distribute: 'shuffle', seed: 42 }), [0.9707432389259338, 0.6836519397329539, 0.5080116945318878, 0.5004639013204724]),
  );
  const panE = { ...base, target: 'pan', wave: 'sine', size: 0.5, spread: 0, fold: 'mirror' } as import('../../shared/types.ts').Effect;
  const pans = [0, 1, 2, 3].map((x, j) => applyEffects({}, [panE], 0.125, [0], j, 4, gAt(x), ext).pan);
  check(
    'fan: mirrored half counter-rotates pan',
    eq(pans, [0.32322330470336313, 0.32322330470336313, 0.6767766952966369, 0.6767766952966369]),
    `got ${pans.join(',')}`,
  );

  // regression: with strict t > 0.5 an even buddy grid put its far clump
  // exactly ON 0.5 and it panned WITH the near wing
  const buddyPans = [0, 1, 2, 3].map((x, j) => applyEffects({}, [{ ...panE, buddy: 2 }], 0.125, [0], j, 4, gAt(x), ext).pan);
  check(
    'fan: buddy+mirror far clump still counter-rotates',
    eq(buddyPans, [0.32322330470336313, 0.32322330470336313, 0.6767766952966369, 0.6767766952966369]),
    `got ${buddyPans.join(',')}`,
  );

  // regression: the inclusive spatial t = 1 wrapped onto t = 0 under chase's
  // forced full spread, locking the two end heads together ([1,0,0,1])
  const chaseE = { ...base, wave: 'chase', width: 0.25 } as import('../../shared/types.ts').Effect;
  const slots = [0, 1, 2, 3].map((x, j) => applyEffects({ dimmer: 1 }, [chaseE], 0.1, [0], j, 4, gAt(x), ext).dimmer);
  check('fan: chase deals distinct slots on a spatial fan', eq(slots, [1, 0, 0, 0]), `got ${slots.join(',')}`);

  // y and z sweep their own axes — heads on a diagonal where y INCREASES with
  // index and z DECREASES, so a transposed-axis typo cannot pass
  const dExt = { minX: 0, maxX: 3, minY: 2, maxY: 5, minZ: 0, maxZ: 3, cx: 1.5, cy: 3.5, cz: 1.5, maxR: 2.598076211353316 };
  const dAt = (i: number) => ({ x: i, y: 2 + i, z: 3 - i, along: 0, row: 0, col: 0, rowT: 0, colT: 0 });
  const dRun = (distribute: 'y' | 'z') =>
    [0, 1, 2, 3].map((j) => applyEffects({ dimmer: 1 }, [{ ...base, distribute }], 0, [0], j, 4, dAt(j), dExt).dimmer);
  check('fan: y sweeps its own axis', eq(dRun('y'), [0, 0.33333333333333326, 0.6666666666666665, 0]));
  check('fan: z sweeps its own axis (reversed on this rig)', eq(dRun('z'), [0, 0.6666666666666665, 0.33333333333333326, 0]));

  // col basis (B1): two 4-pixel fixtures in one 8-head group — the col basis
  // reads the per-fixture normalized colT and ignores the group index, so both
  // fixtures run the SAME wave ("grab one strobe, every strobe is the same")
  const colTs = [0, 0.333333, 0.666667, 1, 0, 0.333333, 0.666667, 1];
  const cAt = (j: number) => ({ x: j, y: 2, z: 0, along: 0, row: 0, col: j % 4, rowT: 0, colT: colTs[j] });
  const cExt = { minX: 0, maxX: 7, minY: 2, maxY: 2, minZ: 0, maxZ: 0, cx: 3.5, cy: 2, cz: 0, maxR: 3.5 };
  const colDims = [...Array(8).keys()].map((j) =>
    applyEffects({ dimmer: 1 }, [{ ...base, distribute: 'col' }], 0, [0], j, 8, cAt(j), cExt).dimmer);
  check(
    'fan: col basis fans within each fixture',
    eq(colDims, [0, 0.3333330000000001, 0.6666669999999999, 0, 0, 0.3333330000000001, 0.6666669999999999, 0]),
    `got ${colDims.join(',')}`,
  );
  check(
    'fan: col basis gives both fixtures the identical wave',
    colDims.slice(0, 4).every((v, i) => v === colDims[4 + i]),
  );
}

// --- profile-head spatial repair (B1): twin of Rust de_metres/de_index ------
{
  const p = sanitizeProject({
    ...demoProject(),
    profiles: {
      bad: {
        id: 'bad', manufacturer: 'T', model: 'Bad', mode: 'x', footprint: 3,
        heads: [{ kind: 'rgb', offset: Number.NaN, offsetY: Number.POSITIVE_INFINITY, row: 1.7, col: -3, label: 'px' }],
        channels: [], beamDeg: 20, virtualDimmer: false,
      },
    },
  } as unknown as Project)!;
  const h = p.profiles!.bad.heads[0];
  check(
    'profile heads: malformed spatial fields repair to the Rust values',
    h.offset === 0 && h.offsetY === undefined && h.row === 1 && h.col === 0,
    `got offset=${h.offset} offsetY=${h.offsetY} row=${h.row} col=${h.col}`,
  );
}

// --- auto-groups (B3 slice 1) ------------------------------------------------
{
  const { desiredAutoGroups, planAutoGroups, applyAutoGroups } = await import('../../ui/src/autoGroups.ts');
  const p = sanitizeProject(demoProject())!;
  const auto = desiredAutoGroups(p);
  const byId = new Map(auto.map((g) => [g.id, g]));
  check(
    'auto-groups: one per multi-head type, none for single heads',
    byId.has('auto-type-kam-partybar-wfs-20ch') && byId.has('auto-type-varytec-derby-st-4ch') &&
      ![...byId.keys()].some((k) => k.includes('hazer')),
    `got ${[...byId.keys()].join(', ')}`,
  );
  check(
    'auto-groups: the type group holds every head of the type in patch order',
    byId.get('auto-type-kam-partybar-wfs-20ch')!.heads.length === 8 &&
      byId.get('auto-type-kam-partybar-wfs-20ch')!.heads[0].fixtureId === 'bar1',
  );

  // rig a truss with both bars on it, bar2 to the LEFT: the truss group must
  // order along the bar, not by patch order
  const p2 = structuredClone(p);
  p2.props = [{ id: 't1', kind: 'trussBar', pos: { x: 0, z: 0 }, rotY: 0, size: { w: 7, h: 0.3, d: 0.3 }, y: 4 } as NonNullable<Project['props']>[number]];
  for (const f of p2.fixtures) {
    if (f.id === 'bar1') { f.parentId = 't1'; f.pos = { x: 1.5, y: 4, z: 0 }; }
    if (f.id === 'bar2') { f.parentId = 't1'; f.pos = { x: -1.5, y: 4, z: 0 }; }
  }
  const truss = desiredAutoGroups(p2).find((g) => g.id === 'auto-truss-t1');
  check(
    'auto-groups: truss group orders along the bar',
    !!truss && truss.heads.length === 8 && truss.heads[0].fixtureId === 'bar2' && truss.heads[4].fixtureId === 'bar1',
    truss ? `first=${truss.heads[0].fixtureId}` : 'no truss group',
  );

  // regenerate honours promotion: a renamed (untagged) group is never touched
  const p3 = structuredClone(p2);
  applyAutoGroups(p3, planAutoGroups(p3));
  const g = p3.groups.find((x) => x.id === 'auto-truss-t1')!;
  delete g.auto; // operator promoted it
  g.heads = [g.heads[0]];
  const plan = planAutoGroups(p3);
  check(
    'auto-groups: a promoted group is not updated or removed by regenerate',
    !plan.update.some((u) => u.existing.id === 'auto-truss-t1') && !plan.remove.some((x) => x.id === 'auto-truss-t1'),
  );
  // a STILL-TAGGED group whose truss vanished is removed on regenerate (the
  // promoted one above is untagged and must survive even with no source)
  const p5 = structuredClone(p2);
  applyAutoGroups(p5, planAutoGroups(p5));
  p5.props = [];
  check(
    'auto-groups: a still-tagged group with no source is removed on regenerate',
    planAutoGroups(p5).remove.some((x) => x.id === 'auto-truss-t1'),
  );

  // sanitize: a non-string tag is dropped, matching Rust's de_opt_string
  const bad = sanitizeProject({ ...demoProject(), groups: [{ id: 'g', name: 'G', heads: [], auto: 7 }] } as unknown as Project)!;
  check('auto-groups: sanitize drops a non-string tag', bad.groups[0].auto === undefined);

  // review regression: a PROMOTED group must also block re-creation under its
  // old id — a duplicate group id makes the two engines resolve different
  // memberships (Map last-wins vs iter().find() first-wins)
  const p6 = structuredClone(p2);
  applyAutoGroups(p6, planAutoGroups(p6));
  const promoted = p6.groups.find((x) => x.id === 'auto-truss-t1')!;
  delete promoted.auto;
  const plan6 = planAutoGroups(p6);
  check(
    'auto-groups: a promoted id is never re-created (no duplicate ids)',
    !plan6.create.some((g) => g.id === 'auto-truss-t1'),
  );

// --- Stage size (backlog #14): the one repair rule, and the window the views draw
{
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  check('stage: a valid size survives', same(sanitizeStage({ w: 12, d: 8, h: 6 }), { w: 12, d: 8, h: 6 }));
  check('stage: sides are clamped to the limits', same(sanitizeStage({ w: 9000, d: 0.2, h: 3 }), { w: 500, d: 1, h: 3 }));
  check('stage: a missing, wrong or non-positive side drops the field',
    sanitizeStage({ w: 10, d: 8 }) === undefined && sanitizeStage({ w: 'ten', d: 8, h: 4 }) === undefined && sanitizeStage({ w: -1, d: 8, h: 6 }) === undefined && sanitizeStage(null) === undefined);
  const kept = sanitizeProject({ ...demoProject(), stage: { w: 12, d: 8, h: 6 } })!;
  check('stage: sanitizeProject keeps a good one', kept.stage?.w === 12 && kept.stage?.h === 6);
  const dropped = sanitizeProject({ ...demoProject(), stage: { w: 12, d: 8 } } as unknown as Project)!;
  check('stage: sanitizeProject drops a bad one', dropped.stage === undefined);
  const empty = stageExtent({ fixtures: [], props: [], stage: undefined });
  check('extent: nothing placed shows the default window', empty.x0 === -5.5 && empty.x1 === 5.5 && empty.z0 === -3 && empty.z1 === 6 && empty.yTop === 7 && !empty.manual);
  const far = stageExtent({ fixtures: [{ ...kept.fixtures[0], pos: { x: 18, y: 10, z: -2 } }], props: [], stage: undefined });
  check('extent: grows to hold a far fixture, with the margin, on whole metres', far.x1 === 21 && far.yTop === 13 && far.x0 === -5.5 && far.z0 === -5, JSON.stringify(far));
  const prop = stageExtent({ fixtures: [], props: [{ id: 'p', kind: 'trussBar', pos: { x: 0, z: 0 }, size: { w: 30, h: 0.3, d: 0.3 }, y: 9 }], stage: undefined });
  check('extent: a wide bar reaches by half its width, and its top counts', prop.x0 === -18 && prop.x1 === 18 && prop.yTop === 13, JSON.stringify(prop));
  const manual = stageExtent({ fixtures: kept.fixtures, props: [], stage: { w: 20, d: 12, h: 8 } });
  check('extent: a manual stage is the window, with a metre of apron', manual.manual && manual.x0 === -11 && manual.x1 === 11 && manual.z0 === -7 && manual.z1 === 7 && manual.yTop === 9, JSON.stringify(manual));
}

// --- Engine-side undo: one history per engine (backlog #12, review M16).
// --- Mirrors history_tests in core/src/state.rs; parity holds the two to it.
{
  const st = new EngineState(sanitizeProject(demoProject())!);
  const edited = (f: (p: Project) => void): Project => { const p = structuredClone(st.project); f(p); return p; };
  const write = (p: Project, label: string, owner: number, coalesce: boolean) => { st.recordEdit(label, owner, coalesce); st.updateProject(p); };
  const name0 = st.project.name;
  write(edited((p) => { p.name = 'Renamed'; }), 'rename the show', 7, false);
  check('undo: names the step', st.undoLabel() === 'rename the show', `got ${st.undoLabel()}`);
  check('undo: reverts the write', st.undo() && st.project.name === name0);
  check('redo: names the step', st.redoLabel() === 'rename the show');
  check('redo: restores the write', st.redo() && st.project.name === 'Renamed');
  check('redo: nothing left', !st.redo());

  // a drag is one step, but only for its own client
  const fade0 = st.project.layers[0].fade;
  write(edited((p) => { p.layers[0].fade = 0.1; }), 'fade of Layer 1', 1, false);
  write(edited((p) => { p.layers[0].fade = 0.2; }), 'fade of Layer 1', 1, true);
  write(edited((p) => { p.layers[0].fade = 0.3; }), 'fade of Layer 1', 1, true);
  check('coalesce: a continuing write joins the open step', st.history.length === 2, `depth ${st.history.length}`);
  write(edited((p) => { p.layers[0].fade = 0.4; }), 'fade of Layer 1', 2, true);
  check("coalesce: never into another client's step", st.history.length === 3, `depth ${st.history.length}`);
  st.undo();
  check("coalesce: undo lands on the other client's value", st.project.layers[0].fade === 0.3, `got ${st.project.layers[0].fade}`);
  st.undo();
  check('coalesce: the drag undoes as one', st.project.layers[0].fade === fade0, `got ${st.project.layers[0].fade}`);
  write(edited((p) => { p.layers[0].fade = 0.5; }), 'fade of Layer 1', 1, true);
  check('coalesce: never across an undo', st.history.length === 2 && st.redone.length === 0);

  // a song switch is not a step, and undo keeps the song you are on
  const deck1 = st.project.activeDeckId!;
  const deck2 = st.project.decks![1].id;
  const layer = st.project.layers[0].id;
  const cell0 = st.project.layers[0].cells[0];
  write(edited((p) => { p.layers[0].cells[0] = 'look-x'; }), 'place a pad', 1, false);
  const steps = st.history.length;
  st.switchDeck(deck2);
  check('song switch: not a step', st.history.length === steps);
  const page2 = JSON.stringify(st.project.layers[0].cells);
  st.undo();
  check('undo: keeps the song you are on', st.project.activeDeckId === deck2, `on ${st.project.activeDeckId}`);
  check('undo: the page on screen is untouched', JSON.stringify(st.project.layers[0].cells) === page2);
  check("undo: song 1's pad is back", st.project.decks!.find((d) => d.id === deck1)!.cells[layer][0] === cell0);

  // what is played stays where it is
  write(edited((p) => { p.name = 'x'; }), 'rename the show', 1, false);
  st.project.layers[0].master = 0.25;
  st.project.settings.haze = 0.6;
  st.undo();
  check('undo: keeps the layer master', st.project.layers[0].master === 0.25);
  check('undo: keeps the haze', st.project.settings.haze === 0.6);

  // capped, and cleared with the project
  for (let i = 0; i < HISTORY_CAP + 5; i++) write(edited((p) => { p.name = `n${i}`; }), 'rename the show', 1, false);
  check('history: capped', st.history.length === HISTORY_CAP, `depth ${st.history.length}`);
  st.replaceProject(sanitizeProject(demoProject())!);
  check('history: cleared with the project', st.history.length === 0 && st.redone.length === 0 && !st.undo());
}


  // review regression: tagged names are machine-owned — a regenerate refreshes
  // a stale generated name (renaming untags, so no operator name is at risk)
  const p7 = structuredClone(p2);
  applyAutoGroups(p7, planAutoGroups(p7));
  p7.groups.find((x) => x.id === 'auto-truss-t1')!.name = 'Truss 9'; // stale
  const plan7 = planAutoGroups(p7);
  check(
    'auto-groups: a stale generated name is refreshed on regenerate',
    plan7.update.some((u) => u.existing.id === 'auto-truss-t1' && u.name === 'Truss 1'),
  );
}

console.log(failures === 0 ? '\nAll engine smoke tests passed.' : `\n${failures} test(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
