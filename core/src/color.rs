use crate::types::clamp01;

/// HSV → RGB, hue 0..360, s/v 0..1.
pub fn hsv_to_rgb(h: f64, s: f64, v: f64) -> (f64, f64, f64) {
    let h = ((h % 360.0) + 360.0) % 360.0;
    let s = clamp01(s);
    let v = clamp01(v);
    let c = v * s;
    let x = c * (1.0 - ((h / 60.0) % 2.0 - 1.0).abs());
    let m = v - c;
    let (r, g, b) = if h < 60.0 {
        (c, x, 0.0)
    } else if h < 120.0 {
        (x, c, 0.0)
    } else if h < 180.0 {
        (0.0, c, x)
    } else if h < 240.0 {
        (0.0, x, c)
    } else if h < 300.0 {
        (x, 0.0, c)
    } else {
        (c, 0.0, x)
    };
    (r + m, g + m, b + m)
}

/// RGB 0..1 → (hue 0..360, sat 0..1, val 0..1).
pub fn rgb_to_hsv(r: f64, g: f64, b: f64) -> (f64, f64, f64) {
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let d = max - min;
    let mut h = 0.0;
    if d > 0.0 {
        if max == r {
            h = 60.0 * (((g - b) / d) % 6.0);
        } else if max == g {
            h = 60.0 * ((b - r) / d + 2.0);
        } else {
            h = 60.0 * ((r - g) / d + 4.0);
        }
    }
    if h < 0.0 {
        h += 360.0;
    }
    (h, if max == 0.0 { 0.0 } else { d / max }, max)
}

/// Varytec LED Derby ST colour-macro table (4CH mode, CH1) — band midpoints
/// with component colours, identical to `shared/color.ts`.
pub struct DerbyMacro {
    pub value: u8,
    pub min: u8,
    pub max: u8,
    pub name: &'static str,
    pub comps: &'static [[u8; 3]],
    pub auto: bool,
}

const R: [u8; 3] = [255, 0, 0];
const G: [u8; 3] = [0, 255, 0];
const B: [u8; 3] = [0, 0, 255];
const W: [u8; 3] = [255, 255, 255];

pub static DERBY_MACROS: &[DerbyMacro] = &[
    DerbyMacro { value: 0, min: 0, max: 5, name: "Off", comps: &[], auto: false },
    DerbyMacro { value: 13, min: 6, max: 20, name: "Red", comps: &[R], auto: true },
    DerbyMacro { value: 28, min: 21, max: 35, name: "Green", comps: &[G], auto: true },
    DerbyMacro { value: 43, min: 36, max: 50, name: "Blue", comps: &[B], auto: true },
    DerbyMacro { value: 58, min: 51, max: 65, name: "White", comps: &[W], auto: true },
    DerbyMacro { value: 73, min: 66, max: 80, name: "Red + Green", comps: &[R, G], auto: true },
    DerbyMacro { value: 88, min: 81, max: 95, name: "Red + Blue", comps: &[R, B], auto: true },
    DerbyMacro { value: 103, min: 96, max: 110, name: "Red + White", comps: &[R, W], auto: true },
    DerbyMacro { value: 118, min: 111, max: 125, name: "Green + Blue", comps: &[G, B], auto: true },
    DerbyMacro { value: 133, min: 126, max: 140, name: "Green + White", comps: &[G, W], auto: true },
    DerbyMacro { value: 148, min: 141, max: 155, name: "Blue + White", comps: &[B, W], auto: true },
    DerbyMacro { value: 163, min: 156, max: 170, name: "R + G + B", comps: &[R, G, B], auto: true },
    DerbyMacro { value: 178, min: 171, max: 185, name: "R + G + W", comps: &[R, G, W], auto: true },
    DerbyMacro { value: 193, min: 186, max: 200, name: "G + B + W", comps: &[G, B, W], auto: true },
    DerbyMacro { value: 208, min: 201, max: 215, name: "R + G + B + W", comps: &[R, G, B, W], auto: true },
    DerbyMacro { value: 223, min: 216, max: 230, name: "Colour Change 1", comps: &[R, G, B], auto: false },
    DerbyMacro { value: 243, min: 231, max: 255, name: "Colour Change 2", comps: &[R, G, B, W], auto: false },
];

pub fn derby_macro_for_value(v: f64) -> &'static DerbyMacro {
    let v = v.clamp(0.0, 255.0) as u8;
    DERBY_MACROS
        .iter()
        .find(|m| v >= m.min && v <= m.max)
        .unwrap_or(&DERBY_MACROS[0])
}

fn avg_comp(m: &DerbyMacro) -> (f64, f64, f64) {
    if m.comps.is_empty() {
        return (0.0, 0.0, 0.0);
    }
    let (mut r, mut g, mut b) = (0.0, 0.0, 0.0);
    for c in m.comps {
        r += c[0] as f64;
        g += c[1] as f64;
        b += c[2] as f64;
    }
    let n = m.comps.len() as f64;
    (r / n / 255.0, g / n / 255.0, b / n / 255.0)
}

/// Nearest displayable macro for a hue/sat — the derby cannot mix RGB.
pub fn derby_quantize(h: f64, s: f64) -> &'static DerbyMacro {
    if s < 0.15 {
        return &DERBY_MACROS[4]; // White
    }
    let (tr, tg, tb) = hsv_to_rgb(h, s, 1.0);
    let mut best = &DERBY_MACROS[1];
    let mut best_d = f64::INFINITY;
    for m in DERBY_MACROS {
        if !m.auto {
            continue;
        }
        let (mr, mg, mb) = avg_comp(m);
        let d = (tr - mr).powi(2) + (tg - mg).powi(2) + (tb - mb).powi(2);
        if d < best_d {
            best_d = d;
            best = m;
        }
    }
    best
}
