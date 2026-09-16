// How long a Discard takes (design #50, A11 — Eos's sneak).
//
// A Discard used to snap: every nudge vanished in one frame, which on a wash is
// a visible jump in the room at exactly the moment someone decided the nudge was
// wrong. A sneak brings the look back over time instead.
//
// Over the fade of the look the nudges belong to, because that is the pace the
// operator already chose for that look arriving. Nudges almost always sit on one
// look — the one being worked on — so the first nudged look decides; a look with
// no fade of its own uses its layer's. A look set to snap (fade 0) discards
// instantly, which is exactly what it would do firing.
//
// Pure, and outside store.ts, which opens a socket when it is imported.
/** Only what the rule reads, so a caller with a narrowed view of the store —
 *  the shortcut table, which stays free of the browser — can pass what it has. */
type LookFades = {
  looks: Record<string, { id: string; fade?: number }>;
  layers: { fade: number; cells: (string | null)[] }[];
};
type Nudges = { soft?: { lookId: string }[] };

export function discardFade(project: LookFades | null, snap: Nudges | null): number | undefined {
  const first = snap?.soft?.[0];
  if (!project || !first) return undefined;
  const look = Object.hasOwn(project.looks, first.lookId) ? project.looks[first.lookId] : undefined;
  if (!look) return undefined;
  if (typeof look.fade === 'number' && Number.isFinite(look.fade)) return look.fade > 0 ? look.fade : undefined;
  // no fade of its own: the layer the look sits on in the song that is up
  const layer = project.layers.find((l) => l.cells.includes(look.id));
  return layer && layer.fade > 0 ? layer.fade : undefined;
}
