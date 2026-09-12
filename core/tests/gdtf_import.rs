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

/// The beam physicals GDTF states, kept rather than thrown away.
///
/// The importer used to take BeamAngle *or* FieldAngle, whichever it found
/// first, and drop LuminousFlux and BeamRadius entirely — so every renderer
/// downstream invented an edge, a brightness and a source size. The ratio
/// between the two angles is the fixture's character (a real CLF Nero is
/// 123 deg over 160), the flux is what lets a beam conserve energy across a
/// zoom, and the radius is what keeps a 1/r^2 integral finite when the camera
/// looks at the lamp.
#[test]
fn beam_physicals_survive_import() {
    let profiles = parse_gdtf(&synthetic_gdtf()).expect("parses");
    let p = profiles.first().expect("at least one mode");

    assert_eq!(p.beam_deg, 11.5, "BeamAngle is the 50% core");
    assert_eq!(p.field_deg, Some(14.0), "FieldAngle is kept alongside it, not instead");
    assert_eq!(p.lumens, Some(9000.0));
    assert_eq!(p.beam_radius, Some(0.031));

    // field_deg() is the accessor everything should use, and it must never
    // return a field narrower than the beam.
    assert_eq!(p.field_deg(), 14.0);
    let mut inverted = p.clone();
    inverted.field_deg = Some(4.0);
    assert_eq!(inverted.field_deg(), 11.5, "an inside-out cone clamps to the beam angle");

    // A profile that declares nothing still answers, from its form.
    let mut bare = p.clone();
    bare.field_deg = None;
    bare.lumens = None;
    assert!((bare.field_deg() - 11.5 * 1.55).abs() < 1e-9);
    assert!(bare.lumens_or_guess() > 0.0);
}

// ---------------------------------------------------------------------------
// Optics: gobo and prism wheels, their rotation, shutter patterns, and the
// resting value a channel's InitialFunction names (backlog #3).

const OPTICS: &str = include_str!("data/synthetic-optics.gdtf.xml");

fn zipped(xml: &str) -> Vec<u8> {
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

/// A minimal fixture around the given wheels and DMX channels, for the cases
/// the shipped synthetic file does not show.
fn fixture_xml(wheels: &str, channels: &str) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<GDTF DataVersion="1.2"><FixtureType Name="Inline" Manufacturer="ACME">
  <Wheels>{wheels}</Wheels>
  <Geometries><Geometry Name="Base"><Beam Name="Beam1" BeamAngle="10"/></Geometry></Geometries>
  <DMXModes><DMXMode Name="M" Geometry="Base"><DMXChannels>
    <DMXChannel DMXBreak="1" Offset="1" Geometry="Base"><LogicalChannel Attribute="Dimmer"><ChannelFunction Attribute="Dimmer" DMXFrom="0/1" Default="0/1"/></LogicalChannel></DMXChannel>
    {channels}
  </DMXChannels></DMXMode></DMXModes>
</FixtureType></GDTF>"#
    )
}

fn optics_profile() -> light_core::cprofile::CompiledProfile {
    let profiles = parse_gdtf(&zipped(OPTICS)).expect("optics fixture parses");
    assert_eq!(profiles.len(), 1);
    profiles.into_iter().next().unwrap()
}

fn optics_params() -> ResolvedParams {
    ResolvedParams { dimmer: 1.0, pan: 0.5, tilt: 0.5, ..Default::default() }
}

/// The first eight bytes of the optics fixture. It has grown a ninth channel
/// (the flower spin) since these assertions were written; rendering into nine
/// and returning eight keeps every one of them meaning what it did.
fn render8(p: &light_core::cprofile::CompiledProfile, prm: &ResolvedParams) -> [u8; 8] {
    let mut buf = [0u8; 9];
    render_compiled(p, &[prm], &mut buf, 0);
    let mut first = [0u8; 8];
    first.copy_from_slice(&buf[..8]);
    first
}

fn channel<'a>(p: &'a light_core::cprofile::CompiledProfile, name: &str) -> &'a light_core::cprofile::CChannel {
    p.channels.iter().find(|c| c.name == name).unwrap_or_else(|| panic!("no channel {name}"))
}

#[test]
fn optics_park_until_a_look_asks() {
    let p = optics_profile();
    assert_eq!(p.footprint, 9, "eight optics channels and the flower spin");
    assert_eq!(p.heads[0].kind, HeadKind::Mover);
    assert_eq!(p.compiler, light_core::cprofile::COMPILER_VERSION, "the importer stamps its version");
    // shutter rests OPEN (12, from InitialFunction) and the prism rotation at
    // its Stop function's default — neither wheel moves for a look that never
    // mentions them
    assert_eq!(render8(&p, &optics_params()), [128, 128, 255, 12, 0, 0, 0, 128]);
}

