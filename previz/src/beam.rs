//! The volumetric beam material.
//!
//! See `beam.wgsl` for the physics. This file is the plumbing: the uniform, the
//! render state, and the proxy hull the shader integrates inside.

use bevy::asset::{embedded_asset, RenderAssetUsages};
use bevy::mesh::{Indices, Mesh, MeshVertexBufferLayoutRef, PrimitiveTopology};
use bevy::pbr::{MaterialPipeline, MaterialPipelineKey};
use bevy::prelude::*;
use bevy::render::render_resource::{
    AsBindGroup, CompareFunction, Face, RenderPipelineDescriptor, ShaderType,
    SpecializedMeshPipelineError,
};
use bevy::shader::ShaderRef;

/// Everything about one beam that is not already in its transform.
///
/// Deliberately small. Every field here is re-uploaded whenever the material is
/// touched, and there are ~150 of these on an arena rig; the apex and axis are
/// pointedly NOT here (the shader reads them from the instance transform, which
/// is a frame fresher — see the note in the WGSL).
#[derive(Clone, Copy, ShaderType, Debug)]
pub struct BeamUniform {
    /// Linear RGB with the intensity, already strobe-gated, in `w`.
    pub color: Vec4,
    pub axial: f32,
    pub one_minus_cos_b: f32,
    pub cos_shoulder_in: f32,
    pub cos_shoulder_out: f32,
    pub sigma_t: f32,
    pub sigma_s: f32,
    pub g: f32,
    pub r0_sq: f32,
    pub length_m: f32,
    /// Operator trim on shaft brightness (Quality::beam_gain).
    pub gain: f32,
    pub _pad: Vec2,
}

impl Default for BeamUniform {
    fn default() -> Self {
        BeamUniform {
            color: Vec4::ZERO,
            axial: 0.0,
            one_minus_cos_b: 0.02,
            cos_shoulder_in: 0.9,
            cos_shoulder_out: 0.86,
            sigma_t: 0.05,
            sigma_s: 0.04,
            g: 0.15,
            r0_sq: 0.0016,
            length_m: 8.0,
            gain: 1.0,
            _pad: Vec2::ZERO,
        }
    }
}

#[derive(Asset, TypePath, AsBindGroup, Debug, Clone)]
pub struct BeamMaterial {
    #[uniform(0)]
    pub beam: BeamUniform,
}

impl Material for BeamMaterial {
    fn fragment_shader() -> ShaderRef {
        "embedded://light_previz/beam.wgsl".into()
    }

    fn alpha_mode(&self) -> AlphaMode {
        // Puts it in the transparent phase with premultiplied-alpha additive
        // blending and depth writes already off.
        AlphaMode::Add
    }

    fn specialize(
        _pipeline: &MaterialPipeline,
        descriptor: &mut RenderPipelineDescriptor,
        _layout: &MeshVertexBufferLayoutRef,
        _key: MaterialPipelineKey<Self>,
    ) -> Result<(), SpecializedMeshPipelineError> {
        // BACK faces only, and this is not a stylistic choice. The hull is a
        // closed solid: drawn double-sided, every ray would run the whole
        // integral twice and add both results, so every beam would be exactly
        // twice as bright and twice as expensive. Back faces also survive the
        // camera being inside the hull and the near plane slicing the front
        // ones off, which front-face rendering does not.
        descriptor.primitive.cull_mode = Some(Face::Front);

        if let Some(ds) = descriptor.depth_stencil.as_mut() {
            // Depth test OFF, not just depth-write off.
            //
            // With back faces, the depth test compares the hull's FAR surface
            // against the opaque buffer — so a beam crossing in front of a
            // riser but terminating behind it is rejected in its entirety, and
            // the visible near half vanishes. Occlusion is done properly in the
            // shader by clamping the integral against the depth prepass.
            ds.depth_compare = Some(CompareFunction::Always);
            ds.depth_write_enabled = Some(false);
        }
        Ok(())
    }
}

pub struct BeamMaterialPlugin;

impl Plugin for BeamMaterialPlugin {
    fn build(&self, app: &mut App) {
        embedded_asset!(app, "beam.wgsl");
        app.add_plugins(MaterialPlugin::<BeamMaterial>::default());
    }
}

