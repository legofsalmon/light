use std::collections::HashMap;

use crate::color::{derby_macro_for_value, derby_quantize, hsv_to_rgb, rgb_to_hsv, DERBY_MACROS};
use crate::effects::apply_effects;
use crate::profiles::{profile_of, HeadKind, ResolvedParams};
use crate::state::EngineState;
use crate::types::{clamp01, lerp, HeadSnap, LayerBlend, LayerSnap, MotorMode};

const N_FIELDS: usize = 9;
#[derive(Clone, Copy, PartialEq, Eq)]
enum Field {
    Dimmer = 0,
    White,
    RingFx,
    Strobe,
    Pan,
    Tilt,
    Haze,
    Fan,
    MotorValue,
}
const ALL_FIELDS: [Field; N_FIELDS] = [
    Field::Dimmer, Field::White, Field::RingFx, Field::Strobe, Field::Pan,
    Field::Tilt, Field::Haze, Field::Fan, Field::MotorValue,
];

fn get_field(p: &ResolvedParams, f: Field) -> f64 {
    match f {
        Field::Dimmer => p.dimmer,
        Field::White => p.white,
        Field::RingFx => p.ring_fx,
        Field::Strobe => p.strobe,
        Field::Pan => p.pan,
        Field::Tilt => p.tilt,
        Field::Haze => p.haze,
        Field::Fan => p.fan,
        Field::MotorValue => p.motor_value,
    }
}
fn set_field(p: &mut ResolvedParams, f: Field, v: f64) {
    match f {
        Field::Dimmer => p.dimmer = v,
        Field::White => p.white = v,
        Field::RingFx => p.ring_fx = v,
        Field::Strobe => p.strobe = v,
        Field::Pan => p.pan = v,
        Field::Tilt => p.tilt = v,
        Field::Haze => p.haze = v,
        Field::Fan => p.fan = v,
        Field::MotorValue => p.motor_value = v,
    }
}

#[derive(Default)]
struct Acc {
    num: [Option<(f64, f64)>; N_FIELDS], // (weighted sum, weight)
    col: Option<(f64, f64, f64, f64)>,   // (r,g,b, weight)
    motor_mode: Option<MotorMode>,
    macro_: Option<f64>,
}

pub struct TickResult {
    pub buffers: HashMap<String, [u8; 512]>,
    pub heads: Vec<HeadSnap>,
    pub layers: Vec<LayerSnap>,
    pub beat: f64,
}

pub struct Renderer {
    eff_beat: f64,
    last_t: Option<f64>,
}

impl Renderer {
    pub fn new() -> Self {
        Renderer { eff_beat: 0.0, last_t: None }
    }

