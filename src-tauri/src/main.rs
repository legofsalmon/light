#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::Manager;

use std::sync::{Arc, Mutex};

/// Is this port ours to take?
fn port_free(port: u16) -> bool {
    std::net::TcpListener::bind(("0.0.0.0", port)).is_ok()
}

/// Ask the user, in a window they cannot miss. Returns the button they chose.
/// osascript rather than a dialog crate: this build is macOS-only, the app is
/// already shelling out nowhere else, and a plugin here would mean a new
/// dependency plus capability config for one dialog.
#[cfg(target_os = "macos")]
fn ask(message: &str, buttons: &[&str], default: &str) -> Option<String> {
    let list = buttons
        .iter()
        .map(|b| format!("\"{}\"", b.replace('"', "")))
        .collect::<Vec<_>>()
        .join(", ");
    let script = format!(
        r#"display dialog "{}" with title "LIGHT" buttons {{{}}} default button "{}" with icon caution"#,
        message.replace('\\', "\\\\").replace('"', "\\\""),
        list,
        default,
    );
    let out = std::process::Command::new("osascript")
        .args(["-e", &script])
        .output()
        .ok()?;
    // "button returned:Use port 9901"
    String::from_utf8_lossy(&out.stdout)
        .split("button returned:")
        .nth(1)
        .map(|s| s.trim().to_string())
}

#[cfg(not(target_os = "macos"))]
fn ask(_message: &str, _buttons: &[&str], _default: &str) -> Option<String> {
    None
}

/// The port to run on, or None if the user would rather quit.
///
/// The overwhelmingly common cause of a clash is a second copy of LIGHT — a
/// dev engine left running, or the app already open. Moving ports silently
/// would be worse than the crash: Resolume's OSC and any tablet pointed at
/// :9900 would be talking to nothing, and that gets discovered at soundcheck.
/// So: say what happened, and let the operator choose.
fn resolve_port(wanted: u16) -> Option<u16> {
    if port_free(wanted) {
        return Some(wanted);
    }
    let alt = (wanted + 1..wanted + 20).find(|p| port_free(*p));
    let Some(alt) = alt else {
        ask(
            &format!("Port {wanted} is in use, and so is every port up to {}.\n\nQuit whatever is using them and open LIGHT again.", wanted + 19),
            &["Quit"],
            "Quit",
        );
        return None;
    };
    let msg = format!(
        "LIGHT cannot use port {wanted}.\n\n\
         Another copy of LIGHT is probably already running — check the Dock. \
         It could also be another app holding the port.\n\n\
         LIGHT can run on port {alt} instead. The window will work normally, \
         but anything pointed at port {wanted} — Resolume OSC, or a tablet on \
         the network — needs pointing at {alt} too."
    );
    let use_alt = format!("Use port {alt}");
    match ask(&msg, &["Quit", &use_alt], &use_alt) {
        Some(choice) if choice == use_alt => Some(alt),
        _ => None,
    }
}

fn main() {
    // the engine's message sender, once the engine thread is live — used to
    // ask for a clean shutdown so ⌘Q cannot drop the last edits
    let engine_tx: Arc<Mutex<Option<std::sync::mpsc::Sender<light_core::engine::EngineMsg>>>> =
        Arc::new(Mutex::new(None));
    let tx_for_setup = Arc::clone(&engine_tx);
    let tx_for_exit = Arc::clone(&engine_tx);

    let app = tauri::Builder::default()
        .setup(move |app| {
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

            // Settle the port BEFORE the engine starts. Discovering the clash
            // inside run() means the engine returns, the process exits, and
            // from the Dock all anyone sees is one bounce — the message goes to
            // stderr, which nobody launching from Finder ever reads.
            let wanted: u16 = std::env::var("LIGHT_PORT")
                .ok()
                .and_then(|p| p.parse().ok())
                .unwrap_or(9900);
            let port = match resolve_port(wanted) {
                Some(p) => p,
                None => std::process::exit(1), // the user chose to quit
            };
            if port != wanted {
                eprintln!("[light] :{wanted} was taken — running on :{port}");
            }

            // The bundled UI has 9900 compiled in as its fallback, so on any
            // other port the window would dial a socket nobody is listening on
            // and sit there saying the engine is not responding.
            //
            // Injecting the port with eval() was the first attempt and was
            // wrong twice over: it only ran when the port had been *taken*, so
            // LIGHT_PORT never triggered it, and a variable set during setup is
            // discarded when the page loads its own context.
            //
            // 9900 is the UI's compiled-in fallback (shared/types.ts WS_PORT).
            //
            // Loading the window from the engine's own HTTP server instead puts
            // the port in the page origin, where wsUrl() already reads it — the
            // exact path a tablet on the LAN uses, so it is the better-tested
            // one. Only when the engine can actually serve: with no bundled UI
            // the tauri:// asset is all there is.
            let serve_url = if port != 9900 && ui_dist.is_some() {
                Some(format!("http://127.0.0.1:{port}/"))
            } else {
                None
            };

            // The engine core runs on its own thread; the window is just a
            // view speaking the same WebSocket protocol as any LAN browser.
            // Either a panic OR run() returning early is fatal: a window that
            // looks alive over a dead engine is the worst failure mode at a show.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                // AssertUnwindSafe: the handle is only used to point the window
                // at a URL. Nothing here observes state that a panic could
                // leave torn — and the panic is fatal anyway, three lines down.
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    light_core::engine::run(light_core::engine::EngineConfig {
                        port,
                        ui_dist,
                        // honor the same kill-switch as the standalone binary —
                        // test harnesses must keep the app off the controller
                        with_midi: std::env::var("LIGHT_NO_MIDI").is_err(),
                        on_ready: Some(Box::new(move |tx| {
                            if let Ok(mut slot) = tx_for_setup.lock() {
                                *slot = Some(tx);
                            }
                            // now the server is up, point the window at it
                            if let Some(url) = serve_url.clone() {
                                if let Some(w) = handle.get_webview_window("main") {
                                    if let Ok(parsed) = url.parse() {
                                        let _ = w.navigate(parsed);
                                    }
                                }
                            }
                        })),
                    });
                }));
                match result {
                    Err(_) => eprintln!("[light] engine thread crashed — exiting so the failure is visible"),
                    Ok(()) => eprintln!("[light] engine stopped (port already in use?) — exiting"),
                }
                std::process::exit(1);
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building LIGHT");

    app.run(move |_handle, event| {
        if let tauri::RunEvent::ExitRequested { .. } = event {
            // flush synchronously-ish: ask the engine to persist and give it a
            // moment. Losing the last edits on quit is worse than a short wait.
            if let Ok(slot) = tx_for_exit.lock() {
                if let Some(tx) = slot.as_ref() {
                    let _ = tx.send(light_core::engine::EngineMsg::Shutdown);
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(400));
        }
    });
}
