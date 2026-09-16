// Engine smoke test — no framework, exits non-zero on failure.
// Verifies: OSC parsing, look merge → DMX bytes, masters/blackout,
// flash release, column cue semantics, clock, and a real Art-Net
// packet over loopback.

import dgram from 'node:dgram';
import { EngineState, HISTORY_CAP } from '../state.ts';
import { Renderer } from '../renderer.ts';
import fs from 'node:fs';
import path from 'node:path';
import type { Project, SoftField } from '../../shared/types.ts';
import { discardFade } from '../../ui/src/discardFade.ts';
import { applyRetune, onPalette, palettesOf, playingColourParts, retunePlan } from '../../ui/src/palettes.ts';
import { sanitizeProject, sanitizeStage } from '../../shared/types.ts';
import { stageExtent } from '../../shared/stageExtent.ts';
import type { ShareList } from '../../shared/gdtfShare.ts';
import { hasUndrivenBeamChannels, isAcceptableList, isPlaceholderProfile, isStaleProfile, parseGdtfSpec, rankMatches } from '../../shared/gdtfShare.ts';
import { COMPILER_VERSION, fadeScaleAt } from '../../shared/types.ts';
import type { EffectTarget, MidiMapping, Snapshot } from '../../shared/types.ts';
import { APC40_COLUMN_ROW, APC40_MK2, APC_COLS, APC_LAYER_ROWS, APC_MINI_MK2, SURFACES, clearAddresses, computeLeds, ledChannel, ledKey, ledNote, nearest } from '../../ui/src/surfaces.ts';
import { CONTROLLER_PRESETS, apc40Mk2Mappings, apcMiniMk2Mappings } from '../../ui/src/controllerPresets.ts';
import { lookFace, lookSwatch } from '../../ui/src/lookColors.ts';
import { describeLearned } from '../../ui/src/labels.ts';

/** The demo show these tests were written against — five fixtures at known
 *  addresses, looks with known ids. Deliberately NOT the shipped default: that
 *  is a real 20-song set list now, and pinning byte assertions to its artistic
 *  content means editing a song looks like an engine regression. */
const demoProject = (): Project =>
  JSON.parse(fs.readFileSync(path.join(process.cwd(), 'core/tests/data/demo_project.json'), 'utf8'));
import { readFileSync } from 'node:fs';
import { MAX_THROW, buildOccluders, hitsPropFootprint, standingHeightAt, throwDistance, type Occluder } from '../../shared/beamThrow.ts';
import { FreezeHold, GO_DARK_FRAMES, OutputGate } from '../output.ts';
import { aimIsIdentity, applyAim } from '../../shared/aim.ts';
import { blendSoft, shapeAmps, shapeAt, softReleaseWeight } from '../../shared/effects.ts';
import { BUILTIN_PROFILE_IDS, SHAPE_KINDS } from '../../shared/types.ts';
import { PROFILES } from '../../shared/profiles.ts';
import { FX_CATEGORIES, FX_LIBRARY, fxSearch, unusable } from '../../ui/src/fxLibrary.ts';
import { SHORTCUTS, SHORTCUT_GROUPS, runShortcut } from '../../ui/src/shortcuts.ts';
import { GESTURES, GESTURE_GROUPS } from '../../ui/src/gestures.ts';
import { qrCode } from '../../ui/src/qr.ts';
import { repairEffect } from '../../shared/types.ts';
import { parseOsc } from '../osc.ts';
import { ArtnetOut } from '../artnet.ts';
import { BAR } from '../../shared/types.ts';
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

  // setTempoAndBeat is the beat clock's entry point, and the twin of
  // core/src/clock.rs. Pinned here so the two cannot drift apart: the tests
  // are deliberately the same three the Rust module asserts.
  const f = new BeatClock();
  f.setBpm(120, 0);
  const held = f.beatAt(1234);
  f.setBpm(174, 1234);
  check('a tempo change on its own does not move the beat', Math.abs(f.beatAt(1234) - held) < 1e-9, `got ${f.beatAt(1234)}`);
  f.setTempoAndBeat(128, 4, 5000);
  check('a start lands tempo and downbeat together', f.bpm === 128 && Math.abs(f.beatAt(5000) - 4) < 1e-9, `${f.bpm} @ ${f.beatAt(5000)}`);
  check('and runs on from there at the new tempo', Math.abs(f.beatAt(5000 + 60000 / 128) - 5) < 1e-9, `got ${f.beatAt(5000 + 60000 / 128)}`);
  f.setTempoAndBeat(Infinity, 0, 6000);
  f.setTempoAndBeat(NaN, 0, 6000);
  f.setTempoAndBeat(120, NaN, 6000);
  check('a tempo that is not a tempo is refused rather than stored', f.bpm === 128 && Number.isFinite(f.beatAt(6000)), `got ${f.bpm}`);
  f.setTempoAndBeat(9999, 0, 6000);
  check('and the clock floor and ceiling still apply (high)', f.bpm === 500, `got ${f.bpm}`);
  f.setTempoAndBeat(1, 0, 6000);
  check('and the clock floor and ceiling still apply (low)', f.bpm === 20, `got ${f.bpm}`);
}

