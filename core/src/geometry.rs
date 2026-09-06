//! Per-head world geometry — the spatial half of the HeadCtx fed to
//! apply_effects. Twin of `shared/geometry.ts`; the two must stay in lockstep
//! or the engines' spatial effects diverge.
//!
//! All values are QUANTIZED to 10⁻⁶ m at the build boundary. IEEE add/multiply
//! are bit-deterministic across the two engines, but sin/cos are not (V8 vs
//! libm can differ in the last ulp); quantizing here means that difference can
//! never reach the per-tick effect maths, so byte parity holds without pinning
//! trig implementations.

use std::collections::HashMap;

use crate::profiles::profile_of;
use crate::types::Project;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct HeadGeom {
    /// world position, metres — x stage left→right, y up, z toward audience
    pub x: f64,
    pub y: f64,
    pub z: f64,
    /// the head's offset along the fixture's local X axis, metres
    pub along: f64,
    /// grid coordinates within the fixture (B1: parsed from GDTF geometry or a
    /// parametric layout; pre-B1 profiles fall back to a single row with
    /// col = head index)
    pub row: usize,
    pub col: usize,
    /// row/col normalized 0..1 over THIS fixture's grid (inclusive; 0 when the
    /// axis is a single line) — the Row/Col distribute bases read these, so
    /// every fixture of a type runs the same pixel wave by construction
    pub row_t: f64,
    pub col_t: f64,
}

/// Geometry for a head the builder could not place (unknown profile — the
/// renderer's heads-map skip already excludes these from output). Matches the
/// repaired-default fixture position so a defensive fallback is never NaN.
pub const NO_GEOM: HeadGeom = HeadGeom {
    x: 0.0,
    y: 2.0,
    z: 0.0,
    along: 0.0,
    row: 0,
    col: 0,
    row_t: 0.0,
    col_t: 0.0,
};

/// floor(v·1e6 + 0.5) — written identically in both languages because
/// Math.round and Rust's f64::round disagree on negative halves. Non-finite
/// input maps to 0: sanitize repairs upstream, this is the last resort.
fn q(v: f64) -> f64 {
    if v.is_finite() { (v * 1e6 + 0.5).floor() / 1e6 } else { 0.0 }
}

