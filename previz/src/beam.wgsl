// Analytic single-scattering integral for one lighting beam.
//
// What this replaces: a hollow cone SHELL — a 28-triangle fan with vertex alpha
// ramping apex-to-rim, drawn additively. It had no radial falloff at all (you
// only ever saw the shell), no response to view angle, and its only reaction to
// zoom was the geometric cone getting wider. It read as a paper cutout, which
// is the single biggest "game engine" tell in the whole picture.
//
// What this does instead: for every pixel the beam's proxy hull covers, find
// where the view ray enters and leaves the cone, and integrate the light
// scattered toward the camera along that segment.
//
// The proxy hull is rasterized BACK FACES ONLY with the depth test off, so a
// fragment here means "the ray passes through this beam's neighbourhood" and
// nothing more. Every geometric fact is recomputed analytically below; the
// triangles are a conservative bound, not the shape.

#import bevy_pbr::forward_io::VertexOutput
#import bevy_pbr::mesh_view_bindings::view
#import bevy_pbr::mesh_functions::get_world_from_local
#import bevy_pbr::prepass_utils::prepass_depth
#import bevy_pbr::view_transformations::depth_ndc_to_view_z

struct Beam {
    /// Linear RGB, w = intensity 0..1 with the strobe gate already applied.
    color: vec4<f32>,
    /// Axial intensity in candela-shaped units, before exposure. Carries the
    /// flux-conservation term, so a narrowed beam is genuinely brighter.
    axial: f32,
    /// 1 - cos(beam half-angle). Passed in rather than the cosine because both
    /// are within an f32 ulp of 1.0 for a narrow beam: a 1.5 degree half-angle
    /// gives 1 - cos = 3.4e-4, and computing that difference in the shader
    /// leaves ~2e-4 of relative noise, which shows as concentric banding.
    one_minus_cos_b: f32,
    /// Cosines bounding the field-angle shoulder: fully lit inside `in`, fully
    /// dark outside `out`. cos is decreasing in angle, so in > out.
    cos_shoulder_in: f32,
    cos_shoulder_out: f32,
    /// Extinction coefficient of the medium, per metre.
    sigma_t: f32,
    /// Scattering coefficient — how much of what is extinguished comes back to
    /// the eye rather than being absorbed.
    sigma_s: f32,
    /// Henyey-Greenstein asymmetry. Positive is forward-scattering.
    g: f32,
    /// Squared radius of the emitting surface, metres^2. Without this the 1/s^2
    /// term is unbounded, and the camera looking straight at a lamp writes an
    /// Inf into an HDR target that bloom then smears over the entire frame.
    r0_sq: f32,
    /// Shaft length along the axis, metres — where the beam lands.
    length_m: f32,
    /// Operator trim on shaft brightness.
    gain: f32,
}

