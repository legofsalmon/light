//! MVR (DIN 15801) import — parses a .mvr archive's GeneralSceneDescription.xml,
//! resolves the GDTF fixture types embedded in the archive, and produces a
//! neutral import bundle both engines apply to their project: profiles,
//! fixtures (universe/address/position/yaw), and a group per MVR layer.
//!
//! Conventions (documented, exporters vary):
//! - MVR space is millimetres, right-handed, Z-up. LIGHT is metres, Y-up,
//!   +z toward the audience: light = (x/1000, z/1000, -y/1000).
//! - `<Address>` accepts the absolute form (universe = (v-1)/512 on the wire,
//!   channel = (v-1)%512+1) and the dot form "universe.channel" (universe
//!   taken as the wire number as written).

use std::collections::HashMap;
use std::io::{Cursor, Read};

use serde::Serialize;

use crate::cprofile::CompiledProfile;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MvrFixture {
    pub name: String,
    pub profile_id: String,
    /// Art-Net wire universe number
    pub universe: u16,
    pub address: usize,
    pub pos: [f64; 3],
    pub rot_y: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MvrGroup {
    pub name: String,
    /// indices into `fixtures`
    pub fixtures: Vec<usize>,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MvrBundle {
    pub profiles: HashMap<String, CompiledProfile>,
    pub fixtures: Vec<MvrFixture>,
    pub groups: Vec<MvrGroup>,
    pub warnings: Vec<String>,
}

/// Row-vector affine transform: p' = x·u + y·v + z·w + o.
#[derive(Clone, Copy)]
struct Mat43 {
    u: [f64; 3],
    v: [f64; 3],
    w: [f64; 3],
    o: [f64; 3],
}

impl Mat43 {
    const IDENTITY: Mat43 = Mat43 {
        u: [1.0, 0.0, 0.0],
        v: [0.0, 1.0, 0.0],
        w: [0.0, 0.0, 1.0],
        o: [0.0, 0.0, 0.0],
    };

    fn apply(&self, p: [f64; 3]) -> [f64; 3] {
        [
            p[0] * self.u[0] + p[1] * self.v[0] + p[2] * self.w[0] + self.o[0],
            p[0] * self.u[1] + p[1] * self.v[1] + p[2] * self.w[1] + self.o[1],
            p[0] * self.u[2] + p[1] * self.v[2] + p[2] * self.w[2] + self.o[2],
        ]
    }

    fn apply_vec(&self, p: [f64; 3]) -> [f64; 3] {
        [
            p[0] * self.u[0] + p[1] * self.v[0] + p[2] * self.w[0],
            p[0] * self.u[1] + p[1] * self.v[1] + p[2] * self.w[1],
            p[0] * self.u[2] + p[1] * self.v[2] + p[2] * self.w[2],
        ]
    }

    fn compose(&self, child: &Mat43) -> Mat43 {
        Mat43 {
            u: self.apply_vec(child.u),
            v: self.apply_vec(child.v),
            w: self.apply_vec(child.w),
            o: self.apply(child.o),
        }
    }
}

fn parse_matrix(s: &str) -> Mat43 {
    let rows: Vec<[f64; 3]> = s
        .split('}')
        .filter_map(|part| {
            let nums: Vec<f64> = part
                .trim_start_matches(|c| c == '{' || c == ' ')
                .split(',')
                .filter_map(|n| n.trim().parse().ok())
                .collect();
            (nums.len() == 3).then(|| [nums[0], nums[1], nums[2]])
        })
        .collect();
    if rows.len() < 4 {
        return Mat43::IDENTITY;
    }
    Mat43 { u: rows[0], v: rows[1], w: rows[2], o: rows[3] }
}

/// mm Z-up → metres Y-up with +z toward the audience.
fn to_light_point(p: [f64; 3]) -> [f64; 3] {
    [p[0] / 1000.0, p[2] / 1000.0, -p[1] / 1000.0]
}

fn yaw_from(m: &Mat43) -> f64 {
    // local X axis in LIGHT coords; yaw θ maps +X to (cosθ, 0, -sinθ)
    let ux = [m.u[0], m.u[2], -m.u[1]];
    if ux[0].abs() < 1e-9 && ux[2].abs() < 1e-9 {
        return 0.0;
    }
    (-ux[2]).atan2(ux[0])
}

/// (wire universe, 1-based channel)
fn parse_address(s: &str) -> Option<(u16, usize)> {
    let s = s.trim();
    if let Some((u, c)) = s.split_once('.') {
        let u: u16 = u.trim().parse().ok()?;
        let c: usize = c.trim().parse().ok()?;
        if c == 0 || c > 512 {
            return None;
        }
        return Some((u, c));
    }
    let v: usize = s.parse().ok()?;
    if v == 0 {
        return None;
    }
    Some((((v - 1) / 512) as u16, (v - 1) % 512 + 1))
}

pub fn parse_mvr(bytes: &[u8]) -> Result<MvrBundle, String> {
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|e| format!("not a zip: {e}"))?;

    let mut scene_xml = String::new();
    let mut gdtf_files: HashMap<String, Vec<u8>> = HashMap::new();
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
        let name = entry.name().to_string();
        if name.eq_ignore_ascii_case("GeneralSceneDescription.xml") {
            entry.read_to_string(&mut scene_xml).map_err(|e| e.to_string())?;
        } else if name.to_lowercase().ends_with(".gdtf") {
            let mut buf = Vec::new();
            entry.read_to_end(&mut buf).map_err(|e| e.to_string())?;
            let stem = name.rsplit('/').next().unwrap_or(&name);
            gdtf_files.insert(stem.to_lowercase(), buf);
        }
    }
    if scene_xml.is_empty() {
        return Err("no GeneralSceneDescription.xml in archive".into());
    }

    let doc = roxmltree::Document::parse(&scene_xml).map_err(|e| format!("bad XML: {e}"))?;
    let mut bundle = MvrBundle::default();
    // per gdtf filename: parsed profiles (mode name → profile id)
    let mut parsed_gdtfs: HashMap<String, Vec<CompiledProfile>> = HashMap::new();

    for layer in doc.descendants().filter(|n| n.has_tag_name("Layer")) {
        let layer_name = layer
            .attribute("name")
            .or(layer.attribute("Name"))
            .unwrap_or("Layer")
            .to_string();
        let mut members: Vec<usize> = Vec::new();
        walk(
            layer,
            Mat43::IDENTITY,
            &gdtf_files,
            &mut parsed_gdtfs,
            &mut bundle,
            &mut members,
        );
        if !members.is_empty() {
            bundle.groups.push(MvrGroup { name: layer_name, fixtures: members });
        }
    }

    if bundle.fixtures.is_empty() {
        return Err("no fixtures with resolvable GDTF types found".into());
    }
    Ok(bundle)
}

