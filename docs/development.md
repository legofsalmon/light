# Development

Building, testing, and extending LIGHT.

## Prerequisites

- **Node.js ≥ 23.6** (the Node engine runs TypeScript directly via type stripping; developed on 25.x)
- **Rust stable** (`rustup`, any recent stable) for the core, parity test, and app
- **Xcode Command Line Tools** (macOS builds)

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Node engine (`--watch`) + Vite UI → http://localhost:5173 |
| `npm run dev:rust` | Same, but the Rust core is the engine |
| `npm run build` | Production UI bundle → `ui/dist` |
| `npm start` | Gig mode: Node engine serves the built UI on :9900 |
| `npm run start:rust` | Gig mode on the Rust core (release build) |
| `npm run app:dev` | Tauri window + Vite dev server |
| `npm run app:build` | `LIGHT.app` → `target/release/bundle/macos/` |
| `npm test` | Node engine smoke suite |
| `cargo test -p light-core` | Rust core suite (same checks + protocol shapes) |
| `npm run test:parity` | **Differential test: both engines, byte-identical DMX** |
| `npm run typecheck` | `tsc` over engine+shared and ui |

## Repo layout

```
shared/     TS data model + fixture profiles + effect maths (engine + UI)
engine/     Node reference engine (+ test/smoke.ts, test/diff.ts)
core/       Rust core: same behaviour, same protocol (+ tests/smoke.rs)
ui/         React app (Vite): grid, editors, previz
src-tauri/  Tauri 2 shell (engine thread + window)
site/       Static landing page (point Vercel at this folder)
docs/       You are here
```

## The rules that keep it reliable

1. **Both engines or neither.** Any behavioural change lands in `engine/` (TS) *and* `core/` (Rust), with the parity test green before merge. If you only prototype in one, gate it off in the other — never let them silently diverge.
2. **Erasable TypeScript only** in `engine/` and `shared/` — Node runs these files raw with types stripped: no `enum`, no constructor parameter properties, no namespaces; type-only imports must use `import type`. (`ui/` is bundled by Vite and has no such restriction, but keeps the same style.)
3. **Nothing blocking on the tick path.** The 25 ms loop must not touch fs/network-blocking calls; persistence is debounced and atomic.
4. **The protocol is the contract.** `shared/types.ts` and `core/src/types.rs` are mirrors; change them together (serde uses camelCase renames + `skip_serializing_if` to match TS optionals exactly). `protocol_json_shapes` in `core/tests/smoke.rs` pins the encoding.

## Adding a fixture profile (until GDTF lands)

1. **`shared/profiles.ts`** — add a `Profile` with `heads` (kind + previz offset), `channelNames`, `beamDeg`, and a `render(heads, buf, base)` that writes DMX bytes from `ResolvedParams`.
2. **`core/src/profiles.rs`** — port the same profile: a `HeadDef` slice, a render fn, an entry in `PROFILES`. Keep byte-for-byte identical maths (`b255`, `strobe_byte` helpers exist in both).
3. Add a case to both smoke suites asserting a known param set produces known bytes, and (if the fixture ships in the default project) extend `engine/test/diff.ts`.
4. UI needs nothing: profiles appear in the patch dropdown automatically; the previz renders from `heads[].kind` + `beamDeg`.

The v0.4 roadmap milestone replaces this dance with data-driven GDTF profiles interpreted by one shared implementation — see [ROADMAP.md](../ROADMAP.md).

## Adding a protocol command end-to-end

1. `shared/types.ts` — add the variant to `Command`.
2. `engine/index.ts` — handle it in `handleCommand` (state mutations live in `engine/state.ts`).
3. `core/src/types.rs` — mirror the variant (`rename_all = "camelCase"` handles field names).
4. `core/src/state.rs` — handle it in `handle_command`, returning an `Outcome` if it changed the project.
5. UI — send it via `useStore().send(...)`.
6. Tests: exercise it in both smoke suites; add a parity checkpoint if it affects DMX.

## Testing notes

- `engine/test/diff.ts` boots both engines on side ports (9901/9902) with network output disabled and compares snapshots — extend its command script when you add DMX-affecting features. It needs `cargo build -p light-core` first.
- The Node smoke test binds UDP :6454 for the Art-Net loopback check and skips gracefully if something else (another Art-Net tool) holds the port; same for the Rust suite.
- Effects are deterministic (integrated beat + hashed sample-and-hold), so assertions sample *off* whole beats where waveforms sit at extremes.

## Tauri app

`src-tauri/` is a thin shell: `main.rs` spawns the engine thread and opens the window; the window is just a WS client like any browser. Icons regenerate with `npx tauri icon src-tauri/icons/icon-source.png` (source rendered from `icon.svg`). `npm run app:build` produces an ad-hoc-signed `.app`; distribution signing/notarisation is not set up yet.

**`"dragDropEnabled": false` in `tauri.conf.json` is load-bearing, and JSON cannot hold the comment that says so.** It defaults to *true*, which makes Tauri install its own OS drag-drop handler on the webview; wry's handler returns `true` without falling through to `super`, so WKWebView never processes the drag and no `dragenter`/`dragover`/`drop` ever reaches the page. That kills HTML5 drag-and-drop in the shipped app while leaving it working in a browser — which is where the UI is usually tested, so the failure is invisible until someone drags a look onto a pad in the real `.app`. Nothing here uses OS file-drop, so turning it off costs nothing. Anything drag-and-drop must be checked in the built app, not only at `:5173`.

