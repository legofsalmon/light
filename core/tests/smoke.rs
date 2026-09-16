//! Port of engine/test/smoke.ts — the Rust core must match the Node
//! reference engine's observable behaviour byte-for-byte.

use light_core::clock::BeatClock;
use light_core::defaults::default_project;

/// The demo show these tests were written against — five fixtures at known
/// addresses, looks with known ids. Deliberately NOT the shipped default: that
/// is a real 20-song set list now, and pinning byte assertions to its artistic
/// content means editing a song looks like an engine regression.
fn demo_project() -> light_core::types::Project {
    serde_json::from_str(include_str!("data/demo_project.json"))
        .expect("demo fixture must parse")
}
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


/// Minimal base64 for feeding fixture archives to the import command.
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
    let mut st = EngineState::new(demo_project(), t0);
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


    let t0 = 1000.0;
    let mut st = EngineState::new(demo_project(), t0);
    let out = st.handle_command(
        Command::ImportGdtf {
            name: "synthetic.gdtf".into(),
            data: b64(include_bytes!("data/synthetic.gdtf")),
            credit: None
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
        cal: None,
        parent_id: None,
    });
    st.project.groups.push(Group {
        id: "g-spot".into(),
        name: "Spot".into(),
        heads: vec![HeadRef { fixture_id: "spot1".into(), head: 0 }],
        auto: None,
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
    let p = demo_project();
    let s = serde_json::to_string(&p).unwrap();
    let v: serde_json::Value = serde_json::from_str(&s).unwrap();
    assert!(v["looks"]["wash-red"]["parts"][0]["params"]["color"]["h"].is_number());
    assert_eq!(v["layers"][0]["cells"][0], serde_json::json!("wash-gold"));
    assert!(v["sync"]["oscPort"].is_number());
    assert!(v["settings"]["hazeFan"].is_number());
    let back: light_core::types::Project = serde_json::from_str(&s).unwrap();
    assert_eq!(back.fixtures.len(), p.fixtures.len());

    // Snapshot field naming (camelCase where it matters).
    let mut st = EngineState::new(demo_project(), 0.0);
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

    let mut st = EngineState::new(demo_project(), 0.0);
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

/// The active song has to survive the round trip in the spelling the UI reads.
/// It did not: `Project` was the one struct without `rename_all`, so the
/// shipping engine wrote `active_deck_id` while the UI, shared/types.ts and the
/// Node engine all looked for `activeDeckId` — no deck chip ever lit and the
/// prev/next song controls navigated from index 0 whatever was playing.
#[test]
fn active_deck_id_crosses_the_wire_as_camel_case() {
    let mut p = demo_project();
    p.active_deck_id = Some("deck-14".into());
    let json = serde_json::to_string(&p).unwrap();
    assert!(json.contains("\"activeDeckId\":\"deck-14\""), "must write camelCase");
    assert!(!json.contains("active_deck_id"), "must not write snake_case");

    // and it reads back
    let back: light_core::types::Project = serde_json::from_str(&json).unwrap();
    assert_eq!(back.active_deck_id.as_deref(), Some("deck-14"));
}

/// Shows saved by an earlier build carry the snake_case spelling. Loading one
/// must keep its active deck rather than silently resetting to the first song.
#[test]
fn legacy_snake_case_active_deck_still_loads() {
    let mut p = demo_project();
    p.active_deck_id = Some("deck-7".into());
    let json = serde_json::to_string(&p).unwrap();
    let legacy = json.replace("\"activeDeckId\"", "\"active_deck_id\"");
    assert!(legacy.contains("active_deck_id"));

    let back: light_core::types::Project = serde_json::from_str(&legacy).unwrap();
    assert_eq!(back.active_deck_id.as_deref(), Some("deck-7"), "legacy spelling must migrate");
}

/// The fixture library has a home now. ROADMAP has promised this path since
/// v0.4 and nothing ever created it, so a downloaded .gdtf had nowhere to go.
#[test]
fn fixture_library_sits_beside_the_projects() {
    // env override wins, like the project dir
    std::env::set_var("LIGHT_FIXTURE_DIR", "/tmp/light-fixtures-test");
    assert_eq!(
        light_core::persist::fixture_dir(),
        std::path::PathBuf::from("/tmp/light-fixtures-test")
    );
    std::env::remove_var("LIGHT_FIXTURE_DIR");

    // otherwise it is a sibling of the projects directory, never inside it —
    // a library belongs to the machine, not to one show
    std::env::set_var("LIGHT_PROJECT_DIR", "/tmp/light-x/projects");
    let d = light_core::persist::fixture_dir();
    assert_eq!(d, std::path::PathBuf::from("/tmp/light-x/fixtures"));
    assert!(!d.starts_with("/tmp/light-x/projects"));
    std::env::remove_var("LIGHT_PROJECT_DIR");
}


/// The credit has to reach the compiled profile, because the profile is what
/// ends up inside a project file that travels to the gig. A GDTF carries no
/// author attribute, so if the importer drops what the caller supplied there is
/// nowhere else for it to come from.
#[test]
fn an_imported_profile_keeps_the_credit_it_was_given() {
    use light_core::state::EngineState;
    use light_core::types::Command;
    let t0 = 0.0;
    let mut st = EngineState::new(demo_project(), t0);
    let out = st.handle_command(
        Command::ImportGdtf {
            name: "synthetic.gdtf".into(),
            data: b64(include_bytes!("data/synthetic.gdtf")),
            credit: Some("dmueller · manufacturer".into()),
        },
        t0,
        None,
    );
    let (ok, _msg, ids) = out.import_result.expect("import result");
    assert!(ok, "import should succeed");
    assert!(!ids.is_empty(), "should have produced a profile");
    for id in &ids {
        let p = st.project.profiles.get(id).expect("profile stored");
        assert_eq!(
            p.credit.as_deref(),
            Some("dmueller · manufacturer"),
            "profile {id} lost its credit"
        );
    }

    // and a hand-picked file with no known author records nothing rather than
    // inventing something
    let out2 = st.handle_command(
        Command::ImportGdtf {
            name: "synthetic.gdtf".into(),
            data: b64(include_bytes!("data/synthetic.gdtf")),
            credit: None,
        },
        t0,
        None,
    );
    let (_ok2, _m2, ids2) = out2.import_result.expect("import result");
    for id in &ids2 {
        assert_eq!(st.project.profiles.get(id).unwrap().credit, None);
    }
}

/// The tick thread must never parse an import.
///
/// A real 9.4 MB festival MVR takes 32 ms to parse — two frames of DMX not
/// sent, with fixtures holding their last value — and ROADMAP forbids exactly
/// that. This asserts the split is real: applying an already-parsed result is
/// cheap, and it is the only half the engine loop runs.
#[test]
fn applying_a_parsed_import_is_cheap() {
    use light_core::state::EngineState;
    let t0 = 0.0;
    let mut st = EngineState::new(demo_project(), t0);

    // parse OFF the clock, exactly as the worker does
    let bytes = include_bytes!("data/synthetic.gdtf");
    let parsed = light_core::gdtf::parse_gdtf(bytes).expect("fixture parses");
    let modes = parsed.len();

    let t = std::time::Instant::now();
    let out = st.apply_gdtf("synthetic.gdtf", Ok(parsed), Some("someone".into()));
    let ms = t.elapsed().as_secs_f64() * 1000.0;

    let (ok, _msg, ids) = out.import_result.expect("import result");
    assert!(ok);
    assert_eq!(ids.len(), modes);
    // the tick budget is 25 ms; applying should not be close to it
    assert!(ms < 5.0, "applying a parsed import took {ms:.1} ms — that belongs off the tick");
    for id in &ids {
        assert_eq!(st.project.profiles.get(id).unwrap().credit.as_deref(), Some("someone"));
    }
}

/// Every project shape the Node reference repairs must load in Rust too.
///
/// It did not: all thirteen of these were rejected outright, which meant a
/// project written to this repo's own documented schema loaded under `npm start`
/// and was renamed `.corrupt-*` by the engine that ships — and a malformed
/// frame from a client vanished with no log, no reply and no toast.
///
/// The fixture was generated by feeding each shape through the actual TypeScript
/// sanitiser and keeping the ones it accepted, so this tracks Node's behaviour
/// rather than my reading of it.
#[test]
fn rust_accepts_every_shape_node_repairs() {
    // The fixture lists WHICH field each shape is missing, and the project is
    // rebuilt here — storing thirteen near-identical copies of a whole show
    // would be 325 KB of noise for the same assertion.
    let paths: Vec<String> =
        serde_json::from_str(include_str!("data/node_repairs.json")).expect("fixture parses");
    assert!(paths.len() >= 13, "fixture shrank — was it regenerated by accident?");
    let base: serde_json::Value =
        serde_json::from_str(include_str!("data/demo_project.json")).expect("demo project parses");

    let mut rejected: Vec<String> = Vec::new();
    for what in &paths {
        let mut project = base.clone();
        let segs: Vec<&str> = what.split('.').collect();
        let mut node = &mut project;
        for seg in &segs[..segs.len() - 1] {
            node = match seg.parse::<usize>() {
                Ok(i) => &mut node[i],
                Err(_) => &mut node[*seg],
            };
        }
        node.as_object_mut().map(|o| o.remove(segs[segs.len() - 1]));
        if serde_json::from_value::<light_core::types::Project>(project).is_err() {
            rejected.push(what.clone());
        }
    }
    rejected.sort();
    assert!(
        rejected.is_empty(),
        "Rust rejects {} shape(s) Node repairs: {}",
        rejected.len(),
        rejected.join(", ")
    );
}

/// The repair values have to MATCH Node's, not merely exist. A layer defaulting
/// to master 0 would load fine and light nothing.
#[test]
fn repair_defaults_match_the_node_sanitizer() {
    use light_core::types::{Layer, Settings, SyncCfg, Vec3};
    assert_eq!(serde_json::from_str::<SyncCfg>("{}").unwrap().osc_port, 7700);
    assert!(serde_json::from_str::<SyncCfg>("{}").unwrap().osc_enabled);
    assert!(serde_json::from_str::<SyncCfg>("{}").unwrap().follow_columns);
    assert!(!serde_json::from_str::<SyncCfg>("{}").unwrap().link_enabled);
    assert_eq!(serde_json::from_str::<Settings>("{}").unwrap().haze_fan, 0.35);
    assert_eq!(serde_json::from_str::<Settings>("{}").unwrap().haze, 0.0);
    // 2 m up, centre stage — a fixture on the floor would aim wrongly
    assert_eq!(serde_json::from_str::<Vec3>("{}").unwrap().y, 2.0);

    let l: Layer = serde_json::from_str(
        r#"{"id":"l","name":"L","blend":"normal"}"#,
    )
    .expect("a layer missing master/fade/cells must load");
    assert_eq!(l.master, 1.0, "a layer defaulting to 0 lights nothing");
    assert_eq!(l.fade, 0.5);
}

/// JSON floats must parse to the BIT-IDENTICAL f64 both engines see. serde_json
/// without the float_roundtrip feature is best-effort and lands 1 ulp off V8's
/// correctly-rounded JSON.parse on ~10 % of 17-digit decimals — the shortest-
/// round-trip forms JSON.stringify writes into project files. Geometry consumes
/// fixture pos/rotY, so a 1-ulp input skew can bucket a quantized world
/// coordinate differently in the two engines. The expected bits are the
/// correctly-rounded values (verified against Python and V8).
#[test]
fn json_floats_parse_bit_identical_to_v8() {
    let cases: [(&str, u64); 3] = [
        ("10.000000499999999", 0x4024000010c6f7a0), // straddles a q() boundary
        ("123.45678901234567", 0x405edd3c07fb4c98),
        ("1.7976931348623157", 0x3ffcc359e067a348),
    ];
    for (s, bits) in cases {
        let v: f64 = serde_json::from_str(s).expect("parses");
        assert_eq!(v.to_bits(), bits, "direct parse of {s}");
    }
    // and through the actual fixture door (de_vec3 goes via Value::as_f64)
    let f: light_core::types::Fixture = serde_json::from_str(
        r#"{"id":"f","name":"F","profileId":"p","universeId":"u","address":1,"pos":{"x":10.000000499999999,"y":2,"z":0},"rotY":123.45678901234567}"#,
    )
    .unwrap();
    assert_eq!(f.pos.x.to_bits(), 0x4024000010c6f7a0, "pos through de_vec3");
    assert_eq!(f.rot_y.to_bits(), 0x405edd3c07fb4c98, "rotY through de_rot_y");
}

/// A repaired submission has to be echoed back to whoever sent it.
///
/// The echo is withheld from the sender on the grounds that it already holds
/// that state — true only when the engine left it alone. `ensure_decks` can
/// rewrite it, and then the sender is the one client that never learns, and
/// re-sends the unrepaired copy on its next edit.
#[test]
fn the_engine_says_when_it_repaired_what_it_was_given() {
    use light_core::state::EngineState;
    use light_core::types::Command;
    let t0 = 0.0;
    let mut st = EngineState::new(demo_project(), t0);

    // untouched: the project already has decks and a resolvable active deck
    let clean = st.project.clone();
    let out = st.handle_command(Command::UpdateProject { project: Box::new(clean), base_gen: None, label: None, coalesce: false }, t0, None);
    assert!(!out.repaired_submission, "a well-formed project must not report a repair");

    // rewritten: an activeDeckId that resolves to nothing gets repointed
    let mut bad = st.project.clone();
    bad.active_deck_id = Some("deck-that-does-not-exist".into());
    let out = st.handle_command(Command::UpdateProject { project: Box::new(bad), base_gen: None, label: None, coalesce: false }, t0, None);
    assert!(out.repaired_submission, "repointing activeDeckId is a repair the sender must hear about");
    assert_ne!(st.project.active_deck_id.as_deref(), Some("deck-that-does-not-exist"));
}

/// The fixture-form inference, pinned against the cases that actually caused
/// trouble.
///
/// The CLF Nero is why this exists: it TILTS, so an aim-first heuristic calls
/// it a moving head, and it has 1, 7 or 14 cells depending on mode, so a
/// head-count-first heuristic calls it a bar. It is a 41 x 32 cm blinder plate
/// in all of them, and the 123 deg beam is what says so.
#[test]
fn fixture_form_inference() {
    use light_core::cprofile::{CChannel, CHead, Cond, Func, FuncCase, Source};
    use light_core::cprofile::{CompiledProfile, FixtureForm};
    use light_core::profiles::HeadKind;

    fn linear(name: &str, source: Source, head: usize) -> CChannel {
        CChannel {
            offsets: vec![0],
            head,
            name: name.into(),
            default: 0,
            cases: vec![FuncCase {
                cond: Cond::Always,
                dmx_from: 0,
                dmx_to: 255,
                func: Func::Linear { source },
            }],
        }
    }
    fn prof(beam_deg: f64, heads: Vec<CHead>, channels: Vec<CChannel>) -> CompiledProfile {
        CompiledProfile {
            id: "t".into(),
            manufacturer: "m".into(),
            model: "m".into(),
            mode: "m".into(),
            footprint: 1,
            heads,
            channels,
            beam_deg,
            field_deg: None,
            lumens: None,
            beam_radius: None,
            virtual_dimmer: false,
            pan_deg: None,
            tilt_deg: None,
            cto_k: None,
            compiler: 0,
            credit: None,
            form_override: None,
        }
    }
    let cell = |off: f64| CHead::flat(HeadKind::Rgb, off, "c".into());

    // A CLF Nero: tilt but no pan, 123 deg, in each of its cell counts.
    for n in [1usize, 7, 14] {
        let heads: Vec<CHead> = (0..n)
            .map(|i| cell(-0.5 + i as f64 / n.max(2) as f64))
            .collect();
        let p = prof(123.0, heads, vec![
            linear("Tilt", Source::Tilt, 0),
            linear("Dimmer", Source::Dimmer, 0),
            linear("R", Source::ColorR, 0),
        ]);
        assert_eq!(p.form(), FixtureForm::Panel, "Nero with {n} cells is a panel");
    }

    // A moving head steers in BOTH axes.
    let mover = prof(50.0, vec![cell(0.0)], vec![
        linear("Pan", Source::Pan, 0),
        linear("Tilt", Source::Tilt, 0),
        linear("R", Source::ColorR, 0),
    ]);
    assert_eq!(mover.form(), FixtureForm::Mover);

    // A batten: cells along X, no rise, narrow lenses, nothing aims.
    let bar = prof(25.0, (0..8).map(|i| cell(i as f64 * 0.12)).collect(), vec![
        linear("Dimmer", Source::Dimmer, 0),
        linear("R", Source::ColorR, 0),
    ]);
    assert_eq!(bar.form(), FixtureForm::Bar);

    // Cells arranged as a plate are not a batten. 4 x 3 at even spacing is
    // rise/span = 0.67, comfortably clear of the 0.35 line; a 2-row batten sits
    // near it on purpose, and pinning a knife-edge case would only test the
    // constant.
    let mut plate_heads: Vec<CHead> = Vec::new();
    for r in 0..3 {
        for c in 0..4 {
            let mut h = cell(c as f64 * 0.1);
            h.offset_y = r as f64 * 0.1;
            plate_heads.push(h);
        }
    }
    let plate = prof(40.0, plate_heads, vec![linear("R", Source::ColorR, 0)]);
    assert_eq!(plate.form(), FixtureForm::Panel);

    // Head kinds win outright.
    let hazer = prof(10.0, vec![CHead::flat(HeadKind::Hazer, 0.0, "h".into())], vec![]);
    assert_eq!(hazer.form(), FixtureForm::Hazer);
    let derby = prof(10.0, vec![CHead::flat(HeadKind::Derby, 0.0, "d".into())], vec![]);
    assert_eq!(derby.form(), FixtureForm::Derby);

    // An override beats every rule, which is the entire point of storing it.
    let mut forced = mover.clone();
    forced.form_override = Some(FixtureForm::Panel);
    assert_eq!(forced.form(), FixtureForm::Panel);

    // And it round-trips through the stored shape as camelCase, absent when unset.
    let json = serde_json::to_string(&mover).unwrap();
    assert!(!json.contains("formOverride"), "unset override must not be serialised");
    let json = serde_json::to_string(&forced).unwrap();
    assert!(json.contains("\"formOverride\":\"panel\""), "got {json}");
    let back: CompiledProfile = serde_json::from_str(&json).unwrap();
    assert_eq!(back.form_override, Some(FixtureForm::Panel));
}

/// One malformed profile used to fail the WHOLE project parse, and the engine
/// then fell back to the default show while renaming the operator's file
/// `.corrupt-*`. A hand-authored channel, a file edited by hand, or a show
/// written by a newer build that knows a Source this one does not were all
/// enough to do it (backlog #16).
#[test]
fn one_unreadable_profile_costs_its_fixtures_not_the_show() {
    let good = r#"{
        "id": "gdtf-good", "manufacturer": "M", "model": "M", "mode": "M",
        "footprint": 1, "heads": [{"kind":"rgb","offset":0,"label":"x"}],
        "channels": [], "beamDeg": 10, "virtualDimmer": false
    }"#;
    let json = format!(
        r#"{{"version":1,"name":"T","universes":[],"fixtures":[],"groups":[],"layers":[],"columns":[],
             "looks":{{}},"profiles":{{
               "gdtf-good": {good},
               "gdtf-bad": {{"id":"gdtf-bad","channels":[{{"offsets":[0],"head":0,"default":0,"name":"C",
                 "cases":[{{"cond":{{"kind":"neverHeardOfIt"}},"dmxFrom":0,"dmxTo":255,
                 "func":{{"kind":"linear","source":"dimmer"}}}}]}}]}}
             }}}}"#
    );
    let p: light_core::types::Project = serde_json::from_str(&json).expect("the project still parses");
    assert!(p.profiles.contains_key("gdtf-good"), "the readable one survives");
    assert!(!p.profiles.contains_key("gdtf-bad"), "the unreadable one is skipped, not fatal");
    assert_eq!(p.profiles.len(), 1);
}

