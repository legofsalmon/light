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

/// Tolerant Vec3 for fixture positions: mirrors the Node sanitizer, which
/// repairs each COMPONENT independently (x→0, y→2, z→0 when missing or not a
/// finite number). Plain serde would fail the whole project on `"pos": null`
/// or `{"x": null}` — shapes Node repairs — and a `.corrupt-*` rename over a
/// component-level nit is exactly what rust_accepts_every_shape_node_repairs
/// exists to prevent. Geometry consumes positions now, so both engines must
/// land on identical values.
fn de_vec3<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Vec3, D::Error> {
    let v = Option::<serde_json::Value>::deserialize(d)?;
    let comp = |o: Option<&serde_json::Map<String, serde_json::Value>>, k: &str, def: f64| -> f64 {
        match o.and_then(|m| m.get(k)).and_then(|x| x.as_f64()) {
            Some(n) if n.is_finite() => n,
            _ => def,
        }
    };
    let obj = v.as_ref().and_then(|x| x.as_object());
    Ok(Vec3 { x: comp(obj, "x", 0.0), y: comp(obj, "y", 2.0), z: comp(obj, "z", 0.0) })
}

/// Node repairs a non-finite rotY to 0; a null/absent/string one must load, not
/// fail the project.
fn de_rot_y<'de, D: serde::Deserializer<'de>>(d: D) -> Result<f64, D::Error> {
    let v = Option::<serde_json::Value>::deserialize(d)?;
    Ok(match v.as_ref().and_then(|x| x.as_f64()) {
        Some(n) if n.is_finite() => n,
        _ => 0.0,
    })
}

/// Node DELETES a non-finite optional angle (rotX/rotZ) — absent, not zero.
fn de_opt_finite<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<f64>, D::Error> {
    let v = Option::<serde_json::Value>::deserialize(d)?;
    Ok(v.as_ref().and_then(|x| x.as_f64()).filter(|n| n.is_finite()))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Fixture {
    pub id: String,
    pub name: String,
    pub profile_id: String,
    pub universe_id: String,
    pub address: usize,
    #[serde(default, deserialize_with = "de_vec3")]
    pub pos: Vec3,
    #[serde(default, deserialize_with = "de_rot_y")]
    pub rot_y: f64,
    /// mounting tilt (pitch, radians) — composes on the kind's default aim
    #[serde(default, deserialize_with = "de_opt_finite", skip_serializing_if = "Option::is_none")]
    pub rot_x: Option<f64>,
    /// mounting roll (radians)
    #[serde(default, deserialize_with = "de_opt_finite", skip_serializing_if = "Option::is_none")]
    pub rot_z: Option<f64>,
    /// Base aim for moving heads, 0..1. Focus, not an override — a look's
    /// pan/tilt applies as a delta from centre on top of it. None = 0.5.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pan: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tilt: Option<f64>,
    /// How this head's own axes are wired and how far it may swing. Absent on
    /// every show written before it existed, and absent means "no calibration".
    #[serde(default, deserialize_with = "de_cal", skip_serializing_if = "Option::is_none")]
    pub cal: Option<FixtureCal>,
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
    /// Provenance tag for derived groups (B3): "type:<profileId>" or
    /// "truss:<propId>". Tagged groups may be rewritten by an explicit
    /// regenerate; the UI clears the tag the moment the operator renames or
    /// edits one (promotion to authored). Inert to the engine. Tolerant:
    /// a non-string value loads as absent, matching the Node sanitizer.
    #[serde(default, deserialize_with = "de_opt_string", skip_serializing_if = "Option::is_none")]
    pub auto: Option<String>,
}

fn de_opt_string<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    let v = Option::<serde_json::Value>::deserialize(d)?;
    Ok(v.as_ref().and_then(|x| x.as_str()).map(|s| s.to_string()))
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

/// The stage as a box, metres: `w` across (x), `d` toward the audience (z),
/// `h` up to the grid (y), centred on the plan's origin. Absent, every view
/// fits itself to whatever is placed. Twin of StageSize in shared/types.ts.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct StageSize {
    pub w: f64,
    pub d: f64,
    pub h: f64,
}

