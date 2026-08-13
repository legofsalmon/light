use std::path::PathBuf;
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::json;

use crate::artnet::ArtnetOut;
use crate::defaults::default_project;
use crate::osc::{OscIn, OscMessage};
use crate::persist;
use crate::renderer::{Renderer, TickResult};
use crate::sacn::SacnOut;
use crate::server::{Broadcaster, ClientId};
use crate::state::{EngineState, Outcome};
use crate::types::{Command, EngineStats, Snapshot};

const TICK_MS: u64 = 25; // 40 Hz DMX refresh

pub enum EngineMsg {
    Cmd(Command),
    Osc(OscMessage),
    Midi(u8, u8, u8),
    MidiPorts(Vec<String>),
    ClientConnected(ClientId),
}

pub struct EngineConfig {
    pub port: u16,
    pub ui_dist: Option<PathBuf>,
    pub with_midi: bool,
}

impl Default for EngineConfig {
    fn default() -> Self {
        EngineConfig { port: 9900, ui_dist: None, with_midi: true }
    }
}

fn unix_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

fn ensure_osc(osc: &mut OscIn, state: &EngineState, tx: &Sender<EngineMsg>) {
    let tx = tx.clone();
    osc.listen(
        state.project.sync.osc_port,
        state.project.sync.osc_enabled,
        move |m| {
            let _ = tx.send(EngineMsg::Osc(m));
        },
    );
}

/// Blocking engine loop — spawn on a dedicated thread from the Tauri shell,
/// or call directly from the standalone binary.
pub fn run(cfg: EngineConfig) {
    let epoch = Instant::now();
    let now_ms = move || epoch.elapsed().as_secs_f64() * 1000.0;

    let dir = persist::project_dir();
    let project = persist::load_project(&dir).unwrap_or_else(|| {
        let p = default_project();
        match persist::save_project(&dir, &p) {
            Ok(path) => println!("[light] created default project at {}", path.display()),
            Err(e) => eprintln!("[light] could not write default project: {e}"),
        }
        p
    });

    let (tx, rx) = mpsc::channel::<EngineMsg>();
    let bc = Broadcaster::new();
    if let Err(e) = crate::server::start(cfg.port, cfg.ui_dist.clone(), tx.clone(), bc.clone()) {
        eprintln!("[light] cannot listen on :{} — is another engine running? {e}", cfg.port);
        return;
    }
    if cfg.with_midi {
        crate::midi::start(tx.clone());
    }

    let mut state = EngineState::new(project, now_ms());
    let mut renderer = Renderer::new();
    let mut artnet = ArtnetOut::new();
    let mut sacn = SacnOut::new();
    let mut osc = OscIn::new();
    ensure_osc(&mut osc, &state, &tx);

    let mut midi_names: Vec<String> = Vec::new();
    let mut dirty_at: Option<Instant> = None;

    println!();
    println!("  ██   LIGHT engine (rust core)");
    println!("  ██   project   {}", state.project.name);
    println!("  ██   ui        http://localhost:{}", cfg.port);
    println!(
        "  ██   art-net   {} @ 40 Hz",
        state
            .project
            .universes
            .iter()
            .filter(|u| u.artnet)
            .map(|u| format!("U{}", u.artnet_universe))
            .collect::<Vec<_>>()
            .join(", ")
    );
    println!(
        "  ██   osc in    {}",
        if state.project.sync.osc_enabled {
            format!(":{}", state.project.sync.osc_port)
        } else {
            "off".into()
        }
    );
    println!();

    let tick = Duration::from_millis(TICK_MS);
    let mut next = Instant::now() + tick;
    let mut snap_flip = false;
    let mut jitter_max = 0f64;
    let mut window_start = now_ms();
    let mut window_ticks: u32 = 0;
    let mut stats = EngineStats { fps: 40, jitter: 0.0, artnet: 0, sacn: 0 };

    loop {
        // Drain control messages until the next DMX tick is due.
        loop {
            let now = Instant::now();
            if now >= next {
                break;
            }
            match rx.recv_timeout(next - now) {
                Ok(msg) => handle_msg(
                    msg, &mut state, &bc, &mut osc, &tx, &dir, &mut dirty_at, &mut midi_names, now_ms(),
                ),
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => return,
            }
        }

        let late = Instant::now().saturating_duration_since(next).as_secs_f64() * 1000.0;
        if late > jitter_max {
            jitter_max = late;
        }

        let t = now_ms();
        let res = renderer.tick(&mut state, t);
        for u in &state.project.universes {
            let Some(buf) = res.buffers.get(&u.id) else { continue };
            if u.artnet {
                artnet.send(u.artnet_universe, buf, u.unicast.as_deref());
            }
            if u.sacn {
                sacn.send(u.sacn_universe, buf, u.unicast.as_deref());
            }
        }

        window_ticks += 1;
        if t - window_start >= 2000.0 {
            stats = EngineStats {
                fps: ((window_ticks as f64 * 1000.0) / (t - window_start)).round() as u32,
                jitter: (jitter_max * 10.0).round() / 10.0,
                artnet: artnet.packets,
                sacn: sacn.packets,
            };
            window_ticks = 0;
            jitter_max = 0.0;
            window_start = t;
        }

        // Snapshots to the UI at 20 fps.
        snap_flip = !snap_flip;
        if snap_flip && bc.count() > 0 {
            let snap = build_snapshot(&state, &res, t, &stats);
            if let Ok(s) = serde_json::to_string(&snap) {
                bc.broadcast(&s);
            }
        }

        // Debounced autosave after project changes.
        if let Some(at) = dirty_at {
            if at.elapsed() >= Duration::from_millis(1200) {
                if let Err(e) = persist::save_project(&dir, &state.project) {
                    eprintln!("[persist] autosave failed: {e}");
                }
                dirty_at = None;
            }
        }

        next += tick;
        if Instant::now() > next + Duration::from_millis(250) {
            next = Instant::now() + tick; // recover after sleep/suspend
        }
    }
}

