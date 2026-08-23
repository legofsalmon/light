use std::collections::HashSet;
use std::sync::mpsc::Sender;
use std::time::Duration;

use midir::{Ignore, MidiInput, MidiInputConnection};

use crate::engine::EngineMsg;

/// macOS only. CoreMIDI keeps each process's device list in a cache it refreshes
/// from notifications delivered on a CFRunLoop. The engine is a plain binary and
/// never runs one, so that cache is frozen at the moment the process first
/// touches CoreMIDI: every rescan below re-reads the same stale answer, and a
/// controller plugged in after launch stays invisible until the app restarts.
/// Creating a fresh `MidiInput` does not help — the cache is per-process, not
/// per-client.
///
/// Pumping the run loop with a zero timeout drains whatever is already queued
/// and returns; measured worst case 16 µs. The refresh is process-wide, which is
/// why only this thread needs to do it — `ApcOut::ensure_connection` enumerates
/// on the DMX tick thread, where blocking for a real timeout is not an option,
/// and it sees the corrected list without paying anything.
#[cfg(target_os = "macos")]
mod refresh {
    use std::ffi::c_void;

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFRunLoopRunInMode(mode: *const c_void, seconds: f64, ret_after_source: u8) -> i32;
        static kCFRunLoopDefaultMode: *const c_void;
    }

    pub fn pump() {
        // SAFETY: runs the calling thread's own run loop with a zero timeout, so
        // it processes what is pending and returns rather than parking.
        unsafe { CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.0, 0) };
    }
}

/// Everywhere else hot-plug enumeration is live and there is nothing to pump.
#[cfg(not(target_os = "macos"))]
mod refresh {
    pub fn pump() {}
}

/// Native MIDI input: connects every input port and rescans for hot-plugged
/// devices. Runs on its own thread; events go straight to the engine channel.
pub fn start(tx: Sender<EngineMsg>) {
    std::thread::spawn(move || {
        let mut connections: Vec<MidiInputConnection<()>> = Vec::new();
        let mut known: HashSet<String> = HashSet::new();
        // Held for the life of the thread. Notifications are delivered to a
        // CoreMIDI client, and the probe client inside `scan` is dropped between
        // passes — with no device connected there would otherwise be stretches
        // with no client alive to deliver to.
        let _notify = MidiInput::new("LIGHT");
        loop {
            refresh::pump();
            let names = scan(&tx, &mut connections, &mut known);
            if let Some(names) = names {
                let _ = tx.send(EngineMsg::MidiPorts(names));
            }
            std::thread::sleep(Duration::from_secs(3));
        }
    });
}

fn scan(
    tx: &Sender<EngineMsg>,
    connections: &mut Vec<MidiInputConnection<()>>,
    known: &mut HashSet<String>,
) -> Option<Vec<String>> {
    let mut probe = match MidiInput::new("LIGHT") {
        Ok(m) => m,
        Err(_) => return None,
    };
    probe.ignore(Ignore::None);
    let ports = probe.ports();
    let mut changed = false;
    let mut names: Vec<String> = Vec::new();

    for port in &ports {
        let name = probe.port_name(port).unwrap_or_else(|_| "MIDI input".into());
        names.push(name.clone());
        if known.contains(&name) {
            continue;
        }
        let mut input = match MidiInput::new("LIGHT") {
            Ok(m) => m,
            Err(_) => continue,
        };
        input.ignore(Ignore::None);
        let tx2 = tx.clone();
        match input.connect(
            port,
            "light-in",
            move |_, message, _| {
                if !message.is_empty() {
                    let _ = tx2.send(EngineMsg::Midi(
                        message[0],
                        message.get(1).copied().unwrap_or(0),
                        message.get(2).copied().unwrap_or(0),
                    ));
                }
            },
            (),
        ) {
            Ok(conn) => {
                connections.push(conn);
                known.insert(name);
                changed = true;
            }
            Err(e) => eprintln!("[midi] connect failed: {e}"),
        }
    }

    // report disappeared devices too
    let current: HashSet<String> = names.iter().cloned().collect();
    if known.iter().any(|k| !current.contains(k)) {
        known.retain(|k| current.contains(k));
        changed = true;
        // dropped devices keep a dead connection handle around; harmless
    }

    if changed {
        Some(names)
    } else {
        None
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::refresh;
    use midir::os::unix::VirtualOutput;
    use midir::{MidiInput, MidiOutput};
    use std::time::{Duration, Instant};

    const CANARY: &str = "LIGHT-HOTPLUG-TEST";
    const CHILD: &str = "LIGHT_MIDI_CANARY";

    fn ports() -> Vec<String> {
        let m = MidiInput::new("LIGHT test").expect("client");
        m.ports().iter().filter_map(|p| m.port_name(p).ok()).collect()
    }

    fn sees_canary() -> bool {
        ports().iter().any(|n| n.contains(CANARY))
    }

    /// Runs as a child process only. A virtual port created inside the *same*
    /// process is visible immediately, with or without a pump — it never goes
    /// near the notification path — so the device has to come from somewhere
    /// else for the test below to be about anything.
    #[test]
    fn canary_child() {
        if std::env::var(CHILD).is_err() {
            return;
        }
        let out = MidiOutput::new("LIGHT canary").expect("client");
        let _port = out.create_virtual(CANARY).expect("virtual port");
        std::thread::sleep(Duration::from_secs(8));
    }

    /// The bug this pins: an APC plugged in after the app started never appeared.
    /// On macOS a process's CoreMIDI device list only refreshes when the process
    /// runs a CFRunLoop, and the engine is a plain binary that never does — so
    /// both rescans (this thread, and `ApcOut::ensure_connection` on the tick
    /// thread) kept re-reading a list frozen at startup. Hot-plug looked
    /// implemented and could not work.
    #[test]
    fn a_device_that_appears_after_start_becomes_visible() {
        // Establish this process's cached list before the device exists.
        let _anchor = MidiInput::new("LIGHT test anchor").expect("client");
        assert!(!sees_canary(), "a stale {CANARY} is still registered");

        let mut child = std::process::Command::new(std::env::current_exe().expect("test binary"))
            .args(["--exact", "midi::tests::canary_child", "--nocapture"])
            .env(CHILD, "1")
            .stdout(std::process::Stdio::null())
            .spawn()
            .expect("spawn canary");

        // The device now exists. Without pumping the run loop this process can
        // look as often as it likes, with as many fresh clients as it likes, and
        // never see it — the cache is per-process, not per-client. If this half
        // ever starts failing, macOS changed and `refresh::pump` can go.
        let blind = Instant::now() + Duration::from_millis(1500);
        while Instant::now() < blind {
            assert!(!sees_canary(), "visible with no pump — recheck whether refresh::pump is needed");
            std::thread::sleep(Duration::from_millis(50));
        }

        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline && !sees_canary() {
            refresh::pump();
            std::thread::sleep(Duration::from_millis(20));
        }
        let saw = sees_canary();
        let _ = child.kill();
        let _ = child.wait();
        assert!(saw, "{CANARY} never appeared even after pumping the run loop");
    }
}
