import type { Effect, Look, LookPart, PartParams, Project } from '../shared/types.ts';

// ---------------------------------------------------------------------------
// Colm's Aug 2026 rig, exactly as patched on the Art-Net→DMX node (Universe 1):
// Derby1 @001, Derby2 @011 (4CH) · Bar1 @021, Bar2 @051 (20CH) · Hazer @101.
// Universe 0 stays with Resolume Arena → Octostrips (pixel-mapped, not ours).
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

  // --- wash looks (bars, all 8 pars) ---
  add(look('wash-amber', 'Amber Wash', [part('g-pars', { dimmer: 1, color: { h: 32, s: 0.95 } })]));
  add(look('wash-red', 'Red Wash', [part('g-pars', { dimmer: 1, color: { h: 0, s: 1 } })]));
  add(look('wash-blue', 'Deep Blue', [part('g-pars', { dimmer: 1, color: { h: 228, s: 1 } })]));
  add(look('wash-magenta', 'Magenta', [part('g-pars', { dimmer: 1, color: { h: 312, s: 1 } })]));
  add(look('wash-teal', 'Teal', [part('g-pars', { dimmer: 1, color: { h: 175, s: 0.9 } })]));
  add(look('wash-white', 'White', [part('g-pars', { dimmer: 1, color: { h: 0, s: 0 } })]));
  add(
    look('wash-rainbow', 'Rainbow Drift', [
      part('g-pars', { dimmer: 1, color: { h: 0, s: 1 } }, [
        fx({ target: 'hue', wave: 'sawUp', rate: 16, size: 1, spread: 0.5 }),
      ]),
    ])
  );
  add(
    look('wash-duotone', 'Red/Blue Split', [
      part('g-bar1', { dimmer: 1, color: { h: 0, s: 1 } }),
      part('g-bar2', { dimmer: 1, color: { h: 228, s: 1 } }),
    ])
  );

  // --- derby looks ---
  add(
    look('derby-red-spin', 'Derby Red Spin', [
      part('g-derbies', { dimmer: 1, color: { h: 0, s: 1 }, motorMode: 'rotate', motorValue: 0.35 }),
    ])
  );
  add(
    look('derby-rb-spin', 'Derby R+B Spin', [
      part('g-derbies', { dimmer: 1, macro: 88, motorMode: 'rotate', motorValue: 0.5 }),
    ])
  );
  add(
    look('derby-gb-slow', 'Derby G+B Slow', [
      part('g-derbies', { dimmer: 1, macro: 118, motorMode: 'rotate', motorValue: 0.15 }),
    ])
  );
  add(
    look('derby-white-aim', 'Derby White Static', [
      part('g-derbies', { dimmer: 1, color: { h: 0, s: 0 }, motorMode: 'aim', motorValue: 0.5 }),
    ])
  );
  add(
    look('derby-rgbw-fast', 'Derby RGBW Fast', [
      part('g-derbies', { dimmer: 1, macro: 208, motorMode: 'rotate', motorValue: 0.85 }),
    ])
  );

  // --- FX layer looks (dimmer modulation over whatever the wash is doing) ---
  add(
    look('fx-chase', 'Par Chase', [
      part('g-pars', {}, [fx({ target: 'dimmer', wave: 'chase', rate: 2, size: 1, width: 0.25 })]),
    ])
  );
  add(
    look('fx-swell', 'Slow Swell', [
      part('g-pars', {}, [fx({ target: 'dimmer', wave: 'sine', rate: 8, size: 0.8 })]),
    ])
  );
  add(
    look('fx-pulse', 'Beat Pulse', [
      part('g-pars', {}, [fx({ target: 'dimmer', wave: 'sawDown', rate: 1, size: 0.9 })]),
    ])
  );
  add(
    look('fx-flicker', 'Random Flicker', [
      part('g-pars', {}, [fx({ target: 'dimmer', wave: 'random', rate: 0.5, size: 1 })]),
    ])
  );
  add(
    look('fx-oddeven', 'Odd / Even', [
      part('g-pars', {}, [fx({ target: 'dimmer', wave: 'square', rate: 2, size: 1, spread: 0.5, width: 0.5 })]),
    ])
  );

  // --- strobe / punch looks (flash = momentary) ---
  add(
    look('strobe-all', 'Full Strobe', [
      part('g-pars', { dimmer: 1, color: { h: 0, s: 0 }, strobe: 0.75 }),
      part('g-derbies', { dimmer: 1, color: { h: 0, s: 0 }, strobe: 0.75 }),
    ], { flash: true, fade: 0 })
  );
  add(
    look('strobe-blinder', 'Ring Blinder', [
      part('g-derbies', { white: 1 }),
    ], { flash: true, fade: 0 })
  );
  add(
    look('strobe-ringfx', 'Ring Patterns', [
      part('g-derbies', { ringFx: 0.55 }),
    ])
  );

  const project: Project = {
    version: 1,
    name: 'Aug 2026 Rig',
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
    looks,
    layers: [
      // index 0 = bottom of the stack; the UI shows the top of the stack first
      {
        id: 'layer-wash', name: 'WASH', blend: 'normal', master: 1, fade: 0.8,
        cells: ['wash-amber', 'wash-red', 'wash-blue', 'wash-magenta', 'wash-teal', 'wash-duotone', 'wash-rainbow', 'wash-white'],
      },
      {
        id: 'layer-derby', name: 'DERBY', blend: 'normal', master: 1, fade: 0.5,
        cells: [null, 'derby-red-spin', 'derby-rb-spin', 'derby-gb-slow', null, 'derby-rgbw-fast', 'derby-white-aim', null],
      },
      {
        id: 'layer-fx', name: 'FX', blend: 'multiply', master: 1, fade: 0.3,
        cells: [null, 'fx-pulse', 'fx-chase', 'fx-swell', 'fx-oddeven', 'fx-flicker', null, null],
      },
      {
        id: 'layer-strobe', name: 'STROBE', blend: 'htp', master: 1, fade: 0.05,
        cells: ['strobe-all', 'strobe-blinder', 'strobe-ringfx', null, null, null, null, null],
      },
    ],
    columns: ['Intro', 'Build', 'Peak', 'Groove', 'Break', 'Drop', 'Outro', 'Chill'],
    midi: [],
    sync: { oscEnabled: true, oscPort: 7700, followColumns: true, bpmFromOsc: true },
    settings: { haze: 0, hazeFan: 0.35 },
  };

  return project;
}
