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
}
