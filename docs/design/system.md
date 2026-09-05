# LIGHT design system

The visual language of LIGHT, written down so it can be maintained in one place
and reused across other apps. `tokens.json` beside this file is the machine
half; this is the human half — what the pieces are, what is inconsistent today,
and how the Figma library is built from it.

**Status:** codified, not redesigned. Every value was measured from
`ui/src/theme.css` and the components on 2026-09-05. The Figma library does not
exist yet; when it does, Figma variables become the source of truth and
`tokens.json` is regenerated from them, not edited by hand.

## The look, in one paragraph

A white-on-dark console for rooms with the house lights down. One theme. Near-black
grounds in cool greys, a single cyan accent that means "on / selected / focused"
and nothing else, and a small family of status colours — green for good, amber
for attention, red for stop. Type is the system sans at small sizes with
tracked uppercase labels doing most of the work; numbers are monospaced. Corners
are 3px. Surfaces are separated by 1px seams, not shadows; the only shadows are
on menus and modals, which float.

## Tokens (see `tokens.json`)

| Collection | What it holds | Notes |
|---|---|---|
| `primitive` | raw greys, cyan, amber, red, rose, swatch and scene palettes | nothing references these directly |
| `semantic` | `bg`, `border`, `text`, `accent`, `status`, `danger`, `blackout`, `overlay` | the app's actual vocabulary; one mode |
| `type` | families, weights, line-heights, 16 composite styles | `label` (9.5px / .09em / upper) is used 95 times |
| `space` | 1 · 2 · 3 · 4 · 5 · 6 · 8 · 10 · 12 · 14 · 16 · 18 · 24 | core steps are 2/4/6/8/12/16/24; 3 and 5 are pad-grid exceptions |
| `radius` | 2 · 3 · 4 · 6 · pill | 3 is the default |
| `size` | chrome heights, pad geometry, panel floors, touch target | `touch-target` 24px is the first thing the current UI fails |
| `elevation` | menu, modal, two glows | |
| `motion` | 120ms · 150ms and three pulse periods | only the identify pulse honours reduced-motion today |

## Components, in build order

Each entry names the CSS class it comes from and the states it must carry.

1. **Foundations** — colour, type, spacing/radius/elevation, glyph sheet.
2. **Label** (`.label`) — default, dim, mono, section head (`.sectionhead`), hint prose.
3. **Button** (`.btn`) — default, ghost, small, on, warn-on, hot, danger, blackout (idle / armed), all-stop, pin, cog. States: rest, hover, active, disabled, focus-visible (missing today).
4. **Segmented** (`.seg`) — with selected item.
5. **Field** — text, num (mono), select, chip-select. States: rest, focus, invalid, disabled.
6. **Fader** (`.fader`) — accent, dim, hue; caption + value; learn-armed; off.
7. **Enable** toggle; **Swatch** (16 picker, 20 current, pad strip, mini strip).
8. **Chip** family — tag, head chip, deck chip, muted, identify, warn, riding. Today these are six shapes at five sizes; the system gives them one.
9. **Status dot** + dot line, **Beat LED**, **BPM**, toast.
10. **Pad** (`.cell`) — empty, look, selected, active, stale, learn-armed, drop target, name-strip hover; flash mark; fade bar.
11. **Column head**, **Layer head** (name, blend, clear, now-playing, master), **Control cell** (filled, riding, empty, addable).
12. **Deck bar**.
13. **Library row** + hint.
14. **Tabs**.
15. **Table** (`.tbl`) — sortable head, mono cell, row key-lines (selected / stub / dark / beamless).
16. **Look editor blocks** — part card, param row, effect row (+ fan row), section head.
17. **Bars** — top bar, previz bar, pane header, offline bar.
18. **Shell** — previz band + audition pane, reveal strips, splitters, bottom panel, crashed region, splash; the four view templates at 806 / 598 / 498 px.
19. **Overlays** — modal (title / body / input / row; danger), wide modal, project-menu popover, marquee.
20. **OSC monitor**, **DMX meters**, **progress bar**.
21. **Licence gate** — currently the least tokenised surface; build last, from the primitives.

## What the system resolves

These are the places where the same intent has different values today. The
token set picks one; the Figma library enforces it; the CSS follows.

1. **Four ambers** → two: `status.warn` (#ffb347) and `status.ride` (#f0a63e). `--amber` is used six times and defined nowhere.
2. **Four reds and five red button treatments** → `status.bad`, the `danger` set, and `blackout` as the one control with its own red. `.clearbtn` and `.danger` are identical at rest.
3. **Six chip shapes** → one chip with variants.
4. **Six near-black grounds** → `bg.app`, `bg.scene`, and the `scene.*` canvas palette.
5. **Thirteen font sizes**, six of them between 8 and 10.5px → the `type.style` set.
6. **Five line-heights for wrapped help text** → `prose` 1.6.
7. **Weight 600 and radius 4** exist only inline → folded in or added deliberately.
8. **Letter-spacing in px** (licence gate) vs em everywhere → em.
9. **Native unstyled controls** in the licence, update and settings surfaces → the Field and Button primitives.
10. **Undefined classes** (`.patchsec`, `.sechead`, `.patchtable`) and scoped-only rules (`.label.dim`, `.mono`) → real components.
11. **z-index** 1 / 2 / 5 / 30 / 60 / 200 / 9999 → a scale.
12. **Chrome sizes** duplicated across CSS templates, `App.tsx` constants and inline strings → `size.*`.
13. **No focus-visible** on buttons, segments, tabs, pads, chips → every interactive component carries a focus state.
14. **Uppercase** by CSS transform in some places and literal caps in JSX in others → the transform, always.

## Building the Figma library

When the Figma connector is authorised, the library is built from this
directory in this order, and then this directory is regenerated from it.

1. **Variables** from `tokens.json`: one collection per top-level key, primitives
   first, semantics aliased onto them. One mode.
2. **Text styles** from `type.style`.
3. **Effect styles** from `elevation`.
4. **Components** in the build order above, each with the listed variants and
   states as component properties, using variables for every colour, size and
   radius — no hardcoded values in the library.
5. **The four view templates** as layout frames at the breakpoints, assembled
   from the components.
6. **Round trip**: `tokens.json` is exported from the variables; a CI check
   fails when `theme.css` drifts from it.

The library is intended to outlive this app: the primitives and the component
primitives (button, field, fader, chip, table, modal) are generic; only the pad
grid and the previz surfaces are LIGHT-specific.
