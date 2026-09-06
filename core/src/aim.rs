//! Where a moving head actually ends up: the look's request, through the
//! fixture's calibration, onto its channels.
//!
//! A rig is not a diagram. Heads get hung backwards, upside down and on their
//! sides, and one of them is always the one that sweeps the wrong way when
//! every other head sweeps right. Before this the only cure was to re-focus
//! that head and accept that every look moved it wrongly, or to fix it in the
//! patch and watch the stage view disagree with the rig.
//!
//! The order is deliberate and both engines share it:
//!
//! 1. take the look's pan and tilt as DELTAS from centre — that is what they
//!    already were, so a fixture with nothing calibrated is untouched;
//! 2. swap them, if the head is on its side;
//! 3. invert either, naming the FIXTURE's axis (so it reads the same whether
//!    or not the swap happened);
//! 4. add the base aim — the operator's focus, which never moves when the
//!    calibration changes, because they set it by looking at the rig;
//! 5. clamp into the soft limits.
//!
//! Inverting the DELTA rather than the result is the whole point: the head
//! stays where it was focused and only the movement mirrors. It is the same
//! trick the effect engine already plays on the mirrored half of a folded pan
//! spread (crate::effects).
//!
//! Mirrors shared/aim.ts. The two must agree to the last bit.

use crate::types::{clamp, clamp01, FixtureCal};

/// Does this fixture need the aim pass at all? Centred base and no
/// calibration is arithmetically identical to leaving it alone, and saying so
/// keeps a 129-fixture rig off this path entirely.
pub fn aim_is_identity(base_pan: f64, base_tilt: f64, cal: Option<&FixtureCal>) -> bool {
    if base_pan != 0.5 || base_tilt != 0.5 {
        return false;
    }
    match cal {
        None => true,
        Some(c) => {
            !c.invert_pan
                && !c.invert_tilt
                && !c.swap
                && c.pan_min.unwrap_or(0.0) <= 0.0
                && c.pan_max.unwrap_or(1.0) >= 1.0
                && c.tilt_min.unwrap_or(0.0) <= 0.0
                && c.tilt_max.unwrap_or(1.0) >= 1.0
        }
    }
}

