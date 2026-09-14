# Reference

## Keyboard

| Key | Does |
|---|---|
| `1`–`9` | fire that column as a cue |
| `T` | tap tempo |
| `B` | blackout on/off |
| `[` `]` | previous / next song |
| `Esc` | disarm, leave the page you are editing, else deselect |
| `F` | hold the rig on this frame, or let it through |
| `K` | keep the live nudges |
| `D` | discard the live nudges |
| `A` | select what the top layer is playing |
| `E` | latch the grid for editing — nothing fires |
| `⌘,` | settings |
| `L` | open the look library |
| `/` / `⌘F` | find a look, song, column, group or fixture |
| `⌘S` | save now |
| `⌘Z` / `⇧⌘Z` | undo / redo |
| `⌥1`–`⌥4` | Pads / Stage / Rig / Build |

Press `?` for this table on screen. It is rendered from the same list the key
handler runs (`ui/src/shortcuts.ts`), and the engine test suite reads the table
above back out of this file and requires the two to match — so a shortcut
cannot be added without appearing here.

Shortcuts are ignored while you are typing in a field. A text field left focused
would otherwise swallow your cue keys, so the search box in the look library
hands the keyboard back on `Esc`, on `Enter`, and when you start dragging a look.

## Gestures

Everything the pointer does that is not a click. The wording on the left is what
a mouse or trackpad does; on glass the same gesture is a hold, and the app says
so — the sheet, the tooltips and this table all pick their words from the same
touch flag.

| With a mouse | On glass | Does |
|---|---|---|
| right-click a pad’s name | hold a pad’s name | open that pad’s menu |
| drag a pad’s name | drag a pad’s name | move the look to another pad — the two swap what they hold |
| right-click a column head | hold a column head | rename, insert or delete that column |
| click the layer’s ✕ | hold the layer’s ✕ until the ring fills | stop that layer |
| click a library tile, then a pad’s name | tap a library tile, then a pad’s name | put that look on the pad — the tile stays armed until Esc |
| type a name on the plan | type a name on the plan | select the lights whose names start with what you type |
| hold the lock | hold the lock | unlock this screen — it asks for the passcode |

The gesture list lives in `ui/src/gestures.ts`, the sheet renders it beside the
keys, and the engine test suite reads the table above back out of this file and
requires the two to match — so a gesture cannot be added without appearing here.

## Hover help

Every control in the app carries a tooltip — buttons, pickers, number fields
and faders alike. Where behaviour is deliberate but invisible it says so: which
fields commit on Enter rather than per keystroke, which gestures are a nudge
rather than an edit, and what a warning badge is warning about. If something on
screen is not obvious, rest on it before going looking in here.

## Glossary

**Look** — a lighting state: colour, intensity, position, beam and effects for
one or more groups. Lives in a pool shared by the whole show.

**Part** — one group's worth of a look. A look is a list of parts.

**Layer** — a row of the grid. Merges bottom to top with a master and a blend
mode.

**Song** — a page of the grid: its own pad on every layer and column.

**Column / cue** — a vertical slice of the grid. Firing it sets every layer,
clearing the ones whose pad is empty.

**Group** — a named set of fixture heads. What looks point at; its order is
chase order.

**Profile** — how a fixture's DMX channels work, usually compiled from a GDTF
file and stored inside the show.

**Spread** — how an effect's phase is distributed across a group: a basis (patch
order, world position, radial, the fixture's own pixel grid), optionally folded,
reversed, tiled or clumped.

**Nudge** — a live value sitting on top of what the look stored,
not saved until you Keep it.

**Dial** — one fader with links into many parameters, each with its
own min/max bracket.

**Pulse** — a beat-locked wave bound to parameters, running without a hand on
anything.

**Flash look** — momentary: held while the pad or note is held, skipped by cues.

**Steps** — a look that is a chaser: steps of look + beats, hard-cutting on
the beat.

## Where things live

| | |
|---|---|
| Projects | `~/Library/Application Support/LIGHT/projects/` |
| Fixture library | `~/Library/Application Support/LIGHT/fixtures/` |
| Backups | `<project>.project.json.bak1` … `.bak5`, beside the project |
| Engine + web UI | `http://localhost:9900` |

The project file is a single JSON document: patch, groups, looks, songs,
mappings and compiled fixture profiles. It is self-contained, so a show travels
as one file.

## Limits worth knowing

- Undo is thirty steps and does not cross projects.
- Steps cannot nest.
- Effect **rate** cannot be driven by a dial or a pulse — everything else
  can. See [Controls](05-controls.md) for why.
- A column fires up to the number of columns the song has; the APC's grid
  reaches the first eight.