#[test]
fn gobo_slot_is_an_index_into_the_wheel() {
    let p = optics_profile();
    let with = |slot: f64| {
        let mut prm = optics_params();
        prm.gobo = Some(slot);
        render8(&p, &prm)[4]
    };
    assert_eq!(with(0.0), 4, "slot 0 = the open band's midpoint (0..9)");
    assert_eq!(with(1.0), 14, "slot 1 = 10..19");
    assert_eq!(with(2.0), 24, "slot 2 = 20..29");
    assert_eq!(with(3.0), 34, "the last slot ends where the shake function begins (39)");
    assert_eq!(with(9.0), 34, "past the wheel clamps to the last slot");
    assert_eq!(with(-3.0), 4, "below it clamps to open");
    assert_eq!(with(1.4), 14, "a fractional slot rounds");
}

#[test]
fn gobo_slot_names_come_from_the_sets_or_the_wheel() {
    let p = optics_profile();
    let ch = channel(&p, "Gobo1");
    let sets = ch
        .cases
        .iter()
        .find_map(|c| match &c.func {
            light_core::cprofile::Func::Slot { sets, source } => {
                assert_eq!(*source, light_core::cprofile::Source::Gobo);
                Some(sets)
            }
            _ => None,
        })
        .expect("a slot case");
    let names: Vec<&str> = sets.iter().map(|s| s.name.as_str()).collect();
    assert_eq!(names, ["Open", "Breakup", "Stars", "Dots"], "the nameless set is named from its wheel slot");
    let bands: Vec<(u8, u8, u8)> = sets.iter().map(|s| (s.min, s.max, s.value)).collect();
    assert_eq!(bands, [(0, 9, 4), (10, 19, 14), (20, 29, 24), (30, 39, 34)]);
    assert!(sets.iter().all(|s| !s.auto), "gobo slots never take part in colour quantisation");
}

#[test]
fn rotation_sweeps_the_union_of_the_rotate_functions() {
    let p = optics_profile();
    let with = |g: Option<f64>, pr: Option<f64>| {
        let mut prm = optics_params();
        prm.beam.gobo_rotate = g;
        prm.beam.prism_rotate = pr;
        render8(&p, &prm)
    };
    // Gobo1Pos: index 0..127 stays untouched; CCW / stop / CW functions from
    // 128 make one 128..255 band
    assert_eq!(with(Some(0.0), None)[5], 128);
    assert_eq!(with(Some(0.5), None)[5], 192);
    assert_eq!(with(Some(1.0), None)[5], 255);
    // Prism1PosRotate names the whole channel: 0..255
    assert_eq!(with(None, Some(0.25))[7], 64);
    assert_eq!(with(None, Some(1.0))[7], 255);
    assert_eq!(with(None, None)[7], 128, "unset rests at the Stop function's default");
}

#[test]
fn prism_slots_span_two_functions() {
    let p = optics_profile();
    let with = |slot: f64| {
        let mut prm = optics_params();
        prm.prism = Some(slot);
        render8(&p, &prm)[6]
    };
    assert_eq!(with(0.0), 31, "Open is 0..63");
    assert_eq!(with(1.0), 95, "3-facet is 64..127 on the second function");
    assert_eq!(with(2.0), 191, "5-facet runs to the channel end");
}

#[test]
fn shutter_patterns_have_bands_of_their_own_and_fall_back_to_plain() {
    use light_core::types::StrobeMode;
    let p = optics_profile();
    let with = |mode: StrobeMode| {
        let mut prm = optics_params();
        prm.strobe = 0.5;
        prm.strobe_mode = mode;
        render8(&p, &prm)[3]
    };
    assert_eq!(with(StrobeMode::Strobe), 72, "plain: 16..127");
    assert_eq!(with(StrobeMode::Pulse), 164, "pulse: 128..199");
    assert_eq!(with(StrobeMode::Random), 228, "random: 200..255");

    // the older synthetic fixture has a pulse band but no random one
    let plain = parse_gdtf(&synthetic_gdtf()).unwrap().remove(0);
    let with = |mode: StrobeMode| {
        let mut prm = params();
        prm.strobe = 0.5;
        prm.strobe_mode = mode;
        let mut buf = [0u8; 16];
        render_compiled(&plain, &[&prm], &mut buf, 0);
        buf[5]
    };
    assert_eq!(with(StrobeMode::Strobe), 108, "plain strobe band 16..199, exactly as before");
    assert_eq!(with(StrobeMode::Pulse), 228, "its pulse band 200..255");
    assert_eq!(with(StrobeMode::Random), 108, "no random band: falls through to plain");
    let mut open = params();
    open.strobe_mode = StrobeMode::Random;
    let mut buf = [0u8; 16];
    render_compiled(&plain, &[&open], &mut buf, 0);
    assert_eq!(buf[5], 8, "a pattern with no strobe rate is no strobe at all");
}

