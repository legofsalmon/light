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

## 3b. Two checks the UI sweep could not make here *(needs the packaged app / the APC)*

Both are shipped as source-verified, not observation-verified. Neither is
speculative — the mechanism was read in the dependency sources — but both should
be confirmed the next time the hardware and a build are in front of you.

1. **HTML5 drag-and-drop in the packaged app.** `"dragDropEnabled": false` was
   added to `tauri.conf.json` because Tauri's default (`true`) installs an OS
   drag handler that returns `true` without falling through to `super`, so
   WKWebView never delivers `dragenter`/`dragover`/`drop` to the page — which
   would make the whole look-library drag a silent no-op in the `.app` while it
   works perfectly at `:5173`. Read in `tauri-utils-2.9.3/src/config.rs:1946`
   and `wry-0.55.1/src/wkwebview/drag_drop.rs:44,89`; the config parses (the
   struct is `deny_unknown_fields`, so a wrong key fails the build). **Check:**
   build the app, drag a library row onto a pad. See `docs/development.md`.
2. **The stale pad's LED on the APC40.** A pad in the live column that no longer
   holds the playing look keeps reporting the STAGE: lit bright in the colour of
   whatever is actually playing. Dim would say "idle" on a layer that is lighting
   the rig, and a dedicated "stale" colour is not available — a fixed white index
   collides with any white look's own bright state, which
   `a_live_column_holding_a_different_look_still_reports_the_stage` in
   `core/src/apc.rs` pins. **Check:** fire a pad, drop a different library look
   onto it, confirm the pad stays lit in the playing look's colour while the rig
   stays lit. If a distinct stale signal is ever wanted it needs a *blink*, which
   means the mk2's Launchpad-style behaviour channels — velocity 2 already blinks
   the single-colour scene LEDs (note 81, blackout), but the RGB pads' behaviour
   channels are unverified on this hardware and the LED map would have to carry a
   channel through `core/src/apc.rs` (it currently sends channel 0 only).

## 3c. APC40 mk2 LED rings for the control row *(deliberately not done)*

The eight DEVICE CONTROL knobs now drive the eight Named Controls
(`apc40Mk2Mappings`). Lighting their LED rings from LIGHT is the obvious next
step and is **not** implemented, because the protocol says it does not work in
the mode the app uses.

From Akai's *APC40 Mk2 Communications Protocol v1.2* (verified against the PDF,
not from memory):

- Knob values are CC `0x10`–`0x17`; ring TYPE is CC `0x18`–`0x1F`, with
  `0 = off, 1 = Single, 2 = Volume Style, 3 = Pan Style`. "The LED rings will
  display its controller value with the LEDs based on the LED Ring Types."
- Notes for **Generic Mode (Mode 0)** — the mode the unit boots into and the one
  LIGHT drives: "LED rings are all set to SINGLE style." The line that promises
  host control, "LED Rings around the knobs are controlled by the APC40 but can
  be updated by the Host", sits under **Ableton Live Mode (Mode 1)** and
  **Alternate Ableton Live Mode (Mode 2)**.
- Generic mode also banks the knobs: "[TRACK SELECTION] buttons … dictate which
  one of nine banks the DEVICE CONTROL knobs … belong to. These knobs and
  switches will output on a different MIDI channel based on the current Track
  Selection (track 1 = MIDI channel 0, track 8 = MIDI channel 7, MASTER = MIDI
  channel 8)." The preset works around this by binding all nine banks to the
  same eight controls.

So a ring in generic mode follows the *knob's physical position*, which is not
the same as the control's value: move a control from the screen, or have ALL STOP
clear the rides, and the ring still shows where the knob is sitting. Fixing that
properly means putting the unit into an Ableton Live mode by SysEx, which changes
the behaviour of every other control on the surface (all buttons become
momentary, all LEDs host-driven) and would invalidate the pad mapping and LED
feedback that work today.

**If it is ever wanted:** try sending ring type `2` (Volume Style) on CC `0x18+n`
and the value on CC `0x10+n` while still in generic mode — the device may honour
it — and if it does, the LED map in `core/src/apc.rs` has to carry a MIDI channel
and a CC/note distinction (it is `HashMap<u8, u8>` of note→velocity today, sent
on channel 0 only), with `ui/src/apcFeedback.ts` kept in lockstep. Needs the
hardware in front of you; nothing about it can be verified from here.

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

**Correction (22 Aug):** that last line is true of the WEB view only. `zm` is
not a field of `HeadLite` (`previz/src/protocol.rs`), nothing in `previz/src`
reads it, and the native cone's half-angle is baked once at rebuild from
`prof.beam_deg` (`scene.rs`), as are the SpotLight's inner/outer angles. So in
the window the docs point people at to judge beam geometry, zoom is invisible
— in the shaft and in the floor pool alike. Landing it there is a protocol
change, not a renderer one.

