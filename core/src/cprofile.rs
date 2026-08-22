//! Compiled fixture profiles — the data-driven layer that GDTF imports (and
//! eventually all built-ins) compile into. One interpreter, defined here,
//! renders resolved parameters to DMX; profiles become serializable data
//! instead of code, so imported fixtures need no per-engine implementation.
//!
//! Semantics are locked to the legacy code-profile behaviour by golden tests
//! (`tests/cprofile_golden.rs`): for every built-in, the interpreter must
//! emit byte-identical output across the parameter space.

use serde::{Deserialize, Serialize};

use crate::color::{hsv_to_rgb, rgb_to_hsv};
use crate::profiles::{HeadKind, ResolvedParams};
use crate::types::{clamp01, MotorMode};

/// A scalar the interpreter can read off the resolved head parameters.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Source {
    Dimmer,
    ColorR,
    ColorG,
    ColorB,
    White,
    RingFx,
    Strobe,
    MotorValue,
    Pan,
    Tilt,
    Haze,
    Fan,
    // Beam parameters. Unlike the sources above these can be *unset*: a look
    // that says nothing about zoom must leave the zoom channel parked at the
    // value the fixture's own GDTF nominates, not drive it to zero.
    Zoom,
    Focus,
    Iris,
    Frost,
    Cto,
}

/// Case guard — the first matching case in a channel wins.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum Cond {
    Always,
    /// source >= value
    SourceAtLeast { source: Source, value: f64 },
    /// source > value
    SourceAbove { source: Source, value: f64 },
    /// source <= value
    SourceBelow { source: Source, value: f64 },
    MotorModeIs { mode: MotorMode },
    /// the source carries no value — the look never touched this parameter
    SourceUnset { source: Source },
}

