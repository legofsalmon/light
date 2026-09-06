//! LED feedback for Akai control surfaces over native MIDI — the packaged
//! app's mirror of `ui/src/apcFeedback.ts`. The four upper pad rows show the
//! look grid (bright = the playing pad, dim = available, coloured by each
//! look's swatch), the layer buttons light when their layer has something to
//! clear, the blackout button blinks while blackout is armed, and the tap
//! button pulses on the beat.
//!
//! **Two surfaces, one picture, two encodings.** The APC40 mk2 takes a palette
//! index as velocity on channel 0, and brightness is baked into the palette:
//! each hue has a bright index and a dim one. The APC mini mk2 takes the same
//! palette index but the MIDI CHANNEL selects the behaviour — channel 6 is full
//! brightness, channel 1 is 25%. So the LED map is computed once as (note →
//! channel, velocity) and each surface encodes the same "playing / available"
//! decision its own way. Both can be plugged in at once; each keeps its own
//! diff cache.
//!
//! Single-colour buttons (layer, blackout, tap) are velocity 0 off / 1 on /
//! 2 blink on both. Note 2 is the HARDWARE blink at a fixed rate, which is why
//! the tap pulse is driven from the beat here rather than handed to the device.
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

/// 4 layer rows on both surfaces. On the APC40 mk2 the fifth row of its 5 x 8
/// grid belongs to the control row the look grid draws under the layers; the
/// mini's 8 x 8 has room for the column row as well. Mirrors APC_LAYER_ROWS in
/// `ui/src/apcFeedback.ts`.
const APC_LAYER_ROWS: usize = 4;

/// White, as the palette's bright and dim anchors — the column row is not
/// coloured by a look, because a column holds one per layer.
const WHITE: (u8, u8) = (3, 1);

/// Where a surface's buttons live and how it wants a pad lit. Data, not a
/// trait: the two surfaces differ in note numbers and in one encoding
/// decision, and nothing else.
pub struct Surface {
    pub name: &'static str,
    /// lowercased substrings that identify the port
    pub matches: &'static [&'static str],
    /// note of column 0 in the TOP layer row; each row down is 8 lower
    pub layer_base: u8,
    /// layer-clear buttons, top row first
    pub scene_base: u8,
    /// blackout / stop-all-clips
    pub blackout: u8,
    /// tap tempo, pulsed on the beat
    pub tap: u8,
    /// pad row that fires whole columns, where the surface has one
    pub column_base: Option<u8>,
    /// Some((playing, available)) when brightness is the CHANNEL and the
    /// palette index is just the hue (mini mk2); None when the palette index
    /// carries the brightness itself (APC40 mk2, channel 0 throughout).
    pub bright_channels: Option<(u8, u8)>,
    /// inclusive note ranges to blank on attach
    pub clear: &'static [(u8, u8)],
}

impl Surface {
    /// One "playing or available" decision, encoded the way this surface wants.
    fn pad(&self, palette: (u8, u8), active: bool) -> (u8, u8) {
        match self.bright_channels {
            Some((on, off)) => (if active { on } else { off }, palette.0),
            None => (0, if active { palette.0 } else { palette.1 }),
        }
    }
}

/// Only the 5 x 8 clip grid is RGB; scene LEDs are single-colour. The bottom
/// row of the grid is left dark for the control row the screen draws there.
pub const APC40_MK2: Surface = Surface {
    name: "APC40 mk2",
    matches: &["apc40"],
    layer_base: 32,
    scene_base: 82,
    blackout: 81,
    tap: 99,
    column_base: None,
    bright_channels: None,
    clear: &[(0, 39), (81, 86), (99, 99)],
};

/// 8 x 8 RGB grid with the bottom row firing columns, and a scene column down
/// the right. Brightness is the channel here: 6 is 100%, 1 is 25%.
pub const APC_MINI_MK2: Surface = Surface {
    name: "APC mini mk2",
    matches: &["apc mini", "apcmini"],
    layer_base: 56,
    scene_base: 112,
    blackout: 119,
    tap: 118,
    column_base: Some(0),
    bright_channels: Some((6, 1)),
    clear: &[(0, 63), (112, 119)],
};

