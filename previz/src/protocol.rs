//! Thin, forward-compatible mirror of the wire types the previz needs, plus
//! the reconnecting WebSocket client thread. The previz is just another
//! client of the engine protocol — it never controls, only observes.

use bevy::prelude::Resource;
use serde::Deserialize;
use std::sync::mpsc::{channel, Receiver};
use std::sync::Mutex;

#[derive(Deserialize, Clone, Copy, Debug, Default)]
pub struct Vec3Lite {
    pub x: f32,
    pub y: f32,
    pub z: f32,
}

// Wire mirrors keep fields we don't render yet (pan/tilt for movers, beat for
// future beat-flash UI) — they document the contract and cost nothing.
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct FixtureLite {
    pub id: String,
    pub profile_id: String,
    pub pos: Vec3Lite,
    #[serde(default)]
    pub rot_y: f32,
    #[serde(default)]
    pub rot_x: Option<f32>,
    #[serde(default)]
    pub rot_z: Option<f32>,
    #[serde(default)]
    pub name: String,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct PropLite {
    pub id: String,
    pub kind: String,
    pub pos: PropPosLite,
    #[serde(default)]
    pub rot_y: Option<f32>,
    /// structural kinds only, metres — w across, h tall, d deep (before rotY)
    #[serde(default)]
    pub size: Option<PropSizeLite>,
    /// structural kinds only — height of the base off the floor
    #[serde(default)]
    pub y: Option<f32>,
}

#[derive(Deserialize, Clone, Copy, Debug)]
pub struct PropSizeLite {
    pub w: f32,
    pub h: f32,
    pub d: f32,
}

#[derive(Deserialize, Clone, Copy, Debug)]
pub struct PropPosLite {
    pub x: f32,
    pub z: f32,
}

/// The stage as the operator set it, metres — width across, depth toward the
/// audience, height to the grid, centred on the origin. Absent: fit to the rig.
#[derive(Deserialize, Clone, Copy, Debug, PartialEq)]
pub struct StageLite {
    pub w: f32,
    pub d: f32,
    pub h: f32,
}

#[derive(Deserialize, Clone, Debug)]
pub struct ProjectLite {
    pub fixtures: Vec<FixtureLite>,
    /// dummy performers placed in the 2D plan
    #[serde(default)]
    pub props: Vec<PropLite>,
    /// the stage box, when the operator set one (Rig view, Stage size)
    #[serde(default)]
    pub stage: Option<StageLite>,
    /// imported (GDTF-compiled) profiles — needed for head layout + beam angle
    #[serde(default, deserialize_with = "profiles_lenient")]
    pub profiles: std::collections::HashMap<String, light_core::cprofile::CompiledProfile>,
}

/// Deserialize profiles ONE AT A TIME, skipping any that fail.
///
/// A CompiledProfile embeds the engine's strict enum contract (Cond / Func /
/// Source, internally tagged, with no `#[serde(other)]` fallback). Serde
/// tolerates unknown *fields* but not unknown *variants*, and ProjectLite's
/// parse is all-or-nothing — so a previz binary one build behind the engine
/// (the bundled .app ships its own) failed EVERY project message and rendered a
/// permanently empty demo stage. The only clue was an eprintln, which goes to
/// /dev/null in a bundle, and snapshots still parsed so nothing looked broken.
///
/// One unreadable profile should cost one fixture's beam metadata, not the
/// stage. Fixtures whose profile is skipped fall back to built-in metadata.
fn profiles_lenient<'de, D>(
    d: D,
) -> Result<std::collections::HashMap<String, light_core::cprofile::CompiledProfile>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw: std::collections::HashMap<String, serde_json::Value> =
        std::collections::HashMap::deserialize(d)?;
    let mut out = std::collections::HashMap::with_capacity(raw.len());
    let mut skipped: Vec<String> = Vec::new();
    for (id, v) in raw {
        match serde_json::from_value::<light_core::cprofile::CompiledProfile>(v) {
            Ok(p) => {
                out.insert(id, p);
            }
            Err(e) => {
                eprintln!("[previz] profile '{id}' unreadable, skipped: {e}");
                skipped.push(id);
            }
        }
    }
    if !skipped.is_empty() {
        eprintln!(
            "[previz] {} profile(s) skipped — those fixtures fall back to built-in beam metadata",
            skipped.len()
        );
    }
    Ok(out)
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct HeadLite {
    pub f: String,
    pub h: usize,
    pub r: f32,
    pub g: f32,
    pub b: f32,
    pub i: f32,
    #[serde(default)]
    pub st: f32,
    #[serde(default)]
    pub ring: f32,
    #[serde(default = "default_mm")]
    pub mm: String,
    #[serde(default)]
    pub mv: f32,
    #[serde(default = "default_half")]
    pub pan: f32,
    #[serde(default = "default_half")]
    pub tilt: f32,
    #[serde(default)]
    pub mc: Option<Vec<[u8; 3]>>,
    /// Live zoom, 0..1, present only while a look is actively driving it —
    /// absent means "parked, keep the profile's own angle" (see
    /// `core/src/renderer.rs`, which skip-serializes it).
    ///
    /// This window is the one the docs send people to for judging beam
    /// geometry, and until now it was the one place zoom could not be seen:
    /// the field was on the wire and simply never parsed, so both the shaft and
    /// the floor pool stayed frozen at the profile angle.
    #[serde(default)]
    pub zm: Option<f32>,
}