/// The one repair rule both engines apply — the twin of `sanitizeStage` in
/// shared/types.ts, and the parity suite holds them to it: every side a finite
/// positive number or the field is dropped; sides clamped to the same limits.
pub fn stage_from_value(v: &serde_json::Value) -> Option<StageSize> {
    let side = |k: &str, lo: f64, hi: f64| -> Option<f64> {
        let n = v.get(k)?.as_f64()?;
        (n.is_finite() && n > 0.0).then(|| n.clamp(lo, hi))
    };
    Some(StageSize { w: side("w", 1.0, 500.0)?, d: side("d", 1.0, 500.0)?, h: side("h", 1.0, 100.0)? })
}

fn de_stage<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<StageSize>, D::Error> {
    let v = Option::<serde_json::Value>::deserialize(d)?;
    Ok(v.as_ref().and_then(stage_from_value))
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

/// How the shutter strobes while `strobe` is above zero. Mirrors StrobeMode in
/// shared/types.ts: plain (the default, and all an older save knows), a pulse
/// that ramps each flash open and shut, or random flashes around the set rate.
/// A fixture without the pattern falls back to its plain strobe band.
/// Per-fixture pan and tilt calibration. Mirrors FixtureCal in
/// shared/types.ts; the maths that reads it lives in crate::aim.
///
/// It is NOT where the head points — that is the base aim, which an operator
/// sets by eye and which stays put when this changes.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FixtureCal {
    /// a look's pan delta drives this head the other way
    #[serde(default, skip_serializing_if = "is_false")]
    pub invert_pan: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub invert_tilt: bool,
    /// the head is hung on its side; applied BEFORE the inversions, which
    /// name the fixture's own axes
    #[serde(default, skip_serializing_if = "is_false")]
    pub swap: bool,
    /// soft limits as a fraction of travel, 0..1
    #[serde(default, deserialize_with = "de_opt_unit", skip_serializing_if = "Option::is_none")]
    pub pan_min: Option<f64>,
    #[serde(default, deserialize_with = "de_opt_unit", skip_serializing_if = "Option::is_none")]
    pub pan_max: Option<f64>,
    #[serde(default, deserialize_with = "de_opt_unit", skip_serializing_if = "Option::is_none")]
    pub tilt_min: Option<f64>,
    #[serde(default, deserialize_with = "de_opt_unit", skip_serializing_if = "Option::is_none")]
    pub tilt_max: Option<f64>,
}

fn is_false(v: &bool) -> bool {
    !*v
}

/// A limit is a finite fraction of travel or it is not there — clamped, the
/// same way the Node sanitizer clamps it, so a hand-edited 5 means "the top".
fn de_opt_unit<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<f64>, D::Error> {
    let v = Option::<serde_json::Value>::deserialize(d)?;
    Ok(match v.as_ref().and_then(|x| x.as_f64()) {
        Some(n) if n.is_finite() => Some(clamp01(n)),
        _ => None,
    })
}

/// A calibration block this build cannot read is dropped, not failed — the
/// head then behaves as it did before calibration existed, which is the
/// safest thing an unreadable correction can do. An empty block is dropped
/// too, so it never round-trips as `"cal": {}`.
fn de_cal<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<FixtureCal>, D::Error> {
    let v = Option::<serde_json::Value>::deserialize(d)?;
    let cal: Option<FixtureCal> = v.and_then(|x| serde_json::from_value(x).ok());
    Ok(cal.filter(|c| *c != FixtureCal::default()))
}

#[cfg(test)]
mod cal_tests {
    use super::*;

    fn cal_of(json: &str) -> Option<FixtureCal> {
        #[derive(Deserialize)]
        struct Holder {
            #[serde(default, deserialize_with = "de_cal")]
            cal: Option<FixtureCal>,
        }
        serde_json::from_str::<Holder>(json).expect("parses").cal
    }