/// A project profile carrying a BUILT-IN id can never render — the resolver
/// tries built-ins first — so it is dropped rather than kept as dead weight
/// that looks like it works. Mirrors the Node sanitizer.
#[test]
fn a_profile_shadowing_a_builtin_id_is_dropped() {
    let json = r#"{"version":1,"name":"T","universes":[],"fixtures":[],"groups":[],"layers":[],
        "columns":[],"looks":{},"profiles":{
          "generic-rgb-par-3ch": {"id":"generic-rgb-par-3ch","manufacturer":"M","model":"M","mode":"M",
            "footprint":1,"heads":[{"kind":"rgb","offset":0,"label":"x"}],"channels":[],
            "beamDeg":10,"virtualDimmer":false}
        }}"#;
    let p: light_core::types::Project = serde_json::from_str(json).expect("parses");
    assert!(p.profiles.is_empty(), "a shadowed id is not kept");
}

/// A held freeze belongs to the client whose finger is down. If that client
/// goes away the release never arrives, and the rig would repeat one frame for
/// the rest of the night — the same failure the flash pad's ownership exists to
/// prevent. A LATCHED freeze is a deliberate choice and must survive.
#[test]
fn a_held_freeze_dies_with_the_hand_that_took_it_and_a_latched_one_does_not() {
    let t0 = 0.0;
    let mut st = EngineState::new(demo_project(), t0);

    // held by client 7
    st.handle_command(Command::SetFreeze { v: true, momentary: true }, t0, Some(7));
    assert!(st.frozen, "the hold freezes the rig");
    assert_eq!(st.frozen_by, Some(7), "and it is owned by the hand that took it");

    // somebody else's client goes: the hold stands
    st.release_all_held(t0 + 1.0, Some(9));
    assert!(st.frozen, "another client leaving does not release this hold");

    // its own client goes: the frame is let through
    st.release_all_held(t0 + 2.0, Some(7));
    assert!(!st.frozen, "the owner leaving releases the hold");
    assert_eq!(st.frozen_by, None);

    // a latch has no owner and outlives every disconnect
    st.handle_command(Command::SetFreeze { v: true, momentary: false }, t0 + 3.0, Some(7));
    assert!(st.frozen && st.frozen_by.is_none(), "a latch is ownerless");
    st.release_all_held(t0 + 4.0, Some(7));
    assert!(st.frozen, "a disconnect does not undo a deliberate latch");

    // but blackout does, by name — the twin asserts the same in engine/test/smoke.ts
    st.set_blackout(true);
    assert!(!st.frozen, "blackout releases a latched freeze");
    assert_eq!(st.frozen_by, None);
}

