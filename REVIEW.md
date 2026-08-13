# Code review — LIGHT v0.5

**Date:** 2026-08-13 (updated same day) · **Scope:** everything — both engines, UI, previz, app shell, protocol, importers.

## Method

Two passes. First, an author self-review during construction (its fixes are folded into the tables below). Then the full **independent multi-agent review**: 7 dimension-focused reviewers (Node engine, Rust core, protocol parity, UI, previz, live-show failure modes, security/docs) produced **77 raw findings**; every critical/major was handed to an adversarial verifier instructed to *refute* it by reading — and where possible executing — the actual code. **43 findings survived confirmation, 0 were refuted outright** (duplicates merged), several with execution-verified proofs (the NaN-poisoning chain and the async spawn crash were demonstrated by running code, not argued). 51 agents, ~3M tokens. A coverage critic then listed what the review *missed*; its findings are included below.

What is independently verified beyond review: the differential parity harness — both engines driven over the real protocol must emit byte-identical DMX on all 512 channels, now including GDTF-imported fixtures (WASM vs native interpreter) and MVR scene application.

## Fixed in this pass (confirmed → resolved)

### Show-stoppers

| Sev | Finding | Fix |
|---|---|---|
| **Critical** | **One malformed OSC packet permanently killed all effects.** `/light/bpm` lacked a finite check; NaN passed through `clamp` (NaN comparisons are false), poisoned the beat clock anchors, and `effBeat += NaN` is absorbing — no recovery without restart. Execution-verified. | Finite+range guards on every OSC numeric input (both engines, unified semantics); `clamp` is NaN-safe; the clock rejects non-finite BPM; effect-time self-heals. Regression tests in both suites. |
| **Critical** | **Any render throw stopped DMX** — the Node 40 Hz loop had no exception guard and the process no handler; a malformed `updateProject` (unvalidated) crashed the next tick. | Tick body wrapped (log-throttled, always reschedules — nodes hold their last frame through a bad tick); `sanitizeProject` repairs/rejects untrusted project shapes on load and update; process-level handlers log instead of dying; WASM render output length clamped. |
| **Critical** | **Flash looks could latch on stage** three separate ways: right/middle-click bypassed release; a held blinder survived if *other* clients stayed connected; column cues *cleared* flash-holding layers instead of leaving them. | Primary-button check in the grid; held flash releases on **any** client disconnect (a spurious release beats a latched blinder); cues now leave flash cells strictly untouched. All regression-tested. |
| **Critical** | **A corrupt project file was silently replaced by the default and the backup rotation then destroyed the last good copies.** | Load falls back through `.bak1–5`, restores the first good copy, and preserves the corrupt file aside — it is never silently replaced and never rotated over the backups. |
| **Critical** | **A hostname in the unicast field triggered blocking DNS inside the 40 Hz output loop** (Rust), stalling output. | Output destinations are IP literals only in both engines — no resolver on the hot path; invalid strings fall back to broadcast so the rig keeps receiving mid-edit. |

### Live-behaviour majors

