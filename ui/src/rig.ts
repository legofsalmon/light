// Patching helpers shared by the Rig view and the fixture library: where the
// next fixture goes, and what it is called.
import type { Project } from '../../shared/types.ts';
import { uid } from '../../shared/types.ts';
import { profileMeta } from './profileInfo.ts';

/** The lowest address in `universeId` where `channels` fit without
 *  overlapping a patched fixture; 1 when nothing fits. */
export function nextFreeAddress(p: Project, universeId: string, channels: number): number {
  const used: [number, number][] = p.fixtures
    .filter((f) => f.universeId === universeId)
    .map((f) => [f.address, f.address + (profileMeta(p, f.profileId)?.channels ?? 1) - 1]);
  for (let a = 1; a + channels - 1 <= 512; a++) {
    if (used.every(([lo, hi]) => a + channels - 1 < lo || a > hi)) return a;
  }
  return 1;
}

/** Add one fixture on `profileId` at the next free address of the first
 *  universe, named after its model and numbered, spread along the front of
 *  the stage so a run of adds does not stack on one spot. Returns its id. */
export function addFixture(p: Project, profileId: string, channels: number, model: string): string {
  const universeId = p.universes[0]?.id ?? 'u1';
  const n = p.fixtures.filter((f) => f.profileId === profileId).length + 1;
  const id = uid('fx');
  p.fixtures.push({
    id,
    name: `${model} ${n}`,
    profileId,
    universeId,
    address: nextFreeAddress(p, universeId, channels),
    pos: { x: Math.round(((p.fixtures.length % 12) - 5.5) * 60) / 100, y: 2, z: 0 },
    rotY: 0,
  });
  return id;
}
