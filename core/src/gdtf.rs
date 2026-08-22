//! GDTF (DIN 15800) import — parses a .gdtf archive's description.xml and
//! compiles each DMX mode into a `CompiledProfile`.
//!
//! v1 scope: single-head fixtures; attributes Dimmer, ColorAdd_R/G/B/W,
//! Pan/Tilt (incl. 16-bit), Shutter/Strobe function pairs, and colour wheels
//! (banded, CIE-converted slot colours). Unmapped channels hold their GDTF
//! defaults so imported fixtures behave sanely out of the box.

use std::io::{Cursor, Read};

use crate::cprofile::{CChannel, CHead, CompiledProfile, Cond, Func, FuncCase, Source, WheelSet};
use crate::profiles::HeadKind;

/// Deepest element nesting we will hand to roxmltree. Its tree construction and
/// drop recurse, overflowing the stack on the order of ten thousand levels deep
/// — a hard SIGABRT the panic hook cannot catch — so a crafted `.mvr` or
/// `.gdtf` from an untrusted LAN client (or a corrupt file) could kill the
/// engine on import. Real scenes and fixtures nest a handful of levels; this
/// bound is orders of magnitude of headroom, verified in one linear byte pass
/// that never itself recurses. Both roxmltree parse sites (GDTF here, MVR in
/// `mvr.rs`) go through `guard_xml_depth` first.
const MAX_XML_DEPTH: i32 = 512;

/// Refuse XML nested deeper than [`MAX_XML_DEPTH`] before roxmltree ever sees
/// it. Conservative by construction: it counts element open/close depth and
/// steps over comments, CDATA, processing instructions and declarations so
/// their contents cannot be mistaken for structure. Miscounting can only make
/// it stricter (reject a valid-but-absurd file), never let a bomb through.
pub(crate) fn guard_xml_depth(xml: &str) -> Result<(), String> {
    let b = xml.as_bytes();
    let n = b.len();
    let find = |from: usize, needle: &[u8]| -> Option<usize> {
        if from > n || needle.is_empty() || from + needle.len() > n {
            return None;
        }
        b[from..].windows(needle.len()).position(|w| w == needle).map(|p| p + from)
    };
    let mut i = 0usize;
    let mut depth: i32 = 0;
    while i < n {
        if b[i] != b'<' {
            i += 1;
            continue;
        }
        if b[i..].starts_with(b"<!--") {
            match find(i + 4, b"-->") {
                Some(j) => i = j + 3,
                None => break,
            }
        } else if b[i..].starts_with(b"<![CDATA[") {
            match find(i + 9, b"]]>") {
                Some(j) => i = j + 3,
                None => break,
            }
        } else if b.get(i + 1) == Some(&b'!') {
            // DOCTYPE / declaration — step to its '>' (best effort)
            match find(i + 2, b">") {
                Some(j) => i = j + 1,
                None => break,
            }
        } else if b.get(i + 1) == Some(&b'?') {
            match find(i + 2, b"?>") {
                Some(j) => i = j + 2,
                None => break,
            }
        } else if b.get(i + 1) == Some(&b'/') {
            depth -= 1;
            match find(i + 2, b">") {
                Some(j) => i = j + 1,
                None => break,
            }
        } else {
            // an opening tag; scan to its unquoted '>' noting self-closing '/>'
            let mut j = i + 1;
            let mut quote: u8 = 0;
            let mut last_nonspace: u8 = 0;
            let mut end = None;
            while j < n {
                let c = b[j];
                if quote != 0 {
                    if c == quote {
                        quote = 0;
                    }
                } else if c == b'"' || c == b'\'' {
                    quote = c;
                } else if c == b'>' {
                    end = Some(j);
                    break;
                }
                if !c.is_ascii_whitespace() {
                    last_nonspace = c;
                }
                j += 1;
            }
            if last_nonspace != b'/' {
                depth += 1;
                if depth > MAX_XML_DEPTH {
                    return Err(format!(
                        "XML nested deeper than {MAX_XML_DEPTH} levels — refused as malformed"
                    ));
                }
            }
            match end {
                Some(j) => i = j + 1,
                None => break,
            }
        }
    }
    Ok(())
}

