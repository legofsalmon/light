use bevy::pbr::{FogVolume, VolumetricLight};
use bevy::prelude::*;
use light_core::profiles::{profile_of, HeadKind};

use crate::protocol::ProjectLite;
use crate::state::Live;

/// Profile metadata from either source: built-in code or imported GDTF data.
struct ProfMeta {
    heads: Vec<(HeadKind, f64)>,
    beam_deg: f64,
}

fn prof_meta(project: &ProjectLite, id: &str) -> Option<ProfMeta> {
    if let Some(p) = profile_of(id) {
        return Some(ProfMeta {
            heads: p.heads.iter().map(|h| (h.kind, h.offset)).collect(),
            beam_deg: p.beam_deg,
        });
    }
    project.profiles.get(id).map(|c| ProfMeta {
        heads: c.heads.iter().map(|h| (h.kind, h.offset)).collect(),
        beam_deg: c.beam_deg,
    })
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
}

#[derive(Component)]
pub struct SourceGlow;

/// Additive translucent beam cone — the visible shaft. Volumetric light-shaft
/// sampling is broken on this Bevy/Metal combination (ambient fog scattering
/// renders, per-light shafts never do), so shafts are honest cone geometry,
/// energy-modulated by live haze. The FogVolume still supplies the ambient
/// haze bed, and VolumetricLight stays on the spots in case a future Bevy
/// makes real shafts work — they would simply add on top.
#[derive(Component)]
pub struct BeamCone;

/// Unit beam cone: apex at the origin, opening along -Z to radius 1 at z=-1,
/// with vertex alpha fading apex→base so the shaft dissolves with distance.
fn unit_cone_mesh() -> Mesh {
    use bevy::render::mesh::{Indices, PrimitiveTopology};
    use bevy::render::render_asset::RenderAssetUsages;

    const SEGS: usize = 28;
    let mut positions: Vec<[f32; 3]> = vec![[0.0, 0.0, 0.0]];
    let mut colors: Vec<[f32; 4]> = vec![[1.0, 1.0, 1.0, 0.85]];
    let mut normals: Vec<[f32; 3]> = vec![[0.0, 0.0, 1.0]];
    for i in 0..=SEGS {
        let a = i as f32 / SEGS as f32 * std::f32::consts::TAU;
        positions.push([a.cos(), a.sin(), -1.0]);
        colors.push([1.0, 1.0, 1.0, 0.0]);
        normals.push([0.0, 0.0, 1.0]);
    }
    let mut indices: Vec<u32> = Vec::with_capacity(SEGS * 3);
    for i in 0..SEGS as u32 {
        indices.extend_from_slice(&[0, i + 1, i + 2]);
    }
    Mesh::new(
        PrimitiveTopology::TriangleList,
        RenderAssetUsages::RENDER_WORLD,
    )
    .with_inserted_attribute(Mesh::ATTRIBUTE_POSITION, positions)
    .with_inserted_attribute(Mesh::ATTRIBUTE_COLOR, colors)
    .with_inserted_attribute(Mesh::ATTRIBUTE_NORMAL, normals)
    .with_inserted_indices(Indices::U32(indices))
}

fn cone_material() -> StandardMaterial {
    StandardMaterial {
        base_color: Color::NONE,
        unlit: true,
        alpha_mode: AlphaMode::Add,
        cull_mode: None,
        double_sided: true,
        ..default()
    }
}

#[derive(Component)]
pub struct RingMesh;

/// Root of the dummy band — human-scale primitive figures for judging throw
/// distances and how looks actually land on people. Toggle with M.
#[derive(Component)]
pub struct BandRoot;

#[derive(Component)]
pub struct DerbyFan;

/// A moving head's beam: aimed by the live pan/tilt rather than fixed to the
/// mounting direction. `rest` is the mounting aim the axes deflect from.
/// Ranges are the usual moving-head travel; GDTF carries the real physical
/// values but the compiled profile does not surface them yet.
#[derive(Component)]
pub struct MoverHead {
    pub rest: Quat,
    pub pan_range: f32,
    pub tilt_range: f32,
}

