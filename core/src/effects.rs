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

/// Apply a part's effects for one head. `beat` already includes the speed master.
/// `phase_corr[i]` is a per-effect phase offset that keeps the waveform
/// continuous when an effect's rate is changed on a live look (see the
/// renderer's rate-correction map). It is 0 for every effect of an untouched
/// show, so the output is byte-identical to passing an all-zero slice.
///
/// (head_idx, head_count, _g) together are the HeadCtx — flattened into three
/// arguments so the hot loop allocates nothing: _g is the renderer's cached
/// HeadGeom, passed by reference. Carried since B2, consumed from A1 (spatial
/// fan); until then it must not influence output, which the golden byte suites
/// gate.
pub fn apply_effects(
    params: &PartParams,
    effects: &[Effect],
    beat: f64,
    phase_corr: &[f64],
    head_idx: usize,
    head_count: usize,
    _g: &crate::geometry::HeadGeom,
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
        let phase = beat / e.rate
            + corr
            + e.phase
            + if head_count > 1 {
                (head_idx as f64 / head_count as f64) * spread
            } else {
                0.0
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
                out.pan = Some(apply_mix(dry, clamp01(dry + (v - 0.5) * e.size), mix));
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
