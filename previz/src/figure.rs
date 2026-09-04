//! The band: jointed human figures, posed per instrument.
//!
//! What this replaces: three primitives in a stack — one capsule for both legs,
//! one for the torso, a sphere on top — with the instrument floating alongside
//! and no arms to hold it. It read as a chess pawn, and more to the point it
//! cast the shadow of a chess pawn: a featureless blob with no hole in it.
//!
//! That matters more here than it would in a game. This window exists to answer
//! "where does the light land on the people", and the two things that actually
//! answer it are the SILHOUETTE and the SHADOW. An arm held clear of the chest
//! punches a hole through both. A bollard does not.
//!
//! So a figure is now a bone chain — pelvis, abdomen, chest, neck, head, two
//! three-bone arms and two three-bone legs — walked from a table of segment
//! directions and flattened at spawn into one entity per bone. Nothing is
//! nested beyond two nodes and nothing animates: the pose is static, chosen by
//! what the person is playing.
//!
//! Proportions are Drillis & Contini fractions of a 1.75 m stature, and the
//! chain closes exactly:
//!
//!   0.068 ankle + 0.431 shank + 0.429 thigh          = 0.928  hip
//!                                        + 0.122     = 1.050  waist
//!                                        + 0.382     = 1.432  shoulder line
//!                                        + 0.085     = 1.517  chin
//!                                        + 0.233 head = 1.750 vertex
//!
//! Everything is a SHARED mesh handle — thirteen of them, and the number does
//! not grow with the number of props. The old code called `meshes.add` thirteen
//! times *inside* the prop loop, so two guitarists were two unbatchable copies
//! of the same guitar. This is 4.5x the entities for slightly FEWER draw calls.

use bevy::prelude::*;

use serde::Deserialize;
use std::sync::LazyLock;

