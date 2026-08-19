# LIGHT — full app review, v1.2.2 (18 Aug 2026)

Nine subsystem finders over the whole codebase, then a skeptic pass instructed to
refute every non-minor finding. 54 raw → 51 unique → 22 verified → 19 confirmed,
2 refuted. 33 agents, 969 tool calls. Minors are flagged but unverified.

Severities below are the skeptic's correction, not the finder's original claim.

---

# LIGHT — review findings

Ordered by what it costs you on stage, not by file. Where several findings are one mechanism, they're treated together.

---

## 1. An out-of-range OSC column blacks out the entire rig

**`core/src/engine.rs:573`** (and the `/light/column` arm at `:588`), landing in **`core/src/state.rs:389`**

`/composition/columns/N/connect` is bounds-checked only on the low side (`col >= 1`). The shipped show has 8 columns; Resolume compositions routinely have more. Launch Resolume column 9 and `trigger_column(8)` finds `cells.get(8) == None` on every layer, which is the "empty cell → clear the layer" path — so the stage goes dark and stays dark for as long as the VJ works above column 8.

This is the only finding in this review that produces the author's own worst case (rig black, no operator error, shipped default config: `oscEnabled: true`, `followColumns: true`, port 7700). Both engines behave identically, so `test:parity` will never see it.

**Fix:** the empty-cell clear is deliberate and load-bearing — column 8 "Blackout" depends on it, and the doc comment at `state.rs:383` says so. The defect is that the code cannot distinguish *"this column exists and is empty"* from *"this column does not exist in the light show."* Add `col < project.columns.len()` (or `col < layer.cells.len()`) as an early return at the top of `trigger_column`, and mirror it in `engine/state.ts:165`. Do **not** fix it by making empty cells non-clearing.

Two caveats worth owning: recovery is automatic — the next in-range column connect restores the look, no manual cue needed. And only `layer-wash` and `layer-fx` are actually mutated in the shipped deck-1 (the other two are already empty); the visible result is still total darkness because wash is the only intensity source. The `/light/column` variant needs no assumption about Resolume at all — anything on the network that can reach :7700 with a finite value ≥ 1.0 triggers it.

---

## 2. A MIDI deck step latches a held flash on at full

**`core/src/state.rs:295`**, with the test gap at **`engine/test/diff.ts:157`** — one root cause, two findings.

Hold a flash pad (blinder), press the APC bank ▶ before releasing it. `deck_step` → `switch_deck` with no hold release; the cells are swapped out from under the hold, so the eventual note-off resolves a different look id at `state.rs:331` and returns early. The blinder stays lit.

The guard exists — `release_holds_for_deck_change` — but it's wired into `Command::SwitchDeck` (`state.rs:764`) only, not into `deck_step`. Node put the release *inside* `switchDeck` (`engine/state.ts:127`), so the reference engine is correct and the shipping engine is not. Commit `8503d3a` is the original "stuck blinder" fix; the port to Rust was incomplete and its "parity byte-identical throughout" claim survived only because the harness never sends a `midi` or `switchDeck` command.

**Fix:** move the release into `switch_deck` itself, matching Node's structure, and drop the call site at `state.rs:765`. That makes the two engines structurally identical rather than coincidentally equal.

**Then close the hole that hid it.** `both()` in `diff.ts` has never sent: `midi`, `switchDeck`, `openProject`, `newProject`, `saveProjectAs`, `resync`, `setSpeed`, `setLayerMaster`, `setHazeFan`, `clearChannelOverrides`, `learn`, `setLink`. The entire MIDI action table — every `run_action` arm — has zero coverage in either engine, not just zero parity coverage, despite `demo_project.json` shipping 55 mappings that exercise all of them. `LIGHT_NO_MIDI` does not block `Command::Midi`, so the harness could send these today. The specific missing case: note-on a flash cell, note-on a deckNext mapping, compare DMX. Note that a `switchDeck` test alone would **not** have caught this — both engines release on that path.

Calibration: this needs a mapping absent from `shared/defaultProject.json` — the bank arrows exist in `demo_project.json` and in whatever `apc40Mk2Mappings` writes when you click the mk2 installer. And it *is* recoverable in seconds: `clear_layer` (notes 82-85), triggering any look on that layer, or the UI deck tabs / `[` `]` all clear it. What doesn't recover it is the reflex of re-pressing the same pad, because that cell is usually empty on the new deck.

---

## 3. Blocking filesystem work runs on the 40 Hz tick thread

**`core/src/engine.rs:543`** (client disconnect), **`:471`** (openProject), plus the GDTF/MVR import already logged in REVIEW.md. One mechanism, several entry points.

Every WebSocket disconnect — closing previz, Cmd-R on the UI, a tablet dropping off WiFi — synchronously runs `persist::save_project_slug` inline on the tick thread: `create_dir_all`, four backup renames, an `fs::copy` of the whole project file, a pretty-print of the entire `Project`, `fs::write`, `fs::rename`. Unconditionally, with no dirty check. `openProject` does the same plus a full `list_projects` that reads and JSON-parses every `*.project.json` in the directory to extract one `name` field each. The autosave path at `engine.rs:295` already moves exactly this call onto a worker thread, with the comment *"so filesystem latency never touches the tick."*

**On stage, the DMX cost is smaller than it looks.** Measured locally: the fs ops run 0.37 ms median / 1.02 ms max for the 185 KB serialization, plus ~0.8 ms to serialize — call it 1-3 ms against a 25 ms budget. That's jitter, not dropped frames. The shipped projects live in `~/Library/Application Support/LIGHT/projects`, not a synced folder, and both clients back off 1 s before reconnecting, so a flapping tablet caps at ~1 save/s. A real freeze needs a network share, a sync provider, or a badly contended disk. `openProject` is the heavier one and grows linearly with your saved-show count.

