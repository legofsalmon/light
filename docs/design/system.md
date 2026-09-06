# LIGHT design system

The visual language of LIGHT, written down so it can be maintained in one place
and reused across other apps. `tokens.json` beside this file is the machine
half; this is the human half — what the pieces are, where they live in Figma,
what was inconsistent before, and how the two stay in sync.

**Status (2026-09-06): built.** The Figma library exists —
[LIGHT Design System](https://www.figma.com/design/zK5Atg0210cM8IxDf8R8PL)
(file key `zK5Atg0210cM8IxDf8R8PL`) — reverse-engineered from
`ui/src/theme.css` at b82e053 and the components: codified, not redesigned.
**Figma is now the source of truth.** `tokens.json` is regenerated from its
variables and styles; `theme.css` follows `tokens.json`. Edit values in Figma.

## The look, in one paragraph

A white-on-dark console for rooms with the house lights down. One theme. Near-black
grounds in cool greys, a single cyan accent that means "on / selected / focused"
and nothing else, and a small family of status colours — green for good, amber
for attention, red for stop. Type is the system sans at small sizes with
tracked uppercase labels doing most of the work; numbers are monospaced. Corners
are 3px. Surfaces are separated by 1px seams, not shadows; the only shadows are
on menus and modals, which float.

## The Figma file

| Page | Holds |
|---|---|
| Cover · Getting started | orientation; the rules the components follow |
| Foundations / Colour | 74 primitive + 56 semantic swatches, every fill bound to its variable |
| Foundations / Type | one specimen per text style, set in the style itself |
| Foundations / Space, size & elevation | spacing bars, radius cards, the size ledger, the four effect styles, motion |
| 19 component pages | one family each, `_Doc` frame on the left, component set(s) to the right, State on the columns |
| Template / Pads · Build · Rig · Stage | the four views at 1440×900 assembled from instances (72 · 72 · 27 · 30); Stage has an *offline* twin. The shells and look grids are **Figma Grid** layouts mirroring the CSS grids; Pads and Build carry 1280 and 1024 breakpoint frames, Rig a 1024 |

Fonts: **SF Pro** (what the Mac renders for `-apple-system`); **Geist Mono**
stands in for SF Mono, which Figma cannot load.

## Tokens (see `tokens.json`)

| Figma collection | tokens.json | Count | Notes |
|---|---|---|---|
| Primitives | `primitive` | 74 | raw values; scopes `[]` so they never appear in a picker; includes an `alpha/*` family for washes, soft fills and shadows |
| Color | `semantic` | 56 | one mode, *Dark*; every value is an alias to a primitive; WEB code syntax = the real CSS custom property (`var(--panel)`) where one exists |
| Space | `space` | 15 | 1 · 2 · 3 · 4 · 5 · 6 · 7 · 8 · 9 · 10 · 12 · 14 · 16 · 18 · 24 — core steps are 2/4/6/8/12/16/24; 3 and 5 are pad-grid exceptions; 7 and 9 came from `.btn.small` and `.seg` |
| Radius | `radius` | 5 | 2 · 3 · 4 · 6 · pill; 3 is the default |
| Size | `size` | 35 | chrome heights, pad geometry, panel floors, `touch-target` 24 |
| Type | `type` | 28 | families, weight names, font sizes (`size/9_5` = 9.5), tracking and leading as reference numbers |
| Motion | `motion` | 5 | 120 ms · 150 ms and three pulse periods |

Text styles: **36**, named `text/<role>`. `text/label` (9.5px / .09em / upper)
is the workhorse. Effect styles: `elevation/menu`, `elevation/modal`,
`elevation/glow-accent`, `elevation/glow-blackout`, shadow colours bound to
variables.

Two Figma facts that shape the token model: a FLOAT variable bound to a text
style's letter-spacing or line-height is applied as **pixels**, so styles bind
family/weight/size and carry tracking/leading literally (the `tracking/*` and
`leading/*` variables are reference only); and overriding tracking on a styled
node **detaches** the style, so every CSS combination gets its own named style
rather than an override.

## Components

39 component sets across 19 pages, 166 variants, every fill and stroke bound to
a variable, every text node on a style, every interactive set carrying a
`State=Focus` variant (stroke `border/focus`) even where the CSS has none.
Variant names are `Property=Value` in Title Case with State on the columns.

| Page | Set (variants) | Codifies |
|---|---|---|
| Label | Label (3: Label · Section · Hint) | `.label` `.sectionhead` `.hint` |
| Button | Button (20) · Button / Small (12) · Button / Danger (16) | `.btn` and every modifier; resolves five red treatments into Danger / Blackout / All-stop |
| Segmented | Segmented (12) | `.seg` |
| Field | Field (16: Text · Number · Select · Chip-select × 4 states) | `input.text` `input.num` `select.sel` `.chipsel`; adds Invalid |
| Fader | Fader (12: Accent · Dim · Hue × 4 states) | `.fader` |
| Enable & Swatch | Enable (4) · Swatch (3) | `.enable` `.swatches i` `.swatch.mini` |
| Chip | Chip (5: Tag · Muted · Finding · Warn · Nudged) · Chip / Selectable (8: Head · Song × 4 states) | `.chip` `.headchip` `.deckchip` `.mutedchip` `.identifychip` `.warnchip` + the NUDGED chip |
| Status | Status dot (4) · Beat LED (2) · BPM · Offline bar · Toast (2) | `.statusdot` `.beatled` `.bpm` `.offlinebar` `.toast` — the bottom-left notice card; failures stay until dismissed |
| Pad | Pad (9 states) | `.cell` — the two targets: colour block fires, name strip selects |
| Grid heads | Column head (8) · Layer head (3) · Dial cell (5) · Dial head | `.colhead` `.layerhead` `.ctlcell` `.controlhead` |
| Song bar | Song bar | `.deckbar` |
| Library row | Library row (4) · Library hint | `.librow` `.libhint` |
| Tabs | Tab (4) · Tab bar | `.tab` `.tabs` |
| Table | Table header cell (3) · Table row (5) | `table.tbl` and the stub / beamless / dark / selected rows |
| Look editor | Param row (2) · Effect row (2) · Part card | `.paramrow` `.fxrow` `.parthead`/`.partbody`; the effect row spells out Size · Spread · Offset · Amount |
| Bars | Top bar · Pane header | `.topbar` (wraps to a second row below ~1500px; carries the trial chip and the cog's update dot) `.previzbar` (holds the stage-window button) |
| Shell | Reveal strip (4) · Splitter (4) · Splash · Crashed region | `.previzstrip` `.vsplit` `.splash` `.crashed` |
| Overlays | Modal (4) · Veil · Popover menu · Marquee | `.modal` `.modalveil`, the project menu, the plan marquee |
| Monitors | OSC monitor · DMX meter · Progress bar (4) | `.oscmon`, the Output-tab meter, the updater bar |

Each set's Figma description records what it codifies, the CSS it resolves,
and any deliberate deviation — several builders found cascade quirks in the
shipped CSS (a hover that never applies, a `.chipsel` padding the later `.chip`
rule overrides, a modal primary that renders as a ghost) and the descriptions
say which behaviour the component follows.

### Values the build added

The CSS used values the first token pass had not named. All were added to Figma
under the same conventions and are in `tokens.json`:

- Primitives: `alpha/red-15`, `alpha/amber-14`, `alpha/amber-7`, `alpha/red-dark-10`, `alpha/black-50`, `amber/700`, `scene/meter-span-edge`
- Color: `status/bad-fill`, `status/warn-fill`, `status/warn-border`, `status/stub-fill`, `status/dark-fill`, `border/swatch`
- Space: `space/7`, `space/9` · Type: `size/8_5`
- Size: `num-w`, `swatch-mini-w/h`, `deckchip-max-w`, `bpm-w`, `nowplaying`, `tab-indicator`, `param-label-w`, `menu-w`, `progress-h`
- Text styles: `text/hint` `text/segment` `text/chip-muted` `text/chip-warn` `text/chip-head` `text/chip-deck` `text/chip-riding` `text/offline` `text/colhead` `text/control-name` `text/control-midi` `text/library-hint` `text/table-head` `text/project-name` `text/cog` `text/control-sm` `text/strip-vertical` `text/crashed` `text/control-head`

## Copy and focus rules the code now carries

- `.prose` is help copy: 12px, line-height 1.5, sentence case, `text/secondary`. `.label`
  is a caption. The Controls and Sync paragraphs, the dial-row caption, the empty
  states and the library's hint are `.prose`; nothing explains itself in tracked caps.
- `.gridhint` sits above the pads when nothing reaches the rig — no fixtures, or
  every output off — and says what to do, with the button that does it.
- Every operable thing is focusable and announces itself: pads (`role=button`,
  Enter/Space press and release like a pointer), column heads, song chips and tabs
  (`role=tab`), enables and head chips (`role=checkbox`), swatches, the reveal
  strips. `:focus-visible` is a 2px accent ring (`box-shadow`, so a learn-armed
  outline still shows). Dialogs focus the safe button and keep Tab inside.
- Fields commit on blur or Enter, never per keystroke: fixture name, group name
  (renaming a generated group makes it yours), look fade.
- Undo says what it will revert: every history entry carries a name, derived
  from what the edit changed (`ui/src/editNames.ts`, in the app's own words —
  "rename song “Intro”", "move “Spot 3”", "place “Acid Bed” on Layer 2") unless
  the call site gives one. The tooltip reads "undo <name> (⌘Z)"; with nothing
  to undo it says what undo cannot reach — imports, song switches, nudges,
  masters. Anything that cannot be undone says so where it is offered.

## Language

One name per thing, and the name says what it does. The words: **pad**, **look**,
**song**, **rig**, **stage**, **dial**, **pulse**, **nudge**, **steps**, **spread**
(an effect across a group), **haze fan** (the hazer's), **brightest / dims / replaces** (layer blends), **ramp up / ramp down** (waves), **beam
size / soften / warmth** (beam channels), **find this light** (identify),
**Keep / Discard** (a nudge's two outcomes). Retired: deck, cell, previz, patch
(as a name), LFO, modulator, macro, named control, ride, soft override, cue
list, htp, cto, iris, frost, trim, sawUp, idx, seat, lease, heartbeat.

`scripts/check-language.mjs` walks every user-visible string in `ui/src`
(JSX text, title/placeholder/label props, dialog and toast copy, `describe*`
return values) and fails `npm run typecheck` on a retired word. Protocol names
(ArtPoll, unicast, UDP, E1.31, OSC) are allowed in tooltips and in the steps
that tell a tech what to click in Arena, never as the name of something in
LIGHT. `ui/src/labels.ts` maps wire values (`sawUp`) to what a person reads.

## What the system resolves

These are the places where the same intent had different values in the CSS.
The token set picks one; the Figma library enforces it; the CSS follows.

1. **Four ambers** → two: `status/warn` (#ffb347) and `status/ride` (#f0a63e). `--amber` was used six times and defined nowhere.
2. **Four reds and five red button treatments** → `status/bad`, the `danger` set, and `blackout` as the one control with its own red.
3. **Six chip shapes** → `Chip` (static kinds) and `Chip / Selectable`.
4. **Six near-black grounds** → `bg/app`, `bg/scene`, and the `scene/*` canvas palette.
5. **Thirteen font sizes**, six of them between 8 and 10.5px → the `text/*` styles.
6. **Five line-heights for wrapped help text** → `text/body-relaxed`.
7. **Weight 600 and radius 4** existed only inline → `text/chip-riding`, `radius/md`.
8. **Letter-spacing in px** (licence gate) vs em everywhere → em.
9. **Native unstyled controls** in the licence, update and settings surfaces → the Field and Button sets.
10. **Undefined classes** (`.patchsec`, `.sechead`, `.patchtable`) → Table and Label Kind=Section.
11. **z-index** 1 / 2 / 5 / 30 / 60 / 200 / 9999 → a scale (still to apply in CSS).
12. **Chrome sizes** duplicated across CSS templates, `App.tsx` constants and inline strings → `size/*`.
13. **No focus-visible** anywhere → every interactive set has `State=Focus`.
14. **Uppercase** by CSS transform in some places and literal caps in JSX in others → the style's text case, always.

## Layout: grid and flex, both ways

Auto-layout frames are flexbox; the components are built with them (FILL ≈ `flex: 1`,
HUG ≈ fit-content, wrap, min/max). The two structures that are CSS grids in the app
are Figma Grid layouts in the templates, so the mapping is one-to-one:

| CSS | Figma Grid | Read back as |
|---|---|---|
| `.app.view-pads` — rows `auto 46px var(--previz-h) 6px minmax(0,1fr)`, columns `minmax(0,1fr) 6px 280px 6px 380px` | template frame, 4 × 5, bars spanning 5 columns | `gridRowSizingCSS` = `46px 270px 6px minmax(0,1fr)`, `gridColumnSizingCSS` = `minmax(0,1fr) 6px 280px 6px 380px` |
| `.app.view-split` — `auto 46px … 6px minmax(0,1fr) 6px 292px` | 6 × 1 | `46px 270px 6px minmax(0,1fr) 6px 292px` |
| `.app.view-patch` / `.app.view-previz` | 4 × 1 / 2 × 1 (offline twin 3 × 1) | likewise |
| `.lookgrid` — `184px repeat(N, 108px) 30px`, `gap: 3px`, control row `grid-column: 1 / -1` | N+2 columns, HUG rows, control row spanning | `184px 108px … 30px` |

The 1px seam is the grid gap, bound to `space/1`; the look grid's gap is bound to
`space/3`. **Track sizes cannot bind to variables** in Figma (only gaps can), so
the numbers are literal and the components sitting in the cells carry the
bindings. What has no Figma form stays in the `_Doc` frames: named areas,
`minmax()`, the user-resizable `--library-w` / `--previz-h` tracks, `position:
sticky`, `overflow: auto`.

**Breakpoint frames.** Each dense template is cloned and resized — the `1fr`
tracks absorb the difference exactly as the CSS does — so the frames show what
the app actually does at a laptop and a tablet, not a redesign:

- Pads at 1024×768: library 280 + editor 380 are fixed, so the pad grid gets
  348px — a column and a half. That is the review's tablet finding (M14/M15) in
  one picture; the density side of it is now touch mode (below), and the pad
  did not get smaller.
- Build at 1024×768: previz 270 + bottom panel 292 are fixed, so the grid gets
  143px — one layer row. The bottom panel needs to scale, or collapse to its tabs.
- The top bar's content is ~1780px at every width; below that it scrolls
  (`overflow-x: auto`, hidden scrollbar) with the cog pinned — the review's M4.
- The audition pane is 432px fixed in Figma where the CSS says 30% (min 230,
  max 44%) — Figma has no percentage widths; the doc frame says so.

## Touch mode

The LAN tablet gets the same UI at `http://<mac>:9900`, and the review found
its targets far under the 24px `size/touch-target` floor and several edits
reachable only by right-click, hover or a modifier key (M14/M15). The answer is
a **density mode, not a redesign**: `.app.touch` on the root, automatic when
the browser reports a coarse pointer (`matchMedia('(pointer: coarse)')`),
forced on or off in Settings ▸ Display (`touchPref` in localStorage), and
followed live if the pointer changes. The laptop keeps its density — nothing
below applies without the class.

**Sizes.** The Size collection has a second mode, **Touch** (the first is Figma's default, named Value); `tokens.json`
carries both values as `modes` on each token, and `theme.css` applies them
under `.app.touch`:

| token | Value | Touch | what it is |
|---|---|---|---|
| `size/btn` | 26 | 28 | every `.btn` (`min-height`) |
| `size/btn-sm` | 20 | 24 | `.btn.small` — the layer ✕, song ◀ ▶, toast dismiss |
| `size/input` | 24 | 26 | `input.text`, `input.num`, `select.sel`; `.chipsel` 24 |
| `size/fader` | 22 | 28 | every fader, dial and master |
| `size/colhead` | 26 | 30 | column heads |
| `size/pad-h` | 58 | 64 | the pad, so the colour block stays the bigger half |
| `size/pad-name` | 17 | 24 | the select-without-firing strip (`--padname-h`) |
| `size/enable` | 12 | 18 | the enable box, plus a `::after` hit area of 26 |
| `size/swatch` | 16 | 24 | colour swatches |
| `size/strip` | 18 | 24 | the reveal strips (`--strip`, also the grid tracks) |

Not tokens but in the same block: `.seg button` and `.headchip` reach 24,
`.tab` 32, song chips 28 with their × and ‹ › **always visible** (they were
hover-only) and stretched to the chip's full height, table rows and library
rows get taller padding, and the splitters' invisible grab grows from 14 to
24px. The `?` button (`.btn.help`) appears in the top bar only in touch mode.

**Routes.** `ui/src/touch.ts` `contextPress(open)` returns the handlers that
open an element's context action from a right-click **or** a long-press
(500ms, 8px slop, touch and pen only — a mouse never gets it, so a slow click
stays a click). The click that trails a long-press is swallowed in the capture
phase, so holding a column head opens its menu without firing the column.
Used on column heads (rename / insert / delete) and song chips (rename / move
/ delete — a new menu; the right-click reaches it too). The 2D plan replaces
⌥ and ⇧ with a Move · Turn · Select picker in touch mode (`previz2dTool`), and
a held finger on a prop offers to remove it, the way a double-click does. The
DMX meter reads on a tap and keeps its reading when the finger lifts.

**Help.** `HelpMode.tsx`: `?` arms help mode, the next tap on anything with a
`title` (or `aria-label`) shows that text in a card beside it — the tap is
swallowed at the document in the capture phase, so a pad does not fire while
being read — and Escape or `?` again ends it. The card is `.helpcard`
(`.pill` for the standing hint); with a mouse the cursor says `help`.

## Keeping Figma and the code in sync

1. Change a variable or style **in Figma**.
2. Export: a read-only `use_figma` script dumps every variable (collection,
   name, type, value or alias, scopes, WEB code syntax, description) and every
   text/effect style; the same shape as the tables above. (Until a Figma REST
   token is set up this runs through the Figma MCP connector in a Claude session.)
3. Regenerate `tokens.json` from the export — the `$extensions.com.light.figma`
   block records the file key and export date.
4. Update `theme.css` from `tokens.json`; the WEB code syntax on each variable
   is the custom property to write.
5. A CI check should fail when `theme.css` drifts from `tokens.json` — not yet
   written; the first one to add.

Adding a component: duplicate the closest page, keep the conventions
(`Property=Value` variants, State on columns, `_Doc` on the left, no hardcoded
colours, a description on the set), and add it to the table above.

The library is intended to outlive this app: the primitives and the component
primitives (button, field, fader, chip, table, modal, tabs) are generic; only the
pad grid, the grid heads and the stage surfaces are LIGHT-specific.