    pub fn tick(&mut self, st: &mut EngineState, t: f64) -> TickResult {
        let beat = st.clock.beat_at(t);
        let dt = self.last_t.map_or(0.0, |lt| t - lt);
        self.last_t = Some(t);
        // Integrated so speed-master changes never jump effect phase.
        self.eff_beat += (dt / 60000.0) * st.clock.bpm * st.speed;

        // --- resolved params per head ---
        struct HeadInfo {
            key: (String, usize),
            kind: HeadKind,
        }
        let mut heads: HashMap<(String, usize), ResolvedParams> = HashMap::new();
        let mut head_order: Vec<HeadInfo> = Vec::new();
        for f in &st.project.fixtures {
            let Some(prof) = profile_of(&f.profile_id) else { continue };
            for (i, hd) in prof.heads.iter().enumerate() {
                let key = (f.id.clone(), i);
                heads.insert(key.clone(), ResolvedParams::default());
                head_order.push(HeadInfo { key, kind: hd.kind });
            }
        }

        // --- layer stack (index 0 = bottom) ---
        let mut layer_snaps: Vec<LayerSnap> = Vec::new();
        let layer_ids: Vec<String> = st.project.layers.iter().map(|l| l.id.clone()).collect();
        for layer_id in &layer_ids {
            let Some(layer) = st.project.layers.iter().find(|l| &l.id == layer_id).cloned() else { continue };
            let live = st.layer_live(layer_id);
            let tau = if live.fade_dur <= 0.0 {
                1.0
            } else {
                clamp01((t - live.fade_start) / (live.fade_dur * 1000.0))
            };
            if tau >= 1.0 && live.prev_id.is_some() {
                live.prev_id = None;
            }
            layer_snaps.push(LayerSnap {
                id: layer.id.clone(),
                look_id: live.look_id.clone(),
                prev_id: live.prev_id.clone(),
                col: live.col,
                t: tau,
            });
            if live.look_id.is_none() && live.prev_id.is_none() {
                continue;
            }

            // Weighted combination of outgoing and incoming look, per head.
            let sources = [
                (live.prev_id.clone(), 1.0 - tau, false),
                (live.look_id.clone(), tau, true),
            ];
            let mut acc: HashMap<(String, usize), Acc> = HashMap::new();
            for (look_id, w, incoming) in sources {
                let Some(look_id) = look_id else { continue };
                if w <= 0.001 {
                    continue;
                }
                let Some(look) = st.project.looks.get(&look_id) else { continue };
                for part in &look.parts {
                    let Some(group) = st.project.groups.iter().find(|g| g.id == part.group_id) else { continue };
                    let n = group.heads.len();
                    for (j, r) in group.heads.iter().enumerate() {
                        let key = (r.fixture_id.clone(), r.head);
                        if !heads.contains_key(&key) {
                            continue;
                        }
                        let prm = apply_effects(&part.params, &part.effects, self.eff_beat, j, n);
                        let a = acc.entry(key).or_default();
                        let mut add_num = |field: Field, v: Option<f64>| {
                            if let Some(v) = v {
                                let c = a.num[field as usize].get_or_insert((0.0, 0.0));
                                c.0 += v * w;
                                c.1 += w;
                            }
                        };
                        add_num(Field::Dimmer, prm.dimmer);
                        add_num(Field::White, prm.white);
                        add_num(Field::RingFx, prm.ring_fx);
                        add_num(Field::Strobe, prm.strobe);
                        add_num(Field::Pan, prm.pan);
                        add_num(Field::Tilt, prm.tilt);
                        add_num(Field::Haze, prm.haze);
                        add_num(Field::Fan, prm.fan);
                        add_num(Field::MotorValue, prm.motor_value);
                        if let Some(c) = prm.color {
                            let (r, g, b) = hsv_to_rgb(c.h, c.s, 1.0);
                            let col = a.col.get_or_insert((0.0, 0.0, 0.0, 0.0));
                            col.0 += r * w;
                            col.1 += g * w;
                            col.2 += b * w;
                            col.3 += w;
                        }
                        // Banded/snap fields take the incoming look's value from fade start.
                        if prm.motor_mode.is_some() && (incoming || a.motor_mode.is_none()) {
                            a.motor_mode = prm.motor_mode;
                        }
                        if prm.macro_.is_some() && (incoming || a.macro_.is_none()) {
                            a.macro_ = prm.macro_;
                        }
                    }
                }
            }

            // Apply this layer onto the stack.
            let m = layer.master;
            for (key, a) in acc {
                let Some(out) = heads.get_mut(&key) else { continue };
                for f in ALL_FIELDS {
                    let Some((sum, w)) = a.num[f as usize] else { continue };
                    if w <= 0.0 {
                        continue;
                    }
                    let val = sum / w;
                    let sw = w.min(1.0);
                    let is_intensity = f == Field::Dimmer || f == Field::White;
                    let cur = get_field(out, f);
                    let next = if layer.blend == LayerBlend::Multiply && is_intensity {
                        let factor = lerp(1.0, lerp(1.0, val, sw), m);
                        clamp01(cur * factor)
                    } else if layer.blend == LayerBlend::Htp && is_intensity {
                        cur.max(clamp01(val * m) * sw)
                    } else {
                        clamp01(lerp(cur, if is_intensity { val * m } else { val }, sw))
                    };
                    set_field(out, f, next);
                }
                if let Some((r, g, b, w)) = a.col {
                    if w > 0.0 {
                        let sw = w.min(1.0);
                        out.r = clamp01(lerp(out.r, r / w, sw));
                        out.g = clamp01(lerp(out.g, g / w, sw));
                        out.b = clamp01(lerp(out.b, b / w, sw));
                    }
                }
                if let Some(mm) = a.motor_mode {
                    out.motor_mode = mm;
                }
                if a.macro_.is_some() {
                    out.macro_ = a.macro_;
                }
            }
        }

        // --- manual haze merges HTP so looks can only add ---
        for ho in &head_order {
            if ho.kind != HeadKind::Hazer {
                continue;
            }
            if let Some(o) = heads.get_mut(&ho.key) {
                o.haze = o.haze.max(st.project.settings.haze);
                o.fan = o.fan.max(st.project.settings.haze_fan);
            }
        }

        // --- grand master & blackout ---
        for o in heads.values_mut() {
            o.dimmer = clamp01(o.dimmer * st.master);
            o.white = clamp01(o.white * st.master);
            if st.blackout {
                o.dimmer = 0.0;
                o.white = 0.0;
                o.strobe = 0.0;
                o.ring_fx = 0.0;
            }
        }

        // --- render to DMX buffers ---
        let mut buffers: HashMap<String, [u8; 512]> = HashMap::new();
        for u in &st.project.universes {
            buffers.insert(u.id.clone(), [0u8; 512]);
        }
        for f in &st.project.fixtures {
            let Some(prof) = profile_of(&f.profile_id) else { continue };
            let Some(buf) = buffers.get_mut(&f.universe_id) else { continue };
            if f.address < 1 || f.address - 1 + prof.channels > 512 {
                continue;
            }
            let hp: Vec<&ResolvedParams> = (0..prof.heads.len())
                .filter_map(|i| heads.get(&(f.id.clone(), i)))
                .collect();
            if hp.len() != prof.heads.len() {
                continue; // duplicate fixture ids or corrupt patch — skip, never panic
            }
            (prof.render)(&hp, buf, f.address - 1);
        }

        // --- previz snapshot ---
        let mut head_snaps: Vec<HeadSnap> = Vec::with_capacity(head_order.len());
        for ho in &head_order {
            let Some(o) = heads.get(&ho.key) else { continue };
            let (mut r, mut g, mut b, mut i) = (o.r, o.g, o.b, o.dimmer);
            let mut mc: Option<Vec<[u8; 3]>> = None;
            if ho.kind == HeadKind::Derby {
                let lit = o.dimmer > 0.02;
                let mac = if !lit {
                    &DERBY_MACROS[0]
                } else if let Some(mv) = o.macro_ {
                    derby_macro_for_value(mv)
                } else {
                    let (h, s, _) = rgb_to_hsv(o.r, o.g, o.b);
                    derby_quantize(h, s)
                };
                mc = Some(mac.comps.to_vec());
                if mac.comps.is_empty() {
                    i = 0.0;
                } else {
                    let (mut ar, mut ag, mut ab) = (0.0, 0.0, 0.0);
                    for c in mac.comps {
                        ar += c[0] as f64;
                        ag += c[1] as f64;
                        ab += c[2] as f64;
                    }
                    let n = mac.comps.len() as f64 * 255.0;
                    r = ar / n;
                    g = ag / n;
                    b = ab / n;
                }
            }
            if ho.kind == HeadKind::Hazer {
                i = o.haze;
                r = 0.85;
                g = 0.85;
                b = 0.85;
            }
            let ring = if o.white >= 0.5 {
                1.0
            } else if o.ring_fx > 0.01 {
                0.5
            } else {
                0.0
            };
            head_snaps.push(HeadSnap {
                f: ho.key.0.clone(),
                h: ho.key.1,
                r, g, b, i,
                st: o.strobe,
                ring,
                mm: o.motor_mode,
                mv: o.motor_value,
                pan: o.pan,
                tilt: o.tilt,
                mc: mc.filter(|v| !v.is_empty()),
            });
        }

        TickResult { buffers, heads: head_snaps, layers: layer_snaps, beat }
    }
}