pub const SURFACES: &[&Surface] = &[&APC40_MK2, &APC_MINI_MK2];

/// note → (channel, velocity); everything not present = off.
/// Mirror of `computeLeds` in `ui/src/apcFeedback.ts`.
fn compute_leds(state: &EngineState, s: &Surface, beat: f64) -> HashMap<u8, (u8, u8)> {
    let p = &state.project;
    let mut leds: HashMap<u8, (u8, u8)> = HashMap::new();

    // FOUR layer rows, not five: the fifth belongs to the control row the look
    // grid shows underneath the layers, so the 5 x 8 surface and the screen are
    // the same shape. (Older layouts put a fifth layer, and before that cue
    // columns, on the bottom row — don't restore either here.)
    for (row, layer) in p.layers.iter().rev().take(APC_LAYER_ROWS).enumerate() {
        let live = state.live.get(&layer.id);
        let base = s.layer_base as i16 - 8 * row as i16;
        for col in 0..p.columns.len().min(8) {
            let Some(Some(look_id)) = layer.cells.get(col) else { continue };
            let Some(look) = p.looks.get(look_id) else { continue };
            let (r, g, b) = swatch_first(look, &p.looks);
            let (bright, dim) = nearest(r, g, b);
            let active = live.is_some_and(|lv| {
                lv.look_id.as_deref() == Some(look_id.as_str()) && lv.col == Some(col)
            });
            // The pad can hold a look the layer is NOT playing while still
            // being the live column — a library drag onto a live pad, where the
            // engine keeps playing what it captured at trigger time. Dim would
            // report "idle" on a layer that is lighting the rig, and a fixed
            // "stale" colour collides with any look that happens to use it
            // (white looks land on the same index). So the surface reports the
            // STAGE: bright, in the colour of whatever is actually playing.
            // The screen carries the nuance that the pad holds something else.
            let stale_playing = (!active)
                .then(|| live.filter(|lv| lv.col == Some(col)).and_then(|lv| lv.look_id.as_deref()))
                .flatten()
                .and_then(|id| p.looks.get(id));
            let cell = if let Some(playing) = stale_playing {
                let (pr, pg, pb) = swatch_first(playing, &p.looks);
                s.pad(nearest(pr, pg, pb), true)
            } else {
                s.pad((bright, dim), active)
            };
            leds.insert((base + col as i16) as u8, cell);
        }
        // layer button (single-colour): on when the layer has something to clear
        if live.is_some_and(|lv| lv.look_id.is_some()) {
            leds.insert(s.scene_base + row as u8, (0, 1));
        }
    }

    // The column row, where the surface has one. A column button fires every
    // layer at once, so it reports the same thing back: lit dim while the
    // column holds anything, bright while every layer holding something there
    // is actually playing it — the whole column up, which is exactly what
    // pressing it does. Change one pad afterwards and it drops to dim, which
    // is true: the column is no longer what is on stage. White rather than a
    // look colour, because a column holds one look per layer.
    if let Some(cb) = s.column_base {
        for col in 0..p.columns.len().min(8) {
            let holders: Vec<&crate::types::Layer> = p
                .layers
                .iter()
                .filter(|l| l.cells.get(col).is_some_and(|c| c.is_some()))
                .collect();
            if holders.is_empty() {
                continue;
            }
            let all_up = holders.iter().all(|l| {
                state.live.get(&l.id).is_some_and(|lv| {
                    lv.col == Some(col) && lv.look_id.as_deref() == l.cells[col].as_deref()
                })
            });
            leds.insert(cb + col as u8, s.pad(WHITE, all_up));
        }
    }

    // stop-all-clips = blackout: blink while armed
    if state.blackout {
        leds.insert(s.blackout, (0, 2));
    }

    // Tap pulses on the beat rather than using the hardware blink, which runs
    // at its own fixed rate and would sit there contradicting the tempo. A
    // quarter of a beat is longer than the 66 ms update period at any tempo a
    // rig runs at, so no beat is skipped.
    if beat.rem_euclid(1.0) < 0.25 {
        leds.insert(s.tap, (0, 1));
    }

    leds
}