// ---------- control-surface LEDs: the browser map, held against the Rust one ----------
{
  // ui/src/surfaces.ts and core/src/apc.rs must paint the same picture from the
  // same state, and until the pure map was split out of apcFeedback.ts nothing
  // checked that. These are the same assertions the Rust module makes, in the
  // same order, so a change to one that is not made to the other fails here.
  const OFFBEAT = 4.5; // tap pulse out of the way
  const surfaceProject = (): Project => {
    const p = sanitizeProject(demoProject())!;
    return p;
  };
  const snapOf = (
    live: { id: string; lookId: string | null; col: number | null }[],
    extra: Partial<Snapshot> = {},
  ): Snapshot =>
    ({
      beat: OFFBEAT,
      blackout: false,
      layers: live.map((l) => ({ ...l, prevId: null, t: 1 })),
      ...extra,
    }) as Snapshot;

  const p = surfaceProject();
  const top = p.layers[p.layers.length - 1];
  const lookId = Object.keys(p.looks)[0];
  top.cells[0] = lookId;
  top.cells[1] = lookId;

  const idle = snapOf([]);
  const playing = snapOf([{ id: top.id, lookId, col: 0 }]);

  // idle: no layer buttons, no blackout blink, everything on channel 0 for the
  // APC40, every velocity a legal palette index
  const big = computeLeds(p, idle, APC40_MK2);
  check('surface: no layer button lit while idle',
    ![82, 83, 84, 85, 86].some((n) => big.has(ledKey(0, n))));
  // The APC40 paints the GRID on channel 0 — but not the CLIP STOP row, where
  // the channel is the track, so "everything on channel 0" is no longer the
  // whole truth and saying it that way would have meant lighting the cue row on
  // the wrong buttons. What still holds: a button is sent on the channel it is
  // addressed by, with a legal velocity.
  check(
    'surface: the APC40 paints the grid on channel 0 and CLIP STOP on its track channel',
    [...big.entries()].every(([key, [ch, v]]) => {
      if (v <= 0 || v >= 128) return false;
      if (ch !== ledChannel(key)) return false; // sent on the channel it is addressed by
      return ledNote(key) === APC40_COLUMN_ROW.note
        ? APC40_COLUMN_ROW.channels.includes(ledChannel(key))
        : ledChannel(key) === 0;
    }),
  );

  // the same decision, two encodings
  const bigLive = computeLeds(p, playing, APC40_MK2);
  const miniLive = computeLeds(p, playing, APC_MINI_MK2);
  const bigPad = (n: number) => bigLive.get(ledKey(0, n))!;
  const miniPad = (n: number) => miniLive.get(ledKey(0, n))!;
  check('surface: APC40 separates playing from available by palette index',
    bigPad(32)[0] === 0 && bigPad(33)[0] === 0 && bigPad(32)[1] !== bigPad(33)[1],
    JSON.stringify([bigPad(32), bigPad(33)]));
  check('surface: the mini separates them by channel, not colour',
    miniPad(56)[1] === miniPad(57)[1] && miniPad(56)[0] === 6 && miniPad(57)[0] === 1,
    JSON.stringify([miniPad(56), miniPad(57)]));
  check('surface: the mini uses the full-brightness hue', miniPad(56)[1] === bigPad(32)[1]);

  // the channel alone can be the whole change, which is why the diff holds it
  const miniIdle = computeLeds(p, idle, APC_MINI_MK2);
  // ...and it stays ONE key while it does: the address identifies the button,
  // the brightness channel rides in the value.
  check('surface: playing changes only the channel on the mini',
    miniIdle.get(ledKey(0, 56))![1] === miniPad(56)[1]
      && miniIdle.get(ledKey(0, 56))![0] !== miniPad(56)[0],
    JSON.stringify([miniIdle.get(ledKey(0, 56)), miniPad(56)]));

  // a live column holding a different look still reports the stage
  const other = Object.keys(p.looks)[1];
  const repointed = surfaceProject();
  repointed.layers[repointed.layers.length - 1].cells[0] = other;
  const stale = computeLeds(repointed, playing, APC40_MK2).get(ledKey(0, 32));
  check('surface: a re-pointed live pad still reports what is on stage',
    JSON.stringify(stale) === JSON.stringify(bigPad(32)), JSON.stringify(stale));

  // the APC40's bottom row belongs to the control row
  const fifth = surfaceProject();
  fifth.layers.unshift({ ...fifth.layers[0], id: 'layer-fifth', cells: [lookId] } as never);
  const capped = computeLeds(fifth, idle, APC40_MK2);
  check('surface: a fifth layer never steals the control row',
    ![0, 1, 2, 3, 4, 5, 6, 7].some((n) => capped.has(ledKey(0, n))));

  // The column row reports the whole column. BOTH surfaces have one now — the
  // mini's bottom pad row and the APC40's CLIP STOP row — addressed differently
  // and encoded differently, from one rule.
  const colProject = surfaceProject();
  for (const l of colProject.layers) l.cells[0] = lookId;
  const colSnap = (n: number) =>
    snapOf(colProject.layers.slice(colProject.layers.length - n).map((l) => ({ id: l.id, lookId, col: 0 })));
  const miniCol = (snap: Snapshot) => computeLeds(colProject, snap, APC_MINI_MK2).get(ledKey(0, 0));
  const clipStop = (snap: Snapshot, col: number) =>
    computeLeds(colProject, snap, APC40_MK2).get(ledKey(APC40_COLUMN_ROW.channels[col], APC40_COLUMN_ROW.note));
  const up = colSnap(colProject.layers.length);
  const held = miniCol(idle);
  check('surface: a column holding content reads dim', JSON.stringify(held) === JSON.stringify([1, 3]), JSON.stringify(held));
  check('surface: the whole column up reads bright',
    JSON.stringify(miniCol(up)) === JSON.stringify([6, 3]), JSON.stringify(miniCol(up)));
  check('surface: a partly-up column reads as not up',
    JSON.stringify(miniCol(colSnap(colProject.layers.length - 1))) === JSON.stringify(held));
  // the APC40's row is single-colour, so the same rule says the half it can:
  // lit while the column is on stage, dark otherwise
  check('surface: CLIP STOP is dark until the column is on stage', clipStop(idle, 0) === undefined);
  check('surface: CLIP STOP lights on the column that is up',
    JSON.stringify(clipStop(up, 0)) === JSON.stringify([0, 1]), JSON.stringify(clipStop(up, 0)));
  check('surface: and only that column — the eight buttons differ by channel, not note',
    [1, 2, 3, 4, 5, 6, 7].every((col) => clipStop(up, col) === undefined));
  check('surface: a partly-up column leaves CLIP STOP dark',
    clipStop(colSnap(colProject.layers.length - 1), 0) === undefined);

  // tap pulses once a beat and is never skipped
  for (const surface of SURFACES) {
    const lit = (beat: number) => computeLeds(p, snapOf([], { beat }), surface).has(ledKey(0, surface.tap));
    check(`surface: ${surface.name} tap lights on the beat`, lit(0) && lit(4.05));
    check(`surface: ${surface.name} tap is dark between beats`, !lit(0.5) && !lit(0.99));
  }

  // The palette anchors and the note tables are LITERAL DATA duplicated in
  // core/src/apc.rs and ui/src/surfaces.ts. Every assertion above is a
  // property, and a property passes happily while one side has a typo in a
  // palette index — the two would simply light different colours on the same
  // look. This holds both against one file. Regenerate with
  // LIGHT_BLESS_GOLDEN=1 cargo test -p light-core the_palette_and_note.
  {
    const golden = JSON.parse(
      fs.readFileSync(new URL('../../core/tests/data/surface-leds.json', import.meta.url), 'utf8'),
    ) as {
      surfaces: Record<string, unknown>[];
      nearest: [string, number, number][];
    };
    const mine = SURFACES.map((s) => ({
      name: s.name,
      matches: s.matches,
      layerBase: s.layerBase,
      sceneBase: s.sceneBase,
      blackout: s.blackout,
      tap: s.tap,
      columnBase: s.columnBase ?? null,
      columnRow: s.columnRow ?? null,
      brightChannels: s.brightChannels ?? null,
      clear: s.clear,
    }));
    check('surface: note tables match the Rust golden',
      JSON.stringify(mine) === JSON.stringify(golden.surfaces), JSON.stringify(mine));
    const drift = golden.nearest.filter(([hex, bright, dim]) => {
      const got = nearest(hex);
      return got.bright !== bright || got.dim !== dim;
    });
    check('surface: the palette matches the Rust golden', drift.length === 0,
      drift.map(([hex]) => `${hex} → ${JSON.stringify(nearest(hex))}`).join(' '));
  }

  // A button that lights up has to DO the thing its light claims. The LED
  // tables (surfaces.ts) and the input presets (controllerPresets.ts) were
  // written months apart in different files, and nothing tied them together:
  // move the blackout LED and the surface would blink "armed" over a button
  // that clears a layer.
  {
    const presets: [string, MidiMapping[], typeof APC40_MK2][] = [
      ['APC40 mk2', apc40Mk2Mappings(p), APC40_MK2],
      ['APC mini mk2', apcMiniMk2Mappings(p), APC_MINI_MK2],
    ];
    for (const [name, maps, surface] of presets) {
      // The channel is part of the address now, not just the number: the
      // APC40's eight CLIP STOP buttons all carry note 52 and differ only by
      // it, so a lookup by number alone would find the first of the eight and
      // call every column correct.
      const noteAction = (n: number, channel = 0) =>
        maps.find((m) => m.type === 'note' && m.number === n && m.channel === channel)?.action;
      check(`preset: ${name} tap LED sits on the tap button`,
        noteAction(surface.tap)?.kind === 'tap', JSON.stringify(noteAction(surface.tap)));
      check(`preset: ${name} blackout LED sits on the blackout button`,
        noteAction(surface.blackout)?.kind === 'blackout', JSON.stringify(noteAction(surface.blackout)));
      const visual = [...p.layers].reverse().slice(0, APC_LAYER_ROWS);
      const layerButtons = visual.every((l, row) => {
        const a = noteAction(surface.sceneBase + row);
        return a?.kind === 'layerClear' && a.layerId === l.id;
      });
      check(`preset: ${name} layer LEDs sit on that layer's clear button`, layerButtons);
      const padsAgree = visual.every((l, row) =>
        [...Array(APC_COLS).keys()].every((col) => {
          const a = noteAction(surface.layerBase - row * 8 + col);
          return a?.kind === 'cell' && a.layerId === l.id && a.col === col;
        }),
      );
      check(`preset: ${name} pad LEDs sit on that pad`, padsAgree);
      // Both surfaces fire columns; they just address the row differently —
      // eight notes on one channel (the mini's pad row), or one note on eight
      // channels (the APC40's CLIP STOP row).
      const columnButton = (col: number): [number, number] | null =>
        surface.columnRow
          ? [surface.columnRow.channels[col], surface.columnRow.note]
          : surface.columnBase !== undefined
            ? [0, surface.columnBase + col]
            : null;
      check(`preset: ${name} has a column row at all`, columnButton(0) !== null);
      const colsAgree = [...Array(APC_COLS).keys()].every((col) => {
        const at = columnButton(col);
        if (!at) return false;
        const a = noteAction(at[1], at[0]);
        return a?.kind === 'column' && a.col === col;
      });
      check(`preset: ${name} column LEDs sit on that column`, colsAgree);
      if (surface.columnBase === undefined) {
        // the APC40's bottom GRID row is left unmapped for the control row, so
        // nothing there may light either — its cues live on CLIP STOP, which is
        // not part of the 5 x 8 grid
        check(`preset: ${name} leaves the control row unmapped and unlit`,
          [...Array(APC_COLS).keys()].every((n) => noteAction(n) === undefined));
      }
    }
    // SYNC on a controller means what the SYNC key means, or the effects are
    // left behind by the resync that was supposed to move them.
    {
      const apc = apc40Mk2Mappings(p);
      const syncs = apc.filter((m) => m.action.kind === 'sync');
      check('preset: APC40 mk2 binds METRONOME to sync', syncs.length === 1
        && syncs[0].type === 'note' && syncs[0].number === 90 && syncs[0].channel === 0,
        JSON.stringify(syncs));
      // and nothing else may sit on the CLIP STOP row, or a GO would fire two
      // things at once
      const stop = apc.filter((m) => m.type === 'note' && m.number === 52);
      check('preset: the CLIP STOP row fires columns and nothing else',
        stop.length === APC_COLS && stop.every((m) => m.action.kind === 'column'),
        JSON.stringify(stop.map((m) => [m.channel, m.action])));
    }

    // The table the Sync section and the DIALS head's controller menu read has
    // to be the same list tested above, or a layout added to the table ships
    // without ever being held against the LED map it will light.
    const sig = (m: MidiMapping[]) => JSON.stringify(m.map((x) => [x.type, x.channel, x.number, x.action]));
    check('preset: the controller table is the list tested here',
      CONTROLLER_PRESETS.map((c) => c.label).join('|') === presets.map(([n]) => n).join('|'),
      CONTROLLER_PRESETS.map((c) => c.label).join('|'));
    check('preset: each entry builds the mappings its own function builds',
      CONTROLLER_PRESETS.every((c, i) => sig(c.build(p)) === sig(presets[i][1])));

    // A learn says what it bound, in the words the rest of the app uses for the
    // same thing (design 2.10) — not "mapped".
    const bound = apc40Mk2Mappings(p).find((m) => m.action.kind === 'cell')!;
    const layer = p.layers.find((l) => l.id === (bound.action as { layerId: string }).layerId)!;
    const col = (bound.action as { col: number }).col;
    check('learn: the confirmation names the pair in the app\'s words',
      describeLearned(p, bound).startsWith(`note ${bound.number} → ${layer.name} · pad ${col + 1}`),
      describeLearned(p, bound));
  }

  // --- what a mapped button does when it is pressed, and when it is let go ---
  // A mapping that fires a column is a CUE, and the one thing a cue may never
  // do is go off on its own. The three ways it could: a note OFF resolving as a
  // press, a bank change landing on the same number, and the attach-time LED
  // blank (a note-on with velocity 0) coming back round a loopback port. All
  // three are the same note-off shape, so this pins the shape.
  {
    const cue = sanitizeProject(demoProject())!;
    cue.midi = [
      { id: 'm-col', type: 'note', channel: 3, number: 52, action: { kind: 'column', col: 3 } },
      { id: 'm-sync', type: 'note', channel: 0, number: 90, action: { kind: 'sync' } },
    ];
    const st = new EngineState(cue);
    const livePads = () => [...st.live.values()].filter((l) => l.col !== null).length;
    st.applyMidi(0x83, 52, 0); // note off, CLIP STOP under column 4
    check('midi: a note off never fires a column', livePads() === 0);
    st.applyMidi(0x93, 52, 0); // note ON, velocity 0 — the attach-time LED blank
    check('midi: a zero-velocity note on never fires a column either', livePads() === 0);
    st.applyMidi(0x90, 52, 127); // the same number on the wrong channel
    check('midi: the column button is (channel, note), not note', livePads() === 0);
    st.applyMidi(0x93, 52, 127);
    check('midi: CLIP STOP on its own channel fires the column', livePads() > 0);

    // SYNC asks for the bar as well as the clock — the whole point of the kind.
    check('midi: a mapped SYNC asks the renderer for a bar', st.applyMidi(0x90, 90, 127) === BAR);
    check('midi: letting SYNC go asks for nothing', st.applyMidi(0x80, 90, 0) === null);
    check('midi: firing a column asks for nothing', st.applyMidi(0x93, 52, 127) === null);
    check('midi: an unmapped note asks for nothing', st.applyMidi(0x90, 52, 127) === null);
  }

  // every note the map can produce must be inside the ranges attach blanks
  const busy = surfaceProject();
  for (const l of busy.layers) for (let c = 0; c < 8; c++) l.cells[c] = lookId;
  const loud = snapOf(busy.layers.map((l) => ({ id: l.id, lookId, col: 0 })), { beat: 0, blackout: true });
  for (const surface of SURFACES) {
    const leds = computeLeds(busy, loud, surface);
    check(`surface: ${surface.name} exercises tap and blackout`,
      leds.has(ledKey(0, surface.tap)) && leds.has(ledKey(0, surface.blackout)));
    // by ADDRESS, not by note: the CLIP STOP row is eight buttons the old
    // channel-0 note ranges could not have reached at all
    const blanked = new Set(clearAddresses(surface).map(([ch, n]) => ledKey(ch, n)));
    const stray = [...leds.keys()].filter((key) => !blanked.has(key));
    check(`surface: ${surface.name} lights only buttons it blanks on attach`, stray.length === 0,
      `stray ${stray.map((k) => `ch${ledChannel(k)} note${ledNote(k)}`).join(',')}`);
  }
}

// ---------- the pad's two readings: the stripe the hardware mirrors, and the
//            rig miniature the screen draws (design #30) ----------
//
// `lookFace` is a SECOND reading of a look, added beside `lookSwatch` rather
// than replacing it. The browser LED mirror reads `lookSwatch(...)[0]`
// (surfaces.ts) and core/src/apc.rs re-implements that first-colour rule by
// hand as `swatch_first` — nothing reads the other's code, so a quiet change
// to the swatch would light the APC a different colour from the pad under the
// same look, with the golden in apc.rs the only thing between the two.
//
// This holds the swatch itself: every look in the shipped show, hashed. It is
// pinned to that show's artistic content on purpose — the looks are the data
// the rule is exercised against — so if the set list changes deliberately, the
// failure prints the new digest to record here. A change nobody meant is the
// case it exists for.
{
  const shipped = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'shared/defaultProject.json'), 'utf8'),
  ) as Project;
  const ids = Object.keys(shipped.looks).sort();
  const swatchOf = (id: string) => lookSwatch(shipped.looks[id], shipped.looks).join(' ');
  const before = ids.map(swatchOf);
  // FNV-1a, so the recorded value is short enough to read in a diff
  const digest = (s: string) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  };
  const got = digest(ids.map((id, i) => `${id}|${before[i]}`).join('\n'));
  check(
    'look colours: the swatch of every look in the shipped show is unchanged',
    got === 'f0355f94' && ids.length === 190,
    `${ids.length} looks, digest ${got} — if the set list changed on purpose, record this digest`,
  );

  // And the face never becomes the swatch: they are memoised separately, and
  // asking for one must not disturb the other.
  for (const id of ids) lookFace(shipped.looks[id], shipped);
  check(
    'look colours: drawing the face leaves the swatch byte-identical',
    ids.every((id, i) => swatchOf(id) === before[i]),
  );
  check(
    'look colours: the face never lands on a group that is not in the rig',
    ids.every((id) =>
      lookFace(shipped.looks[id], shipped).marks.every((m) => shipped.groups.some((g) => g.id === m.groupId)),
    ),
  );
}

