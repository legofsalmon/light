use bevy::light::{FogVolume, VolumetricLight};
use bevy::prelude::*;
use light_core::cprofile::FixtureForm;
use light_core::profiles::{profile_of, HeadKind};

use crate::protocol::ProjectLite;
use crate::state::Live;

/// Profile metadata from either source: built-in code or imported GDTF data.
/// Heads are (kind, offset along local X, offset up local Y) — the Y offset
/// is B1's 2D pixel layout; built-ins are flat bars.
struct ProfMeta {
    heads: Vec<(HeadKind, f64, f64)>,
    beam_deg: f64,
    /// The 10 % field angle, in degrees — the edge of the usable light.
    field_deg: f64,
    /// Physical emitter radius in metres; keeps the 1/r^2 term finite.
    beam_radius: f64,
    /// Total flux for the whole fixture, in lumens — what the GDTF declares
    /// where it declares one, otherwise a plausible figure for the form.
    lumens: f64,
    /// What shape of fixture this is — the operator's override if they set one,
    /// otherwise inferred. Decides the body mesh, the emitter primitive and the
    /// default flux, none of which the head kinds can answer on their own.
    form: FixtureForm,
    /// The head whose snapshot pan/tilt steers the WHOLE fixture, when the
    /// fixture aims but its emitters are not `Mover` heads.
    ///
    /// A Robin Spiider is a moving head whose emitters are pixels: the compiled
    /// profile is `rgb` heads with Pan/Tilt channels bound to the Base
    /// geometry, which lands on one head (0 in practice). Gating the yoke on
    /// `kind == Mover` left every GDTF-imported mover nailed in place while the
    /// editor set pan/tilt, the snapshot carried it and the real fixture moved.
    /// `None` keeps the built-in behaviour: each Mover head aims by its own
    /// values.
    aim_head: Option<usize>,
}

/// Which head carries this compiled profile's Pan/Tilt channels, if any.
fn aim_head_of(c: &light_core::cprofile::CompiledProfile) -> Option<usize> {
    c.channels
        .iter()
        .find(|ch| {
            ch.cases.iter().any(|case| {
                matches!(
                    case.func,
                    light_core::cprofile::Func::Linear {
                        source: light_core::cprofile::Source::Pan
                            | light_core::cprofile::Source::Tilt
                    }
                )
            })
        })
        .map(|ch| ch.head)
}

fn prof_meta(project: &ProjectLite, id: &str) -> Option<ProfMeta> {
    if let Some(p) = profile_of(id) {
        return Some(ProfMeta {
            heads: p.heads.iter().map(|h| (h.kind, h.offset, 0.0)).collect(),
            beam_deg: p.beam_deg,
            // The built-ins are hand-written and predate the form idea; their
            // head kinds happen to say enough.
            field_deg: p.beam_deg * 1.55,
            beam_radius: 0.035,
            lumens: match p.heads.first().map(|h| h.kind) {
                Some(HeadKind::Derby) => 10_000.0,
                Some(HeadKind::Hazer) => 0.0,
                Some(HeadKind::Mover) => 16_000.0,
                _ if p.heads.len() > 1 => 24_000.0,
                _ => 9_000.0,
            },
            form: match p.heads.first().map(|h| h.kind) {
                Some(HeadKind::Derby) => FixtureForm::Derby,
                Some(HeadKind::Hazer) => FixtureForm::Hazer,
                Some(HeadKind::Mover) => FixtureForm::Mover,
                _ if p.heads.len() > 1 => FixtureForm::Bar,
                _ => FixtureForm::Par,
            },
            aim_head: None,
        });
    }
    project.profiles.get(id).map(|c| ProfMeta {
        heads: c.heads.iter().map(|h| (h.kind, h.offset, h.offset_y)).collect(),
        beam_deg: c.beam_deg,
        form: c.form(),
        field_deg: c.field_deg(),
        beam_radius: c.beam_radius.unwrap_or(0.035),
        lumens: c.lumens_or_guess(),
        // only when no head is a Mover already — those steer themselves
        aim_head: if c.heads.iter().any(|h| h.kind == HeadKind::Mover) {
            None
        } else {
            aim_head_of(c)
        },
    })
}

impl ProfMeta {
    /// Width across the fixture's own cells, in metres.
    fn span(&self) -> f64 {
        let (mut lo, mut hi) = (f64::INFINITY, f64::NEG_INFINITY);
        for (_, x, _) in &self.heads {
            lo = lo.min(*x);
            hi = hi.max(*x);
        }
        if hi >= lo { hi - lo } else { 0.0 }
    }
}

#[derive(Component)]
pub struct FixtureRoot;

#[derive(Component, Clone)]
pub struct HeadTag {
    pub fixture: String,
    pub head: usize,
    #[allow(dead_code)] // used once movers/GDTF land
    pub kind: HeadKind,
}

/// A beam spotlight; `idx` selects the derby macro component colour, `lumens`
/// is the full-intensity output for this beam.
#[derive(Component)]
pub struct BeamLight {
    pub idx: usize,
    pub lumens: f32,
    /// The profile's own beam half-angle, in radians — what zoom deflects from.
    pub base_outer: f32,
}

#[derive(Component)]
pub struct SourceGlow;

/// The single area light standing in for a whole panel's face.
///
/// `heads` is how many cells the fixture has, so the update pass can average
/// them into one colour; `lumens` is the fixture's total output, not one
/// cell's.
#[derive(Component)]
pub struct PanelLight {
    pub heads: usize,
    pub lumens: f32,
}

