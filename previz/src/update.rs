use bevy::light::FogVolume;
use bevy::prelude::*;
use std::collections::HashMap;

use crate::protocol::{WsEvent, WsReceiver};
use crate::scene::{BeamCone, BeamLight, DerbyFan, HeadTag, MoverHead, RingMesh, SourceGlow};
use crate::state::{Live, Sent, Smoothed};

/// Pull everything the WS thread has queued into the Live resource.
pub fn drain_ws(rx: Res<WsReceiver>, mut live: ResMut<Live>) {
    let rx = rx.0.lock().unwrap();
    while let Ok(ev) = rx.try_recv() {
        match ev {
            WsEvent::Project(p) => {
                // Only rebuild the scene when the patch itself changed — the
                // engine echoes the whole project on every edit.
                let mut sig = p
                    .fixtures
                    .iter()
                    .map(|f| {
                        format!(
                            "{}|{}|{:.2},{:.2},{:.2}|{:.3},{:.3},{:.3};",
                            f.id,
                            f.profile_id,
                            f.pos.x,
                            f.pos.y,
                            f.pos.z,
                            f.rot_y,
                            f.rot_x.unwrap_or(0.0),
                            f.rot_z.unwrap_or(0.0)
                        )
                    })
                    .collect::<String>();
                for pr in &p.props {
                    // size and base-Y are part of the shape, not decoration:
                    // the patch table scrubs them live, and omitting them meant
                    // a riser's height or a screen's base could be changed
                    // without this window ever rebuilding — the geometry AND
                    // the fitted floor/backdrop/haze stayed at the old bounds
                    // until some unrelated fixture move forced a rebuild.
                    let s = pr.size.unwrap_or(crate::protocol::PropSizeLite { w: 0.0, h: 0.0, d: 0.0 });
                    sig.push_str(&format!(
                        "P{}|{}|{:.2},{:.2}|{:.2}|{:.2},{:.2},{:.2}|{:.2};",
                        pr.id,
                        pr.kind,
                        pr.pos.x,
                        pr.pos.z,
                        pr.rot_y.unwrap_or(0.0),
                        s.w,
                        s.h,
                        s.d,
                        pr.y.unwrap_or(0.0)
                    ));
                }
                let mut prof_ids: Vec<_> = p.profiles.iter().collect();
                prof_ids.sort_by(|a, b| a.0.cmp(b.0));
                for (id, cp) in prof_ids {
                    // head count alone missed a re-imported profile whose beam
                    // angle changed — the cones would keep the old spread; and
                    // since B1's layout editor, the OFFSETS can change without
                    // the count changing, so they sign too
                    sig.push_str(&format!("{}#{}#{:.2}", id, cp.heads.len(), cp.beam_deg));
                    for h in &cp.heads {
                        sig.push_str(&format!("|{:.3},{:.3}", h.offset, h.offset_y));
                    }
                    sig.push(';');
                }
                if sig != live.fixture_sig {
                    live.fixture_sig = sig;
                    live.project_rev += 1;
                }
                live.project = Some(p);
            }
            WsEvent::Snap(s) => live.snap = Some(s),
            WsEvent::Connected(c) => live.connected = c,
        }
    }
}

fn gate(now_s: f32, st: f32) -> f32 {
    if st <= 0.01 {
        return 1.0;
    }
    let hz = 2.0 + st * 12.0;
    if (now_s * hz).fract() < 0.5 {
        1.0
    } else {
        0.06
    }
}