/// One slot on a banded/wheel channel (colour wheels, macro tables, gobos).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WheelSet {
    /// DMX value transmitted for this slot (band midpoint)
    pub value: u8,
    pub min: u8,
    pub max: u8,
    pub name: String,
    /// component colours 0..255, for previz and nearest-colour matching
    pub comps: Vec<[u8; 3]>,
    /// eligible for automatic colour quantisation
    pub auto: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum Func {
    /// write a constant
    Fixed { value: u16 },
    /// map source 0..1 linearly onto dmxFrom..dmxTo (inclusive), rounded
    Linear { source: Source },
    /// banded wheel: explicit DMX override (params.macro) when allowed,
    /// else nearest-colour among `auto` sets
    Wheel { sets: Vec<WheelSet>, allow_explicit: bool },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FuncCase {
    pub cond: Cond,
    pub dmx_from: u16,
    pub dmx_to: u16,
    pub func: Func,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CChannel {
    /// 0-based offsets within the footprint; [coarse] or [coarse, fine]
    pub offsets: Vec<usize>,
    /// which head this channel belongs to
    pub head: usize,
    pub cases: Vec<FuncCase>,
    /// written when no case matches
    pub default: u16,
    /// display name (patch table / DMX monitor)
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CHead {
    pub kind: HeadKind,
    /// metres along the fixture's local X axis. Tolerant: the Node sanitizer
    /// repairs a non-finite/absent spatial field to 0, and the two engines
    /// must land on the same values or geometry diverges — so a shape Node
    /// repairs must never fail the whole Rust project load.
    #[serde(default, deserialize_with = "de_metres")]
    pub offset: f64,
    /// metres along the fixture's local Y axis (up) — B1: real pixel layouts
    /// are 2D. Defaults keep every pre-B1 save loading as a flat bar.
    #[serde(default, deserialize_with = "de_metres", skip_serializing_if = "is_zero")]
    pub offset_y: f64,
    /// grid coordinates within the fixture (row 0 = top). When EVERY head of a
    /// profile is (0, 0) — pre-B1 saves, single-row imports — the geometry
    /// builder falls back to col = head index, one row.
    #[serde(default, deserialize_with = "de_index", skip_serializing_if = "is_zero_usize")]
    pub row: usize,
    #[serde(default, deserialize_with = "de_index", skip_serializing_if = "is_zero_usize")]
    pub col: usize,
    pub label: String,
}

fn is_zero(v: &f64) -> bool {
    *v == 0.0
}

fn is_zero_usize(v: &usize) -> bool {
    *v == 0
}

/// Finite number or 0 — mirrors the Node sanitizer's profile-head repair.
fn de_metres<'de, D: serde::Deserializer<'de>>(d: D) -> Result<f64, D::Error> {
    let v = Option::<serde_json::Value>::deserialize(d)?;
    Ok(match v.as_ref().and_then(|x| x.as_f64()) {
        Some(n) if n.is_finite() => n,
        _ => 0.0,
    })
}

/// Non-negative integer or 0 (floor, clamp) — mirrors the Node sanitizer.
fn de_index<'de, D: serde::Deserializer<'de>>(d: D) -> Result<usize, D::Error> {
    let v = Option::<serde_json::Value>::deserialize(d)?;
    Ok(match v.as_ref().and_then(|x| x.as_f64()) {
        Some(n) if n.is_finite() && n >= 0.0 => n.floor() as usize,
        _ => 0,
    })
}

impl CHead {
    /// A single-row head with no vertical offset — the pre-B1 shape.
    pub fn flat(kind: HeadKind, offset: f64, label: String) -> CHead {
        CHead { kind, offset, offset_y: 0.0, row: 0, col: 0, label }
    }
}

/// What SHAPE of fixture this profile describes — the box, not the emitter.
///
/// `HeadKind` already says what one emitter does; this says what the thing on
/// the truss physically is, which is a different question and the one a
/// renderer needs. A CLF Nero is a rectangular blinder plate that happens to
/// tilt; a Robe Spiider is a moving head that happens to have nineteen pixels.
/// Neither is knowable from the head kinds alone, and getting it wrong is
/// visible: before this existed, every Nero in the demo show rendered as a
/// 16 cm cube throwing a spotlight cone, when it is a 41 x 32 cm panel.
///
/// Deliberately short. Each variant has to earn itself by changing how the
/// fixture is drawn or lit, not by being a category a catalogue would use.
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum FixtureForm {
    /// Yoke and head: aims, throws a cone.
    Mover,
    /// A single-lens can on a bracket.
    Par,
    /// A linear batten or pixel bar — long, thin, cells in a row.
    Bar,
    /// A rectangular plate: blinders, LED panels, strobe plates. An AREA
    /// emitter, not a lens — the thing a cone is most wrong about.
    Panel,
    /// A single-lens strobe.
    Strobe,
    /// Multi-lens rotating effect.
    Derby,
    /// Puts haze in the air and emits nothing.
    Hazer,
}

impl FixtureForm {
    pub fn label(self) -> &'static str {
        match self {
            FixtureForm::Mover => "moving head",
            FixtureForm::Par => "par",
            FixtureForm::Bar => "bar / batten",
            FixtureForm::Panel => "panel / blinder",
            FixtureForm::Strobe => "strobe",
            FixtureForm::Derby => "derby",
            FixtureForm::Hazer => "hazer",
        }
    }

    pub const ALL: [FixtureForm; 7] = [
        FixtureForm::Mover,
        FixtureForm::Par,
        FixtureForm::Bar,
        FixtureForm::Panel,
        FixtureForm::Strobe,
        FixtureForm::Derby,
        FixtureForm::Hazer,
    ];
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompiledProfile {
    pub id: String,
    pub manufacturer: String,
    pub model: String,
    pub mode: String,
    pub footprint: usize,
    pub heads: Vec<CHead>,
    pub channels: Vec<CChannel>,
    pub beam_deg: f64,
    /// no dimmer channel exists: fold intensity into colour/white sources
    pub virtual_dimmer: bool,
    /// Who authored the fixture definition this was compiled from.
    ///
    /// GDTF Share's terms require that "our status (and that of any identified
    /// contributors) as the authors of material on our Website must always be
    /// acknowledged", and a compiled profile travels inside the project file to
    /// wherever the show goes. Carrying the credit with it is the one licence
    /// condition we can satisfy unilaterally. Absent on the built-in profiles,
    /// which nobody else wrote.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credit: Option<String>,

    /// An operator's override of the inferred form. Normally absent.
    ///
    /// Only the OVERRIDE is stored, never the guess. Two reasons: a re-import
    /// must not silently clobber a correction someone made by hand, and
    /// improving the heuristic should improve every show that already exists
    /// rather than only the ones imported afterwards. `form()` is the accessor
    /// everything should use.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub form_override: Option<FixtureForm>,
}

impl CompiledProfile {
    /// The form to draw this fixture as: the operator's override if they set
    /// one, otherwise a guess from the profile itself.
    pub fn form(&self) -> FixtureForm {
        self.form_override.unwrap_or_else(|| self.infer_form())
    }

    /// Guess the form from what the profile actually says.
    ///
    /// Ordered, because the tests overlap. The beam angle carries most of the
    /// signal and is the one that catches blinders: a source wider than 90 deg
    /// has no lens worth speaking of, so it is a flood or a plate whatever else
    /// it can do. That is what puts a CLF Nero — 123 deg, tilts, no pan — in
    /// Panel rather than Mover, which testing it for aim first would not.
    fn infer_form(&self) -> FixtureForm {
        let kinds: Vec<HeadKind> = self.heads.iter().map(|h| h.kind).collect();
        if kinds.iter().any(|k| *k == HeadKind::Hazer) {
            return FixtureForm::Hazer;
        }
        if kinds.iter().any(|k| *k == HeadKind::Derby) {
            return FixtureForm::Derby;
        }
        // A real moving head steers in both axes. Tilt alone is a hanging
        // bracket, which plenty of static fixtures have.
        if self.drives(Source::Pan) && self.drives(Source::Tilt) {
            return FixtureForm::Mover;
        }
        if self.beam_deg >= 90.0 {
            return FixtureForm::Panel;
        }
        // Cells spread along the fixture's own X, with no height to them: a
        // batten. `span` is in metres, from the pixel layout.
        if self.heads.len() >= 4 {
            let span = self.head_span();
            let rise = self.head_rise();
            if span > 0.0 && rise <= span * 0.35 {
                return FixtureForm::Bar;
            }
            return FixtureForm::Panel;
        }
        if self.drives(Source::Strobe) && !self.drives(Source::ColorR) {
            return FixtureForm::Strobe;
        }
        FixtureForm::Par
    }

    /// Does any channel actually drive this source? An attribute that compiled
    /// to no cases drives nothing, which is the whole point of the check.
    pub fn drives(&self, want: Source) -> bool {
        self.channels.iter().any(|ch| {
            ch.cases.iter().any(|case| match &case.func {
                Func::Linear { source } => *source == want,
                _ => false,
            })
        })
    }

    /// Width across the cells, in metres.
    pub fn head_span(&self) -> f64 {
        let (mut lo, mut hi) = (f64::INFINITY, f64::NEG_INFINITY);
        for h in &self.heads {
            lo = lo.min(h.offset);
            hi = hi.max(h.offset);
        }
        if hi >= lo { hi - lo } else { 0.0 }
    }

    /// Height across the cells, in metres.
    pub fn head_rise(&self) -> f64 {
        let (mut lo, mut hi) = (f64::INFINITY, f64::NEG_INFINITY);
        for h in &self.heads {
            lo = lo.min(h.offset_y);
            hi = hi.max(h.offset_y);
        }
        if hi >= lo { hi - lo } else { 0.0 }
    }
}

// ---------------------------------------------------------------------------
// Interpreter
// ---------------------------------------------------------------------------

fn source_value(p: &ResolvedParams, s: Source, virtual_dimmer: bool) -> f64 {
    let vd = |v: f64| if virtual_dimmer { v * p.dimmer } else { v };
    match s {
        Source::Dimmer => p.dimmer,
        Source::ColorR => vd(p.r),
        Source::ColorG => vd(p.g),
        Source::ColorB => vd(p.b),
        Source::White => vd(p.white),
        Source::RingFx => p.ring_fx,
        Source::Strobe => p.strobe,
        Source::MotorValue => p.motor_value,
        Source::Pan => p.pan,
        Source::Tilt => p.tilt,
        Source::Haze => p.haze,
        Source::Fan => p.fan,
        // 0.0 is never reached for a set parameter: a channel driven by an
        // optional source is guarded by Cond::SourceUnset, which takes the
        // fixed-default branch first.
        Source::Zoom => p.beam.zoom.unwrap_or(0.0),
        Source::Focus => p.beam.focus.unwrap_or(0.0),
        Source::Iris => p.beam.iris.unwrap_or(0.0),
        Source::Frost => p.beam.frost.unwrap_or(0.0),
        Source::Cto => p.beam.cto.unwrap_or(0.0),
    }
}

/// Whether an optional source currently carries a value.
fn source_is_set(p: &ResolvedParams, s: Source) -> bool {
    match s {
        Source::Zoom => p.beam.zoom.is_some(),
        Source::Focus => p.beam.focus.is_some(),
        Source::Iris => p.beam.iris.is_some(),
        Source::Frost => p.beam.frost.is_some(),
        Source::Cto => p.beam.cto.is_some(),
        _ => true,
    }
}

fn cond_matches(c: &Cond, p: &ResolvedParams, virtual_dimmer: bool) -> bool {
    match c {
        Cond::Always => true,
        Cond::SourceAtLeast { source, value } => source_value(p, *source, virtual_dimmer) >= *value,
        Cond::SourceAbove { source, value } => source_value(p, *source, virtual_dimmer) > *value,
        Cond::SourceBelow { source, value } => source_value(p, *source, virtual_dimmer) <= *value,
        Cond::MotorModeIs { mode } => p.motor_mode == *mode,
        Cond::SourceUnset { source } => !source_is_set(p, *source),
    }
}

/// Nearest wheel slot for an RGB colour — mirrors the legacy derby
/// quantisation exactly: desaturated colours pick the pure-white slot, else
/// nearest average-component colour among `auto` slots.
fn wheel_quantize(sets: &[WheelSet], p: &ResolvedParams) -> u16 {
    let (h, s, _) = rgb_to_hsv(p.r, p.g, p.b);
    if s < 0.15 {
        if let Some(w) = sets.iter().find(|w| w.auto && w.comps.as_slice() == [[255u8, 255, 255]]) {
            return w.value as u16;
        }
    }
    let (tr, tg, tb) = hsv_to_rgb(h, s, 1.0);
    let mut best: Option<(&WheelSet, f64)> = None;
    for w in sets {
        if !w.auto || w.comps.is_empty() {
            continue;
        }
        let (mut ar, mut ag, mut ab) = (0.0, 0.0, 0.0);
        for c in &w.comps {
            ar += c[0] as f64;
            ag += c[1] as f64;
            ab += c[2] as f64;
        }
        let n = w.comps.len() as f64 * 255.0;
        let d = (tr - ar / n).powi(2) + (tg - ag / n).powi(2) + (tb - ab / n).powi(2);
        if best.map_or(true, |(_, bd)| d < bd) {
            best = Some((w, d));
        }
    }
    best.map(|(w, _)| w.value as u16).unwrap_or(0)
}

fn eval_case(case: &FuncCase, p: &ResolvedParams, virtual_dimmer: bool) -> u16 {
    match &case.func {
        Func::Fixed { value } => *value,
        Func::Linear { source } => {
            // f64 math end-to-end: untrusted profiles may have from > to, and
            // u16 arithmetic here must never underflow/overflow the tick loop
            let v = clamp01(source_value(p, *source, virtual_dimmer));
            let from = case.dmx_from as f64;
            let to = case.dmx_to as f64;
            (from + v * (to - from)).round().clamp(0.0, 65535.0) as u16
        }
        Func::Wheel { sets, allow_explicit } => {
            if *allow_explicit {
                if let Some(m) = p.macro_ {
                    return m.clamp(0.0, 255.0).round() as u16;
                }
            }
            wheel_quantize(sets, p)
        }
    }
}

/// Render one fixture's heads through a compiled profile into a DMX buffer.
pub fn render_compiled(cp: &CompiledProfile, heads: &[&ResolvedParams], buf: &mut [u8], base: usize) {
    for ch in &cp.channels {
        let Some(p) = heads.get(ch.head) else { continue };
        let mut out = ch.default;
        for case in &ch.cases {
            if cond_matches(&case.cond, p, cp.virtual_dimmer) {
                out = eval_case(case, p, cp.virtual_dimmer);
                break;
            }
        }
        match ch.offsets.as_slice() {
            [o] => {
                if base + o < buf.len() {
                    buf[base + o] = out.min(255) as u8;
                }
            }
            [hi, lo] => {
                if base + hi < buf.len() && base + lo < buf.len() {
                    buf[base + hi] = (out >> 8) as u8;
                    buf[base + lo] = (out & 0xff) as u8;
                }
            }
            _ => {}
        }
    }
}

// ---------------------------------------------------------------------------
// Built-ins expressed as data
// ---------------------------------------------------------------------------

fn lin(offset: usize, head: usize, name: &str, source: Source, from: u16, to: u16) -> CChannel {
    CChannel {
        offsets: vec![offset],
        head,
        name: name.into(),
        default: 0,
        cases: vec![FuncCase { cond: Cond::Always, dmx_from: from, dmx_to: to, func: Func::Linear { source } }],
    }
}

fn lin16(offsets: [usize; 2], head: usize, name: &str, source: Source) -> CChannel {
    CChannel {
        offsets: offsets.to_vec(),
        head,
        name: name.into(),
        default: 0,
        cases: vec![FuncCase { cond: Cond::Always, dmx_from: 0, dmx_to: 65535, func: Func::Linear { source } }],
    }
}

/// 0–5 open, 6–255 slow→fast — the shared shutter/flash shape.
fn strobe_channel(offset: usize, head: usize, name: &str) -> CChannel {
    CChannel {
        offsets: vec![offset],
        head,
        name: name.into(),
        default: 0,
        cases: vec![
            FuncCase {
                cond: Cond::SourceBelow { source: Source::Strobe, value: 0.01 },
                dmx_from: 0,
                dmx_to: 0,
                func: Func::Fixed { value: 0 },
            },
            FuncCase { cond: Cond::Always, dmx_from: 6, dmx_to: 255, func: Func::Linear { source: Source::Strobe } },
        ],
    }
}

fn derby_wheel_sets() -> Vec<WheelSet> {
    crate::color::DERBY_MACROS
        .iter()
        .map(|m| WheelSet {
            value: m.value,
            min: m.min,
            max: m.max,
            name: m.name.into(),
            comps: m.comps.to_vec(),
            auto: m.auto,
        })
        .collect()
}

pub fn compiled_builtins() -> Vec<CompiledProfile> {
    let mut out = Vec::new();

    // Varytec LED Derby ST — 4CH
    out.push(CompiledProfile {
        id: "varytec-derby-st-4ch".into(),
        manufacturer: "Varytec".into(),
        model: "LED Derby ST".into(),
        mode: "4 Channel".into(),
        footprint: 4,
        heads: vec![CHead::flat(HeadKind::Derby, 0.0, "Derby".into())],
        beam_deg: 5.0,
        virtual_dimmer: false,
        credit: None,
        form_override: None,
        channels: vec![
            CChannel {
                offsets: vec![0],
                head: 0,
                name: "Colour macro".into(),
                default: 0,
                cases: vec![
                    FuncCase {
                        cond: Cond::SourceBelow { source: Source::Dimmer, value: 0.02 },
                        dmx_from: 0,
                        dmx_to: 0,
                        func: Func::Fixed { value: 0 },
                    },
                    FuncCase {
                        cond: Cond::Always,
                        dmx_from: 0,
                        dmx_to: 255,
                        func: Func::Wheel { sets: derby_wheel_sets(), allow_explicit: true },
                    },
                ],
            },
            strobe_channel(1, 0, "Strobe"),
            CChannel {
                offsets: vec![2],
                head: 0,
                name: "Motor".into(),
                default: 0,
                cases: vec![
                    FuncCase {
                        cond: Cond::MotorModeIs { mode: MotorMode::Off },
                        dmx_from: 0,
                        dmx_to: 0,
                        func: Func::Fixed { value: 0 },
                    },
                    FuncCase {
                        cond: Cond::MotorModeIs { mode: MotorMode::Aim },
                        dmx_from: 1,
                        dmx_to: 127,
                        func: Func::Linear { source: Source::MotorValue },
                    },
                    FuncCase {
                        cond: Cond::MotorModeIs { mode: MotorMode::Rotate },
                        dmx_from: 128,
                        dmx_to: 255,
                        func: Func::Linear { source: Source::MotorValue },
                    },
                ],
            },
            CChannel {
                offsets: vec![3],
                head: 0,
                name: "White ring".into(),
                default: 0,
                cases: vec![
                    FuncCase {
                        cond: Cond::SourceAtLeast { source: Source::White, value: 0.5 },
                        dmx_from: 220,
                        dmx_to: 220,
                        func: Func::Fixed { value: 220 },
                    },
                    FuncCase {
                        cond: Cond::SourceAbove { source: Source::RingFx, value: 0.01 },
                        dmx_from: 10,
                        dmx_to: 179,
                        func: Func::Linear { source: Source::RingFx },
                    },
                ],
            },
        ],
    });

    // KAM Power Partybar WFS — 20CH: 4 × (R,G,B,Dimmer,Flash)
    let mut kam_channels = Vec::new();
    let mut kam_heads = Vec::new();
    for i in 0..4 {
        let o = i * 5;
        kam_heads.push(CHead::flat(
            HeadKind::Rgb,
            [-0.39, -0.13, 0.13, 0.39][i],
            format!("Par {}", i + 1),
        ));
        kam_channels.push(lin(o, i, &format!("Par {} Red", i + 1), Source::ColorR, 0, 255));
        kam_channels.push(lin(o + 1, i, &format!("Par {} Green", i + 1), Source::ColorG, 0, 255));
        kam_channels.push(lin(o + 2, i, &format!("Par {} Blue", i + 1), Source::ColorB, 0, 255));
        kam_channels.push(lin(o + 3, i, &format!("Par {} Dimmer", i + 1), Source::Dimmer, 0, 255));
        kam_channels.push(strobe_channel(o + 4, i, &format!("Par {} Flash", i + 1)));
    }
    out.push(CompiledProfile {
        id: "kam-partybar-wfs-20ch".into(),
        manufacturer: "KAM".into(),
        model: "Power Partybar WFS".into(),
        mode: "20 Channel".into(),
        footprint: 20,
        heads: kam_heads,
        channels: kam_channels,
        beam_deg: 15.0,
        virtual_dimmer: false,
        credit: None,
        form_override: None,
    });

    // Generic hazer — 2CH
    out.push(CompiledProfile {
        id: "generic-hazer-2ch".into(),
        manufacturer: "Generic".into(),
        model: "Hazer".into(),
        mode: "2 Channel".into(),
        footprint: 2,
        heads: vec![CHead::flat(HeadKind::Hazer, 0.0, "Hazer".into())],
        channels: vec![
            lin(0, 0, "Haze output", Source::Haze, 0, 255),
            lin(1, 0, "Fan speed", Source::Fan, 0, 255),
        ],
        beam_deg: 0.0,
        virtual_dimmer: false,
        credit: None,
        form_override: None,
    });

    // Generic dimmer — 1CH
    out.push(CompiledProfile {
        id: "generic-dimmer-1ch".into(),
        manufacturer: "Generic".into(),
        model: "Dimmer".into(),
        mode: "1 Channel".into(),
        footprint: 1,
        heads: vec![CHead::flat(HeadKind::Dimmer, 0.0, "Dim".into())],
        channels: vec![lin(0, 0, "Dimmer", Source::Dimmer, 0, 255)],
        beam_deg: 25.0,
        virtual_dimmer: false,
        credit: None,
        form_override: None,
    });

    // Generic RGB par — 3CH (virtual dimmer)
    out.push(CompiledProfile {
        id: "generic-rgb-par-3ch".into(),
        manufacturer: "Generic".into(),
        model: "RGB Par".into(),
        mode: "3 Channel".into(),
        footprint: 3,
        heads: vec![CHead::flat(HeadKind::Rgb, 0.0, "Par".into())],
        channels: vec![
            lin(0, 0, "Red", Source::ColorR, 0, 255),
            lin(1, 0, "Green", Source::ColorG, 0, 255),
            lin(2, 0, "Blue", Source::ColorB, 0, 255),
        ],
        beam_deg: 20.0,
        virtual_dimmer: true,
        credit: None,
        form_override: None,
    });

    // Generic RGBW par — 4CH (virtual dimmer)
    out.push(CompiledProfile {
        id: "generic-rgbw-par-4ch".into(),
        manufacturer: "Generic".into(),
        model: "RGBW Par".into(),
        mode: "4 Channel".into(),
        footprint: 4,
        heads: vec![CHead::flat(HeadKind::Rgb, 0.0, "Par".into())],
        channels: vec![
            lin(0, 0, "Red", Source::ColorR, 0, 255),
            lin(1, 0, "Green", Source::ColorG, 0, 255),
            lin(2, 0, "Blue", Source::ColorB, 0, 255),
            lin(3, 0, "White", Source::White, 0, 255),
        ],
        beam_deg: 20.0,
        virtual_dimmer: true,
        credit: None,
        form_override: None,
    });

    // Generic moving head RGBW — 10CH, 16-bit position
    out.push(CompiledProfile {
        id: "generic-mover-10ch".into(),
        manufacturer: "Generic".into(),
        model: "Moving Head RGBW".into(),
        mode: "10 Channel".into(),
        footprint: 10,
        heads: vec![CHead::flat(HeadKind::Mover, 0.0, "Head".into())],
        channels: vec![
            lin16([0, 1], 0, "Pan", Source::Pan),
            lin16([2, 3], 0, "Tilt", Source::Tilt),
            lin(4, 0, "Dimmer", Source::Dimmer, 0, 255),
            strobe_channel(5, 0, "Strobe"),
            lin(6, 0, "Red", Source::ColorR, 0, 255),
            lin(7, 0, "Green", Source::ColorG, 0, 255),
            lin(8, 0, "Blue", Source::ColorB, 0, 255),
            lin(9, 0, "White", Source::White, 0, 255),
        ],
        beam_deg: 12.0,
        virtual_dimmer: false,
        credit: None,
        form_override: None,
    });

    out
}

#[cfg(test)]
mod head_repair_tests {
    use super::*;

    #[test]
    fn malformed_spatial_fields_repair_instead_of_failing_the_project() {
        // a shape the Node sanitizer repairs must never fail the Rust load —
        // geometry consumes these fields now, so both engines must land on
        // the same values (finite-or-0; indices floor≥0-or-0)
        let h: CHead = serde_json::from_str(
            r#"{"kind":"rgb","offset":null,"offsetY":"oops","row":1.7,"col":-3,"label":"px"}"#,
        )
        .expect("malformed spatial fields must load");
        assert_eq!(h.offset, 0.0);
        assert_eq!(h.offset_y, 0.0);
        assert_eq!(h.row, 1, "1.7 floors to 1, matching Math.floor");
        assert_eq!(h.col, 0, "negative clamps to 0");
    }

    #[test]
    fn good_spatial_fields_pass_through() {
        let h: CHead = serde_json::from_str(
            r#"{"kind":"rgb","offset":-0.25,"offsetY":0.1,"row":2,"col":5,"label":"px"}"#,
        )
        .unwrap();
        assert_eq!((h.offset, h.offset_y, h.row, h.col), (-0.25, 0.1, 2, 5));
    }
}
