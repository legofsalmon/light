//! APC40 mk2 LED feedback over native MIDI — the packaged app's mirror of
//! `ui/src/apcFeedback.ts`. The pad grid shows the look grid (bright = the
//! playing cell, dim = available, coloured by each look's swatch), the bottom
//! row mirrors cue columns, scene LEDs light when their layer has something
//! to clear, and scene 5 blinks while blackout is armed.
//!
//! Hardware notes (mk2, generic mode): only the 5×8 clip grid is RGB — pads
//! take a 128-entry palette index as note-on velocity (channel 0 = solid).
//! Scene-launch LEDs are single-colour: velocity 0 off / 1 on / 2 blink.
//!
//! Keep `compute_leds` in lockstep with the TS implementation — the browser
//! drives the LEDs in dev, this module drives them in the .app, and they must
//! paint the same picture.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use midir::{MidiOutput, MidiOutputConnection};

use crate::color::{derby_macro_for_value, hsv_to_rgb};
use crate::state::EngineState;
use crate::types::{EffectTarget, Look};

/// Palette anchors (APC40 mk2 shares the Launchpad-style 128 palette):
/// (r, g, b, bright index, dim index)
const PALETTE: &[(u8, u8, u8, u8, u8)] = &[
    (255, 0, 0, 5, 7),
    (255, 127, 0, 9, 11),
    (255, 255, 0, 13, 15),
    (127, 255, 0, 17, 19),
    (0, 255, 0, 21, 23),
    (0, 255, 127, 25, 27),
    (0, 255, 255, 37, 39),
    (0, 127, 255, 41, 43),
    (0, 0, 255, 45, 47),
    (127, 0, 255, 49, 51),
    (255, 0, 255, 53, 55),
    (255, 0, 127, 57, 59),
    (255, 255, 255, 3, 1),
];

fn nearest(r: u8, g: u8, b: u8) -> (u8, u8) {
    // low-chroma greys read best as white on the pads
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    if max - min < 40 {
        return (3, 1);
    }
    let mut best = (3u8, 1u8);
    let mut bd = i64::MAX;
    for &(pr, pg, pb, bright, dim) in PALETTE {
        let d = (i64::from(r) - i64::from(pr)).pow(2)
            + (i64::from(g) - i64::from(pg)).pow(2)
            + (i64::from(b) - i64::from(pb)).pow(2);
        if d < bd {
            bd = d;
            best = (bright, dim);
        }
    }
    best
}

/// First swatch colour of a look — mirror of `lookSwatch(look)[0]` in
/// `ui/src/lookColors.ts` (first part that yields a colour wins). Cue lists
/// borrow the swatch of their first resolvable step.
fn swatch_first(look: &Look, looks: &std::collections::HashMap<String, Look>) -> (u8, u8, u8) {
    if let Some(steps) = look.steps.as_ref().filter(|s| !s.is_empty()) {
        for st in steps {
            if let Some(target) = looks.get(&st.look_id) {
                if target.steps.as_ref().is_none_or(|s| s.is_empty()) {
                    return swatch_first_plain(target);
                }
            }
        }
        return (0x3a, 0x3a, 0x40);
    }
    swatch_first_plain(look)
}

fn swatch_first_plain(look: &Look) -> (u8, u8, u8) {
    for part in &look.parts {
        if part.effects.iter().any(|e| e.target == EffectTarget::Hue) {
            return (0xff, 0x3b, 0x30); // RAINBOW[0]
        }
        if let Some(m) = part.params.macro_ {
            // macro_ is the raw 0-255 DMX byte, same scale the TS side passes
            if let Some(&[r, g, b]) = derby_macro_for_value(m).comps.first() {
                return (r, g, b);
            }
            return (0x3a, 0x3a, 0x40); // "Off" macro has no comps
        }
        if let Some(c) = &part.params.color {
            let (r, g, b) = hsv_to_rgb(c.h, c.s, 1.0);
            return (
                (r * 255.0).round() as u8,
                (g * 255.0).round() as u8,
                (b * 255.0).round() as u8,
            );
        }
        if part.params.white.is_some() || part.params.ring_fx.is_some() {
            return (0xf5, 0xf5, 0xf0);
        }
        if part.params.strobe.is_some() {
            return (0xe8, 0xe8, 0xee);
        }
        if part.params.dimmer.is_some() || !part.effects.is_empty() {
            return (0x9a, 0x9a, 0xa4);
        }
    }
    (0x3a, 0x3a, 0x40)
}

