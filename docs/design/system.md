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
| Template / Pads · Build · Rig · Stage | the four views at 1440×900 assembled from instances (72 · 72 · 27 · 30); Stage has an *offline* twin showing the Offline bar + Splash |

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
| Chip | Chip (5) · Chip / Selectable (8) | `.chip` `.headchip` `.deckchip` `.mutedchip` `.identifychip` `.warnchip` + the RIDING chip |
| Status | Status dot (4) · Beat LED (2) · BPM · Offline bar · Toast (2) | `.statusdot` `.beatled` `.bpm` `.offlinebar` and today's top-bar toast |
| Pad | Pad (9 states) | `.cell` — the two targets: colour block fires, name strip selects |
| Grid heads | Column head (8) · Layer head (3) · Control cell (5) · Control head | `.colhead` `.layerhead` `.ctlcell` `.controlhead` |
| Deck bar | Deck bar | `.deckbar` |
| Library row | Library row (4) · Library hint | `.librow` `.libhint` |
| Tabs | Tab (4) · Tab bar | `.tab` `.tabs` |
| Table | Table header cell (3) · Table row (5) | `table.tbl` and the stub / beamless / dark / selected rows |
| Look editor | Param row (2) · Effect row (2) · Part card | `.paramrow` `.fxrow` `.parthead`/`.partbody`; the effect row spells out Size · Spread · Offset · Amount |
| Bars | Top bar · Pane header | `.topbar` `.previzbar` |
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