**The worse half is data safety, and it isn't about timing at all.** `BACKUPS = 5` and the rotation runs on *every* disconnect. Close previz, reload the UI twice, have a tablet flap once — five routine actions and your entire backup history is five near-identical copies of the last few minutes. That silently guts the recovery ladder at `persist.rs:162-195` that `load_project` depends on when the main file is corrupt.

**Fix, in order of value:**
1. Skip the disconnect save entirely when `dirty_at.is_none()` — that alone removes almost every rotation.
2. Move the disconnect save onto the existing `std::thread::spawn` pattern from `engine.rs:295`. This also removes a Node/Rust divergence: `engine/index.ts:226` doesn't save on disconnect at all, and the harness can't see it because `diff.ts` never closes a socket.
3. Rotate backups only when the content actually changed, or keep the rotation but make it cheap (hardlink rather than copy).
4. `list_projects` should read the header of each file, or cache names, rather than parsing every show.

---

## 4. Nothing tells you the engine stalled

**`ui/src/components/TopBar.tsx:122`**, with **`ui/src/store.ts:346`**

`engineOk = connected && (snap?.stats.fps ?? 0) >= 35`. The fps number is carried *inside* the snapshot, and `snap` is never timestamped. If the tick thread wedges while the socket stays open — which is precisely what the sync `openProject`, `saveProjectAs` and GDTF import above do — snapshots stop arriving, `snap` retains its last value, and the dot stays green reading "engine 40fps" forever. `App.tsx:133` gates the OFFLINE bar on `!connected`, so that never appears either. Meanwhile `core/src/engine.rs:79` uses an unbounded `mpsc`, so every command you press — blackout, ALL STOP, master — serialises onto a healthy socket into a queue nobody drains. No error anywhere.

REVIEW.md:39 already records your view that "a window that looks alive over a dead engine is the worst failure mode at a show." This is the uncovered half of that hole: `stats.fps` catches a *slowdown* (recomputed every 2 s), but not a full stop, because the metric is transported by the loop that stopped.

Two corrections to how bad it looks: the snapshot-driven widgets do freeze visibly — the master fader won't move when dragged (`Fader.tsx` is fully controlled off `snap.master`), the beat LED stops, triggered cells never highlight. Those are real clues, easy to misread as "the clock is paused." And `oscAlive` at `TopBar.tsx:121` *is* an age check, so ironically the OSC dot tells the truth before the engine dot does. Also: the queued commands aren't dropped — if the thread ever unwedges they all execute at once, which is its own hazard.

**Fix:** record `Date.now()` alongside every snapshot in `store.ts:346`, run a 500 ms `setInterval`, and treat `age > 750 ms` as engine-stalled: red dot, the OFFLINE bar, and refuse to queue further commands silently. This is a ten-line change and it converts every stall in this review from "misdiagnosed mid-show" into "visible and diagnosable."

---

## 5. A WiFi hiccup drops a tablet, releasing its holds and silently eating its next commands

**`core/src/server.rs:159`**

The write path sets a 2 s `SO_SNDTIMEO` at `:147` and then treats *any* `ws.send` error as fatal: `break 'conn` → `bc.remove(id)` → `ClientDisconnected` → `release_all_held(t, Some(gone))`. A `WouldBlock`/`TimedOut` from that timeout is fully recoverable — tungstenite's `write_out_buffer` drains only the bytes actually written, so a later `flush()` resumes at the right byte. The read path four lines below (`:176-178`) tolerates exactly those two error kinds. The write path tolerates neither.

On stage: a tablet holding a blinder gets dropped, the blinder fades out with no input from you, and the reconnect gets a *new* client id — so when you finally lift your finger, the `release` hits `state.rs:331` with a mismatched look id and is a no-op. The layer just stays dark for the rest of the intended hold.

**And on every occurrence, held look or not**, the ~1 s reconnect window at `store.ts:386` silently discards anything you press: `store.ts:76` is `if (!QUEUEABLE.has(type)) return;` — triggers, tap, master, blackout are all dropped with no queue, no error, no feedback. That is "the operator's controls silently not reaching the rig," and it fires on every drop.

Calibration: the trigger threshold is higher than 2 s of congestion. The write only blocks once the kernel send buffer is full, and the timeout needs 2 s in which the kernel accepts *zero* further bytes. Snapshots run ~100-200 KB/s, so realistically this needs a 3-6 s total stall — a bad roam, a DFS radar scan, or a power-save wedge, not a clean AP roam. Note MIDI/OSC/APC holds are owned by `LOCAL_CLIENT` and are immune; only WS-client holds are exposed.

**Fix:** match the read path — tolerate `WouldBlock`/`TimedOut` on the write and retry, or better, adopt Node's approach (`engine/server.ts:101`): snapshots are disposable, so *drop the frame* for a backed-up client rather than killing the connection. Separately, make the UI's reconnect window visible and queue-or-warn on non-queueable commands instead of silently returning.

---

## 6. `replace_project` doesn't reset transient state — the hazer goes to 100%, overrides and mutes survive the switch

**`core/src/state.rs:525`**, reached from **`core/src/engine.rs:475`** (openProject) and **`:450`** (newProject). One function, three symptoms.

```rust
pub fn replace_project(&mut self, p: Project) {
    self.project = p;
    self.ensure_decks();
    self.live.clear();
}
```

`live` is cleared. `overrides`, `identify`, `muted` and `settings.haze` are not.

**Haze.** `run()` zeroes `project.settings.haze` on boot with a comment saying the hazer must never start pumping on its own. `replace_project` skips that. Your own files make this live today: `electronic-set.project.json` has `"haze": 1.0, "hazeFan": 0.35` and `aug-2026-rig.project.json` has `"haze": 1`, both patching fixture `hazer` at u1/73 with Art-Net on. Open the app at 5pm (haze correctly 0), pick the other show from the project menu to prep, and channel 73 goes to 255 on the next tick in an empty room. Worse: the renderer's blackout branch (`renderer.rs:380-388`) deliberately does *not* zero haze, so your reflex — hit blackout — will not stop it. Only ALL STOP or dragging the fader works. It is at least loud: `TopBar.tsx:213` binds the fader to `snap.haze`, so it visibly jumps to 100%.

