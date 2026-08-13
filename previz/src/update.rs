use bevy::pbr::FogVolume;
use bevy::prelude::*;
use std::collections::HashMap;

use crate::protocol::{WsEvent, WsReceiver};
use crate::scene::{BeamLight, DerbyFan, HeadTag, RingMesh, SourceGlow};
use crate::state::{Live, Smoothed};

/// Pull everything the WS thread has queued into the Live resource.
pub fn drain_ws(rx: Res<WsReceiver>, mut live: ResMut<Live>) {
    let rx = rx.0.lock().unwrap();
    while let Ok(ev) = rx.try_recv() {
        match ev {
            WsEvent::Project(p) => {
                // Only rebuild the scene when the patch itself changed — the
                // engine echoes the whole project on every edit.
                let sig = p
                    .fixtures
                    .iter()
                    .map(|f| {
                        format!(
                            "{}|{}|{:.2},{:.2},{:.2}|{:.3};",
                            f.id, f.profile_id, f.pos.x, f.pos.y, f.pos.z, f.rot_y
                        )
                    })
                    .collect::<String>();
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