Low-severity previz items deliberately left (they are polish, not correctness):
no selection/hover in the 3D view, mover bodies that do not articulate (only the
beam moves), an invented 2–14 Hz strobe band rather than the profile's, frame-
rate-dependent intensity smoothing, a camera key shared between the live and
audition panes, the native previz's per-frame snapshot clone, its shadow budget
spent in patch order rather than by relevance, its sRGB/linear inconsistency
between pools and shafts, and no fixture labels or selection sync.

**Exposure asymmetry, since the browser view gained eye adaptation.** The web
previz now meters the light in the room each frame and moves
`toneMappingExposure` with it (`ui/src/components/Previz3D.tsx`, `auto exp` in
the previz bar). The native window does not: its camera is
`Tonemapping::TonyMcMapface` + `Bloom::default()` at a fixed Bevy exposure
(`previz/src/camera.rs:29`). It is a physically-lit renderer rather than a stack
of additive cones, so it does not have the failure that forced the web change —
but the two views now disagree about how bright a big look looks, and the docs
send people to the native one to judge exactly that. Matching them belongs with
the Stage 4 previz-quality work rather than as a patch: Bevy has an `Exposure`
component, and the metering signal (per-frame emitted luminance) is already
computed in the web twin and could be derived the same way from the snapshot.
Calibration constant and reasoning are in the comment above `ADAPT_KEY`.

**Stage 4's tonemapping item, on the web side — DONE, and the review's stated
reason was half wrong.** The web previz now runs `THREE.NeutralToneMapping`
(Khronos PBR Neutral) as Stage 4 asks. The review justified it as "ACES Filmic
actively skews saturated reds orange and blues cyan"; measured against the
actual three.js 0.179 shaders, in OKLab, at the 20× overdrive the beam stack
lives in:

- **Reds and amber: confirmed, and worse than stated.** ACES takes a saturated
  red +53° of hue (red reads orange) and amber +27° with its saturation crushed
  to 0.09.
- **Blues: the claim points the wrong way.** ACES's blue shift maxes at −13°;
  Neutral's reaches +19°. Neither curve is hue-preserving perceptually — the
  often-repeated "Neutral preserves hue" is a property of *linear* HSV, not of
  anything the eye uses, and it breaks because Neutral's final desaturating mix
  lifts a zero channel to a small linear value that the sRGB curve then
  magnifies.
- **What actually justifies the swap is saturation, not hue.** A cyan beam
  keeps 0.26 saturation under Neutral and 0.03 under ACES; ACES also ends in a
  hard `saturate()` clip where Neutral asymptotes. Saturation is what decides
  whether a colour reads as that colour at all, so the trade is worth taking —
  but take it for that reason, not the folk one.

Also worth knowing before comparing constants across the two: three.js
pre-divides ACES's exposure by 0.6 and Neutral's not at all, so an exposure
number fitted for one is meaningless for the other.