pub fn setup_stage(
    mut commands: Commands,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
) {
    // stage floor — glossy dark so beams throw specular pools
    commands.spawn((
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

    // back wall to catch light
    commands.spawn((
        Mesh3d(meshes.add(Plane3d::default().mesh().size(16.0, 7.0))),
        MeshMaterial3d(materials.add(StandardMaterial {
            base_color: Color::srgb(0.05, 0.05, 0.06),
            perceptual_roughness: 0.9,
            ..default()
        })),
        Transform::from_xyz(0.0, 3.5, -2.0).with_rotation(Quat::from_rotation_x(std::f32::consts::FRAC_PI_2)),
    ));

    // truss
    let truss_mat = materials.add(StandardMaterial {
        base_color: Color::srgb(0.22, 0.22, 0.25),
        perceptual_roughness: 0.5,
        metallic: 0.9,
        ..default()
    });
    commands.spawn((
        Mesh3d(meshes.add(Cuboid::new(7.0, 0.09, 0.09))),
        MeshMaterial3d(truss_mat.clone()),
        Transform::from_xyz(0.0, 3.05, 0.0),
    ));
    for lx in [-3.5f32, 3.5] {
        commands.spawn((
            Mesh3d(meshes.add(Cuboid::new(0.09, 3.05, 0.09))),
            MeshMaterial3d(truss_mat.clone()),
            Transform::from_xyz(lx, 3.05 / 2.0, 0.0),
        ));
    }

    // participating medium — density driven live by the engine's haze value.
    // Stage haze scatters close to isotropically: the default forward-biased
    // asymmetry (0.5) makes side-on beams nearly invisible from FOH.
    commands.spawn((
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
                _ => standing(p),
            }
        });
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
    existing: Query<Entity, With<FixtureRoot>>,
    existing_props: Query<Entity, With<BandRoot>>,
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
    spawn_props(&mut commands, &mut meshes, &mut materials, &project.props);

    let body_mat = materials.add(StandardMaterial {
        base_color: Color::srgb(0.16, 0.16, 0.18),
        perceptual_roughness: 0.6,
        metallic: 0.4,
        ..default()
    });
    let cone_mesh = meshes.add(unit_cone_mesh());

    // Every shadow-casting spotlight costs its own depth pass, so cost grows
    // with rig size, not with what you can see: 10 bars + 4 derbies is 64 of
    // them and the previz falls to ~13 fps. Shadows are what sells the beams
    // landing on people, so keep them — but only for a fixed budget of main
    // heads. Derby sub-beams never get one: six narrow spinning beams per
    // fixture is where the cost explodes and where a shadow map buys nothing.
    let mut shadow_budget: usize = std::env::var("LIGHT_PREVIZ_SHADOWS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(10);

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
        let body = match prof.heads.first().map(|h| h.0) {
            Some(HeadKind::Derby) => Cuboid::new(0.26, 0.2, 0.2),
            Some(HeadKind::Hazer) => Cuboid::new(0.34, 0.26, 0.26),
            _ if prof.heads.len() > 1 => Cuboid::new(1.06, 0.09, 0.09),
            _ => Cuboid::new(0.16, 0.14, 0.16),
        };
        commands.entity(root).with_children(|p| {
            p.spawn((
                Mesh3d(meshes.add(body)),
                MeshMaterial3d(body_mat.clone()),
                Transform::default(),
            ));
        });

        for (hi, &(kind, offset)) in prof.heads.iter().enumerate() {
            let tag = HeadTag { fixture: f.id.clone(), head: hi, kind };
            let rigged = f.pos.y > 1.2;
            let beam_dir = match kind {
                HeadKind::Derby => Vec3::new(0.0, -0.85, 0.52),
                _ if rigged => Vec3::new(0.0, -0.93, 0.37),
                _ => Vec3::new(0.0, -0.26, 0.97),
            };
            let outer = (prof.beam_deg.max(2.0) as f32).to_radians() / 2.0;
            // shaft length: throw to the floor along the beam, clamped sane
            let throw = (f.pos.y.max(0.3) / beam_dir.y.abs().max(0.2)).clamp(1.0, 9.0);
            let cone_scale = Vec3::new(throw * outer.tan().max(0.02), throw * outer.tan().max(0.02), throw);

            commands.entity(root).with_children(|p| {
                let mut head = p.spawn((
                    tag.clone(),
                    Transform::from_xyz(offset as f32, 0.0, 0.0),
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
                                            BeamLight { idx: k, lumens: 2_500_000.0 },
                                            SpotLight {
                                                color: Color::BLACK,
                                                intensity: 0.0,
                                                range: 11.0,
                                                radius: 0.02,
                                                inner_angle: outer * 0.6,
                                                outer_angle: outer,
                                                shadows_enabled: false,
                                                ..default()
                                            },
                                            VolumetricLight,
                                            Transform::from_rotation(rot),
                                        ))
                                        .with_children(|c| {
                                            c.spawn((
                                                tag.clone(),
                                                BeamLight { idx: k, lumens: 0.0 },
                                                BeamCone,
                                                Mesh3d(cone_mesh.clone()),
                                                MeshMaterial3d(materials.add(cone_material())),
                                                Transform::from_scale(cone_scale * Vec3::new(0.7, 0.7, 0.85)),
                                            ));
                                        });
                                    }
                                });
                            });
                        }
                        HeadKind::Hazer => {}
                        _ if pixel_strip => {} // emissive glow only
                        _ => {
                            h.spawn((
                                tag.clone(),
                                // Bevy photometric scale: ~1e6 lm is a domestic
                                // point light; stage beams need multi-megalumen
                                // output to read at concert throw distances.
                                BeamLight { idx: 0, lumens: 8_000_000.0 },
                                SpotLight {
                                    color: Color::BLACK,
                                    intensity: 0.0,
                                    range: 12.0,
                                    radius: 0.04,
                                    inner_angle: outer * 0.7,
                                    outer_angle: outer,
                                    shadows_enabled: {
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
                                    rest: Transform::default().looking_to(beam_dir, Vec3::Y).rotation,
                                    pan_range: 540f32.to_radians(),
                                    tilt_range: 270f32.to_radians(),
                                },
                                || kind == HeadKind::Mover,
                            )
                            .with_children(|c| {
                                c.spawn((
                                    tag.clone(),
                                    BeamLight { idx: 0, lumens: 0.0 },
                                    BeamCone,
                                    Mesh3d(cone_mesh.clone()),
                                    MeshMaterial3d(materials.add(cone_material())),
                                    Transform::from_scale(cone_scale),
                                ));
                            });
                        }
                    }
                });
            });
        }
    }
}
