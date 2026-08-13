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
pub fn apply_effects(
    params: &PartParams,
    effects: &[Effect],
    beat: f64,
    head_idx: usize,
    head_count: usize,
) -> PartParams {
    if effects.is_empty() {
        return params.clone();
    }
    let mut out = params.clone();
    for e in effects {
        if e.size <= 0.0 || e.rate <= 0.0 {
            continue;
        }
        let spread = if e.wave == Wave::Chase { 1.0 } else { e.spread };
        let phase = beat / e.rate
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
                out.dimmer = Some(clamp01(base * (1.0 - e.size * (1.0 - v))));
            }
            EffectTarget::Hue => {
                let mut c = out.color.unwrap_or(crate::types::ColorHS { h: 0.0, s: 1.0 });
                let delta = (if is_centred(e) { v - 0.5 } else { v }) * e.size * 360.0;
                c.h = ((c.h + delta) % 360.0 + 360.0) % 360.0;
                out.color = Some(c);
            }
            EffectTarget::White => {
                out.white = Some(clamp01(out.white.unwrap_or(0.0).max(v * e.size)));
            }
            EffectTarget::Strobe => {
                out.strobe = Some(clamp01(out.strobe.unwrap_or(0.0).max(v * e.size)));
            }
            EffectTarget::Pan => {
                out.pan = Some(clamp01(out.pan.unwrap_or(0.5) + (v - 0.5) * e.size));
            }
            EffectTarget::Tilt => {
                out.tilt = Some(clamp01(out.tilt.unwrap_or(0.5) + (v - 0.5) * e.size));
            }
        }
    }
    out
}
