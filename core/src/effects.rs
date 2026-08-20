use crate::types::{clamp01, Effect, EffectTarget, PartParams, Wave};

/// Deterministic 0..1 hash — ports the JS Math.imul construction bit-exactly.
fn hash01(a: i32, b: i32) -> f64 {
    let mut h = a
        .wrapping_mul(374761393)
        .wrapping_add(b.wrapping_mul(668265263));
    h = (h ^ (((h as u32) >> 13) as i32)).wrapping_mul(1274126177);
    ((h ^ (((h as u32) >> 16) as i32)) as u32) as f64 / 4294967296.0
}

pub fn wave_value(e: &Effect, phase: f64, head_idx: usize) -> f64 {
    let p = ((phase % 1.0) + 1.0) % 1.0;
    match e.wave {
        Wave::Sine => 0.5 - 0.5 * (p * std::f64::consts::PI * 2.0).cos(),
        Wave::Triangle => {
            if p < 0.5 {
                p * 2.0
            } else {
                2.0 - p * 2.0
            }
        }
        Wave::SawUp => p,
        Wave::SawDown => 1.0 - p,
        Wave::Square | Wave::Chase => {
            if p < e.width.max(0.02) {
                1.0
            } else {
                0.0
            }
        }
        Wave::Random => hash01(phase.floor() as i32, head_idx as i32 * 7919 + 13),
    }
}

fn is_centred(e: &Effect) -> bool {
    matches!(e.wave, Wave::Sine | Wave::Triangle | Wave::Square | Wave::Random)
}

/// 0..1 normalisation with a degenerate-extent guard: a single head (or a
/// perfectly stacked group) has no sweep axis, so everything lands in phase.
fn norm(v: f64, lo: f64, hi: f64) -> f64 {
    if hi - lo > 1e-9 { (v - lo) / (hi - lo) } else { 0.0 }
}

/// Fan position 0..1 for one head under an effect's spatial config (A1), plus
/// whether the head sits on the mirrored half (pan counter-rotates there).
/// Pipeline: basis (+reverse) → buddy clump → fold → parts tile. Only called on
/// the general path — the all-defaults fan is the verbatim legacy expression in
/// apply_effects, gated by the golden byte suites.
fn fan_pos(
    e: &Effect,
    j: usize,
    n: usize,
    g: &crate::geometry::HeadGeom,
    ext: &crate::geometry::GroupExtents,
) -> (f64, bool) {
    use crate::types::{Distribute, Fold};
    let mut t = match e.distribute {
        Distribute::X => norm(g.x, ext.min_x, ext.max_x),
        Distribute::Y => norm(g.y, ext.min_y, ext.max_y),
        Distribute::Z => norm(g.z, ext.min_z, ext.max_z),
        Distribute::Radial => {
            let (dx, dy, dz) = (g.x - ext.cx, g.y - ext.cy, g.z - ext.cz);
            if ext.max_r > 1e-9 {
                (dx * dx + dy * dy + dz * dz).sqrt() / ext.max_r
            } else {
                0.0
            }
        }
        // seeded, reproducible scatter - the same bit-exact hash the random
        // wave uses, so busking-safe randomness you can get back
        Distribute::Shuffle => hash01(j as i32, e.seed),
        Distribute::Index => {
            if n > 1 {
                j as f64 / n as f64
            } else {
                0.0
            }
        }
    };
    if e.reverse {
        // index keeps its grid spacing ((n−1−j)/n); continuous bases just flip
        t = if e.distribute == Distribute::Index {
            if n > 1 { (n - 1 - j) as f64 / n as f64 } else { 0.0 }
        } else {
            1.0 - t
        };
    }
    if e.buddy > 1 && n > 1 {
        // clump adjacent-in-fan heads onto ceil(n/buddy) equal steps
        let m = (n as f64 / e.buddy as f64).ceil();
        t = (t * m).floor().min(m - 1.0) / m;
    }
    let mirrored = e.fold == Fold::Mirror && t > 0.5;
    if e.fold == Fold::Mirror {
        t = if t <= 0.5 { 2.0 * t } else { 2.0 * (1.0 - t) };
    } else if e.fold == Fold::Centre {
        t = (2.0 * t - 1.0).abs();
    }
    // tile k repeats across the group - phase is circular, so the mod is safe
    if e.parts > 1 {
        t = (t * e.parts as f64) % 1.0;
    }
    (t, mirrored)
}

