use crate::color::{derby_quantize, rgb_to_hsv};
use crate::types::{clamp01, MotorMode};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HeadKind {
    Rgb,
    Derby,
    Hazer,
    Dimmer,
    Mover,
}

pub struct HeadDef {
    pub kind: HeadKind,
    pub offset: f64,
}

/// Fully-resolved per-head parameters after the layer merge. Colour is RGB so
/// crossfades behave exactly like the wire channels.
#[derive(Debug, Clone)]
pub struct ResolvedParams {
    pub dimmer: f64,
    pub r: f64,
    pub g: f64,
    pub b: f64,
    pub white: f64,
    pub ring_fx: f64,
    pub strobe: f64,
    pub motor_mode: MotorMode,
    pub motor_value: f64,
    pub macro_: Option<f64>,
    pub pan: f64,
    pub tilt: f64,
    pub haze: f64,
    pub fan: f64,
}

impl Default for ResolvedParams {
    fn default() -> Self {
        ResolvedParams {
            dimmer: 0.0,
            r: 1.0,
            g: 1.0,
            b: 1.0,
            white: 0.0,
            ring_fx: 0.0,
            strobe: 0.0,
            motor_mode: MotorMode::Off,
            motor_value: 0.0,
            macro_: None,
            pan: 0.5,
            tilt: 0.5,
            haze: 0.0,
            fan: 0.0,
        }
    }
}

pub struct Profile {
    pub id: &'static str,
    pub channels: usize,
    pub heads: &'static [HeadDef],
    pub beam_deg: f64,
    pub render: fn(&[&ResolvedParams], &mut [u8], usize),
}

fn b255(v: f64) -> u8 {
    (clamp01(v) * 255.0).round() as u8
}

fn strobe_byte(s: f64) -> u8 {
    if s <= 0.01 {
        0
    } else {
        6 + (clamp01(s) * 249.0).round() as u8
    }
}

// Varytec LED Derby ST — 4CH: colour macro / strobe / motor / white ring.
fn render_derby(heads: &[&ResolvedParams], buf: &mut [u8], base: usize) {
    let p = heads[0];
    let lit = p.dimmer > 0.02;
    buf[base] = if !lit {
        0
    } else if let Some(m) = p.macro_ {
        m.clamp(0.0, 255.0).round() as u8
    } else {
        let (h, s, _) = rgb_to_hsv(p.r, p.g, p.b);
        derby_quantize(h, s).value
    };
    buf[base + 1] = strobe_byte(p.strobe);
    buf[base + 2] = match p.motor_mode {
        MotorMode::Off => 0,
        MotorMode::Aim => 1 + (clamp01(p.motor_value) * 126.0).round() as u8,
        MotorMode::Rotate => 128 + (clamp01(p.motor_value) * 127.0).round() as u8,
    };
    buf[base + 3] = if p.white >= 0.5 {
        220
    } else if p.ring_fx > 0.01 {
        10 + (clamp01(p.ring_fx) * 169.0).round() as u8
    } else {
        0
    };
}

// KAM Power Partybar WFS — 20CH: 4 pars × R/G/B/Dimmer/Flash.
fn render_partybar(heads: &[&ResolvedParams], buf: &mut [u8], base: usize) {
    for i in 0..4 {
        let p = heads[i];
        let o = base + i * 5;
        buf[o] = b255(p.r);
        buf[o + 1] = b255(p.g);
        buf[o + 2] = b255(p.b);
        buf[o + 3] = b255(p.dimmer);
        buf[o + 4] = strobe_byte(p.strobe);
    }
}

fn render_hazer(heads: &[&ResolvedParams], buf: &mut [u8], base: usize) {
    buf[base] = b255(heads[0].haze);
    buf[base + 1] = b255(heads[0].fan);
}

fn render_dimmer(heads: &[&ResolvedParams], buf: &mut [u8], base: usize) {
    buf[base] = b255(heads[0].dimmer);
}

