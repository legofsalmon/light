//! Wire-compatible mirror of `shared/types.ts` — every struct serialises to
//! exactly the JSON the UI and the Node reference engine speak.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub fn clamp(v: f64, lo: f64, hi: f64) -> f64 {
    if !v.is_finite() {
        return lo; // NaN must never propagate into the engine
    }
    if v < lo { lo } else if v > hi { hi } else { v }
}
pub fn clamp01(v: f64) -> f64 {
    clamp(v, 0.0, 1.0)
}
pub fn lerp(a: f64, b: f64, t: f64) -> f64 {
    a + (b - a) * t
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Vec3 {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UniverseCfg {
    pub id: String,
    pub label: String,
    pub artnet_universe: u16,
    pub sacn_universe: u16,
    pub artnet: bool,
    pub sacn: bool,
    pub unicast: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Fixture {
    pub id: String,
    pub name: String,
    pub profile_id: String,
    pub universe_id: String,
    pub address: usize,
    #[serde(default)]
    pub pos: Vec3,
    #[serde(default)]
    pub rot_y: f64,
    /// mounting tilt (pitch, radians) — composes on the kind's default aim
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rot_x: Option<f64>,
    /// mounting roll (radians)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rot_z: Option<f64>,
    /// Base aim for moving heads, 0..1. Focus, not an override — a look's
    /// pan/tilt applies as a delta from centre on top of it. None = 0.5.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pan: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tilt: Option<f64>,
    /// Stage structure this fixture is rigged on. `pos` stays in ROOM
    /// coordinates — the parent link is bookkeeping for the editor, and the
    /// engine never needs it to render.
    #[serde(rename = "parentId", default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeadRef {
    pub fixture_id: String,
    pub head: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Group {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub heads: Vec<HeadRef>,
}

/// A dummy performer on the stage — previz-only scenery. Tolerantly decoded
/// (mirroring the TS sanitize): malformed entries drop, never reject the
/// whole project.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StageProp {
    pub id: String,
    pub kind: String,
    pub pos: PropPos,
    #[serde(rename = "rotY", default, skip_serializing_if = "Option::is_none")]
    pub rot_y: Option<f64>,
    /// Structural kinds only (truss, riser, screen), metres. Absent on performers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<PropSize>,
    /// Structural kinds only — height of the base off the floor.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub y: Option<f64>,
}

/// w across, h tall, d deep — before `rot_y` is applied.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PropSize {
    pub w: f64,
    pub h: f64,
    pub d: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PropPos {
    pub x: f64,
    pub z: f64,
}

fn de_props<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<Option<Vec<StageProp>>, D::Error> {
    let v = Option::<serde_json::Value>::deserialize(d)?;
    let Some(serde_json::Value::Array(items)) = v else { return Ok(None) };
    let props: Vec<StageProp> = items
        .into_iter()
        .filter_map(|item| serde_json::from_value::<StageProp>(item).ok())
        .collect();
    Ok(if props.is_empty() { None } else { Some(props) })
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct ColorHS {
    pub h: f64,
    pub s: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MotorMode {
    Off,
    Aim,
    Rotate,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PartParams {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dimmer: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<ColorHS>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub white: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ring_fx: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub strobe: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub motor_mode: Option<MotorMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub motor_value: Option<f64>,
    #[serde(rename = "macro", skip_serializing_if = "Option::is_none")]
    pub macro_: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pan: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tilt: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub haze: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fan: Option<f64>,
    // Beam shaping. Absent means the look says nothing about this parameter and
    // the fixture keeps its parked value — not that the parameter is zero.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub zoom: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub focus: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub iris: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frost: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cto: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EffectTarget {
    Dimmer,
    Hue,
    White,
    Strobe,
    Pan,
    Tilt,
    Zoom,
    Focus,
    Iris,
    Frost,
    Cto,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Wave {
    Sine,
    Triangle,
    SawUp,
    SawDown,
    Square,
    Chase,
    Random,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Effect {
    pub id: String,
    pub target: EffectTarget,
    pub wave: Wave,
    pub rate: f64,
    pub size: f64,
    pub spread: f64,
    pub width: f64,
    pub phase: f64,
    /// Parked: the effect is retained but contributes nothing this tick.
    #[serde(default)]
    pub bypass: bool,
    /// Wet/dry 0..1 (1 = full effect, the pre-A2 behaviour). Defaults to 1 so
    /// every save written before this field existed renders unchanged.
    #[serde(default = "default_mix")]
    pub mix: f64,
}

fn default_mix() -> f64 {
    1.0
}

/// A named entry in the FX pool: a reusable effect template that references no
/// fixtures. Applying it copies the effect into a look part with a fresh id
/// (copy-on-apply), so editing the pool never reaches a running show. The
/// engine never renders from the pool — it is carried so it survives the
/// save/broadcast round-trip and syncs across clients.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FxPreset {
    pub id: String,
    #[serde(default)]
    pub name: String,
    pub effect: Effect,
}

/// Tolerant like de_effects: drop a preset with no id or an unrepairable
/// effect rather than failing the whole project load.
fn de_fx_pool<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Vec<FxPreset>, D::Error> {
    let v = Option::<serde_json::Value>::deserialize(d)?;
    let Some(serde_json::Value::Array(items)) = v else { return Ok(Vec::new()) };
    let pool = items
        .into_iter()
        .filter_map(|item| {
            let obj = item.as_object()?;
            let id = obj.get("id")?.as_str()?.to_string();
            let name = obj.get("name").and_then(|x| x.as_str()).unwrap_or("").to_string();
            let effect = repair_effect(obj.get("effect")?.as_object()?)?;
            Some(FxPreset { id, name, effect })
        })
        .collect();
    Ok(pool)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LookPart {
    pub id: String,
    pub group_id: String,
    pub params: PartParams,
    #[serde(default, deserialize_with = "de_effects")]
    pub effects: Vec<Effect>,
}

/// One entry of a cue list: play `look_id` for `beats` beats, then advance.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CueStep {
    pub look_id: String,
    #[serde(default = "default_beats")]
    pub beats: f64,
}

fn is_zero(n: &usize) -> bool {
    *n == 0
}

fn default_beats() -> f64 {
    1.0
}

/// Mirror of the TS sanitize for `Look.steps`: repair, never reject. A
/// hand-edited project file with `"beats": "2"` or a null entry must load
/// here exactly as it does in the Node engine — a hard serde error would
/// silently boot the core with the default project instead.
/// Deserialize a part's effects ONE AT A TIME, repairing or dropping each,
/// exactly as `de_steps` does for cue steps.
///
/// Two things this buys, both load-bearing for the motion engine work that adds
/// fields to `Effect`:
/// 1. Forward/backward safety — the strict derived struct fails the WHOLE
///    project (quarantining it to `.corrupt-*` and booting the default show) if
///    any single effect is missing a field. A future field addition without
///    this would brick every saved show on the first load by an older core.
/// 2. NaN hygiene — a non-finite rate/size today reaches the hue-wrap maths.
///    Each numeric field is finite-or-default here, at the door.
///
/// An effect with no id or an unrecognised target/wave is dropped (just that
/// effect), not fatal.
/// Repair one effect object at the door: drop it (None) if it has no id or an
/// unknown target/wave; otherwise force every numeric field finite and clamp
/// mix. Shared by de_effects (look parts) and de_fx_pool (preset templates).
fn repair_effect(obj: &serde_json::Map<String, serde_json::Value>) -> Option<Effect> {
    let fin = |k: &str, def: f64| -> f64 {
        match obj.get(k).and_then(|x| x.as_f64()) {
            Some(n) if n.is_finite() => n,
            _ => def,
        }
    };
    let id = obj.get("id")?.as_str()?.to_string();
    let target = serde_json::from_value::<EffectTarget>(obj.get("target")?.clone()).ok()?;
    let wave = serde_json::from_value::<Wave>(obj.get("wave")?.clone()).ok()?;
    Some(Effect {
        id,
        target,
        wave,
        rate: fin("rate", 1.0),
        size: fin("size", 1.0),
        spread: fin("spread", 0.0),
        width: fin("width", 0.5),
        phase: fin("phase", 0.0),
        bypass: obj.get("bypass").and_then(|x| x.as_bool()).unwrap_or(false),
        // clamp to 0..1; a missing or non-finite mix means full wet
        mix: fin("mix", 1.0).clamp(0.0, 1.0),
    })
}

fn de_effects<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Vec<Effect>, D::Error> {
    let v = Option::<serde_json::Value>::deserialize(d)?;
    let Some(serde_json::Value::Array(items)) = v else { return Ok(Vec::new()) };
    let effects = items
        .into_iter()
        .filter_map(|item| repair_effect(item.as_object()?))
        .collect();
    Ok(effects)
}

fn de_steps<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<Option<Vec<CueStep>>, D::Error> {
    let v = Option::<serde_json::Value>::deserialize(d)?;
    let Some(serde_json::Value::Array(items)) = v else { return Ok(None) };
    let steps: Vec<CueStep> = items
        .into_iter()
        .filter_map(|item| {
            let obj = item.as_object()?;
            let look_id = obj.get("lookId")?.as_str()?.to_string();
            let beats = match obj.get("beats").and_then(|b| b.as_f64()) {
                Some(b) if b.is_finite() && b > 0.0 => b.min(512.0),
                _ => 1.0,
            };
            Some(CueStep { look_id, beats })
        })
        .collect();
    Ok(if steps.is_empty() { None } else { Some(steps) })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Look {
    pub id: String,
    pub name: String,
    pub parts: Vec<LookPart>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub flash: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fade: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de_steps")]
    pub steps: Option<Vec<CueStep>>,
}

impl Look {
    pub fn is_flash(&self) -> bool {
        self.flash.unwrap_or(false)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LayerBlend {
    Normal,
    Multiply,
    Htp,
}

/// A page of the grid — one per song. `layer.cells` always holds the ACTIVE
/// deck; switching swaps pages in and out.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Deck {
    pub id: String,
    pub name: String,
    pub columns: Vec<String>,
    pub cells: HashMap<String, Vec<Option<String>>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Layer {
    pub id: String,
    pub name: String,
    pub blend: LayerBlend,
    #[serde(default = "one")]
    pub master: f64,
    #[serde(default = "half")]
    pub fade: f64,
    /// Node rebuilds a missing cells array from `columns`; an empty one behaves
    /// identically because every lookup misses, and ensure_decks resizes it.
    #[serde(default)]
    pub cells: Vec<Option<String>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum MidiAction {
    Cell { layer_id: String, col: usize },
    Column { col: usize },
    LayerMaster { layer_id: String },
    LayerClear { layer_id: String },
    Grand,
    Speed,
    Haze,
    Tap,
    Blackout,
    DeckNext,
    DeckPrev,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MidiType {
    Note,
    Cc,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MidiMapping {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: MidiType,
    pub channel: u8,
    pub number: u8,
    pub action: MidiAction,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(default)]
pub struct SyncCfg {
    pub osc_enabled: bool,
    pub osc_port: u16,
    pub follow_columns: bool,
    pub bpm_from_osc: bool,
    /// follow an Ableton Link session (native engine only)
    #[serde(default)]
    pub link_enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(default)]
pub struct Settings {
    pub haze: f64,
    pub haze_fan: f64,
}

// camelCase like every other struct in this file. Without it `active_deck_id`
// went out on the wire and to disk in snake_case while the UI, shared/types.ts
// and the Node engine all read `activeDeckId` — so the active song never
// crossed the boundary, no deck chip ever lit, and [ ] / prev / next all
// navigated from index 0. It is the only multi-word field on this struct, so
// the rename touches nothing else.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub version: u32,
    #[serde(default = "untitled")]
    pub name: String,
    pub universes: Vec<UniverseCfg>,
    pub fixtures: Vec<Fixture>,
    pub groups: Vec<Group>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de_props")]
    pub props: Option<Vec<StageProp>>,
    #[serde(default)]
    pub looks: HashMap<String, Look>,
    pub layers: Vec<Layer>,
    pub columns: Vec<String>,
    #[serde(default)]
    pub midi: Vec<MidiMapping>,
    #[serde(default)]
    pub sync: SyncCfg,
    #[serde(default)]
    pub settings: Settings,
    /// imported (GDTF-compiled) fixture profiles — travel with the project
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub profiles: HashMap<String, crate::cprofile::CompiledProfile>,
    /// grid pages (one per song); layer.cells mirrors the active deck
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub decks: Vec<Deck>,
    /// `alias` is the migration: shows written by an earlier build carry the
    /// snake_case spelling, and without it they would silently lose their
    /// active deck on first load. Reads either, always writes camelCase, so a
    /// project converts itself the next time it is saved.
    #[serde(default, skip_serializing_if = "Option::is_none", alias = "active_deck_id")]
    pub active_deck_id: Option<String>,
    /// FX pool: named, reusable effect templates (copy-on-apply). Carried
    /// through the round-trip; never rendered from directly.
    #[serde(default, skip_serializing_if = "Vec::is_empty", deserialize_with = "de_fx_pool")]
    pub fx_pool: Vec<FxPreset>,
}

// ---------- live wire types (engine → ui) ----------

#[derive(Debug, Clone, Serialize)]
pub struct HeadSnap {
    pub f: String,
    pub h: usize,
    pub r: f64,
    pub g: f64,
    pub b: f64,
    pub i: f64,
    pub st: f64,
    pub ring: f64,
    pub mm: MotorMode,
    pub mv: f64,
    pub pan: f64,
    pub tilt: f64,
    /// Resolved zoom 0..1, present only when a look is driving zoom on this
    /// head. The previz widens/narrows its cone from it; absent keeps the
    /// profile's own beam angle.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub zm: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mc: Option<Vec<[u8; 3]>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LayerSnap {
    pub id: String,
    pub look_id: Option<String>,
    pub prev_id: Option<String>,
    pub col: Option<usize>,
    pub t: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct EngineStats {
    pub fps: u32,
    pub jitter: f64,
    pub artnet: u64,
    pub sacn: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct LinkSnap {
    pub on: bool,
    pub peers: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtnetNodeSnap {
    pub ip: String,
    pub name: String,
    pub age_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    #[serde(rename = "type")]
    pub typ: &'static str, // always "snap"
    pub now: f64,
    pub beat: f64,
    pub bpm: f64,
    pub speed: f64,
    pub master: f64,
    pub blackout: bool,
    pub haze: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub link: Option<LinkSnap>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artnet_nodes: Option<Vec<ArtnetNodeSnap>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artnet_poll: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub osc_in: Option<&'static str>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub muted: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub identify: Option<String>,
    #[serde(skip_serializing_if = "is_zero")]
    pub overrides: usize,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub unknown_profiles: Vec<String>,
    pub haze_fan: f64,
    pub heads: Vec<HeadSnap>,
    pub layers: Vec<LayerSnap>,
    pub stats: EngineStats,
}

// ---------------------------------------------------------------------------
// Repair defaults.
//
// These exist so the shipping engine accepts every project shape the Node
// reference repairs. It did not: a project written to this repo's own
// documented schema loaded in Node and was renamed `.corrupt-*` by Rust, and a
// malformed frame from a client was dropped in total silence.
//
// The values mirror shared/types.ts `sanitizeProject` field for field. Zero is
// the wrong default for most of them — a layer at master 0 is blacked out, OSC
// on port 0 reaches nothing — which is why these are written out rather than
// derived.

fn one() -> f64 {
    1.0
}

fn half() -> f64 {
    0.5
}

fn untitled() -> String {
    "Untitled".to_string()
}

impl Default for Vec3 {
    /// Node repairs a missing fixture position to 2 m up, centre stage.
    fn default() -> Self {
        Vec3 { x: 0.0, y: 2.0, z: 0.0 }
    }
}

impl Default for SyncCfg {
    fn default() -> Self {
        SyncCfg {
            osc_enabled: true,
            link_enabled: false,
            osc_port: 7700,
            follow_columns: true,
            bpm_from_osc: true,
        }
    }
}

impl Default for Settings {
    fn default() -> Self {
        Settings { haze: 0.0, haze_fan: 0.35 }
    }
}

// ---------- commands (ui → engine) ----------

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Command {
    Hello,
    Trigger { layer_id: String, col: usize },
    Release { layer_id: String, col: usize },
    ClearLayer { layer_id: String },
    Column { col: usize },
    SetBpm { bpm: f64 },
    SetLink { on: bool },
    #[serde(rename_all = "camelCase")]
    SetFixtureMute { fixture_id: String, on: bool },
    #[serde(rename_all = "camelCase")]
    Identify { fixture_id: Option<String> },
    /// Audition a look in the previz without sending it to the rig. None stops.
    #[serde(rename_all = "camelCase")]
    PreviewLook { look_id: Option<String> },
    AllStop,
    #[serde(rename_all = "camelCase")]
    SetChannel { universe_id: String, channel: usize, value: Option<u8> },
    ClearChannelOverrides,
    Projects,
    NewProject { name: String },
    OpenProject { slug: String },
    SaveProjectAs { name: String },
    Tap,
    Resync,
    SetSpeed { v: f64 },
    SetMaster { v: f64 },
    SetLayerMaster { layer_id: String, v: f64 },
    SetBlackout { v: bool },
    SetHaze { v: f64 },
    SetHazeFan { v: f64 },
    /// Subscribe this client to raw DMX for the given universes; an empty list
    /// unsubscribes. Only the Output tab wants it, so nothing else pays for it.
    WatchDmx {
        #[serde(default)]
        universe_ids: Vec<String>,
    },
    /// TEST ONLY — pins the effect clock to a fixed beat and freezes its
    /// integration, so a moving effect produces the same bytes on both engines
    /// frame by frame. Gated behind the LIGHT_TEST_CLOCK env var and otherwise
    /// ignored, so it can never touch a show. See engine::run.
    #[serde(rename = "_pinClock")]
    PinClock { eff_beat: f64 },
    UpdateProject {
        project: Box<Project>,
        /// The project generation this edit was composed against; the engine
        /// rejects and re-syncs a write whose base is stale. Absent for blind
        /// submitters (tests, scripts) — then no staleness check runs.
        #[serde(default)]
        base_gen: Option<u64>,
    },
    Midi { status: u8, d1: u8, d2: u8 },
    Learn { action: Option<MidiAction> },
    ImportGdtf {
        name: String,
        data: String,
        /// Who authored the definition. A GDTF file carries no author
        /// attribute, so it can only come from the source of the file.
        #[serde(default)]
        credit: Option<String>,
    },
    ImportMvr { name: String, data: String, replace: bool },
    SwitchDeck { deck_id: String },
    LaunchPreviz,
    Save,
}

#[cfg(test)]
mod effect_repair_tests {
    use super::*;

    fn part_with_effects(json: &str) -> LookPart {
        serde_json::from_str(&format!(
            r#"{{"id":"p","groupId":"g","params":{{}},"effects":{json}}}"#
        ))
        .expect("a part with a malformed effect must still deserialize")
    }

    #[test]
    fn a_non_finite_rate_is_repaired_not_fatal() {
        // serde_json cannot encode NaN, but a null or missing numeric arrives
        // as exactly the "not finite" case the door guard handles
        let p = part_with_effects(
            r#"[{"id":"e","target":"dimmer","wave":"sine","rate":null,"size":1,"spread":0,"width":0.5,"phase":0}]"#,
        );
        assert_eq!(p.effects.len(), 1);
        assert_eq!(p.effects[0].rate, 1.0, "null rate defaulted, not propagated");
    }

    #[test]
    fn a_missing_field_defaults_rather_than_failing_the_project() {
        // the whole point: a future field or an old save missing `width` loads
        let p = part_with_effects(
            r#"[{"id":"e","target":"hue","wave":"sawUp","rate":4,"size":1,"spread":0.5,"phase":0}]"#,
        );
        assert_eq!(p.effects.len(), 1);
        assert_eq!(p.effects[0].width, 0.5, "missing width defaulted");
    }

    #[test]
    fn an_unknown_target_drops_only_that_effect() {
        let p = part_with_effects(
            r#"[{"id":"bad","target":"laser","wave":"sine","rate":1,"size":1,"spread":0,"width":0.5,"phase":0},
                {"id":"ok","target":"pan","wave":"sine","rate":1,"size":1,"spread":0,"width":0.5,"phase":0}]"#,
        );
        assert_eq!(p.effects.len(), 1, "the laser effect dropped, the pan effect kept");
        assert_eq!(p.effects[0].id, "ok");
    }

    #[test]
    fn unknown_extra_fields_are_ignored_not_fatal() {
        // forward compat: a project written by a newer UI with a field this
        // core does not model must still load
        let p = part_with_effects(
            r#"[{"id":"e","target":"dimmer","wave":"sine","rate":1,"size":1,"spread":0,"width":0.5,"phase":0,"distribute":"x","fold":"mirror"}]"#,
        );
        assert_eq!(p.effects.len(), 1);
    }

    #[test]
    fn a2_bypass_and_mix_default_to_active_full_wet() {
        // a pre-A2 save has neither field: it must load as an active, full-wet
        // effect so it renders exactly as it did before the fields existed
        let p = part_with_effects(
            r#"[{"id":"e","target":"dimmer","wave":"sine","rate":1,"size":1,"spread":0,"width":0.5,"phase":0}]"#,
        );
        assert_eq!(p.effects.len(), 1);
        assert!(!p.effects[0].bypass, "missing bypass defaults off");
        assert_eq!(p.effects[0].mix, 1.0, "missing mix defaults to full wet");
    }

    #[test]
    fn a2_mix_is_clamped_and_bypass_coerced() {
        let p = part_with_effects(
            r#"[{"id":"e","target":"dimmer","wave":"sine","rate":1,"size":1,"spread":0,"width":0.5,"phase":0,"bypass":true,"mix":1.7}]"#,
        );
        assert_eq!(p.effects.len(), 1);
        assert!(p.effects[0].bypass, "explicit bypass kept");
        assert_eq!(p.effects[0].mix, 1.0, "out-of-range mix clamped to 1");
    }
}