fn project_event(state: &EngineState) -> String {
    json!({ "type": "project", "project": state.project }).to_string()
}

fn apply_outcome(
    out: Outcome,
    state: &mut EngineState,
    bc: &Broadcaster,
    osc: &mut OscIn,
    tx: &Sender<EngineMsg>,
    dir: &PathBuf,
    dirty_at: &mut Option<Instant>,
) {
    if out.project_changed {
        bc.broadcast(&project_event(state));
        *dirty_at = Some(Instant::now());
        ensure_osc(osc, state, tx);
    }
    if let Some(mapping) = out.learned {
        bc.broadcast(&json!({ "type": "learned", "mapping": mapping }).to_string());
    }
    if out.save_requested {
        match persist::save_project(dir, &state.project) {
            Ok(path) => bc.broadcast(
                &json!({ "type": "saved", "path": path.to_string_lossy() }).to_string(),
            ),
            Err(e) => eprintln!("[persist] save failed: {e}"),
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn handle_msg(
    msg: EngineMsg,
    state: &mut EngineState,
    bc: &Broadcaster,
    osc: &mut OscIn,
    tx: &Sender<EngineMsg>,
    dir: &PathBuf,
    dirty_at: &mut Option<Instant>,
    midi_names: &mut Vec<String>,
    t: f64,
) {
    match msg {
        EngineMsg::Cmd(cmd) => {
            let out = state.handle_command(cmd, t);
            apply_outcome(out, state, bc, osc, tx, dir, dirty_at);
        }
        EngineMsg::Osc(m) => {
            bc.broadcast(
                &json!({ "type": "osc", "entry": { "t": unix_ms(), "addr": m.addr, "args": m.args } })
                    .to_string(),
            );
            handle_osc_sync(&m, state, t);
        }
        EngineMsg::Midi(status, d1, d2) => {
            let out = state.apply_midi(status, d1, d2, t);
            apply_outcome(out, state, bc, osc, tx, dir, dirty_at);
        }
        EngineMsg::MidiPorts(names) => {
            *midi_names = names;
            bc.broadcast(&json!({ "type": "midiInputs", "names": midi_names }).to_string());
        }
        EngineMsg::ClientConnected(id) => {
            bc.send_to(id, project_event(state));
            bc.send_to(id, json!({ "type": "midiInputs", "names": midi_names }).to_string());
        }
    }
}

fn handle_osc_sync(m: &OscMessage, state: &mut EngineState, t: f64) {
    let num0 = m.args.first().and_then(|v| v.as_f64());
    let sync = &state.project.sync;

    if sync.bpm_from_osc && m.addr == "/composition/tempocontroller/tempo" {
        if let Some(v) = num0 {
            // Resolume sends the tempo slider normalised 0..1 over 20..500 BPM;
            // tolerate tools that send the BPM directly.
            let bpm = if v <= 1.0001 { 20.0 + v * 480.0 } else { v };
            state.clock.set_bpm(bpm, t);
        }
    }
    if m.addr == "/composition/tempocontroller/resync" {
        state.clock.resync(t);
    }
    if sync.follow_columns {
        if let Some(rest) = m.addr.strip_prefix("/composition/columns/") {
            if let Some(col_s) = rest.strip_suffix("/connect") {
                if let Ok(col) = col_s.parse::<usize>() {
                    if col >= 1 && (m.args.is_empty() || num0.unwrap_or(0.0) >= 1.0) {
                        state.trigger_column(col - 1, t);
                    }
                }
            }
        }
    }
    if m.addr == "/light/bpm" {
        if let Some(v) = num0 {
            state.clock.set_bpm(v, t);
        }
    }
    if m.addr == "/light/column" {
        if let Some(v) = num0 {
            if v >= 1.0 {
                state.trigger_column(v as usize - 1, t);
            }
        }
    }
    if m.addr == "/light/blackout" {
        state.blackout = num0.unwrap_or(0.0) >= 1.0;
    }
}

fn build_snapshot(state: &EngineState, res: &TickResult, t: f64, stats: &EngineStats) -> Snapshot {
    let mut dmx = std::collections::HashMap::new();
    for (id, buf) in &res.buffers {
        dmx.insert(id.clone(), buf.to_vec());
    }
    Snapshot {
        typ: "snap",
        now: t,
        beat: res.beat,
        bpm: state.clock.bpm,
        speed: state.speed,
        master: state.master,
        blackout: state.blackout,
        haze: state.project.settings.haze,
        haze_fan: state.project.settings.haze_fan,
        heads: res.heads.clone(),
        layers: res.layers.clone(),
        dmx,
        stats: stats.clone(),
    }
}