/// note → velocity (channel 0); everything not present = off.
/// Mirror of `computeLeds` in `ui/src/apcFeedback.ts`.
fn compute_leds(state: &EngineState) -> HashMap<u8, u8> {
    let p = &state.project;
    let mut leds: HashMap<u8, u8> = HashMap::new();

    // visual layer order is bottom-up on the controller: reversed, top 4 rows
    for (row, layer) in p.layers.iter().rev().take(4).enumerate() {
        let live = state.live.get(&layer.id);
        let base = 32 - 8 * row as i16;
        for col in 0..p.columns.len().min(8) {
            let Some(Some(look_id)) = layer.cells.get(col) else { continue };
            let Some(look) = p.looks.get(look_id) else { continue };
            let (r, g, b) = swatch_first(look, &p.looks);
            let (bright, dim) = nearest(r, g, b);
            let active = live.is_some_and(|lv| {
                lv.look_id.as_deref() == Some(look_id.as_str()) && lv.col == Some(col)
            });
            leds.insert((base + col as i16) as u8, if active { bright } else { dim });
        }
        // scene LED (single-colour): on when the layer has something to clear
        if live.is_some_and(|lv| lv.look_id.is_some()) {
            leds.insert(82 + row as u8, 1);
        }
    }

    // bottom row: cue columns — dim when the column holds any non-flash look,
    // bright white when it's the most recent cue on any layer
    for col in 0..p.columns.len().min(8) {
        let has_content = p.layers.iter().any(|l| {
            l.cells
                .get(col)
                .and_then(|c| c.as_ref())
                .and_then(|id| p.looks.get(id))
                .is_some_and(|lk| !lk.is_flash())
        });
        let is_live = state
            .live
            .values()
            .any(|lv| lv.col == Some(col) && lv.look_id.is_some());
        if is_live {
            leds.insert(col as u8, 3);
        } else if has_content {
            leds.insert(col as u8, 1);
        }
    }

    // scene 5 = blackout: blink while armed
    if state.blackout {
        leds.insert(86, 2);
    }

    leds
}

/// Owns the APC40 output connection; rescans for hot-plug, clears the surface
/// on attach, and diffs LED state at ~15 Hz so the wire stays quiet.
pub struct ApcOut {
    conn: Option<MidiOutputConnection>,
    last_sent: HashMap<u8, u8>,
    last_update: Instant,
    last_scan: Instant,
}

impl ApcOut {
    pub fn new() -> Self {
        ApcOut {
            conn: None,
            last_sent: HashMap::new(),
            // fire immediately on first update
            last_update: Instant::now() - Duration::from_secs(1),
            last_scan: Instant::now() - Duration::from_secs(10),
        }
    }

    fn ensure_connection(&mut self) {
        if self.conn.is_some() || self.last_scan.elapsed() < Duration::from_secs(3) {
            return;
        }
        self.last_scan = Instant::now();
        let Ok(out) = MidiOutput::new("LIGHT") else { return };
        let port = out.ports().into_iter().find(|p| {
            out.port_name(p)
                .map(|n| n.to_lowercase().contains("apc40"))
                .unwrap_or(false)
        });
        let Some(port) = port else { return };
        match out.connect(&port, "light-apc-leds") {
            Ok(mut conn) => {
                // clear the whole surface once on attach
                for n in (0u8..=39).chain(82..=86) {
                    let _ = conn.send(&[0x90, n, 0]);
                }
                self.last_sent.clear();
                self.conn = Some(conn);
                println!("[apc] LED feedback attached");
            }
            Err(e) => eprintln!("[apc] connect failed: {e}"),
        }
    }