/// Apply the latest snapshot to lights, glows, rings, fans, and fog —
/// smoothing intensities at render rate between 20 fps snapshots.
#[allow(clippy::too_many_arguments)]
pub fn apply_live(
    time: Res<Time>,
    mut live: ResMut<Live>,
    mut lights: Query<(&HeadTag, &BeamLight, &mut SpotLight, &mut Visibility), Without<RingMesh>>,
    cones: Query<(&HeadTag, &BeamLight, &MeshMaterial3d<StandardMaterial>), With<BeamCone>>,
    glows: Query<(&HeadTag, &MeshMaterial3d<StandardMaterial>), With<SourceGlow>>,
    mut rings: Query<(&HeadTag, &mut Visibility), With<RingMesh>>,
    mut fans: Query<(&HeadTag, &mut Transform), With<DerbyFan>>,
    mut movers: Query<(&HeadTag, &MoverHead, &mut Transform), Without<DerbyFan>>,
    // Beam cones live one level under the head, so they need their own mutable
    // Transform access. Disjoint from `movers` (Without<MoverHead>) and from
    // `fans` (Without<DerbyFan>), which is what lets Bevy accept three
    // simultaneous &mut Transform queries.
    mut mover_cones: Query<
        (&HeadTag, &mut Transform),
        (With<BeamCone>, Without<MoverHead>, Without<DerbyFan>),
    >,
    mut fogs: Query<&mut FogVolume>,
    mut materials: ResMut<Assets<StandardMaterial>>,
    q: Res<crate::quality::Quality>,
) {
    let dt = time.delta_secs();
    let now_s = time.elapsed_secs();
    let Some(snap) = live.snap.clone() else { return };

    let mut heads: HashMap<(String, usize), &crate::protocol::HeadLite> = HashMap::new();
    for h in &snap.heads {
        heads.insert((h.f.clone(), h.h), h);
    }

    // If the engine is gone, everything below would keep animating from the LAST
    // snapshot — strobe gates and derby spins run off this window's own clock,
    // so the previz carries on looking live while DMX may be dark or frozen.
    // The one tool meant to mirror the stage must not confidently lie about it:
    // fade to dark instead, and stop advancing the self-driven animation. The
    // window title says why.
    let connected = live.connected;

    // Smooth toward targets: fast attack, softer release.
    for (key, h) in &heads {
        let s = live.smoothed.entry(key.clone()).or_insert_with(Smoothed::default);
        let (ka, kr) = (1.0 - (-dt * 18.0).exp(), 1.0 - (-dt * 9.0).exp());
        let target = if connected { h.i } else { 0.0 };
        let k = if target > s.i { ka } else { kr };
        s.i += (target - s.i) * k;
        s.r += (h.r - s.r) * ka;
        s.g += (h.g - s.g) * ka;
        s.b += (h.b - s.b) * ka;
        if connected {
            match h.mm.as_str() {
                "rotate" => s.spin += dt * (0.4 + h.mv * 5.2),
                "aim" => s.spin += (h.mv * std::f32::consts::PI - s.spin) * (1.0 - (-dt * 6.0).exp()),
                _ => {}
            }
        }
    }

    // A dark light is not a free light. Every visible SpotLight is assigned to
    // clusters each frame and, if it casts shadows, gets its own depth pass —
    // whether or not its intensity is zero. On this rig that is 153 lights
    // being clustered to render a blackout. Hiding the dark ones takes them out
    // of both, and a cue lights a few dozen heads, not all of them.
    //
    // `set_if_neq` matters as much as the test: writing Visibility every frame
    // dirties it and re-runs propagation for the whole subtree.
    const LIGHT_ON: f32 = 0.0015;
    for (tag, beam, mut light, mut vis) in &mut lights {
        let key = (tag.fixture.clone(), tag.head);
        let (Some(h), Some(s)) = (heads.get(&key), live.smoothed.get(&key)) else {
            if light.intensity != 0.0 {
                light.intensity = 0.0;
            }
            vis.set_if_neq(Visibility::Hidden);
            continue;
        };
        let (mut r, mut g, mut b) = (s.r, s.g, s.b);
        if let Some(mc) = &h.mc {
            if !mc.is_empty() {
                let c = mc[beam.idx % mc.len()];
                r = c[0] as f32 / 255.0;
                g = c[1] as f32 / 255.0;
                b = c[2] as f32 / 255.0;
            }
        }
        let energy = s.i * gate(now_s, h.st);
        if energy < LIGHT_ON {
            vis.set_if_neq(Visibility::Hidden);
            continue;
        }
        vis.set_if_neq(Visibility::Inherited);
        light.color = Color::srgb(r, g, b);
        light.intensity = beam.lumens * energy;
    }

    // Beam shafts: additive cones, energy scaled by live haze — no haze, no
    // visible beam, exactly like the real thing.
    //
    // Guarded by `Sent`. Every `materials.get_mut` here marks a material
    // changed, and 150 heads x (cone + glow) x 60 fps is 18,000 material
    // re-uploads a second for a rig that is mostly holding still. Writing only
    // what actually moved is the difference between this renderer being usable
    // on an arena plot and not.
    // See Quality::haze_floor — a show with no haze programmed has no visible
    // beams, which is true and unhelpful in the window built to judge them.
    let haze = snap.haze.max(q.haze_floor);
    let haze_k = (0.10 + haze * 0.60) * q.beam_gain;
    let mut pending: Vec<((String, usize), Sent)> = Vec::new();
    for (tag, beam, mat) in &cones {
        let key = (tag.fixture.clone(), tag.head);
        let (Some(h), Some(s)) = (heads.get(&key), live.smoothed.get(&key)) else {
            // Unknown head: park it dark, once.
            if let Some(mut m) = materials.get_mut(&mat.0) {
                if m.base_color != Color::NONE {
                    m.base_color = Color::NONE;
                }
            }
            continue;
        };
        let (mut r, mut g, mut b) = (s.r, s.g, s.b);
        if let Some(mc) = &h.mc {
            if !mc.is_empty() {
                let c = mc[beam.idx % mc.len()];
                r = c[0] as f32 / 255.0;
                g = c[1] as f32 / 255.0;
                b = c[2] as f32 / 255.0;
            }
        }
        let e = s.i * gate(now_s, h.st) * haze_k;
        let want = Sent { r, g, b, e };
        if s.sent.is_some_and(|p| !p.differs(&want)) {
            continue;
        }
        pending.push((key, want));
        let Some(mut m) = materials.get_mut(&mat.0) else { continue };
        m.base_color = Color::LinearRgba(LinearRgba::new(r * 1.6 * e, g * 1.6 * e, b * 1.6 * e, e.min(1.0)));
    }

    for (tag, mat) in &glows {
        let key = (tag.fixture.clone(), tag.head);
        let Some(s) = live.smoothed.get(&key) else { continue };
        // Same guard, keyed off the same record: the glow is driven by the same
        // four numbers as the cone, so if the cone had nothing to say neither
        // does the glow.
        let want = Sent { r: s.r, g: s.g, b: s.b, e: s.i };
        if s.sent.is_some_and(|p| !p.differs(&want)) {
            continue;
        }
        if let Some(mut m) = materials.get_mut(&mat.0) {
            let e = 1.5 + 55.0 * s.i;
            m.emissive = LinearRgba::rgb(s.r * e, s.g * e, s.b * e);
        }
    }

    for (key, want) in pending {
        if let Some(s) = live.smoothed.get_mut(&key) {
            s.sent = Some(want);
        }
    }

    for (tag, mut vis) in &mut rings {
        let key = (tag.fixture.clone(), tag.head);
        let ring = heads.get(&key).map(|h| h.ring).unwrap_or(0.0);
        let on = ring >= 1.0 || (ring > 0.0 && (now_s / 0.26).fract() < 0.5);
        *vis = if on && ring > 0.0 { Visibility::Visible } else { Visibility::Hidden };
    }

    for (tag, mut tf) in &mut fans {
        let key = (tag.fixture.clone(), tag.head);
        if let Some(s) = live.smoothed.get(&key) {
            tf.rotation = Quat::from_rotation_z(s.spin);
        }
    }

    // moving heads: steer the beam by the live pan/tilt. 0.5 is centre, so a
    // fixture with no base aim and no look driving it rests exactly where its
    // mounting points — the same place it sat before movers could aim.
    // The cone length is baked at spawn from the RESTING aim, so without this
    // a mover that tilts to near-horizontal still ends its shaft 9 m out in
    // mid-air, and one that tilts steeply down punches through the riser it is
    // pointed at. Movers are the dominant arena fixture, so most of what this
    // view exists to judge — where the moving beams land — was wrong the moment
    // anything moved. One ray-plane intersection per mover per snapshot.
    let mut cone_scales: HashMap<(String, usize), Vec3> = HashMap::new();
    for (tag, mv, mut tf) in &mut movers {
        let key = (tag.fixture.clone(), tag.head);
        // Steer by the head that CARRIES the aim channels, which for a pixel
        // mover is not this beam's own head (see MoverHead::aim_head).
        let Some(h) = heads.get(&(tag.fixture.clone(), mv.aim_head)) else { continue };
        let pan = (h.pan - 0.5) * mv.pan_range;
        let tilt = (h.tilt - 0.5) * mv.tilt_range;
        // pan about the rig's vertical, then tilt about the head's own local X
        tf.rotation = Quat::from_rotation_y(pan) * mv.rest * Quat::from_rotation_x(tilt);

        // world beam direction: the cone opens along the head's local -Z
        let dir = (mv.root_rot * (tf.rotation * Vec3::NEG_Z)).normalize_or_zero();
        let throw = if dir.y < -0.01 {
            (mv.height / -dir.y).clamp(1.0, mv.max_throw) // hits the floor
        } else {
            mv.max_throw // level or climbing — draw the full shaft
        };
        let r = (throw * mv.outer.tan()).max(0.02);
        cone_scales.insert(key, Vec3::new(r, r, throw));
    }
    for (tag, mut tf) in &mut mover_cones {
        if let Some(s) = cone_scales.get(&(tag.fixture.clone(), tag.head)) {
            tf.scale = *s;
        }
    }

    // haze → participating-medium density
    for mut fog in &mut fogs {
        fog.density_factor = 0.045 + snap.haze.max(q.haze_floor) * 0.28;
    }
}

