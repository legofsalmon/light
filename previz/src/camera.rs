use bevy::core_pipeline::bloom::Bloom;
use bevy::core_pipeline::prepass::DepthPrepass;
use bevy::core_pipeline::tonemapping::Tonemapping;
use bevy::input::mouse::{MouseMotion, MouseWheel};
use bevy::pbr::VolumetricFog;
use bevy::prelude::*;

#[derive(Resource)]
pub struct Orbit {
    pub yaw: f32,
    pub pitch: f32,
    pub dist: f32,
    pub target: Vec3,
}

impl Default for Orbit {
    fn default() -> Self {
        // FOH view
        Orbit { yaw: 0.0, pitch: 0.32, dist: 8.5, target: Vec3::new(0.0, 1.5, 0.0) }
    }
}

pub fn setup_camera(mut commands: Commands) {
    commands.spawn((
        Camera3d::default(),
        Camera { hdr: true, ..default() },
        Msaa::Off,
        DepthPrepass,
        Tonemapping::TonyMcMapface,
        Bloom::default(),
        VolumetricFog { ambient_intensity: 0.06, ..default() },
        Transform::from_xyz(0.0, 4.0, 9.0).looking_at(Vec3::new(0.0, 1.5, 0.0), Vec3::Y),
    ));
}

pub fn orbit_camera(
    mut orbit: ResMut<Orbit>,
    buttons: Res<ButtonInput<MouseButton>>,
    keys: Res<ButtonInput<KeyCode>>,
    mut motion: EventReader<MouseMotion>,
    mut wheel: EventReader<MouseWheel>,
    mut camera: Query<&mut Transform, With<Camera3d>>,
) {
    let mut delta = Vec2::ZERO;
    for ev in motion.read() {
        delta += ev.delta;
    }
    if buttons.pressed(MouseButton::Left) {
        orbit.yaw -= delta.x * 0.005;
        orbit.pitch = (orbit.pitch + delta.y * 0.005).clamp(-0.1, 1.45);
    } else if buttons.pressed(MouseButton::Right) || buttons.pressed(MouseButton::Middle) {
        let yaw_rot = Quat::from_rotation_y(orbit.yaw);
        let right = yaw_rot * Vec3::X;
        let pan = (right * -delta.x + Vec3::Y * delta.y) * 0.004 * orbit.dist.max(1.0) * 0.35;
        orbit.target += pan;
        orbit.target.y = orbit.target.y.clamp(0.0, 5.0);
    }
    for ev in wheel.read() {
        let step = match ev.unit {
            bevy::input::mouse::MouseScrollUnit::Line => ev.y * 0.6,
            bevy::input::mouse::MouseScrollUnit::Pixel => ev.y * 0.02,
        };
        orbit.dist = (orbit.dist - step).clamp(2.0, 22.0);
    }

    // presets
    if keys.just_pressed(KeyCode::Digit1) {
        *orbit = Orbit::default(); // FOH
    }
    if keys.just_pressed(KeyCode::Digit2) {
        *orbit = Orbit { yaw: std::f32::consts::FRAC_PI_2, pitch: 0.18, dist: 8.0, target: Vec3::new(0.0, 1.6, 0.5) };
    }
    if keys.just_pressed(KeyCode::Digit3) {
        *orbit = Orbit { yaw: 0.0, pitch: 1.42, dist: 11.0, target: Vec3::new(0.0, 0.0, 0.8) };
    }

    if let Ok(mut tf) = camera.single_mut() {
        let rot = Quat::from_rotation_y(orbit.yaw) * Quat::from_rotation_x(-orbit.pitch);
        let pos = orbit.target + rot * Vec3::new(0.0, 0.0, orbit.dist);
        *tf = Transform::from_translation(pos).looking_at(orbit.target, Vec3::Y);
    }
}