fn render_rgb_par(heads: &[&ResolvedParams], buf: &mut [u8], base: usize) {
    let p = heads[0];
    buf[base] = b255(p.r * p.dimmer);
    buf[base + 1] = b255(p.g * p.dimmer);
    buf[base + 2] = b255(p.b * p.dimmer);
}

fn render_rgbw_par(heads: &[&ResolvedParams], buf: &mut [u8], base: usize) {
    let p = heads[0];
    buf[base] = b255(p.r * p.dimmer);
    buf[base + 1] = b255(p.g * p.dimmer);
    buf[base + 2] = b255(p.b * p.dimmer);
    buf[base + 3] = b255(p.white * p.dimmer);
}

fn render_mover(heads: &[&ResolvedParams], buf: &mut [u8], base: usize) {
    let p = heads[0];
    let pan16 = (clamp01(p.pan) * 65535.0).round() as u16;
    let tilt16 = (clamp01(p.tilt) * 65535.0).round() as u16;
    buf[base] = (pan16 >> 8) as u8;
    buf[base + 1] = (pan16 & 0xff) as u8;
    buf[base + 2] = (tilt16 >> 8) as u8;
    buf[base + 3] = (tilt16 & 0xff) as u8;
    buf[base + 4] = b255(p.dimmer);
    buf[base + 5] = strobe_byte(p.strobe);
    buf[base + 6] = b255(p.r);
    buf[base + 7] = b255(p.g);
    buf[base + 8] = b255(p.b);
    buf[base + 9] = b255(p.white);
}

static DERBY_HEADS: &[HeadDef] = &[HeadDef { kind: HeadKind::Derby, offset: 0.0 }];
static PARTYBAR_HEADS: &[HeadDef] = &[
    HeadDef { kind: HeadKind::Rgb, offset: -0.39 },
    HeadDef { kind: HeadKind::Rgb, offset: -0.13 },
    HeadDef { kind: HeadKind::Rgb, offset: 0.13 },
    HeadDef { kind: HeadKind::Rgb, offset: 0.39 },
];
static HAZER_HEADS: &[HeadDef] = &[HeadDef { kind: HeadKind::Hazer, offset: 0.0 }];
static DIMMER_HEADS: &[HeadDef] = &[HeadDef { kind: HeadKind::Dimmer, offset: 0.0 }];
static PAR_HEADS: &[HeadDef] = &[HeadDef { kind: HeadKind::Rgb, offset: 0.0 }];
static MOVER_HEADS: &[HeadDef] = &[HeadDef { kind: HeadKind::Mover, offset: 0.0 }];

pub static PROFILES: &[Profile] = &[
    Profile { id: "varytec-derby-st-4ch", channels: 4, heads: DERBY_HEADS, beam_deg: 5.0, render: render_derby },
    Profile { id: "kam-partybar-wfs-20ch", channels: 20, heads: PARTYBAR_HEADS, beam_deg: 15.0, render: render_partybar },
    Profile { id: "generic-hazer-2ch", channels: 2, heads: HAZER_HEADS, beam_deg: 0.0, render: render_hazer },
    Profile { id: "generic-dimmer-1ch", channels: 1, heads: DIMMER_HEADS, beam_deg: 25.0, render: render_dimmer },
    Profile { id: "generic-rgb-par-3ch", channels: 3, heads: PAR_HEADS, beam_deg: 20.0, render: render_rgb_par },
    Profile { id: "generic-rgbw-par-4ch", channels: 4, heads: PAR_HEADS, beam_deg: 20.0, render: render_rgbw_par },
    Profile { id: "generic-mover-10ch", channels: 10, heads: MOVER_HEADS, beam_deg: 12.0, render: render_mover },
];

pub fn profile_of(id: &str) -> Option<&'static Profile> {
    PROFILES.iter().find(|p| p.id == id)
}