/// One attached surface, with the diff cache that belongs to it. Two surfaces
/// plugged in at once must not share a cache — they paint different notes.
struct Attached {
    surface: &'static Surface,
    conn: MidiOutputConnection,
    last_sent: HashMap<u8, (u8, u8)>,
}

/// Owns the output connections; rescans for hot-plug, clears each surface on
/// attach, and diffs LED state at ~15 Hz so the wire stays quiet.
///
/// **Scanning happens on a worker, never on the tick.** Creating the first
/// CoreMIDI output client in a process costs around half a second — measured,
/// not guessed — and connecting then blanks up to 72 notes. Done inline that is
/// twenty-odd dropped DMX frames on the first tick, and `ROADMAP.md` forbids
/// exactly this. The worker does the client, the enumeration, the connect and
/// the blanking, and hands back only what it opened.
pub struct ApcOut {
    attached: Vec<Attached>,
    /// a scan in flight; nothing else may start one while it is
    pending: Option<std::sync::mpsc::Receiver<Vec<(&'static Surface, MidiOutputConnection)>>>,
    last_update: Instant,
    last_scan: Instant,
}

impl ApcOut {
    pub fn new() -> Self {
        ApcOut {
            attached: Vec::new(),
            pending: None,
            // fire immediately on first update
            last_update: Instant::now() - Duration::from_secs(1),
            last_scan: Instant::now() - Duration::from_secs(10),
        }
    }

    /// Everything a scan does, off the tick thread.
    fn scan(want: Vec<&'static Surface>) -> Vec<(&'static Surface, MidiOutputConnection)> {
        let mut found = Vec::new();
        let Ok(out) = MidiOutput::new("LIGHT") else { return found };
        let ports = out.ports();
        for surface in want {
            let port = ports.iter().find(|p| {
                out.port_name(p)
                    .map(|n| {
                        let n = n.to_lowercase();
                        surface.matches.iter().any(|m| n.contains(m))
                    })
                    .unwrap_or(false)
            });
            let Some(port) = port else { continue };
            // one MidiOutput per connection: connect() consumes it
            let Ok(client) = MidiOutput::new("LIGHT") else { continue };
            match client.connect(port, "light-surface-leds") {
                Ok(mut conn) => {
                    for &(from, to) in surface.clear {
                        for n in from..=to {
                            let _ = conn.send(&[0x90, n, 0]);
                        }
                    }
                    println!("[surface] {} LED feedback attached", surface.name);
                    found.push((surface, conn));
                }
                Err(e) => eprintln!("[surface] {} connect failed: {e}", surface.name),
            }
        }
        found
    }

    fn ensure_connections(&mut self) {
        // collect a finished scan first, so a surface found last time is in
        // hand before we decide whether another scan is worth starting
        if let Some(rx) = &self.pending {
            match rx.try_recv() {
                Ok(found) => {
                    for (surface, conn) in found {
                        self.attached.push(Attached { surface, conn, last_sent: HashMap::new() });
                    }
                    self.pending = None;
                }
                Err(std::sync::mpsc::TryRecvError::Disconnected) => self.pending = None,
                Err(std::sync::mpsc::TryRecvError::Empty) => return,
            }
        }
        let want: Vec<&'static Surface> = SURFACES
            .iter()
            .copied()
            .filter(|s| !self.attached.iter().any(|a| std::ptr::eq(a.surface, *s)))
            .collect();
        if want.is_empty() || self.last_scan.elapsed() < Duration::from_secs(3) {
            return;
        }
        self.last_scan = Instant::now();
        let (tx, rx) = std::sync::mpsc::channel();
        if std::thread::Builder::new()
            .name("light-surface-scan".into())
            .spawn(move || {
                let _ = tx.send(Self::scan(want));
            })
            .is_ok()
        {
            self.pending = Some(rx);
        }
    }