pub fn parse_gdtf(bytes: &[u8]) -> Result<Vec<CompiledProfile>, String> {
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|e| format!("not a zip: {e}"))?;
    let mut xml = String::new();
    zip.by_name("description.xml")
        .map_err(|_| "no description.xml in archive".to_string())?
        .read_to_string(&mut xml)
        .map_err(|e| format!("description.xml unreadable: {e}"))?;
    parse_description(&xml)
}

/// "128/1" → value normalised into `bytes`-wide DMX space; "32768/2" stays 16-bit etc.
fn parse_dmx_value(s: &str, width: usize) -> Option<u32> {
    let mut it = s.split('/');
    let value: u32 = it.next()?.trim().parse().ok()?;
    let stated: usize = it.next().and_then(|b| b.trim().parse().ok()).unwrap_or(1);
    let shift = (width as i32 - stated as i32) * 8;
    Some(if shift >= 0 { value << shift } else { value >> -shift })
}

/// GDTF colours are CIE xyY ("x,y,Y" with Y 0..100) → sRGB components 0..255.
fn cie_to_rgb(s: &str) -> [u8; 3] {
    let p: Vec<f64> = s.split(',').filter_map(|v| v.trim().parse().ok()).collect();
    if p.len() < 3 || p[1] <= 0.0 {
        return [255, 255, 255];
    }
    let (x, y, big_y) = (p[0], p[1], (p[2] / 100.0).clamp(0.0, 1.0));
    let (cap_x, cap_z) = (x * big_y / y, (1.0 - x - y) * big_y / y);
    let lin = [
        3.2406 * cap_x - 1.5372 * big_y - 0.4986 * cap_z,
        -0.9689 * cap_x + 1.8758 * big_y + 0.0415 * cap_z,
        0.0557 * cap_x - 0.204 * big_y + 1.057 * cap_z,
    ];
    let mut out = [0u8; 3];
    let peak = lin.iter().cloned().fold(1e-6f64, f64::max).max(1.0);
    for (i, v) in lin.iter().enumerate() {
        let v = (v / peak).clamp(0.0, 1.0);
        let srgb = if v <= 0.0031308 { 12.92 * v } else { 1.055 * v.powf(1.0 / 2.4) - 0.055 };
        out[i] = (srgb * 255.0).round() as u8;
    }
    out
}

struct WheelDef {
    name: String,
    slots: Vec<(String, [u8; 3])>,
}