/// Luminous flux for one head, in lumens — real numbers for real fixtures.
///
/// A Robe Spiider is about 12,000 lm, an Ayrton profile about 22,000, an LED
/// blinder tens of thousands across its whole face, one derby lens a couple of
/// thousand. Nothing here is exact — the compiled profile does not carry flux
/// yet, and GDTF's `LuminousFlux` is discarded at import — but they are the
/// right ORDER, which the old hardcoded 8,000,000 was not by three of them.
///
/// When the importer starts keeping LuminousFlux this becomes the fallback for
/// profiles that lack it, rather than the answer for every fixture.
fn lumens_for(prof: &ProfMeta, per_head: bool) -> f32 {
    if prof.form == FixtureForm::Hazer {
        return 0.0;
    }
    let total = prof.lumens as f32;
    // A fixture's declared flux is its WHOLE output. Split it between the
    // emitters that actually draw a beam, or a 14-cell blinder is fourteen
    // blinders. A derby is the exception the other way: its six lenses share
    // one lamp, which is already what the total describes.
    if per_head {
        total / prof.heads.len().max(1) as f32
    } else {
        total
    }
}

/// Additive translucent beam cone — the visible shaft. Volumetric light-shaft
/// sampling is broken on this Bevy/Metal combination (ambient fog scattering
/// renders, per-light shafts never do), so shafts are honest cone geometry,
/// energy-modulated by live haze. The FogVolume still supplies the ambient
/// haze bed, and VolumetricLight stays on the spots in case a future Bevy
/// makes real shafts work — they would simply add on top.
#[derive(Component)]
pub struct BeamCone {
    /// The scale this hull was spawned with, at the profile's field angle.
    /// Zoom rescales laterally from here; a mover's length is recomputed each
    /// frame and multiplies in on top.
    pub base_scale: Vec3,
    /// The profile's field half-angle, in radians — what zoom deflects from.
    pub base_field: f32,
    /// Emitter radius in metres: the term that keeps 1/r^2 finite when the
    /// camera looks straight down the barrel.
    pub r0: f32,
    /// Shaft length in metres, so the shader knows where the beam stops.
    pub length_m: f32,
}


#[derive(Component)]
pub struct RingMesh;

/// Root of the dummy band — human-scale primitive figures for judging throw
/// distances and how looks actually land on people. Toggle with M.
#[derive(Component)]
pub struct BandRoot;

/// The light-catching back wall, repositioned behind the deepest geometry.
#[derive(Component)]
pub struct Backdrop;

/// The stage floor, grown to cover whatever the plot actually spans.
#[derive(Component)]
pub struct Floor;

/// The haze volume, grown to enclose the rig — beams outside it do not scatter.
#[derive(Component)]
pub struct HazeVolume;

/// The demo scene is sized for a club stage: a 16 x 12 m floor, a wall 2 m
/// upstage, and haze around head height. A real plot can be an order of
/// magnitude bigger — a festival MVR loaded here spans 37 m across and hangs at
/// 10 m — and against that the fixed scenery reads as a wall dropped through the
/// middle of the stage, with the haze sitting below every fixture. So the
/// backdrop is fitted to the rig on every rebuild.
#[derive(Clone, Copy)]
struct Bounds {
    min: Vec3,
    max: Vec3,
}

impl Bounds {
    fn of(project: &crate::protocol::ProjectLite) -> Option<Bounds> {
        let mut min = Vec3::splat(f32::INFINITY);
        let mut max = Vec3::splat(f32::NEG_INFINITY);
        let mut any = false;
        for f in &project.fixtures {
            min = min.min(Vec3::new(f.pos.x, f.pos.y, f.pos.z));
            max = max.max(Vec3::new(f.pos.x, f.pos.y, f.pos.z));
            any = true;
        }
        for pr in &project.props {
            // a rotated prop can reach further than its centre in either axis
            let reach = pr.size.map_or(0.5, |s| s.w.max(s.d) * 0.5);
            let top = pr.y.unwrap_or(0.0) + pr.size.map_or(1.8, |s| s.h);
            min = min.min(Vec3::new(pr.pos.x - reach, 0.0, pr.pos.z - reach));
            max = max.max(Vec3::new(pr.pos.x + reach, top, pr.pos.z + reach));
            any = true;
        }
        any.then_some(Bounds { min, max })
    }
}

#[derive(Component)]
pub struct DerbyFan;

/// A moving head's beam: aimed by the live pan/tilt rather than fixed to the
/// mounting direction. `rest` is the mounting aim the axes deflect from.
/// Ranges are the usual moving-head travel; GDTF carries the real physical
/// values but the compiled profile does not surface them yet.
#[derive(Component)]
pub struct MoverHead {
    /// Which snapshot head steers this beam. Its own, for a Mover head; the
    /// fixture's Pan/Tilt-bearing head for a pixel mover, whose other pixels
    /// sit at a default 0.5 and would otherwise freeze half the fixture.
    pub aim_head: usize,
    pub rest: Quat,
    pub pan_range: f32,
    pub tilt_range: f32,
    /// World rotation of the fixture root. Fixtures only move on a rebuild, so
    /// capturing it at spawn is exact and avoids a GlobalTransform round-trip.
    pub root_rot: Quat,
    /// Height this head is rigged at — the other half of the floor intersection.
    pub height: f32,
    /// Beam half-angle, so the cone keeps its spread when its length changes.
    pub outer: f32,
    /// Longest shaft to draw, from the fitted rig bounds.
    pub max_throw: f32,
}

