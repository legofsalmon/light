//! Whether the operating system is actually taking our packets.
//!
//! A `send_to` that fails is silent on the wire and, until now, silent in the
//! app: the output dot read *live* for a whole evening while the kernel refused
//! every frame (a Mac that had updated LIGHT in place and needed the Local
//! Network permission re-evaluated by a relaunch). Nothing reached the rig and
//! nothing said so. This remembers the most recent refusal for one second, so a
//! single failing universe keeps it visible at 40 frames a second — a success
//! from the next universe does not erase it — and it retires itself a second
//! after the last refusal. A sender with no socket at all is a permanent
//! refusal.
//!
//! Twin of `engine/sendHealth.ts`; both carry the same tests.

use std::time::{Duration, Instant};

/// How long a refusal stays reported after the last failed send. Long enough
/// that one bad universe among good ones holds the dot, short enough that a
/// fix shows within a second.
pub const HOLD: Duration = Duration::from_secs(1);

#[derive(Default)]
pub struct SendHealth {
    /// the message, and when it was noted — `None` when permanent (no socket)
    last: Option<(String, Option<Instant>)>,
}

impl SendHealth {
    /// A send the OS refused, with the destination and its error.
    pub fn note_err(&mut self, msg: String, now: Instant) {
        self.last = Some((msg, Some(now)));
    }

    /// No socket could be made: every send is refused until further notice.
    pub fn note_permanent(&mut self, msg: String) {
        self.last = Some((msg, None));
    }

    /// The refusal to report right now, if any.
    pub fn current(&self, now: Instant) -> Option<&str> {
        match &self.last {
            Some((msg, None)) => Some(msg),
            Some((msg, Some(at))) if now.duration_since(*at) < HOLD => Some(msg),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_refused_send_is_reported_for_a_second_then_forgotten() {
        let t0 = Instant::now();
        let mut h = SendHealth::default();
        assert_eq!(h.current(t0), None, "nothing has failed yet");
        h.note_err("192.168.200.107: No route to host (os error 65)".into(), t0);
        assert_eq!(
            h.current(t0 + Duration::from_millis(900)),
            Some("192.168.200.107: No route to host (os error 65)")
        );
        assert_eq!(h.current(t0 + Duration::from_millis(1100)), None, "silence is not failure");
    }

    #[test]
    fn one_failing_universe_among_good_ones_keeps_it_visible() {
        // 40 frames a second, one universe refused and the next accepted: the
        // report must hold, not flicker with whichever send came last
        let t0 = Instant::now();
        let mut h = SendHealth::default();
        for i in 0..80u64 {
            let now = t0 + Duration::from_millis(i * 25);
            if i % 2 == 1 {
                h.note_err("255.255.255.255: No route to host".into(), now);
            }
            if i > 0 {
                assert!(h.current(now).is_some(), "frame {i}: a refusal 25 ms ago is still a refusal");
            }
        }
        // and a second after the last refusal, with only successes since, it is gone
        assert_eq!(h.current(t0 + Duration::from_millis(79 * 25 + 1001)), None);
    }

    #[test]
    fn no_socket_is_a_refusal_that_never_retires() {
        let t0 = Instant::now();
        let mut h = SendHealth::default();
        h.note_permanent("no socket: Address family not supported".into());
        assert_eq!(h.current(t0 + Duration::from_secs(60)), Some("no socket: Address family not supported"));
    }
}