fn parse_description(xml: &str) -> Result<Vec<CompiledProfile>, String> {
    guard_xml_depth(xml)?;
    let doc = roxmltree::Document::parse(xml).map_err(|e| format!("bad XML: {e}"))?;
    let ft = doc
        .descendants()
        .find(|n| n.has_tag_name("FixtureType"))
        .ok_or("no FixtureType element")?;
    let manufacturer = ft.attribute("Manufacturer").unwrap_or("Unknown").to_string();
    let model = ft.attribute("Name").unwrap_or("Imported fixture").to_string();
    // A GDTF FixtureType carries no author attribute, so a hand-imported file
    // has no credit to record. The Share download path knows the uploader and
    // sets it there — see CompiledProfile::credit.
    let credit: Option<String> = None;

    // wheels (for Color1 etc.)
    let wheels: Vec<WheelDef> = ft
        .descendants()
        .filter(|n| n.has_tag_name("Wheel"))
        .map(|w| WheelDef {
            name: w.attribute("Name").unwrap_or("").to_string(),
            slots: w
                .children()
                .filter(|s| s.has_tag_name("Slot"))
                .map(|s| {
                    (
                        s.attribute("Name").unwrap_or("Slot").to_string(),
                        s.attribute("Color").map(cie_to_rgb).unwrap_or([255, 255, 255]),
                    )
                })
                .collect(),
        })
        .collect();

    // the Geometries tree — pixel fixtures carry per-pixel Position matrices
    let geometries = ft.descendants().find(|n| n.has_tag_name("Geometries"));

    // beam physicals
    let beam_deg = ft
        .descendants()
        .find(|n| n.has_tag_name("Beam"))
        .and_then(|b| {
            b.attribute("BeamAngle")
                .or(b.attribute("FieldAngle"))
                .and_then(|v| v.parse::<f64>().ok())
        })
        .unwrap_or(15.0);

    let mut out = Vec::new();
    for mode in ft.descendants().filter(|n| n.has_tag_name("DMXMode")) {
        let mode_name = mode.attribute("Name").unwrap_or("Default").to_string();
        let mut channels: Vec<CChannel> = Vec::new();
        let mut footprint = 0usize;
        let mut has_pan = false;
        let mut has_tilt = false;
        let mut has_rgb = false;
        let mut has_dimmer = false;

        let mut chan_geom: Vec<String> = Vec::new();
        let mut chan_color: Vec<Option<char>> = Vec::new(); // 'r','g','b','w' colour channels
        for ch in mode.descendants().filter(|n| n.has_tag_name("DMXChannel")) {
            let Some(offset_attr) = ch.attribute("Offset") else { continue };
            if offset_attr.trim().is_empty() || offset_attr == "None" {
                continue; // virtual channel
            }
            let offsets: Vec<usize> = offset_attr
                .split(',')
                .filter_map(|o| o.trim().parse::<usize>().ok())
                .filter(|&o| o >= 1) // Offset="0" exists in the wild; `0 - 1` must not underflow
                .map(|o| o - 1)
                .collect();
            if offsets.is_empty() || offsets.len() > 2 {
                continue;
            }
            let width = offsets.len();
            let max_dmx: u16 = if width == 2 { 65535 } else { 255 };
            footprint = footprint.max(offsets.iter().max().unwrap() + 1);

            // functions of the first logical channel
            let logical = ch.children().find(|n| n.has_tag_name("LogicalChannel"));
            let attr_name = logical
                .and_then(|l| l.attribute("Attribute"))
                .unwrap_or("NoFeature")
                .to_string();
            let functions: Vec<roxmltree::Node> = logical
                .map(|l| l.children().filter(|n| n.has_tag_name("ChannelFunction")).collect())
                .unwrap_or_default();
            let default = functions
                .first()
                .and_then(|f| f.attribute("Default"))
                .and_then(|d| parse_dmx_value(d, width))
                .unwrap_or(0)
                .min(max_dmx as u32) as u16;

            let name = attr_name.clone();
            let mut cases: Vec<FuncCase> = Vec::new();

            let simple = |src: Source| FuncCase {
                cond: Cond::Always,
                dmx_from: 0,
                dmx_to: max_dmx,
                func: Func::Linear { source: src },
            };

            // A beam parameter the operator has not touched must sit where the
            // fixture's own definition parks it — a Spiider opens at DMX 128,
            // and driving its zoom to 0 the moment a show loads would narrow
            // every head in the rig. So: hold the default while unset, sweep
            // the channel once a look sets it.
            let optional = |src: Source| {
                vec![
                    FuncCase {
                        cond: Cond::SourceUnset { source: src },
                        dmx_from: default,
                        dmx_to: default,
                        func: Func::Fixed { value: default },
                    },
                    FuncCase {
                        cond: Cond::Always,
                        dmx_from: 0,
                        dmx_to: max_dmx,
                        func: Func::Linear { source: src },
                    },
                ]
            };

            match attr_name.as_str() {
                // Indexed forms count. GDTF writes `Dimmer` on a single-instance
                // geometry and `Dimmer1`, `Dimmer2`… when it is indexed — the
                // same convention this match already honours for `Shutter1`,
                // `Focus1` and `Frost1`/`Frost2`. Dimmer, Pan and Tilt were
                // exact-match only, so a file using the indexed spelling
                // compiled to channels that drive NOTHING: a fixture that never
                // lights and never moves, with no error anywhere. A real show
                // had 49 blinders dark for exactly this (`Dimmer1`) and a
                // 65-channel pixel dimmer array with them.
                a if indexed_base(a) == "Dimmer" => {
                    has_dimmer = true;
                    cases.push(simple(Source::Dimmer));
                }
                a if indexed_base(a) == "Pan" => {
                    has_pan = true;
                    cases.push(simple(Source::Pan));
                }
                a if indexed_base(a) == "Tilt" => {
                    has_tilt = true;
                    cases.push(simple(Source::Tilt));
                }
                "ColorAdd_R" | "ColorRGB_Red" => {
                    has_rgb = true;
                    cases.push(simple(Source::ColorR));
                }
                "ColorAdd_G" | "ColorRGB_Green" => {
                    has_rgb = true;
                    cases.push(simple(Source::ColorG));
                }
                "ColorAdd_B" | "ColorRGB_Blue" => {
                    has_rgb = true;
                    cases.push(simple(Source::ColorB));
                }
                "ColorAdd_W" | "ColorAdd_WW" | "ColorAdd_CW" => {
                    cases.push(simple(Source::White));
                }
                "Shutter1" | "Shutter" => {
                    // open on the Shutter1 function default; strobe over the
                    // Shutter1Strobe function's band when the look strobes
                    let open_value = default;
                    let strobe_fn = functions.iter().find(|f| {
                        f.attribute("Attribute").map_or(false, |a| a.contains("Strobe"))
                    });
                    if let Some(sf) = strobe_fn {
                        let from = sf
                            .attribute("DMXFrom")
                            .and_then(|d| parse_dmx_value(d, width))
                            .unwrap_or(0)
                            .min(max_dmx as u32) as u16;
                        let to = strobe_fn_end(sf, &functions, max_dmx, width);
                        cases.push(FuncCase {
                            cond: Cond::SourceBelow { source: Source::Strobe, value: 0.01 },
                            dmx_from: open_value,
                            dmx_to: open_value,
                            func: Func::Fixed { value: open_value },
                        });
                        cases.push(FuncCase {
                            cond: Cond::Always,
                            dmx_from: from,
                            dmx_to: to,
                            func: Func::Linear { source: Source::Strobe },
                        });
                    }
                }
                // Beam shaping. All continuous and monotonic on every fixture
                // that has them, which is what makes them safe to expose as a
                // plain 0..1 fader and to ramp from an effect.
                "Zoom" => cases.extend(optional(Source::Zoom)),
                "Focus1" | "Focus" => cases.extend(optional(Source::Focus)),
                "Iris" => cases.extend(optional(Source::Iris)),
                "Frost1" | "Frost2" | "Frost" => cases.extend(optional(Source::Frost)),
                // CTO warms a white; CTB is the same axis the other way, so it
                // rides the same parameter rather than earning its own fader.
                "CTO" | "CTB" | "CTC" => cases.extend(optional(Source::Cto)),
                a if a.starts_with("Color") && !a.contains("Add") && !a.contains("RGB") => {
                    // colour wheel: match by wheel name from the function, else first wheel
                    let wheel = functions
                        .first()
                        .and_then(|f| f.attribute("Wheel"))
                        .and_then(|wn| wheels.iter().find(|w| w.name == wn))
                        .or(wheels.first());
                    if let Some(w) = wheel {
                        let sets = wheel_sets_from_functions(w, &functions, max_dmx, width);
                        if !sets.is_empty() {
                            cases.push(FuncCase {
                                cond: Cond::Always,
                                dmx_from: 0,
                                dmx_to: max_dmx,
                                func: Func::Wheel { sets, allow_explicit: true },
                            });
                        }
                    }
                }
                _ => {} // unmapped: hold default
            }

            chan_geom.push(ch.attribute("Geometry").unwrap_or("").to_string());
            chan_color.push(match attr_name.as_str() {
                "ColorAdd_R" | "ColorRGB_Red" => Some('r'),
                "ColorAdd_G" | "ColorRGB_Green" => Some('g'),
                "ColorAdd_B" | "ColorRGB_Blue" => Some('b'),
                "ColorAdd_W" | "ColorAdd_WW" | "ColorAdd_CW" => Some('w'),
                _ => None,
            });
            channels.push(CChannel { offsets, head: 0, cases, default, name });
        }

        // Multi-pixel fixtures (strips, bars): synthesize one head per pixel
        // group so the previz shows a strip and chases can run across it.
        let (head_count, head_geoms) = synthesize_heads(&mut channels, &chan_geom, &chan_color);

        if channels.is_empty() {
            continue;
        }
        let kind = if has_pan && has_tilt {
            HeadKind::Mover
        } else if has_rgb {
            HeadKind::Rgb
        } else {
            HeadKind::Dimmer
        };
        let heads: Vec<CHead> = if head_count > 1 {
            // Real positions from the file when authored (B1); the even-spaced
            // fabrication stays as the fallback for flat console exports and
            // zeroed geometry (the CLF Nero case).
            parse_pixel_layout(geometries, &head_geoms, head_count).unwrap_or_else(|| {
                let width = if head_count >= 4 { 1.0 } else { 0.3 * head_count as f64 };
                (0..head_count)
                    .map(|i| {
                        CHead::flat(
                            HeadKind::Rgb,
                            (i as f64 / (head_count - 1) as f64 - 0.5) * width,
                            format!("Px {}", i + 1),
                        )
                    })
                    .collect()
            })
        } else {
            vec![CHead::flat(kind, 0.0, model.clone())]
        };
        let slug: String = format!("{manufacturer}-{model}-{mode_name}")
            .to_lowercase()
            .chars()
            .map(|c| if c.is_alphanumeric() { c } else { '-' })
            .collect();
        out.push(CompiledProfile {
            id: format!("gdtf-{slug}"),
            manufacturer: manufacturer.clone(),
            model: model.clone(),
            mode: mode_name,
            footprint,
            heads,
            channels,
            beam_deg,
            virtual_dimmer: !has_dimmer,
            credit: credit.clone(),
            form_override: None,
        });
    }
    if out.is_empty() {
        return Err("no usable DMX modes found".into());
    }
    Ok(out)
}

