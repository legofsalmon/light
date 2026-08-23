//! Render the beam shafts at half (or quarter) resolution and composite them
//! back into the full-res HDR target.
//!
//! WHY. Measured on the 129-fixture demo rig at its busiest cue, the shafts are
//! 11.7 ms of a 46.7 ms frame, and the cost is fill rate: the proxy hull covers
//! far more screen than the vertex-alpha shell it replaced, ~150 of them
//! overlap, and every covered pixel runs a 16-step march. Step count is already
//! tuned. Resolution is the remaining lever, and a beam is the ideal thing to
//! under-sample — it is smooth everywhere except at the silhouette of whatever
//! it lands on, and that silhouette comes from the depth clamp rather than from
//! the geometry.
//!
//! HOW. There are no render-graph nodes in bevy 0.19: `Core3d` is an ECS
//! schedule and a "pass" is a system taking `RenderContext`. So bevy's own
//! `main_transparent_pass_3d` is removed from that schedule and replaced with
//! one that renders the same `Transparent3d` phase into a half-res texture,
//! followed by an additive fullscreen composite.
//!
//! Retargeting the whole transparent phase is safe HERE and would not be
//! everywhere: this app's transparent phase contains only beams. Every
//! `StandardMaterial` in `scene.rs` leaves `alpha_mode` at its `Opaque`
//! default, and `BeamMaterial` is the one thing returning `AlphaMode::Add`.
//! `assert_transparent_is_beams_only` keeps that true.
//!
//! WHAT WAS REJECTED. A second `Camera3d` drawing the beams to an image target
//! is the obvious approach and cannot work: `beam.wgsl` clamps its integral
//! against the main view's depth prepass, and a second camera gets its own —
//! empty, because no opaque geometry is on its layer. Beams would cut straight
//! through the risers and the band. Regenerating that depth means a second
//! prepass and a second opaque pass over the whole stage, which costs more than
//! the shafts do.

use bevy::camera::MainPassResolutionOverride;
use bevy::core_pipeline::core_3d::{main_opaque_pass_3d, main_transparent_pass_3d, Transparent3d};
use bevy::core_pipeline::{Core3d, Core3dSystems, FullscreenShader};
use bevy::ecs::schedule::{ScheduleCleanupPolicy, Schedules};
use bevy::prelude::*;
use bevy::render::camera::ExtractedCamera;
use bevy::render::render_phase::ViewSortedRenderPhases;
use bevy::material::descriptor::BindGroupLayoutDescriptor;
use bevy::render::render_resource::binding_types::{sampler, texture_2d};
use bevy::render::render_resource::*;
use bevy::render::renderer::{RenderContext, RenderDevice, ViewQuery};
use bevy::render::texture::{CachedTexture, TextureCache};
use bevy::render::view::{ExtractedView, ViewTarget};
use bevy::render::{Render, RenderApp, RenderStartup, RenderSystems};
use bevy::shader::Shader;

/// Divisor on the beam pass's resolution. 1 leaves bevy's own transparent pass
/// alone entirely, so it is a real fallback rather than a differently-shaped
/// code path.
///
/// Inserted straight into the render world rather than extracted: it is fixed
/// at startup, and `swap_transparent_pass` runs in `RenderStartup`, which is
/// before the first extract — reading an extracted copy there panics.
#[derive(Resource, Clone, Copy)]
pub struct BeamScale(pub u32);

/// The half-res attachments for one view.
#[derive(Component)]
struct BeamHalfRes {
    color: CachedTexture,
    /// Never read and never written — the beam pipeline carries a depth-stencil
    /// state (depth test Always, no write) and wgpu requires the pass to match
    /// it. Allocating a throwaway is cheaper than specialising the pipeline
    /// differently for the two paths.
    depth: CachedTexture,
    size: UVec2,
}

#[derive(Resource)]
struct BeamComposite {
    pipeline: CachedRenderPipelineId,
    layout: BindGroupLayoutDescriptor,
    sampler: Sampler,
}

pub struct BeamHalfResPlugin {
    pub scale: u32,
}

impl Plugin for BeamHalfResPlugin {
    fn build(&self, app: &mut App) {
        bevy::asset::embedded_asset!(app, "beam_composite.wgsl");

        let Some(render_app) = app.get_sub_app_mut(RenderApp) else { return };
        render_app
            .insert_resource(BeamScale(self.scale))
            .add_systems(RenderStartup, (init_composite, swap_transparent_pass))
            .add_systems(
                Render,
                prepare_beam_targets.in_set(RenderSystems::PrepareResources),
            )
            .add_systems(
                Core3d,
                (
                    beam_pass_half_res
                        .in_set(Core3dSystems::MainPass)
                        .after(main_opaque_pass_3d),
                    // In MainPass, after the beam pass — NOT merely "before
                    // EarlyPostProcess". Volumetric fog registers itself as
                    // `.after(MainPass).before(EarlyPostProcess)`, so anything
                    // expressed with the same bounds is unordered against it,
                    // and the beams must be in the target before the fog veils
                    // them. Being inside MainPass puts a hard edge there.
                    composite_beams
                        .in_set(Core3dSystems::MainPass)
                        .after(beam_pass_half_res),
                ),
            );
    }
}

