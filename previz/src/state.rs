use bevy::prelude::*;
use std::collections::HashMap;

use crate::protocol::{ProjectLite, SnapLite};

/// Per-head render-rate smoothing (snapshots arrive at 20 fps; we render at 60+).
#[derive(Default, Clone)]
pub struct Smoothed {
    pub r: f32,
    pub g: f32,
    pub b: f32,
    pub i: f32,
    pub spin: f32,
    /// What was last pushed to this head's cone material and glow material.
    ///
    /// Touching an `Assets<StandardMaterial>` entry marks it changed, and a
    /// changed material is re-extracted, re-uploaded and — since bindless
    /// landed — can pull its whole slab with it. Doing that for every cone and
    /// every glow on every frame is the single most expensive thing this
    /// renderer does, and almost all of it is writing values that did not
    /// change: a rig is mostly still, most of the time, even mid-cue.
    pub sent: Option<Sent>,
}

/// The values a head last pushed to the GPU. Compared with an epsilon rather
/// than exactly — these come off a per-frame exponential smoother, so they
/// never settle to a bit-identical value and an `==` check would never hit.
#[derive(Clone, Copy, PartialEq)]
pub struct Sent {
    pub r: f32,
    pub g: f32,
    pub b: f32,
    /// intensity after the strobe gate
    pub e: f32,
}

impl Sent {
    /// 1/512 of full scale: finer than an 8-bit channel, so nothing visible is
    /// ever skipped, and coarse enough that a settled head stops writing.
    const EPS: f32 = 0.002;

    pub fn differs(&self, o: &Sent) -> bool {
        (self.r - o.r).abs() > Self::EPS
            || (self.g - o.g).abs() > Self::EPS
            || (self.b - o.b).abs() > Self::EPS
            || (self.e - o.e).abs() > Self::EPS
    }
}

#[derive(Resource, Default)]
pub struct Live {
    pub project: Option<ProjectLite>,
    /// bumped when the fixture list actually changes (not on every project echo)
    pub project_rev: u64,
    pub built_rev: u64,
    pub fixture_sig: String,
    pub snap: Option<SnapLite>,
    pub smoothed: HashMap<(String, usize), Smoothed>,
    pub connected: bool,
    /// How big the rig actually is, published by the scene rebuild so the
    /// camera can frame it. The demo scene's fixed limits (22 m orbit, 5 m
    /// target height) cannot frame a 37 m arena plot hung at 10 m — the room,
    /// the beams and the camera all have to learn the same bounds.
    pub rig_extent: Option<RigExtent>,
}

#[derive(Clone, Copy, Debug)]
pub struct RigExtent {
    /// diagonal of the rig's bounding box, in metres
    pub diag: f32,
    /// highest thing in the rig, in metres
    pub height: f32,
    /// Where the rig actually is on the floor. An MVR does not have to be
    /// centred on the origin, and framing a plot that sits ten metres stage
    /// left by pointing at 0,0 is the same miss as not framing it at all.
    pub center: Vec3,
}