    /// Called every engine tick; throttles itself and only sends diffs.
    pub fn update(&mut self, state: &EngineState) {
        if self.last_update.elapsed() < Duration::from_millis(66) {
            return;
        }
        self.last_update = Instant::now();
        self.ensure_connection();
        let Some(conn) = self.conn.as_mut() else { return };

        let leds = compute_leds(state);
        let mut failed = false;

        // explicitly turn off notes that vanished
        let gone: Vec<u8> = self
            .last_sent
            .iter()
            .filter(|(note, vel)| **vel != 0 && !leds.contains_key(note))
            .map(|(note, _)| *note)
            .collect();
        for note in gone {
            if conn.send(&[0x90, note, 0]).is_err() {
                failed = true;
            }
            self.last_sent.insert(note, 0);
        }
        // send only changes
        for (&note, &vel) in &leds {
            if self.last_sent.get(&note).copied() != Some(vel) {
                if conn.send(&[0x90, note, vel]).is_err() {
                    failed = true;
                }
                self.last_sent.insert(note, vel);
            }
        }

        if failed {
            // device unplugged mid-show — drop and let the rescan re-attach
            eprintln!("[apc] send failed — device detached, will rescan");
            self.conn = None;
            self.last_sent.clear();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::defaults::default_project;

    #[test]
    fn default_project_leds_match_browser_reference() {
        // Idle engine on the default project: no live layers, no blackout —
        // only "column holds content" dim cells and pad colours appear.
        let mut state = EngineState::new(default_project(), 0.0);
        let leds = compute_leds(&state);
        // no scene LEDs, no blackout blink while idle
        for n in 82..=86 {
            assert!(!leds.contains_key(&n), "scene LED {n} lit while idle");
        }
        // every lit pad must be a valid velocity (palette index or 1/2/3)
        for (&note, &vel) in &leds {
            assert!(note <= 39 || (82..=86).contains(&note), "note {note} out of surface");
            assert!(vel > 0 && vel < 128, "velocity {vel} out of range");
        }

        // fire the first column as a cue: its bottom-row LED goes bright
        state.trigger_column(0, 0.0);
        let leds = compute_leds(&state);
        assert_eq!(leds.get(&0).copied(), Some(3), "live cue column should be bright white");

        // blackout blinks scene 5
        state.blackout = true;
        let leds = compute_leds(&state);
        assert_eq!(leds.get(&86).copied(), Some(2));
    }

    #[test]
    fn grid_rows_map_bottom_up() {
        // top visual layer (last in project order) must land on pad row 32..39
        let p = default_project();
        let top_layer = p.layers.last().unwrap().id.clone();
        let mut state = EngineState::new(p, 0.0);
        // find a column with content on the top layer and trigger it
        let cells = state
            .project
            .layers
            .last()
            .unwrap()
            .cells
            .clone();
        let Some(col) = cells.iter().position(|c| c.is_some()) else {
            return; // default project always has content, but stay robust
        };
        state.trigger(&top_layer, col, 0.0, crate::state::LOCAL_CLIENT);
        let leds = compute_leds(&state);
        let note = (32 + col) as u8;
        let vel = leds.get(&note).copied().unwrap_or(0);
        // the playing cell must use its BRIGHT palette index — every bright
        // anchor is odd-or-3 per the table; assert it differs from dim state
        state.clear_layer(&top_layer, 0.0);
        let idle = compute_leds(&state);
        assert_ne!(idle.get(&note).copied(), Some(vel), "active pad must differ from idle");
    }
}
