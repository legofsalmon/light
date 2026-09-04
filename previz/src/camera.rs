use bevy::math::cubic_splines::LinearSpline;
use bevy::post_process::auto_exposure::{AutoExposure, AutoExposureCompensationCurve};
use bevy::post_process::bloom::Bloom;
use bevy::core_pipeline::prepass::DepthPrepass;
use bevy::core_pipeline::tonemapping::Tonemapping;
use bevy::input::mouse::{MouseMotion, MouseWheel};
use bevy::anti_alias::smaa::{Smaa, SmaaPreset};
use bevy::camera::{Exposure, Hdr};
use bevy::light::VolumetricFog;
use bevy::prelude::*;

#[derive(Resource)]
pub struct Orbit {
    pub yaw: f32,
    pub pitch: f32,
    pub dist: f32,
    pub target: Vec3,
    /// True once the operator has driven the camera, or LIGHT_PREVIZ_CAM has
    /// placed it. Until then the view is ours to frame; after, it is theirs and
    /// nothing may move it.
    pub claimed: bool,
    /// Latches once the view has been framed to a rig, so a scene rebuild — a
    /// patch edit, a re-import — never resets a view the operator is working
    /// in. Lives here rather than on `Live` so this system can keep taking the
    /// project read-only.
    pub framed: bool,
}

/// The FOH shot for a rig of this size, sitting in this place.
///
/// One definition, used by the `1` preset and by the automatic first framing,
/// because they should obviously agree and when they were written separately
/// they did not.
pub fn foh_for(e: Option<crate::state::RigExtent>) -> Orbit {
    let (dist, eye_h, center) = match e {
        Some(e) => (e.diag * 0.8, ((e.height + 3.0).max(5.0) * 0.25).clamp(1.5, 4.0), e.center),
        None => (8.5, 1.5, Vec3::ZERO),
    };
    Orbit {
        yaw: 0.0,
        pitch: 0.32,
        dist,
        target: Vec3::new(center.x, eye_h, center.z),
        claimed: false,
        framed: true,
    }
}

impl Default for Orbit {
    fn default() -> Self {
        // FOH view
        let d = Orbit { yaw: 0.0, pitch: 0.32, dist: 8.5, target: Vec3::new(0.0, 1.5, 0.0), claimed: false, framed: false };
        // LIGHT_PREVIZ_CAM=yaw,pitch,dist[,tx,ty,tz] — the starting viewpoint.
        //
        // Purely a development affordance, and it earns its keep: judging how
        // this renderer LOOKS means a picture, pictures come from
        // LIGHT_PREVIZ_SHOT, and until now every one of them was taken from the
        // same default FOH position. Half the shots framed empty air because the
        // rig they were meant to show hangs above it, and there was no way to
        // aim the camera without a hand on the mouse.
        let Ok(v) = std::env::var("LIGHT_PREVIZ_CAM") else { return d };
        let n: Vec<f32> = v.split(',').filter_map(|x| x.trim().parse().ok()).collect();
        if n.len() < 3 {
            eprintln!("[previz] LIGHT_PREVIZ_CAM wants yaw,pitch,dist[,tx,ty,tz]; ignoring {v:?}");
            return d;
        }
        Orbit {
            yaw: n[0],
            pitch: n[1],
            dist: n[2],
            target: if n.len() >= 6 { Vec3::new(n[3], n[4], n[5]) } else { d.target },
            // An explicitly placed camera is a claimed camera: auto-framing
            // would otherwise yank a deliberately composed shot back to FOH the
            // moment the first project arrived, which made the knob useless for
            // the screenshots it exists for.
            claimed: true,
            framed: true,
        }
    }
}

