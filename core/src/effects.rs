use crate::types::{clamp01, Effect, EffectTarget, PartParams, ShapeKind, Wave};

/// Deterministic 0..1 hash — ports the JS Math.imul construction bit-exactly.
fn hash01(a: i32, b: i32) -> f64 {
    let mut h = a
        .wrapping_mul(374761393)
        .wrapping_add(b.wrapping_mul(668265263));
    h = (h ^ (((h as u32) >> 13) as i32)).wrapping_mul(1274126177);
    ((h ^ (((h as u32) >> 16) as i32)) as u32) as f64 / 4294967296.0
}

/// Where on a figure phase p lands, as offsets in -1..1 on each axis.
///
/// Pure, and written in the same operations in the same order as shapeAt in
/// shared/effects.ts — the two engines have to land on the same f64. That is
/// already true of the sine wave below, which has been parity-pinned for
/// months on exactly this arrangement; trig is not required by IEEE-754 to be
/// correctly rounded, so identical source is the guarantee, not identical
/// results in principle.
///
/// The caller scales, rotates and offsets. This is only the figure.
pub fn shape_at(kind: ShapeKind, phase: f64, ccw: bool) -> (f64, f64) {
    let w = ((phase % 1.0) + 1.0) % 1.0;
    let p = if ccw { 1.0 - w } else { w };
    let t = p * std::f64::consts::PI * 2.0;
    match kind {
        // Gerono's lemniscate on its side: crosses itself at the centre, which
        // is what makes it read as a figure-8 rather than as a wobble.
        ShapeKind::Figure8 => (t.sin(), (t * 2.0).sin()),
        // Perimeter walk, a quarter of the phase per side. Corners are the
        // point: a head visibly stops turning one way and starts the other.
        ShapeKind::Square => {
            let q = p * 4.0;
            let side = (q.floor() as i32).min(3);
            let f = q - side as f64;
            match side {
                0 => (-1.0 + 2.0 * f, -1.0),
                1 => (1.0, -1.0 + 2.0 * f),
                2 => (1.0 - 2.0 * f, 1.0),
                _ => (-1.0, 1.0 - 2.0 * f),
            }
        }
        ShapeKind::Circle => (t.cos(), t.sin()),
    }
}

/// Pan and tilt amplitudes for a shape, from its size and aspect.
///
/// Aspect 0.5 gives both the full size; 0 is all pan and 1 is all tilt, so the
/// same knob covers a circle, an ellipse, a flat sweep and a vertical bounce.
/// Half-amplitude each way, matching the plain pan and tilt targets: a
/// full-size figure spans the whole of the head's travel and no more.
pub fn shape_amps(size: f64, aspect: f64) -> (f64, f64) {
    (
        size * (2.0 * (1.0 - aspect)).min(1.0) * 0.5,
        size * (2.0 * aspect).min(1.0) * 0.5,
    )
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
        Wave::Random => hash01(phase.floor().clamp(-2147483648.0, 2147483647.0) as i32, head_idx as i32 * 7919 + 13),
    }
}

/// Modulator wave value 0..1 (P2): a pure function of phase - no state, so it
/// is byte-identical across engines by construction. Square/chase run at a
/// fixed 0.5 width; random is sample-and-hold keyed by the modulator's index.
/// Mirrors modWave in shared/effects.ts.
pub fn mod_wave(wave: Wave, phase: f64, seed_idx: usize) -> f64 {
    let p = ((phase % 1.0) + 1.0) % 1.0;
    match wave {
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
            if p < 0.5 {
                1.0
            } else {
                0.0
            }
        }
        Wave::Random => hash01(phase.floor().clamp(-2147483648.0, 2147483647.0) as i32, seed_idx as i32 * 7919 + 13),
    }
}

/// The neutral a modulator offset rides on when the look never set the part
/// field. Mirrors softBase in shared/effects.ts.
pub fn soft_base(params: &PartParams, field: crate::types::SoftField) -> f64 {
    use crate::types::SoftField as F;
    match field {
        F::Dimmer => params.dimmer.unwrap_or(1.0),
        F::Hue => params.color.map_or(0.0, |c| c.h),
        F::Sat => params.color.map_or(1.0, |c| c.s),
        F::Pan => params.pan.unwrap_or(0.5),
        F::Tilt => params.tilt.unwrap_or(0.5),
        F::Zoom => params.zoom.unwrap_or(0.5),
        F::Focus => params.focus.unwrap_or(0.5),
        F::Iris => params.iris.unwrap_or(0.5),
        F::Frost => params.frost.unwrap_or(0.5),
        F::Cto => params.cto.unwrap_or(0.5),
        F::GoboRotate => params.gobo_rotate.unwrap_or(0.5),
        F::PrismRotate => params.prism_rotate.unwrap_or(0.5),
        F::White => params.white.unwrap_or(0.0),
        F::RingFx => params.ring_fx.unwrap_or(0.0),
        F::Strobe => params.strobe.unwrap_or(0.0),
        F::MotorValue => params.motor_value.unwrap_or(0.0),
        F::Haze => params.haze.unwrap_or(0.0),
        F::Fan => params.fan.unwrap_or(0.0),
        _ => 0.0, // effect-only fields never reach here
    }
}

