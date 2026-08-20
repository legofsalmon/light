# Parked work

Items from the v1.2.2 full review that are deliberately **not** done yet, with
enough detail to pick up cold. Everything here was confirmed against the code by
an adversarial verifier — these are real, not speculative.

Full review: <https://claude.ai/code/artifact/a877b38b-6309-46b8-ac5f-bfbb9963bd4a>

Done so far on `show-safety-v1.2.3`: Stage 1 (show safety) and most of Stage 2
(protocol correctness + UI scale). See `git log` from `4ccd150` onward.

---

## 1. Per-client snapshot content — DMX opt-in and previewHeads targeting

**Why parked:** the snapshot is currently built once per tick and broadcast as
one JSON string to every client (`Broadcaster::broadcast` in
`core/src/server.rs`, `server.broadcast` in `engine/server.ts`). Making the
content differ per client is an architectural change to the broadcast path in
*both* engines, and it needs its own parity coverage. It did not belong bolted
onto the protocol pass.

**Measured, on the 129-fixture / 7-universe arena show** (scratch engine, outputs
off): **28.5 KB per snapshot, 20 fps → ~556 KB/s per client.** Composition:

| part | bytes | note |
|---|---|---|
| `heads` | ~17.0 KB | ~200–260 heads × 10 floats |
| `dmx` | ~8.1 KB | all 7 universes, every tick |
| everything else | ~0.4 KB | layers, stats, bpm, flags |

Head-float rounding (commit `3520e4a`) already caps the *crossfade peak*; these
two items are the *sustained* rate.

### 1a. Make `dmx` opt-in per client
Only `OutputView`'s DmxMeters reads `snap.dmx`, one universe at a time, and only
while the Output tab is open — yet all 7 universes ship 20×/s to every client
including the previz and the tablet.

- Add a `watchDmx { universeId | null }` command; the engine remembers it per
  client and includes only that buffer for that client (`null` = none).
- Sites: `build_snapshot` (`core/src/engine.rs:~840-852`), the Node twin
  (`engine/index.ts:~650-665`), `Snapshot.dmx` in `shared/types.ts:~509` (no
  skip attribute today), and the UI's `OutputView` to send the subscription on
  mount/unmount and universe change.
- Cheaper interim if per-client proves invasive: base64 the buffers (512 bytes →
  683 chars vs ~1.5–2 KB of JSON number array). Roughly 3× on the dmx portion
  with **no** per-client machinery — a good first step.
- **Parity note:** `engine/test/diff.ts`'s `compareDmx` reads `snap.dmx` for
  every universe. If dmx becomes opt-in, the harness clients must subscribe to
  all universes or the comparison silently compares nothing. This is the main
  trap in this item.

### 1b. Send `previewHeads` only to the auditioning client
`state.preview_look` is set by *any* cell selection (`store.ts` `setSel` →
`previewLook`) and stays set, so the audition head set — which roughly doubles
the head payload — is broadcast to every client indefinitely.

- Track which client requested the preview and include `previewHeads` only for
  that client.
- Related, and worth doing at the same time: the audition pane never clears
  `sel`, so the preview stays alive after editing (see item 4 — the second
  WebGL context leak). Clearing `sel` when the editor is left fixes both the
  bandwidth and the context churn.

---

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

## 3. Remaining low-severity findings (not yet triaged into a stage)

Each was verified; none is show-critical.

**Operator / UI**
- Delete-look blast-radius scan reads only stored deck copies, so a look used
  only in the *current* song deletes with no warning — `LookEditor.tsx:562`;
  include `layers[].cells`.
- Deck stepping wraps at both ends (`App.tsx:100` + both engines' `deck_step`);
  consoles clamp. Bank ▶ past the last song silently lands on song 1.
- `bump` in `OutputView.tsx:237` uses mouse events, so press-and-hold is dead on
  the tablet; column rename is right-click-only, unreachable on touch.
- Column tooltips promise `key N` for every N but only 1–9 are mapped
  (`LookGrid.tsx:424`); user guide says 1–8.
- `AddressInput` / `BeatsInput` / fixture-name input lack the focused-edit guard
  the other inputs have (`PatchView.tsx:95`) — a project echo can clobber
  mid-typing.
- `var(--bad)` is referenced in `ShareFixtures.tsx:356` but defined nowhere, so
  Share errors render in default grey; use `--hot`.
- Deleting a structure strands `parentId` on fixtures rigged to it
  (`PatchView.tsx:1104`) — the Rigged-on column silently blanks.
- "Along the bar" scrub edits one fixture despite the multi-edit promise in the
  table legend (`PatchView.tsx:333`).
- Layer heads and column headers scroll out of view on wide grids; no
  `position: sticky` (`theme.css:296`).

**Engine / shell**
- No cap on client connections; one OS thread per socket, and half-open sockets
  hold a thread through the 600 ms peek loop (`core/src/server.rs:153`).
- Unbounded work from wire commands: a thread spawned per import with no
  in-flight cap, and an unbounded engine mpsc (`engine.rs:553`, `:151`).
  Partially mitigated by the depth guard, not by a bound.
- Five Tauri commands are synchronous on the main thread; `share_search`
  re-reads and re-parses the 6.4 MB catalogue per keystroke
  (`src-tauri/src/share.rs:393`) — declare them `async`, cache the parse.
- Catalogue cache written with a bare `fs::write` — no tmp+rename, unlike the
  project persist path (`share.rs:212`).
- `share_login` persists the username before the password, so a Keychain failure
  strands a half-saved sign-in (`share.rs:346`).
- `listProjects` parses every saved project on every client connect, on the tick
  thread (`engine/persist.ts:86`).
- `flushPending` splices the offline queue before checking `readyState`
  (`store.ts:365`) — a disconnect race can drop queued edits.
- Browser APC LED attach never clears note 81, leaving a stale "blackout armed"
  blink (`apcFeedback.ts:91`); Rust clears 81–86.
- On a moved port the window is navigated to `http://127.0.0.1:<alt>` — a
  non-app origin with no IPC capability configured — so GDTF Share and the local
  fixture library silently vanish (`src-tauri/src/main.rs:216`). Needs a
  capability for `http://127.0.0.1:*`, or deliver the port without navigating.

**Rust tick-path hygiene** (measured safe today — tick is 7.9–9.8 µs against a
25 ms budget — but worth doing before per-head work grows)
- Per-tick `Layer` clones and String-keyed head maps (`renderer.rs:260`).
- `Broadcaster` copies the whole snapshot string per client inside the clients
  mutex; `Arc<str>` would make it one allocation (`server.rs:56`).
- Native previz clones the whole snapshot per frame and never prunes its
  smoothed map (`previz/src/update.rs:90`).
- Every UI edit `structuredClone`s the whole project twice (`store.ts:250`).

---

## 4. Stage 3 — done

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

## 5. Stages 4–5 (upcoming)

Stage 4 (previz quality: bloom/tonemapping, camera bookmarks, soft-falloff beam
shader, quality tiers, Bevy 0.19, DLSS on PC / MetalFX on macOS) and Stage 5
(features: audio-reactivity, Art-Net HTP merge, MVR geometry, Link-clock
timelines) are described in the review artifact.