pub fn setup_camera(
    mut commands: Commands,
    q: Res<crate::quality::Quality>,
    mut curves: ResMut<Assets<AutoExposureCompensationCurve>>,
) {
    // Eye adaptation, expressed as a compensation curve.
    //
    // Bevy's auto exposure on its own is FULL adaptation: it meters the frame
    // and drives the exposure until the average lands on a fixed target, so a
    // cue with twice the light on stage looks exactly as bright as one with
    // half. That is correct for a game and useless for a lighting tool — you
    // would push the master and watch nothing happen.
    //
    // The compensation curve is how you buy some of it back. It adds F-stops as
    // a function of the metered EV, so a line of slope k lets a scene k stops
    // brighter actually read k stops brighter: k = 1 - strength. At the default
    // 0.6, doubling the light on stage still reads about a third brighter, and
    // the frame never blows out. Same bargain the web previz struck, reached
    // from the opposite direction.
    let k = 1.0 - q.adapt_strength.clamp(0.0, 1.0);
    let lo = -4.0f32;
    let hi = 10.0f32;
    let mid = 2.0f32;
    let curve = curves.add(
        AutoExposureCompensationCurve::from_curve(LinearSpline::new([
            Vec2::new(lo, (lo - mid) * k),
            Vec2::new(mid, 0.0),
            Vec2::new(hi, (hi - mid) * k),
        ]))
        .expect("compensation curve is a monotonic line"),
    );

    commands.spawn((
        Camera3d::default(),
        Camera::default(),
        Hdr,
        // A previz is mostly thin bright geometry — truss chords, fixture
        // bodies, the rim of every beam — against near-black, with bloom on
        // top. With no anti-aliasing at all those edges crawl and sparkle the
        // moment the camera moves, which reads as the render being cheap. MSAA
        // is the one that works here: bevy's volumetric fog carries a
        // MULTISAMPLED bind-group path (volumetric_fog/render.rs:415), and TAA
        // is the wrong trade for this subject — the thing on screen is fast
        // moving beams, which is exactly what a temporal resolve smears.
        q.msaa_component(),
        DepthPrepass,
        // Bevy's default is EV100 9.7 — Blender-calibrated, roughly an
        // overcast afternoon. This is a blacked-out room with lamps in it.
        Exposure { ev100: q.ev100 },
        Tonemapping::TonyMcMapface,
        Bloom::default(),
        VolumetricFog {
            // Ambient scattering inside the medium. This is the knob that
            // decides whether the room reads as a blacked-out venue or as fog
            // under a streetlight: it lights the haze everywhere at once, so
            // any of it that is not needed is pure veiling glare over the
            // whole frame, and a stage's blacks have to be black.
            ambient_intensity: 0.015,
            // 64 steps across a room-sized volume is ~15 cm per sample, and the
            // banding that produces swims as the camera moves. The cost is
            // per-pixel-per-step and this scene is not fill-bound, so buy the
            // steps.
            step_count: q.fog_steps,
            ..default()
        },
        Transform::from_xyz(0.0, 4.0, 9.0).looking_at(Vec3::new(0.0, 1.5, 0.0), Vec3::Y),
    ))
    .insert_if(
        // Short rays: this exists to darken the few centimetres a shadow map's
        // depth bias erases where an object meets the deck, not to replace the
        // shadow map. A long ray here would double-shade what the map already
        // has and cost far more.
        bevy::pbr::ContactShadows { linear_steps: 8, thickness: 0.12, length: 0.35 },
        || q.contact_shadows,
    )
    .insert_if(Smaa { preset: SmaaPreset::High }, || q.smaa)
    .insert_if(
        AutoExposure {
            // A stage runs from near-black to a wall of light; the default
            // -8..8 window wastes most of its bins on luminances this scene
            // never produces.
            range: -4.0..=10.0,
            // Ignore the darkest and brightest tails harder than the default.
            // The darkest is a genuinely black room and the brightest is a
            // handful of lens flares, and letting either steer the exposure is
            // what makes an auto-exposed previz breathe on every strobe hit.
            filter: 0.20..=0.85,
            // Stopping down fast and opening up slowly is what an eye does and
            // what stops a strobe pumping the whole picture.
            speed_brighten: 2.5,
            speed_darken: 0.8,
            exponential_transition_distance: 1.5,
            compensation_curve: curve,
            ..default()
        },
        || q.auto_exposure,
    );
}

