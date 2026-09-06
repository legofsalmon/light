use std::collections::HashSet;
use std::sync::mpsc::Sender;
use std::time::Duration;

use midir::{Ignore, MidiInput, MidiInputConnection};
#[cfg(unix)]
use midir::os::unix::VirtualInput;

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
        // Held for the life of the thread: dropping it removes the port.
        let _own_port = open_own_port(&tx);
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

/// The port LIGHT publishes under its own name, so a DAW on this Mac can send
/// notes and beat clock straight to the console with nothing to set up. Without
/// it the operator has to open Audio MIDI Setup and add an IAC bus first, which
/// is a step in a utility most people have never opened.
///
/// It is a **destination**, and macOS lists sources and destinations
/// separately, so it appears in other apps' MIDI output menus and never in this
/// process's own input scan — the engine cannot attach to itself. Verified
/// rather than assumed: `--example virtprobe` prints both lists either side of
/// creating one. The surface scanner does enumerate destinations, but it
/// matches on "apc40" and "apc mini", so it passes this one over.
#[cfg(unix)]
fn open_own_port(tx: &Sender<EngineMsg>) -> Option<MidiInputConnection<()>> {
    const NAME: &str = "LIGHT";
    let mut input = match MidiInput::new("LIGHT") {
        Ok(m) => m,
        Err(e) => {
            eprintln!("[midi] no client for the LIGHT port: {e}");
            return None;
        }
    };
    input.ignore(Ignore::None);
    match input.create_virtual(NAME, handler(tx, NAME), ()) {
        Ok(conn) => {
            println!("[midi] listening on a port named \"{NAME}\" — send to it from a DAW");
            let _ = tx.send(EngineMsg::MidiOwnPort(NAME.to_string()));
            Some(conn)
        }
        Err(e) => {
            // Not fatal: every real input still works, and the IAC route the
            // docs describe is unaffected.
            eprintln!("[midi] could not publish the LIGHT port: {e}");
            None
        }
    }
}

#[cfg(not(unix))]
fn open_own_port(_tx: &Sender<EngineMsg>) -> Option<MidiInputConnection<()>> {
    None
}