// ---------------------------------------------------------------------------
// shared/figure.json — the one source both previz renderers read.
//
// It used to be ~140 numbers hand-written here and, separately, a different
// ~40 hand-written in ui/src/components/Previz3D.tsx. That is how the web view
// came to still be drawing an armless pawn three commits after these figures
// grew limbs. Parsed once at startup; a malformed file is a build-time asset
// error, not a runtime surprise, because the parse is asserted by a test.
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct Segments {
    thigh: f32,
    shank: f32,
    lumbar: f32,
    thorax: f32,
    neck: f32,
    head: f32,
    uarm: f32,
    farm: f32,
    hand: f32,
    #[serde(rename = "hipX")]
    hip_x: f32,
    #[serde(rename = "footLift")]
    foot_lift: f32,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum MeshSpec {
    #[serde(rename = "box")]
    Boxy { size: [f32; 3] },
    Capsule { radius: f32, length: f32 },
}

#[derive(Deserialize, Clone, Copy)]
struct LegSpec {
    thigh: [f32; 3],
    shank: [f32; 3],
    toe: f32,
}

#[derive(Deserialize)]
struct StanceSpec {
    #[serde(rename = "pelvisY")]
    pelvis_y: f32,
    legs: [LegSpec; 2],
}

#[derive(Deserialize)]
struct SpineSpec {
    lumbar: [f32; 3],
    thorax: [f32; 3],
    neck: [f32; 3],
    head: [f32; 3],
}

#[derive(Deserialize, Clone, Copy)]
struct FootSpec {
    pos: [f32; 3],
    #[serde(rename = "rotX")]
    rot_x: f32,
    #[serde(rename = "rotY")]
    rot_y: f32,
}

#[derive(Deserialize)]
struct KindSpec {
    stance: String,
    pelvis: Option<[f32; 3]>,
    legs: Option<[LegSpec; 2]>,
    feet: Option<[FootSpec; 2]>,
    spine: SpineSpec,
    #[serde(rename = "headPitch")]
    head_pitch: f32,
    #[serde(rename = "headYaw")]
    head_yaw: f32,
    #[serde(rename = "armR")]
    arm_r: [[f32; 3]; 3],
    #[serde(rename = "armL")]
    arm_l: [[f32; 3]; 3],
}

/// One instrument piece: either a sized box at a position, or a strut stretched
/// between two points.
#[derive(Deserialize)]
struct PartSpec {
    mesh: String,
    mat: String,
    size: Option<[f32; 3]>,
    pos: Option<[f32; 3]>,
    from: Option<[f32; 3]>,
    to: Option<[f32; 3]>,
    thick: Option<f32>,
    #[serde(rename = "rotX", default)]
    rot_x: f32,
    #[serde(rename = "rotY", default)]
    rot_y: f32,
    #[serde(rename = "rotZ", default)]
    rot_z: f32,
    /// Orient by the direction between two points before applying rotX — a
    /// guitar headstock following the neck it is on the end of.
    #[serde(rename = "alignTo")]
    align_to: Option<[[f32; 3]; 2]>,
}

#[derive(Deserialize)]
struct MatSpec {
    color: String,
    roughness: f32,
    metallic: f32,
}

#[derive(Deserialize)]
struct LegRing {
    from: [f32; 3],
    radius: f32,
    y: f32,
    thick: f32,
    count: usize,
}

#[derive(Deserialize)]
struct StoolSpec {
    seat: PartSpec,
    post: PartSpec,
    legs: LegRing,
}

#[derive(Deserialize)]
struct StickSpec {
    length: f32,
    thick: f32,
    mat: String,
    #[serde(rename = "targetR")]
    target_r: [f32; 3],
    #[serde(rename = "targetL")]
    target_l: [f32; 3],
}

#[derive(Deserialize)]
struct VariationSpec {
    #[serde(rename = "statureBase")]
    stature_base: f32,
    #[serde(rename = "statureRange")]
    stature_range: f32,
    streams: std::collections::HashMap<String, u32>,
    #[serde(rename = "torsoYawRange")]
    torso_yaw_range: f32,
    #[serde(rename = "headPitchRange")]
    head_pitch_range: f32,
    #[serde(rename = "headYawRange")]
    head_yaw_range: f32,
}

#[derive(Deserialize)]
struct ScaleOnly {
    scale: [f32; 3],
}

#[derive(Deserialize)]
struct DeltoidSpec {
    scale: f32,
    offset: [f32; 3],
}

#[derive(Deserialize)]
struct OffsetOnly {
    offset: [f32; 3],
}

#[derive(Deserialize)]
struct FigureData {
    segments: Segments,
    meshes: std::collections::HashMap<String, MeshSpec>,
    #[serde(rename = "trunkFlatten")]
    trunk_flatten: std::collections::HashMap<String, [f32; 3]>,
    head: ScaleOnly,
    deltoid: DeltoidSpec,
    shoulder: OffsetOnly,
    materials: std::collections::HashMap<String, MatSpec>,
    stances: std::collections::HashMap<String, StanceSpec>,
    kinds: std::collections::HashMap<String, KindSpec>,
    variation: VariationSpec,
    instruments: std::collections::HashMap<String, Vec<PartSpec>>,
    #[serde(rename = "drumKit")]
    drum_kit: Vec<PartSpec>,
    #[serde(rename = "floorTomLegs")]
    floor_tom_legs: LegRing,
    #[serde(rename = "drumStool")]
    drum_stool: StoolSpec,
    sticks: StickSpec,
}

static FIG: LazyLock<FigureData> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../shared/figure.json"))
        .expect("shared/figure.json should parse")
});

fn vec3(a: [f32; 3]) -> Vec3 {
    Vec3::new(a[0], a[1], a[2])
}

/// sRGB hex from the shared file.
fn hex(s: &str) -> Color {
    let n = u32::from_str_radix(s.trim_start_matches('#'), 16).unwrap_or(0x808080);
    Color::srgb_u8((n >> 16) as u8, (n >> 8) as u8, n as u8)
}

fn mesh_of(meshes: &mut Assets<Mesh>, name: &str) -> Handle<Mesh> {
    match FIG.meshes.get(name).unwrap_or_else(|| panic!("figure.json has no mesh {name}")) {
        MeshSpec::Boxy { size } => meshes.add(Cuboid::new(size[0], size[1], size[2])),
        // Bevy's Capsule3d(radius, length) and three's CapsuleGeometry(radius,
        // height) both mean the CYLINDER section, so this transcribes 1:1.
        MeshSpec::Capsule { radius, length } => meshes.add(Capsule3d::new(*radius, *length)),
    }
}

fn rnd_stream(seed: u32, name: &str) -> f32 {
    rnd(seed, *FIG.variation.streams.get(name).unwrap_or(&0))
}


