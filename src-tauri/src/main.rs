#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // The Rust engine core runs on its own thread; the window is just a view
    // speaking the same WebSocket protocol as any LAN browser. If the engine
    // thread ever panics, exit visibly — a window that looks alive over a
    // dead engine is the worst failure mode at a show.
    std::thread::spawn(|| {
        let result = std::panic::catch_unwind(|| {
            light_core::engine::run(light_core::engine::EngineConfig {
                port: std::env::var("LIGHT_PORT")
                    .ok()
                    .and_then(|p| p.parse().ok())
                    .unwrap_or(9900),
                ui_dist: None,
                with_midi: true,
            });
        });
        if result.is_err() {
            eprintln!("[light] engine thread crashed — exiting so the failure is visible");
            std::process::exit(1);
        }
    });

    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running LIGHT");
}