fn default_mm() -> String {
    "off".into()
}
fn default_half() -> f32 {
    0.5
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct SnapLite {
    pub beat: f64,
    pub bpm: f64,
    #[serde(default)]
    pub haze: f32,
    #[serde(default)]
    pub blackout: bool,
    pub heads: Vec<HeadLite>,
}

pub enum WsEvent {
    Project(ProjectLite),
    Snap(SnapLite),
    Connected(bool),
}

#[derive(Resource)]
pub struct WsReceiver(pub Mutex<Receiver<WsEvent>>);

pub fn spawn_ws_client() -> Receiver<WsEvent> {
    let (tx, rx) = channel::<WsEvent>();
    std::thread::spawn(move || {
        let port = std::env::var("LIGHT_PORT")
            .ok()
            .and_then(|p| p.parse::<u16>().ok())
            .unwrap_or(9900);
        let url = format!("ws://127.0.0.1:{port}");
        loop {
            match tungstenite::connect(&url) {
                Ok((mut ws, _)) => {
                    eprintln!("[previz] connected to engine at {url}");
                    let _ = tx.send(WsEvent::Connected(true));
                    loop {
                        match ws.read() {
                            Ok(tungstenite::Message::Text(t)) => {
                                let Ok(v) = serde_json::from_str::<serde_json::Value>(&t) else {
                                    continue;
                                };
                                match v.get("type").and_then(|s| s.as_str()) {
                                    Some("project") => {
                                        match serde_json::from_value::<ProjectLite>(v["project"].clone()) {
                                            Ok(p) => {
                                                let _ = tx.send(WsEvent::Project(p));
                                            }
                                            Err(e) => eprintln!("[previz] project parse FAILED: {e}"),
                                        }
                                    }
                                    Some("snap") => {
                                        match serde_json::from_value::<SnapLite>(v) {
                                            Ok(s) => {
                                                let _ = tx.send(WsEvent::Snap(s));
                                            }
                                            Err(e) => eprintln!("[previz] snap parse FAILED: {e}"),
                                        }
                                    }
                                    _ => {}
                                }
                            }
                            Ok(tungstenite::Message::Close(_)) | Err(_) => break,
                            Ok(_) => {}
                        }
                    }
                    eprintln!("[previz] engine connection lost — retrying");
                    let _ = tx.send(WsEvent::Connected(false));
                }
                Err(_) => {}
            }
            std::thread::sleep(std::time::Duration::from_millis(1000));
        }
    });
    rx
}
