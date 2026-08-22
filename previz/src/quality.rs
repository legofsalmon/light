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
    /// live show.
    pub fn low() -> Self {
        Quality { msaa: 1, fog_steps: 48, haze_oversize: 1.6, shadows: 4, ev100: 3.0, lumen_scale: 1.0, ambient: 2.0, beam_gain: 1.0, haze_floor: 0.35 }
    }

    /// The default: the measured budget, spent where it shows most.
    pub fn standard() -> Self {
        Quality { msaa: 1, fog_steps: 64, haze_oversize: 1.6, shadows: 10, ev100: 3.0, lumen_scale: 1.0, ambient: 2.0, beam_gain: 1.0, haze_floor: 0.35 }
    }

    /// For a second machine, or a still.
    pub fn high() -> Self {
        Quality { msaa: 4, fog_steps: 128, haze_oversize: 1.8, shadows: 16, ev100: 3.0, lumen_scale: 1.0, ambient: 2.0, beam_gain: 1.0, haze_floor: 0.35 }
    }

    pub fn from_env() -> Self {
        let mut q = match std::env::var("LIGHT_PREVIZ_QUALITY").as_deref() {
            Ok("low") => Self::low(),
            Ok("high") => Self::high(),
            _ => Self::standard(),
        };
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
        if let Some(v) = env_f32("LIGHT_PREVIZ_BEAMGAIN") {
            q.beam_gain = v.clamp(0.0, 20.0);
        }
        if let Some(v) = env_f32("LIGHT_PREVIZ_HAZE") {
            q.haze_floor = v.clamp(0.0, 1.0);
        }
        eprintln!(
            "[previz] quality: msaa x{} · fog {} steps · haze x{:.2} · {} shadow lights",
            q.msaa, q.fog_steps, q.haze_oversize, q.shadows
        );
        eprintln!(
            "[previz] photometrics: EV100 {:.1} · lumens x{:.2} · ambient {:.0} · beam gain x{:.2} · haze floor {:.2}",
            q.ev100, q.lumen_scale, q.ambient, q.beam_gain, q.haze_floor
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