/// Apply a part's effects for one head. `beat` already includes the speed master.
/// `phase_corr[i]` is a per-effect phase offset that keeps the waveform
/// continuous when an effect's rate is changed on a live look (see the
/// renderer's rate-correction map). It is 0 for every effect of an untouched
/// show, so the output is byte-identical to passing an all-zero slice.
///
/// (head_idx, head_count, g, ext) together are the HeadCtx — flattened into
/// four arguments so the hot loop allocates nothing: g is the renderer's cached
/// HeadGeom and ext the group's cached extents, both passed by reference. The
/// legacy fan (all A1 fields at defaults) runs the pre-A1 expression VERBATIM,
/// gated by the golden byte suites.
pub fn apply_effects(
    params: &PartParams,
    effects: &[Effect],
    beat: f64,
    phase_corr: &[f64],
    head_idx: usize,
    head_count: usize,
    g: &crate::geometry::HeadGeom,
    ext: &crate::geometry::GroupExtents,
) -> PartParams {
    if effects.is_empty() {
        return params.clone();
    }
    let mut out = params.clone();
    for (i, e) in effects.iter().enumerate() {
        // bypass parks the effect entirely; mix 0 is fully dry - both leave
        // every target exactly as it was, including undriven ones (so a
        // bypassed dimmer effect does not force the group to full).
        if e.bypass || e.mix <= 0.0 || e.size <= 0.0 || e.rate <= 0.0 {
            continue;
        }
        let mix = e.mix;
        let spread = if e.wave == Wave::Chase { 1.0 } else { e.spread };
        let corr = phase_corr.get(i).copied().unwrap_or(0.0);
        let legacy_fan = e.distribute == crate::types::Distribute::Index
            && e.fold == crate::types::Fold::None
            && !e.reverse
            && e.parts <= 1
            && e.buddy <= 1;
        let (phase, mirrored) = if legacy_fan {
            // the pre-A1 expression, byte-for-byte
            let p = beat / e.rate
                + corr
                + e.phase
                + if head_count > 1 {
                    (head_idx as f64 / head_count as f64) * spread
                } else {
                    0.0
                };
            (p, false)
        } else {
            let (t, m) = fan_pos(e, head_idx, head_count, g, ext);
            (beat / e.rate + corr + e.phase + t * spread, m)
        };
        let v = wave_value(e, phase, head_idx);
        match e.target {
            EffectTarget::Dimmer => {
                let base = out.dimmer.unwrap_or(1.0);
                out.dimmer = Some(apply_mix(base, clamp01(base * (1.0 - e.size * (1.0 - v))), mix));
            }
            EffectTarget::Hue => {
                let mut c = out.color.unwrap_or(crate::types::ColorHS { h: 0.0, s: 1.0 });
                let delta = (if is_centred(e) { v - 0.5 } else { v }) * e.size * 360.0 * mix;
                c.h = ((c.h + delta) % 360.0 + 360.0) % 360.0;
                out.color = Some(c);
            }
            EffectTarget::White => {
                let dry = out.white.unwrap_or(0.0);
                out.white = Some(apply_mix(dry, clamp01(dry.max(v * e.size)), mix));
            }
            EffectTarget::Strobe => {
                let dry = out.strobe.unwrap_or(0.0);
                out.strobe = Some(apply_mix(dry, clamp01(dry.max(v * e.size)), mix));
            }
            EffectTarget::Pan => {
                let dry = out.pan.unwrap_or(0.5);
                // value-sign mirror: the mirrored half counter-rotates, so a
                // folded pan sweep opens and closes symmetrically
                let dir = if mirrored { -1.0 } else { 1.0 };
                out.pan = Some(apply_mix(dry, clamp01(dry + (v - 0.5) * e.size * dir), mix));
            }
            EffectTarget::Tilt => {
                let dry = out.tilt.unwrap_or(0.5);
                out.tilt = Some(apply_mix(dry, clamp01(dry + (v - 0.5) * e.size), mix));
            }
            // Beam parameters swing about their set value, like pan and tilt.
            // Adding the effect at all is the operator saying they want this
            // parameter driven, so an unset one starts from the middle of its
            // travel rather than staying parked.
            EffectTarget::Zoom => {
                let dry = out.zoom.unwrap_or(0.5);
                out.zoom = Some(apply_mix(dry, clamp01(dry + (v - 0.5) * e.size), mix));
            }
            EffectTarget::Focus => {
                let dry = out.focus.unwrap_or(0.5);
                out.focus = Some(apply_mix(dry, clamp01(dry + (v - 0.5) * e.size), mix));
            }
            EffectTarget::Iris => {
                let dry = out.iris.unwrap_or(0.5);
                out.iris = Some(apply_mix(dry, clamp01(dry + (v - 0.5) * e.size), mix));
            }
            EffectTarget::Frost => {
                let dry = out.frost.unwrap_or(0.5);
                out.frost = Some(apply_mix(dry, clamp01(dry + (v - 0.5) * e.size), mix));
            }
            EffectTarget::Cto => {
                let dry = out.cto.unwrap_or(0.5);
                out.cto = Some(apply_mix(dry, clamp01(dry + (v - 0.5) * e.size), mix));
            }
        }
    }
    out
}

/// Wet/dry blend of one target. At mix 1 this returns `wet` verbatim (byte-for-
/// byte the pre-mix behaviour); below 1 it eases back toward the dry value the
/// target held going into this effect. mix <= 0 is handled by skipping the whole
/// effect, so the target keeps whatever it had - including staying undriven.
fn apply_mix(dry: f64, wet: f64, mix: f64) -> f64 {
    if mix >= 1.0 {
        wet
    } else {
        dry + (wet - dry) * mix
    }
}

