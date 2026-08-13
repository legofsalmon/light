//! LIGHT native previz — a Bevy window that is just another client of the
//! engine's WebSocket protocol. It observes, never controls: volumetric
//! beams, haze-coupled fog, bloom, and a glossy stage floor.

mod camera;
mod protocol;
mod scene;
mod state;
mod update;

use bevy::prelude::*;
use std::sync::Mutex;

fn main() {
    let rx = protocol::spawn_ws_client();

    App::new()
        .insert_resource(ClearColor(Color::srgb(0.016, 0.016, 0.022)))
        .insert_resource(AmbientLight {
            color: Color::srgb(0.65, 0.7, 0.9),
            brightness: 35.0,
            ..default()
        })
        .insert_resource(protocol::WsReceiver(Mutex::new(rx)))
        .insert_resource(state::Live::default())
        .insert_resource(camera::Orbit::default())
        .add_plugins(DefaultPlugins.set(WindowPlugin {
            primary_window: Some(Window {
                title: "LIGHT · Previz".into(),
                resolution: (1380.0f32, 860.0f32).into(),
                ..default()
            }),
            ..default()
        }))
        .add_systems(Startup, (scene::setup_stage, camera::setup_camera))
        .add_systems(
            Update,
            (
                update::drain_ws,
                scene::rebuild_fixtures,
                update::apply_live,
                camera::orbit_camera,
            )
                .chain(),
        )
        .run();
}
