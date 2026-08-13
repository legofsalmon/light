# LIGHT ⚡

A look engine that sits between **Resolume Arena** and your lighting network.
Resolume-style grid of clip-triggered *looks*, beat-synced effects, MIDI
control, OSC sync, 2D/3D previz — **Art-Net** out (sACN too).

Built for the two-universe architecture:

- **Universe 0** — Arena → Octostrip controller directly (pixel-mapped video).
- **Universe 1** — **LIGHT** → Art-Net→DMX node (derbies, partybars, hazer),
  triggered from Arena's clip grid over OSC.

## Architecture

```
┌────────────┐  OSC (columns, BPM)   ┌──────────────────────────────┐
│  Resolume   │ ───────────────────► │  ENGINE (Rust core)          │  Art-Net / sACN
│  Arena      │                      │  merge → effects → 40 Hz DMX │ ────────────────► node → rig
└────────────┘                       │  MIDI in (CoreMIDI)          │
                                     └──────────────┬───────────────┘
                                                    │ WebSocket (JSON, :9900)
                                     ┌──────────────┴───────────────┐
                                     │  UI — React grid, look editor,│
                                     │  2D/3D previz (Tauri window   │
                                     │  or any browser on the LAN)   │
                                     └──────────────────────────────┘
```

Two interchangeable engines speak the **same protocol on :9900**:

| | Node engine (`engine/`) | Rust core (`core/`) |
|---|---|---|
| Role | reference + dev iteration | the shipped engine |
| MIDI | via browser WebMIDI | native CoreMIDI (works with window closed) |
| Verified | full smoke suite | same suite ported + **byte-identical parity test** |

`npm run test:parity` boots both and requires channel-for-channel identical DMX (build the Rust core first: `cargo build -p light-core`).

## Run it

```bash
npm install            # once
npm run dev            # Node engine + UI dev server → http://localhost:5173
npm run dev:rust       # same, but running the Rust core
npm run app:dev        # Tauri desktop window (Rust core inside)
npm run app:build      # → target/release/bundle/macos/LIGHT.app
npm start              # headless gig mode: Node engine serves the built UI on :9900
npm run start:rust     # same, on the Rust core (LAN devices can open http://<mac-ip>:9900)
```

Tests: `npm test` (Node engine), `cargo test -p light-core` (Rust core),
`npm run test:parity` (differential).

## Resolume setup (once)

Arena ▸ Preferences ▸ OSC → **enable OSC Output**, host `127.0.0.1`, port
**7700**. Then:

- Launching an Arena **column** fires the matching LIGHT column (cue).
- Arena's **BPM** drives all LIGHT effects (tempo slider is followed live).
- Extra addresses for custom mappings: `/light/bpm` (float),
  `/light/column` (int, 1-based), `/light/blackout` (0/1).

## Concepts

- **Layers × columns grid.** Rows are layers (WASH → DERBY → FX → STROBE),
  cells hold looks. Clicking a cell fires it with a crossfade; a **column** is
  a cue — it fires every layer's cell and clears layers with empty cells
  (flash looks are skipped so a cue can never latch a blinder).
- **Blend modes.** `normal` = replace, `multiply` = modulate the wash below
  (chases/pulses), `htp` = highest wins (strobes/blinders).
- **Effects** run in beats (sine, triangle, saws, square, chase, random) with
  size / phase-spread / width per fixture group — tempo from tap, drag, or
  Resolume.
- **Flash looks** are momentary: held while the mouse button / MIDI note is
  down.
- **MIDI learn**: arm *MIDI LEARN* in the top bar, click any cell, column
  header, or fader, then touch your controller. Mappings live in the project.
- **Patch** (Fixtures tab): profiles for the Aug 2026 rig are built in —
  Varytec LED Derby ST 4CH (macro-colour table from the QLC+ definition),
  KAM Partybar WFS 20CH, hazer 2CH — plus generic dimmer / RGB / RGBW /
  moving-head profiles. Drag fixtures in the 2D previz to place them.
- **Output** tab: per-universe Art-Net / sACN toggles, unicast or broadcast,
  engine health (refresh rate, tick jitter), live DMX meters.

Default patch (Universe 1 on the node): Derby1 @001 · Derby2 @011 ·
Bar1 @021 · Bar2 @051 · Hazer @101. Project autosaves to
`projects/default.project.json` (with rotating `.bak` copies); in the bundled
app it lives in `~/Library/Application Support/LIGHT/projects/`.

## Keyboard

`1‑8` columns · `T` tap tempo · `B` blackout · `⌘S` save · `Esc` deselect

## Roadmap

- Ableton Link tempo sync (Arena supports Link natively)
- Fixture profile editor + more built-ins; 16-bit pan/tilt fades
- Cue-list / chase sequencer per cell; per-cell fade overrides in the grid UI
- MIDI feedback (controller LEDs mirroring active cells)
- Art-Net poll/reply + per-node discovery; sACN priority per universe