/// Retire bevy's full-res transparent pass, unless we are running at scale 1.
///
/// `RemoveSystemsOnly` keeps the set's transitive ordering edges, so
/// `main_opaque_pass_3d` still runs before whatever came after the pass we
/// removed. Logged rather than asserted: `RenderStartup` is documented as
/// possibly running more than once (a new `RenderDevice` re-runs it), and the
/// second call legitimately finds nothing to remove.
fn swap_transparent_pass(world: &mut World) {
    if world.resource::<BeamScale>().0 <= 1 {
        return;
    }
    // Take the ONE schedule out rather than holding the whole `Schedules`
    // resource across the call. `Schedule::remove_systems_in_set` initialises
    // the graph if it is dirty, initialising inserts resources, and doing that
    // inside a `resource_scope` trips a debug assertion — "Resource was
    // inserted during a call to World::resource_scope".
    let Some(mut schedule) = world.resource_mut::<Schedules>().remove(Core3d) else {
        warn!("[previz] half-res beams: no Core3d schedule to edit — beams will draw twice");
        return;
    };
    let result = schedule.remove_systems_in_set(
        main_transparent_pass_3d,
        world,
        // Keeps the set's transitive ordering edges, so whatever ran after
        // bevy's transparent pass still runs after the opaque one.
        ScheduleCleanupPolicy::RemoveSystemsOnly,
    );
    world.resource_mut::<Schedules>().insert(schedule);

    match result {
        // Zero is the expected answer the second time around: RenderStartup is
        // documented as possibly running again when a new RenderDevice is
        // acquired, and the pass is already gone by then.
        Ok(n) => info!("[previz] half-res beams on; removed {n} full-res transparent pass(es)"),
        Err(e) => warn!(
            "[previz] half-res beams: could not remove the full-res transparent pass ({e:?}) — \
             beams will draw twice, once at each resolution"
        ),
    }
}

fn init_composite(
    mut commands: Commands,
    device: Res<RenderDevice>,
    asset_server: Res<AssetServer>,
    fullscreen: Res<FullscreenShader>,
    pipeline_cache: Res<PipelineCache>,
) {
    // 0.19 pipelines take a bind-group layout DESCRIPTOR; the cache turns it
    // into the real layout when the bind group is built.
    let layout = BindGroupLayoutDescriptor::new(
        "beam_composite_layout",
        &BindGroupLayoutEntries::sequential(
            ShaderStages::FRAGMENT,
            (
                texture_2d(TextureSampleType::Float { filterable: true }),
                sampler(SamplerBindingType::Filtering),
            ),
        ),
    );
    // Bilinear. The classic objection is halos where a beam meets geometry, but
    // the silhouette here comes from the shader's own depth clamp rather than
    // from the hull, so an upsampled edge lands where the light stops rather
    // than smearing across an object's rim.
    let sampler = device.create_sampler(&SamplerDescriptor {
        label: Some("beam_composite_sampler"),
        mag_filter: FilterMode::Linear,
        min_filter: FilterMode::Linear,
        ..default()
    });
    let shader: Handle<Shader> = asset_server.load("embedded://light_previz/beam_composite.wgsl");

    let pipeline = pipeline_cache.queue_render_pipeline(RenderPipelineDescriptor {
        label: Some("beam_composite".into()),
        layout: vec![layout.clone()],
        vertex: fullscreen.to_vertex_state(),
        fragment: Some(FragmentState {
            shader,
            targets: vec![Some(ColorTargetState {
                format: TextureFormat::Rgba16Float,
                blend: Some(BlendState {
                    color: BlendComponent {
                        src_factor: BlendFactor::One,
                        dst_factor: BlendFactor::One,
                        operation: BlendOperation::Add,
                    },
                    // Leave the target's alpha exactly as it was. The beams are
                    // premultiplied-additive and write a = 0, so REPLACE here
                    // would stamp zero over whatever the opaque pass left.
                    alpha: BlendComponent {
                        src_factor: BlendFactor::Zero,
                        dst_factor: BlendFactor::One,
                        operation: BlendOperation::Add,
                    },
                }),
                write_mask: ColorWrites::ALL,
            })],
            ..default()
        }),
        ..default()
    });

    commands.insert_resource(BeamComposite { pipeline, layout, sampler });
}

