import { useStore } from './store.ts';
import { attachApcOutput, scheduleFeedback } from './apcFeedback.ts';
import { midiInputOn } from '../../shared/midiInputs.ts';

/**
 * WebMIDI input for browser-hosted sessions. In the Tauri app MIDI arrives
 * in the Rust core instead; this module quietly does nothing when the
 * WebMIDI API is unavailable (e.g. WKWebView).
 */
export function initMidi(): void {
  const nav = navigator as Navigator & {
    requestMIDIAccess?: (opts?: { sysex: boolean }) => Promise<MIDIAccess>;
  };
  if (!nav.requestMIDIAccess) return;
  nav
    .requestMIDIAccess({ sysex: false })
    .then((access) => {
      const offNow = () => useStore.getState().project?.sync.midiInputsOff ?? [];
      const attach = () => {
        const names: string[] = [];
        access.inputs.forEach((input) => {
          const name = input.name ?? 'MIDI input';
          names.push(name);
          input.onmidimessage = (e: MIDIMessageEvent) => {
            // When the engine owns native MIDI (Rust core), it already sees
            // this event — forwarding again would double-trigger.
            if (useStore.getState().engineMidi) return;
            // A switched-off input (Sync · MIDI) is another app's controller:
            // nothing it sends reaches the engine, learn included. The same
            // rule, by the same name, that the native engine applies.
            if (!midiInputOn(useStore.getState().project?.sync, name)) return;
            const d = e.data;
            if (!d || d.length === 0) return;
            // System realtime — clock, start, continue, stop. A source sending
            // beat clock sends 48 of these a second at 120 BPM, and none of
            // them is a mapping: dropping them here saves the store a lookup
            // per message. Following the clock is the native engine's job; a
            // browser cannot see a timestamp worth averaging.
            if (d[0] >= 0xf8) return;
            useStore.getState().handleMidi(d[0], d[1] ?? 0, d[2] ?? 0);
          };
        });
        // always report what WebMIDI sees; the store decides which list wins
        useStore.getState().setMidiInputs(names);
        attachApcOutput(access, offNow());
      };
      access.onstatechange = attach;
      attach();
      // LED feedback follows engine state (throttled + diffed internally),
      // and the surface it goes to follows the switch: when the off list
      // changes, the outputs are chosen again.
      let lastOff = offNow().join('\t');
      useStore.subscribe(() => {
        const off = offNow().join('\t');
        if (off !== lastOff) {
          lastOff = off;
          attach();
        }
        scheduleFeedback();
      });
    })
    .catch(() => {
      // no MIDI permission — the Sync panel explains how to enable it
    });
}
