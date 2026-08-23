//! Truss inferred from where the fixtures hang.
//!
//! A hundred and twenty-nine fixtures floating in mid-air with nothing holding
//! them up is the loudest remaining "this is a diagram, not a stage" signal in
//! the window. Every previz worth the name — Depence, Capture, WYSIWYG — draws
//! structure, and the eye uses it to read depth and scale before it reads
//! anything else.
//!
//! The honest objection is that LIGHT's project file has no truss in it. There
//! is no `truss` prop kind and MVR geometry import is parked, so anything drawn
//! here is INFERRED, not imported. That is a real caveat and it is why the bar
//! for drawing a run is deliberately high: three or more fixtures sharing a
//! height and a depth, spread over at least a metre and a half, with any gap
//! wider than four metres splitting the run in two. A rig that does not look
//! like it hangs off a straight bar gets no bar drawn.
//!
//! On the arena plot that resolves to exactly the five overhead runs a human
//! would draw, and the side-fill blinders eighteen metres out become their own
//! short runs rather than one absurd thirty-seven metre span.
//!
//! Turn it off with LIGHT_PREVIZ_TRUSS=0. When MVR geometry lands, real truss
//! replaces this and the inference should go.

use bevy::asset::RenderAssetUsages;
use bevy::mesh::{Indices, Mesh, PrimitiveTopology};
use bevy::prelude::*;

/// One inferred straight run of truss, along world X.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TrussRun {
    /// Centre height of the truss SECTION — above the fixtures, not level with
    /// them, because fixtures hang underneath.
    pub y: f32,
    pub z: f32,
    pub x0: f32,
    pub x1: f32,
}

/// Standard 12-inch box truss: a 290 mm square section on 50 mm chords.
pub const SECTION: f32 = 0.29;
/// Distance the drawn truss runs past the outermost fixture on it.
const OVERHANG: f32 = 0.6;
/// A fixture's clamp sits this far above its patch position — the mover base
/// is 235 mm tall — so the truss underside goes here and the section centre
/// half a section higher.
const HANG_DROP: f32 = 0.235;

