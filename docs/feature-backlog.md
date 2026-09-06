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

### 1 · Output-safe first run and a setup path — ◼ shipped 2026-09-06
**Touches:** ui, shared/types.ts, core, engine, parity, docs
**Shipped:** a **transmit gate** — runtime-only, OFF at every boot, never
saved. `EngineState.transmit` + `setTransmit` + a `transmit` snapshot field in
both engines; `core/src/output.rs` / `engine/output.ts` hold the decision
(`Wire::Show | Dark | Silent`) and are unit-tested identically in each. Going
offline sends `GO_DARK_FRAMES` (3) frames of zeros before falling silent,
because Art-Net and sACN nodes hold the last frame they were sent and simply
stopping would leave the rig lit. Node discovery is deliberately NOT gated:
ArtPoll is a question, not output, and it is what you want while setting up.
The universes still say WHERE output goes; the gate only says whether any of
it leaves the machine. This makes B1 a rule rather than a property of whichever
templates happened to ship with outputs off.

UI: a `live` / `offline` button at the head of the top bar's safety group,
amber whenever universes are switched on but nothing is going out — the one
state that looks like a fault and is not. The output dot reads **not sending**
in that case instead of claiming it is sending. The Output tab carries the same
control in sentences, and doubles as the all-universes-off empty state.

**Setup guide** (`ui/src/components/SetupGuide.tsx`): Output → Fixtures →
Stage → Groups → Aim, each step ticked by READING the project rather than
self-reported, so an MVR import that arrives with fixtures, groups and
positions ticks three steps before you see them; Aim is dropped entirely on a
rig with no movers. It ends on **go live**. Re-openable from Settings ▸ Rig
setup. Docs: a Getting-started chapter in `docs/user-guide.md` and a "Going
live" section in `docs/website/09-output.md`.

**Two deliberate departures from the plan above.** It *guides* rather than
hosts the tab content — each step sends you to the real surface at full size,
which avoids duplicating five views inside a modal and lets you work normally
while it is up. And it opens on a project with **no fixtures** rather than on a
first-run flag: that is exactly a new project and nothing else, it needs no new
wire state, and it behaves the same on the tablet as on the Mac. A fresh
install boots the demo, which is already patched — so "just give me the demo"
is what a first launch already does, and the guide stays out of its way.

**Not done:** nothing outstanding for this item. The gate's behaviour on real
hardware (a node going dark on the go-dark frames) is unverified — every test
here ran with outputs off, by standing rule.

### 2 · A bundled starter fixture library — ◧ shipped 2026-09-06 as generics + picker; brand content still gated on decision 1
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
**Shipped:** twelve LIGHT-authored generic layouts (`shared/fixtures/*.gdtf.xml`
— pars with the dimmer and strobe in every common position, RGBA/RGBAW/UV
pars, RGB and RGBW bars, a 16-cell strip; 24 modes) compiled into the app by
`build.rs` and seeded into the fixture directory once per `SEED_VERSION`
(`src-tauri/src/library.rs`, never overwriting); the Rig view's **Fixture
library** section lists the operator's own files, the generics and the
built-ins in one searchable table with `+ rig` per mode (imports the file
through the engine's compiler, waits for the echo, patches at the next free
address) and removal; a file import now also lands in the library. What is
not done: brand-name content — every candidate source is GDTF Share, and its
terms forbid redistribution, so that waits on the email in decision 1.

