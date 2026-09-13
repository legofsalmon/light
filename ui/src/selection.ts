// Fixture selection → group creation, shared by the 2D plan and the fixtures
// table. The selection itself lives in the store (`fxSel`) so every surface
// highlights and acts on the same set.

import type { HeadRef, Project } from '../../shared/types.ts';
import { uid } from '../../shared/types.ts';
import { profileMeta } from './profileInfo.ts';
import { notify, useStore } from './store.ts';

/** Every head of the selected fixtures, in table order. */
function headsOfSelection(project: Project, fxSel: string[]): HeadRef[] {
  return fxSel.flatMap((fid) => {
    const f = project.fixtures.find((fx) => fx.id === fid);
    const prof = f && profileMeta(project, f.profileId);
    return prof ? prof.heads.map((_, hi) => ({ fixtureId: fid, head: hi })) : [];
  });
}

/** Create a project group from every head of the selected fixtures. */
export function createGroupFromSelection(): void {
  const { project, fxSel, mutate, setFxSel } = useStore.getState();
  if (!project || fxSel.length === 0) return;
  const heads = headsOfSelection(project, fxSel);
  if (heads.length === 0) {
    // selection held only dangling ids — clear it, don't send a no-op edit
    setFxSel([]);
    return;
  }
  mutate((p) => {
    p.groups.push({ id: uid('g'), name: `Group ${p.groups.length + 1}`, heads });
  });
  setFxSel([]);
}

/** A group that already holds exactly these heads and no others — the same set,
 *  whatever order it stores them in, because chase order is the group's own
 *  business. */
function groupWithExactly(project: Project, heads: HeadRef[]): string | null {
  const key = (h: HeadRef) => `${h.fixtureId}:${h.head}`;
  const want = new Set(heads.map(key));
  const match = project.groups.find(
    (g) => g.heads.length === want.size && g.heads.every((h) => want.has(key(h))),
  );
  return match?.id ?? null;
}

/**
 * `+ look from selection` (A44): heads selected, and one press later they are
 * a group, a look that lights them, a pad pointing at it and the editor open
 * on it.
 *
 * The three things it will not do: it never reuses a pad that has something on
 * it, it never makes a second group where one already holds exactly these
 * heads, and it never fires anything — the pad is filled, not played.
 */
export function lookFromSelection(): void {
  const st = useStore.getState();
  const { project, fxSel } = st;
  if (!project || fxSel.length === 0) return;
  const heads = headsOfSelection(project, fxSel);
  if (heads.length === 0) {
    st.setFxSel([]);
    return;
  }

  // Where it lands: the selected pad if it is empty, else the first empty pad
  // on layer 1 of the song on stage.
  const layer1 = project.layers[0];
  const selLayer = st.sel && project.layers.find((l) => l.id === st.sel!.layerId);
  const columns = project.columns.length;
  let target: { layerId: string; col: number } | null = null;
  if (st.sel && selLayer && !selLayer.cells[st.sel.col]) target = { layerId: selLayer.id, col: st.sel.col };
  else if (layer1) {
    for (let c = 0; c < columns; c++) {
      if (!layer1.cells[c]) {
        target = { layerId: layer1.id, col: c };
        break;
      }
    }
  }
  if (!target) {
    notify(`${layer1?.name ?? 'the first layer'} has no free pad in this song — clear one, or select an empty pad first`);
    return;
  }

  const existing = groupWithExactly(project, heads);
  const lookId = uid('look');
  const pad = target;
  const names = fxSel
    .map((id) => project.fixtures.find((f) => f.id === id)?.name)
    .filter((n): n is string => !!n);
  const groupName = existing
    ? project.groups.find((g) => g.id === existing)!.name
    : names.length === 1 ? names[0] : `Group ${project.groups.length + 1}`;

  st.mutate((p) => {
    const groupId = existing ?? uid('g');
    if (!existing) p.groups.push({ id: groupId, name: groupName, heads });
    p.looks[lookId] = {
      id: lookId,
      name: groupName,
      parts: [{ id: uid('part'), groupId, params: { dimmer: 1 }, effects: [] }],
    };
    const ly = p.layers.find((l) => l.id === pad.layerId);
    if (!ly) return;
    while (ly.cells.length <= pad.col) ly.cells.push(null);
    ly.cells[pad.col] = lookId;
    // the song's own copy of the pads, kept in step the way every other pad
    // write does
    const deck = (p.decks ?? []).find((d) => d.id === p.activeDeckId);
    if (deck) deck.cells = Object.fromEntries(p.layers.map((x) => [x.id, [...x.cells]]));
  }, `make ${groupName} a look`);

  st.setSel(pad);
  // The editor lives in Build; Rig has no editor to open it in.
  st.setView('split');
  st.setTab('look');
}
