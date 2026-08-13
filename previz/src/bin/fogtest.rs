//! Minimal volumetric-fog reproduction: does Bevy 0.16.1 render ANY
//! volumetric scattering on this machine? Mirrors bevy's fog_volumes example
//! with our exact camera stack. Saves a screenshot to $LIGHT_PREVIZ_SHOT.

use bevy::core_pipeline::bloom::Bloom;
use bevy::core_pipeline::tonemapping::Tonemapping;
use bevy::pbr::{FogVolume, VolumetricFog, VolumetricLight};
use bevy::prelude::*;

fn main() {
    App::new()
        .insert_resource(ClearColor(Color::srgb(0.02, 0.02, 0.03)))
        .add_plugins(DefaultPlugins)
        .add_systems(Startup, setup)
        .add_systems(Update, shot)
        .run();
}

fn setup(
    mut commands: Commands,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
) {
    // floor
    commands.spawn((
        Mesh3d(meshes.add(Plane3d::default().mesh().size(12.0, 12.0))),
        MeshMaterial3d(materials.add(StandardMaterial {
            base_color: Color::srgb(0.1, 0.1, 0.12),
            ..default()
        })),
        Transform::default(),
    ));

    // fog volume, big and dense
    commands.spawn((
        FogVolume {
            density_factor: 0.5,
            scattering: 1.0,
            scattering_asymmetry: 0.3,
            ..default()
        },
        Transform::from_xyz(0.0, 2.0, 0.0).with_scale(Vec3::splat(8.0)),
    ));

    // directional light through the fog — the canonical bevy example setup
    commands.spawn((
        DirectionalLight {
            illuminance: 32_000.0,
            shadows_enabled: true,
            ..default()
        },
        VolumetricLight,
        Transform::from_xyz(2.0, 4.0, 2.0).looking_at(Vec3::ZERO, Vec3::Y),
    ));

    // spotlight down through the fog
    commands.spawn((
        SpotLight {
            intensity: 8_000_000.0,
            range: 12.0,
            color: Color::srgb(0.3, 0.9, 1.0),
            inner_angle: 0.2,
            outer_angle: 0.35,
            shadows_enabled: true,
            ..default()
        },
        VolumetricLight,
        Transform::from_xyz(-1.5, 3.5, 0.0).looking_to(Vec3::new(0.3, -0.9, 0.1), Vec3::Y),
    ));

    // camera — exact same component stack as the previz camera
    // canonical example stack: NO DepthPrepass, NO Msaa::Off
    commands.spawn((
        Camera3d::default(),
        Camera { hdr: true, ..default() },
        Tonemapping::TonyMcMapface,
        Bloom::default(),
        VolumetricFog { ambient_intensity: 0.1, ..default() },
        Transform::from_xyz(0.0, 2.5, 8.0).looking_at(Vec3::new(0.0, 1.5, 0.0), Vec3::Y),
    ));
}

fn shot(mut commands: Commands, time: Res<Time>, mut done: Local<bool>) {
    if *done {
        return;
    }
    let Ok(path) = std::env::var("LIGHT_PREVIZ_SHOT") else {
        *done = true;
        return;
    };
    if time.elapsed_secs() < 4.0 {
        return;
    }
    *done = true;
    commands
        .spawn(bevy::render::view::screenshot::Screenshot::primary_window())
        .observe(bevy::render::view::screenshot::save_to_disk(path));
}
