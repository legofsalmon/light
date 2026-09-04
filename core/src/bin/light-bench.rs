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
    bench_mvr_import();

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
    st.trigger("layer-wash", 6, 0.0, light_core::state::LOCAL_CLIENT); // rainbow drift: hue effect across 8 heads
    st.trigger("layer-fx", 2, 0.0, light_core::state::LOCAL_CLIENT); // par chase
    st.trigger("layer-derby", 1, 0.0, light_core::state::LOCAL_CLIENT);
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

    // MVR parse (synthetic 2-fixture scene with embedded GDTF)
    let mvr = include_bytes!("../../tests/data/synthetic.mvr");
    bench("mvr parse (synthetic 2-fixture scene)", 2_000, || {
        let _ = light_core::mvr::parse_mvr(mvr).unwrap();
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

/// How long does importing a real MVR block the thread that drives DMX?
///
/// The tick budget is 25 ms. This exists because REVIEW-v1.2.2 lists
/// "synchronous GDTF/MVR import on the engine thread" as accepted-unfixed
/// against a ROADMAP that says nothing heavy may touch the tick path, and
/// nobody had ever put a number on it.
///
/// Point LIGHT_BENCH_MVR at a .mvr to measure a real one; otherwise it uses the
/// synthetic test fixture, which is far smaller and will flatter the result.
pub fn bench_mvr_import() {
    let (label, bytes) = match std::env::var("LIGHT_BENCH_MVR") {
        Ok(p) => match std::fs::read(&p) {
            Ok(b) => (p, b),
            Err(e) => {
                println!("mvr import   : cannot read {p}: {e}");
                return;
            }
        },
        Err(_) => (
            "synthetic.mvr (set LIGHT_BENCH_MVR for a real one)".to_string(),
            include_bytes!("../../tests/data/synthetic.mvr").to_vec(),
        ),
    };

    let t = std::time::Instant::now();
    let parsed = light_core::mvr::parse_mvr(&bytes);
    let ms = t.elapsed().as_secs_f64() * 1000.0;
    match parsed {
        Ok(b) => println!(
            "mvr import   : {ms:.1} ms for {} KB — {} fixtures, {} groups  [{}]\n               \
             tick budget is 25 ms, so that is {:.0} tick(s) of DMX not sent",
            bytes.len() / 1024,
            b.fixtures.len(),
            b.groups.len(),
            label,
            (ms / 25.0).ceil()
        ),
        Err(e) => println!("mvr import   : failed after {ms:.1} ms — {e}"),
    }
}
