#!/usr/bin/env node
// Turn the designed 20-song set into a LIGHT project and a vizz preset pack.
//
//   node scripts/build-set.mjs <design.json> <outdir>
//
// The design comes from agents; this applies the fixes both reviewers found and
// emits artefacts that actually load. Every correction is mechanical and
// explained where it happens — nothing here is taste, it is the difference
// between what was written and what the hardware and the schemas allow.
import fs from 'node:fs';
import path from 'node:path';

const [, , designPath, outDir] = process.argv;
if (!designPath || !outDir) {
  console.error('usage: build-set.mjs <design.json> <outdir>');
  process.exit(1);
}
const design = JSON.parse(fs.readFileSync(designPath, 'utf8'));
const songs = design.result?.songs ?? design.songs;
fs.mkdirSync(outDir, { recursive: true });

const fixes = [];
const note = (k) => fixes.push(k);

// ---------------------------------------------------------------- looks ----
const looks = {};
for (const song of songs) {
  // the song's own colour, used to repair effects that modulate a hue that was
  // never set — without a base, shared/effects.ts defaults to {h:0,s:1}, so an
  // intended teal drift comes out red
  const songHue = (() => {
    for (const l of song.looks ?? []) {
      for (const p of l.parts ?? []) if (p.params?.color) return p.params.color;
    }
    return { h: 210, s: 1 };
  })();

  for (const look of song.looks ?? []) {
    const parts = [];
    for (const [i, part] of (look.parts ?? []).entries()) {
      // the design wrote g-bars; the rig calls that group g-pars, and keeping
      // the ids identical lets looks move between this set and the real show
      const groupId = part.groupId === 'g-bars' ? 'g-pars' : part.groupId;
      if (part.groupId === 'g-bars') note('groupId g-bars → g-pars');

      // Haze is judged by eye on the night — how much a room already holds
      // varies with the venue, the door, and how long the doors have been open,
      // and a look that pumps it fights the operator. The master HAZE fader is
      // the only source; look-level haze parts are dropped.
      if (groupId === 'g-hazer') { note('hazer part dropped (haze stays manual)'); continue; }

      const params = { ...(part.params ?? {}) };
      delete params.haze;
      delete params.fan;

      if (groupId === 'g-derbies') {
        // The Varytec derby has no dimmer channel: profiles.ts gates on
        // `dimmer > 0.02` and then writes a colour macro, so 0.2 and 0.9 are
        // the same picture. Anything staged dim was asking for brightness the
        // fixture cannot produce — lift the intended-on ones to full and drop
        // the ones that only made sense as a whisper.
        if (params.dimmer !== undefined && params.dimmer > 0.02) {
          if (params.dimmer < 0.35) {
            note('derby part dropped (dim value the hardware cannot render)');
            continue;
          }
          if (params.dimmer !== 1) {
            params.dimmer = 1;
            note('derby dimmer → 1 (binary gate)');
          }
        }
        // channel 4 serves both, and white wins the branch outright
        if ((params.white ?? 0) >= 0.5 && (params.ringFx ?? 0) > 0.01) {
          delete params.ringFx;
          note('derby ringFx dropped (white already owns that channel)');
        }
      }

      const effects = ((part.effects ?? []).map((e, j) => {
        const fx = { ...e };
        if (!fx.id) { fx.id = `${look.id}-e${j}`; note('effect id minted'); }
        if (fx.width === undefined) { fx.width = 0.5; note('effect width defaulted'); }
        if (fx.rate === undefined && fx.beats !== undefined) { fx.rate = fx.beats; delete fx.beats; }
        return fx;
      }));

      // a hue effect needs something to modulate
      if (effects.some((e) => e.target === 'hue') && !params.color) {
        params.color = { ...songHue };
        note('base colour added under a hue effect');
      }

      parts.push({ id: `${look.id}-p${i}`, groupId, params, effects });
    }
    // A look can lose every part above — a derby-only look staged dim, say.
    // Keeping it would put a pad in the grid that fires and does nothing, which
    // on stage reads as a dead button rather than an intentional blackout.
    if (parts.length === 0) { note('empty look dropped (all its parts were unrenderable)'); continue; }
    looks[look.id] = {
      id: look.id,
      name: look.name,
      parts,
      ...(look.flash ? { flash: true } : {}),
    };
  }
}