// ---------- SYNC lands on a bar, in both engines ----------
{
  // The bug: effects run on effBeat / rate, so a rate-4 effect tops out where
  // effBeat is a multiple of 4. Rounding to the nearest BEAT left it 0.5 or
  // 0.75 through its cycle from every start tried, which is why SYNC appeared
  // to do nothing to anything slower than a quarter note. Same assertions as
  // core/src/renderer.rs, so the two cannot drift.
  const r = new Renderer(new EngineState(demoProject()));
  for (const start of [7.3, 5.9, 2.4, 10.1, 0.2, 13.75]) {
    r.pinClock(start);
    r.alignPhase(BAR);
    const eff = r.readEffBeat();
    const off = [1, 2, 4, 0.5].map((rate) => Math.abs(((eff / rate) % 1 + 1) % 1)).filter((p) => p > 1e-9);
    check(`sync: a bar-long effect tops out from ${start}`, off.length === 0, `eff ${eff}`);
  }
  for (const start of [7.3, 5.9, 2.4]) {
    r.pinClock(start);
    r.alignPhase(1);
    check(`tap: still lands on the beat tapped from ${start}`, r.readEffBeat() === Math.round(start), `got ${r.readEffBeat()}`);
  }
  for (const bad of [0, -4, NaN, Infinity]) {
    r.pinClock(5.9);
    r.alignPhase(bad);
    check(`sync: a nonsense grid (${bad}) falls back to a beat`, r.readEffBeat() === 6, `got ${r.readEffBeat()}`);
  }
  // and the musical clock lands on a bar line, not just any beat
  const c = new BeatClock();
  c.setBpm(120, 0);
  for (const at of [1234, 2500, 9001]) {
    c.resync(at);
    const beat = c.beatAt(at);
    check(`sync: the beat count lands on a bar line at ${at}`, Math.abs(((beat % BAR) + BAR) % BAR) < 1e-9, `beat ${beat}`);
  }
}

// ---------- beat clock: the project flag, which is all this engine carries ----------
{
  // The follower itself is native-only (a browser cannot see a timestamp worth
  // averaging), exactly like Link. What BOTH engines must agree on is the
  // project shape and the rule that only one thing drives the tempo — a client
  // has to get the same project back whichever engine it is talking to.
  const p = sanitizeProject(demoProject())!;
  check('beat clock: off in a repaired project', p.sync.midiClockEnabled === false, String(p.sync.midiClockEnabled));
  const stripped = demoProject() as unknown as { sync: Record<string, unknown> };
  delete stripped.sync.midiClockEnabled;
  check('beat clock: an older project gets the field back', sanitizeProject(stripped as unknown as Project)!.sync.midiClockEnabled === false);
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
  // The importer stamps its version too — what catches a gobo wheel compiled
  // before LIGHT could drive one, which the name check cannot tell from a
  // wheel LIGHT still leaves alone.
  check('stale: a profile with no compiler stamp is behind this build', isStaleProfile({}));
  check('stale: a profile stamped by this build is current', !isStaleProfile({ compiler: COMPILER_VERSION }));
  check('stale: a profile stamped by a newer build is not offered a rebuild', !isStaleProfile({ compiler: COMPILER_VERSION + 1 }));
}

