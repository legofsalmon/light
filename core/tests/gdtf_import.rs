//! GDTF import: a synthetic, spec-shaped .gdtf archive covering 16-bit
//! position, dimmer, RGB, shutter/strobe function pairs, a colour wheel with
//! CIE slot colours, and an unmapped channel that must hold its default.

use std::io::Write;

use light_core::cprofile::render_compiled;
use light_core::gdtf::parse_gdtf;
use light_core::profiles::{HeadKind, ResolvedParams};

const DESCRIPTION: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<GDTF DataVersion="1.2">
  <FixtureType Name="TestSpot 100" Manufacturer="ACME" Description="synthetic test fixture">
    <Wheels>
      <Wheel Name="ColorWheel1">
        <Slot Name="Open" Color="0.3127,0.3290,100.0"/>
        <Slot Name="Red" Color="0.6400,0.3300,21.26"/>
        <Slot Name="Blue" Color="0.1500,0.0600,7.22"/>
      </Wheel>
    </Wheels>
    <Geometries>
      <Geometry Name="Base">
        <Beam Name="Beam1" BeamAngle="11.5" FieldAngle="14" LuminousFlux="9000"/>
      </Geometry>
    </Geometries>
    <DMXModes>
      <DMXMode Name="Standard" Geometry="Base">
        <DMXChannels>
          <DMXChannel DMXBreak="1" Offset="1,2" Geometry="Base">
            <LogicalChannel Attribute="Pan">
              <ChannelFunction Attribute="Pan" DMXFrom="0/1" Default="32768/2" PhysicalFrom="-270" PhysicalTo="270"/>
            </LogicalChannel>
          </DMXChannel>
          <DMXChannel DMXBreak="1" Offset="3,4" Geometry="Base">
            <LogicalChannel Attribute="Tilt">
              <ChannelFunction Attribute="Tilt" DMXFrom="0/1" Default="32768/2"/>
            </LogicalChannel>
          </DMXChannel>
          <DMXChannel DMXBreak="1" Offset="5" Geometry="Base">
            <LogicalChannel Attribute="Dimmer">
              <ChannelFunction Attribute="Dimmer" DMXFrom="0/1" Default="0/1"/>
            </LogicalChannel>
          </DMXChannel>
          <DMXChannel DMXBreak="1" Offset="6" Geometry="Base">
            <LogicalChannel Attribute="Shutter1">
              <ChannelFunction Attribute="Shutter1" DMXFrom="0/1" Default="8/1"/>
              <ChannelFunction Attribute="Shutter1Strobe" DMXFrom="16/1"/>
              <ChannelFunction Attribute="Shutter1StrobePulse" DMXFrom="200/1"/>
            </LogicalChannel>
          </DMXChannel>
          <DMXChannel DMXBreak="1" Offset="7" Geometry="Base">
            <LogicalChannel Attribute="ColorAdd_R">
              <ChannelFunction Attribute="ColorAdd_R" DMXFrom="0/1" Default="0/1"/>
            </LogicalChannel>
          </DMXChannel>
          <DMXChannel DMXBreak="1" Offset="8" Geometry="Base">
            <LogicalChannel Attribute="ColorAdd_G">
              <ChannelFunction Attribute="ColorAdd_G" DMXFrom="0/1" Default="0/1"/>
            </LogicalChannel>
          </DMXChannel>
          <DMXChannel DMXBreak="1" Offset="9" Geometry="Base">
            <LogicalChannel Attribute="ColorAdd_B">
              <ChannelFunction Attribute="ColorAdd_B" DMXFrom="0/1" Default="0/1"/>
            </LogicalChannel>
          </DMXChannel>
          <DMXChannel DMXBreak="1" Offset="10" Geometry="Base">
            <LogicalChannel Attribute="Zoom">
              <ChannelFunction Attribute="Zoom" DMXFrom="0/1" Default="128/1"/>
            </LogicalChannel>
          </DMXChannel>
          <DMXChannel DMXBreak="1" Offset="11" Geometry="Base">
            <LogicalChannel Attribute="Color1">
              <ChannelFunction Attribute="Color1" DMXFrom="0/1" Default="0/1" Wheel="ColorWheel1">
                <ChannelSet Name="Open" DMXFrom="0/1"/>
                <ChannelSet Name="Red" DMXFrom="16/1"/>
                <ChannelSet Name="Blue" DMXFrom="32/1"/>
              </ChannelFunction>
            </LogicalChannel>
          </DMXChannel>
        </DMXChannels>
      </DMXMode>
    </DMXModes>
  </FixtureType>
</GDTF>"#;

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
