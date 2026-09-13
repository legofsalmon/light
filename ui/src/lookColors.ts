import type { Look, LookPart, Project } from '../../shared/types.ts';
import { derbyMacroForValue, hsvToRgb, rgbHex } from '../../shared/color.ts';
import { color } from './tokens.ts';

// the swatch palette is a token set (Figma: Primitives/swatch), shared with the design file
const RAINBOW = [1, 2, 3, 4, 5, 6].map((i) => color[`swatch/rainbow-${i}` as keyof typeof color]);

/** Representative colour strip for a look's grid-cell thumbnail. Cue lists
 *  borrow the swatch of their first resolvable step (pass `looks` for that). */
export function lookSwatch(look: Look, looks?: Record<string, Look>): string[] {
  if (look.steps?.length && looks) {
    for (const st of look.steps) {
      const target = Object.hasOwn(looks, st.lookId) ? looks[st.lookId] : undefined;
      if (target && !target.steps?.length) return lookSwatch(target);
    }
    return [color['swatch/neutral']];
  }
  const out: string[] = [];
  for (const part of look.parts) {
    if (part.effects.some((e) => e.target === 'hue')) {
      out.push(...RAINBOW);
      continue;
    }
    if (part.params.macro !== undefined) {
      for (const [r, g, b] of derbyMacroForValue(part.params.macro).comps) {
        out.push(rgbHex(r / 255, g / 255, b / 255));
      }
      continue;
    }
    if (part.params.color) {
      const [r, g, b] = hsvToRgb(part.params.color.h, part.params.color.s, 1);
      out.push(rgbHex(r, g, b));
      continue;
    }
    if (part.params.white !== undefined || part.params.ringFx !== undefined) {
      out.push(color['swatch/white']);
      continue;
    }
    if (part.params.strobe !== undefined) {
      out.push(color['swatch/strobe']);
      continue;
    }
    if (part.params.dimmer !== undefined || part.effects.length > 0) {
      out.push(color['swatch/dimmer']);
    }
  }
  return out.length ? out.slice(0, 8) : [color['swatch/neutral']];
}

// ---------- the pad face: a miniature of the rig (design 2.3, #30) ----------
//
// `lookSwatch` above draws vertical stripes with no spatial meaning, so Cold
// Seam and Open Blue are the same blue block and an effect-only look is grey.
// The face answers the other question — WHICH of the rig this look touches —
// with one mark per group, left to right in stage order. It is a second
// reading of the same look, never a replacement: `lookSwatch` and its first
// element are what the APC's LEDs and the pad glow read (surfaces.ts, and
// core/src/apc.rs re-implements the first-colour rule by hand), so the screen
// and the hardware only agree while those stay one rule. Nothing below feeds
// them, and nothing above this line changed.

/** One mark on a face: the group a part drives, in that part's own colour. */
export type FaceMark = {
  groupId: string;
  /** the group's name — the library prints the first one to tell twins apart */
  group: string;
  /** the mark's colour; a hollow mark draws it as an outline */
  color: string;
  /** the part says nothing about brightness or colour — it only aims a head or
   *  runs an effect — so the mark is an outline rather than a fill */
  hollow: boolean;
};

/** What a pad or a library tile draws instead of the stripe. */
export type LookFace = {
  /** one per group the look touches, in stage order */
  marks: FaceMark[];
  /** a steps look draws a row of this many dots; 0 for an ordinary look */
  steps: number;
};

const EMPTY_FACE: LookFace = { marks: [], steps: 0 };

/** Left to right across the stage: a group sits at the mean x of its heads (x
 *  runs stage left → right), and a group whose fixtures are gone keeps its
 *  place in the project's own order, behind every group that is patched. */
function stageOrder(project: Project): Map<string, number> {
  const pos = new Map<string, number>();
  for (const f of project.fixtures) pos.set(f.id, f.pos.x);
  const ranked = project.groups.map((g, i) => {
    let sum = 0;
    let n = 0;
    for (const h of g.heads) {
      const x = pos.get(h.fixtureId);
      if (x !== undefined) {
        sum += x;
        n++;
      }
    }
    return { id: g.id, i, x: n ? sum / n : Number.POSITIVE_INFINITY };
  });
  ranked.sort((a, b) => (a.x === b.x ? a.i - b.i : a.x - b.x));
  const at = new Map<string, number>();
  ranked.forEach((g, i) => at.set(g.id, i));
  return at;
}

/** The colour a part paints its heads, read the same way `lookSwatch` reads
 *  it — so a face and the lamp over it never disagree about what a look is.
 *  `null` is a part that says nothing about brightness or colour: position,
 *  beam shaping or an effect on its own, which draws hollow. */
function partColour(part: LookPart): string | null {
  const p = part.params;
  if (p.macro !== undefined) {
    const first = derbyMacroForValue(p.macro).comps[0];
    if (first) return rgbHex(first[0] / 255, first[1] / 255, first[2] / 255);
  }
  if (p.color) {
    const [r, g, b] = hsvToRgb(p.color.h, p.color.s, 1);
    return rgbHex(r, g, b);
  }
  if (p.white !== undefined || p.ringFx !== undefined) return color['swatch/white'];
  if (p.strobe !== undefined) return color['swatch/strobe'];
  if (p.dimmer !== undefined) return color['swatch/dimmer'];
  return null;
}

function buildFace(look: Look, project: Project): LookFace {
  // A steps look borrows its marks from the first step that resolves to a
  // plain look — the same borrow `lookSwatch` makes — and carries how many
  // steps it runs, which is the thing the stripe could never show.
  if (look.steps?.length) {
    for (const st of look.steps) {
      const target = Object.hasOwn(project.looks, st.lookId) ? project.looks[st.lookId] : undefined;
      if (target && !target.steps?.length) {
        return { marks: buildFace(target, project).marks, steps: look.steps.length };
      }
    }
    return { marks: [], steps: look.steps.length };
  }
  const order = stageOrder(project);
  const names = new Map(project.groups.map((g) => [g.id, g.name]));
  const seen = new Set<string>();
  const marks: FaceMark[] = [];
  for (const part of look.parts) {
    if (seen.has(part.groupId)) continue; // one mark per group, however many parts drive it
    seen.add(part.groupId);
    const c = partColour(part);
    marks.push({
      groupId: part.groupId,
      group: names.get(part.groupId) ?? '',
      color: c ?? color['swatch/dimmer'],
      hollow: c === null,
    });
  }
  marks.sort(
    (a, b) =>
      (order.get(a.groupId) ?? Number.POSITIVE_INFINITY) - (order.get(b.groupId) ?? Number.POSITIVE_INFINITY),
  );
  return { marks, steps: 0 };
}

/** Per project object, per look id. `mutate` replaces the whole project on
 *  every edit (store.ts structuredClone), and so does every snapshot from the
 *  engine, so a look that changed can never read a stale face — the map it was
 *  cached in went with the project it belonged to. A WeakMap, so those maps go
 *  with it rather than piling up one per edit. */
const faces = new WeakMap<Project, Map<string, LookFace>>();

/** The rig miniature for a look: one mark per group it touches, in stage
 *  order, coloured by that part's colour, hollow where the part only aims a
 *  head or runs an effect; a steps look carries its count for the dot row.
 *  Memoised per look id and project generation. */
export function lookFace(look: Look, project: Project): LookFace {
  let per = faces.get(project);
  if (!per) {
    per = new Map();
    faces.set(project, per);
  }
  const had = per.get(look.id);
  if (had) return had;
  const face = look.parts.length || look.steps?.length ? buildFace(look, project) : EMPTY_FACE;
  per.set(look.id, face);
  return face;
}