@group(#{MATERIAL_BIND_GROUP}) @binding(0) var<uniform> beam: Beam;

const LN2: f32 = 0.6931472;
const FRAC_4_PI: f32 = 0.07957747;
/// Samples along the segment inside the cone. The 1/s^2 envelope — the term a
/// naive march aliases worst — is handled by weighting each step at its
/// midpoint, so this buys smoothness in the ANGULAR terms only and does not
/// need to be large.
const STEPS: i32 = 24;

/// Henyey-Greenstein phase function.
///
/// `cos_theta` is the angle between the direction the light is TRAVELLING and
/// the direction the eye is looking. Light continuing forward toward the camera
/// means those agree. The sign is easy to get backwards and the failure is
/// subtle — the shaft brightens when the camera is behind the lamp instead of
/// when the lamp points at it — so the caller passes -dot(n, D) and this
/// function takes it as given.
fn hg(cos_theta: f32, g: f32) -> f32 {
    let gg = g * g;
    let denom = 1.0 + gg - 2.0 * g * cos_theta;
    return FRAC_4_PI * (1.0 - gg) / max(denom * sqrt(max(denom, 1e-4)), 1e-4);
}

@fragment
fn fragment(in: VertexOutput) -> @location(0) vec4<f32> {
    let energy = beam.color.w;
    if energy <= 0.0005 {
        return vec4<f32>(0.0);
    }

    // Apex and axis straight from this instance's transform. Deliberately NOT
    // from the uniform: `apply_live` mutates mover rotations in Update and
    // transform propagation happens in PostUpdate, so anything read from a
    // GlobalTransform on the CPU describes the PREVIOUS frame's pose. The
    // analytic cone and the rasterized hull would then disagree and the
    // silhouette would tear every time a mover swept.
    let m = get_world_from_local(in.instance_index);
    let apex = (m * vec4<f32>(0.0, 0.0, 0.0, 1.0)).xyz;
    // The cone opens along local -Z, matching how the hull mesh is built.
    let axis = normalize((m * vec4<f32>(0.0, 0.0, -1.0, 0.0)).xyz);

    let eye = view.world_position.xyz;
    let to_frag = in.world_position.xyz - eye;
    let dist_frag = length(to_frag);
    let dir = to_frag / max(dist_frag, 1e-6);

    // --- ray vs infinite double cone -------------------------------------
    // Surface: dot(normalize(X - apex), axis) = k, with the far sheet selected
    // afterwards. Writing it as a quadratic in t for X = eye + t*dir.
    let k = 1.0 - beam.one_minus_cos_b;
    // The hull is cut at the FIELD angle, and so is the integral: the shoulder
    // is where the light actually ends.
    let k_cut = beam.cos_shoulder_out;
    let v = eye - apex;
    let d_a = dot(dir, axis);
    let v_a = dot(v, axis);
    let kk = k_cut * k_cut;

    let a = d_a * d_a - kk;
    let b = 2.0 * (d_a * v_a - dot(dir, v) * kk);
    let c = v_a * v_a - dot(v, v) * kk;

    var t0 = 0.0;
    var t1 = 0.0;
    if abs(a) < 1e-6 {
        // The ray runs parallel to a generatrix of the cone. Not the exotic
        // case it sounds: it is a one-dimensional family of directions present
        // in every frame, so without this branch it shows as a visible streak
        // of divide-by-zero pixels rather than as a rare glitch.
        if abs(b) < 1e-9 {
            return vec4<f32>(0.0);
        }
        let t = -c / b;
        t0 = 0.0;
        t1 = t;
        if t <= 0.0 {
            return vec4<f32>(0.0);
        }
    } else {
        let disc = b * b - 4.0 * a * c;
        if disc <= 0.0 {
            return vec4<f32>(0.0);
        }
        let sq = sqrt(disc);
        let inv = 0.5 / a;
        let ta = (-b - sq) * inv;
        let tb = (-b + sq) * inv;
        t0 = min(ta, tb);
        t1 = max(ta, tb);
    }

    // Clip to the forward sheet and to the shaft's own length. The quadratic
    // solves the DOUBLE cone, so without the axial clamp every beam grows a
    // phantom twin pointing backwards out of the fixture.
    let denom_axial = d_a;
    // (X - apex).axis = v_a + t*d_a, wanted in [0, length].
    if abs(denom_axial) > 1e-6 {
        let s0 = (0.0 - v_a) / denom_axial;
        let s1 = (beam.length_m - v_a) / denom_axial;
        t0 = max(t0, min(s0, s1));
        t1 = min(t1, max(s0, s1));
    } else {
        // Ray perpendicular to the axis: the axial coordinate never changes.
        if v_a < 0.0 || v_a > beam.length_m {
            return vec4<f32>(0.0);
        }
    }

    // Camera inside the hull is normal, not exceptional — an operator flies
    // through beams constantly.
    t0 = max(t0, 0.0);

    // Occlusion. The depth test is off (a back-face fragment that terminates
    // behind a riser would otherwise reject the whole beam, including the half
    // in front of it), so the opaque depth buffer is sampled and used to cut
    // the integral instead.
    let opaque_ndc = prepass_depth(in.position, 0u);
    if opaque_ndc > 0.0 {
        let view_z = depth_ndc_to_view_z(opaque_ndc);
        // View-space Z is negative in front of the camera; the ray distance to
        // that surface along `dir` accounts for off-axis pixels.
        // View-space z is negative in front of the camera, and `view_z` is
        // measured along the camera's forward axis rather than along this
        // pixel's ray — so an off-axis pixel needs the obliquity factor or the
        // clamp cuts the integral short across most of the frame. The camera's
        // world-space forward is -Z of its own transform.
        let fwd = -view.world_from_view[2].xyz;
        let cos_fwd = max(dot(dir, fwd), 1e-3);
        t1 = min(t1, -view_z / cos_fwd);
    }

    if t1 <= t0 {
        return vec4<f32>(0.0);
    }

    // --- integrate --------------------------------------------------------
    let dt = (t1 - t0) / f32(STEPS);
    var acc = 0.0;
    for (var i = 0; i < STEPS; i = i + 1) {
        let t = t0 + (f32(i) + 0.5) * dt;
        let p = eye + dir * t - apex;
        let s2 = dot(p, p);
        let s = sqrt(max(s2, 1e-8));
        let n = p / s;
        let ct = dot(n, axis);
        if ct <= 0.0 {
            continue;
        }

        // Radial profile: a Gaussian core that is EXACTLY 0.5 at the beam
        // angle — which is the definition of the beam angle, so it needs no
        // fitting — inside a soft aperture at the field angle.
        //
        // (1 - ct) is computed as half the squared chord between the two unit
        // vectors rather than by subtracting cosines, which for a narrow beam
        // is a catastrophic cancellation.
        let chord = n - axis;
        let one_minus_ct = 0.5 * dot(chord, chord);
        let core = exp(-LN2 * one_minus_ct / max(beam.one_minus_cos_b, 1e-7));
        let shoulder = smoothstep(beam.cos_shoulder_out, beam.cos_shoulder_in, ct);
        let radial = core * shoulder;
        if radial <= 1e-5 {
            continue;
        }

        // Inverse square from the source, softened by the emitter's real size.
        let falloff = 1.0 / (s2 + beam.r0_sq);
        // Beer-Lambert, out from the lamp and back to the eye.
        let transmit = exp(-beam.sigma_t * (s + t));
        // Forward scattering. n is lamp->point, dir is eye->point; light
        // continuing toward the eye means they oppose.
        let phase = hg(-dot(n, dir), beam.g);

        acc = acc + radial * falloff * transmit * phase * dt;
    }

    // `view.exposure` matters: bevy's photometric path applies it to everything
    // else, and a shader emitting raw radiance would sit five orders of
    // magnitude above the rest of the frame.
    let scale = beam.axial * energy * beam.sigma_s * beam.gain * view.exposure;
    let rgb = beam.color.rgb * acc * scale;

    // Premultiplied-alpha additive: the alpha channel is unused by the blend
    // state, but keep it finite so a NaN can never enter the target.
    return vec4<f32>(max(rgb, vec3<f32>(0.0)), 0.0);
}
