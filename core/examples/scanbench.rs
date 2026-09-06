//! Scratch: how long a MIDI output port scan takes, because ApcOut does one on
//! the DMX tick thread. Not part of the product.
fn main() {
    let mut worst = 0f64;
    let mut total = 0f64;
    let n = 200;
    let mut all: Vec<f64> = Vec::new();
    for _ in 0..n {
        let t = std::time::Instant::now();
        if let Ok(out) = midir::MidiOutput::new("LIGHT") {
            let ports = out.ports();
            for p in &ports {
                let _ = out.port_name(p);
            }
        }
        let ms = t.elapsed().as_secs_f64() * 1000.0;
        all.push(ms);
        worst = worst.max(ms);
        total += ms;
    }
    println!("scan: mean {:.3} ms, worst {:.3} ms over {n}", total / n as f64, worst);
    println!("first {:.3} ms; over 1 ms: {} of {n}", all[0], all.iter().filter(|&&m| m > 1.0).count());
    let mut sorted = all.clone();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    println!("p50 {:.3}  p99 {:.3}  max {:.3}", sorted[n / 2], sorted[n * 99 / 100], sorted[n - 1]);
}
