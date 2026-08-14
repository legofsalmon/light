//! Port of engine/test/smoke.ts — the Rust core must match the Node
//! reference engine's observable behaviour byte-for-byte.

use light_core::clock::BeatClock;
use light_core::defaults::default_project;
use light_core::osc::parse_osc;
use light_core::renderer::Renderer;
use light_core::state::EngineState;
use light_core::types::Command;

fn osc_buf(addr: &str, tags: &str, args: &[f64]) -> Vec<u8> {
    fn pad(s: &str) -> Vec<u8> {
        let len = (s.len() / 4 + 1) * 4;
        let mut b = vec![0u8; len];
        b[..s.len()].copy_from_slice(s.as_bytes());
        b
    }
    let mut out = pad(addr);
    out.extend(pad(&format!(",{tags}")));
    for (i, t) in tags.chars().enumerate() {
        if t == 'i' {
            out.extend((args[i] as i32).to_be_bytes());
        } else {
            out.extend((args[i] as f32).to_be_bytes());
        }
    }
    out
}

#[test]
fn osc_parse() {
    let m = parse_osc(&osc_buf("/composition/columns/3/connect", "i", &[1.0]));
    assert_eq!(m.len(), 1);
    assert_eq!(m[0].addr, "/composition/columns/3/connect");
    assert_eq!(m[0].args[0].as_i64(), Some(1));
    let f = parse_osc(&osc_buf("/composition/tempocontroller/tempo", "f", &[0.25]));
    assert!((f[0].args[0].as_f64().unwrap() - 0.25).abs() < 1e-6);
}

#[test]
fn merge_to_dmx() {
    let t0 = 1000.0;
    let mut st = EngineState::new(default_project(), t0);
    let mut r = Renderer::new();
    r.tick(&mut st, t0);

    // Red wash (col 1 of WASH), after the 0.8 s fade.
    st.trigger("layer-wash", 1, t0, light_core::state::LOCAL_CLIENT);
    let res = r.tick(&mut st, t0 + 900.0);
    let u1 = &res.buffers["u1"];
    assert_eq!(u1[20], 255, "bar par1 red");
    assert_eq!(u1[21], 0, "bar par1 green");
    assert_eq!(u1[23], 255, "bar par1 dimmer");
    assert_eq!(u1[35], 255, "bar par4 red (whole group)");
    assert_eq!(u1[50], 255, "bar2 red");
    assert_eq!(u1[0], 0, "derby untouched");

    // Derby Red Spin: macro Red=13, motor rotate 0.35 → 172.
    st.trigger("layer-derby", 1, t0 + 1000.0, light_core::state::LOCAL_CLIENT);
    let b2 = r.tick(&mut st, t0 + 2000.0).buffers["u1"];
    assert_eq!(b2[0], 13, "derby macro red");
    assert_eq!(b2[2], 128 + (0.35f64 * 127.0).round() as u8, "derby motor");
    assert_eq!(b2[10], 13, "derby2 same");

    // Grand master.
    st.master = 0.5;
    let b3 = r.tick(&mut st, t0 + 2100.0).buffers["u1"];
    assert!((b3[23] as i32 - 128).abs() <= 1, "gm halves dimmer, got {}", b3[23]);
    assert_eq!(b3[0], 13, "gm keeps macro");

    // Blackout.
    st.blackout = true;
    let b4 = r.tick(&mut st, t0 + 2200.0).buffers["u1"];
    assert_eq!(b4[23], 0, "blackout dimmer");
    assert_eq!(b4[0], 0, "blackout macro");
    st.blackout = false;
    st.master = 1.0;

    // FX multiply modulates dimmer, leaves colour (sample off the whole beat).
    st.trigger("layer-fx", 1, t0 + 3000.0, light_core::state::LOCAL_CLIENT);
    let b5 = r.tick(&mut st, t0 + 4100.0).buffers["u1"];
    assert_eq!(b5[20], 255, "fx leaves colour");
    assert!(b5[23] > 0 && b5[23] < 255, "fx modulates dimmer, got {}", b5[23]);

    // Flash blinder: latch while held, release drops it.
    st.trigger("layer-strobe", 1, t0 + 5000.0, light_core::state::LOCAL_CLIENT);
    let b6 = r.tick(&mut st, t0 + 5050.0).buffers["u1"];
    assert_eq!(b6[3], 220, "blinder ring on");
    st.release("layer-strobe", 1, t0 + 5100.0);
    let b7 = r.tick(&mut st, t0 + 5400.0).buffers["u1"];
    assert_eq!(b7[3], 0, "blinder released");

    // Column cue semantics.
    st.trigger_column(0, t0 + 6000.0);
    assert_eq!(st.layer_live("layer-strobe").look_id, None, "column skips flash");
    assert_eq!(
        st.layer_live("layer-wash").look_id.as_deref(),
        Some("wash-gold"),
        "column fires wash"
    );
    assert_eq!(st.layer_live("layer-derby").look_id, None, "column clears empty layer");

    // Held flash must drop when the last client disconnects.
    st.trigger("layer-strobe", 1, t0 + 8000.0, light_core::state::LOCAL_CLIENT);
    let b9 = r.tick(&mut st, t0 + 8050.0).buffers["u1"];
    assert_eq!(b9[3], 220, "held blinder on before disconnect");
    st.release_all_held(t0 + 8100.0, None);
    let b10 = r.tick(&mut st, t0 + 8400.0).buffers["u1"];
    assert_eq!(b10[3], 0, "release_all_held drops blinder");

    // Manual haze reaches the buffer.
    st.project.settings.haze = 0.5;
    let b8 = r.tick(&mut st, t0 + 7000.0).buffers["u1"];
    assert!((b8[100] as i32 - 128).abs() <= 1, "haze output, got {}", b8[100]);
    assert_eq!(b8[101], (0.35f64 * 255.0).round() as u8, "haze fan");
}

