//! LIGHT native previz — a Bevy window that is just another client of the
//! engine's WebSocket protocol. It observes, never controls: volumetric
//! beams, haze-coupled fog, bloom, and a glossy stage floor.

mod beam;
mod camera;
mod protocol;
mod quality;
mod scene;
mod state;
mod update;

use bevy::prelude::*;
use bevy::window::WindowResolution;
use std::sync::Mutex;

fn main() {
    let rx = protocol::spawn_ws_client();

    let mut app = App::new();
    // LIGHT_PREVIZ_DIAG=1 logs frame-time diagnostics once per second.
    if std::env::var("LIGHT_PREVIZ_DIAG").is_ok() {
        app.add_plugins((
            bevy::diagnostic::FrameTimeDiagnosticsPlugin::default(),
            bevy::diagnostic::LogDiagnosticsPlugin::default(),
        ));
    }
    let quality = quality::Quality::from_env();
    app
        .insert_resource(ClearColor(Color::srgb(0.016, 0.016, 0.022)))
        // 0.19: AmbientLight became a per-camera Component; the scene-wide
        // default it used to be is GlobalAmbientLight.
        .insert_resource(GlobalAmbientLight {
            color: Color::srgb(0.65, 0.7, 0.9),
            brightness: quality.ambient,
            ..default()
        })
        .insert_resource(protocol::WsReceiver(Mutex::new(rx)))
        .insert_resource(quality)
        .insert_resource(state::Live::default())
        .insert_resource(camera::Orbit::default())
        .add_plugins(DefaultPlugins.set(WindowPlugin {
            primary_window: Some(Window {
                title: "LIGHT · Previz".into(),
                resolution: WindowResolution::new(1380, 860),
                ..default()
            }),
            ..default()
        }))
        .add_plugins(bevy::post_process::auto_exposure::AutoExposurePlugin)
        .add_plugins(beam::BeamMaterialPlugin)
        // A rig is not a game level. Bevy sizes its GPU light-clustering lists
        // for a handful of lights; an arena plot is 153 spot lights, and on the
        // first frame that they all land in view Bevy logs "the scene lighting
        // may have been corrupted for a few frames" and resizes — twice, on
        // this rig, every run. Start big enough that it never has to.
        .add_systems(Startup, (widen_light_clusters, scene::setup_stage, camera::setup_camera))
        .add_systems(
            Update,
            (
                update::drain_ws,
                scene::rebuild_fixtures,
                update::apply_live,
                update::apply_panel_lights,
                update::reflect_connection,
                update::diag_state,
                update::auto_screenshot,
                update::key_screenshot,
                scene::toggle_band,
                camera::orbit_camera,
            )
                .chain(),
        )
        .run();
}

/// See the note at the call site: pre-size the light-clustering lists for a
/// rig rather than for a game level.
fn widen_light_clusters(settings: Option<ResMut<bevy::light::cluster::GlobalClusterSettings>>) {
    let Some(mut settings) = settings else { return };
    if let Some(gpu) = settings.gpu_clustering.as_mut() {
        gpu.initial_z_slice_list_capacity = gpu.initial_z_slice_list_capacity.max(8192);
        gpu.initial_index_list_capacity = gpu.initial_index_list_capacity.max(524_288);
    }
}