// --- optics params are read the way Rust's de_slot / de_strobe_mode read them
{
  const raw = demoProject();
  const look = Object.values(raw.looks)[0]!;
  look.parts[0].params = { gobo: 2.4, prism: -1, strobeMode: 'bogus', goboRotate: 0.3 } as unknown as Project['looks'][string]['parts'][number]['params'];
  const prm = sanitizeProject(raw)!.looks[look.id].parts[0].params;
  check('sanitize: a wheel slot is rounded to a whole slot', prm.gobo === 2, `gobo=${prm.gobo}`);
  check('sanitize: a negative slot is dropped', prm.prism === undefined, `prism=${prm.prism}`);
  check('sanitize: an unknown shutter pattern is dropped', prm.strobeMode === undefined, `strobeMode=${prm.strobeMode}`);
  check('sanitize: a rotation passes through', prm.goboRotate === 0.3);
  // the flower spin is a rotation like the wheel spins: numeric, untouched
  const raw2 = demoProject();
  const look2 = Object.values(raw2.looks)[0]!;
  look2.parts[0].params = { flower: 0.75 } as unknown as Project['looks'][string]['parts'][number]['params'];
  look2.parts[0].effects = [{ ...look2.parts[0].effects[0] ?? {}, id: 'fx-flower', target: 'flower', wave: 'sine', rate: 4, size: 1, spread: 0, width: 0.5, phase: 0, bypass: false, mix: 1, distribute: 'index', fold: 'none', reverse: false, parts: 1, buddy: 1, seed: 0 } as never];
  const fixed = sanitizeProject(raw2)!.looks[look2.id].parts[0];
  check('sanitize: flower spin passes through', fixed.params.flower === 0.75, `flower=${fixed.params.flower}`);
  check('sanitize: flower is an effect target repairEffect keeps', fixed.effects.length === 1 && fixed.effects[0].target === 'flower', JSON.stringify(fixed.effects.map((e) => e.target)));
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

// --- the transmit gate: what actually reaches the wire (backlog #1) ---------
// Mirrors the unit tests in core/src/output.rs. The two engines must decide
// identically, and neither may put DMX on a network it was not asked to.
{
  {
    const g = new OutputGate();
    check('gate: a fresh engine is offline', !g.isLive());
    let silent = true;
    for (let i = 0; i < 10; i++) if (g.tick() !== 'silent') silent = false;
    check('gate: and stays silent, with no go-dark frames to send', silent);
  }
  {
    const g = new OutputGate();
    g.set(true);
    let show = g.isLive();
    for (let i = 0; i < 10; i++) if (g.tick() !== 'show') show = false;
    check('gate: live sends the show', show);
  }
  {
    // A node holds the last frame it received, so falling silent while the rig
    // is lit would leave it lit. Zeros first, then nothing.
    const g = new OutputGate();
    g.set(true);
    g.tick();
    g.set(false);
    const dark = Array.from({ length: GO_DARK_FRAMES }, () => g.tick());
    check(
      'gate: going offline darkens the rig first',
      dark.every((w) => w === 'dark'),
      `got ${dark.join(',')}`,
    );
    check('gate: then falls silent for good', [g.tick(), g.tick(), g.tick()].every((w) => w === 'silent'));
  }
  {
    const g = new OutputGate();
    g.set(true);
    g.set(false);
    check('gate: one go-dark frame out', g.tick() === 'dark');
    g.set(true);
    check('gate: going live again cancels the rest — no black flash', g.tick() === 'show');
  }
  {
    // the engine calls set() from the engine state every tick, so re-setting
    // the state it already has is the common path, not an edge case
    const g = new OutputGate();
    g.set(true);
    g.set(false);
    g.set(false);
    g.set(false);
    const run = [g.tick(), g.tick(), g.tick(), g.tick()];
    check(
      'gate: the go-dark run is armed once, not re-armed every tick',
      JSON.stringify(run) === JSON.stringify(['dark', 'dark', 'dark', 'silent']),
      `got ${run.join(',')}`,
    );
  }
  {
    const st = new EngineState(sanitizeProject(demoProject())!);
    check('gate: engine state boots offline, whatever the show says', st.transmit === false);
  }
}

// --- the factory effects catalogue (backlog #4) -----------------------------
// It is app data that becomes SHOW data the moment anyone applies one, so it
// has to satisfy the same validator an untrusted project file does — and
// satisfy it without being changed, which is the difference between "the
// engine will accept this" and "the engine will quietly rewrite this".
{
  check(
    'fx library: between 30 and 70 presets',
    FX_LIBRARY.length >= 30 && FX_LIBRARY.length <= 70,
    `${FX_LIBRARY.length} presets`,
  );
  const ids = new Set(FX_LIBRARY.map((p) => p.id));
  check('fx library: ids are unique', ids.size === FX_LIBRARY.length);
  const names = new Set(FX_LIBRARY.map((p) => p.name));
  check('fx library: names are unique', names.size === FX_LIBRARY.length);

  const cats = new Set(FX_CATEGORIES.map((c) => c.id));
  const strayCat = FX_LIBRARY.filter((p) => !cats.has(p.category));
  check('fx library: every preset is in a category the picker shows', strayCat.length === 0, strayCat.map((p) => p.id).join(','));
  const emptyCat = FX_CATEGORIES.filter((c) => !FX_LIBRARY.some((p) => p.category === c.id));
  check('fx library: no category is empty', emptyCat.length === 0, emptyCat.map((c) => c.id).join(','));

  const noDesc = FX_LIBRARY.filter((p) => p.description.trim().length < 20 || !p.description.trim().endsWith('.'));
  check('fx library: every preset has a described, full-sentence purpose', noDesc.length === 0, noDesc.map((p) => p.id).join(','));

  // The real assertion: repairEffect accepts each one AND leaves it alone.
  const rejected: string[] = [];
  const rewritten: string[] = [];
  for (const p of FX_LIBRARY) {
    const asEffect = { ...p.effect, id: p.id };
    const fixed = repairEffect(asEffect);
    if (!fixed) { rejected.push(p.id); continue; }
    if (JSON.stringify(fixed) !== JSON.stringify(asEffect)) rewritten.push(p.id);
  }
  check('fx library: every preset survives repairEffect', rejected.length === 0, rejected.join(','));
  check('fx library: and none of them is repaired on the way through', rewritten.length === 0, rewritten.join(','));

  // Knobs the validator tolerates but an operator would call broken: a rate of
  // zero or a depth of zero is an effect that renders nothing at all, and both
  // engines skip it outright (shared/effects.ts, core/src/effects.rs).
  const inert = FX_LIBRARY.filter((p) => p.effect.rate <= 0 || p.effect.size <= 0 || p.effect.mix <= 0 || p.effect.bypass);
  check('fx library: no preset is inert as shipped', inert.length === 0, inert.map((p) => p.id).join(','));

  // The four families the editor's feature row names (design 2.6). A fifth
  // section, or "Movement" coming back, is a catalogue that no longer agrees
  // with the editor beside it.
  check(
    'fx library: the sections are the editor\u2019s own families',
    FX_CATEGORIES.map((c) => c.label).join(' \u00b7 ') === 'Intensity \u00b7 Colour \u00b7 Position \u00b7 Beam',
    FX_CATEGORIES.map((c) => c.label).join(' \u00b7 '),
  );
  // "Strobe and white" split by what the preset does to the light, not by the
  // channel it moves: a strobe is intensity, a white is colour.
  const strobeElsewhere = FX_LIBRARY.filter((p) => p.effect.target === 'strobe' && p.category !== 'intensity');
  check('fx library: a strobe preset is filed under Intensity', strobeElsewhere.length === 0, strobeElsewhere.map((p) => p.id).join(','));
  const whiteElsewhere = FX_LIBRARY.filter((p) => p.effect.target === 'white' && p.category !== 'colour');
  check('fx library: a white preset is filed under Colour', whiteElsewhere.length === 0, whiteElsewhere.map((p) => p.id).join(','));
  const aimElsewhere = FX_LIBRARY.filter(
    (p) => (p.effect.target === 'pan' || p.effect.target === 'tilt' || p.effect.target === 'shape') && p.category !== 'position',
  );
  check('fx library: an aiming preset is filed under Position', aimElsewhere.length === 0, aimElsewhere.map((p) => p.id).join(','));

  // The cannot-take flag is read off the TARGET, so re-filing a preset never
  // moves it: a strobe stab under Intensity still greys for a group whose
  // fixtures have no strobe channel.
  const noStrobe: ReadonlySet<EffectTarget> = new Set<EffectTarget>(['dimmer', 'hue', 'pan', 'tilt', 'shape']);
  const stab = FX_LIBRARY.find((p) => p.id === 'strobe-stab');
  check('fx library: a strobe preset still cannot be taken by a group with no strobe', !!stab && unusable(stab, noStrobe));
  const pulse = FX_LIBRARY.find((p) => p.id === 'pulse-bar');
  check('fx library: and a dimmer preset in the same section can', !!pulse && !unusable(pulse, noStrobe));

  check('fx library: search matches a name', fxSearch(FX_LIBRARY, 'rainbow').length > 0);
  check('fx library: search matches words only in a description', fxSearch(FX_LIBRARY, 'downbeat').length > 0);
  check('fx library: search matches a section name', fxSearch(FX_LIBRARY, 'position').length > 0);
  check('fx library: and the retired section name finds nothing', fxSearch(FX_LIBRARY, 'movement').length === 0);
  check('fx library: an unmatched search returns nothing rather than everything', fxSearch(FX_LIBRARY, 'zzzznope').length === 0);
  check('fx library: an empty search returns the lot', fxSearch(FX_LIBRARY, '  ').length === FX_LIBRARY.length);
}

// --- pan/tilt calibration (backlog #5) --------------------------------------
// Mirrors the unit tests in core/src/aim.rs. Both engines run the same rule
// from their own copy, so the two files have to agree to the last bit — and a
// fixture with nothing calibrated has to render exactly as it always did.
{
  const near = (got: { pan: number; tilt: number }, p: number, t: number) =>
    Math.abs(got.pan - p) < 1e-12 && Math.abs(got.tilt - t) < 1e-12;

  check('aim: nothing calibrated is the identity', aimIsIdentity(0.5, 0.5, undefined));
  const untouched = [[0, 0], [0.5, 0.5], [1, 1], [0.25, 0.9]].every(([p, t]) =>
    near(applyAim(p, t, 0.5, 0.5, undefined), p, t));
  check('aim: and passes every value through unchanged', untouched);

  check('aim: a base aim moves the centre', near(applyAim(0.5, 0.5, 0.25, 0.25, undefined), 0.25, 0.25));
  check('aim: and the look is a delta on top of it', near(applyAim(1, 1, 0.25, 0.25, undefined), 0.75, 0.75));
  check('aim: a base aim is not the identity', !aimIsIdentity(0.25, 0.5, undefined));

  const invP = { invertPan: true };
  check('aim: invert leaves the focus where it was', near(applyAim(0.5, 0.5, 0.3, 0.5, invP), 0.3, 0.5));
  check('aim: invert mirrors the movement only', near(applyAim(0.7, 0.5, 0.3, 0.5, invP), 0.1, 0.5));
  check('aim: a pan inversion leaves tilt alone', near(applyAim(0.5, 0.8, 0.3, 0.5, invP), 0.3, 0.8));

  const sw = { swap: true };
  check('aim: swap sends the look tilt to the pan channel', near(applyAim(0.5, 0.9, 0.5, 0.5, sw), 0.9, 0.5));
  check('aim: and the look pan to the tilt channel', near(applyAim(0.9, 0.5, 0.5, 0.5, sw), 0.5, 0.9));
  check(
    'aim: invert names the fixture axis, not the look one',
    near(applyAim(0.5, 0.9, 0.5, 0.5, { swap: true, invertPan: true }), 0.1, 0.5),
  );

  const lim = { panMin: 0.3, panMax: 0.7, tiltMax: 0.6 };
  check('aim: soft limits hold whatever a look asks for', near(applyAim(1, 1, 0.5, 0.5, lim), 0.7, 0.6));
  check('aim: at both ends', near(applyAim(0, 0, 0.5, 0.5, lim), 0.3, 0));
  check('aim: and move nothing already inside them', near(applyAim(0.6, 0.5, 0.5, 0.5, lim), 0.6, 0.5));
  check(
    'aim: limits the wrong way round park the head low rather than nowhere',
    applyAim(0.5, 0.5, 0.5, 0.5, { panMin: 0.8, panMax: 0.2 }).pan === 0.8,
  );
  check('aim: a calibration that corrects nothing is still the identity', aimIsIdentity(0.5, 0.5, { panMin: 0, panMax: 1 }));
  check('aim: one that corrects something is not', !aimIsIdentity(0.5, 0.5, { invertTilt: true }));

  // the sanitizer's job: a hand-edited block lands on one answer in both engines
  const raw = demoProject();
  raw.fixtures[0].cal = { invertPan: 'yes', swap: true, panMin: 5, tiltMax: 'x', bogus: 1 } as never;
  const cal = sanitizeProject(raw)!.fixtures[0].cal;
  check('sanitize: a non-boolean flag is dropped', cal?.invertPan === undefined, JSON.stringify(cal));
  check('sanitize: a true flag is kept', cal?.swap === true);
  check('sanitize: an out-of-range limit is clamped, not dropped', cal?.panMin === 1, `panMin=${cal?.panMin}`);
  check('sanitize: a non-numeric limit is dropped', cal?.tiltMax === undefined);

  const empty = demoProject();
  empty.fixtures[0].cal = { invertPan: false } as never;
  check(
    'sanitize: a block that corrects nothing is removed rather than stored',
    sanitizeProject(empty)!.fixtures[0].cal === undefined,
  );
}

// --- freeze: holding the frame while the show runs on (backlog #7) ---------
// Mirrors the unit tests in core/src/output.rs.
{
  const frame = (v: number) => new Map([['u1', new Uint8Array(512).fill(v)]]);
  {
    const f = new FreezeHold();
    let live = true;
    for (const v of [1, 2, 3]) {
      const b = frame(v);
      f.apply(false, b);
      if (b.get('u1')![0] !== v) live = false;
    }
    check('freeze: not frozen passes every frame through', live);
  }
  {
    const f = new FreezeHold();
    const first = frame(7);
    f.apply(true, first);
    check('freeze: the first frozen tick is the one held', first.get('u1')![0] === 7);
    let held = true;
    for (const v of [9, 40, 255]) {
      const b = frame(v);
      f.apply(true, b);
      if (b.get('u1')![0] !== 7) held = false;
    }
    check('freeze: and the wire repeats it while the show runs on', held);
  }
  {
    const f = new FreezeHold();
    f.apply(true, frame(7));
    const out = frame(9);
    f.apply(false, out);
    check('freeze: releasing goes live again', out.get('u1')![0] === 9);
    const again = frame(11);
    f.apply(true, again);
    check('freeze: and a later freeze latches the new frame, not the old hold', again.get('u1')![0] === 11);
  }
  {
    // otherwise it would be the one thing on the rig still moving
    const f = new FreezeHold();
    f.apply(true, frame(7));
    const two = frame(9);
    two.set('u2', new Uint8Array(512).fill(4));
    f.apply(true, two);
    check('freeze: a universe already held keeps its frame', two.get('u1')![0] === 7);
    check('freeze: one added mid-freeze latches now', two.get('u2')![0] === 4);
    const three = frame(9);
    three.set('u2', new Uint8Array(512).fill(200));
    f.apply(true, three);
    check('freeze: and holds from then on', three.get('u2')![0] === 4);
  }
  {
    const f = new FreezeHold();
    const two = frame(7);
    two.set('u2', new Uint8Array(512).fill(4));
    f.apply(true, two);
    const one = frame(9);
    f.apply(true, one);
    check('freeze: a deleted universe is not resurrected by the hold', one.size === 1 && one.get('u1')![0] === 7);
  }
  {
    // blackout always wins: a hold that could swallow a panic is not a hold
    // Read through a function: assigning the field narrows its type to the
    // literal, and the compiler then calls the assertion unreachable — which
    // is exactly the assertion worth making, because setBlackout is what is
    // meant to change it.
    const st = new EngineState(sanitizeProject(demoProject())!);
    const held = (): boolean => st.frozen;
    st.frozen = true;
    st.setBlackout(true);
    check('freeze: blackout releases it', !held() && st.blackout);
    st.frozen = true;
    st.setBlackout(false);
    check('freeze: clearing blackout does not', held());
    check('freeze: the engine boots unfrozen', !new EngineState(sanitizeProject(demoProject())!).frozen);
  }
}

// --- the keyboard and the pointer, written down once (backlog #8, design #37) -
// The handler and the published table were kept by hand and drifted: the guide
// said keys 1-8 fire columns long after the handler had grown to 1-9, and it
// never mentioned [ and ] at all. Nobody notices, because the only person who
// reads a keyboard reference is someone who has already failed to guess. So
// the code is the source and this reads the documentation back — for the keys,
// and now for the holds, drags and right-clicks beside them, which were never
// written down anywhere at all.
{
  const ref = fs.readFileSync(path.join(process.cwd(), 'docs/website/10-reference.md'), 'utf8');
  /** One `##` section of the reference, heading included, and nothing of the
   *  next. Unbounded, a table added under a later heading could satisfy the
   *  section above it — which is the drift this whole block exists to stop. */
  const sectionOf = (heading: string): string => {
    const from = ref.indexOf(heading);
    if (from < 0) return '';
    const to = ref.indexOf('\n## ', from + 1);
    return to < 0 ? ref.slice(from) : ref.slice(from, to);
  };
  const section = sectionOf('## Keyboard');
  const rows = section
    .split('\n')
    .filter((l) => l.startsWith('| `'))
    .map((l) => l.split('|').map((c) => c.trim()).filter(Boolean))
    .map(([keys, does]) => ({ keys, does }));

  check('shortcuts: the published table was found', rows.length > 0, `${rows.length} rows`);
  check(
    'shortcuts: the guide lists exactly what the handler binds',
    JSON.stringify(rows) === JSON.stringify(SHORTCUTS.map((s) => ({ keys: s.keys, does: s.label }))),
    `\n  guide: ${JSON.stringify(rows)}\n  code:  ${JSON.stringify(SHORTCUTS.map((s) => ({ keys: s.keys, does: s.label })))}`,
  );
  check(
    'shortcuts: every one is in a group the sheet renders',
    SHORTCUTS.every((s) => SHORTCUT_GROUPS.includes(s.group)),
    SHORTCUTS.filter((s) => !SHORTCUT_GROUPS.includes(s.group)).map((s) => s.keys).join(','),
  );
  check(
    'shortcuts: no group is empty',
    SHORTCUT_GROUPS.every((g) => SHORTCUTS.some((s) => s.group === g)),
    SHORTCUT_GROUPS.filter((g) => !SHORTCUTS.some((s) => s.group === g)).join(','),
  );

  // The same contract for the pointer half. The gesture table is three columns
  // — what a mouse does, what a fingertip does instead, what it does — because
  // the app words the same gesture two ways depending on what is in the hand,
  // and a reference that published only one of them would be wrong for half
  // the clients on the network.
  const gsec = sectionOf('## Gestures').split('\n').filter((l) => l.startsWith('|'));
  const ghead = gsec[0] ?? '';
  const grows = gsec
    .slice(2) // the header row and the |---| rule under it
    .map((l) => l.split('|').map((c) => c.trim()).filter(Boolean))
    .map(([pointer, glass, does]) => ({ pointer, glass, does }));
  const gcode = GESTURES.map((g) => ({ pointer: g.pointer, glass: g.touch, does: g.label }));

  check('gestures: the published table was found', grows.length > 0, `${grows.length} rows`);
  check(
    'gestures: it is the three-column table the sheet reads',
    ghead === '| With a mouse | On glass | Does |',
    ghead,
  );
  check(
    'gestures: the guide lists exactly what the sheet renders',
    JSON.stringify(grows) === JSON.stringify(gcode),
    `\n  guide: ${JSON.stringify(grows)}\n  code:  ${JSON.stringify(gcode)}`,
  );
  check(
    'gestures: every one is in a group the sheet renders',
    GESTURES.every((g) => GESTURE_GROUPS.includes(g.group)),
    GESTURES.filter((g) => !GESTURE_GROUPS.includes(g.group)).map((g) => g.pointer).join(','),
  );
  check(
    'gestures: no group is empty',
    GESTURE_GROUPS.every((g) => GESTURES.some((x) => x.group === g)),
    GESTURE_GROUPS.filter((g) => !GESTURES.some((x) => x.group === g)).join(','),
  );
  check(
    'gestures: each says what it is on glass as well as under a mouse',
    GESTURES.every((g) => g.pointer.length > 0 && g.touch.length > 0 && g.label.length > 0),
    GESTURES.filter((g) => !g.pointer || !g.touch || !g.label).map((g) => g.label).join(','),
  );

  // What actually happens, not what the predicates claim. ⌥1 matches the
  // digits rule AND the view rule, and it is the dispatcher's two passes that
  // make it mean one thing — so the dispatcher is what gets tested.
  // Structural, not Partial<KeyboardEvent>: this suite runs under Node with no
  // DOM lib, where that name is not the browser's.
  type FakeKey = {
    key: string;
    metaKey?: boolean;
    ctrlKey?: boolean;
    altKey?: boolean;
    shiftKey?: boolean;
    repeat?: boolean;
  };
  const press = (e: FakeKey, editing: string | null = null): string[] => {
    const calls: string[] = [];
    const st = {
      project: { columns: new Array(9).fill(null), decks: [{ id: 'a' }, { id: 'b' }], activeDeckId: 'a' },
      snap: { blackout: false, frozen: false, soft: [], layers: [] },
      send: (c: { type: string; col?: number }) => calls.push(c.col === undefined ? c.type : `${c.type}:${c.col}`),
      setView: (v: string) => calls.push(`view:${v}`),
      setSel: (x: unknown) => calls.push(x === null ? 'deselect' : 'select'),
      editingDeckId: editing,
      setEditingDeckId: (id: string | null) => calls.push(id === null ? 'stop editing' : `edit:${id}`),
      undo: () => calls.push('undo'),
      redo: () => calls.push('redo'),
    };
    runShortcut(e, st as never);
    return calls;
  };
  const is = (name: string, e: FakeKey, want: string[], editing: string | null = null) => {
    const got = press(e, editing);
    check(`shortcuts: ${name}`, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}`);
  };

  is('a digit fires that column', { key: '1' }, ['column:0']);
  is('and the ninth', { key: '9' }, ['column:8']);
  is('⌥1 switches view and does NOT fire column 1', { key: '1', altKey: true }, ['view:pads']);
  is('⌥4 is the last view', { key: '4', altKey: true }, ['view:split']);
  is('T taps', { key: 'T' }, ['tap']);
  is('B blacks out', { key: 'b' }, ['setBlackout']);
  is('] steps a song', { key: ']' }, ['switchDeck']);
  is('Escape deselects', { key: 'Escape' }, ['deselect']);
  is('save is the chord, not the letter', { key: 's', metaKey: true }, ['save']);
  is('⇧⌘Z redoes', { key: 'z', metaKey: true, shiftKey: true }, ['redo']);
  is('⌘Z undoes', { key: 'z', metaKey: true }, ['undo']);
  // the two gates that keep a cue key from misfiring
  is('a held key does not machine-gun a cue', { key: '1', repeat: true }, []);
  is('a browser chord whose letter is ours is not ours', { key: 'b', metaKey: true }, []);
  is('an unbound key does nothing', { key: 'q' }, []);

  is('F holds the frame', { key: 'f' }, ['setFreeze']);
  // Decision 0: on a page that is not the room's, a digit selects its column
  // rather than firing it, and Escape comes back before it clears a selection.
  is('a digit does NOT fire while another song is being edited', { key: '1' }, [], 'b');
  is('Escape leaves the page being edited first', { key: 'Escape' }, ['stop editing'], 'b');
  is('and deselects once it is back on the live page', { key: 'Escape' }, ['deselect']);

  check('shortcuts: the modified ones shadow a system chord', SHORTCUTS.some((s) => s.modified));
}

// --- movement shapes (backlog #9) -------------------------------------------
// Mirrors the unit tests in core/src/effects.rs. One effect drives pan AND
// tilt from a figure, so the figure has to be the same figure in both engines.
{
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

  {
    let round = true;
    for (let i = 0; i < 64; i++) {
      const { x, y } = shapeAt('circle', i / 64, false);
      if (!near(x * x + y * y, 1)) round = false;
    }
    check('shape: a circle is a circle', round);
    const start = shapeAt('circle', 0, false);
    check('shape: it starts at the right of the figure', near(start.x, 1) && near(start.y, 0));
    check('shape: and rises first', shapeAt('circle', 0.1, false).y > 0);
  }

  {
    const crossings = Array.from({ length: 1000 }, (_, i) => shapeAt('figure8', i / 1000, false))
      .filter(({ x, y }) => Math.abs(x) < 0.02 && Math.abs(y) < 0.02).length;
    check('shape: a figure of eight passes through the middle', crossings > 0);
    check(
      'shape: twice a lap, which is what tells it from an oval',
      near(shapeAt('figure8', 0, false).x, 0) && near(shapeAt('figure8', 0.5, false).x, 0),
    );
  }

  {
    let onEdge = true;
    for (let i = 0; i < 400; i++) {
      const { x, y } = shapeAt('square', i / 400, false);
      if (!(near(Math.abs(x), 1) || near(Math.abs(y), 1))) onEdge = false;
    }
    check('shape: a square stays on its perimeter', onEdge);
    const corners = [0, 0.25, 0.5, 0.75].map((p) => shapeAt('square', p, false));
    check(
      'shape: and hits each corner once a lap',
      JSON.stringify(corners) === JSON.stringify([
        { x: -1, y: -1 }, { x: 1, y: -1 }, { x: 1, y: 1 }, { x: -1, y: 1 },
      ]),
      JSON.stringify(corners),
    );
  }

  {
    let bounded = true;
    let wraps = true;
    for (const k of SHAPE_KINDS) {
      for (let i = -50; i < 150; i++) {
        const { x, y } = shapeAt(k, i / 50, false);
        if (Math.abs(x) > 1 + 1e-9 || Math.abs(y) > 1 + 1e-9) bounded = false;
      }
      // near, not equal: 3.3 % 1 is not bit-identical to 0.3, and both engines
      // do the same arithmetic in the same order — which is the property that
      // matters. Every existing wave has wrapped like this since the start.
      for (const b of [3.3, -0.7]) {
        const a1 = shapeAt(k, 0.3, false);
        const a2 = shapeAt(k, b, false);
        if (!near(a1.x, a2.x) || !near(a1.y, a2.y)) wraps = false;
      }
    }
    check('shape: every figure stays inside its box', bounded);
    check('shape: and a phase outside 0..1 lands on its wrap', wraps);
  }

  {
    let mirrored = true;
    for (const k of SHAPE_KINDS) {
      for (let i = 1; i < 20; i++) {
        const cw = shapeAt(k, i / 20, false);
        const ccw = shapeAt(k, 1 - i / 20, true);
        if (!near(cw.x, ccw.x) || !near(cw.y, ccw.y)) mirrored = false;
      }
    }
    check('shape: anticlockwise is the same figure the other way', mirrored);
  }

  {
    const eq = (got: { pan: number; tilt: number }, p: number, t: number) => near(got.pan, p) && near(got.tilt, t);
    check('shape: an even aspect gives both axes half the travel', eq(shapeAmps(1, 0.5), 0.5, 0.5));
    check('shape: all the way one way is all pan', eq(shapeAmps(1, 0), 0.5, 0));
    check('shape: and the other is all tilt', eq(shapeAmps(1, 1), 0, 0.5));
    check('shape: size scales both', eq(shapeAmps(0.5, 0.5), 0.25, 0.25));
    let capped = true;
    for (let i = 0; i <= 20; i++) {
      const a = shapeAmps(1, i / 20);
      if (a.pan > 0.5 + 1e-9 || a.tilt > 0.5 + 1e-9) capped = false;
    }
    check('shape: never past half the travel, whatever the aspect', capped);
  }
}

// --- profile lifecycle and the ids built-ins occupy (backlog #16) ----------
{
  check(
    'profiles: the built-in id list matches the built-in profiles',
    JSON.stringify([...BUILTIN_PROFILE_IDS].sort()) === JSON.stringify(Object.keys(PROFILES).sort()),
    `list=${[...BUILTIN_PROFILE_IDS].sort().join(',')} profiles=${Object.keys(PROFILES).sort().join(',')}`,
  );

  // A project profile carrying a built-in id can never render — both engines
  // resolve built-ins first — so it is dropped rather than kept as dead weight
  // that looks like it works.
  const shadow = demoProject();
  const real = { id: 'gdtf-x', manufacturer: 'M', model: 'M', mode: 'M', footprint: 1,
    heads: [{ kind: 'rgb', offset: 0, label: 'x' }], channels: [], beamDeg: 10, virtualDimmer: false };
  shadow.profiles = {
    'generic-rgb-par-3ch': { ...real, id: 'generic-rgb-par-3ch' },
    'gdtf-x': real,
  } as never;
  const kept = sanitizeProject(shadow)!.profiles ?? {};
  check('profiles: one shadowing a built-in id is dropped', !Object.hasOwn(kept, 'generic-rgb-par-3ch'), Object.keys(kept).join(','));
  check('profiles: and the rest are left alone', Object.hasOwn(kept, 'gdtf-x'), Object.keys(kept).join(','));
}

// --- the address code on the setup surface -----------------------------------
// A hand-written QR encoder (ui/src/qr.ts, design 2.10) has no library behind
// it, so this reads back what it drew: the format string names a level-L mask,
// every Reed-Solomon syndrome is zero, and the bytes come out as they went in.
// A code that is one module wrong still LOOKS like a code on the screen.
{
  const EXP: number[] = [];
  const LOG: number[] = [];
  for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  const gmul = (a: number, b: number) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);
  // BCH(15,5) over level L, computed rather than copied from the encoder
  const fmt = (mask: number) => {
    const v = (0b01 << 3) | mask;
    let d = v << 10;
    for (let i = 14; i >= 10; i--) if ((d >> i) & 1) d ^= 0x537 << (i - 10);
    return ((v << 10) | d) ^ 0x5412;
  };
  const MASK = [
    (r: number, c: number) => (r + c) % 2 === 0,
    (r: number) => r % 2 === 0,
    (_r: number, c: number) => c % 3 === 0,
    (r: number, c: number) => (r + c) % 3 === 0,
    (r: number, c: number) => (((r / 2) | 0) + ((c / 3) | 0)) % 2 === 0,
    (r: number, c: number) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r: number, c: number) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
    (r: number, c: number) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
  ];
  const CAP: [number, number][] = [[19, 7], [34, 10], [55, 15], [80, 20], [108, 26]];

  const readBack = (text: string): string => {
    const out = qrCode(text);
    if (!out) return 'no code';
    const n = out.size - 8;
    const version = (n - 17) / 4;
    if (!Number.isInteger(version) || version < 1 || version > 5) return `size ${out.size}`;
    const m: number[][] = [...Array(n)].map(() => Array(n).fill(0));
    for (const s of out.path.matchAll(/M(\d+) (\d+)h1v1h-1z/g)) m[Number(s[2]) - 4][Number(s[1]) - 4] = 1;
    for (const [br, bc] of [[0, 0], [0, n - 7], [n - 7, 0]]) {
      for (let r = 0; r < 7; r++) for (let c = 0; c < 7; c++) {
        if (m[br + r][bc + c] !== (Math.max(Math.abs(r - 3), Math.abs(c - 3)) === 2 ? 0 : 1)) return 'finder';
      }
    }
    for (let i = 8; i < n - 8; i++) if (m[6][i] !== (i % 2 === 0 ? 1 : 0) || m[i][6] !== (i % 2 === 0 ? 1 : 0)) return 'timing';
    if (m[4 * version + 9][8] !== 1) return 'dark module';
    let f1 = 0;
    let f2 = 0;
    for (let i = 0; i < 15; i++) {
      f1 |= (i < 6 ? m[8][i] : i === 6 ? m[8][7] : i === 7 ? m[8][8] : i === 8 ? m[7][8] : m[14 - i][8]) << i;
      f2 |= (i < 7 ? m[n - 1 - i][8] : m[8][n - 15 + i]) << i;
    }
    if (f1 !== f2) return 'format copies differ';
    const mask = [...Array(8)].findIndex((_, k) => fmt(k) === f1);
    if (mask < 0) return 'format is not level L';
    // the function patterns the zigzag steps over, marked out from the spec
    const fn: boolean[][] = [...Array(n)].map(() => Array(n).fill(false));
    const mark = (r0: number, c0: number, h: number, w: number) => {
      for (let r = r0; r < r0 + h; r++) for (let c = c0; c < c0 + w; c++) if (r >= 0 && c >= 0 && r < n && c < n) fn[r][c] = true;
    };
    mark(0, 0, 9, 9); mark(0, n - 8, 9, 8); mark(n - 8, 0, 8, 9); mark(6, 0, 1, n); mark(0, 6, n, 1);
    if (version > 1) {
      const cs = [6, 4 * version + 10];
      for (const cr of cs) for (const cc of cs) if (!(cr === 6 && cc > 6) && !(cc === 6 && cr > 6) && !(cr === 6 && cc === 6)) mark(cr - 2, cc - 2, 5, 5);
    }
    const bits: number[] = [];
    let up = true;
    for (let right = n - 1; right > 0; right -= 2) {
      if (right === 6) right = 5;
      for (let step = 0; step < n; step++) {
        const r = up ? n - 1 - step : step;
        for (const c of [right, right - 1]) if (!fn[r][c]) bits.push(m[r][c] ^ (MASK[mask](r, c) ? 1 : 0));
      }
      up = !up;
    }
    const [dataLen, ecLen] = CAP[version - 1];
    const words: number[] = [];
    for (let i = 0; i + 8 <= (dataLen + ecLen) * 8; i += 8) words.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
    for (let s = 0; s < ecLen; s++) {
      let acc = 0;
      for (const w of words) acc = gmul(acc, EXP[s]) ^ w;
      if (acc !== 0) return `syndrome ${s}`;
    }
    if (words[0] >> 4 !== 4) return 'not byte mode';
    const len = ((words[0] & 0xf) << 4) | (words[1] >> 4);
    const got: number[] = [];
    for (let i = 0; i < len; i++) got.push((((words[1 + i] & 0xf) << 4) | (words[2 + i] >> 4)) & 0xff);
    return new TextDecoder().decode(Uint8Array.from(got));
  };

  for (const text of ['http://192.168.1.12:9900', 'http://localhost:9900', 'http://light.local:9935', 'a', 'x'.repeat(17), 'x'.repeat(18), 'x'.repeat(106)]) {
    const back = readBack(text);
    check(`qr: "${text.length > 24 ? `${text.length} bytes` : text}" reads back as itself`, back === text, back);
  }
  check('qr: more than version 5 holds is refused rather than drawn wrong', qrCode('x'.repeat(107)) === null);
  check('qr: the smallest version that fits is the one used', qrCode('x'.repeat(17))?.size === 29 && qrCode('x'.repeat(18))?.size === 33);
}

// --- a look's reach, and the order a spread runs a group (#38, A38 / A39) ---
// The plan draws both; neither is allowed to be a second copy of a rule that
// already exists. The reach is `lookFace`'s groups with `lookKinds`' families;
// the order is read back OUT of shared/effects.ts through a probe, so the
// numbers on the plan are the fan the engines actually run.
{
  const { lookReach, spreadOrder, headKey } = await import('../../ui/src/components/editor/reach.ts');
  const { applyEffects } = await import('../../shared/effects.ts');
  type P = import('../../shared/types.ts').Project;
  type FX = import('../../shared/types.ts').Effect;

  const par = (id: string, x: number) => ({
    id, name: id.toUpperCase(), profileId: 'generic-rgb-par-3ch', universeId: 'u1',
    address: 1, pos: { x, y: 3, z: 0 }, rotY: 0,
  });
  const mover = (id: string, x: number) => ({
    id, name: id.toUpperCase(), profileId: 'generic-mover-10ch', universeId: 'u1',
    address: 1, pos: { x, y: 3, z: 0 }, rotY: 0,
  });
  const project = {
    fixtures: [par('p0', 0), par('p1', 1), par('p2', 2), par('p3', 3), mover('m0', 5), mover('m1', 6)],
    groups: [
      // movers listed FIRST, so a reach that came back in project order rather
      // than stage order would read m-then-p and fail below
      { id: 'movers', name: 'Movers', heads: [{ fixtureId: 'm0', head: 0 }, { fixtureId: 'm1', head: 0 }] },
      { id: 'pars', name: 'Pars', heads: [0, 1, 2, 3].map((i) => ({ fixtureId: `p${i}`, head: 0 })) },
    ],
    looks: {},
    layers: [],
    columns: [],
  } as unknown as P;
  const look = {
    id: 'lk', name: 'Cold Seam',
    parts: [
      { id: 'a', groupId: 'pars', params: { dimmer: 1, color: { h: 200, s: 1 } }, effects: [] },
      { id: 'b', groupId: 'movers', params: { pan: 0.5, tilt: 0.5 }, effects: [] },
      { id: 'c', groupId: 'gone', params: { dimmer: 1 }, effects: [] },
    ],
  } as unknown as import('../../shared/types.ts').Look;
  (project.looks as Record<string, unknown>)['lk'] = look;

  const reach = lookReach(look, project);
  check(
    'reach: one entry per group the look drives, in stage order',
    reach.length === 2 && reach[0].groupId === 'pars' && reach[1].groupId === 'movers',
    reach.map((r) => r.groupId).join(','),
  );
  check(
    'reach: each group carries the families that part enables',
    reach[0]?.kinds.join('') === 'IC' && reach[1]?.kinds.join('') === 'P',
    reach.map((r) => `${r.groupId}=${r.kinds.join('')}`).join(' '),
  );
  check(
    'reach: every head of the group is outlined, not just the first',
    reach[0]?.heads.join(',') === 'p0:0,p1:0,p2:0,p3:0' && reach[0]?.heads[0] === headKey('p0', 0),
    reach[0]?.heads.join(','),
  );
  check(
    'reach: a part naming a group this rig has not got reaches nothing',
    !reach.some((r) => r.groupId === 'gone'),
  );

  // a steps look borrows the groups of its first resolvable step — the same
  // borrow the pad face makes — and is tagged with what its steps do
  (project.looks as Record<string, unknown>)['cue'] = {
    id: 'cue', name: 'Cue', parts: [], steps: [{ lookId: 'lk', beats: 1 }],
  };
  const stepReach = lookReach((project.looks as Record<string, import('../../shared/types.ts').Look>)['cue'], project);
  check(
    'reach: a steps look reaches through to its step',
    stepReach.length === 2 && stepReach[0].kinds.join('') === 'ICP',
    stepReach.map((r) => `${r.groupId}=${r.kinds.join('')}`).join(' '),
  );

  const fx = {
    id: 'e', target: 'dimmer', wave: 'sawUp', rate: 1, size: 1, spread: 1, width: 0.5, phase: 0,
    bypass: false, mix: 1, distribute: 'index', fold: 'none', reverse: false, parts: 1, buddy: 1, seed: 0,
  } as FX;
  const run = (over: Partial<FX>): string => {
    const order = spreadOrder(project, 'pars', { ...fx, ...over } as FX);
    return [0, 1, 2, 3].map((i) => order.get(`p${i}:0`)).join(',');
  };
  check('spread order: in order, one after another', run({}) === '1,2,3,4', run({}));
  check('spread order: reverse runs it backwards', run({ reverse: true }) === '4,3,2,1', run({ reverse: true }));
  check(
    'spread order: a mirror fold gives the two wings the same numbers',
    run({ fold: 'mirror' }) === '1,2,3,2', run({ fold: 'mirror' }),
  );
  check(
    'spread order: the centre fold leads from the middle',
    run({ fold: 'centre' }) === '3,2,1,2', run({ fold: 'centre' }),
  );
  check(
    'spread order: buddy clumps adjacent heads onto one number',
    run({ buddy: 2 }) === '1,1,2,2', run({ buddy: 2 }),
  );
  check(
    'spread order: tile repeats the whole run across the group',
    run({ parts: 2 }) === '1,2,1,2', run({ parts: 2 }),
  );
  check('spread order: X sweeps stage left to right', run({ distribute: 'x' }) === '1,2,3,4', run({ distribute: 'x' }));
  check(
    'spread order: a parked or dry effect still previews its order',
    run({ bypass: true, mix: 0, size: 0 }) === '1,2,3,4',
    run({ bypass: true, mix: 0, size: 0 }),
  );
  check(
    'spread order: a chase orders its heads the same way the ramp does',
    run({ wave: 'chase' }) === run({}), `${run({ wave: 'chase' })} vs ${run({})}`,
  );
  check('spread order: a group this rig has not got numbers nothing', spreadOrder(project, 'gone', fx).size === 0);

  // and the numbers agree with the fan the ENGINE runs: ranking the four heads
  // by the phase applyEffects hands them must give the same order the preview
  // prints, for every basis the disclosure offers
  {
    const ext = { minX: 0, maxX: 3, minY: 3, maxY: 3, minZ: 0, maxZ: 0, cx: 1.5, cy: 3, cz: 0, maxR: 1.5 };
    const gAt = (x: number) => ({ x, y: 3, z: 0, along: 0, row: 0, col: 0, rowT: 0, colT: 0 });
    let agree = true;
    const cases: Partial<FX>[] = [
      {}, { reverse: true }, { fold: 'mirror' }, { fold: 'centre' }, { buddy: 2 }, { parts: 2 },
      { distribute: 'x' }, { distribute: 'radial' }, { distribute: 'shuffle', seed: 7 },
    ];
    for (const over of cases) {
      const e = { ...fx, ...over, spread: 0.5 } as FX;
      // dimmer under a full-size ramp IS the fan value, so ranking by it is
      // ranking by phase — with no reference to how the preview computes it
      const byEngine = [0, 1, 2, 3].map((j) => applyEffects({ dimmer: 1 }, [e], 0, [0], j, 4, gAt(j), ext).dimmer ?? 0);
      const steps = [...new Set(byEngine.map((v) => Math.floor(v * 1e6 + 0.5)))].sort((a, b) => a - b);
      const want = byEngine.map((v) => steps.indexOf(Math.floor(v * 1e6 + 0.5)) + 1).join(',');
      const got = run(over);
      if (got !== want) {
        agree = false;
        check(`spread order: agrees with the engine for ${JSON.stringify(over)}`, false, `${got} vs ${want}`);
      }
    }
    check('spread order: every basis matches the phase the engine hands each head', agree);
  }
}

// --- the look's four offset dials (#44, A41) --------------------------------
// They ride the existing soft nudge path, so the two things worth pinning are
// which addresses each one reaches and the value it drives them at: a value
// the engine's own door would reject is a dial that silently does nothing.
{
  const { OFFSET_DIALS, OFFSET_NEUTRAL, offsetTakers } = await import('../../ui/src/components/editor/offsets.ts');
  const { softClamp } = await import('../../shared/types.ts');
  type P = import('../../shared/types.ts').Project;
  type L = import('../../shared/types.ts').Look;

  const anyFixture = (id: string, profileId: string) => ({
    id, name: id.toUpperCase(), profileId, universeId: 'u1', address: 1,
    pos: { x: 0, y: 3, z: 0 }, rotY: 0,
  });
  const project = {
    fixtures: [
      anyFixture('p', 'generic-rgb-par-3ch'),
      anyFixture('m', 'generic-mover-10ch'),
      anyFixture('h', 'generic-hazer-2ch'),
      anyFixture('d', 'generic-dimmer-1ch'),
    ],
    groups: [
      { id: 'pars', name: 'Pars', heads: [{ fixtureId: 'p', head: 0 }] },
      { id: 'movers', name: 'Movers', heads: [{ fixtureId: 'm', head: 0 }] },
      { id: 'haze', name: 'Haze', heads: [{ fixtureId: 'h', head: 0 }] },
      { id: 'dims', name: 'Dims', heads: [{ fixtureId: 'd', head: 0 }] },
    ],
    looks: {}, layers: [], columns: [],
  } as unknown as P;

  const anEffect = (id: string, size: number) => ({
    id, target: 'dimmer', wave: 'sine', rate: 4, size, spread: 0, width: 0.5, phase: 0,
    bypass: false, mix: 1, distribute: 'index', fold: 'none', reverse: false, parts: 1, buddy: 1, seed: 0,
  });
  const look = {
    id: 'lk', name: 'Ride me',
    parts: [
      { id: 'a', groupId: 'pars', params: { dimmer: 0.8, color: { h: 350, s: 1 } }, effects: [anEffect('f1', 0.5)] },
      { id: 'b', groupId: 'movers', params: { dimmer: 1, pan: 0.4, tilt: 0.6 }, effects: [anEffect('f2', 1)] },
      // a hazer takes no brightness dial, and a plain dimmer channel has no
      // colour to turn — a stored colour on it would never reach a lamp
      { id: 'c', groupId: 'haze', params: { haze: 0.5, dimmer: 0.5 }, effects: [] },
      { id: 'd', groupId: 'dims', params: { dimmer: 0.9, color: { h: 10, s: 1 } }, effects: [] },
    ],
  } as unknown as L;
  const takers = offsetTakers(project, look);
  const ids = (dial: 'hue' | 'dimmer' | 'pan' | 'size') => takers[dial].map((a) => a.partId).join(',');

  check('offsets: hue reaches only the parts that set a colour on a group that has one', ids('hue') === 'a', ids('hue'));
  check('offsets: dimmer skips the hazer, which takes no brightness', ids('dimmer') === 'a,b,d', ids('dimmer'));
  check('offsets: pan reaches only the parts that aim a head', ids('pan') === 'b', ids('pan'));
  check(
    'offsets: size reaches every effect, addressed by effect',
    takers.size.map((a) => a.effectId).join(',') === 'f1,f2',
    takers.size.map((a) => a.effectId).join(','),
  );
  check(
    'offsets: a steps look has no parts of its own to offset',
    Object.values(offsetTakers(project, { id: 's', name: 'S', parts: [], steps: [{ lookId: 'lk', beats: 1 }] } as unknown as L))
      .every((a) => a.length === 0),
  );

  const spec = (d: string) => OFFSET_DIALS.find((x) => x.dial === d)!;
  check(
    'offsets: every dial at its neutral leaves the stored value exactly as it is',
    spec('hue').at(200, OFFSET_NEUTRAL.hue) === 200 && spec('dimmer').at(0.8, OFFSET_NEUTRAL.dimmer) === 0.8 &&
      spec('pan').at(0.4, OFFSET_NEUTRAL.pan) === 0.4 && spec('size').at(0.5, OFFSET_NEUTRAL.size) === 0.5,
  );
  check(
    'offsets: hue comes round the wheel rather than stopping at the end',
    spec('hue').at(350, 30) === 20, `${spec('hue').at(350, 30)}`,
  );
  check('offsets: hue goes the other way round too', spec('hue').at(10, -30) === 340, `${spec('hue').at(10, -30)}`);
  check('offsets: dimmer scales, and holds at full', spec('dimmer').at(0.8, 0.5) === 0.4 && spec('dimmer').at(0.8, 2) === 1);
  check(
    'offsets: pan swings, and holds at the ends',
    spec('pan').at(0.4, 0.25) === 0.65 && spec('pan').at(0.4, 0.5) === 0.9 && spec('pan').at(0.9, 0.5) === 1,
  );
  check('offsets: size scales the swing flat and back', spec('size').at(0.5, 0) === 0 && spec('size').at(0.5, 2) === 1);

  // nothing a dial can produce may be turned away at the engine's door: a
  // value softClamp rewrites is a dial whose reading and whose rig disagree
  let doorOk = true;
  for (const d of OFFSET_DIALS) {
    const field = d.dial === 'pan' ? 'pan' : d.dial === 'hue' ? 'hue' : d.dial === 'size' ? 'size' : 'dimmer';
    for (let i = 0; i <= 20; i++) {
      const v = d.min + ((d.max - d.min) * i) / 20;
      for (const base of [0, 0.25, 0.5, 0.9, 1, 10, 200, 359]) {
        const at = d.at(base, v);
        if (softClamp(field, at) !== at) {
          doorOk = false;
          check(`offsets: ${d.dial} from ${base} at ${v} passes the engine's door`, false, `${at}`);
        }
      }
    }
  }
  check('offsets: no dial position produces a value the engine would clamp', doorOk);

  check(
    'offsets: the readings follow the one number rule',
    spec('hue').fmt(30) === '+30°' && spec('hue').fmt(0) === '0°' && spec('dimmer').fmt(0.5) === '0.50×' &&
      spec('pan').fmt(0.12) === '+12\u2009%' && spec('size').fmt(1) === '1.00×',
    [spec('hue').fmt(30), spec('dimmer').fmt(0.5), spec('pan').fmt(0.12), spec('size').fmt(1)].join(' '),
  );
}

