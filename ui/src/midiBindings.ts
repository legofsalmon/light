// What a control is already bound to, and whether two controls are fighting
// over the same key (design #32, A48).
//
// Arena tints every assignable control while mapping is on and prints what each
// one already answers to, with duplicates in red. LIGHT's learn mode only ever
// showed the one target you clicked, so the questions it cannot answer are the
// ones that matter at 1 a.m.: what is this bound to already, is anything bound
// at all, and did I just put two things on the same note.
//
// Pure, and in its own file, for the same reason as midiPos.ts: store.ts opens
// a socket when it is imported, so nothing that wants to check these rules
// could reach them there.
import type { MidiAction, MidiMapping, Project } from '../../shared/types.ts';
import { describeMidiSource } from './labels.ts';
import { sameAction } from './midiPos.ts';

/** Every mapping that drives this control. */
export function mappingsFor(project: Pick<Project, 'midi'> | null, action: MidiAction | undefined): MidiMapping[] {
  if (!project || !action) return [];
  return project.midi.filter((m) => sameAction(m.action, action));
}

/** The key a mapping listens on, as one string — `cc7` / `note53ch2`.
 *  Two mappings with the same one are two things on the same key. */
const slotOf = (m: Pick<MidiMapping, 'type' | 'channel' | 'number'>): string =>
  `${m.type}:${m.channel}:${m.number}`;

/** The mapping ids that share their key with a mapping driving something else.
 *
 *  Two mappings on one key is not always wrong — the APC preset deliberately
 *  binds all nine knob banks of a knob to the same dial, and those drive the
 *  SAME control. What is worth shouting about is one key driving two different
 *  things, where a press does both and neither is what was wanted. */
export function clashingMappingIds(project: Pick<Project, 'midi'> | null): Set<string> {
  const out = new Set<string>();
  if (!project) return out;
  const bySlot = new Map<string, MidiMapping[]>();
  for (const m of project.midi) {
    const k = slotOf(m);
    if (!bySlot.has(k)) bySlot.set(k, []);
    bySlot.get(k)!.push(m);
  }
  for (const group of bySlot.values()) {
    if (group.length < 2) continue;
    const first = group[0]!.action;
    if (group.every((m) => sameAction(m.action, first))) continue; // one control, many banks
    for (const m of group) out.add(m.id);
  }
  return out;
}

/** What a control answers to today, for the label learn mode prints on it.
 *
 *  `null` when nothing is bound — which is itself the answer worth seeing while
 *  learn is armed, so the caller draws "unbound" rather than nothing. `clash`
 *  says another control shares one of these keys. */
export function bindingOf(
  project: Pick<Project, 'midi'> | null,
  action: MidiAction | undefined,
): { text: string; clash: boolean } | null {
  const hits = mappingsFor(project, action);
  if (hits.length === 0) return null;
  const clashes = clashingMappingIds(project);
  const clash = hits.some((m) => clashes.has(m.id));
  // One control bound across several banks of the same knob is one binding, not
  // nine: say it once, with the count, the way the dial row already does.
  const slots = new Set(hits.map((m) => `${m.type}:${m.number}`));
  const text = slots.size === 1
    ? describeMidiSource(hits[0]!) + (hits.length > 1 ? ` ×${hits.length}` : '')
    : [...new Set(hits.map((m) => describeMidiSource(m)))].join(' · ');
  return { text, clash };
}
