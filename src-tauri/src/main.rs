#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::Manager;

use std::sync::{Arc, Mutex};

/// The last panic's message and backtrace, stashed by the hook below so the
/// thread that catches the unwind can report what actually happened.
static PANIC_DETAIL: Mutex<Option<String>> = Mutex::new(None);

/// Where a death gets recorded.
///
/// A Finder-launched .app has stderr on /dev/null, so `eprintln!` at the moment
/// of failure reaches nobody. That is the whole reason an app which vanished
/// mid-show left nothing behind to debug: the two lines that would have named
/// the cause were written to a stream no one could read.
fn log_file() -> Option<std::path::PathBuf> {
    let dir = std::path::PathBuf::from(std::env::var("HOME").ok()?).join("Library/Logs/LIGHT");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("engine.log"))
}

fn log_line(text: &str) {
    eprintln!("[light] {text}");
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if let Some(p) = log_file() {
        use std::io::Write;
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(p) {
            let _ = writeln!(f, "[{secs}] {text}");
        }
    }
}

/// Capture panics with a backtrace before the unwind discards them. The payload
/// alone carries no backtrace, so it has to be taken here, at the throw site.
fn install_panic_logger() {
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let bt = std::backtrace::Backtrace::force_capture();
        let text = format!("PANIC {info}\nbacktrace:\n{bt}");
        if let Ok(mut slot) = PANIC_DETAIL.lock() {
            *slot = Some(text.clone());
        }
        log_line(&text);
        prev(info);
    }));
}

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
    // saturating: LIGHT_PORT=65530 overflowed u16 here — a debug panic, and in
    // release a scan that claimed "every port up to 65549 is in use".
    let last = wanted.saturating_add(20);
    let alt = (wanted.saturating_add(1)..last).find(|p| port_free(*p));
    let Some(alt) = alt else {
        ask(
            &format!("Port {wanted} is in use, and so is every port up to {}.\n\nQuit whatever is using them and open LIGHT again.", last.saturating_sub(1)),
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
    install_panic_logger();
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
            // A start line, so the log is a timeline rather than only a death
            // notice: whoever reads it after the next unexplained exit can see
            // what this run was doing before it stopped.
            log_line(&format!(
                "starting — port {port}, bundled ui {}",
                if ui_dist.is_some() { "found" } else { "MISSING" }
            ));

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
                    })
                }));
                // The dialogs below block on osascript until a human clicks, and
                // a window alive over a dead engine is the exact failure the exit
                // exists to prevent. Guarantee the exit regardless of the dialog.
                std::thread::spawn(|| {
                    std::thread::sleep(std::time::Duration::from_secs(10));
                    std::process::exit(1);
                });
                match result {
                    // A quit we asked for. Tauri is already tearing the process
                    // down, so exiting here would race its teardown and report a
                    // crash for a clean quit — which is exactly what the old
                    // code did, under a hardcoded "port already in use?" that
                    // was wrong for this path and would send the next person
                    // debugging it looking at the network.
                    Ok(light_core::engine::ExitReason::Shutdown) => {
                        log_line("engine stopped: shutdown requested");
                        return;
                    }
                    Ok(reason) => {
                        log_line(&format!("engine stopped unexpectedly: {reason}"));
                        ask(
                            &format!("LIGHT's engine stopped.\n\n{reason}\n\nThe details are in ~/Library/Logs/LIGHT/engine.log"),
                            &["Quit"],
                            "Quit",
                        );
                    }
                    Err(_) => {
                        let detail = PANIC_DETAIL
                            .lock()
                            .ok()
                            .and_then(|d| d.clone())
                            .unwrap_or_else(|| "no detail captured".to_string());
                        let first = detail.lines().next().unwrap_or("engine panic").to_string();
                        log_line("engine thread panicked — exiting so the failure is visible");
                        ask(
                            &format!("LIGHT's engine crashed and the show has stopped.\n\n{first}\n\nThe full backtrace is in ~/Library/Logs/LIGHT/engine.log"),
                            &["Quit"],
                            "Quit",
                        );
                    }
                }
                std::process::exit(1);
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building LIGHT");

    app.run(move |_handle, event| {
        if let tauri::RunEvent::ExitRequested { .. } = event {
            // Logged because this is the one way run() can end that only exists
            // in the app: Shutdown has exactly one sender, right here. Tauri
            // emits ExitRequested for ⌘Q *and* when the last window is
            // destroyed, so if the app ever dies "on its own" again, this line
            // landing in the log says the window went first.
            log_line("exit requested — asking the engine to flush and stop");
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