/// What every input port does with a message, real or virtual.
///
/// Written once so the virtual "LIGHT" port and a plugged-in controller cannot
/// drift apart: a DAW sending beat clock to LIGHT's own port has to be followed
/// exactly the way a CDJ on a USB cable is.
fn handler(tx: &Sender<EngineMsg>, name: &str) -> impl FnMut(u64, &[u8], &mut ()) {
    let tx = tx.clone();
    // Cloned once per connection, then refcount-bumped per message: the
    // follower needs to know WHICH port a tick came from, and a rig with a
    // clock source sends 48 of them a second at 120 BPM.
    let port_name: std::sync::Arc<str> = std::sync::Arc::from(name);
    // midir stamps a message in the driver's own microseconds — uptime, on
    // CoreMIDI — and the engine measures everything from the moment it
    // started. Both count real microseconds, so one offset taken at the
    // first message carries the driver's precision onto the engine's scale
    // and keeps it there. Taking a fresh reading per message instead would
    // throw that precision away, which is the whole reason for keeping the
    // stamp.
    let mut stamp_offset: Option<i64> = None;
    move |stamp, message, _: &mut ()| {
        let Some(&status) = message.first() else { return };
        // System realtime — clock, start, continue, stop — is split off here
        // rather than sent down the command channel as a note. At 120 BPM that
        // channel was carrying 48 messages a second that every handler
        // downstream had to look at and discard, and midir's timestamp (the
        // only one worth averaging) was being thrown away at the same time.
        if status >= 0xF8 {
            let off =
                *stamp_offset.get_or_insert(crate::engine::micros_now() as i64 - stamp as i64);
            let at = (stamp as i64).saturating_add(off).max(0) as u64;
            let _ = tx.send(EngineMsg::MidiClock(status, at, port_name.clone()));
            return;
        }
        let _ = tx.send(EngineMsg::Midi(
            status,
            message.get(1).copied().unwrap_or(0),
            message.get(2).copied().unwrap_or(0),
        ));
    }
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
        match input.connect(port, "light-in", handler(tx, &name), ()) {
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

/// The message handler is shared by every real port and by the virtual "LIGHT"
/// one, so these cover both. No CoreMIDI here — creating a port is the part
/// that needs hardware or a run loop; deciding what a message means is not.
#[cfg(test)]
mod handler_tests {
    use super::*;
    use std::sync::mpsc::channel;

    /// EngineMsg carries parsed imports and commands, so it is not Debug and
    /// should not become Debug for a test's convenience. This says enough.
    fn describe(m: &EngineMsg) -> String {
        match m {
            EngineMsg::Midi(a, b, c) => format!("Midi({a:#x},{b},{c})"),
            EngineMsg::MidiClock(s, at, port) => format!("MidiClock({s:#x},{at},{port})"),
            _ => "other".into(),
        }
    }

    fn shown(out: &[EngineMsg]) -> String {
        out.iter().map(describe).collect::<Vec<_>>().join(" ")
    }

    fn feed(msgs: &[(u64, &[u8])]) -> Vec<EngineMsg> {
        let (tx, rx) = channel();
        let mut h = handler(&tx, "Deck");
        for (stamp, m) in msgs {
            h(*stamp, m, &mut ());
        }
        // BOTH senders: `handler` keeps its own clone, so dropping only the
        // local one leaves the channel open and `into_iter` blocks for ever.
        drop(h);
        drop(tx);
        rx.into_iter().collect()
    }

    #[test]
    fn a_note_arrives_as_a_note() {
        let out = feed(&[(0, &[0x90, 0x3c, 0x64])]);
        assert!(matches!(out[..], [EngineMsg::Midi(0x90, 0x3c, 0x64)]), "{}", shown(&out));
    }

    #[test]
    fn a_short_message_is_padded_rather_than_dropped() {
        // Some controllers send running-status-ish two-byte messages; the
        // engine's actions read a velocity, so it has to be something.
        let out = feed(&[(0, &[0xb0, 0x07])]);
        assert!(matches!(out[..], [EngineMsg::Midi(0xb0, 0x07, 0)]), "{}", shown(&out));
    }

    #[test]
    fn an_empty_message_says_nothing() {
        assert!(feed(&[(0, &[])]).is_empty());
    }

    #[test]
    fn realtime_is_split_off_and_carries_the_port_that_sent_it() {
        // One byte, no data bytes, and it must NOT go down the note path — at
        // 120 BPM that is 48 messages a second every handler would sift.
        for status in [0xF8u8, 0xFA, 0xFB, 0xFC] {
            let out = feed(&[(0, &[status])]);
            match &out[..] {
                [EngineMsg::MidiClock(s, _, port)] => {
                    assert_eq!(*s, status);
                    assert_eq!(&**port, "Deck", "the follower has to know which port");
                }
                other => panic!("{status:#x} did not come through as clock: {}", shown(other)),
            }
        }
    }

    #[test]
    fn the_gap_between_ticks_survives_being_put_on_our_own_clock() {
        // The driver stamps in its own microseconds and the engine measures
        // from its own start. One offset taken at the first message moves the
        // whole stream across, so the INTERVALS — which are the tempo — come
        // through untouched. That is the entire reason for keeping the stamp.
        let before = crate::engine::micros_now();
        let out = feed(&[(1_000_000, &[0xF8]), (1_020_000, &[0xF8]), (1_041_000, &[0xF8])]);
        let after = crate::engine::micros_now();
        let at: Vec<u64> = out
            .iter()
            .map(|m| match m {
                EngineMsg::MidiClock(_, at, _) => *at,
                other => panic!("not clock: {}", describe(other)),
            })
            .collect();
        assert_eq!(at[1] - at[0], 20_000, "a 20 ms gap has to stay 20 ms");
        assert_eq!(at[2] - at[1], 21_000);
        // and the stream now sits on the engine's scale, not the driver's
        assert!(at[0] >= before && at[0] <= after, "{} not within {before}..{after}", at[0]);
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
