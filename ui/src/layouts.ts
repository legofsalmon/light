/** Parametric pixel layouts (B1) — pure generators writing the 2D head
 *  fields (offset, offsetY, row, col) for an imported profile whose GDTF
 *  carried no usable geometry (the CLF Nero case: 84 pixels, all zeroed).
 *  Layout lives on the profile — the TYPE — so applying it once lays out
 *  every fixture of that type: "grab one strobe, every strobe is the same." */

export type HeadPlacement = { offset: number; offsetY: number; row: number; col: number };

/** Evenly spaced along local X, centred. */
export function stripLayout(n: number, pitch: number): HeadPlacement[] {
  return Array.from({ length: n }, (_, i) => ({
    offset: (i - (n - 1) / 2) * pitch,
    offsetY: 0,
    row: 0,
    col: i,
  }));
}

/** cols × rows grid, centred; row 0 at the top (positive offsetY). Serpentine
 *  flips the physical column on odd rows — pixel strings are usually wired as
 *  a snake, and head order is wiring order. row/col are always the PHYSICAL
 *  grid position. */
export function gridLayout(
  n: number,
  cols: number,
  pitchX: number,
  pitchY: number,
  serpentine: boolean
): HeadPlacement[] {
  const c = Math.max(1, Math.floor(cols));
  const rows = Math.ceil(n / c);
  return Array.from({ length: n }, (_, i) => {
    const row = Math.floor(i / c);
    const col = serpentine && row % 2 === 1 ? c - 1 - (i % c) : i % c;
    return {
      offset: (col - (c - 1) / 2) * pitchX,
      offsetY: ((rows - 1) / 2 - row) * pitchY,
      row,
      col,
    };
  });
}

/** A ring in the fixture's face plane, head 0 at 12 o'clock plus startDeg,
 *  clockwise (viewed from the audience). col runs around the ring so the
 *  'col' fan basis chases it. */
export function ringLayout(n: number, diameter: number, startDeg: number): HeadPlacement[] {
  const r = diameter / 2;
  return Array.from({ length: n }, (_, i) => {
    const a = ((startDeg + (i * 360) / n) * Math.PI) / 180;
    return {
      offset: r * Math.sin(a),
      offsetY: r * Math.cos(a),
      row: 0,
      col: i,
    };
  });
}
