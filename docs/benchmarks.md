# Performance benchmarks

Living record — a dated entry lands here with every milestone that touches a
hot path. Numbers are from the reproducible harnesses below unless noted.

**Reference machine:** Apple M2 Max, 64 GB RAM, macOS 26.1.
**Harnesses:** `cargo run --release -p light-core --bin light-bench` (engine
micro/meso benches) · `LIGHT_PREVIZ_DIAG=1 npm run previz` (frame diagnostics,
logged once per second) · `npm run test:parity` (cross-engine correctness,
not speed).

## Budgets

| Path | Budget | Why |
|---|---|---|
| Engine tick | 25 ms (40 Hz) | a missed tick is a visible stutter on stage |
| Previz frame | ≤ 8.3 ms | ProMotion 120 Hz; ≥ 60 fps mandatory |
| GDTF import | interactive (< 100 ms/file) | import-time only, never on the tick path |

## 2026-08-13 — previz beam-cone shafts + photometric fix

The native previz shipped with two rendering defects found during visual
acceptance: fixture spotlight lumens were ~14× below Bevy's photometric
exposure scale (invisible pools), and Bevy 0.16.1's volumetric light-shaft
term renders nothing on this Metal/macOS combination (ambient in-fog
scattering works; per-light shafts never draw — reproduced with the engine's
canonical example setup). Fixed with 8 M lm bars / 2.5 M lm derby cones plus
additive vertex-alpha cone meshes for shafts, energy-scaled by live haze.

| Metric | Result |
|---|---|
| Frame rate | ~121 fps avg (vsync-locked, 120 Hz cap) — unchanged vs pre-cone soak |
| Frame time | 8.32 ms avg / 8.04 ms spot |
| Added scene cost | 20 beam cones (28-segment, additive, unlit) — no measurable delta |

Verdict: beam cones are free at this rig size; budget unchanged.

## 2026-08-13 — post-review hardening

43 confirmed review findings fixed (NaN guards, loop exception guard, project
sanitisation, WS server rewrite with bounded queues, IP-literal-only output,
overflow guards throughout). Tick-path cost after all guards:

| Bench | Result | Notes |
|---|---|---|
| Engine tick (default rig, 3 active looks + fx) | **8.23 µs** | within noise of pre-hardening (7.85–9.79 µs range); guards are free at rig scale |

## 2026-08-13 — v0.5: MVR import

| Bench | Result | Notes |
|---|---|---|
| MVR parse, native (2-fixture scene, embedded GDTF) | 41.7 µs | import-time only |
| MVR parse via WASM (Node) | 64.1 µs | |
| Engine tick after v0.5 changes | 9.79 µs | was 7.85 µs — profile-resolution now checks imported profiles too; still 0.04 % of budget |

Verdict: no meaningful movement; the tick path remains ~2 500× under budget.

## 2026-08-13 — v0.4 C1/C2: compiled-profile interpreter + GDTF parser

`light-bench`, release profile:

| Bench | Result | Notes |
|---|---|---|
| Engine tick, default rig, 3 active looks + effects | **7.85 µs** | 0.03 % of the 25 ms budget — ≈ 3 000× headroom; scaling to hundreds of fixtures is compute-trivial |
| Profile render, legacy code — KAM 20ch / Derby 4ch / Mover 10ch | 17 / 72 / 8 ns | per fixture per tick |
| Profile render, compiled interpreter — same profiles | 69 / 95 / 30 ns | 2–4× the hand-written code, still noise: 100 imported fixtures ≈ 10 µs/tick |
| GDTF parse (synthetic 11-ch spot) | 28.8 µs | import-time only |

WASM bridge (same interpreter compiled for the Node engine; Node 25):

| Bench | Result | Notes |
|---|---|---|
| Imported-profile render via WASM | 243 ns | ~3–8× native Rust, incl. param marshalling — 100 imported fixtures ≈ 24 µs/tick |
| GDTF parse via WASM | 32.8 µs | vs 28.8 µs native |

Verdict: the data-driven interpreter costs nothing measurable at rig scale,
in either engine. No tick-path regression from v0.4.

## 2026-08-13 — v0.3 B1: native previz (Bevy 0.16.1, release)

30-minute soak, default rig, random column + haze changes every 8 s
(`scratchpad/soak.sh` methodology: engine + previz + cycler):

| Metric | Result |
|---|---|
| Stability | alive after 30 min, no reconnects needed |
| Memory | 230 MB flat (no growth across hundreds of look changes) |
| Frame rate | **~121 fps avg**, vsync-locked at the 120 Hz display cap |
| Frame time | ~8.3 ms avg — equals the 120 Hz vsync interval, so true render cost is at or below it |

Scene load: ~20 volumetric shadow-casting spotlights (2 derby fans × 6 + 8
bar pars), fog volume, bloom, glossy floor. Meets the ≤ 8 ms-class budget at
double the required refresh rate.

## 2026-08-13 — v0.1/0.2: engines

| Metric | Result | Source |
|---|---|---|
| Engine refresh | 40 Hz sustained, both engines | stats in every snapshot (Output tab) |
| Tick jitter | ≈ 1 ms steady-state (5 ms max during app launch churn) | engine stats window |
| Art-Net output | 2 universes × 40 Hz continuous, verified frames | smoke suites (loopback byte checks) |
| DMX parity Node ↔ Rust | byte-identical, 10 checkpoints | `npm run test:parity` (~12 s wall) |
| App bundle | 7.9 MB `LIGHT.app` | Tauri release build, LTO |

## How to add an entry

1. Extend `core/src/bin/light-bench.rs` (or the soak script) to cover the new
   path — benches live in code, not in one-off shell history.
2. Run on the reference machine, release profile, mains power.
3. Add a dated section at the top with the numbers, the load description, and
   a one-line verdict against the budget table.