#[test]
fn gdtf_import_end_to_end() {
    use light_core::types::{Fixture, Group, HeadRef, Look, LookPart, PartParams, Vec3};

    fn b64(data: &[u8]) -> String {
        const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = String::new();
        for chunk in data.chunks(3) {
            let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
            let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
            out.push(A[(n >> 18) as usize & 63] as char);
            out.push(A[(n >> 12) as usize & 63] as char);
            out.push(if chunk.len() > 1 { A[(n >> 6) as usize & 63] as char } else { '=' });
            out.push(if chunk.len() > 2 { A[n as usize & 63] as char } else { '=' });
        }
        out
    }

    let t0 = 1000.0;
    let mut st = EngineState::new(default_project(), t0);
    let out = st.handle_command(
        Command::ImportGdtf {
            name: "synthetic.gdtf".into(),
            data: b64(include_bytes!("data/synthetic.gdtf")),
        },
        t0,
        None,
    );
    let (ok, msg, ids) = out.import_result.expect("import result");
    assert!(ok, "import failed: {msg}");
    assert_eq!(ids, vec!["gdtf-acme-testspot-100-standard".to_string()]);
    assert!(st.project.profiles.contains_key(&ids[0]));

    // patch it at 200 and fire a look at it
    st.project.fixtures.push(Fixture {
        id: "spot1".into(),
        name: "Test Spot".into(),
        profile_id: ids[0].clone(),
        universe_id: "u1".into(),
        address: 200,
        pos: Vec3 { x: 0.0, y: 3.0, z: 0.0 },
        rot_y: 0.0,
        rot_x: None,
        rot_z: None,
        pan: None,
        tilt: None,
    });
    st.project.groups.push(Group {
        id: "g-spot".into(),
        name: "Spot".into(),
        heads: vec![HeadRef { fixture_id: "spot1".into(), head: 0 }],
    });
    st.project.looks.insert(
        "look-spot".into(),
        Look {
            id: "look-spot".into(),
            name: "Spot test".into(),
            steps: None,
            parts: vec![LookPart {
                id: "p1".into(),
                group_id: "g-spot".into(),
                params: PartParams {
                    dimmer: Some(1.0),
                    color: Some(light_core::types::ColorHS { h: 0.0, s: 1.0 }),
                    pan: Some(0.5),
                    tilt: Some(1.0),
                    ..Default::default()
                },
                effects: vec![],
            }],
            flash: None,
            fade: None,
        },
    );
    st.project.layers[0].cells[0] = Some("look-spot".into());

    let mut r = Renderer::new();
    r.tick(&mut st, t0);
    st.trigger("layer-wash", 0, t0, light_core::state::LOCAL_CLIENT);
    let res = r.tick(&mut st, t0 + 1000.0); // > 0.8 s fade
    let u1 = &res.buffers["u1"];
    let base = 199;
    assert_eq!([u1[base], u1[base + 1]], [128, 0], "pan 16-bit");
    assert_eq!([u1[base + 2], u1[base + 3]], [255, 255], "tilt 16-bit");
    assert_eq!(u1[base + 4], 255, "dimmer");
    assert_eq!(u1[base + 5], 8, "shutter open default");
    assert_eq!([u1[base + 6], u1[base + 7], u1[base + 8]], [255, 0, 0], "rgb");
    assert_eq!(u1[base + 9], 128, "unmapped zoom default");
    assert_eq!(u1[base + 10], 23, "wheel quantised to red");
}

