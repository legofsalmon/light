# Parked work

Items from the v1.2.2 full review that are deliberately **not** done yet, with
enough detail to pick up cold. Everything here was confirmed against the code by
an adversarial verifier — these are real, not speculative.

Full review: <https://claude.ai/code/artifact/a877b38b-6309-46b8-ac5f-bfbb9963bd4a>

Done so far on `show-safety-v1.2.3`: Stages 1–3 (show safety, protocol
correctness + scale, previz correctness) and the low-severity sweep. See
`git log` from `4ccd150` onward.

**Only two items remain parked**: authentication (§2 below) and the moved-port
Tauri capability (§3). Everything else in this file has been done.

---

## 1. Per-client snapshot content — DONE (`23d2a77`)

The snapshot is now identical for every client (serialised once, broadcast
once), and the two per-client payloads became targeted events: raw DMX behind a
`watchDmx` subscription the Output tab sends, and the audition head set to
whoever requested it. Measured on the arena show: **556 → 385 KB/s** per client
not showing the Output tab, 408 KB/s for the one that is.

## 2. Authentication on the control surface  *(review severity: high)*

**Why parked:** it is a genuine feature — token generation, injection into the
served UI, a tablet pairing flow, a read-only role — not a patch. It also
changes how the tablet connects, so it wants testing on the real venue setup
rather than shipping alongside safety fixes.

**What is true today:** both engines bind `0.0.0.0` (`core/src/server.rs:120`
and the v6 wildcard at `:142`; `engine/server.ts:85`) and accept every WS
upgrade with no token, no `Origin` check, and no per-client privilege
(`server.rs:192-207`, `engine/server.ts:55-73`). Every connection may send
`allStop`, `setBlackout`, `updateProject`, `openProject`, `importMvr`, `midi`,
`learn`. `handle_http` serves the full console UI to any comer. Anyone on the
venue WiFi who types the Mac's IP into a phone gets a working ALL STOP, and
nothing logs who pressed it.

The OSC listener is the same class: `osc.rs:147` binds `0.0.0.0` and
`/light/blackout` is honoured from any UDP sender (`engine.rs:777-783`) — a
stray `0.0` *unsets* an armed blackout.

**Planned shape:**
- Session token generated at engine start; required as a WS query parameter.
  The Tauri window and the engine-served UI get it injected; the tablet pairs
  via a QR / short code screen.
- `Origin` allowlist for the HTTP+WS upgrade.
- A read-only role for unpaired clients (they can watch, not command).
- Gate `/light/*` OSC behind an opt-in toggle, default off.

**Trade-off to decide first:** this must not make a laptop-only show harder to
start. Suggested default — loopback connections are trusted automatically, so
the app and a local browser need no pairing, and only genuine LAN clients do.

---

## 3. Moved-port Tauri capability *(parked — needs a packaged build to verify)*

When port 9900 is taken the shell navigates the window to
`http://127.0.0.1:<alt>/` (`src-tauri/src/main.rs:216`) so the port travels in
the origin. That is a non-app origin, and `src-tauri/gen/schemas/capabilities.json`
is `{}` — no capability grants the window IPC there — so `__TAURI__` is absent,
`shareAvailable()` is false, and the whole GDTF Share panel plus the local
fixture library silently disappear. The port dialog meanwhile promises "the
window will work normally".

**Why still parked:** verifying either the failure or a fix needs a full
`tauri build` plus a contrived port conflict, and a wrong capability file breaks
IPC for *every* launch, not just the moved-port one. That is a bad trade to make
blind for a feature that is hidden (not broken) on a rare path.

**Two candidate fixes, in preference order:**
1. Do not navigate at all. `wsUrl()` still honours a `window.__LIGHT_PORT__`
   escape hatch (`ui/src/store.ts:481`), so delivering the port via Tauri 2's
   *initialization script* API keeps the window on `tauri://` and Share keeps
   working. Note the code comment at `main.rs:200` — a previous attempt used
   `eval()`, which fails because a variable set during setup is discarded when
   the page loads its own context; an initialization script is the API that
   runs before page scripts on every navigation, and is a different thing.
   Setting one means building the window in Rust rather than from
   `tauri.conf.json`.
2. Add `src-tauri/capabilities/*.json` granting the main window IPC on
   `http://127.0.0.1:*`, and keep the navigation.

Either way: test by holding 9900 with a second engine, launching the app, and
confirming the Share panel is present.

## 4. Low-severity findings — DONE (`37c00cd`, `91df1d5`)

