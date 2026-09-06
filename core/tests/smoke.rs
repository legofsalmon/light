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
