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
    /// quit requested — flush the project to disk, then let run() return
    Shutdown,
    Cmd(Command, Option<ClientId>),
    Osc(OscMessage),
    Midi(u8, u8, u8),
    MidiPorts(Vec<String>),
    ClientConnected(ClientId),
    ClientDisconnected(ClientId),
}

pub struct EngineConfig {
    pub port: u16,
    pub ui_dist: Option<PathBuf>,
    pub with_midi: bool,
    /// receives the engine's message sender once it is live, so the host app
    /// can ask for a clean shutdown (⌘Q must not drop the last edits)
    pub on_ready: Option<Box<dyn FnOnce(Sender<EngineMsg>) + Send>>,
}

impl Default for EngineConfig {
    fn default() -> Self {
        EngineConfig { port: 9900, ui_dist: None, with_midi: true, on_ready: None }
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
pub fn run(mut cfg: EngineConfig) {
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
    if let Some(ready) = cfg.on_ready.take() {
        ready(tx.clone());
    }
    let bc = Broadcaster::new();
    if let Err(e) = crate::server::start(cfg.port, cfg.ui_dist.clone(), tx.clone(), bc.clone()) {
        eprintln!("[light] cannot listen on :{} — is another engine running? {e}", cfg.port);
        return;
    }
    if cfg.with_midi {
        crate::midi::start(tx.clone());
    }

    // The hazer must never start pumping on its own: opening the app in an
    // empty room the afternoon after a gig used to restore last night's level.
    let mut project = project;
    project.settings.haze = 0.0;
    let mut state = EngineState::new(project, now_ms());
    let mut renderer = Renderer::new();
    let mut artnet = ArtnetOut::new();
    let mut sacn = SacnOut::new();
    let mut osc = OscIn::new();
    // APC40 LED feedback shares the with_midi gate — the parity harness runs
    // with LIGHT_NO_MIDI and must never touch a controller
    let mut apc = cfg.with_midi.then(crate::apc::ApcOut::new);
    let mut link = crate::link::LinkSync::new(state.clock.bpm);
    link.set_enabled(state.project.sync.link_enabled);
    ensure_osc(&mut osc, &state, &tx);

    let mut midi_names: Vec<String> = Vec::new();
    let mut dirty_at: Option<Instant> = None;
    let mut dirty_first: Option<Instant> = None;
    let mut project_dirty = false;
    let mut last_echo = Instant::now();
    let mut osc_log: (f64, u32) = (0.0, 0); // monitor rate-limit window

    // Keep the machine awake through a set — display sleep or App Nap
    // stopping DMX mid-show is the classic venue failure.
    #[cfg(target_os = "macos")]
    {
        let pid = std::process::id().to_string();
        match std::process::Command::new("caffeinate")
            .args(["-dims", "-w", &pid])
            .spawn()
        {
            Ok(_) => println!("[light] caffeinate active — sleep/App Nap suppressed"),
            Err(e) => eprintln!("[light] caffeinate unavailable: {e}"),
        }
    }

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
        match osc.status() {
            // saying ":7700" when the bind failed sends you hunting Resolume
            Some("failed") => format!(":{} UNAVAILABLE (port held by another app)", state.project.sync.osc_port),
            Some(_) => format!(":{}", state.project.sync.osc_port),
            None => "off".into(),
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
                Ok(EngineMsg::Shutdown) => {
                    // final flush: an edit inside the autosave debounce window
                    // must survive ⌘Q
                    let slug = persist::current_slug(&dir);
                    match persist::save_project_slug(&dir, &slug, &state.project) {
                        Ok(_) => println!("[light] project flushed on shutdown"),
                        Err(e) => eprintln!("[persist] shutdown flush failed: {e}"),
                    }
                    return;
                }
                Ok(msg) => {
                    let bpm_before = state.clock.bpm;
                    let align = handle_msg(
                        msg, &mut state, &bc, &mut osc, &tx, &dir, &mut dirty_at, &mut midi_names,
                        &mut osc_log, now_ms(), &mut project_dirty,
                    );
                    if align {
                        renderer.align_phase();
                    }
                    // a locally-set tempo (tap / setBpm / OSC) leads the session
                    if state.clock.bpm != bpm_before {
                        link.push_tempo(state.clock.bpm);
                    }
                    // the enable flag can change via SetLink or a project edit
                    if link.enabled() != state.project.sync.link_enabled {
                        link.set_enabled(state.project.sync.link_enabled);
                    }
                    if dirty_at.is_none() {
                        dirty_first = None; // a switch handler flushed + cleared
                    } else if dirty_first.is_none() {
                        dirty_first = Some(Instant::now());
                    }
                }
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => return,
            }
        }

        let late = Instant::now().saturating_duration_since(next).as_secs_f64() * 1000.0;
        if late > jitter_max {
            jitter_max = late;
        }

        // Coalesced project echo, rate-limited: continuous controls (faders,
        // MIDI CC) dirty the project on every input event, and each echo is
        // the WHOLE project.
        if project_dirty && last_echo.elapsed() >= Duration::from_millis(100) {
            project_dirty = false;
            last_echo = Instant::now();
            bc.broadcast(&project_event(&state));
        }

        let t = now_ms();
        // follow the Link session tempo while enabled
        if let Some(bpm) = link.poll_tempo(state.clock.bpm) {
            state.clock.set_bpm(bpm, t);
        }
        let res = renderer.tick(&mut state, t);
        {
            let enabled = state.project.universes.iter().any(|u| u.artnet);
            let unicasts: Vec<Option<String>> = state
                .project
                .universes
                .iter()
                .filter(|u| u.artnet)
                .map(|u| u.unicast.clone())
                .collect();
            artnet.poll_tick(enabled, &unicasts);
        }
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

        if let Some(apc) = apc.as_mut() {
            apc.update(&state); // self-throttled to ~15 Hz, diff-only sends
        }

        // Snapshots to the UI at 20 fps.
        snap_flip = !snap_flip;
        if snap_flip && bc.count() > 0 {
            let snap = build_snapshot(&state, &res, t, &stats, &link, &artnet, osc.status());
            if let Ok(s) = serde_json::to_string(&snap) {
                bc.broadcast(&s);
            }
        }

        // Debounced autosave after project changes — on a worker thread so
        // filesystem latency never touches the tick. Quiet for 1.2 s OR
        // dirty for 10 s, whichever first (continuous editing must not
        // postpone persistence indefinitely — mirrors the Node reference).
        if let Some(at) = dirty_at {
            let overdue = dirty_first.is_some_and(|f| f.elapsed() >= Duration::from_secs(10));
            if at.elapsed() >= Duration::from_millis(1200) || overdue {
                let p = state.project.clone();
                let d = dir.clone();
                // capture the slug HERE, on the tick thread — the worker must
                // never re-read .current mid-save and race a project switch
                let slug = persist::current_slug(&dir);
                let bc2 = bc.clone();
                std::thread::spawn(move || {
                    if let Err(e) = persist::save_project_slug(&d, &slug, &p) {
                        eprintln!("[persist] autosave failed: {e}");
                        // the operator must know the show is not on disk —
                        // everything else still looks completely normal
                        bc2.broadcast(
                            &json!({"type":"toast","ok":false,"message":format!("SAVE FAILED — {e}")})
                                .to_string(),
                        );
                    }
                });
                dirty_at = None;
                dirty_first = None;
            }
        }

        next += tick;
        if Instant::now() > next + Duration::from_millis(250) {
            next = Instant::now() + tick; // recover after sleep/suspend
        }
    }
}