The UI sweep (delete-look blast radius, deck-step wrapping in all four places,
touch `bump`, stranded `parentId`, along-the-bar multi-edit, focused-edit guards,
`var(--bad)`, column tooltips, sticky grid headers) and the engine/shell sweep
(bounded import queue, connection cap, mtime-keyed project-name and Share
catalogue caches, async Tauri commands, atomic catalogue write, Keychain write
order, APC LED 81, offline-queue disconnect race).

Deliberately not done — Rust tick-path hygiene, measured safe today (the tick is
7.9–9.8 µs against a 25 ms budget) and worth doing only before per-head work
grows: per-tick `Layer` clones and String-keyed head maps (`renderer.rs:260`),
the Broadcaster's per-client string copy (`server.rs:56`, `Arc<str>` would fix
it), the native previz's per-frame snapshot clone (`previz/src/update.rs:90`),
and `structuredClone`-ing the whole project twice per UI edit (`store.ts:250`).

## 5. Stage 3 — done

Every confirmed previz-correctness defect is fixed (commits `d915a50`,
`67c967f`, `a70641f`):

- web: stale occluders on structure moves, WebGL context churn + no
  context-lost handler, circle-instead-of-rectangle 2D hit-test, snap/measure
  toggles absent in the mode they act on, fitBeam cutting against the previous
  frame's pan;
- native: club-scale beam reach and camera clamps on an arena plot, mover cones
  frozen at rest-pose length while aiming, rebuild signature ignoring prop
  size/base-Y/beam angle, one bad profile blanking the whole scene, invisible
  disconnect;
- and zoom now reaches the previz (`HeadSnap.zm`), so the parameter whose point
  is beam geometry is finally visible in the beam view.

Low-severity previz items deliberately left (they are polish, not correctness):
no selection/hover in the 3D view, mover bodies that do not articulate (only the
beam moves), an invented 2–14 Hz strobe band rather than the profile's, frame-
rate-dependent intensity smoothing, a camera key shared between the live and
audition panes, the native previz's per-frame snapshot clone, its shadow budget
spent in patch order rather than by relevance, its sRGB/linear inconsistency
between pools and shafts, and no fixture labels or selection sync.

## 6. The motion engine (LX-operator feedback — investigated, designed, not yet built)

Full investigation: <https://claude.ai/code/artifact/3aa44b37-811d-49b0-a630-940b18aab155>
("The Motion Engine"). 12 agents: research on MA3/Resolume/consoles/modulation
systems, code-mapping of LIGHT's seams, three design tracks, one judge.

Verified facts that anchor it:
- The Spiider GDTF carries real positions for all 19 pixels in its Geometry
  tree; the CLF Nero (84-pixel strobe plate) has all positions zeroed. So pixel
  layouts are parsed-from-file when authored, parametric (Strip/Grid/Ring) per
  TYPE when not — layout on the profile means "every strobe is the same" by
  construction (`core/src/gdtf.rs` reads only the Geometry NAME today, ~line
  369, and fabricates evenly-spaced offsets ~line 399).
- Both renderers call applyEffects at exactly one line each
  (`engine/renderer.ts:218`, `core/src/renderer.rs:374`) — the single seam.
- The Rust `Effect` struct has NO serde defaults (`core/src/types.rs:214`), so
  any new Effect field without a tolerant deserializer bricks old saves.
- Effect parity coverage is zero at the byte level today (effBeat boot skew +
  settle() never converges on motion): a `_pinClock` test seam must land first.

Agreed build order (each step shippable, parity-green):
1. Groundwork: tolerant de_effects + sanitize effect repair — DONE (`c2575c6`)
2. P5 _pinClock seam + golden effect baseline — DONE (`ed47ac1`)
3. P4 phase-continuous rates (fixes the live rate-snap bug) — DONE. Per-effect
   `corr` map beside cueAnchors in each renderer, keyed (layer, look, part,
   effect); `phase = beat/rate + corr`, where `corr += beat*(1/oldRate -
   1/newRate)` the tick a rate changes. Exactly 0.0 for untouched effects, so
   golden bytes + all prior parity are byte-identical. applyEffects gained a
   `phaseCorr[]` param (both twins). Proven by 6 new parity assertions incl. two
   before/after continuity checks (frame does NOT move when only rate changes)
   and correction accumulation across successive edits.
