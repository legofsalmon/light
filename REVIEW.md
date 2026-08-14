# Code review — LIGHT

Living record, newest pass first. Each dated entry states its method, what it
verified by execution, and what it left open.

---

# 2026-08-14 — post-v0.5 pass (commit `4778229`)

**Scope:** everything again, weighted toward the four commits that landed after the
v0.5 review and had never been reviewed — `902ef67` (cue lists, Ableton Link, patch
bulk ops), `b04f6f1` (APC40 LED feedback), `8ee2c6b` (undo/redo, universe editor,
Art-Net discovery, project management), `4778229` (patch scrub inputs, multi-fixture
edit, camera memory, stage props).

## Method

Seven subsystem passes (Rust render/state, Rust I/O and protocol, Node engine and
parity, UI, previz, profile/GDTF/MVR pipeline, build/CI/docs/hygiene), each required
to construct a concrete failure scenario and to attempt to refute its own findings
before reporting. Findings marked **verified** below were reproduced by running code
against the real engine, not argued from reading.

Standing suites re-run on this checkout: `npm run typecheck` clean, `npm test` 23/23,
`cargo test -p light-core` 18/18, `npm run test:parity` byte-identical. Building
`light-core` on Linux needs `libasound2-dev`.

**The v0.5 pass's fixes are real.** Its four headline criticals were re-verified by
execution: the OSC barrage (15 hostile packets) leaves the clock and effects intact;
a corrupt project is recovered from `.bak1` and preserved aside as
`.corrupt-<ts>`; a held blinder releases when its holder dies; `clamp` is NaN-safe
and identical in both engines. Two of its *claims*, however, are inaccurate — see
N2 and R6.

**Sustained load is genuinely well defended.** A 90 s release-build soak (747 live
commands, 107 client-churn cycles) held frame gaps at p50 25.0 ms / p99 25.8 ms with
zero gaps over 100 ms and 820 KB RSS growth. A separate chaos pass — 480
connect/disconnect cycles plus 13 hostile payloads including a 2 MB frame and a null
project — produced no output stalls. The findings below are specific, not systemic.

## Show-stoppers

