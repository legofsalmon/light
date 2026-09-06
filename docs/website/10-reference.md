# Reference

## Keyboard

| Key | Does |
|---|---|
| `1`–`9` | fire that column as a cue |
| `T` | tap tempo |
| `B` | blackout on/off |
| `[` `]` | previous / next song |
| `Esc` | deselect |
| `⌘S` | save now |
| `⌘Z` / `⇧⌘Z` | undo / redo |
| `⌥1`–`⌥4` | Pads / Stage / Rig / Build |

Shortcuts are ignored while you are typing in a field. A text field left focused
would otherwise swallow your cue keys, so the search box in the look library
hands the keyboard back on `Esc`, on `Enter`, and when you start dragging a look.

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