4. A2 FX pool (copy-on-apply presets, retargeting, inform-not-forbid targets) —
   DONE. Three commits: (a) engine slice — per-effect `bypass` + wet/dry `mix`
   fields, byte-identical at defaults, apply_mix/applyMix twins, tolerant
   deserialize defaults (`5537a3e`); (b) `project.fxPool` typed passthrough,
   tolerant `de_fx_pool`/sanitize, factored `repair_effect`/`repairEffect`,
   round-trip parity (`4965201`); (c) UI — park toggle + mix fader +
   inform-not-forbid target optgroups on the effect row (`9f5468e`), and the
   copy-on-apply pool: ☆ save, "apply from pool" copy-in, rename/delete manager
   (`c81ca81`). Browser-verified against a scratch outputs-off engine.
5. B2 geometry builder (HeadCtx at the seam, zero behaviour change) — DONE.
   Four commits: (a) groundwork — fixture pos repaired per-COMPONENT in TS
   sanitize, tolerant de_vec3/de_rot_y/de_opt_finite in Rust (`fdb7682`);
   (b) the twins shared/geometry.ts + core/src/geometry.rs — canonical
   world = pos + Ry·Rx·Rz·(offset,0,0), quantized 1e-6 m via floor(v·1e6+0.5)
   in BOTH languages, gen-keyed cache per renderer (the first), one new
   applyEffects arg `g: &HeadGeom` (unused until A1; goldens gate), 17-head
   Python-generated golden vectors asserted f64-exact in both suites,
   rebuild cost 1.4–38 µs in docs/benchmarks.md (`701abda`); (c) Previz2D
   head dots/bar line/rotate gesture moved to the canonical yaw (`9ed68b3`);
   (d) adversarial-review fixes — serde_json float_roundtrip (1-ulp V8 parse
   divergence, bit-pinned test) and the structure layer (truss rect, 
   hitsPropFootprint, offsetOnParent/posFromOffset) completing the canonical
   migration, with sign-discriminating 30° tests (`2bd0b99`).
   NOTE for A1: HeadGeom carries {x,y,z,along,row,col}; row/col are single-row
   (0, headIdx) until B1 parses real pixel grids.
6. A1 spatial fan (distribute x/y/z/radial/shuffle, fold mirror/centre, parts,
   segments, seed; value-sign mirror for pan) — DONE. Three commits:
   (a) engine (`c61380f`) — Effect gains distribute/fold/reverse/parts/buddy/
   seed (tolerant: unknown values degrade to defaults, never drop the effect);
   fan pipeline basis(+reverse)→buddy→fold→parts→×spread in the effects twins;
   per-group extents (min/max/centroid/maxR) gen-cached beside geometry with
   Python-generated extents goldens; the all-defaults path runs the pre-A1
   expression VERBATIM; pan value-sign mirror on the mirrored wing; 12 twin
   unit tests with identical f64 constants + a pinned parity matrix.
   (b) UI (`69c17ac`) — the fan row: seg [idx X Y Z ◎ ⤨], ⟷/◇/⇄ toggles,
   parts/buddy, shuffle re-roll. (c) adversarial-review fixes (`0ecd499`) —
   chase compresses its fan to (n−1)/n so spatial chases deal n distinct
   slots; mirrored uses >=0.5 so even buddy grids split into whole wings;
   TS skips dangling-group parts before rate-corr like Rust; y/z axes now
   tested (transposition-proof diagonal rig + live raised/pulled-bar parity);
   broken-extents-proof vacuousness guard; pool canon covers the fan fields;
   parts/buddy inputs commit on blur.
   Semantics note: spatial bases are INCLUSIVE (t ∈ [0,1]; spread 1 = one
   wavelength across the rig, ends in phase) except under chase; index stays
   exclusive j/n as ever.
7. B1 GDTF geometry parser + per-profile layout editor + offsetY
8. B3 auto-groups slice 1 (per-type, per-truss ordered along the bar)
9. P1 soft overrides (SoftAddr layer, engine-side commit, Store/Discard)
10. P3 Named Controls (the macro replacement — typed faders, per-link ranges)
11. P2 modulators (LFO slice, then ADSR slice)
12. B4 pixel-map canvas stays deferred (projection, not canvas)

Rejected: A3 (superseded by P1+P4), any macro language, live-linked pool
presets, k-means auto-grouping, a second RNG.

## 7. Stages 4–5 (upcoming)

Stage 4 (previz quality: bloom/tonemapping, camera bookmarks, soft-falloff beam
shader, quality tiers, Bevy 0.19, DLSS on PC / MetalFX on macOS) and Stage 5
(features: audio-reactivity, Art-Net HTP merge, MVR geometry, Link-clock
timelines) are described in the review artifact.