/// The strobe band ends where the next function begins (GDTF functions
/// partition the channel by DMXFrom), or at the channel max.
fn strobe_fn_end(
    sf: &roxmltree::Node,
    functions: &[roxmltree::Node],
    max_dmx: u16,
    width: usize,
) -> u16 {
    let start = sf
        .attribute("DMXFrom")
        .and_then(|d| parse_dmx_value(d, width))
        .unwrap_or(0);
    functions
        .iter()
        .filter_map(|f| f.attribute("DMXFrom").and_then(|d| parse_dmx_value(d, width)))
        .filter(|&from| from > start)
        .min()
        .map(|next| (next - 1).min(max_dmx as u32) as u16)
        .unwrap_or(max_dmx)
}

/// Wheel-slot bands: each ChannelSet (or function partition) covers a DMX
/// range; slot colours come from the wheel definition in order.
fn wheel_sets_from_functions(
    wheel: &WheelDef,
    functions: &[roxmltree::Node],
    max_dmx: u16,
    width: usize,
) -> Vec<WheelSet> {
    // gather (from, name, optional wheel-slot index) from ChannelSets across functions
    let mut bands: Vec<(u32, String)> = Vec::new();
    for f in functions {
        for cs in f.children().filter(|n| n.has_tag_name("ChannelSet")) {
            let Some(from) = cs.attribute("DMXFrom").and_then(|d| parse_dmx_value(d, width)) else {
                continue;
            };
            bands.push((from, cs.attribute("Name").unwrap_or("").to_string()));
        }
    }
    bands.sort_by_key(|b| b.0);
    if bands.is_empty() {
        // no explicit sets: spread wheel slots evenly
        let n = wheel.slots.len().max(1) as u32;
        let span = max_dmx as u32 + 1;
        return wheel
            .slots
            .iter()
            .enumerate()
            .map(|(i, (name, rgb))| {
                let min = i as u32 * span / n;
                let max = ((i as u32 + 1) * span / n).saturating_sub(1);
                WheelSet {
                    value: (min + (max - min) / 2).min(255) as u8,
                    min: min.min(255) as u8,
                    max: max.min(255) as u8,
                    name: name.clone(),
                    comps: vec![*rgb],
                    auto: true,
                }
            })
            .collect();
    }
    bands
        .iter()
        .enumerate()
        .map(|(i, (from, name))| {
            let to = bands
                .get(i + 1)
                .map(|b| b.0.saturating_sub(1))
                .unwrap_or(max_dmx as u32);
            // match the slot colour by index in the wheel; fall back to white
            let rgb = wheel.slots.get(i).map(|s| s.1).unwrap_or([255, 255, 255]);
            let label = if name.is_empty() {
                wheel.slots.get(i).map(|s| s.0.clone()).unwrap_or_default()
            } else {
                name.clone()
            };
            WheelSet {
                value: (from + (to - from) / 2).min(255) as u8,
                min: (*from).min(255) as u8,
                max: to.min(255) as u8,
                name: label,
                comps: vec![rgb],
                auto: true,
            }
        })
        .collect()
}

