# LIGHT — Roadmap

LIGHT started as the missing piece between Resolume Arena and a small Art-Net rig:
looks in a clip grid, driven by columns, MIDI, and Arena itself. The long-term
shape is a look engine that scales from a two-bar pub rig to a serious club
install — QLC+'s simplicity at the base, growing toward console-class features —
without ever compromising the thing that matters most in the booth: **the output
never stops, never glitches, never surprises you.**

## Invariants (every milestone)

These hold for all releases; a feature that can't satisfy them doesn't ship:

- **Engine isolation.** DMX rendering lives in its own real-time process. UI,
  previz, and integrations are clients of the WebSocket protocol and can crash,
  lag, or disconnect without touching output.
- **Parity or it didn't happen.** The Node reference engine and the Rust core
  stay byte-identical (`npm run test:parity`); anything that renders DMX is
  implemented once or tested differentially.
- **Nothing heavy on the tick path.** The 40 Hz render loop takes no
  filesystem, network-blocking, or unbounded work. Ever.
- **Cues can't misfire.** Column cues skip momentary flash looks; blackout
  always wins; masters only scale intensity.

## v0.2 — Publish *(current)*

Repository on GitHub, full code review with adversarially-verified findings
(`REVIEW.md`), documentation set (`docs/`), landing page (`site/` →
light.letissier.ie), CI candidates noted below.

**Acceptance:** all four test suites green; docs fact-checked against code;
site serves statically with no build step.

## v0.3 — "See it": native previz renderer

Today's three.js view (additive cones, no shadows or post) is a sketch. The
target is Depence-class *readability*: beams that occlude, haze that behaves,
colour that blooms. Decision made: skip incremental WebGL polish and build a
**native previz window** — because the previz is just another WebSocket client,
it can use a real renderer without adding one gram of risk to the engine.

- **B1 — `previz/` workspace crate (Bevy, pinned).** Volumetric spotlights with
  shadow-mapped shafts, fog density bound to the live haze value, HDR bloom +
  filmic tonemapping, reflective stage floor, emissive fixture sources. Derby
  fixtures render as six narrow rotating volumetric beams in true macro
  component colours (already in the snapshot as `mc[]`). Strobe gates light
  intensity. Fallback plan if Bevy's volumetrics disappoint: raw wgpu with
  custom froxel volumetrics (substantially more effort, same architecture).
- **B2 — Integration.** Launch from the Tauri app or `npm run previz`; camera
  presets (FOH / side / top / orbit); persisted window state.
- **B3 — Photometric accuracy.** Once GDTF lands (v0.4): true beam/field
  angles, luminous-flux-scaled falloff, wheel colours from CIE data; IES
  profiles for washes later.

**Honest limits:** real-time path-traced GI is out of reach in any of these
paths — but volumetrics + shadows + bloom + reflections is perceptually close
for dark, hazy stages, which is the entire use case. Meanwhile the zero-effort
pro option already works: LIGHT speaks standard sACN/Art-Net, so Capture,
Depence, or L8 can visualise it today.

**Acceptance:** side-by-side beats the three.js view on the default rig;
≤ 8 ms/frame at 1440p on Apple Silicon with ~30 volumetric shadow-casting
lights; 30-minute soak with looks cycling; three.js view remains as fallback.

## v0.4 — "Any fixture": GDTF import

Fixture profiles stop being code and become data. LIGHT adopts
[GDTF](https://gdtf-share.com) (DIN 15800), the industry fixture-description
standard.

- **Compiled-profile format:** GDTF `DMXMode → DMXChannel → LogicalChannel →
  ChannelFunction → ChannelSet` distils into a JSON profile both engines
  interpret — linear and banded channel functions (the Varytec derby's macro
  table is exactly a banded channel), 16-bit fine channels, defaults, virtual
  dimmers for colour-only fixtures, physical beam data for previz.
- **One interpreter, zero drift:** implemented once in Rust (`light-core`) and
  compiled to WASM for the Node engine and UI — profile parity holds by
  construction. Golden tests pin today's built-in profiles to their exact
  current DMX bytes.
- **Import UX:** drop a `.gdtf` file into the patch view, pick a mode, done.
  Library lives in `~/Library/Application Support/LIGHT/fixtures/`.

**Acceptance:** built-ins re-expressed in the format emit byte-identical
output; a GDTF from gdtf-share for a common moving head patches and renders
correctly (dimmer/colour/pan/tilt/shutter + one wheel).

## v0.5 — "Any design": MVR import

Import an existing lighting design from Vectorworks, Depence, grandMA, or
anything else that exports [MVR](https://gdtf-share.com) (DIN 15801):
fixtures, modes, patch addresses, and positions arrive in one file with the
GDTFs embedded.

- Parse `GeneralSceneDescription.xml`; resolve embedded fixture types;
  convert transforms (MVR is millimetres, Z-up → LIGHT is metres, Y-up);
  merge-or-replace into the current patch.
- Later in the milestone: venue/truss geometry from the MVR rendered in the
  native previz, and fixture 3D bodies from GDTF glTF geometry.

**Acceptance:** an MVR exported from a mainstream tool reproduces its patch
(universes/addresses) and plan positions in LIGHT without manual fixes.

## v0.6+ — Console growth

Roughly in order of expected value:

- **Ableton Link** tempo sync (Arena supports Link natively; removes the OSC
  tempo dependency).
- **Cue-lists / chasers per cell** — a cell that steps through looks on beats
  or go-presses; the bridge from "looks" toward console cue stacks.
- **MIDI feedback** — controller LEDs mirror active cells (APC/Launchpad).
- **Per-cell fade overrides in the grid UI**, cell copy/paste, drag-reorder.
- **Art-Net discovery** (ArtPoll/PollReply, per-node routing) and **sACN
  priority** per universe.
- **Project schema versioning + migrations** (forward-compatible saves).
- **WS auth token** for LAN control surfaces (tablet remotes) on untrusted
  networks.
- **Undo/redo** across project edits.
- **Pixel mapping** for the Octostrips as a LIGHT-side alternative to
  Arena-native control — pixel effects (waves, gradients, chases) on fixture
  groups at 40 Hz, which the Rust core has abundant headroom for.
- **Windows/Linux builds** (Tauri + midir + the engine are already
  cross-platform; needs CI + testing).

## Engineering debt / candidates from review

Tracked in [REVIEW.md](REVIEW.md) with severities; structural items graduate
into milestones here rather than being patched ad hoc.

---

*Sequencing follows gig needs: publish (v0.2) is done when this repo is
public; v0.3 makes rehearsal-without-rig real; v0.4–0.5 remove the last
hand-coded fixture work; v0.6+ grows toward console territory as the rig does.*
