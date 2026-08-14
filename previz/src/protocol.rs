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
pub struct ProjectLite {
    pub fixtures: Vec<FixtureLite>,
    /// imported (GDTF-compiled) profiles — needed for head layout + beam angle
    #[serde(default)]
    pub profiles: std::collections::HashMap<String, light_core::cprofile::CompiledProfile>,
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
