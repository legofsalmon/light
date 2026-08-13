//! GDTF import: a synthetic, spec-shaped .gdtf archive covering 16-bit
//! position, dimmer, RGB, shutter/strobe function pairs, a colour wheel with
//! CIE slot colours, and an unmapped channel that must hold its default.

use std::io::Write;

use light_core::cprofile::render_compiled;
use light_core::gdtf::parse_gdtf;
use light_core::profiles::{HeadKind, ResolvedParams};

const DESCRIPTION: &str = include_str!("data/synthetic.gdtf.xml");


fn synthetic_gdtf() -> Vec<u8> {
    let mut buf = Vec::new();
    {
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
        zip.start_file::<_, ()>("description.xml", zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(DESCRIPTION.as_bytes()).unwrap();
        zip.finish().unwrap();
    }
    buf
}

fn params() -> ResolvedParams {
    ResolvedParams {
        dimmer: 1.0,
        r: 1.0,
        g: 0.0,
        b: 0.0,
        pan: 0.5,
        tilt: 1.0,
        ..Default::default()
    }
}

#[test]
fn imports_synthetic_fixture() {
    let profiles = parse_gdtf(&synthetic_gdtf()).expect("parses");
    assert_eq!(profiles.len(), 1);
    let p = &profiles[0];
    assert_eq!(p.manufacturer, "ACME");
    assert_eq!(p.model, "TestSpot 100");
    assert_eq!(p.mode, "Standard");
    assert_eq!(p.footprint, 11);
    assert!(!p.virtual_dimmer, "has a real dimmer channel");
    assert_eq!(p.heads[0].kind, HeadKind::Mover);
    assert!((p.beam_deg - 11.5).abs() < 1e-9);
}

#[test]
fn renders_expected_bytes() {
    let profiles = parse_gdtf(&synthetic_gdtf()).unwrap();
    let p = &profiles[0];
    let prm = params();
    let refs = vec![&prm];
    let mut buf = [0u8; 16];
    render_compiled(p, &refs, &mut buf, 0);

    assert_eq!([buf[0], buf[1]], [128, 0], "pan 50% → 32768 split");
    assert_eq!([buf[2], buf[3]], [255, 255], "tilt 100%");
    assert_eq!(buf[4], 255, "dimmer");
    assert_eq!(buf[5], 8, "shutter holds its open default when not strobing");
    assert_eq!([buf[6], buf[7], buf[8]], [255, 0, 0], "rgb");
    assert_eq!(buf[9], 128, "unmapped zoom holds its GDTF default");
    // colour wheel: red look → Red band (16..31), midpoint 23
    assert_eq!(buf[10], 23, "wheel quantises to the red slot");

    // strobing writes into the strobe function's band (16..199)
    let mut strobing = params();
    strobing.strobe = 1.0;
    let refs = vec![&strobing];
    render_compiled(p, &refs, &mut buf, 0);
    assert_eq!(buf[5], 199, "full strobe = top of the strobe band");
    strobing.strobe = 0.5;
    let refs = vec![&strobing];
    render_compiled(p, &refs, &mut buf, 0);
    assert_eq!(buf[5], 16 + 92, "mid strobe maps linearly across the band");

    // explicit wheel override wins
    let mut explicit = params();
    explicit.macro_ = Some(40.0);
    let refs = vec![&explicit];
    render_compiled(p, &refs, &mut buf, 0);
    assert_eq!(buf[10], 40, "explicit macro value passes through");
}

#[test]
fn rejects_garbage() {
    assert!(parse_gdtf(b"not a zip at all").is_err());
}

#[test]
fn pixel_bar_synthesizes_heads() {
    // 8 × RGB enumerated channels, no distinct geometries — the repeated
    // colour-cycle fallback must yield 8 heads (one per pixel).
    let mut xml = String::from(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<GDTF DataVersion="1.2"><FixtureType Name="PixelBar 8" Manufacturer="ACME">
<DMXModes><DMXMode Name="24ch" Geometry="Base"><DMXChannels>"#,
    );
    for i in 0..8 {
        for (c, attr) in [("R", "ColorAdd_R"), ("G", "ColorAdd_G"), ("B", "ColorAdd_B")] {
            xml.push_str(&format!(
                r#"<DMXChannel DMXBreak="1" Offset="{}"><LogicalChannel Attribute="{attr}"><ChannelFunction Attribute="{attr}" DMXFrom="0/1" Default="0/1"/></LogicalChannel></DMXChannel>"#,
                i * 3 + match c { "R" => 1, "G" => 2, _ => 3 } + i * 0,
            ));
        }
    }
    xml.push_str("</DMXChannels></DMXMode></DMXModes></FixtureType></GDTF>");

    let mut buf = Vec::new();
    {
        let mut z = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
        z.start_file::<_, ()>("description.xml", zip::write::SimpleFileOptions::default()).unwrap();
        z.write_all(xml.as_bytes()).unwrap();
        z.finish().unwrap();
    }
    let profiles = parse_gdtf(&buf).expect("parses");
    let p = &profiles[0];
    assert_eq!(p.footprint, 24);
    assert_eq!(p.heads.len(), 8, "one head per pixel");
    assert!(p.heads.iter().all(|h| h.kind == HeadKind::Rgb));
    // heads spread across ~1 m
    assert!((p.heads[0].offset + 0.5).abs() < 1e-9 && (p.heads[7].offset - 0.5).abs() < 1e-9);
    // channel→head assignment: pixel 3's red is channel index 6 (offset 7)
    let ch = p.channels.iter().find(|c| c.offsets == vec![6]).unwrap();
    assert_eq!(ch.head, 2);

    // render: distinct colours per pixel head
    let mut heads: Vec<light_core::profiles::ResolvedParams> = (0..8)
        .map(|i| light_core::profiles::ResolvedParams {
            dimmer: 1.0,
            r: if i % 2 == 0 { 1.0 } else { 0.0 },
            g: 0.0,
            b: if i % 2 == 0 { 0.0 } else { 1.0 },
            ..Default::default()
        })
        .collect();
    heads[0].dimmer = 1.0;
    let refs: Vec<&light_core::profiles::ResolvedParams> = heads.iter().collect();
    let mut out = [0u8; 32];
    render_compiled(p, &refs, &mut out, 0);
    assert_eq!([out[0], out[1], out[2]], [255, 0, 0], "pixel 1 red");
    assert_eq!([out[3], out[4], out[5]], [0, 0, 255], "pixel 2 blue");
    assert_eq!([out[21], out[22], out[23]], [0, 0, 255], "pixel 8 blue");
}
