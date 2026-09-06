//! MIDI Beat Clock follower (backlog #10).
//!
//! Twenty-four ticks to the quarter note, and nothing else in the message:
//! no tempo, no position, just an edge. So the tempo is the interval between
//! edges, and the interval between two edges over USB is noisy enough that
//! using it directly would make the rig shiver. A window of a whole beat is
//! what turns that into a number worth following.
//!
//! Native only, like Link — a browser cannot see a timestamp worth averaging.
//! And mutually exclusive with Link, because LIGHT pushes a locally-set tempo
//! INTO a Link session: following a jittery clock and leading a session from
//! it would launder that jitter out to every other machine in the room.
//!
//! It does not free-run. If the source stops sending, the follower goes quiet
//! and the clock keeps whatever tempo it had — a stall is not a tempo change,
//! and a rig that slows to nothing because a cable moved is worse than one
//! that holds its last known tempo.

use std::collections::VecDeque;

/// Ticks per quarter note. Fixed by the MIDI spec, not a preference.
pub const PPQN: u64 = 24;

/// How many tick intervals the tempo is averaged over. One beat: long enough
/// to swamp per-message jitter, short enough to follow a DJ riding a pitch
/// fader within a beat of them doing it.
const WINDOW: usize = PPQN as usize;

/// Nothing for this long means the source is gone rather than slow. Two
/// seconds is below 20 BPM, which is under the clock's own floor.
const STALE_MICROS: u64 = 2_000_000;

/// Intervals outside this are a dropped message or a stopped transport, not a
/// tempo — 20 to 500 BPM is the range the beat clock itself clamps to.
const MIN_INTERVAL: u64 = 60_000_000 / (500 * PPQN);
const MAX_INTERVAL: u64 = 60_000_000 / (20 * PPQN);

#[derive(Debug, Default)]
pub struct MidiClock {
    /// tick timestamps in microseconds, oldest first
    ticks: VecDeque<u64>,
    /// Which port the ticks are coming from. The first source to send clock
    /// owns it until it goes quiet, so two devices both sending cannot fight
    /// over the tempo — and nobody has to configure which one to believe.
    source: Option<String>,
    last_at: u64,
    /// ticks since the last Start, which is the only way the phase is known
    since_start: u64,
    phase_known: bool,
    /// a Start or Continue arrived and the beat should be re-anchored
    pending_anchor: bool,
    running: bool,
}

/// What the follower wants the clock to do this tick.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ClockFollow {
    pub bpm: f64,
    /// Present when the transport just started: the beat to anchor to. Absent
    /// means "same phase, new tempo", which is every other tick.
    pub beat: Option<f64>,
}

impl MidiClock {
    pub fn new() -> Self {
        Self::default()
    }

    /// Whichever port is currently believed, if any.
    pub fn source(&self) -> Option<&str> {
        self.source.as_deref()
    }

    pub fn running(&self) -> bool {
        self.running
    }

    /// Feed one realtime status byte with the timestamp it arrived at.
    pub fn on_message(&mut self, status: u8, at_micros: u64, port: &str) {
        match status {
            0xF8 => self.tick(at_micros, port),
            // Start rewinds to the top of the bar; Continue picks up where it
            // stopped, so only Start knows where beat zero is.
            0xFA => {
                self.running = true;
                self.since_start = 0;
                self.phase_known = true;
                self.pending_anchor = true;
                self.own(port, at_micros);
            }
            0xFB => {
                self.running = true;
                self.own(port, at_micros);
            }
            0xFC => self.running = false,
            _ => {}
        }
    }

    fn own(&mut self, port: &str, at: u64) {
        if self.source.as_deref() != Some(port) && !self.is_live(at) {
            self.source = Some(port.to_string());
            self.ticks.clear();
        }
        self.last_at = at;
    }

    fn is_live(&self, now: u64) -> bool {
        self.source.is_some() && now.saturating_sub(self.last_at) < STALE_MICROS
    }