    /// Called every engine tick; throttles itself and only sends diffs.
    pub fn update(&mut self, state: &EngineState, beat: f64) {
        if self.last_update.elapsed() < Duration::from_millis(66) {
            return;
        }
        self.last_update = Instant::now();
        self.ensure_connections();

        self.attached.retain_mut(|a| {
            let leds = compute_leds(state, a.surface, beat);
            let mut failed = false;

            // explicitly turn off notes that vanished
            let gone: Vec<(u8, u8)> = a
                .last_sent
                .iter()
                .filter(|(note, (_, vel))| *vel != 0 && !leds.contains_key(note))
                .map(|(note, (ch, _))| (*note, *ch))
                .collect();
            for (note, ch) in gone {
                if a.conn.send(&[0x90 | ch, note, 0]).is_err() {
                    failed = true;
                }
                a.last_sent.insert(note, (ch, 0));
            }
            // send only changes — the CHANNEL is part of the state, not just
            // the velocity: on the mini a pad that stays the same colour and
            // changes brightness changes only the channel, and folding it away
            // would leave that pad stuck at its old brightness.
            for (&note, &(ch, vel)) in &leds {
                if a.last_sent.get(&note).copied() != Some((ch, vel)) {
                    if a.conn.send(&[0x90 | ch, note, vel]).is_err() {
                        failed = true;
                    }
                    a.last_sent.insert(note, (ch, vel));
                }
            }

            if failed {
                // unplugged mid-show — drop it and let the rescan re-attach
                eprintln!("[surface] {} send failed — detached, will rescan", a.surface.name);
            }
            !failed
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::defaults::default_project;

    /// Off-beat, so the tap pulse is not in the way of a note-table assertion.
    const OFFBEAT: f64 = 0.5;

    fn vel(leds: &HashMap<u8, (u8, u8)>, note: u8) -> Option<u8> {
        leds.get(&note).map(|&(_, v)| v)
    }

    /// A look that stays on stage once fired, chosen the same way every run.
    ///
    /// `looks.keys().next()` is what these tests used to do, and `looks` is a
    /// HashMap: the look was whatever the hash seed handed over that run. 14 of
    /// the demo's 190 looks are `flash` — momentary, so triggering one does not
    /// leave it live — and picking one of those made a test fail about once in
    /// fifteen runs with nothing in the diff to explain it. Sorted, and skipping
    /// flash and cue lists, so the choice is a property of the file.
    fn steady_look(p: &crate::types::Project) -> String {
        let mut ids: Vec<&String> = p.looks.keys().collect();
        ids.sort();
        ids.into_iter()
            .find(|id| {
                let l = &p.looks[*id];
                l.flash != Some(true) && l.steps.as_ref().is_none_or(|s| s.is_empty())
            })
            .expect("the demo has a look that stays up")
            .clone()
    }

    /// Colours chosen to land on every palette anchor, plus the greys the
    /// low-chroma rule catches and a few that sit between anchors.
    const PROBES: &[(u8, u8, u8)] = &[
        (255, 0, 0),
        (255, 127, 0),
        (255, 255, 0),
        (127, 255, 0),
        (0, 255, 0),
        (0, 255, 127),
        (0, 255, 255),
        (0, 127, 255),
        (0, 0, 255),
        (127, 0, 255),
        (255, 0, 255),
        (255, 0, 127),
        (255, 255, 255),
        (0, 0, 0),
        (0x3a, 0x3a, 0x40),
        (0x9a, 0x9a, 0xa4),
        (0xf5, 0xf5, 0xf0),
        (0xe8, 0xe8, 0xee),
        (0xff, 0x3b, 0x30),
        (200, 60, 20),
        (20, 200, 60),
        (60, 20, 200),
    ];

    /// The data both implementations duplicate as literals — the palette and
    /// the note tables — in one canonical form.
    fn golden() -> String {
        let mut out = String::from("{\n  \"surfaces\": [\n");
        for (i, s) in SURFACES.iter().enumerate() {
            out.push_str(&format!(
                "    {{\"name\": \"{}\", \"matches\": [{}], \"layerBase\": {}, \"sceneBase\": {}, \"blackout\": {}, \"tap\": {}, \"columnBase\": {}, \"brightChannels\": {}, \"clear\": [{}]}}{}\n",
                s.name,
                s.matches.iter().map(|m| format!("\"{m}\"")).collect::<Vec<_>>().join(", "),
                s.layer_base,
                s.scene_base,
                s.blackout,
                s.tap,
                s.column_base.map_or("null".into(), |c| c.to_string()),
                s.bright_channels.map_or("null".into(), |(a, b)| format!("[{a}, {b}]")),
                s.clear.iter().map(|&(a, b)| format!("[{a}, {b}]")).collect::<Vec<_>>().join(", "),
                if i + 1 == SURFACES.len() { "" } else { "," }
            ));
        }
        out.push_str("  ],\n  \"nearest\": [\n");
        for (i, &(r, g, b)) in PROBES.iter().enumerate() {
            let (bright, dim) = nearest(r, g, b);
            out.push_str(&format!(
                "    [\"#{r:02x}{g:02x}{b:02x}\", {bright}, {dim}]{}\n",
                if i + 1 == PROBES.len() { "" } else { "," }
            ));
        }
        out.push_str("  ]\n}\n");
        out
    }

    /// The palette anchors and the note tables are LITERAL DATA duplicated in
    /// core/src/apc.rs and ui/src/surfaces.ts. Every other test here asserts a
    /// property, and a property test passes happily while one side has a typo
    /// in a palette index — the two would simply light different colours. This
    /// one pins the data itself against a file the Node suite checks too, so a
    /// change to either side that is not made to the other fails on one of
    /// them. Regenerate with LIGHT_BLESS_GOLDEN=1.
    #[test]
    fn the_palette_and_note_tables_match_the_browser() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/data/surface-leds.json");
        let want = golden();
        if std::env::var("LIGHT_BLESS_GOLDEN").is_ok() {
            std::fs::write(path, &want).expect("write golden");
            return;
        }
        let have = std::fs::read_to_string(path).expect("golden file missing");
        assert_eq!(have, want, "surface data drifted from the golden");
    }

    #[test]
    fn default_project_leds_match_browser_reference() {
        // Idle engine on the default project: no live layers, no blackout —
        // only "column holds content" dim cells and pad colours appear.
        let mut state = EngineState::new(default_project(), 0.0);
        let leds = compute_leds(&state, &APC40_MK2, OFFBEAT);
        // no layer buttons, no blackout blink while idle
        for n in 82..=86 {
            assert!(!leds.contains_key(&n), "layer button {n} lit while idle");
        }
        // every lit pad must be a valid velocity on a valid note
        for (&note, &(ch, v)) in &leds {
            assert!(note <= 39 || (81..=86).contains(&note), "note {note} out of surface");
            assert!(v > 0 && v < 128, "velocity {v} out of range");
            assert_eq!(ch, 0, "the APC40 paints everything on channel 0");
        }

        // The bottom row is a LAYER row now, not a cue mirror: firing a column
        // must not paint the old bright-white cue marker over pad 0.
        state.trigger_column(0, 0.0);
        let leds = compute_leds(&state, &APC40_MK2, OFFBEAT);
        assert_ne!(vel(&leds, 0), Some(3), "pad 0 belongs to the bottom layer now, not the cue row");

        // blackout blinks stop-all-clips, freeing scene 5 for the fifth layer
        state.blackout = true;
        let leds = compute_leds(&state, &APC40_MK2, OFFBEAT);
        assert_eq!(leds.get(&81).copied(), Some((0, 2)));
    }

    #[test]
    fn a_live_column_holding_a_different_look_still_reports_the_stage() {
        // The screen shows this as `.cell.stale`: the layer is still playing
        // what it captured at trigger time, but the pad has been re-pointed at
        // another look (a library drag onto a live pad). Dim would tell an
        // operator in the dark that the layer is idle while it lights the rig.
        let p = default_project();
        let top_layer = p.layers.last().unwrap().id.clone();
        let mut state = EngineState::new(p, 0.0);
        let mut ids = state.project.looks.keys().cloned().collect::<Vec<_>>();
        ids.sort();
        assert!(ids.len() >= 2, "need two looks to re-point a pad");
        let (played, swapped) = (ids[0].clone(), ids[1].clone());
        let col = 0usize;

        if let Some(layer) = state.project.layers.last_mut() {
            layer.cells[col] = Some(played.clone());
        }
        state.trigger(&top_layer, col, 0.0, crate::state::LOCAL_CLIENT);
        let playing = compute_leds(&state, &APC40_MK2, OFFBEAT).get(&(32 + col as u8)).copied();

        // re-point the pad; the engine keeps playing `played`
        if let Some(layer) = state.project.layers.last_mut() {
            layer.cells[col] = Some(swapped);
        }
        let stale = compute_leds(&state, &APC40_MK2, OFFBEAT).get(&(32 + col as u8)).copied();
        // the surface keeps reporting the stage: same bright colour as before
        // the pad was re-pointed, because the SAME look is still playing
        assert_eq!(stale, playing, "a re-pointed live pad must still report what is on stage");

        // and an idle pad in another column stays dim, not white
        let idle_col = 1usize;
        if let Some(layer) = state.project.layers.last_mut() {
            layer.cells[idle_col] = Some(played);
        }
        let idle = compute_leds(&state, &APC40_MK2, OFFBEAT).get(&(32 + idle_col as u8)).copied();
        assert_ne!(idle, stale, "a pad outside the live column must read as idle");
    }

    #[test]
    fn the_control_row_is_never_taken_by_a_fifth_layer() {
        // The APC40's bottom row belongs to the control row the look grid draws
        // under the layers. A project carrying a fifth layer must not light it.
        let mut p = default_project();
        let extra = p.layers[0].clone();
        p.layers.insert(0, crate::types::Layer { id: "layer-fifth".into(), ..extra });
        let mut state = EngineState::new(p, 0.0);
        let look_id = steady_look(&state.project);
        if let Some(layer) = state.project.layers.iter_mut().find(|l| l.id == "layer-fifth") {
            layer.cells[0] = Some(look_id);
        }
        let leds = compute_leds(&state, &APC40_MK2, OFFBEAT);
        for note in 0u8..8 {
            assert!(!leds.contains_key(&note), "bottom row note {note} must stay dark for controls");
        }
    }

    #[test]
    fn grid_rows_map_bottom_up() {
        // top visual layer (last in project order) must land on each surface's
        // own top row: 32..39 on the APC40, 56..63 on the mini
        for surface in SURFACES {
            let p = default_project();
            let top_layer = p.layers.last().unwrap().id.clone();
            let mut state = EngineState::new(p, 0.0);
            // Seed the pad rather than hunting for one. The shipped show is a
            // real set list: its opening song is ambient and has nothing on the
            // strobe layer, so searching found nothing and this test quietly
            // returned without asserting anything. What is under test is the
            // pad mapping, not the artistic content of song one.
            let look_id = steady_look(&state.project);
            let col = 0usize;
            if let Some(layer) = state.project.layers.last_mut() {
                layer.cells[col] = Some(look_id);
            }
            state.trigger(&top_layer, col, 0.0, crate::state::LOCAL_CLIENT);
            let note = surface.layer_base + col as u8;
            let live = compute_leds(&state, surface, OFFBEAT).get(&note).copied();
            assert!(live.is_some(), "{}: the playing pad is dark", surface.name);
            state.clear_layer(&top_layer, 0.0);
            let idle = compute_leds(&state, surface, OFFBEAT).get(&note).copied();
            assert_ne!(idle, live, "{}: active pad must differ from idle", surface.name);
        }
    }

    #[test]
    fn both_surfaces_paint_the_same_picture_in_their_own_encoding() {
        // The whole point of the surface table. Same state, same decision about
        // every pad — the APC40 says it with a palette index on channel 0, the
        // mini says it with the channel and one colour index.
        let p = default_project();
        let top_layer = p.layers.last().unwrap().id.clone();
        let mut state = EngineState::new(p, 0.0);
        let look_id = steady_look(&state.project);
        if let Some(layer) = state.project.layers.last_mut() {
            layer.cells[0] = Some(look_id.clone());
            layer.cells[1] = Some(look_id);
        }
        state.trigger(&top_layer, 0, 0.0, crate::state::LOCAL_CLIENT);

        let big = compute_leds(&state, &APC40_MK2, OFFBEAT);
        let mini = compute_leds(&state, &APC_MINI_MK2, OFFBEAT);

        let (big_live, big_idle) = (big[&32], big[&33]);
        let (mini_live, mini_idle) = (mini[&56], mini[&57]);
        // APC40: one channel, two palette indices
        assert_eq!(big_live.0, 0);
        assert_eq!(big_idle.0, 0);
        assert_ne!(big_live.1, big_idle.1, "the APC40 separates them by palette index");
        // mini: one palette index, two channels
        assert_eq!(mini_live.1, mini_idle.1, "the mini separates them by channel, not colour");
        assert_eq!((mini_live.0, mini_idle.0), (6, 1));
        // and the mini's colour is the APC40's BRIGHT index, both times: the
        // dim index is a dimmer shade of the same hue and would come out twice
        // as dark once the channel dimmed it again
        assert_eq!(mini_live.1, big_live.1, "the mini uses the full-brightness hue");
    }

    #[test]
    fn the_channel_alone_can_be_the_whole_change() {
        // Why the diff cache has to hold the channel as well as the velocity.
        // On the mini a pad going from available to playing keeps its colour
        // and moves channel; a cache keyed on velocity alone would see no
        // change and leave that pad stuck dim while its layer lights the rig.
        let p = default_project();
        let top_layer = p.layers.last().unwrap().id.clone();
        let mut state = EngineState::new(p, 0.0);
        let look_id = steady_look(&state.project);
        if let Some(layer) = state.project.layers.last_mut() {
            layer.cells[0] = Some(look_id);
        }
        let before = compute_leds(&state, &APC_MINI_MK2, OFFBEAT)[&56];
        state.trigger(&top_layer, 0, 0.0, crate::state::LOCAL_CLIENT);
        let after = compute_leds(&state, &APC_MINI_MK2, OFFBEAT)[&56];
        assert_eq!(before.1, after.1, "same colour");
        assert_ne!(before.0, after.0, "different channel");
        assert_ne!(before, after, "so the pair differs, and the diff sends it");
    }

    #[test]
    fn the_column_row_reports_the_whole_column() {
        // Only the mini has one. It fires every layer at once, so it says the
        // same thing back: dim while the column merely holds something, bright
        // only while every layer holding something there is playing it.
        let mut p = default_project();
        let look_id = steady_look(&p);
        for layer in &mut p.layers {
            layer.cells[0] = Some(look_id.clone());
        }
        let mut state = EngineState::new(p, 0.0);
        let held = compute_leds(&state, &APC_MINI_MK2, OFFBEAT)[&0];
        assert_eq!(held, APC_MINI_MK2.pad(WHITE, false), "holding content, nothing playing");

        state.trigger_column(0, 0.0);
        let up = compute_leds(&state, &APC_MINI_MK2, OFFBEAT)[&0];
        assert_eq!(up, APC_MINI_MK2.pad(WHITE, true), "the whole column is on stage");

        // clear one layer and the column is no longer what is on stage
        let one = state.project.layers[0].id.clone();
        state.clear_layer(&one, 0.0);
        let partial = compute_leds(&state, &APC_MINI_MK2, OFFBEAT)[&0];
        assert_eq!(partial, held, "a column that is only partly up reads as not up");

        // and the APC40 has no column row at all
        assert!(!compute_leds(&state, &APC40_MK2, OFFBEAT).contains_key(&0));
    }

    #[test]
    fn a_column_of_flash_looks_never_reads_as_up() {
        // A flash look is momentary: firing the column lights it while it is
        // held and lets go. So the column is not holding the stage and must not
        // claim to be. This is the behaviour that made the column test flaky
        // before `steady_look` — worth pinning rather than rediscovering, and
        // worth stating so nobody "fixes" it into always-bright.
        let mut p = default_project();
        let flash = {
            let mut ids: Vec<&String> = p.looks.keys().collect();
            ids.sort();
            ids.into_iter().find(|id| p.looks[*id].flash == Some(true)).expect("a flash look").clone()
        };
        for layer in &mut p.layers {
            layer.cells[0] = Some(flash.clone());
        }
        let mut state = EngineState::new(p, 0.0);
        state.trigger_column(0, 0.0);
        assert_eq!(
            compute_leds(&state, &APC_MINI_MK2, OFFBEAT)[&0],
            APC_MINI_MK2.pad(WHITE, false),
            "a flash look is not holding the stage"
        );
    }

    #[test]
    fn tap_pulses_once_a_beat_and_is_never_skipped() {
        let state = EngineState::new(default_project(), 0.0);
        for surface in SURFACES {
            let lit = |b: f64| compute_leds(&state, surface, b).contains_key(&surface.tap);
            assert!(lit(0.0), "{}: dark on the beat", surface.name);
            assert!(lit(4.05), "{}: dark just after a beat", surface.name);
            assert!(!lit(0.5), "{}: lit between beats", surface.name);
            assert!(!lit(0.99), "{}: lit between beats", surface.name);
            // negative beats happen before the first anchor, and rem_euclid
            // keeps the pulse on the beat there too rather than inverting it
            assert!(lit(-4.0), "{}: dark on a beat before the anchor", surface.name);
            assert!(!lit(-0.5), "{}: lit between beats before the anchor", surface.name);
        }
        // The window has to outlast the 66 ms update period at any tempo a rig
        // runs at, or a beat gets skipped and the LED looks broken.
        let beat_ms_at = |bpm: f64| 60_000.0 / bpm;
        assert!(0.25 * beat_ms_at(200.0) > 66.0, "the pulse is shorter than the update period");
    }

    #[test]
    fn every_surface_lights_only_notes_it_clears() {
        // A note lit but never blanked stays on after LIGHT quits — the APC40's
        // blackout LED did exactly that once, sitting there claiming "armed"
        // with blackout off. Every note the map can produce must be inside the
        // ranges the attach blanks.
        let mut p = default_project();
        let look_id = steady_look(&p);
        for layer in &mut p.layers {
            for col in 0..8.min(layer.cells.len()) {
                layer.cells[col] = Some(look_id.clone());
            }
        }
        let mut state = EngineState::new(p, 0.0);
        state.trigger_column(0, 0.0);
        state.blackout = true;
        for surface in SURFACES {
            let leds = compute_leds(&state, surface, 0.0); // on the beat: tap lit too
            assert!(leds.contains_key(&surface.tap), "{}: tap not exercised", surface.name);
            assert!(leds.contains_key(&surface.blackout), "{}: blackout not exercised", surface.name);
            for &note in leds.keys() {
                assert!(
                    surface.clear.iter().any(|&(a, b)| (a..=b).contains(&note)),
                    "{}: note {note} is lit but never blanked on attach",
                    surface.name
                );
            }
        }
    }
}