/// A closed unit cone: apex at the origin, opening along -Z to radius 1 at
/// z = -1, WITH a base cap.
///
/// The cap is load bearing. The shader rasterizes back faces to find the pixels
/// a beam might cover; an open lateral surface gives no fragment at all for a
/// ray that leaves through the base disc, so looking up into a shaft would
/// punch a hole straight through it.
pub fn unit_cone_hull() -> Mesh {
    const SEGS: usize = 32;

    let mut positions: Vec<[f32; 3]> = Vec::with_capacity(SEGS * 2 + 2);
    let mut normals: Vec<[f32; 3]> = Vec::with_capacity(SEGS * 2 + 2);
    let mut indices: Vec<u32> = Vec::with_capacity(SEGS * 6);

    // 0: apex
    positions.push([0.0, 0.0, 0.0]);
    normals.push([0.0, 0.0, 1.0]);
    // 1..=SEGS: rim, for the lateral surface
    for i in 0..SEGS {
        let a = i as f32 / SEGS as f32 * std::f32::consts::TAU;
        positions.push([a.cos(), a.sin(), -1.0]);
        normals.push([a.cos(), a.sin(), 0.0]);
    }
    // SEGS+1: base centre, then SEGS+2.. : the rim again for the cap, so the
    // cap can carry its own normal without splitting the lateral shading.
    let base_centre = positions.len() as u32;
    positions.push([0.0, 0.0, -1.0]);
    normals.push([0.0, 0.0, -1.0]);
    let cap_start = positions.len() as u32;
    for i in 0..SEGS {
        let a = i as f32 / SEGS as f32 * std::f32::consts::TAU;
        positions.push([a.cos(), a.sin(), -1.0]);
        normals.push([0.0, 0.0, -1.0]);
    }

    // Wound so the geometric normal points OUTWARD, which makes the surface
    // nearest the camera the front face and the far surface the back face.
    // That is the way round the material needs: it culls front faces, so what
    // survives is the far surface, which is also the one that still exists when
    // the camera is inside the hull and the near plane has sliced the near
    // surface away. Getting this backwards draws the near surface instead and
    // the beam vanishes the moment you fly into it.
    for i in 0..SEGS as u32 {
        let n = (i + 1) % SEGS as u32;
        indices.extend_from_slice(&[0, 1 + i, 1 + n]);
    }
    // Base cap, outward normal along -Z, away from the apex.
    for i in 0..SEGS as u32 {
        let n = (i + 1) % SEGS as u32;
        indices.extend_from_slice(&[base_centre, cap_start + n, cap_start + i]);
    }

    Mesh::new(PrimitiveTopology::TriangleList, RenderAssetUsages::RENDER_WORLD)
        .with_inserted_attribute(Mesh::ATTRIBUTE_POSITION, positions)
        .with_inserted_attribute(Mesh::ATTRIBUTE_NORMAL, normals)
        .with_inserted_indices(Indices::U32(indices))
}

/// Axial intensity for a beam, in the same candela convention the rest of the
/// frame is lit in.
///
/// The physically honest figure would be `Phi / (2*pi*(1 - cos theta_f)*f_bar)`
/// — the flux actually concentrated into the cone. That is NOT what this
/// returns, and the reason is worth writing down.
///
/// Bevy converts a SpotLight's lumens to candela as `intensity / 4*pi` whatever
/// its cone angle: it never concentrates. So every surface in the frame is lit
/// as though the fixture radiated in all directions. A beam computed correctly
/// therefore sits about two hundred times above the surfaces it lands on, and
/// the picture is a white sheet with a stage somewhere underneath it. Measured:
/// a 16,000 lm head at 7.5 degrees came out 40x over.
///
/// So the shaft uses the same base as the pool, `Phi / 4*pi`, and takes only
/// the RELATIVE concentration from zoom — identical to `flux_gain` on the
/// spotlight side, which is what keeps the shaft and the pool it lands in
/// agreeing about how bright the fixture just got. Absolute photometry would
/// need bevy's own spot path fixed first, and that is a different argument.
/// How much of the physical cone concentration the shaft is drawn with.
///
/// Measured, not chosen — and provisional, for a reason worth stating.
///
/// The physically correct factor for a 16,000 lm head at its profile angle is
/// about 200x. At 200x the shafts rendered roughly 40x over: a white sheet with
/// a stage somewhere underneath it. Calibrated down against the demo show's
/// BUSIEST cue rather than a flattering one, which lands here.
///
/// Two separate fudges are stacked in this number and both have a known cure.
///
/// The first is bevy's: its spot path converts lumens to candela as Phi/4*pi
/// whatever the cone angle, so every SURFACE in the frame is lit as though the
/// fixture radiated in all directions. A shaft computed honestly sits two
/// hundred times above the pool it lands in. This constant is what reconciles
/// them, and it becomes 1.0 the day that path concentrates by cone angle.
///
/// The second is ours: there is no exposure adaptation here. Additive shafts
/// stack without bound, so a cue with 105 lit fixtures needs a different
/// constant from one with 48, and no single number serves both — the web previz
/// hit exactly this and solved it by metering the frame. Bevy 0.19 ships a
/// histogram `AutoExposure` that would do the same here, at which point this
/// constant stops having to be a compromise between cue sizes and can go back
/// to being about the fixture.
const SHAFT_CONCENTRATION: f32 = 8.0;

pub fn axial_intensity(lumens: f32, field_half_rad: f32, base_field_half_rad: f32) -> f32 {
    let cd = lumens / (4.0 * std::f32::consts::PI) * SHAFT_CONCENTRATION;
    let now = (1.0 - field_half_rad.cos()).max(1e-5);
    let base = (1.0 - base_field_half_rad.cos()).max(1e-5);
    cd * (base / now).clamp(0.05, 64.0)
}