/// Group hanging fixtures into straight runs.
///
/// Takes bare positions so it can be tested against a real plot without a
/// world. Fixtures below `min_height` are floor packages and get nothing.
pub fn infer_runs(positions: &[Vec3], min_height: f32) -> Vec<TrussRun> {
    // Same height and same depth, within the slop of a real rig: different
    // fixture types on one bar hang at slightly different drops and clamp at
    // slightly different depths, which on the arena plot is up to half a metre
    // of spread on what is plainly one truss.
    const Y_TOL: f32 = 0.75;
    /// Tighter than the height rule, and measured rather than picked. On the
    /// arena plot the fixtures on one overhead bar span 0.38 m of depth, while
    /// the front truss at z = -0.02 and the side-fill wings at z = +0.49 are
    /// 0.51 m apart and are NOT the same structure. Anything looser than this
    /// swallowed the front truss into the wings and then threw all three away.
    const Z_TOL: f32 = 0.45;
    const MIN_SPAN: f32 = 1.0;
    const MIN_COUNT: usize = 3;

    // Anchor each cluster on its first member rather than a running mean: with
    // a mean, a long shallow ramp of heights walks the cluster centre and
    // swallows the truss above it.
    let mut clusters: Vec<(Vec3, Vec<Vec3>)> = Vec::new();
    for &p in positions.iter().filter(|p| p.y >= min_height) {
        match clusters
            .iter_mut()
            .find(|(a, _)| (p.y - a.y).abs() <= Y_TOL && (p.z - a.z).abs() <= Z_TOL)
        {
            Some((_, members)) => members.push(p),
            None => clusters.push((p, vec![p])),
        }
    }

    let mut runs = Vec::new();
    for (_, mut members) in clusters {
        if members.len() < MIN_COUNT {
            continue;
        }
        members.sort_by(|a, b| a.x.total_cmp(&b.x));

        // Where to break a row into separate structures.
        //
        // A fixed distance cannot do this job. Four metres splits the real
        // front truss — four fixtures spread over fourteen metres with six
        // metre holes, which is a perfectly ordinary sparse hang — and forty
        // metres would join two side-fill wings eighteen metres either side of
        // the stage into one impossible bar.
        //
        // What actually distinguishes them is the row's OWN spacing: a hole
        // several times wider than the gaps around it is a different structure,
        // and a hole the same size as its neighbours is just how that bar is
        // populated. Median, not mean, so one enormous hole does not raise the
        // threshold enough to hide itself.
        let mut gaps: Vec<f32> =
            members.windows(2).map(|w| w[1].x - w[0].x).collect();
        gaps.sort_by(f32::total_cmp);
        let median = gaps.get(gaps.len() / 2).copied().unwrap_or(0.0);
        let split_at = (median * 3.0).max(4.0);

        let mut start = 0usize;
        for i in 1..=members.len() {
            let split = i == members.len() || members[i].x - members[i - 1].x > split_at;
            if !split {
                continue;
            }
            let seg = &members[start..i];
            start = i;
            if seg.len() < MIN_COUNT {
                continue;
            }
            let (x0, x1) = (seg[0].x, seg[seg.len() - 1].x);
            if x1 - x0 < MIN_SPAN {
                continue;
            }
            // Highest fixture on the run decides the underside, so nothing
            // pokes through the bar it is supposed to be hanging from.
            let top = seg.iter().fold(f32::MIN, |m, p| m.max(p.y));
            let z = seg.iter().map(|p| p.z).sum::<f32>() / seg.len() as f32;
            runs.push(TrussRun {
                y: top + HANG_DROP + SECTION * 0.5,
                z,
                x0: x0 - OVERHANG,
                x1: x1 + OVERHANG,
            });
        }
    }
    runs
}

#[derive(Default)]
struct Build {
    pos: Vec<[f32; 3]>,
    nrm: Vec<[f32; 3]>,
    idx: Vec<u32>,
}

impl Build {
    /// One straight tube from `a` to `b`. Six sides: these are 50 mm bars seen
    /// from ten metres away, and the silhouette is the whole point.
    fn tube(&mut self, a: Vec3, b: Vec3, r: f32) {
        const SEGS: u32 = 6;
        let axis = b - a;
        let len = axis.length();
        if len < 1e-4 {
            return;
        }
        let n = axis / len;
        // Any perpendicular will do; pick the one that is not near-parallel.
        let up = if n.y.abs() > 0.9 { Vec3::X } else { Vec3::Y };
        let u = n.cross(up).normalize();
        let v = n.cross(u);
        let base = self.pos.len() as u32;
        for i in 0..SEGS {
            let t = i as f32 / SEGS as f32 * std::f32::consts::TAU;
            let d = u * t.cos() + v * t.sin();
            for end in [a, b] {
                let p = end + d * r;
                self.pos.push([p.x, p.y, p.z]);
                self.nrm.push([d.x, d.y, d.z]);
            }
        }
        for i in 0..SEGS {
            let (c, nx) = (base + i * 2, base + ((i + 1) % SEGS) * 2);
            self.idx.extend_from_slice(&[c, nx, c + 1, nx, nx + 1, c + 1]);
        }
    }
}