/// Shared meshes and materials. Built once per scene rebuild, never per prop.
pub struct Kit {
    pelvis: Handle<Mesh>,
    abdomen: Handle<Mesh>,
    chest: Handle<Mesh>,
    neck: Handle<Mesh>,
    uarm: Handle<Mesh>,
    farm: Handle<Mesh>,
    hand: Handle<Mesh>,
    thigh: Handle<Mesh>,
    shank: Handle<Mesh>,
    foot: Handle<Mesh>,
    /// Unit primitives — the scale IS the size, so one handle serves every
    /// instrument part and every piece of structure.
    pub ball: Handle<Mesh>,
    pub cube: Handle<Mesh>,
    pub cyl: Handle<Mesh>,
    pub cloth: Handle<StandardMaterial>,
    pub skin: Handle<StandardMaterial>,
    pub wood: Handle<StandardMaterial>,
    pub metal: Handle<StandardMaterial>,
    pub brass: Handle<StandardMaterial>,
}

impl Kit {
    pub fn new(meshes: &mut Assets<Mesh>, materials: &mut Assets<StandardMaterial>) -> Kit {
        let mut mat = |name: &str| {
            let m = FIG.materials.get(name).unwrap_or_else(|| panic!("no material {name}"));
            materials.add(StandardMaterial {
                base_color: hex(&m.color),
                perceptual_roughness: m.roughness,
                metallic: m.metallic,
                ..default()
            })
        };
        Kit {
            pelvis: mesh_of(meshes, "pelvis"),
            abdomen: mesh_of(meshes, "abdomen"),
            chest: mesh_of(meshes, "chest"),
            neck: mesh_of(meshes, "neck"),
            uarm: mesh_of(meshes, "uarm"),
            farm: mesh_of(meshes, "farm"),
            hand: mesh_of(meshes, "hand"),
            thigh: mesh_of(meshes, "thigh"),
            shank: mesh_of(meshes, "shank"),
            foot: mesh_of(meshes, "foot"),
            ball: meshes.add(Sphere::new(0.5)),
            cube: meshes.add(Cuboid::from_length(1.0)),
            cyl: meshes.add(Cylinder::new(0.5, 1.0)),
            cloth: mat("cloth"),
            skin: mat("skin"),
            wood: mat("wood"),
            metal: mat("metal"),
            brass: mat("brass"),
        }
    }
}

// ---------------------------------------------------------------------------
// Posing
// ---------------------------------------------------------------------------

/// Place a Y-up, origin-centred segment so it runs from joint `a` to joint `b`.
fn bone(a: Vec3, b: Vec3) -> Transform {
    let d = b - a;
    Transform::from_translation((a + b) * 0.5)
        .with_rotation(Quat::from_rotation_arc(Vec3::Y, d.try_normalize().unwrap_or(Vec3::Y)))
}

/// Walk a chain of (length, direction) from `start`, returning every joint.
/// Directions are normalised here so the tables below stay readable.
fn chain(start: Vec3, segs: &[(f32, Vec3)]) -> Vec<Vec3> {
    let mut out = Vec::with_capacity(segs.len() + 1);
    out.push(start);
    let mut p = start;
    for (len, dir) in segs {
        p += dir.try_normalize().unwrap_or(Vec3::NEG_Y) * *len;
        out.push(p);
    }
    out
}

/// FNV-1a over the prop's stable id.
///
/// `pr.id` is persisted, unique and — until now — never read by the renderer.
/// It is the natural place to get variation from: the same musician is the same
/// height and stands the same way every time the scene rebuilds, which a
/// per-frame random could never promise.
fn seed_of(id: &str) -> u32 {
    let mut h: u32 = 0x811c_9dc5;
    for b in id.as_bytes() {
        h ^= *b as u32;
        h = h.wrapping_mul(0x0100_0193);
    }
    h
}

/// The k-th uniform in [0, 1) for a seed.
fn rnd(seed: u32, k: u32) -> f32 {
    let mut h = seed ^ k.wrapping_mul(0x9e37_79b9);
    h ^= h >> 16;
    h = h.wrapping_mul(0x7feb_352d);
    h ^= h >> 15;
    h = h.wrapping_mul(0x846c_a68b);
    h ^= h >> 16;
    (h >> 8) as f32 / 16_777_216.0
}

const V: fn(f32, f32, f32) -> Vec3 = Vec3::new;

/// One leg: thigh direction, shank direction, and how far the toe points out.
type Leg = (Vec3, Vec3, f32);