#[test]
fn initial_function_names_the_resting_value() {
    let p = optics_profile();
    assert_eq!(channel(&p, "Shutter1").default, 12, "Open's default, not Closed's (listed first)");
    assert_eq!(channel(&p, "Prism1PosRotate").default, 128, "Stop's default, not CCW's");
    // and a file without the attribute keeps the first function's, as before
    let plain = parse_gdtf(&synthetic_gdtf()).unwrap().remove(0);
    assert_eq!(channel(&plain, "Shutter1").default, 8);
}

#[test]
fn the_rotating_gobo_wheel_is_the_one_light_drives() {
    // A MegaPointe: Gobo1 is a static wheel, Gobo2 rotates. "The gobo" an
    // operator means is the one that spins, so slot and spin both go to 2.
    let xml = fixture_xml(
        r#"<Wheel Name="Static"><Slot Name="Open"/><Slot Name="S1"/></Wheel>
           <Wheel Name="Rotating"><Slot Name="Open"/><Slot Name="R1"/><Slot Name="R2"/></Wheel>"#,
        r#"<DMXChannel DMXBreak="1" Offset="2" Geometry="Base"><LogicalChannel Attribute="Gobo1">
             <ChannelFunction Attribute="Gobo1" DMXFrom="0/1" Default="0/1" Wheel="Static">
               <ChannelSet Name="Open" DMXFrom="0/1"/><ChannelSet Name="S1" DMXFrom="10/1"/></ChannelFunction></LogicalChannel></DMXChannel>
           <DMXChannel DMXBreak="1" Offset="3" Geometry="Base"><LogicalChannel Attribute="Gobo2">
             <ChannelFunction Attribute="Gobo2" DMXFrom="0/1" Default="0/1" Wheel="Rotating">
               <ChannelSet Name="Open" DMXFrom="0/1"/><ChannelSet Name="R1" DMXFrom="10/1"/><ChannelSet Name="R2" DMXFrom="20/1"/></ChannelFunction></LogicalChannel></DMXChannel>
           <DMXChannel DMXBreak="1" Offset="4" Geometry="Base"><LogicalChannel Attribute="Gobo2Pos">
             <ChannelFunction Attribute="Gobo2Pos" DMXFrom="0/1" Default="0/1" Wheel="Rotating"/>
             <ChannelFunction Attribute="Gobo2PosRotate" DMXFrom="128/1" Default="128/1" Wheel="Rotating"/></LogicalChannel></DMXChannel>"#,
    );
    let p = parse_gdtf(&zipped(&xml)).expect("parses").remove(0);
    assert!(channel(&p, "Gobo1").cases.is_empty(), "the static wheel holds its default");
    assert!(!channel(&p, "Gobo2").cases.is_empty());
    assert!(!channel(&p, "Gobo2Pos").cases.is_empty());
    let mut prm = ResolvedParams { dimmer: 1.0, ..Default::default() };
    prm.gobo = Some(2.0);
    prm.beam.gobo_rotate = Some(1.0);
    let mut buf = [0u8; 4];
    render_compiled(&p, &[&prm], &mut buf, 0);
    assert_eq!(buf, [255, 0, 137, 255], "Gobo1 parked, Gobo2 on R2 (the 20..255 band's midpoint), Gobo2Pos full CW");
}

#[test]
fn slot_and_rotation_on_one_channel() {
    // A cheap head puts the wheel and its rotation on one channel: slots
    // low, rotate band high.
    let xml = fixture_xml(
        r#"<Wheel Name="W"><Slot Name="Open"/><Slot Name="Breakup"/></Wheel>"#,
        r#"<DMXChannel DMXBreak="1" Offset="2" Geometry="Base"><LogicalChannel Attribute="Gobo1">
             <ChannelFunction Attribute="Gobo1" DMXFrom="0/1" Default="0/1" Wheel="W">
               <ChannelSet Name="Open" DMXFrom="0/1"/><ChannelSet Name="Breakup" DMXFrom="20/1"/></ChannelFunction>
             <ChannelFunction Attribute="Gobo1PosRotate" DMXFrom="128/1" Default="128/1" Wheel="W"/></LogicalChannel></DMXChannel>"#,
    );
    let p = parse_gdtf(&zipped(&xml)).expect("parses").remove(0);
    assert_eq!(channel(&p, "Gobo1").cases.len(), 4);
    let with = |slot: Option<f64>, rot: Option<f64>| {
        let mut prm = ResolvedParams { dimmer: 1.0, ..Default::default() };
        prm.gobo = slot;
        prm.beam.gobo_rotate = rot;
        let mut buf = [0u8; 2];
        render_compiled(&p, &[&prm], &mut buf, 0);
        buf[1]
    };
    assert_eq!(with(None, None), 0, "nothing asked: parked");
    assert_eq!(with(None, Some(1.0)), 0, "a rotation with no slot chosen has nothing to spin");
    assert_eq!(with(Some(1.0), None), 73, "slot 1 = 20..127, the rotate band starting at 128");
    assert_eq!(with(Some(0.0), Some(1.0)), 9, "open stays open, whatever the rotation says");
    assert_eq!(with(Some(1.0), Some(0.0)), 128, "slot 1 spinning: the rotate band");
    assert_eq!(with(Some(1.0), Some(1.0)), 255);
}

