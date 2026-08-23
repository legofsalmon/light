// Composite the half-resolution beam pass back into the full-res HDR target.
//
// Additive, and additive is what makes the whole scheme viable: beams are
// premultiplied-additive already, so summing an upsampled buffer is the same
// operation the full-res pass was doing, just with fewer samples behind it.
//
// Bilinear upsampling with no depth awareness, deliberately. The usual reason
// for a nearest-depth upsample is that a half-res effect bleeds across geometry
// silhouettes — but a beam's silhouette here is not geometric. `beam.wgsl`
// clamps its integral against the depth prepass, so the shaft already ends
// where the light lands, and interpolating between two samples that both end
// there lands there too. If haloing ever does show up on a riser edge, the fix
// is a nearest-depth tap, not a sharper filter.

#import bevy_core_pipeline::fullscreen_vertex_shader::FullscreenVertexOutput

@group(0) @binding(0) var beams: texture_2d<f32>;
@group(0) @binding(1) var beams_sampler: sampler;

@fragment
fn fragment(in: FullscreenVertexOutput) -> @location(0) vec4<f32> {
    let c = textureSample(beams, beams_sampler, in.uv);
    // Alpha is forced to zero: the blend state leaves the target's own alpha
    // alone, and a stray value here would be a silent way to corrupt it.
    return vec4<f32>(max(c.rgb, vec3<f32>(0.0)), 0.0);
}
