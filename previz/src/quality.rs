//! Render-quality settings, read once from the environment at startup.
//!
//! Two reasons this exists rather than a pile of constants.
//!
//! First, iteration. A release build of this crate is ~5 minutes, so tuning a
//! sample count by editing a `const` costs five minutes per data point and
//! nobody does it twice. These are the knobs that trade frame time for
//! picture, and they need to be turnable while the window is open in front of
//! you.
//!
//! Second, the budget is real and small. `docs/benchmarks.md` records the
//! default rig at 8.6 ms against an 8.3 ms target and the 44-head stress rig at
//! 15.9 ms — this renderer is at or over budget before anything is added to it.
//! Anything that costs frame time therefore has to be a *tier*, off by default
//! on the machines that cannot pay for it, rather than a decision baked in for
//! everyone.
//!
//! `LIGHT_PREVIZ_QUALITY=low|standard|high` picks a preset; individual
//! variables override whatever the preset chose.

use bevy::prelude::*;

#[derive(Resource, Clone, Copy, Debug)]
pub struct Quality {
    /// Post-process anti-aliasing (SMAA).
    ///
    /// The previz is thin bright geometry against near-black with bloom on
    /// top, which is the worst case for edge crawl — and MSAA is no longer
    /// available at the default tier, because it cannot coexist with the
    /// single-sampled half-res beam target. SMAA runs after tonemapping on the
    /// resolved image, so it is compatible with everything, costs about a
    /// millisecond, and unlike TAA it cannot smear a moving beam, which is the
    /// one thing this window exists to show.
    pub smaa: bool,

    /// MSAA samples: 1 (off), 2, 4 or 8.
    ///
    /// A previz is thin bright geometry against near-black with bloom on top,
    /// which is the worst case for aliasing — but volumetric fog runs a
    /// multisampled path when this is on, so it is also one of the more
    /// expensive things here. Measure before raising it.
    pub msaa: u32,
    /// Raymarch steps for the haze volume. Bevy's default is 64, spread across
    /// whatever the volume spans, so a big room bands.
    pub fog_steps: u32,
    /// How much larger than the fitted room the haze volume is drawn, so its
    /// faces — a hard scattering boundary — sit outside the shot.
    pub haze_oversize: f32,
    /// Shadow-casting spotlights. Each costs its own depth pass, so this is the
    /// single biggest lever on a large rig.
    pub shadows: usize,

    // --- photometrics -------------------------------------------------
    //
    // These are one system, not four knobs, and they only make sense
    // together. Bevy is physically based: a SpotLight's `intensity` is
    // LUMENS, it becomes candela, and what finally lands on screen is
    // scaled by the camera's exposure, `2^-ev100 / 1.2`.
    //
    // Bevy's default EV100 is 9.7 — calibrated against Blender, and roughly
    // an overcast afternoon. A dark venue is nowhere near that, and the
    // previz had been compensating by inventing fixtures of EIGHT MILLION
    // lumens (a real moving head is ten to twenty thousand) with a comment
    // claiming 1e6 lm is "a domestic point light". It is about a thousand
    // of them.
    //
    // Exposing the venue instead of the sun lets the fixtures carry
    // plausible numbers, which matters beyond tidiness: once the profile
    // knows a real flux, the beam shader can conserve it across a zoom, and
    // "this fixture is brighter than that one" becomes a fact about the rig
    // rather than a fudge.
    /// Camera exposure. Lower is a brighter picture. ~3 is a dark venue.
    pub ev100: f32,
    /// Multiplies every fixture's luminous flux. The rig-wide trim.
    pub lumen_scale: f32,
    /// Ambient fill, in the same units as GlobalAmbientLight::brightness.
    pub ambient: f32,
    /// Multiplies the additive beam-cone brightness.
    pub beam_gain: f32,
    /// Draw box truss inferred from where the fixtures hang (LIGHT_PREVIZ_TRUSS).
    pub truss: bool,

    /// Hard cap on a light's range, in metres.
    ///
    /// Kept as a diagnostic rather than a tuning lever: measured on the demo
    /// rig it buys almost nothing (42.6 ms at 39 m against 42.3 at 18 and 39.2
    /// at an unusably short 8), which is itself the useful finding — the cost
    /// of a light here is per-pixel shading, not cluster assignment. Defaults
    /// high enough not to cut light off in a real room.
    pub light_range_cap: f32,

    /// Light panels with a real area light rather than a wide spot.
    ///
    /// A `RectLight` is the honest primitive for a blinder plate: it emits from
    /// its whole face, so the wash has soft square-ish edges instead of a hard
    /// ellipse. It is also, measured on this rig, the single most expensive
    /// thing in the frame — 24 of them cost 15.5 ms of a 42.8 ms frame, 0.65 ms
    /// each, and it is per-pixel shading rather than cluster assignment (range
    /// makes almost no difference).
    ///
    /// Off by default at every tier below `high`, and the reason is
    /// correctness before cost. Bevy holds rect lights in a fixed array of
    /// EIGHT, unclustered, evaluated for every lit fragment; past eight they
    /// are silently dropped. This rig has 24 Neros, so sixteen of them were
    /// emitting nothing while bevy warned about it into a log nobody read.
    /// Even switched on they are budgeted to eight, with wide spots for the
    /// rest — consistency across identical fixtures beats a better edge on a
    /// third of them.
    pub panel_area_lights: bool,