#[test]
fn a_wheel_without_channel_sets_spreads_its_slots() {
    let xml = fixture_xml(
        r#"<Wheel Name="W"><Slot Name="Open"/><Slot Name="A"/><Slot Name="B"/><Slot Name="C"/></Wheel>"#,
        r#"<DMXChannel DMXBreak="1" Offset="2" Geometry="Base"><LogicalChannel Attribute="Gobo1">
             <ChannelFunction Attribute="Gobo1" DMXFrom="0/1" Default="0/1" Wheel="W"/>
             <ChannelFunction Attribute="Gobo1WheelSpin" DMXFrom="128/1" Default="128/1" Wheel="W"/></LogicalChannel></DMXChannel>"#,
    );
    let p = parse_gdtf(&zipped(&xml)).expect("parses").remove(0);
    let sets = channel(&p, "Gobo1")
        .cases
        .iter()
        .find_map(|c| match &c.func {
            light_core::cprofile::Func::Slot { sets, .. } => Some(sets.clone()),
            _ => None,
        })
        .expect("slot case");
    let bands: Vec<(&str, u8, u8, u8)> = sets.iter().map(|s| (s.name.as_str(), s.min, s.max, s.value)).collect();
    assert_eq!(
        bands,
        [("Open", 0, 31, 15), ("A", 32, 63, 47), ("B", 64, 95, 79), ("C", 96, 127, 111)],
        "four slots share the function's 0..127, not the whole channel"
    );
}

// ---------------------------------------------------------------------------
// Pan and tilt travel: how far the head actually swings, from the file rather
// than from the 540/270 both stage views used to assume (backlog #5).

#[test]
fn travel_comes_from_the_file_and_falls_back_when_it_does_not_say() {
    let p = parse_gdtf(&synthetic_gdtf()).expect("parses").remove(0);
    // Pan declares PhysicalFrom -270 / PhysicalTo 270
    assert_eq!(p.pan_deg, Some(540.0));
    assert_eq!(p.pan_travel(), 540.0);
    // Tilt declares no physical range at all, so nothing is invented...
    assert_eq!(p.tilt_deg, None);
    // ...and the accessor supplies the figure the previz used to hardcode
    assert_eq!(p.tilt_travel(), 270.0);
}

#[test]
fn travel_is_a_magnitude_whichever_way_the_file_writes_it() {
    // A Lyra declares pan 270 -> -270 and a MegaPointe -270 -> 270. Both swing
    // 540 degrees; the sign is about the fixture's own axes, and acting on it
    // would silently reverse every imported mover. Which way a head should
    // move is the operator's invertPan.
    let descending = fixture_xml(
        "",
        r#"<DMXChannel DMXBreak="1" Offset="2" Geometry="Base"><LogicalChannel Attribute="Pan">
             <ChannelFunction Attribute="Pan" DMXFrom="0/1" PhysicalFrom="270" PhysicalTo="-270"/></LogicalChannel></DMXChannel>
           <DMXChannel DMXBreak="1" Offset="3" Geometry="Base"><LogicalChannel Attribute="Tilt">
             <ChannelFunction Attribute="Tilt" DMXFrom="0/1" PhysicalFrom="110" PhysicalTo="-110"/></LogicalChannel></DMXChannel>"#,
    );
    let p = parse_gdtf(&zipped(&descending)).expect("parses").remove(0);
    assert_eq!(p.pan_deg, Some(540.0));
    assert_eq!(p.tilt_deg, Some(220.0), "a Spiider's 110 either side");
}

#[test]
fn an_absurd_or_zero_travel_is_ignored_rather_than_drawn() {
    let junk = fixture_xml(
        "",
        r#"<DMXChannel DMXBreak="1" Offset="2" Geometry="Base"><LogicalChannel Attribute="Pan">
             <ChannelFunction Attribute="Pan" DMXFrom="0/1" PhysicalFrom="0" PhysicalTo="0"/></LogicalChannel></DMXChannel>
           <DMXChannel DMXBreak="1" Offset="3" Geometry="Base"><LogicalChannel Attribute="Tilt">
             <ChannelFunction Attribute="Tilt" DMXFrom="0/1" PhysicalFrom="-100000" PhysicalTo="100000"/></LogicalChannel></DMXChannel>"#,
    );
    let p = parse_gdtf(&zipped(&junk)).expect("parses").remove(0);
    assert_eq!(p.pan_deg, None, "a zero swing is not a swing");
    assert_eq!(p.tilt_deg, None, "nor is one no yoke could make");
    assert_eq!((p.pan_travel(), p.tilt_travel()), (540.0, 270.0));
}

