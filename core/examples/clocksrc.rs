//! Scratch: a virtual MIDI beat clock source, for verifying the follower
//! against a real CoreMIDI port. Not part of the product.
//!   cargo run -p light-core --example clocksrc -- <bpm> <seconds>
use midir::os::unix::VirtualOutput;

fn main() {
    let bpm: f64 = std::env::args().nth(1).and_then(|s| s.parse().ok()).unwrap_or(128.0);
    let secs: f64 = std::env::args().nth(2).and_then(|s| s.parse().ok()).unwrap_or(12.0);
    let out = midir::MidiOutput::new("light-clocksrc").expect("midi out");
    let mut conn = out.create_virtual("LIGHT test clock").expect("virtual port");
    let step = std::time::Duration::from_secs_f64(60.0 / (bpm * 24.0));
    eprintln!("[clocksrc] sending {bpm} BPM for {secs}s on \"LIGHT test clock\"");
    let _ = conn.send(&[0xFA]); // start
    let ticks = (secs * bpm * 24.0 / 60.0) as u64;
    let began = std::time::Instant::now();
    let mut err: Vec<f64> = Vec::new();
    for i in 0..ticks {
        let due = began + step.mul_f64(i as f64);
        // sleep to a millisecond short, then spin: thread::sleep on macOS
        // overshoots by a few ms, which at a 20 ms tick IS the jitter under test
        let now = std::time::Instant::now();
        if due > now + std::time::Duration::from_millis(2) {
            std::thread::sleep(due - now - std::time::Duration::from_millis(2));
        }
        while std::time::Instant::now() < due {
            std::hint::spin_loop();
        }
        let sent = std::time::Instant::now();
        err.push((sent.duration_since(began).as_secs_f64() - step.as_secs_f64() * i as f64) * 1000.0);
        let _ = conn.send(&[0xF8]);
    }
    let worst = err.iter().cloned().fold(0.0f64, |a, b| a.max(b.abs()));
    let mean = err.iter().sum::<f64>() / err.len() as f64;
    eprintln!("[clocksrc] send jitter: worst {worst:.2} ms, mean {mean:.2} ms");
    let _ = conn.send(&[0xFC]); // stop
    eprintln!("[clocksrc] done, {ticks} ticks");
}