/// Current value of an effect knob, for a modulator's base read. None when a
/// part-field is (mis)bound with an effect address - skipped, matching the
/// Node twin's NaN-clamp rejection.
pub fn effect_field_value(e: &Effect, field: crate::types::SoftField) -> Option<f64> {
    use crate::types::SoftField as F;
    match field {
        F::Rate => Some(e.rate),
        F::Size => Some(e.size),
        F::Spread => Some(e.spread),
        F::Width => Some(e.width),
        F::Phase => Some(e.phase),
        F::Mix => Some(e.mix),
        _ => None,
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
        // normalized within the head's OWN fixture: every fixture of a type
        // runs the same pixel wave - "grab one strobe, every strobe is the same"
        Distribute::Row => g.row_t,
        Distribute::Col => g.col_t,
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
    // >= so an even buddy grid (which lands a clump exactly on 0.5) splits into
    // two whole wings - with strict > that clump joined the near wing and its
    // pan failed to counter-rotate
    let mirrored = e.fold == Fold::Mirror && t >= 0.5;
    if e.fold == Fold::Mirror {
        t = if t <= 0.5 { 2.0 * t } else { 2.0 * (1.0 - t) };
    } else if e.fold == Fold::Centre {
        t = (2.0 * t - 1.0).abs();
    }
    // tile k repeats across the group - phase is circular, so the mod is safe
    if e.parts > 1 {
        t = (t * e.parts as f64) % 1.0;
    }
    // A chase deals n distinct slots. The spatial bases (and folds) are
    // INCLUSIVE - the far head sits at exactly t = 1, which under chase's
    // forced full spread wraps onto the near head and locks the two ends
    // together with no operator escape. Compress the finished fan to the
    // index-style exclusive span instead; linear, so slots stay evenly spaced.
    if e.wave == Wave::Chase && n > 1 {
        t *= (n - 1) as f64 / n as f64;
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
            // The one target that writes two parameters. `wave` and `width`
            // say nothing here — the figure IS the waveform — so the phase
            // goes to the shape directly rather than through wave_value.
            EffectTarget::Shape => {
                let (fx, fy) = shape_at(e.shape.unwrap_or(ShapeKind::Circle), phase, e.shape_ccw);
                let rot = e.shape_rotate.unwrap_or(0.0) * std::f64::consts::PI * 2.0;
                let (ca, sa) = (rot.cos(), rot.sin());
                let rx = fx * ca - fy * sa;
                let ry = fx * sa + fy * ca;
                let (amp_pan, amp_tilt) = shape_amps(e.size, e.shape_aspect.unwrap_or(0.5));
                // the same value-sign mirror the plain pan target uses, so a
                // folded spread opens and closes instead of shearing
                let dir = if mirrored { -1.0 } else { 1.0 };
                let dry_pan = out.pan.unwrap_or(0.5);
                let dry_tilt = out.tilt.unwrap_or(0.5);
                out.pan = Some(apply_mix(dry_pan, clamp01(dry_pan + rx * amp_pan * dir), mix));
                out.tilt = Some(apply_mix(dry_tilt, clamp01(dry_tilt + ry * amp_tilt), mix));
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
            // The optics rotations are continuous like the beam parameters, so
            // a wave swings the spin speed about its set value the same way.
            EffectTarget::GoboRotate => {
                let dry = out.gobo_rotate.unwrap_or(0.5);
                out.gobo_rotate = Some(apply_mix(dry, clamp01(dry + (v - 0.5) * e.size), mix));
            }
            EffectTarget::PrismRotate => {
                let dry = out.prism_rotate.unwrap_or(0.5);
                out.prism_rotate = Some(apply_mix(dry, clamp01(dry + (v - 0.5) * e.size), mix));
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
mod shape_tests {
    use super::*;
    use crate::types::ShapeKind;

    fn near(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-9
    }

    #[test]
    fn a_circle_is_a_circle() {
        for i in 0..64 {
            let p = i as f64 / 64.0;
            let (x, y) = shape_at(ShapeKind::Circle, p, false);
            assert!(near(x * x + y * y, 1.0), "phase {p}: ({x}, {y}) is off the unit circle");
        }
        let (x, y) = shape_at(ShapeKind::Circle, 0.0, false);
        assert!(near(x, 1.0) && near(y, 0.0), "starts at the right of the figure");
        assert!(shape_at(ShapeKind::Circle, 0.1, false).1 > 0.0, "and rises first");
    }

    #[test]
    fn a_figure_of_eight_crosses_itself_at_the_centre() {
        // twice a lap, which is what tells it from an oval
        let crossings = (0..1000)
            .map(|i| shape_at(ShapeKind::Figure8, i as f64 / 1000.0, false))
            .filter(|(x, y)| x.abs() < 0.02 && y.abs() < 0.02)
            .count();
        assert!(crossings > 0, "never passes through the middle");
        assert!(near(shape_at(ShapeKind::Figure8, 0.0, false).0, 0.0));
        assert!(near(shape_at(ShapeKind::Figure8, 0.5, false).0, 0.0), "and again half way round");
    }

    #[test]
    fn a_square_walks_its_perimeter_and_stays_on_it() {
        for i in 0..400 {
            let p = i as f64 / 400.0;
            let (x, y) = shape_at(ShapeKind::Square, p, false);
            assert!(near(x.abs(), 1.0) || near(y.abs(), 1.0), "phase {p}: ({x}, {y}) is off the edge");
            assert!(x.abs() <= 1.0 + 1e-9 && y.abs() <= 1.0 + 1e-9);
        }
        assert_eq!(shape_at(ShapeKind::Square, 0.0, false), (-1.0, -1.0));
        assert_eq!(shape_at(ShapeKind::Square, 0.25, false), (1.0, -1.0));
        assert_eq!(shape_at(ShapeKind::Square, 0.5, false), (1.0, 1.0));
        assert_eq!(shape_at(ShapeKind::Square, 0.75, false), (-1.0, 1.0));
    }

    #[test]
    fn every_figure_is_bounded_and_wraps() {
        for kind in [ShapeKind::Circle, ShapeKind::Figure8, ShapeKind::Square] {
            for i in -50..150 {
                let p = i as f64 / 50.0;
                let (x, y) = shape_at(kind, p, false);
                assert!(x.abs() <= 1.0 + 1e-9 && y.abs() <= 1.0 + 1e-9, "{kind:?} at {p}");
            }
            // The effect clock runs in beats and never stops climbing, so a
            // phase outside 0..1 has to land on the same point as its wrap.
            // NEAR, not equal: 3.3 % 1.0 is not bit-identical to 0.3, so the
            // trig downstream differs in the last place. Both engines do the
            // same arithmetic in the same order, so they agree with each
            // other — which is the property that matters — and the DMX byte
            // this becomes is the same either way. Every existing wave has
            // wrapped like this since the beginning.
            for (a, b) in [(0.3, 3.3), (0.3, -0.7)] {
                let (x1, y1) = shape_at(kind, a, false);
                let (x2, y2) = shape_at(kind, b, false);
                assert!(near(x1, x2) && near(y1, y2), "{kind:?}: {a} and {b} differ");
            }
        }
    }

    #[test]
    fn anticlockwise_is_the_same_figure_the_other_way() {
        for kind in [ShapeKind::Circle, ShapeKind::Figure8, ShapeKind::Square] {
            for i in 1..20 {
                let p = i as f64 / 20.0;
                let cw = shape_at(kind, p, false);
                let ccw = shape_at(kind, 1.0 - p, true);
                assert!(near(cw.0, ccw.0) && near(cw.1, ccw.1), "{kind:?} at {p}");
            }
        }
    }

    #[test]
    fn aspect_trades_one_axis_for_the_other() {
        // even: both get the full size, half-amplitude each way, so a
        // full-size figure spans the travel and no more
        assert_eq!(shape_amps(1.0, 0.5), (0.5, 0.5));
        assert_eq!(shape_amps(1.0, 0.0), (0.5, 0.0), "all pan");
        assert_eq!(shape_amps(1.0, 1.0), (0.0, 0.5), "all tilt");
        assert_eq!(shape_amps(0.5, 0.5), (0.25, 0.25), "size scales both");
        for i in 0..=20 {
            let (p, t) = shape_amps(1.0, i as f64 / 20.0);
            assert!(p <= 0.5 + 1e-9 && t <= 0.5 + 1e-9, "never past half the travel");
        }
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
        HeadGeom { x, y: 2.0, z: 0.0, along: 0.0, row: 0, col: 0, row_t: 0.0, col_t: 0.0 }
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
            shape: None,
            shape_aspect: None,
            shape_rotate: None,
            shape_ccw: false,
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
    fn y_and_z_sweep_their_own_axes() {
        // Heads on a diagonal where y INCREASES with index and z DECREASES, so
        // a transposed-axis typo (the y branch reading z, or vice versa) fails
        // — with co-linear axes, normalisation would erase the difference.
        let ext = GroupExtents {
            min_x: 0.0, max_x: 3.0, min_y: 2.0, max_y: 5.0, min_z: 0.0, max_z: 3.0,
            cx: 1.5, cy: 3.5, cz: 1.5, max_r: 2.598076211353316,
        };
        let g = |i: usize| HeadGeom {
            x: i as f64, y: 2.0 + i as f64, z: 3.0 - i as f64, along: 0.0, row: 0, col: 0, row_t: 0.0, col_t: 0.0,
        };
        let params = PartParams { dimmer: Some(1.0), ..Default::default() };
        let run = |e: &Effect| -> Vec<f64> {
            (0..4)
                .map(|j| {
                    apply_effects(&params, std::slice::from_ref(e), 0.0, &[0.0], j, 4, &g(j), &ext)
                        .dimmer
                        .unwrap()
                })
                .collect()
        };
        let ey = Effect { distribute: Distribute::Y, ..base() };
        let ez = Effect { distribute: Distribute::Z, ..base() };
        assert_eq!(run(&ey), vec![0.0, 0.33333333333333326, 0.6666666666666665, 0.0]);
        assert_eq!(run(&ez), vec![0.0, 0.6666666666666665, 0.33333333333333326, 0.0], "z runs the other way on this rig");
    }

    #[test]
    fn buddy_mirror_far_clump_counter_rotates_pan() {
        // regression: with strict t > 0.5 an even buddy grid put its far clump
        // exactly ON 0.5 and it panned WITH the near wing
        let e = Effect {
            target: EffectTarget::Pan,
            wave: Wave::Sine,
            size: 0.5,
            spread: 0.0,
            fold: Fold::Mirror,
            buddy: 2,
            ..base()
        };
        let got: Vec<f64> = [0.0, 1.0, 2.0, 3.0]
            .iter()
            .enumerate()
            .map(|(j, &x)| {
                apply_effects(&PartParams::default(), std::slice::from_ref(&e), 0.125, &[0.0], j, 4, &g_at(x), &ext())
                    .pan
                    .unwrap()
            })
            .collect();
        assert_eq!(
            got,
            vec![0.32322330470336313, 0.32322330470336313, 0.6767766952966369, 0.6767766952966369]
        );
    }

    #[test]
    fn chase_deals_distinct_slots_on_a_spatial_fan() {
        // regression: the inclusive spatial t = 1 wrapped onto t = 0 under
        // chase's forced full spread, locking the two end heads together
        let e = Effect {
            wave: Wave::Chase,
            width: 0.25,
            distribute: Distribute::X,
            ..base()
        };
        let params = PartParams { dimmer: Some(1.0), ..Default::default() };
        let got: Vec<f64> = [0.0, 1.0, 2.0, 3.0]
            .iter()
            .enumerate()
            .map(|(j, &x)| {
                apply_effects(&params, std::slice::from_ref(&e), 0.1, &[0.0], j, 4, &g_at(x), &ext())
                    .dimmer
                    .unwrap()
            })
            .collect();
        // one lit slot — before the fix the far head wrapped into it: [1,0,0,1]
        assert_eq!(got, vec![1.0, 0.0, 0.0, 0.0]);
    }

    #[test]
    fn col_basis_fans_within_each_fixture() {
        // two 4-pixel fixtures in one 8-head group: the col basis reads the
        // per-fixture normalized colT and ignores the group index entirely, so
        // both fixtures run the SAME wave — "grab one strobe, lay out the
        // pixels, every strobe is the same".
        let e = Effect { distribute: Distribute::Col, ..base() };
        let params = PartParams { dimmer: Some(1.0), ..Default::default() };
        let col_ts = [0.0, 0.333333, 0.666667, 1.0, 0.0, 0.333333, 0.666667, 1.0];
        let got: Vec<f64> = (0..8)
            .map(|j| {
                let g = HeadGeom {
                    x: j as f64, y: 2.0, z: 0.0, along: 0.0,
                    row: 0, col: j % 4, row_t: 0.0, col_t: col_ts[j],
                };
                apply_effects(&params, std::slice::from_ref(&e), 0.0, &[0.0], j, 8, &g, &ext())
                    .dimmer
                    .unwrap()
            })
            .collect();
        assert_eq!(
            got,
            vec![
                0.0, 0.3333330000000001, 0.6666669999999999, 0.0,
                0.0, 0.3333330000000001, 0.6666669999999999, 0.0
            ]
        );
        assert_eq!(&got[0..4], &got[4..8], "both fixtures run the identical wave");
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