// ---------------------------------------------------------------------------
// Warmth in Kelvin: the fixture states the temperature at each end, which is
// the difference between a fader reading "43%" and one reading "3200K"
// (backlog #15).

#[test]
fn the_warmth_range_comes_from_the_file_in_wire_order() {
    // A Spiider runs 8000 K at the low end down to 2700 at the high one. NOT
    // sorted: which end is warm is the half of this a fader label needs.
    let xml = fixture_xml(
        "",
        r#"<DMXChannel DMXBreak="1" Offset="2" Geometry="Base"><LogicalChannel Attribute="CTO">
             <ChannelFunction Attribute="CTO" DMXFrom="0/1" PhysicalFrom="8000" PhysicalTo="2700"/></LogicalChannel></DMXChannel>"#,
    );
    let p = parse_gdtf(&zipped(&xml)).expect("parses").remove(0);
    assert_eq!(p.cto_k, Some((8000.0, 2700.0)));
}

#[test]
fn a_warmth_range_no_lamp_could_have_is_ignored() {
    for (from, to) in [("0", "0"), ("6500", "6500"), ("1", "5"), ("50000", "2700")] {
        let xml = fixture_xml(
            "",
            &format!(
                r#"<DMXChannel DMXBreak="1" Offset="2" Geometry="Base"><LogicalChannel Attribute="CTO">
                     <ChannelFunction Attribute="CTO" DMXFrom="0/1" PhysicalFrom="{from}" PhysicalTo="{to}"/></LogicalChannel></DMXChannel>"#
            ),
        );
        let p = parse_gdtf(&zipped(&xml)).expect("parses").remove(0);
        assert_eq!(p.cto_k, None, "{from} to {to} should not have been believed");
    }
}

#[test]
fn a_fixture_that_says_nothing_about_kelvin_offers_none() {
    // The fader then reads as a percentage rather than inventing a number.
    let xml = fixture_xml(
        "",
        r#"<DMXChannel DMXBreak="1" Offset="2" Geometry="Base"><LogicalChannel Attribute="CTO">
             <ChannelFunction Attribute="CTO" DMXFrom="0/1" Default="0/1"/></LogicalChannel></DMXChannel>"#,
    );
    let p = parse_gdtf(&zipped(&xml)).expect("parses").remove(0);
    assert_eq!(p.cto_k, None);
}