**Stage 4's tonemapping item, on the native side — mostly already true.** The
review's phrasing ("TonyMcMapface/AgX, tonemapper exposed as a setting")
overstates the work: `previz/src/camera.rs:29` has set `TonyMcMapface` since
the first previz commit and has never changed, and `Bloom` + `hdr: true` are
already there. The only missing half is *exposed as a setting* — an env var
plus a key to cycle the variant, about an hour, no protocol or parity surface.
The genuinely large part of native Stage 4 is the Bevy 0.16 → 0.19 upgrade
(declared `bevy = "0.16"` at `previz/Cargo.toml:8`, resolved 0.16.1), which
everything else in that lane gates on.

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
7. B1 GDTF geometry parser + per-profile layout editor + offsetY — DONE.
   Six commits: (a) schema+geometry — CHead offsetY/row/col (serde-defaulted,
   zero-skipped; pre-B1 saves byte-stable), geometry twins place heads at
   Ry·Rx·Rz·(offset, offsetY, 0) and carry rowT/colT normalized per-fixture,
   flat-fallback (all heads (0,0) → col=index), Row/Col fan bases ("every
   strobe is the same" by construction) (`a1a1ab4`); (b) the Geometries
   parser — per-pixel Position matrices composed through ancestors, Z-up→Y-up,
   translation = 4th brace group, centred layouts, mm-vs-metres by CENTRED
   extent >5, synthesized fallback for flat/zeroed/absurd files (`e19b384`,
   hardened `91ee69c`); (c) previz offsetY in all three paths (`9f1d6ea`) +
   rebuild signatures sign offsets (`48af934`); (d) the parametric layout
   editor — Strip/Grid(serpentine)/Ring on the PROFILE, SVG preview,
   browser-verified end-to-end (`6a70b1a`); (e) adversarial-review fixes —
   re-import PRESERVES operator-authored layouts (flat incoming inherits
   stored non-flat; real geometry stays authoritative and now warns via the
   extended layout_sig), per-row x-sorted cols, single-linkage row
   clustering, tolerant CHead spatial loading in both engines (`91ee69c`).
   NOTE: every GDTF embedded in the mainstage MVR is a flat single-Base
   console export — rich geometry lives on GDTF Share (fetch is parked, §2).
8. B3 auto-groups slice 1 (per-type, per-truss ordered along the bar) — DONE
   (`2ed93e4`). Group gains an inert `auto` provenance tag (tolerant both
   engines); desiredAutoGroups/planAutoGroups/applyAutoGroups in
   ui/src/autoGroups.ts; ⟳ button with create/update/remove diff-confirm in
   the Groups panel; rename/chip-edit/reverse promotes (deletes the tag);
   deterministic ids make regenerate idempotent. Browser-verified: dialog
   plan correct, engine holds tagged groups, truss ordered along the bar.
   Halves/pairs/odd-even linked groups stay deferred until wanted.
9. P1 soft overrides (SoftAddr layer, engine-side commit, Store/Discard) —
   DONE (`2b12857` engine, `8528bbf` UI). SoftField vocabulary (16 part fields
   incl. hue/sat + 6 effect knobs) — the binding surface P3/P2 plug into.
   Commands: soft (per-value, validated+clamped at the door, storage-shaped
   address (look, part[, effect], field)), softCommit (one gen bump, shared
   field-routing twins), softClear. Resolution stored→soft folded into an
   effective view before the applyEffects seam (renderer keys by the RESOLVED
   look, so cue steps ride correctly); P4 rate-corr reads effective effects so
   soft rate rides stay continuous. Cleared on ALL STOP + project switch;
   dangling addresses sweep in the gen-gated block. Snapshot carries live
   rides. 12 pinned parity assertions. UI: RIDE toggle, dual-state faders,
   amber RIDING banner with Store/Discard, browser-verified. APC-knob focus
   follows in P3.
10. P3 Named Controls (the macro replacement — typed faders, per-link ranges)
    — DONE (`cf917f0`). Control { id, name, value, links[] } with per-link
    (look, part[, effect], field, min, max) brackets (min>max inverts);
    setControl resolves EVERY link through the P1 soft layer, so rendering,
    the RIDING chip, Store/Discard, ALL STOP and sweeping come free; MIDI
    'control' learn action drives any CC onto a control; Controls tab UI with
    dangling-link ⚠. 7 parity assertions incl. the MIDI path. APC 8-knob
    LED-ring bank deferred as polish.
11. P2 modulators (LFO slice, then ADSR slice) — LFO SLICE DONE (`116a736`).
    Modulator { wave, rate, phase, on, bindings[] }; value = pure function of
    the shared effBeat (speed master + tap for free); bindings add
    (wave−0.5)·depth (hue ×360) over stored → soft, clamped per-field;
    gen-gated binding index; 8 parity assertions. The full resolution order
    (stored → soft → modulation) is live in both engines.
    ADSR SLICE STILL PARKED — pickup notes: envelope triggered by look fire,
    release anchored in LayerLive (needs a release timestamp field), sustain
    is a LEVEL not a time, release tails are voice-overlap semantics (the
    two-source crossfade merge already models this), allStop gates envelopes
    dark; add an 'adsr' modulator kind beside the LFO so bindings/UI reuse.
12. B4 pixel-map canvas — DECIDED (deferred permanently unless demanded).
    The pixel map is a computed projection of real head positions (the
    geometry module), always current, never hand-stale. The 2D previz front
    view IS that projection since B1 slice 3. A hand-drawn per-group
    arrangement override gets built only if physically-false layouts are ever
    actually wanted on this rig.

Rejected: A3 (superseded by P1+P4), any macro language, live-linked pool
presets, k-means auto-grouping, a second RNG.

## 7. Stages 4–5 (upcoming)

Stage 4 (previz quality: bloom/tonemapping, camera bookmarks, soft-falloff beam
shader, quality tiers, Bevy 0.19, DLSS on PC / MetalFX on macOS) and Stage 5
(features: audio-reactivity, Art-Net HTP merge, MVR geometry, Link-clock
timelines) are described in the review artifact.

## 8. Previz shadow allocation — DONE (`update::allocate_shadows`)

Was: the budget was spent in spawn order and decided once at scene build, so a
cue lighting only fixtures late in the patch got none of it. Measured on the
real rig it was worse than that — all 24 head slots went to a group no look in
the show uses, and three of the four groups that DO get fired cast nothing at
all.

Now dealt per frame, round-robin across fixture groups, to the lights that are
lit. The "may churn render pipelines" worry that parked it was unfounded:
bevy's shadow-pass pipeline key carries one bit of light information
(orthographic vs perspective) and no light identity, so the pipeline is always
a cache hit.