/// LIGHT_PREVIZ_SHOT=<path.png>: save one screenshot of the rendered frame
/// ~5s after launch — lets the rendered output be inspected headlessly
/// (macOS screen-recording permission can't block an in-app capture).
/// F12 saves a PNG of the window. Iterating on how this thing LOOKS needs a
/// picture, and a picture of a native window otherwise means the OS screen
/// recorder and its permission prompt. Writes beside the binary's working
/// directory unless LIGHT_PREVIZ_SHOTDIR says otherwise.
pub fn key_screenshot(
    mut commands: Commands,
    keys: Res<ButtonInput<KeyCode>>,
    mut n: Local<u32>,
) {
    if !keys.just_pressed(KeyCode::F12) {
        return;
    }
    let dir = std::env::var("LIGHT_PREVIZ_SHOTDIR").unwrap_or_else(|_| ".".into());
    let path = format!("{dir}/previz-{:03}.png", *n);
    *n += 1;
    eprintln!("[previz] screenshot -> {path}");
    commands
        .spawn(bevy::render::view::screenshot::Screenshot::primary_window())
        .observe(bevy::render::view::screenshot::save_to_disk(path));
}

pub fn auto_screenshot(mut commands: Commands, time: Res<Time>, mut shots: Local<u32>) {
    if *shots >= 2 {
        return;
    }
    let Ok(path) = std::env::var("LIGHT_PREVIZ_SHOT") else {
        *shots = 2;
        return;
    };
    let due = if *shots == 0 { 5.0 } else { 9.0 };
    if time.elapsed_secs() < due {
        return;
    }
    let path = if *shots == 0 { path } else { path.replace(".png", "-b.png") };
    *shots += 1;
    commands
        .spawn(bevy::render::view::screenshot::Screenshot::primary_window())
        .observe(bevy::render::view::screenshot::save_to_disk(path));
}

