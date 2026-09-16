// Which MIDI inputs LIGHT listens to, and which output a surface's LEDs go to.
//
// Two APC40s on one Mac — one for LIGHT, one for Resolume — send the same
// notes and differ only by name, so the name is the whole choice. A show lists
// the inputs it does NOT listen to; everything else is on, as every show
// before this was. The Rust engine holds the same two rules (`midi_input_on`
// in core/src/state.rs, `choose_port` in core/src/apc.rs); these are the
// browser's, for WebMIDI.
import type { SyncCfg } from './types.ts';

/** Does LIGHT listen to this input? Off by name, in Sync · MIDI. */
export function midiInputOn(sync: Pick<SyncCfg, 'midiInputsOff'> | undefined, name: string): boolean {
  return !(sync?.midiInputsOff ?? []).includes(name);
}

/** The port a surface's LEDs go to: the first whose name says it is this
 *  surface and that is not switched off. -1 when there is none. */
export function choosePort(names: string[], matches: string[], off: string[]): number {
  return names.findIndex((n) => {
    const lower = n.toLowerCase();
    return matches.some((m) => lower.includes(m)) && !off.includes(n);
  });
}
