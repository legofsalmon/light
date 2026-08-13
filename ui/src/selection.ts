// Fixture selection → group creation, shared by the 2D previz bar and the
// fixtures table. The selection itself lives in the store (`fxSel`) so every
// surface highlights and acts on the same set.

import { uid } from '../../shared/types.ts';
import { profileMeta } from './profileInfo.ts';
import { useStore } from './store.ts';

/** Create a project group from every head of the selected fixtures. */
export function createGroupFromSelection(): void {
  const { project, fxSel, mutate, setFxSel } = useStore.getState();
  if (!project || fxSel.length === 0) return;
  const heads = fxSel.flatMap((fid) => {
    const f = project.fixtures.find((fx) => fx.id === fid);
    const prof = f && profileMeta(project, f.profileId);
    return prof ? prof.heads.map((_, hi) => ({ fixtureId: fid, head: hi })) : [];
  });
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