fn prepare_beam_targets(
    mut commands: Commands,
    mut cache: ResMut<TextureCache>,
    device: Res<RenderDevice>,
    scale: Res<BeamScale>,
    views: Query<(Entity, &ExtractedCamera), With<ExtractedView>>,
) {
    let s = scale.0.max(1);
    for (entity, camera) in &views {
        // Insert-or-remove rather than `continue`: render-world camera entities
        // are retained between frames, so bailing out would leave last frame's
        // component pointing at a CachedTexture the cache may already have
        // handed to somebody else.
        let Some(full) = camera.physical_target_size.filter(|_| s > 1) else {
            commands.entity(entity).remove::<BeamHalfRes>();
            continue;
        };
        let size = (full / s).max(UVec2::ONE);
        let extent = Extent3d { width: size.x, height: size.y, depth_or_array_layers: 1 };
        let color = cache.get(
            &device,
            TextureDescriptor {
                label: Some("beam_half_res_color"),
                size: extent,
                mip_level_count: 1,
                sample_count: 1,
                dimension: TextureDimension::D2,
                format: TextureFormat::Rgba16Float,
                usage: TextureUsages::RENDER_ATTACHMENT | TextureUsages::TEXTURE_BINDING,
                view_formats: &[],
            },
        );
        let depth = cache.get(
            &device,
            TextureDescriptor {
                label: Some("beam_half_res_depth"),
                size: extent,
                mip_level_count: 1,
                sample_count: 1,
                dimension: TextureDimension::D2,
                format: TextureFormat::Depth32Float,
                usage: TextureUsages::RENDER_ATTACHMENT,
                view_formats: &[],
            },
        );
        commands.entity(entity).insert(BeamHalfRes { color, depth, size });
    }
}

fn beam_pass_half_res(
    world: &World,
    view: ViewQuery<(
        &ExtractedCamera,
        &ExtractedView,
        &BeamHalfRes,
        Option<&MainPassResolutionOverride>,
    )>,
    phases: Res<ViewSortedRenderPhases<Transparent3d>>,
    mut ctx: RenderContext,
) {
    let view_entity = view.entity();
    let (_camera, extracted_view, half, _resolution_override) = view.into_inner();
    let Some(phase) = phases.get(&extracted_view.retained_view_entity) else { return };
    if phase.items.is_empty() {
        return;
    }

    let mut pass = ctx.begin_tracked_render_pass(RenderPassDescriptor {
        label: Some("beam_pass_half_res"),
        color_attachments: &[Some(RenderPassColorAttachment {
            view: &half.color.default_view,
            depth_slice: None,
            resolve_target: None,
            ops: Operations { load: LoadOp::Clear(Default::default()), store: StoreOp::Store },
        })],
        depth_stencil_attachment: Some(RenderPassDepthStencilAttachment {
            view: &half.depth.default_view,
            depth_ops: Some(Operations { load: LoadOp::Clear(0.0), store: StoreOp::Discard }),
            stencil_ops: None,
        }),
        timestamp_writes: None,
        occlusion_query_set: None,
        multiview_mask: None,
    });
    // No `set_camera_viewport`: the attachment IS the reduced viewport, and the
    // clip-space transform is resolution independent.
    if let Err(err) = phase.render(&mut pass, world, view_entity) {
        error!("[previz] half-res beam pass failed: {err:?}");
    }
}

fn composite_beams(
    view: ViewQuery<(&ViewTarget, &BeamHalfRes)>,
    composite: Res<BeamComposite>,
    pipeline_cache: Res<PipelineCache>,
    device: Res<RenderDevice>,
    mut ctx: RenderContext,
) {
    let (target, half) = view.into_inner();
    let Some(pipeline) = pipeline_cache.get_render_pipeline(composite.pipeline) else { return };

    let bind_group = device.create_bind_group(
        "beam_composite_bind_group",
        &pipeline_cache.get_bind_group_layout(&composite.layout),
        &BindGroupEntries::sequential((&half.color.default_view, &composite.sampler)),
    );

    // `main_texture_view()` is the UNSAMPLED view the opaque pass has already
    // resolved into, so this is MSAA-agnostic — the same attachment bevy's own
    // volumetric fog composites onto.
    let mut pass = ctx.begin_tracked_render_pass(RenderPassDescriptor {
        label: Some("beam_composite"),
        color_attachments: &[Some(RenderPassColorAttachment {
            view: target.main_texture_view(),
            depth_slice: None,
            resolve_target: None,
            ops: Operations { load: LoadOp::Load, store: StoreOp::Store },
        })],
        depth_stencil_attachment: None,
        timestamp_writes: None,
        occlusion_query_set: None,
        multiview_mask: None,
    });
    pass.set_render_pipeline(pipeline);
    pass.set_bind_group(0, &bind_group, &[]);
    pass.draw(0..3, 0..1);
    let _ = half.size;
}
