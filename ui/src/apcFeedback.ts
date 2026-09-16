// Connections to Akai control surfaces, and the LED diff that keeps the wire
// quiet. What the LEDs should SAY lives in surfaces.ts, which the Node suite
// tests against the Rust mirror (core/src/apc.rs).
//
// Both surfaces can be plugged in at once and each keeps its own diff cache:
// they paint different notes, and on the mini the MIDI channel is part of a
// pad's state rather than a constant, so a shared cache keyed on velocity
// alone would leave pads stuck at the wrong brightness.

import { useStore } from './store.ts';
import { SURFACES, clearAddresses, computeLeds, ledNote, type Surface } from './surfaces.ts';

// Re-exported so callers keep one import for "the surface": the grid shape is
// a contract the on-screen look grid keeps with the hardware.
import { choosePort } from '../../shared/midiInputs.ts';
export { APC_COLS, APC_LAYER_ROWS, APC_ROWS, APC_KNOB_BANKS, SURFACES } from './surfaces.ts';

/** One attached surface, with the diff cache that belongs to it. Two surfaces
 *  plugged in at once must not share a cache — they paint different notes.
 *  Keyed the way computeLeds is keyed: by the button's (channel, note) address,
 *  because on the APC40 eight buttons share note 52. */
type Attached = { surface: Surface; out: MIDIOutput; lastSent: Map<number, [number, number]> };

let attached: Attached[] = [];

export function attachApcOutput(access: MIDIAccess, off: string[] = []): void {
  // Whatever was attached before is let go first, blanked: a surface switched
  // off in Sync · MIDI is another app's now, and one that is chosen again is
  // repainted from an empty cache anyway. A port that has been unplugged
  // refuses the send; that is fine, there is nothing left to blank.
  for (const a of attached) {
    for (const [ch, n] of clearAddresses(a.surface)) {
      try { a.out.send([0x90 | ch, n, 0]); } catch { /* unplugged */ }
    }
  }
  attached = [];
  const outputs = [...access.outputs.values()];
  const names = outputs.map((o) => o.name ?? '');
  for (const surface of SURFACES) {
    const i = choosePort(names, surface.matches, off);
    if (i < 0) continue;
    const out = outputs[i]!;
    // Blank the whole surface once on attach. This has to cover every button
    // the map can produce, including ones it only ever INSERTS: computeLeds
    // adds the blackout LED when blackout is armed and never sets it to zero,
    // so the diff loop cannot turn it off either. Quitting with blackout armed
    // left it blinking "armed" on the hardware while blackout was actually off
    // — a false safety indicator on the physical surface. A Rust test and a
    // Node one pin every lit address against this list.
    //
    // Velocity 0, so this can never fire a cue if it comes back round a
    // loopback port: a zero-velocity note on is a note OFF, and every mapping
    // that fires anything is guarded on the press.
    for (const [ch, n] of clearAddresses(surface)) out.send([0x90 | ch, n, 0]);
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
      // diff: send only changes; explicitly turn off buttons that vanished.
      // The note goes out on the channel it was LIT on, which is not always the
      // channel in the key — on the mini the key is the pad and the channel is
      // its brightness.
      for (const [key, [ch, vel]] of lastSent) {
        if (!leds.has(key) && vel !== 0) {
          out.send([0x90 | ch, ledNote(key), 0]);
          lastSent.set(key, [ch, 0]);
        }
      }
      // The CHANNEL is part of the state, not just the velocity: on the mini a
      // pad that stays the same colour and changes brightness changes only the
      // channel, and folding it away would leave that pad stuck at its old
      // brightness while its layer lights the rig.
      for (const [key, [ch, vel]] of leds) {
        const was = lastSent.get(key);
        if (!was || was[0] !== ch || was[1] !== vel) {
          out.send([0x90 | ch, ledNote(key), vel]);
          lastSent.set(key, [ch, vel]);
        }
      }
    }
  }, 66); // ~15 Hz is plenty for LEDs
}
