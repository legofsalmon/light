//! MVR import: synthetic archive with two fixtures (one inside a transformed
//! GroupObject), an embedded GDTF, absolute + dot address forms, and a
//! fixture with a missing GDTF that must be skipped with a warning.

use std::io::Write;

use light_core::mvr::parse_mvr;

const SCENE: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<GeneralSceneDescription verMajor="1" verMinor="6">
 <Scene>
  <Layers>
   <Layer name="Front Truss">
    <ChildList>
     <Fixture name="Spot L" uuid="a">
      <Matrix>{1,0,0}{0,1,0}{0,0,1}{-2000,1000,3000}</Matrix>
      <GDTFSpec>TestSpot.gdtf</GDTFSpec>
      <GDTFMode>Standard</GDTFMode>
      <Addresses><Address break="0">513</Address></Addresses>
     </Fixture>
     <GroupObject name="SR cluster">
      <Matrix>{1,0,0}{0,1,0}{0,0,1}{4000,0,0}</Matrix>
      <ChildList>
       <Fixture name="Spot R" uuid="b">
        <Matrix>{1,0,0}{0,1,0}{0,0,1}{-2000,1000,3000}</Matrix>
        <GDTFSpec>TestSpot</GDTFSpec>
        <GDTFMode>Nonexistent Mode</GDTFMode>
        <Addresses><Address break="0">2.25</Address></Addresses>
       </Fixture>
      </ChildList>
     </GroupObject>
     <Fixture name="Ghost" uuid="c">
      <GDTFSpec>Missing.gdtf</GDTFSpec>
      <Addresses><Address break="0">1</Address></Addresses>
     </Fixture>
    </ChildList>
   </Layer>
  </Layers>
 </Scene>
</GeneralSceneDescription>"#;

fn synthetic_mvr() -> Vec<u8> {
    // embedded GDTF = the synthetic archive from the GDTF tests
    let gdtf_xml = include_str!("data/synthetic.gdtf.xml");
    let mut gdtf = Vec::new();
    {
        let mut z = zip::ZipWriter::new(std::io::Cursor::new(&mut gdtf));
        z.start_file::<_, ()>("description.xml", zip::write::SimpleFileOptions::default()).unwrap();
        z.write_all(gdtf_xml.as_bytes()).unwrap();
        z.finish().unwrap();
    }
    let mut buf = Vec::new();
    {
        let mut z = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
        let opts = zip::write::SimpleFileOptions::default();
        z.start_file::<_, ()>("GeneralSceneDescription.xml", opts).unwrap();
        z.write_all(SCENE.as_bytes()).unwrap();
        z.start_file::<_, ()>("TestSpot.gdtf", opts).unwrap();
        z.write_all(&gdtf).unwrap();
        z.finish().unwrap();
    }
    buf
}

#[test]
fn imports_scene() {
    let b = parse_mvr(&synthetic_mvr()).expect("parses");
    assert_eq!(b.fixtures.len(), 2, "ghost fixture skipped");
    assert_eq!(b.profiles.len(), 1, "one gdtf mode used");

    let l = &b.fixtures[0];
    assert_eq!(l.name, "Spot L");
    // absolute 513 → wire universe 1, channel 1
    assert_eq!((l.universe, l.address), (1, 1));
    // mm Z-up (-2000, 1000, 3000) → m Y-up (-2, 3, -1)
    assert!((l.pos[0] + 2.0).abs() < 1e-9 && (l.pos[1] - 3.0).abs() < 1e-9 && (l.pos[2] + 1.0).abs() < 1e-9);

    let r = &b.fixtures[1];
    assert_eq!(r.name, "Spot R");
    // dot form "2.25" → wire universe 2, channel 25
    assert_eq!((r.universe, r.address), (2, 25));
    // group transform composes: (-2000+4000, 1000, 3000) → (2, 3, -1)
    assert!((r.pos[0] - 2.0).abs() < 1e-9 && (r.pos[1] - 3.0).abs() < 1e-9 && (r.pos[2] + 1.0).abs() < 1e-9);

    assert_eq!(b.groups.len(), 1);
    assert_eq!(b.groups[0].name, "Front Truss");
    assert_eq!(b.groups[0].fixtures, vec![0, 1]);

    // warnings: missing gdtf + wrong mode fallback
    assert!(b.warnings.iter().any(|w| w.contains("Missing.gdtf")), "{:?}", b.warnings);
    assert!(b.warnings.iter().any(|w| w.contains("Nonexistent Mode")), "{:?}", b.warnings);
}

