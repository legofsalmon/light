# Feature backlog — the Lightkey gaps, verified

What LIGHT lacks against Lightkey 6, checked against the code rather than the
brochure. Each item below was a claim from the September 2026 review; an agent
read the codebase to confirm or correct it, and a second agent tried to refute
the verdict. 24 claims, 0 overturned, 1 found false (removed — see the end).

This is a *to-do list*, not a promise. Items are in the order they are worth
doing for LIGHT's audience (a VJ with Arena, a rig, a laptop and a tablet),
not the order Lightkey's feature page lists them. UX findings from the same
review live in the review artifact and `docs/design/system.md`, not here.

**Effort key:** S hours · M a day or two · L about a week · XL several weeks.
**Touches:** which parity-locked halves a change reaches. Anything on the tick
path or in the project schema touches `shared/types.ts`, `core`, `engine` and
the parity harness together.

**Status:** ⬜ absent · ◧ partial · ✅ present

---

## Decisions to make before starting

These block more than one item and are product calls, not engineering.

1. **Fixture-library licensing.** GDTF Share's terms forbid redistribution
   ([docs/investigation-gdtf-share.md](investigation-gdtf-share.md) §T&C). A
   bundled starter set must come from manufacturer files with explicit terms, be
   hand-authored, or wait on the email to info@gdtf-share.com the investigation
   recommended. Blocks #2.