    /// Divisor on the beam pass's resolution: 1, 2 or 4.
    ///
    /// The shafts are fill-bound — measured 11.7 ms of a 46.7 ms frame — and
    /// they are the ideal thing to under-sample, being smooth everywhere except
    /// at the silhouette of what they land on, which comes from the depth clamp
    /// rather than from the geometry.
    ///
    /// Mutually exclusive with MSAA, and the code enforces it: the beam
    /// pipeline is specialised for the view's sample count, and the half-res
    /// attachment is single-sampled, so the two disagree. MSAA wins if both are
    /// asked for, because a tier that asked for MSAA wanted edges.
    pub beam_scale: u32,

    /// Draw the emissive blob at each emitter. Diagnostic knob: there is one
    /// mesh AND one material asset per head, so this measures the cost of that
    /// rather than of the geometry.
    pub glows: bool,

    /// Draw beam shafts at all.
    ///
    /// A tier in its own right — the shafts are the most expensive thing in the
    /// frame and a laptop sharing itself with a live show may reasonably want
    /// the pools and none of the air. Also the only honest way to measure what
    /// they cost, since the shader early-outs on intensity rather than on
    /// coverage.
    pub beams: bool,

    /// Eye adaptation: meter the frame and move the exposure with it.
    ///
    /// The web previz already does this and for the same reason — additive
    /// shafts stack without bound, so a cue with 105 lit fixtures and one with
    /// 48 cannot share a fixed exposure. Bevy ships a GPU histogram, which is
    /// strictly better than the web twin's analytic estimate: it meters what is
    /// actually on screen rather than the light leaving the rig, so it knows
    /// how CONCENTRATED a look is — the one thing the web version admits it
    /// cannot see.
    pub auto_exposure: bool,
    /// How much of a brightness change the adaptation cancels, 0..1.
    ///
    /// Partial on purpose, exactly as in the web view: at 1 the previz would be
    /// useless for judging light, because pushing the master would change
    /// nothing on screen.
    pub adapt_strength: f32,

    /// Floor under the stage haze value, for visualisation only.
    ///
    /// A beam is only visible because something in the air scatters it, so a
    /// show with no haze programmed correctly renders almost no shafts — which
    /// is honest and useless. The demo show runs haze 0.00, and that alone is
    /// most of why this window has looked flat: 105 lit fixtures and nothing in
    /// the air to catch them.
    ///
    /// The web previz solved this years ago with its "beam viz" fader, which is
    /// a *preference* rather than the rig's haze value. This is the same idea:
    /// the stage haze still drives the medium whenever it is higher, and
    /// setting this to 0 gives the physically honest picture back.
    pub haze_floor: f32,
}

impl Default for Quality {
    fn default() -> Self {
        Self::standard()
    }
}

impl Quality {
    /// Anything that still has to hold 60 fps on a laptop sharing itself with a
    /// live show. No shafts and a coarse fog march: you keep the pools, the
    /// colour and where the light lands, and lose the air.
    pub fn low() -> Self {
        Quality { smaa: true, msaa: 1, fog_steps: 16, haze_oversize: 1.6, shadows: 2, ev100: 3.0, lumen_scale: 1.0, ambient: 2.0, beam_gain: 1.0, truss: true, light_range_cap: 60.0, panel_area_lights: false, beams: false, glows: true, beam_scale: 2, haze_floor: 0.35, auto_exposure: true, adapt_strength: 0.6 }
    }

    /// The default: the measured budget, spent where it shows most.
    pub fn standard() -> Self {
        Quality { smaa: true, msaa: 1, fog_steps: 32, haze_oversize: 1.6, shadows: 10, ev100: 3.0, lumen_scale: 1.0, ambient: 2.0, beam_gain: 1.0, truss: true, light_range_cap: 60.0, panel_area_lights: true, beams: true, glows: true, beam_scale: 2, haze_floor: 0.35, auto_exposure: true, adapt_strength: 0.6 }
    }

    /// For a second machine, or a still.
    pub fn high() -> Self {
        Quality { smaa: true, msaa: 4, fog_steps: 128, haze_oversize: 1.8, shadows: 16, ev100: 3.0, lumen_scale: 1.0, ambient: 2.0, beam_gain: 1.0, truss: true, light_range_cap: 60.0, panel_area_lights: true, beams: true, glows: true, beam_scale: 1, haze_floor: 0.35, auto_exposure: true, adapt_strength: 0.6 }
    }