/// Assign channels to per-pixel heads. Strategy 1: distinct `Geometry`
/// attributes that each carry colour channels (well-formed pixel fixtures).
/// Strategy 2: repeated colour cycles — every repeated red channel starts a
/// new pixel. Non-colour channels stay on head 0 (globals). Returns the head
/// count (1 = leave single-head) and, for strategy 1, the per-head geometry
/// NAME — the key into the Geometries tree that may carry the pixel's real
/// position (strategy 2 heads have no geometry identity; empty vec).
fn synthesize_heads(
    channels: &mut [CChannel],
    geoms: &[String],
    colors: &[Option<char>],
) -> (usize, Vec<String>) {
    // Strategy 1: geometry grouping
    let mut geom_order: Vec<&String> = Vec::new();
    for (g, c) in geoms.iter().zip(colors) {
        if c.is_some() && !g.is_empty() && !geom_order.contains(&g) {
            geom_order.push(g);
        }
    }
    if geom_order.len() > 1 {
        for (i, ch) in channels.iter_mut().enumerate() {
            if let Some(pos) = geom_order.iter().position(|g| *g == &geoms[i]) {
                ch.head = pos;
            }
        }
        let names = geom_order.iter().map(|g| (*g).clone()).collect();
        return (geom_order.len(), names);
    }

    // Strategy 2: repeated colour cycles (e.g. R,G,B,R,G,B,…)
    let reds = colors.iter().filter(|c| **c == Some('r')).count();
    if reds < 2 {
        return (1, Vec::new());
    }
    let mut head: isize = -1;
    let mut seen_in_head: Vec<char> = Vec::new();
    for (i, ch) in channels.iter_mut().enumerate() {
        let Some(c) = colors[i] else { continue };
        if head < 0 || seen_in_head.contains(&c) {
            head += 1;
            seen_in_head.clear();
        }
        seen_in_head.push(c);
        ch.head = head.max(0) as usize;
    }
    ((head + 1).max(1) as usize, Vec::new())
}

