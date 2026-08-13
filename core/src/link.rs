//! Ableton Link tempo sync — native engine only. Link is a tempo *source*
//! like OSC: it feeds the beat clock, it never touches the DMX math, so the
//! Node reference engine stays byte-identical without it.
//!
//! v1 scope: follow the session tempo while enabled, push locally-set tempo
//! (tap, setBpm, OSC) back into the session, report peer count to the UI.

use rusty_link::{AblLink, SessionState};

pub struct LinkSync {
    link: AblLink,
    session: SessionState,
    enabled: bool,
}

impl LinkSync {
    pub fn new(bpm: f64) -> Self {
        LinkSync {
            link: AblLink::new(bpm),
            session: SessionState::new(),
            enabled: false,
        }
    }

    pub fn set_enabled(&mut self, on: bool) {
        self.enabled = on;
        self.link.enable(on);
    }

    pub fn enabled(&self) -> bool {
        self.enabled
    }

    pub fn peers(&self) -> u64 {
        self.link.num_peers()
    }

    /// Poll the session tempo; `Some(bpm)` when it moved away from ours.
    /// Clamped to the same 20–500 range the OSC tempo input enforces.
    pub fn poll_tempo(&mut self, current_bpm: f64) -> Option<f64> {
        if !self.enabled {
            return None;
        }
        self.link.capture_app_session_state(&mut self.session);
        let t = self.session.tempo();
        if t.is_finite() && (20.0..=500.0).contains(&t) && (t - current_bpm).abs() > 0.01 {
            Some(t)
        } else {
            None
        }
    }

    /// Push a locally-set tempo (tap / setBpm / OSC) into the session so the
    /// rest of the Link peers follow us.
    pub fn push_tempo(&mut self, bpm: f64) {
        if !self.enabled {
            return;
        }
        self.link.capture_app_session_state(&mut self.session);
        self.session.set_tempo(bpm, self.link.clock_micros());
        self.link.commit_app_session_state(&self.session);
    }
}