| # | Sev | Finding | Where |
|---|---|---|---|
| **C1** | **Critical** | **One unauthenticated WS message kills the engine.** `f.address - 1 + prof.channels() > 512` wraps for an address near `usize::MAX`; the guard passes and the renderer indexes a 512-byte buffer near 2^64. **Verified:** exit code 101, `panicked at profiles.rs:84 … index is 18446744073709551614`, backtrace `render_derby → Renderer::tick → engine::run`. Server binds `0.0.0.0:9900` with no auth, and a corrupt project file reaches the same place (no `sanitizeProject` equivalent on the Rust side). Node is unaffected — float64 makes the comparison true. | `core/src/renderer.rs:392`, `core/src/profiles.rs:84` |
| **C2** | **Critical** | **A 21 KB import file aborts the packaged app.** `roxmltree` recurses per nesting level with no element-depth limit. The Tauri shell starts the engine on a plain `std::thread::spawn` (2 MiB stack), so ~2 750 levels ≈ 21 KB overflows it. **Verified:** `fatal runtime error: stack overflow, aborting` — a `SIGABRT`, so `catch_unwind` never sees it and the deliberate "exit visibly" path never runs. Art-Net just stops. | `core/src/mvr.rs:163`, `core/src/gdtf.rs:62`, `src-tauri/src/main.rs:8` |
| **C3** | **Critical** | **An imported profile can drive another fixture's channels.** `footprint` is taken from GDTF `Offset` uncapped, so `Offset="18446744073709551615"` gives `footprint = usize::MAX`. **Verified** from a 1.3 KB `.mvr` (MVR auto-patches): debug panics on the next tick at `renderer.rs:392`; release wraps, bypasses the guard, and `render_compiled(base=2, offset=usize::MAX-1)` wrote `buf[0] = 255` — Derby 1's macro channel. `usize` is 32-bit under wasm32, so the two engines don't even agree on the compiled profile. | `core/src/gdtf.rs:117`, `core/src/cprofile.rs:219` |
| **C4** | **Critical** | **A spec-valid colour wheel underflows the band maths.** Band ends use `next.saturating_sub(1)` but the following `to - from` is unguarded, so two `ChannelSet`s sharing a `DMXFrom` underflow `u32`. GDTF's `ModeMaster` exists precisely so several `ChannelFunction`s share a DMX range, and the code flattens all of them into one sorted list — duplicates are guaranteed. **Verified:** debug panics at `gdtf.rs:372` (on the render thread, so the app quits); release emits `band 24..23 value=255 name=Red` — asking for red transmits "spin, fastest". | `core/src/gdtf.rs:317, :372` |
| **C5** | **Critical** | **An Arena column past LIGHT's last column blacks out the rig.** `cells.get(col) == None` from an out-of-range index is treated as "empty cell", which means *clear the layer*. LIGHT ships 8 columns; Arena compositions routinely have more, and column launches are the primary integration. **Verified:** an active look goes `dimmer 1.0 → 0.0` after `trigger_column(12)` on an 8-column project. The v0.5 pass fixed the mirror image (`col < 1`) and missed this side. | `core/src/state.rs:261`, `core/src/engine.rs:497`, `engine/state.ts:142` |
| **C6** | **Critical** | **A held blinder latches ON when the cell changes underneath it.** `release` re-derives what was pressed from the *current* grid instead of acting on `live.held`; the UI also only sends the release `if look?.flash` against the current cell. `switch_deck` deliberately leaves live state alone. **Verified** through raw MIDI with the shipped APC40 preset: note-on 32 (hold pad) → note-on 96 (bank ▶ = `deckNext`) → note-off 32 → DMX ch400 stays 255 after 10 s, `live.held` still true. Undo and a second client editing the grid reach the same state. Both engines. | `core/src/state.rs:201`, `ui/src/components/LookGrid.tsx:40`, `engine/state.ts:63` |
| **C7** | **Critical** | **Closing the previz drops a flash look the operator is still holding** — the exact dual of C6. The engine releases *all* held flashes on *any* disconnect, which was sound when every client was a UI window. **Verified:** operator holds the blinder and stays connected; a passive client connects, sends nothing, closes cleanly; ch4/ch14 go 220 → 0 mid-hold. Violates the ROADMAP invariant that previz/UI clients can disconnect "without touching output". | `core/src/engine.rs:473`, `core/src/state.rs:238`, `engine/index.ts:143` |
| **C8** | **Critical** | **Patch scrubbing silently reverts, and a multi-selection collapses onto one old value.** The draft-sync effect skips while focused, and mousedown focuses the field before the 4 px scrub threshold, so `draft` stays frozen at the pre-drag string. `onUp` then calls `el.blur()`, `onBlur={commit}` fires, and `commit()` writes that stale value back with no `v !== value` guard. With ten fixtures selected, release writes the dragged row's *original* value into all ten. Clearing a field writes `0` (`Number('') === 0`). | `ui/src/components/inputs.tsx:104, :109, :144, :162` |
| **C9** | **Critical** | **An ArtPollReply flood grows an uncapped map the render thread then sorts.** Inserts are keyed by source IP with no cap, no rate limit and no check that we polled; `nodes_snapshot()` clones and sorts the whole map *before* `truncate(8)`, on the render thread at 20 Hz. **Measured:** 50k sources → 27.2 ms; 150k → 106.8 ms; 250k → 215.1 ms against a 25 ms budget. Needs a hostile or badly broken host on the show LAN, but the fix is one line at the insert site. | `core/src/artnet.rs:133, :153`, `core/src/engine.rs:553` |

## Majors