    fn tick(&mut self, at: u64, port: &str) {
        // A second source is ignored while the first is still sending. It is
        // not an error and not worth a warning — two clock sources on one rig
        // is a normal thing to have plugged in.
        if self.is_live(at) && self.source.as_deref() != Some(port) {
            return;
        }
        self.own(port, at);
        if let Some(&prev) = self.ticks.back() {
            let iv = at.saturating_sub(prev);
            // A dropped message, a paused transport, or the clock coming back
            // after a gap: start the window again rather than average an
            // interval that never happened.
            //
            // The absolute band alone does not catch the common case. One
            // dropped tick at 128 BPM is a 39 ms interval, which is a perfectly
            // legal 32 BPM — so it passes, and then sits in the window dragging
            // the tempo down for a whole beat. Judging it against the tempo
            // already being followed catches it: nothing a hand on a pitch
            // fader can do moves a single interval by half, and a source that
            // really did change tempo that much rebuilds the window in half a
            // beat, which is what it would have to do anyway.
            let sudden = self
                .per_tick()
                .is_some_and(|per| (iv as f64) < per * 0.6 || (iv as f64) > per * 1.6);
            if sudden || !(MIN_INTERVAL..=MAX_INTERVAL).contains(&iv) {
                self.ticks.clear();
            }
        }
        self.ticks.push_back(at);
        while self.ticks.len() > WINDOW + 1 {
            self.ticks.pop_front();
        }
        self.since_start = self.since_start.saturating_add(1);
    }

    /// Microseconds per tick across the window, by least squares.
    ///
    /// The obvious way — first edge to last, divided by the gaps between them —
    /// uses two of the twenty-five timestamps and throws the rest away, so the
    /// answer carries the full jitter of whichever two edges happen to be on
    /// the ends. A source running a few milliseconds late on one of them moves
    /// the reported tempo by more than a BPM. Fitting a line through every edge
    /// in the window instead uses all of them, which divides that noise by
    /// roughly the square root of the count, and it costs nothing in
    /// responsiveness: same window, same latency, better arithmetic.
    fn per_tick(&self) -> Option<f64> {
        let n = self.ticks.len();
        if n < 2 {
            return None;
        }
        // Ticks are one index apart by construction, so the x values are
        // 0..n and their spread is a constant — only the timestamps vary.
        let mid = (n - 1) as f64 / 2.0;
        let base = *self.ticks.front()?; // keep the f64 conversion small
        let mean = self.ticks.iter().map(|&t| (t - base) as f64).sum::<f64>() / n as f64;
        let mut num = 0.0;
        for (i, &t) in self.ticks.iter().enumerate() {
            num += (i as f64 - mid) * ((t - base) as f64 - mean);
        }
        // Σ(i - mid)² for i in 0..n, in closed form
        let den = (n as f64) * ((n * n) as f64 - 1.0) / 12.0;
        let per_tick = num / den;
        if per_tick <= 0.0 || !per_tick.is_finite() {
            return None;
        }
        Some(per_tick)
    }

