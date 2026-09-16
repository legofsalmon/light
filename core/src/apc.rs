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
//! brightness, channel 1 is 25%. So the LED map is computed once as
//! ((channel, note) → (channel, velocity)) and each surface encodes the same
//! "playing / available" decision its own way. Both can be plugged in at once;
//! each keeps its own diff cache.
//!
//! The KEY is a pair because the APC40's eight CLIP STOP buttons — the column
//! row, under the grid — all carry note 52 and differ only by the track
//! channel. The VALUE keeps its own channel because on the mini the channel is
//! the brightness, so one button changes channel while staying one button.
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

/// A column row addressed by CHANNEL: one note, one channel per column.
/// Mirror of `Surface.columnRow` in `ui/src/surfaces.ts`.
pub struct ColumnRow {
    pub note: u8,
    pub channels: &'static [u8],
}

/// The APC40 mk2's CLIP STOP row, named once so the LED table and the input
/// preset (`ui/src/controllerPresets.ts`) cannot drift: one note (0x34), and
/// the channel is the track.
pub const APC40_COLUMN_ROW: ColumnRow = ColumnRow { note: 52, channels: &[0, 1, 2, 3, 4, 5, 6, 7] };

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
    /// An RGB PAD row that fires whole columns: eight consecutive notes from
    /// here on channel 0, lit dim / bright like any other pad (mini mk2).
    pub column_base: Option<u8>,
    /// A single-colour BUTTON row that fires whole columns: one note, and the
    /// channel is the column — the APC40 mk2's CLIP STOP row, where the channel
    /// IS the track. Not a second base note: the eight buttons all carry note 52
    /// and differ only by channel, which is why the LED map is keyed by the
    /// pair. Single-colour, so the two-brightness pad rule reduces to one bit
    /// here: lit while the whole column is on stage, dark otherwise.
    pub column_row: Option<ColumnRow>,
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

    /// Every (channel, note) the attach has to blank, so that nothing the map
    /// can light is left burning after LIGHT quits. The ranges are channel 0 —
    /// a velocity-0 note clears a pad whatever channel lit it — plus the column
    /// row, whose channel IS its address and which no channel-0 message would
    /// reach. Mirror of `clearAddresses` in `ui/src/surfaces.ts`.
    pub fn clear_addresses(&self) -> Vec<(u8, u8)> {
        let mut out = Vec::new();
        for &(from, to) in self.clear {
            for n in from..=to {
                out.push((0, n));
            }
        }
        if let Some(cr) = &self.column_row {
            for &ch in cr.channels {
                out.push((ch, cr.note));
            }
        }
        out
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
    column_row: Some(APC40_COLUMN_ROW),
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
    column_row: None,
    bright_channels: Some((6, 1)),
    clear: &[(0, 63), (112, 119)],
};

pub const SURFACES: &[&Surface] = &[&APC40_MK2, &APC_MINI_MK2];

/// (channel, note) → (channel, velocity); everything not present = off.
///
/// The KEY is the button's address; the VALUE still carries the channel the
/// message goes out on, and the two are not always the same number. On the mini
/// the channel is the BRIGHTNESS, so one button changes channel while staying
/// one button — folding that into the key would turn every brightness change
/// into an off on the old channel and an on on the new one. On the APC40's
/// CLIP STOP row the channel is the TRACK, so there the address and the send
/// channel are the same thing.
///
/// Mirror of `computeLeds` in `ui/src/surfaces.ts`.
fn compute_leds(state: &EngineState, s: &Surface, beat: f64) -> HashMap<(u8, u8), (u8, u8)> {
    let p = &state.project;
    let mut leds: HashMap<(u8, u8), (u8, u8)> = HashMap::new();

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
            leds.insert((0, (base + col as i16) as u8), cell);
        }
        // layer button (single-colour): on when the layer has something to clear
        if live.is_some_and(|lv| lv.look_id.is_some()) {
            leds.insert((0, s.scene_base + row as u8), (0, 1));
        }
    }

    // The column row, where the surface has one. A column button fires every
    // layer at once, so it reports the same thing back: it is bright while
    // every layer holding something there is actually playing it — the whole
    // column up, which is exactly what pressing it does. Change one pad
    // afterwards and it drops, which is true: the column is no longer what is
    // on stage.
    //
    // One rule, two encodings, as everywhere else on these surfaces. The mini's
    // column row is eight RGB PADS, so it can say both halves: dim while the
    // column merely holds something, bright while it is up — white rather than
    // a look colour, because a column holds one look per layer. The APC40's
    // CLIP STOP row is eight SINGLE-COLOUR buttons (0 off / 1 on / 2 blink), so
    // it says the half that matters with the house lights down: lit while the
    // column is on stage. The grid above it already shows which columns hold
    // content, and a blink means "armed" on this surface — blackout owns that.
    if s.column_base.is_some() || s.column_row.is_some() {
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
            if let Some(cr) = &s.column_row {
                if let Some(&ch) = cr.channels.get(col) {
                    if all_up {
                        leds.insert((ch, cr.note), (ch, 1));
                    }
                }
            } else if let Some(cb) = s.column_base {
                leds.insert((0, cb + col as u8), s.pad(WHITE, all_up));
            }
        }
    }

    // stop-all-clips = blackout: blink while armed
    if state.blackout {
        leds.insert((0, s.blackout), (0, 2));
    }

    // Tap pulses on the beat rather than using the hardware blink, which runs
    // at its own fixed rate and would sit there contradicting the tempo. A
    // quarter of a beat is longer than the 66 ms update period at any tempo a
    // rig runs at, so no beat is skipped.
    if beat.rem_euclid(1.0) < 0.25 {
        leds.insert((0, s.tap), (0, 1));
    }

    leds
}

