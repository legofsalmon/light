use std::collections::HashMap;

use crate::clock::BeatClock;
use crate::types::{
    clamp, clamp01, soft_clamp, Command, MidiAction, MidiMapping, MidiType, Project, SoftField,
    SoftSnap,
};

/// Soft overrides for one (look, part): part-level fields plus per-effect
/// fields. Grouped so the renderer resolves a whole part with one lookup.
#[derive(Debug, Clone, Default)]
pub struct SoftPatch {
    pub params: HashMap<SoftField, f64>,
    pub effects: HashMap<String, HashMap<SoftField, f64>>,
}

/// Route one soft part-field onto PartParams. Hue/Sat address the colour
/// components, creating the colour with the other component at its default
/// (s 1 / h 0) when the look never set one. Mirrors applySoftParam in
/// engine/state.ts — identical routing or stored shows diverge.
pub fn apply_soft_param(params: &mut crate::types::PartParams, field: SoftField, v: f64) {
    match field {
        SoftField::Hue => {
            let s = params.color.map_or(1.0, |c| c.s);
            params.color = Some(crate::types::ColorHS { h: v, s });
        }
        SoftField::Sat => {
            let h = params.color.map_or(0.0, |c| c.h);
            params.color = Some(crate::types::ColorHS { h, s: v });
        }
        SoftField::Dimmer => params.dimmer = Some(v),
        SoftField::White => params.white = Some(v),
        SoftField::RingFx => params.ring_fx = Some(v),
        SoftField::Strobe => params.strobe = Some(v),
        SoftField::MotorValue => params.motor_value = Some(v),
        SoftField::Pan => params.pan = Some(v),
        SoftField::Tilt => params.tilt = Some(v),
        SoftField::Haze => params.haze = Some(v),
        SoftField::Fan => params.fan = Some(v),
        SoftField::Zoom => params.zoom = Some(v),
        SoftField::Focus => params.focus = Some(v),
        SoftField::Iris => params.iris = Some(v),
        SoftField::Frost => params.frost = Some(v),
        SoftField::Cto => params.cto = Some(v),
        SoftField::GoboRotate => params.gobo_rotate = Some(v),
        SoftField::PrismRotate => params.prism_rotate = Some(v),
        // effect-only fields never reach a params patch (set_soft routes)
        SoftField::Rate | SoftField::Size | SoftField::Spread | SoftField::Width
        | SoftField::Phase | SoftField::Mix => {}
    }
}

/// Route one soft effect-field onto an Effect.
pub fn apply_soft_effect(e: &mut crate::types::Effect, field: SoftField, v: f64) {
    match field {
        SoftField::Rate => e.rate = v,
        SoftField::Size => e.size = v,
        SoftField::Spread => e.spread = v,
        SoftField::Width => e.width = v,
        SoftField::Phase => e.phase = v,
        SoftField::Mix => e.mix = v,
        _ => {}
    }
}

#[derive(Debug, Clone)]
pub struct LayerLive {
    pub look_id: Option<String>,
    pub prev_id: Option<String>,
    pub col: Option<usize>,
    pub fade_start: f64,
    pub fade_dur: f64, // seconds
    /// Which client is holding this momentary look, if any. None while nothing
    /// is held; a hold started by MIDI/OSC is owned by `LOCAL_CLIENT` so that a
    /// browser disconnecting never drops it.
    pub held_by: Option<u64>,
}

impl Default for LayerLive {
    fn default() -> Self {
        LayerLive { look_id: None, prev_id: None, col: None, fade_start: 0.0, fade_dur: 0.0, held_by: None }
    }
}

/// Owner for holds started by MIDI, OSC or any non-socket source. No WS client
/// ever gets this id, so such a hold survives every browser disconnect.
pub const LOCAL_CLIENT: u64 = u64::MAX;

static UID_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

/// Fresh id. The counter alone restarts at 1 every launch, so a second MVR
/// import after a restart used to hand out ids the project already held —
/// two physical fixtures sharing an id merge into one head in the renderer
/// and their group references become ambiguous. Seeding with the boot time
/// (as the Node reference does) keeps ids unique across runs.
pub fn uid(prefix: &str) -> String {
    static BOOT_MS: std::sync::OnceLock<u64> = std::sync::OnceLock::new();
    let boot = *BOOT_MS.get_or_init(|| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    });
    uid_with(prefix, boot, UID_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed))
}

/// Split out so the cross-restart property is testable: the boot stamp is what
/// keeps two runs from issuing the same id, and a unit test cannot restart the
/// process to prove it.
fn uid_with(prefix: &str, boot: u64, n: u64) -> String {
    format!("{prefix}-r{boot:x}{n:x}")
}

#[cfg(test)]
mod uid_tests {
    use super::uid_with;

    #[test]
    fn ids_differ_across_restarts() {
        // same counter values, different launch — the case that used to collide
        // and silently merge two MVR-imported fixtures into one head
        let run1: Vec<String> = (1..=3).map(|n| uid_with("fx", 0x1a0000e8752, n)).collect();
        let run2: Vec<String> = (1..=3).map(|n| uid_with("fx", 0x1a0000e9b61, n)).collect();
        for a in &run1 {
            assert!(!run2.contains(a), "id {a} reissued after a restart");
        }
    }

    #[test]
    fn ids_differ_within_a_run() {
        let ids: Vec<String> = (1..=64).map(|n| uid_with("fx", 7, n)).collect();
        let mut sorted = ids.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(sorted.len(), ids.len(), "counter reused an id within one run");
    }
}

