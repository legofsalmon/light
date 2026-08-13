//! WASM bridge: exposes the compiled-profile interpreter and the GDTF parser
//! to the Node engine, so profile behaviour has exactly one implementation.
//!
//! Param marshalling: per head, 15 f64 slots in this order —
//! [dimmer, r, g, b, white, ringFx, strobe, motorMode(0=off/1=aim/2=rotate),
//!  motorValue, hasMacro(0/1), macroValue, pan, tilt, haze, fan]

use std::cell::RefCell;
use std::collections::HashMap;

use wasm_bindgen::prelude::*;

use light_core::cprofile::{render_compiled, CompiledProfile};
use light_core::profiles::ResolvedParams;
use light_core::types::MotorMode;

pub const PARAMS_PER_HEAD: usize = 15;

thread_local! {
    static REGISTRY: RefCell<HashMap<u32, CompiledProfile>> = RefCell::new(HashMap::new());
    static NEXT_ID: RefCell<u32> = const { RefCell::new(1) };
}

/// Parse a .gdtf archive; returns a JSON array of compiled profiles.
/// Throws (JS-side) with a message on failure.
#[wasm_bindgen]
pub fn parse_gdtf(bytes: &[u8]) -> Result<String, JsError> {
    let profiles = light_core::gdtf::parse_gdtf(bytes).map_err(|e| JsError::new(&e))?;
    serde_json::to_string(&profiles).map_err(|e| JsError::new(&e.to_string()))
}

/// Parse a .mvr archive; returns the import bundle as JSON
/// ({profiles, fixtures, groups, warnings}).
#[wasm_bindgen]
pub fn parse_mvr(bytes: &[u8]) -> Result<String, JsError> {
    let bundle = light_core::mvr::parse_mvr(bytes).map_err(|e| JsError::new(&e))?;
    serde_json::to_string(&bundle).map_err(|e| JsError::new(&e.to_string()))
}

/// Register a compiled profile (JSON) for rendering; returns a handle.
#[wasm_bindgen]
pub fn register_profile(json: &str) -> Result<u32, JsError> {
    let profile: CompiledProfile =
        serde_json::from_str(json).map_err(|e| JsError::new(&e.to_string()))?;
    let id = NEXT_ID.with(|n| {
        let mut n = n.borrow_mut();
        let id = *n;
        *n += 1;
        id
    });
    REGISTRY.with(|r| r.borrow_mut().insert(id, profile));
    Ok(id)
}

#[wasm_bindgen]
pub fn unregister_profile(handle: u32) {
    REGISTRY.with(|r| r.borrow_mut().remove(&handle));
}

fn unflatten(flat: &[f64]) -> Vec<ResolvedParams> {
    flat.chunks_exact(PARAMS_PER_HEAD)
        .map(|c| ResolvedParams {
            dimmer: c[0],
            r: c[1],
            g: c[2],
            b: c[3],
            white: c[4],
            ring_fx: c[5],
            strobe: c[6],
            motor_mode: match c[7] as i32 {
                1 => MotorMode::Aim,
                2 => MotorMode::Rotate,
                _ => MotorMode::Off,
            },
            motor_value: c[8],
            macro_: if c[9] > 0.5 { Some(c[10]) } else { None },
            pan: c[11],
            tilt: c[12],
            haze: c[13],
            fan: c[14],
        })
        .collect()
}

/// Render one fixture's heads through a registered profile.
/// `params` is heads × 15 f64 (layout above). Returns the footprint bytes.
#[wasm_bindgen]
pub fn render(handle: u32, params: &[f64]) -> Result<Vec<u8>, JsError> {
    REGISTRY.with(|r| {
        let reg = r.borrow();
        let profile = reg.get(&handle).ok_or_else(|| JsError::new("unknown profile handle"))?;
        let heads = unflatten(params);
        let refs: Vec<&ResolvedParams> = heads.iter().collect();
        let mut buf = vec![0u8; profile.footprint];
        render_compiled(profile, &refs, &mut buf, 0);
        Ok(buf)
    })
}