// --- a held freeze belongs to the hand that took it (design #57) -------------
// The Rust twin asserts the same four facts in core/tests/smoke.rs; this is the
// Node side of the same rule, so the two engines cannot drift on it.
{
  const st = new EngineState(sanitizeProject(demoProject())!);
  st.frozen = true;
  st.frozenBy = 7;
  st.releaseAllHeld(1, 9);
  check('freeze: another client leaving does not release this hold', st.frozen);
  st.releaseAllHeld(2, 7);
  check('freeze: the owner leaving releases the hold', !st.frozen && st.frozenBy === null);

  st.frozen = true;
  st.frozenBy = null; // a latch is ownerless
  st.releaseAllHeld(3, 7);
  check('freeze: a disconnect does not undo a deliberate latch', st.frozen);
  st.setBlackout(true);
  check('freeze: blackout releases a latched freeze', !st.frozen && st.frozenBy === null);
}

// --- the four fields the engine only carries (design #46) --------------------
// The Rust twin asserts the round trip in core/tests/smoke.rs; this is the Node
// side, where the job is type REPAIR rather than survival — unknown keys pass
// through untouched, so a note that arrives as a number is what would reach the
// UI as the wrong shape.
{
  const base = () => sanitizeProject(demoProject())!;

  const kept = sanitizeProject({
    ...demoProject(),
    palettes: [{ id: 'pal-1', name: 'venue blue', h: 214, s: 0.9 }],
    pinnedGroups: [demoProject().groups[0]!.id],
  } as never)!;
  check('carried: a palette survives the sanitiser', kept.palettes?.length === 1 && kept.palettes[0]!.name === 'venue blue');
  check('carried: a pinned group that exists survives', kept.pinnedGroups?.length === 1);

  const junk = sanitizeProject({
    ...demoProject(),
    palettes: [{ id: 'ok', name: 'fine', h: 36, s: 0.2 }, { id: 'bad', name: 'no hue' }],
    pinnedGroups: [demoProject().groups[0]!.id, 'grp-that-was-deleted'],
  } as never)!;
  check('carried: a palette missing its hue is dropped', junk.palettes?.length === 1);
  check('carried: a pinned group that no longer exists is dropped', junk.pinnedGroups?.length === 1);

  const decks = base().decks!;
  const noted = sanitizeProject({
    ...demoProject(),
    decks: [{ ...decks[0]!, note: 'capo 3', home: true }, { ...decks[0]!, id: 'deck-2', home: true }],
  } as never)!;
  check('carried: a set-list note survives', noted.decks?.[0]?.note === 'capo 3');
  check('carried: only one song is home', noted.decks!.filter((d) => d.home).length === 1);

  const wrong = sanitizeProject({
    ...demoProject(),
    decks: [{ ...decks[0]!, note: 42, home: 'yes' }],
  } as never)!;
  check('carried: a note of the wrong type is dropped, not coerced', wrong.decks?.[0]?.note === undefined);
  check('carried: so is a home flag of the wrong type', wrong.decks?.[0]?.home === undefined);
}