| # | Finding | Where |
|---|---|---|
| **N1** | **A prototype-key `profileId` stops all Node output.** `PROFILES` is `Object.fromEntries`, so `PROFILES["constructor"]` is truthy, `.channels` is `undefined`, `base + undefined > 512` is false, and `prof.heads.map` throws inside the tick — before `artnet.send`. **Verified.** The loop guard reschedules, so the process survives and the WS server keeps answering while no packet is ever sent again: the rig holds its last frame and the engine looks alive. `sanitizeProject` never validates `profileId`. | `shared/profiles.ts:217`, `engine/renderer.ts:251` |
| **N2** | **The Node engine resolves DNS on the 40 Hz path for sACN.** `engine/artnet.ts:59` checks `net.isIP` and `core/src/sacn.rs:69` parses `Ipv4Addr`, but the Node sACN path passes the unicast string straight to `dgram.send` — so REVIEW's "IP literals only in **both** engines" is false. A hostname resolves 40×/s on the libuv pool (shared with UI serving and autosave); a half-typed `192.168.1` is accepted by `getaddrinfo` as `192.168.0.1`, so sACN goes to a real *wrong* host while Art-Net correctly falls back to broadcast. | `engine/sacn.ts:68` |
| **N3** | **Listing projects parses every show file on the tick thread.** `list_projects` runs `serde_json::from_str` over every `*.project.json` just to read `name`, inside `handle_msg` — before the tick and before `artnet.send`. **Measured** (205 fixtures, 376 KiB/file): 12 shows → 24.9 ms, 25 shows → 50.1 ms, 12 large-GDTF shows → 84 ms. The UI requests it on every WS connect and reconnects on a 1 s timer, so a tablet on flaky Wi-Fi hitches output continuously. | `core/src/engine.rs:371`, `core/src/persist.rs:85` |
| **N4** | **Undo/redo restores live performance state.** Layer masters, haze, learned MIDI mappings, `universes` and `sync` all live in the project and are written by the engine as the operator works, but undo replays a whole-project snapshot verbatim. **Verified:** snapshot at master 1.00/haze 0.00 → ride to 0.15/0.10 → ⌘Z → back to 1.00/0.00. Wash 15% to full in one frame from an unrelated undo; an undo can also silently re-route or disable output. `entryUsable` guards project identity, not staleness. | `ui/src/store.ts:102, :155`, `core/src/state.rs:407` |
| **N5** | **Explicit save runs on the tick thread, and two savers race one temp file.** Only the debounced autosave moved to a worker; `save_requested` — set by ⌘S from any LAN client *and* by the Link toggle — does `create_dir_all`, a four-rename rotation, a full file copy, serialisation and a write inline. **Measured** 6.3 ms for a 2 MB post-import project on tmpfs. Both savers share one fixed `.tmp` path with nothing tracking a save in flight: pressing ⌘S inside the 1.2 s debounce made a save fail in **183/200 rounds**, and the autosave path only `eprintln!`s it, so the edit is silently lost. | `core/src/engine.rs:343`, `core/src/persist.rs:122, :144, :215` |
| **N6** | **A failed OSC rebind is never retried.** `stop()` only sets a flag; the listener holds the socket until its 400 ms read timeout, so toggling OSC off/on inside that window hits `EADDRINUSE`, and `ensure_osc` runs only on a project change. **Verified:** 5 msgs → toggle → 0 msgs, still 0 after 1.5 s, revived only by an unrelated edit. The snapshot carries Art-Net and Link health but has no OSC liveness field, so the UI still shows OSC enabled while Resolume sync is dead. | `core/src/osc.rs:133`, `core/src/engine.rs:47` |
| **N7** | **Importing a fixture freezes DMX for the parse duration.** **Measured** on release against a 32 ms baseline: 1.3 MB GDTF → 81 ms gap (~3 ticks); 10.7 MB → 379 ms (~15 ticks). Debug is far worse (967 ms; 5.8 s at 54 MB). `tungstenite::accept` takes defaults, so inbound is capped only at 64 MiB. REVIEW accepted this as "~40 µs synthetic but unbounded" — the real magnitude is ~0.4 s for a 10 MB file, from an ordinary operator action. | `core/src/state.rs:582, :602`, `core/src/server.rs:112` |
| **N8** | **Zip bombs are unbounded.** Neither importer limits decompression. **Verified:** a 510 KB `.gdtf` inflating 1000:1 allocated 512 MB and froze the render thread for **35 s**; a 10 MB upload is a 10 GB allocation → OOM kill. MVR is worse — it reads every embedded `.gdtf` into memory and holds them all. `Read::take` on each entry is the whole fix. | `core/src/gdtf.rs:17`, `core/src/mvr.rs:147` |
| **N9** | **Malformed `DMXValue` byte counts panic.** `(width - stated) * 8` with `stated ≥ 5` gives a shift amount ≥ 32. **Verified:** `Default="10/5"` → `panicked at gdtf.rs:30 — attempt to shift right with overflow`. `stated` is unbounded, so the multiply overflows `i32` first for large values; release masks the shift and produces wrong defaults. Legal byte counts are 1–4. | `core/src/gdtf.rs:25` |
| **N10** | **APC hot-plug rescan runs on the render thread** every 3 s while no controller is attached: `MIDIClientCreate`, destination enumeration and a per-port string property fetch, each a Mach IPC round trip, with the discarded client's disposal broadcasting `kMIDIMsgSetupChanged` machine-wide. `core/src/midi.rs:11` does the equivalent scan on its own thread. A failed send sets `conn = None`, so an unplug mid-show enters this cycle exactly when CoreMIDI is slowest. Placement is proven; magnitude unmeasured on Linux. | `core/src/apc.rs:188, :220`, `core/src/engine.rs:229` |

