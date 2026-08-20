import type { Project } from './types.ts';
import { PROFILES } from './profiles.ts';

/**
 * Per-head world geometry — the spatial half of the HeadCtx fed to
 * applyEffects. Twin of `core/src/geometry.rs`; the two must stay in lockstep
 * or the engines' spatial effects diverge.
 *
 * All values are QUANTIZED to 10⁻⁶ m at the build boundary. IEEE add/multiply
 * are bit-deterministic across the two engines, but sin/cos are not (V8 vs
 * libm can differ in the last ulp); quantizing here means that difference can
 * never reach the per-tick effect maths, so byte parity holds without pinning
 * trig implementations.
 */
export type HeadGeom = {
  /** world position, metres — x stage left→right, y up, z toward audience */
  x: number;
  y: number;
  z: number;
  /** the head's offset along the fixture's local X axis, metres */
  along: number;
  /** grid coordinates. Every profile today is a single row along local X, so
   *  row is 0 and col is the head index; B1 (GDTF geometry parsing) makes
   *  these honest for real pixel grids. */
  row: number;
  col: number;
};

/** Geometry for a head the builder could not place (unknown profile — the
 *  renderer's heads-map skip already excludes these from output). Matches the
 *  repaired-default fixture position so a defensive fallback is never NaN. */
export const NO_GEOM: HeadGeom = { x: 0, y: 2, z: 0, along: 0, row: 0, col: 0 };

/** floor(v·1e6 + 0.5) — written identically in both languages because
 *  Math.round and Rust's f64::round disagree on negative halves. Non-finite
 *  input maps to 0: sanitize repairs upstream, this is the last resort. */
function q(v: number): number {
  return Number.isFinite(v) ? Math.floor(v * 1e6 + 0.5) / 1e6 : 0;
}

/**
 * Build world geometry for every head of every fixture, keyed
 * `${fixtureId}:${head}` — the same key the renderer's heads map uses, from
 * the same enumeration (fixtures × profile heads, builtin profile first),
 * so every rendered head has an entry by construction.
 *
 * The formula is the repo's canonical placement, verbatim from the two 3D
 * previzes (three.js rotation.order 'YXZ' / bevy EulerRot::YXZ):
 *
 *     world = pos + Ry(rotY) · Rx(rotX) · Rz(rotZ) · (offset, 0, 0)
 *
 * radians, right-handed Y-up; yaw maps local +X to (cosθ, 0, −sinθ) — the
 * convention core/src/mvr.rs documents and MVR import assumes. (The 2D plan
 * view historically used +sinθ; it is the outlier, not this.)
 *
 * Rebuild is gen-gated by the caller — this walks every head, so it must run
 * on project changes only, never per tick.
 */
export function buildGeometry(p: Project): Map<string, HeadGeom> {
  const out = new Map<string, HeadGeom>();
  for (const f of p.fixtures) {
    const profHeads = PROFILES[f.profileId]?.heads ?? p.profiles?.[f.profileId]?.heads;
    if (!profHeads) continue;
    const yaw = f.rotY;
    const pitch = f.rotX ?? 0;
    const roll = f.rotZ ?? 0;
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const cx = Math.cos(pitch), sx = Math.sin(pitch);
    const cz = Math.cos(roll), sz = Math.sin(roll);
    profHeads.forEach((hd, i) => {
      const o = hd.offset;
      // Rz then Rx then Ry applied to (o, 0, 0), each step written out so the
      // operation ORDER is textually identical to the Rust twin (IEEE ops are
      // deterministic given the same inputs in the same order).
      const ax = o * cz;
      const ay = o * sz;
      const by = ay * cx;
      const bz = ay * sx;
      const wx = ax * cy + bz * sy;
      const wz = -ax * sy + bz * cy;
      out.set(`${f.id}:${i}`, {
        x: q(f.pos.x + wx),
        y: q(f.pos.y + by),
        z: q(f.pos.z + wz),
        along: q(o),
        row: 0,
        col: i,
      });
    });
  }
  return out;
}