/// The four fields the UI writes and the engine only carries (design #46).
///
/// `Project` and `Deck` have no unknown-field capture: anything the struct does
/// not declare is dropped the next time the engine broadcasts, silently and one
/// tick after the operator set it. A palette, a pinned group, a set-list note
/// and the home song are all UI state that has to survive a round trip through
/// an engine that never reads them.
#[test]
fn the_fields_the_engine_only_carries_survive_a_round_trip() {
    use light_core::types::Palette;
    let mut p = demo_project();
    p.palettes = vec![Palette { id: "pal-1".into(), name: "venue blue".into(), h: 214.0, s: 0.9 }];
    p.pinned_groups = vec!["grp-derbies".into(), "grp-strips".into()];
    p.decks[0].note = Some("capo 3 — starts dark".into());
    p.decks[0].home = true;

    let json = serde_json::to_string(&p).unwrap();
    // the spelling the UI reads
    assert!(json.contains("\"pinnedGroups\""), "pinnedGroups must cross as camelCase");
    assert!(!json.contains("pinned_groups"), "never the snake_case spelling");

    let back: light_core::types::Project = serde_json::from_str(&json).unwrap();
    assert_eq!(back.palettes.len(), 1);
    assert_eq!(back.palettes[0].name, "venue blue");
    assert_eq!(back.palettes[0].h, 214.0);
    assert_eq!(back.pinned_groups, vec!["grp-derbies".to_string(), "grp-strips".to_string()]);
    assert_eq!(back.decks[0].note.as_deref(), Some("capo 3 — starts dark"));
    assert!(back.decks[0].home);
}

