// APC40 mk2 LED feedback: the pad grid mirrors the look grid (bright = the
// playing cell, dim = available cells, coloured by each look's swatch), the
// bottom row mirrors cue columns, scene LEDs light when their layer has
// something to clear, and scene 5 blinks while blackout is armed.
//
// Hardware notes (mk2, generic mode): only the 5×8 clip grid is RGB — pads
// take a 128-entry palette index as note-on velocity (channel 0 = solid).
// Scene-launch LEDs are single-colour: velocity 0 off / 1 on / 2 blink.

import type { Project, Snapshot } from '../../shared/types.ts';
import { useStore } from './store.ts';
import { lookSwatch } from './lookColors.ts';

// Palette anchors (APC40 mk2 shares the Launchpad-style 128 palette):
// {rgb → bright index, dim index}
const PALETTE: { r: number; g: number; b: number; bright: number; dim: number }[] = [
  { r: 255, g: 0, b: 0, bright: 5, dim: 7 },
  { r: 255, g: 127, b: 0, bright: 9, dim: 11 },
  { r: 255, g: 255, b: 0, bright: 13, dim: 15 },
  { r: 127, g: 255, b: 0, bright: 17, dim: 19 },
  { r: 0, g: 255, b: 0, bright: 21, dim: 23 },
  { r: 0, g: 255, b: 127, bright: 25, dim: 27 },
  { r: 0, g: 255, b: 255, bright: 37, dim: 39 },
  { r: 0, g: 127, b: 255, bright: 41, dim: 43 },
  { r: 0, g: 0, b: 255, bright: 45, dim: 47 },
  { r: 127, g: 0, b: 255, bright: 49, dim: 51 },
  { r: 255, g: 0, b: 255, bright: 53, dim: 55 },
  { r: 255, g: 0, b: 127, bright: 57, dim: 59 },
  { r: 255, g: 255, b: 255, bright: 3, dim: 1 },
];

function nearest(hex: string): { bright: number; dim: number } {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  // low-chroma greys read best as white on the pads
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max - min < 40) return { bright: 3, dim: 1 };
  let best = PALETTE[0];
  let bd = Infinity;
  for (const p of PALETTE) {
    const d = (r - p.r) ** 2 + (g - p.g) ** 2 + (b - p.b) ** 2;
    if (d < bd) {
      bd = d;
      best = p;
    }
  }
  return best;
}

/** note → [channel, velocity]; everything not present = off */
function computeLeds(project: Project, snap: Snapshot | null): Map<number, [number, number]> {
  const leds = new Map<number, [number, number]>();
  const visual = [...project.layers].reverse();
  const liveOf = (id: string) => snap?.layers.find((l) => l.id === id);

  visual.slice(0, 5).forEach((layer, row) => {
    const base = 32 - row * 8;
    const live = liveOf(layer.id);
    for (let col = 0; col < Math.min(8, project.columns.length); col++) {
      const lookId = layer.cells[col];
      if (!lookId) continue;
      const look = project.looks[lookId];
      if (!look) continue;
      const pal = nearest(lookSwatch(look, project.looks)[0] ?? '#666666');
      const active = live?.lookId === lookId && live?.col === col;
      leds.set(base + col, [0, active ? pal.bright : pal.dim]);
    }
    // scene LED (single-colour): on when the layer has something to clear
    if (live?.lookId) leds.set(82 + row, [0, 1]);
  });

  // stop-all-clips = blackout: blink while armed
  if (snap?.blackout) leds.set(81, [0, 2]);

  return leds;
}

let output: MIDIOutput | null = null;
const lastSent = new Map<number, number>(); // note → velocity (channel folded in)

export function attachApcOutput(access: MIDIAccess): void {
  output = null;
  for (const out of access.outputs.values()) {
    if (/apc40/i.test(out.name ?? '')) output = out;
  }
  lastSent.clear();
  if (!output) return;
  // clear the whole surface once on attach
  for (let n = 0; n <= 39; n++) output.send([0x90, n, 0]);
  for (let n = 82; n <= 86; n++) output.send([0x90, n, 0]);
}

let pending = false;

export function scheduleFeedback(): void {
  if (!output || pending) return;
  // when the engine owns native MIDI (Rust core / packaged app), it also
  // drives the LEDs — two writers with independent diff caches would fight
  if (useStore.getState().engineMidi) return;
  pending = true;
  setTimeout(() => {
    pending = false;
    const { project, snap } = useStore.getState();
    if (!output || !project) return;
    const leds = computeLeds(project, snap);
    // diff: send only changes; explicitly turn off notes that vanished
    for (const [note, vel] of lastSent) {
      if (!leds.has(note) && vel !== 0) {
        output.send([0x90, note, 0]);
        lastSent.set(note, 0);
      }
    }
    for (const [note, [ch, vel]] of leds) {
      if (lastSent.get(note) !== vel) {
        output.send([0x90 | ch, note, vel]);
        lastSent.set(note, vel);
      }
    }
  }, 66); // ~15 Hz is plenty for LEDs
}