pub fn setup_stage(
    mut commands: Commands,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
) {
    // stage floor — glossy dark so beams throw specular pools
    commands.spawn((
        Floor,
        Mesh3d(meshes.add(Plane3d::default().mesh().size(16.0, 12.0))),
        MeshMaterial3d(materials.add(StandardMaterial {
            base_color: Color::srgb(0.055, 0.055, 0.065),
            perceptual_roughness: 0.22,
            metallic: 0.65,
            reflectance: 0.55,
            ..default()
        })),
        Transform::from_xyz(0.0, 0.0, 1.0),
    ));

    // Back wall to catch light. It is a lighting aid, not part of the plot, so
    // it gets pushed behind whatever the project actually places — a fixed wall
    // at z = -2 sits in the middle of any stage deeper than the demo one.
    commands.spawn((
        Backdrop,
        Mesh3d(meshes.add(Plane3d::default().mesh().size(16.0, 7.0))),
        MeshMaterial3d(materials.add(StandardMaterial {
            base_color: Color::srgb(0.05, 0.05, 0.06),
            perceptual_roughness: 0.9,
            ..default()
        })),
        Transform::from_xyz(0.0, 3.5, -2.0).with_rotation(Quat::from_rotation_x(std::f32::consts::FRAC_PI_2)),
    ));

    // participating medium — density driven live by the engine's haze value.
    // Stage haze scatters close to isotropically: the default forward-biased
    // asymmetry (0.5) makes side-on beams nearly invisible from FOH.
    commands.spawn((
        HazeVolume,
        FogVolume {
            density_factor: 0.08,
            scattering: 0.65,
            scattering_asymmetry: 0.15,
            light_intensity: 2.0,
            ..default()
        },
        Transform::from_xyz(0.0, 3.0, 1.0).with_scale(Vec3::new(16.0, 7.0, 13.0)),
    ));
}

/// Grow the floor, the back wall and the haze volume to enclose the rig.
///
/// Everything is scaled rather than re-meshed: the floor and wall are unit-ish
/// planes and the haze is a scaled cube, so this costs three transform writes
/// per rebuild instead of three mesh uploads.
fn fit_backdrop(
    oversize: f32,
    project: &crate::protocol::ProjectLite,
    backdrop: &mut Query<&mut Transform, (With<Backdrop>, Without<Floor>, Without<HazeVolume>)>,
    floor: &mut Query<&mut Transform, (With<Floor>, Without<Backdrop>, Without<HazeVolume>)>,
    haze: &mut Query<&mut Transform, (With<HazeVolume>, Without<Backdrop>, Without<Floor>)>,
) {
    // An empty project keeps the demo scene exactly as it was.
    let Some(b) = Bounds::of(project) else { return };

    // Never shrink below the demo scene — a two-fixture test rig in a 16 m room
    // still wants a room.
    const MARGIN: f32 = 3.0;
    let width = (b.max.x - b.min.x + MARGIN * 2.0).max(16.0);
    let depth = (b.max.z - b.min.z + MARGIN * 2.0).max(12.0);
    let height = (b.max.y + MARGIN).max(7.0);
    let cx = (b.min.x + b.max.x) * 0.5;
    let cz = (b.min.z + b.max.z) * 0.5;

    // floor: the base mesh is 16 x 12 in XZ
    if let Ok(mut t) = floor.single_mut() {
        t.scale.x = width / 16.0;
        t.scale.z = depth / 12.0;
        t.translation.x = cx;
        t.translation.z = cz;
    }

    // wall: base mesh 16 x 7, rotated upright, so local z is world height
    if let Ok(mut t) = backdrop.single_mut() {
        t.scale.x = width / 16.0;
        t.scale.z = height / 7.0;
        t.translation.x = cx;
        t.translation.y = height * 0.5;
        t.translation.z = b.min.z - MARGIN;
    }

    // Haze. A beam only scatters inside this volume, so it has to reach the
    // fixtures — on an arena plot they hang three times higher than the demo.
    //
    // It is also deliberately BIGGER than the room. Sized exactly to the room,
    // the box's six faces are a hard on/off boundary for scattering: beams
    // brighten and dim as they cross it and the whole image shifts as the
    // camera orbits through it, which reads as invisible walls in a room that
    // only has one. Oversizing pushes those faces outside the shot. The cost is
    // sampling density, not time — the raymarch is a fixed step count across
    // whatever it spans — which is why the step count went up with it.
    if let Ok(mut t) = haze.single_mut() {
        let k = oversize;
        t.scale = Vec3::new(width * k, height * k, depth * k);
        t.translation = Vec3::new(cx, height * 0.5, cz);
    }
}

