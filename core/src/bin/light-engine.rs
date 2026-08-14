use std::path::PathBuf;

use light_core::engine::{run, EngineConfig};

fn main() {
    let port = std::env::var("LIGHT_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(9900);
    let dist = PathBuf::from("ui/dist");
    run(EngineConfig {
        port,
        ui_dist: if dist.exists() { Some(dist) } else { None },
        with_midi: std::env::var("LIGHT_NO_MIDI").is_err(),
        on_ready: None,
    });
}
