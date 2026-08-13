use std::collections::HashMap;

use crate::clock::BeatClock;
use crate::types::{clamp, clamp01, Command, MidiAction, MidiMapping, MidiType, Project};

#[derive(Debug, Clone)]
pub struct LayerLive {
    pub look_id: Option<String>,
    pub prev_id: Option<String>,
    pub col: Option<usize>,
    pub fade_start: f64,
    pub fade_dur: f64, // seconds
    pub held: bool,
}

impl Default for LayerLive {
    fn default() -> Self {
        LayerLive { look_id: None, prev_id: None, col: None, fade_start: 0.0, fade_dur: 0.0, held: false }
    }
}

static UID_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
pub fn uid(prefix: &str) -> String {
    let n = UID_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    format!("{prefix}-r{n:x}")
}

/// What a handled message asks the surrounding engine loop to do.
#[derive(Default)]
pub struct Outcome {
    pub project_changed: bool,
    pub learned: Option<MidiMapping>,
    pub save_requested: bool,
    /// (ok, message, imported profile ids)
    pub import_result: Option<(bool, String, Vec<String>)>,
    pub launch_previz: bool,
    /// tap/resync: land the effect phase on a downbeat
    pub align_phase: bool,
}

/// Minimal base64 decode (standard alphabet, padding optional) — the import
/// path only; not worth a dependency.
fn base64_decode(s: &str) -> Result<Vec<u8>, String> {
    const ALPHA: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut rev = [255u8; 256];
    for (i, &c) in ALPHA.iter().enumerate() {
        rev[c as usize] = i as u8;
    }
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let mut acc: u32 = 0;
    let mut bits = 0;
    for c in s.bytes() {
        if c == b'=' || c == b'\n' || c == b'\r' {
            continue;
        }
        let v = rev[c as usize];
        if v == 255 {
            return Err("invalid base64".into());
        }
        acc = (acc << 6) | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Ok(out)
}

pub struct EngineState {
    pub project: Project,
    pub live: HashMap<String, LayerLive>,
    pub clock: BeatClock,
    pub master: f64,
    pub speed: f64,
    pub blackout: bool,
    pub learn_target: Option<MidiAction>,
}

impl EngineState {
    pub fn new(project: Project, now: f64) -> Self {
        let mut st = EngineState {
            project,
            live: HashMap::new(),
            clock: BeatClock::new(now),
            master: 1.0,
            speed: 1.0,
            blackout: false,
            learn_target: None,
        };
        st.ensure_decks();
        st.reconcile();
        st
    }

    /// Older projects have no pages — the current grid becomes deck 1, and
    /// the active deck id must always resolve. Mirrors the Node sanitiser.
    fn ensure_decks(&mut self) {
        if self.project.decks.is_empty() {
            let cells: HashMap<String, Vec<Option<String>>> = self
                .project
                .layers
                .iter()
                .map(|l| (l.id.clone(), l.cells.clone()))
                .collect();
            self.project.decks.push(crate::types::Deck {
                id: "deck-1".into(),
                name: "Song 1".into(),
                columns: self.project.columns.clone(),
                cells,
            });
            self.project.active_deck_id = Some("deck-1".into());
        }
        let active_ok = self
            .project
            .active_deck_id
            .as_ref()
            .map(|id| self.project.decks.iter().any(|d| &d.id == id))
            .unwrap_or(false);
        if !active_ok {
            self.project.active_deck_id = Some(self.project.decks[0].id.clone());
        }
    }

    /// Switch the active grid page: store the current cells into the outgoing
    /// deck, load the target's. Playing looks keep playing.
    pub fn switch_deck(&mut self, deck_id: &str) -> bool {
        if self.project.active_deck_id.as_deref() == Some(deck_id) {
            return false;
        }
        if !self.project.decks.iter().any(|d| d.id == deck_id) {
            return false;
        }
        let current_id = self.project.active_deck_id.clone();
        if let Some(cur) = self
            .project
            .decks
            .iter_mut()
            .find(|d| Some(&d.id) == current_id.as_ref())
        {
            cur.columns = self.project.columns.clone();
            cur.cells = self
                .project
                .layers
                .iter()
                .map(|l| (l.id.clone(), l.cells.clone()))
                .collect();
        }
        let target = self.project.decks.iter().find(|d| d.id == deck_id).unwrap().clone();
        self.project.columns = target.columns.clone();
        let n = self.project.columns.len();
        for l in &mut self.project.layers {
            let mut cells = target.cells.get(&l.id).cloned().unwrap_or_default();
            cells.resize(n, None);
            l.cells = cells;
        }
        self.project.active_deck_id = Some(deck_id.to_string());
        true
    }

    pub fn deck_step(&mut self, dir: i32) -> bool {
        if self.project.decks.len() < 2 {
            return false;
        }
        let i = self
            .project
            .decks
            .iter()
            .position(|d| Some(&d.id) == self.project.active_deck_id.as_ref())
            .unwrap_or(0) as i32;
        let n = self.project.decks.len() as i32;
        let j = ((i + dir) % n + n) % n;
        let id = self.project.decks[j as usize].id.clone();
        self.switch_deck(&id)
    }

    pub fn layer_live(&mut self, layer_id: &str) -> &mut LayerLive {
        self.live.entry(layer_id.to_string()).or_default()
    }

    pub fn trigger(&mut self, layer_id: &str, col: usize, t: f64) {
        let Some(layer) = self.project.layers.iter().find(|l| l.id == layer_id) else { return };
        let Some(Some(look_id)) = layer.cells.get(col).cloned() else { return };
        let Some(look) = self.project.looks.get(&look_id) else { return };
        let fade = look.fade.unwrap_or(layer.fade).max(0.0);
        let flash = look.is_flash();
        let live = self.layer_live(layer_id);
        // Retriggering the already-active look is a no-op — a double column
        // press mid-fade must not snap the crossfade.
        if live.look_id.as_deref() == Some(look_id.as_str()) && !flash {
            return;
        }
        live.prev_id = live.look_id.take();
        live.look_id = Some(look_id);
        live.col = Some(col);
        live.fade_start = t;
        live.fade_dur = fade;
        live.held = flash;
    }

    pub fn release(&mut self, layer_id: &str, col: usize, t: f64) {
        let Some(layer) = self.project.layers.iter().find(|l| l.id == layer_id) else { return };
        let Some(Some(look_id)) = layer.cells.get(col).cloned() else { return };
        let Some(look) = self.project.looks.get(&look_id) else { return };
        if !look.is_flash() {
            return;
        }
        let fade = look.fade.unwrap_or(0.05).max(0.02);
        let live = self.layer_live(layer_id);
        if live.look_id.as_deref() != Some(look_id.as_str()) {
            return;
        }
        live.prev_id = live.look_id.take();
        live.look_id = None;
        live.col = None;
        live.fade_start = t;
        live.fade_dur = fade;
        live.held = false;
    }

    pub fn clear_layer(&mut self, layer_id: &str, t: f64) {
        let Some(layer) = self.project.layers.iter().find(|l| l.id == layer_id) else { return };
        let fade = layer.fade;
        let live = self.layer_live(layer_id);
        if live.look_id.is_none() && live.prev_id.is_none() {
            return;
        }
        live.prev_id = live.look_id.take();
        live.look_id = None;
        live.col = None;
        live.fade_start = t;
        live.fade_dur = fade;
        live.held = false;
    }

    /// Gig safety: if the client holding a momentary flash look vanishes, its
    /// release will never arrive — drop all held flash looks.
    pub fn release_all_held(&mut self, t: f64) {
        for live in self.live.values_mut() {
            if !live.held {
                continue;
            }
            let Some(look_id) = live.look_id.take() else { continue };
            let fade = self
                .project
                .looks
                .get(&look_id)
                .and_then(|l| l.fade)
                .unwrap_or(0.05)
                .max(0.02);
            live.prev_id = Some(look_id);
            live.col = None;
            live.fade_start = t;
            live.fade_dur = fade;
            live.held = false;
        }
    }

    /// Column = cue: fire non-flash cells, clear empty ones. Flash looks are
    /// skipped so a cue can never latch a blinder on.
    pub fn trigger_column(&mut self, col: usize, t: f64) {
        let layer_ids: Vec<String> = self.project.layers.iter().map(|l| l.id.clone()).collect();
        for id in layer_ids {
            let layer = self.project.layers.iter().find(|l| l.id == id).unwrap();
            let look = layer
                .cells
                .get(col)
                .and_then(|c| c.as_ref())
                .and_then(|lid| self.project.looks.get(lid));
            match look {
                Some(l) if l.is_flash() => {} // momentary looks are untouched by cues
                Some(_) => self.trigger(&id, col, t),
                None => self.clear_layer(&id, t),
            }
        }
    }

    pub fn apply_midi(&mut self, status: u8, d1: u8, d2: u8, t: f64) -> Outcome {
        let mut out = Outcome::default();
        let kind = status & 0xf0;
        let channel = status & 0x0f;
        let is_note_on = kind == 0x90 && d2 > 0;
        let is_note_off = kind == 0x80 || (kind == 0x90 && d2 == 0);
        let is_cc = kind == 0xb0;
        if !is_note_on && !is_note_off && !is_cc {
            return out;
        }

        if let Some(target) = self.learn_target.take() {
            if is_note_on || is_cc {
                let mapping = MidiMapping {
                    id: uid("midi"),
                    kind: if is_cc { MidiType::Cc } else { MidiType::Note },
                    channel,
                    number: d1,
                    action: target,
                };
                self.project.midi.push(mapping.clone());
                out.project_changed = true;
                out.learned = Some(mapping);
                return out;
            }
            self.learn_target = Some(target);
        }

        let actions: Vec<(MidiAction, MidiType)> = self
            .project
            .midi
            .iter()
            .filter(|m| {
                m.channel == channel
                    && m.number == d1
                    && match m.kind {
                        MidiType::Note => is_note_on || is_note_off,
                        MidiType::Cc => is_cc,
                    }
            })
            .map(|m| (m.action.clone(), m.kind))
            .collect();
        for (action, kind) in actions {
            // A pad mapped to a fader-style target must not slam it to zero
            // on release — notes drive continuous targets by velocity, press
            // only.
            let continuous = matches!(
                action,
                MidiAction::LayerMaster { .. } | MidiAction::Grand | MidiAction::Speed | MidiAction::Haze
            );
            if kind == MidiType::Note && continuous && !is_note_on {
                continue;
            }
            let pressed = if is_cc { d2 > 63 } else { is_note_on };
            if self.run_action(&action, pressed, d2 as f64 / 127.0, t) {
                out.project_changed = true;
            }
        }
        out
    }

    /// Returns true when the action mutated the project (needs broadcast+save).
    pub fn run_action(&mut self, a: &MidiAction, pressed: bool, value: f64, t: f64) -> bool {
        match a {
            MidiAction::Cell { layer_id, col } => {
                if pressed {
                    self.trigger(layer_id, *col, t);
                } else {
                    self.release(layer_id, *col, t);
                }
                false
            }
            MidiAction::Column { col } => {
                if pressed {
                    self.trigger_column(*col, t);
                }
                false
            }
            MidiAction::LayerClear { layer_id } => {
                if pressed {
                    self.clear_layer(layer_id, t);
                }
                false
            }
            MidiAction::LayerMaster { layer_id } => {
                if let Some(layer) = self.project.layers.iter_mut().find(|l| &l.id == layer_id) {
                    layer.master = clamp01(value);
                    true
                } else {
                    false
                }
            }
            MidiAction::Grand => {
                self.master = clamp01(value);
                false
            }
            MidiAction::Speed => {
                self.speed = 0.25 * 16f64.powf(clamp01(value));
                false
            }
            MidiAction::Haze => {
                self.project.settings.haze = clamp01(value);
                true
            }
            MidiAction::Tap => {
                if pressed {
                    self.clock.tap(t);
                }
                false
            }
            MidiAction::Blackout => {
                if pressed {
                    self.blackout = !self.blackout;
                }
                false
            }
            MidiAction::DeckNext => pressed && self.deck_step(1),
            MidiAction::DeckPrev => pressed && self.deck_step(-1),
        }
    }

    /// Swap in a different project wholesale (open/new): live look state,
    /// fades, and held flashes all reset — a fresh show, not an edit.
    pub fn replace_project(&mut self, p: Project) {
        self.project = p;
        self.ensure_decks();
        self.live.clear();
    }

    pub fn update_project(&mut self, p: Project) {
        self.project = p;
        self.ensure_decks();
        self.reconcile();
    }

    fn reconcile(&mut self) {
        let layer_ids: std::collections::HashSet<&str> =
            self.project.layers.iter().map(|l| l.id.as_str()).collect();
        self.live.retain(|id, _| layer_ids.contains(id.as_str()));
        for live in self.live.values_mut() {
            if let Some(id) = &live.look_id {
                if !self.project.looks.contains_key(id) {
                    live.look_id = None;
                }
            }
            if let Some(id) = &live.prev_id {
                if !self.project.looks.contains_key(id) {
                    live.prev_id = None;
                }
            }
        }
    }

    /// Apply an MVR import bundle: ensure universes exist, add profiles,
    /// fixtures, and a group per MVR layer. Returns a summary string.
    fn apply_mvr(&mut self, bundle: crate::mvr::MvrBundle, replace: bool, t: f64) -> String {
        if replace {
            self.project.fixtures.clear();
            self.project.groups.clear();
            for layer in &mut self.project.layers {
                for c in &mut layer.cells {
                    *c = None;
                }
            }
            self.project.looks.clear();
            self.reconcile();
            let _ = t;
        }
        for (id, p) in bundle.profiles {
            self.project.profiles.insert(id, p);
        }
        let mut fixture_ids: Vec<String> = Vec::new();
        for f in &bundle.fixtures {
            let universe_id = match self
                .project
                .universes
                .iter()
                .find(|u| u.artnet_universe == f.universe)
            {
                Some(u) => u.id.clone(),
                None => {
                    let id = uid("u");
                    self.project.universes.push(crate::types::UniverseCfg {
                        id: id.clone(),
                        label: format!("MVR U{}", f.universe),
                        artnet_universe: f.universe,
                        sacn_universe: f.universe.max(1),
                        artnet: true,
                        sacn: false,
                        unicast: None,
                    });
                    id
                }
            };
            let fid = uid("fx");
            fixture_ids.push(fid.clone());
            self.project.fixtures.push(crate::types::Fixture {
                id: fid,
                name: f.name.clone(),
                profile_id: f.profile_id.clone(),
                universe_id,
                address: f.address,
                pos: crate::types::Vec3 { x: f.pos[0], y: f.pos[1], z: f.pos[2] },
                rot_y: f.rot_y,
            });
        }
        for g in &bundle.groups {
            let mut heads: Vec<crate::types::HeadRef> = Vec::new();
            for &fi in &g.fixtures {
                let Some(fid) = fixture_ids.get(fi) else { continue };
                let Some(f) = bundle.fixtures.get(fi) else { continue };
                let n = self
                    .project
                    .profiles
                    .get(&f.profile_id)
                    .map(|p| p.heads.len())
                    .unwrap_or(1);
                for h in 0..n {
                    heads.push(crate::types::HeadRef { fixture_id: fid.clone(), head: h });
                }
            }
            if !heads.is_empty() {
                self.project.groups.push(crate::types::Group {
                    id: uid("g"),
                    name: g.name.clone(),
                    heads,
                });
            }
        }
        let mut msg = format!(
            "imported {} fixture(s), {} group(s)",
            bundle.fixtures.len(),
            bundle.groups.len()
        );
        if !bundle.warnings.is_empty() {
            msg.push_str(&format!(" · {} warning(s): {}", bundle.warnings.len(), bundle.warnings.join("; ")));
        }
        msg
    }

    /// Handle one protocol command. Mirrors the Node engine's handleCommand.
    pub fn handle_command(&mut self, cmd: Command, t: f64) -> Outcome {
        let mut out = Outcome::default();
        match cmd {
            Command::Hello => {}
            Command::Trigger { layer_id, col } => self.trigger(&layer_id, col, t),
            Command::Release { layer_id, col } => self.release(&layer_id, col, t),
            Command::ClearLayer { layer_id } => self.clear_layer(&layer_id, t),
            Command::Column { col } => self.trigger_column(col, t),
            Command::SetBpm { bpm } => self.clock.set_bpm(bpm, t),
            Command::Tap => {
                self.clock.tap(t);
                out.align_phase = true;
            }
            Command::Resync => {
                self.clock.resync(t);
                out.align_phase = true;
            }
            Command::SetSpeed { v } => self.speed = clamp(v, 0.1, 8.0),
            Command::SetMaster { v } => self.master = clamp01(v),
            Command::SetLayerMaster { layer_id, v } => {
                if let Some(layer) = self.project.layers.iter_mut().find(|l| l.id == layer_id) {
                    layer.master = clamp01(v);
                    out.project_changed = true;
                }
            }
            Command::SetBlackout { v } => self.blackout = v,
            Command::Projects
            | Command::NewProject { .. }
            | Command::OpenProject { .. }
            | Command::SaveProjectAs { .. } => {
                // handled by the engine loop (filesystem access lives there)
            }
            Command::SetLink { on } => {
                // the engine loop watches this flag and drives the Link session
                self.project.sync.link_enabled = on;
                out.project_changed = true;
                out.save_requested = true;
            }
            Command::SetHaze { v } => {
                self.project.settings.haze = clamp01(v);
                out.project_changed = true;
            }
            Command::SetHazeFan { v } => {
                self.project.settings.haze_fan = clamp01(v);
                out.project_changed = true;
            }
            Command::UpdateProject { project } => {
                self.update_project(*project);
                out.project_changed = true;
            }
            Command::SwitchDeck { deck_id } => {
                if self.switch_deck(&deck_id) {
                    out.project_changed = true;
                }
            }
            Command::Midi { status, d1, d2 } => {
                let midi_out = self.apply_midi(status, d1, d2, t);
                out.project_changed |= midi_out.project_changed;
                out.learned = midi_out.learned;
            }
            Command::Learn { action } => self.learn_target = action,
            Command::ImportGdtf { name, data } => {
                let result = base64_decode(&data).and_then(|bytes| crate::gdtf::parse_gdtf(&bytes));
                match result {
                    Ok(profiles) => {
                        let ids: Vec<String> = profiles.iter().map(|p| p.id.clone()).collect();
                        for p in profiles {
                            self.project.profiles.insert(p.id.clone(), p);
                        }
                        out.project_changed = true;
                        out.import_result = Some((
                            true,
                            format!("{name}: imported {} mode(s)", ids.len()),
                            ids,
                        ));
                    }
                    Err(e) => {
                        out.import_result = Some((false, format!("{name}: {e}"), vec![]));
                    }
                }
            }
            Command::ImportMvr { name, data, replace } => {
                let result = base64_decode(&data).and_then(|bytes| crate::mvr::parse_mvr(&bytes));
                match result {
                    Ok(bundle) => {
                        let n = self.apply_mvr(bundle, replace, t);
                        out.project_changed = true;
                        out.import_result = Some((true, format!("{name}: {n}"), vec![]));
                    }
                    Err(e) => out.import_result = Some((false, format!("{name}: {e}"), vec![])),
                }
            }
            Command::LaunchPreviz => out.launch_previz = true,
            Command::Save => out.save_requested = true,
        }
        out
    }
}