### Silently wrong imports (all verified)

- **`ChannelSet@WheelSlotIndex` is never read** (`core/src/gdtf.rs:365`), so slots pair with bands by position. Real wheels interleave split positions, so on an Open/Red/Green/Blue wheel red emitted Open/Red's value, green emitted Red's, blue emitted Red/Green's — every colour one slot off, previz colours mislabelled to match. Bands past the slot list get a white fallback *and* `auto: true`, so wheel-spin ranges become selectable "white".
- **`DMXBreak` is ignored** (`core/src/gdtf.rs:112`). A two-break fixture compiles to `footprint = 2` with both breaks aliased onto the same slots; the later channel wins, so dimmer and pan never reach the fixture.
- **3/4-byte channels are dropped *before* the footprint update** (`core/src/gdtf.rs:123`), so a fixture with 24-bit pan reports `footprint = 1` while occupying 4 slots. `ui/src/profileInfo.ts:34` uses that for overlap detection and next-free-address, so the next fixture is patched on top — invisibly, since MVR auto-patches.
- **MVR `universe.channel` is one universe off** relative to the absolute form (`core/src/mvr.rs:125`): `513` correctly maps to wire universe 1, but `2.25` maps to 2. Two fixtures in the same MVR universe land in different LIGHT universes depending only on the exporter's notation, and `apply_mvr` auto-creates both. `core/tests/mvr_import.rs:74, :81` asserts both values, so the test locks the bug in — correcting it is part of the fix.
- **Profile-id slug collisions** (`core/src/gdtf.rs:271`): modes `"8 Ch"` and `"8-Ch"` both slugify to one id, so a fixture matched against the first mode is patched with the second's channel layout.
- **16-bit wheel channels collapse to 8 bits** (`WheelSet` fields are `u8`), so a 16-bit wheel always sits in the bottom 1/256 of its range.
- **Only the first `LogicalChannel` of a `DMXChannel` is read** (`core/src/gdtf.rs:131`): a `NoFeature`-then-`Dimmer` channel holds its default forever and sets `virtual_dimmer`, so the fixture never comes up.

## Parity: the guarantee is narrower than the invariant claims

`npm run test:parity` genuinely passes byte-identically, and the cue-list section is
careful work. But ROADMAP's "anything that renders DMX is implemented once or tested
differentially" does not hold today.

- **Effects have zero differential coverage, and structurally cannot have any.** No look
  fired by the harness carries an effect; the whole `layer-fx` row is never triggered.
  `effBeat` is integrated from each engine's own first tick, so absolute phase differs
  permanently and *any* effect look would diverge by design. Cue lists only work because
  they use a *difference* from an anchor. Needs a hook to set `effBeat` absolutely.
- **Crossfades are only ever sampled at their endpoints** (the harness comments say so),
  where the weighted-source blend degenerates to a single source. The accepted "derby
  macro pops at fade end" bug lives in exactly that untested arithmetic.
- **Only universe `u1` is compared** (`engine/test/diff.ts:72`). Complete by luck today,
  but the universe editor and MVR import both create more — and after the MVR import the
  harness compares patch *shape* only, never the imported fixtures' DMX bytes.
- **No OSC is ever sent**, and no MIDI, decks, `setSpeed`, `setLayerMaster`, `resync`,
  `setLink`, or client-disconnect. Two of the proven divergences below sit in exactly
  those paths.
- **`sanitizeProject` repairs; serde is all-or-nothing.** Node rejects `version: 2` while
  Rust accepts it; Node repairs a look with no `parts` while Rust drops the whole command.
  The day a v2 file exists the engines take opposite decisions and nothing says so.