    pub fn from_env() -> Self {
        let mut q = match std::env::var("LIGHT_PREVIZ_QUALITY").as_deref() {
            Ok("low") => Self::low(),
            Ok("high") => Self::high(),
            _ => Self::standard(),
        };
        if let Ok(v) = std::env::var("LIGHT_PREVIZ_SMAA") {
            q.smaa = v != "0" && !v.eq_ignore_ascii_case("off");
        }
        if let Some(v) = env_u32("LIGHT_PREVIZ_MSAA") {
            q.msaa = match v {
                2 => 2,
                4 => 4,
                8 => 8,
                _ => 1,
            };
        }
        if let Some(v) = env_u32("LIGHT_PREVIZ_FOGSTEPS") {
            q.fog_steps = v.clamp(8, 512);
        }
        if let Some(v) = env_f32("LIGHT_PREVIZ_HAZE_OVERSIZE") {
            q.haze_oversize = v.clamp(1.0, 4.0);
        }
        // Kept under its old name: it shipped as LIGHT_PREVIZ_SHADOWS and is
        // referenced from the benchmarks note.
        if let Some(v) = env_u32("LIGHT_PREVIZ_SHADOWS") {
            q.shadows = v as usize;
        }
        if let Some(v) = env_f32("LIGHT_PREVIZ_EV100") {
            q.ev100 = v.clamp(-4.0, 16.0);
        }
        if let Some(v) = env_f32("LIGHT_PREVIZ_LUMENS") {
            q.lumen_scale = v.clamp(0.01, 100.0);
        }
        if let Some(v) = env_f32("LIGHT_PREVIZ_AMBIENT") {
            q.ambient = v.clamp(0.0, 500.0);
        }
        if let Ok(v) = std::env::var("LIGHT_PREVIZ_TRUSS") {
            q.truss = v != "0" && !v.eq_ignore_ascii_case("off");
        }
        if let Some(v) = env_f32("LIGHT_PREVIZ_BEAMGAIN") {
            q.beam_gain = v.clamp(0.0, 20.0);
        }
        if let Some(v) = env_f32("LIGHT_PREVIZ_HAZE") {
            q.haze_floor = v.clamp(0.0, 1.0);
        }
        if let Some(v) = env_f32("LIGHT_PREVIZ_RANGE") {
            q.light_range_cap = v.clamp(2.0, 200.0);
        }
        if let Ok(v) = std::env::var("LIGHT_PREVIZ_PANELS") {
            q.panel_area_lights = v != "0" && !v.eq_ignore_ascii_case("off");
        }
        if let Some(v) = env_u32("LIGHT_PREVIZ_BEAMSCALE") {
            q.beam_scale = match v { 4 => 4, 2 => 2, _ => 1 };
        }
        if let Ok(v) = std::env::var("LIGHT_PREVIZ_GLOWS") {
            q.glows = v != "0" && !v.eq_ignore_ascii_case("off");
        }
        if let Ok(v) = std::env::var("LIGHT_PREVIZ_BEAMS") {
            q.beams = v != "0" && !v.eq_ignore_ascii_case("off");
        }
        if let Ok(v) = std::env::var("LIGHT_PREVIZ_AUTOEXP") {
            q.auto_exposure = v != "0" && !v.eq_ignore_ascii_case("off");
        }
        if let Some(v) = env_f32("LIGHT_PREVIZ_ADAPT") {
            q.adapt_strength = v.clamp(0.0, 1.0);
        }
        // MSAA and a single-sampled half-res attachment cannot coexist.
        if q.msaa > 1 && q.beam_scale > 1 {
            eprintln!("[previz] MSAA x{} wins over half-res beams; beam scale forced to 1", q.msaa);
            q.beam_scale = 1;
        }
        eprintln!(
            "[previz] quality: msaa x{} · fog {} steps · haze x{:.2} · {} shadow lights · beam scale 1/{} · smaa {}",
            q.msaa, q.fog_steps, q.haze_oversize, q.shadows, q.beam_scale,
            if q.smaa { "on" } else { "off" }
        );
        eprintln!(
            "[previz] photometrics: EV100 {:.1} · lumens x{:.2} · ambient {:.0} · beam gain x{:.2} · haze floor {:.2} · auto exp {} (strength {:.2})",
            q.ev100, q.lumen_scale, q.ambient, q.beam_gain, q.haze_floor,
            if q.auto_exposure { "on" } else { "off" },
            q.adapt_strength
        );
        q
    }

    pub fn msaa_component(&self) -> Msaa {
        match self.msaa {
            2 => Msaa::Sample2,
            4 => Msaa::Sample4,
            8 => Msaa::Sample8,
            _ => Msaa::Off,
        }
    }
}

fn env_u32(k: &str) -> Option<u32> {
    std::env::var(k).ok().and_then(|v| v.parse().ok())
}

fn env_f32(k: &str) -> Option<f32> {
    std::env::var(k).ok().and_then(|v| v.parse().ok())
}