/// A cheap, float-free fingerprint of what a profile does on the wire.
/// Footprint alone is not enough: an MVR-exported stub profile (every channel
/// named "Dimmer1..N") and the real manufacturer GDTF can share a footprint
/// and mean entirely different things, which is exactly the case an operator
/// re-imports to fix. Ordered channel names catch it. No floats, so the two
/// engines cannot disagree the way a structural f64 compare would.
fn layout_sig(p: &crate::cprofile::CompiledProfile) -> String {
    let names: Vec<&str> = p.channels.iter().map(|c| c.name.as_str()).collect();
    // The head layout signs too (B1): since the layout editor, offsets and
    // row/col are operator-authored state — a re-import that changes them is a
    // replacement worth announcing. Engine-local strings, never compared
    // across engines, so the float formatting needs no parity discipline.
    let heads: Vec<String> = p
        .heads
        .iter()
        .map(|h| format!("{:.4},{:.4},{},{}", h.offset, h.offset_y, h.row, h.col))
        .collect();
    format!("{}|{}|{}|{}", p.footprint, p.heads.len(), names.join(","), heads.join(";"))
}

/// An operator-authored pixel layout must survive a re-import that brings no
/// layout of its own. The flat fallback is recognisable — every head at
/// (row 0, col 0) — and a stored non-flat layout on a same-shape profile is
/// strictly better informed than that, so it wins, silently (nothing is
/// lost, so there is nothing to warn about). A file that carries REAL parsed
/// geometry has non-flat heads and stays authoritative — re-importing a
/// corrected file must still correct, and describe_profile_replacement
/// announces the layout change.
fn preserve_authored_layout(project: &Project, incoming: &mut crate::cprofile::CompiledProfile) {
    let Some(existing) = project.profiles.get(&incoming.id) else { return };
    if existing.heads.len() != incoming.heads.len() {
        return;
    }
    let flat =
        |hs: &[crate::cprofile::CHead]| hs.iter().all(|h| h.row == 0 && h.col == 0);
    if flat(&incoming.heads) && !flat(&existing.heads) {
        for (inc, ex) in incoming.heads.iter_mut().zip(&existing.heads) {
            inc.offset = ex.offset;
            inc.offset_y = ex.offset_y;
            inc.row = ex.row;
            inc.col = ex.col;
        }
    }
}

/// Replacing a profile that fixtures are patched to rewrites what every one of
/// their addresses means. Overwriting is correct — it is the whole point of
/// re-importing a corrected file — but it must never be silent.
fn describe_profile_replacement(
    project: &Project,
    incoming: &crate::cprofile::CompiledProfile,
) -> Option<String> {
    let existing = project.profiles.get(&incoming.id)?;
    if layout_sig(existing) == layout_sig(incoming) {
        return None;
    }
    let users: Vec<&str> = project
        .fixtures
        .iter()
        .filter(|f| f.profile_id == incoming.id)
        .map(|f| f.name.as_str())
        .collect();
    if users.is_empty() {
        return None; // nothing patched to it — a plain library update
    }
    let shown: Vec<&str> = users.iter().take(3).copied().collect();
    let more = users.len() - shown.len();
    let grew = if incoming.footprint > existing.footprint {
        " · footprint GREW — check the patch for address overlaps"
    } else {
        ""
    };
    Some(format!(
        "{} {} · {} replaced in place ({}ch → {}ch): {} patched fixture(s) now use the new layout — {}{}{}",
        incoming.manufacturer,
        incoming.model,
        incoming.mode,
        existing.footprint,
        incoming.footprint,
        users.len(),
        shown.join(", "),
        if more > 0 { format!(" +{more} more") } else { String::new() },
        grew,
    ))
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
    /// the engine rewrote an updateProject it was given, so the client that
    /// sent it is now holding something different from what the engine has
    pub repaired_submission: bool,
    /// the undo history gained, lost or moved a step — clients need the
    /// `history` event
    pub history_changed: bool,
}

/// One step of the engine's undo history: the project as it was BEFORE the
/// edit named by `label` (review M16, backlog #12). The engine owns the history
/// so every client shares one — a ⌘Z on the laptop and a ⌘Z on the tablet step
/// the same show back the same way. Mirrors engine/state.ts.
#[derive(Clone)]
pub struct HistoryEntry {
    pub label: String,
    pub project: Project,
}

/// Steps kept. Each is a whole project, which bounds the memory: a big show
/// with compiled profiles is a few MB, and a hundred of those is still less
/// than the browser holds.
pub const HISTORY_CAP: usize = 100;

