//! Scratch: virtual MIDI destinations named like control surfaces, so the LED
//! feedback path can be verified end to end without the hardware. Prints what
//! LIGHT actually sends. Not part of the product.
//!   cargo run -p light-core --example surfacesink -- <seconds> [name…]
use midir::os::unix::VirtualInput;
use std::sync::{Arc, Mutex};

type Msg = (u8, u8, u8);

fn main() {
    let secs: f64 = std::env::args().nth(1).and_then(|s| s.parse().ok()).unwrap_or(12.0);
    let names: Vec<String> = {
        let rest: Vec<String> = std::env::args().skip(2).collect();
        if rest.is_empty() { vec!["APC40 mkII".into(), "APC mini mk2".into()] } else { rest }
    };

    let mut conns = Vec::new();
    let logs: Vec<Arc<Mutex<Vec<Msg>>>> = names.iter().map(|_| Arc::new(Mutex::new(Vec::new()))).collect();
    for (name, log) in names.iter().zip(&logs) {
        let input = midir::MidiInput::new("light-surfacesink").expect("midi in");
        let log = log.clone();
        let conn = input
            .create_virtual(name, move |_, m, _| {
                if m.len() == 3 {
                    log.lock().unwrap().push((m[0], m[1], m[2]));
                }
            }, ())
            .expect("virtual destination");
        conns.push(conn);
        eprintln!("[sink] listening as \"{name}\"");
    }

    std::thread::sleep(std::time::Duration::from_secs_f64(secs));

    for (name, log) in names.iter().zip(&logs) {
        let msgs = log.lock().unwrap().clone();
        let blanks = msgs.iter().filter(|(_, _, v)| *v == 0).count();
        // last write wins, so replay to get the surface as it stands
        let mut state: std::collections::BTreeMap<u8, (u8, u8)> = Default::default();
        for &(status, note, vel) in &msgs {
            if vel == 0 { state.remove(&note); } else { state.insert(note, (status & 0x0f, vel)); }
        }
        println!("\n== {name}: {} messages, {blanks} blanks, {} notes lit", msgs.len(), state.len());
        for (note, (ch, vel)) in &state {
            println!("   note {note:>3}  ch {ch:>2}  vel {vel:>3}");
        }
    }
}
