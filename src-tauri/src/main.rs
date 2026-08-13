#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // The Rust engine core runs on its own thread; the window is just a view
    // speaking the same WebSocket protocol as any LAN browser.
    std::thread::spawn(|| {
        light_core::engine::run(light_core::engine::EngineConfig {
            port: std::env::var("LIGHT_PORT")
                .ok()
                .and_then(|p| p.parse().ok())
                .unwrap_or(9900),
            ui_dist: None,
            with_midi: true,
        });
    });

    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running LIGHT");
}