/// A show that predates the four fields loads with them empty, and saving it
/// again does not write them — an old project stays byte-identical rather than
/// growing keys it never had.
#[test]
fn a_show_without_the_carried_fields_neither_fails_nor_grows_them() {
    let p = demo_project();
    let json = serde_json::to_string(&p).unwrap();
    assert!(!json.contains("palettes"), "absent, not an empty list");
    assert!(!json.contains("pinnedGroups"));
    // scoped to the deck: other structs in a show have a `note` of their own
    let deck_json = serde_json::to_string(&p.decks[0]).unwrap();
    assert!(!deck_json.contains("note"), "a song without a note writes none: {deck_json}");
    assert!(!deck_json.contains("home"), "a song that is not home writes nothing: {deck_json}");

    let back: light_core::types::Project = serde_json::from_str(&json).unwrap();
    assert!(back.palettes.is_empty() && back.pinned_groups.is_empty());
    assert!(back.decks.iter().all(|d| d.note.is_none() && !d.home));
}

/// Where a knob physically sits (design #52, A35). An APC's faders are absolute:
/// after the screen moves a value, the hardware is wherever it was left, and the
/// next touch jumps the value there. When the engine owns MIDI this record is the
/// only place that answer exists.
#[test]
fn every_cc_leaves_its_position_behind_mapped_or_not() {
    let mut st = EngineState::new(demo_project(), 0.0);
    // a CC nothing is mapped to still records where the knob is
    st.apply_midi(0xb3, 7, 99, 0.0);
    assert_eq!(st.midi_cc.get(&(3, 7)), Some(&99), "channel 3 (0-based), cc 7");
    // the latest position wins
    st.apply_midi(0xb3, 7, 12, 1.0);
    assert_eq!(st.midi_cc.get(&(3, 7)), Some(&12));
    // a note is not a position
    st.apply_midi(0x90, 7, 127, 2.0);
    assert_eq!(st.midi_cc.len(), 1, "notes leave nothing behind");
}

