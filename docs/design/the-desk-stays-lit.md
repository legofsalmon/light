# LIGHT — Final design · "The desk stays lit" (2026-09-13, revision 2)

*Base: T5, the judges' winner. Absorbed, with attribution: T2's pad face as a rig miniature (all four judges); T1's `minmax` pad track (two); T4's hold-to-clear ✕ with `--motion-hold` bound to `LONG_PRESS_MS` (four); T4's lock-on-by-default and latch rules (two); T4's phone pager (three); the `check-tokens.mjs` extension (three); T3's guard that no panel opens except beside a full grid, with its 30 s latch release (one); and two I judge essential — T1's CLIP STOP cue row, the only reading that respects the preset file's own warning, and T4's hardware-key tokens, the one drawn detail that makes the strip read as a desk. Fixed: the four things the judges said the winner must fix — column heads and keys 1–9 firing the live page while the grid shows another song; the phone's 40 px pads; anything scrolling over pad bodies; and lane-1 items labelled "no engine" that the Rust project struct would drop.*

*Revision 2 corrects what adversarial verification refuted: the grid's gap and padding arithmetic, the phone's four-gap row, the strip's drop schedule against the window the app can actually produce, the CLIP STOP LED work, momentary FREEZE on a client that can vanish, the fader's focus rule, the `.cell` state facts, the lock's default on the owner's own laptop, and lane 1's honesty. The editing page's rewrite of "a pad body fires" is now decision 0, not a settled fact.*

*Every claim about the current app cites a screenshot in `uxshots/` or a `file:line` at v1.5.0. **S** tokens / defaults / CSS · **M** component work, or a tick-neutral change in both engines with a parity case · **M-schema** an additive optional field or action kind in both engines, round-trip case, no render change · **L** render change or a field the renderer reads.*

---

## 1. Thesis

LIGHT is a desk in a dark booth beside Arena. A desk has three planes: matte chrome that never glows, a few large readouts you can read from the stage, and the light itself — the only saturated thing in the room. Today the chrome glows (fourteen cyan lamps lit on 01-pads.png before a pad plays), the readouts are 9.5 px tracked caps (`tokens.css:288`), and the light is a 0.85-opacity stripe (`theme.css:479-488`) behind a 1 px border that also means "focused" and "drop here" (`theme.css:445-447, 507-509`). This design changes defaults and tokens first: Pads opens as an executor surface, Build as a programmer, and the phone gets the same Pads view under one layout state that removes what a finger cannot use. It keeps the four views, the two editor homes, the pad's two targets and the APC mapping the owner's hands know. Five things cannot be done with tokens — editing song B while A plays, firing a cue from the APC40, saying whether an edit reaches the rig, holding the frame from a tablet that may vanish, retuning a colour across the pool — and the last four are one engine lane with parity cases, behind the token work, not blocking it. The first is UI-only.

**Three principles.**

1. **The grid is the constant; everything else gives way.** Layer head + eight pads is the measurement the layout is built around. Panels fold, the band shortens to a floor, pads shrink to a floor of 96 px; the grid never scrolls sideways before the panels have given up their width; a panel opens only when the window holds it beside all eight columns. Today: 5 of 8 columns at 1440 (01-pads.png), 3.5 at 1280 (40-pads-1280.png), one at 1024 (41-pads-1024.png), because `MIN_GRID_W` is 306 (`tokens.css:185`, `App.tsx:371`). The desktop window cannot go below 1100×700 (`src-tauri/tauri.conf.json:18-19`); 1024 wide is a browser client, or a 14" MacBook Pro scaled to 1024×665 — both are measured.
2. **Light is the only saturated colour.** Three meaning tokens replace one overloaded cyan: `--color-live` (tungsten) for what is playing and for a lit key, `--accent` only for the cursor, amber and red for trouble. No green anywhere. Saturated fills come only from the look. Brightness is state, colour is content, corner marks are flags.
3. **Nothing new reaches the rig.** The only pointer gestures that change output are the pad body, the column head, the layer ✕, the masters and the panic pair — the same five things today (`LookGrid.tsx:284-289`, `:1078-1081`; `TopBar.tsx:503-528`). Editing stays on right-click / hold. Clearing on glass is a hold. Lock is on by default on any client that is not the engine's own host. What a page that is not the live song does with those five gestures is decision 0 (section 9); the default written here is that the body and head go inert and select, and that a cue that does not fire is treated as a misfire (section 8, rule 18).

---

## 2. Anatomy

Budgets for 1440×900, 1280×800, 1100×700 (the Tauri floor), 1024×700 (a browser client), 1024×665 (MBP-14 scaled), 1024×768 touch and 390×844 touch. Every size is a token; section 6 lists each with its value. Sizes are edited in `docs/design/tokens.json` and regenerated (`npm run tokens`); `tokens.css` is generated and `check-tokens.mjs` fails if it is edited by hand (`scripts/check-tokens.mjs:1-5`).

### 2.1 The command strip and the status line

Today `.topbar` wraps (`theme.css:290`) and scrolls (`:1007`); ALL STOP and BLACKOUT are flow children 17–18 of 22, followed by MIDI LEARN, the trial chip, the status dots, `?` and ⚙ (`TopBar.tsx:501-560`), so at 1440 the wrap lands the panic pair at the far left of a second row (01b-pads-topbar-detail.png), split across a line break on the tablet (60-tablet-pads-touch.png), row three of eight on the phone (50-phone-pads-touch.png).

The bar becomes two elements rendered from **one ordered control table**, each control carrying a `tier` (strip / line) and a `dropOrder`. The strip never wraps or scrolls: it measures its own width with a `ResizeObserver` and moves controls to the line in `dropOrder` until the content fits. There is no fixed breakpoint, so no window width — including the 1100–1165 band the Tauri floor permits — can be caught between two breakpoints with a strip that overflows. The panic pair has its own grid area, `--size-panic-w: 198` (92 + 96 + a 10 gap), right-anchored, at the same x on every view and width.

```
1440 ────────────────────────────────────────────────────────────────────────────────────── 46
│ ⚡LIGHT │ Electronic Set ▾ │ PADS STAGE RIG BUILD │ 120.0 BPM TAP SYNC │ SPEED 1.00× │ HAZE 0 │ MASTER ▮▮▮▮ 100 │ OFFLINE │ FREEZE ║ ALL STOP │ BLACKOUT │
   72        130                200                 95   44  50         92          86      130             70        62   ║  92        96
│ ·saved ↺ ↻ │ LINK │ CLOCK │ MIDI LEARN │ held · 3 ▾ │ find ⌘F │    ● engine 40  ● sending · 1  ○ midi  ● osc │ trial 2d │ ? │ ⚙ │ 22
```