struct Pose {
    pelvis: Vec3,
    /// Right leg then left. Right is the figure's own right, at x = -hipX.
    legs: [Leg; 2],
    /// Explicit foot placement, for a seated figure whose feet are on pedals
    /// rather than flat on the deck.
    feet: Option<[(Vec3, Quat); 2]>,
    lumbar: Vec3,
    thorax: Vec3,
    neck: Vec3,
    head: Vec3,
    head_pitch: f32,
    head_yaw: f32,
    /// Upper arm, forearm, hand direction — right then left.
    arm_r: [Vec3; 3],
    arm_l: [Vec3; 3],
}

fn legs_of(sp: &[LegSpec; 2]) -> [Leg; 2] {
    [
        (vec3(sp[0].thigh), vec3(sp[0].shank), sp[0].toe),
        (vec3(sp[1].thigh), vec3(sp[1].shank), sp[1].toe),
    ]
}

fn mirror_legs(l: [Leg; 2]) -> [Leg; 2] {
    let f = |(a, b, t): Leg| (Vec3::new(-a.x, a.y, a.z), Vec3::new(-b.x, b.y, b.z), -t);
    [f(l[1]), f(l[0])]
}

fn pose_for(kind: &str, seed: u32) -> Pose {
    let k = FIG.kinds.get(kind).unwrap_or_else(|| {
        FIG.kinds.get("default").expect("figure.json needs a `default` kind")
    });
    let arms = |a: &[[f32; 3]; 3]| [vec3(a[0]), vec3(a[1]), vec3(a[2])];

    // A named kind pins its own stance. Only the fallback takes one from the
    // variation stream, and only the fallback is ever mirrored — a guitarist
    // reversed would hold the instrument on the wrong side.
    let (pelvis, legs) = match (&k.pelvis, &k.legs) {
        // 'seated': the pose carries its own pelvis and legs outright.
        (Some(p), Some(l)) => (vec3(*p), legs_of(l)),
        _ => {
            let named = FIG.stances.get(k.stance.as_str());
            match named {
                Some(st) => (Vec3::new(0.0, st.pelvis_y, 0.0), legs_of(&st.legs)),
                None => {
                    // the fallback kind: pick and possibly mirror
                    let names = ["even", "shift", "wide"];
                    let pick = (rnd_stream(seed, "stance") * 3.0) as usize;
                    let st = FIG
                        .stances
                        .get(names[pick.min(2)])
                        .expect("figure.json needs even/shift/wide stances");
                    let mut l = legs_of(&st.legs);
                    if rnd_stream(seed, "mirror") < 0.5 {
                        l = mirror_legs(l);
                    }
                    (Vec3::new(0.0, st.pelvis_y, 0.0), l)
                }
            }
        }
    };

    Pose {
        pelvis,
        legs,
        feet: k.feet.as_ref().map(|f| {
            [
                (
                    vec3(f[0].pos),
                    Quat::from_rotation_y(f[0].rot_y) * Quat::from_rotation_x(f[0].rot_x),
                ),
                (
                    vec3(f[1].pos),
                    Quat::from_rotation_y(f[1].rot_y) * Quat::from_rotation_x(f[1].rot_x),
                ),
            ]
        }),
        lumbar: vec3(k.spine.lumbar),
        thorax: vec3(k.spine.thorax),
        neck: vec3(k.spine.neck),
        head: vec3(k.spine.head),
        head_pitch: k.head_pitch,
        head_yaw: k.head_yaw,
        arm_r: arms(&k.arm_r),
        arm_l: arms(&k.arm_l),
    }
}

