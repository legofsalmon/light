import type { Look } from '../../shared/types.ts';
import { derbyMacroForValue, hsvToRgb, rgbHex } from '../../shared/color.ts';

const RAINBOW = ['#ff3b30', '#ffcc00', '#34c759', '#32ade6', '#5856d6', '#ff2d88'];

/** Representative colour strip for a look's grid-cell thumbnail. */
export function lookSwatch(look: Look): string[] {
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
      out.push('#f5f5f0');
      continue;
    }
    if (part.params.strobe !== undefined) {
      out.push('#e8e8ee');
      continue;
    }
    if (part.params.dimmer !== undefined || part.effects.length > 0) {
      out.push('#9a9aa4');
    }
  }
  return out.length ? out.slice(0, 8) : ['#3a3a40'];
}