/// Minimal base64 decode (standard alphabet, padding optional) — the import
/// path only; not worth a dependency.
///
/// Public so the app shell's Share downloader can test that what it encodes is
/// exactly what this decodes. The two halves of that trip are written by hand
/// in two crates; a known-answer test on one side proves nothing about the
/// other.
pub fn base64_decode(s: &str) -> Result<Vec<u8>, String> {
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
    /// Silenced fixtures — a stuck or dead unit is taken out of the show
    /// without touching the patch (which would re-fan every chase).
    /// Transient: a mute is for tonight, not a property of the show.
    pub muted: std::collections::HashSet<String>,
    /// Fixture driven to full white so it can be found on the truss.
    pub identify: Option<String>,
    /// Look being auditioned in the previz. Transient, never persisted, and it
    /// never reaches DMX — the renderer resolves it into a separate head set
    /// that only the snapshot carries.
    pub preview_look: Option<String>,
    /// universe id -> channel(0-511) -> value. Raw override, applied last.
    pub overrides: HashMap<String, HashMap<usize, u8>>,
    /// P1 soft overrides: live rides over stored look data, keyed
    /// (look id, part id) and grouped per part so the renderer resolves a
    /// whole part with ONE lookup. Runtime-only — SoftCommit writes them into
    /// the project, SoftClear/AllStop/project switch drops them.
    pub soft: HashMap<(String, String), SoftPatch>,
    /// Live Named Control positions (P3). Runtime-only; the STORED position
    /// is Control.value in the project. Cleared with the soft layer.
    pub control_live: HashMap<String, f64>,
    pub learn_target: Option<MidiAction>,
    /// TEST ONLY — a pending effect-clock pin (LIGHT_TEST_CLOCK gated), consumed
    /// by the engine loop before the next tick. Not show state; never persisted.
    pub pending_pin: Option<f64>,
    /// Monotonic project generation. Bumped on every change to the project, and
    /// echoed to clients, which quote it back as updateProject.base_gen so a
    /// stale full-project write (composed before a deck switch, a project open,
    /// or another client's edit) can be rejected instead of clobbering the newer
    /// state. Runtime-only — never saved, never reset on load.
    pub gen: u64,
    /// Undo history: the project before each recorded edit, newest last.
    pub history: Vec<HistoryEntry>,
    /// Steps undone and not yet redone; the next recorded edit drops them.
    pub redone: Vec<HistoryEntry>,
    /// Who opened the newest step, when it was a client's project write —
    /// only that client's next write may coalesce into it.
    last_push_owner: Option<u64>,
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
            muted: std::collections::HashSet::new(),
            identify: None,
            preview_look: None,
            overrides: HashMap::new(),
            soft: HashMap::new(),
            control_live: HashMap::new(),
            learn_target: None,
            gen: 1,
            pending_pin: None,
            history: Vec::new(),
            redone: Vec::new(),
            last_push_owner: None,
        };
        st.ensure_decks();
        st.reconcile();
        st
    }

    /// Advance the project generation. Called wherever the project content
    /// changes, so the value clients quote back always reflects the latest
    /// authoritative state.
    pub fn bump_gen(&mut self) {
        self.gen = self.gen.wrapping_add(1);
    }

    /// Older projects have no pages — the current grid becomes deck 1, and
    /// the active deck id must always resolve. Mirrors the Node sanitiser.
    /// Returns true if it CHANGED the project.
    ///
    /// That matters beyond bookkeeping: an updateProject echo is withheld from
    /// the client that sent it, on the grounds that the client already holds
    /// that state. It does not, if this rewrote it — and then every other client
    /// learns about the repair while the one holding the wrong copy does not,
    /// and re-sends the unrepaired version on its next edit.
    fn ensure_decks(&mut self) -> bool {
        let mut changed = false;
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
            changed = true;
        }
        let active_ok = self
            .project
            .active_deck_id
            .as_ref()
            .map(|id| self.project.decks.iter().any(|d| &d.id == id))
            .unwrap_or(false);
        if !active_ok {
            self.project.active_deck_id = Some(self.project.decks[0].id.clone());
            changed = true;
        }
        changed
    }

    /// Switch the active grid page: store the current cells into the outgoing
    /// deck, load the target's. Playing looks keep playing.
    pub fn switch_deck(&mut self, deck_id: &str, t: f64) -> bool {
        if self.project.active_deck_id.as_deref() == Some(deck_id) {
            return false;
        }
        if !self.project.decks.iter().any(|d| d.id == deck_id) {
            return false;
        }
        Self::store_page(&mut self.project);
        self.project.active_deck_id = Some(deck_id.to_string());
        self.load_page();
        // Inside the swap, not at the call sites: every route onto a new page
        // has to release, and a caller that forgets is a blinder latched on for
        // the rest of the show. Node puts it here too (engine/state.ts) — the
        // two engines are now structurally the same rather than coincidentally
        // equal, which is what let `deck_step` diverge unnoticed.
        self.release_holds_for_deck_change(t);
        true
    }

    /// Held flashes must not survive a page change: the cell they were taken
    /// from is swapped out, so the note-off can never find them again and the
    /// blinder stays lit for the rest of the show.
    fn release_holds_for_deck_change(&mut self, t: f64) {
        self.release_all_held(t, None);
    }

    /// Write the live page (columns and every layer's cells) into its deck, so
    /// the project carries every song complete. switch_deck does it for the
    /// outgoing deck; a history snapshot needs it for the active one.
    fn store_page(p: &mut Project) {
        let active = p.active_deck_id.clone();
        if let Some(d) = p.decks.iter_mut().find(|d| Some(&d.id) == active.as_ref()) {
            d.columns = p.columns.clone();
            d.cells = p.layers.iter().map(|l| (l.id.clone(), l.cells.clone())).collect();
        }
    }

    /// Load the active deck's columns and cells into the live grid — the
    /// second half of switch_deck, shared with the history restore.
    fn load_page(&mut self) {
        let Some(target) = self
            .project
            .active_deck_id
            .as_ref()
            .and_then(|id| self.project.decks.iter().find(|d| &d.id == id))
            .cloned()
        else {
            return;
        };
        self.project.columns = target.columns.clone();
        let n = self.project.columns.len();
        for l in &mut self.project.layers {
            let mut cells = target.cells.get(&l.id).cloned().unwrap_or_default();
            cells.resize(n, None);
            l.cells = cells;
        }
    }

    // --- undo history (review M16, backlog #12). One history per engine, fed by
    // every recorded edit whoever made it. Steps hold the project BEFORE the
    // edit; what is played rather than edited — song switches, masters, haze,
    // nudges, blackout — is not a step and is kept when a step is undone.

    /// The project as a history entry holds it: a copy with the live page
    /// stored into its deck.
    fn snapshot(&self) -> Project {
        let mut p = self.project.clone();
        Self::store_page(&mut p);
        p
    }

    fn push_entry(&mut self, project: Project, label: &str) {
        self.history.push(HistoryEntry { label: label.to_string(), project });
        if self.history.len() > HISTORY_CAP {
            self.history.remove(0);
        }
        self.redone.clear();
    }

    /// Record the state before an edit that is not a client's project write —
    /// an import, a Keep, a learned mapping. Never coalesces.
    pub fn record(&mut self, label: &str) {
        let snap = self.snapshot();
        self.push_entry(snap, label);
        self.last_push_owner = None;
    }

    /// Record the state before a client's project write. `coalesce` is the
    /// client saying this write continues its previous one (a drag): the open
    /// step keeps its snapshot and its name — but only if that step is this
    /// client's and nothing was undone since. Returns whether a step opened.
    pub fn record_edit(&mut self, label: &str, owner: u64, coalesce: bool) -> bool {
        if coalesce && self.redone.is_empty() && self.last_push_owner == Some(owner) && !self.history.is_empty() {
            return false;
        }
        let snap = self.snapshot();
        self.push_entry(snap, label);
        self.last_push_owner = Some(owner);
        true
    }

    /// Put a history snapshot back as the project, keeping what is live rather
    /// than edited: the page the operator is on (a song switch is navigation),
    /// the layer masters, the haze and the Link switch. The snapshot's copy of
    /// the current page is loaded into the grid, so an edit made on song 1 is
    /// undone even while song 2 is up.
    fn restore(&mut self, mut p: Project) {
        p.active_deck_id = self.project.active_deck_id.clone();
        for l in &mut p.layers {
            if let Some(now) = self.project.layers.iter().find(|x| x.id == l.id) {
                l.master = now.master;
            }
        }
        p.settings.haze = self.project.settings.haze;
        p.settings.haze_fan = self.project.settings.haze_fan;
        p.sync.link_enabled = self.project.sync.link_enabled;
        self.project = p;
        self.ensure_decks();
        self.load_page();
        self.reconcile();
        self.last_push_owner = None;
    }

    /// Step back. False when there is nothing to undo.
    pub fn undo(&mut self) -> bool {
        let Some(entry) = self.history.pop() else { return false };
        let now = self.snapshot();
        self.redone.push(HistoryEntry { label: entry.label, project: now });
        self.restore(entry.project);
        true
    }

    /// Step forward again. False when there is nothing to redo.
    pub fn redo(&mut self) -> bool {
        let Some(entry) = self.redone.pop() else { return false };
        let now = self.snapshot();
        self.history.push(HistoryEntry { label: entry.label, project: now });
        if self.history.len() > HISTORY_CAP {
            self.history.remove(0);
        }
        self.restore(entry.project);
        true
    }

    pub fn clear_history(&mut self) {
        self.history.clear();
        self.redone.clear();
        self.last_push_owner = None;
    }

    pub fn undo_label(&self) -> Option<&str> {
        self.history.last().map(|e| e.label.as_str())
    }

    pub fn redo_label(&self) -> Option<&str> {
        self.redone.last().map(|e| e.label.as_str())
    }

    pub fn deck_step(&mut self, dir: i32, t: f64) -> bool {
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
        // CLAMP, do not wrap. The APC bank arrows are an eyes-off control: one
        // press too many at the last song used to land silently on song 1, and
        // with Resolume follow-columns armed the next column launch fires the
        // opener's looks. Every console clamps here. Mirrored in
        // engine/state.ts and in the UI's [ / ] handler.
        let j = (i + dir).clamp(0, n - 1);
        if j == i {
            return false; // already at the end — nothing moved
        }
        let id = self.project.decks[j as usize].id.clone();
        self.switch_deck(&id, t)
    }

    pub fn layer_live(&mut self, layer_id: &str) -> &mut LayerLive {
        self.live.entry(layer_id.to_string()).or_default()
    }

    pub fn trigger(&mut self, layer_id: &str, col: usize, t: f64, owner: u64) {
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
        live.held_by = if flash { Some(owner) } else { None };
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
        live.held_by = None;
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
        live.held_by = None;
    }

    /// Gig safety: if the client holding a momentary flash look vanishes, its
    /// release will never arrive — drop the holds it owned. `owner: None` drops
    /// every hold regardless of who started it (all-stop, project reload).
    pub fn release_all_held(&mut self, t: f64, owner: Option<u64>) {
        for live in self.live.values_mut() {
            match (live.held_by, owner) {
                (None, _) => continue,                       // nothing held here
                (Some(h), Some(o)) if h != o => continue,    // someone else's hold
                _ => {}
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
            live.held_by = None;
        }
    }

    /// Column = cue: fire non-flash cells, clear empty ones. Flash looks are
    /// skipped so a cue can never latch a blinder on.
    pub fn trigger_column(&mut self, col: usize, t: f64) {
        // A column this show does not have is not "a column of empty cells" —
        // it is not addressed to us at all. Resolume compositions routinely run
        // wider than the light show, and treating the overshoot as empty would
        // clear every layer and black the rig out for as long as the VJ worked
        // above our last column. The empty-cell clear below stays exactly as it
        // was: it is what makes a "Blackout" column work.
        if col >= self.project.columns.len() {
            return;
        }
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
                Some(_) => self.trigger(&id, col, t, LOCAL_CLIENT),
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
                self.record("map a MIDI control");
                self.project.midi.push(mapping.clone());
                out.project_changed = true;
                out.history_changed = true;
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
             | MidiAction::Control { .. });
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
                    self.trigger(layer_id, *col, t, LOCAL_CLIENT);
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
            MidiAction::DeckNext => pressed && self.deck_step(1, t),
            MidiAction::DeckPrev => pressed && self.deck_step(-1, t),
            MidiAction::Control { control_id } => {
                let id = control_id.clone();
                self.set_control(&id, value);
                false
            }
        }
    }

    /// Swap in a different project wholesale (open/new): live look state,
    /// fades, and held flashes all reset — a fresh show, not an edit.
    /// Opening a show is a boot into that show: everything transient from the
    /// last one has to go. Clearing `live` alone is not enough. `overrides`,
    /// `identify` and `muted` are keyed by ids that every project derived from
    /// the shipped default shares — `u1`, `u0`, `derby1`, `hazer` — so they do
    /// not go stale on a switch, they silently re-bind to the incoming show and
    /// keep forcing. `AllStop` already treats all three as panic state; the
    /// switch path simply never did.
    ///
    /// Haze is zeroed for the same reason `run()` zeroes it at boot: the hazer
    /// must never start pumping on its own, and the operator's reflex will not
    /// stop it, because the renderer's blackout branch deliberately leaves haze
    /// alone. The fan goes with it — it runs independently of the haze level
    /// and it is the audible one.
    /// Store profiles a worker has already compiled from a .gdtf.
    ///
    /// Cheap: a HashMap insert per DMX mode. The expensive half — base64 decode
    /// and XML parse — happens off the tick thread.
    pub fn apply_gdtf(
        &mut self,
        name: &str,
        parsed: Result<Vec<crate::cprofile::CompiledProfile>, String>,
        credit: Option<String>,
    ) -> Outcome {
        let mut out = Outcome::default();
        match parsed {
            Ok(profiles) => {
                self.record(&format!("import “{name}”"));
                out.history_changed = true;
                let ids: Vec<String> = profiles.iter().map(|p| p.id.clone()).collect();
                let mut replaced: Vec<String> = Vec::new();
                for mut p in profiles {
                    // Attribution travels with the profile into the project
                    // file — see CompiledProfile::credit.
                    p.credit = credit.clone();
                    preserve_authored_layout(&self.project, &mut p);
                    if let Some(note) = describe_profile_replacement(&self.project, &p) {
                        replaced.push(note);
                    }
                    self.project.profiles.insert(p.id.clone(), p);
                }
                out.project_changed = true;
                let mut msg = format!("{name}: imported {} mode(s)", ids.len());
                for note in &replaced {
                    msg.push_str(&format!(" · {note}"));
                }
                out.import_result = Some((true, msg, ids));
            }
            Err(e) => out.import_result = Some((false, format!("{name}: {e}"), vec![])),
        }
        out
    }

    /// Apply an MVR scene a worker has already parsed.
    pub fn apply_mvr_parsed(
        &mut self,
        name: &str,
        parsed: Result<crate::mvr::MvrBundle, String>,
        replace: bool,
        t: f64,
    ) -> Outcome {
        let mut out = Outcome::default();
        match parsed {
            Ok(bundle) => {
                self.record(&if replace {
                    format!("replace the rig from “{name}”")
                } else {
                    format!("import “{name}”")
                });
                out.history_changed = true;
                let n = self.apply_mvr(bundle, replace, t);
                out.project_changed = true;
                out.import_result = Some((true, format!("{name}: {n}"), vec![]));
            }
            Err(e) => out.import_result = Some((false, format!("{name}: {e}"), vec![])),
        }
        out
    }

    /// Ingest one soft override (P1). Validates the address against the
    /// CURRENT project and clamps the value at the door, so the renderer never
    /// meets a dangling or out-of-range ride. value None clears the entry.
    /// Mirrors setSoft in engine/state.ts.
    pub fn set_soft(
        &mut self,
        look_id: &str,
        part_id: &str,
        effect_id: Option<&str>,
        field: SoftField,
        value: Option<f64>,
    ) -> bool {
        let Some(look) = self.project.looks.get(look_id) else { return false };
        let Some(part) = look.parts.iter().find(|pt| pt.id == part_id) else { return false };
        if let Some(eid) = effect_id {
            if !part.effects.iter().any(|e| e.id == eid) {
                return false;
            }
        }
        let key = (look_id.to_string(), part_id.to_string());
        match value {
            None => {
                let Some(patch) = self.soft.get_mut(&key) else { return false };
                if let Some(eid) = effect_id {
                    if let Some(ef) = patch.effects.get_mut(eid) {
                        ef.remove(&field);
                        if ef.is_empty() {
                            patch.effects.remove(eid);
                        }
                    }
                } else {
                    patch.params.remove(&field);
                }
                if patch.params.is_empty() && patch.effects.is_empty() {
                    self.soft.remove(&key);
                }
                true
            }
            Some(raw) => {
                let Some(v) = soft_clamp(field, raw) else { return false };
                let patch = self.soft.entry(key).or_default();
                if let Some(eid) = effect_id {
                    patch.effects.entry(eid.to_string()).or_default().insert(field, v);
                } else {
                    patch.params.insert(field, v);
                }
                true
            }
        }
    }

    /// Flat view of the live rides, for the snapshot. Sorted for a stable
    /// wire order (HashMap iteration is arbitrary).
    pub fn soft_entries(&self) -> Vec<SoftSnap> {
        let mut out: Vec<SoftSnap> = Vec::new();
        for ((look_id, part_id), patch) in &self.soft {
            for (field, value) in &patch.params {
                out.push(SoftSnap {
                    look_id: look_id.clone(),
                    part_id: part_id.clone(),
                    effect_id: None,
                    field: *field,
                    value: *value,
                });
            }
            for (effect_id, fields) in &patch.effects {
                for (field, value) in fields {
                    out.push(SoftSnap {
                        look_id: look_id.clone(),
                        part_id: part_id.clone(),
                        effect_id: Some(effect_id.clone()),
                        field: *field,
                        value: *value,
                    });
                }
            }
        }
        out.sort_by(|a, b| {
            (&a.look_id, &a.part_id, &a.effect_id, format!("{:?}", a.field))
                .cmp(&(&b.look_id, &b.part_id, &b.effect_id, format!("{:?}", b.field)))
        });
        out
    }

    /// Store: write every soft value into the project, then clear. Returns
    /// whether anything was written (→ gen bump + broadcast). Mirrors
    /// softCommit in engine/state.ts — identical field routing or the two
    /// engines' stored shows diverge.
    pub fn soft_commit(&mut self) -> bool {
        let mut changed = false;
        let soft = std::mem::take(&mut self.soft);
        for ((look_id, part_id), patch) in soft {
            let Some(look) = self.project.looks.get_mut(&look_id) else { continue };
            let Some(part) = look.parts.iter_mut().find(|pt| pt.id == part_id) else { continue };
            for (field, v) in patch.params {
                apply_soft_param(&mut part.params, field, v);
                changed = true;
            }
            for (effect_id, fields) in patch.effects {
                let Some(e) = part.effects.iter_mut().find(|x| x.id == effect_id) else { continue };
                for (field, v) in fields {
                    apply_soft_effect(e, field, v);
                    changed = true;
                }
            }
        }
        changed
    }

    /// Move a Named Control (P3): resolve every link through the soft layer.
    /// Each link maps v (0..1) onto its bracket min + (max − min)·v; the soft
    /// door clamps per-field, so a bracket cannot push a parameter out of
    /// range. Dangling links are skipped — they stay inspectable in the
    /// control's data. Mirrors setControl in engine/state.ts.
    pub fn set_control(&mut self, control_id: &str, value: f64) -> bool {
        if !value.is_finite() {
            return false;
        }
        let v = clamp01(value);
        let Some(control) = self.project.controls.iter().find(|c| c.id == control_id) else {
            return false;
        };
        let links: Vec<crate::types::ControlLink> = control.links.clone();
        for l in links {
            let mapped = l.min + (l.max - l.min) * v;
            self.set_soft(&l.look_id, &l.part_id, l.effect_id.as_deref(), l.field, Some(mapped));
        }
        self.control_live.insert(control_id.to_string(), v);
        true
    }

    /// Live control positions for the snapshot — only those that moved.
    pub fn control_entries(&self) -> Vec<crate::types::ControlSnap> {
        let mut out: Vec<crate::types::ControlSnap> = self
            .control_live
            .iter()
            .map(|(id, value)| crate::types::ControlSnap { id: id.clone(), value: *value })
            .collect();
        out.sort_by(|a, b| a.id.cmp(&b.id));
        out
    }

    /// Drop rides whose look/part/effect no longer exists — called from the
    /// renderer's gen-gated rebuild, so every project change sweeps exactly
    /// once, in both engines, with the same discipline as the geometry cache.
    pub fn sweep_soft(&mut self) {
        // deleted controls must not stream stale live positions in snapshots
        if !self.control_live.is_empty() {
            let controls = &self.project.controls;
            self.control_live.retain(|id, _| controls.iter().any(|c| c.id == *id));
        }
        if self.soft.is_empty() {
            return;
        }
        let project = &self.project;
        self.soft.retain(|(look_id, part_id), patch| {
            let Some(look) = project.looks.get(look_id) else { return false };
            let Some(part) = look.parts.iter().find(|pt| pt.id == *part_id) else { return false };
            patch
                .effects
                .retain(|eid, _| part.effects.iter().any(|e| e.id == *eid));
            !patch.params.is_empty() || !patch.effects.is_empty()
        });
    }

    pub fn replace_project(&mut self, p: Project) {
        self.project = p;
        self.ensure_decks();
        self.clear_history(); // history belongs to the show it was made in
        self.live.clear();
        self.overrides.clear();
        self.soft.clear(); // rides belong to the show they were ridden in
        self.control_live.clear();
        self.identify = None;
        self.muted.clear();
        self.preview_look = None;
        self.project.settings.haze = 0.0;
        self.project.settings.haze_fan = 0.0;
        // A wholesale swap is the biggest project change there is — advance the
        // generation so any in-flight edit composed against the old show is seen
        // as stale and rejected rather than written over the new one.
        self.bump_gen();
    }

    /// Returns true if the engine CHANGED what it was given — in which case the
    /// sender needs the echo it would otherwise be spared. `reconcile` only
    /// prunes live state and never touches the project, so `ensure_decks` is
    /// the only thing here that can rewrite a submission.
    pub fn update_project(&mut self, p: Project) -> bool {
        self.project = p;
        let repaired = self.ensure_decks();
        self.reconcile();
        repaired
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
        let mut replaced: Vec<String> = Vec::new();
        for (id, mut p) in bundle.profiles {
            preserve_authored_layout(&self.project, &mut p);
            if let Some(note) = describe_profile_replacement(&self.project, &p) {
                replaced.push(note);
            }
            self.project.profiles.insert(id, p);
        }
        let mut fixture_ids: Vec<String> = Vec::new();
        let mut new_universes = 0usize;
        for f in &bundle.fixtures {
            let universe_id = match self
                .project
                .universes
                .iter()
                .find(|u| u.artnet_universe == f.universe)
            {
                Some(u) => u.id.clone(),
                None => {
                    new_universes += 1;
                    let id = uid("u");
                    self.project.universes.push(crate::types::UniverseCfg {
                        id: id.clone(),
                        label: format!("MVR U{}", f.universe),
                        artnet_universe: f.universe,
                        sacn_universe: f.universe.max(1),
                        // Output OFF until the operator says otherwise: an
                        // imported scene's universe can collide with a live one
                        // (universe 0 is the factory default on most nodes) and
                        // importing must never start driving a rig.
                        artnet: false,
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
                rot_x: None,
                rot_z: None,
                pan: None,
                tilt: None,
                // MVR carries its own rigging hierarchy; we do not map it onto
                // hand-drawn structure, so an imported fixture starts unparented.
                parent_id: None,
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
                    auto: None, // MVR groups are the file's authored layers, not derived
                });
            }
        }
        let mut msg = format!(
            "imported {} fixture(s), {} group(s)",
            bundle.fixtures.len(),
            bundle.groups.len()
        );
        for note in &replaced {
            msg.push_str(&format!(" · {note}"));
        }
        if new_universes > 0 {
            // the operator has to switch these on deliberately — say so, or the
            // rig looks dead after a clean import
            msg.push_str(&format!(
                " · {new_universes} new universe(s) created with output OFF — enable them in Output"
            ));
        }
        if !bundle.warnings.is_empty() {
            msg.push_str(&format!(" · {} warning(s): {}", bundle.warnings.len(), bundle.warnings.join("; ")));
        }
        msg
    }

    /// Handle one protocol command. Mirrors the Node engine's handleCommand.
    pub fn handle_command(&mut self, cmd: Command, t: f64, owner: Option<u64>) -> Outcome {
        // MIDI, OSC and internal callers have no socket: their holds belong to
        // LOCAL_CLIENT so no browser disconnect can release them.
        let owner = owner.unwrap_or(LOCAL_CLIENT);
        let mut out = Outcome::default();
        match cmd {
            Command::Hello => {}
            Command::Trigger { layer_id, col } => self.trigger(&layer_id, col, t, owner),
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
            Command::SetFixtureMute { fixture_id, on } => {
                if on {
                    self.muted.insert(fixture_id);
                } else {
                    self.muted.remove(&fixture_id);
                }
            }
            Command::Identify { fixture_id } => self.identify = fixture_id,
            // No project_changed: auditioning a look is not an edit, and a
            // project echo per selection click would be absurd.
            Command::PreviewLook { look_id } => self.preview_look = look_id,
            Command::AllStop => {
                // panic: everything dark and quiet, right now
                self.blackout = true;
                let layer_ids: Vec<String> =
                    self.project.layers.iter().map(|l| l.id.clone()).collect();
                for id in layer_ids {
                    self.clear_layer(&id, t);
                }
                self.release_all_held(t, None);
                self.identify = None;
                self.overrides.clear();
                self.soft.clear(); // rides are transient state; panic drops them too
                self.control_live.clear();
                self.project.settings.haze = 0.0;
                self.project.settings.haze_fan = 0.0; // the fan is the audible one
                out.project_changed = true;
            }
            Command::Soft { look_id, part_id, effect_id, field, value } => {
                self.set_soft(&look_id, &part_id, effect_id.as_deref(), field, value);
            }
            Command::SoftCommit => {
                let before = self.snapshot();
                if self.soft_commit() {
                    self.push_entry(before, "keep the nudged values");
                    self.last_push_owner = None;
                    out.project_changed = true;
                    out.history_changed = true;
                }
                self.control_live.clear(); // the fan-out is baked; position spent
            }
            Command::SoftClear => {
                self.soft.clear();
                self.control_live.clear(); // a discarded fan-out has no live position
            }
            Command::SetControl { control_id, value } => {
                self.set_control(&control_id, value);
            }
            Command::SetChannel { universe_id, channel, value } => {
                // protocol is 1-512
                if channel >= 1 && channel <= 512 {
                    let ch = channel - 1;
                    match value {
                        None => {
                            if let Some(map) = self.overrides.get_mut(&universe_id) {
                                map.remove(&ch);
                                if map.is_empty() {
                                    self.overrides.remove(&universe_id);
                                }
                            }
                        }
                        Some(v) => {
                            self.overrides.entry(universe_id).or_default().insert(ch, v);
                        }
                    }
                }
            }
            Command::ClearChannelOverrides => self.overrides.clear(),
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
            // Handled in engine.rs before the state machine ever sees them;
            // these arms exist only for exhaustiveness.
            Command::WatchDmx { .. } => {}
            Command::PinClock { .. } => {}
            Command::UpdateProject { project, base_gen: _, label, coalesce } => {
                // base_gen is a transport-layer concern (staleness rejection in
                // engine.rs); by the time a command reaches the state machine it
                // has been accepted. If the engine repaired what arrived, the
                // sender is the one client that must NOT be spared the echo.
                if self.record_edit(label.as_deref().unwrap_or("edit"), owner, coalesce) {
                    out.history_changed = true;
                }
                out.repaired_submission = self.update_project(*project);
                out.project_changed = true;
            }
            Command::Undo => {
                if self.undo() {
                    out.project_changed = true;
                    out.history_changed = true;
                }
            }
            Command::Redo => {
                if self.redo() {
                    out.project_changed = true;
                    out.history_changed = true;
                }
            }
            Command::SwitchDeck { deck_id } => {
                if self.switch_deck(&deck_id, t) {
                    out.project_changed = true;
                }
            }
            Command::Midi { status, d1, d2 } => {
                let midi_out = self.apply_midi(status, d1, d2, t);
                out.project_changed |= midi_out.project_changed;
                out.learned = midi_out.learned;
            }
            Command::Learn { action } => self.learn_target = action,
            // Parse-and-apply, for direct callers and tests. The engine loop
            // never reaches this: it intercepts the command, parses on a worker
            // and calls apply_gdtf with the result, because parsing a real MVR
            // costs two ticks of DMX.
            Command::ImportGdtf { name, data, credit } => {
                let parsed =
                    base64_decode(&data).and_then(|bytes| crate::gdtf::parse_gdtf(&bytes));
                return self.apply_gdtf(&name, parsed, credit);
            }
            Command::ImportMvr { name, data, replace } => {
                let parsed =
                    base64_decode(&data).and_then(|bytes| crate::mvr::parse_mvr(&bytes));
                return self.apply_mvr_parsed(&name, parsed, replace, t);
            }
            Command::LaunchPreviz => out.launch_previz = true,
            Command::Save => out.save_requested = true,
        }
        out
    }
}