**Proven divergences.** (1) In the `random` waveform, JS `Math.floor(phase)|0` wraps mod
2^32 while Rust `phase.floor() as i32` saturates — `phase=3e9` gives hash `0.139666182`
vs `0.800063099`. Nothing validates an effect's `rate` or `phase`, so a small rate
reaches this in seconds. (2) A cue step naming an inherited prototype key is dropped by
Node but kept and rendered dark by Rust, so a two-step cue totals 4 beats in one engine
and 8 in the other.

**The default projects have already drifted:** 8 differing leaves, every derby and bar
fixture's `x` and `z`, contradicting `core/src/defaults.rs:3` ("the exact JSON the Node
reference engine generates"). Previz-only impact, but the harness writes the *Node*
default into both engines' directories, so it can never detect drift of any kind here.

## Previz

Architecturally sound — a read-only client with no reachable panics and no way to
back-pressure the tick (C7 is the sole path back into the show). Its real risk is that an
operator rehearses against it, and it currently lies four ways:

- **Derbies fade on screen and snap on the rig.** The fixture has no dimmer channel —
  `render_derby` gates at `dimmer > 0.02` — but the snapshot reports the raw dimmer, so
  all three views ramp a fade that fires as a hard on. Two derbies are 40% of the rig.
- **The 2D plan mirrors `rotY`** relative to both 3D views (`+sin θ` where a right-handed
  Y-up frame needs `−sin θ`), and alt-drag rotate writes the screen-space angle straight in.
- **Moving heads never move** natively — `pan`/`tilt` arrive and are deserialised but never
  read. The browser view implements them.
- **Fog tracks the haze slider, not the hazer's resolved output**, so a haze-burst look
  pumps the real hazer while previz fog sits at its floor. The `haze_k` floor is also
  non-zero, so beams stay 10% visible on a dry stage.

Also: floor-standing fixtures aim ~70° apart between the two 3D views, and the browser band
leaks geometry on every props change (`Previz3D.tsx:350` omits the `disposeDeep` its sibling
rig path performs) — ~11 rebuilds/s while dragging a musician.

**v0.3 acceptance:** bloom, tonemapping, reflective floor, emissive sources, derby fans and
strobe gating all landed. Two headline claims did not — volumetric shafts are additive cone
geometry because Bevy 0.16.1's per-light volumetric term draws nothing on this Metal stack,
and persisted window state is absent (ironically the *browser* view persists its camera).
The 8.32 ms frame figure is vsync-locked at 120 Hz, so it cannot distinguish 8.2 ms of GPU
work from 1 ms.

## Repo, CI and docs