pub fn orbit_camera(
    mut orbit: ResMut<Orbit>,
    buttons: Res<ButtonInput<MouseButton>>,
    keys: Res<ButtonInput<KeyCode>>,
    mut motion: MessageReader<MouseMotion>,
    mut wheel: MessageReader<MouseWheel>,
    mut camera: Query<&mut Transform, With<Camera3d>>,
    live: Res<crate::state::Live>,
) {
    // Frame the rig that is actually loaded. The fixed limits below were sized
    // for the 16 x 12 m demo stage: on a 37 m arena plot hung at 10 m, max
    // zoom-out left the stage edges outside the frustum and the orbit target
    // could not be raised to the truss to inspect the hangs — the wide shot
    // this window exists for was physically unreachable. Never tighter than the
    // demo limits, so a small rig behaves exactly as before.
    let (max_dist, max_target_y, near_dist) = match live.rig_extent {
        Some(e) => ((e.diag * 2.0).max(22.0), (e.height + 3.0).max(5.0), e.diag * 0.8),
        None => (22.0, 5.0, 8.5),
    };

    // Frame the rig the first time we learn how big it is.
    //
    // The presets already scaled with the plot, but the view the window OPENS
    // on did not: a fixed 8.5 m at eye height, which on the arena plot is a
    // close-up of the band's knees with all hundred and twenty-nine fixtures
    // and every beam out of frame above. The rig is 37 m across and hangs at
    // 10 m. You had to know to press 1.
    //
    // Once the operator has touched anything the camera is theirs and this
    // never fires again — including on a rebuild, so editing the patch does not
    // throw away the shot you were lining up.
    if !orbit.claimed && !orbit.framed && live.rig_extent.is_some() {
        *orbit = foh_for(live.rig_extent);
    }

    let mut delta = Vec2::ZERO;
    for ev in motion.read() {
        delta += ev.delta;
    }
    if !delta.is_finite() {
        delta = Vec2::ZERO;
    }
    if buttons.pressed(MouseButton::Left) && delta != Vec2::ZERO {
        orbit.claimed = true;
        orbit.yaw -= delta.x * 0.005;
        orbit.pitch = (orbit.pitch + delta.y * 0.005).clamp(-0.1, 1.45);
    } else if (buttons.pressed(MouseButton::Right) || buttons.pressed(MouseButton::Middle))
        && delta != Vec2::ZERO
    {
        orbit.claimed = true;
        let yaw_rot = Quat::from_rotation_y(orbit.yaw);
        let right = yaw_rot * Vec3::X;
        let pan = (right * -delta.x + Vec3::Y * delta.y) * 0.004 * orbit.dist.max(1.0) * 0.35;
        orbit.target += pan;
        orbit.target.y = orbit.target.y.clamp(0.0, max_target_y);
    }
    for ev in wheel.read() {
        let step = match ev.unit {
            bevy::input::mouse::MouseScrollUnit::Line => ev.y * 0.6,
            bevy::input::mouse::MouseScrollUnit::Pixel => ev.y * 0.02,
        };
        if step != 0.0 {
            orbit.claimed = true;
        }
        orbit.dist = (orbit.dist - step).clamp(2.0, max_dist);
    }

    // presets
    // Presets scale with the rig: on an arena plot a "FOH" preset framing 8.5 m
    // of a 37 m stage is not the shot anyone wanted.
    let eye_h = (max_target_y * 0.25).clamp(1.5, 4.0);
    if keys.just_pressed(KeyCode::Digit1) {
        *orbit = foh_for(live.rig_extent);
        orbit.claimed = true;
    }
    if keys.just_pressed(KeyCode::Digit2) {
        // side
        *orbit = Orbit {
            yaw: std::f32::consts::FRAC_PI_2,
            pitch: 0.18,
            dist: near_dist * 0.95,
            target: Vec3::new(0.0, eye_h, 0.5),
            claimed: true,
            framed: true,
        };
    }
    if keys.just_pressed(KeyCode::Digit3) {
        // top
        *orbit = Orbit {
            yaw: 0.0,
            pitch: 1.42,
            dist: near_dist * 1.3,
            target: Vec3::new(0.0, 0.0, 0.8),
            claimed: true,
            framed: true,
        };
    }

    if let Ok(mut tf) = camera.single_mut() {
        let rot = Quat::from_rotation_y(orbit.yaw) * Quat::from_rotation_x(-orbit.pitch);
        let pos = orbit.target + rot * Vec3::new(0.0, 0.0, orbit.dist);
        *tf = Transform::from_translation(pos).looking_at(orbit.target, Vec3::Y);
    }
}