/// Launch the native previz window as a detached process. Candidate paths:
/// env override, next to the current executable, repo target dirs.
fn spawn_previz() -> (bool, String) {
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(p) = std::env::var("LIGHT_PREVIZ_BIN") {
        candidates.push(p.into());
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("light-previz"));
        }
    }
    candidates.push("target/release/light-previz".into());
    candidates.push("target/debug/light-previz".into());

    for c in &candidates {
        if c.is_file() {
            return match std::process::Command::new(c).spawn() {
                Ok(_) => (true, "previz launched".into()),
                Err(e) => (false, format!("previz failed to start: {e}")),
            };
        }
    }
    (false, "previz binary not found — build it with: cargo build --release -p light-previz".into())
}

fn project_event(state: &EngineState) -> String {
    json!({ "type": "project", "project": state.project }).to_string()
}

fn broadcast_projects(bc: &Broadcaster, dir: &PathBuf) {
    let list: Vec<serde_json::Value> = persist::list_projects(dir)
        .into_iter()
        .map(|(slug, name)| json!({ "slug": slug, "name": name }))
        .collect();
    bc.broadcast(
        &json!({
            "type": "projects",
            "current": persist::current_slug(dir),
            "list": list,
        })
        .to_string(),
    );
}

#[allow(clippy::too_many_arguments)]
fn apply_outcome(
    out: Outcome,
    state: &mut EngineState,
    bc: &Broadcaster,
    osc: &mut OscIn,
    tx: &Sender<EngineMsg>,
    dir: &PathBuf,
    dirty_at: &mut Option<Instant>,
    project_dirty: &mut bool,
) {
    if out.project_changed {
        // Continuous controls (faders, MIDI CC) land here per input event and
        // each echo is the WHOLE project — coalesce to one per tick instead of
        // flooding every client mid fader-ride.
        *project_dirty = true;
        *dirty_at = Some(Instant::now());
        ensure_osc(osc, state, tx);
    }
    if let Some(mapping) = out.learned {
        bc.broadcast(&json!({ "type": "learned", "mapping": mapping }).to_string());
    }
    if let Some((ok, message, profile_ids)) = out.import_result {
        bc.broadcast(
            &json!({ "type": "importResult", "ok": ok, "message": message, "profileIds": profile_ids })
                .to_string(),
        );
    }
    if out.launch_previz {
        let (ok, message) = spawn_previz();
        bc.broadcast(&json!({ "type": "toast", "ok": ok, "message": message }).to_string());
    }
    if out.save_requested {
        match persist::save_project(dir, &state.project) {
            Ok(path) => bc.broadcast(
                &json!({ "type": "saved", "path": path.to_string_lossy() }).to_string(),
            ),
            Err(e) => {
                eprintln!("[persist] save failed: {e}");
                bc.broadcast(
                    &json!({"type":"toast","ok":false,"message":format!("SAVE FAILED — {e}")}).to_string(),
                );
            }
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
    osc_log: &mut (f64, u32),
    t: f64,
    project_dirty: &mut bool,
) -> bool {
    match msg {
        // handled by the drain loop before it reaches here
        EngineMsg::Shutdown => {}
        EngineMsg::Cmd(cmd, owner) => {
            // project FILE commands live here — the state machine has no
            // filesystem access, mirroring the Node reference's split
            match &cmd {
                Command::Projects => {
                    broadcast_projects(bc, dir);
                    return false;
                }
                Command::NewProject { name } => {
                    let name = if name.trim().is_empty() { "Untitled" } else { name.trim() };
                    let slug = persist::unique_slug(dir, name);
                    let mut fresh = crate::defaults::default_project();
                    fresh.name = name.to_string();
                    // flush the outgoing project under its OWN slug first —
                    // an edit inside the autosave debounce window must not
                    // vanish with the switch
                    let _ = persist::save_project(dir, &state.project);
                    *dirty_at = None;
                    if let Err(e) = persist::save_slug_now(dir, &slug, &fresh) {
                        bc.broadcast(&json!({"type":"toast","ok":false,"message":format!("cannot create: {e}")}).to_string());
                        return false;
                    }
                    persist::set_current_slug(dir, &slug);
                    state.replace_project(fresh);
                    bc.broadcast(&project_event(state));
                    bc.broadcast(&json!({"type":"toast","ok":true,"message":format!("created \"{name}\"")}).to_string());
                    broadcast_projects(bc, dir);
                    ensure_osc(osc, state, tx);
                    return false;
                }
                Command::OpenProject { slug } if *slug == persist::current_slug(dir) => {
                    // already open — flush live edits rather than reverting
                    // to the possibly-stale disk copy
                    let cur = persist::current_slug(dir);
                    let _ = persist::save_project_slug(dir, &cur, &state.project);
                    *dirty_at = None;
                    bc.broadcast(&json!({"type":"toast","ok":true,"message":"already open"}).to_string());
                    return false;
                }
                Command::OpenProject { slug } => {
                    let Some(p) = persist::load_slug(dir, slug) else {
                        bc.broadcast(&json!({"type":"toast","ok":false,"message":format!("cannot open \"{slug}\"")}).to_string());
                        return false;
                    };
                    let _ = persist::save_project(dir, &state.project); // flush pending edits, old slug
                    *dirty_at = None;
                    persist::set_current_slug(dir, slug);
                    let pname = p.name.clone();
                    state.replace_project(p);
                    bc.broadcast(&project_event(state));
                    bc.broadcast(&json!({"type":"toast","ok":true,"message":format!("opened \"{pname}\"")}).to_string());
                    broadcast_projects(bc, dir);
                    ensure_osc(osc, state, tx);
                    return false;
                }
                Command::SaveProjectAs { name } => {
                    let name = if name.trim().is_empty() { "Untitled" } else { name.trim() };
                    let slug = persist::slugify(name);
                    state.project.name = name.to_string();
                    if let Err(e) = persist::save_slug_now(dir, &slug, &state.project) {
                        bc.broadcast(&json!({"type":"toast","ok":false,"message":format!("cannot save: {e}")}).to_string());
                        return false;
                    }
                    persist::set_current_slug(dir, &slug);
                    bc.broadcast(&project_event(state));
                    bc.broadcast(&json!({"type":"toast","ok":true,"message":format!("saved as \"{name}\"")}).to_string());
                    broadcast_projects(bc, dir);
                    return false;
                }
                _ => {}
            }
            let out = state.handle_command(cmd, t, owner);
            let align = out.align_phase;
            apply_outcome(out, state, bc, osc, tx, dir, dirty_at, project_dirty);
            return align;
        }
        EngineMsg::Osc(m) => {
            // The monitor is best-effort — never let an OSC flood amplify
            // into the WS broadcast path (cap ~25 events/s).
            let now = unix_ms();
            if now - osc_log.0 > 1000.0 {
                *osc_log = (now, 0);
            }
            if osc_log.1 < 25 {
                osc_log.1 += 1;
                bc.broadcast(
                    &json!({ "type": "osc", "entry": { "t": now, "addr": m.addr, "args": m.args } })
                        .to_string(),
                );
            }
            let align = m.addr == "/composition/tempocontroller/resync";
            handle_osc_sync(&m, state, t);
            return align;
        }
        EngineMsg::Midi(status, d1, d2) => {
            let out = state.apply_midi(status, d1, d2, t);
            apply_outcome(out, state, bc, osc, tx, dir, dirty_at, project_dirty);
        }
        EngineMsg::MidiPorts(names) => {
            *midi_names = names;
            bc.broadcast(&json!({ "type": "midiInputs", "names": midi_names }).to_string());
        }
        EngineMsg::ClientConnected(id) => {
            bc.send_to(id, project_event(state));
            bc.send_to(id, json!({ "type": "midiInputs", "names": midi_names }).to_string());
        }
        EngineMsg::ClientDisconnected(gone) => {
            // Release exactly what this client was holding. Waiting for the
            // last client to go was the wrong half of the trade: a tablet
            // dropping off the WiFi mid-flash left its blinder latched on
            // stage for as long as the console stayed connected.
            state.release_all_held(t, Some(gone));
            // Closing the window drops its socket — flush now rather than
            // gambling that the process lives long enough for the autosave
            // debounce (or that the host delivers a quit event at all).
            let slug = persist::current_slug(dir);
            if let Err(e) = persist::save_project_slug(dir, &slug, &state.project) {
                eprintln!("[persist] disconnect flush failed: {e}");
            } else {
                *dirty_at = None;
            }
        }
    }
    false
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
    // Untrusted network input: finite-checked, range-checked, identical to
    // the Node engine.
    if m.addr == "/light/bpm" {
        if let Some(v) = num0 {
            if v.is_finite() && (20.0..=999.0).contains(&v) {
                state.clock.set_bpm(v, t);
            }
        }
    }
    if m.addr == "/light/column" {
        if let Some(v) = num0 {
            if v.is_finite() && v >= 1.0 {
                state.trigger_column(v.floor() as usize - 1, t);
            }
        }
    }
    if m.addr == "/light/blackout" {
        if let Some(v) = num0 {
            if v.is_finite() {
                state.blackout = v >= 1.0;
            }
        }
    }
}

fn build_snapshot(
    state: &EngineState,
    res: &TickResult,
    t: f64,
    stats: &EngineStats,
    link: &crate::link::LinkSync,
    artnet: &crate::artnet::ArtnetOut,
    osc_status: Option<&'static str>,
) -> Snapshot {
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
        link: Some(crate::types::LinkSnap { on: link.enabled(), peers: link.peers() }),
        artnet_nodes: if artnet.poll_status() != "off"
            || state.project.universes.iter().any(|u| u.artnet)
        {
            Some(artnet.nodes_snapshot())
        } else {
            None
        },
        muted: {
            let mut m: Vec<String> = state.muted.iter().cloned().collect();
            m.sort(); // stable wire order
            m
        },
        identify: state.identify.clone(),
        overrides: state.overrides.values().map(|m| m.len()).sum(),
        osc_in: osc_status,
        artnet_poll: match artnet.poll_status() {
            "off" => {
                if state.project.universes.iter().any(|u| u.artnet) {
                    Some("on") // enabled this tick; listener opens next poll
                } else {
                    None
                }
            }
            s => Some(if s == "failed" { "failed" } else { "on" }),
        },
        blackout: state.blackout,
        haze: state.project.settings.haze,
        haze_fan: state.project.settings.haze_fan,
        heads: res.heads.clone(),
        layers: res.layers.clone(),
        dmx,
        stats: stats.clone(),
    }
}
