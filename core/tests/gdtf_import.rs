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
    assert_eq!(buf[9], 128, "a look that says nothing about zoom leaves it parked");
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


/// Zoom is optional, and the distinction matters on load: a saved show whose
/// looks predate the parameter must not slam every moving head to its narrowest
/// beam the moment it opens. So an absent value holds the fixture's own default
/// and a present one drives the channel.
#[test]
fn zoom_is_parked_until_a_look_asks_for_it() {
    let profiles = parse_gdtf(&synthetic_gdtf()).expect("parses");
    let p = &profiles[0];
    let mut buf = [0u8; 16];

    let parked = params();
    assert!(parked.beam.zoom.is_none(), "the fixture starts with no zoom asked for");
    render_compiled(p, &[&parked], &mut buf, 0);
    assert_eq!(buf[9], 128, "unset zoom holds the GDTF default of 128");

    let mut wide = params();
    wide.beam.zoom = Some(1.0);
    render_compiled(p, &[&wide], &mut buf, 0);
    assert_eq!(buf[9], 255, "zoom 1.0 drives the channel to the top");

    let mut narrow = params();
    narrow.beam.zoom = Some(0.0);
    render_compiled(p, &[&narrow], &mut buf, 0);
    assert_eq!(buf[9], 0, "zoom 0.0 drives the channel to the bottom");

    // and the channels around it are untouched either way
    assert_eq!(buf[4], 255, "dimmer unaffected by zoom");
    assert_eq!(buf[10], 23, "colour wheel unaffected by zoom");
}

// ---------------------------------------------------------------------------
// B1: real pixel positions from the Geometries tree
// ---------------------------------------------------------------------------

/// A pixel-bar description.xml: `geometries` is the inner XML of the
/// Geometries element; one RGB channel triple per name in `pixels`.
fn pixel_bar_xml(geometries: &str, pixels: &[&str]) -> String {
    let mut chans = String::new();
    for (i, name) in pixels.iter().enumerate() {
        for (k, attr) in ["ColorAdd_R", "ColorAdd_G", "ColorAdd_B"].iter().enumerate() {
            chans.push_str(&format!(
                r#"<DMXChannel DMXBreak="1" Offset="{}" Geometry="{name}">
                     <LogicalChannel Attribute="{attr}">
                       <ChannelFunction Attribute="{attr}" DMXFrom="0/1" Default="0/1"/>
                     </LogicalChannel>
                   </DMXChannel>"#,
                i * 3 + k + 1,
            ));
        }
    }
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<GDTF DataVersion="1.2">
  <FixtureType Name="PixelBar" Manufacturer="TEST">
    <Geometries>{geometries}</Geometries>
    <DMXModes>
      <DMXMode Name="Px" Geometry="Base">
        <DMXChannels>{chans}</DMXChannels>
      </DMXMode>
    </DMXModes>
  </FixtureType>
</GDTF>"#
    )
}