/// A pixel array written the way manufacturers actually write one: the colour
/// channels declared ONCE on a template lens, each physical pixel a
/// GeometryReference to it with its own Position and a DMX offset per break.
/// The references carry TWO Break entries — the four-channel offset first and
/// the three-channel one last — and the modes pick between them by declaring
/// their pixel channels on break 1 or as an Overwrite. That is, line for line,
/// how a Robin Spiider is written. A seventh pixel (the "flower") is a
/// template with a single instance at offset 1, which must compile exactly as
/// a plain geometry did before.
fn ring_head_xml() -> String {
    let ring = [(0, 60), (52, 30), (52, -30), (0, -60), (-52, -30), (-52, 30)];
    let mut refs = String::new();
    for (i, (x, y)) in ring.iter().enumerate() {
        refs.push_str(&format!(
            r#"<GeometryReference Name="P{n}" Geometry="Lens" Position="{I3}{{{x},{y},0,1}}">
                 <Break DMXBreak="1" DMXOffset="{four}"/>
                 <Break DMXBreak="1" DMXOffset="{three}"/>
               </GeometryReference>"#,
            n = i + 1,
            four = i * 4 + 1,
            three = i * 3 + 1,
        ));
    }
    let chan = |brk: &str, geom: &str, attr: &str, off: usize| {
        format!(
            r#"<DMXChannel DMXBreak="{brk}" Offset="{off}" Geometry="{geom}">
                 <LogicalChannel Attribute="{attr}">
                   <ChannelFunction Attribute="{attr}" DMXFrom="0/1" Default="0/1"/>
                 </LogicalChannel>
               </DMXChannel>"#
        )
    };
    let common = format!(
        "{}{}{}",
        chan("1", "Yoke", "Pan", 1).replace(r#"Offset="1""#, r#"Offset="1,2""#),
        chan("1", "Head", "Tilt", 3).replace(r#"Offset="3""#, r#"Offset="3,4""#),
        chan("1", "Head", "Dimmer", 5),
    );
    let rgb = format!(
        "{common}{}{}{}{}{}{}",
        chan("Overwrite", "Lens", "ColorAdd_R", 6),
        chan("Overwrite", "Lens", "ColorAdd_G", 7),
        chan("Overwrite", "Lens", "ColorAdd_B", 8),
        chan("1", "Flower", "ColorAdd_R", 24),
        chan("1", "Flower", "ColorAdd_G", 25),
        chan("1", "Flower", "ColorAdd_B", 26),
    );
    let rgbw = format!(
        "{common}{}{}{}{}{}{}{}{}",
        chan("1", "Lens", "ColorAdd_R", 6),
        chan("1", "Lens", "ColorAdd_G", 7),
        chan("1", "Lens", "ColorAdd_B", 8),
        chan("1", "Lens", "ColorAdd_W", 9),
        chan("1", "Flower", "ColorAdd_R", 30),
        chan("1", "Flower", "ColorAdd_G", 31),
        chan("1", "Flower", "ColorAdd_B", 32),
        chan("1", "Flower", "ColorAdd_W", 33),
    );
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<GDTF DataVersion="1.2">
  <FixtureType Name="RingHead" Manufacturer="TEST">
    <Geometries>
      <Geometry Name="Base" Position="{I3}{{0,0,0,1}}">
        <Axis Name="Yoke" Position="{I3}{{0,0,0,1}}">
          <Axis Name="Head" Position="{I3}{{0,0,200,1}}">
            <Geometry Name="Face">{refs}</Geometry>
            <GeometryReference Name="Centre" Geometry="Flower" Position="{I3}{{0,0,-100,1}}">
              <Break DMXBreak="1" DMXOffset="1"/>
            </GeometryReference>
          </Axis>
        </Axis>
      </Geometry>
      <Beam Name="Lens" BeamAngle="25" FieldAngle="25" LuminousFlux="500"/>
      <Beam Name="Flower" BeamAngle="25" FieldAngle="25" LuminousFlux="500"/>
    </Geometries>
    <DMXModes>
      <DMXMode Name="RGB" Geometry="Base"><DMXChannels>{rgb}</DMXChannels></DMXMode>
      <DMXMode Name="RGBW" Geometry="Base"><DMXChannels>{rgbw}</DMXChannels></DMXMode>
    </DMXModes>
  </FixtureType>
</GDTF>"#
    )
}

#[test]
fn referenced_pixels_each_get_their_own_channels() {
    // Six ring pixels plus the flower: seven heads, not two templates.
    let profiles = parse_gdtf(&zip_xml(&ring_head_xml())).expect("parses");
    let rgb = profiles.iter().find(|p| p.mode == "RGB").expect("RGB mode");
    assert_eq!(rgb.heads.len(), 7, "one head per instance, plus the single-instance flower");
    assert_eq!(
        rgb.heads.iter().map(|h| h.label.as_str()).collect::<Vec<_>>(),
        ["P1", "P2", "P3", "P4", "P5", "P6", "Centre"],
        "heads in document order, named for the INSTANCE"
    );
    // Three-channel mode: the pixel channels are declared as an Overwrite, so
    // each instance takes the LAST break entry — a stride of three.
    assert_eq!(rgb.footprint, 26, "P6's blue is channel 23 and the flower runs 24..26");
    let head_of = |one_based: usize| {
        rgb.channels.iter().find(|c| c.offsets == vec![one_based - 1]).map(|c| c.head)
    };
    assert_eq!(head_of(6), Some(0), "P1 red where the template declared it");
    assert_eq!(head_of(12), Some(2), "P3 red three channels later per pixel");
    assert_eq!(head_of(23), Some(5), "P6 blue");
    assert_eq!(head_of(24), Some(6), "the flower's own channels are untouched");
    assert_eq!(head_of(9), Some(1));
    // pan and tilt stay on head 0, which is what both previews steer by
    let pan = rgb.channels.iter().find(|c| c.name == "Pan").expect("pan");
    assert_eq!(pan.head, 0);
    assert_eq!(rgb.form(), light_core::cprofile::FixtureForm::Mover, "it aims, so it is a mover");
}

#[test]
fn a_four_channel_mode_takes_the_first_break_entry() {
    let profiles = parse_gdtf(&zip_xml(&ring_head_xml())).expect("parses");
    let rgbw = profiles.iter().find(|p| p.mode == "RGBW").expect("RGBW mode");
    assert_eq!(rgbw.heads.len(), 7);
    assert_eq!(rgbw.footprint, 33, "stride of four: P6 ends at 29, the flower runs 30..33");
    let head_of = |one_based: usize| {
        rgbw.channels.iter().find(|c| c.offsets == vec![one_based - 1]).map(|c| c.head)
    };
    assert_eq!(head_of(6), Some(0));
    assert_eq!(head_of(14), Some(2), "P3 red, four channels per pixel this time");
    assert_eq!(head_of(29), Some(5), "P6 white");
    assert_eq!(head_of(30), Some(6), "the flower");
}

#[test]
fn a_ring_face_keeps_its_shape_instead_of_becoming_a_line() {
    // The pixels vary in GDTF X and Y with Z pointing down the beam — the
    // moving-head way round. Read as a bar (drop Y) they collapsed to a line.
    // The recessed flower is the outlier that must not tip the plane choice.
    let profiles = parse_gdtf(&zip_xml(&ring_head_xml())).expect("parses");
    let p = profiles.iter().find(|p| p.mode == "RGB").unwrap();
    let near = |a: f64, b: f64| (a - b).abs() < 1e-9;
    let by = |label: &str| p.heads.iter().find(|h| h.label == label).unwrap();
    assert!(near(by("P1").offset, 0.0) && near(by("P1").offset_y, 0.06), "top of the ring, 60 mm up: {:?}", (by("P1").offset, by("P1").offset_y));
    assert!(near(by("P4").offset_y, -0.06), "bottom of the ring");
    assert!(near(by("P2").offset, 0.052) && near(by("P2").offset_y, 0.03));
    assert!(near(by("P5").offset, -0.052) && near(by("P5").offset_y, -0.03));
    assert!(near(by("Centre").offset, 0.0) && near(by("Centre").offset_y, 0.0), "the flower's recess is depth, dropped");
    assert!(p.heads.iter().any(|h| !near(h.offset_y, 0.0)), "not a line");
}

#[test]
fn an_instance_with_no_matching_break_is_skipped_not_misaddressed() {
    // Template on break 2; one reference offers break 2, the other only
    // break 1. The second cannot be placed and must vanish rather than land on
    // a guessed offset — a wrong address on a real rig lights the wrong lamp.
    let xml = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<GDTF DataVersion="1.2"><FixtureType Name="Odd" Manufacturer="TEST">
  <Geometries>
    <Geometry Name="Base">
      <GeometryReference Name="A" Geometry="L" Position="{I3}{{-100,0,0,1}}"><Break DMXBreak="2" DMXOffset="1"/></GeometryReference>
      <GeometryReference Name="B" Geometry="L" Position="{I3}{{100,0,0,1}}"><Break DMXBreak="1" DMXOffset="4"/></GeometryReference>
    </Geometry>
    <Geometry Name="L"/>
  </Geometries>
  <DMXModes><DMXMode Name="M" Geometry="Base"><DMXChannels>
    <DMXChannel DMXBreak="2" Offset="1" Geometry="L"><LogicalChannel Attribute="ColorAdd_R"><ChannelFunction Attribute="ColorAdd_R" DMXFrom="0/1" Default="0/1"/></LogicalChannel></DMXChannel>
    <DMXChannel DMXBreak="2" Offset="2" Geometry="L"><LogicalChannel Attribute="ColorAdd_G"><ChannelFunction Attribute="ColorAdd_G" DMXFrom="0/1" Default="0/1"/></LogicalChannel></DMXChannel>
    <DMXChannel DMXBreak="2" Offset="3" Geometry="L"><LogicalChannel Attribute="ColorAdd_B"><ChannelFunction Attribute="ColorAdd_B" DMXFrom="0/1" Default="0/1"/></LogicalChannel></DMXChannel>
  </DMXChannels></DMXMode></DMXModes>
</FixtureType></GDTF>"#
    );
    let p = &parse_gdtf(&zip_xml(&xml)).expect("parses")[0];
    assert_eq!(p.channels.len(), 3, "only A's copy exists");
    assert_eq!(p.footprint, 3);
    assert!(p.channels.iter().all(|c| c.offsets[0] < 3), "A sits where the template declared");
}

