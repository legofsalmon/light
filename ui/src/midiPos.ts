// Where a controller physically sits, against where the value is.
//
// An APC's track faders and device knobs are ABSOLUTE: they send the position
// they are at, and they do not move when the screen does. So after a song
// switch, a look change, a Keep, or anyone dragging the on-screen fader, the
// physical control is wherever it was left — and the next touch of it jumps the
// value there, with no warning and mid-show. Hog draws a bar for exactly this
// reason; this is the reading behind ours (design A35).
//
// Pure, and in its own file: store.ts opens a socket when it is imported, so
// nothing that wants to check this rule could reach it there.
import type { MidiAction, Project } from '../../shared/types.ts';

/** Two actions mean the same control. Structural rather than by id, because a
 *  mapping stores the action itself and not a reference to the thing it
 *  drives — `{kind:'layerMaster', layerId:'L1'}` is the whole identity. */
export function sameAction(a: MidiAction, b: MidiAction): boolean {
  if (a.kind !== b.kind) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if ((a as Record<string, unknown>)[k] !== (b as Record<string, unknown>)[k]) return false;
  }
  return true;
}

/** Where the hardware sits for a control, 0..1, or null when nothing has moved
 *  a knob bound to it this session.
 *
 *  `cc` is keyed `channel:number` with the channel 0-based, as it arrives on
 *  the wire. A control can carry more than one mapping — two surfaces, or a
 *  duplicate — and the most recently moved one is the one a hand is on, so the
 *  last match wins. Note mappings are not positions and are skipped. */
export function hardwareAt(
  project: Pick<Project, 'midi'> | null,
  cc: Record<string, number>,
  action: MidiAction | undefined,
): number | null {
  if (!project || !action) return null;
  let best: number | null = null;
  for (const m of project.midi) {
    if (m.type !== 'cc' || !sameAction(m.action, action)) continue;
    const v = cc[`${m.channel}:${m.number}`];
    if (v !== undefined) best = v / 127;
  }
  return best;
}
