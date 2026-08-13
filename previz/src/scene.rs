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

#[derive(Component)]
pub struct RingMesh;

#[derive(Component)]
pub struct DerbyFan;

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

    // participating medium — density driven live by the engine's haze value
    commands.spawn((
        FogVolume {
            density_factor: 0.08,
            ..default()
        },
        Transform::from_xyz(0.0, 3.0, 1.0).with_scale(Vec3::new(16.0, 7.0, 13.0)),
    ));
}

/// Rebuild fixture entities whenever the patch changes.
pub fn rebuild_fixtures(
    mut commands: Commands,
    mut live: ResMut<Live>,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
    existing: Query<Entity, With<FixtureRoot>>,
) {
    if live.project_rev == live.built_rev {
        return;
    }
    live.built_rev = live.project_rev;
    for e in &existing {
        commands.entity(e).despawn();
    }
    let Some(project) = live.project.clone() else { return };

    let body_mat = materials.add(StandardMaterial {
        base_color: Color::srgb(0.16, 0.16, 0.18),
        perceptual_roughness: 0.6,
        metallic: 0.4,
        ..default()
    });

    for f in &project.fixtures {
        let Some(prof) = prof_meta(&project, &f.profile_id) else { continue };
        let root = commands
            .spawn((
                FixtureRoot,
                Transform::from_xyz(f.pos.x, f.pos.y, f.pos.z)
                    .with_rotation(Quat::from_rotation_y(f.rot_y)),
                Visibility::default(),
            ))
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
                                            BeamLight { idx: k, lumens: 180_000.0 },
                                            SpotLight {
                                                color: Color::BLACK,
                                                intensity: 0.0,
                                                range: 11.0,
                                                radius: 0.02,
                                                inner_angle: outer * 0.6,
                                                outer_angle: outer,
                                                shadows_enabled: true,
                                                ..default()
                                            },
                                            VolumetricLight,
                                            Transform::from_rotation(rot),
                                        ));
                                    }
                                });
                            });
                        }
                        HeadKind::Hazer => {}
                        _ => {
                            h.spawn((
                                tag.clone(),
                                BeamLight { idx: 0, lumens: 420_000.0 },
                                SpotLight {
                                    color: Color::BLACK,
                                    intensity: 0.0,
                                    range: 12.0,
                                    radius: 0.04,
                                    inner_angle: outer * 0.7,
                                    outer_angle: outer,
                                    shadows_enabled: true,
                                    ..default()
                                },
                                VolumetricLight,
                                Transform::default().looking_to(beam_dir, Vec3::Y),
                            ));
                        }
                    }
                });
            });
        }
    }
}