#[cfg(test)]
mod history_tests {
    use super::*;
    use crate::defaults::default_project;

    fn edited(st: &EngineState, f: impl FnOnce(&mut Project)) -> Project {
        let mut p = st.project.clone();
        f(&mut p);
        p
    }

    fn write(st: &mut EngineState, p: Project, label: &str, owner: u64, coalesce: bool) {
        st.handle_command(
            Command::UpdateProject { project: Box::new(p), base_gen: None, label: Some(label.into()), coalesce },
            0.0,
            Some(owner),
        );
    }

    #[test]
    fn undo_reverts_a_write_and_redo_restores_it() {
        let mut st = EngineState::new(default_project(), 0.0);
        let before = st.project.name.clone();
        let p = edited(&st, |p| p.name = "Renamed".into());
        write(&mut st, p, "rename the show", 7, false);
        assert_eq!(st.undo_label(), Some("rename the show"));
        assert!(st.undo());
        assert_eq!(st.project.name, before);
        assert_eq!(st.redo_label(), Some("rename the show"));
        assert!(st.redo());
        assert_eq!(st.project.name, "Renamed");
        assert!(!st.redo(), "nothing left to redo");
    }

    #[test]
    fn a_drag_is_one_step_but_only_for_its_own_client() {
        let mut st = EngineState::new(default_project(), 0.0);
        let fade0 = st.project.layers[0].fade;
        for (v, owner, coalesce) in [(0.1, 1, false), (0.2, 1, true), (0.3, 1, true)] {
            let p = edited(&st, |p| p.layers[0].fade = v);
            write(&mut st, p, "fade of Layer 1", owner, coalesce);
        }
        assert_eq!(st.history.len(), 1, "a continuing write from the same client joins the open step");
        let p = edited(&st, |p| p.layers[0].fade = 0.4);
        write(&mut st, p, "fade of Layer 1", 2, true);
        assert_eq!(st.history.len(), 2, "another client's write never joins someone else's step");
        assert!(st.undo());
        assert_eq!(st.project.layers[0].fade, 0.3);
        assert!(st.undo());
        assert_eq!(st.project.layers[0].fade, fade0, "the drag undoes as one");
        // after an undo, a "continuing" write must open its own step
        let p = edited(&st, |p| p.layers[0].fade = 0.5);
        write(&mut st, p, "fade of Layer 1", 1, true);
        assert_eq!(st.history.len(), 1);
        assert!(st.redone.is_empty(), "a new edit drops what was undone");
    }

