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
            useStore.getState().handleMidi(d[0], d[1] ?? 0, d[2] ?? 0);
          };
        });
        if (!useStore.getState().engineMidi) useStore.getState().setMidiInputs(names);
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
