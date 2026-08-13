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
    let doc = roxmltree::Document::parse(xml).map_err(|e| format!("bad XML: {e}"))?;
    let ft = doc
        .descendants()
        .find(|n| n.has_tag_name("FixtureType"))
        .ok_or("no FixtureType element")?;
    let manufacturer = ft.attribute("Manufacturer").unwrap_or("Unknown").to_string();
    let model = ft.attribute("Name").unwrap_or("Imported fixture").to_string();

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

        for ch in mode.descendants().filter(|n| n.has_tag_name("DMXChannel")) {
            let Some(offset_attr) = ch.attribute("Offset") else { continue };
            if offset_attr.trim().is_empty() || offset_attr == "None" {
                continue; // virtual channel
            }
            let offsets: Vec<usize> = offset_attr
                .split(',')
                .filter_map(|o| o.trim().parse::<usize>().ok())
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

            match attr_name.as_str() {
                "Dimmer" => {
                    has_dimmer = true;
                    cases.push(simple(Source::Dimmer));
                }
                "Pan" => {
                    has_pan = true;
                    cases.push(simple(Source::Pan));
                }
                "Tilt" => {
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

            channels.push(CChannel { offsets, head: 0, cases, default, name });
        }

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
            heads: vec![CHead { kind, offset: 0.0, label: model.clone() }],
            channels,
            beam_deg,
            virtual_dimmer: !has_dimmer,
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
            let to = bands.get(i + 1).map(|b| b.0 - 1).unwrap_or(max_dmx as u32);
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
