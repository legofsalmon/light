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

// ---------------------------------------------------------------------------
// Segment lengths, metres, for a 1.75 m figure.
// ---------------------------------------------------------------------------
const L_THIGH: f32 = 0.429;
const L_SHANK: f32 = 0.431;
const L_LUMBAR: f32 = 0.122;
const L_THORAX: f32 = 0.382;
const L_NECK: f32 = 0.085;
const L_HEAD: f32 = 0.117;
const L_UARM: f32 = 0.300;
const L_FARM: f32 = 0.260;
const L_HAND: f32 = 0.105;
const HIP_X: f32 = 0.088;
/// Half the foot block's height: its bottom face pins to y = 0.
const FOOT_LIFT: f32 = 0.034;

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
        Kit {
            // Authored at exact segment length, never scaled: a capsule's caps
            // distort under non-uniform scale, and `bone` relies on the
            // cylinder part matching the joint-to-joint distance so the caps
            // OVERLAP at every joint. An overlapping joint cannot leak a pinhole
            // of light through the shadow.
            pelvis: meshes.add(Cuboid::new(0.310, 0.190, 0.210)),
            abdomen: meshes.add(Capsule3d::new(0.115, 0.100)),
            chest: meshes.add(Capsule3d::new(0.145, 0.240)),
            neck: meshes.add(Capsule3d::new(0.052, 0.050)),
            uarm: meshes.add(Capsule3d::new(0.050, L_UARM)),
            farm: meshes.add(Capsule3d::new(0.043, L_FARM)),
            hand: meshes.add(Cuboid::new(0.085, L_HAND, 0.045)),
            thigh: meshes.add(Capsule3d::new(0.080, L_THIGH)),
            shank: meshes.add(Capsule3d::new(0.058, L_SHANK)),
            foot: meshes.add(Cuboid::new(0.100, FOOT_LIFT * 2.0, 0.266)),
            ball: meshes.add(Sphere::new(0.5)),
            cube: meshes.add(Cuboid::from_length(1.0)),
            cyl: meshes.add(Cylinder::new(0.5, 1.0)),
            cloth: materials.add(StandardMaterial {
                base_color: Color::srgb(0.14, 0.14, 0.16),
                perceptual_roughness: 0.92,
                ..default()
            }),
            skin: materials.add(StandardMaterial {
                base_color: Color::srgb(0.62, 0.47, 0.38),
                perceptual_roughness: 0.75,
                ..default()
            }),
            wood: materials.add(StandardMaterial {
                base_color: Color::srgb(0.35, 0.12, 0.10),
                perceptual_roughness: 0.55,
                ..default()
            }),
            metal: materials.add(StandardMaterial {
                base_color: Color::srgb(0.55, 0.55, 0.6),
                metallic: 0.85,
                perceptual_roughness: 0.35,
                ..default()
            }),
            brass: materials.add(StandardMaterial {
                base_color: Color::srgb(0.71, 0.58, 0.28),
                metallic: 0.9,
                perceptual_roughness: 0.3,
                ..default()
            }),
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

/// One leg: thigh direction, shank direction, and how far the toe points out.
type Leg = (Vec3, Vec3, f32);

struct Pose {
    pelvis: Vec3,
    /// Right leg then left. Right is the figure's own right, at x = -HIP_X.
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

const V: fn(f32, f32, f32) -> Vec3 = Vec3::new;

/// Even weight, feet about 0.20 apart. Exactly 1.750 m with an upright spine.
fn stance_even(y: f32) -> [Leg; 2] {
    [
        (V(-0.03, -1.00, -0.02), V(0.02, -1.00, 0.02), -0.08),
        (V(0.03, -1.00, -0.02), V(-0.02, -1.00, 0.02), 0.08),
    ]
    .map(|l| l)
    .map(|(a, b, t)| (a, b, t))
    .map(|x| {
        let _ = y;
        x
    })
}

/// Weight on the right, left foot forward and the knee soft.
fn stance_shift() -> [Leg; 2] {
    [
        (V(-0.07, -1.00, -0.04), V(0.05, -1.00, 0.03), -0.06),
        (V(0.10, -1.00, 0.30), V(-0.06, -1.00, -0.16), 0.22),
    ]
}

/// Feet 0.42 apart, both knees about 10 degrees soft. A player's stance.
fn stance_wide() -> [Leg; 2] {
    [
        (V(-0.20, -1.00, 0.14), V(0.12, -1.00, -0.12), -0.18),
        (V(0.20, -1.00, 0.14), V(-0.12, -1.00, -0.12), 0.18),
    ]
}

fn mirror_legs(l: [Leg; 2]) -> [Leg; 2] {
    let f = |(a, b, t): Leg| (V(-a.x, a.y, a.z), V(-b.x, b.y, b.z), -t);
    [f(l[1]), f(l[0])]
}

fn pose_for(kind: &str, seed: u32) -> Pose {
    let pick = (rnd(seed, 2) * 3.0) as usize;
    let mut legs = match pick {
        0 => stance_even(0.0),
        1 => stance_shift(),
        _ => stance_wide(),
    };
    if rnd(seed, 11) < 0.5 {
        legs = mirror_legs(legs);
    }
    let pelvis_y = match pick {
        0 => 0.928,
        1 => 0.920,
        _ => 0.912,
    };

    // Each kind is posed doing its job. The asymmetry is the point: it is what
    // makes a shadow say "drummer" from ten metres.
    match kind {
        "vocalist" => Pose {
            pelvis: V(0.0, pelvis_y, 0.0),
            legs: stance_shift(),
            feet: None,
            lumbar: V(0.0, 1.0, 0.10),
            thorax: V(0.0, 1.0, 0.22),
            neck: V(0.0, 1.0, 0.05),
            head: V(0.0, 1.0, 0.02),
            head_pitch: -0.10, // chin lifted, off the mic
            head_yaw: 0.0,
            // One hand on the shaft, the other thrown open ABOVE the head.
            //
            // The first pass angled the upper arm almost horizontally and put
            // the fingertips at 1.78 against a head crown of 1.74 — four
            // centimetres of clearance, which in perspective just reads as an
            // arm held out level. Lifting the humerus takes the hand to 1.90,
            // and the gap between hand and head is the whole gesture.
            arm_r: [V(-0.35, -0.90, 0.26), V(0.55, 0.72, 0.42), V(0.55, 0.10, 0.83)],
            arm_l: [V(0.60, 0.40, 0.28), V(0.22, 0.95, 0.15), V(0.06, 0.99, 0.08)],
        },
        "guitarist" => Pose {
            pelvis: V(0.0, 0.912, 0.0),
            legs: stance_wide(),
            feet: None,
            lumbar: V(0.0, 1.0, 0.16),
            thorax: V(0.0, 1.0, 0.30),
            neck: V(0.0, 1.0, 0.30),
            head: V(0.0, 1.0, 0.34),
            head_pitch: 0.38, // down at the fretboard
            head_yaw: 0.0,
            arm_r: [V(-0.30, -0.90, 0.20), V(0.60, -0.55, 0.30), V(0.35, -0.35, 0.87)],
            arm_l: [V(0.25, -0.94, 0.10), V(0.55, 0.42, 0.05), V(0.90, 0.30, -0.10)],
        },
        // Same skeleton as the guitarist, deliberately opposite posture: rooted,
        // upright, head up at the crowd. Together with a longer flatter neck and
        // a lower-slung body it is five independent tells, so the two are never
        // confused at a distance the way the identical old boxes were.
        "bassist" => Pose {
            pelvis: V(0.0, 0.912, 0.0),
            legs: stance_wide(),
            feet: None,
            lumbar: V(0.0, 1.0, 0.02),
            thorax: V(0.0, 1.0, 0.05),
            neck: V(0.0, 1.0, 0.02),
            head: V(0.0, 1.0, 0.02),
            head_pitch: 0.04,
            head_yaw: 0.12,
            arm_r: [V(-0.22, -0.94, 0.26), V(0.50, -0.42, 0.42), V(0.30, -0.30, 0.90)],
            arm_l: [V(0.34, -0.90, 0.12), V(0.66, 0.14, 0.08), V(0.94, 0.20, -0.10)],
        },
        "keyboardist" => Pose {
            pelvis: V(0.0, 0.928, 0.0),
            legs: stance_even(0.0),
            feet: None,
            lumbar: V(0.0, 1.0, 0.10),
            thorax: V(0.0, 1.0, 0.16),
            neck: V(0.0, 1.0, 0.26),
            head: V(0.0, 1.0, 0.28),
            head_pitch: 0.34,
            head_yaw: 0.0,
            // Both palms flat over the keys. `bone` orients the hand block's
            // thin axis as the palm normal, so this falls out for free.
            arm_r: [V(-0.18, -0.95, 0.30), V(0.12, -0.42, 0.90), V(0.05, -0.55, 0.83)],
            arm_l: [V(0.26, -0.94, 0.26), V(0.10, -0.40, 0.91), V(0.02, -0.55, 0.84)],
        },
        // Seated, and the only figure with an explicit foot placement: both feet
        // are on pedals, heels up, not flat on the deck.
        "drummer" => Pose {
            pelvis: V(0.0, 0.520, -0.420),
            legs: [
                (V(-0.10, -0.20, 1.00), V(0.02, -0.90, 0.44), 0.0),
                (V(0.30, -0.22, 0.94), V(0.10, -0.88, 0.46), 0.0),
            ],
            feet: Some([
                (V(-0.115, 0.045, 0.235), Quat::from_rotation_x(0.30)),
                (
                    V(0.265, 0.045, 0.225),
                    Quat::from_rotation_y(0.20) * Quat::from_rotation_x(0.26),
                ),
            ]),
            lumbar: V(0.0, 1.0, 0.12),
            thorax: V(0.0, 1.0, 0.14),
            neck: V(0.0, 1.0, 0.10),
            head: V(0.0, 1.0, 0.12),
            head_pitch: 0.16,
            head_yaw: 0.0,
            // One arm up at the crash, one down on the snare.
            arm_r: [V(-0.55, 0.28, 0.60), V(-0.30, 0.34, 0.80), V(-0.34, 0.10, 0.94)],
            arm_l: [V(0.28, -0.86, 0.42), V(-0.34, -0.10, 0.93), V(-0.20, -0.20, 0.96)],
        },
        _ => Pose {
            pelvis: V(0.0, pelvis_y, 0.0),
            legs,
            feet: None,
            lumbar: V(0.0, 1.0, 0.02),
            thorax: V(0.0, 1.0, 0.04),
            neck: V(0.0, 1.0, 0.02),
            head: V(0.0, 1.0, 0.0),
            head_pitch: 0.0,
            head_yaw: 0.0,
            arm_r: [V(-0.12, -1.00, 0.06), V(0.05, -1.00, 0.10), V(0.0, -1.0, 0.10)],
            arm_l: [V(0.12, -1.00, 0.06), V(-0.05, -1.00, 0.10), V(0.0, -1.0, 0.10)],
        },
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
        let hip = pose.pelvis + V(sx * HIP_X, 0.0, 0.0);
        let j = chain(hip, &[(L_THIGH, *thigh_d), (L_SHANK, *shank_d)]);
        p.spawn((Mesh3d(kit.thigh.clone()), cloth(), bone(j[0], j[1])));
        p.spawn((Mesh3d(kit.shank.clone()), cloth(), bone(j[1], j[2])));
        let (fpos, frot) = match &pose.feet {
            Some(f) => f[i],
            // Pin the sole to the deck and let the shank's lower cap cover the
            // slack. This is what makes the stance tables robust without having
            // to solve pelvis height per pose — and it is what gives the figure
            // a contact shadow instead of floating 9 cm above its own.
            None => (
                V(j[2].x, FOOT_LIFT, j[2].z + 0.075),
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
    let waist = pose.pelvis + n(pose.lumbar) * L_LUMBAR;
    p.spawn((
        Mesh3d(kit.abdomen.clone()),
        cloth(),
        bone(pose.pelvis, waist).with_scale(V(1.0, 1.0, 0.82)),
    ));

    // Everything above the waist rides one node, so the per-figure shoulder
    // turn is an exact parent rotation.
    //
    // It must NOT be baked into the joint positions. The trunk capsules are
    // flattened by a non-uniform local scale, and `from_rotation_arc` is
    // minimal-arc — it introduces roll for any bone whose direction is off
    // axis, which would tilt the flattening. Rotating the parent cannot.
    let yaw = (rnd(seed, 3) - 0.5) * 0.30;
    let neck_base_w = waist + n(pose.thorax) * L_THORAX;
    let chin_w = neck_base_w + n(pose.neck) * L_NECK;
    let head_w = chin_w + n(pose.head) * L_HEAD;
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
            bone(Vec3::ZERO, nb).with_scale(V(1.0, 1.0, 0.76)),
        ));
        u.spawn((Mesh3d(kit.neck.clone()), skin(), bone(nb, chin)));
        // A 7.5-head egg, not a ball on a post. The old 0.22 m sphere was 6.5 cm
        // too wide and read as exactly that at any distance.
        let hp = pose.head_pitch + (rnd(seed, 5) - 0.5) * 0.20;
        let hy = pose.head_yaw + (rnd(seed, 19) - 0.5) * 0.50;
        u.spawn((
            Mesh3d(kit.ball.clone()),
            skin(),
            Transform::from_translation(headc)
                .with_rotation(Quat::from_rotation_y(hy) * Quat::from_rotation_x(hp))
                .with_scale(V(0.155, 0.233, 0.195)),
        ));
        // Deltoids take the shoulders out to a 0.454 m bideltoid — canon is
        // 0.453. The old figure's widest point was a 0.34 m torso capsule,
        // which is why its shadow read as a bollard.
        for sx in [-1.0f32, 1.0] {
            u.spawn((
                Mesh3d(kit.ball.clone()),
                skin(),
                Transform::from_translation(nb + V(sx * 0.155, -0.005, 0.005))
                    .with_scale(Vec3::splat(0.144)),
            ));
        }
        for (arm, sx) in [(pose.arm_r, -1.0f32), (pose.arm_l, 1.0)] {
            let sho = nb + V(sx * 0.165, -0.030, 0.010);
            let j = chain(sho, &[(L_UARM, arm[0]), (L_FARM, arm[1]), (L_HAND, arm[2])]);
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
    let stature = 0.96 + 0.08 * rnd(seed, 0);

    p.spawn((Transform::from_scale(Vec3::splat(stature)), Visibility::default()))
        .with_children(|b| {
            spawn_body(b, &pose, kit, seed);
            if kind == "drummer" {
                // The stool is the one thing that must scale WITH the player,
                // or a tall drummer floats above their own seat.
                part(b, &kit.cyl, &kit.cloth, V(0.340, 0.055, 0.340), V(0.0, 0.473, -0.420), Quat::IDENTITY);
                part(b, &kit.cyl, &kit.metal, V(0.055, 0.400, 0.055), V(0.0, 0.245, -0.420), Quat::IDENTITY);
                for k in 0..3 {
                    let t = std::f32::consts::FRAC_PI_2 + k as f32 * std::f32::consts::TAU / 3.0;
                    strut(b, &kit.cyl, &kit.metal, V(0.0, 0.290, -0.420),
                          V(0.160 * t.cos(), 0.020, -0.420 + 0.160 * t.sin()), 0.028);
                }
            }
        });

    match kind {
        "vocalist" => {
            // The column stands where the GRIPPING HAND is, not on the centre
            // line. The hand closes at (-0.098, 1.314, 0.335); a stand at x = 0
            // left it holding air ten centimetres to one side, which is the
            // kind of thing you do not see until you look at one figure close
            // up and then cannot stop seeing.
            const X: f32 = -0.098;
            const Z: f32 = 0.335;
            part(p, &kit.cyl, &kit.metal, V(0.280, 0.024, 0.280), V(X, 0.012, Z), Quat::IDENTITY);
            part(p, &kit.cyl, &kit.metal, V(0.022, 1.470, 0.022), V(X, 0.735, Z), Quat::IDENTITY);
            part(p, &kit.cyl, &kit.metal, V(0.048, 0.170, 0.048), V(X + 0.012, 1.530, Z - 0.022), Quat::from_rotation_x(-0.34));
            part(p, &kit.ball, &kit.cloth, Vec3::splat(0.075), V(X + 0.026, 1.602, Z - 0.070), Quat::IDENTITY);
        }
        "guitarist" => {
            part(p, &kit.ball, &kit.wood, V(0.340, 0.420, 0.110), V(-0.100, 1.000, 0.235),
                 Quat::from_rotation_z(-0.30) * Quat::from_rotation_x(-0.22));
            let (a, b) = (V(0.055, 1.085, 0.205), V(0.635, 1.310, 0.115));
            strut(p, &kit.cube, &kit.wood, a, b, 0.052);
            let neck_rot = bone(a, b).rotation;
            part(p, &kit.cube, &kit.wood, V(0.075, 0.170, 0.020), V(0.663, 1.320, 0.111),
                 neck_rot * Quat::from_rotation_x(0.20));
        }
        "bassist" => {
            part(p, &kit.ball, &kit.wood, V(0.300, 0.380, 0.105), V(-0.120, 0.905, 0.215),
                 Quat::from_rotation_z(-0.16) * Quat::from_rotation_x(-0.16));
            let (a, b) = (V(0.040, 0.960, 0.190), V(0.760, 1.180, 0.100));
            strut(p, &kit.cube, &kit.wood, a, b, 0.058);
            let neck_rot = bone(a, b).rotation;
            part(p, &kit.cube, &kit.wood, V(0.095, 0.230, 0.022), V(0.805, 1.194, 0.095),
                 neck_rot * Quat::from_rotation_x(0.20));
        }
        "keyboardist" => {
            part(p, &kit.cube, &kit.cloth, V(1.150, 0.090, 0.340), V(0.0, 0.910, 0.390), Quat::from_rotation_x(-0.09));
            part(p, &kit.cube, &kit.cloth, V(0.900, 0.070, 0.280), V(0.0, 1.150, 0.560), Quat::from_rotation_x(-0.14));
            for r in [-0.24f32, 0.24] {
                part(p, &kit.cube, &kit.metal, V(0.038, 0.960, 0.038), V(0.0, 0.455, 0.390), Quat::from_rotation_z(r));
            }
            part(p, &kit.cube, &kit.metal, V(0.900, 0.035, 0.035), V(0.0, 0.018, 0.390), Quat::IDENTITY);
        }
        "drummer" => spawn_kit(p, kit, &pose, stature),
        _ => {}
    }
}

/// The drum kit. Everything except the stool is in the ROOT frame, so it stays
/// the same size whatever height the player is.
fn spawn_kit(p: &mut ChildSpawnerCommands, kit: &Kit, pose: &Pose, stature: f32) {
    let hp = std::f32::consts::FRAC_PI_2;
    part(p, &kit.cyl, &kit.wood, V(0.560, 0.460, 0.560), V(0.0, 0.290, 0.180), Quat::from_rotation_x(hp));
    part(p, &kit.cube, &kit.metal, V(0.100, 0.030, 0.240), V(-0.060, 0.020, 0.030), Quat::IDENTITY);
    part(p, &kit.cyl, &kit.metal, V(0.360, 0.150, 0.360), V(0.240, 0.610, -0.030), Quat::from_rotation_x(-0.14));
    part(p, &kit.cyl, &kit.metal, V(0.032, 0.540, 0.032), V(0.240, 0.270, -0.030), Quat::IDENTITY);
    part(p, &kit.cyl, &kit.wood, V(0.260, 0.240, 0.260), V(-0.150, 0.790, 0.120), Quat::from_rotation_x(0.34));
    part(p, &kit.cyl, &kit.wood, V(0.300, 0.260, 0.300), V(0.155, 0.800, 0.150), Quat::from_rotation_x(0.30));
    part(p, &kit.cyl, &kit.wood, V(0.360, 0.400, 0.360), V(-0.480, 0.320, -0.060), Quat::IDENTITY);
    for k in 0..3 {
        let t = k as f32 * std::f32::consts::TAU / 3.0;
        strut(p, &kit.cyl, &kit.metal, V(-0.480, 0.300, -0.060),
              V(-0.480 + 0.160 * t.cos(), 0.010, -0.060 + 0.160 * t.sin()), 0.020);
    }
    // Cymbals are 0.020 thick, not 0.015. SpotLight's shadow_depth_bias is a
    // flat 0.02 m along the light vector, so a disc thinner than that drops its
    // own shadow — the cymbal would be lit but cast nothing.
    for (y, d) in [(0.840f32, 0.360f32), (0.878, 0.360)] {
        part(p, &kit.cyl, &kit.brass, V(d, 0.020, d), V(0.480, y, 0.100), Quat::IDENTITY);
    }
    part(p, &kit.cyl, &kit.metal, V(0.026, 0.860, 0.026), V(0.480, 0.430, 0.100), Quat::IDENTITY);
    part(p, &kit.cube, &kit.metal, V(0.090, 0.030, 0.220), V(0.470, 0.020, -0.020), Quat::IDENTITY);
    part(p, &kit.cyl, &kit.brass, V(0.400, 0.020, 0.400), V(-0.660, 1.340, 0.060), Quat::from_rotation_z(0.20));
    part(p, &kit.cyl, &kit.metal, V(0.028, 1.320, 0.028), V(-0.660, 0.660, 0.060), Quat::IDENTITY);
    part(p, &kit.cyl, &kit.brass, V(0.500, 0.020, 0.500), V(0.560, 1.140, 0.240), Quat::from_rotation_z(-0.16));
    part(p, &kit.cyl, &kit.metal, V(0.028, 1.130, 0.028), V(0.560, 0.565, 0.240), Quat::IDENTITY);

    // Sticks, aimed from the hands at what each hand is about to hit. The tip
    // overshoots the drum, which is what a real stick does.
    let n = |v: Vec3| v.try_normalize().unwrap_or(Vec3::Y);
    let waist = pose.pelvis + n(pose.lumbar) * L_LUMBAR;
    let nb = waist + n(pose.thorax) * L_THORAX;
    for (arm, sx, target) in [
        (pose.arm_r, -1.0f32, V(-0.660, 1.340, 0.060)),
        (pose.arm_l, 1.0, V(0.240, 0.610, -0.030)),
    ] {
        let sho = nb + V(sx * 0.165, -0.030, 0.010);
        let j = chain(sho, &[(L_UARM, arm[0]), (L_FARM, arm[1]), (L_HAND, arm[2])]);
        // The hands live under the stature-scaled body node; the kit does not.
        let hand = j[3] * stature;
        strut(p, &kit.cyl, &kit.cloth, hand, hand + n(target - hand) * 0.400, 0.011);
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
        let hip = L_ANKLE + L_SHANK + L_THIGH;
        let vertex = hip + L_LUMBAR + L_THORAX + L_NECK + 0.233;
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
                let hip = pose.pelvis + Vec3::new(sx * HIP_X, 0.0, 0.0);
                let j = chain(hip, &[(L_THIGH, *th), (L_SHANK, *sh)]);
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
            let waist = pose.pelvis + n(pose.lumbar) * L_LUMBAR;
            let nb = waist + n(pose.thorax) * L_THORAX;
            let mut widest: f32 = 0.0;
            for (arm, sx) in [(pose.arm_r, -1.0f32), (pose.arm_l, 1.0)] {
                let sho = nb + Vec3::new(sx * 0.165, -0.030, 0.010);
                let j = chain(sho, &[(L_UARM, arm[0]), (L_FARM, arm[1]), (L_HAND, arm[2])]);
                for p in &j[1..] {
                    widest = widest.max((p.x - pose.pelvis.x).abs());
                }
            }
            assert!(widest >= 0.20, "{kind}: widest arm point only {widest} from the axis");
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
