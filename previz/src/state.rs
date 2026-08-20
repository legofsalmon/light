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
}