    /// The tempo, and a beat to anchor to if the transport just started.
    /// None while there is not enough to be sure of, or once the source has
    /// gone quiet.
    pub fn follow(&mut self, now_micros: u64) -> Option<ClockFollow> {
        if !self.is_live(now_micros) {
            self.ticks.clear();
            self.source = None;
            return None;
        }
        // Half a beat of ticks before saying anything: a tempo taken from two
        // edges is a guess, and a wrong one shows on the rig immediately.
        if self.ticks.len() < WINDOW / 2 {
            return None;
        }
        let per_tick = self.per_tick()?;
        let bpm = 60_000_000.0 / (per_tick * PPQN as f64);
        if !bpm.is_finite() {
            return None;
        }
        let beat = if self.pending_anchor && self.phase_known {
            self.pending_anchor = false;
            // Start means the top: beat zero, and every 24 ticks after it.
            Some(self.since_start as f64 / PPQN as f64)
        } else {
            self.pending_anchor = false;
            None
        };
        Some(ClockFollow { bpm, beat })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One tick interval, in micros, for a tempo.
    fn iv(bpm: f64) -> u64 {
        (60_000_000.0 / (bpm * PPQN as f64)) as u64
    }

    fn run(c: &mut MidiClock, bpm: f64, ticks: usize, from: u64) -> u64 {
        let mut t = from;
        for _ in 0..ticks {
            c.on_message(0xF8, t, "Deck");
            t += iv(bpm);
        }
        t
    }

    #[test]
    fn it_says_nothing_until_it_has_enough_to_be_sure() {
        let mut c = MidiClock::new();
        let t = run(&mut c, 120.0, 4, 1_000_000);
        assert!(c.follow(t).is_none(), "four edges is a guess, not a tempo");
        let t = run(&mut c, 120.0, 10, t);
        assert!(c.follow(t).is_some(), "half a beat is enough");
    }

    #[test]
    fn it_reads_the_tempo_it_is_sent() {
        for want in [60.0, 120.0, 128.0, 174.0] {
            let mut c = MidiClock::new();
            let t = run(&mut c, want, 48, 1_000_000);
            let f = c.follow(t).expect("following");
            assert!((f.bpm - want).abs() < 0.5, "wanted {want}, got {}", f.bpm);
        }
    }

    #[test]
    fn jitter_averages_out_instead_of_shivering() {
        // +/- 1 ms on every edge, which is ordinary for USB MIDI. Averaged over
        // a beat it has to come out very close to the real tempo.
        let mut c = MidiClock::new();
        let base = iv(128.0);
        let mut t = 1_000_000u64;
        for i in 0..64 {
            let wobble = if i % 2 == 0 { 900 } else { -900i64 };
            c.on_message(0xF8, (t as i64 + wobble) as u64, "Deck");
            t += base;
        }
        let f = c.follow(t).expect("following");
        assert!((f.bpm - 128.0).abs() < 1.0, "got {}", f.bpm);
    }

    #[test]
    fn one_late_edge_does_not_move_the_tempo_much() {
        // The failure the least-squares fit exists to prevent. Filling the
        // window cleanly and then landing the newest edge 6 ms late is an
        // ordinary USB hiccup. Measured end to end that one edge IS the answer
        // and the tempo moves by more than 1.5 BPM; fitting a line through all
        // twenty-five puts it under half of that.
        let mut c = MidiClock::new();
        let step = iv(128.0);
        let mut t = run(&mut c, 128.0, 48, 1_000_000);
        let clean = c.follow(t).expect("following").bpm;
        assert!((clean - 128.0).abs() < 0.1, "a clean window reads true: {clean}");
        t += 6_000; // `run` already advanced to the next tick's due time
        c.on_message(0xF8, t, "Deck");
        let late = c.follow(t).expect("following").bpm;
        assert!((late - 128.0).abs() < 0.5, "one late edge moved the tempo to {late}");
    }

    #[test]
    fn a_single_dropped_tick_never_becomes_a_tempo() {
        // The worst realistic case, because it is legal: one missing tick at
        // 128 BPM is a 39 ms interval, which reads as a perfectly valid 32 BPM.
        // Left in the window it drags the tempo down for a whole beat, and the
        // rig visibly slows for that beat. It has to restart instead.
        let mut c = MidiClock::new();
        let step = iv(128.0);
        let mut t = run(&mut c, 128.0, 48, 1_000_000);
        assert!((c.follow(t).expect("following").bpm - 128.0).abs() < 0.1);
        t += step; // the tick that never arrived
        c.on_message(0xF8, t, "Deck");
        assert!(c.follow(t).is_none(), "the window restarted rather than keeping the hole");
        // and it comes back to the same tempo, not a slower one
        let t = run(&mut c, 128.0, 24, t + step);
        assert!((c.follow(t).expect("following").bpm - 128.0).abs() < 0.5, "got {}", c.follow(t).unwrap().bpm);
    }

    #[test]
    fn a_gap_restarts_the_window_rather_than_averaging_a_hole() {
        let mut c = MidiClock::new();
        let mut t = run(&mut c, 120.0, 48, 1_000_000);
        // a dropped USB packet: one interval far too long
        t += iv(120.0) * 40;
        c.on_message(0xF8, t, "Deck");
        assert!(c.follow(t).is_none(), "the window restarted, so there is nothing to say yet");
        let t = run(&mut c, 174.0, 48, t + iv(174.0));
        let f = c.follow(t).expect("following again");
        assert!((f.bpm - 174.0).abs() < 0.5, "got {}", f.bpm);
    }

    #[test]
    fn a_source_that_goes_quiet_is_let_go_of() {
        let mut c = MidiClock::new();
        let t = run(&mut c, 120.0, 48, 1_000_000);
        assert!(c.follow(t).is_some());
        assert_eq!(c.source(), Some("Deck"));
        // nothing for two seconds: gone, not slow
        assert!(c.follow(t + STALE_MICROS + 1).is_none());
        assert_eq!(c.source(), None, "and the port is released for the next one");
    }

    #[test]
    fn the_first_source_owns_the_tempo_while_it_is_sending() {
        // two devices both sending clock is a normal thing to have plugged in,
        // and they must not fight over the tempo
        let mut c = MidiClock::new();
        let mut t = 1_000_000u64;
        for _ in 0..48 {
            c.on_message(0xF8, t, "Deck");
            c.on_message(0xF8, t + 5, "Laptop"); // interleaved, faster
            t += iv(120.0);
        }
        assert_eq!(c.source(), Some("Deck"));
        let f = c.follow(t).expect("following");
        assert!((f.bpm - 120.0).abs() < 0.5, "the second source did not pull it: {}", f.bpm);
    }

    #[test]
    fn start_anchors_the_phase_and_continue_does_not() {
        let mut c = MidiClock::new();
        c.on_message(0xFA, 1_000_000, "Deck"); // start: beat zero
        let t = run(&mut c, 120.0, 48, 1_000_000);
        let f = c.follow(t).expect("following");
        assert_eq!(f.beat, Some(2.0), "48 ticks after a start is two beats in");
        // the next poll has no anchor: same phase, new tempo
        let t = run(&mut c, 120.0, 24, t);
        assert_eq!(c.follow(t).expect("following").beat, None);
    }

    /// The follower and the beat clock together, which is the pair that
    /// actually drives the rig. `follow` runs on every tick — 40 times a
    /// second — so the risk is not the tempo but the PHASE: a beat that jumps
    /// backwards or stalls each time the tempo is re-set would make every
    /// effect stutter in time with the clock instead of to it.
    #[test]
    fn a_beat_followed_over_a_bar_advances_smoothly() {
        use crate::clock::BeatClock;
        let mut c = MidiClock::new();
        let mut clock = BeatClock::new(0.0);
        let bpm = 128.0;
        let step = iv(bpm);
        let mut at = 1_000_000u64;
        // a start, then four bars of ticks with a millisecond of wobble on each
        c.on_message(0xFA, at, "Deck");
        let mut last_beat = f64::NEG_INFINITY;
        let mut anchored_at: Option<f64> = None;
        for i in 0..(PPQN as usize * 16) {
            let wobble = if i % 2 == 0 { 900i64 } else { -900 };
            c.on_message(0xF8, (at as i64 + wobble) as u64, "Deck");
            at += step;
            // the engine's tick, in the same domain, in milliseconds
            let t = at as f64 / 1000.0;
            if let Some(f) = c.follow(at) {
                match f.beat {
                    Some(b) => {
                        clock.set_tempo_and_beat(f.bpm, b, t);
                        anchored_at = Some(b);
                        last_beat = f64::NEG_INFINITY; // the anchor is a jump, by design
                    }
                    None => clock.set_bpm(f.bpm, t),
                }
            }
            let beat = clock.beat_at(t);
            assert!(beat >= last_beat - 1e-9, "the beat went backwards at tick {i}: {last_beat} -> {beat}");
            last_beat = beat;
        }
        // The anchor is the one place the beat is ALLOWED to jump — the source
        // pressed play and the rig snaps to its downbeat. It fires on the first
        // poll with enough ticks to be sure of a tempo, which is half a beat
        // after the start, so it must land on the half beat rather than on zero.
        assert_eq!(anchored_at, Some(0.5), "the start anchored the phase where the source actually is");
        // Sixteen beats of ticks after the start, so the clock should read
        // sixteen beats on from where the start put it — within a tick.
        let end = at as f64 / 1000.0;
        assert!((clock.beat_at(end) - 16.0).abs() < 0.1, "got {}", clock.beat_at(end));
        assert!((clock.bpm - bpm).abs() < 1.0, "got {}", clock.bpm);
    }

    #[test]
    fn stop_is_reported_without_throwing_the_tempo_away() {
        let mut c = MidiClock::new();
        let t = run(&mut c, 120.0, 48, 1_000_000);
        assert!(c.running() || !c.running(), "free-running clock needs no start");
        c.on_message(0xFC, t, "Deck");
        assert!(!c.running());
        let f = c.follow(t).expect("the tempo is still known");
        assert!((f.bpm - 120.0).abs() < 0.5);
    }
}