/// Build world geometry for every head of every fixture, keyed
/// (fixture id, head) — the same key the renderer's heads map uses, from the
/// same enumeration (fixtures × profile heads, builtin profile first), so
/// every rendered head has an entry by construction.
///
/// The formula is the repo's canonical placement, verbatim from the two 3D
/// previzes (three.js rotation.order 'YXZ' / bevy EulerRot::YXZ):
///
/// `world = pos + Ry(rotY) · Rx(rotX) · Rz(rotZ) · (offset, 0, 0)`
///
/// radians, right-handed Y-up; yaw maps local +X to (cosθ, 0, −sinθ) — the
/// convention core/src/mvr.rs documents and MVR import assumes. (The 2D plan
/// view historically used +sinθ; it is the outlier, not this.)
///
/// Rebuild is gen-gated by the caller — this walks every head, so it must run
/// on project changes only, never per tick.
pub fn build_geometry(p: &Project) -> HashMap<(String, usize), HeadGeom> {
    let mut out = HashMap::new();
    for f in &p.fixtures {
        // mirror Prof::resolve in renderer.rs: builtin first, then compiled.
        // (offset, offset_y, row, col) per head — built-ins carry no grid.
        let heads: Vec<(f64, f64, usize, usize)> = if let Some(bp) = profile_of(&f.profile_id) {
            bp.heads.iter().map(|h| (h.offset, 0.0, 0, 0)).collect()
        } else if let Some(cp) = p.profiles.get(&f.profile_id) {
            cp.heads.iter().map(|h| (h.offset, h.offset_y, h.row, h.col)).collect()
        } else {
            continue;
        };
        // Pre-B1 profiles (and every built-in) carry no grid: when EVERY head
        // is (row 0, col 0), fall back to a single row with col = head index —
        // the exact layout those profiles always had.
        let flat = heads.iter().all(|&(_, _, r, c)| r == 0 && c == 0);
        let mut max_row = 0usize;
        let mut max_col = 0usize;
        for (i, &(_, _, r, c)) in heads.iter().enumerate() {
            let r = if flat { 0 } else { r };
            let c = if flat { i } else { c };
            if r > max_row {
                max_row = r;
            }
            if c > max_col {
                max_col = c;
            }
        }
        let yaw = f.rot_y;
        let pitch = f.rot_x.unwrap_or(0.0);
        let roll = f.rot_z.unwrap_or(0.0);
        let (cy, sy) = (yaw.cos(), yaw.sin());
        let (cx, sx) = (pitch.cos(), pitch.sin());
        let (cz, sz) = (roll.cos(), roll.sin());
        for (i, &(ox, oy, r, c)) in heads.iter().enumerate() {
            // Rz then Rx then Ry applied to (ox, oy, 0), each step written out
            // so the operation ORDER is textually identical to the TS twin
            // (IEEE ops are deterministic given the same inputs in the same
            // order).
            let ax = ox * cz - oy * sz;
            let ay = ox * sz + oy * cz;
            let by = ay * cx;
            let bz = ay * sx;
            let wx = ax * cy + bz * sy;
            let wz = -ax * sy + bz * cy;
            let row = if flat { 0 } else { r };
            let col = if flat { i } else { c };
            out.insert(
                (f.id.clone(), i),
                HeadGeom {
                    x: q(f.pos.x + wx),
                    y: q(f.pos.y + by),
                    z: q(f.pos.z + wz),
                    along: q(ox),
                    row,
                    col,
                    row_t: q(if max_row > 0 { row as f64 / max_row as f64 } else { 0.0 }),
                    col_t: q(if max_col > 0 { col as f64 / max_col as f64 } else { 0.0 }),
                },
            );
        }
    }
    out
}

/// Spatial extent of one group's heads, for normalizing spatial effect fans.
/// Derived from QUANTIZED HeadGeom values in group.heads order, so both engines
/// compute bit-identical extents (sums and sqrt are IEEE-deterministic).
/// Twin of GroupExtents in shared/geometry.ts.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GroupExtents {
    pub min_x: f64,
    pub max_x: f64,
    pub min_y: f64,
    pub max_y: f64,
    pub min_z: f64,
    pub max_z: f64,
    /// centroid of the placed heads
    pub cx: f64,
    pub cy: f64,
    pub cz: f64,
    /// largest head distance from the centroid
    pub max_r: f64,
}

/// Extents for a group with no placed heads — everything degenerate, so every
/// spatial basis normalizes to 0 and the fan collapses to "all in phase".
pub const NO_EXTENTS: GroupExtents = GroupExtents {
    min_x: 0.0,
    max_x: 0.0,
    min_y: 0.0,
    max_y: 0.0,
    min_z: 0.0,
    max_z: 0.0,
    cx: 0.0,
    cy: 0.0,
    cz: 0.0,
    max_r: 0.0,
};