// ---------------------------------------------------------------- decks ----
const LAYERS = ['layer-wash', 'layer-derby', 'layer-fx', 'layer-strobe'];
const COLUMNS = ['Intro', 'Build', 'Break', 'Drop', 'Bridge', 'Peak', 'Outro', 'Blackout'];

const decks = songs.map((song, i) => {
  const cells = {};
  for (const layer of LAYERS) {
    const row = (song.cells?.[layer] ?? []).slice(0, 8);
    while (row.length < 8) row.push(null);
    // a cell pointing at a look that was dropped or never written renders as
    // nothing and looks like a dead pad — clear it rather than ship a lie
    cells[layer] = row.map((id) => (id && looks[id] ? id : null));
  }
  // Column 8 is the way out of a song. Two songs left it hard-empty and one
  // left its full bed running; make it an ember everywhere so the operator
  // always has the same landing.
  if (!cells['layer-wash'][7]) {
    const ember = Object.values(looks).find(
      (l) => l.id.startsWith(`s${String(song.n).padStart(2, '0')}-`) && /ember|out|abyss|low/i.test(l.id),
    );
    if (ember) cells['layer-wash'][7] = ember.id;
  }
  for (const layer of ['layer-derby', 'layer-fx', 'layer-strobe']) cells[layer][7] = null;

  return {
    id: `deck-${i + 1}`,
    name: `${String(song.n).padStart(2, '0')} · ${song.title}`,
    columns: [...COLUMNS],
    cells,
  };
});

// ------------------------------------------------------------ vizz pack ----
const vizzDir = path.join(outDir, 'vizz-presets');
fs.mkdirSync(vizzDir, { recursive: true });
const gridCells = [];
for (const song of songs) {
  const v = song.vizz;
  if (!v) continue;
  const values = { ...v.values };
  // black paper is the whole point — never let a design drift off it
  values['/bg/red'] = 0; values['/bg/green'] = 0; values['/bg/blue'] = 0; values['/bg/alpha'] = 1;
  for (const n of [1, 2, 3, 4]) {
    const kind = values[`/l${n}/kind`];
    if (kind === undefined || kind === 0) continue;
    // multiply(1) and subtract(6) against black paper render black: the layer
    // is on, costs a pass, and shows nothing
    const blend = values[`/l${n}/blend`];
    if (blend === 1 || blend === 6) {
      values[`/l${n}/blend`] = 3; // add
      note(`vizz /l${n}/blend ${blend} → add (would render black)`);
    }
  }
  fs.writeFileSync(path.join(vizzDir, `${v.name}.json`), JSON.stringify({ values }, null, 2));
  gridCells.push({ preset: v.name });
}
while (gridCells.length < 20) gridCells.push({ preset: `blank ${gridCells.length + 1}` });
fs.writeFileSync(
  path.join(vizzDir, 'grid.json'),
  JSON.stringify({ cells: gridCells, duration: 0.3, curve: 'easein' }, null, 2),
);

fs.writeFileSync(path.join(outDir, 'looks.json'), JSON.stringify(looks, null, 2));
fs.writeFileSync(path.join(outDir, 'decks.json'), JSON.stringify(decks, null, 2));

const counts = fixes.reduce((m, k) => ((m[k] = (m[k] ?? 0) + 1), m), {});
console.log(`looks: ${Object.keys(looks).length}  decks: ${decks.length}  vizz presets: ${gridCells.filter((c) => !c.preset.startsWith('blank')).length}`);
console.log('repairs applied:');
for (const [k, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${k}`);
