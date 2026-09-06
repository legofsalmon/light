//! The transmit gate: whether rendered frames actually reach the wire.
//!
//! Distinct from blackout, and deliberately so. Blackout is a SHOW state — the
//! rig is dark because the engine is transmitting frames of zeros, and it is
//! the transmitting that holds it dark. This is a TRANSPORT state: offline,
//! nothing leaves the machine at all, so LIGHT can sit on a working network
//! next to whatever else is patched there without fighting it for the rig.
//!
//! It starts OFF on every boot and is never saved. A show file that arrived by
//! email, the demo opened to look around, a laptop woken in a venue where
//! someone else is mid-patch — none of them may put DMX on a network until an
//! operator says so. That is the review's B1 blocker stated as a rule rather
//! than as a property of whichever templates happened to ship with outputs
//! off, and it is the same reasoning that keeps submaster positions
//! runtime-only.
//!
//! Going offline sends a few frames of zeros before falling silent. Art-Net
//! and sACN nodes hold the last frame they received, so simply stopping would
//! leave the rig lit at whatever it was showing — the exact opposite of what
//! "offline" looks like it should do, and the sort of thing you discover with
//! a room full of people in it. UDP drops frames, so it is sent more than once.
//!
//! Mirrors engine/output.ts. The two must decide identically.

/// Frames of zeros sent on the way out, so a node that drops one still goes
/// dark. Three at 40 Hz is 75 ms.
pub const GO_DARK_FRAMES: u8 = 3;

/// What a tick puts on the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Wire {
    /// the rendered frame
    Show,
    /// zeros — on the way offline, so the rig does not hold its last look
    Dark,
    /// nothing at all
    Silent,
}

#[derive(Debug, Default)]
pub struct OutputGate {
    live: bool,
    go_dark: u8,
}

impl OutputGate {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn is_live(&self) -> bool {
        self.live
    }

    /// Follow the engine state's gate. Going live cancels any go-dark frames
    /// still pending: the show is about to be sent anyway, and a stray zero
    /// frame after "go live" is a visible flash.
    pub fn set(&mut self, live: bool) {
        if live == self.live {
            return;
        }
        self.live = live;
        self.go_dark = if live { 0 } else { GO_DARK_FRAMES };
    }

    /// What this tick sends. Call once per tick, before the per-universe loop —
    /// it consumes one go-dark frame.
    pub fn tick(&mut self) -> Wire {
        if self.live {
            return Wire::Show;
        }
        if self.go_dark > 0 {
            self.go_dark -= 1;
            return Wire::Dark;
        }
        Wire::Silent
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn boots_silent_and_stays_silent() {
        let mut g = OutputGate::new();
        assert!(!g.is_live(), "a fresh engine is offline");
        // and never emits the go-dark frames it has nothing to darken
        for _ in 0..10 {
            assert_eq!(g.tick(), Wire::Silent);
        }
    }

    #[test]
    fn live_sends_the_show() {
        let mut g = OutputGate::new();
        g.set(true);
        assert!(g.is_live());
        for _ in 0..10 {
            assert_eq!(g.tick(), Wire::Show);
        }
    }

    #[test]
    fn going_offline_darkens_the_rig_before_falling_silent() {
        let mut g = OutputGate::new();
        g.set(true);
        assert_eq!(g.tick(), Wire::Show);
        g.set(false);
        for i in 0..GO_DARK_FRAMES {
            assert_eq!(g.tick(), Wire::Dark, "go-dark frame {i}");
        }
        for _ in 0..10 {
            assert_eq!(g.tick(), Wire::Silent, "then nothing, for good");
        }
    }

    #[test]
    fn going_live_again_cancels_the_go_dark_frames() {
        // Otherwise "offline, no wait, live" flashes the rig black between the
        // click and the next frame.
        let mut g = OutputGate::new();
        g.set(true);
        g.set(false);
        assert_eq!(g.tick(), Wire::Dark);
        g.set(true);
        for _ in 0..5 {
            assert_eq!(g.tick(), Wire::Show);
        }
    }

    #[test]
    fn setting_the_state_it_already_has_changes_nothing() {
        // the engine calls set() every tick from the engine state, so this is
        // the common path, not an edge case
        let mut g = OutputGate::new();
        g.set(true);
        for _ in 0..3 {
            g.set(true);
            assert_eq!(g.tick(), Wire::Show);
        }
        g.set(false);
        g.set(false);
        g.set(false);
        assert_eq!(g.tick(), Wire::Dark, "the go-dark run is armed once, not re-armed");
        assert_eq!(g.tick(), Wire::Dark);
        assert_eq!(g.tick(), Wire::Dark);
        assert_eq!(g.tick(), Wire::Silent);
    }
}