### 3 · Moving-light optics: gobo, prism, shutter modes — ◼ shipped 2026-09-06 (previz drawing of them still open)
**Touches:** shared/types.ts, core, engine, parity, ui, docs
**Shipped:** `PartParams` gains `gobo` and `prism` (a wheel slot INDEX, 0 =
open, never a DMX value, so one look lands on "the second gobo" of every
fixture in the group), `goboRotate` / `prismRotate` (0..1 across the rotate
band; nudge-able, effect targets) and `strobeMode` (`strobe` / `pulse` /
`random`). Slots and the pattern snap like `macro`; rotations crossfade like
zoom; all absent = parked, so every old save renders byte for byte. Engine:
`Source::{Gobo, GoboRotate, Prism, PrismRotate}`, `Func::Slot` (index →
set), `Cond::StrobeModeIs`, WASM layout 20 → 25 slots (NaN = unset), both
renderers' merge. Importer: one gobo and one prism wheel per mode — the first
that rotates, else wheel 1 (a MegaPointe's Gobo1 is static, Gobo2 spins);
slots from the ChannelSets of the exact-attribute functions (nameless sets
named from `WheelSlotIndex`, boundary sets skipped, no sets → the wheel's
slots spread over the function's band); rotation = the union of the
`…PosRotate` functions, on the `…Pos` channel or a channel named after the
rotate function (Lyra); slot + rotate on one channel handled; pulse/random
shutter bands by suffix with plain as the fallback. Side-finding fixed: a
channel's resting value now comes from its `InitialFunction` — the Lyra's
shutter lists Closed (default 5) before Open (15) and compiled SHUT.
Profiles carry `compiler` (`COMPILER_VERSION` = 1); `isStaleProfile` joins
the undriven-beam-channel check behind the Rig table's flag and GDTF Share's
"rebuild from library". UI: gobo / prism slot pickers (names from the
profile), gobo spin / prism spin faders, a plain · pulse · random picker
beside the strobe fader; every effect target and control field now shows its
person-facing name (`TARGET_LABEL` / `FIELD_LABEL`). Tests: ten Rust import
tests on a second synthetic fixture plus inline MegaPointe-style and
one-channel cases, golden sweep extended, Node sanitiser checks, parity
checkpoints (parked / driven / random + clamped slot / unknown pattern +
fractional slot / released). **Not done:** drawing gobos and prisms in the
previz (a larger item of its own); a second gobo wheel; gobo shake and wheel
spin; indexed (angle) rotation on a `…Pos` channel with no rotate function.

### 4 · A ready-made effects library — ◼ shipped 2026-09-06 (single-effect; composites still open)
**Touches:** ui, docs (no engine change, as predicted)
**Shipped:** `ui/src/fxLibrary.ts` — 46 named, categorised, described factory
presets across Intensity, Colour, Movement, Beam, and Strobe and white. App
data, not show data: applying one copies it into the part with a fresh id, the
same copy-on-apply the user-authored pool already used, so nothing in the
catalogue is ever live and nothing a look does can edit it.

`ui/src/components/FxPicker.tsx` is the picker the bare `<select>` was not:
search over name, description and category; category filter; each row showing
its target, wave and speed in musical time ("dimmer · sine · a bar") plus a
sentence on when to reach for it. Presets whose target the group cannot take
are flagged rather than hidden, using `capableTargets()` — extracted so the
target menu and the picker give one answer instead of two that drift.

**Preview is the real thing.** Picking applies to the part immediately and
leaves the picker open, so the next pick REPLACES it: you audition by clicking
down the list and watching the stage. Keep closes on what is playing; Cancel
takes it back out; Escape is Cancel. Every write is an ordinary look edit, so
undo covers it and no preview state exists on the wire to go stale.

The catalogue is validated in `engine/test/smoke.ts`: 30–70 entries, unique
ids and names, every category populated, full-sentence descriptions, nothing
inert as shipped, search behaviour — and the real one, that every preset
survives `repairEffect` **unchanged**, which is the difference between "the
engines will accept this" and "the engines will quietly rewrite it".

**Not done, and honestly:** composite presets (Fire = random dimmer + colour
drift + white flicker) still need `FxPreset.effect → effects[]` across both
engines and the parity round-trip — the L this entry warned about, and the
next slice if it is wanted. And the presets are authored from the effect
maths, not auditioned on Colm's rig: they are structurally correct and each
one renders, but which of them are actually *good* is a judgement only the
real rig can make.

### 5 · Pan/tilt calibration — ◧ shipped 2026-09-06 without the wizard; mounting compensation still open
**Touches:** shared/types.ts, core, engine, parity, ui, previz, previz3d, docs
**Shipped:** the correctness half, which is the "M without the wizard" this
entry scoped.

**Travel from the file.** The GDTF importer reads Pan/Tilt `PhysicalFrom/To`
into `CompiledProfile.pan_deg` / `tilt_deg`, with `pan_travel()` /
`tilt_travel()` supplying the 540/270 both previz used to hardcode. Magnitude
only: the sign is real (a Lyra declares 270 to -270, a MegaPointe -270 to 270)
but it describes the fixture's axes rather than the room's, and acting on it
would silently reverse every imported mover. Both stage views now draw a
Spiider's 220° of tilt and a Nero's 180° instead of assuming 270°.

**Calibration.** `Fixture.cal` — `invertPan`, `invertTilt`, `swap`, and soft
limits per axis — absent by default and absent-means-nothing, so every show
written before it renders byte for byte. The rule is one module per engine
(`shared/aim.ts`, `core/src/aim.rs`, 8 unit tests each side): deltas from
centre, then swap, then invert (naming the FIXTURE's axis, so it reads the
same either way), then the base aim, then clamp. Inverting the DELTA is the
point — the head stays where it was focused and only the movement mirrors,
the same trick the effect engine plays on a folded pan spread. Limits given
the wrong way round park the head at the low one rather than nowhere.

Both renderers call it in place of the old base-aim block, with ten parity
checkpoints beside the "focus:" ones. `de_cal` and the Node sanitizer both
drop a block that corrects nothing, each pinned in its own suite.

**No home in degrees.** The entry asked for one; it would have been a second
way to say what the base aim already says. The Rig table shows the existing
0..1 base aim AS degrees instead, read against the profile's travel — one
source of truth, and the read-out the wizard would have needed anyway.

**UI:** `Aim pan` / `Aim tilt` carry an angle beside the percentage; a `Cal`
column opens a panel with the three flags and the four limits, measured and
clamped into the window because the Rig table scrolls sideways.

**Not done:** the wizard (identify → drive live → "point at stage centre" →
"does it go stage-left?" → set `rotY` from the answer). It needs a live rig to
be worth anything, and the controls above let an operator calibrate by eye
against one in the meantime. **Mounting orientation is still not compensated
on the wire** — the carry-separately item, and still separate: deriving pan
direction from `rotY` automatically would change the output of every existing
show with a rotated fixture, which is a decision rather than a fix. `invertPan`
is the explicit form, and it reaches the wire and both stage views together.

### 6 · Group / fixture submasters — ◧ group slice shipped 2026-09-06; per-fixture and APC still open
**Touches:** shared/types.ts, core, engine, parity, ui, docs
**Shipped: the M slice.** `setSubmaster` command, `submaster` MIDI action,
`submasters` snapshot field (present only while one is below full), and a
`GROUPS` fader row under the dials in the pads view.

The pass sits after the layer merge and before the grand master, on dimmer and
white only — `ROADMAP.md:23`, masters scale intensity and nothing else.

**Overlap is MIN, as the entry called it.** Auto-groups put every head in a
per-type group *and* a per-truss one, so nearly every head is in two: the
product would take a head in two groups both at 50% down to 25%, which is
what neither fader says. Pinned by a parity case that would pass under either
rule if it only checked one group.

**Runtime-only, per decision 4.** Only entries BELOW full are stored, so full
is the absence of an entry and an empty map skips the render pass entirely —
which is the state the rig is in nearly all the time. Cleared by ALL STOP and
by a project switch, and swept when a group is deleted (from the renderer's
per-generation rebuild, beside `sweep_soft`). Mute is the tool that survives a
panic; a level is not, and the docs say which is which.

The head index is built on the same generation gate as geometry, and the
per-tick scratch map lives on the renderer and is cleared rather than
allocated — nothing heavy on the tick path.

Sixteen parity checks: one group, overlapping groups, released, stacked under
a layer master, blackout over the lot, a panic clearing them, and a deleted
group taking its level with it.

**Still open:** per-fixture submasters and APC LED feedback, the two things
that made this an L. Neither is foreclosed — the pass takes a head key and a
level, and a per-fixture level would join the same `min`.

### 7 · Freeze (hold output while editing) — ◼ shipped 2026-09-06
**Touches:** shared/types.ts, core, engine, parity, ui, docs
**Shipped:** `setFreeze` command, `frozen` snapshot flag, runtime-only.
`FreezeHold` lives in `core/src/output.rs` / `engine/output.ts` beside the
transmit gate, because both answer the same question at the same moment: is
the rig following me, and if not, why not.

The substitution happens in the engine loop immediately after `tick()`, before
anything reads the buffers, so the wire and the DMX monitor agree while
`heads`/`layers` stay fresh — the stage view, the pads and the previz all
follow the edit. Each universe latches on the first frozen tick it is present
for, so one added mid-freeze holds from the moment it exists instead of being
the only thing on the rig still moving.

**Decisions the entry left open.** Raw overrides do NOT punch through, and
neither does identify: the override pass is separable and identify is baked
into the render long before this, so only one of the two diagnostics *could*
be let through, and one working while the other silently did not is worse than
a rule that is simply true. The DMX monitor shows the held frame, for the same
reason it exists — it reports what is leaving the app.

Blackout, ALL STOP and a project switch release it (`set_blackout` /
`setBlackout` is now the one door, so the MIDI toggle releases it too). A hold
that could swallow a panic is not a hold anyone should trust.

UI: a `freeze`/`held` toggle beside the transmit gate, and the pads-view grid
hint gains a fourth case with a release button — freezing and forgetting is
the failure this feature can cause, so it is not left to a lit button in a
busy top bar.

Tests: 5 unit tests each side plus 12 parity checkpoints, including the one
that proves the whole design — the snapshot follows an edit that the wire does
not. Verified live: the wire latched while the stage view fell to 1.4%, and
released to catch up.

### 8 · In-app help, shortcut sheet, first-run card — ◼ shipped 2026-09-06
**Touches:** ui, docs
**Side finding: already fixed.** `open_url` shipped with the "now" lane
(`src-tauri/src/main.rs`, wrapped by `ui/src/shell.ts` with a `window.open`
fallback), so external links work in the packaged app and the guide link had
its prerequisite.

**Shipped:** `ui/src/shortcuts.ts` is the keyboard, written down once. The key
handler runs it, the sheet renders it, and a test in the engine suite reads the
published table out of `docs/website/10-reference.md` and requires the two to
match key for key — so a shortcut cannot be added without appearing in the
documentation. That is the drift this replaces: the guide claimed keys 1–8
fire columns long after the handler had grown to 1–9, and never mentioned
`[` / `]` at all.

The module is deliberately DOM-free — its own `KeyPress` and `State` shapes
rather than the browser's `KeyboardEvent` and the store's type — because the
engine's test suite runs under Node with no DOM and imports it to press keys
at the real dispatcher. Nineteen checks, including the one that matters:
`⌥1` switches view and does **not** also fire column 1, which the two-pass
dispatcher is what prevents.

`?` opens the sheet (`ShortcutSheet.tsx`), `?` or Escape closes it, and while
it is open every other key is swallowed — it has no text fields, so without
that the cue keys behind it stay armed and reading the keyboard reference
fires cues. Settings gains a **Help** section: the user guide and the sheet.

**First-run card** (`WelcomeCard.tsx`): once per machine, after the licence
gate by construction, dismissed to `localStorage`. Says what LIGHT is in two
paragraphs, says that the demo is a demo and that LIGHT starts offline, and
offers three doors — set up my own rig (opens the setup guide), read the guide,
have a play. Deliberately not a tour.

`docs/user-guide.md`'s keyboard line is corrected and now points at `?`.

**Not done:** videos, which the entry itself calls content rather than code.

### 9 · Named movement shapes (circle, figure-8, paths) — ◧ M slice shipped 2026-09-06; paths (L) still open
**Touches:** shared/types.ts, core, engine, parity, ui, docs
**Shipped: the M slice, and the S one is moot.** The quick-add would have
inserted two pre-phased effects, which is the arrangement this replaces — two
rows to edit in step, unsaveable to the pool as one thing, and broken the
moment somebody changed the rate of one of them. A coupled target is the
honest version of the same idea and it is not much more work.

`EffectTarget` gains `shape`, the only target that writes TWO parameters, plus
four fields that are absent-by-default and validate-or-drop, so an effect that
is not a shape comes out of `repairEffect` exactly as it went in (the factory
catalogue is pinned on that): `shape` (circle / figure8 / square),
`shapeAspect`, `shapeRotate`, `shapeCcw`. An unknown figure from a newer build
degrades to the default rather than dropping the effect, like an unknown
`distribute`.

`shapeAt` / `shape_at` and `shapeAmps` / `shape_amps` are written in the same
operations in the same order in both engines — trig is not required by
IEEE-754 to be correctly rounded, so identical source is the guarantee. The
existing sine wave has been parity-pinned on that arrangement for months, and
the new parity block checks three figures at five phases each plus every knob,
because a disagreement would show at some phases and not others.

`wave` and `width` say nothing for a shape — the figure IS the waveform — so
the editor swaps the wave picker for a figure picker and the width fader for
aspect, turn and direction. `.fxrow` wraps now: three controls where there was
one overflowed a narrow editor pane and hid its own mix fader. Six presets
under Movement in the catalogue.

**Still open: the L slice** — editable paths with a polar/XY editor, project
`paths[]`, sampling in both engines, per-head offset, previz overlay. Nothing
here forecloses it: a path would be another `ShapeKind` reading a stored point
list, and the apply site already takes a figure and scales, rotates and offsets
it.

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

### 14 · Manual stage size — ◼ shipped 2026-09-06
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
**Shipped:** `Project.stage {w, d, h}` (metres, centred on the origin) in
both engines with one repair rule (`sanitizeStage` / `de_stage`, parity-tested:
a bad side drops the field, sides clamp to 1–500 / 1–100); `shared/stageExtent.ts`
derives the window every web view shows (the rig with a 3 m margin on whole
metres, never below the club default) or uses the set stage with a 1 m apron;
the 2D plan fits and draws the outline, the in-app 3D floor and grids fit,
the native previz fits its room and frames its camera to the set stage
(`room_for`); the Rig view's Stage section has the size row (auto / set).

### 15 · Colour picker: wheel, Kelvin, palette — ◧ wheel, tints and Kelvin shipped 2026-09-06; palette still open
**Touches:** ui, shared/types.ts, core (Kelvin metadata only)
**Shipped: both S slices and the Kelvin M.**

`ui/src/components/ColourWheel.tsx` — the colour chip at the end of the colour
row opens a disc: angle is hue, distance from the middle is saturation, centre
is white. Hex entry beside it (brightness discarded on purpose — intensity is
the dimmer's job, and a dark hex would otherwise dim the part as well as colour
it), and a warm-to-cool tint row at the saturations a white actually reads at.
Arrow keys walk the disc; shift steps coarser.

The disc is two CSS gradients, not a canvas: nothing reads pixels back, because
the hue and saturation of a click are geometry, and geometry is exact where
sampling a rendered gradient would be a guess about somebody's colour
management.

Everything — swatch, tint, disc drag, hex — now goes through one `setColour`,
which is the road the swatches already took: with a nudge armed, or the colour
already nudged, it goes through the soft layer, or the click looks dead while
quietly rewriting the stored show. That was one duplicated rule before and is
now none.

**Kelvin:** the importer reads `PhysicalFrom/To` off the CTO channel into
`CompiledProfile.cto_k`, kept in WIRE order rather than sorted because which
end is warm is the useful half. The warmth fader reads Kelvin only when every
fixture in the group that has the channel states the same range — two heads
with different ranges would make one number a lie about the other, and a
percentage is at least honestly vague. Bounded to 1000–20000 K so a stray unit
in a file cannot put 6 K on a fader. Real files agree: Lyra 6500→2800,
Rivale 6500→2900, Spiider 8000→2700.

**Still open: the palette M** — per-look or per-project stored colours, which
is a schema field both engines must round-trip. Nothing here forecloses it.

**Debt:** the disc and its marker are the only sizes in `theme.css` without a
Size variable, marked `/* not a token: … */` rather than blocking on a Figma
round-trip. Worth adding next time the design file is open.

### 16 · In-app fixture profile editor — ◧ trustworthy half shipped 2026-09-06; the channel editor is what remains
**Touches:** ui, shared/types.ts, core, docs
**Shipped: the reliability and lifecycle half, deliberately before the editor.**
A per-channel editor on top of the old load path would have been a way to make
a show unopenable from inside the app, so the order was not a matter of taste.

**One unreadable profile no longer fails the whole project.** `de_profiles` in
core deserialises them one at a time and skips what it cannot read — the
pattern the previz has had since it rendered a permanently empty stage for the
same reason. Before this, one hand-authored channel (or a show written by a
newer build that knew a `Source` this one did not) failed the entire parse, and
the engine fell back to the default show while renaming the operator's file
`.corrupt-*`. Skipping is not silent: those fixtures land in the snapshot's
`unknownProfiles`, which the Rig view already flags.

**Built-in ids no longer shadow silently.** Both engines resolve a built-in
before a project profile, so a project profile carrying a built-in id could
never render. Both sanitizers now drop it rather than keep dead weight that
looks like it works. `BUILTIN_PROFILE_IDS` lives in `shared/types.ts` — the
list, not the implementations, because that module is the bottom of the import
graph — and a smoke test pins it against `PROFILES` so it cannot drift.

**Lifecycle:** a `Profiles` table in the Rig view — channel count, head count,
"used by N", editable metadata, and remove. Removal is refused while a fixture
still points at it, and the `.gdtf` stays in the library either way. Profiles
used to accumulate with no way to take any out.

**Still open: the channel editor** — per-channel rows with 16-bit pairs,
Linear/Fixed/Wheel cases and motor modes, plus duplicate-from-built-in (which
needs `compiled_builtins()` reachable from TS) and a parity assertion for the
hand-authored path. Duplicate is deliberately absent until then: a copy you
cannot change is not worth a button. The groundwork it needed is now in place —
a bad edit can no longer take the project down with it.

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

### 21 · Intel / universal builds and an updater architecture guard — ◧ guard shipped 2026-09-06; the build decision is still open
**Touches:** src-tauri, CI, docs
**Shipped: (b), the guard, which was needed whichever way (a) goes.**
`update_install.rs::verify()` gained check 7: both the app binary and the
grafted previz binary must carry a Mach-O slice this Mac executes. Checks 1–6
all pass for a perfectly good build of the wrong architecture, so nothing else
caught it.

Slices are read from the Mach-O headers directly, not via `lipo` — that is an
Xcode Command Line Tools shim, and running it on a Mac without them pops the
"install developer tools" panel mid-update. Fat and thin headers, bounded
reads, hostile slice counts. `arm64e` reads as `arm64`: same cpu type, and an
Apple Silicon Mac runs both. Cross-checked against `lipo -archs` on a real fat
binary (`/bin/ls`) and a real thin one.

Which architecture the MAC is comes from `sysctl.proc_translated`, not from
the build LIGHT happens to be — on a universal build those are different
questions, and reading the build would call a Rosetta-translated process an
Intel Mac. Rosetta is credited only when the running process proves it is
there. Nine unit tests including one that checks the guard agrees with the
machine running it about its own binary.

**Still open:** (a) decision 3, then either raise `timeout-minutes` or split
into per-arch jobs with an assemble/lipo/re-sign/notarise stage; (c) site and
`docs/distribution.md` still say universal; (d) no 1.3.0 build has ever run on
x86_64, and a real Intel Mac is the only way to close that.

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