// --- where a knob physically sits (design #52, A35) -------------------------
// The Rust twin asserts the same three facts in core/tests/smoke.rs.
{
  const st = new EngineState(sanitizeProject(demoProject())!);
  st.applyMidi(0xb3, 7, 99);
  check('knob: a CC nothing is mapped to still records where it is', st.midiCc.get('3:7') === 99);
  st.applyMidi(0xb3, 7, 12);
  check('knob: the latest position wins', st.midiCc.get('3:7') === 12);
  st.applyMidi(0x90, 7, 127);
  check('knob: a note leaves nothing behind', st.midiCc.size === 1);
}

// --- blind is cleared by what ends a programming session (design #48) --------
// The Rust twin is `blind_is_cleared_by_all_stop_and_a_project_switch`.
{
  const st = new EngineState(sanitizeProject(demoProject())!);
  st.blind = true;
  st.replaceProject(sanitizeProject(demoProject())!);
  // read through a function so TypeScript does not narrow it to the `true`
  // it was just assigned — the whole point is that replaceProject changed it
  const blindNow = (): boolean => st.blind;
  check('blind: a project switch clears it', !blindNow());
}

// --- a timed Discard blends by the same bits as the Rust twin (design #50) ---
// Held to the table in core/tests/smoke.rs, compared by bit pattern. Hue is
// DEGREES — an earlier draft wrapped at 1.0 and passed on hues that never occur.
{
  const bitsOf = (x: number): string => {
    const b = new DataView(new ArrayBuffer(8));
    b.setFloat64(0, x);
    return [...new Uint8Array(b.buffer)].map((v) => v.toString(16).padStart(2, '0')).join('');
  };
  const table: [SoftField, number, number, number, string][] = [
    ['hue', 350.0, 10.0, 0.5, '0000000000000000'],
    ['hue', 30.0, 330.0, 0.5, '0000000000000000'],
    ['hue', 72.0, 216.0, 0.25, '405b000000000000'],
    ['hue', 350.0, 10.0, 0.3, '4076400000000000'],
    ['hue', 0.1, 359.9, 0.5, '0000000000000000'],
    ['hue', 195.5, 12.25, 0.4, '4070a33333333333'],
    ['hue', 324.0, 36.0, 0.0, '4074400000000000'],
    ['dimmer', 1.0, 0.2, 0.5, '3fe3333333333333'],
    ['rate', 1.0, 4.0, 0.75, '400a000000000000'],
  ];
  let same = true;
  for (const [f, stored, soft, w, bits] of table) {
    const got = blendSoft(f, stored, soft, w);
    if (bitsOf(got) !== bits) {
      same = false;
      check(`discard: ${f} ${stored}→${soft} at ${w} matches the Rust bits`, false, `got ${got} (${bitsOf(got)}), want ${bits}`);
    }
  }
  check('discard: every blend lands on the Rust twin\'s exact bits', same);
  check('discard: a hue never wraps to 360', blendSoft('hue', 0.1, 359.9, 0.5) === 0);
  check('discard: no release leaves the nudge untouched', blendSoft('hue', 10, 200, 1) === 200);
  check(
    'discard: the weight falls from 1 to 0 and stays there',
    softReleaseWeight(null, 5) === 1 && softReleaseWeight({ start: 0, dur: 1000 }, 250) === 0.75
      && softReleaseWeight({ start: 0, dur: 1000 }, 1000) === 0 && softReleaseWeight({ start: 0, dur: 1000 }, 5000) === 0,
  );
}