/// LIGHT_PREVIZ_DIAG=1: log render-state ground truth every 2s so a dark
/// window can be diagnosed from the terminal (is it data, scene, or light?).
pub fn diag_state(
    time: Res<Time>,
    live: Res<Live>,
    lights: Query<&SpotLight, With<BeamLight>>,
    lit_detail: Query<
        (&HeadTag, &SpotLight, &InheritedVisibility, &ViewVisibility, &GlobalTransform),
        With<BeamLight>,
    >,
    fogs: Query<&FogVolume>,
    mut last: Local<f32>,
    mut enabled: Local<Option<bool>>,
) {
    let on = *enabled.get_or_insert_with(|| std::env::var("LIGHT_PREVIZ_DIAG").is_ok());
    if !on {
        return;
    }
    let now = time.elapsed_secs();
    if now - *last < 2.0 {
        return;
    }
    *last = now;
    let total = lights.iter().count();
    let lit = lights.iter().filter(|l| l.intensity > 1.0).count();
    let max_i = lights.iter().map(|l| l.intensity).fold(0.0f32, f32::max);
    let fog = fogs.iter().next().map(|f| f.density_factor).unwrap_or(-1.0);
    let (snap_heads, haze) = live
        .snap
        .as_ref()
        .map(|s| (s.heads.len(), s.haze))
        .unwrap_or((0, -1.0));
    let fixtures = live.project.as_ref().map(|p| p.fixtures.len()).unwrap_or(0);
    eprintln!(
        "[previz-diag] connected={} fixtures={fixtures} spotlights={total} lit={lit} maxI={max_i:.0} fog={fog:.3} snapHeads={snap_heads} haze={haze:.2}",
        live.connected
    );
    if let Some((tag, sl, inh, view, gt)) = lit_detail.iter().find(|(_, sl, ..)| sl.intensity > 1.0) {
        let (_, rot, pos) = gt.to_scale_rotation_translation();
        let dir = rot * Vec3::NEG_Z;
        eprintln!(
            "[previz-diag]   e.g. {}#{}: I={:.0} rgba={:?} inherited_vis={} view_vis={} pos=({:.1},{:.1},{:.1}) dir=({:.2},{:.2},{:.2}) range={} outer={:.2}",
            tag.fixture, tag.head, sl.intensity, sl.color, inh.get(), view.get(),
            pos.x, pos.y, pos.z, dir.x, dir.y, dir.z, sl.range, sl.outer_angle
        );
    }
}

/// Say in the title bar when the engine is gone.
///
/// The scene fades to dark on disconnect (see `apply_live`), which is honest
/// but ambiguous on its own — a dark stage is also a legitimate look. The title
/// is what distinguishes "the rig is out" from "I am not being told anything".
pub fn reflect_connection(
    live: Res<Live>,
    mut windows: Query<&mut Window>,
    mut was: Local<Option<bool>>,
) {
    if *was == Some(live.connected) {
        return; // only touch the window when it actually changes
    }
    *was = Some(live.connected);
    let Ok(mut w) = windows.single_mut() else { return };
    w.title = if live.connected {
        "LIGHT · Previz".to_string()
    } else {
        "LIGHT · Previz — DISCONNECTED (engine not reachable)".to_string()
    };
}