#[test]
fn nan_bpm_rejected() {
    let mut c = BeatClock::new(0.0);
    c.set_bpm(f64::NAN, 1000.0);
    assert_eq!(c.bpm, 120.0, "NaN must not poison the clock");
    c.set_bpm(f64::INFINITY, 1000.0);
    assert_eq!(c.bpm, 120.0);
    c.set_bpm(150.0, 1000.0);
    assert!((c.bpm - 150.0).abs() < 1e-9, "clock still works after rejection");
    assert!(c.beat_at(2000.0).is_finite());
}

#[test]
fn clock_math() {
    let mut c = BeatClock::new(0.0);
    c.set_bpm(120.0, 0.0);
    assert!((c.beat_at(1000.0) - c.beat_at(0.0) - 2.0).abs() < 1e-9);
    c.tap(10000.0);
    c.tap(10500.0);
    c.tap(11000.0);
    assert!((c.bpm - 120.0).abs() < 0.5, "tap tempo, got {}", c.bpm);
}

#[test]
fn protocol_json_shapes() {
    // Commands exactly as the UI sends them.
    let cmd: Command =
        serde_json::from_str(r#"{"type":"trigger","layerId":"layer-wash","col":2}"#).unwrap();
    assert!(matches!(cmd, Command::Trigger { ref layer_id, col: 2 } if layer_id == "layer-wash"));
    let cmd: Command = serde_json::from_str(r#"{"type":"setBpm","bpm":150}"#).unwrap();
    assert!(matches!(cmd, Command::SetBpm { bpm } if (bpm - 150.0).abs() < 1e-9));
    let cmd: Command = serde_json::from_str(
        r#"{"type":"learn","action":{"kind":"cell","layerId":"layer-fx","col":0}}"#,
    )
    .unwrap();
    assert!(matches!(cmd, Command::Learn { action: Some(_) }));
    let cmd: Command = serde_json::from_str(r#"{"type":"learn","action":null}"#).unwrap();
    assert!(matches!(cmd, Command::Learn { action: None }));

    // Project round-trips without losing fields the UI depends on.
    let p = default_project();
    let s = serde_json::to_string(&p).unwrap();
    let v: serde_json::Value = serde_json::from_str(&s).unwrap();
    assert!(v["looks"]["wash-red"]["parts"][0]["params"]["color"]["h"].is_number());
    assert_eq!(v["layers"][0]["cells"][0], serde_json::json!("wash-gold"));
    assert!(v["sync"]["oscPort"].is_number());
    assert!(v["settings"]["hazeFan"].is_number());
    let back: light_core::types::Project = serde_json::from_str(&s).unwrap();
    assert_eq!(back.fixtures.len(), p.fixtures.len());

    // Snapshot field naming (camelCase where it matters).
    let mut st = EngineState::new(default_project(), 0.0);
    let mut r = Renderer::new();
    let res = r.tick(&mut st, 0.0);
    let snap = serde_json::json!({
        "layers": res.layers,
        "heads": res.heads,
    });
    assert!(snap["layers"][0]["lookId"].is_null());
    assert!(snap["layers"][0].get("look_id").is_none());
}

#[test]
fn artnet_loopback() {
    use light_core::artnet::ArtnetOut;
    use std::net::UdpSocket;
    use std::time::Duration;

    let rx = match UdpSocket::bind("127.0.0.1:6454") {
        Ok(s) => s,
        Err(_) => {
            eprintln!("skip artnet loopback (:6454 busy)");
            return;
        }
    };
    rx.set_read_timeout(Some(Duration::from_secs(2))).unwrap();

    let mut st = EngineState::new(default_project(), 0.0);
    let mut r = Renderer::new();
    r.tick(&mut st, 0.0);
    st.trigger("layer-wash", 1, 0.0, light_core::state::LOCAL_CLIENT);
    let res = r.tick(&mut st, 2000.0);

    let mut tx = ArtnetOut::new();
    std::thread::sleep(Duration::from_millis(50));
    tx.send(1, &res.buffers["u1"], Some("127.0.0.1"));

    let mut pkt = [0u8; 600];
    let (n, _) = rx.recv_from(&mut pkt).expect("no packet received");
    assert_eq!(n, 530);
    assert_eq!(&pkt[..8], b"Art-Net\0");
    assert_eq!(u16::from_le_bytes([pkt[8], pkt[9]]), 0x5000);
    assert_eq!(pkt[14], 1);
    assert_eq!(pkt[15], 0);
    assert_eq!(u16::from_be_bytes([pkt[16], pkt[17]]), 512);
    assert_eq!(pkt[18 + 20], 255, "channel 21 par1 red");
}