// --- Discard travels back over the nudged look's own fade (design #50) --------
{
  const proj = {
    looks: { a: { id: 'a', fade: 1.5 }, b: { id: 'b', fade: 0 }, c: { id: 'c' } },
    layers: [{ fade: 0.4, cells: ['c', null] }],
  };
  check('discard fade: the look\'s own fade', discardFade(proj, { soft: [{ lookId: 'a' }] }) === 1.5);
  check('discard fade: a look set to snap discards instantly', discardFade(proj, { soft: [{ lookId: 'b' }] }) === undefined);
  check('discard fade: a look with none uses its layer\'s', discardFade(proj, { soft: [{ lookId: 'c' }] }) === 0.4);
  check('discard fade: nothing nudged, nothing to time', discardFade(proj, { soft: [] }) === undefined);
  check('discard fade: a look that has gone is not guessed at', discardFade(proj, { soft: [{ lookId: 'gone' }] }) === undefined);
}

// --- palettes: retune by value, and what a tap on the performance row reaches (design #49)
{
  const look = (id: string, colours: ({ h: number; s: number } | undefined)[]) => ({
    id, name: id, parts: colours.map((c, i) => ({ id: `${id}-p${i}`, groupId: 'g', params: c ? { color: c } : {}, effects: [] })),
  });
  const project = {
    palettes: undefined,
    looks: {
      bed: look('bed', [{ h: 228, s: 1 }]),
      floor: look('floor', [{ h: 228, s: 1 }, { h: 228, s: 1 }]),
      nudged: look('nudged', [{ h: 236, s: 0.95 }]), // blue, nudged a few degrees and kept
      red: look('red', [{ h: 0, s: 1 }]),
      nocolour: look('nocolour', [undefined]),
    },
  } as never;

  check('palettes: a show with none opens with the twelve it always had', palettesOf({ palettes: undefined }).length === 12);
  check('palettes: a show with its own uses them', palettesOf({ palettes: [{ id: 'x', name: 'venue blue', h: 214, s: 0.9 }] })[0]!.name === 'venue blue');

  const plan = retunePlan(project, { h: 228, s: 1 });
  check('palettes: retune carries the parts set to exactly that colour', plan.exact.length === 3);
  check('palettes: and counts the looks they span, for the question', plan.looks === 2);
  check('palettes: a part nudged near it is named, never changed', plan.near.length === 1 && plan.near[0]!.lookId === 'nudged');
  check('palettes: an unrelated colour is neither', !plan.exact.concat(plan.near).some((x) => x.lookId === 'red'));

  // the part the palette is being retuned TO is where the retune lands, not a
  // near miss it leaves behind
  const landing = retunePlan(project, { h: 228, s: 1 }, { h: 236, s: 0.95 });
  check('palettes: a part already on the new colour is not reported as left behind', landing.near.length === 0 && landing.exact.length === 3);

  const wrap = retunePlan({ looks: { a: look('a', [{ h: 358, s: 1 }]) } } as never, { h: 3, s: 1 });
  check('palettes: near is measured the short way round the wheel', wrap.near.length === 1, `358° vs 3° is 5°`);

  const whites = retunePlan({ looks: { a: look('a', [{ h: 140, s: 0 }]) } } as never, { h: 0, s: 0 });
  check('palettes: white has no hue to disagree about', whites.exact.length === 1);

  // The swatch lights by the same test the retune moves by — white with a stray
  // hue lit no swatch while the retune still carried it
  check('palettes: the lit swatch and the retune agree on white', onPalette({ h: 140, s: 0 }, { h: 0, s: 0 }));
  check('palettes: rounding is on the palette, a degree is not', onPalette({ h: 228.3, s: 1 }, { h: 228, s: 1 }) && !onPalette({ h: 229, s: 1 }, { h: 228, s: 1 }));
  check('palettes: the wheel edge is the same colour', onPalette({ h: 359.8, s: 1 }, { h: 0, s: 1 }));

  const edited = structuredClone((project as { looks: object }));
  applyRetune(edited as never, plan, { h: 214, s: 0.9 });
  const bedColour = (edited as { looks: Record<string, { parts: { params: { color?: { h: number } } }[] }> }).looks.bed!.parts[0]!.params.color!.h;
  const nudgedColour = (edited as { looks: Record<string, { parts: { params: { color?: { h: number } } }[] }> }).looks.nudged!.parts[0]!.params.color!.h;
  check('palettes: applying the retune moves the exact parts', bedColour === 214);
  check('palettes: and leaves the near one where it was', nudgedColour === 236);

  const reach = playingColourParts(project, ['bed', 'nocolour', 'bed', null, 'gone']);
  check('palettes: a tap reaches the coloured parts of what is playing, once each', reach.length === 1 && reach[0]!.lookId === 'bed');
}