#[test]
fn rejects_garbage() {
    assert!(parse_mvr(b"nope").is_err());
    // zip without scene xml
    let mut buf = Vec::new();
    {
        let mut z = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
        z.start_file::<_, ()>("readme.txt", zip::write::SimpleFileOptions::default()).unwrap();
        z.write_all(b"hi").unwrap();
        z.finish().unwrap();
    }
    assert!(parse_mvr(&buf).is_err());
}

/// A scene nested absurdly deep must not overflow the import worker's stack
/// (a hard SIGABRT). It is refused with a clear error, before roxmltree — whose
/// own tree build/drop recurses — ever sees it.
#[test]
fn pathologically_deep_scene_is_refused_not_fatal() {
    let mut scene = String::from(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<GeneralSceneDescription verMajor="1" verMinor="6"><Scene><Layers><Layer name="Deep">"#,
    );
    // 10000 levels of real nesting — far past what roxmltree survives
    for _ in 0..5000 {
        scene.push_str("<GroupObject><ChildList>");
    }
    scene.push_str(
        r#"<Fixture name="Buried"><GDTFSpec>TestSpot.gdtf</GDTFSpec><GDTFMode>Standard</GDTFMode><Addresses><Address break="0">1</Address></Addresses></Fixture>"#,
    );
    for _ in 0..5000 {
        scene.push_str("</ChildList></GroupObject>");
    }
    scene.push_str("</Layer></Layers></Scene></GeneralSceneDescription>");

    let mut buf = Vec::new();
    {
        let mut z = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
        let opts = zip::write::SimpleFileOptions::default();
        z.start_file::<_, ()>("GeneralSceneDescription.xml", opts).unwrap();
        z.write_all(scene.as_bytes()).unwrap();
        z.finish().unwrap();
    }
    // returns Err rather than crashing the process
    let r = parse_mvr(&buf);
    assert!(r.is_err(), "a depth-bomb MVR is refused");
    assert!(r.unwrap_err().contains("deeper"), "the error names the depth limit");
}

/// A moderately deep but legal scene (well under the guard limit) still imports
/// normally — the guard must not punish real, if unusual, nesting.
#[test]
fn moderately_deep_scene_still_imports() {
    let gdtf_xml = include_str!("data/synthetic.gdtf.xml");
    let mut gdtf = Vec::new();
    {
        let mut z = zip::ZipWriter::new(std::io::Cursor::new(&mut gdtf));
        z.start_file::<_, ()>("description.xml", zip::write::SimpleFileOptions::default()).unwrap();
        z.write_all(gdtf_xml.as_bytes()).unwrap();
        z.finish().unwrap();
    }
    let mut scene = String::from(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<GeneralSceneDescription verMajor="1" verMinor="6"><Scene><Layers><Layer name="Nested">"#,
    );
    // 100 levels of grouping — unusual but legal, comfortably under the limit
    for _ in 0..50 {
        scene.push_str("<GroupObject><ChildList>");
    }
    scene.push_str(
        r#"<Fixture name="Deep One"><GDTFSpec>TestSpot.gdtf</GDTFSpec><GDTFMode>Standard</GDTFMode><Addresses><Address break="0">1</Address></Addresses></Fixture>"#,
    );
    for _ in 0..50 {
        scene.push_str("</ChildList></GroupObject>");
    }
    scene.push_str("</Layer></Layers></Scene></GeneralSceneDescription>");

    let mut buf = Vec::new();
    {
        let mut z = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
        let opts = zip::write::SimpleFileOptions::default();
        z.start_file::<_, ()>("GeneralSceneDescription.xml", opts).unwrap();
        z.write_all(scene.as_bytes()).unwrap();
        z.start_file::<_, ()>("TestSpot.gdtf", opts).unwrap();
        z.write_all(&gdtf).unwrap();
        z.finish().unwrap();
    }
    let b = parse_mvr(&buf).expect("a 100-deep scene parses");
    assert_eq!(b.fixtures.len(), 1);
    assert_eq!(b.fixtures[0].name, "Deep One");
}