/// A GDTF Matrix attribute: 3×3 rotation rows plus a translation, row-vector
/// convention (world = local·R + t). The wire format is four brace groups;
/// the translation is the first three values of the FOURTH group under both
/// 4×4-row-major and u/v/w/o spellings seen in the wild.
struct GMat {
    r: [[f64; 3]; 3],
    t: [f64; 3],
}

/// `Dimmer3` -> `Dimmer`. Strips a trailing run of ASCII digits so an indexed
/// GDTF attribute matches its base name. Deliberately narrow: it is applied
/// only to the attributes whose arms opt into it, so `Effects1Rate`,
/// `Color1` and friends keep their own meanings.
fn indexed_base(attr: &str) -> &str {
    let base = attr.trim_end_matches(|c: char| c.is_ascii_digit());
    if base.is_empty() { attr } else { base }
}

fn parse_matrix(s: &str) -> Option<GMat> {
    let groups: Vec<Vec<f64>> = s
        .split('}')
        .filter(|g| !g.trim().is_empty())
        .map(|g| {
            g.trim_start_matches(|c: char| c == '{' || c.is_whitespace())
                .split(',')
                .filter_map(|v| v.trim().parse::<f64>().ok())
                .collect()
        })
        .collect();
    if groups.len() != 4 || groups.iter().any(|g| g.len() < 3) {
        return None;
    }
    let mut r = [[0.0; 3]; 3];
    for (i, row) in r.iter_mut().enumerate() {
        for (j, v) in row.iter_mut().enumerate() {
            *v = groups[i][j];
        }
    }
    Some(GMat { r, t: [groups[3][0], groups[3][1], groups[3][2]] })
}