// --- the FADE master (design decision 3, A26) --------------------------------
// The Rust twin is `the_fade_master_scales_every_crossfade_a_layer_starts`, held
// to the same bit table. The command's clamp lives in engine/index.ts, which
// cannot be imported here, so the parity harness holds that half.
{
  const bitsOf = (x: number): string => {
    const b = new DataView(new ArrayBuffer(8));
    b.setFloat64(0, x);
    return [...new Uint8Array(b.buffer)].map((v) => v.toString(16).padStart(2, '0')).join('');
  };
  const table: [number, string][] = [
    [0, '0000000000000000'], // the bottom is a cut
    [0.5, '3ff0000000000000'], // the middle is as programmed
    [1, '4010000000000000'], // the top is four times as long
    [64 / 127, '3ff040c2050c1c40'], // CC 64, a hair past the middle
    [0.3, '3fd70a3d70a3d70a'],
    [100 / 127, '4003d70cd729487d'],
    [-1, '0000000000000000'],
    [2, '4010000000000000'],
    [NaN, '0000000000000000'],
  ];
  const drift = table.filter(([p, b]) => bitsOf(fadeScaleAt(p)) !== b);
  check('fade master: the fader curve matches the Rust twin to the bit', drift.length === 0,
    drift.map(([p]) => `${p} → ${fadeScaleAt(p)}`).join(' '));

  const st = new EngineState(sanitizeProject(demoProject())!);
  check('fade master: a show opens as programmed', st.fadeScale === 1);
  const durBits = (layerId: string): string => bitsOf(st.live.get(layerId)!.fadeDur);

  st.fadeScale = 2.5;
  st.trigger('layer-wash', 1, 1000);
  check('fade master: a look takes its layer fade, stretched', durBits('layer-wash') === '4000000000000000', `${st.live.get('layer-wash')!.fadeDur}`);
  st.fadeScale = 0;
  st.trigger('layer-wash', 2, 2000);
  check('fade master: at the bottom the next look cuts in', durBits('layer-wash') === '0000000000000000');

  st.fadeScale = 0.5;
  st.trigger('layer-fx', 1, 3000);
  st.clearLayer('layer-fx', 3500);
  check('fade master: a layer clearing is scaled too', durBits('layer-fx') === '3fc3333333333333', `${st.live.get('layer-fx')!.fadeDur}`);

  st.project.looks['strobe-blinder']!.fade = 0.3;
  st.fadeScale = 2;
  st.trigger('layer-strobe', 1, 4000);
  st.release('layer-strobe', 1, 4500);
  check('fade master: a flash letting go is stretched', durBits('layer-strobe') === '3fe3333333333333', `${st.live.get('layer-strobe')!.fadeDur}`);
  st.fadeScale = 0;
  st.trigger('layer-strobe', 1, 5000);
  st.release('layer-strobe', 1, 5500);
  check('fade master: and never goes under the 20 ms floor', durBits('layer-strobe') === '3f947ae147ae147b', `${st.live.get('layer-strobe')!.fadeDur}`);

  // on a controller: a fader sets it by the curve, and a pad bound to it is a
  // fader-style target — letting the pad go must not slam it to a cut
  st.project.midi.push({ id: 'fade-cc', type: 'cc', channel: 0, number: 20, action: { kind: 'fadeScale' } });
  st.project.midi.push({ id: 'fade-pad', type: 'note', channel: 0, number: 60, action: { kind: 'fadeScale' } });
  st.applyMidi(0xb0, 20, 64);
  check('fade master: a controller fader sets it by the curve', bitsOf(st.fadeScale) === '3ff040c2050c1c40', `${st.fadeScale}`);
  st.applyMidi(0x90, 60, 100);
  check('fade master: a pad sets it by its velocity', bitsOf(st.fadeScale) === '4003d70cd729487d', `${st.fadeScale}`);
  st.applyMidi(0x80, 60, 0);
  st.applyMidi(0x90, 60, 0);
  check('fade master: and letting the pad go leaves it where it is', bitsOf(st.fadeScale) === '4003d70cd729487d', `${st.fadeScale}`);
}

console.log(failures === 0 ? '\nAll engine smoke tests passed.' : `\n${failures} test(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
