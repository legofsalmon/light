import type { Look } from '../../shared/types.ts';
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
