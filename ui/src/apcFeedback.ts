// Connections to Akai control surfaces, and the LED diff that keeps the wire
// quiet. What the LEDs should SAY lives in surfaces.ts, which the Node suite
// tests against the Rust mirror (core/src/apc.rs).
//
// Both surfaces can be plugged in at once and each keeps its own diff cache:
// they paint different notes, and on the mini the MIDI channel is part of a
// pad's state rather than a constant, so a shared cache keyed on velocity
// alone would leave pads stuck at the wrong brightness.

import { useStore } from './store.ts';
import { SURFACES, computeLeds, type Surface } from './surfaces.ts';

// Re-exported so callers keep one import for "the surface": the grid shape is
// a contract the on-screen look grid keeps with the hardware.
export { APC_COLS, APC_LAYER_ROWS, APC_ROWS, APC_KNOB_BANKS, SURFACES } from './surfaces.ts';

/** One attached surface, with the diff cache that belongs to it. Two surfaces
 *  plugged in at once must not share a cache — they paint different notes. */
type Attached = { surface: Surface; out: MIDIOutput; lastSent: Map<number, [number, number]> };

let attached: Attached[] = [];

export function attachApcOutput(access: MIDIAccess): void {
  attached = [];
  const outputs = [...access.outputs.values()];
  for (const surface of SURFACES) {
    const out = outputs.find((o) => {
      const n = (o.name ?? '').toLowerCase();
      return surface.matches.some((m) => n.includes(m));
    });
    if (!out) continue;
    // Blank the whole surface once on attach. This has to cover every note the
    // map can produce, including ones it only ever INSERTS: computeLeds adds
    // the blackout LED when blackout is armed and never sets it to zero, so the
    // diff loop cannot turn it off either. Quitting with blackout armed left it
    // blinking "armed" on the hardware while blackout was actually off — a
    // false safety indicator on the physical surface. A Rust test now pins
    // every lit note against these ranges.
    for (const [from, to] of surface.clear) {
      for (let n = from; n <= to; n++) out.send([0x90, n, 0]);
    }
    attached.push({ surface, out, lastSent: new Map() });
  }
}

let pending = false;

export function scheduleFeedback(): void {
  if (attached.length === 0 || pending) return;
  // when the engine owns native MIDI (Rust core / packaged app), it also
  // drives the LEDs — two writers with independent diff caches would fight
  if (useStore.getState().engineMidi) return;
  pending = true;
  setTimeout(() => {
    pending = false;
    const { project, snap } = useStore.getState();
    if (!project) return;
    for (const { surface, out, lastSent } of attached) {
      const leds = computeLeds(project, snap, surface);
      // diff: send only changes; explicitly turn off notes that vanished
      for (const [note, [ch, vel]] of lastSent) {
        if (!leds.has(note) && vel !== 0) {
          out.send([0x90 | ch, note, 0]);
          lastSent.set(note, [ch, 0]);
        }
      }
      // The CHANNEL is part of the state, not just the velocity: on the mini a
      // pad that stays the same colour and changes brightness changes only the
      // channel, and folding it away would leave that pad stuck at its old
      // brightness while its layer lights the rig.
      for (const [note, [ch, vel]] of leds) {
        const was = lastSent.get(note);
        if (!was || was[0] !== ch || was[1] !== vel) {
          out.send([0x90 | ch, note, vel]);
          lastSent.set(note, [ch, vel]);
        }
      }
    }
  }, 66); // ~15 Hz is plenty for LEDs
}
