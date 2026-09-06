import { useStore } from './store.ts';
import { attachApcOutput, scheduleFeedback } from './apcFeedback.ts';

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
      const attach = () => {
        const names: string[] = [];
        access.inputs.forEach((input) => {
          names.push(input.name ?? 'MIDI input');
          input.onmidimessage = (e: MIDIMessageEvent) => {
            // When the engine owns native MIDI (Rust core), it already sees
            // this event — forwarding again would double-trigger.
            if (useStore.getState().engineMidi) return;
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
        attachApcOutput(access);
      };
      access.onstatechange = attach;
      attach();
      // LED feedback follows engine state (throttled + diffed internally)
      useStore.subscribe(() => scheduleFeedback());
    })
    .catch(() => {
      // no MIDI permission — the Sync panel explains how to enable it
    });
}
