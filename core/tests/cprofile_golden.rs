//! Golden tests: every built-in profile expressed as compiled data must emit
//! byte-identical DMX to its legacy code implementation across the parameter
//! space — edges, band boundaries, and a large seeded sweep.

use light_core::cprofile::{compiled_builtins, render_compiled, CompiledProfile};
use light_core::profiles::{profile_of, ResolvedParams};
use light_core::types::MotorMode;

fn lcg(seed: &mut u64) -> f64 {
    *seed = seed
        .wrapping_mul(6364136223846793005)
        .wrapping_add(1442695040888963407);
    ((*seed >> 33) & 0x7fff_ffff) as f64 / 2147483648.0
}

const EDGES: [f64; 9] = [0.0, 0.005, 0.01, 0.011, 0.02, 0.021, 0.49, 0.5, 1.0];

fn gen_params(seed: &mut u64, case: usize) -> ResolvedParams {
    let pick = |seed: &mut u64, case: usize, salt: usize| -> f64 {
        // alternate between exact edge values and random ones
        if (case + salt) % 3 == 0 {
            EDGES[((lcg(seed) * EDGES.len() as f64) as usize).min(EDGES.len() - 1)]
        } else {
            lcg(seed)
        }
    };
    let motor_mode = match case % 3 {
        0 => MotorMode::Off,
        1 => MotorMode::Aim,
        _ => MotorMode::Rotate,
    };
    let macro_ = match case % 5 {
        0 => Some(lcg(seed) * 320.0 - 30.0), // exercises clamping
        1 => Some(88.0),
        _ => None,
    };
    ResolvedParams {
        dimmer: pick(seed, case, 0),
        r: pick(seed, case, 1),
        g: pick(seed, case, 2),
        b: pick(seed, case, 3),
        white: pick(seed, case, 4),
        ring_fx: pick(seed, case, 5),
        strobe: pick(seed, case, 6),
        motor_mode,
        motor_value: pick(seed, case, 7),
        macro_,
        pan: pick(seed, case, 8),
        tilt: pick(seed, case, 9),
        haze: pick(seed, case, 10),
        fan: pick(seed, case, 11),
    }
}

fn assert_profile_parity(cp: &CompiledProfile) {
    let legacy = profile_of(&cp.id).expect("legacy profile exists");
    assert_eq!(legacy.channels, cp.footprint, "{}: footprint", cp.id);
    assert_eq!(legacy.heads.len(), cp.heads.len(), "{}: head count", cp.id);

    let mut seed = 0x19e5_eed1_u64;
    for case in 0..800 {
        let params: Vec<ResolvedParams> =
            (0..cp.heads.len()).map(|_| gen_params(&mut seed, case)).collect();
        let refs: Vec<&ResolvedParams> = params.iter().collect();

        let mut legacy_buf = [0u8; 64];
        let mut compiled_buf = [0u8; 64];
        (legacy.render)(&refs, &mut legacy_buf, 0);
        render_compiled(cp, &refs, &mut compiled_buf, 0);

        if legacy_buf[..cp.footprint] != compiled_buf[..cp.footprint] {
            panic!(
                "{} case {}: legacy {:?} != compiled {:?}\nparams: {:?}",
                cp.id,
                case,
                &legacy_buf[..cp.footprint],
                &compiled_buf[..cp.footprint],
                params
            );
        }
    }
}

#[test]
fn all_builtins_byte_identical() {
    let compiled = compiled_builtins();
    assert_eq!(compiled.len(), 7, "all built-ins expressed as data");
    for cp in &compiled {
        assert_profile_parity(cp);
    }
}

#[test]
fn compiled_profiles_serde_roundtrip() {
    for cp in compiled_builtins() {
        let json = serde_json::to_string(&cp).unwrap();
        let back: CompiledProfile = serde_json::from_str(&json).unwrap();
        // render parity after a JSON round trip (import path uses this form)
        let mut seed = 42u64;
        for case in 0..50 {
            let params: Vec<ResolvedParams> =
                (0..cp.heads.len()).map(|_| gen_params(&mut seed, case)).collect();
            let refs: Vec<&ResolvedParams> = params.iter().collect();
            let mut a = [0u8; 64];
            let mut b = [0u8; 64];
            render_compiled(&cp, &refs, &mut a, 0);
            render_compiled(&back, &refs, &mut b, 0);
            assert_eq!(a, b, "{}: roundtrip parity", cp.id);
        }
    }
}