/// Emit the whole skeleton. `p` is the stature-scaled `body` node.
fn spawn_body(p: &mut ChildSpawnerCommands, pose: &Pose, kit: &Kit, seed: u32) {
    let cloth = || MeshMaterial3d(kit.cloth.clone());
    let skin = || MeshMaterial3d(kit.skin.clone());

    // --- legs, in the pelvis frame ---
    p.spawn((Mesh3d(kit.pelvis.clone()), cloth(), Transform::from_translation(pose.pelvis)));
    for (i, (thigh_d, shank_d, toe)) in pose.legs.iter().enumerate() {
        let sx = if i == 0 { -1.0 } else { 1.0 };
        let hip = pose.pelvis + V(sx * FIG.segments.hip_x, 0.0, 0.0);
        let j = chain(hip, &[(FIG.segments.thigh, *thigh_d), (FIG.segments.shank, *shank_d)]);
        p.spawn((Mesh3d(kit.thigh.clone()), cloth(), bone(j[0], j[1])));
        p.spawn((Mesh3d(kit.shank.clone()), cloth(), bone(j[1], j[2])));
        let (fpos, frot) = match &pose.feet {
            Some(f) => f[i],
            // Pin the sole to the deck and let the shank's lower cap cover the
            // slack. This is what makes the stance tables robust without having
            // to solve pelvis height per pose — and it is what gives the figure
            // a contact shadow instead of floating 9 cm above its own.
            None => (
                V(j[2].x, FIG.segments.foot_lift, j[2].z + 0.075),
                Quat::from_rotation_y(*toe),
            ),
        };
        p.spawn((
            Mesh3d(kit.foot.clone()),
            cloth(),
            Transform::from_translation(fpos).with_rotation(frot),
        ));
    }

    // --- spine ---
    let n = |v: Vec3| v.try_normalize().unwrap_or(Vec3::Y);
    let waist = pose.pelvis + n(pose.lumbar) * FIG.segments.lumbar;
    p.spawn((
        Mesh3d(kit.abdomen.clone()),
        cloth(),
        bone(pose.pelvis, waist).with_scale(vec3(FIG.trunk_flatten["abdomen"])),
    ));

    // Everything above the waist rides one node, so the per-figure shoulder
    // turn is an exact parent rotation.
    //
    // It must NOT be baked into the joint positions. The trunk capsules are
    // flattened by a non-uniform local scale, and `from_rotation_arc` is
    // minimal-arc — it introduces roll for any bone whose direction is off
    // axis, which would tilt the flattening. Rotating the parent cannot.
    let yaw = (rnd_stream(seed, "torsoYaw") - 0.5) * FIG.variation.torso_yaw_range;
    let neck_base_w = waist + n(pose.thorax) * FIG.segments.thorax;
    let chin_w = neck_base_w + n(pose.neck) * FIG.segments.neck;
    let head_w = chin_w + n(pose.head) * FIG.segments.head;
    // Waist-local.
    let (nb, chin, headc) = (neck_base_w - waist, chin_w - waist, head_w - waist);

    p.spawn((
        Transform::from_translation(waist).with_rotation(Quat::from_rotation_y(yaw)),
        Visibility::default(),
    ))
    .with_children(|u| {
        u.spawn((
            Mesh3d(kit.chest.clone()),
            cloth(),
            bone(Vec3::ZERO, nb).with_scale(vec3(FIG.trunk_flatten["chest"])),
        ));
        u.spawn((Mesh3d(kit.neck.clone()), skin(), bone(nb, chin)));
        // A 7.5-head egg, not a ball on a post. The old 0.22 m sphere was 6.5 cm
        // too wide and read as exactly that at any distance.
        let hp = pose.head_pitch + (rnd_stream(seed, "headPitch") - 0.5) * FIG.variation.head_pitch_range;
        let hy = pose.head_yaw + (rnd_stream(seed, "headYaw") - 0.5) * FIG.variation.head_yaw_range;
        u.spawn((
            Mesh3d(kit.ball.clone()),
            skin(),
            Transform::from_translation(headc)
                .with_rotation(Quat::from_rotation_y(hy) * Quat::from_rotation_x(hp))
                .with_scale(vec3(FIG.head.scale)),
        ));
        // Deltoids take the shoulders out to a 0.454 m bideltoid — canon is
        // 0.453. The old figure's widest point was a 0.34 m torso capsule,
        // which is why its shadow read as a bollard.
        for sx in [-1.0f32, 1.0] {
            u.spawn((
                Mesh3d(kit.ball.clone()),
                skin(),
                Transform::from_translation(
                    nb + vec3(FIG.deltoid.offset) * Vec3::new(sx, 1.0, 1.0),
                )
                .with_scale(Vec3::splat(FIG.deltoid.scale)),
            ));
        }
        for (arm, sx) in [(pose.arm_r, -1.0f32), (pose.arm_l, 1.0)] {
            let sho = nb + vec3(FIG.shoulder.offset) * V(sx, 1.0, 1.0);
            let j = chain(sho, &[(FIG.segments.uarm, arm[0]), (FIG.segments.farm, arm[1]), (FIG.segments.hand, arm[2])]);
            u.spawn((Mesh3d(kit.uarm.clone()), cloth(), bone(j[0], j[1])));
            u.spawn((Mesh3d(kit.farm.clone()), cloth(), bone(j[1], j[2])));
            u.spawn((Mesh3d(kit.hand.clone()), skin(), bone(j[2], j[3])));
        }
    });
}