fn zip_xml(xml: &str) -> Vec<u8> {
    let mut buf = Vec::new();
    {
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
        zip.start_file::<_, ()>("description.xml", zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(xml.as_bytes()).unwrap();
        zip.finish().unwrap();
    }
    buf
}

const I3: &str = "{1,0,0,0}{0,1,0,0}{0,0,1,0}";

#[test]
fn pixel_positions_compose_through_the_geometry_tree() {
    // two sub-groups translated ±300 mm, pixels at local ±100 mm: world x
    // must compose to ±400/±200 mm. The whole head sits 100 mm up (GDTF +z),
    // which centring cancels. mm magnitudes exercise the unit heuristic.
    let geoms = format!(
        r#"<Geometry Name="Base">
             <Geometry Name="Head" Position="{I3}{{0,0,100,1}}">
               <Geometry Name="L" Position="{I3}{{-300,0,0,1}}">
                 <Geometry Name="PxA" Position="{I3}{{-100,0,0,1}}"/>
                 <Geometry Name="PxB" Position="{I3}{{100,0,0,1}}"/>
               </Geometry>
               <Geometry Name="R" Position="{I3}{{300,0,0,1}}">
                 <Geometry Name="PxC" Position="{I3}{{-100,0,0,1}}"/>
                 <Geometry Name="PxD" Position="{I3}{{100,0,0,1}}"/>
               </Geometry>
             </Geometry>
           </Geometry>"#
    );
    let xml = pixel_bar_xml(&geoms, &["PxA", "PxB", "PxC", "PxD"]);
    let p = &parse_gdtf(&zip_xml(&xml)).expect("parses")[0];
    assert_eq!(p.heads.len(), 4);
    let near = |a: f64, b: f64| (a - b).abs() < 1e-9;
    assert!(near(p.heads[0].offset, -0.4), "PxA composes -300-100 mm -> -0.4 m, got {}", p.heads[0].offset);
    assert!(near(p.heads[1].offset, -0.2), "got {}", p.heads[1].offset);
    assert!(near(p.heads[2].offset, 0.2), "got {}", p.heads[2].offset);
    assert!(near(p.heads[3].offset, 0.4), "got {}", p.heads[3].offset);
    assert!(p.heads.iter().all(|h| near(h.offset_y, 0.0)), "the parent's uniform +z cancels in centring");
    assert_eq!(
        p.heads.iter().map(|h| (h.row, h.col)).collect::<Vec<_>>(),
        vec![(0, 0), (0, 1), (0, 2), (0, 3)],
        "single row, cols in x order"
    );
    assert_eq!(p.heads[0].label, "PxA", "the geometry name becomes the head label");
}

#[test]
fn a_two_row_grid_gets_honest_rows_and_cols() {
    let geoms = format!(
        r#"<Geometry Name="Base">
             <Geometry Name="PxA" Position="{I3}{{-100,0,50,1}}"/>
             <Geometry Name="PxB" Position="{I3}{{100,0,50,1}}"/>
             <Geometry Name="PxC" Position="{I3}{{-100,0,-50,1}}"/>
             <Geometry Name="PxD" Position="{I3}{{100,0,-50,1}}"/>
           </Geometry>"#
    );
    let xml = pixel_bar_xml(&geoms, &["PxA", "PxB", "PxC", "PxD"]);
    let p = &parse_gdtf(&zip_xml(&xml)).expect("parses")[0];
    let near = |a: f64, b: f64| (a - b).abs() < 1e-9;
    // GDTF +z is up -> offset_y; top row (z=+50) is row 0
    assert_eq!(
        p.heads.iter().map(|h| (h.row, h.col)).collect::<Vec<_>>(),
        vec![(0, 0), (0, 1), (1, 0), (1, 1)]
    );
    assert!(near(p.heads[0].offset_y, 0.05) && near(p.heads[2].offset_y, -0.05));
}

#[test]
fn zeroed_positions_fall_back_to_the_synthesized_spacing() {
    // the CLF Nero case: geometry exists but every position is zero — the
    // even-spaced fabrication must survive, not a stack of coincident pixels
    let geoms = format!(
        r#"<Geometry Name="Base">
             <Geometry Name="PxA" Position="{I3}{{0,0,0,1}}"/>
             <Geometry Name="PxB" Position="{I3}{{0,0,0,1}}"/>
             <Geometry Name="PxC" Position="{I3}{{0,0,0,1}}"/>
             <Geometry Name="PxD" Position="{I3}{{0,0,0,1}}"/>
           </Geometry>"#
    );
    let xml = pixel_bar_xml(&geoms, &["PxA", "PxB", "PxC", "PxD"]);
    let p = &parse_gdtf(&zip_xml(&xml)).expect("parses")[0];
    let near = |a: f64, b: f64| (a - b).abs() < 1e-9;
    assert!(near(p.heads[0].offset, -0.5), "synthesized ±0.5 span, got {}", p.heads[0].offset);
    assert!(near(p.heads[3].offset, 0.5));
    assert!(p.heads.iter().all(|h| h.offset_y == 0.0 && h.row == 0 && h.col == 0));
}

#[test]
fn metre_scale_positions_skip_the_mm_heuristic() {
    // values <= 5 in magnitude are already metres and must not be divided
    let geoms = format!(
        r#"<Geometry Name="Base">
             <Geometry Name="PxA" Position="{I3}{{-0.3,0,0,1}}"/>
             <Geometry Name="PxB" Position="{I3}{{0.3,0,0,1}}"/>
           </Geometry>"#
    );
    let xml = pixel_bar_xml(&geoms, &["PxA", "PxB"]);
    let p = &parse_gdtf(&zip_xml(&xml)).expect("parses")[0];
    let near = |a: f64, b: f64| (a - b).abs() < 1e-9;
    assert!(near(p.heads[0].offset, -0.3) && near(p.heads[1].offset, 0.3), "got {}", p.heads[0].offset);
}

#[test]
fn jittered_rows_keep_x_order() {
    // review repro: 2 mm of z jitter (inside the 5 mm row tolerance) must NOT
    // scramble cols — the row re-sorts by x after clustering
    let geoms = format!(
        r#"<Geometry Name="Base">
             <Geometry Name="PxA" Position="{I3}{{-300,0,2,1}}"/>
             <Geometry Name="PxB" Position="{I3}{{-100,0,0,1}}"/>
             <Geometry Name="PxC" Position="{I3}{{100,0,2,1}}"/>
             <Geometry Name="PxD" Position="{I3}{{300,0,0,1}}"/>
           </Geometry>"#
    );
    let xml = pixel_bar_xml(&geoms, &["PxA", "PxB", "PxC", "PxD"]);
    let p = &parse_gdtf(&zip_xml(&xml)).expect("parses")[0];
    assert_eq!(
        p.heads.iter().map(|h| (h.row, h.col)).collect::<Vec<_>>(),
        vec![(0, 0), (0, 1), (0, 2), (0, 3)],
        "one jittered row, cols strictly in x order"
    );
}

#[test]
fn a_tilted_strip_stays_one_row() {
    // y drifts 2 mm per pixel (8 mm total): consecutive gaps stay under the
    // 5 mm tolerance, so this is ONE tilted row — not fragments of two
    let geoms = format!(
        r#"<Geometry Name="Base">
             <Geometry Name="PxA" Position="{I3}{{-300,0,0,1}}"/>
             <Geometry Name="PxB" Position="{I3}{{-100,0,2,1}}"/>
             <Geometry Name="PxC" Position="{I3}{{100,0,4,1}}"/>
             <Geometry Name="PxD" Position="{I3}{{300,0,6,1}}"/>
           </Geometry>"#
    );
    let xml = pixel_bar_xml(&geoms, &["PxA", "PxB", "PxC", "PxD"]);
    let p = &parse_gdtf(&zip_xml(&xml)).expect("parses")[0];
    assert!(p.heads.iter().all(|h| h.row == 0), "gradual drift is one row");
    assert_eq!(
        p.heads.iter().map(|h| h.col).collect::<Vec<_>>(),
        vec![0, 1, 2, 3]
    );
}

#[test]
fn an_off_origin_mm_file_is_classified_by_extent() {
    // pixels 5 m from the author's origin, 40 mm apart: the unit heuristic
    // must see the CENTRED 40 mm extent (mm-scale pitch, metres reading),
    // not the 5000 raw magnitude
    let geoms = format!(
        r#"<Geometry Name="Base">
             <Geometry Name="PxA" Position="{I3}{{5000,0,0,1}}"/>
             <Geometry Name="PxB" Position="{I3}{{5040,0,0,1}}"/>
           </Geometry>"#
    );
    let xml = pixel_bar_xml(&geoms, &["PxA", "PxB"]);
    let p = &parse_gdtf(&zip_xml(&xml)).expect("parses")[0];
    let near = |a: f64, b: f64| (a - b).abs() < 1e-9;
    // centred ±20, raw > 5 → mm → ±0.02 m
    assert!(near(p.heads[0].offset, -0.02), "got {}", p.heads[0].offset);
    assert!(near(p.heads[1].offset, 0.02));
}

#[test]
fn an_absurd_span_falls_back_to_synthesized() {
    // ±6000 raw → mm reading → still ±6 m: wrong under either unit, so the
    // synthesized fallback wins over a 12 m-wide "fixture"
    let geoms = format!(
        r#"<Geometry Name="Base">
             <Geometry Name="PxA" Position="{I3}{{-6000,0,0,1}}"/>
             <Geometry Name="PxB" Position="{I3}{{6000,0,0,1}}"/>
           </Geometry>"#
    );
    let xml = pixel_bar_xml(&geoms, &["PxA", "PxB"]);
    let p = &parse_gdtf(&zip_xml(&xml)).expect("parses")[0];
    let near = |a: f64, b: f64| (a - b).abs() < 1e-9;
    assert!(near(p.heads[0].offset, -0.3), "synthesized 2-head spacing, got {}", p.heads[0].offset);
}

#[test]
fn a_reimport_preserves_an_operator_authored_layout() {
    use light_core::state::EngineState;
    let project: light_core::types::Project = serde_json::from_str(
        r#"{"version":1,"universes":[],"fixtures":[],"groups":[],"layers":[],"columns":[]}"#,
    )
    .unwrap();
    let mut st = EngineState::new(project, 0.0);

    // a zero-geometry bar imports with the flat fallback
    let geoms = format!(
        r#"<Geometry Name="Base">
             <Geometry Name="PxA" Position="{I3}{{0,0,0,1}}"/>
             <Geometry Name="PxB" Position="{I3}{{0,0,0,1}}"/>
             <Geometry Name="PxC" Position="{I3}{{0,0,0,1}}"/>
             <Geometry Name="PxD" Position="{I3}{{0,0,0,1}}"/>
           </Geometry>"#
    );
    let xml = pixel_bar_xml(&geoms, &["PxA", "PxB", "PxC", "PxD"]);
    let parsed = parse_gdtf(&zip_xml(&xml)).unwrap();
    let id = parsed[0].id.clone();
    st.apply_gdtf("bar.gdtf", Ok(parsed.clone()), None);

    // the operator lays it out as a 2×2 grid (what PixelLayout writes)
    {
        let prof = st.project.profiles.get_mut(&id).unwrap();
        for (i, h) in prof.heads.iter_mut().enumerate() {
            h.offset = if i % 2 == 0 { -0.1 } else { 0.1 };
            h.offset_y = if i < 2 { 0.05 } else { -0.05 };
            h.row = i / 2;
            h.col = i % 2;
        }
    }

    // re-importing the SAME layout-less file must not flatten their work
    st.apply_gdtf("bar.gdtf", Ok(parsed), None);
    let prof = st.project.profiles.get(&id).unwrap();
    assert_eq!(prof.heads[3].row, 1, "authored layout survived the re-import");
    assert_eq!(prof.heads[3].col, 1);
    assert!((prof.heads[3].offset - 0.1).abs() < 1e-9);
    assert!((prof.heads[3].offset_y + 0.05).abs() < 1e-9);

    // but a file that DOES carry real geometry stays authoritative
    let real = format!(
        r#"<Geometry Name="Base">
             <Geometry Name="PxA" Position="{I3}{{-150,0,0,1}}"/>
             <Geometry Name="PxB" Position="{I3}{{-50,0,0,1}}"/>
             <Geometry Name="PxC" Position="{I3}{{50,0,0,1}}"/>
             <Geometry Name="PxD" Position="{I3}{{150,0,0,1}}"/>
           </Geometry>"#
    );
    let xml2 = pixel_bar_xml(&real, &["PxA", "PxB", "PxC", "PxD"]);
    st.apply_gdtf("bar.gdtf", Ok(parse_gdtf(&zip_xml(&xml2)).unwrap()), None);
    let prof = st.project.profiles.get(&id).unwrap();
    assert!((prof.heads[0].offset + 0.15).abs() < 1e-9, "real file geometry wins, got {}", prof.heads[0].offset);
    assert_eq!(prof.heads[0].row, 0);
}

/// A one-channel blinder whose GDTF names its attribute `Dimmer1` rather than
/// `Dimmer` — the indexed spelling GDTF uses on indexed geometry, and the same
/// convention as `Shutter1` / `Focus1`, which the importer already accepted.
///
/// Exact-matching `Dimmer` compiled this to a channel with NO cases: a fixture
/// that renders 0 at full dimmer and never lights, with nothing anywhere saying
/// so. A real show had 49 blinders dark for exactly this.
#[test]
fn an_indexed_dimmer_attribute_still_drives_the_dimmer() {
    let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<GDTF DataVersion="1.2">
  <FixtureType Name="Stage Blinder IP" Manufacturer="TEST">
    <Geometries><Geometry Name="Base"/></Geometries>
    <DMXModes>
      <DMXMode Name="1 Channel Mode" Geometry="Base">
        <DMXChannels>
          <DMXChannel DMXBreak="1" Offset="1" Geometry="Base">
            <LogicalChannel Attribute="Dimmer1">
              <ChannelFunction Attribute="Dimmer1" DMXFrom="0/1" Default="0/1"/>
            </LogicalChannel>
          </DMXChannel>
        </DMXChannels>
      </DMXMode>
    </DMXModes>
  </FixtureType>
</GDTF>"#;
    let profiles = light_core::gdtf::parse_gdtf(&zip_xml(xml)).expect("parses");
    let p = profiles.first().expect("one mode");
    let ch = p.channels.first().expect("one channel");
    assert!(
        !ch.cases.is_empty(),
        "an indexed Dimmer must drive something — an empty case list is a dark fixture",
    );
    assert!(
        ch.cases.iter().any(|c| matches!(
            c.func,
            light_core::cprofile::Func::Linear { source: light_core::cprofile::Source::Dimmer }
        )),
        "Dimmer1 should drive Source::Dimmer",
    );
}

/// The narrowing that keeps the above from eating attributes that merely start
/// with a handled name: `Effects1Rate` is not an effects channel's base, and a
/// colour wheel's `Color1` must stay a wheel rather than becoming a dimmer.
#[test]
fn indexed_matching_does_not_swallow_unrelated_attributes() {
    let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<GDTF DataVersion="1.2">
  <FixtureType Name="Odd" Manufacturer="TEST">
    <Geometries><Geometry Name="Base"/></Geometries>
    <DMXModes>
      <DMXMode Name="M" Geometry="Base">
        <DMXChannels>
          <DMXChannel DMXBreak="1" Offset="1" Geometry="Base">
            <LogicalChannel Attribute="Effects1Rate">
              <ChannelFunction Attribute="Effects1Rate" DMXFrom="0/1" Default="0/1"/>
            </LogicalChannel>
          </DMXChannel>
          <DMXChannel DMXBreak="1" Offset="2" Geometry="Base">
            <LogicalChannel Attribute="Dimmer2">
              <ChannelFunction Attribute="Dimmer2" DMXFrom="0/1" Default="0/1"/>
            </LogicalChannel>
          </DMXChannel>
        </DMXChannels>
      </DMXMode>
    </DMXModes>
  </FixtureType>
</GDTF>"#;
    let profiles = light_core::gdtf::parse_gdtf(&zip_xml(xml)).expect("parses");
    let p = profiles.first().expect("one mode");
    let rate = &p.channels[0];
    let dim = &p.channels[1];
    assert!(
        !rate.cases.iter().any(|c| matches!(
            c.func,
            light_core::cprofile::Func::Linear { source: light_core::cprofile::Source::Dimmer }
        )),
        "Effects1Rate must not be read as a dimmer",
    );
    assert!(
        dim.cases.iter().any(|c| matches!(
            c.func,
            light_core::cprofile::Func::Linear { source: light_core::cprofile::Source::Dimmer }
        )),
        "Dimmer2 is a dimmer",
    );
}