    #[test]
    fn undo_keeps_the_song_you_are_on() {
        let mut st = EngineState::new(default_project(), 0.0);
        assert!(st.project.decks.len() >= 2, "the demo show has songs");
        let deck1 = st.project.active_deck_id.clone().unwrap();
        let deck2 = st.project.decks[1].id.clone();
        let layer = st.project.layers[0].id.clone();
        let cell_before = st.project.layers[0].cells[0].clone();
        let p = edited(&st, |p| p.layers[0].cells[0] = Some("look-x".into()));
        write(&mut st, p, "place a pad", 1, false);
        assert!(st.switch_deck(&deck2, 0.0));
        assert_eq!(st.history.len(), 1, "a song switch is not a step");
        let page2 = st.project.layers[0].cells.clone();
        assert!(st.undo());
        assert_eq!(st.project.active_deck_id.as_deref(), Some(deck2.as_str()), "undo does not switch the song back");
        assert_eq!(st.project.layers[0].cells, page2, "the page on screen is untouched");
        let d1 = st.project.decks.iter().find(|d| d.id == deck1).unwrap();
        assert_eq!(d1.cells[&layer][0], cell_before, "song 1's pad is back to what it was");
    }

    #[test]
    fn undo_keeps_live_state() {
        let mut st = EngineState::new(default_project(), 0.0);
        let layer = st.project.layers[0].id.clone();
        let p = edited(&st, |p| p.name = "x".into());
        write(&mut st, p, "rename the show", 1, false);
        st.handle_command(Command::SetLayerMaster { layer_id: layer, v: 0.25 }, 0.0, None);
        st.handle_command(Command::SetHaze { v: 0.6 }, 0.0, None);
        assert_eq!(st.history.len(), 1, "masters and haze are played, not edited");
        assert!(st.undo());
        assert_eq!(st.project.layers[0].master, 0.25);
        assert_eq!(st.project.settings.haze, 0.6);
    }