**Channel overrides.** Channel-check some strips on show A at 6pm, open show B. `self.overrides` is keyed by universe id, and every project derived from the shipped default shares `u1`/`u0` — so the stale forces re-bind and are applied as the last write of every tick, after every fixture render and after blackout. `AllStop` clears both `overrides` and `identify` (`state.rs:719-720`), which tells me you already treat them as panic-state; the switch path just missed them. A non-matching universe id doesn't drop the override either — `renderer.rs:498` just skips it that tick while it stays in the map and in the snapshot count, so it reactivates when you switch back.

**Mutes.** `muted` is documented as transient at `state.rs:180`, survives the switch, and re-applies to any fixture id shared across shows — `derby1`, `derby2`, `hazer` exist in all three of your projects. A unit muted last night is still dark in the new show.

**Fix:** one place. In `replace_project`, also do `self.overrides.clear(); self.identify = None; self.muted.clear(); self.project.settings.haze = 0.0;` — i.e. hoist the boot-time guard and the AllStop panic-state reset into the switch path. Mirror in `engine/index.ts:165` / `engine/state.ts:260`; both engines have the identical gap, so this is a shared defect, not a parity break, and fixing only one side *creates* one. Add an `openProject` case to `diff.ts` while you're there — the whole project-switch path currently has zero parity coverage.

---

## 7. `activeDeckId` never crosses the wire — the UI doesn't know which song is live

**`core/src/types.rs:356`**

`Project` is derived with a bare `#[derive(Serialize, Deserialize)]`. `active_deck_id` is the only multi-word field in the whole of `types.rs` with neither a container `rename_all` nor a field-level `#[serde(rename)]` — `StageProp` handles exactly this case by hand at `types.rs:85` (`rename = "rotY"`). So the shipping Rust engine emits `active_deck_id` on the wire and to disk while the UI, `shared/types.ts` and the Node engine all read `activeDeckId`. Proof on your disk: `electronic-set.project.json` contains `"active_deck_id": "deck-14"` and zero `activeDeckId`.

On stage, in the packaged app, every launch:
- `App.tsx:88` and `LookGrid.tsx:145/157/240` all do `findIndex(...) === -1` then `(i < 0 ? 0 : i)`. So `[`, `]`, ◀ and ▶ are all computed from index 0 — `]` always loads decks[1] and `[` always loads decks[19], whatever song is actually playing. The engine honours it faithfully and the wrong song's grid goes live.
- `LookGrid.tsx:168` never marks a deck chip `on`, so nothing shows which song is live.
- `LookGrid.tsx:183` means the ‹ › song-reorder controls never render on any chip — that feature is unreachable.
- `LookGrid.tsx:215` shows the delete-× on *every* chip, including the one that's playing.

Two things still work, which is presumably why this survived: clicking a deck chip directly sends the id it was rendered with, and the APC bank arrows are handled engine-side where the internal field is correct. The UI→engine direction also round-trips fine, because `mutate` uses `structuredClone` and preserves the unknown key.

**Fix:** add `#[serde(rename_all = "camelCase")]` to `Project`, or `#[serde(rename = "activeDeckId")]` on the field. Then write a one-shot migration in `persist::try_load` that accepts either spelling, because your three saved shows on disk are all in the snake spelling and will otherwise lose their active deck on first load. Categorise this as a wire-contract break with the shipping UI, not as a Node parity issue — the Rust↔Node half is a dev-only path.

---

## 8. The whole-project blob is both document and live state, and the UI replaces it wholesale