## Native previz

`previz/` is a Bevy app and a plain WebSocket client of the engine — it observes
and never commands, so nothing it does can reach DMX.

Working on it:

- `cargo build -p light-previz` then `./target/debug/light-previz`. The dev
  profile optimises dependencies and not our code (`[profile.dev.package."*"]`),
  so once Bevy is cached a rebuild is **about two seconds** against five minutes
  for release. Do all iteration there.
- **F12 saves a PNG**, and `LIGHT_PREVIZ_SHOT=<path>` saves two automatically a
  few seconds in. Use these rather than the OS screen recorder: they need no
  permission and they capture the window rather than the desktop.
- `LIGHT_PREVIZ_DIAG=1` logs frame time plus a render-state line every two
  seconds — fixture count, live spotlights, panel lights, fog density, haze —
  so a dark window can be diagnosed from the terminal.
- `LIGHT_PREVIZ_CAM=yaw,pitch,dist[,tx,ty,tz]` places the camera at startup.
  Screenshots are how you judge this thing, and without it every screenshot came
  from the same default viewpoint — half of them framing empty air, because on
  an arena plot the rig hangs above where the default camera looks. Setting it
  also *claims* the camera, so the automatic first framing leaves your shot
  alone.
- `previz/src/quality.rs` holds every knob that trades frame time for picture
  (MSAA, fog steps, shadow budget, exposure, flux, haze floor, beam gain,
  adaptation, truss) as `LIGHT_PREVIZ_*` variables. They exist because a release
  build is five minutes and a `const` is not a knob anybody turns twice.

Shadow maps are dealt PER FRAME by `update::allocate_shadows`, round-robin
across fixture groups, to the lights that are actually lit. They used to be
handed out in patch order at scene build, which on a real rig gave every slot to
one or two fixture types and left the rest casting nothing — measured by
differencing shadows-on against shadows-off per group, three of the four groups
the show actually fires changed 0.00 % of the frame. Two things make the
per-frame version cheap, and both were assumed to be the opposite: bevy's
shadow-pass pipeline key carries no light identity, so toggling can never cause
a shader compile; and a light hidden with `Visibility::Hidden` is dropped by
`extract_lights` before clustering, before the shadow count and before the atlas
allocation, so the old budget was being reserved for darkness.

Measure from a FIXED camera. The tiers read 11.5 / 20.2 / 44.2 ms from the shot
the window now opens on and 13.9 / 31.3 / 69.8 ms from the old close default,
for the same build — beams are fill, and fill is most of the frame time, so the
viewpoint is worth more than most of the knobs. Any before/after number without
`LIGHT_PREVIZ_CAM` pinned is measuring the camera.

### What is drawn, and what is inferred

Fixture geometry comes from the compiled profile's `FixtureForm`, which the
operator can override per profile in the patch table. A mover is articulated —
base, yoke, tilting barrel, lens — and the aim splits across the yoke and the
shell, so the body swings with the beam. Everything else gets a body frame
turned to face where its light goes, with the emitters on the front face.

A performer's height is inferred too, and for the same reason. A stage prop's
`y` is structural-only — `sanitizeProject` deletes it from performers and should
keep doing so — so `standingHeightAt` (shared/beamThrow.ts) reads the height off
whichever riser the performer is standing inside, and `floor_height_at`
(previz/src/scene.rs) is its twin.

Those two are hand-copied into different languages with no parity test between
them, so their CASES live in one file both sides load:
`shared/testdata/standingHeight.json`. Add a case there and it runs in
`engine/test/smoke.ts` and in the Rust unit tests at once. That is the only
thing standing between the two previz windows and a slow drift apart — do not
add a case to one side only.

**Truss is inferred, not imported.** The project file has no truss in it, so
`previz/src/truss.rs` reads it off the hang: three or more fixtures sharing a
height and a depth over at least a metre and a half. A run breaks wherever a
hole opens up that is several times wider than the fixture spacing around it —
which is the only rule that both keeps a sparse front truss whole and refuses to
join two side-fill wings eighteen metres apart. `LIGHT_PREVIZ_TRUSS=0` turns it
off; when MVR geometry import lands, real truss should replace it.

Debug it by bisecting with the shader, not by reasoning at it. Returning a flat
colour early answers "does this rasterize at all", then "did the uniform
arrive", and so on. That is how a placeholder `lumens: 0.0` was found after an
hour of the beams simply not existing.

## Release checklist

1. `npm test` · `cargo test -p light-core` · `npm run typecheck` · `npm run test:parity` — all green.
2. `npm run build` then `npm run app:build`.
3. **`cargo build --release -p light-previz`.** The PREVIZ button launches a
   PREBUILT binary (`spawn_previz` in `core/src/engine.rs`) and never compiles
   anything, so a stale one just quietly opens old code. This cost a real
   evening once: goalposts that had been deleted from the source were still on
   screen, along with eight days of beam, camera and aiming fixes that had
   never been seen. The engine now warns in its toast when the binary predates
   `previz/src`, but only beside a source tree — a shipped app has no such
   check, so the build has to happen here.
4. Launch the `.app`, fire a column, watch the Art-Net counter and a real node.
   Drag a look from the library onto a pad while you are there — HTML5
   drag-and-drop is the one thing a browser check cannot vouch for (above).
5. Open the previz window and fire a beam cue. It is a separate binary with its
   own renderer and none of the suites touch it.
6. Tag, push, update `ROADMAP.md` checkboxes.
