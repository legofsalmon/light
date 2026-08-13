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

    /// Change tempo without a phase jump.
    pub fn set_bpm(&mut self, bpm: f64, t: f64) {
        self.anchor_beat = self.beat_at(t);
        self.anchor_t = t;
        self.bpm = clamp(bpm, 20.0, 500.0);
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