    #[test]
    fn imports_keeps_and_learned_mappings_are_steps() {
        let bytes = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/data/synthetic.gdtf")).unwrap();
        let mut st = EngineState::new(default_project(), 0.0);
        let profiles = st.project.profiles.len();
        let out = st.apply_gdtf("synthetic.gdtf", crate::gdtf::parse_gdtf(&bytes), None);
        assert!(out.history_changed);
        assert_eq!(st.undo_label(), Some("import “synthetic.gdtf”"));
        assert!(st.project.profiles.len() > profiles);
        assert!(st.undo());
        assert_eq!(st.project.profiles.len(), profiles, "the import is gone again");

        let mappings = st.project.midi.len();
        st.learn_target = Some(serde_json::from_str(r#"{"kind":"grand"}"#).unwrap());
        let out = st.apply_midi(0x90, 60, 100, 0.0);
        assert!(out.learned.is_some());
        assert_eq!(st.undo_label(), Some("map a MIDI control"));
        assert_eq!(st.project.midi.len(), mappings + 1);
        assert!(st.undo());
        assert_eq!(st.project.midi.len(), mappings);
    }

    #[test]
    fn history_is_capped_and_cleared_with_the_project() {
        let mut st = EngineState::new(default_project(), 0.0);
        for i in 0..(HISTORY_CAP + 5) {
            let p = edited(&st, |p| p.name = format!("n{i}"));
            write(&mut st, p, "rename the show", 1, false);
        }
        assert_eq!(st.history.len(), HISTORY_CAP);
        st.replace_project(default_project());
        assert!(st.history.is_empty() && st.redone.is_empty());
        assert!(!st.undo());
    }
}
