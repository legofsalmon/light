//! One-off timing probe for build_geometry — run with:
//!   cargo test -p light-core --test geobench -- --ignored --nocapture
use std::time::Instant;

#[test]
#[ignore]
fn geometry_build_cost() {
    let demo: light_core::types::Project =
        serde_json::from_str(include_str!("data/demo_project.json")).unwrap();
    let mut big = demo.clone();
    big.fixtures = (0..100)
        .map(|i| light_core::types::Fixture {
            id: format!("fx{i}"),
            name: format!("F{i}"),
            profile_id: "kam-partybar-wfs-20ch".into(),
            universe_id: "u1".into(),
            address: 1 + (i % 24) * 20,
            pos: light_core::types::Vec3 { x: (i % 10) as f64 - 5.0, y: 3.0, z: (i / 10) as f64 - 2.0 },
            rot_y: (i % 7) as f64 * 0.3,
            rot_x: Some(0.1),
            rot_z: Some(-0.05),
            pan: None,
            tilt: None,
            parent_id: None,
        })
        .collect();
    for (name, p) in [("demo (13 fixtures)", &demo), ("synthetic (100 bars, 400 heads)", &big)] {
        for _ in 0..200 {
            let _ = light_core::geometry::build_geometry(p);
        }
        let n = 2000;
        let t0 = Instant::now();
        for _ in 0..n {
            let _ = light_core::geometry::build_geometry(p);
        }
        let per = t0.elapsed().as_nanos() as f64 / n as f64 / 1000.0;
        println!("rust build_geometry {name}: {per:.2} µs/build");
    }
}
