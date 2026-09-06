use crate::types::clamp;

/// Musical clock: continuous beat position from an anchor + BPM.
/// Times are engine-epoch milliseconds (f64), mirroring performance.now().
pub struct BeatClock {
    pub bpm: f64,
    anchor_t: f64,
    anchor_beat: f64,
    taps: Vec<f64>,
}

impl BeatClock {
    pub fn new(now: f64) -> Self {
        BeatClock { bpm: 120.0, anchor_t: now, anchor_beat: 0.0, taps: Vec::new() }
    }

    pub fn beat_at(&self, t: f64) -> f64 {
        self.anchor_beat + ((t - self.anchor_t) / 60000.0) * self.bpm
    }

    /// Change tempo without a phase jump. Non-finite input is rejected outright.
    pub fn set_bpm(&mut self, bpm: f64, t: f64) {
        if !bpm.is_finite() {
            return;
        }
        self.anchor_beat = self.beat_at(t);
        self.anchor_t = t;
        self.bpm = clamp(bpm, 20.0, 500.0);
    }

    /// Set tempo AND phase together.
    ///
    /// A follower knows both at once, and doing it as two calls leaves one
    /// tick where the beat is computed from the NEW tempo against the OLD
    /// anchor — a phase step every time the tempo moves, which on a MIDI clock
    /// is several times a second. Mirrors setTempoAndBeat in engine/clock.ts.
    pub fn set_tempo_and_beat(&mut self, bpm: f64, beat: f64, t: f64) {
        if !bpm.is_finite() || !beat.is_finite() {
            return;
        }
        self.bpm = clamp(bpm, 20.0, 500.0);
        self.anchor_beat = beat;
        self.anchor_t = t;
    }

    /// Snap the beat phase to a downbeat now (Resolume resync).
    pub fn resync(&mut self, t: f64) {
        self.anchor_beat = self.beat_at(t).ceil();
        self.anchor_t = t;
    }

    pub fn tap(&mut self, t: f64) {
        if let Some(&last) = self.taps.last() {
            if t - last > 2500.0 {
                self.taps.clear();
            }
        }
        self.taps.push(t);
        if self.taps.len() > 5 {
            self.taps.remove(0);
        }
        if self.taps.len() >= 2 {
            let iv = (self.taps[self.taps.len() - 1] - self.taps[0]) / (self.taps.len() - 1) as f64;
            self.bpm = clamp(60000.0 / iv, 20.0, 500.0);
        }
        // Every tap lands on a whole beat.
        self.anchor_beat = self.beat_at(t).round();
        self.anchor_t = t;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_tempo_change_on_its_own_does_not_move_the_beat() {
        // set_bpm is what the follower calls on every ordinary tick, several
        // times a second. If it stepped the phase the rig would stutter in
        // time with the clock rather than to it.
        let mut c = BeatClock::new(0.0);
        let before = c.beat_at(1234.0);
        c.set_bpm(174.0, 1234.0);
        assert!((c.beat_at(1234.0) - before).abs() < 1e-9);
        assert_eq!(c.bpm, 174.0);
    }

    #[test]
    fn a_transport_start_lands_the_tempo_and_the_downbeat_together() {
        let mut c = BeatClock::new(0.0);
        c.set_bpm(120.0, 0.0);
        c.set_tempo_and_beat(128.0, 4.0, 5000.0);
        assert_eq!(c.bpm, 128.0);
        assert!((c.beat_at(5000.0) - 4.0).abs() < 1e-9, "the beat is where it was told");
        // and it runs on from there at the new tempo: one beat = 60000/128 ms
        assert!((c.beat_at(5000.0 + 60000.0 / 128.0) - 5.0).abs() < 1e-9);
    }

    #[test]
    fn a_tempo_that_is_not_a_tempo_is_refused_rather_than_stored() {
        // A follower divides by an interval, so a zero-length window would hand
        // this an infinity. Keeping the last good tempo is the only safe answer.
        let mut c = BeatClock::new(0.0);
        c.set_bpm(128.0, 0.0);
        c.set_tempo_and_beat(f64::INFINITY, 0.0, 1000.0);
        c.set_tempo_and_beat(f64::NAN, 0.0, 1000.0);
        c.set_tempo_and_beat(120.0, f64::NAN, 1000.0);
        c.set_bpm(f64::NAN, 1000.0);
        assert_eq!(c.bpm, 128.0);
        assert!(c.beat_at(1000.0).is_finite());
        // and the clock's own floor and ceiling still apply
        c.set_tempo_and_beat(9999.0, 0.0, 1000.0);
        assert_eq!(c.bpm, 500.0);
        c.set_tempo_and_beat(1.0, 0.0, 1000.0);
        assert_eq!(c.bpm, 20.0);
    }
}