/// A box-truss run as ONE mesh, running along +X from the origin.
///
/// One mesh per run and not one entity per bar, which is the difference between
/// fifteen draws for the whole rig and about nine hundred: a fifteen-metre run
/// carries sixty diagonals and thirty rungs on its own.
///
/// `section` is the square section's side. Inferred runs pass the fixed 0.29 m
/// `SECTION`; the ratios in shared/structure.json were chosen to reproduce the
/// constants those runs were authored with — 0.0250009 against 0.025 for the
/// chord, 0.499989 against 0.5 for the bay — so the geometry is identical to
/// within a micrometre and the rendered frame is identical outright. It is NOT
/// bit-for-bit, and saying so would be a lie a future reader could act on.
/// A PLACED trussBar or trussLeg passes its own section, from the patch.
///
/// Chord axes sit AT +/- section/2 rather than inset by the chord radius, so
/// the drawn envelope is section + 2*chord_r — 26 mm proud per face on a 0.3 m
/// bar. Insetting them is incompatible with the ratio rule reproducing the
/// authored constants, and 26 mm on a truss is not worth a second knob.
pub fn truss_mesh(length: f32, section: f32) -> Mesh {
    let cfg = &crate::scene::STRUCT.truss;
    let chord_r = (section * cfg.chord_ratio).max(cfg.min_chord);
    let pitch = (section * cfg.bay_ratio).max(0.05);
    let h = section * 0.5;
    let mut b = Build::default();
    // The four chords, running the length at the corners of the section.
    for (dy, dz) in [(h, h), (h, -h), (-h, h), (-h, -h)] {
        b.tube(Vec3::new(0.0, dy, dz), Vec3::new(length, dy, dz), chord_r);
    }
    // Webbing. A real truss zigzags on all four faces; the two vertical faces
    // and the underside are the ones you can see from a room, and the top face
    // costs geometry to draw a pattern nobody will ever be above.
    let n = ((length / pitch).round() as usize).max(1);
    let step = length / n as f32;
    let web_r = chord_r * cfg.web_ratio;
    for i in 0..n {
        let (x0, x1) = (i as f32 * step, (i + 1) as f32 * step);
        // Zigzag, alternating direction so consecutive diagonals meet at a node
        // the way a real ladder brace does.
        let (lo, hi) = if i % 2 == 0 { (-h, h) } else { (h, -h) };
        for dz in [h, -h] {
            b.tube(Vec3::new(x0, lo, dz), Vec3::new(x1, hi, dz), web_r);
        }
        b.tube(Vec3::new(x0, -h, -h), Vec3::new(x1, -h, h), web_r);
        // Vertical rung at each node — what stops the zigzag reading as a
        // lightning bolt rather than a truss.
        b.tube(Vec3::new(x1, -h, h), Vec3::new(x1, h, h), web_r);
        b.tube(Vec3::new(x1, -h, -h), Vec3::new(x1, h, -h), web_r);
    }
    Mesh::new(PrimitiveTopology::TriangleList, RenderAssetUsages::RENDER_WORLD)
        .with_inserted_attribute(Mesh::ATTRIBUTE_POSITION, b.pos)
        .with_inserted_attribute(Mesh::ATTRIBUTE_NORMAL, b.nrm)
        .with_inserted_indices(Indices::U32(b.idx))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The real arena plot, reduced to the heights and depths its fixtures
    /// actually sit at. A human looking at this draws five overhead bars and
    /// two side-fill towers, and so should the inference.
    fn arena() -> Vec<Vec3> {
        let mut v = Vec::new();
        for (y, z, x0, x1, n) in [
            (7.15f32, -7.10f32, -7.3f32, 7.3f32, 8usize),
            (7.20, -7.48, -7.1, 7.2, 8),
            (7.85, -4.60, -7.3, 7.3, 8),
            (7.91, -4.98, -7.1, 7.2, 16),
            (8.61, -2.10, -7.3, 7.3, 8),
            (8.66, -2.48, -7.1, 7.2, 7),
        ] {
            for i in 0..n {
                let t = i as f32 / (n - 1) as f32;
                v.push(Vec3::new(x0 + (x1 - x0) * t, y, z));
            }
        }
        // The front truss: four fixtures over fourteen metres, six metre holes.
        for x in [-7.0f32, -0.97, 1.04, 7.07] {
            v.push(Vec3::new(x, 9.50, -0.02));
        }
        // The side-fill wings: eight a side, tightly packed, eighteen metres
        // either side of centre, sharing a height and a depth with each other
        // and with nothing at all in between.
        for s in [-1.0f32, 1.0] {
            for i in 0..8 {
                v.push(Vec3::new(s * (17.6 + i as f32 * 0.18), 9.21, 0.49));
            }
        }
        v
    }

    #[test]
    fn the_arena_plot_resolves_to_its_overhead_bars() {
        let runs = infer_runs(&arena(), 2.0);
        // Three overhead bars, one sparse front truss, two side-fill wings.
        assert_eq!(runs.len(), 6, "{runs:#?}");
        let mut zs: Vec<f32> = runs.iter().map(|r| r.z).collect();
        zs.sort_by(f32::total_cmp);
        for (got, want) in zs.iter().zip([-7.29, -4.79, -2.29, -0.02, 0.49, 0.49]) {
            assert!((got - want).abs() < 0.4, "{zs:?}");
        }
        // The sparse front truss is drawn as ONE bar across its whole span,
        // holes and all — the case a fixed split distance got wrong.
        let front = runs.iter().find(|r| (r.z + 0.02).abs() < 0.1).expect("front truss");
        assert!(front.x1 - front.x0 > 14.0, "front truss spans {}", front.x1 - front.x0);
    }

    #[test]
    fn a_gap_wide_enough_to_be_two_structures_splits() {
        let runs = infer_runs(&arena(), 2.0);
        let wings: Vec<_> = runs.iter().filter(|r| r.z > 0.4).collect();
        assert_eq!(wings.len(), 2, "the side fills are two towers, not one 37 m bar");
        for w in wings {
            assert!(w.x1 - w.x0 < 3.0, "a wing spans {}", w.x1 - w.x0);
        }
    }

    /// The whole point of the height rule: the bar goes ABOVE what hangs off it.
    #[test]
    fn the_bar_clears_the_fixtures_hanging_from_it() {
        let runs = infer_runs(&arena(), 2.0);
        for r in &runs {
            let top = arena()
                .iter()
                .filter(|p| (p.z - r.z).abs() < 0.4 && (p.y - r.y).abs() < 1.0)
                .fold(f32::MIN, |m, p| m.max(p.y));
            assert!(r.y - SECTION * 0.5 >= top, "run at {} sits on top of {top}", r.y);
        }
    }

    #[test]
    fn floor_packages_get_no_truss() {
        let low: Vec<Vec3> = (0..6).map(|i| Vec3::new(i as f32, 0.4, -3.0)).collect();
        assert!(infer_runs(&low, 2.0).is_empty());
    }

    #[test]
    fn two_fixtures_are_not_evidence_of_a_bar() {
        let pair = vec![Vec3::new(-3.0, 6.0, -2.0), Vec3::new(3.0, 6.0, -2.0)];
        assert!(infer_runs(&pair, 2.0).is_empty());
    }

    /// Parameterising the section must not move the inferred runs, which were
    /// authored against a hard-coded 0.025 m chord at a 0.29 m section.
    #[test]
    fn the_inferred_section_still_gives_the_authored_chord() {
        let cfg = &crate::scene::STRUCT.truss;
        let chord = (SECTION * cfg.chord_ratio).max(cfg.min_chord);
        assert!((chord - 0.025).abs() < 1e-4, "chord is {chord}, was 0.025");
        let pitch = SECTION * cfg.bay_ratio;
        assert!((pitch - 0.5).abs() < 1e-3, "bay is {pitch}, was 0.5");
    }

    #[test]
    fn a_run_is_a_closed_mesh_with_geometry_in_it() {
        let m = truss_mesh(12.0, SECTION);
        let n = m.count_vertices();
        assert!(n > 500, "{n} vertices is not a truss");
        assert!(m.indices().is_some_and(|i| i.len() % 3 == 0));
    }
}