/// A unit-primitive part: `m` scaled to `size` at `at`.
fn part(
    p: &mut ChildSpawnerCommands,
    m: &Handle<Mesh>,
    mat: &Handle<StandardMaterial>,
    size: Vec3,
    at: Vec3,
    rot: Quat,
) {
    p.spawn((
        Mesh3d(m.clone()),
        MeshMaterial3d(mat.clone()),
        Transform::from_translation(at).with_rotation(rot).with_scale(size),
    ));
}

/// A unit primitive stretched between two points — a stand leg, a guitar neck.
fn strut(
    p: &mut ChildSpawnerCommands,
    m: &Handle<Mesh>,
    mat: &Handle<StandardMaterial>,
    a: Vec3,
    b: Vec3,
    thick: f32,
) {
    let t = bone(a, b).with_scale(V(thick, (b - a).length(), thick));
    p.spawn((Mesh3d(m.clone()), MeshMaterial3d(mat.clone()), t));
}

/// Spawn one performer and their instrument as children of the prop root.
///
/// The figure hangs off a stature-scaled node; the instrument does NOT, so a
/// short guitarist does not get a short guitar.
pub fn spawn_performer(p: &mut ChildSpawnerCommands, kind: &str, id: &str, kit: &Kit) {
    let seed = seed_of(id);
    let pose = pose_for(kind, seed);
    let stature = FIG.variation.stature_base
        + FIG.variation.stature_range * rnd_stream(seed, "stature");

    p.spawn((Transform::from_scale(Vec3::splat(stature)), Visibility::default()))
        .with_children(|b| {
            spawn_body(b, &pose, kit, seed);
            if kind == "drummer" {
                // The stool is the one instrument part that scales WITH the
                // player, or a tall drummer floats above their own seat.
                let st = &FIG.drum_stool;
                spawn_part(b, kit, &st.seat);
                spawn_part(b, kit, &st.post);
                for k in 0..st.legs.count {
                    let t = std::f32::consts::FRAC_PI_2
                        + k as f32 * std::f32::consts::TAU / st.legs.count as f32;
                    let from = vec3(st.legs.from);
                    strut(
                        b,
                        &kit.cyl,
                        &kit.metal,
                        from,
                        V(
                            from.x + st.legs.radius * t.cos(),
                            st.legs.y,
                            from.z + st.legs.radius * t.sin(),
                        ),
                        st.legs.thick,
                    );
                }
            }
        });

    // Instruments come straight out of the shared file, so the web view builds
    // the same guitar from the same numbers.
    if let Some(parts) = FIG.instruments.get(kind) {
        for sp in parts {
            spawn_part(p, kit, sp);
        }
    }
    if kind == "drummer" {
        spawn_kit(p, kit, &pose, stature);
    }
}

/// Resolve one `PartSpec` — a sized piece at a position, or a strut stretched
/// between two points — against the shared mesh and material kit.
fn spawn_part(p: &mut ChildSpawnerCommands, kit: &Kit, sp: &PartSpec) {
    let mesh = match sp.mesh.as_str() {
        "ball" => &kit.ball,
        "cube" => &kit.cube,
        _ => &kit.cyl,
    };
    let mat = match sp.mat.as_str() {
        "cloth" => &kit.cloth,
        "skin" => &kit.skin,
        "wood" => &kit.wood,
        "brass" => &kit.brass,
        _ => &kit.metal,
    };
    if let (Some(a), Some(b), Some(t)) = (sp.from, sp.to, sp.thick) {
        strut(p, mesh, mat, vec3(a), vec3(b), t);
        return;
    }
    let size = sp.size.map_or(Vec3::ONE, vec3);
    let pos = sp.pos.map_or(Vec3::ZERO, vec3);
    // `alignTo` first, then the local rotations on top of it: a headstock
    // follows the neck it is on the end of, and is then angled back from it.
    let base = match sp.align_to {
        Some([a, b]) => bone(vec3(a), vec3(b)).rotation,
        None => Quat::IDENTITY,
    };
    let rot = base
        * Quat::from_rotation_z(sp.rot_z)
        * Quat::from_rotation_y(sp.rot_y)
        * Quat::from_rotation_x(sp.rot_x);
    part(p, mesh, mat, size, pos, rot);
}

