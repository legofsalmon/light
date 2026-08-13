use std::collections::HashSet;
use std::sync::mpsc::Sender;
use std::time::Duration;

use midir::{Ignore, MidiInput, MidiInputConnection};

use crate::engine::EngineMsg;

/// Native MIDI input: connects every input port and rescans for hot-plugged
/// devices. Runs on its own thread; events go straight to the engine channel.
pub fn start(tx: Sender<EngineMsg>) {
    std::thread::spawn(move || {
        let mut connections: Vec<MidiInputConnection<()>> = Vec::new();
        let mut known: HashSet<String> = HashSet::new();
        loop {
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
