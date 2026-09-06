//! Scratch: send to a named MIDI destination, for checking the port LIGHT
//! publishes under its own name. The counterpart to `surfacesink`, which
//! receives. Not part of the product.
//!   cargo run -p light-core --example midisend -- <port> note <n> [channel]
//!   cargo run -p light-core --example midisend -- <port> clock <bpm> <secs>
fn main() {
    let a: Vec<String> = std::env::args().skip(1).collect();
    let want = a.first().cloned().unwrap_or_else(|| "LIGHT".into()).to_lowercase();
    let out = midir::MidiOutput::new("light-midisend").expect("midi out");
    let ports = out.ports();
    let Some(port) = ports
        .iter()
        .find(|p| out.port_name(p).map(|n| n.to_lowercase().contains(&want)).unwrap_or(false))
    else {
        eprintln!("[midisend] no destination matching \"{want}\". Available:");
        for p in &ports {
            eprintln!("    {}", out.port_name(p).unwrap_or_default());
        }
        std::process::exit(1);
    };
    let name = out.port_name(port).unwrap_or_default();
    let mut conn = out.connect(port, "light-midisend").expect("connect");
    eprintln!("[midisend] connected to \"{name}\"");

    match a.get(1).map(String::as_str).unwrap_or("note") {
        "clock" => {
            let bpm: f64 = a.get(2).and_then(|s| s.parse().ok()).unwrap_or(128.0);
            let secs: f64 = a.get(3).and_then(|s| s.parse().ok()).unwrap_or(8.0);
            let step = std::time::Duration::from_secs_f64(60.0 / (bpm * 24.0));
            let began = std::time::Instant::now();
            let _ = conn.send(&[0xFA]);
            for i in 0..((secs * bpm * 24.0 / 60.0) as u64) {
                let due = began + step.mul_f64(i as f64);
                while std::time::Instant::now() < due {
                    std::hint::spin_loop();
                }
                let _ = conn.send(&[0xF8]);
            }
            let _ = conn.send(&[0xFC]);
            eprintln!("[midisend] sent {bpm} BPM for {secs}s");
        }
        _ => {
            let n: u8 = a.get(2).and_then(|s| s.parse().ok()).unwrap_or(36);
            let ch: u8 = a.get(3).and_then(|s| s.parse().ok()).unwrap_or(0);
            let _ = conn.send(&[0x90 | (ch & 0x0f), n, 100]);
            std::thread::sleep(std::time::Duration::from_millis(300));
            let _ = conn.send(&[0x80 | (ch & 0x0f), n, 0]);
            eprintln!("[midisend] note {n} on channel {ch}");
        }
    }
}