/// Blind (design #48): nudges reach the audition, not the rig. The flag is
/// runtime only and must not outlive the thing that ends a programming session.
#[test]
fn blind_is_cleared_by_all_stop_and_a_project_switch() {
    let mut st = EngineState::new(demo_project(), 0.0);
    st.handle_command(Command::SetBlind { v: true }, 0.0, None);
    assert!(st.blind);
    st.handle_command(Command::AllStop, 1.0, None);
    assert!(!st.blind, "the panic leaves nothing programmed in secret");

    st.handle_command(Command::SetBlind { v: true }, 2.0, None);
    st.replace_project(demo_project());
    assert!(!st.blind, "blind belongs to the show it was armed in");
}

/// A timed Discard travels each nudge back to the stored value (design #50).
/// The Node twin (`blendSoft` in shared/effects.ts) is held to the SAME table,
/// compared by bit pattern. Hue is DEGREES: an earlier draft wrapped at 1.0 and
/// passed a table of 0..1 hues that never occur, while a real release from 30°
/// to 330° sat on red for the whole fade. A hue that lands on exactly 360 is
/// normalised to 0 in both — the same colour, and it must be the same number.
#[test]
fn a_timed_discard_blends_by_the_same_bits_as_the_node_twin() {
    use light_core::state::blend_soft;
    use light_core::types::SoftField as F;
    let table: &[(F, f64, f64, f64, u64)] = &[
        (F::Hue, 350.0, 10.0, 0.5, 0x0000000000000000),   // twenty degrees through red, not 340 the long way
        (F::Hue, 30.0, 330.0, 0.5, 0x0000000000000000),   // the other way round
        (F::Hue, 72.0, 216.0, 0.25, 0x405b000000000000),  // 108°
        (F::Hue, 350.0, 10.0, 0.3, 0x4076400000000000),   // 356°, still short of red
        (F::Hue, 0.1, 359.9, 0.5, 0x0000000000000000),    // lands on exactly 360 → normalised to 0
        (F::Hue, 195.5, 12.25, 0.4, 0x4070a33333333333),  // 266.2°, a fraction that is not tidy
        (F::Hue, 324.0, 36.0, 0.0, 0x4074400000000000),   // fully released = stored
        (F::Dimmer, 1.0, 0.2, 0.5, 0x3fe3333333333333),
        (F::Rate, 1.0, 4.0, 0.75, 0x400a000000000000),
    ];
    for &(f, stored, soft, w, bits) in table {
        let got = blend_soft(f, stored, soft, w);
        assert_eq!(got.to_bits(), bits, "{f:?} {stored}→{soft} at w={w}: got {got}");
    }
    // no release running: the nudge stands untouched
    assert_eq!(blend_soft(F::Hue, 10.0, 200.0, 1.0), 200.0);
}

