// Named colours the show keeps (design A12, slices 1 and 2).
//
// The editor offered twelve hard-coded swatches, and a look kept its colour
// inside itself. So retuning a venue's blue — the house LEDs read cold, the
// band wanted it warmer — was one edit per look that used it, thirty of them,
// from a view that shows one look at a time.
//
// A palette is a name and a colour. The show keeps a list of them; the editor
// offers them instead of the fixed twelve; and changing one's colour offers to
// carry every part that was set to that colour along with it, in one undoable
// step. The renderer never sees a palette — it is a way of editing colours, not
// a new kind of colour — so nothing here touches the tick.
//
// Pure, and outside store.ts, which opens a socket when it is imported.

import type { Palette, Project } from '../../shared/types.ts';

/** The twelve the editor has always offered, named, for a show that has not
 *  made its own. Hue is DEGREES, as it is everywhere a colour lives. */
export const DEFAULT_PALETTES: Palette[] = [
  { id: 'pal-red', name: 'red', h: 0, s: 1 },
  { id: 'pal-orange', name: 'orange', h: 30, s: 1 },
  { id: 'pal-amber', name: 'amber', h: 52, s: 1 },
  { id: 'pal-green', name: 'green', h: 120, s: 1 },
  { id: 'pal-teal', name: 'teal', h: 160, s: 0.95 },
  { id: 'pal-cyan', name: 'cyan', h: 195, s: 1 },
  { id: 'pal-blue', name: 'blue', h: 228, s: 1 },
  { id: 'pal-violet', name: 'violet', h: 262, s: 1 },
  { id: 'pal-purple', name: 'purple', h: 290, s: 1 },
  { id: 'pal-magenta', name: 'magenta', h: 315, s: 1 },
  { id: 'pal-pink', name: 'pink', h: 345, s: 0.9 },
  { id: 'pal-white', name: 'white', h: 0, s: 0 },
];

/** The show's palettes, or the starting twelve when it has none of its own.
 *  An old project opens with exactly what the editor always offered. */
export function palettesOf(project: Pick<Project, 'palettes'> | null): Palette[] {
  return project?.palettes && project.palettes.length > 0 ? project.palettes : DEFAULT_PALETTES;
}

/** Shortest distance round the wheel, in degrees, 0..180. */
const hueGap = (a: number, b: number): number => {
  const d = Math.abs(((a - b) % 360 + 360) % 360);
  return d > 180 ? 360 - d : d;
};

/** A colour that IS this palette colour: the same numbers, to within rounding. */
const EXACT_HUE = 0.5;
const EXACT_SAT = 0.005;
/** A colour close enough to be the same idea, set by hand or nudged and kept —
 *  worth naming in the retune, never worth changing without being asked. */
const NEAR_HUE = 15;
const NEAR_SAT = 0.15;

/** Is this part colour the palette colour? White has no hue to speak of, so two
 *  desaturated colours are the same whatever their hue says. */
function sameColour(c: { h: number; s: number }, p: { h: number; s: number }, hueTol: number, satTol: number): boolean {
  if (Math.abs(c.s - p.s) > satTol) return false;
  if (p.s <= satTol && c.s <= satTol) return true;
  return hueGap(c.h, p.h) <= hueTol;
}

/** Is this colour exactly that palette colour? The one test the editor lights a
 *  swatch by and the retune moves a part by, so the two never disagree. */
export function onPalette(c: { h: number; s: number }, p: { h: number; s: number }): boolean {
  return sameColour(c, p, EXACT_HUE, EXACT_SAT);
}

export type RetunePlan = {
  /** parts set to exactly the old colour: these move */
  exact: { lookId: string; partId: string }[];
  /** parts close to it but not on it: named, left alone */
  near: { lookId: string; partId: string }[];
  /** how many distinct looks the exact parts span, for the question */
  looks: number;
};

/** What changing a palette colour would carry with it. Matched by VALUE: a part
 *  holds a hue and a saturation, not a reference to a palette, so "the parts
 *  that use venue blue" means the parts set to venue blue's numbers. The honest
 *  limit — a part nudged a few degrees and kept is not an exact match — is
 *  exactly why the near ones are reported rather than silently skipped. */
export function retunePlan(
  project: Pick<Project, 'looks'>,
  from: { h: number; s: number },
  /** where the palette is going: a part already there is not "near and left
   *  behind" — the retune lands on it */
  to?: { h: number; s: number },
): RetunePlan {
  const exact: RetunePlan['exact'] = [];
  const near: RetunePlan['near'] = [];
  const touched = new Set<string>();
  for (const look of Object.values(project.looks)) {
    for (const part of look.parts) {
      const c = part.params.color;
      if (!c) continue;
      if (onPalette(c, from)) {
        exact.push({ lookId: look.id, partId: part.id });
        touched.add(look.id);
      } else if (to && onPalette(c, to)) {
        continue;
      } else if (sameColour(c, from, NEAR_HUE, NEAR_SAT)) {
        near.push({ lookId: look.id, partId: part.id });
      }
    }
  }
  return { exact, near, looks: touched.size };
}

/** Carry the planned parts to the new colour. Writes into the project it is
 *  given, so a caller runs it inside one `mutate` — one undo step for the lot. */
export function applyRetune(project: Project, plan: RetunePlan, to: { h: number; s: number }): void {
  for (const { lookId, partId } of plan.exact) {
    const part = project.looks[lookId]?.parts.find((p) => p.id === partId);
    if (part) part.params.color = { h: to.h, s: to.s };
  }
}

/** The parts a palette tap on the performance surface reaches: every part of
 *  every look a layer is playing right now that carries a colour of its own. A
 *  part that leaves colour to the layers under it is left alone — tinting it
 *  would change what it does, not what colour it is. */
export function playingColourParts(
  project: Pick<Project, 'looks'>,
  playing: (string | null | undefined)[],
): { lookId: string; partId: string }[] {
  const out: { lookId: string; partId: string }[] = [];
  const seen = new Set<string>();
  for (const lookId of playing) {
    if (!lookId || seen.has(lookId) || !Object.hasOwn(project.looks, lookId)) continue;
    seen.add(lookId);
    for (const part of project.looks[lookId]!.parts) {
      if (part.params.color) out.push({ lookId, partId: part.id });
    }
  }
  return out;
}