#[test]
fn the_spec_matrix_form_is_read_with_its_translation_in_the_last_column() {
    // The GDTF spec writes a 4x4 row by row with the translation in the last
    // column and {0,0,0,1} as the final row — how Robe writes a Spiider. The
    // parent is turned a quarter turn about Z, so the child at local +x must
    // come out at world +y: that is R·p, and reading it as p·R would put it
    // at -y. Metres here, so the unit heuristic stays out of it.
    let xml = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<GDTF DataVersion="1.2"><FixtureType Name="Spec" Manufacturer="TEST">
  <Geometries>
    <Geometry Name="Base" Position="{{1,0,0,0}}{{0,1,0,0}}{{0,0,1,0}}{{0,0,0,1}}">
      <Geometry Name="Turned" Position="{{0,-1,0,0}}{{1,0,0,0}}{{0,0,1,-0.3}}{{0,0,0,1}}">
        <Geometry Name="PxA" Position="{{1,0,0,0.1}}{{0,1,0,0}}{{0,0,1,0}}{{0,0,0,1}}"/>
        <Geometry Name="PxB" Position="{{1,0,0,-0.1}}{{0,1,0,0}}{{0,0,1,0}}{{0,0,0,1}}"/>
        <Geometry Name="PxC" Position="{{1,0,0,0}}{{0,1,0,0.2}}{{0,0,1,0}}{{0,0,0,1}}"/>
      </Geometry>
    </Geometry>
  </Geometries>
  <DMXModes><DMXMode Name="M" Geometry="Base"><DMXChannels>{}</DMXChannels></DMXMode></DMXModes>
</FixtureType></GDTF>"#,
        ["PxA", "PxB", "PxC"]
            .iter()
            .enumerate()
            .map(|(i, g)| {
                ["ColorAdd_R", "ColorAdd_G", "ColorAdd_B"]
                    .iter()
                    .enumerate()
                    .map(|(k, a)| format!(
                        r#"<DMXChannel DMXBreak="1" Offset="{}" Geometry="{g}"><LogicalChannel Attribute="{a}"><ChannelFunction Attribute="{a}" DMXFrom="0/1" Default="0/1"/></LogicalChannel></DMXChannel>"#,
                        i * 3 + k + 1
                    ))
                    .collect::<String>()
            })
            .collect::<String>()
    );
    let p = &parse_gdtf(&zip_xml(&xml)).expect("parses")[0];
    let near = |a: f64, b: f64| (a - b).abs() < 1e-9;
    let by = |l: &str| p.heads.iter().find(|h| h.label == l).unwrap();
    // The face here varies in X and Y, so Y is up: PxA's local +x became
    // world +y (up), PxB world -y, PxC's local +y became world -x. Then the
    // layout is centred, which moves every x by +0.2/3.
    let cx = 0.2 / 3.0;
    assert!(near(by("PxA").offset, cx) && near(by("PxA").offset_y, 0.1), "PxA {:?}", (by("PxA").offset, by("PxA").offset_y));
    assert!(near(by("PxB").offset, cx) && near(by("PxB").offset_y, -0.1), "PxB {:?}", (by("PxB").offset, by("PxB").offset_y));
    assert!(near(by("PxC").offset, -0.2 + cx) && near(by("PxC").offset_y, 0.0), "PxC {:?}", (by("PxC").offset, by("PxC").offset_y));
}