#[test]
fn a_timed_discard_empties_the_layer_when_it_arrives() {
    use light_core::state::soft_release_weight;
    assert_eq!(soft_release_weight(None, 5.0), 1.0, "no release: the nudges stand");
    assert_eq!(soft_release_weight(Some((0.0, 1000.0)), 0.0), 1.0);
    assert_eq!(soft_release_weight(Some((0.0, 1000.0)), 250.0), 0.75);
    assert_eq!(soft_release_weight(Some((0.0, 1000.0)), 1000.0), 0.0);
    assert_eq!(soft_release_weight(Some((0.0, 1000.0)), 5000.0), 0.0, "past the end stays at the stored show");
}

/// The FADE master (design decision 3, A26). The fader's curve is held to the
/// same bit table as the Node twin in engine/test/smoke.ts, and every crossfade
/// a layer starts is its programmed length times the master: a look firing, a
/// layer clearing, a flash letting go — whose 20 ms floor stays under it.
#[test]
fn the_fade_master_scales_every_crossfade_a_layer_starts() {
    use light_core::state::fade_scale_at;
    use light_core::types::{MidiAction, MidiMapping, MidiType};
    let table: &[(f64, u64)] = &[
        (0.0, 0x0000000000000000),          // the bottom is a cut
        (0.5, 0x3ff0000000000000),          // the middle is as programmed
        (1.0, 0x4010000000000000),          // the top is four times as long
        (64.0 / 127.0, 0x3ff040c2050c1c40), // CC 64, a hair past the middle
        (0.3, 0x3fd70a3d70a3d70a),
        (100.0 / 127.0, 0x4003d70cd729487d),
        (-1.0, 0x0000000000000000),         // clamped
        (2.0, 0x4010000000000000),
        (f64::NAN, 0x0000000000000000),     // NaN never reaches the engine
    ];
    for &(p, bits) in table {
        let got = fade_scale_at(p);
        assert_eq!(got.to_bits(), bits, "position {p}: got {got}");
    }

    let mut st = EngineState::new(demo_project(), 0.0);
    assert_eq!(st.fade_scale, 1.0, "a show opens as programmed");

    // a look with no fade of its own takes its layer's 0.8 s, stretched
    st.handle_command(Command::SetFadeScale { v: 2.5 }, 0.0, None);
    st.trigger("layer-wash", 1, 1.0, 0);
    assert_eq!(st.live["layer-wash"].fade_dur.to_bits(), 0x4000000000000000, "0.8 s × 2.5 = 2 s");
    // at the bottom the next look cuts in
    st.handle_command(Command::SetFadeScale { v: 0.0 }, 2.0, None);
    st.trigger("layer-wash", 2, 2.0, 0);
    assert_eq!(st.live["layer-wash"].fade_dur.to_bits(), 0, "a cut");

    // a layer clearing: the fx layer's 0.3 s at half
    st.handle_command(Command::SetFadeScale { v: 0.5 }, 3.0, None);
    st.trigger("layer-fx", 1, 3.0, 0);
    st.clear_layer("layer-fx", 3.5);
    assert_eq!(st.live["layer-fx"].fade_dur.to_bits(), 0x3fc3333333333333, "0.3 s × 0.5");

    // a flash letting go: stretched, and never below the 20 ms floor
    st.project.looks.get_mut("strobe-blinder").unwrap().fade = Some(0.3);
    st.handle_command(Command::SetFadeScale { v: 2.0 }, 4.0, None);
    st.trigger("layer-strobe", 1, 4.0, 0);
    st.release("layer-strobe", 1, 4.5);
    assert_eq!(st.live["layer-strobe"].fade_dur.to_bits(), 0x3fe3333333333333, "0.3 s × 2");
    st.handle_command(Command::SetFadeScale { v: 0.0 }, 5.0, None);
    st.trigger("layer-strobe", 1, 5.0, 0);
    st.release("layer-strobe", 1, 5.5);
    assert_eq!(st.live["layer-strobe"].fade_dur.to_bits(), 0x3f947ae147ae147b, "the floor, not a click");

    // the command keeps it on the fader's range
    st.handle_command(Command::SetFadeScale { v: 9.0 }, 6.0, None);
    assert_eq!(st.fade_scale, 4.0);
    st.handle_command(Command::SetFadeScale { v: -1.0 }, 6.0, None);
    assert_eq!(st.fade_scale, 0.0);
    st.handle_command(Command::SetFadeScale { v: f64::NAN }, 6.0, None);
    assert_eq!(st.fade_scale, 0.0);

    // on a controller: a fader sets it by the curve, and a pad bound to it is
    // a fader-style target — letting the pad go must not slam it to a cut
    st.project.midi.push(MidiMapping { id: "fade-cc".into(), kind: MidiType::Cc, channel: 0, number: 20, action: MidiAction::FadeScale });
    st.project.midi.push(MidiMapping { id: "fade-pad".into(), kind: MidiType::Note, channel: 0, number: 60, action: MidiAction::FadeScale });
    st.apply_midi(0xb0, 20, 64, 7.0);
    assert_eq!(st.fade_scale.to_bits(), 0x3ff040c2050c1c40, "CC 64");
    st.apply_midi(0x90, 60, 100, 8.0);
    assert_eq!(st.fade_scale.to_bits(), 0x4003d70cd729487d, "a pad sets it by its velocity");
    st.apply_midi(0x80, 60, 0, 9.0);
    st.apply_midi(0x90, 60, 0, 9.0);
    assert_eq!(st.fade_scale.to_bits(), 0x4003d70cd729487d, "and letting it go leaves it where it is");
}