#[cfg(test)]
mod fan_tests {
    use super::*;
    use crate::geometry::{GroupExtents, HeadGeom};
    use crate::types::{Distribute, Fold, PartParams};

    // Twin of the "spatial fan" section in engine/test/smoke.ts: identical
    // inputs, identical expected values (computed once, asserted f64-exact in
    // BOTH engines - this is the cross-language contract for the fan maths).

    fn ext() -> GroupExtents {
        GroupExtents {
            min_x: 0.0, max_x: 3.0, min_y: 2.0, max_y: 2.0, min_z: 0.0, max_z: 0.0,
            cx: 1.5, cy: 2.0, cz: 0.0, max_r: 1.5,
        }
    }

    fn g_at(x: f64) -> HeadGeom {
        HeadGeom { x, y: 2.0, z: 0.0, along: 0.0, row: 0, col: 0 }
    }

    fn base() -> Effect {
        Effect {
            id: "e".into(),
            target: EffectTarget::Dimmer,
            wave: Wave::SawUp,
            rate: 1.0,
            size: 1.0,
            spread: 1.0,
            width: 0.5,
            phase: 0.0,
            bypass: false,
            mix: 1.0,
            distribute: Distribute::X,
            fold: Fold::None,
            reverse: false,
            parts: 1,
            buddy: 1,
            seed: 0,
        }
    }

    fn dims(e: &Effect) -> Vec<f64> {
        let params = PartParams { dimmer: Some(1.0), ..Default::default() };
        let xs = [0.0, 1.0, 2.0, 3.0];
        xs.iter()
            .enumerate()
            .map(|(j, &x)| {
                apply_effects(&params, std::slice::from_ref(e), 0.0, &[0.0], j, 4, &g_at(x), &ext())
                    .dimmer
                    .unwrap()
            })
            .collect()
    }

    #[test]
    fn x_fan_sweeps_the_group_and_wraps_at_a_full_wavelength() {
        // spread 1 = one wavelength across the rig, so both ends are in phase
        assert_eq!(dims(&base()), vec![0.0, 0.33333333333333326, 0.6666666666666665, 0.0]);
    }

    #[test]
    fn mirror_folds_ends_in_phase_sweeping_to_centre() {
        let e = Effect { fold: Fold::Mirror, ..base() };
        assert_eq!(dims(&e), vec![0.0, 0.6666666666666665, 0.6666666666666667, 0.0]);
    }

    #[test]
    fn centre_fold_leads_from_the_middle() {
        let e = Effect { fold: Fold::Centre, ..base() };
        assert_eq!(dims(&e), vec![0.0, 0.3333333333333335, 0.33333333333333326, 0.0]);
    }

    #[test]
    fn buddy_clumps_adjacent_heads() {
        let e = Effect { buddy: 2, ..base() };
        assert_eq!(dims(&e), vec![0.0, 0.0, 0.5, 0.5]);
    }

    #[test]
    fn parts_tiles_the_fan() {
        let e = Effect { parts: 2, ..base() };
        assert_eq!(dims(&e), vec![0.0, 0.6666666666666665, 0.33333333333333326, 0.0]);
    }

    #[test]
    fn reverse_index_keeps_grid_spacing() {
        let e = Effect { distribute: Distribute::Index, reverse: true, ..base() };
        assert_eq!(dims(&e), vec![0.75, 0.5, 0.25, 0.0]);
    }

    #[test]
    fn radial_ripples_from_the_centroid() {
        let e = Effect { distribute: Distribute::Radial, ..base() };
        assert_eq!(dims(&e), vec![0.0, 0.33333333333333326, 0.33333333333333326, 0.0]);
    }

    #[test]
    fn shuffle_is_seeded_and_reproducible() {
        let e = Effect { distribute: Distribute::Shuffle, seed: 42, ..base() };
        assert_eq!(
            dims(&e),
            vec![0.9707432389259338, 0.6836519397329539, 0.5080116945318878, 0.5004639013204724]
        );
    }

    #[test]
    fn mirrored_half_counter_rotates_pan() {
        let e = Effect {
            target: EffectTarget::Pan,
            wave: Wave::Sine,
            size: 0.5,
            spread: 0.0,
            fold: Fold::Mirror,
            ..base()
        };
        let xs = [0.0, 1.0, 2.0, 3.0];
        let got: Vec<f64> = xs
            .iter()
            .enumerate()
            .map(|(j, &x)| {
                apply_effects(&PartParams::default(), std::slice::from_ref(&e), 0.125, &[0.0], j, 4, &g_at(x), &ext())
                    .pan
                    .unwrap()
            })
            .collect();
        // symmetric about centre: the far half swings the opposite way
        assert_eq!(
            got,
            vec![0.32322330470336313, 0.32322330470336313, 0.6767766952966369, 0.6767766952966369]
        );
    }
}
