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
    pub pos: Vec3,
    pub rot_y: f64,
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
    pub heads: Vec<HeadRef>,
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LookPart {
    pub id: String,
    pub group_id: String,
    pub params: PartParams,
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

fn default_beats() -> f64 {
    1.0
}

/// Mirror of the TS sanitize for `Look.steps`: repair, never reject. A
/// hand-edited project file with `"beats": "2"` or a null entry must load
/// here exactly as it does in the Node engine — a hard serde error would
/// silently boot the core with the default project instead.
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
    pub master: f64,
    pub fade: f64,
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
pub struct Settings {
    pub haze: f64,
    pub haze_fan: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    pub version: u32,
    pub name: String,
    pub universes: Vec<UniverseCfg>,
    pub fixtures: Vec<Fixture>,
    pub groups: Vec<Group>,
    pub looks: HashMap<String, Look>,
    pub layers: Vec<Layer>,
    pub columns: Vec<String>,
    pub midi: Vec<MidiMapping>,
    pub sync: SyncCfg,
    pub settings: Settings,
    /// imported (GDTF-compiled) fixture profiles — travel with the project
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub profiles: HashMap<String, crate::cprofile::CompiledProfile>,
    /// grid pages (one per song); layer.cells mirrors the active deck
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub decks: Vec<Deck>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_deck_id: Option<String>,
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
    pub haze_fan: f64,
    pub heads: Vec<HeadSnap>,
    pub layers: Vec<LayerSnap>,
    pub dmx: HashMap<String, Vec<u8>>,
    pub stats: EngineStats,
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
    UpdateProject { project: Box<Project> },
    Midi { status: u8, d1: u8, d2: u8 },
    Learn { action: Option<MidiAction> },
    ImportGdtf { name: String, data: String },
    ImportMvr { name: String, data: String, replace: bool },
    SwitchDeck { deck_id: String },
    LaunchPreviz,
    Save,
}