/// Two controllers on one Mac (Sync · MIDI's input switch). The inputs LIGHT
/// does not listen to are carried by name, absent when there are none, and
/// decide what the engine hears. The Node twin holds the same rule from
/// shared/midiInputs.ts; the LED side is `the_leds_go_to_the_apc_that_is_switched_on`
/// in apc.rs.
#[test]
fn a_switched_off_input_is_carried_by_name_and_not_listened_to() {
    let mut p = demo_project();
    let json = serde_json::to_string(&p).unwrap();
    assert!(!json.contains("midiInputsOff"), "nothing off: absent, not an empty list");
    p.sync.midi_inputs_off = vec!["APC40 mk2".into()];
    let json = serde_json::to_string(&p).unwrap();
    assert!(json.contains("\"midiInputsOff\":[\"APC40 mk2\"]"), "{json}");
    let back: light_core::types::Project = serde_json::from_str(&json).unwrap();
    assert_eq!(back.sync.midi_inputs_off, vec!["APC40 mk2".to_string()]);

    let st = EngineState::new(back, 0.0);
    assert!(!st.midi_input_on("APC40 mk2"), "the Resolume unit is not listened to");
    assert!(st.midi_input_on("APC40 LIGHT"), "the other one is");
    assert!(st.midi_input_on("IAC Driver Bus 1"), "and so is everything else");
}

