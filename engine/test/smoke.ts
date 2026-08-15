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

/** The demo show these tests were written against — five fixtures at known
 *  addresses, looks with known ids. Deliberately NOT the shipped default: that
 *  is a real 20-song set list now, and pinning byte assertions to its artistic
 *  content means editing a song looks like an engine regression. */
const demoProject = (): Project =>
  JSON.parse(fs.readFileSync(path.join(process.cwd(), 'core/tests/data/demo_project.json'), 'utf8'));
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
  const st = new EngineState(demoProject());
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
    const st = new EngineState(demoProject());
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

console.log(failures === 0 ? '\nAll engine smoke tests passed.' : `\n${failures} test(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