fn gmat_apply(m: &GMat, p: [f64; 3]) -> [f64; 3] {
    // row-vector: p' = p·R + t
    [
        p[0] * m.r[0][0] + p[1] * m.r[1][0] + p[2] * m.r[2][0] + m.t[0],
        p[0] * m.r[0][1] + p[1] * m.r[1][1] + p[2] * m.r[2][1] + m.t[1],
        p[0] * m.r[0][2] + p[1] * m.r[1][2] + p[2] * m.r[2][2] + m.t[2],
    ]
}

/// Origin of the named geometry in the fixture's frame: (0,0,0) run through
/// its own Position and every ancestor's up to the Geometries root. Any
/// geometry-typed element counts (Geometry, GeometryReference, Beam, …) —
/// pixel fixtures use GeometryReference instances, each with its own matrix.
fn geometry_origin(geometries: roxmltree::Node, name: &str) -> Option<[f64; 3]> {
    let node = geometries
        .descendants()
        .find(|n| n.is_element() && n.attribute("Name") == Some(name))?;
    let mut p = [0.0f64; 3];
    let mut cur = node;
    loop {
        if cur == geometries {
            break;
        }
        if let Some(m) = cur.attribute("Position").and_then(parse_matrix) {
            p = gmat_apply(&m, p);
        }
        match cur.parent() {
            Some(parent) if parent.is_element() => cur = parent,
            _ => break,
        }
    }
    Some(p)
}