/// One attached surface, with the diff cache that belongs to it. Two surfaces
/// plugged in at once must not share a cache — they paint different notes.
struct Attached {
    surface: &'static Surface,
    /// the port's name, which is how a switch-off in Sync · MIDI finds it
    port: String,
    conn: MidiOutputConnection,
    /// Keyed the way compute_leds is keyed: by the button's (channel, note)
    /// address, because on the APC40 eight buttons share note 52.
    last_sent: HashMap<(u8, u8), (u8, u8)>,
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
    pending: Option<std::sync::mpsc::Receiver<Vec<(&'static Surface, String, MidiOutputConnection)>>>,
    last_update: Instant,
    last_scan: Instant,
}

/// Which output a surface's LEDs go to: the first port whose name says it is
/// this surface and that is not switched off in Sync · MIDI. Two APC40s on one
/// Mac — one for LIGHT, one for Resolume — differ only by name, so the name is
/// the whole choice. Mirrors `choosePort` in shared/midiInputs.ts.
pub fn choose_port(names: &[String], surface: &Surface, off: &[String]) -> Option<usize> {
    names.iter().position(|n| {
        let lower = n.to_lowercase();
        surface.matches.iter().any(|m| lower.contains(m)) && !off.iter().any(|o| o == n)
    })
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
    fn scan(
        want: Vec<&'static Surface>,
        off: Vec<String>,
    ) -> Vec<(&'static Surface, String, MidiOutputConnection)> {
        let mut found = Vec::new();
        let Ok(out) = MidiOutput::new("LIGHT") else { return found };
        let ports = out.ports();
        let names: Vec<String> = ports.iter().map(|p| out.port_name(p).unwrap_or_default()).collect();
        for surface in want {
            let Some(i) = choose_port(&names, surface, &off) else { continue };
            let port = &ports[i];
            let name = names[i].clone();
            // one MidiOutput per connection: connect() consumes it
            let Ok(client) = MidiOutput::new("LIGHT") else { continue };
            match client.connect(port, "light-surface-leds") {
                Ok(mut conn) => {
                    // Velocity 0, so this can never fire a cue if it comes back
                    // round a loopback port: a zero-velocity note on is a note
                    // OFF, and every mapping that fires anything is guarded on
                    // the press.
                    for (ch, n) in surface.clear_addresses() {
                        let _ = conn.send(&[0x90 | ch, n, 0]);
                    }
                    println!("[surface] {} LED feedback attached ({name})", surface.name);
                    found.push((surface, name, conn));
                }
                Err(e) => eprintln!("[surface] {} connect failed: {e}", surface.name),
            }
        }
        found
    }

    fn ensure_connections(&mut self, off: &[String]) {
        // A surface whose port was switched off since it attached is another
        // app's now: blank what this one painted on it, and let it go.
        self.attached.retain_mut(|a| {
            if !off.iter().any(|o| *o == a.port) {
                return true;
            }
            for (ch, n) in a.surface.clear_addresses() {
                let _ = a.conn.send(&[0x90 | ch, n, 0]);
            }
            println!("[surface] {} switched off — its LEDs are left to the app that owns it", a.port);
            false
        });
        // collect a finished scan first, so a surface found last time is in
        // hand before we decide whether another scan is worth starting
        if let Some(rx) = &self.pending {
            match rx.try_recv() {
                Ok(found) => {
                    for (surface, port, conn) in found {
                        // switched off while the scan was out: not ours after all
                        if off.iter().any(|o| *o == port) {
                            continue;
                        }
                        self.attached.push(Attached { surface, port, conn, last_sent: HashMap::new() });
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
        let off = off.to_vec();
        if std::thread::Builder::new()
            .name("light-surface-scan".into())
            .spawn(move || {
                let _ = tx.send(Self::scan(want, off));
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
        self.ensure_connections(&state.project.sync.midi_inputs_off);

        self.attached.retain_mut(|a| {
            let leds = compute_leds(state, a.surface, beat);
            let mut failed = false;

            // Explicitly turn off buttons that vanished. The note goes out on
            // the channel it was LIT on, which is not always the channel in the
            // key — on the mini the key is the pad and the channel is its
            // brightness.
            let gone: Vec<((u8, u8), u8)> = a
                .last_sent
                .iter()
                .filter(|(key, (_, vel))| *vel != 0 && !leds.contains_key(key))
                .map(|(key, (ch, _))| (*key, *ch))
                .collect();
            for (key, ch) in gone {
                if a.conn.send(&[0x90 | ch, key.1, 0]).is_err() {
                    failed = true;
                }
                a.last_sent.insert(key, (ch, 0));
            }
            // send only changes — the CHANNEL is part of the state, not just
            // the velocity: on the mini a pad that stays the same colour and
            // changes brightness changes only the channel, and folding it away
            // would leave that pad stuck at its old brightness.
            for (&key, &(ch, vel)) in &leds {
                if a.last_sent.get(&key).copied() != Some((ch, vel)) {
                    if a.conn.send(&[0x90 | ch, key.1, vel]).is_err() {
                        failed = true;
                    }
                    a.last_sent.insert(key, (ch, vel));
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

    /// Two APC40s on one Mac differ only by name. The LEDs go to the first
    /// matching port that is not switched off — never to the other app's.
    #[test]
    fn the_leds_go_to_the_apc_that_is_switched_on() {
        let names: Vec<String> = ["IAC Driver Bus 1", "APC40 mk2", "APC40 LIGHT"].map(String::from).to_vec();
        assert_eq!(choose_port(&names, &APC40_MK2, &[]), Some(1), "nothing off: the first APC40");
        assert_eq!(choose_port(&names, &APC40_MK2, &["APC40 mk2".into()]), Some(2), "the first is Resolume's");
        assert_eq!(choose_port(&names, &APC40_MK2, &["APC40 mk2".into(), "APC40 LIGHT".into()]), None, "both off");
        assert_eq!(choose_port(&names, &APC_MINI_MK2, &[]), None, "a name that is not this surface is never chosen");
        // the same name twice cannot be told apart: off is off for both
        let twins: Vec<String> = ["APC40 mk2", "APC40 mk2"].map(String::from).to_vec();
        assert_eq!(choose_port(&twins, &APC40_MK2, &["APC40 mk2".into()]), None);
    }
    use crate::defaults::default_project;

    /// Off-beat, so the tap pulse is not in the way of a note-table assertion.
    const OFFBEAT: f64 = 0.5;

    /// Velocity of a button on channel 0 — the grid, the scene column, the
    /// blackout and tap keys. The column row is addressed by channel, so it has
    /// `at` below instead.
    fn vel(leds: &HashMap<(u8, u8), (u8, u8)>, note: u8) -> Option<u8> {
        leds.get(&(0, note)).map(|&(_, v)| v)
    }

    /// One button by its full address.
    fn at(leds: &HashMap<(u8, u8), (u8, u8)>, channel: u8, note: u8) -> Option<(u8, u8)> {
        leds.get(&(channel, note)).copied()
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
                "    {{\"name\": \"{}\", \"matches\": [{}], \"layerBase\": {}, \"sceneBase\": {}, \"blackout\": {}, \"tap\": {}, \"columnBase\": {}, \"columnRow\": {}, \"brightChannels\": {}, \"clear\": [{}]}}{}\n",
                s.name,
                s.matches.iter().map(|m| format!("\"{m}\"")).collect::<Vec<_>>().join(", "),
                s.layer_base,
                s.scene_base,
                s.blackout,
                s.tap,
                s.column_base.map_or("null".into(), |c| c.to_string()),
                s.column_row.as_ref().map_or("null".into(), |c| format!(
                    "{{\"note\": {}, \"channels\": [{}]}}",
                    c.note,
                    c.channels.iter().map(|n| n.to_string()).collect::<Vec<_>>().join(", ")
                )),
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
            assert!(at(&leds, 0, n).is_none(), "layer button {n} lit while idle");
        }
        // Every lit button must be a valid velocity at an address this surface
        // actually has. The APC40 paints the GRID on channel 0 — but not the
        // CLIP STOP row, where the channel is the track, so "everything on
        // channel 0" is no longer the whole truth and saying it that way would
        // have meant lighting the cue row on the wrong buttons.
        let col_row = APC40_MK2.column_row.as_ref().expect("the APC40 has a CLIP STOP row");
        for (&(ch, note), &(send, v)) in &leds {
            assert!(v > 0 && v < 128, "velocity {v} out of range");
            assert_eq!(send, ch, "the APC40 sends on the channel it addresses");
            if note == col_row.note {
                assert!(col_row.channels.contains(&ch), "CLIP STOP lit on channel {ch}");
            } else {
                assert_eq!(ch, 0, "the APC40 paints everything but CLIP STOP on channel 0");
                assert!(note <= 39 || (81..=86).contains(&note), "note {note} out of surface");
            }
        }

        // The bottom row is a LAYER row now, not a cue mirror: firing a column
        // must not paint the old bright-white cue marker over pad 0. The cue
        // marker lives on CLIP STOP, one row lower and on the track channel.
        state.trigger_column(0, 0.0);
        let leds = compute_leds(&state, &APC40_MK2, OFFBEAT);
        assert_ne!(vel(&leds, 0), Some(3), "pad 0 belongs to the bottom layer now, not the cue row");

        // blackout blinks stop-all-clips, freeing scene 5 for the fifth layer
        state.blackout = true;
        let leds = compute_leds(&state, &APC40_MK2, OFFBEAT);
        assert_eq!(at(&leds, 0, 81), Some((0, 2)));
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
        let playing = at(&compute_leds(&state, &APC40_MK2, OFFBEAT), 0, 32 + col as u8);

        // re-point the pad; the engine keeps playing `played`
        if let Some(layer) = state.project.layers.last_mut() {
            layer.cells[col] = Some(swapped);
        }
        let stale = at(&compute_leds(&state, &APC40_MK2, OFFBEAT), 0, 32 + col as u8);
        // the surface keeps reporting the stage: same bright colour as before
        // the pad was re-pointed, because the SAME look is still playing
        assert_eq!(stale, playing, "a re-pointed live pad must still report what is on stage");

        // and an idle pad in another column stays dim, not white
        let idle_col = 1usize;
        if let Some(layer) = state.project.layers.last_mut() {
            layer.cells[idle_col] = Some(played);
        }
        let idle = at(&compute_leds(&state, &APC40_MK2, OFFBEAT), 0, 32 + idle_col as u8);
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
            assert!(at(&leds, 0, note).is_none(), "bottom row note {note} must stay dark for controls");
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
            let live = at(&compute_leds(&state, surface, OFFBEAT), 0, note);
            assert!(live.is_some(), "{}: the playing pad is dark", surface.name);
            state.clear_layer(&top_layer, 0.0);
            let idle = at(&compute_leds(&state, surface, OFFBEAT), 0, note);
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

        let (big_live, big_idle) = (big[&(0, 32)], big[&(0, 33)]);
        let (mini_live, mini_idle) = (mini[&(0, 56)], mini[&(0, 57)]);
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
        let before = compute_leds(&state, &APC_MINI_MK2, OFFBEAT)[&(0, 56)];
        state.trigger(&top_layer, 0, 0.0, crate::state::LOCAL_CLIENT);
        let after = compute_leds(&state, &APC_MINI_MK2, OFFBEAT)[&(0, 56)];
        assert_eq!(before.1, after.1, "same colour");
        assert_ne!(before.0, after.0, "different channel");
        assert_ne!(before, after, "so the pair differs, and the diff sends it");
        // ...and it is still ONE key, not two. The address identifies a button;
        // the brightness channel rides in the value. Key on the send channel
        // instead and every pad that lights would first be blanked on the
        // channel it used to be lit on — twice the wire traffic, for the most
        // common change there is.
    }

    #[test]
    fn the_column_row_reports_the_whole_column() {
        // BOTH surfaces have one now — the mini's bottom pad row and the
        // APC40's CLIP STOP row — addressed differently and encoded
        // differently, from ONE rule: a column button fires every layer at
        // once, so it says the same thing back. The mini's RGB pads can say
        // both halves (dim holding, bright up); the APC40's single-colour
        // buttons say the half that matters with the house lights down.
        let mut p = default_project();
        let look_id = steady_look(&p);
        for layer in &mut p.layers {
            layer.cells[0] = Some(look_id.clone());
        }
        let mut state = EngineState::new(p, 0.0);
        let stop = |st: &EngineState, col: usize| {
            at(
                &compute_leds(st, &APC40_MK2, OFFBEAT),
                APC40_COLUMN_ROW.channels[col],
                APC40_COLUMN_ROW.note,
            )
        };
        let minicol = |st: &EngineState| at(&compute_leds(st, &APC_MINI_MK2, OFFBEAT), 0, 0);

        let held = minicol(&state).expect("the mini's column button holds content");
        assert_eq!(held, APC_MINI_MK2.pad(WHITE, false), "holding content, nothing playing");
        assert_eq!(stop(&state, 0), None, "CLIP STOP is dark until the column is on stage");

        state.trigger_column(0, 0.0);
        assert_eq!(minicol(&state), Some(APC_MINI_MK2.pad(WHITE, true)), "the whole column is on stage");
        assert_eq!(stop(&state, 0), Some((0, 1)), "CLIP STOP under column 1 lights when it is on stage");
        // The eight buttons are one note on eight channels, so the ONE that
        // lights has to be the one under the column that is up. Keyed by note
        // alone, every one of them would have claimed it.
        for col in 1..8 {
            assert_eq!(stop(&state, col), None, "CLIP STOP under column {} lit too", col + 1);
        }

        // clear one layer and the column is no longer what is on stage
        let one = state.project.layers[0].id.clone();
        state.clear_layer(&one, 0.0);
        assert_eq!(minicol(&state), Some(held), "a column that is only partly up reads as not up");
        assert_eq!(stop(&state, 0), None, "and CLIP STOP goes dark with it");
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
            compute_leds(&state, &APC_MINI_MK2, OFFBEAT)[&(0, 0)],
            APC_MINI_MK2.pad(WHITE, false),
            "a flash look is not holding the stage"
        );
        assert_eq!(
            at(
                &compute_leds(&state, &APC40_MK2, OFFBEAT),
                APC40_COLUMN_ROW.channels[0],
                APC40_COLUMN_ROW.note
            ),
            None,
            "and CLIP STOP does not claim it either"
        );
    }

    #[test]
    fn tap_pulses_once_a_beat_and_is_never_skipped() {
        let state = EngineState::new(default_project(), 0.0);
        for surface in SURFACES {
            let lit = |b: f64| compute_leds(&state, surface, b).contains_key(&(0, surface.tap));
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
    fn every_surface_lights_only_buttons_it_clears() {
        // A button lit but never blanked stays on after LIGHT quits — the
        // APC40's blackout LED did exactly that once, sitting there claiming
        // "armed" with blackout off. Every ADDRESS the map can produce must be
        // one the attach blanks, which is why this walks (channel, note) pairs:
        // the CLIP STOP row is eight buttons the old channel-0 note ranges
        // could not have reached at all.
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
            let blanked = surface.clear_addresses();
            assert!(leds.contains_key(&(0, surface.tap)), "{}: tap not exercised", surface.name);
            assert!(leds.contains_key(&(0, surface.blackout)), "{}: blackout not exercised", surface.name);
            // the column row has to be lit here too, or its addresses would go
            // through this test unexamined
            let col_lit = leds.keys().any(|&(ch, note)| {
                surface.column_row.as_ref().is_some_and(|c| c.note == note && c.channels.contains(&ch))
                    || surface.column_base.is_some_and(|cb| ch == 0 && note == cb)
            });
            assert!(col_lit, "{}: the column row not exercised", surface.name);
            for &key in leds.keys() {
                assert!(
                    blanked.contains(&key),
                    "{}: ch {} note {} is lit but never blanked on attach",
                    surface.name,
                    key.0,
                    key.1
                );
            }
        }
    }
}
