//! Reproducible micro/meso benchmarks for the hot paths. Run with:
//!
//!     cargo run --release -p light-core --bin light-bench
//!
//! Results are recorded per milestone in docs/benchmarks.md.

use std::time::Instant;

use light_core::cprofile::{compiled_builtins, render_compiled};
use light_core::defaults::default_project;
use light_core::gdtf::parse_gdtf;
use light_core::profiles::{profile_of, ResolvedParams};
use light_core::renderer::Renderer;
use light_core::state::EngineState;

fn bench<F: FnMut()>(name: &str, iters: u32, mut f: F) {
    // warmup
    for _ in 0..iters / 10 {
        f();
    }
    let start = Instant::now();
    for _ in 0..iters {
        f();
    }
    let total = start.elapsed();
    let per = total.as_secs_f64() / iters as f64;
    let unit = if per < 1e-6 {
        format!("{:.0} ns", per * 1e9)
    } else if per < 1e-3 {
        format!("{:.2} µs", per * 1e6)
    } else {
        format!("{:.3} ms", per * 1e3)
    };
    println!("{name:<52} {unit:>12} /iter   ({iters} iters)");
}

fn main() {
    println!("light-bench — release profile\n");

    let params = ResolvedParams {
        dimmer: 0.8,
        r: 1.0,
        g: 0.3,
        b: 0.1,
        strobe: 0.4,
        motor_value: 0.5,
        pan: 0.3,
        tilt: 0.7,
        ..Default::default()
    };

    // profile render: legacy code vs compiled interpreter
    let compiled = compiled_builtins();
    for id in ["kam-partybar-wfs-20ch", "varytec-derby-st-4ch", "generic-mover-10ch"] {
        let legacy = profile_of(id).unwrap();
        let cp = compiled.iter().find(|c| c.id == id).unwrap();
        let heads: Vec<&ResolvedParams> = (0..legacy.heads.len()).map(|_| &params).collect();
        let mut buf = [0u8; 64];
        bench(&format!("render legacy    {id}"), 1_000_000, || {
            (legacy.render)(&heads, &mut buf, 0);
        });
        bench(&format!("render compiled  {id}"), 1_000_000, || {
            render_compiled(cp, &heads, &mut buf, 0);
        });
    }

    // full engine tick on the default rig (5 fixtures, 4 layers, look active)
    let mut st = EngineState::new(default_project(), 0.0);
    let mut r = Renderer::new();
    r.tick(&mut st, 0.0);
    st.trigger("layer-wash", 6, 0.0); // rainbow drift: hue effect across 8 heads
    st.trigger("layer-fx", 2, 0.0); // par chase
    st.trigger("layer-derby", 1, 0.0);
    let mut t = 1000.0;
    bench("engine tick (default rig, 3 active looks + fx)", 100_000, || {
        t += 25.0;
        let _ = r.tick(&mut st, t);
    });

    // GDTF parse (synthetic archive from the test suite)
    let gdtf = build_synthetic_gdtf();
    bench("gdtf parse (synthetic 11ch spot)", 2_000, || {
        let _ = parse_gdtf(&gdtf).unwrap();
    });

    println!("\ntick budget @40 Hz = 25 ms; snapshot cadence 20 fps");
}

fn build_synthetic_gdtf() -> Vec<u8> {
    use std::io::Write;
    let xml = include_str!("../../tests/data/synthetic.gdtf.xml");
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
