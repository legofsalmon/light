// Engine smoke test — no framework, exits non-zero on failure.
// Verifies: OSC parsing, look merge → DMX bytes, masters/blackout,
// flash release, column cue semantics, clock, and a real Art-Net
// packet over loopback.

import dgram from 'node:dgram';
import { EngineState } from '../state.ts';
import { Renderer } from '../renderer.ts';
import fs from 'node:fs';
import path from 'node:path';
import type { Project } from '../../shared/types.ts';
import { sanitizeProject } from '../../shared/types.ts';
import type { ShareList } from '../../shared/gdtfShare.ts';
import { hasUndrivenBeamChannels, isAcceptableList, isPlaceholderProfile, parseGdtfSpec, rankMatches } from '../../shared/gdtfShare.ts';

/** The demo show these tests were written against — five fixtures at known
 *  addresses, looks with known ids. Deliberately NOT the shipped default: that
 *  is a real 20-song set list now, and pinning byte assertions to its artistic
 *  content means editing a song looks like an engine regression. */
const demoProject = (): Project =>
  JSON.parse(fs.readFileSync(path.join(process.cwd(), 'core/tests/data/demo_project.json'), 'utf8'));
import { MAX_THROW, buildOccluders, hitsPropFootprint, throwDistance, type Occluder } from '../../shared/beamThrow.ts';
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
  ) as { project: Project; expected: Record<string, { x: number; y: number; z: number; along: number; row: number; col: number }> };
  const geom = buildGeometry(golden.project);
  const keys = Object.keys(golden.expected);
  check('geometry: golden head count', geom.size === keys.length, `got ${geom.size}, want ${keys.length}`);
  let bad = '';
  for (const key of keys) {
    const g = geom.get(key);
    const want = golden.expected[key];
    if (!g) { bad = `${key} missing`; break; }
    // exact f64 equality — quantization is the tolerance
    if (g.x !== want.x || g.y !== want.y || g.z !== want.z || g.along !== want.along || g.row !== want.row || g.col !== want.col) {
      bad = `${key}: got ${JSON.stringify(g)}, want ${JSON.stringify(want)}`;
      break;
    }
  }
  check('geometry: golden vectors match exactly', bad === '', bad);
  check(
    'geometry: unknown profile gets no entry',
    ![...geom.keys()].some((k) => k.startsWith('ghost:')),
  );

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

console.log(failures === 0 ? '\nAll engine smoke tests passed.' : `\n${failures} test(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
