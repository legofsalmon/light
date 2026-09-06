//! What reaches the wire: whether anything does (the transmit gate), and
//! which frame it is (the freeze hold).
//!
//! Both live here because both answer the same question at the same moment,
//! and an operator asks them together: "is the rig following me, and if not,
//! why not."
//!
//! ## The transmit gate
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

use std::collections::HashMap;

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

/// Holds the frame the rig is showing while the show carries on underneath.
///
/// Freeze exists for the thing every operator does mid-set: opening a look to
/// change it, with the rig live. Every edit is live, so a half-built look is
/// on stage while it is being built. Frozen, the wire repeats the frame it was
/// already showing and the renderer keeps running — so the stage view, the
/// pads and the previz all follow the edit while the room does not.
///
/// It holds EVERYTHING, including the raw channel check tool and find-this-
/// light. Both are diagnostics and there is a case for letting them through,
/// but only one of them could be: the override pass is separable and identify
/// is baked into the render long before this. One diagnostic punching through
/// while the other silently does not is worse than a rule that is simply true,
/// and "frozen means the wire does not change" is a promise worth being able
/// to make. The DMX monitor shows the held frame for the same reason: it
/// reports what is leaving the app, and while frozen that is this.
///
/// Blackout and ALL STOP release it rather than being held by it — blackout
/// always wins, and a panic that a hold could swallow is not a panic.
///
/// Mirrors engine/output.ts, beside the gate.
#[derive(Debug, Default)]
pub struct FreezeHold {
    held: HashMap<String, [u8; 512]>,
}

impl FreezeHold {
    pub fn new() -> Self {
        Self::default()
    }

    /// Substitute the held frame while frozen. Call once per tick with the
    /// buffers this tick rendered; what comes back out is what should reach
    /// the wire and the monitor.
    ///
    /// Each universe latches on the first frozen tick it is present for, so a
    /// universe added mid-freeze holds from the moment it exists rather than
    /// going live on its own.
    pub fn apply(&mut self, frozen: bool, buffers: &mut HashMap<String, [u8; 512]>) {
        if !frozen {
            self.held.clear();
            return;
        }
        for (id, buf) in buffers.iter_mut() {
            match self.held.get(id) {
                Some(h) => *buf = *h,
                None => {
                    self.held.insert(id.clone(), *buf);
                }
            }
        }
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

#[cfg(test)]
mod freeze_tests {
    use super::*;

    fn frame(v: u8) -> HashMap<String, [u8; 512]> {
        HashMap::from([("u1".to_string(), [v; 512])])
    }

    #[test]
    fn not_frozen_passes_every_frame_through() {
        let mut f = FreezeHold::new();
        for v in [1u8, 2, 3] {
            let mut b = frame(v);
            f.apply(false, &mut b);
            assert_eq!(b["u1"][0], v);
        }
    }

    #[test]
    fn frozen_repeats_the_frame_it_latched() {
        let mut f = FreezeHold::new();
        let mut b = frame(7);
        f.apply(true, &mut b);
        assert_eq!(b["u1"][0], 7, "the first frozen tick is the one held");
        // the show carries on underneath and the wire does not
        for v in [9u8, 40, 255] {
            let mut b = frame(v);
            f.apply(true, &mut b);
            assert_eq!(b["u1"][0], 7);
        }
    }

    #[test]
    fn releasing_goes_live_again_and_forgets() {
        let mut f = FreezeHold::new();
        let mut b = frame(7);
        f.apply(true, &mut b);
        let mut b = frame(9);
        f.apply(false, &mut b);
        assert_eq!(b["u1"][0], 9, "released, this tick's frame goes out");
        // and a later freeze latches the NEW frame, not the old hold
        let mut b = frame(11);
        f.apply(true, &mut b);
        assert_eq!(b["u1"][0], 11);
    }

    #[test]
    fn a_universe_added_mid_freeze_holds_from_the_moment_it_exists() {
        // otherwise it would be the one thing on the rig still moving
        let mut f = FreezeHold::new();
        let mut b = frame(7);
        f.apply(true, &mut b);
        let mut two = frame(9);
        two.insert("u2".to_string(), [4u8; 512]);
        f.apply(true, &mut two);
        assert_eq!(two["u1"][0], 7, "the one already held keeps its frame");
        assert_eq!(two["u2"][0], 4, "the new one latches now");
        let mut three = frame(9);
        three.insert("u2".to_string(), [200u8; 512]);
        f.apply(true, &mut three);
        assert_eq!(three["u2"][0], 4, "and holds from then on");
    }

    #[test]
    fn a_universe_that_goes_away_does_not_come_back() {
        let mut f = FreezeHold::new();
        let mut two = frame(7);
        two.insert("u2".to_string(), [4u8; 512]);
        f.apply(true, &mut two);
        let mut one = frame(9);
        f.apply(true, &mut one);
        assert_eq!(one.len(), 1, "a deleted universe is not resurrected by the hold");
        assert_eq!(one["u1"][0], 7);
    }
}