/// A Spiider's flower effect: DMX 0 is "off", 1..255 runs fast one way
/// through still at 128 to fast the other. The importer maps the fader across
/// 1..255 so its middle lands EXACTLY on the still point, and leaves the
/// channel at the file's default — off — until a look sets it.
#[test]
fn flower_spin_sweeps_the_rotate_band_and_rests_off() {
    let p = &parse_gdtf(&zipped(OPTICS)).expect("parses")[0];
    assert_eq!(p.footprint, 9, "the flower channel is the ninth");
    let flower = p.channels.iter().find(|c| c.name == "FlowerEffect").expect("a FlowerEffect channel");
    assert_eq!(flower.offsets, vec![8]);
    let byte = |v: Option<f64>| {
        let mut prm = ResolvedParams { dimmer: 1.0, ..Default::default() };
        prm.beam.flower = v;
        let mut buf = [0u8; 9];
        render_compiled(p, &[&prm], &mut buf, 0);
        buf[8]
    };
    assert_eq!(byte(None), 0, "nothing asked: the effect is off, as the file parks it");
    assert_eq!(byte(Some(0.5)), 128, "the fader's middle is the still point, not 127");
    assert_eq!(byte(Some(0.0)), 1, "one end is full speed one way — never the off value");
    assert_eq!(byte(Some(1.0)), 255, "the other end is full speed the other way");
    // the whole profile still says it drives it, which is what shows the fader
    assert!(p.drives(light_core::cprofile::Source::Flower));
}

/// The committed archive must BE the XML beside it. The parity harness imports
/// `data/synthetic-optics.gdtf` while these tests build one from the `.xml`,
/// and nothing held the two together — a channel added to the XML would not
/// reach the harness until somebody remembered to re-zip. Regenerate with
/// `LIGHT_BLESS_GOLDEN=1 cargo test -p light-core --test gdtf_import`.
#[test]
fn the_committed_optics_archive_is_the_one_the_tests_assert_against() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/data/synthetic-optics.gdtf");
    let built = zipped(OPTICS);
    assert_eq!(built, zipped(OPTICS), "the archive builder is not reproducible");
    if std::env::var("LIGHT_BLESS_GOLDEN").is_ok() {
        std::fs::write(path, &built).expect("write archive");
        return;
    }
    let have = std::fs::read(path).expect("archive missing");
    assert_eq!(have, built, "data/synthetic-optics.gdtf drifted from its .xml");
}
