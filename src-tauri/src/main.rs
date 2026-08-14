#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            // The bundled UI is served over HTTP by the engine as well as
            // loaded in the window, so a phone or tablet on the same network
            // can drive the show at http://<mac>:9900.
            let ui_dist = app
                .path()
                .resolve("ui-dist", tauri::path::BaseDirectory::Resource)
                .ok()
                .filter(|p| p.join("index.html").is_file());
            if ui_dist.is_none() {
                eprintln!("[light] bundled UI not found — LAN access disabled for this run");
            }

            // The engine core runs on its own thread; the window is just a
            // view speaking the same WebSocket protocol as any LAN browser.
            // Either a panic OR run() returning early (port already held) is
            // fatal: a window that looks alive over a dead engine is the
            // worst failure mode at a show.
            std::thread::spawn(move || {
                let result = std::panic::catch_unwind(|| {
                    light_core::engine::run(light_core::engine::EngineConfig {
                        port: std::env::var("LIGHT_PORT")
                            .ok()
                            .and_then(|p| p.parse().ok())
                            .unwrap_or(9900),
                        ui_dist,
                        // honor the same kill-switch as the standalone binary —
                        // test harnesses must keep the app off the controller
                        with_midi: std::env::var("LIGHT_NO_MIDI").is_err(),
                    });
                });
                match result {
                    Err(_) => eprintln!("[light] engine thread crashed — exiting so the failure is visible"),
                    Ok(()) => eprintln!("[light] engine stopped (port already in use?) — exiting"),
                }
                std::process::exit(1);
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running LIGHT");
}