/// Per-group spatial extents over the heads that HAVE geometry (a dangling ref
/// renders nothing, so it must not stretch the fan either). Gen-gated by the
/// caller alongside build_geometry — same rebuild discipline.
pub fn build_group_extents(
    p: &Project,
    geom: &HashMap<(String, usize), HeadGeom>,
) -> HashMap<String, GroupExtents> {
    let mut out = HashMap::new();
    for g in &p.groups {
        let mut n = 0usize;
        let (mut min_x, mut max_x) = (f64::INFINITY, f64::NEG_INFINITY);
        let (mut min_y, mut max_y) = (f64::INFINITY, f64::NEG_INFINITY);
        let (mut min_z, mut max_z) = (f64::INFINITY, f64::NEG_INFINITY);
        let (mut sx, mut sy, mut sz) = (0.0f64, 0.0f64, 0.0f64);
        for r in &g.heads {
            let Some(hg) = geom.get(&(r.fixture_id.clone(), r.head)) else { continue };
            n += 1;
            if hg.x < min_x { min_x = hg.x; }
            if hg.x > max_x { max_x = hg.x; }
            if hg.y < min_y { min_y = hg.y; }
            if hg.y > max_y { max_y = hg.y; }
            if hg.z < min_z { min_z = hg.z; }
            if hg.z > max_z { max_z = hg.z; }
            sx += hg.x;
            sy += hg.y;
            sz += hg.z;
        }
        if n == 0 {
            out.insert(g.id.clone(), NO_EXTENTS);
            continue;
        }
        let (cx, cy, cz) = (sx / n as f64, sy / n as f64, sz / n as f64);
        let mut max_r = 0.0f64;
        for r in &g.heads {
            let Some(hg) = geom.get(&(r.fixture_id.clone(), r.head)) else { continue };
            let (dx, dy, dz) = (hg.x - cx, hg.y - cy, hg.z - cz);
            // sqrt is correctly rounded per IEEE-754 in both languages, so this
            // is deterministic given the quantized inputs - no re-quantization
            let rr = (dx * dx + dy * dy + dz * dz).sqrt();
            if rr > max_r { max_r = rr; }
        }
        out.insert(
            g.id.clone(),
            GroupExtents { min_x, max_x, min_y, max_y, min_z, max_z, cx, cy, cz, max_r },
        );
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The golden vectors are the cross-language contract: generated by an
    /// INDEPENDENT third implementation (Python) of the same formula and
    /// quantizer, and asserted EXACTLY here and in engine/test/smoke.ts. If
    /// either engine's trig lands a quantization boundary differently, this is
    /// where it surfaces — as an exact-value mismatch, not a byte drift later.
    #[test]
    fn golden_vectors_match_exactly() {
        let golden: serde_json::Value =
            serde_json::from_str(include_str!("../tests/data/geometry_golden.json"))
                .expect("golden file parses");
        let project: Project = serde_json::from_value(golden["project"].clone())
            .expect("golden project deserializes");
        let geom = build_geometry(&project);
        let expected = golden["expected"].as_object().expect("expected map");
        assert_eq!(geom.len(), expected.len(), "head count mismatch");
        for (key, want) in expected {
            let (fid, head) = key.rsplit_once(':').expect("key shape fid:head");
            let g = geom
                .get(&(fid.to_string(), head.parse().unwrap()))
                .unwrap_or_else(|| panic!("missing geometry for {key}"));
            // exact f64 equality — quantization is the tolerance
            assert_eq!(g.x, want["x"].as_f64().unwrap(), "{key} x");
            assert_eq!(g.y, want["y"].as_f64().unwrap(), "{key} y");
            assert_eq!(g.z, want["z"].as_f64().unwrap(), "{key} z");
            assert_eq!(g.along, want["along"].as_f64().unwrap(), "{key} along");
            assert_eq!(g.row, want["row"].as_u64().unwrap() as usize, "{key} row");
            assert_eq!(g.col, want["col"].as_u64().unwrap() as usize, "{key} col");
            assert_eq!(g.row_t, want["rowT"].as_f64().unwrap(), "{key} rowT");
            assert_eq!(g.col_t, want["colT"].as_f64().unwrap(), "{key} colT");
        }
    }

    #[test]
    fn unknown_profile_gets_no_entry() {
        let golden: serde_json::Value =
            serde_json::from_str(include_str!("../tests/data/geometry_golden.json")).unwrap();
        let project: Project = serde_json::from_value(golden["project"].clone()).unwrap();
        let geom = build_geometry(&project);
        assert!(
            !geom.keys().any(|(fid, _)| fid == "ghost"),
            "a fixture with an unknown profile must be skipped, like the heads map skips it"
        );
    }

    #[test]
    fn compiled_profile_offsets_are_consumed_not_rederived() {
        // A GDTF-imported strip: offsets are whatever the compile stored
        // (fabricated or parsed) — geometry must read them, never recompute
        // spacing from the head index. Mirrored in engine/test/smoke.ts with
        // the same literals.
        use crate::cprofile::{CHead, CompiledProfile};
        use crate::profiles::HeadKind;
        let heads: Vec<CHead> = [-0.5, -0.1667, 0.1667, 0.5]
            .iter()
            .map(|&o| CHead::flat(HeadKind::Rgb, o, String::new()))
            .collect();
        let cp = CompiledProfile {
            id: "imported-strip".into(),
            manufacturer: "T".into(),
            model: "Strip".into(),
            mode: "4px".into(),
            footprint: 12,
            heads,
            channels: vec![],
            beam_deg: 20.0,
            field_deg: None,
            lumens: None,
            beam_radius: None,
            virtual_dimmer: false,
            compiler: 0,
            credit: None,
            form_override: None,
        };
        let mut project: Project =
            serde_json::from_str(r#"{"version":1,"universes":[],"fixtures":[{"id":"s","name":"S","profileId":"imported-strip","universeId":"u1","address":1,"pos":{"x":0,"y":3,"z":0},"rotY":0}],"groups":[],"layers":[],"columns":[]}"#)
                .unwrap();
        project.profiles.insert("imported-strip".into(), cp);
        let geom = build_geometry(&project);
        assert_eq!(geom.len(), 4);
        assert_eq!(geom[&("s".to_string(), 0)].x, -0.5);
        assert_eq!(geom[&("s".to_string(), 1)].x, -0.1667);
        assert_eq!(geom[&("s".to_string(), 3)].x, 0.5);
        assert_eq!(geom[&("s".to_string(), 2)].along, 0.1667);
    }

    #[test]
    fn group_extents_match_the_golden_vectors() {
        // same cross-language contract as the head positions: the expected
        // values are Python-computed over the QUANTIZED golden heads, in
        // group.heads order, asserted f64-exact in both engines' suites.
        let golden: serde_json::Value =
            serde_json::from_str(include_str!("../tests/data/geometry_golden.json")).unwrap();
        let project: Project = serde_json::from_value(golden["project"].clone()).unwrap();
        let geom = build_geometry(&project);
        let ext = build_group_extents(&project, &geom);
        let want = golden["expectedExtents"].as_object().expect("expectedExtents present");
        assert_eq!(ext.len(), want.len(), "group count");
        for (gid, w) in want {
            let e = ext.get(gid).unwrap_or_else(|| panic!("missing extents for {gid}"));
            let f = |k: &str| w[k].as_f64().unwrap();
            assert_eq!(e.min_x, f("minX"), "{gid} minX");
            assert_eq!(e.max_x, f("maxX"), "{gid} maxX");
            assert_eq!(e.min_y, f("minY"), "{gid} minY");
            assert_eq!(e.max_y, f("maxY"), "{gid} maxY");
            assert_eq!(e.min_z, f("minZ"), "{gid} minZ");
            assert_eq!(e.max_z, f("maxZ"), "{gid} maxZ");
            assert_eq!(e.cx, f("cx"), "{gid} cx");
            assert_eq!(e.cy, f("cy"), "{gid} cy");
            assert_eq!(e.cz, f("cz"), "{gid} cz");
            assert_eq!(e.max_r, f("maxR"), "{gid} maxR");
        }
    }

    #[test]
    fn quantizer_matches_the_ts_twin_on_negative_halves() {
        // Math.round and f64::round disagree at -0.5 — both twins use
        // floor(v·1e6 + 0.5) instead. -0.0000005 · 1e6 = -0.5 → floor(0.0) = 0.
        assert_eq!(q(-0.0000005), 0.0, "negative half rounds up (toward +inf), as Math.round does");
        assert_eq!(q(0.0000005), 0.000001);
        assert_eq!(q(f64::NAN), 0.0, "non-finite is absorbed, never propagated");
        assert_eq!(q(f64::INFINITY), 0.0);
        assert_eq!(q(1.23456789), 1.234568);
    }
}