| # | Finding |
|---|---|
| **R1** | **There is no LICENSE** — no file, no `license` field in any of the six manifests — while `site/index.html:143` says "Free · Open source" and the og:description says "Free and open source". Default is all rights reserved, so the claim is false and nobody can legally use the code. |
| **R2** | **CI compiles one crate of four.** `previz`, `src-tauri` and `profile-wasm` are never built by anything, yet `npm run app:build` starts with `cargo build --release -p light-previz`. `npm run build` (the UI bundle that ships inside the app) is never run either. |
| **R3** | **The WASM guarantee holds by discipline, not construction.** `profile-wasm/pkg/` is a tracked 434 KB binary that nothing rebuilds or verifies; CI does not even compile the crate. It *is* in sync today — verified byte-for-byte against the native interpreter over a 1 800-case sweep plus GDTF and MVR parses — but the only record of the build command is a string in a `console.error` at `engine/wasmProfiles.ts:33`, absent from `docs/development.md` including the release checklist. The one test that could catch drift is a single data point: change `cprofile.rs`'s desaturation threshold from 0.15 to 0.2 and CI stays green while every imported wheel fixture diverges. |
| **R4** | **`cargo clippy -p light-core` fails** with a deny-by-default error (`core/src/artnet.rs:170`, `*seq >= 255` on a `u8`) plus 14 warnings; `cargo fmt --check` reports 182 diffs across 30 files. Neither is gated. No JS/TS linter exists at all. `npm audit` is clean (169 deps). |
| **R5** | **macOS-only code is never compiled** — CI is ubuntu-only, so the `caffeinate` assertion (itself a v0.5 confirmed fix) and midir's CoreMIDI backend are never built, for a macOS-only product. |
| **R6** | **Four milestones ship as roadmap.** `README.md:97-101` still lists Ableton Link, cue lists, MIDI feedback and Art-Net discovery as future; `docs/architecture.md:8` says "native previz (planned)"; `docs/resolume-and-midi.md:40` says Link "is planned"; `ROADMAP.md:25` says "v0.2 — Publish *(current)*"; `ROADMAP.md:29` points at a "CI candidates" section that doesn't exist. `REVIEW.md:38` credits "the engine" with the caffeinate assertion when only the Rust core has it — while `README.md:47` offers `npm start` as headless gig mode. |
| **R7** | **`docs/architecture.md` is not "the complete protocol reference"** it claims: 9 of 26 commands, 3 events, 4 snapshot fields and 4 environment variables are missing, as are the `props`, `profiles`, `decks` and `activeDeckId` project keys. Cue lists, decks and undo appear in no user-facing doc. `docs/benchmarks.md:82` cites a `scratchpad/soak.sh` that isn't tracked; `:102` says 10 parity checkpoints where there are 17. |
| **R8** | **Tracked artefacts and a leaked link:** `__pycache__/*.pyc`, four generated `src-tauri/gen/schemas/*.json`, and `.claude/launch.json` (despite commit `34887af` "gitignore: exclude `.claude/` harness artifacts"). `qlcplus/README.md:3` links a private `claude.ai` artifact URL. No secrets or personal data found; both lockfiles committed. |
| **R9** | **Untested subsystems with zero coverage:** `persist` (where a v0.5 Critical fix lives), the WS server, sACN on the wire, Art-Net discovery, Link, MIDI, decks, project management, and the whole UI (no test runner at all). `core/src/apc.rs:11` asks for lockstep with `ui/src/apcFeedback.ts`; nothing compares them. |
| **R10** | **Smaller I/O items:** `openProject`'s slug reaches the filesystem unvalidated (`core/src/engine.rs:406`) while `current_slug` validates carefully — a traversal read, and `set_current_slug` then writes the raw string; Tauri `csp: null` (no live sink today); the Art-Net reply listener spins on any non-timeout error (`core/src/artnet.rs:117`); the WS accept loop dies permanently if `thread::spawn` ever fails (`core/src/server.rs:66`); the Tauri shell treats a *normal* `engine::run` return — e.g. port already bound — as success, producing exactly the zombie window it exists to prevent (`src-tauri/src/main.rs:8`). |

## What was checked and found correct

Reported so it isn't re-litigated: the DMX merge math (all three blend modes × three
master values, "masters only scale intensity" holds), crossfade weighting in all four
field combinations, cue-list stepping and `align_phase`, NaN containment end-to-end,
16-bit rounding, blackout ordering, the tick budget (11.8 µs default rig → 123.6 µs at
205 fixtures; under 0.6 ms of a 25 ms frame at 40× rig size), the single-owner
concurrency model (no races or deadlocks found), every sACN E1.31 and Art-Net ArtDmx
field against the specs, the OSC parser against malformed input, the WS ownership model
and its traversal guard, the Link tempo loop, the APC LED map vs its TS twin, the
built-in profiles vs the QLC+ definitions (all 17 derby bands and midpoints, KAM channel
order and head split, hazer), and the patch table's marquee gesture. Zip-slip and
billion-laughs were specifically attempted and are not reachable — neither importer
writes to disk, and `roxmltree` rejects DTDs.

## Suggested order

1. C1 and C5 — two small bounds fixes against a remote kill and a full-rig blackout.
2. C2, C3, C4, N8, N9 — import input guards; three of these are engine-down.
3. C6 + C7 together — attribute flash holds to a client and to the triggered look.
4. C8 — the scrub commit, protecting the patch from its own editor.
5. C9, N3, N5, N7 — get the remaining filesystem and unbounded work off the tick thread.
6. N1, N2 — and correct the two v0.5 claims that no longer hold.
7. R2, R3 — four lines of CI plus the `profile-wasm` provenance gate.
8. R1 — a LICENSE, or drop "open source" from the site.
9. Then the parity gaps and the wrong-import semantics, each with the test that would
   have caught it.

---

# 2026-08-13 — v0.5

**Scope:** everything — both engines, UI, previz, app shell, protocol, importers.

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