/// Boot warns about a show it could not read, never about a first run, and falls
/// back to the default only for a dead pointer. The same cases as BOOT_CASES in
/// engine/test/boot.ts, read here at the loader the warning is decided from; the
/// parity harness boots both engines on them and compares what a client is
/// greeted with. The last case is why the fallback is narrow: a corrupt show
/// beside a readable default used to open the default without a word.
#[test]
fn a_first_run_is_not_a_show_that_could_not_be_read() {
    use light_core::persist::{load_project, Loaded};
    let torn = r#"{ "version": 1, "name": "Friday", "fixtures": ["#; // a write cut short
    let readable = include_str!("data/demo_project.json");
    // (case, files on disk, warns, what .current names afterwards)
    let rows: [(&str, &[(&str, &str)], bool, Option<&str>); 6] = [
        ("an empty directory (a first run)", &[], false, None),
        ("a corrupt show with no backups", &[("default.project.json", torn)], true, None),
        ("a missing show whose backups will not parse", &[("default.project.json.bak1", torn)], true, None),
        ("a pointer to a show with nothing saved anywhere", &[(".current", "friday")], false, Some("default")),
        (
            "a pointer to a show that left only unreadable backups",
            &[(".current", "friday"), ("friday.project.json.bak1", torn)],
            true,
            Some("default"),
        ),
        (
            "a corrupt named show beside a readable default",
            &[(".current", "friday"), ("friday.project.json", torn), ("default.project.json", readable)],
            true,
            Some("friday"),
        ),
    ];
    let root = std::env::temp_dir().join(format!("light-boot-{}", std::process::id()));
    for (i, (name, files, warns, current)) in rows.iter().enumerate() {
        let dir = root.join(i.to_string());
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for (file, body) in files.iter() {
            std::fs::write(dir.join(file), body).unwrap();
        }
        match load_project(&dir) {
            Loaded::Project(p) => panic!("{name}: nothing here should open, yet {:?} did", p.name),
            Loaded::Nothing { unreadable } => assert_eq!(unreadable, *warns, "{name}"),
        }
        let pointer = std::fs::read_to_string(dir.join(".current")).ok();
        assert_eq!(pointer.as_deref().map(str::trim), *current, "{name}: the show .current names");
        if *warns {
            // the warning promises the file was left alone
            let kept = std::fs::read_dir(&dir)
                .unwrap()
                .flatten()
                .any(|e| std::fs::read_to_string(e.path()).is_ok_and(|s| s == torn));
            assert!(kept, "{name}: the unreadable bytes must still be on disk");
        }
    }
    let _ = std::fs::remove_dir_all(&root);
}
