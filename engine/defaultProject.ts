import type { CueStep, Deck, Effect, Look, LookPart, MidiAction, MidiMapping, PartParams, Project, StageProp } from '../shared/types.ts';

// ---------------------------------------------------------------------------
// The first-load DEMO show: the standard small-rig patch (2 derbies, 2 party
// bars, hazer on Universe 1) with a 12-song set — each deck is one song with
// its own palette and energy, sharing one look pool. Made to demonstrate the
// app: washes, splits, effect layers, derby patterns, cue-list chasers,
// flash strobes, and a dummy band on stage for the previz.
// ---------------------------------------------------------------------------

let n = 0;
const id = (p: string) => `${p}${++n}`;

function fx(partial: Partial<Effect> & Pick<Effect, 'target' | 'wave'>): Effect {
  return { id: id('fx'), rate: 4, size: 1, spread: 0, width: 0.5, phase: 0, ...partial };
}

function part(groupId: string, params: PartParams, effects: Effect[] = []): LookPart {
  return { id: id('part'), groupId, params, effects };
}

function look(lookId: string, name: string, parts: LookPart[], extra: Partial<Look> = {}): Look {
  return { id: lookId, name, parts, ...extra };
}

export function defaultProject(): Project {
  const looks: Record<string, Look> = {};
  const add = (l: Look) => {
    looks[l.id] = l;
    return l.id;
  };

  // --- wash looks (bars, all 8 pars) — static colours first: the parity
  //     harness checkpoints the first cells and needs byte-stable output ---
  add(look('wash-gold', 'Gold Wash', [part('g-pars', { dimmer: 1, color: { h: 38, s: 0.9 } })]));
  add(look('wash-red', 'Red Wash', [part('g-pars', { dimmer: 1, color: { h: 0, s: 1 } })]));
  add(look('wash-blue', 'Deep Blue', [part('g-pars', { dimmer: 1, color: { h: 228, s: 1 } })]));
  add(look('wash-magenta', 'Magenta', [part('g-pars', { dimmer: 1, color: { h: 312, s: 1 } })]));
  add(look('wash-teal', 'Teal', [part('g-pars', { dimmer: 1, color: { h: 175, s: 0.9 } })]));
  add(look('wash-white', 'White', [part('g-pars', { dimmer: 1, color: { h: 0, s: 0 } })]));
  add(look('wash-ice', 'Ice Blue', [part('g-pars', { dimmer: 1, color: { h: 205, s: 0.55 } })]));
  add(look('wash-uv', 'UV Purple', [part('g-pars', { dimmer: 1, color: { h: 268, s: 1 } })]));
  add(look('wash-green', 'Emerald', [part('g-pars', { dimmer: 1, color: { h: 140, s: 0.95 } })]));
  add(look('wash-pink', 'Hot Pink', [part('g-pars', { dimmer: 1, color: { h: 330, s: 0.85 } })]));
  add(look('wash-amber-dim', 'Warm Glow', [part('g-pars', { dimmer: 0.45, color: { h: 30, s: 0.85 } })]));

  // splits and movement
  add(
    look('wash-duotone', 'Red/Blue Split', [
      part('g-bar1', { dimmer: 1, color: { h: 0, s: 1 } }),
      part('g-bar2', { dimmer: 1, color: { h: 228, s: 1 } }),
    ])
  );
  add(
    look('wash-sunset', 'Sunset Split', [
      part('g-bar1', { dimmer: 1, color: { h: 18, s: 1 } }),
      part('g-bar2', { dimmer: 1, color: { h: 315, s: 0.8 } }),
    ])
  );
  add(
    look('wash-mint-uv', 'Mint / UV Split', [
      part('g-bar1', { dimmer: 1, color: { h: 160, s: 0.8 } }),
      part('g-bar2', { dimmer: 1, color: { h: 268, s: 1 } }),
    ])
  );
  add(
    look('wash-rainbow', 'Rainbow Drift', [
      part('g-pars', { dimmer: 1, color: { h: 0, s: 1 } }, [
        fx({ target: 'hue', wave: 'sawUp', rate: 16, size: 1, spread: 0.5 }),
      ]),
    ])
  );
  add(
    look('wash-ocean', 'Ocean Roll', [
      part('g-pars', { dimmer: 1, color: { h: 195, s: 0.9 } }, [
        fx({ target: 'hue', wave: 'sine', rate: 12, size: 0.25, spread: 0.6 }),
      ]),
    ])
  );
  add(
    look('wash-fire', 'Fire Flicker', [
      part('g-pars', { dimmer: 1, color: { h: 22, s: 1 } }, [
        fx({ target: 'dimmer', wave: 'random', rate: 0.25, size: 0.5 }),
        fx({ target: 'hue', wave: 'random', rate: 0.5, size: 0.12 }),
      ]),
    ])
  );

  // --- derby looks ---
  add(look('derby-red-spin', 'Derby Red Spin', [part('g-derbies', { dimmer: 1, color: { h: 0, s: 1 }, motorMode: 'rotate', motorValue: 0.35 })]));
  add(look('derby-rb-spin', 'Derby R+B Spin', [part('g-derbies', { dimmer: 1, macro: 88, motorMode: 'rotate', motorValue: 0.5 })]));
  add(look('derby-gb-slow', 'Derby G+B Slow', [part('g-derbies', { dimmer: 1, macro: 118, motorMode: 'rotate', motorValue: 0.15 })]));
  add(look('derby-white-aim', 'Derby White Static', [part('g-derbies', { dimmer: 1, color: { h: 0, s: 0 }, motorMode: 'aim', motorValue: 0.5 })]));
  add(look('derby-rgbw-fast', 'Derby RGBW Fast', [part('g-derbies', { dimmer: 1, macro: 208, motorMode: 'rotate', motorValue: 0.85 })]));
  add(look('derby-gw', 'Derby G+W Spin', [part('g-derbies', { dimmer: 1, macro: 133, motorMode: 'rotate', motorValue: 0.4 })]));
  add(look('derby-bw-slow', 'Derby B+W Slow', [part('g-derbies', { dimmer: 1, macro: 148, motorMode: 'rotate', motorValue: 0.12 })]));
  add(look('derby-rg', 'Derby R+G Spin', [part('g-derbies', { dimmer: 1, macro: 73, motorMode: 'rotate', motorValue: 0.55 })]));
  add(look('derby-colorchange', 'Derby Auto Colours', [part('g-derbies', { dimmer: 1, macro: 223, motorMode: 'rotate', motorValue: 0.6 })]));

  // --- FX layer looks (multiply blend: modulate whatever the wash does) ---
  add(look('fx-chase', 'Par Chase', [part('g-pars', {}, [fx({ target: 'dimmer', wave: 'chase', rate: 2, size: 1, width: 0.25 })])]));
  add(look('fx-swell', 'Slow Swell', [part('g-pars', {}, [fx({ target: 'dimmer', wave: 'sine', rate: 8, size: 0.8 })])]));
  add(look('fx-pulse', 'Beat Pulse', [part('g-pars', {}, [fx({ target: 'dimmer', wave: 'sawDown', rate: 1, size: 0.9 })])]));
  add(look('fx-flicker', 'Random Flicker', [part('g-pars', {}, [fx({ target: 'dimmer', wave: 'random', rate: 0.5, size: 1 })])]));
  add(look('fx-oddeven', 'Odd / Even', [part('g-pars', {}, [fx({ target: 'dimmer', wave: 'square', rate: 2, size: 1, spread: 0.5, width: 0.5 })])]));
  add(look('fx-halfbeat', 'Half-Beat Chop', [part('g-pars', {}, [fx({ target: 'dimmer', wave: 'square', rate: 0.5, size: 1, width: 0.5 })])]));
  add(look('fx-sweep', 'L→R Sweep', [part('g-pars', {}, [fx({ target: 'dimmer', wave: 'chase', rate: 4, size: 1, width: 0.45 })])]));
  add(look('fx-breathe', 'Breathe', [part('g-pars', {}, [fx({ target: 'dimmer', wave: 'sine', rate: 16, size: 0.55 })])]));

  // --- strobe / punch looks (flash = momentary) ---
  add(
    look('strobe-all', 'Full Strobe', [
      part('g-pars', { dimmer: 1, color: { h: 0, s: 0 }, strobe: 0.75 }),
      part('g-derbies', { dimmer: 1, color: { h: 0, s: 0 }, strobe: 0.75 }),
    ], { flash: true, fade: 0 })
  );
  add(look('strobe-blinder', 'Ring Blinder', [part('g-derbies', { white: 1 })], { flash: true, fade: 0 }));
  add(look('strobe-ringfx', 'Ring Patterns', [part('g-derbies', { ringFx: 0.55 })]));
  add(
    look('strobe-red', 'Red Strobe', [
      part('g-pars', { dimmer: 1, color: { h: 0, s: 1 }, strobe: 0.85 }),
    ], { flash: true, fade: 0 })
  );
  add(
    look('strobe-slowmo', 'Slow-Mo Strobe', [
      part('g-pars', { dimmer: 1, color: { h: 0, s: 0 }, strobe: 0.25 }),
    ], { flash: true, fade: 0 })
  );

  // --- cue-list chasers (⛓): step through looks on the beat ---
  const steps = (list: [string, number][]): CueStep[] => list.map(([lookId, beats]) => ({ lookId, beats }));
  add(look('cue-colourwheel', 'Colour Wheel', [], {
    steps: steps([['wash-red', 4], ['wash-gold', 4], ['wash-green', 4], ['wash-teal', 4], ['wash-blue', 4], ['wash-uv', 4]]),
  }));
  add(look('cue-verse', 'Verse 8s', [], {
    steps: steps([['wash-ice', 8], ['wash-teal', 8]]),
  }));
  add(look('cue-drop', 'Drop Snap', [], {
    steps: steps([['wash-white', 1], ['wash-red', 1], ['wash-white', 1], ['wash-blue', 1]]),
  }));
  add(look('cue-warm', 'Warm Sway', [], {
    steps: steps([['wash-gold', 8], ['wash-amber-dim', 8], ['wash-pink', 8]]),
  }));

  // --- the 12-song set: cells per layer, columns are song sections ---
  // cell shorthand: w=wash d=derby f=fx s=strobe · null = empty
  const deck = (
    num: number,
    name: string,
    w: (string | null)[],
    d: (string | null)[],
    f: (string | null)[],
    s: (string | null)[],
  ): Deck => ({
    id: `deck-${num}`,
    name: `${String(num).padStart(2, '0')} · ${name}`,
    columns: ['Intro', 'Build', 'Peak', 'Groove', 'Break', 'Drop', 'Outro', 'Chill'],
    cells: {
      'layer-wash': w,
      'layer-derby': d,
      'layer-fx': f,
      'layer-strobe': s,
    },
  });

  const decks: Deck[] = [
    deck(1, 'Opener — Gold',
      ['wash-gold', 'wash-red', 'wash-blue', 'wash-magenta', 'wash-teal', 'wash-duotone', 'wash-rainbow', 'wash-white'],
      [null, 'derby-red-spin', 'derby-rb-spin', 'derby-gb-slow', null, 'derby-rgbw-fast', 'derby-white-aim', null],
      [null, 'fx-pulse', 'fx-chase', 'fx-swell', 'fx-oddeven', 'fx-flicker', null, null],
      ['strobe-all', 'strobe-blinder', 'strobe-ringfx', null, null, null, null, null]),
    deck(2, 'House — Teal',
      ['wash-teal', 'wash-ocean', 'wash-mint-uv', 'wash-blue', 'wash-ice', 'cue-verse', 'wash-teal', 'wash-amber-dim'],
      [null, 'derby-gb-slow', 'derby-bw-slow', 'derby-gw', null, 'derby-rgbw-fast', null, null],
      ['fx-breathe', 'fx-pulse', 'fx-chase', 'fx-halfbeat', null, 'fx-sweep', 'fx-swell', null],
      [null, 'strobe-blinder', 'strobe-all', null, null, 'strobe-slowmo', null, null]),
    deck(3, 'Disco — Rainbow',
      ['wash-rainbow', 'cue-colourwheel', 'wash-pink', 'wash-gold', 'wash-magenta', 'wash-duotone', 'wash-rainbow', 'wash-white'],
      ['derby-colorchange', 'derby-rgbw-fast', 'derby-rb-spin', 'derby-rg', null, 'derby-colorchange', null, null],
      ['fx-chase', 'fx-oddeven', 'fx-sweep', null, 'fx-swell', 'fx-chase', null, null],
      [null, 'strobe-all', 'strobe-ringfx', null, null, 'strobe-blinder', null, null]),
    deck(4, 'Rock — Red',
      ['wash-red', 'wash-fire', 'wash-white', 'wash-duotone', 'wash-amber-dim', 'cue-drop', 'wash-red', null],
      ['derby-red-spin', null, 'derby-white-aim', 'derby-rb-spin', null, 'derby-rgbw-fast', null, null],
      [null, 'fx-flicker', 'fx-pulse', null, 'fx-swell', 'fx-halfbeat', null, null],
      ['strobe-red', 'strobe-all', 'strobe-blinder', null, null, 'strobe-red', null, null]),
    deck(5, 'Ballad — Ice',
      ['wash-ice', 'wash-blue', 'wash-white', 'wash-amber-dim', 'cue-warm', 'wash-ice', 'wash-amber-dim', null],
      [null, 'derby-bw-slow', 'derby-white-aim', null, null, 'derby-gb-slow', null, null],
      ['fx-breathe', 'fx-swell', null, 'fx-breathe', null, null, 'fx-swell', null],
      [null, null, 'strobe-ringfx', null, null, null, null, null]),
    deck(6, 'Funk — Magenta',
      ['wash-magenta', 'wash-pink', 'wash-sunset', 'wash-gold', 'wash-duotone', 'cue-colourwheel', 'wash-magenta', null],
      ['derby-rb-spin', 'derby-rg', 'derby-colorchange', null, null, 'derby-rgbw-fast', null, null],
      ['fx-oddeven', 'fx-chase', 'fx-sweep', 'fx-pulse', null, 'fx-halfbeat', null, null],
      [null, 'strobe-blinder', 'strobe-all', null, null, 'strobe-ringfx', null, null]),
    deck(7, 'Techno — White',
      ['wash-white', 'wash-ice', 'cue-drop', 'wash-blue', 'wash-uv', 'wash-white', 'wash-ice', null],
      ['derby-white-aim', 'derby-bw-slow', 'derby-rgbw-fast', null, null, 'derby-white-aim', null, null],
      ['fx-halfbeat', 'fx-pulse', 'fx-chase', 'fx-oddeven', null, 'fx-sweep', null, null],
      ['strobe-slowmo', 'strobe-all', 'strobe-blinder', null, null, 'strobe-all', null, null]),
    deck(8, 'Dub — Emerald',
      ['wash-green', 'wash-mint-uv', 'wash-uv', 'wash-teal', 'wash-amber-dim', 'cue-verse', 'wash-green', null],
      ['derby-gw', 'derby-gb-slow', 'derby-rg', null, null, 'derby-colorchange', null, null],
      ['fx-breathe', 'fx-swell', 'fx-chase', 'fx-halfbeat', null, 'fx-flicker', null, null],
      [null, 'strobe-ringfx', 'strobe-blinder', null, null, null, null, null]),
    deck(9, 'Indie — Pink',
      ['wash-pink', 'wash-sunset', 'wash-teal', 'wash-ice', 'wash-amber-dim', 'cue-warm', 'wash-pink', null],
      [null, 'derby-rb-spin', 'derby-bw-slow', null, null, 'derby-gw', null, null],
      ['fx-swell', 'fx-pulse', 'fx-oddeven', null, 'fx-breathe', 'fx-chase', null, null],
      [null, null, 'strobe-blinder', null, null, 'strobe-slowmo', null, null]),
    deck(10, 'DnB — Chaos',
      ['wash-uv', 'cue-drop', 'wash-red', 'wash-white', 'wash-blue', 'cue-colourwheel', 'wash-uv', null],
      ['derby-rgbw-fast', 'derby-colorchange', 'derby-rb-spin', 'derby-rg', null, 'derby-rgbw-fast', null, null],
      ['fx-chase', 'fx-halfbeat', 'fx-sweep', 'fx-flicker', null, 'fx-oddeven', null, null],
      ['strobe-all', 'strobe-red', 'strobe-blinder', null, null, 'strobe-all', null, null]),
    deck(11, 'Encore — Full',
      ['cue-colourwheel', 'wash-rainbow', 'wash-duotone', 'wash-gold', 'wash-magenta', 'cue-drop', 'wash-white', null],
      ['derby-colorchange', 'derby-rgbw-fast', 'derby-rb-spin', 'derby-gw', null, 'derby-rgbw-fast', 'derby-white-aim', null],
      ['fx-sweep', 'fx-chase', 'fx-pulse', 'fx-oddeven', null, 'fx-halfbeat', null, null],
      ['strobe-blinder', 'strobe-all', 'strobe-ringfx', null, null, 'strobe-red', null, null]),
    deck(12, 'Closer — Warm',
      ['wash-gold', 'cue-warm', 'wash-amber-dim', 'wash-sunset', 'wash-ice', 'wash-amber-dim', 'wash-gold', null],
      [null, 'derby-gb-slow', 'derby-bw-slow', null, null, 'derby-white-aim', null, null],
      ['fx-breathe', 'fx-swell', null, 'fx-breathe', null, null, null, null],
      [null, null, 'strobe-ringfx', null, null, null, null, null]),
  ];

  const props: StageProp[] = [
    { id: 'prop-voc', kind: 'vocalist', pos: { x: 0, z: 1.9 } },
    { id: 'prop-gtr', kind: 'guitarist', pos: { x: -1.7, z: 1.2 } },
    { id: 'prop-bass', kind: 'bassist', pos: { x: 1.7, z: 1.2 } },
    { id: 'prop-drums', kind: 'drummer', pos: { x: 0, z: 0.1 } },
    { id: 'prop-keys', kind: 'keyboardist', pos: { x: -3.0, z: 0.6 } },
  ];

  // APC40 mk2 factory layout, seeded so the controller WORKS on first launch —
  // an unmapped APC on a demo show looks like the app is broken. Identical to
  // the "load APC40 mk2 preset" button in Sync · MIDI.
  const midi: MidiMapping[] = [];
  const addMidi = (type: 'note' | 'cc', channel: number, number: number, action: MidiAction) =>
    midi.push({ id: id('midi'), type, channel, number, action });
  const layerIds = ['layer-wash', 'layer-derby', 'layer-fx', 'layer-strobe'];
  // grid: top pad row (notes 32-39) = top on-screen layer = STROBE
  [...layerIds].reverse().forEach((layerId, row) => {
    const base = 32 - row * 8;
    for (let col = 0; col < 8; col++) addMidi('note', 0, base + col, { kind: 'cell', layerId, col });
    addMidi('note', 0, 82 + row, { kind: 'layerClear', layerId });
  });
  for (let col = 0; col < 8; col++) addMidi('note', 0, col, { kind: 'column', col });
  addMidi('note', 0, 86, { kind: 'blackout' });
  addMidi('note', 0, 99, { kind: 'tap' });
  addMidi('note', 0, 97, { kind: 'deckPrev' });
  addMidi('note', 0, 96, { kind: 'deckNext' });
  layerIds.forEach((layerId, i) => addMidi('cc', i, 7, { kind: 'layerMaster', layerId }));
  addMidi('cc', 4, 7, { kind: 'haze' });
  addMidi('cc', 5, 7, { kind: 'speed' });
  addMidi('cc', 0, 14, { kind: 'grand' });

  const project: Project = {
    version: 1,
    name: 'LIGHT Demo Set',
    universes: [
      {
        id: 'u1',
        label: 'Art-Net node (U1)',
        artnetUniverse: 1,
        sacnUniverse: 1,
        artnet: true,
        sacn: false,
        unicast: null,
      },
    ],
    fixtures: [
      { id: 'derby1', name: 'Derby 1', profileId: 'varytec-derby-st-4ch', universeId: 'u1', address: 1, pos: { x: -2.6, y: 3.0, z: 0 }, rotY: 0 },
      { id: 'derby2', name: 'Derby 2', profileId: 'varytec-derby-st-4ch', universeId: 'u1', address: 11, pos: { x: 2.6, y: 3.0, z: 0 }, rotY: 0 },
      { id: 'bar1', name: 'Partybar 1', profileId: 'kam-partybar-wfs-20ch', universeId: 'u1', address: 21, pos: { x: -1.4, y: 3.0, z: 0 }, rotY: 0 },
      { id: 'bar2', name: 'Partybar 2', profileId: 'kam-partybar-wfs-20ch', universeId: 'u1', address: 51, pos: { x: 1.4, y: 3.0, z: 0 }, rotY: 0 },
      { id: 'hazer', name: 'Hazer', profileId: 'generic-hazer-2ch', universeId: 'u1', address: 101, pos: { x: 3.2, y: 0, z: 0.6 }, rotY: 0 },
    ],
    groups: [
      {
        id: 'g-all',
        name: 'All',
        heads: [
          { fixtureId: 'derby1', head: 0 },
          { fixtureId: 'derby2', head: 0 },
          ...[0, 1, 2, 3].map((h) => ({ fixtureId: 'bar1', head: h })),
          ...[0, 1, 2, 3].map((h) => ({ fixtureId: 'bar2', head: h })),
        ],
      },
      { id: 'g-derbies', name: 'Derbies', heads: [{ fixtureId: 'derby1', head: 0 }, { fixtureId: 'derby2', head: 0 }] },
      {
        id: 'g-pars',
        name: 'Bar Pars L→R',
        heads: [
          ...[0, 1, 2, 3].map((h) => ({ fixtureId: 'bar1', head: h })),
          ...[0, 1, 2, 3].map((h) => ({ fixtureId: 'bar2', head: h })),
        ],
      },
      { id: 'g-bar1', name: 'Bar 1', heads: [0, 1, 2, 3].map((h) => ({ fixtureId: 'bar1', head: h })) },
      { id: 'g-bar2', name: 'Bar 2', heads: [0, 1, 2, 3].map((h) => ({ fixtureId: 'bar2', head: h })) },
      { id: 'g-hazer', name: 'Hazer', heads: [{ fixtureId: 'hazer', head: 0 }] },
    ],
    props,
    looks,
    layers: [
      // index 0 = bottom of the stack; cells hold the ACTIVE deck (deck 1)
      {
        id: 'layer-wash', name: 'WASH', blend: 'normal', master: 1, fade: 0.8,
        cells: [...decks[0].cells['layer-wash']],
      },
      {
        id: 'layer-derby', name: 'DERBY', blend: 'normal', master: 1, fade: 0.5,
        cells: [...decks[0].cells['layer-derby']],
      },
      {
        id: 'layer-fx', name: 'FX', blend: 'multiply', master: 1, fade: 0.3,
        cells: [...decks[0].cells['layer-fx']],
      },
      {
        id: 'layer-strobe', name: 'STROBE', blend: 'htp', master: 1, fade: 0.05,
        cells: [...decks[0].cells['layer-strobe']],
      },
    ],
    columns: ['Intro', 'Build', 'Peak', 'Groove', 'Break', 'Drop', 'Outro', 'Chill'],
    decks,
    activeDeckId: 'deck-1',
    midi,
    sync: { oscEnabled: true, oscPort: 7700, followColumns: true, bpmFromOsc: true, linkEnabled: false },
    settings: { haze: 0, hazeFan: 0.35 },
  };

  return project;
}
