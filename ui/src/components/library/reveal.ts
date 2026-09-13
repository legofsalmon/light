// Showing somebody a thing that is already on screen, or nearly.
//
// Every one of these is deliberately inert: a pad is SELECTED and scrolled to,
// never fired; a column is scrolled to and never fired. The library and find
// both reach into the grid, and the rule for both is that reaching into the
// grid may move the eye and may move the cursor, and may never move a light.

import { useStore } from '../../store.ts';

/** After React has painted the new selection, bring it into view. */
function afterPaint(fn: () => void): void {
  if (typeof requestAnimationFrame === 'undefined') return;
  requestAnimationFrame(() => requestAnimationFrame(fn));
}

const show = (el: Element | null | undefined) =>
  el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });

/** The first pad pointing at `lookId` in the song on the grid, top layer
 *  first — the same order the grid draws. Null when it is on none. */
export function firstPad(lookId: string): { layerId: string; col: number } | null {
  const p = useStore.getState().project;
  if (!p) return null;
  for (const layer of [...p.layers].reverse()) {
    const col = layer.cells.indexOf(lookId);
    if (col >= 0) return { layerId: layer.id, col };
  }
  return null;
}

/** Select a pad and scroll to it. Selecting never fires (LookGrid's name strip
 *  is the same gesture), so this is safe mid-song. */
export function selectPad(layerId: string, col: number): void {
  useStore.getState().setSel({ layerId, col });
  afterPaint(() => show(document.querySelector('.lookgrid .cell.selected')));
}

/** Scroll the grid to a column. Never fires it: a column head is one of the
 *  five gestures that reach the rig, and this is not one of them. */
export function showColumn(col: number): void {
  afterPaint(() => show(document.querySelectorAll('.lookgrid .colhead')[col]));
}

/** Put the fixtures of these heads on the plan's selection, and open the band
 *  if it is folded — a "show me" that shows nothing is not a verb. */
export function showOnPlan(fixtureIds: string[]): void {
  const st = useStore.getState();
  st.setFxSel([...new Set(fixtureIds)]);
  const band = st.view === 'previz' ? null : st.view;
  if (band && st.previzHidden[band]) st.togglePreviz(band);
}

/** The Rig view, with this group's fixtures selected — the table row and the
 *  plan read the same selection, so both land on it. */
export function showGroup(groupId: string): void {
  const st = useStore.getState();
  const group = st.project?.groups.find((g) => g.id === groupId);
  if (!group) return;
  st.setView('patch');
  st.setFxSel([...new Set(group.heads.map((h) => h.fixtureId))]);
  afterPaint(() => show(document.querySelector(`[data-group-id="${CSS.escape(groupId)}"]`) ?? document.querySelector('tr.rowsel')));
}