**`ui/src/store.ts:339`** (echo clobbers in-flight edits), **`:202`** (undo teleports the grid), **`:130`** (the throttle's deadline branch). Three symptoms, one design.

The engine broadcasts the entire `Project` on a 100 ms coalesced timer whenever it's dirty, to every client with no originator filter. The UI applies it unconditionally at `store.ts:333-345`. Meanwhile `mutate` writes optimistically and defers the wire send 50 ms — and the deferred closure re-reads `get().project` at fire time.

**Symptom A — your last edit of a gesture is discarded.** Drag the dimmer fader to 80%; an echo carrying 62% lands at t≈5 ms and replaces the store; at t=50 ms the pending write transmits 62% back. The fader snaps back and the rig holds the old level. The UI doesn't end up *lying* about the rig — after the send, UI and engine agree on the old value — so the failure is "my edit didn't stick," not "the console shows 80% while the rig sits at 62%." Loss rate is ~25% for a UI-only drag (uniform 0-50 ms window against a 100 ms echo), and the magnitude is only the pointer travel since the previous write. It rises toward ~50% for an *isolated* edit made while something else holds the engine dirty — a mapped MIDI CC on a layer master or haze, a second connected client, a concurrent TopBar haze drag. Same mechanism eats characters in the look-name field (`LookEditor.tsx:431`), the fade field (`:448`) and the universe label (`OutputView.tsx:353`) — note `inputs.tsx:14-18` already guards against exactly this with `if (document.activeElement !== ref.current)`, but the store-bound text inputs don't.

**Symptom B — undo teleports the grid to an earlier song.** `pushUndo` clones the *whole* project, which includes `activeDeckId`, `columns` and every layer's `cells` — i.e. the live grid page. Deck switching never goes through `mutate`, so the top-of-stack snapshot stays stale across song changes, and `entryUsable` only compares the project *slug*. Edit during song 1, play through to song 3, press ⌘Z: the engine's `update_project` replaces the project outright, `activeDeckId` jumps to song 1, every layer's cells revert, the APC LED grid repaints to the wrong page, and the next column trigger fires song 1's looks. Nothing re-runs the held-flash release either.

Corrections that matter for triage: nothing changes on stage *immediately* — live look state lives outside the project and `reconcile()` only nulls dead references, so currently-playing looks keep playing. The damage lands on the next trigger, on the LED repaint, and on the autosave that follows. And it's one keystroke recoverable — redo captured the live pre-undo project — except for a flash held across the undo, which is orphaned permanently. It also only teleports if there was no UI edit after the song-1 edit; any later `mutate` pushes a fresher snapshot.

**Symptom C — the throttle's 250 ms "bound" doesn't exist.** `store.ts:130` cancels the overdue flush and re-arms 50 ms without refreshing `projectWriteFirst`, which is only assigned in the `else` branch and in the callback that was just cancelled. Once past the deadline the state latches and every further pointermove re-cancels. In practice this is narrow: entering it needs a 50 ms timer overdue by ≥200 ms (a GC or OS hitch — the previz is a separate process and can't stall the main thread), and only the unthrottled `Fader` can sustain it, since `ScrubNumInput` and `Previz2D` self-throttle `mutate` to 90 ms, wider than the re-arm. Latency is bounded by the length of continuous pointer motion, not unbounded, because the last `mutate` always leaves a timer armed. Master, layer master, haze, BPM, triggers and blackout bypass this entirely via `send`.

**Fix — one mechanism, in this order:**
1. **Stop echoing a project back to the client that sent it.** Tag `updateProject` with the sender's client id and exclude it from that broadcast. This kills symptom A outright and is the smallest change.
2. **Take live state out of the undo snapshot.** Either exclude `activeDeckId`/`columns`/`cells` from `pushUndo`'s clone and from what undo sends, or move the active-deck pointer out of `Project` and into engine state where it belongs. The second is the real fix and also removes finding 7's field entirely.
3. `store.ts:130`: flush immediately in the deadline branch (or at minimum refresh `projectWriteFirst`), and correct the comment — the real bound is 50 ms, which is also the exact size of the loss window in symptom A.
4. Give the store-bound text inputs the same focus guard `inputs.tsx` already has.

---

## 9. A prototype-key `profileId` freezes the Node engine's DMX output

**`engine/renderer.ts:301`**

`PROFILES` is built with `Object.fromEntries`, so it inherits `Object.prototype`. A fixture with `profileId: "toString"` (or `constructor`, `valueOf`, `hasOwnProperty`, `__proto__`, …) takes the built-in branch because the lookup is truthy; `prof.channels` is `undefined`, so the guard evaluates `NaN > 512` → false and doesn't `continue`; `prof.heads.map(...)` then throws. The throw escapes into `loop()`'s catch at `index.ts:509` *before* the Art-Net/sACN send block at `:537`, so the engine keeps ticking and transmits nothing — every node holds its last frame, indefinitely, with a once-per-second log line.

The nastiest detail: `flushProject()` runs *before* the tick, so project echoes keep flowing while the rig is frozen. The UI keeps confirming your edits while nothing reaches the fixtures.

You already fixed this exact class once — `Object.hasOwn` at `renderer.ts:60` for cue-step ids, with a regression test at `diff.ts:345` whose comment reads "the Node tick loop crashed and froze DMX output." The profile lookup was left unhardened. `sanitizeProject` never inspects `profileId`; the head-registration loop at `:118` dodges it only by accident via `?.heads`.

Scope honestly: **the .app is unaffected** — it runs the Rust core, whose `Prof::resolve` uses a `HashMap` and skips the fixture. This bites you when running `npm start`/`npm run dev`, and during `test:parity`. The primary defect is the parity break itself. Reachable only from a hand-edited or third-party project file, or a direct WS `updateProject`. (It also needs `address >= 1`; a non-finite address, which `sanitizeProject` repairs to 1, lands right in the throwing range.)

**Fix:** `if (!Object.hasOwn(PROFILES, f.profileId)) { /* fall through to compiled profiles */ }` at `:301`, matching `:60`. Consider a `try/catch` around the per-fixture render so one bad fixture can never take down the whole output loop.

---

## The known project-switch crash: not reproduced, and what it isn't

I could not find a mechanism that makes the engine thread panic or return during `openProject` in the app but not in the standalone binary. What I ruled out, with reasons:

- **The address-overflow panic (`renderer.rs:460`)** is symmetric. `engine::run` runs the tick loop on whatever thread calls it, so that panic unwinds out of `main` in the standalone binary too (exit 101). It cannot produce the differential you saw.
- **The tmp-file race (`persist.rs:144`)** has no panic path — every fs error is a `Result`, and `to_string_pretty` on `Project` cannot panic.
- **Sync I/O on the tick thread during `openProject`** stalls, it doesn't return or panic.
- **`replace_project`** does no allocation or indexing that can fail.

The structural fact worth acting on regardless: `src-tauri/src/main.rs:175` calls `process::exit(1)` on *either* a panic *or* a normal return of `run()`, and it does so without surfacing the panic payload. That means **every** engine-thread panic or early return in this codebase presents identically as "the whole .app vanished, no message" — including `server::start` failing to bind (`engine.rs:84-87`, a plain early return), which is reachable on the port-clash path. You are debugging a class of failures through a channel that discards the diagnosis.

**Do this first, it costs an hour and will name the cause on the next occurrence:**
1. In the `catch_unwind` at `main.rs:149`, downcast the payload to `&str`/`String` and write it — plus a backtrace, with `RUST_BACKTRACE=1` set in the app's own environment — to `~/Library/Logs/LIGHT/engine-crash.log` before exiting.
2. Distinguish the two arms. A panic and a clean return of `run()` are different bugs; log which one happened.
3. Show a dialog with the reason rather than exiting silently. Keeping the exit is right — a live window over a dead engine is worse — but exiting mutely is what made this untraceable.

The most likely remaining shapes, in order, are a panic inside code that only the app path reaches (the `on_ready` callback holds a `Sender` and a Tauri `AppHandle`; the app serves the embedded UI dist where the standalone may not), and something in the webview's disconnect/reconnect around the navigate that hits `ClientDisconnected` → the synchronous save at `engine.rs:543` in a state the standalone never enters. Both become obvious with the payload logged.

---

## Minors

Verified:

- **`core/src/renderer.rs:460`** — `f.address - 1 + prof.channels()` is unchecked `usize` arithmetic, so an address within `channels - 1` of `usize::MAX` wraps past the guard and the legacy renderers index the 512-byte buffer out of bounds → panic → `exit(1)`. Requires a hand-written integer literal or a non-JS WS client (the UI clamps at `PatchView.tsx:59`, MVR clamps at `mvr.rs:125`, and JS float precision makes it unreachable from any JSON emitted by JavaScript). Not the app-death cause; symmetric between app and standalone. **Fix:** `f.address.checked_sub(1).and_then(|b| b.checked_add(prof.channels()))`, or just reject `f.address > 512` up front.
- **`core/src/persist.rs:144`** — all three save paths derive the identical `<slug>.project.json.tmp`, and the autosave worker is detached and untracked, so a concurrent tick-thread save can interleave and rename a torn document over the live show file. Rare (needs the second save inside the worker's sub-millisecond create→rename gap) and the corrupted file is always the *outgoing* project. **The more valuable half of the fix:** `load_slug` (`persist.rs:102`) has no backup fallback, so a mid-show re-open of a torn file gives a flat `cannot open "<slug>"` while five good backups sit unused — give it the same ladder `load_project` already has. Then suffix the scratch name per writer, in **both** engines (`engine/persist.ts` has the same shared `${file}.tmp`).
- **`core/src/persist.rs:150`** — the Rust core has no `sanitizeProject`. `Settings.haze_fan`, `Look.parts`, `Group.heads`, `Project.name`, `Fixture.rot_y`, `LookPart.effects`, `Layer.master/fade/cells` and most of `SyncCfg` carry no `#[serde(default)]`, so a project Node repairs is rejected outright by Rust — and on the `updateProject` path the frame is dropped at `server.rs:170` with no reply, no log, no toast. Note `docs/architecture.md:45-73` omits top-level `"name"`, so a project written to your own documented spec loads in Node and is silently dropped by Rust. **One genuinely operator-reachable instance:** `mvr.rs:92-105` uses `.parse().ok()`, which accepts `"NaN"`/`"inf"` tokens into `pos`/`rot_y`; serde writes those as `null` and `f64` can't read `null` back — so the engine writes a file it cannot load, and the next boot renames your show `.corrupt-*` and starts the demo default. Add a finiteness check in `parse_matrix` and `#[serde(default)]` across the struct set.
- **`core/src/osc.rs:186`** — `stop()` sets a flag but never closes the socket, which lives in the listener thread and is only dropped after `recv_from` returns (up to 400 ms). An enable-toggle landing 50-400 ms apart hits `EADDRINUSE` on the rebind, and `ensure_osc` only retries on the next `project_changed`. Self-reporting (the TopBar dot goes to "failed"), one click from recovery, and any inbound packet closes the window — but the tooltip blames "another app (a second engine? QLC+?)" when it's LIGHT's own expiring listener, which sends you hunting the wrong problem. **Fix:** `shutdown()`/drop the socket in `stop()`, and correct that tooltip. Node closes synchronously (`engine/osc.ts:137`), so this is a parity divergence too.
- **`src-tauri/src/main.rs:110`** — when the port dialog moves the engine to 9901, nothing publishes the choice; `spawn_previz` (`engine.rs:334`) does a bare `Command::new(c).spawn()` and the child falls back to 9900 — i.e. the *other* copy of LIGHT. Completely silent (previz renders no connection state outside `LIGHT_PREVIZ_DIAG=1`) but harmless to the rig: previz never sends. Same gap in `engine/index.ts:122`. **Fix:** pass `port` into `spawn_previz` and `.env("LIGHT_PORT", port.to_string())`, both engines.
- **`src-tauri/src/main.rs:56`** — the alternate port is probed (and the socket immediately released) *before* a modal `display dialog` with no `giving up after`, so the offered port can be taken during an unbounded human wait; the bind then fails and you get a Dock bounce with no window, which is exactly what that dialog exists to prevent. Narrower than it reads: neither LIGHT build ever claims an alternate port without its own dialog, so the realistic actors are the parity harness on 9901 (`diff.ts:146`) or a manual dev engine. Launch-time only, and `server::start` fails *before* Art-Net/sACN/MIDI open, so the rig is untouched. **Fix:** hold the probed listener across the dialog, or re-probe after the click and fall forward. Same line: `(wanted + 1..wanted + 20)` is unchecked `u16` arithmetic — `LIGHT_PORT=65530` panics in debug and reports "every port up to 65549 is in use" in release.
- **`engine/test/diff.ts:100`** — `compareDmx` and `settle` index `dmx['u1']` literally and the harness project has one universe, so the shipped show's second universe (8 Octostrips on an 8-head compiled GDTF profile with `virtualDimmer`) is never byte-compared. Narrower than it looks: `render_compiled` is one shared implementation (`profile-wasm/src/lib.rs:95` calls `light_core::cprofile::render_compiled`), and the 8-head + virtual-dimmer shape *is* covered natively at `core/tests/gdtf_import.rs:95-148`. The genuinely uncovered surface is the Node-only 15-f64 flattening in `engine/wasmProfiles.ts:79-96` against Rust's `chunks_exact(15)` — with one head the stride is always 0, so a stride drift would silently drop the ragged tail. **Fix:** patch an 8-head compiled fixture on a second universe into the harness project and iterate all universes in `compareDmx`.

Unverified (flagged, not skeptic-checked):

- **`core/src/cprofile.rs:207` / `engine/wasmProfiles.ts:93`** — Rust writes only the offsets a compiled profile's channels declare; Node block-writes the whole footprint including gap zeros. Different bytes on the wire wherever two fixtures' address ranges overlap — which `PatchView.tsx:22` permits and merely flags. Reachable from real GDTF files, since `gdtf.rs:124` drops ≥3-offset channels while `footprint` still spans them.
- **`core/src/renderer.rs:222`** — the tick deep-clones every `Layer` (including its `Vec<Option<String>>` of cells) to read two `Copy` fields, and allocates a fresh `String` per head-map key lookup — roughly 10⁴ allocations/second on the thread with a 25 ms deadline. Key the head map by fixture index; the layer fields need no clone at all.
- **`core/src/artnet.rs:110`** — the ArtPollReply listener binds 6454 exclusively with no reuse, unlike Node (`artnet.ts:103`, `reuseAddr: true`), so LIGHT locks other Art-Net software off the port — and in the reverse order `PollState::Failed` is terminal (`poll_tick` only reopens from `Off`), so discovery stays broken for the whole gig.
- **`core/src/artnet.rs:117`** — `let Ok(..) = recv_from(..) else { continue }` can't distinguish the 1 s timeout from a real error, so a persistently-erroring socket becomes an unthrottled busy loop competing with the tick, while `poll_status()` still reports "on". The sibling OSC listener at `osc.rs:174` does distinguish; copy that.
- **`core/src/engine.rs:81`** — `on_ready` fires *before* `server::start` binds, so the shell's `navigate` under the comment "now the server is up" is issued against a port nothing is serving; it survives on event-loop timing alone, the `Result` is dropped with `let _ =`, and nothing retries. This is the same shape as the bug commit `b04c538` set out to fix.
- **`core/src/mvr.rs:133`** — the two accepted MVR address encodings disagree by one universe: absolute is converted to 0-based, dotted is taken verbatim. `core/tests/mvr_import.rs:73-81` asserts both behaviours side by side. A dotted-address scene lands the whole rig one universe high and nothing responds.
- **`core/src/midi.rs:42`** — input ports are de-duplicated by display name, so a second port sharing a name is reported to the UI as available but never connected. Two identical controllers, or any two ports whose `port_name()` both fall back to `"MIDI input"`: the device is listed, the pads do nothing, no error anywhere.
- **`core/src/state.rs:506`** — a MIDI-mapped Tap changes BPM but never sets `align_phase`, so tapping tempo on the controller doesn't land the phase on a downbeat the way the UI Tap button does. Identical gap in Node, so parity holds and the harness won't surface it. Note `Command::Midi` at `state.rs:769` also drops `align_phase` when merging the inner `Outcome`, so fixing `apply_midi` alone won't propagate.
- **`core/src/apc.rs:90`** — `swatch_first_plain` returns grey on a part whose derby macro is the "Off" band instead of falling through to the next part, so the .app paints a different pad colour than the browser for e.g. "derby off, wash deep blue". Not reachable in the shipped 190-look show; bites user-authored looks.
- **`previz/src/update.rs:90`** — `apply_live` deep-clones the whole snapshot and re-clones every fixture id per entity, every rendered frame, on a renderer already documented at ~13 fps. Separately, `live.smoothed` is never pruned, so a removed-then-re-added fixture resumes from its stale intensity instead of fading up.
- **`.github/workflows/release.yml:150`** — the release body unconditionally promises a Developer ID-signed, notarised, no-Gatekeeper install, including for the ad-hoc fallback build the same workflow supports (`build-app.sh` falls through to `codesign -s -`). The workflow already prints "not stapled — first launch needs Privacy & Security > Open Anyway" into a log nobody downloading the release reads.
---

# Completeness critique — what the LIGHT review missed

Repo root: `/Users/colmhewson/Documents/Web/light`

---

## 1. The `.app` death on project switch was **not explained**. It was not even localised.

No finding in the list contains a mechanism by which `run()` panics or returns during an `openProject` in the app but not in the standalone binary. The two nearest — `/Users/colmhewson/Documents/Web/light/core/src/persist.rs:144` (shared `.tmp` name) and `/Users/colmhewson/Documents/Web/light/core/src/engine.rs:543` (sync save on the tick thread) — produce a torn file and a stalled tick respectively. Neither kills a process. The review answered a different, easier question and left this one open while appearing to have covered it.

Four things it should have done and did not:

**a. Enumerate the ways `run()` can end.** There are exactly four, and the review never listed them:
- `/Users/colmhewson/Documents/Web/light/core/src/engine.rs:86` — `server::start` fails (startup only).
- `/Users/colmhewson/Documents/Web/light/core/src/engine.rs:177-185` — `EngineMsg::Shutdown` → `return`. **This is app-only.** The only sender is `/Users/colmhewson/Documents/Web/light/src-tauri/src/main.rs:186-189`, on `RunEvent::ExitRequested`. The standalone binary has no sender for it at all.
- `/Users/colmhewson/Documents/Web/light/core/src/engine.rs:211` — `RecvTimeoutError::Disconnected` → `return`. Unreachable: `tx` lives in `run`'s own frame.
- a panic anywhere in the loop.

That leaves one structurally app-exclusive path — `Shutdown` — and the review never touched it. `RunEvent::ExitRequested` in Tauri 2 is not only ⌘Q; it is also emitted when the last window is destroyed. Any teardown of the webview window during an `openProject` (a WebKit content-process crash under the project-echo burst being the obvious candidate) produces exactly the reported symptom: window gone, engine gone, `Ok(()) => process::exit(1)`. The handler at `main.rs:182-192` never calls `api.prevent_exit()` and never distinguishes a user quit from a window loss.
**Close it:** make the exit handler discriminate, and have `run()` return a typed reason the shell reports differently.

**b. Notice the repro was not a repro.** `/Users/colmhewson/Documents/Web/light/core/src/persist.rs:10-22` — `project_dir()` returns the **relative** path `projects` whenever the CWD contains it. The standalone binary run from the repo root therefore switched among `/Users/colmhewson/Documents/Web/light/projects/*.project.json` (48 KB, one show). The Finder-launched `.app` (CWD `/`) switched among `~/Library/Application Support/LIGHT/projects`. Different files, different sizes, different shows. "The standalone did the same project switch without dying" is not evidence of anything until both run against the same directory.
**Close it:** re-run with `LIGHT_PROJECT_DIR` pinned to the app's Application Support directory for both processes.

**c. Notice the Rust save path has apparently never run.** `Project` at `/Users/colmhewson/Documents/Web/light/core/src/types.rs:335` lacks `rename_all`, so the Rust core *writes* `active_deck_id`. Every project file in the repo — `projects/default.project.json`, `core/tests/data/demo_project.json`, `shared/defaultProject.json` — contains `activeDeckId` and **zero** occurrences of `active_deck_id`. A Rust round-trip would have replaced one with the other (serde drops the unknown key). No file here has ever been written by the shipping engine. The project-switch path in the binary that ships is effectively untested, and that fact is sitting on disk in plain sight.

**d. Notice the bug is undiagnosable by construction.** The only two lines that distinguish "panicked" from "returned" are `eprintln!` at `main.rs:172-173`. A Finder-launched `.app` has stderr on `/dev/null`. There is no `panic::set_hook`, no `os_log`, no log file anywhere in the workspace (`grep set_hook|os_log` over `core/`, `src-tauri/`, `previz/` → 0 hits). Worse, the `Ok(())` arm hardcodes **"port already in use?"** — a wrong explanation for a path reached by a clean `Shutdown`, which will actively mislead whoever debugs this next.
**Close it:** panic hook writing payload + backtrace + thread name to `~/Library/Logs/LIGHT/engine.log` and `os_log` before death; drop the hardcoded guess; and check `~/Library/Logs/DiagnosticReports/` for a `LIGHT-*.ips` — if one exists, it was never a Rust panic and the whole framing in the brief is wrong.

---

## 2. Whole subsystems with zero findings

No finding touches any of: `apc.rs`, `midi.rs`, `link.rs`, `clock.rs`, `color.rs`, `effects.rs`, `profiles.rs`, `cprofile.rs` (490 lines), `gdtf.rs`, `mvr.rs`, `defaults.rs`, `artnet.rs`, `sacn.rs`, `bin/light-bench.rs`; every `engine/*.ts` except `renderer.ts` and `test/diff.ts` (including `index.ts`, 656 lines); **all** of `shared/` (`types.ts` 470 lines, `color.ts`, `effects.ts`, `profiles.ts`); **all** of `previz/`; every `ui/src/components/*` except `TopBar.tsx` (`PatchView.tsx` 779, `LookEditor.tsx` 666, `OutputView.tsx` 479, `Previz2D.tsx` 510); `ui/src/midi.ts`, `apcFeedback.ts`, `selection.ts`, `dialog.tsx`; every file in `core/tests/`; and the entire packaging surface (`tauri.conf.json`, `Info.plist`, `light.entitlements`, `scripts/build-app.sh`).

Concrete things inside that silence, worth chasing in priority order:

- **MIDI double-delivery / client churn.** `/Users/colmhewson/Documents/Web/light/core/src/midi.rs:30` constructs a fresh CoreMIDI client every 3 s forever; `midi.rs:76-80` drops the *name* on unplug but keeps the dead `MidiInputConnection` handle ("harmless"). Meanwhile `/Users/colmhewson/Documents/Web/light/ui/src/midi.ts:24` suppresses browser WebMIDI forwarding only when `engineMidi` is true — which is derived from a `midiInputs` event that `midi.rs:82-86` emits **only when `changed`**, and never at all if `MidiInput::new` fails. Engine MIDI failing open, or a replug, gives you two live paths and every APC pad fires twice. This is the author's stated worst case in the other direction.
- **The parity claim does not cover the wire.** `engine/test/diff.ts` compares `snap.dmx`, i.e. the *pre-transport* 512-byte buffer. Nothing anywhere byte-compares the actual UDP output of `core/src/artnet.rs` vs `engine/artnet.ts`, or `core/src/sacn.rs` vs `engine/sacn.ts`. Sequence numbering, framing and universe encoding are outside a suite advertised as byte-for-byte.
- **Rust has no `sanitizeProject` on *any* path, not just load.** The filed finding (`persist.rs:150`) covers file load. The bigger hole is `/Users/colmhewson/Documents/Web/light/core/src/state.rs:531` — `update_project` is assign + `ensure_decks` + `reconcile`, and `reconcile` only prunes *live* state. `shared/types.ts:368-450` additionally nulls dangling cell look-ids, repairs non-finite `layer.master`/`fade`, normalises and clamps cue steps to 512 beats, and guards prototype keys. So the Rust core accepts, renders, **and then autosaves** a project shape it will itself refuse to load next boot and rename `.corrupt-*`.
- **Previz is the only consumer of a serde contract nobody tests.** `/Users/colmhewson/Documents/Web/light/previz/src/protocol.rs:60` deserialises `light_core::cprofile::CompiledProfile` straight off the wire. And `protocol.rs:122` reads `LIGHT_PORT` from its own env while `/Users/colmhewson/Documents/Web/light/core/src/engine.rs:335` spawns it with inherited env and never sets the port — **that** is where the "previz dials 9900" finding should be fixed, one line in `engine.rs`, not in `src-tauri/src/main.rs:110` where it was filed.

---

## 3. The review never read `REVIEW.md` — and re-derived accepted findings as new criticals

`/Users/colmhewson/Documents/Web/light/REVIEW.md` records a prior 51-agent review at v0.5 with an explicit **accepted/unfixed** list. It already contains, as known and dispositioned: `updateProject` whole-project last-write-wins clobber (= the `store.ts:339` "critical"), full-project updates per pointermove (= `store.ts:130`), synchronous GDTF/MVR import on the engine thread, MIDI replug double-delivery, snapshot-before-first-project-event, no schema versioning, no WS soak harness.

Two consequences the review should own:
- Several "new criticals" are re-finds. Presenting them as discoveries hides that the real question is *why they were accepted and whether that judgement still holds now that the shipped show is 190 looks and 20 decks*.
- One open item on that list is a live parity defect on the command path and **nobody in the node-parity dimension mentioned it**: *"Rust strict integer deserialization can reject values Node accepts (e.g. `2.0` for an index) — command silently dropped."* That is verbatim the author's worst outcome — controls silently not reaching the rig — sitting unfixed in the project's own review file.
- `REVIEW.md` also claims the parity harness covers "GDTF-imported fixtures (WASM vs native interpreter)". `diff.ts:209` does import a *synthetic* GDTF, but `core/tests/data/demo_project.json` ships **zero** compiled profiles and **one** universe. The only GDTF profile the author actually gigs — the Showtec Octostrip 192-ch on `u0` — is outside the harness on both axes. The `diff.ts:100` finding understates this: it is not just "u0 is not compared", it is "the real profile is never in the diff at all".

---

## 4. Nothing was measured. Every performance and lifecycle finding is asserted.

The directive is *reliability and performance first*, and the review produced no numbers.

- `engine.rs:543` is filed critical for stalling the 40 Hz tick. Nobody measured `save_project_slug` against the shipped 144 KB / 190-look / 20-deck project — so nobody knows whether that is 2 dropped ticks or 40. `/Users/colmhewson/Documents/Web/light/core/src/bin/light-bench.rs` exists in this repo and is cited by no finding.
- Memory: the shipped show is 89 KB minified; `engine.rs:223` broadcasts the **whole** project at up to 10 Hz; `ui/src/store.ts:179` `structuredClone`s it per mutate and `store.ts:96-118` keeps 30 full clones. Nobody measured RSS on either side over a set. A WKWebView content-process OOM is precisely the shape of "window and engine both gone" (see §1a).
- `stats.jitter` is computed at `engine.rs:258` and displayed, and not one finding quotes a value from it under real Art-Net + sACN + OSC + Link + APC load.
- The `TopBar.tsx:122` "no staleness watchdog" finding is correct but has nothing to watch: the engine never emits a tick-health signal. Fixing the client alone leaves it inferring liveness from the same snapshot stream that stops.

**Close it:** run `light-bench` against `shared/defaultProject.json`; add an hour-long soak driving both engines with a synthetic OSC/MIDI storm asserting a max-tick-lateness ceiling and an RSS ceiling; emit an explicit `tickStalled` event from the engine so the client watchdog has ground truth.

---

## 5. Packaging: claims that only a build can verify, and no build verifies them

- `tauri.conf.json:38-40` points at `light.entitlements`; `src-tauri/Info.plist` carries `NSLocalNetworkUsageDescription`. Whether that plist actually merges into the shipped bundle is entirely an assumption about `tauri-bundler`, and nothing checks it. If it does not merge, macOS 15 shows a reasonless Local Network prompt, and a decline **silently kills Art-Net and sACN in the `.app` while the standalone — inheriting Terminal's grant — keeps working.** That is the same app-vs-standalone asymmetry under investigation, it is reachable at a gig, and no finding mentions it.
- `scripts/build-app.sh:62-65` re-signs with `codesign --force --deep`, which Apple documents as unreliable for nested code; the script's own comment (line 48-50) records that entitlements were silently stripped once already. Lines 119-124 *print* the result for a human to read and never fail the build.

**Close it:** hard assertions at the end of `build-app.sh` — `plutil -p "$BUNDLE/Contents/Info.plist"` must contain `NSLocalNetworkUsageDescription`, `codesign -d --entitlements` must contain `allow-jit`, `spctl --assess` must pass, both binaries must be fat — each with a non-zero exit.

---

## 6. Specific defects, none of them in the finding list

1. **`/Users/colmhewson/Documents/Web/light/core/src/engine.rs:471`** — `openProject` calls `save_project` and *then* sets `*dirty_at = None`. `dirty_at` is only the scheduling flag; once the debounce fires, `engine.rs:295` has already spawned a **detached** save worker for the same slug, and clearing the flag cannot recall it. Node does the opposite order and cancels a real timer (`engine/index.ts:370` `persist.cancelPendingSave()`). Two concurrent writers of the same `<slug>.project.json.tmp` is precisely what `persist.rs:144` describes — the review filed the collision as abstract concurrency and never named the trigger that makes it routine.
2. **`/Users/colmhewson/Documents/Web/light/ui/src/store.ts:135-139`** — the 50 ms trailing send reads `get().project` at fire time and is **not slug-guarded**. Only the offline `pending` queue is (`store.ts:86`, `store.ts:265`), and the undo stack went to the trouble of tagging every entry with a slug specifically because of "cross-project overwrites" (`store.ts:90-95`). The live throttle path has the identical hazard and none of the protection: a timer armed just before an `openProject` fires just after it, straight into the new slug.
3. **`/Users/colmhewson/Documents/Web/light/core/src/state.rs:531`** — no sanitisation on the hottest write path (§2).
4. **`/Users/colmhewson/Documents/Web/light/core/src/midi.rs:76-80`** — leaked connections and double-delivery (§2).
5. **`/Users/colmhewson/Documents/Web/light/core/src/engine.rs:335`** — previz child never told the engine's port (§2).
6. **The `types.rs:356` finding is understated and its supporting claim is wrong.** Thirteen other structs in that file also lack `rename_all` (`Vec3`, `Group`, `Deck`, `Layer`, `Look`, `Effect`, `HeadSnap`, …) — they merely happen to have single-word fields. More importantly, the finding stops at "the active song never crosses the boundary" and never states the operator-visible consequence: with `project.activeDeckId` permanently `undefined`, `/Users/colmhewson/Documents/Web/light/ui/src/components/LookGrid.tsx:167-168` never highlights any deck chip (the LD cannot see which song is live), and `LookGrid.tsx:145` / `:157` compute `findIndex(...) === -1`, so **◀ always jumps to the last deck and ▶ always jumps to deck 2**, from anywhere in the set. That is a mid-show navigation failure, not a serialisation nit.