    #[test]
    fn a_block_that_corrects_nothing_is_dropped() {
        // Mirrors the Node sanitizer, which deletes the block rather than
        // storing an empty one — otherwise the same show has two shapes.
        assert_eq!(cal_of(r#"{"cal":{}}"#), None);
        assert_eq!(cal_of(r#"{"cal":{"invertPan":false}}"#), None);
        assert_eq!(cal_of(r#"{}"#), None);
    }

    #[test]
    fn an_unreadable_block_is_dropped_rather_than_failing_the_load() {
        // The head then behaves as it did before calibration existed, which is
        // the safest thing an unreadable correction can do.
        assert_eq!(cal_of(r#"{"cal":"nonsense"}"#), None);
        assert_eq!(cal_of(r#"{"cal":{"invertPan":"yes"}}"#), None);
    }

    #[test]
    fn limits_are_clamped_into_range_not_dropped() {
        let c = cal_of(r#"{"cal":{"panMin":5,"tiltMax":-2}}"#).expect("kept");
        assert_eq!(c.pan_min, Some(1.0));
        assert_eq!(c.tilt_max, Some(0.0));
        // and a non-numeric one goes, leaving the rest
        let c = cal_of(r#"{"cal":{"panMin":0.25,"panMax":"x"}}"#).expect("kept");
        assert_eq!((c.pan_min, c.pan_max), (Some(0.25), None));
    }

    #[test]
    fn a_real_block_round_trips_without_the_defaults() {
        let c = cal_of(r#"{"cal":{"swap":true,"tiltMax":0.75}}"#).expect("kept");
        let out = serde_json::to_string(&c).unwrap();
        assert_eq!(out, r#"{"swap":true,"tiltMax":0.75}"#, "false flags must not travel");
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum StrobeMode {
    #[default]
    Strobe,
    Pulse,
    Random,
}

/// A pattern this build does not know is dropped, not failed: the Node
/// sanitizer deletes it too, so both engines strobe plain.
fn de_strobe_mode<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<StrobeMode>, D::Error> {
    let v = Option::<serde_json::Value>::deserialize(d)?;
    Ok(v.and_then(|x| serde_json::from_value(x).ok()))
}

/// A wheel slot: a finite, non-negative number, rounded — mirrors the Node
/// sanitizer, so a hand-edited "2.4" lands on slot 2 in both engines.
fn de_slot<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<f64>, D::Error> {
    let v = Option::<serde_json::Value>::deserialize(d)?;
    Ok(match v.as_ref().and_then(|x| x.as_f64()) {
        Some(n) if n.is_finite() && n >= 0.0 => Some(n.round()),
        _ => None,
    })
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
    /// Shutter pattern while strobing; absent is a plain strobe.
    #[serde(default, deserialize_with = "de_strobe_mode", skip_serializing_if = "Option::is_none")]
    pub strobe_mode: Option<StrobeMode>,
    // Optics. A slot is an INDEX into the fixture's own wheel (0 = open, no
    // prism), never a DMX value, so one look reads the same on two different
    // fixtures. Absent leaves the wheel where the profile parks it.
    #[serde(default, deserialize_with = "de_slot", skip_serializing_if = "Option::is_none")]
    pub gobo: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gobo_rotate: Option<f64>,
    #[serde(default, deserialize_with = "de_slot", skip_serializing_if = "Option::is_none")]
    pub prism: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prism_rotate: Option<f64>,
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
    GoboRotate,
    PrismRotate,
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

/// How an effect's phase fans across the group: patch order (the legacy
/// behaviour), a world-position sweep, a ripple from the group's centre, a
/// seeded scatter, or the fixture's own pixel grid (Row/Col fan WITHIN each
/// fixture, so every strobe runs the same pixel wave by construction).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum Distribute {
    #[default]
    Index,
    X,
    Y,
    Z,
    Radial,
    Shuffle,
    Row,
    Col,
}

/// Symmetry fold on the fan: mirror = ends in phase sweeping toward the
/// centre (MA "wings"); centre = centre leads, ends trail.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum Fold {
    #[default]
    None,
    Mirror,
    Centre,
}

/// Parameters a soft override can ride (P1). Part fields are the numeric
/// PartParams (Hue/Sat address the colour components); effect fields are the
/// numeric Effect knobs. One vocabulary, shared with P2/P3 bindings later.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SoftField {
    Dimmer,
    White,
    RingFx,
    Strobe,
    MotorValue,
    Pan,
    Tilt,
    Haze,
    Fan,
    Zoom,
    Focus,
    Iris,
    Frost,
    Cto,
    GoboRotate,
    PrismRotate,
    Hue,
    Sat,
    Rate,
    Size,
    Spread,
    Width,
    Phase,
    Mix,
}

/// Per-field clamp for soft values — validated at the door, so the renderer
/// never meets an out-of-range ride. Mirrors softClamp in shared/types.ts.
pub fn soft_clamp(field: SoftField, v: f64) -> Option<f64> {
    if !v.is_finite() {
        return None;
    }
    Some(match field {
        SoftField::Hue => clamp(v, 0.0, 360.0),
        SoftField::Rate => clamp(v, 0.05, 64.0),
        _ => clamp01(v),
    })
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
    /// Fan basis (A1). Index with fold None, reverse off and parts/buddy 1 is
    /// byte-identical to the pre-A1 fan.
    #[serde(default)]
    pub distribute: Distribute,
    /// Symmetry fold on the fan.
    #[serde(default)]
    pub fold: Fold,
    /// Run the fan backwards.
    #[serde(default)]
    pub reverse: bool,
    /// Tile the fan into k repeats across the group (1 = off).
    #[serde(default = "default_one")]
    pub parts: u32,
    /// Clump size: adjacent heads (in fan order) share a phase (1 = off).
    #[serde(default = "default_one")]
    pub buddy: u32,
    /// Seed for the shuffle basis.
    #[serde(default)]
    pub seed: i32,
}

fn default_mix() -> f64 {
    1.0
}

fn default_one() -> u32 {
    1
}

/// One fan-out of a Named Control (P3): drives a single soft address through
/// a per-link bracket. value v (0..1) maps to min + (max − min)·v — set
/// min > max to invert. The soft door clamps the mapped value per-field.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlLink {
    pub look_id: String,
    pub part_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effect_id: Option<String>,
    pub field: SoftField,
    pub min: f64,
    pub max: f64,
}

/// A Named Control (P3) — the macro answer: a typed live fader fanning out to
/// parameters through per-link brackets. `value` is the SAVED position; the
/// live position is runtime state carried in the snapshot.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Control {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub value: f64,
    #[serde(default)]
    pub links: Vec<ControlLink>,
}

/// Tolerant like de_fx_pool: drop a control with no id, drop a link whose
/// field is unknown, force numerics finite — mirror of the Node sanitizer.
fn de_controls<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Vec<Control>, D::Error> {
    let v = Option::<serde_json::Value>::deserialize(d)?;
    let Some(serde_json::Value::Array(items)) = v else { return Ok(Vec::new()) };
    let fin = |o: &serde_json::Map<String, serde_json::Value>, k: &str, def: f64| -> f64 {
        match o.get(k).and_then(|x| x.as_f64()) {
            Some(n) if n.is_finite() => n,
            _ => def,
        }
    };
    let controls = items
        .into_iter()
        .filter_map(|item| {
            let obj = item.as_object()?;
            let id = obj.get("id")?.as_str()?.to_string();
            let name = obj.get("name").and_then(|x| x.as_str()).unwrap_or("").to_string();
            let value = clamp01(fin(obj, "value", 0.0));
            let links: Vec<ControlLink> = obj
                .get("links")
                .and_then(|x| x.as_array())
                .map(|ls| {
                    ls.iter()
                        .filter_map(|l| {
                            let lo = l.as_object()?;
                            let field = serde_json::from_value::<SoftField>(lo.get("field")?.clone()).ok()?;
                            Some(ControlLink {
                                look_id: lo.get("lookId")?.as_str()?.to_string(),
                                part_id: lo.get("partId")?.as_str()?.to_string(),
                                effect_id: lo.get("effectId").and_then(|x| x.as_str()).map(|s| s.to_string()),
                                field,
                                min: fin(lo, "min", 0.0),
                                max: fin(lo, "max", 1.0),
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            Some(Control { id, name, value, links })
        })
        .collect();
    Ok(controls)
}

/// One binding of a modulator (P2): adds a beat-driven offset to a soft
/// address. depth −1..1 scales the swing; the combined value clamps
/// per-field — the offset rides ON TOP of stored → soft.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModBinding {
    pub look_id: String,
    pub part_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effect_id: Option<String>,
    pub field: SoftField,
    pub depth: f64,
}

/// A global modulator (P2, LFO slice): a pure function of the shared effect
/// beat, so it inherits the speed master and tap alignment for free.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Modulator {
    pub id: String,
    #[serde(default)]
    pub name: String,
    pub wave: Wave,
    pub rate: f64,
    #[serde(default)]
    pub phase: f64,
    #[serde(default = "default_true")]
    pub on: bool,
    #[serde(default)]
    pub bindings: Vec<ModBinding>,
}

fn default_true() -> bool {
    true
}

/// Tolerant, mirror of the Node sanitizer.
fn de_modulators<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Vec<Modulator>, D::Error> {
    let v = Option::<serde_json::Value>::deserialize(d)?;
    let Some(serde_json::Value::Array(items)) = v else { return Ok(Vec::new()) };
    let fin = |o: &serde_json::Map<String, serde_json::Value>, k: &str, def: f64| -> f64 {
        match o.get(k).and_then(|x| x.as_f64()) {
            Some(n) if n.is_finite() => n,
            _ => def,
        }
    };
    let mods = items
        .into_iter()
        .filter_map(|item| {
            let obj = item.as_object()?;
            let id = obj.get("id")?.as_str()?.to_string();
            let wave = serde_json::from_value::<Wave>(obj.get("wave")?.clone()).ok()?;
            let name = obj.get("name").and_then(|x| x.as_str()).unwrap_or("").to_string();
            let rate = match obj.get("rate").and_then(|x| x.as_f64()) {
                Some(n) if n.is_finite() && n > 0.0 => n.min(512.0),
                _ => 4.0,
            };
            let phase = fin(obj, "phase", 0.0);
            let on = obj.get("on").and_then(|x| x.as_bool()).unwrap_or(true);
            let bindings: Vec<ModBinding> = obj
                .get("bindings")
                .and_then(|x| x.as_array())
                .map(|bs| {
                    bs.iter()
                        .filter_map(|b| {
                            let bo = b.as_object()?;
                            let field = serde_json::from_value::<SoftField>(bo.get("field")?.clone()).ok()?;
                            // rate is NOT modulatable: a per-tick rate change
                            // turns the P4 phase-continuity map into a tick-
                            // schedule-dependent integrator
                            if field == SoftField::Rate {
                                return None;
                            }
                            Some(ModBinding {
                                look_id: bo.get("lookId")?.as_str()?.to_string(),
                                part_id: bo.get("partId")?.as_str()?.to_string(),
                                effect_id: bo.get("effectId").and_then(|x| x.as_str()).map(|s| s.to_string()),
                                field,
                                depth: clamp(fin(bo, "depth", 0.0), -1.0, 1.0),
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            Some(Modulator { id, name, wave, rate, phase, on, bindings })
        })
        .collect();
    Ok(mods)
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
    // A1: an UNKNOWN distribute or fold degrades to the default rather than
    // dropping the effect — a show authored on a newer build should still run
    // here, just unfanned, which beats going dark.
    let distribute = obj
        .get("distribute")
        .and_then(|x| serde_json::from_value::<Distribute>(x.clone()).ok())
        .unwrap_or_default();
    let fold = obj
        .get("fold")
        .and_then(|x| serde_json::from_value::<Fold>(x.clone()).ok())
        .unwrap_or_default();
    let count = |k: &str| -> u32 {
        match obj.get(k).and_then(|x| x.as_f64()) {
            Some(n) if n.is_finite() && n >= 1.0 => (n.floor() as u32).min(64),
            _ => 1,
        }
    };
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
        distribute,
        fold,
        reverse: obj.get("reverse").and_then(|x| x.as_bool()).unwrap_or(false),
        parts: count("parts"),
        buddy: count("buddy"),
        // clamped, not wrapped: JS ToInt32 and Rust saturating casts disagree
        // on absurd magnitudes, so both engines clamp to i32 range instead
        seed: match obj.get("seed").and_then(|x| x.as_f64()) {
            Some(n) if n.is_finite() => n.floor().clamp(-2147483648.0, 2147483647.0) as i32,
            _ => 0,
        },
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
    /// move a Named Control (CC value scales 0..1)
    Control { control_id: String },
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
    /// The stage as a box; absent = every view fits itself to the rig.
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de_stage")]
    pub stage: Option<StageSize>,
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
    /// Named Controls (P3): live faders fanning to parameters via soft links.
    #[serde(default, skip_serializing_if = "Vec::is_empty", deserialize_with = "de_controls")]
    pub controls: Vec<Control>,
    /// Global modulators (P2): beat-locked LFOs bound to parameters.
    #[serde(default, skip_serializing_if = "Vec::is_empty", deserialize_with = "de_modulators")]
    pub modulators: Vec<Modulator>,
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

/// One live Named Control position, as the snapshot carries it.
#[derive(Debug, Clone, Serialize)]
pub struct ControlSnap {
    pub id: String,
    pub value: f64,
}

/// One live soft override, as the snapshot carries it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SoftSnap {
    pub look_id: String,
    pub part_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effect_id: Option<String>,
    pub field: SoftField,
    pub value: f64,
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
    /// Whether the engine is putting DMX on the wire. Not derivable from the
    /// project: the universes say WHERE output would go, this says whether any
    /// of it leaves the machine.
    pub transmit: bool,
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
    /// live soft overrides (P1) — present only while something is ridden
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub soft: Vec<SoftSnap>,
    /// live Named Control positions (P3)
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub controls: Vec<ControlSnap>,
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
    /// Open or close the transmit gate: whether rendered frames reach the wire
    /// at all. Runtime-only, off at every boot — crate::output.
    SetTransmit { v: bool },
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
    /// P1 soft override: ride one stored parameter live without a project
    /// write. value None clears the single entry.
    #[serde(rename_all = "camelCase")]
    Soft {
        look_id: String,
        part_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        effect_id: Option<String>,
        field: SoftField,
        value: Option<f64>,
    },
    /// Store: write every soft value into the project (one gen bump), clear.
    SoftCommit,
    /// Discard: drop every soft value, stored data untouched.
    SoftClear,
    /// Move a Named Control: resolves through the soft layer per link.
    #[serde(rename_all = "camelCase")]
    SetControl { control_id: String, value: f64 },
    UpdateProject {
        project: Box<Project>,
        /// The project generation this edit was composed against; the engine
        /// rejects and re-syncs a write whose base is stale. Absent for blind
        /// submitters (tests, scripts) — then no staleness check runs.
        #[serde(default)]
        base_gen: Option<u64>,
        /// what this edit is, for the history — the undo tooltip shows it
        #[serde(default)]
        label: Option<String>,
        /// continues the sender's previous write (a drag): join the open step
        #[serde(default)]
        coalesce: bool,
    },
    /// step the engine's shared history back / forward
    Undo,
    Redo,
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

#[cfg(test)]
mod fixture_spatial_repair_tests {
    use super::*;

    fn fixture(json: &str) -> Fixture {
        serde_json::from_str(json).expect("a fixture with malformed spatial fields must still load")
    }

    #[test]
    fn a_null_pos_repairs_to_the_default_not_a_corrupt_rename() {
        let f = fixture(r#"{"id":"f","name":"F","profileId":"p","universeId":"u","address":1,"pos":null,"rotY":0}"#);
        assert_eq!((f.pos.x, f.pos.y, f.pos.z), (0.0, 2.0, 0.0), "2 m up, centre stage — Node's repair value");
    }

    #[test]
    fn a_partial_pos_fills_each_component_like_node_does() {
        // {x:1} must land on {1, 2, 0} in BOTH engines — geometry consumes
        // positions now, so a component-level divergence is a parity break
        let f = fixture(r#"{"id":"f","name":"F","profileId":"p","universeId":"u","address":1,"pos":{"x":1},"rotY":0}"#);
        assert_eq!((f.pos.x, f.pos.y, f.pos.z), (1.0, 2.0, 0.0));
        let g = fixture(r#"{"id":"f","name":"F","profileId":"p","universeId":"u","address":1,"pos":{"x":1,"y":null,"z":"oops"},"rotY":0}"#);
        assert_eq!((g.pos.x, g.pos.y, g.pos.z), (1.0, 2.0, 0.0), "null and non-numeric components repaired");
    }

    #[test]
    fn a_bad_rot_y_repairs_to_zero_and_bad_optional_angles_vanish() {
        let f = fixture(r#"{"id":"f","name":"F","profileId":"p","universeId":"u","address":1,"pos":{"x":0,"y":2,"z":0},"rotY":null,"rotX":"bad","rotZ":null}"#);
        assert_eq!(f.rot_y, 0.0, "null rotY → 0, matching the Node sanitizer");
        assert_eq!(f.rot_x, None, "non-numeric rotX deleted, not zeroed — absent means 'unset'");
        assert_eq!(f.rot_z, None);
    }

    #[test]
    fn good_spatial_values_pass_through_untouched() {
        let f = fixture(r#"{"id":"f","name":"F","profileId":"p","universeId":"u","address":1,"pos":{"x":-1.5,"y":3.25,"z":0.75},"rotY":1.5707963267948966,"rotX":0.3}"#);
        assert_eq!((f.pos.x, f.pos.y, f.pos.z), (-1.5, 3.25, 0.75));
        assert_eq!(f.rot_y, 1.5707963267948966);
        assert_eq!(f.rot_x, Some(0.3));
        assert_eq!(f.rot_z, None);
    }
}

#[cfg(test)]
mod group_auto_tests {
    use super::*;

    #[test]
    fn the_provenance_tag_round_trips_and_tolerates_junk() {
        let g: Group =
            serde_json::from_str(r#"{"id":"g","name":"G","heads":[],"auto":"type:kam"}"#).unwrap();
        assert_eq!(g.auto.as_deref(), Some("type:kam"));
        let s = serde_json::to_string(&g).unwrap();
        assert!(s.contains(r#""auto":"type:kam""#), "tag survives a save");

        // a non-string tag loads as absent, matching the Node sanitizer
        let g: Group =
            serde_json::from_str(r#"{"id":"g","name":"G","heads":[],"auto":7}"#).unwrap();
        assert_eq!(g.auto, None);
        let s = serde_json::to_string(&g).unwrap();
        assert!(!s.contains("auto"), "absent tag is not serialized");

        // authored groups (no tag) are unchanged
        let g: Group = serde_json::from_str(r#"{"id":"g","name":"G","heads":[]}"#).unwrap();
        assert_eq!(g.auto, None);
    }
}

#[cfg(test)]
mod stage_tests {
    use super::*;

    #[test]
    fn the_repair_rule_matches_the_node_sanitiser() {
        let v = |s: &str| serde_json::from_str::<serde_json::Value>(s).unwrap();
        assert_eq!(stage_from_value(&v(r#"{"w":12,"d":8,"h":6}"#)), Some(StageSize { w: 12.0, d: 8.0, h: 6.0 }));
        assert_eq!(stage_from_value(&v(r#"{"w":9000,"d":0.2,"h":3}"#)), Some(StageSize { w: 500.0, d: 1.0, h: 3.0 }), "clamped");
        assert_eq!(stage_from_value(&v(r#"{"w":10,"d":8}"#)), None, "a missing side drops the field");
        assert_eq!(stage_from_value(&v(r#"{"w":"ten","d":8,"h":4}"#)), None, "a wrong side drops the field");
        assert_eq!(stage_from_value(&v(r#"{"w":-1,"d":8,"h":6}"#)), None, "a non-positive side drops the field");
        assert_eq!(stage_from_value(&v("null")), None);
    }

    #[test]
    fn a_project_keeps_its_stage_across_a_round_trip_and_repairs_a_bad_one() {
        let mut p = crate::defaults::blank_project();
        p.stage = Some(StageSize { w: 20.0, d: 12.0, h: 8.0 });
        let json = serde_json::to_string(&p).unwrap();
        assert!(json.contains(r#""stage":{"w":20.0,"d":12.0,"h":8.0}"#), "{json}");
        let back: Project = serde_json::from_str(&json).unwrap();
        assert_eq!(back.stage, p.stage);
        // absent stays absent, and is not written
        let none = crate::defaults::blank_project();
        assert!(!serde_json::to_string(&none).unwrap().contains("\"stage\""));
        // a bad one on the wire is dropped, not rejected — the project still loads
        let bad = json.replace(r#""stage":{"w":20.0,"d":12.0,"h":8.0}"#, r#""stage":{"w":0,"d":12,"h":8}"#);
        let repaired: Project = serde_json::from_str(&bad).unwrap();
        assert_eq!(repaired.stage, None);
    }
}