fn walk(
    node: roxmltree::Node,
    parent: Mat43,
    gdtf_files: &HashMap<String, Vec<u8>>,
    parsed: &mut HashMap<String, Vec<CompiledProfile>>,
    bundle: &mut MvrBundle,
    members: &mut Vec<usize>,
) {
    for child in node.children().filter(|n| n.is_element()) {
        match child.tag_name().name() {
            "Fixture" => {
                let m = child
                    .children()
                    .find(|n| n.has_tag_name("Matrix"))
                    .and_then(|n| n.text())
                    .map(parse_matrix)
                    .unwrap_or(Mat43::IDENTITY);
                let world = parent.compose(&m);
                if let Some(idx) = import_fixture(child, &world, gdtf_files, parsed, bundle) {
                    members.push(idx);
                }
            }
            "GroupObject" | "ChildList" => {
                let m = child
                    .children()
                    .find(|n| n.has_tag_name("Matrix"))
                    .and_then(|n| n.text())
                    .map(parse_matrix)
                    .unwrap_or(Mat43::IDENTITY);
                walk(child, parent.compose(&m), gdtf_files, parsed, bundle, members);
            }
            _ => {}
        }
    }
}

fn import_fixture(
    node: roxmltree::Node,
    world: &Mat43,
    gdtf_files: &HashMap<String, Vec<u8>>,
    parsed: &mut HashMap<String, Vec<CompiledProfile>>,
    bundle: &mut MvrBundle,
) -> Option<usize> {
    let name = node
        .attribute("name")
        .or(node.attribute("Name"))
        .unwrap_or("Fixture")
        .to_string();
    let text_of = |tag: &str| {
        node.children()
            .find(|n| n.has_tag_name(tag))
            .and_then(|n| n.text())
            .map(|t| t.trim().to_string())
    };

    let Some(spec) = text_of("GDTFSpec") else {
        bundle.warnings.push(format!("{name}: no GDTFSpec — skipped"));
        return None;
    };
    let key = spec.to_lowercase();
    let key_ext = if key.ends_with(".gdtf") { key.clone() } else { format!("{key}.gdtf") };
    let Some(file) = gdtf_files.get(&key_ext).or_else(|| gdtf_files.get(&key)) else {
        bundle.warnings.push(format!("{name}: GDTF '{spec}' not in archive — skipped"));
        return None;
    };

    if !parsed.contains_key(&key_ext) {
        match crate::gdtf::parse_gdtf(file) {
            Ok(profiles) => {
                parsed.insert(key_ext.clone(), profiles);
            }
            Err(e) => {
                bundle.warnings.push(format!("{name}: GDTF '{spec}' unreadable ({e}) — skipped"));
                parsed.insert(key_ext.clone(), vec![]);
            }
        }
    }
    let profiles = &parsed[&key_ext];
    if profiles.is_empty() {
        return None;
    }
    let mode = text_of("GDTFMode");
    let profile = mode
        .as_ref()
        .and_then(|m| profiles.iter().find(|p| &p.mode == m))
        .unwrap_or_else(|| {
            if let Some(m) = &mode {
                bundle
                    .warnings
                    .push(format!("{name}: mode '{m}' not found, using '{}'", profiles[0].mode));
            }
            &profiles[0]
        });

    let Some((universe, address)) = node
        .children()
        .find(|n| n.has_tag_name("Addresses"))
        .and_then(|a| a.children().find(|n| n.has_tag_name("Address")))
        .and_then(|n| n.text())
        .and_then(parse_address)
    else {
        bundle.warnings.push(format!("{name}: no valid DMX address — skipped"));
        return None;
    };

    bundle.profiles.insert(profile.id.clone(), profile.clone());
    bundle.fixtures.push(MvrFixture {
        name,
        profile_id: profile.id.clone(),
        universe,
        address,
        pos: to_light_point(world.o),
        rot_y: yaw_from(world),
    });
    Some(bundle.fixtures.len() - 1)
}