/// The resolved look values, mapped onto what this fixture's channels get.
pub fn apply_aim(
    pan: f64,
    tilt: f64,
    base_pan: f64,
    base_tilt: f64,
    cal: Option<&FixtureCal>,
) -> (f64, f64) {
    let mut dp = pan - 0.5;
    let mut dt = tilt - 0.5;
    if let Some(c) = cal {
        if c.swap {
            std::mem::swap(&mut dp, &mut dt);
        }
        if c.invert_pan {
            dp = -dp;
        }
        if c.invert_tilt {
            dt = -dt;
        }
    }
    // Limits are a fraction of travel and default to the whole of it. A pair
    // given the wrong way round would otherwise clamp everything to one value
    // and park the head; low wins, so a mistake reads as "stuck at the low
    // limit" rather than as a fixture that has died.
    let (p_lo, p_hi, t_lo, t_hi) = match cal {
        None => (0.0, 1.0, 0.0, 1.0),
        Some(c) => {
            let p_lo = clamp01(c.pan_min.unwrap_or(0.0));
            let t_lo = clamp01(c.tilt_min.unwrap_or(0.0));
            (
                p_lo,
                clamp01(c.pan_max.unwrap_or(1.0)).max(p_lo),
                t_lo,
                clamp01(c.tilt_max.unwrap_or(1.0)).max(t_lo),
            )
        }
    };
    (clamp(base_pan + dp, p_lo, p_hi), clamp(base_tilt + dt, t_lo, t_hi))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The engines have to agree to the last bit, and they do — both are f64
    /// doing the same operations in the same order. A TEST expectation typed
    /// as 0.1 does not: 0.3 + -(0.7 - 0.5) is 0.10000000000000003, which is
    /// the right answer written out in full.
    #[track_caller]
    fn near(got: (f64, f64), want: (f64, f64)) {
        assert!(
            (got.0 - want.0).abs() < 1e-12 && (got.1 - want.1).abs() < 1e-12,
            "got {got:?}, want {want:?}"
        );
    }

    fn cal(f: impl FnOnce(&mut FixtureCal)) -> FixtureCal {
        let mut c = FixtureCal::default();
        f(&mut c);
        c
    }

    #[test]
    fn nothing_calibrated_is_the_old_behaviour() {
        assert!(aim_is_identity(0.5, 0.5, None));
        for (p, t) in [(0.0, 0.0), (0.5, 0.5), (1.0, 1.0), (0.25, 0.9)] {
            assert_eq!(apply_aim(p, t, 0.5, 0.5, None), (p, t));
        }
    }

    #[test]
    fn a_base_aim_moves_the_centre_and_the_look_is_a_delta() {
        // the pre-calibration rule, unchanged
        assert_eq!(apply_aim(0.5, 0.5, 0.25, 0.25, None), (0.25, 0.25));
        assert_eq!(apply_aim(1.0, 1.0, 0.25, 0.25, None), (0.75, 0.75));
        assert!(!aim_is_identity(0.25, 0.5, None));
    }

    #[test]
    fn invert_mirrors_the_movement_and_leaves_the_focus_alone() {
        let c = cal(|c| c.invert_pan = true);
        // the head stays where it was focused...
        near(apply_aim(0.5, 0.5, 0.3, 0.5, Some(&c)), (0.3, 0.5));
        // ...and a look that pans right now pans left from there
        near(apply_aim(0.7, 0.5, 0.3, 0.5, Some(&c)), (0.1, 0.5));
        // tilt is untouched by a pan inversion
        near(apply_aim(0.5, 0.8, 0.3, 0.5, Some(&c)), (0.3, 0.8));
    }

    #[test]
    fn swap_sends_the_looks_tilt_to_the_pan_channel() {
        let c = cal(|c| c.swap = true);
        assert_eq!(apply_aim(0.5, 0.9, 0.5, 0.5, Some(&c)), (0.9, 0.5));
        assert_eq!(apply_aim(0.9, 0.5, 0.5, 0.5, Some(&c)), (0.5, 0.9));
    }

    #[test]
    fn invert_names_the_fixtures_axis_not_the_looks() {
        // swapped AND pan-inverted: the look's tilt reaches the pan channel,
        // and it is the PAN channel that runs backwards
        let c = cal(|c| {
            c.swap = true;
            c.invert_pan = true;
        });
        near(apply_aim(0.5, 0.9, 0.5, 0.5, Some(&c)), (0.1, 0.5));
    }

    #[test]
    fn soft_limits_hold_whatever_a_look_asks_for() {
        let c = cal(|c| {
            c.pan_min = Some(0.3);
            c.pan_max = Some(0.7);
            c.tilt_max = Some(0.6);
        });
        assert_eq!(apply_aim(1.0, 1.0, 0.5, 0.5, Some(&c)), (0.7, 0.6));
        assert_eq!(apply_aim(0.0, 0.0, 0.5, 0.5, Some(&c)), (0.3, 0.0));
        // and a limit does not move anything already inside it
        assert_eq!(apply_aim(0.6, 0.5, 0.5, 0.5, Some(&c)), (0.6, 0.5));
    }

    #[test]
    fn limits_the_wrong_way_round_park_the_head_low_rather_than_nowhere() {
        let c = cal(|c| {
            c.pan_min = Some(0.8);
            c.pan_max = Some(0.2);
        });
        let (p, _) = apply_aim(0.5, 0.5, 0.5, 0.5, Some(&c));
        assert_eq!(p, 0.8, "low wins, so it reads as stuck rather than dead");
    }

    #[test]
    fn a_calibration_that_corrects_nothing_is_still_the_identity() {
        let c = cal(|c| {
            c.pan_min = Some(0.0);
            c.pan_max = Some(1.0);
        });
        assert!(aim_is_identity(0.5, 0.5, Some(&c)));
        let c2 = cal(|c| c.invert_tilt = true);
        assert!(!aim_is_identity(0.5, 0.5, Some(&c2)));
    }
}
