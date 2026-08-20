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
  (`engine/renderer.ts:170`, `core/src/renderer.rs:309`) — the single seam.
- The Rust `Effect` struct has NO serde defaults (`core/src/types.rs:214`), so
  any new Effect field without a tolerant deserializer bricks old saves.
- Effect parity coverage is zero at the byte level today (effBeat boot skew +
  settle() never converges on motion): a `_pinClock` test seam must land first.

Agreed build order (each step shippable, parity-green):
1. Groundwork: tolerant de_effects + sanitize effect repair
2. P5 _pinClock seam + golden effect baseline
3. P4 phase-continuous rates (fixes the live rate-snap bug)
4. A2 FX pool (copy-on-apply presets, retargeting, inform-not-forbid targets)
5. B2 geometry builder (HeadCtx at the seam, zero behaviour change)
6. A1 spatial fan (distribute x/y/z/radial/shuffle, fold mirror/centre, parts,
   segments, seed; value-sign mirror for pan)
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