| Finding | Fix |
|---|---|
| Releasing a pad mapped to the grand master **blacked out the stage** (note-off drove value actions to 0). | Notes drive continuous targets by velocity on press only; note-off is ignored for them. |
| Tap/resync snapped the *clock* but **effects never re-aligned** to the downbeat (effect time is integrated separately by design, for smooth speed changes). | Tap/resync now also land the effect phase on the nearest downbeat, both engines. |
| Double column press mid-fade **snapped the crossfade** (outgoing look discarded). | Retriggering the already-active look is a no-op. |
| Held keyboard keys machine-gunned cues/tap/blackout; browser shortcuts overlapped. | `repeat` and modifier keys ignored. |
| Up to 200 queued live commands **replayed as a stale burst** on WS reconnect. | Only edits (project updates, saves, imports) queue while offline; live commands are dropped. |
| `spawnPreviz` crash on async spawn error (execution-verified). | Error handler attached; failure surfaces as a toast. |
| **Rust WS server**: reader/writer shared one socket fd (frame-corruption risk with pinging clients), no dead-client detection, unbounded queues. | Rewritten: one thread owns each client socket (single writer), short read poll + write timeouts detect dead peers, queues bounded at 512 with stalled-client eviction. Node side bounds `bufferedAmount`. |
| OSC listener died permanently on bind failure/port change (Rust); malformed packets could panic the parse thread. | Bind is synchronous with retry on every config change; liveness tracked; parser bounds-checked (fuzz-shaped guards on strings, blobs, bundles). |
| Untrusted compiled profiles could underflow u16 maths in the interpreter; GDTF `Offset="0"` underflowed channel parsing. | All interpreter maths in f64 with clamped casts; parser guards zero/duplicate offsets. |
| Autosave did synchronous filesystem writes on the render thread (both engines). | Saves run off-thread (Node: async fs with a 10 s max-latency flush; Rust: worker thread). |
| OSC floods amplified into WS broadcasts from the render path. | Monitor broadcasts rate-limited (~25/s) in both engines. |
| macOS sleep/App Nap could stop the engine mid-show (coverage-critic find). | The engine holds a `caffeinate -dims` assertion for its lifetime on macOS. |
| Tauri shell: an engine-thread panic left a zombie window ("connected", DMX frozen). | The shell exits visibly if the engine thread dies — honest failure over a silent zombie. |
| `/light/column` 0/negative cleared every layer (Node); `/light/blackout` argument semantics diverged between engines. | Unified, guarded handling — identical in both engines, covered by the parity suite. |

## Accepted / scheduled (not fixed in this pass)

| Sev | Finding | Disposition |
|---|---|---|
| Major | `updateProject` is whole-project last-write-wins; concurrent edits clobber (incl. rapid keystrokes racing the echo). | Roadmap v0.6: operation-based edits or revision checks. Single-operator use unaffected. |
| Major | Look-fader drags and patch inputs send full-project updates per pointermove/keystroke. | Roadmap: batching/throttle layer in `mutate`. Local WS keeps this invisible today. |
| Major | GDTF/MVR imports parse synchronously on the Rust engine thread (output freezes for the parse duration, ~40 µs synthetic but unbounded for huge files). | Move imports to a worker in v0.6; parse cost is measured and bounded for realistic files. |
| Major | Rust strict integer deserialization can reject values Node accepts (e.g. `2.0` for an index) — command silently dropped. | Roadmap: tolerant number coercion layer; parity suite guards the common paths today. |
| Minor | Wrong-NIC output: broadcast/multicast egress the default route (Wi-Fi) on dual-homed Macs — the classic "worked at home, dead at the venue". | **Mitigation documented**: set the node's unicast IP per universe (unicast routes via the correct interface). Roadmap: per-universe interface binding. |
| Minor | Derby macro/motor hold the outgoing value through a crossfade then pop at fade end. | Cosmetic on banded hardware; revisit with GDTF wheel fades. |
| Minor | HashMap key order scrambles `looks`/`profiles` in saved JSON (noisy diffs); MIDI rescan can leak/double-deliver on replug; previz WebGL contexts accumulate on 2D/3D toggles; per-frame allocation churn in previz loops; stale `saved ✓`/blackout-from-snapshot edge cases; MIDI-learn arm leaks on UI reload; Rust may deliver a snapshot before the first project event; engine hot-restart in dev drops live look state. | Tracked; none affect show output. |
| Minor | README inaccuracies (stale test count, parity prerequisites, LAN-UI claim for the bundled app). | Corrected in this pass. |

## Coverage gaps the critic surfaced

Beyond wrong-NIC and sleep (both addressed above): no project schema versioning/migrations before format changes ship (roadmap, pre-v1); supply-chain pinning is Cargo.lock/package-lock only (no audit gate in CI — CI itself is still to be wired); no soak/chaos harness for the WS layer (the previz soak covers the render path only).

## Standing verification

`npm test` · `cargo test -p light-core` · `npm run typecheck` · `npm run test:parity` — all green after every fix above, parity byte-identical. Performance after hardening is recorded in [docs/benchmarks.md](docs/benchmarks.md).