/// Dummy musicians: capsule-and-sphere figures at real human scale
/// (~1.75 m standing), matte cloth and skin so pools, shafts, and colour
/// read on them the way they will on the actual band. Spawned from the
/// project's placed props (2D plan: "+ musician…", drag to move,
/// double-click to remove). Press M in this window to show/hide them all.
fn spawn_props(
    commands: &mut Commands,
    meshes: &mut Assets<Mesh>,
    materials: &mut Assets<StandardMaterial>,
    props: &[crate::protocol::PropLite],
) {
    let cloth = materials.add(StandardMaterial {
        base_color: Color::srgb(0.14, 0.14, 0.16),
        perceptual_roughness: 0.92,
        ..default()
    });
    let skin = materials.add(StandardMaterial {
        base_color: Color::srgb(0.62, 0.47, 0.38),
        perceptual_roughness: 0.75,
        ..default()
    });
    let wood = materials.add(StandardMaterial {
        base_color: Color::srgb(0.35, 0.12, 0.10),
        perceptual_roughness: 0.55,
        ..default()
    });
    let metal = materials.add(StandardMaterial {
        base_color: Color::srgb(0.55, 0.55, 0.6),
        metallic: 0.85,
        perceptual_roughness: 0.35,
        ..default()
    });
    let brass = materials.add(StandardMaterial {
        base_color: Color::srgb(0.71, 0.58, 0.28),
        metallic: 0.9,
        perceptual_roughness: 0.3,
        ..default()
    });

    // structure reads as aluminium and stage deck, matching the in-window previz
    let truss_struct = materials.add(StandardMaterial {
        base_color: Color::srgb(0.22, 0.22, 0.25),
        perceptual_roughness: 0.5,
        metallic: 0.9,
        ..default()
    });
    let deck = materials.add(StandardMaterial {
        base_color: Color::srgb(0.10, 0.10, 0.12),
        perceptual_roughness: 0.85,
        ..default()
    });
    let panel = materials.add(StandardMaterial {
        base_color: Color::srgb(0.03, 0.03, 0.04),
        perceptual_roughness: 0.35,
        metallic: 0.1,
        ..default()
    });

    let legs_mesh = meshes.add(Capsule3d::new(0.13, 0.55));
    let torso_mesh = meshes.add(Capsule3d::new(0.17, 0.40));
    let head_mesh = meshes.add(Sphere::new(0.11));

    for pr in props {
        let root = commands
            .spawn((
                BandRoot,
                Transform::from_xyz(pr.pos.x, 0.0, pr.pos.z)
                    .with_rotation(Quat::from_rotation_y(pr.rot_y.unwrap_or(0.0))),
                Visibility::default(),
            ))
            .id();
        commands.entity(root).with_children(|p| {
            let standing = |p: &mut ChildSpawnerCommands| {
                p.spawn((Mesh3d(legs_mesh.clone()), MeshMaterial3d(cloth.clone()), Transform::from_xyz(0.0, 0.5, 0.0)));
                p.spawn((Mesh3d(torso_mesh.clone()), MeshMaterial3d(cloth.clone()), Transform::from_xyz(0.0, 1.17, 0.0)));
                p.spawn((Mesh3d(head_mesh.clone()), MeshMaterial3d(skin.clone()), Transform::from_xyz(0.0, 1.62, 0.0)));
            };
            match pr.kind.as_str() {
                "vocalist" => {
                    standing(p);
                    p.spawn((
                        Mesh3d(meshes.add(Cylinder::new(0.013, 1.55))),
                        MeshMaterial3d(metal.clone()),
                        Transform::from_xyz(0.3, 0.775, 0.25),
                    ));
                    p.spawn((
                        Mesh3d(meshes.add(Sphere::new(0.04))),
                        MeshMaterial3d(cloth.clone()),
                        Transform::from_xyz(0.3, 1.56, 0.25),
                    ));
                }
                "guitarist" | "bassist" => {
                    standing(p);
                    p.spawn((
                        Mesh3d(meshes.add(Cuboid::new(0.32, 0.9, 0.09))),
                        MeshMaterial3d(wood.clone()),
                        Transform::from_xyz(0.0, 1.0, 0.22)
                            .with_rotation(Quat::from_rotation_z(0.55)),
                    ));
                }
                "keyboardist" => {
                    standing(p);
                    p.spawn((
                        Mesh3d(meshes.add(Cuboid::new(1.15, 0.09, 0.32))),
                        MeshMaterial3d(cloth.clone()),
                        Transform::from_xyz(0.0, 0.93, 0.35),
                    ));
                    for dx in [-0.45f32, 0.45] {
                        p.spawn((
                            Mesh3d(meshes.add(Cuboid::new(0.05, 0.9, 0.05))),
                            MeshMaterial3d(metal.clone()),
                            Transform::from_xyz(dx, 0.45, 0.35),
                        ));
                    }
                }
                "drummer" => {
                    // seated: stool + shorter stack, kit facing local +Z
                    p.spawn((Mesh3d(meshes.add(Cylinder::new(0.16, 0.45))), MeshMaterial3d(cloth.clone()), Transform::from_xyz(0.0, 0.225, -0.45)));
                    p.spawn((Mesh3d(torso_mesh.clone()), MeshMaterial3d(cloth.clone()), Transform::from_xyz(0.0, 0.85, -0.45)));
                    p.spawn((Mesh3d(head_mesh.clone()), MeshMaterial3d(skin.clone()), Transform::from_xyz(0.0, 1.3, -0.45)));
                    p.spawn((
                        Mesh3d(meshes.add(Cylinder::new(0.28, 0.45))),
                        MeshMaterial3d(wood.clone()),
                        Transform::from_xyz(0.0, 0.28, 0.15)
                            .with_rotation(Quat::from_rotation_x(std::f32::consts::FRAC_PI_2)),
                    ));
                    p.spawn((
                        Mesh3d(meshes.add(Cylinder::new(0.17, 0.14))),
                        MeshMaterial3d(metal.clone()),
                        Transform::from_xyz(-0.32, 0.55, -0.15),
                    ));
                    for (cx, cy) in [(-0.5f32, 1.15f32), (0.5, 1.05)] {
                        p.spawn((
                            Mesh3d(meshes.add(Cylinder::new(0.19, 0.015))),
                            MeshMaterial3d(brass.clone()),
                            Transform::from_xyz(cx, cy, -0.05)
                                .with_rotation(Quat::from_rotation_z(0.08)),
                        ));
                        p.spawn((
                            Mesh3d(meshes.add(Cylinder::new(0.012, cy))),
                            MeshMaterial3d(metal.clone()),
                            Transform::from_xyz(cx, cy / 2.0, -0.05),
                        ));
                    }
                }
                // ---- structure ------------------------------------------
                // Boxes, not detailed trussing: these exist so a beam has
                // something to land on and so the operator can judge blocking.
                // Sized from the project, so this view and the in-window previz
                // describe the same stage.
                "trussBar" | "trussLeg" => {
                    let (w, h, d) = size_of(pr, 7.0, 0.3, 0.3);
                    p.spawn((
                        Mesh3d(meshes.add(Cuboid::new(w, h, d))),
                        MeshMaterial3d(truss_struct.clone()),
                        Transform::from_xyz(0.0, pr.y.unwrap_or(0.0) + h / 2.0, 0.0),
                    ));
                }
                "riser" => {
                    let (w, h, d) = size_of(pr, 2.0, 0.4, 1.5);
                    p.spawn((
                        Mesh3d(meshes.add(Cuboid::new(w, h, d))),
                        MeshMaterial3d(deck.clone()),
                        Transform::from_xyz(0.0, pr.y.unwrap_or(0.0) + h / 2.0, 0.0),
                    ));
                }
                "screen" => {
                    let (w, h, d) = size_of(pr, 4.0, 2.25, 0.12);
                    p.spawn((
                        Mesh3d(meshes.add(Cuboid::new(w, h, d))),
                        MeshMaterial3d(panel.clone()),
                        Transform::from_xyz(0.0, pr.y.unwrap_or(0.5) + h / 2.0, 0.0),
                    ));
                }
                _ => standing(p),
            }
        });
    }
}