Budget: 1,219 px of controls (BPM at mono 22 with its label measures ≈ 95, not the 70 of revision 1; today's 18 px readout is already ≈ 79 on 01b) + 12 gaps × 10 + 24 padding = **1,363 at 1440, 77 spare**. `dropOrder`: SPEED, HAZE, SYNC, the project name (to `▾`, −90), MASTER to `--size-master-w-narrow: 100`, FREEZE. What the order produces: 1280 → SPEED and HAZE on the line, 1,165 ✓ (115 spare); 1100 (Tauri floor) → SYNC and the name gone, MASTER narrow, 985 ✓; 1024 (browser) → 985 ✓ (39 spare). Below 900 the remote (2.11) takes over — two tiers by construction. In Pads the status line folds to its right-hand third (held chip, lamps with state words, `?`, ⚙); Build, Rig and Stage show it whole. While an editing page is shown (2.5), the project name yields to `editing 02 · Undertow` in `--accent`, so the top of the screen says it as well as the grid.

**Keys are hardware keys**: flat `--color-key-fill`, a 1 px top edge `--color-key-edge-hi`, a 1 px bottom shade `--color-key-edge-lo`; pressed = `--raise2` plus a 5 px `--color-lamp` at the left edge, and `--color-lamp` is tungsten — a lit key on a desk is a lamp, the same family as what is playing (today a pressed toggle is a cyan fill, `.btn.on`, `theme.css:169`). The thing beside the laptop is an APC; the thing under a thumb at FOH should read the same way.

| key state | drawing |
|---|---|
| quiet | `--color-key-fill`, edges, `text/key` in `--text-dim` |
| hover | text to `--text`, top edge to `alpha/white-10`, `--motion-fast`; no fill change |
| pressed (momentary) | `--raise2` for the press, back in `--motion-press` |
| lamp (latched) | `--raise2` + the 5 px `--color-lamp` bar; text `--text` |
| danger (ALL STOP, BLACKOUT) | red family: idle border-only, armed filled and pulsing (BLACKOUT only) |
| disabled | face 0.4, no edges, `cursor: default`, tooltip says why (`no rig yet`) |

**BPM** is `text/readout` mono 22, slashed zero, click to type, drag to scrub (`TopBar.tsx:303-311`). **TAP, SYNC, LINK, CLOCK, MIDI LEARN, FREEZE** are quiet keys with a lamp. **FREEZE** lit reads `HELD`, the strip's only amber. Its two titles today already describe the workflow rather than warn about forgetting it (`TopBar.tsx:493-494`: hold the rig on the frame it is showing while you edit; blackout and ALL STOP release it); the rewrite is light — the idle line gains *set up the next column, then release*, and the held line keeps the sentence that blackout and ALL STOP release it. **Momentary freeze** — held only while the pointer is down, latched by a short click (release on pointer-up only when the press lasted longer than `--motion-hold-latch: 250ms`, otherwise it latches) — is the flash-pad shape as a template (`LookGrid.tsx:284-289`, which always releases on up), sending `setFreeze v:true` on pointerdown and `v:false` on pointerup / pointercancel. It is **not** UI-only: `Command::SetFreeze` is a bare global bool with no owner (`core/src/state.rs:1369`), and `ClientDisconnected` calls `release_all_held` for held looks only (`core/src/engine.rs:1121-1130`; `state.rs:687`), so a tablet that drops off the Wi-Fi mid-hold would leave the rig frozen with nobody's finger down — the exact failure the flash pad was fixed for. The momentary hold therefore carries an owner (a `held_by` client id, as `LayerLive` does, or `SetFreeze { v, momentary: true }`) and is released in `release_all_held` on disconnect, in both engines, with a parity case (lane 3, #57). Until that ships, FREEZE is a latch with the new copy, and `F` latches. **MASTER** is neutral at rest, readout amber below 100: the `.subcell.down` rule (`theme.css:1416`) on the grand master. Today only the grand MASTER's fill is cyan (`TopBar.tsx:393`, default `variant='accent'`, `.fader .fill` at `theme.css:243-248`); the layer, group, haze and control faders already pass `variant="dim"` and draw a white-alpha gradient (`LookGrid.tsx:441, 786, 894`; `TopBar.tsx:391`; `theme.css:249-252`) — so this is one call site plus the `.fader .fill` rule. **OFFLINE / LIVE** is the one gate, carrying the sentence that lives in four places today (`TopBar.tsx:477-480`, `LookGrid.tsx:918-960`, `OutputView.tsx:44-80`, the guide); with no universe configured it opens the setup sheet at Output. **ALL STOP** keeps its confirm (`TopBar.tsx:503-517`); **BLACKOUT** idle is border-only, armed is filled and the strip's only pulse, matching the APC's blinking STOP ALL LED (`surfaces.ts:205`; today rest is already red, `theme.css:175-176`); it toggles through `setBlackout` unless learn is armed (`:525`). **Engine loss** is a bar above the strip, `ENGINE LOST — reconnecting` / `ENGINE STALLED` (`App.tsx:249-253`); "offline" is reserved for the gate.

The status line holds what performs nothing: a save dot by the project name (the SAVE button, "only for peace of mind", `TopBar.tsx:223`, goes), ↺ ↻, LINK, CLOCK, MIDI LEARN, the one `held · N` chip (A4: nudged · Keep · Discard, groups down · all up, channels held · release, finding · release, frozen · release, muted, dark — each row its existing verb, replacing five chips at `TopBar.tsx:401-458`), `find ⌘F` (A40), the lamps, the trial chip, `?`, ⚙. **The `held` chip pulses at `--motion-pulse-find` while any find is active** — find is the one thing that overrides blackout, and the canvas tag that would otherwise say so is hidden whenever the band is folded. On the remote the panic strip's LIVE lamp carries the same pulse.

### 2.2 The grid

Today's grid is one CSS grid — head + N pads + a trailing add-column track — with `gap: var(--space-3)` between every track and `width: max-content` inside a `.gridwrap` that pads `--space-10` on every side and scrolls (`LookGrid.tsx:1060`; `theme.css:368-373`). Every measurement below counts **nine 3 px gaps (27), the 30 px add column and 20 px of wrapper padding**.

The grid rule becomes `.lookgrid { width: 100%; grid-template-columns: var(--size-layerhead-w) repeat(8, minmax(var(--size-pad-w-min), var(--size-pad-w-max))) var(--size-addcol-w) }` — `max-content` goes, or `minmax` resolves to its maximum and every laptop scrolls sideways. `LookGrid.tsx:1060` hardcodes the template string, so this is a one-line component change beside the tokens. The layer head is 120, or 96 when the grid area is under 1,200 px (so a panel opening at 1280 narrows the head, not the pads below their floor). Pads are `--size-pad-h-pads: 72` in Pads (58 in Build's context row); the dial row matches, being the APC's fifth row.

Grid need = head + 8 × pad + 27 + 30. `--size-min-grid-w` becomes **945** (120 + 8 × 96 + 57; 921 with the narrow head; T3's 873 assumed an 84 px pad floor, and 84 px cannot hold an 11 px two-line name). Grid area = window − 18 per reveal strip (rendered only where that panel could open) − 6 per **open** panel's splitter (a collapsed splitter track is 0 px, `App.tsx:243, 245`) − 20 wrapper padding. The panel floors become `LIBRARY_MIN_WINDOW = 921 + 20 + 200 + 6 + 18 = 1,165` and `EDITOR_MIN_WINDOW = 921 + 20 + 300 + 6 + 18 = 1,265` (`App.tsx:381-383`; today 822 for both together): one panel opens only beside a full eight-column grid, and both together (1,453) never fit at 1440.

| breakpoint | chrome | band | grid area (panels closed) | head | pad | library · editor in Pads |
|---|---|---|---|---|---|---|
| 1440×900 | 68 | 234 (26 %) | 1,384 × 592 | 120 | 150 × 72 | panel · panel, never both |
| 1280×800 | 68 | 208 | 1,224 × 518 | 120 (96 beside a panel) | 130 × 72 | panel (pads 107) · panel (pads 97) |
| 1100×700 Tauri floor | 68 | 140 (floor) | 1,080 × 486 (no strips) | 96 | 115 × 72, groups folded | sheet · Build |
| 1024×700 browser | 68 | 140 | 1,004 × 486 | 96 | 106 × 72, groups folded | sheet · Build |
| 1024×665 MBP-14 | 68 | 140 | 1,004 × 451 | 96 | 106 × 58, groups folded | sheet · Build |
| 1024×768 touch | 68 | folded (24) | 1,004 × 670 | 96 | 106 × 72 | sheet · sheet |
| 390×844 touch | remote | — | 370 | 48 | ≥ 77 × 72 | tray |

Widths: 1440 − 36 − 20 = 1,384; 1,384 − 120 − 57 = 1,207 → 150 px pads. 1280: 1,224 − 177 = 1,047 → 130. 1100: no strips below 1,165, so 1,080 − 96 − 57 = 927 → 115. 1024: 1,004 − 153 = 851 → 106. With the library open at 1280 the grid is 1280 − 18 − 6 − 200 − 20 = 1,036 → 107 px pads; with the editor, 936 → 97, both above the floor.

**Below 1,165 px no side panel opens in Pads** — the Tauri floor and every 1024 client. There the library is the **library sheet**: the same component the phone's tray shows, laid over the grid from the right at `--size-library-w`, opened by `L`, the strip's `looks` key (line tier) or the label-cell chip `looks ›`, closed by Esc or a placement. On it, arm-then-place (2.7) is the whole gesture; drag-to-place is a 1440 / 1280 affordance. The editor on such a window is Build (⌥4 or the pad menu's `open`), one view switch — W-B and W-C are re-walked at 1024 in section 5.

Vertical need in Pads, every gap counted: heads 26 + song row 30 + 5 × 72 + groups 40 + 7 gaps × 3 + 20 wrapper padding = **497**, which becomes `--size-min-grid-h` (today 140, `tokens.css:202`, spent entirely on chrome at 1024, 42-build-1024.png). The pads-view clamp does not exist today — `clampLayout` caps `previzH` at `innerHeight − 420` and floors it at `MIN_PANEL` 150 in every view (`App.tsx:420-451`; the ~275 px band on 41-pads-1024.png) — so it is added: `previzH ≤ innerHeight − 68 − 6 − MIN_GRID_H`, floor `--size-min-band: 140`. Order of giving way: band to 140 → the groups row folds (−43) → pad-h to 58 (−70) → the band folds to its 24 px strip. Proven: 1440 and 1280 hold 497 outright; 1100×700 has 486, groups fold → 454 ✓; 1024×665 has 451, groups fold → 454 ✗, pad-h 58 → 384 ✓. Once the grid never scrolls vertically the 10 px classic scrollbar (`theme.css:880`) never narrows the pads.

```
Pads · 1440×900 · defaults
┌──────────────────────────────────────────────────────────────────────┬──┬──┐
│ strip 46 · status line 22 (folded)                                   │  │  │
│ band 234 · live 3D · state tag on the canvas          [3D|2D][view ▾]│lo│ed│
├──────────────────────────────────────────────────────────────────────┤ok│it│
│ go live ▸│ ◀ 01 · Still Air ▶  next: 02 · Undertow  editing: this song ▾ +▾│s │or│
│          │ ▶1·INTRO ▶2·BUILD ▶3·BREAK ▶4·DROP 5·BRIDGE 6·PEAK 7·OUTRO ■8·BLK│18│18│
│ LAYER 4  │ ▢       ▢       ▢       ▢       ▢       ▢       ▢       ▢ │  │  │
│ LAYER 3  │ ▢       ▢      ╔═════╗  ▓tide▓  ▓drift▓ ▓tide▓  ▢       ▢ │  │  │
│ ▪ Drift  │                ║drift║ glow                                │  │  │
│ LAYER 2  │ ▢       ▢       ▢       ▢       ▢       ▢       ▢       ▢ │  │  │
│ LAYER 1  │ ▓still▓ ▓still▓ ▓cold▓  ▓open▓  ▓cold▓  ▓blue▓  ▓still▓ ▢ │  │  │
│ DIALS  ▾ │ ◐ size ◐ hue  ◐ sat  ◐ rate ◐ spread ◐ mix  ◐ ·   ◐ ·    │  │  │
│ GROUPS ▾ │ ALL 100  DERBIES 100  BARS 100  STRIPS 100  HAZER 100    │  │  │
└──────────────────────────────────────────────────────────────────────┴──┴──┘
 120 + 8 × 150 + 27 + 30 = 1,377 ≤ 1,384 · whole song · pads 150 × 72 (today 108 × 58, 5 of 8 visible)
```

```
Pads · 1024×768 touch · locked · band folded
┌────────────────────────────────────────────────────────────────────┐
│ strip 46 (985 of 1,024) · status line 22                           │
│ ▸ band (24)                                                        │
│ locked   │ ◀ 01 · Still Air ▶   next: 02 · Undertow        tray ▸  │ 30
│          │ ▶1  ▶2  ▶3  ▶4  5  6  7  ■8                             │ 26
│ L4 ▮ ✕   │ 8 pads × 106 × 72, name strip 26                        │ 72 × 5
│ …        │                                                         │
│ GROUPS ▾ │ ALL  DERBIES  BARS  STRIPS  HAZER                       │ 40
└────────────────────────────────────────────────────────────────────┘
 96 + 8 × 106 + 27 + 30 = 1,001 ≤ 1,004 · vertical 497 ≤ 670 · the tray holds library, held, editor, setup
```

The empty top-left label cell (`LookGrid.tsx:1063-1068`) becomes the grid's one-line chip: `learning… click a target` in learn mode, otherwise the RigHint's action variants — `go live ▸`, `release hold`, `no rig yet → Rig`, `looks ›` on a window without a panel — never a paragraph (P6); the 50 px `.gridhint` (`LookGrid.tsx:918-960`) goes. On an editing page it reads `editing 02 · nothing fires · Esc`.

**Column heads** (`LookGrid.tsx:1069-1086`, today a bare `{col + 1} · {name}` with no live state; left click sends `column` at `:1076-1078`, right-click / hold edits through `contextPress` at `:1082`) gain a leading `▶` when any layer holds a pad there and `■` when none (firing it clears every layer — `triggerColumn` in both engines, `engine/state.ts:381-396`, `core/src/state.rs:712-737`; the demo's column 8), and `.colhead.live`: a 2 px `--color-live` rule while every layer holding a pad there is playing it (the mini's column-LED rule, `surfaces.ts:184-201`), 1 px when only some, a countdown bar while any `t < 1`; the next head carries a dim `next`. Everything the head needs is already in scope — `allLayers[].cells[col]` (`:982, :1023`) and `liveLayers[].col / t` (`:964`; `LayerSnap.col`, `.t`, `.lookId` at `shared/types.ts:720-728`, in both snapshots) — so the glyph, rule, countdown and `next` are render-only component work (M, lane 2, #14), not tokens, and no snapshot changes. What the head does on an editing page is a separate matter with new state behind it (2.5, #26).

### 2.3 The pad — all states

The two targets stay exactly (`LookGrid.tsx:314-353`, `theme.css:449-475`): the block fires on pointerdown; the name strip selects, drags and opens the menu. What changes is what the block shows and how each state is drawn, so the grid reads as eight looks rather than thirty-two boxes (01c-pads-grid-detail.png; empty and filled pads share one 1 px border, `theme.css:421-447`).

**The face is a miniature of the rig** (T2; Resolume adopt 9). `lookSwatch` draws vertical stripes with no spatial meaning (`lookColors.ts:10-48`; rendered at `theme.css:479-488`), so Cold Seam and Open Blue are the same blue block, a hue-effect look such as Blue Field is a rainbow, and an effect-only look is grey. A new `lookFace(look, project)` draws one mark per group the look touches, in stage order, coloured by that part's colour; hollow for an effect-only or position-only part; a dot row with the count for a steps look; memoised per look id and project generation. **`lookSwatch` and its first element are untouched**: the browser LED mirror reads `lookSwatch(...)[0]` (`surfaces.ts:160`, `:177`), and the Rust mirror re-implements that first-colour rule by hand as `swatch_first` (`apc.rs:76-121`) rather than reading it — the cross-check that would catch drift is `default_project_leds_match_browser_reference` (`apc.rs:549`). `lookFace` must never become the source for `--pad-glow` or the layer head's now-playing mini swatch (`LookGrid.tsx:426`); both stay on `lookSwatch[0]` so the screen and the LED agree.

```
 rest                playing              selected             stale               empty
┌───────────┐      ╔═══════════╗ glow   ┌───────────┐       ┌──────────◤ amber  ┌ ─ ─ ─ ─ ┐
│ ▮▮▮▮▮ ·· ○│ 0.55 ║ █████ ▪▪ ●║ 1.0    │ ▮▮▮▮▮ ·· ○│       │ ▮▮▮▮▮ ·· ○│ corner │         │ no border
├───────────┤      ╠═══════════╣ halo   ┣━━━━━━━━━━━┫ 2 px  ├───────────┤        │ fill    │
│ Cold Seam │      ║ Cold Seam ║ name   ┃ Cold Seam ┃ accent│ Blue Field│ --warn └ ─ ─ ─ ─ ┘
└───────────┘      ╚══▬▬▬▬═════╝ live   └───────────┘ rule  └───────────┘ on stage
```

Today every state is a border: playing is an accent border **plus** an `--accent-soft` fill and an on-accent name (`theme.css:446-447`); selected is a `--text-dim` border (grey-300, `:445`) — one step lighter than the hover border, which is `--line2`, grey-600 (`:430`), so hover and selected are two greys three stops apart; stale amber, learn-armed amber, drop dashed (`:507-520`).

| state | drawing |
|---|---|
| empty | fill-only well, `--color-border-pad-empty: transparent` |
| rest / hover | face 0.55 / 0.70; the block keeps its shape (it fires) |
| pressed | block to 1.0 in `--motion-press` 70 ms, eases back (no `:active` today) |
| playing | face 1.0, 1 px `--color-live` halo, 14 px glow in the look's first colour (`--pad-glow` inline), tungsten name; blooms in over `--motion-glow` 200 ms; no fill wash |
| fading | fadebar in `--color-live` (accent today, `:499`) |
| selected | 2 px `--accent` rule on the strip's top edge, accent name; border untouched, so it composes with playing (A17) |
| stale | amber corner mark; the strip reads the look on stage in `--warn`; tooltip names its song (A18) |
| learn-armed | accent dashed on the target; the grid under `--color-bg-wash-learn` with every target printing its binding, duplicates in `--hot` (Resolume) |
| place target | dashed accent + soft fill, unchanged |
| flash / steps | bolt glyph in `--text` (the `FLASH` word goes); **held** = face 1.0 + `--color-live` halo, bolt filled, no glow (it is not playing, it is being held); chain glyph, dot row shows position |
| focus | 1 px ring 2 px *outside* the pad, so focus ≠ selected ≠ playing |
| pinned | pin glyph bottom-left |
| inert (editing page) | face 0.55 under the blind tint, `cursor: not-allowed` on the block; a press flashes the label-cell chip |

Name strip: `--text-pad-name-size: 11`, `--padname-h: 22` (touch 26), sentence case as authored (GLASS ATLAS is forced to caps today, `theme.css:411`), two-line clamp. The pad menu is an anchored popover, no veil (today `askChoice` veils the playing pads, `LookGrid.tsx:216-236`, `dialog.tsx:82`; 03-pads-pad-menu.png): open · duplicate · **duplicate as flash on the top layer** (`→ Layer 4 · col 3`, or the first empty column to the right, greyed with `Layer 4 is full` when none) · **put on this pad in every song** (a write to every song in the project — twelve in W-A's set — with an inline undo chip) · show in library · clear pad · ⋯ rename · delete. One `Popover menu` component (`docs/design/system.md:89`) serves pads, heads, columns, songs and tiles.

### 2.4 The layer head

Today 184 × 90 (`theme.css:400-412`; `tokens.css:175`) with a live blend `<select>` beside the ✕ (`LookGrid.tsx:387-402`) — more than half the pad area, and a build-time control on the performance row. The head becomes **120 × pad-h**, sticky-left (`theme.css:392-398`): line 1 `LAYER 3 · dims · ✕` (name in `text/key`, blend a read-only tag, ✕ a ghost unless something is playing — the hardware's rule, `surfaces.ts:182`; the ghost has no hover state, a hover on an idle layer changes nothing); line 2 the now-playing mini swatch (from `lookSwatch[0]`) and name in `--color-live`, an unlit well when idle (today a bare `—`, `LookGrid.tsx:433`); line 3 the master, neutral fill, amber readout below 100.

Right-click / hold the head (the `contextPress` route columns and songs use, `LookGrid.tsx:563, 1082`) opens a popover: blend; fade `0.3 s` as a scrub-number (`layer.fade` exists at `shared/types.ts:414` and nothing in the UI edits it); select what's playing (A6); later rides-through and bypass. Clicking the now-playing line selects the live pad without firing. For ten seconds after a ✕ the line reads `— was Cold Seam ↩`, ↩ sending the same `trigger` the pad would (Hog Pig + Clear); never for a flash look, never by itself. **In touch mode ✕ is hold-to-clear**: a ring fills over `--motion-hold`, and `--motion-hold` and `LONG_PRESS_MS` are one number by construction, not by coincidence — `hold: 500` joins the Motion collection in `tokens.json`, `build-tokens.mjs:159-184` already emits a `motion` object with the unit stripped, and `touch.ts:15` becomes `export const LONG_PRESS_MS = motion.hold` (today it is a hand-typed `500` that imports nothing from `tokens.ts`; `Previz2D.tsx:643-655` runs its own `setTimeout` on the same constant and is fine once the constant is derived). The ring restarts when the 8 px slop cancels the timer (`touch.ts:64`), or it would keep filling on a hold that has already been abandoned. Laptop click and APC scene buttons are unchanged. After a song switch the line reads `Cold Seam · from 01 Still Air` in `--warn` (A18), reading `LayerSnap.deckId` and treating `undefined` as "this song" so the UI ships before the snapshot field. The DIALS head gains **`controller ▾`** — a direct menu: `APC40 mk2 · APC mini mk2 · APC40 mk2 busk · learn…`, loading the preset in place with an inline `undo` chip, no confirm (today ⌥4 → Sync · MIDI → LOAD → `Load the APC40 mk2 preset?`, `SyncView.tsx:173-177`; the preset replaces `p.midi`, which is autosaved, so it is loaded once per project, not per set). The GROUPS head shows eight pinned slots with `all ▾` (A14; today one fader per group, `LookGrid.tsx:743-800`).

### 2.5 The song row, and the page you are editing

Today: twenty chips with a hidden scrollbar (`theme.css:1036`), ◀ ▶ that switch live on every press (`LookGrid.tsx:526-552`), `+ song` that creates and switches immediately (`:635-651`).

```
SONG ◀ 01 · Still Air ▶   next: 02 · Undertow ✎     editing: this song ▾     + song ▾
     live switch (APC bank twins)  set-list note      the page the grid shows   never switches while playing
```

The current chip is `--color-live` text. Clicking it opens the **song picker** popover (the `ProjectMenu` pattern, `TopBar.tsx:83-104`): every song numbered, ★ home first (key `0`, unbound today, `shortcuts.ts:70-150`), each with its note, type-to-filter, Enter switches live. Song 15 from song 1 is one gesture, not fourteen live presses.

**`editing: this song ▾`** is the P3 fix, and it is UI-only. Picking another song sets `editingDeckId`; the grid renders `decks[x].cells` under an `alpha/blind-6` tint, the chip reads `editing: 02 · Undertow` beneath a 2 px `--accent` rule (the cursor colour: it is the programmer's page), the strip's project name yields to `editing 02 · Undertow` in accent, the band's state tag reads `EDITING 02`, and the label cell says what follows. Esc, or a song switch from any source, returns editing to live.

**On an editing page nothing fires from the screen — decision 0.** The hard constraint reads "clicking a pad body fires it"; an editing page is the one place this design bends it, and the owner must say yes to the bend before it is built. The default written here: the pad **body is inert** (`cursor: not-allowed`; a press flashes the chip `editing 02 — fires only on the live page`), because the body's meaning must stay "fire, or nothing" — never "select", which is the strip's job; the name strip selects, drags and opens the menu as always; column heads *select the column* — accent rule, the grid scrolls to it; keys `1`–`9` do the same. The heads say so themselves, not only the label cell: they drop the ▶ / ■ glyph and the live rule (both belong to the room), are set in `--text-dim`, and their tooltip reads `select column 3 · editing 02 — fires only on the live page`. T5 left the heads firing the live page with the truth on hover; every judge called that a misfire-shaped ambiguity. The inverse — a hand reaching for `4` or a pad while the grid happens to show song B and getting nothing — is a misfire too (section 8, rule 18), and four things stand between it and a dark drop: the strip's name slot, the tint, the dim heads, the chip. The alternative, spelled out in section 9, is that the editing page is only ever shown in Build, so Pads never shows anything but the live song. The APC keeps firing the live page either way, because the engine never knows which page the screen shows.

```
Pads · 1440 · editing 02 · Undertow while 01 · Still Air plays
┌──────────┬────────────────────────────────────────────────────────────────────┐
│ SONG ◀ 01 · Still Air ▶   next: 02 · Undertow    editing: 02 · Undertow ▾  Esc │ current chip tungsten
│                                                  ━━━━━━━━━━━━━━━━━━━━━━━━━     │ 2 px --accent rule
├──────────┼────────────────────────────────────────────────────────────────────┤
│ editing  │ 1·INTRO  2·BUILD  3·BREAK  4·DROP  5·BRIDGE 6·PEAK  7·OUTRO  8·BLK │ heads --text-dim: no ▶/■,
│ 02 ·     │                  ━━━━━━━                                           │ no live rule; the selected
│ nothing  ├────────────────────────────────────────────────────────────────────┤ column wears the rule
│ fires ·  │                                                                    │
│ Esc      │                                                                    │
├──────────┤                                                                    │
│ LAYER 4  │ ▢       ▢       ▢       ▢       ▢       ▢       ▢       ▢          │ heads read the room:
│ · idle   │                                                                    │ song 01, live masters
│ LAYER 3  │ ▢       ▓haze▓  ▢       ▓tide▓  ▢       ▢       ▢       ▢          │ pads: decks['02'].cells
│ ▪ Drift  │                                                                    │ face 0.55, body inert
│ LAYER 1  │ ▓warm▓  ▢       ▓cold▓  ▢       ▢       ▢       ▢       ▢          │ drop writes decks['02']
└──────────┴────────────────────────────────────────────────────────────────────┘
 the grid under alpha/blind-6 · the strip's name slot reads editing 02 · the heads and the APC never change
```

The layer heads keep reading the live page; the ✕, the masters and the panic pair keep their live meaning because they live on the head and the strip, which always show the room. T2 shipped the opposite rule — a pad press on an edited-not-live song sending `switchDeck` then `trigger` — and the panel rightly called it disqualifying.

**What the editing page touches**, so change #26 is sized honestly. The UI has no viewed-page-≠-live-page state today: `cols = project.columns` (`LookGrid.tsx:971`) and `layer.cells` mirror the active deck (`shared/types.ts:688-689`). Selection is a page-blind `{layerId, col}` that every reader resolves against the live page — `previewLook` in `store.ts:457-458`, `LookEditor.tsx:1042`, `EditorPane.tsx:22`, `PrevizPanel.tsx:38` — and LookEditor writes cells there too (`:1088` new-look-on-pad, `:1105` pick-look, `:1173` put-here, `:1190` clear). So `sel` gains `deckId`; every reader resolves through it; `placeLook`'s deck guard (`LookGrid.tsx:29-32`) targets `editingDeckId` rather than `activeDeckId` and its trailing `setSel` (`:39`) carries the deck; duplicate / move / clear pad (`:59-98, 117-133, 224-231`), `editColumns` and the head row (`:971, 992-997`, `columnMenu`) read and write `decks[x].columns` and resize `decks[x].cells` when x is not live; `LookLibrary.tsx:28` counts across decks; keys `1`–`9` branch in their `run` (`shortcuts.ts:71-79`). A store field, two handlers and six readers: **M, UI-only**, not one click handler.

**Write routing**, stated so it can be checked. When `editingDeckId` is not the live song, a drop or pad-menu verb writes `decks[editing].cells[layerId][col]` and does **not** touch `layers[].cells`; otherwise today's path runs (`LookGrid.tsx:15-41`). The two cannot collide in the engine: `storePage` writes only the *active* page into its own deck (`engine/state.ts:221-227`; `core/src/state.rs:471`), `loadPage` reads `decks[x].cells` only when x becomes live (`:230-239`) and on undo `restore` (`:300-306`, which replaces `decks[]` from the snapshot — so an undo rolls back an editing-page write like any other edit, the expected semantics); `updateProject` stores the project as sent after sanitise (`engine/state.ts:708-722`; `core/src/state.rs:1189`), and the only rewrites either engine makes are `ensure_decks` / the sanitiser's deck migration (`state.rs:409-441`; `shared/types.ts:1078-1090`), which seed a first deck when `decks` is empty and re-point a dangling `activeDeckId` — neither reads or resizes an existing deck's cells. Two consequences the client owns: (1) a non-active deck's cells are not padded or validated until `loadPage` runs, so the client write keeps `cells[layerId].length === decks[x].columns.length` and prunes ids against `project.looks` when a look is deleted while a page is being edited; (2) the round-trip is gated **before** the state machine — a full-project write whose `baseGen` is stale is dropped and the sender re-synced (`engine/index.ts:390-393`; `core/src/engine.rs:1061-1068`), every APC fader or haze move bumps the generation, and the client today replaces its project with the echo and never retries (`store.ts:667-686`). So a B-page drop made while the busking hand rides a fader would be silently lost. The fix is client-side: when an echo arrives with `gen` ≠ the optimistically advanced `lastGen` while `editingDeckId` is set, merge `decks[editing].cells` onto the fresh echo and resend once — safe precisely because the editing deck cannot conflict with the live page — and if that too is rejected, notify `the song switched while you were placing — nothing was placed on 02` (mirroring `LookGrid.tsx:31`) and keep `editingDeckId` where it was. Editor writes go to `project.looks[id]`, the pool, and were never page-dependent. No engine change, no parity case; `LayerSnap.deckId` (lane 3) only makes the head's caption exact.

### 2.6 The editor

One editor, two homes (`EditorPane.tsx:5-11`, `BottomPanel.tsx`) stays. The stripe, the header, the part body and the fader change.

```
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓ stripe: LIVE / NOT ON THE RIG / HELD
┃ LIVE · edits reach the rig now           Layer 3 · col 3   on 4 pads · 2 songs ▾ ┃
┃ [Drift (very slow)        ]  ⚡ flash  fade [0.3] s     ▶ fire  nudge  blind  ⋯  ┃
┃ ┌ Strips L→R ──────────────────────────────────────────── remove part ┐          ┃
┃ │  Intensity ●   Colour ●   Position   Beam   Haze                    │          ┃
┃ │  DIMMER   ▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮░░░░░░░░░   45 %                           │          ┃
┃ │  STROBE   ○ off · 12 Hz                                             │          ┃
┃ │  ─── effect · dimmer · sine · 8 bars = 15 BPM · size 90 % · ⋯       │          ┃
┃ │      ▸ spread: order · tile 1 · buddy 1                             │          ┃
┃ └─────────────────────────────────────────────────────────────────────┘          ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
```

- **Stripe** (A2): `liveLookId === lookId && liveCol === col` (`LookGrid.tsx:167`) *and the editing song is live*. LIVE = 3 px `--accent` rule and caption; NOT ON THE RIG = the pane grounded in `--color-bg-blind` (a 6 % tint over `--panel`, not a fourth surface colour, so it reads the same in the side column, the bottom panel and the phone tray); HELD = `--warn` while frozen.
- **Header** (B2): name · flash key · fade · shared-by chip counting every deck (`LookLibrary.tsx:26-31` counts one song today) with *make this pad its own copy*. The nine-control header (`LookEditor.tsx:1133-1263`) loses the 190-entry swap `<select>` (`:1167`), CLEAR PAD (`:1194`) and DELETE LOOK (`:1261`) to `⋯`. `▶ fire` is a key with the tungsten lamp, absent on a page that is not live; `nudge` and `blind` are latches with the amber lamp (`blind` is A10, lane 3; until then the key is absent).
- **Part body** (A1): Intensity · Colour · Position · Beam · Haze from `groupCanAim / groupCanWhite / groupBeamCaps / groupOptics` (`LookEditor.tsx:72-151`); a dot when enabled, amber when nudged. `FX_CATEGORIES` (`fxLibrary.ts:37-43`) is renamed, not silently: Movement → Position; "Strobe and white" → Intensity (strobe rows) and Colour (white rows); Dimmer → Intensity; the rest keep their names. Search words follow the new names; each preset keeps its `cannot take` flag per group under its new section, so a derby preset that only strobes still greys for a group without a strobe channel. ‹ › steppers on the slot pickers (MagicQ).
- **Effect row**: line 2 is a self-summarising disclosure opening to the eight spread pictograms as glyphs (today ◎ ⤨ ↔ ◇ ⇄ at five weights, `LookEditor.tsx:36-43`); the rate reads as beats per cycle **and** the BPM it resolves to at the current tempo — `8 bars = 15 BPM` — beside the select (B6); granularity as words — per pixel / per strip — sets buddy from the head count; opening it numbers the heads on the plan (A39; `shared/effects.ts:178-230`).
- **Fader** (`Fader.tsx`: 77 lines, drag and double-click only, `:63`): `--size-fader-max-w: 320`; value in a `--size-value-w: 44` mono column outside the fill (10b-build-editor-detail.png shows SIZE's `90%` struck by the fill edge); click to type, right-click resets; `role=slider`, ← → 1 %, ⇧ 10 %, Home / End. **The fader keeps focus after pointer-up** so the arrows work after a click in the booth; its own `onKeyDown` owns the arrows and the digits with `stopPropagation`, and the window key handler (`App.tsx:191`, which steps aside only for INPUT / SELECT / TEXTAREA) additionally steps aside for `[role="slider"]` and `isContentEditable` — the pattern `ColourWheel.tsx:141-147` already ships. Revision 1's "focus leaves on pointer-up" would not have closed the hazard (the first keydown fires, `e.repeat` is already dropped at `shortcuts.ts:159`) and would have broken the arrows it promised. Strobe is a rate, not `60 %` (`LookEditor.tsx:804-807`). `→ dial ▾` on any row appends a `ControlLink` (`shared/types.ts:423-430`); `dials for this look` writes eight (A32). This is component work: M.
- **Build's grid** is the context row: a 24 px **layer tab strip** (`L1 L2 L3 L4 · DIALS`, the selected layer lit) over the column heads and the selected layer's single 58 px pad row — 24 + 26 + 58 + 2 gaps = **114**. Switching layer inside Build is one tap on the strip, so "edit the Layer 4 strobe while Layer 1 is selected" never leaves Build (B1 without B5's cost). Today Build shows all rows (10-build-look-editor.png).

```
Build · 1024×700 (browser) / 1100×700 (Tauri floor)
┌──────────────────────────────────────────────────────────────┐
│ strip 46 · status line 22                                    │ 68
│ audition 200 (floor 140)                                     │ 200
├──────────────────────────────────────────────────────────────┤ 6
│ L1  L2 [L3] L4  DIALS                                        │ 24  layer tab strip
│ ▶1·INTRO ▶2·BUILD ▶3·BREAK ▶4·DROP 5·BRIDGE 6·PEAK 7·OUTRO ■8│ 26
│ ▓still▓ ▓still▓ ▓cold▓ ▓open▓ ▓cold▓ ▓blue▓ ▓still▓ ▢        │ 58  Layer 3 only, pads 106 × 58
├──────────────────────────────────────────────────────────────┤ 6
│ editor 306 (1100×700) · 271 (1024×665; 331 with the audition at 140)
└──────────────────────────────────────────────────────────────┘
```

Build at 1440×900: 46 + 22 + audition 200 + 6 + context row 114 + 6 = 394 → **506 px of editor** (today 260, 10-build-look-editor.png); 1280×800 → 406; 1100×700 → 306; 1024×665 → 271, or 331 once the audition gives way to its 140 floor. Build's floor is the tab strip + heads + one pad row + 260 of editor; the audition gives way first, then folds. Build keeps Look and Controls (B5).

### 2.7 The library

Today 190 alphabetical rows, text search only, no menu, `×N` counting one song (`LookLibrary.tsx:15-31`); Ash, Ember, Red Pump twice each (01-pads.txt).

```
┌ 280 ──────────────────────────────────────────────────┐
│ ◂ looks · colour 41                        [search   ] │
│ all · this song · on stage · ⚡ · ⛓ · unused · group ▾ │
│ ┌──────┐┌──────┐┌──────┐┌──────┐                      │
│ │▮▮▮▮··││▮▮▮▮▮▮││ ▮▮ ⚡ ││▮▮ ⛓3 │  tiles 64 × 44        │
│ │Abyss ││Acid B││Acid H││Acid R│  I C P B  ×2 · 3 songs│
│ └──────┘└──────┘└──────┘└──────┘                      │
│ ‹ 17–32 ›  of 190                                      │
└────────────────────────────────────────────────────────┘
```

Tiles carry the rig-miniature face, corner marks, I·C·P·B kind glyphs per enabled family (ONYX), the first part's group for twins (`Ash · Derbies`), and `×pads · songs` across every deck (Lightkey); chips are computed, never hand-tagged (A7, A25). Sixteen tiles at a time is the APC's own count — two rows of the 5×8 — and the page marks `‹ 17–32 ›` are the bank arrows, not a paginator (Eos direct selects, A8). Right-click / hold a tile: open · rename · put on this pad in every song · show on pads · show on plan · delete with `used on N pads in M songs`; greyed when none of its groups exist in this rig. On touch, and on any window where the library is a sheet, **arm-then-place**: tap a tile (it takes the accent ring and the chip reads `place Cold Seam · tap a pad's name`), tap a pad's name strip — `placeLook` with its guard (`LookGrid.tsx:15-41`); the tile stays armed for the next pad until Esc, so six placements are one arm each. Drag stays on top on the 1440 / 1280 laptop. Both 190-entry `<select>`s (`LookEditor.tsx:1099-1116, 1163-1185`) become this list as a popover. A `palettes` strip (lane 3) replaces the twelve hard-coded `SWATCHES` (`LookEditor.tsx:43-49`).

**Project-wide find** (A40, Lightkey): `⌘F`, or `/` when no field is focused; looks, songs, columns, groups, fixtures; Enter acts by kind — look → its first pad or the library; song → switch, shown as the live action it is; column → scroll, never fire; group → its Rig row; fixture → select on the plan. "Which song has Ember Blue on the drop" has no answer today.

**Empty states**, each a label-cell-style chip, one line, the app's words, with the verb it offers:

| surface | reads | offers | glyph |
|---|---|---|---|
| pad | (a well; nothing) | drop, or double-click → new look | — |
| now-playing line | an unlit well | — | — |
| library, new project | `no looks yet` | `+ new look` | `add` |
| library, no hits | `nothing called "ember"` | `clear search` | `find` |
| song picker, one song | `01 · Song 1 — the only song` | `+ song` | `add` |
| GROUPS row, none pinned | `pin a group ▾` | the `all ▾` menu | `pin` |
| DIALS row, none | `no dials · dials for this look` | that verb | — |
| rig table, no fixtures | `no rig yet` | `+ add fixture…` · `⇩ import` | `add` |
| held chip, nothing held | not rendered | — | — |
| plan, nothing to aim at | `aim at ▾ — add a musician or a truss on the plan` | Stage section | `home` |
| grid, no rig | `no rig yet → Rig` | the view switch | — |

### 2.8 The band

**Pads**: 26 %, live 3D; the audition appears only when the selected look differs from what its layer plays (P7; today `previewPane` defaults true, `store.ts:358`, and shows whenever `sel` is set — a condition in `PrevizPanel.tsx:282-287`, so this is a small code change, not a default flip). One state tag on the canvas — `OFFLINE` / `HELD` / `BLACKOUT` / `EDITING 02` / `FINDING Spiider 2` — drawn by the component that draws the label-cell chip. The bar is `3D | 2D` · `stage window` · `view ▾`; SNAP and MEASURE leave for Rig's 2D (R6; four toggles lit cyan by default today, `store.ts:358, 374-377`). **Build**: the audition alone, 200 px. **Rig**: the plan as a column beside the table, not a letterbox borrowed from under a live stage (`store.ts:464-493`). **Stage** (`theme.css:95`): `3D | 2D` + `stage window`, the tag on the canvas so a frozen rig cannot animate unlabelled (30-stage-3d.png). In Pads the plan is a tappable, locked sheet (A21). Selecting a pad by its strip outlines the heads its parts drive, tagged with the enabled families (A38; a second ring style beside `Previz2D.tsx:332-341`): the audition shows what a look does, this shows where.

```
Stage · full screen (the second display, or ⌥2)
┌────────────────────────────────────────────────────────────────────────┐
│ 3D | 2D · stage window                               ● LIVE  01 · Still Air │ 46
│                                                                        │
│                        the rig, live                                   │
│                                                                        │
│  HELD                                            (tag, top-left, 22px) │
└────────────────────────────────────────────────────────────────────────┘
```

### 2.9 The rig page

No tab bar: Rig owns Fixtures; Output and Sync · MIDI move to the setup surface. A section rail replaces the scroll (`PatchView.tsx:502-1580`; 23-rig-scrolled-bottom.png).

```
┌ rail 120 ┬─ table 1fr ───────────────────────────────────┬─ plan 38 % ──────────────┐
│ Fixtures │ [find…]  + add fixture…  ⇩ import  ⇢ re-address│ PLAN | FRONT  move·turn·sel│
│ Groups 7 │ FIXTURE    PROFILE          U  ADDR    CH  ● ◎ ⋯│     ▪▪▪▪▪▪▪▪ strips        │
│ Stage    │ Spiider 1  Robe Spiider     1  1–49    49  ● ◎ ⋯│   ✱  ▪▪  ●  ▪▪  ✱          │
│ Profiles │ Spiider 2  Robe Spiider     1  50–98   49  ● ◎ ⋯│  ◐         ◐   ♪ drummer   │
│ Library  ├────────────────────────────────────────────────├───────────────────────────┤
│          │ Spiider 1 · position · mount · ▸ calibration   │ AIM · 4 selected            │
│          │                                                │ aim at ▾ drummer · store · ◎│
└──────────┴────────────────────────────────────────────────┴────────────────────────────┘

Rig · 1024 wide: rail 120 + 6 + table 557 + plan 341 (38 % of 898)
table columns: name 140 (sticky) · profile 120 · U 28 · addr 64 · ch 36 · ● ◎ ⋯ 66 = 454 + 6 × 12 padding = 526 ≤ 557
```

**Table** (R3): name sticky-left, profile, universe, address as one mono `1–49` (today `1` over `–4`, 20b-rig-table-detail.png, `PatchView.tsx:592-604`), channels, the live pair by the name — ● mute, ◎ find behind a `--motion-hold` hold because it overrides blackout and sits 24 px from mute today (`:741-748`). Position, mounting and calibration move to the **inspector** under the table, so the header no longer ends at `RIGGE` (20-rig-patch.png). Find-as-you-type; the conflict chip lists rows; plan selection scrolls the table (`Previz2D.tsx:660-680` never scrolls); a typed prefix selects on the plan (A43). **+ add fixture…** asks type, count, universe and start address together and selects the new rows (today a generic 3-channel par, `PatchView.tsx:783-797`; the library three screens down lands at (0, 2, 0), `FixtureLibrary.tsx:93-95`). **The aim strip** under the plan: `aim at ▾` lists the plan's musicians and structures; the UI computes each head's pan/tilt from its own position and calibration (the inverse of `shared/aim.ts`) and writes base aim — no schema change; a stored plan point (A13) stays L. **Groups**: members only, in chase order, `+ heads…`, `add N selected to ▾` (today 525 chips, `PatchView.tsx:1090-1172`). **Look from selection** (A44): heads selected + an empty pad → a group, a one-part look, the pad pointed at it, the editor open (`selection.ts:10-27`; `LookEditor.tsx:1077-1094`).

### 2.10 The setup surface

Output · Sync · MIDI · Display · **Lock** · Licence · Updates as one sheet (`AdminModal`, `--size-modal-wide-w 680`), reached from ⚙, the OFFLINE gate, any lamp, the DIALS head's `controller ▾ → learn…`, and `⌘,`. Sync · MIDI opens as `APC40 mk2 · 52 mappings · learn` with the prose behind `?` and the table behind a disclosure (B9); the MIDI-learn toast names what it bound in the app's words — `note 53 → Layer 2 · pad 3` (P12). Display carries the touch preference and, on a networked client, the address `http://192.168.1.12:9900` in `text/readout` with the same address as a scannable code beside it (`AdminModal.tsx:167-171` only says there is nothing to manage). Lock sets the passcode and shows the default rule (2.11).

### 2.11 The FOH remote

The remote is the Pads view under `app.remote` — `touch` on **and** the window under 900 px. Same components, one layout state. T4's graft replaces T5's 40 px colour-only pads (below a fingertip; a fat tap fires the neighbouring column) with four pads per page behind a page key.

```
390×844 · app.touch.remote · locked
┌────────────────────────────────────────────┐
│ BLACKOUT │ ALL STOP │ MASTER ▮▮▮ 100 │ ● LIVE│ 56
│  ◀  01 · Still Air ▾           ▶   held 2  │ 44
│           [ 1–4 ]  [ 5–8 ]                 │ 28  page key: two positions, like the bank arrows
│    │▶1·INTRO│▶2·BUILD│▶3·BREAK│▶4·DROP│    │ 30  heads: this row pans
│ 4▮✕│        │        │        │        │   │ 75  pads ≥ 77 × 72 · head 48
│ 3▮✕│        │        │ ▒Drift │ █Tide  │   │ 75
│ 2▮✕│        │        │        │        │   │ 75
│ 1▮✕│ ▒Still │ ▒Still │ ▒Cold  │ █Open  │   │ 75
╞════╪════════╪════════╪════════╪════════╡
│DIAL│ size   │ hue    │  ·     │  ·     │   │ 72
│GRPS│ ALL    │ DERBIES│ STRIPS │ BARS   │   │ 72
│ L4 ▮▮▮▮ 100  L3 ▮▮▮▮ 100  ▲ SPEED HAZE TAP │ 56  levels tier
│ [lock] locked · hold to unlock   edit ○  ? │ 44
└────────────────────────────────────────────┘
 grid-template-columns: 48px repeat(4, minmax(0, 1fr)) · no add column · width 100 % · cannot overflow
```

- **The row cannot overflow, by construction.** Revision 1 counted three gaps; a head plus four pads in one grid has four (`theme.css:373`), and the add-column track would add a fifth plus 30 px: 48 + 4 × 78 + 12 = 372 > 370 at 390 wide, a 2 px sideways scroll over pad bodies — exactly the thing forbidden. Under `.app.remote` the template is `48px repeat(4, minmax(0, 1fr))`, the add column is not rendered (an edit affordance the locked remote cannot use), and `.lookgrid { width: 100% }` replaces `max-content` so the grid can never exceed its wrapper (`theme.css:373`, `LookGrid.tsx:1060` — a remote branch on the template, M). Pads are (370 − 48 − 12) / 4 = **77.5 px at 390**, (355 − 60) / 4 = **73.75 at 375** (SE / mini): above a fingertip on every phone the remote covers.
- **Paging**: the page key is the tap route; a swipe pages only when it begins on the column-head row, and that row is a native scroll container — `overflow-x: auto; scroll-snap-type: x mandatory; touch-action: pan-x` — so the browser itself cancels the click that follows a pan and no trailing click reaches the head's `onClick` (`LookGrid.tsx:1078`). No JS pointer pager: `contextPress`'s `SLOP_PX` and its `onClickCapture` guard only the long-press menu echo (`touch.ts:17, 60-66`), and a pointer-driven pager that let a short swipe inside one head land a click would fire that column live — the misfire class the page key exists to remove. Pad cells keep today's touch-action (they lack `touch-action: none` on purpose, `theme.css:335-349`) and gain `touch-action: manipulation`, so a press is a press and is never followed by a pan or a double-tap zoom; with the grid at 100 % there is nothing under a pad to scroll. A swipe beginning on a pad is a pad press, as today (`LookGrid.tsx:284`). Column 8 is on page 2; BLACKOUT at the top does its job on either page (decision 5).
- **Lock** (backlog #13 layer 1, `docs/feature-backlog.md:545-557`, M; the default is this design's own decision, the backlog does not set one): `locked` persisted per client like `view` (`store.ts:180-188`). **On by default when `touch` is on, or when the client's host is not the engine's own** — `location.hostname` compared with the address the engine reports, never keyed on "no Tauri bridge", because the owner's own laptop runs the UI in a browser against the Node reference engine every day (`npm run dev`, `npm start`, `README.md:43-47`) and must not boot locked. Locked: Pads only; no latch; no sheets but help, levels and the picker; pads, columns, songs, dials, groups, masters, blackout, all stop and freeze all work. Unlock: hold the `lock` glyph for `--motion-hold`, then the passcode if set. Only the passcode persists; the unlocked state does not — a reconnect, a reload or 30 s idle re-locks, so "on by default" holds at every show, not until the first unlock. The passcode lives in the client's localStorage: a deterrent, and its help says so — it *keeps a leaning elbow off the Rig page until the server-enforced role exists*, and it does not stop a WebSocket client sending `updateProject` (the L layer).
- **The edit latch** (unlocked): the MIDI-learn arm shape. Latched, the grid takes the cyan wash and the whole pad selects — tap = select, hold = menu, tap-after-arming-a-tile = place; nothing fires. Per client; exclusive with MIDI learn; cleared by ALL STOP, a song switch, leaving Pads, and 30 s idle. `E` toggles it on the laptop (decision 0).
- The **tray** — the desk's pull-out, a `tray` key on the bottom bar, not a hamburger — holds the library, the held list, the editor (full-screen on the phone, with the stripe) and the setup surface. The **tablet** at 1024×768 is not the remote: Pads with touch density (`tokens.css:326-340`), band folded, eight columns at 106 × 72 (2.2), locked, the tray for library and editor. On 60-tablet-pads-touch.png the client opened on Rig ▸ Look because `view` comes from localStorage (`store.ts:180-188`); a networked client opens on Pads.
- A networked client gets two lines under the strip — *This is the show running on the Mac. Locked to the pads; hold `lock` to unlock* — never "set up my own rig" (`WelcomeCard.tsx:60-72`). Reveal strips are not rendered where they cannot open (`App.tsx:300-345` renders them always today). Toasts land top-right (`theme.css:1186-1194`); **project toasts go to the requester only**, which is an engine change in both engines — Node broadcasts at `engine/index.ts:623, 633-656` (`server.send` at `:350` is the per-socket shape), Rust at `core/src/engine.rs:856, 993-1042` (`bc.send_to` exists beside `bc.broadcast`) — lane 3, #56, with a parity case.

---

## 3. Visual identity

### 3.1 Palette tokens

Primitives to add: `tungsten/100` `#f3ebd7` (a lamp at full; 11:1 on `--panel`) · `tungsten/300` `#c9bd9e` · `alpha/tungsten-20` `#f3ebd733` · `alpha/blind-6` `#5c7cff0f` · `alpha/accent-8` as an alias of `alpha/cyan-8` · an **Opacity collection** (Figma number variables) `face-rest 0.55 · face-hover 0.70 · face-playing 1`.

| token | value | means |
|---|---|---|
| `--color-live` | `tungsten/100` | what is playing: pad halo, now-playing name, current song, column rule, fadebar, LIVE lamp |
| `--color-live-dim` | `tungsten/300` | fading out; `was …` |
| `--color-lamp` | alias of `--color-live` | the 5 px lamp on a pressed key — the desk's own light, one family with what is playing |
| `--accent` | `cyan/500` (unchanged) | **only** the cursor: selected pad rule, editing-song rule and name slot, LIVE stripe, focus, place target, armed tile, latch and learn wash |
| `--color-key-fill` / `-edge-hi` / `-edge-lo` | `grey/800` / `alpha/white-6` / `alpha/black-50` | a key's face, top edge, bottom shade |
| `--color-fader-fill-rest` / `--color-fader-down` | `alpha/white-7` / `amber/400` | a master at rest / its readout below full |
| `--color-bg-blind` | `alpha/blind-6` | the editor ground off the rig; the grid on an editing page |
| `--color-bg-wash-learn` | `alpha/accent-8` | the grid while learn or the latch is on |
| `--color-border-pad-empty` | transparent | an empty pad is a well |
| `--color-bg-seam` | `grey/700` (was `grey/0`) | seams are hairlines (`theme.css:30-34`) |
| `--color-status-nudge` | alias of `--warn` | one amber (today 400 and 500, `tokens.css:109, 112`) |
| `--color-status-ok` | `grey/300` | a healthy lamp is bright, not green; trouble is amber, loss is red |
| `--pad-glow` | inline from `lookSwatch[0]` | the one place saturated colour leaves the pad |

Four hues, not five, and none of them a semantic set: tungsten is the desk's own light (playing, lit keys), cyan is the cursor, amber is attention (held, below full, stale, nudged), red is the blackout family. Green is retired from the palette — the status dots read brightness (`--color-status-ok`) for health, amber for degraded, red for lost. Removed *uses*: `--accent` on the wordmark (`TopBar.tsx:202`), `.btn.on` for LIVE and the stage-bar toggles, tab fills, the song chip, `.fader .fill` on the grand master (`theme.css:243-248`), `.cell.active`'s `--accent-soft` fill and `--color-text-on-accent` name (`theme.css:446-447`), the library count. `--flash` leaves the pad and stays for the APC's held-flash LED.

### 3.2 Type scale

Two named families, four sizes, three weights; twelve styles replace thirty-six and account for every existing one. Seven sizes sit inside a 3 px band today (`tokens.css:298-309`); thirteen `text-transform: uppercase` rules become two.

**The families.** Today `--font` is the system stack (`tokens.css:212`: `-apple-system, BlinkMacSystemFont, …`) and there is no mono token — that is the bootstrap default the owner asked to leave, and SF Mono does not exist on an Android or non-Apple tablet at FOH, so a BPM readout there would fall to Courier. The sans is **IBM Plex Sans** and the mono **IBM Plex Mono**: one family for the keys and the readouts, drawn for machine-room signage rather than a marketing page, with a true tabular figure set, a slashed zero (`zero`) and a `500` that holds on a dark ground at booth brightness. Both are OFL, self-hosted as woff2 under `ui/public/fonts` and served by the engine like the rest of the UI (a gig has no CDN), 400 / 500 / 600 for the sans, 500 for the mono — six files, ≈ 180 KB. Tokens: `--font: 'IBM Plex Sans', -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif` and `--font-mono: 'IBM Plex Mono', 'SF Mono', ui-monospace, Menlo, monospace`, both in `tokens.json` so Figma and the CSS name the same faces.

| style | px / weight / tracking | case | used for |
|---|---|---|---|
| `text/micro` | 9 / 500 / 0.10em | caps | corner marks, kind glyph labels, table heads, lamp words |
| `text/label` | 11 / 500 / 0.12em | caps | section labels (DIALS, GROUPS), row labels (DIMMER), column heads |
| `text/key` | 11 / 600 / 0.10em | caps | hardware keys: ALL STOP, BLACKOUT, TAP, SYNC, FREEZE, FIRE, the view keys, `L1`–`L4` |
| `text/ui` | 11 / 400 / 0 | sentence | buttons, chips, menus, library rows, table cells |
| `text/name` | 13 / 500 / 0 | as typed | pad, look, song and fixture names, now-playing — never forced to caps |
| `text/prose` | 12 / 400 · leading 1.5 | sentence | help strings, guide lines |
| `text/value` | mono 11 / 500 / 0.02em · `tnum zero` | — | fader values, addresses, counts, times |
| `text/readout` | mono 22 / 500 / −0.01em · `tnum zero` | — | BPM, MASTER on the remote, the network address |

Wordmark, strip-vertical, table-head and crashed stay as they are. Weights are T3's: 400 on a pad name and 500 on a key are thin on a dark ground at booth brightness. Numbers, one rule: `0.3 s`, `210°`, `45 %` (thin space), `12 Hz`, `1.00×`, `120.0`, `1–49` with an en dash, `8 bars = 15 BPM`, masters bare with `100` = full.

### 3.3 Glyph set

One inline-SVG set, `ui/src/glyphs.tsx`, 12-grid, `--icon-size: 12` (16 touch), `--icon-stroke: 1.5`, `currentColor`, replacing Unicode at five weights (`LookEditor.tsx:36-43`, `PatchView.tsx:50, 222`) and every emoji in UI copy — the `lock` glyph is the unlock control and the lock line's mark; no emoji anywhere on the page. Twenty-five: `bolt` (flash; also the wordmark's mark, matching the favicon — today a cyan square) · `chain` · `play` · `stop-square` · `hold` · `corner` · `find` · `lock` · `clear` · `prev` `next` · `add` · `more` · `chevron` · `pin` · `home` · `tray` · the eight spread pictograms. The `.chipsel` caret stays as its gradient (`theme.css:180-191`).

### 3.4 Motion

`--motion-press` 70 ms (pad and key brighten) · `--motion-fast` 120 (hover, lamps) · `--motion-base` 150 (release ease, folds) · `--motion-fold` 160, height only · `--motion-glow` 200 (a fired pad blooms) · `--motion-hold` 500 (the ring on hold-to-clear, hold-to-find, hold-to-unlock; `LONG_PRESS_MS` is read from this token, 2.4) · `--motion-hold-latch` 250 (a FREEZE press shorter than this latches) · `--motion-pulse-blackout` 900 (the strip's only pulse) · `--motion-pulse-find` 1400 (the held chip and the remote's LIVE lamp while a find is on, because find overrides blackout; revision 1 named it with a retired word, `check-language.mjs:45`). The beat lamp is hard on/off. No slides on the grid, ever. `prefers-reduced-motion` turns the pulses steady and drops the glow ease.

### 3.5 Elevation and seams

**Plane 0**, chrome: `--bg`, `--panel`, `--panel2`, 1 px `--line` seams; splitters are 6 px of `--panel` with a hairline (today 6 px of pure black, `theme.css:30-34`); keys have edges; nothing glows. **Plane 1**, readouts: BPM, now-playing names, master values — larger, in `--text` or `--color-live`, no ground of their own. **Plane 2**, light: the pad glow, the audition, the canvas, the tiles — the only glows besides menus and modals. Three button intents: quiet, pressed (quiet + lamp), danger; blackout is the one exception.

### 3.6 How colour means

| meaning | colour | where | never |
|---|---|---|---|
| live | tungsten | now-playing, live column rule, fadebar, LIVE stripe and lamp, current song, a lit key | a toggle's fill, a tab, a master's fill |
| selected | cyan | the selected pad's rule, the editing-song rule and name slot, focus, the armed tile, the latch wash | a pressed key, a lit master, a view tab (a 2 px `--text` underline), the wordmark |
| attention | amber; red for the blackout family | the held chip, corner marks, a master below full, HELD, a degraded lamp; BLACKOUT, ALL STOP, a lost engine | prose, a border as a state, two ambers, green anywhere |
| content | the look's own colour | faces, the glow, plan dots, tiles | chrome, tabs, song chips |

### 3.7 Enforcement

T3's own risk section is right: a design built on defaults regresses one "show more" at a time unless the defaults are enforced like literals. `scripts/check-tokens.mjs` already fails on generated-file drift, literals in `theme.css` and inline styles, and undefined `var()`s (`:1-17`); its checks are per-declaration with no idea of selectors (`:100-112`), so the rules below are **new rules inside the same script**, not lines added to an existing loop — still S, ≈ 40 lines, engine-free — and they ship **first in lane 1**: (a) any token that *resolves* to `cyan/500` or an `alpha/cyan-*` (`--accent`, `--accent-soft`, `--color-accent-fill-*`, `--color-accent-marquee*`, `--color-border-focus`, `tokens.css:95-107`) may appear only under a listed set of cursor selectors — a small rule-level pass (selector list → declarations) using the `resolveVar` / colour-owner map the script already builds, plus a grep of `.ts`/`.tsx` for `var(--accent`, `accent/default` and `alpha/cyan-` so a component cannot route around a theme-only list; (b) the Opacity collection's values are the only opacities on `.cell .face`; (c) the Pads defaults (`libraryHidden`, `editorHidden`, `previewPane`, `--ratio-band-pads`) are read from `tokens.ts`, not typed into `store.ts:355-358`; (d) canvas `fillStyle` / `strokeStyle` string literals fail — `OutputView.tsx:126, 139, 145` carry `#9a9aa6`, `#26262a` and an rgba today (R7) and move to `color[...]` from `tokens.ts` like `:107-118` already do, the node-health `●` becomes the lamp primitive at `--size-lamp` and the 10 px beat LED reads `--size-lamp` too; (e) `touch.ts` may carry no duration literal. The Figma-frame check is not written, and this document does not pretend it is.

---

## 4. Console-derived patterns

All seven reports, merged: synthesis A1–A21 (grandMA3, Eos, Titan) with the addendum's A22–A52 (MagicQ, Hog 4 / ONYX, Lightkey, Resolume). Lanes refer to section 6.

### Adopted

| # | pattern (console) | decision · where · lane |
|---|---|---|
| A1 | Encoder bar by feature, only the patch's features (grandMA; MagicQ; Hog kind keys; ONYX groups) | feature row; `FX_CATEGORIES` renamed with the mapping in 2.6; ‹ › on slot pickers · next |
| A2 | Live / Blind as a ground, never a mode (Eos) | the stripe and `--color-bg-blind` · next |
| A3 | Programmer values marked per attribute (grandMA) | `Fader` `nudged`; NUDGED chip navigates · next |
| A4 | Park display: every hold in one list (Eos) | `held · N` chip · next |
| A5 | Clear that never touches playback; programmer hardkeys (grandMA, Eos) | Esc escalates; keys for Keep, Discard, nudge, freeze, select-active, find · next, behind decision 0 for the bare keys |
| A6 | Select Active (Eos) | click the now-playing line · next |
| A7 | Flexichannel filters (Eos; MagicQ palette windows; Lightkey computed sections) | computed chips incl. `unused` · next |
| A8 | Direct selects, one-press placement on touch (Eos) | tiles sixteen at a time; arm-then-place · next |
| A9 | Highlight / Next / Last; group highlight (grandMA, Eos) | ‹ › walk find · next; find a whole group · later |
| A10 | Blind programming (grandMA) | `blind` on the nudge, audition pass only · later |
| A11 | Sneak (Eos) | Discard over the look's fade · later |
| A12 | Colour palettes (Titan, Eos, grandMA, MagicQ) | slice 1 named palettes + retune-by-value · later (M-schema passthrough + a lane-2 strip); slice 2 live strip · later; slice 3 only if needed |
| A13 | Position palettes that survive a venue change (Titan) | `params.aimAt` · later L; the aim strip computes base aim in the UI · next |
| A14 | Group masters only where assigned (grandMA) | pinned groups row · next; `pinnedGroups` · later (M-schema) |
| A15 | Views per task (grandMA; MagicQ Run-in-Execute; Hog Views; Resolume) | as defaults, not a switch · now |
| A16 | Fixed command section (grandMA; Hog; ONYX) | strip + status line · next |
| A17 | Selected ≠ active (grandMA, Eos) | the 2 px strip rule · now |
| A18 | Page change with playbacks running shows the page (Titan) | `from 01 Still Air`, `undefined`-safe · next; `LayerSnap.deckId` · later (M-schema) |
| A19 | Set-list notes (Titan) | in the picker · next; `Deck.note` · later (M-schema) |
| A20 | Locked handles / persistent clips (Titan, Resolume) | "put on this pad in every song" · next; `pinned` carried by `switch_deck` · later, only if needed |
| A21 | Magic sheets (Eos; Lightkey Preview) | locked tappable plan in Pads · next |
| A22 | Key Lock / perform lock (MagicQ; Lightkey) | lock on by default off the engine's host · next; per-pad lock · later with layer 2 |
| A23 | Playback bar: current, progress, next (Hog; ONYX; Resolume ▶/■; MagicQ) | column head glyph, rule, countdown, `next` — render-only from `LayerSnap.col / t / lookId` · next (M) |
| A24 | Brightness = playing, colour = content (MagicQ; `surfaces.ts:8-9`) | Opacity collection · now |
| A25 | The face encodes what it stores; greyed when inapplicable (ONYX; Hog; Lightkey) | I·C·P·B glyphs, cross-song counts, greyed tiles · next |
| A26 | Busking-rate master (MagicQ) | **decision 3** · later if yes |
| A27 | The playback's fader shapes its effect (MagicQ; Hog) | layer-scoped `ControlLink` · later |
| A28 | Intensity-only busking playbacks (MagicQ) | `APC40 mk2 · busk`: faders 5–8 → pinned groups via `submaster` (`shared/types.ts:475`) · **decision 2** |
| A29 | Preload / momentary freeze (MagicQ; Lightkey) | workflow copy · now; `F` latch · next; momentary hold with an owner · later (both engines) |
| A30 | A Home page (MagicQ) | ★ home, key `0` (decision 0) · next; `Deck.home` · later (M-schema) |
| A31 | Per-layer speed (MagicQ; ONYX) | not adopted unless strobe-versus-chase appears on the real rig |
| A32 | Encoders follow the selection; send a parameter to a dial (Hog; ONYX; Resolume) | `dials for this look` (S), `→ dial ▾` (M) · next |
| A33 | Override list as a crossfading fader (ONYX) | **decision 4** · L, later if yes |
| A34 | Pig + Clear restores (Hog; ONYX) | `— was … ↩` · next |
| A35 | Fader-position mismatch (Hog) | hollow tick · browser half next, engine echo later |
| A36 | Chase Fade % (ONYX) | `CueStep.fade`, 0 = today's cut · later |
| A37 | Direct-access popup, no veil (ONYX; Hog) | `Popover menu` everywhere · next |
| A38 | Show a look's reach on the plan (Lightkey) | selection outlines its groups · next |
| A39 | Spread-order preview (Lightkey) | the spread disclosure numbers the heads · next |
| A40 | Project-wide find (Lightkey) | `⌘F` · next |
| A41 | Per-cue live offsets (Lightkey) | four offset dials over the existing `soft` path · next, after the editor |
| A42 | Slider: drag, type, step, right-click default (Lightkey; Resolume) | `Fader` · next (M; keeps focus, owns its keys) |
| A43 | Type-to-select on the plan (Lightkey) | Rig plan · next |
| A44 | Look from a selection (Lightkey) | `+ look from selection` · next |
| A45 | Still spread (Lightkey) | `still` at rate 0, identical in both engines · later |
| A46 | Ignore column trigger per layer (Resolume) | `Layer.ridesThroughCues`, tag on the head, LED rule excludes it · later |
| A47 | Layer transition on the strip (Resolume) | `fade` in the head popover · next |
| A48 | Mapping mode tints and prints; duplicates red (Resolume) | learn wash · next |
| A49 | The pad face reads as content (Resolume) | the rig-miniature face · next |
| A50 | Beat snap (Resolume) | **refused** until its cancellation rules are written |
| A51 | Effects quick search on double-click (Resolume) | FX picker on double-click · next |
| A52 | Layer bypass (Resolume) | ✕ hold action, runtime-only · later |

Kept as-is, confirmed by the reports: the pool look as referenced data; derby auto-quantise; FX presets copied on apply; base aim per fixture; the two targets; the audition as Arena's preview monitor.

### Deliberately rejected

| console | pattern | why not |
|---|---|---|
| grandMA3, Eos, Hog, MagicQ, ONYX | command line, keyword grammar, numeric timing | proposal-until-Enter is the misfire class the constraints forbid; keys 1–9 fire columns (`shortcuts.ts:71-79`), so a digit can never mean a time |
| all five desks, Lightkey | Record / Update / Clear programmer; a permanent override layer | edits are the show; nudge → Keep / Discard is the whole scratch layer |
| all desks, Lightkey | tracking, Go+, follow, move-in-black, cuelists, GO on Space | a column fully describes the stage; backlog #23 |
| Eos | Park precedence over blackout | blackout always wins; find is the one exception and pulses for that reason |
| grandMA, Lightkey | global Blind; apply-on-exit | a mode change that fires is a misfire path |
| grandMA, Hog, ONYX, Titan, MagicQ | executor pages, banks, virtual playback pages | the song is the page |
| MagicQ, Lightkey, Hog, ONYX, Resolume | designable grids, free-form pages, dockable panels, saved layouts, workspaces | the 5×8 is the APC40 and Arena's grid; saved layouts are how Arena and MagicQ got crowded |
| MagicQ, Hog, ONYX | encoder banking | all nine knob banks bind the same dials on purpose (`controllerPresets.ts:76-91`) |
| Hog, ONYX, Lightkey | priority numbers, HTP/LTP flags, priority arithmetic | stack order plus three blends reads on the head at 2 a.m. |
| grandMA, Hog, MagicQ | special-master zoo; continuous per-layer or per-cue rate | one SPEED, one MASTER; a driven rate drifts the engines |
| grandMA, Eos, Resolume, Lightkey | state in a value's colour; deck colours; adaptive tint | colour is content |
| Resolume | a second play button per column; toggle trigger; active-layer targets; autopilot; layer groups; effect stacks; per-clip transport; tempo nudge | hold-to-edit already solved accidental fires (`LookGrid.tsx:1079-1084`); a second press that darkens is a misfire; a pad is a position; Arena is the timeline |
| Lightkey | polar HUDs; fade-curve editors; Touch Bar / Watch; single process | no framing fixtures; theatre transitions in the crossfade path; the engine/UI split is the advantage |
| ONYX, Hog | the 22-mode effect vocabulary, N-shot | rate must stay a pure function of the beat clock |
| Hog | two-touch-screen and trackball assumptions | the second screen is the Stage window or a phone |

---

## 5. The six workflows, before → after

**L** laptop touch · **A** action · **S** live switch · **V** view switch · **Sc** long scroll. A popover is counted as open + pick, two actions, everywhere. W-A's set: 12 songs × 6 sections, 12 re-syncs, 3 blackouts. Every "after" names the lane it needs, and what lanes 1–2 alone deliver.

**W-A · Busk 60 minutes, hands on the APC40 mk2, laptop half-closed.**
*Before.* The preset binds pads → `cell`, scene buttons → `layerClear`, STOP ALL → `blackout`, TAP, bank ◀ ▶ → songs, knobs → dials (`controllerPresets.ts:28-92`); no `column` binding, and `MidiAction` has no sync kind (`shared/types.ts:468-483`; `core/src/types.rs:1036-1052`). APC TAP re-anchors a beat, not the bar (`engine/clock.ts:56-58`). Sections 72 L; re-syncs 12 L; preset load ⌥4 → the Sync · MIDI tab → LOAD → `Load the APC40 mk2 preset?` (`SyncView.tsx:173-177`) 4 L. **88 L**, with column 8 off-screen at every laptop width.
*After (lane 3, #45).* Eight preset lines bind the **CLIP STOP row** — on the APC40 mk2 hardware, note 52 on channels 0–7, the buttons directly under the 5×8 grid — to `{kind:'column'}`, which already exists in `MidiAction` and both dispatchers (`shared/types.ts:472`; `engine/state.ts:442`; `core/src/state.rs:812`), and both engines match a mapping on channel and number (`engine/state.ts:423-424`; `core/src/state.rs:773-774`): preset data. METRONOME binds a new `{kind:'sync'}` — one variant in `shared/types.ts:468-483` and `core/src/types.rs:1036-1052` — that must run the same path as `Command::Resync`, clock resync **plus** `align_phase(BAR)` (`core/src/state.rs:1351-1357`; `engine/index.ts:462-467`), and both MIDI entry points drop that today: the Rust `EngineMsg::Midi` arm discards `out.align_phase` (`core/src/engine.rs:1101-1105`, where the Command arm returns it at `:1070`) and Node's `'midi'` case never calls `renderer.alignPhase` (`engine/index.ts:660-662`). Without that plumbing an APC SYNC would resync the clock and leave a bar-long shape where it was. The `describe` table in `SyncView.tsx` gains the `sync` label. The bottom pad row stays reserved for the dials, as both files insist (`controllerPresets.ts:33-41`; `surfaces.ts:20-26`); the user guide says plainly that CLIP STOP under column N is a GO for that column, because a VJ beside Arena reads that label the other way. `controller ▾` loads the preset: **2 L once per project, 0 L during the set.** Lanes 1–2 alone: 88 L, but with every column on screen.

**W-B · Build song B while A plays; then one look on a pad in both songs.**
*Before.* ▶ (1 A, 1 S — the APC repaints to B mid-song, `engine/state.ts:203-217`), six drags, ◀ (1 A, 1 S); then drag to A, ▶, drag to B, ◀. **12 A, 4 S**, each switch showing a page whose live column reads as stale or empty (`LookGrid.tsx:167-177`), never as what is playing.
*After at 1440 / 1280 (lane 2, #26).* `editing ▾ → 02` (2 A, 0 S): B's pads under the blind tint, the heads still reading A. Open the library (1 A; folded by default). Six drags (6 A) into `decks['02'].cells`. Both songs: right-click the tile → *put on this pad in every song* (2 A — a write to every song in the project, with an undo chip), or editing → this song, drag, editing → 02, drag (6 A). **11 A (or 15 A), 0 S.**
*After at 1024 (no side panel).* `editing ▾ → 02` (2 A), `L` opens the library sheet (1 A), six × (tap tile, tap strip) (12 A), Esc (1 A); both songs from the sheet's tile menu (2 A). **18 A, 0 S** — more taps than 1440, still no live switch. On the tablet: latch, tap tile, tap strip — the same zero. Lane 1 alone: today's 12 A, 4 S.

**W-C · Turn a wash into a strobe hit on the top layer without editing the wash everywhere.**
*Before.* Tick STROBE + FLASH edits the wash on every pad in every song, silently (B3). The safe path — Duplicate lands on the same layer (`LookGrid.tsx:59-74`) → rename → FLASH → STROBE → rate → untick colour → untick dimmer → drag to a `brightest` layer → set blend → check the audition — is **11 steps.**
*After (lane 2, #19 and #28).* Right-click the wash's strip → *duplicate as flash on the top layer · → Layer 4 · col 3* (2 A): the copy lands on Layer 4 at the same column, or at the first empty column to the right when that pad is taken (the menu row says which; greyed when Layer 4 is full), with `flash` set, named `Cold Seam · hit`; the editor opens on it, NOT ON THE RIG, `on 1 pad · 1 song`. Intensity → strobe `12 Hz` (2 A). **4 steps.** Had you edited the wash instead, its chip would have read `on 4 pads · 2 songs` before the first tick. At 1024 the editor is Build: 5 steps, 1 V.

**W-D · Patch four Spiiders on universe 1 from address 1, place, aim at the drummer, find one.**
*Before.* Rig (1 V) → scroll three screens to the library (1 Sc) → `+ rig` × 4 at (0, 2, 0) (`FixtureLibrary.tsx:93-95`) → scroll up (1 Sc) → fix addresses (4–8 A) → four drags on a letterboxed plan → scroll right past `Rigged on` (1 Sc; 20-rig-patch.png) → pan/tilt on four rows by eye (8 A) → ◎ beside mute (1 A). **≈ 18 A + 4 drags, 1 V, 3 Sc**, and converging four heads on one point is arithmetic by hand.
*After (lane 2, #34).* Rig (1 V) → `+ add fixture…` (1) → `spiider` (1) → pick (1) → count 4 (1) → Add (1): four rows selected, four dots on the plan column → 4 drags to the truss → `aim at ▾ drummer` (2) → `store as base aim` (1) → hold ◎ on Spiider 2 (1). **9 A + 4 drags, 1 V, 0 Sc.**

**W-E · Retune the venue's blue across every look that uses it.**
*Before.* Twelve hard-coded swatches (`LookEditor.tsx:43-49`; 12-build-colour-wheel.png); Blue Field, Blue Floor, Deep Blue Bed, Open Blue, Cold Seam carry the blue baked in (01-pads.txt). One look at a time: **≈ 30 edits.**
*After, slice 1 (lane 3, #46 for the field; lane 2 for the strip).* `project.palettes[]` replaces `SWATCHES`, each named. Open the palette (1), change hue (1), accept `retune 14 parts in 11 looks?` (1) — one mutate, one undo step. **3 edits.** Honest limit: it matches by value, so a hand-nudged part is listed as `3 parts near this colour, not changed`. Slice 2 makes *this wash, warmer* a nudge through `soft`; slice 3 (references resolved at load) makes W-E one edit and is taken only if 1–2 prove the need. Lanes 1–2 alone: 30 edits.

**W-F · First run to first live output on the owner's rig.**
*Before.* Welcome (1; 00-first-run-welcome.png) → *set up my own rig* opens the guide on the demo (`WelcomeCard.tsx:60-72`; `:67` calls `setSetupGuide(true)`, no `newProject`) (2) → `+ new project…` under the project ▾ (`TopBar.tsx:83-104`) (3) → Rig, generic par or the library three screens down (4) → Build ▸ Output for Art-Net (5) → Pads, OFFLINE → LIVE (6). **6 screens, three of them work on the wrong project.**
*After (lane 2, #20; the docked guide #40 is cosmetic to the count).* Welcome (1) → the button runs the TopBar flow — `askPrompt` for a name, `newProject`, then `setView('patch')` — so Rig opens on the bare project (2) and the guide opens itself there (`SetupGuide.tsx:110-115`), docked as a strip above the rail, ticked off the project as today (`SetupGuide.tsx:56-97`) (3): fixtures, plan, groups on one page → the Output step opens the setup sheet (4) → Pads, the label cell reads `go live ▸` (5). Cancelling the name prompt returns to the welcome card, which is not marked seen. **5 screens; the welcome card still sits over the demo, and none of the work happens on it.**

---

## 6. Change list

Lane 1 is tokens, defaults, CSS and the checker script: nothing that touches a component's logic or an engine. Lane 2 is UI components. Lane 3 is anything both engines must agree on. Revision 1 carried component and Rust work in lane 1; it is re-laned here.

### Lane 1 · now — tokens, defaults, CSS; no component logic, no engine

| # | change | size | file | tokens |
|---|---|---|---|---|
| 1 | **`check-tokens.mjs` extension first**: resolved-colour accent allowlist (selector-aware pass + `.ts/.tsx` grep); Opacity values; Pads defaults from `tokens.ts`; canvas literal scan; no duration literal in `touch.ts` | S | `scripts/check-tokens.mjs`, `scripts/build-tokens.mjs:119-125, 159-184`, `store.ts:355-358` | `opacity/face-*` |
| 2 | Pads opens folded with band 26 %; Build opens with the audition alone; touch both folded — under **new** storage keys (`padsLibraryHidden`, `padsEditorHidden`, `padsAudition`), because `loadFlag` (`store.ts:198-203`) prefers a saved value and the owner's install has toggled the old ones | S | `store.ts:198-203, 355-358`, `App.tsx:494-497` | `--ratio-band-pads: 0.26`, `--size-band-build: 200`, `--size-min-band: 140` |
| 3 | Grid, head and floor tokens (the template and clamp code are #21) | S | `docs/design/tokens.json` → regen | `--size-pad-w-min: 96`, `--size-pad-w-max: 160`, `--size-layerhead-w: 120` (narrow 96), `--size-pad-h-pads: 72`, `--size-min-grid-w: 945` (narrow 921), `--size-min-grid-h: 497`, `--size-addcol-w` unchanged |
| 4 | Four meaning colours, no green; grand master neutral; lamp keys; blackout idle quiet; one amber; wordmark bolt | S | `theme.css:169-176, 243-248, 357-364, 445-447`, `TopBar.tsx:202, 393` (variant), `tokens.css:109, 112` | `--color-live`, `--color-live-dim`, `--color-lamp`, `--color-status-ok`, `--size-lamp: 5`, `--color-fader-fill-rest`, `--color-fader-down`, `tungsten/100`, `tungsten/300` |
| 5 | Key tokens on `.btn`: flat fill, top edge, bottom shade; hover, pressed, lamp, danger, disabled states | S | `theme.css:154-180` | `--color-key-fill`, `--color-key-edge-hi`, `--color-key-edge-lo` |
| 6 | Pad states: well, 0.55 / 0.70 / 1.0, glow + halo (no fill wash), selected rule, stale corner, held flash, press, focus ring outside, inert cursor, 11 px two-line name | S | `theme.css:421-523`, `LookGrid.tsx:300-307` (class names only) | `--color-border-pad-empty`, `--elevation-glow-pad`, `--motion-press`, `--motion-glow`, `--size-cornermark: 8`, `--text-pad-name-size: 11`, `--padname-h: 22` (touch 26) |
| 7 | Layer head 120 × pad-h; blend tag; ghost ✕; idle well | S | `theme.css:400-412`, `LookGrid.tsx:381-433` (markup) | — |
| 8 | Seams `--line`; splitters `--panel` with a hairline | S | `theme.css:30-34, 116-121` | `--color-bg-seam: grey/700` |
| 9 | Type scale to twelve styles; **IBM Plex Sans / Mono self-hosted** with fallback stacks; caps only on micro / label / key; `tabular-nums slashed-zero` on `body`; one unit rule | S | `tokens.json`, `theme.css` (13 uppercase rules → 2), `ui/public/fonts/`, `Fader.tsx:73` | `--font`, `--font-mono`, `text/*` |
| 10 | Motion tokens incl. `hold` in the Motion collection; `touch.ts:15` reads `motion.hold`; reduced motion; height-only folds; the find pulse renamed | S | `tokens.css:317-321`, `touch.ts:15` | `--motion-fold`, `--motion-hold: 500ms`, `--motion-hold-latch: 250ms`, `--motion-pulse-blackout: 900ms`, `--motion-pulse-find: 1400ms` |
| 11 | R7: DMX meter colours from `tokens.ts`; node health and beat LED on the lamp primitive | S | `OutputView.tsx:126-145, 354-356` | `--size-lamp` |
| 12 | FREEZE copy: the workflow line gains *set up the next column, then release*; HELD line keeps *blackout and ALL STOP release it* | S | `TopBar.tsx:493-494` | — |
| 13 | Toast position top-right | S | `theme.css:1186-1194` | `--size-toast-top` |

### Lane 2 · next — components, UI-only

| # | change | size | file | tokens |
|---|---|---|---|---|
| 14 | Column head ▶/■, `.live` rule, countdown, `next` — render-only from `allLayers[].cells` and `liveLayers[].col/t/lookId` already in scope; fault = `--hot`; `.statusdot.bad` wired to the stall watchdog; MIDI and OSC agree; OSC copy | M | `LookGrid.tsx:964, 982, 1023, 1069-1086`, `TopBar.tsx:192-196, 548-620`, `theme.css:361-364` | `--size-rule` |
| 15 | Audition only when selected ≠ playing (a condition, not a default) | S | `PrevizPanel.tsx:282-287` | — |
| 16 | Stage bar = 3D/2D + stage window + `view ▾`; state tag on the canvas incl. `EDITING 02` | S | `PrevizPanel.tsx:100-135, 260-271` | — |
| 17 | RigHint → label-cell chip incl. `looks ›`; the gate carries the sentence; ENGINE LOST wording | M | `LookGrid.tsx:918-960, 1063-1068`, `TopBar.tsx:466-486`, `App.tsx:249-253` | — |
| 18 | Fader: `role=slider`, arrows / Home / End with `stopPropagation`, click-to-type, right-click reset, value column outside the fill, **keeps focus**; window handler steps aside for `[role=slider]` and `isContentEditable` | M | `Fader.tsx`, `theme.css:253-267`, `App.tsx:191`, `ColourWheel.tsx:141-147` (same guard) | `--size-fader-max-w: 320`, `--size-value-w: 44` |
| 19 | Menus as anchored popovers, no veil; pad verbs *duplicate as flash on the top layer* (with the occupied-pad rule), *put on this pad in every song* (all songs, undo chip), *show in library* | M | `LookGrid.tsx:214-236, 563, 1082`, `dialog.tsx:82` | — |
| 20 | Welcome → `askPrompt` + `newProject` + `setView('patch')`, cancel returns to the card; two-line networked-client text; networked client opens on Pads; Display shows the address and its code | M | `WelcomeCard.tsx:60-72`, `store.ts:180-188`, `AdminModal.tsx:167-171` | — |
| 21 | Grid template from tokens with `minmax`, `width: 100%`; head narrow under 1,200 px of grid area; pads-view band clamp and give-way order; reveal strips rendered only where a panel fits; new panel floors | M | `LookGrid.tsx:1060`, `theme.css:368-373`, `App.tsx:300-345, 371, 381-383, 420-451` | (from #3) |
| 22 | Keys: `F` freeze latch, `0` home, `E` latch, Keep / Discard / nudge / select-active / find; Esc escalates; `1`–`9` branch on the editing page — all behind decision 0 | M | `shortcuts.ts:70-150` | — |
| 23 | `?` on every pointer; tiered help strings; cog tooltip names the guide; the 26 prose *go to X* strings become keys that perform the switch (`LookEditor.tsx:863, 1065`, `SetupGuide.tsx:91`, `TopBar.tsx:409`, `LookGrid.tsx:942`, and the rest by grep) | S | `TopBar.tsx:626-652`, `HelpMode.tsx`, the five files named | — |
| 24 | Command strip + status line from one control table with `dropOrder` and a `ResizeObserver`; panic area; two tiers below 900; folded in Pads; `editing 02` in the name slot | M | `TopBar.tsx` → `CommandStrip.tsx`, `StatusLine.tsx`; `theme.css:283-300, 1007` | `--size-panic-w: 198`, `--size-statusline: 22`, `--size-master-w-narrow: 100` |
| 25 | `held · N` chip (pulses while finding); `Fader` `nudged`; NUDGED navigates; pending-write dot | M | `TopBar.tsx:401-458` → `HeldChip.tsx`, `Fader.tsx`, `LookEditor.tsx:536-540` | — |
| 26 | **The editing page** (decision 0): `editingDeckId`; `sel.deckId`; `decks[x].cells` under the blind tint; inert bodies, heads and `1`–`9` select; every selection reader and cell writer resolves through the deck (`store.ts:452-460`, `LookEditor.tsx:1042, 1088, 1105, 1173, 1190`, `EditorPane.tsx:22`, `PrevizPanel.tsx:38`, `LookLibrary.tsx:28`); `placeLook` guard and `setSel` (`LookGrid.tsx:29-39`); duplicate / move / clear / columns on the editing deck (`:59-98, 117-133, 224-231, 971, 992-997`); merge-and-resend once on a stale-gen rejection, then the notify; length and look-id hygiene on the edited deck; Esc and any song switch return to live | M, UI-only | `store.ts`, `LookGrid.tsx`, `LookEditor.tsx`, `shortcuts.ts:71-79` | `--color-bg-blind` |
| 27 | Song row: current chip, picker popover, `+ song ▾` that never switches while playing; head reads `LayerSnap.deckId`, `undefined` = this song | M | `LookGrid.tsx:370-446, 500-660` → `SongRow.tsx` | `--size-picker-w` |
| 28 | Editor: stripe, header, cross-deck shared-by, `⋯`, feature row, folded effect line 2 with `bars = BPM`, spread words, strobe in Hz; `FX_CATEGORIES` mapping with `cannot take` flags kept | M | `LookEditor.tsx:329-490, 638-913, 1133-1263`, `fxLibrary.ts:37-43` | — |
| 29 | Library: computed chips incl. `unused`, kind glyphs, twins' group, `×pads · songs`, sixteen at a time, context menu, tiles + arm-then-place (armed until Esc), **the library sheet under 1,165 px and on touch**; replaces both selects; empty states | M | `LookLibrary.tsx`, `LookEditor.tsx:1099-1116, 1163-1185` | `--size-library-tile: 64` |
| 30 | **Pad face as a rig miniature**, memoised; `lookSwatch` and `[0]` untouched; glow and mini swatch stay on `lookSwatch[0]`; Figma Pad variant | M | `lookColors.ts` (new `lookFace`), `LookGrid.tsx:302-311` (face only, not `:426`) | Opacity collection |
| 31 | Glyph set (25) incl. `lock`, `tray`; wordmark → bolt; no emoji in copy | M | new `glyphs.tsx`; every Unicode and emoji site | `--icon-size: 12`, `--icon-stroke: 1.5` |
| 32 | Learn wash with printed bindings; duplicates `--hot`; learn toast in app words | M | `LookGrid.tsx:1064`, `Fader.tsx`, `TopBar.tsx:531`, `theme.css:281, 390, 507` | `--color-bg-wash-learn` |
| 33 | Head popover (blend, fade, select-active); `— was … ↩`; **hold-to-clear ✕ in touch with the ring**, restarted on slop | M | `LookGrid.tsx:381-433`, `touch.ts:60-66` | `--motion-hold` |
| 34 | Rig page: rail, lean table with the 1024 column widths, inspector, filter, conflict rows, plan column, aim strip (UI-computed), `+ add fixture…`, members-only groups, type-to-select, look-from-selection, plan scrolls the table; no tab bar; empty states | M | `PatchView.tsx:502-1580` (split), `FixtureLibrary.tsx`, `Previz2D.tsx:660-680`, `selection.ts:10-27`, `BottomPanel.tsx:9-15` | `--size-rail-w: 120`, `--ratio-plan-w: 0.38` |
| 35 | Setup surface incl. **Lock**: `locked` per client, on by default off the engine's host or under touch, hold-to-unlock + passcode (passcode persists, unlock does not; re-lock on reconnect and idle); `controller ▾` direct menu with undo chip; Sync summary with disclosure | M | `AdminModal.tsx`, `OutputView.tsx`, `SyncView.tsx:150-205`, `store.ts` | — |
| 36 | `app.remote`: panic strip, page key, head row as a `pan-x` snap scroller, `48px repeat(4, minmax(0, 1fr))` with no add column and `width: 100%`, `touch-action: manipulation` on pads, levels tier, tray, edit latch (exclusive with learn; cleared by ALL STOP, song switch, leaving Pads, 30 s idle) | M | `App.tsx`, `LookGrid.tsx:1060`, `theme.css` `.app.touch.remote`, `touch.ts` | `--size-remote-head-w: 48`, `--size-panic-h-touch: 56` |
| 37 | One sheet with Keys and Gestures from one table; docs test extended | S | `ShortcutSheet.tsx`, `HelpMode.tsx` | — |
| 38 | Reach on the plan; spread-order preview | M | `Previz2D.tsx:332-341`, `LookEditor.tsx:428-490`, `shared/effects.ts:178-230` | — |
| 39 | `⌘F` project find | M | `StatusLine.tsx`, new `Find.tsx` | — |
| 40 | Setup guide docked as a strip | M | `SetupGuide.tsx`, `theme.css:1307-1321` | `--size-guide-strip: 24` |
| 41 | `dials for this look` (S); `→ dial ▾` on rows (M); Controls prose behind `?` | S / M | `LookGrid.tsx:800-916`, `ControlsView.tsx:54-146, 281-284` | — |
| 42 | Build layout: audition-only band, **layer tab strip** + heads + one pad row (114), editor takes the rest; floor rule (audition gives way to 140, then folds) | M | `App.tsx:47-58`, `theme.css:47-55`, `tokens.css:202` | `--size-gridstrip`, `--size-layertabs: 24` |
| 43 | Hollow tick for APC fader mismatch, browser half | M | `store.ts:561-569`, `Fader.tsx` | — |
| 44 | Per-cue offset dials over the existing `soft` path (A41) | M | `LookEditor.tsx:548-550, 594-596` | — |

### Lane 3 · later — engine and schema, parity

| # | change | size | engines | parity case |
|---|---|---|---|---|
| 45a | **P4 · APC cue row, bindings**: eight preset lines (hardware note 52, ch 0–7 → `column`, existing kind); `{kind:'sync'}` in `MidiAction` both sides, dispatched through the Resync path, with `align_phase` returned from the Rust Midi arm and `renderer.alignPhase(BAR)` called from Node's `'midi'` case; `describe` label | M-schema | `controllerPresets.ts:28-92`, `shared/types.ts:468-483`, `core/src/types.rs:1036-1052`, `engine/state.ts:428-480`, `engine/index.ts:660-662`, `core/src/state.rs:773-800, 1351-1357`, `core/src/engine.rs:1101-1105`, `SyncView.tsx` | MIDI sync aligns effect phase identically to the SYNC key; preset smoke |
| 45b | **P4 · CLIP STOP LEDs**: both LED maps, both diff caches and both attach-clear passes re-keyed from note to (channel, note) — today `Map<note, [ch, vel]>` (`surfaces.ts:143-147`), `HashMap<u8,(u8,u8)>` (`apc.rs:200-202, 292`), `lastSent` (`apcFeedback.ts:19`), clear on channel 0 only (`apcFeedback.ts:39-40`; `apc.rs:342-345`) — since eight buttons share note 52 and differ only by channel; `Surface` gains `columnRow: { note, channels[] }`, not a second base note; golden re-blessed (`core/tests/data/surface-leds.json`, emitter `apc.rs:500-527`, serialiser `smoke.ts:312-330`, `LIGHT_BLESS_GOLDEN=1`); the "APC40 paints everything on channel 0" assertion (`smoke.ts:240-243`) and the clears-what-it-lights test (`apc.rs:790-811`) rewritten | M, bordering L | `surfaces.ts`, `apcFeedback.ts`, `core/src/apc.rs` | LED picture identical in both mirrors; no tick change. Ships after 45a; until then the screen's column heads carry the state and the set is still 0 L |
| 46 | **Schema passthrough × 4** — `project.palettes`, `project.pinnedGroups`, `Deck.note`, `Deck.home`: a `#[serde(default, skip_serializing_if…)]` Rust field, the `ensure_decks` literal at `state.rs:418` taking `note: None, home: false`, a type line in `shared/types.ts` (the sanitiser already passes unknown keys through — the line is for type repair, not survival), a round-trip case each. `core/src/types.rs:1012-1017, 1104-1148` carry no unknown-field capture, so without the field the packaged engine drops it on the next broadcast | M-schema each | `core/src/types.rs`, `core/src/state.rs:418`, `shared/types.ts:401-406, 669-720, 1007-1090` | survives sanitise and round-trip; render unchanged |
| 47 | `LayerSnap.deckId` in both snapshots, written at trigger time (`trigger()` clones `active_deck_id` before `layer_live()` takes its borrow, `state.rs:629`) | M-schema | `engine/state.ts` `LayerLive`, `core/src/state.rs:629-650`, `shared/types.ts:720-728`, `core/src/types.rs:1177-1183` | `deckId` identical after `switch_deck` |
| 48 | A10 · blind nudge: soft values in the audition pass only | M | `engine/index.ts:532-547`, `core/src/state.rs` soft door | main render unchanged byte-for-byte |
| 49 | A12 slice 2 · palette strip through `soft`; optional `fadeS` | M | `shared/types.ts:889`, both soft doors | timed soft reaches its value at t = fadeS identically |
| 50 | A11 · `softClear` with a time | M | both | 0 s, 0.3 s, 2 s |
| 51 | Busk preset: faders 5–8 → pinned groups — decision 2 | S data, after #46 | `controllerPresets.ts` | preset smoke test |
| 52 | A35 engine half: last CC per mapping in the snapshot | M-schema | both | one case |
| 53 | Pinned pads carried by `switch_deck` — only if #19 proves insufficient | M-schema | both `switchDeck` paths | pinned cell survives a switch |
| 54 | A46 rides-through, A52 bypass, A36 chase fade %, A27 layer-scoped links, A45 still spread, A9 group find | M each | both | each its own case |
| 55 | A13 `aimAt`; A12 slice 3; A33 override mix (decision 4); A26 FADE master (decision 3); lock layer 2 | L / M | both, schema | none in this design's promise |
| 56 | Project toasts to the requester only: `send_to` / `server.send` instead of broadcast for `newProject`, `openProject`, `saveAs` | M | `engine/index.ts:623-656` (`:350` shape), `core/src/engine.rs:856, 993-1042` | a second client sees no toast for another's open |
| 57 | **Momentary FREEZE with an owner**: `SetFreeze { v, momentary }` or `held_by` on the freeze; released in `release_all_held` on `ClientDisconnected`; the latched click stays ownerless | M | `core/src/state.rs:687, 1369`, `core/src/engine.rs:1121-1130`, `engine/state.ts`, `engine/index.ts` | a disconnect mid-hold releases the frame in both engines; a latched freeze survives it |

---

## 7. Risks, and what this design gives up

**It is still four views and two homes.** T1's split is taken as defaults, so an operator who unfolds the editor in Pads can approach today's crowding. Two guards: every default is a token `check-tokens.mjs` holds (item 1), and `--size-min-grid-w` 945 means no panel opens except beside all eight columns, and both never fit at 1440. The Figma-frame check is not written.

**Below 1,165 px Pads has no side panel.** The Tauri floor (1100) and every 1024 client place looks from the library sheet, and edit in Build. That is the price of eight columns on a small window, and it is a sheet the phone needed anyway — but it is a change of habit at 1024, and W-B costs 18 taps there.

**The editing page is a new UI state, and it bends a hard constraint.** It is tinted, captioned in the strip, returned to live by Esc and by any song switch, and nothing on it fires. Two surprises: the APC keeps firing the live page — correct, and a possible surprise to a hand that has just placed a look on B and reaches for the pad; and a hand that reaches for a pad or `4` on the screen while it shows B gets nothing — rule 18. Decision 0 is the owner's. Rehearse it before the first show. The client-side merge-and-resend is the one piece of new concurrency logic in the design; its failure mode is the notify, never a silent loss.

**The remote is a layout, not a role.** Lock keeps an elbow off the Rig page; it does not stop a client sending `updateProject`. Backlog #13's L layer is the real fix and is in lane 3; the lock's help says so.

**Tungsten in daylight.** At FOH under house lights the glow is invisible and the halo and the now-playing line carry the state alone. Check `#f3ebd7` on the Mac at booth brightness before locking it in Figma.

**Hold-to-clear costs 500 ms on glass.** Accepted: no gesture may clear a layer by accident.

**Momentary FREEZE waits for its engine half.** Until #57, a held finger is a latch; the copy says so.

**The CLIP STOP row is two lane-3 items.** The bindings and the `sync` kind are additive (45a); the LEDs re-key both mirrors, both caches and the golden (45b). Lane 1 ships without either; until 45a, W-A is 88 laptop touches with everything on screen instead of 2.

**Given up, on purpose.** The header's swap `<select>`, CLEAR PAD and DELETE LOOK move to `⋯`. The twenty-chip song scroller. The blend `<select>` on the head. The RigHint paragraph. Four cyan stage-bar toggles; SNAP and MEASURE on the Stage bar. The wordmark's square. The SAVE button. Green as a colour. The five-tab panel on Rig, and Output / Sync · MIDI as tabs on Build (a sheet, one gesture further). The flash pad's orange word. SPEED and HAZE on the strip at 1280. Drag-to-place below 1,165 px. GROUPS shows eight pinned groups, not all. The phone that shows the whole console. The system font.

**Strengths kept** — all nineteen of synthesis section 2. Unchanged: 2, 3, 10, 15, 17, 19. Kept and extended: 1 the two targets (the face and the latch add to them); 4 one editor in two homes (plus the phone tray and Build's layer tabs); 5 the audition (only when it differs); 6 the effects catalogue (sections renamed with the mapping in 2.6, search words follow, `cannot take` flags kept per group); 7 token discipline (Opacity collection, resolved-colour allowlist, canvas scan); 8 touch as a token mode (`app.remote` is a layout state under it); 9 help mode's capture-phase swallow and the sheet from one table (gestures join it); 11 RigHint's button (a chip); 12 contextPress menus (popovers, no veil); 13 per-view hide machinery (defaults inverted, new keys); 14 Rig borrowing the plan (the plan column, without swapping the band under a live stage); 16 the finding pulse (moved to the held chip and the remote's LIVE lamp, since the canvas tag is hidden when the band folds); 18 the welcome card (its button now runs `newProject`).

---

## 8. What this deliberately refuses

Standing rules from the merged avoid lists of all seven reports. A proposal against one needs its own argument.

1. **No command line, keyword grammar or numeric timing.** A digit can never mean a time. (grandMA, Eos, MagicQ, Hog, ONYX)
2. **No Record / Update / Clear scratch buffer and no permanent override layer.** Nudge → Keep / Discard is the one scratch state. (all desks, Lightkey)
3. **No tracking, Go+, follow, move-in-black, cuelists or GO key.** A column fully describes the stage. (all desks; backlog #23)
4. **Nothing but find-this-light overrides blackout**, and whatever is finding pulses somewhere always visible. (Eos)
5. **No global Blind and no apply-on-exit.** Blind lives on the nudge. (grandMA, Lightkey)
6. **No second paging axis.** The song is the page. (grandMA, Hog, ONYX, MagicQ, Titan)
7. **No designable grid, free-form page, dockable panels, saved layouts or workspaces.** The 5×8 is the hardware. (MagicQ, Lightkey, Hog, ONYX, Resolume)
8. **No encoder banking.** Knob N is dial N in every bank. (MagicQ, Hog, ONYX)
9. **No priority numbers, HTP/LTP flags or priority arithmetic.** (Hog, ONYX, Lightkey)
10. **No special-master zoo and no continuous per-layer or per-cue rate.** One SPEED, one MASTER. (grandMA, Hog, MagicQ, ONYX, Lightkey)
11. **No state in a value's colour, no song colours, no adaptive tint.** Colour is content. (grandMA, Eos, Resolume, Lightkey)
12. **No second target on the column head, toggle trigger, autopilot, layer groups, effect stacks above the look, per-clip transport or tempo nudge.** (Resolume)
13. **No beat snap until its cancellation rules are written** — an armed press must die on ALL STOP, blackout and a song switch, in both engines. (Resolume)
14. **No two undo stacks.** (Eos)
15. **No hand-authored preset folders or per-type preset sets.** Sections are computed. (Lightkey, MagicQ)
16. **No polar HUDs, fade-curve editors, magic-sheet editors, platform vanity or single-process window.** (Lightkey, Eos)
17. **No new pointer gesture that reaches the rig.** The five that do today are the five that will.
18. **A cue that does not fire is a misfire.** Any state in which the pad body or a digit key withholds output must be visible in the strip, on the grid and on the heads at once, and must end on Esc and on any song switch. (this design, decision 0)

---

## 9. Open decisions for the owner

0. **The editing page, and the keys that change meaning with it.** The hard constraint says a pad body fires. On an editing page this design makes the body inert (a press flashes the chip), the heads and `1`–`9` select, and shows the state in four places (2.5). The alternative: the editing page exists only in Build, so Pads never shows any page but the live one and nothing on Pads ever changes meaning — W-B then costs one view switch each way. Bundled with this yes: three new bare keys — `0` (home: a live song switch, the same class as ◀ ▶ on the row), `F` (FREEZE latch; momentary later), `E` (the edit latch, which withholds fires until Esc) — none behind a modifier. Say yes to the default, yes to Build-only, or strike any of the keys.
1. **Column 8 on the phone.** It sits on page 2 behind the page key; BLACKOUT at the top covers the demo's use of it. Accept, or pin the last column to both pages (a five-column page at ≈ 61 px pads, under a fingertip)?
2. **The busk preset's faders.** Track faders 5–8 today drive haze (ch 5) and speed (ch 6), with 4 and 7 unbound (`controllerPresets.ts:67-68`). `APC40 mk2 · busk` would put the first four pinned groups on 5–8 and leave haze and speed on screen. A second preset beside the default, or the default?
3. **A busking-rate FADE master** (MagicQ A26): one runtime fader beside SPEED, 0× = snap, read at trigger time in both engines (`core/src/state.rs:633`; `engine/state.ts:187`). Any pad becomes a hit without editing the look; it is a fifth fader on a strip with 77 px to spare at 1440, so it would push SPEED to the line at 1440. In the later lane, or out?
4. **A mix master on `replaces` layers** (ONYX A33): the fader crossfades hue and position toward what is beneath, not only intensity. It contradicts `ROADMAP.md:23` ("masters only scale intensity") and is a render change in both engines. Yes, no, or only if the busk preset shows the need?
5. **Pad height in Pads: 72 or 58.** 72 gives bigger targets and a two-line name and drops the band from 32 % to 26 % at 1440 (300 → 234 px of stage); 58 keeps the band at 30 %. The token is `--size-pad-h-pads`; the layout holds either way.
6. **The 1024 laptop.** The Tauri floor is 1100; a 1024 window is a browser client or a scaled 14" display. Lower `minWidth` to 1024 and make it a real desktop size (the layout above already fits), or keep 1100 and treat 1024 as the browser's problem?