/// Real pixel positions from the Geometries tree, when the file carries them.
/// Returns None when any head's geometry is missing, a position is
/// non-finite, or the layout is degenerate (all pixels at one point — flat
/// console exports write exactly this); the caller then keeps the synthesized
/// evenly-spaced fallback, so a well-formed import can never get WORSE.
fn parse_pixel_layout(
    geometries: Option<roxmltree::Node>,
    head_geoms: &[String],
    head_count: usize,
) -> Option<Vec<CHead>> {
    let geometries = geometries?;
    if head_geoms.len() != head_count || head_count < 2 {
        return None;
    }
    let mut px: Vec<(f64, f64)> = Vec::with_capacity(head_count);
    for name in head_geoms {
        if name.is_empty() {
            return None;
        }
        let p = geometry_origin(geometries, name)?;
        if !p.iter().all(|v| v.is_finite()) {
            return None;
        }
        // GDTF is Z-up: X stays the fixture's local X, Z becomes local Y (up);
        // depth (GDTF Y) is dropped - a pixel face is planar
        px.push((p[0], p[2]));
    }
    // Centre the layout FIRST: LIGHT treats fixture.pos as the visual centre,
    // and centring first makes the unit heuristic below depend on the
    // fixture's physical extent rather than where the author happened to put
    // the geometry origin.
    let n = px.len() as f64;
    let cx = px.iter().map(|p| p.0).sum::<f64>() / n;
    let cy = px.iter().map(|p| p.1).sum::<f64>() / n;
    for p in &mut px {
        p.0 -= cx;
        p.1 -= cy;
    }
    // Degenerate (all pixels at one point): the flat-export signature.
    let span_raw = px.iter().fold(0.0f64, |m, &(x, y)| m.max(x.abs()).max(y.abs()));
    if span_raw < 1e-4 {
        return None;
    }
    // Unit heuristic: the spec says metres, console exports have shipped mm;
    // no fixture face is 5 m wide, so a centred extent above 5 is millimetres.
    if span_raw > 5.0 {
        for p in &mut px {
            p.0 *= 0.001;
            p.1 *= 0.001;
        }
    }
    // A span still over 5 m is wrong under EITHER unit reading — refuse it
    // and keep the synthesized fallback rather than a 100 m-wide "fixture".
    let span = px.iter().fold(0.0f64, |m, &(x, y)| m.max(x.abs()).max(y.abs()));
    if span > 5.0 {
        return None;
    }
    // Rows: sort top-down, then break where the gap between CONSECUTIVE
    // vertical values exceeds 5 mm (single-linkage — a tilted bar whose y
    // drifts gradually stays ONE row instead of fragmenting at every 5 mm of
    // cumulative drift). Cols run in x order WITHIN each row, re-sorted after
    // clustering so sub-tolerance jitter cannot scramble the chase direction.
    let mut order: Vec<usize> = (0..px.len()).collect();
    order.sort_by(|&a, &b| {
        px[b].1
            .partial_cmp(&px[a].1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(px[a].0.partial_cmp(&px[b].0).unwrap_or(std::cmp::Ordering::Equal))
    });
    let mut rows: Vec<Vec<usize>> = Vec::new();
    let mut prev_y = px[order[0]].1;
    for &i in &order {
        if rows.is_empty() || (prev_y - px[i].1) > 0.005 {
            rows.push(Vec::new());
        }
        prev_y = px[i].1;
        rows.last_mut().unwrap().push(i);
    }
    let mut row_of = vec![0usize; px.len()];
    let mut col_of = vec![0usize; px.len()];
    for (r, members) in rows.iter_mut().enumerate() {
        members.sort_by(|&a, &b| {
            px[a].0
                .partial_cmp(&px[b].0)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(a.cmp(&b)) // deterministic on exact x ties
        });
        for (c, &i) in members.iter().enumerate() {
            row_of[i] = r;
            col_of[i] = c;
        }
    }
    Some(
        (0..px.len())
            .map(|i| CHead {
                kind: HeadKind::Rgb,
                offset: px[i].0,
                offset_y: px[i].1,
                row: row_of[i],
                col: col_of[i],
                label: head_geoms[i].clone(),
            })
            .collect(),
    )
}

#[cfg(test)]
mod depth_guard_tests {
    use super::guard_xml_depth;

    fn chain(open: &str, close: &str, n: usize) -> String {
        let mut s = String::from("<root>");
        for _ in 0..n {
            s.push_str(open);
        }
        for _ in 0..n {
            s.push_str(close);
        }
        s.push_str("</root>");
        s
    }

    #[test]
    fn accepts_shallow_and_flat() {
        assert!(guard_xml_depth("<a><b/><c>x</c></a>").is_ok());
        // 5000 flat siblings are only depth 2 — must not be refused
        let mut s = String::from("<root>");
        for _ in 0..5000 {
            s.push_str("<f/>");
        }
        s.push_str("</root>");
        assert!(guard_xml_depth(&s).is_ok());
    }

    #[test]
    fn refuses_a_deep_chain() {
        assert!(guard_xml_depth(&chain("<g>", "</g>", 100)).is_ok());
        assert!(guard_xml_depth(&chain("<g>", "</g>", 600)).is_err());
    }

    #[test]
    fn self_closing_tags_do_not_accumulate_depth() {
        // 2000 self-closing siblings stay at depth 1, well under the limit
        let mut s = String::from("<root>");
        for _ in 0..2000 {
            s.push_str("<f a=\"1\"/>");
        }
        s.push_str("</root>");
        assert!(guard_xml_depth(&s).is_ok());
    }

    #[test]
    fn structure_inside_comments_and_cdata_is_ignored() {
        let mut s = String::from("<root><!-- ");
        for _ in 0..2000 {
            s.push_str("<g>");
        }
        s.push_str(" --><![CDATA[");
        for _ in 0..2000 {
            s.push_str("<g>");
        }
        s.push_str("]]></root>");
        assert!(guard_xml_depth(&s).is_ok(), "fake tags in comments/CDATA must not count");
    }

    #[test]
    fn quoted_gt_does_not_close_a_tag() {
        // the '>' inside the attribute value must not be read as the tag end
        assert!(guard_xml_depth("<a b=\"x &gt; y\"><c d='p>q'/></a>").is_ok());
    }
}