2. **Network-only output, or not.** `ROADMAP.md:57-59` and the README build the
   architecture around an Art-Net node. Either commit to USB DMX (#18) or say
   "network only" plainly on the download page. Blocks #18 and the site copy.
3. **Universal or arm64 for stable 1.3.0.** The betas are arm64 by choice (CI
   time). `/latest` is still the universal v1.2.2. Blocks #21 — and the updater
   arch guard in #21 is needed *whichever* way this goes.
4. **Submaster persistence.** Saved-at-zero would kill a group on next boot,
   against the "comes up dark and safe" promise. Runtime-only is recommended
   (#6).
5. **Undo scope.** Engine-side project journal only, or live state (masters,
   rides) too. Project-only is the reliability-safe slice (#12) — decided and
   shipped 2026-09-06: live state stays out, and an undo keeps it.

---

## The list

### 1 · Output-safe first run and a setup path — ⬜ absent — L
**Touches:** ui, shared/types.ts, core, engine, parity, docs
**Today:** first launch boots the demo show; *new project* gives a blank grid.
Both templates ship `artnet: true` on two universes, so a fresh install
transmits to the LAN the moment it opens — the review's blocker B1. The five
setup surfaces (Output, Fixtures, Stage, Groups, Aim) exist as unordered tabs;
nothing sequences them, and PatchView has no zero-fixture state.
**Build:**
- A global *transmit gate* distinct from blackout (blackout still sends frames
  of zeros): a project setting or engine command honoured in both engines'
  Art-Net/sACN send path, defaulted OFF for shipped templates, with a
  persistent on-screen state and a one-click "go live". Parity-covered.
- A first-run gate (the engines already know "no saved project ever") that
  opens an assistant — Output → Fixtures → Stage → Groups → Aim → done —
  hosting the existing tab content, with "just give me the demo" one click away.
- Zero-fixture and all-universes-off empty states.
- A Getting-started chapter in the user guide.
**First slice:** flip both templates to `artnet: false` + a test (hours; in the
review's "now" lane). Then the transmit gate. Then the assistant (M on its own).

### 2 · A bundled starter fixture library — ◧ partial — L (gated on decision 1)
**Touches:** src-tauri, ui, docs (+ core/engine/shared/parity only if the
picker must work on the tablet or the compiler is extended)
**Today:** exactly 7 built-in profiles (3 from Colm's rig, 4 generics). The
substrate is complete: data-driven `CompiledProfile`, one interpreter in both
engines (WASM in Node), a local fixture directory with `library_list` /
`library_read`, GDTF Share fetch (12,437 entries, own account, online, Tauri
app only). Nothing seeds the directory; the only picker is "rebuild from
library".
**Build:**
- Content: 20–50 common club/DJ fixtures, sourced under redistribution terms
  or hand-authored and verified against the manual.
- Seed: a Tauri resource + copy-if-absent into `fixture_dir()` (and the Node
  mirror in `engine/persist.ts`).
- An offline "add fixture from library" picker in PatchView replaying the
  existing `importGdtf` command — zero engine change in the Tauri app.
- Compiler coverage caveat: cheap DJ movers are heavy on macro/program/gobo
  channels the GDTF compiler parks at defaults (#3), so a bundled Chauvet
  mover would patch but not fully drive until #3 lands.
**Note:** the competitive gap is *offline and zero-setup*, not catalogue size —
GDTF Share and Lightkey are the same order of magnitude.

### 3 · Moving-light optics: gobo, prism, shutter modes — ◧ partial — L
**Touches:** shared/types.ts, core, engine, parity, ui, docs
**Today:** strobe is present (one linear rate; `Shutter1StrobePulse/Random`
never driven). Colour wheels are present in both engines (auto-quantised from
HS; explicit slot picker is derby-only). Gobo and prism are absent everywhere —
`Gobo1*`/`Prism1*` fall into the GDTF importer's "unmapped" arm.
**Build:**
- A banded, snap-not-fade part parameter (gobo slot) + continuous rotate;
  prism in/out + rotate; shutter modes as selectable bands. Each needs
  `PartParams` fields, `ResolvedParams`/`BeamParams`, both renderers' merge
  (banded merges like `macro`, not weighted), new `Source` variants, GDTF arms,
  the WASM param-layout bump, SoftField/EffectTarget membership, UI caps and a
  slot picker built from the profile's wheel names, tests + parity checkpoints.
- Previz rendering of gobos/prisms is a separate, larger item.
**First slice (S, UI only):** expose imported profiles' colour-wheel slot names
as a picker for non-derby fixtures — `macro` already flows through both engines.
**Constraint:** golden tests for built-ins must stay byte-identical; old saves
must load with the new params absent (the `SourceUnset` pattern already exists).

### 4 · A ready-made effects library — ◧ partial — M
**Touches:** ui, docs (no engine change for single-effect presets)
**Today:** effects are composed (11 targets × 7 waves × fan pipeline). A
user-authored FX pool exists end to end (copy-on-apply; the engine never
renders from the pool) but ships empty, and its picker is a bare `<select>`
that only appears once the pool is non-empty.
**Build:**
- A factory catalogue as an app-level constant — 30–70 named, categorised,
  described presets validated with `repairEffect` at test time — surfaced
  beside "apply from pool…" or in a proper picker with categories, search and
  live preview onto the selected part.
- Composite presets (Fire = random dimmer + hue drift + white flicker) mean
  `FxPreset.effect → effects[]`: a schema change across both engines and the
  parity round-trip test — escalates to L. Ship single-effect first.
**Note:** most of the day is authoring and auditioning on the real rig, not
code. Many Lightkey templates are pixel-matrix effects LIGHT routes through
Arena by design; per-pixel Rain/Meteor is the roadmap "pixel mapping" item.

### 5 · Pan/tilt calibration — ◧ partial — L (M without the wizard)
**Touches:** shared/types.ts, core, engine, parity, ui, previz, previz3d, docs
**Today:** per-fixture base aim ("focus", 0..1, no degrees, parity-pinned);
mounting yaw/pitch/roll exists but is previz-only — a fixture hung backwards
pans the wrong way on the wire and only the previz knows. Pan/tilt travel is
hardcoded 540°/270° in both previz; the GDTF importer drops `PhysicalFrom/To`.
No invert, no limits, no wizard.
**Build:**
- Profile physical range from GDTF into `CompiledProfile` (540/270 defaults
  for built-ins).
- Optional per-fixture calibration block (invert pan/tilt, swap, home in
  degrees, soft limits), absent-by-default so old saves load byte-identically.
- Both renderers: invert → home offset → clamp to limits, after the focus
  delta and before quantisation; new parity checkpoints beside the "focus:"
  ones.
- UI: degree read-out in the patch table, invert/limit controls, a wizard:
  identify → drive live → "point at stage centre" → "does it go stage-left?" →
  optional perspective step that also sets `rotY` so previz and wire agree.
- Both previz honour range and invert.
**Carry separately:** mounting orientation is not compensated on the wire — a
correctness item on its own even without the wizard.

### 6 · Group / fixture submasters — ⬜ absent — M (L with per-fixture + APC)
**Touches:** shared/types.ts, core, engine, parity, ui, docs
**Today:** grand master (runtime), four layer masters (persisted), speed, haze,
blackout. Per-fixture: a binary mute. Named Controls *replace* a stored level;
they do not scale, and are per (look, part).
**Build:** a submaster stage per group (optionally fixture) multiplying dimmer
and white after the layer merge and before the grand master, in both engines:
commands, MIDI actions, snapshot fields, a head→groups index built per project
generation (never on the tick), parity cases (single, overlapping, stacked
with layer master and blackout), a fader strip. Overlap semantics: auto-groups
put every head in a per-type *and* a per-truss group — `min` is the console
answer, product double-scales. Respect `ROADMAP.md:23` "masters only scale
intensity". See decision 4 on persistence.

### 7 · Freeze (hold output while editing) — ⬜ absent — M
**Touches:** shared/types.ts, core, engine, parity, ui, docs
**Today:** Audition is a second render that never reaches DMX; the only hold is
the per-channel `setChannel` check tool. Every edit is live.
**Build:** an engine-side `freeze` command holding the last sent frame per
universe while the renderer keeps ticking (previz and snapshot follow edits);
runtime-only; `AllStop` and blackout release it ("blackout always wins");
decide whether raw overrides punch through and what the DMX monitor shows
(probably the wire); snapshot flag + top-bar toggle + persistent warning chip;
parity case (freeze → edit → DMX unchanged → unfreeze → live; AllStop releases).
Do not build it UI-side — a client-held frame violates engine isolation.

### 8 · In-app help, shortcut sheet, first-run card — ◧ partial — M
**Touches:** ui, src-tauri, docs
**Today:** 219 hand-written tooltips (rich, deliberate), nothing else. No
guide link, no shortcut list (the guide's keyboard reference is already stale:
says 1–8, handler does 1–9 and `[`/`]`), no first-run guidance, no videos.
**Side finding to verify first:** the two existing external links (licence
"manage →", update "release page") are `target="_blank"` with no
`on_new_window` handler; on wry 0.55 WKWebView that click is dropped. A
~10-line `open_url` Tauri command (or `tauri-plugin-opener`) fixes both and is
the prerequisite for any guide link.
**Build:** a `?` in the top bar / settings → hosted guide; a shortcut table in
`App.tsx` that both the keydown handler and a `?`-key modal read so they cannot
drift; a dismissable once-only first-run card after the licence gate; sync the
guide's keyboard reference. Videos are content, not code.

### 9 · Named movement shapes (circle, figure-8, paths) — ◧ partial — S / M / L slices
**Touches:** shared/types.ts, core, engine, parity, ui, docs
**Today:** pan and tilt are independent effect targets with a free phase, so a
circle *can* be hand-built from two effects; `fold: mirror` gives symmetric
wings and is parity-pinned. No shape type, no XY pad, no path editor; the FX
pool holds one effect so a circle cannot be saved.
**Slices:** S — "add circle / figure-8" quick-add that inserts two pre-phased
effects, zero engine change. M — a coupled `shape` effect (serde-defaulted
fields: shape, aspect, rotation, direction) writing both targets from a
parametric formula, parity-asserted. L — editable paths with a polar/XY editor,
project `paths[]`, sampling in both engines, per-head offset, previz overlay.

### 10 · MIDI Beat Clock as a tempo source — ⬜ absent — M (follower alone S)
**Touches:** shared/types.ts, core, engine, parity, ui, docs
**Today:** tap, drag, OSC tempo from Arena, Ableton Link (native engine).
0xF8 clock bytes already reach the native engine and are discarded — at 120 BPM
that is 48 messages/s through the engine channel for nothing; the browser
forwards them over WebSocket too.
**Build:** a native-only follower like Link (24 PPQN with midir timestamps,
start/continue/stop, jitter rejection, a combined tempo+phase setter on
`BeatClock` mirrored in both engines), a `midiClockEnabled` + port field in
`SyncCfg`, precedence against Link (a jittery follower must not make LIGHT a
jittery Link leader), status in the snapshot and top bar, tests.
**Two cheap wins regardless:** pre-filter status ≥ 0xF8 in `core/src/midi.rs`
and `ui/src/midi.ts`; keep midir's timestamp instead of discarding it.
Note `ROADMAP.md:107` still lists Link as future — it shipped.

### 11 · MIDI feedback breadth (APC mini LEDs, Launchpad, X-Touch) — ◧ partial — M → XL
**Touches:** core, ui, docs (+ shared/engine/parity only if surface choice enters the schema)
**Today:** APC40 mk2 LEDs in two mirrored implementations (`core/src/apc.rs`,
`ui/src/apcFeedback.ts`), one connection, channel 0 only, port name must
contain "apc40". APC mini mk2 has an input preset and no LED path. Traktor F1
and Stream Deck are HID, not MIDI — no path at all.
**Slices:** M — APC mini mk2 LEDs (channel-aware LED map, second note table,
multi-surface connections, mirrored tests). L — a surface abstraction
(detect-by-port, note→(channel, velocity), SysEx init for Launchpad programmer
mode; `midi.ts` currently requests `sysex: false`). L each — X-Touch (Mackie:
motor faders, scribble strips). The full claim is XL.
`ROADMAP.md:111` "MIDI feedback (APC/Launchpad)" is stale for the APC40.

### 12 · Engine-side undo — ◼ shipped 2026-09-06 (project journal; live state out by decision 5)
**Touches:** shared/types.ts, core, engine, parity, ui, docs
**Today:** a 30-deep UI-side stack fed only by the UI's own edit path; engine
echoes are deliberately not captured (inferring them from diffs caused
cross-project overwrites and fader floods). Bypasses: deck switches, GDTF/MVR
import, MIDI/APC actions, masters, haze, ALL STOP. Committing a ride *is*
undoable. The engine has no history at all — only a `gen` counter and a 5-deep
crash-recovery backup ladder.
**Build:** an engine-owned journal of before-images or reverse patches per
project-changing command in both engines; `undo`/`redo` commands and an
`undoDepth` snapshot field replacing the browser stack so every client shares
one history; a multi-client policy (is B's edit undoable by A; are APC deck
switches steps; does undoing an import release live looks); parity cases.
Masters/overrides/rides are live state, not the document — scope them out.
`ROADMAP.md:118` "Undo/redo" already means this; reconcile rather than duplicate.
**Shipped:** both engines keep a 100-deep journal of before-images (`history`
/ `redo` in `EngineState`), fed by every accepted `updateProject` (named by
the client's `label`, coalesced across a drag by `coalesce` — same client only,
never across an undo), GDTF/MVR imports, Keep on a nudge and a learned MIDI
mapping. `undo`/`redo` commands restore for every client and keep the live
page, masters, haze and Link; a `history` event carries the depths and the
names for the buttons. Song switches are navigation, not steps. Parity cases
in `engine/test/diff.ts`; unit tests in both engines.

### 13 · Lock mode for a floor tablet — ⬜ absent — M (UI) / L (enforced)
**Touches:** ui, src-tauri, docs (+ core/engine/shared/parity for enforcement)
**Today:** the `pads` view is the performance view; nothing prevents switching.
No auth, no roles — every WS connection can send `updateProject`, `openProject`,
`setChannel`.
**Build (layer 1, M):** a `locked` flag persisted like `view`, a top-bar
toggle, pinning to pads with library/editor/menus/tabs gated, unlock via a
passcode through the existing dialog, ALL STOP still reachable. Touch ID is
Mac-window-only (custom `LocalAuthentication` FFI; the tablet is a browser).
**Layer 2 (L):** a server-enforced perform-only role — this *is* the parked
authentication work (`docs/parked-work.md` §2, `ROADMAP.md:116`). Without it,
layer 1 is "keeps a leaning elbow off the Patch tab", and should say so.

### 14 · Manual stage size — ◧ partial — M (S first slice)
**Touches:** shared/types.ts, core, engine, parity, ui, previz, previz3d, docs
**Today:** no size field anywhere. The native Bevy previz *derives* bounds
from fixtures and structural props (`Bounds::of`, 3 m margin, 16×12×7 m
floor). The web 2D plan and in-app 3D use hard-coded 11×9 m / 14×10 m extents
and neither derive nor clamp — an arena-scale MVR renders off-canvas.
**Slices:** S — port `Bounds::of` to the web views (ui only). M — a
`stage: {w, d, h}` project field (declared in the Rust struct or autosave
strips it), `sanitizeProject` repair, `ProjectLite` on the previz wire, a row
in the Stage table, and a policy for manual-vs-derived in native `fit_backdrop`.
Off the tick path — DMX goldens untouched.

### 15 · Colour picker: wheel, Kelvin, palette — ◧ partial — S / M
**Touches:** ui (+ shared/core/engine/parity for a palette or Kelvin-labelled CTO)
**Today:** hue fader + saturation fader + 12 hard-coded swatches; a raw 0..1
CTO fader on fixtures that have one (no Kelvin, no effect on RGB mixing).
**Slices:** S — a 2-D hue/sat wheel and hex/RGB entry emitting the same
`ColorHS`, routed through `setP` so rides keep working. S — warm/cool swatches
resolving to `{h,s}` (does not touch the RGBW white emitter; making CCT drive
white is a renderer change, M). M — per-look or per-project palette (schema
field both engines must round-trip). M — Kelvin-labelled CTO from GDTF range
metadata.

### 16 · In-app fixture profile editor — ◧ partial — M (MVP) / L (trustworthy)
**Touches:** ui, shared/types.ts (sanitize), core (lenient load), parity, docs
**Today:** the profile format is data-driven with one shared interpreter and is
already written in-app (form override, pixel layout). No new/duplicate/edit/
delete; an imported profile can never be removed; a malformed hand-authored
channel fails the *whole* Rust project load; built-in ids silently shadow
project profiles.
**Build:** editor UI (metadata, footprint, heads, per-channel rows incl. 16-bit
pairs, Linear/Fixed/Wheel cases, motor modes); duplicate-from-imported (free)
and from-built-in (needs `compiled_builtins()` reachable — TS twin or request);
a validation twin in `sanitizeProject` and a lenient per-profile Rust load path;
lifecycle (delete/rename/"used by N"); a parity assertion for the hand-authored
path; refuse built-in ids. `README.md:98` already lists it.

### 17 · DAW-fired cues — ◧ partial — S (docs) / M (supported) / XL (plugin)
**Touches:** shared/types.ts, core, engine, parity, ui, docs
**Today — undocumented but working:** the native engine connects every CoreMIDI
input, so a MIDI clip on an IAC bus fires a pad or column like an APC pad, in
the next 40 Hz frame. Transport bytes (clock, start/stop, SPP, MTC) are
discarded; Link is tempo-only (no `beat_at_time`, no `is_playing`); OSC
timetags skipped; MIDI `cell` actions address the *active* deck so the same
note means a different look after a deck switch.
**Slices:** S — document the IAC recipe and publish a "LIGHT" virtual input
port. M — transport-locked downbeat/arm via MIDI Start/SPP or Link transport,
plus a fire-by-look-id / deck-qualified action so DAW notes survive deck
switches (parity on the effBeat/resync path). XL — a Lightkey-class DAW plugin.
Stated design intent (v1.2.2 review, road item 04): timecode reaches LIGHT via
Arena's column-follow, not a direct DAW hook. Frame the item against that.

### 18 · USB DMX interfaces — ⬜ absent — L (Enttec Pro family) / XL (Lightkey breadth)
**Touches:** shared/types.ts, core, engine, parity, ui, docs
**Today:** every DMX byte leaves over UDP. No serial/USB scaffolding, no trait
for a third transport; both engines hard-code the Art-Net/sACN pair in the
tick loop. Network-only is a *chosen* position (`ROADMAP.md:57-59`).
**Build (first slice):** the Enttec DMX USB Pro framed protocol (covers
DMXking and Pro-compatible clones) on both engines via `serialport` (IOKit,
no dylib) — or a `LIGHT_NO_USB` gate for the Node twin, an explicit decision;
a writer thread with a bounded queue that drops frames rather than stalling
the 40 Hz tick; device enumeration/hot-plug/health surfaced like `artnetNodes`;
`usb`/`usbDevice` on `UniverseCfg` with `#[serde(default)]` and sanitize
repair; stats; the parity harness forcing `usb=false`. Open DMX/bare FTDI
bit-banging on macOS adds real timing risk; matching ~20 interfaces is several
independent protocol stacks. Not sandboxed, so no USB entitlement.
**For Colm's rig this buys nothing today** — it is market expansion. See decision 2.

### 19 · DMX in / HTP merge — ⬜ absent — L (M for Art-Net-only merge)
**Touches:** shared/types.ts, core, engine, parity, ui, docs
**Today:** nothing receives DMX. The ArtPoll listener drops every opcode except
PollReply; sACN has no multicast join anywhere. The only channel-space hook is
the raw override pass.
**Build:** input-universe config (protocol, wire universe, merge mode, source
filter) + stats; Art-Net in by extending the 6454 listener (must run even when
no universe outputs Art-Net); sACN in (bind 5568, join per universe, sequence
handling, per-source priority — meaningfully more work); a latest-frame buffer
with a *staleness timeout* (a dead upstream console must not pin channels); a
channel-space merge beside the overrides pass with a precedence decision
(blackout still wins); optional DMX-channel triggers; harness UDP injection
(Rust binds 6454 exclusively, Node uses reuseAddr — two receivers on one host
need an override); UI rows and status dots. `docs/parked-work.md:407` names
"Art-Net HTP merge" as Stage 5.

### 20 · Stream Deck — ⬜ absent — M (Companion module) / L (first-party plugin)
**Touches:** docs + an out-of-tree package (no engine change for the recommended shape)
**Today:** nothing. Indirect surfaces: three OSC addresses (bpm, column,
blackout), the unauthenticated WS protocol on :9900 with the full Command
union, window-focused hotkeys.
**Build (recommended):** a Bitfocus Companion module speaking the existing WS
protocol — trigger/release, column, tap, blackout, allStop, switchDeck,
masters — with key feedback derived from the snapshot exactly as
`apcFeedback.ts` does, reconnect/backoff, dropdowns populated from the
`project` event. A direct HID driver in the core is the wrong shape
(`ROADMAP.md:14-16`). Prerequisite for any non-local host: the WS auth token
(decision under #13).

### 21 · Intel / universal builds and an updater architecture guard — ◧ partial — M
**Touches:** src-tauri, CI, docs
**Today:** 1.3.0 betas are arm64-only by choice (`release.yml:30`; universal
v1.2.2 took 84 of a 90-minute CI cap). `/latest` still serves universal
v1.2.2; the site and `docs/distribution.md` still say universal. **The updater
has no architecture awareness**: it picks the newest `LIGHT.zip` and verifies
signature, notarisation, bundle id and version — never the Mach-O arch. The
first arm64-only *stable* release will be offered to every Intel Mac on v1.2.2,
pass every check, swap, and fail to relaunch; the documented rollback covers a
failed `mv`, not a failed launch.
**Build:** (a) decision 3, then either raise `timeout-minutes` (up to 360) or
split into per-arch jobs + an assemble/lipo/re-sign/notarise stage (M);
(b) an arch check in `update_install.rs::verify()` — `lipo -archs` of both
binaries against the host (plus `sysctl.proc_translated` for Rosetta),
refusing with a message that points at the releases page, stubbed in tests
like `open`/`lsof`/`xattr` — **needed whichever way (a) goes**; (c) site and
distribution copy; (d) a real Intel Mac to test on — no 1.3.0 build has ever
run on x86_64.

### 22 · Multi-head *moving* fixtures (per-head pan/tilt bars) — ◧ partial — L
**Touches:** core, parity, previz, previz3d, ui, docs
**Reworded from the claim:** independently controllable heads already exist end
to end (groups are sets of heads; params, effects and compiled channels are
per head; the Partybar is 4 heads). The gap is the *moving bar*: the GDTF
importer declares single-head scope and assigns pan/tilt to head 0 unless the
pan/tilt channels carry the exact same geometry as that head's colour channels;
multi-head profiles are always `Rgb` kind; both previz articulate one yoke per
fixture; no per-head base aim.
**Build:** head assignment by geometry ancestry + an indexed-attribute fallback
(PanN → head N−1) with `Mover` kind for heads that drive pan and tilt, plus
tests; a multi-head mover in the pinned parity project with byte assertions;
per-head yokes in `previz/src/scene.rs`/`update.rs` and `Previz3D.tsx`; docs.
Per-head base aim or per-head look params is a schema change → XL; optional.

### 23 · Theatre-style cue stack (GO, follow, manual crossfade) — ⬜ absent — XL
**Touches:** everything
**Deliberately not built.** LIGHT's "cue list" is a beat-stepped chaser
(`Look.steps`), parity-pinned; the only "cue" is a column press; crossfades are
time-driven. `ROADMAP.md:109-110` names "go-presses" as the bridge toward
console cue stacks. A minimal go-press slice — `advance: 'beat' | 'go'`, a
`go`/`back` command + MIDI action + OSC route, a stored step index — is L on
its own. Full theatre semantics land in the tick path and schema of both
engines: XL. Keep it off the list until a customer asks for it.

---

## Removed after verification

- **"Overlay effects on top of whatever is playing" — ✅ present.** This is
  exactly what the layer stack's `multiply`/`htp` blend modes are, in both
  engines, documented as the FX layer's mode, and the backbone of the demo show
  (48/48 fx looks on the multiply layer, 14/14 strobes on htp). A bare dimmer
  wave with no base params starts from 1.0 and carves whatever is beneath.
  The one narrower true limit: **colour cannot be overlaid or modulated** —
  colour always lerp-replaces regardless of blend, and a hue effect with no
  base colour starts from red. A `hue-offset` blend variant would be M and its
  own item if ever wanted; it is documented as intentional today.

## Not our fight (recorded so nobody re-asks)

Philips Hue · Sunlite/FreeStyler import · a built-in audio analyser (both apps
defer to external tools) · SMPTE/LTC decode (Arena provides it upstream;
column-follow inherits it).

## Stale roadmap lines this list supersedes

`ROADMAP.md:107` Ableton Link (shipped) · `:111` MIDI feedback for the APC40
(shipped; Launchpad still open, #11) · `:118` undo/redo (engine-side shipped;
engine-side is #12) · `:81` fixture library directory (exists; unseeded, #2).
