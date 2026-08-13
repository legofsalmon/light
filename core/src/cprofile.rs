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
    pub offset: f64,
    pub label: String,
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
    }
}

fn cond_matches(c: &Cond, p: &ResolvedParams, virtual_dimmer: bool) -> bool {
    match c {
        Cond::Always => true,
        Cond::SourceAtLeast { source, value } => source_value(p, *source, virtual_dimmer) >= *value,
        Cond::SourceAbove { source, value } => source_value(p, *source, virtual_dimmer) > *value,
        Cond::SourceBelow { source, value } => source_value(p, *source, virtual_dimmer) <= *value,
        Cond::MotorModeIs { mode } => p.motor_mode == *mode,
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
        heads: vec![CHead { kind: HeadKind::Derby, offset: 0.0, label: "Derby".into() }],
        beam_deg: 5.0,
        virtual_dimmer: false,
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
        kam_heads.push(CHead {
            kind: HeadKind::Rgb,
            offset: [-0.39, -0.13, 0.13, 0.39][i],
            label: format!("Par {}", i + 1),
        });
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
    });

    // Generic hazer — 2CH
    out.push(CompiledProfile {
        id: "generic-hazer-2ch".into(),
        manufacturer: "Generic".into(),
        model: "Hazer".into(),
        mode: "2 Channel".into(),
        footprint: 2,
        heads: vec![CHead { kind: HeadKind::Hazer, offset: 0.0, label: "Hazer".into() }],
        channels: vec![
            lin(0, 0, "Haze output", Source::Haze, 0, 255),
            lin(1, 0, "Fan speed", Source::Fan, 0, 255),
        ],
        beam_deg: 0.0,
        virtual_dimmer: false,
    });

    // Generic dimmer — 1CH
    out.push(CompiledProfile {
        id: "generic-dimmer-1ch".into(),
        manufacturer: "Generic".into(),
        model: "Dimmer".into(),
        mode: "1 Channel".into(),
        footprint: 1,
        heads: vec![CHead { kind: HeadKind::Dimmer, offset: 0.0, label: "Dim".into() }],
        channels: vec![lin(0, 0, "Dimmer", Source::Dimmer, 0, 255)],
        beam_deg: 25.0,
        virtual_dimmer: false,
    });

    // Generic RGB par — 3CH (virtual dimmer)
    out.push(CompiledProfile {
        id: "generic-rgb-par-3ch".into(),
        manufacturer: "Generic".into(),
        model: "RGB Par".into(),
        mode: "3 Channel".into(),
        footprint: 3,
        heads: vec![CHead { kind: HeadKind::Rgb, offset: 0.0, label: "Par".into() }],
        channels: vec![
            lin(0, 0, "Red", Source::ColorR, 0, 255),
            lin(1, 0, "Green", Source::ColorG, 0, 255),
            lin(2, 0, "Blue", Source::ColorB, 0, 255),
        ],
        beam_deg: 20.0,
        virtual_dimmer: true,
    });

    // Generic RGBW par — 4CH (virtual dimmer)
    out.push(CompiledProfile {
        id: "generic-rgbw-par-4ch".into(),
        manufacturer: "Generic".into(),
        model: "RGBW Par".into(),
        mode: "4 Channel".into(),
        footprint: 4,
        heads: vec![CHead { kind: HeadKind::Rgb, offset: 0.0, label: "Par".into() }],
        channels: vec![
            lin(0, 0, "Red", Source::ColorR, 0, 255),
            lin(1, 0, "Green", Source::ColorG, 0, 255),
            lin(2, 0, "Blue", Source::ColorB, 0, 255),
            lin(3, 0, "White", Source::White, 0, 255),
        ],
        beam_deg: 20.0,
        virtual_dimmer: true,
    });

    // Generic moving head RGBW — 10CH, 16-bit position
    out.push(CompiledProfile {
        id: "generic-mover-10ch".into(),
        manufacturer: "Generic".into(),
        model: "Moving Head RGBW".into(),
        mode: "10 Channel".into(),
        footprint: 10,
        heads: vec![CHead { kind: HeadKind::Mover, offset: 0.0, label: "Head".into() }],
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
    });

    out
}