/// The drum kit. Everything except the stool is in the ROOT frame, so it stays
/// the same size whatever height the player is.
fn spawn_kit(p: &mut ChildSpawnerCommands, kit: &Kit, pose: &Pose, stature: f32) {
    for sp in &FIG.drum_kit {
        spawn_part(p, kit, sp);
    }
    // Floor-tom tripod. Stated in the shared file rather than found by scanning
    // the kit for a part 0.400 tall, which grew a second tripod on any other
    // drum retuned to that height.
    let fl = &FIG.floor_tom_legs;
    let from = vec3(fl.from);
    for k in 0..fl.count {
        let a = k as f32 * std::f32::consts::TAU / fl.count as f32;
        strut(
            p,
            &kit.cyl,
            &kit.metal,
            from,
            V(from.x + fl.radius * a.cos(), fl.y, from.z + fl.radius * a.sin()),
            fl.thick,
        );
    }

    // Sticks, aimed from each hand at what that hand is about to hit. The tip
    // overshoots the drum, which is what a real stick does.
    let st = &FIG.sticks;
    let mat = if st.mat == "metal" { &kit.metal } else { &kit.cloth };
    let n = |v: Vec3| v.try_normalize().unwrap_or(Vec3::Y);
    let waist = pose.pelvis + n(pose.lumbar) * FIG.segments.lumbar;
    let nb = waist + n(pose.thorax) * FIG.segments.thorax;
    for (arm, sx, target) in [
        (pose.arm_r, -1.0f32, vec3(st.target_r)),
        (pose.arm_l, 1.0, vec3(st.target_l)),
    ] {
        let sho = nb + vec3(FIG.shoulder.offset) * V(sx, 1.0, 1.0);
        let j = chain(
            sho,
            &[
                (FIG.segments.uarm, arm[0]),
                (FIG.segments.farm, arm[1]),
                (FIG.segments.hand, arm[2]),
            ],
        );
        // The hands live under the stature-scaled body node; the kit does not.
        let hand = j[3] * stature;
        strut(p, &kit.cyl, mat, hand, hand + n(target - hand) * st.length, st.thick);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The proportion chain has to close, or every figure is the wrong height
    /// and every foot is off the deck. This is the arithmetic in the module
    /// doc, checked.
    #[test]
    fn an_upright_figure_is_exactly_1_75_m() {
        const L_ANKLE: f32 = 0.068;
        let hip = L_ANKLE + FIG.segments.shank + FIG.segments.thigh;
        let vertex = hip + FIG.segments.lumbar + FIG.segments.thorax + FIG.segments.neck + 0.233;
        assert!((hip - 0.928).abs() < 1e-4, "hip at {hip}");
        assert!((vertex - 1.750).abs() < 1e-3, "vertex at {vertex}");
    }

    /// `bone` must place a segment so its ENDS are the two joints, not so its
    /// centre is one of them. Getting this backwards halves every limb.
    #[test]
    fn a_bone_spans_its_two_joints() {
        let (a, b) = (Vec3::new(0.1, 1.0, 0.0), Vec3::new(0.4, 0.6, 0.2));
        let t = bone(a, b);
        assert!((t.translation - (a + b) * 0.5).length() < 1e-5);
        // Local +Y maps onto the joint-to-joint direction.
        let mapped = t.rotation * Vec3::Y;
        assert!((mapped - (b - a).normalize()).length() < 1e-5, "{mapped:?}");
    }

    /// Every standing pose must put both soles ON the deck. A figure floating
    /// above its own contact shadow is the exact defect this replaces.
    #[test]
    fn standing_figures_stand_on_the_floor() {
        for kind in ["vocalist", "guitarist", "bassist", "keyboardist"] {
            let pose = pose_for(kind, seed_of(kind));
            assert!(pose.feet.is_none(), "{kind} should use the deck rule");
            for (i, (th, sh, _)) in pose.legs.iter().enumerate() {
                let sx = if i == 0 { -1.0 } else { 1.0 };
                let hip = pose.pelvis + Vec3::new(sx * FIG.segments.hip_x, 0.0, 0.0);
                let j = chain(hip, &[(FIG.segments.thigh, *th), (FIG.segments.shank, *sh)]);
                // The ankle must land close enough to the deck that the foot
                // block, pinned at y = 0, still meets the shank.
                assert!(
                    j[2].y.abs() < 0.14,
                    "{kind} leg {i}: ankle at y={} is too far from the deck",
                    j[2].y
                );
            }
        }
    }

    /// The silhouette rule: at least one elbow well clear of the body axis, so
    /// a spot from the truss throws something with a hole in it rather than a
    /// blob. This is the whole reason for arms in a lighting previz.
    #[test]
    fn every_pose_has_an_arm_clear_of_the_chest() {
        for kind in ["vocalist", "guitarist", "bassist", "keyboardist", "drummer"] {
            let pose = pose_for(kind, seed_of(kind));
            let n = |v: Vec3| v.normalize();
            let waist = pose.pelvis + n(pose.lumbar) * FIG.segments.lumbar;
            let nb = waist + n(pose.thorax) * FIG.segments.thorax;
            let mut widest: f32 = 0.0;
            for (arm, sx) in [(pose.arm_r, -1.0f32), (pose.arm_l, 1.0)] {
                let sho = nb + Vec3::new(sx * 0.165, -0.030, 0.010);
                let j = chain(sho, &[(FIG.segments.uarm, arm[0]), (FIG.segments.farm, arm[1]), (FIG.segments.hand, arm[2])]);
                for p in &j[1..] {
                    widest = widest.max((p.x - pose.pelvis.x).abs());
                }
            }
            assert!(widest >= 0.20, "{kind}: widest arm point only {widest} from the axis");
        }
    }

    /// The two renderers must agree BIT FOR BIT about this hash, or the same
    /// musician is a different height in the two windows — and nobody would
    /// think to suspect the hash.
    ///
    /// Every pair below was MEASURED from the TypeScript twin running in a
    /// browser (ui/src/components/figure.ts exports `_test.seedOf` / `_test.rnd`
    /// for exactly this). JavaScript has no u32, so that side is `Math.imul`
    /// plus `>>> 0` after every step; this is what says it got that right.
    ///
    /// The first draft of this test had one value typed from memory rather than
    /// measured, and it failed — which is the correct outcome, but the lesson
    /// is that a hash test is worthless unless both sides are read off the
    /// machine.
    #[test]
    fn the_hash_agrees_with_the_typescript_twin() {
        // (id, seed, rnd stream 0, rnd stream 2)
        for (id, seed, r0, r2) in [
            ("prop-voc", 3_314_113_805u32, 0.234_680_235f32, 0.379_705_012f32),
            ("prop-gtr", 1_743_596_194, 0.033_841_491, 0.926_282_585),
            ("prop-bass", 4_154_571_824, 0.363_615_930, 0.491_659_701),
            ("prop-drums", 1_573_363_592, 0.590_025_306, 0.051_662_147),
            ("prop-keys", 3_523_445_823, 0.614_000_320, 0.845_280_886),
        ] {
            assert_eq!(seed_of(id), seed, "{id} seed");
            assert!((rnd(seed_of(id), 0) - r0).abs() < 1e-7, "{id} stream 0");
            assert!((rnd(seed_of(id), 2) - r2).abs() < 1e-7, "{id} stream 2");
        }
    }

    /// Variation must be a pure function of the prop id: the same musician is
    /// the same height every rebuild, and a rebuild happens on any 1 cm nudge
    /// of an unrelated prop.
    #[test]
    fn variation_is_stable_for_an_id() {
        for id in ["prop-voc", "prop-gtr", "prop-drums"] {
            let a = seed_of(id);
            assert_eq!(a, seed_of(id));
            assert!((rnd(a, 0) - rnd(seed_of(id), 0)).abs() < 1e-9);
        }
        assert_ne!(seed_of("prop-voc"), seed_of("prop-gtr"));
    }

    /// Stature stays inside a human range. Too wide and the hands leave the
    /// instrument, which does not scale with the player.
    #[test]
    fn stature_stays_human() {
        for i in 0..2000u32 {
            let s = seed_of(&format!("prop-{i}"));
            let h = (0.96 + 0.08 * rnd(s, 0)) * 1.75;
            assert!((1.67..=1.83).contains(&h), "stature {h}");
        }
    }
}
