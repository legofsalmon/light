//! Scratch: compile a .gdtf with LIGHT's importer and print what came out,
//! one line per head. Not part of the product.
//!   cargo run -p light-core --example gdtfdump -- <file.gdtf> [mode-substring]
fn main() {
    let path = std::env::args().nth(1).expect("path to a .gdtf");
    let want = std::env::args().nth(2).map(|s| s.to_lowercase());
    let bytes = std::fs::read(&path).expect("read");
    let profiles = match light_core::gdtf::parse_gdtf(&bytes) {
        Ok(p) => p,
        Err(e) => { eprintln!("parse failed: {e}"); std::process::exit(1) }
    };
    for p in &profiles {
        if let Some(w) = &want { if !p.mode.to_lowercase().contains(w) { continue; } }
        let v = serde_json::to_value(p).unwrap();
        println!("== mode {:?}  id={}  footprint={}  pan_deg={:?} tilt_deg={:?} beam_deg={:?} cto_k={:?}",
            p.mode, p.id, v["footprint"], v["panDeg"], v["tiltDeg"], v["beamDeg"], v["ctoK"]);
        let heads = v["heads"].as_array().cloned().unwrap_or_default();
        println!("   heads: {}", heads.len());
        for (i, h) in heads.iter().enumerate() {
            let mut h2 = h.clone();
            if let Some(o) = h2.as_object_mut() { o.remove("channels"); }
            println!("   [{i:>2}] {}", serde_json::to_string(&h2).unwrap());
        }
        let chans = v["channels"].as_array().cloned().unwrap_or_default();
        println!("   channels: {}", chans.len());
        for c in chans.iter().take(60) {
            println!("      {}", serde_json::to_string(c).unwrap());
        }
        println!();
    }
}