/// A structural prop's dimensions, falling back to the same defaults the shared
/// types use when a project predates the size field.
fn size_of(pr: &crate::protocol::PropLite, w: f32, h: f32, d: f32) -> (f32, f32, f32) {
    match pr.size {
        Some(s) if s.w > 0.0 && s.h > 0.0 && s.d > 0.0 => (s.w, s.h, s.d),
        _ => (w, h, d),
    }
}

/// M toggles the dummy band.
pub fn toggle_band(
    keys: Res<ButtonInput<KeyCode>>,
    mut band: Query<&mut Visibility, With<BandRoot>>,
) {
    if keys.just_pressed(KeyCode::KeyM) {
        for mut v in &mut band {
            *v = if matches!(*v, Visibility::Hidden) {
                Visibility::Inherited
            } else {
                Visibility::Hidden
            };
        }
    }
}

/// Rebuild fixture entities whenever the patch changes.
pub fn rebuild_fixtures(
    mut commands: Commands,
    mut live: ResMut<Live>,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
    mut beam_mats: ResMut<Assets<crate::beam::BeamMaterial>>,
    existing: Query<Entity, With<FixtureRoot>>,
    existing_props: Query<Entity, With<BandRoot>>,
    mut backdrop: Query<&mut Transform, (With<Backdrop>, Without<Floor>, Without<HazeVolume>)>,
    mut floor: Query<&mut Transform, (With<Floor>, Without<Backdrop>, Without<HazeVolume>)>,
    mut haze: Query<&mut Transform, (With<HazeVolume>, Without<Backdrop>, Without<Floor>)>,
    q: Res<crate::quality::Quality>,
) {
    if live.project_rev == live.built_rev {
        return;
    }
    live.built_rev = live.project_rev;
    eprintln!("[previz] scene rebuild #{} ", live.project_rev);
    for e in &existing {
        commands.entity(e).despawn();
    }
    for e in &existing_props {
        commands.entity(e).despawn();
    }
    let Some(project) = live.project.clone() else { return };

    fit_backdrop(q.haze_oversize, &project, &mut backdrop, &mut floor, &mut haze);

    spawn_props(&mut commands, &mut meshes, &mut materials, &project.props);

    let body_mat = materials.add(StandardMaterial {
        base_color: Color::srgb(0.16, 0.16, 0.18),
        perceptual_roughness: 0.6,
        metallic: 0.4,
        ..default()
    });
    // The proxy hull the beam shader integrates inside. Cut at the FIELD
    // angle, not the beam angle: the soft shoulder lives out there, and sizing
    // the geometry to the core would clip it back to a hard silhouette — the
    // exact defect the shader exists to remove.
    let cone_mesh = meshes.add(crate::beam::unit_cone_hull());

    // Every shadow-casting spotlight costs its own depth pass, so cost grows
    // with rig size, not with what you can see: 10 bars + 4 derbies is 64 of
    // them and the previz falls to ~13 fps. Shadows are what sells the beams
    // landing on people, so keep them — but only for a fixed budget of main
    // heads. Derby sub-beams never get one: six narrow spinning beams per
    // fixture is where the cost explodes and where a shadow map buys nothing.
    let mut shadow_budget: usize = q.shadows;

    // Beam reach, sized to the room rather than to the demo stage. The shaft
    // clamp used to be a hard 9 m and spotlight range a hard 11-12 m — fine for
    // a club, wrong for an arena plot: heads at 10 m trim throw ~10.7 m to the
    // deck, so every shaft stopped ~1.5 m in mid-air, and any pool more than
    // 12 m away simply was not lit, which reads as "the looks are broken" when
    // the data is correct. Never smaller than the old constants, so a small rig
    // looks exactly as it did.
    let (max_throw, light_range) = match Bounds::of(&project) {
        Some(b) => {
            let size = b.max - b.min;
            let diag = (size.x * size.x + size.y * size.y + size.z * size.z).sqrt();
            // publish it so the camera can frame the same rig
            live.rig_extent = Some(crate::state::RigExtent { diag, height: b.max.y });
            ((b.max.y + 2.0).max(9.0), diag.max(12.0))
        }
        None => {
            live.rig_extent = None;
            (9.0, 12.0)
        }
    };

    for f in &project.fixtures {
        let Some(prof) = prof_meta(&project, &f.profile_id) else { continue };
        // Pixel strips (imported multi-pixel fixtures): each pixel renders as
        // an emissive source, not a shadow-casting volumetric spotlight — 64
        // shadowed lights would crush the GPU for zero visual gain.
        let pixel_strip = prof.heads.len() > 4 && prof.heads.iter().all(|h| h.0 == HeadKind::Rgb);
        // yaw, then mounting tilt, then roll — tilt/roll compose on the
        // kind's default aim so a bar can be pointed exactly where it hangs
        let root_tf = Transform::from_xyz(f.pos.x, f.pos.y, f.pos.z).with_rotation(
            Quat::from_euler(
                EulerRot::YXZ,
                f.rot_y,
                f.rot_x.unwrap_or(0.0),
                f.rot_z.unwrap_or(0.0),
            ),
        );
        let root = commands
            .spawn((FixtureRoot, root_tf, Visibility::default()))
            .id();

        // body
        // Sized by FORM, not by head count. A CLF Nero has 1, 7 or 14 cells
        // depending on its mode and is the same 41 x 32 x 17 cm plate in all of
        // them — under the old rule it was a 16 cm cube in one mode and a
        // 1.06 m bar in another.
        let body = match prof.form {
            FixtureForm::Derby => Cuboid::new(0.26, 0.2, 0.2),
            FixtureForm::Hazer => Cuboid::new(0.34, 0.26, 0.26),
            // Wide enough to hold its cells, and deep enough to read as a box
            // rather than a card when the camera comes round the side.
            FixtureForm::Panel => {
                let w = (prof.span() + 0.16).max(0.34) as f32;
                Cuboid::new(w, (w * 0.78).min(0.42), 0.17)
            }
            FixtureForm::Bar => Cuboid::new((prof.span() + 0.1).max(0.5) as f32, 0.09, 0.09),
            FixtureForm::Strobe => Cuboid::new(0.36, 0.24, 0.16),
            FixtureForm::Mover => Cuboid::new(0.16, 0.14, 0.16),
            FixtureForm::Par => Cuboid::new(0.16, 0.14, 0.16),
        };
        // A blinder plate is an AREA emitter: a 41 x 32 cm face throwing 117
        // degrees, which a cone models badly in both directions — too directional
        // near the fixture, and a hard elliptical edge where there should be a
        // soft square-ish wash. Bevy 0.19 has the right primitive.
        //
        // One light for the whole fixture rather than one per cell. The spill
        // from a plate really is a single area source at any distance you can
        // see it from; the per-cell structure lives on the face, which the
        // emissive glows already draw. It is also the difference between 24
        // lights and 336 on this rig.
        if prof.form == FixtureForm::Panel {
            let (bw, bh) = (body.half_size.x * 2.0, body.half_size.y * 2.0);
            // A RectLight lies in its local XY plane and faces local -Z, so it
            // needs aiming exactly like a spot does. Left at identity it faces
            // whatever the fixture root faces, which for anything hung on a bar
            // is not where the fixture is pointed.
            let face = if f.pos.y > 1.2 {
                Vec3::new(0.0, -0.93, 0.37)
            } else {
                Vec3::new(0.0, -0.26, 0.97)
            };
            commands.entity(root).with_children(|p| {
                p.spawn((
                    HeadTag { fixture: f.id.clone(), head: 0, kind: HeadKind::Rgb },
                    PanelLight {
                        heads: prof.heads.len(),
                        lumens: lumens_for(&prof, false) * q.lumen_scale,
                    },
                    RectLight {
                        color: Color::BLACK,
                        intensity: 0.0,
                        range: light_range,
                        width: bw,
                        height: bh,
                        ..default()
                    },
                    Transform::default().looking_to(face, Vec3::Y),
                    Visibility::Hidden,
                ));
            });
        }

        commands.entity(root).with_children(|p| {
            p.spawn((
                Mesh3d(meshes.add(body)),
                MeshMaterial3d(body_mat.clone()),
                Transform::default(),
            ));
        });

        for (hi, &(kind, offset, offset_y)) in prof.heads.iter().enumerate() {
            let tag = HeadTag { fixture: f.id.clone(), head: hi, kind };
            let rigged = f.pos.y > 1.2;
            let beam_dir = match kind {
                HeadKind::Derby => Vec3::new(0.0, -0.85, 0.52),
                _ if rigged => Vec3::new(0.0, -0.93, 0.37),
                _ => Vec3::new(0.0, -0.26, 0.97),
            };
            let outer = (prof.beam_deg.max(2.0) as f32).to_radians() / 2.0;
            // Field half-angle, and a shoulder beyond it: f_r is non-zero out
            // to roughly 1.15x the field, so the hull has to be at least that
            // wide or a hard triangle edge cuts the soft edge off.
            let field = (prof.field_deg.max(prof.beam_deg) as f32).to_radians() / 2.0 * 1.15;
            // shaft length: throw to the floor along the beam, clamped sane
            let throw = (f.pos.y.max(0.3) / beam_dir.y.abs().max(0.2)).clamp(1.0, max_throw);
            let fr = (throw * field.tan()).max(0.03);
            let field_scale = Vec3::new(fr, fr, throw);

            commands.entity(root).with_children(|p| {
                let mut head = p.spawn((
                    tag.clone(),
                    Transform::from_xyz(offset as f32, offset_y as f32, 0.0),
                    Visibility::default(),
                ));

                head.with_children(|h| {
                    // emissive source for bloom
                    h.spawn((
                        tag.clone(),
                        SourceGlow,
                        Mesh3d(meshes.add(Sphere::new(0.05))),
                        MeshMaterial3d(materials.add(StandardMaterial {
                            base_color: Color::srgb(0.02, 0.02, 0.02),
                            emissive: LinearRgba::BLACK,
                            perceptual_roughness: 1.0,
                            ..default()
                        })),
                        Transform::default(),
                    ));

                    match kind {
                        HeadKind::Derby => {
                            // ring blinder
                            h.spawn((
                                tag.clone(),
                                RingMesh,
                                Mesh3d(meshes.add(Torus::new(0.15, 0.19))),
                                MeshMaterial3d(materials.add(StandardMaterial {
                                    base_color: Color::WHITE,
                                    emissive: LinearRgba::rgb(30.0, 30.0, 28.0),
                                    ..default()
                                })),
                                Transform::default(),
                                Visibility::Hidden,
                            ));
                            // 6-beam fan: aim → spinner → tilted cones
                            h.spawn((
                                Transform::default().looking_to(beam_dir, Vec3::Y),
                                Visibility::default(),
                            ))
                            .with_children(|aim| {
                                aim.spawn((
                                    tag.clone(),
                                    DerbyFan,
                                    Transform::default(),
                                    Visibility::default(),
                                ))
                                .with_children(|fan| {
                                    for k in 0..6 {
                                        let rot = Quat::from_rotation_z(
                                            k as f32 * std::f32::consts::TAU / 6.0,
                                        ) * Quat::from_rotation_x(0.42);
                                        fan.spawn((
                                            tag.clone(),
                                            BeamLight {
                                                idx: k,
                                                lumens: lumens_for(&prof, false) / 6.0 * q.lumen_scale,
                                                base_outer: outer * 0.7,
                                            },
                                            SpotLight {
                                                color: Color::BLACK,
                                                intensity: 0.0,
                                                range: light_range,
                                                radius: 0.02,
                                                inner_angle: outer * 0.6,
                                                outer_angle: outer,
                                                shadow_maps_enabled: false,
                                                ..default()
                                            },
                                            VolumetricLight,
                                            Transform::from_rotation(rot),
                                        ))
                                        .with_children(|c| {
                                            c.spawn((
                                                tag.clone(),
                                                BeamLight {
                                                    idx: k,
                                                    lumens: lumens_for(&prof, false) / 6.0 * q.lumen_scale,
                                                    base_outer: outer * 0.7,
                                                },
                                                BeamCone {
                                                    base_scale: field_scale * Vec3::new(0.7, 0.7, 0.85),
                                                    base_field: field * 0.7,
                                                    r0: prof.beam_radius as f32 * 0.5,
                                                    length_m: throw * 0.85,
                                                },
                                                Mesh3d(cone_mesh.clone()),
                                                MeshMaterial3d(beam_mats.add(crate::beam::BeamMaterial {
                                                    beam: crate::beam::BeamUniform::default(),
                                                })),
                                                Transform::from_scale(field_scale * Vec3::new(0.7, 0.7, 0.85)),
                                            ));
                                        });
                                    }
                                });
                            });
                        }
                        HeadKind::Hazer => {}
                        // A panel's light comes from its whole face. It gets
                        // one RectLight for the fixture, spawned after this
                        // loop — not a cone per cell.
                        _ if prof.form == FixtureForm::Panel => {}
                        _ if pixel_strip => {} // emissive glow only
                        _ => {
                            h.spawn((
                                tag.clone(),
                                BeamLight {
                                    idx: 0,
                                    lumens: lumens_for(&prof, true) * q.lumen_scale,
                                    base_outer: outer,
                                },
                                SpotLight {
                                    color: Color::BLACK,
                                    intensity: 0.0,
                                    range: light_range,
                                    radius: 0.04,
                                    inner_angle: outer * 0.7,
                                    outer_angle: outer,
                                    shadow_maps_enabled: {
                                        let on = shadow_budget > 0;
                                        shadow_budget = shadow_budget.saturating_sub(1);
                                        on
                                    },
                                    ..default()
                                },
                                VolumetricLight,
                                Transform::default().looking_to(beam_dir, Vec3::Y),
                            ))
                            .insert_if(
                                MoverHead {
                                    aim_head: prof.aim_head.unwrap_or(hi),
                                    rest: Transform::default().looking_to(beam_dir, Vec3::Y).rotation,
                                    pan_range: 540f32.to_radians(),
                                    tilt_range: 270f32.to_radians(),
                                    root_rot: root_tf.rotation,
                                    height: f.pos.y,
                                    outer,
                                    max_throw,
                                },
                                // Ask the CHANNELS, not the head kind — see
                                // ProfMeta::aim_head.
                                || kind == HeadKind::Mover || prof.aim_head.is_some(),
                            )
                            .with_children(|c| {
                                c.spawn((
                                    tag.clone(),
                                    BeamLight {
                                        idx: 0,
                                        lumens: lumens_for(&prof, true) * q.lumen_scale,
                                        base_outer: outer,
                                    },
                                    BeamCone {
                                        base_scale: field_scale,
                                        base_field: field,
                                        r0: prof.beam_radius as f32,
                                        length_m: throw,
                                    },
                                    Mesh3d(cone_mesh.clone()),
                                    MeshMaterial3d(beam_mats.add(crate::beam::BeamMaterial {
                                        beam: crate::beam::BeamUniform::default(),
                                    })),
                                    Transform::from_scale(field_scale),
                                ));
                            });
                        }
                    }
                });
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::ProjectLite;

    fn project(json: &str) -> ProjectLite {
        serde_json::from_str(json).expect("ProjectLite should parse")
    }

    #[test]
    fn bounds_cover_an_arena_plot() {
        // The shape that exposed the bug: a festival MVR 37 m across, hung at
        // 10 m and running 7.5 m upstage — against which a wall fixed at z = -2
        // lands in the middle of the stage.
        let p = project(
            r#"{"fixtures":[
                {"id":"a","profileId":"x","pos":{"x":-18.37,"y":7.15,"z":-7.48}},
                {"id":"b","profileId":"x","pos":{"x":18.39,"y":9.93,"z":0.49}}
            ],"props":[],"profiles":{}}"#,
        );
        let b = Bounds::of(&p).expect("two fixtures make bounds");
        assert!((b.min.x - -18.37).abs() < 1e-4);
        assert!((b.max.x - 18.39).abs() < 1e-4);
        assert!((b.max.y - 9.93).abs() < 1e-4);
        assert!((b.min.z - -7.48).abs() < 1e-4);
        // the wall goes behind the deepest fixture, not through the stage
        assert!(b.min.z - 3.0 < -10.0, "backdrop would sit at {}", b.min.z - 3.0);
    }

    #[test]
    fn structural_props_contribute_their_size() {
        let p = project(
            r#"{"fixtures":[],"props":[
                {"id":"s","kind":"screen","pos":{"x":0,"z":-4},"size":{"w":6,"h":3.5,"d":0.2},"y":0.5}
            ],"profiles":{}}"#,
        );
        let b = Bounds::of(&p).expect("a prop alone makes bounds");
        // half of the largest horizontal dimension reaches out from the centre
        assert!((b.min.x - -3.0).abs() < 1e-4, "min.x was {}", b.min.x);
        // base height plus the piece's own height
        assert!((b.max.y - 4.0).abs() < 1e-4, "max.y was {}", b.max.y);
    }

    /// One profile the previz binary cannot understand — a newer engine adding a
    /// Source/Func variant, or plain corruption — must cost that one profile,
    /// not the whole project message and with it the entire stage.
    #[test]
    fn an_unreadable_profile_does_not_discard_the_project() {
        let p = project(
            r#"{"fixtures":[{"id":"a","profileId":"good","pos":{"x":0,"y":3,"z":0}}],
                "props":[],
                "profiles":{
                  "good":{"id":"good","manufacturer":"M","model":"X","mode":"m","footprint":1,
                          "heads":[{"kind":"rgb","offset":0,"label":"h"}],
                          "channels":[],"beamDeg":15,"virtualDimmer":false},
                  "future":{"id":"future","manufacturer":"M","model":"Y","mode":"m","footprint":1,
                          "heads":[{"kind":"rgb","offset":0,"label":"h"}],
                          "channels":[{"offsets":[0],"head":0,"name":"Zoom","default":0,
                                       "cases":[{"cond":{"kind":"always"},"dmxFrom":0,"dmxTo":255,
                                                 "func":{"kind":"linear","source":"tachyonFlux"}}]}],
                          "beamDeg":15,"virtualDimmer":false}
                }}"#,
        );
        // the project survived, the fixture is intact, and the good profile came through
        assert_eq!(p.fixtures.len(), 1, "the project itself must not be discarded");
        assert!(p.profiles.contains_key("good"), "readable profiles are kept");
        assert!(!p.profiles.contains_key("future"), "the unreadable one is skipped");
    }

    #[test]
    fn an_empty_project_has_no_bounds() {
        // nothing placed yet must leave the demo scene alone rather than
        // collapsing the floor to a point
        let p = project(r#"{"fixtures":[],"props":[],"profiles":{}}"#);
        assert!(Bounds::of(&p).is_none());
    }
}
