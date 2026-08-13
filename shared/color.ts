import { clamp } from './types.ts';

/** HSV → RGB, all 0..1 except hue 0..360. */
export function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  h = ((h % 360) + 360) % 360;
  s = clamp(s);
  v = clamp(v);
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [r + m, g + m, b + m];
}

/** RGB 0..1 → [hue 0..360, sat 0..1, val 0..1] */
export function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  if (h < 0) h += 360;
  return [h, max === 0 ? 0 : d / max, max];
}

export function rgbHex(r: number, g: number, b: number): string {
  const c = (v: number) => Math.round(clamp(v) * 255).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

// ---------------------------------------------------------------------------
// Varytec LED Derby ST colour-macro table (4CH mode, CH1), from the QLC+
// fixture definition — DMX band midpoints with component colours.
// ---------------------------------------------------------------------------

export type DerbyMacro = {
  value: number; // band midpoint we transmit
  min: number;
  max: number;
  name: string;
  comps: [number, number, number][]; // component colours 0..255
  auto: boolean; // eligible for hue quantisation
};

const R: [number, number, number] = [255, 0, 0];
const G: [number, number, number] = [0, 255, 0];
const B: [number, number, number] = [0, 0, 255];
const W: [number, number, number] = [255, 255, 255];

export const DERBY_MACROS: DerbyMacro[] = [
  { value: 0, min: 0, max: 5, name: 'Off', comps: [], auto: false },
  { value: 13, min: 6, max: 20, name: 'Red', comps: [R], auto: true },
  { value: 28, min: 21, max: 35, name: 'Green', comps: [G], auto: true },
  { value: 43, min: 36, max: 50, name: 'Blue', comps: [B], auto: true },
  { value: 58, min: 51, max: 65, name: 'White', comps: [W], auto: true },
  { value: 73, min: 66, max: 80, name: 'Red + Green', comps: [R, G], auto: true },
  { value: 88, min: 81, max: 95, name: 'Red + Blue', comps: [R, B], auto: true },
  { value: 103, min: 96, max: 110, name: 'Red + White', comps: [R, W], auto: true },
  { value: 118, min: 111, max: 125, name: 'Green + Blue', comps: [G, B], auto: true },
  { value: 133, min: 126, max: 140, name: 'Green + White', comps: [G, W], auto: true },
  { value: 148, min: 141, max: 155, name: 'Blue + White', comps: [B, W], auto: true },
  { value: 163, min: 156, max: 170, name: 'R + G + B', comps: [R, G, B], auto: true },
  { value: 178, min: 171, max: 185, name: 'R + G + W', comps: [R, G, W], auto: true },
  { value: 193, min: 186, max: 200, name: 'G + B + W', comps: [G, B, W], auto: true },
  { value: 208, min: 201, max: 215, name: 'R + G + B + W', comps: [R, G, B, W], auto: true },
  { value: 223, min: 216, max: 230, name: 'Colour Change 1', comps: [R, G, B], auto: false },
  { value: 243, min: 231, max: 255, name: 'Colour Change 2', comps: [R, G, B, W], auto: false },
];

export function derbyMacroForValue(v: number): DerbyMacro {
  return DERBY_MACROS.find((m) => v >= m.min && v <= m.max) ?? DERBY_MACROS[0];
}

function avgComp(m: DerbyMacro): [number, number, number] {
  if (m.comps.length === 0) return [0, 0, 0];
  let r = 0, g = 0, b = 0;
  for (const [cr, cg, cb] of m.comps) {
    r += cr; g += cg; b += cb;
  }
  const n = m.comps.length;
  return [r / n / 255, g / n / 255, b / n / 255];
}

/** Nearest displayable macro for a requested hue/sat — the derby cannot mix RGB. */
export function derbyQuantize(h: number, s: number): DerbyMacro {
  if (s < 0.15) return DERBY_MACROS[4]; // White
  const [tr, tg, tb] = hsvToRgb(h, s, 1);
  let best = DERBY_MACROS[1];
  let bestD = Infinity;
  for (const m of DERBY_MACROS) {
    if (!m.auto) continue;
    const [mr, mg, mb] = avgComp(m);
    const d = (tr - mr) ** 2 + (tg - mg) ** 2 + (tb - mb) ** 2;
    if (d < bestD) {
      bestD = d;
      best = m;
    }
  }
  return best;
}
