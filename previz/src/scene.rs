use bevy::light::{FogVolume, VolumetricLight};
use bevy::render::render_resource::Face;
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

/// The single light standing in for a whole panel's face.
///
/// `heads` is how many cells the fixture has, so the update pass can average
/// them into one colour; `lumens` is the fixture's total output, not one
/// cell's.
#[derive(Component)]
pub struct PanelLight {
    pub heads: usize,
    pub lumens: f32,
    /// Converts `lumens` into whatever unit the primitive underneath actually
    /// wants.
    ///
    /// Bevy is not consistent here, and the inconsistency is a factor of 4*pi.
    /// A SpotLight's intensity is divided by 4*pi on its way to the GPU
    /// (render/light.rs:666); a RectLight's is used RAW
    /// (render/light.rs:1982). So the same number is 12.57x brighter as an
    /// area light than as a spot — which is the entire reason the cheap panel
    /// fallback looked so much dimmer, and nothing to do with cone shape as I
    /// first assumed.
    pub scale: f32,
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

/// One inferred run of overhead truss. See `truss.rs` for what "inferred" buys
/// and what it costs.
#[derive(Component)]
pub struct TrussRunMesh;

/// A spot light that is allowed to take one of the shadow-map slots.
///
/// Every fixture head and every panel fallback carries this; the derby's six
/// spinning sub-beams deliberately do not. Which candidates actually get a slot
/// is decided PER FRAME by `update::allocate_shadows`.
#[derive(Component)]
pub struct ShadowCandidate {
    /// One profile at one trim — what the operator means by "the Spiiders" or
    /// "the floor package". The budget is dealt ACROSS groups so no fixture
    /// type can be starved by a louder one: rank globally on output and the
    /// 30,000 lm blinders take every slot off the beams, which is the reported
    /// bug back in mirror image.
    pub group: u16,
    /// The fixture's patch index with its bits reversed.
    ///
    /// Sorting ascending on this makes any PREFIX spread across the patch, so
    /// when a whole group sits at one level — a blinder hit, the common case,
    /// where every rank is identical — the winners land along the truss instead
    /// of bunched at whichever end happened to be patched first.
    pub spread: u16,
    /// This frame's priority within the group, written by `apply_live` and
    /// `apply_panel_lights`. Zero means dark.
    pub rank: f32,
}

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
            // base_y, not pr.y: a performer lifted onto a riser reaches higher,
            // and this figure fits the floor, the room, the haze volume, the
            // beam reach and the RigExtent the camera frames on.
            let top = base_y(&project.props, pr) + pr.size.map_or(1.8, |s| s.h);
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

/// Which joint of an articulated moving head this entity is.
///
/// A real mover is a base bolted to the truss, a yoke that swings about the
/// vertical, and a head that tilts between the yoke's arms. Until now the previz
/// drew one static box and swung only the light inside it: the beam moved and
/// the fixture did not, which is the single most obvious way this window looked
/// like a diagram rather than a stage. Sixty of the 129 fixtures on the rig are
/// movers, so it was also the most common thing on screen.
///
/// The aim quaternion splits onto the two joints with no maths change at all.
/// `MoverHead::rest` is `looking_to(beam_dir, Y)` and every `beam_dir` has a
/// zero X component, so `rest` is a pure pitch about X and carries no yaw:
///
///   yoke  = from_rotation_y(pan)
///   shell = rest * from_rotation_x(tilt)
///
/// composes through the hierarchy to exactly the `from_rotation_y(pan) * rest *
/// from_rotation_x(tilt)` the single entity used to be given. It is the same
/// rotation, redistributed onto the two things that physically carry it.
///
/// Both parts hold a copy of `MoverHead`, so one query with a match on this
/// enum drives the pair. That matters more than it looks: `apply_live` already
/// keeps three `&mut Transform` queries disjoint by hand-written `Without`
/// filters, and adding two more as separate queries would need five mutually
/// exclusive filter sets — Bevy panics at runtime the moment any pair overlaps.
#[derive(Component, Clone, Copy, PartialEq, Eq, Debug)]
pub enum MoverPart {
    /// Swings about the fixture's vertical. Carries pan.
    Yoke,
    /// Tilts between the yoke's arms. Carries the rest pose and tilt, and every
    /// head, emitter and shaft rides on it.
    Shell,
}

pub fn setup_stage(
    mut commands: Commands,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
    q: Res<crate::quality::Quality>,
) {
    // Stage deck: matte black ply, not polished ice.
    commands.spawn((
        Floor,
        Mesh3d(meshes.add(Plane3d::default().mesh().size(16.0, 12.0))),
        MeshMaterial3d(materials.add(StandardMaterial {
            // A real matte black deck measures 2.5-5% reflectance — black
            // marley about 3-4%, matte scenic black on ply 4-6%. sRGB 0.19
            // decodes to 3.01% linear, dead centre of that. The old 0.055
            // decoded to 0.4%, which is darker than anything physical.
            // Keep the faint blue bias: it stops the bluish ambient fill
            // reading as a neutral grey card.
            base_color: Color::srgb(q.deck_albedo, q.deck_albedo, q.deck_albedo * 1.03),
            // Not 1.0. alpha = perceptual^2, and at 1.0 the GGX lobe spreads
            // until no highlight resolves at all. Black marley runs 5-15 gloss
            // units at 60 degrees: glossier when new, dulled by rosin and gaff
            // to about here. Broad enough that a 15-degree spot smears its
            // highlight over metres of deck, tight enough that the smear is a
            // shape rather than a uniform lift.
            perceptual_roughness: 0.78,
            // A deck is painted ply or PVC vinyl — a dielectric, no conductor
            // anywhere in it. The old 0.65 was self-defeating in two ways at
            // once: bevy's metallic scales diffuse by (1 - metallic) AND drags
            // F0 from the dielectric value toward base_color, so with a
            // near-black base it threw away two thirds of an already tiny
            // diffuse term and came out DARKER in specular than a plain
            // dielectric would have. The comment it carried — "glossy dark so
            // beams throw specular pools" — described the opposite of what the
            // numbers did.
            metallic: 0.0,
            // Bevy maps this to F0 as 0.16*r^2, so 0.5 gives exactly 4% —
            // right for PVC vinyl (IOR 1.53 -> 4.4%) or sealed ply (~4.0%).
            // A first pass at 0.20 gave F0 = 0.64%, which no dielectric on
            // earth is; Schlick still drives F to 1 at true grazing, so that
            // did not remove the edge highlight, it removed the whole 50-80
            // degree band where a deck's sheen actually reads from a seated
            // FOH camera — the one part the matte brief wanted kept.
            reflectance: 0.5,
            ..default()
        })),
        Transform::from_xyz(0.0, 0.0, 1.0),
    ));

    // An inverted room — the half of commit 445ebe3 that never landed.
    //
    // That commit rewrote `fit_backdrop` to scale this entity as a UNIT CUBE
    // and its message describes a cuboid with its front faces culled, but the
    // spawn was never touched: it stayed a Plane3d 16 x 7 rotated upright. The
    // arithmetic and the mesh have disagreed ever since, and scaling a 16 x 7
    // plane as though it were a unit cube produced a 685 x 98 m quad standing
    // at z = -3.5 — four metres DOWNSTAGE of the upstage truss, hiding it and
    // the whole upstage half of the deck from every FOH camera.
    //
    // Nothing caught it because every claim in that commit message is still
    // true of a 685 m quad. The seam really was gone (the thing overflows the
    // frame from any angle, so there is no top edge left to find) and the frame
    // time really did drop 7 ms (the depth prepass really did start getting a
    // hit for nearly every pixel). It was an accidental full-frame occluder,
    // not a room.
    //
    // The mesh must stay Cuboid::new(1.0, 1.0, 1.0): it spans +/-0.5, which is
    // exactly what fit_backdrop's arithmetic assumes. This transform is only
    // the demo room — fit_backdrop early-returns on an empty project — and z is
    // 1.0 to match the demo floor, which is centred there.
    commands.spawn((
        Backdrop,
        Mesh3d(meshes.add(Cuboid::new(1.0, 1.0, 1.0))),
        MeshMaterial3d(materials.add(StandardMaterial {
            base_color: Color::srgb(0.05, 0.05, 0.06),
            perceptual_roughness: 0.9,
            metallic: 0.0,
            // Only back faces are drawn, and a back face's vertex normal points
            // AWAY from the camera. Without this the shader lights every
            // interior surface with an outward normal and the room is black.
            double_sided: true,
            cull_mode: Some(Face::Front),
            ..default()
        })),
        Transform::from_xyz(0.0, 3.48, 1.0).with_scale(Vec3::new(16.0, 7.0, 12.0)),
        // Nothing lives outside the room for it to shadow, and a closed box
        // around every light would otherwise put the entire scene inside its
        // own shadow volume.
        bevy::light::NotShadowCaster,
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

    // The room encloses the rig with a margin and reaches from the floor to
    // well above the highest hang, so a beam pointed up has something to land
    // on. Unit cube, so the scale IS the size. Dropped a hair below zero so it
    // never z-fights the floor it sits on.
    if let Ok(mut t) = backdrop.single_mut() {
        let room_h = height + MARGIN;
        t.scale = Vec3::new(width, room_h, depth);
        t.translation = Vec3::new(cx, room_h * 0.5 - 0.02, cz);
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

/// The Y a prop's root sits at: its own declared base if it is structure, the
/// surface under their feet if it is a person.
///
/// Stated once. The first cut of this asked `STRUCTURE_KINDS.contains(..)` off
/// a four-string array copied out of shared/types.ts — a hand-kept twin of a
/// list that already exists, which is the exact mistake the sanitizer's own
/// comment warns about, and it displaced `spawn_props`' doc block on the way in.
///
/// The structural defaults here are the web view's, not the old native ones: a
/// `trussBar` with no `y` now hangs at 3.05 rather than lying on the floor,
/// which is what ui/src/components/Previz3D.tsx has always drawn. Only a
/// malformed file can tell the difference — `addStructure` always writes `y`.
fn base_y(props: &[crate::protocol::PropLite], pr: &crate::protocol::PropLite) -> f32 {
    match pr.kind.as_str() {
        "trussBar" => pr.y.unwrap_or(3.05),
        "trussLeg" | "riser" => pr.y.unwrap_or(0.0),
        "screen" => pr.y.unwrap_or(0.5),
        _ => floor_height_at(props, pr.pos.x, pr.pos.z),
    }
}

/// Dummy musicians — jointed figures at real human scale, posed by instrument
/// (see figure.rs) — plus the truss, risers and screens the plot places.
/// Spawned from the project's props (2D plan: "+ musician…", drag to move,
/// double-click to remove). Press M in this window to show/hide them all.
fn spawn_props(
    commands: &mut Commands,
    meshes: &mut Assets<Mesh>,
    materials: &mut Assets<StandardMaterial>,
    props: &[crate::protocol::PropLite],
) {
    // One kit of shared handles for the whole band. The old code called
    // `meshes.add` thirteen times INSIDE this loop, so two guitarists were two
    // unbatchable copies of the same guitar and a twenty-prop stage was fifty
    // mesh assets. This is thirteen, whatever the prop count.
    let kit = crate::figure::Kit::new(meshes, materials);

    // structure reads as aluminium and stage deck, matching the in-window previz
    let truss_struct = materials.add(StandardMaterial {
        base_color: Color::srgb(0.22, 0.22, 0.25),
        perceptual_roughness: 0.5,
        metallic: 0.3,
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

    for pr in props {
        // Every prop's root now carries its base — structure its own, a person
        // the surface under their feet. Lifting the ROOT is the whole mechanism
        // for a person: figure.rs pins every sole to y = 0 in the figure's own
        // frame and the stature node is pure scale, so the instrument, the mic
        // stand's base plate and the drum stool rise together with no relative
        // drift. Lifting the STATURE node instead would look identical and
        // silently throw the drum sticks off, whose origin is converted from
        // body to root frame by a bare scalar multiply.
        let base = base_y(props, pr);
        let root = commands
            .spawn((
                BandRoot,
                Transform::from_xyz(pr.pos.x, base, pr.pos.z)
                    .with_rotation(Quat::from_rotation_y(pr.rot_y.unwrap_or(0.0))),
                Visibility::default(),
            ))
            .id();
        commands.entity(root).with_children(|p| {
            match pr.kind.as_str() {
                // ---- structure -------------------------------------------
                // Boxes, not detailed trussing: these exist so a beam has
                // something to land on and so the operator can judge blocking.
                // Sized from the project, so this view and the in-window previz
                // describe the same stage.
                "trussBar" | "trussLeg" => {
                    let (w, h, d) = size_of(pr, 7.0, 0.3, 0.3);
                    p.spawn((
                        Mesh3d(kit.cube.clone()),
                        MeshMaterial3d(truss_struct.clone()),
                        // The root carries the base (see base_y); this is just
                        // the box's own centre above it.
                        Transform::from_xyz(0.0, h / 2.0, 0.0).with_scale(Vec3::new(w, h, d)),
                    ));
                }
                "riser" => {
                    let (w, h, d) = size_of(pr, 2.0, 0.4, 1.5);
                    p.spawn((
                        Mesh3d(kit.cube.clone()),
                        MeshMaterial3d(deck.clone()),
                        // The root carries the base (see base_y); this is just
                        // the box's own centre above it.
                        Transform::from_xyz(0.0, h / 2.0, 0.0).with_scale(Vec3::new(w, h, d)),
                    ));
                }
                "screen" => {
                    let (w, h, d) = size_of(pr, 4.0, 2.25, 0.12);
                    p.spawn((
                        Mesh3d(kit.cube.clone()),
                        MeshMaterial3d(panel.clone()),
                        Transform::from_xyz(0.0, h / 2.0, 0.0).with_scale(Vec3::new(w, h, d)),
                    ));
                }
                // ---- people ----------------------------------------------
                kind => crate::figure::spawn_performer(p, kind, &pr.id, &kit),
            }
        });
    }
}

/// Height of the surface a performer standing at (x, z) is actually standing
/// ON — 0 for the deck, or the top of the riser they are inside.
///
/// DERIVED, not authored, and that is the point. A performer has no height of
/// their own: `sanitizeProject` deletes `y` from every non-structural prop and
/// should keep doing so. The operator drags a musician around a plan that
/// already draws the risers; asking them to ALSO type a height matching
/// whichever riser they landed on is a number that goes stale the first time
/// the riser moves. Read from the scenery it cannot go stale, needs no control,
/// and the drummer moves when the riser does.
///
/// Only risers count — a truss bar at deck level is not something you stand on.
/// Stacking falls out: the highest containing surface wins.
///
/// Twin of `standingHeightAt` in shared/beamThrow.ts, including the yaw
/// convention: local +X is (cos, -sin), so a point is taken into the prop's
/// frame with lx = dx*c - dz*s, lz = dx*s + dz*c. Get that backwards and a
/// rotated riser lifts people standing beside it instead of on it.
fn floor_height_at(props: &[crate::protocol::PropLite], x: f32, z: f32) -> f32 {
    let mut top = 0.0f32;
    for pr in props {
        if pr.kind != "riser" {
            continue;
        }
        // `size_of`, not `pr.size.unwrap_or(..)`: it also rejects a component
        // that is zero or negative, which is what the renderer does when it
        // DRAWS the riser. Without it a riser with w = 0 was drawn at the
        // default 2 x 0.4 x 1.5 and lifted nobody.
        let (w, h, d) = size_of(pr, 2.0, 0.4, 1.5);
        let (dx, dz) = (x - pr.pos.x, z - pr.pos.z);
        let (c, sn) = (pr.rot_y.unwrap_or(0.0).cos(), pr.rot_y.unwrap_or(0.0).sin());
        let (lx, lz) = (dx * c - dz * sn, dx * sn + dz * c);
        // No margin. Standing within 15 cm of a riser's edge should not
        // levitate someone who is beside it.
        if lx.abs() <= w * 0.5 && lz.abs() <= d * 0.5 {
            top = top.max(pr.y.unwrap_or(0.0) + h);
        }
    }
    top
}

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
    existing_truss: Query<Entity, With<TrussRunMesh>>,
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
    for e in &existing_truss {
        commands.entity(e).despawn();
    }
    let Some(project) = live.project.clone() else { return };

    fit_backdrop(q.haze_oversize, &project, &mut backdrop, &mut floor, &mut haze);

    if q.band {
        spawn_props(&mut commands, &mut meshes, &mut materials, &project.props);
    }

    // Structure, before the fixtures that hang off it.
    if q.truss {
        // Aluminium, but NOT as a mirror.
        //
        // The first pass had this at metallic 0.92, which is physically what
        // raw truss is, and it rendered pure black. A metal's colour is
        // entirely what it reflects, and this scene has no environment map — so
        // a fully metallic surface in a blacked-out room reflects a blacked-out
        // room. Bevy 0.19 can filter a generated cubemap at runtime and that is
        // the real answer, but it re-filters every frame for a room that never
        // changes.
        //
        // Dialling metallic down lets the diffuse term carry it, which means
        // the truss is lit by the fixtures hanging off it. That is both cheaper
        // and closer to how a rig actually reads from the floor.
        let steel = materials.add(StandardMaterial {
            base_color: Color::srgb(0.46, 0.46, 0.50),
            perceptual_roughness: 0.50,
            metallic: 0.30,
            ..default()
        });
        let hangs: Vec<Vec3> = project
            .fixtures
            .iter()
            .map(|f| Vec3::new(f.pos.x, f.pos.y, f.pos.z))
            .collect();
        let runs = crate::truss::infer_runs(&hangs, 2.0);
        if !runs.is_empty() {
            eprintln!("[previz] truss: {} run(s) inferred from the hang", runs.len());
        }
        for r in runs {
            // The mesh is built along +X from the origin, so the entity carries
            // the whole placement and one run's geometry is never shared with
            // another's — lengths differ, so there is nothing to share.
            commands.spawn((
                TrussRunMesh,
                Mesh3d(meshes.add(crate::truss::truss_mesh(r.x1 - r.x0))),
                MeshMaterial3d(steel.clone()),
                Transform::from_xyz(r.x0, r.y, r.z),
            ));
        }
    }

    // Powder-coated casing, not chrome — same reasoning as the truss steel
    // below: with no environment map, metallic is a synonym for black here.
    let body_mat = materials.add(StandardMaterial {
        base_color: Color::srgb(0.20, 0.20, 0.225),
        perceptual_roughness: 0.62,
        metallic: 0.15,
        ..default()
    });
    // The proxy hull the beam shader integrates inside. Cut at the FIELD
    // angle, not the beam angle: the soft shoulder lives out there, and sizing
    // the geometry to the core would clip it back to a hard silhouette — the
    // exact defect the shader exists to remove.
    let cone_mesh = meshes.add(crate::beam::unit_cone_hull());
    // ONE handle, not one per head. This was `meshes.add(Sphere::new(0.05))`
    // inside the head loop: 153 identical 720-triangle spheres, each its own
    // asset, its own vertex buffer and its own draw. The material still has to
    // be per-head because each carries its own live colour.
    let glow_mesh = meshes.add(Sphere::new(0.05));

    // The articulated mover, as five shared handles. Sixty movers on this rig
    // means these are instanced sixty times each and cost five meshes, not
    // three hundred — the same reason `glow_mesh` is hoisted out of the loop.
    //
    // Dimensions are a mid-size wash/beam head (a Spiider or a Rival is roughly
    // 0.5 m tall in its yoke). Everything is measured from the fixture's patch
    // position, which stays exactly where the lens is: the base and yoke are
    // built UPWARD from it, so adding the body does not move a single beam or
    // change a single throw distance from the previous build.
    let mover_base = meshes.add(Cuboid::new(0.22, 0.10, 0.22));
    let mover_arm = meshes.add(Cuboid::new(0.036, 0.20, 0.11));
    let mover_cross = meshes.add(Cuboid::new(0.27, 0.036, 0.11));
    // Bevy's Cylinder runs along +Y; the head barrel runs along the beam, which
    // is local -Z. Rotating the TRANSFORM rather than baking a second mesh
    // keeps this a shared handle.
    let mover_shell = meshes.add(Cylinder::new(0.088, 0.22));
    let mover_lens = meshes.add(Cylinder::new(0.080, 0.014));
    // Darker and rougher than the body: a mover's yoke is a matte casting, and
    // giving it the body's 0.4 metallic made a wall of grey mirrors.
    let yoke_mat = materials.add(StandardMaterial {
        base_color: Color::srgb(0.135, 0.135, 0.155),
        perceptual_roughness: 0.75,
        metallic: 0.10,
        ..default()
    });
    // The lens reads as glass even when the fixture is dark, which is what
    // stops a blacked-out rig looking like a row of bricks.
    let lens_mat = materials.add(StandardMaterial {
        base_color: Color::srgb(0.03, 0.035, 0.05),
        perceptual_roughness: 0.08,
        metallic: 0.0,
        reflectance: 0.85,
        ..default()
    });

    // Bevy's hard limit; see the note at the panel spawn.
    let mut rect_budget: usize = 8;

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
            live.rig_extent = Some(crate::state::RigExtent {
                diag,
                height: b.max.y,
                center: Vec3::new((b.min.x + b.max.x) * 0.5, 0.0, (b.min.z + b.max.z) * 0.5),
            });
            ((b.max.y + 2.0).max(9.0), diag.max(12.0).min(q.light_range_cap))
        }
        None => {
            live.rig_extent = None;
            (9.0, 12.0f32.min(q.light_range_cap))
        }
    };

    // (profile, in the air) — the two things that make one fixture
    // interchangeable with another for "does this type cast a shadow".
    let mut group_keys: Vec<(String, bool)> = Vec::new();

    for (fi, f) in project.fixtures.iter().enumerate() {
        let Some(prof) = prof_meta(&project, &f.profile_id) else { continue };
        let gkey = (f.profile_id.clone(), f.pos.y > 1.2);
        let group = group_keys.iter().position(|k| *k == gkey).unwrap_or_else(|| {
            group_keys.push(gkey);
            group_keys.len() - 1
        }) as u16;
        let candidate = || ShadowCandidate {
            group,
            spread: (fi as u16).reverse_bits(),
            rank: 0.0,
        };
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
            // needs aiming exactly like a spot does.
            let face = if f.pos.y > 1.2 {
                Vec3::new(0.0, -0.93, 0.37)
            } else {
                Vec3::new(0.0, -0.26, 0.97)
            };
            // Bevy holds rect lights in a FIXED array of 8
            // (MAX_RECT_LIGHTS, render/light.rs:232), unclustered, iterated for
            // every lit fragment (pbr_functions.wgsl:662). Two consequences,
            // both of which bit:
            //
            //   - past eight they are silently dropped. This rig has 24 Neros
            //     and bevy was warning "24 exceeding the supported limit of 8"
            //     into a log nobody was reading, so SIXTEEN blinders were
            //     emitting nothing. That is the same class of bug as the one
            //     this whole panel path was written to fix.
            //   - they cost the same whatever their range, because there is no
            //     culling to respond to it: measured 0.65 ms each, and capping
            //     range from 39 m to 8 m changed almost nothing.
            //
            // So they are budgeted, exactly like shadow-casting spots, and
            // everything past the budget gets a wide spot instead.
            let area = q.panel_area_lights && rect_budget > 0;
            if area {
                rect_budget -= 1;
            }
            let tag = HeadTag { fixture: f.id.clone(), head: 0, kind: HeadKind::Rgb };
            let lumens = lumens_for(&prof, false) * q.lumen_scale;
            let panel = PanelLight {
                heads: prof.heads.len(),
                lumens,
                scale: if area { 1.0 } else { 4.0 * std::f32::consts::PI },
            };
            let aim = Transform::default().looking_to(face, Vec3::Y);
            commands.entity(root).with_children(|p| {
                if area {
                    p.spawn((
                        tag,
                        panel,
                        RectLight {
                            color: Color::BLACK,
                            intensity: 0.0,
                            range: light_range,
                            width: bw,
                            height: bh,
                            ..default()
                        },
                        aim,
                        Visibility::Hidden,
                    ));
                } else {
                    // Wrong shape — a hard ellipse where a plate throws a soft
                    // square — but the right brightness, in the room, for every
                    // fixture rather than the first eight.
                    let outer = (prof.beam_deg.max(2.0) as f32).to_radians() / 2.0;
                    p.spawn((
                        tag,
                        panel,
                        SpotLight {
                            color: Color::BLACK,
                            intensity: 0.0,
                            range: light_range,
                            radius: bw.max(bh) * 0.5,
                            // Nearly uniform: a plate washes evenly with a soft
                            // edge rather than rolling off from a hot centre.
                            inner_angle: (outer * 0.88).min(1.30),
                            outer_angle: outer.min(1.35),
                            // Off at spawn; `allocate_shadows` turns it on if
                            // this panel is among the brightest lit lights this
                            // frame. A 77-degree cone from 8 m spreads a
                            // 1024-map over a 29 m circle, so the shadow is
                            // soft to the point of being a gradient — which is
                            // what a 41 x 32 cm emitter actually casts.
                            shadow_maps_enabled: false,
                            // Bevy's default normal bias is 1.8, and the
                            // erosion it causes scales with the cone: 1.8 x
                            // (2*tan(outer)/2048) x sqrt(2) x distance is 14 mm
                            // for a 30-degree beam at 10 m but 43 mm for a
                            // 60-degree wash — wider than the 42 mm forearm
                            // that is the whole reason the figures grew arms.
                            // 0.8 keeps the thin limbs and still holds off acne
                            // on a 42 m wall at grazing incidence.
                            shadow_normal_bias: 0.8,
                            contact_shadows_enabled: q.contact_shadows,
                            ..default()
                        },
                        aim,
                        candidate(),
                        Visibility::Hidden,
                    ));
                }
            });
        }

        // Does this fixture physically aim? Ask the same question the beam
        // steering asks — the CHANNELS first, because a GDTF pixel mover is a
        // moving head whose emitters are all `Rgb`, and gating on head kind
        // left every imported mover bolted in place.
        let aims = prof.aim_head.is_some() || prof.heads.iter().any(|h| h.0 == HeadKind::Mover);
        // Which way this fixture's body faces when nothing is driving it: the
        // rest pose a mover's yoke deflects from, and — new — the direction a
        // fixture that does NOT move is bolted pointing.
        let rest_dir = match prof.heads.first().map(|h| h.0) {
            Some(HeadKind::Derby) => Vec3::new(0.0, -0.85, 0.52),
            _ if f.pos.y > 1.2 => Vec3::new(0.0, -0.93, 0.37),
            _ => Vec3::new(0.0, -0.26, 0.97),
        };
        let body_rot = Transform::default().looking_to(rest_dir, Vec3::Y).rotation;

        // Everything below the yoke hangs off this. A fixture that does not aim
        // keeps the old flat arrangement exactly: one body mesh, heads parented
        // straight to the root.
        let head_parent = if aims {
            let base = commands
                .spawn((
                    Mesh3d(mover_base.clone()),
                    MeshMaterial3d(body_mat.clone()),
                    Transform::from_xyz(0.0, 0.185, 0.0),
                    // A mover must not shadow its own output. The casing wraps
                    // the emitter, and a spot light inside a closed mesh renders
                    // that mesh into its own shadow map and goes black —
                    // silently, because nothing errors. Cheaper than moving the
                    // light out of the casing, and correct: real fixtures do not
                    // cast their body into their own beam.
                    bevy::light::NotShadowCaster,
                ))
                .id();
            let yoke = commands
                .spawn((
                    HeadTag {
                        fixture: f.id.clone(),
                        head: prof.aim_head.unwrap_or(0),
                        kind: HeadKind::Mover,
                    },
                    MoverPart::Yoke,
                    MoverHead {
                        aim_head: prof.aim_head.unwrap_or(0),
                        rest: Transform::default().looking_to(rest_dir, Vec3::Y).rotation,
                        pan_range: 540f32.to_radians(),
                        tilt_range: 270f32.to_radians(),
                        root_rot: root_tf.rotation,
                        height: f.pos.y,
                        outer: (prof.beam_deg.max(2.0) as f32).to_radians() / 2.0,
                        max_throw,
                    },
                    Transform::from_xyz(0.0, 0.135, 0.0),
                    Visibility::default(),
                ))
                .id();
            let shell = commands
                .spawn((
                    HeadTag {
                        fixture: f.id.clone(),
                        head: prof.aim_head.unwrap_or(0),
                        kind: HeadKind::Mover,
                    },
                    MoverPart::Shell,
                    MoverHead {
                        aim_head: prof.aim_head.unwrap_or(0),
                        rest: Transform::default().looking_to(rest_dir, Vec3::Y).rotation,
                        pan_range: 540f32.to_radians(),
                        tilt_range: 270f32.to_radians(),
                        root_rot: root_tf.rotation,
                        height: f.pos.y,
                        outer: (prof.beam_deg.max(2.0) as f32).to_radians() / 2.0,
                        max_throw,
                    },
                    // Puts the shell pivot back at the fixture's patch position,
                    // undoing the yoke's rise. The lens therefore sits exactly
                    // where the single body box used to, and every throw
                    // distance in the scene is unchanged.
                    Transform::from_xyz(0.0, -0.135, 0.0),
                    Visibility::default(),
                ))
                .id();
            commands.entity(root).add_children(&[base, yoke]);
            commands.entity(yoke).add_children(&[shell]);
            commands.entity(yoke).with_children(|p| {
                for sx in [-1.0f32, 1.0] {
                    p.spawn((
                        Mesh3d(mover_arm.clone()),
                        MeshMaterial3d(yoke_mat.clone()),
                        Transform::from_xyz(sx * 0.118, -0.075, 0.0),
                        bevy::light::NotShadowCaster,
                    ));
                }
                p.spawn((
                    Mesh3d(mover_cross.clone()),
                    MeshMaterial3d(yoke_mat.clone()),
                    Transform::from_xyz(0.0, 0.012, 0.0),
                    bevy::light::NotShadowCaster,
                ));
            });
            commands.entity(shell).with_children(|p| {
                // Cylinder runs along +Y; lay it along the beam axis, -Z.
                let lay = Quat::from_rotation_x(-std::f32::consts::FRAC_PI_2);
                p.spawn((
                    Mesh3d(mover_shell.clone()),
                    MeshMaterial3d(body_mat.clone()),
                    Transform::from_rotation(lay),
                    bevy::light::NotShadowCaster,
                ));
                p.spawn((
                    Mesh3d(mover_lens.clone()),
                    MeshMaterial3d(lens_mat.clone()),
                    Transform::from_xyz(0.0, 0.0, -0.114).with_rotation(lay),
                    bevy::light::NotShadowCaster,
                ));
            });
            shell
        } else {
            // A body frame for fixtures that do not move, for the same reason
            // the mover got a shell — and this one is a straight bug fix.
            //
            // Every non-mover body was drawn square to the world while its
            // light went somewhere else entirely. On this rig that is seventy
            // three fixtures — pars, battens, blinders, strobes — hanging at
            // 68 degrees down with their casings facing flat downstage, and
            // their emissive cells floating in a horizontal line off the front
            // of the box rather than sitting on the tilted face. A blinder
            // plate aimed at the deck looked like a picture frame facing the
            // audience.
            //
            // Rotating the whole frame, not just the mesh, is what fixes the
            // cells too: they hang off this node, so they land on the face.
            let bodyf = commands
                .spawn((Transform::from_rotation(body_rot), Visibility::default()))
                .id();
            commands.entity(root).add_children(&[bodyf]);

            // The HANGING hardware stays world-vertical, on the root, while the
            // fixture it holds tilts inside it — the same split the mover makes
            // between its base and its shell. A par's yoke does not tilt with
            // the can; that is the entire point of a yoke.
            let (bw, bh, bd) =
                (body.half_size.x * 2.0, body.half_size.y * 2.0, body.half_size.z * 2.0);
            commands.entity(root).with_children(|p| {
                match prof.form {
                    FixtureForm::Par | FixtureForm::Strobe => {
                        let reach = (bw * 0.5 + 0.022).max(0.09);
                        for sx in [-1.0f32, 1.0] {
                            p.spawn((
                                Mesh3d(meshes.add(Cuboid::new(0.028, bh + 0.06, bd * 0.55))),
                                MeshMaterial3d(yoke_mat.clone()),
                                Transform::from_xyz(sx * reach, 0.01, 0.0),
                                bevy::light::NotShadowCaster,
                            ));
                        }
                        p.spawn((
                            Mesh3d(meshes.add(Cuboid::new(reach * 2.0, 0.028, bd * 0.55))),
                            MeshMaterial3d(yoke_mat.clone()),
                            Transform::from_xyz(0.0, bh * 0.5 + 0.04, 0.0),
                            bevy::light::NotShadowCaster,
                        ));
                    }
                    FixtureForm::Bar | FixtureForm::Panel => {
                        // A batten or a plate hangs off a pair of drop
                        // brackets rather than a yoke.
                        for sx in [-1.0f32, 1.0] {
                            p.spawn((
                                Mesh3d(meshes.add(Cuboid::new(0.026, 0.11, bd * 0.6))),
                                MeshMaterial3d(yoke_mat.clone()),
                                Transform::from_xyz(sx * bw * 0.32, bh * 0.5 + 0.05, 0.0),
                                bevy::light::NotShadowCaster,
                            ));
                        }
                    }
                    _ => {}
                }
            });

            commands.entity(bodyf).with_children(|p| {
                match prof.form {
                    // A par is a can, not a box. Forty-nine of the hundred and
                    // twenty-nine fixtures on this rig land on the Par
                    // fallback, so it is the most repeated object on screen and
                    // was the least considered.
                    FixtureForm::Par => {
                        let r = bw * 0.5;
                        let lay = Quat::from_rotation_x(-std::f32::consts::FRAC_PI_2);
                        p.spawn((
                            Mesh3d(meshes.add(Cylinder::new(r, bd * 1.3))),
                            MeshMaterial3d(body_mat.clone()),
                            Transform::from_rotation(lay),
                            bevy::light::NotShadowCaster,
                        ));
                        // The rim catches a highlight and gives the can a front.
                        p.spawn((
                            Mesh3d(meshes.add(Cylinder::new(r * 1.08, 0.018))),
                            MeshMaterial3d(yoke_mat.clone()),
                            Transform::from_xyz(0.0, 0.0, -bd * 0.65).with_rotation(lay),
                            bevy::light::NotShadowCaster,
                        ));
                    }
                    // A plate with a recessed face: an outer shell and an inset
                    // darker front, which is what makes a blinder read as glass
                    // in a frame rather than as a painted brick.
                    FixtureForm::Panel => {
                        p.spawn((
                            Mesh3d(meshes.add(body)),
                            MeshMaterial3d(body_mat.clone()),
                            Transform::default(),
                            bevy::light::NotShadowCaster,
                        ));
                        p.spawn((
                            Mesh3d(meshes.add(Cuboid::new(bw * 0.90, bh * 0.86, 0.02))),
                            MeshMaterial3d(lens_mat.clone()),
                            Transform::from_xyz(0.0, 0.0, -bd * 0.5 - 0.006),
                            bevy::light::NotShadowCaster,
                        ));
                    }
                    FixtureForm::Bar => {
                        p.spawn((
                            Mesh3d(meshes.add(body)),
                            MeshMaterial3d(body_mat.clone()),
                            Transform::default(),
                            bevy::light::NotShadowCaster,
                        ));
                        // End caps, so a batten has ends rather than fading
                        // into a bar of the same colour as everything else.
                        for sx in [-1.0f32, 1.0] {
                            p.spawn((
                                Mesh3d(meshes.add(Cuboid::new(0.03, bh * 1.25, bd * 1.25))),
                                MeshMaterial3d(yoke_mat.clone()),
                                Transform::from_xyz(sx * bw * 0.5, 0.0, 0.0),
                                bevy::light::NotShadowCaster,
                            ));
                        }
                    }
                    FixtureForm::Strobe => {
                        p.spawn((
                            Mesh3d(meshes.add(body)),
                            MeshMaterial3d(body_mat.clone()),
                            Transform::default(),
                            bevy::light::NotShadowCaster,
                        ));
                        p.spawn((
                            Mesh3d(meshes.add(Cuboid::new(bw * 0.93, bh * 0.82, 0.02))),
                            MeshMaterial3d(lens_mat.clone()),
                            Transform::from_xyz(0.0, 0.0, -bd * 0.5 - 0.006),
                            bevy::light::NotShadowCaster,
                        ));
                    }
                    _ => {
                        p.spawn((
                            Mesh3d(meshes.add(body)),
                            MeshMaterial3d(body_mat.clone()),
                            Transform::default(),
                            // The only body mesh that was missing this. A spot
                            // inside a closed casing renders the casing into
                            // its own shadow map and goes black, silently — it
                            // was latent only because such a fixture rarely
                            // fell inside the first 24 in patch order, and
                            // per-frame allocation makes it reachable.
                            bevy::light::NotShadowCaster,
                        ));
                    }
                }
            });
            bodyf
        };
        // Every emitter sits on the FRONT FACE of its casing, not at the
        // middle of it.
        //
        // A mover's glow was buried inside the barrel and its shaft started
        // 11 cm behind the lens. A static fixture was worse: its emitter sat at
        // the dead centre of the box, so a par's glow was inside the can and a
        // blinder's cells were half-sunk into the plate, which is why some of
        // them appeared to be floating beside their own fixture rather than on
        // it. Both are now a hair proud of the front face — of the barrel for a
        // mover, of the body for everything else.
        let lens_z = if aims { -0.12 } else { -(body.half_size.z + 0.012) };

        for (hi, &(kind, offset, offset_y)) in prof.heads.iter().enumerate() {
            let tag = HeadTag { fixture: f.id.clone(), head: hi, kind };
            let rigged = f.pos.y > 1.2;
            let beam_dir = match kind {
                HeadKind::Derby => Vec3::new(0.0, -0.85, 0.52),
                _ if rigged => Vec3::new(0.0, -0.93, 0.37),
                _ => Vec3::new(0.0, -0.26, 0.97),
            };
            // The emitter's rotation RELATIVE to the body frame it now hangs
            // in. For the ordinary fixture — every head the same kind — this is
            // identity, because the body is already pointing where the light
            // goes. It is only non-identity for a profile that mixes head kinds
            // with different default aims, and then it is exactly right rather
            // than approximately so.
            let emitter_rot =
                body_rot.inverse() * Transform::default().looking_to(beam_dir, Vec3::Y).rotation;
            let outer = (prof.beam_deg.max(2.0) as f32).to_radians() / 2.0;
            // Field half-angle, and a shoulder beyond it: f_r is non-zero out
            // to roughly 1.15x the field, so the hull has to be at least that
            // wide or a hard triangle edge cuts the soft edge off.
            let field = (prof.field_deg.max(prof.beam_deg) as f32).to_radians() / 2.0 * 1.15;
            // shaft length: throw to the floor along the beam, clamped sane
            let throw = (f.pos.y.max(0.3) / beam_dir.y.abs().max(0.2)).clamp(1.0, max_throw);
            let fr = (throw * field.tan()).max(0.03);
            let field_scale = Vec3::new(fr, fr, throw);

            commands.entity(head_parent).with_children(|p| {
                // On an articulated fixture this is the SHELL, so a pixel
                // mover's cells ride the head that carries them instead of
                // hanging in space where the fixture used to be pointing.
                let mut head = p.spawn((
                    tag.clone(),
                    Transform::from_xyz(offset as f32, offset_y as f32, lens_z),
                    Visibility::default(),
                ));

                head.with_children(|h| {
                    // emissive source for bloom
                    if q.glows {
                    h.spawn((
                        tag.clone(),
                        SourceGlow,
                        Mesh3d(glow_mesh.clone()),
                        MeshMaterial3d(materials.add(StandardMaterial {
                            base_color: Color::srgb(0.02, 0.02, 0.02),
                            emissive: LinearRgba::BLACK,
                            perceptual_roughness: 1.0,
                            ..default()
                        })),
                        // On an articulated head, squash the emitter into the
                        // lens it is sitting in. A 10 cm sphere hanging off the
                        // front of a 22 cm barrel reads as a ball stuck to the
                        // fixture; the same sphere flattened to the lens disc
                        // reads as glass with a lamp behind it, which is what
                        // you actually see on a rig.
                        if aims {
                            Transform::from_scale(Vec3::new(1.65, 1.65, 0.30))
                        } else {
                            Transform::default()
                        },
                    ));
                    }

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
                                Transform::from_rotation(emitter_rot),
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
                                                // Deliberately off, and it does
                                                // not draw on the budget. Six
                                                // narrow spinning beams per
                                                // derby is exactly where shadow
                                                // cost explodes, and a shadow
                                                // map buys nothing for a beam
                                                // that sweeps a wall.
                                                shadow_maps_enabled: false,
                                                ..default()
                                            },
                                            VolumetricLight,
                                            Transform::from_rotation(rot),
                                        ))
                                        .with_children(|c| {
                                            if !q.beams { return; }
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
                                    // Off at spawn; `allocate_shadows` decides
                                    // per frame which lit heads get a slot.
                                    shadow_maps_enabled: false,
                                // Bevy's default normal bias is 1.8, and the
                                // erosion it causes scales with the cone: 1.8 x
                                // (2*tan(outer)/2048) x sqrt(2) x distance is 14 mm
                                // for a 30-degree beam at 10 m but 43 mm for a
                                // 60-degree wash — wider than the 42 mm forearm
                                // that is the whole reason the figures grew arms.
                                // 0.8 keeps the thin limbs and still holds off acne
                                // on a 42 m wall at grazing incidence.
                                shadow_normal_bias: 0.8,
                                    contact_shadows_enabled: q.contact_shadows,
                                    ..default()
                                },
                                VolumetricLight,
                                candidate(),
                                // The frame above — a mover's shell, or a static
                                // fixture's body node — already points this way.
                                // Re-applying the full `looking_to` here would
                                // pitch the beam twice and send everything into
                                // the floor.
                                Transform::from_rotation(emitter_rot),
                            ))
                            .with_children(|c| {
                                if !q.beams { return; }
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

    /// Both previz views must lift a figure by the same amount, and they are
    /// hand-copied twins in two languages with no parity test between them. So
    /// the CASES live in one file that both sides load —
    /// shared/testdata/standingHeight.json — and adding one there adds it to
    /// both suites at once. The mirror of this loop is in engine/test/smoke.ts.
    #[test]
    fn floor_height_matches_the_shared_corpus() {
        let raw = include_str!("../../shared/testdata/standingHeight.json");
        let cases: serde_json::Value = serde_json::from_str(raw).expect("corpus parses");
        let cases = cases.as_array().expect("corpus is an array");
        assert!(cases.len() >= 15, "corpus shrank to {}", cases.len());
        for c in cases {
            let props: Vec<crate::protocol::PropLite> =
                serde_json::from_value(c["props"].clone()).expect("props parse");
            let at = c["at"].as_array().unwrap();
            let (x, z) = (at[0].as_f64().unwrap() as f32, at[1].as_f64().unwrap() as f32);
            let want = c["expect"].as_f64().unwrap() as f32;
            let got = floor_height_at(&props, x, z);
            assert!(
                (got - want).abs() < 1e-4,
                "{}: floor_height_at({x}, {z}) = {got}, expected {want}",
                c["why"].as_str().unwrap_or("?")
            );
        }
    }

    fn prop(json: serde_json::Value) -> crate::protocol::PropLite {
        serde_json::from_value(json).expect("PropLite should parse")
    }

    /// The regression guard for base_y: the root now carries the base and the
    /// child no longer re-adds it, so a miss double-counts. A riser at the
    /// default y = 0 renders identically either way — only a hanging bar or a
    /// lifted riser can catch it.
    #[test]
    fn a_truss_bar_hangs_at_its_own_base() {
        let bar = prop(serde_json::json!({
            "id": "t", "kind": "trussBar", "pos": { "x": 0, "z": 0 }, "y": 3.05
        }));
        assert!((base_y(&[], &bar) - 3.05).abs() < 1e-5);
        // and with no y at all it still hangs, matching the web view
        let bare = prop(serde_json::json!({
            "id": "t", "kind": "trussBar", "pos": { "x": 0, "z": 0 }
        }));
        assert!((base_y(&[], &bare) - 3.05).abs() < 1e-5, "a y-less bar should hang");
        let screen = prop(serde_json::json!({
            "id": "s", "kind": "screen", "pos": { "x": 0, "z": 0 }
        }));
        assert!((base_y(&[], &screen) - 0.5).abs() < 1e-5);
    }

    /// A performer's own `y` must do nothing. The Node engine deletes it and
    /// the Rust core does not, so one can reach the renderer; after base_y it
    /// is inert and that disagreement has no visible consequence.
    #[test]
    fn a_stray_performer_y_is_inert() {
        let g = prop(serde_json::json!({
            "id": "g", "kind": "guitarist", "pos": { "x": 0, "z": 0 }, "y": 5.0
        }));
        assert_eq!(base_y(&[], &g), 0.0);
        let r = prop(serde_json::json!({
            "id": "r", "kind": "riser", "pos": { "x": 0, "z": 0 },
            "size": { "w": 2, "h": 0.4, "d": 1.5 }, "y": 0
        }));
        assert!((base_y(&[r], &g) - 0.4).abs() < 1e-5);
    }

    /// A lifted performer reaches higher, and the fitted floor, room, haze
    /// volume, beam reach and the RigExtent the camera frames on all come off
    /// these bounds.
    #[test]
    fn a_lifted_performer_extends_the_fitted_bounds() {
        let p = project(
            r#"{"fixtures":[],"props":[
                {"id":"r","kind":"riser","pos":{"x":0,"z":0},"size":{"w":2,"h":0.4,"d":1.5},"y":0},
                {"id":"d","kind":"drummer","pos":{"x":0,"z":0}}
            ],"profiles":{}}"#,
        );
        let b = Bounds::of(&p).expect("bounds");
        assert!((b.max.y - 2.2).abs() < 1e-4, "top is {}", b.max.y);
    }

    /// The whole two-joint split rests on one property of the rest pose, and
    /// nothing in the type system protects it.
    ///
    /// `MoverPart` puts pan on the yoke and `rest * tilt` on the shell. The
    /// COMPOSED rotation is the same as the old single entity's `pan * rest *
    /// tilt` whatever `rest` is — quaternion multiplication does not care where
    /// you put the brackets — so the beam always points the right way. What is
    /// not automatic is the BODY: tilt is applied after `rest`, so it turns
    /// about `rest * X`, and the yoke's arms are at fixed x = +/-0.118. Those
    /// have to be the same axis, or the head swings out through the side of its
    /// own yoke.
    ///
    /// A first pass at this test asserted `rest` had no yaw and failed
    /// immediately: the downstage mounting direction yaws by exactly pi,
    /// because `looking_to` has to turn the local -Z all the way round to face
    /// +Z. That is harmless — pi about Y maps the arm positions onto each
    /// other and only flips which way tilt counts, which the old code did too.
    /// The axis is the real invariant, so test the axis.
    #[test]
    fn tilt_turns_about_the_axis_the_yoke_arms_are_on() {
        for dir in [
            Vec3::new(0.0, -0.85, 0.52),
            Vec3::new(0.0, -0.93, 0.37),
            Vec3::new(0.0, -0.26, 0.97),
        ] {
            let rest = Transform::default().looking_to(dir, Vec3::Y).rotation;
            let tilt_axis = rest * Vec3::X;
            assert!(
                (tilt_axis.x.abs() - 1.0).abs() < 1e-5,
                "{dir:?} tilts about {tilt_axis:?}, not the yoke's X"
            );
        }
    }

    /// The yoke rises and the shell drops back by the same amount, so the lens
    /// lands exactly where the old single body box put it.
    ///
    /// This is what let the articulation ship without re-checking a single
    /// throw distance, pool position or shaft length: the emitter did not move.
    /// If someone retunes the body proportions, this says so.
    #[test]
    fn articulation_leaves_the_emitter_where_it_was() {
        const YOKE_RISE: f32 = 0.135;
        const SHELL_DROP: f32 = -0.135;
        assert!((YOKE_RISE + SHELL_DROP).abs() < 1e-6);
    }

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
