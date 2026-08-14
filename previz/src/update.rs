use bevy::pbr::FogVolume;
use bevy::prelude::*;
use std::collections::HashMap;

use crate::protocol::{WsEvent, WsReceiver};
use crate::scene::{BeamCone, BeamLight, DerbyFan, HeadTag, RingMesh, SourceGlow};
use crate::state::{Live, Smoothed};

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
                let mut prof_ids: Vec<_> = p.profiles.iter().collect();
                prof_ids.sort_by_key(|(id, _)| id.clone());
                for (id, cp) in prof_ids {
                    sig.push_str(&format!("{}#{};", id, cp.heads.len()));
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
    mut lights: Query<(&HeadTag, &BeamLight, &mut SpotLight)>,
    cones: Query<(&HeadTag, &BeamLight, &MeshMaterial3d<StandardMaterial>), With<BeamCone>>,
    glows: Query<(&HeadTag, &MeshMaterial3d<StandardMaterial>), With<SourceGlow>>,
    mut rings: Query<(&HeadTag, &mut Visibility), With<RingMesh>>,
    mut fans: Query<(&HeadTag, &mut Transform), With<DerbyFan>>,
    mut fogs: Query<&mut FogVolume>,
    mut materials: ResMut<Assets<StandardMaterial>>,
) {
    let dt = time.delta_secs();
    let now_s = time.elapsed_secs();
    let Some(snap) = live.snap.clone() else { return };

    let mut heads: HashMap<(String, usize), &crate::protocol::HeadLite> = HashMap::new();
    for h in &snap.heads {
        heads.insert((h.f.clone(), h.h), h);
    }

    // Smooth toward targets: fast attack, softer release.
    for (key, h) in &heads {
        let s = live.smoothed.entry(key.clone()).or_insert_with(Smoothed::default);
        let (ka, kr) = (1.0 - (-dt * 18.0).exp(), 1.0 - (-dt * 9.0).exp());
        let k = if h.i > s.i { ka } else { kr };
        s.i += (h.i - s.i) * k;
        s.r += (h.r - s.r) * ka;
        s.g += (h.g - s.g) * ka;
        s.b += (h.b - s.b) * ka;
        match h.mm.as_str() {
            "rotate" => s.spin += dt * (0.4 + h.mv * 5.2),
            "aim" => s.spin += (h.mv * std::f32::consts::PI - s.spin) * (1.0 - (-dt * 6.0).exp()),
            _ => {}
        }
    }

    for (tag, beam, mut light) in &mut lights {
        let key = (tag.fixture.clone(), tag.head);
        let (Some(h), Some(s)) = (heads.get(&key), live.smoothed.get(&key)) else {
            light.intensity = 0.0;
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
        light.color = Color::srgb(r, g, b);
        light.intensity = beam.lumens * s.i * gate(now_s, h.st);
    }

    // beam shafts: additive cones, energy scaled by live haze — no haze, no
    // visible beam, exactly like the real thing
    let haze_k = 0.10 + snap.haze * 0.60;
    for (tag, beam, mat) in &cones {
        let key = (tag.fixture.clone(), tag.head);
        let Some(m) = materials.get_mut(&mat.0) else { continue };
        let (Some(h), Some(s)) = (heads.get(&key), live.smoothed.get(&key)) else {
            m.base_color = Color::NONE;
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
        m.base_color = Color::LinearRgba(LinearRgba::new(r * 1.6 * e, g * 1.6 * e, b * 1.6 * e, e.min(1.0)));
    }

    for (tag, mat) in &glows {
        let key = (tag.fixture.clone(), tag.head);
        let Some(s) = live.smoothed.get(&key) else { continue };
        if let Some(m) = materials.get_mut(&mat.0) {
            let e = 1.5 + 55.0 * s.i;
            m.emissive = LinearRgba::rgb(s.r * e, s.g * e, s.b * e);
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

    // haze → participating-medium density
    for mut fog in &mut fogs {
        fog.density_factor = 0.045 + snap.haze * 0.28;
    }
}

/// LIGHT_PREVIZ_SHOT=<path.png>: save one screenshot of the rendered frame
/// ~5s after launch — lets the rendered output be inspected headlessly
/// (macOS screen-recording permission can't block an in-app capture).
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
