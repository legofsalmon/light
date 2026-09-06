// What the stage views draw: the box the operator set, or the rig with a
// margin. One rule for the 2D plan, the in-app 3D and the Stage table, so a
// fixture that is on the plan is on the floor as well.
//
// The native previz derives the same way (Bounds::of + fit_backdrop in
// previz/src/scene.rs); this is that rule for the web, with the web's own
// floor: nothing placed shows the club-sized window it always has.
import type { Project, StageSize } from './types.ts';

export type StageExtent = {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  /** the top of the view, metres above the floor */
  yTop: number;
  /** true when the extent is the stage the operator set */
  manual: boolean;
};

/** what the plan shows with nothing placed */
export const DEFAULT_VIEW = { x0: -5.5, x1: 5.5, z0: -3, z1: 6, yTop: 7 } as const;
/** metres around whatever is placed — the same margin the native previz keeps */
const MARGIN = 3;
/** metres of apron shown around a manual stage, so an edge fixture stays grabbable */
const APRON = 1;

/** The stage rectangle itself, on the floor: manual sizes only. */
export function stageRect(stage: StageSize): { x0: number; x1: number; z0: number; z1: number } {
  return { x0: -stage.w / 2, x1: stage.w / 2, z0: -stage.d / 2, z1: stage.d / 2 };
}

export function stageExtent(p: Pick<Project, 'fixtures' | 'props' | 'stage'>): StageExtent {
  if (p.stage) {
    const r = stageRect(p.stage);
    return { x0: r.x0 - APRON, x1: r.x1 + APRON, z0: r.z0 - APRON, z1: r.z1 + APRON, yTop: p.stage.h + APRON, manual: true };
  }
  let x0 = Infinity;
  let x1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  let y1 = -Infinity;
  let any = false;
  for (const f of p.fixtures) {
    x0 = Math.min(x0, f.pos.x);
    x1 = Math.max(x1, f.pos.x);
    z0 = Math.min(z0, f.pos.z);
    z1 = Math.max(z1, f.pos.z);
    y1 = Math.max(y1, f.pos.y);
    any = true;
  }
  for (const pr of p.props ?? []) {
    // a rotated prop can reach further than its centre in either axis
    const reach = pr.size ? Math.max(pr.size.w, pr.size.d) / 2 : 0.5;
    const top = (pr.y ?? 0) + (pr.size?.h ?? 1.8);
    x0 = Math.min(x0, pr.pos.x - reach);
    x1 = Math.max(x1, pr.pos.x + reach);
    z0 = Math.min(z0, pr.pos.z - reach);
    z1 = Math.max(z1, pr.pos.z + reach);
    y1 = Math.max(y1, top);
    any = true;
  }
  if (!any) return { ...DEFAULT_VIEW, manual: false };
  // Whole metres, so the window only steps when something crosses a metre
  // line — a drag near the edge does not zoom the plan under the pointer.
  return {
    x0: Math.min(DEFAULT_VIEW.x0, Math.floor(x0 - MARGIN)),
    x1: Math.max(DEFAULT_VIEW.x1, Math.ceil(x1 + MARGIN)),
    z0: Math.min(DEFAULT_VIEW.z0, Math.floor(z0 - MARGIN)),
    z1: Math.max(DEFAULT_VIEW.z1, Math.ceil(z1 + MARGIN)),
    yTop: Math.max(DEFAULT_VIEW.yTop, Math.ceil(y1 + MARGIN)),
    manual: false,
  };
}
