# User guide

How to operate LIGHT: looks, layers, cues, effects, and the controls that matter mid-set.

## The mental model

- A **look** is a lighting state: colour, intensity, positions, and effects for one or more fixture groups.
- Looks live in a **grid**: rows are **layers**, columns are **cues**. The layer stack runs bottom-to-top (WASH at the bottom, STROBE on top — the UI shows the top of the stack as the top row). Four layer rows, plus a fifth **control row** ruled off underneath them — the same shape as an APC40 mk2's clip grid.
- Clicking a pad fires its look on that layer with a crossfade. Clicking a **column header** fires the whole column as a cue.
- Everything time-based (effects, fades shown in beats) follows the **beat clock** — tap it, drag it, or let Resolume drive it.

## Firing looks

| Action | How |
|---|---|
| Fire a pad | Click it (also selects it for editing) |
| Fire a column (cue) | Click the column header, or keys `1`–`8` |
| Hold a flash look | Press and hold the pad — it releases on mouse-up |
| Clear a layer | `✕` in the layer header |
| From MIDI | Map pads/faders with MIDI learn (below) |
| From Resolume | Enable OSC output in Arena — column launches follow automatically |

**Column = cue.** Firing a column fires every layer's pad in that column and *clears* layers whose pad is empty — so a column fully describes the stage. Momentary **flash** looks are skipped by cues on purpose: a cue can never latch a blinder on.

**Flash looks** are momentary: active only while the mouse button or mapped MIDI note is held. If the client holding a flash look disconnects entirely, the engine releases it automatically.

## Crossfades

Each layer has a default fade (seconds) in the project; a look can override it with its own **fade** field in the look editor. Colours fade through RGB space (exactly what the fixture's channels do), intensities fade linearly, and *banded* values — derby colour slots, motor modes — snap at the start of the fade because the hardware can't fade between bands.

## Layers and blend modes

Layers apply bottom-to-top. Each has a **master** (scales that layer's intensity contribution) and a **blend mode**:

- **replaces** — replaces what's below on the channels the look touches. For base washes.
- **dims** — scales the intensity (dimmer/white) below. This is the FX layer's mode: a chase or pulse modulates *whatever colour the wash is showing* without owning colour itself.
- **brightest** — the brighter of the two layers wins, on intensity. For strobes and blinders that sit on top.

The **grand master** (top bar) scales all dimmer/white output. **Blackout** (top bar or `B`) zeroes intensity and strobing instantly — it always wins.

## The look editor

Select a pad → the Look tab shows its editor. A look is a list of **parts**; each part targets one fixture **group** and carries:

- **Dimmer** — intensity 0–100%.
- **Colour** — hue + saturation faders plus swatches. Derbies can't mix colour: they quantise to the nearest of their 14 fixed colour slots ("auto"), or pick a slot from the dropdown.
- **Derby extras** — *ring blinder* toggle (the white LED ring is on/off hardware — there is no ring dimmer), *ring FX* (the ring's built-in strobe patterns), *motor* (off / static aim / rotate + speed).
- **White** — the dedicated white emitter on an RGBW head, offered whenever
  something in the group actually drives one. Distinct from a derby's *ring
  blinder*, which is on/off hardware.
- **Strobe** — shutter rate, slow → fast.
- **Position** — pan/tilt for moving heads.
- **Haze** — output + haze fan for hazer-type fixtures (merged highest-wins with the manual haze slider in the top bar).

Enable a parameter with the checkbox to its left; a look only writes the parameters it has enabled, which is what lets layers combine cleanly.

### Effects

Each part can stack effects. An effect modulates one target (`dimmer`, `hue`, `white`, `strobe`, `pan`, `tilt`) with a wave:

| Wave | Feels like |
|---|---|
| sine / triangle | smooth swells |
| ramp up / ramp down | builds / beat-pulses |
| square | on/off gate (set *width* for duty) |
| chase | one-at-a-time run across the group (*width* = how many are lit) |
| random | sample-and-hold flicker |

- **rate** is musical: 1/4 beat up to 8 bars.
- **size** is depth.
- **spread** fans the phase across the group's heads — spread on a saw = a wipe; chase forces full spread.
- Chase/spread order = the order of heads in the group (see the Fixtures tab; chip order is chase order).

The **speed** fader in the top bar multiplies all effect rates (0.25×–4×) without jumping their phase.

## Tempo

- **TAP** (or `T`) — tap tempo; every tap also lands the downbeat.
- Drag the BPM number vertically for fine adjustment.
- **SYNC** snaps the phase to the next downbeat (matches Arena's resync).
- With Resolume connected via OSC, Arena's tempo drives the clock (see [resolume-and-midi.md](resolume-and-midi.md)).

## MIDI learn

1. Click **MIDI LEARN** in the top bar (it arms).
2. Click any pad, column header, layer master, or top-bar control.
3. Touch the control on your device — pad or encoder. Done; the mapping is stored in the project.

Notes fire pads (note-off releases flash looks); CCs drive faders. Manage or delete mappings in the **Sync · MIDI** tab.

A control in the grid's control row is learnable the same way — arm learn, click
its fader, touch an encoder. Prefer an encoder or fader to a pad: a pad drives a
continuous target by its velocity on press only (so a release cannot slam a dial
to zero), which means a pad can push a control up but never bring it back down.

**The APC40's eight device knobs drive the eight controls.** Load the APC40 mk2
preset in the Sync · MIDI tab and knob *N* becomes control *N* — the control row
shows which knob it is under each fader, read from the mappings themselves, so a
blank there means nothing is bound yet.

Two things worth knowing about that surface. The knobs are **absolute**, so the
first move jumps the control to wherever the knob is physically sitting — the
same pickup behaviour as the track faders on the layer masters. And in the
APC40's generic mode the knobs are *banked* by the `[TRACK SELECTION]` buttons,
which silently moves them to a different MIDI channel; the preset therefore binds
all nine banks to the same eight controls, so a stray press of a track button
cannot take your dials away mid-set.

## Saving

Everything autosaves ~1 second after any edit, with five rotating backups (`.bak1`–`.bak5`) next to the project file. `⌘S` (or the save button) forces a save. Live-performance state (which looks are active, grand master, blackout) is deliberately *not* saved — a restart always comes up dark and safe.

## Keyboard reference

`1`–`8` fire columns · `T` tap tempo · `B` blackout · `⌘S` save · `Esc` deselect. Shortcuts are ignored while you're typing in a field.

---

## Since the first release notes — what else is in the app

**Songs.** The chips under the top bar are pages of the grid, one per
song. Click to switch, double-click to rename, `⧉ duplicate` copies the current
song's pads into a new one (the usual way to start the next song), and the
APC40's bank ◀ ▶ arrows step through them. Looks live in one shared pool, so the
same look can sit in many pads and songs — an empty pad offers
**use existing look…** as well as **+ create look here**.

**Steps (⛓).** Any look can become a chaser: open it and press `⛓ steps`,
then add steps (a look + a beat count each). It hard-cuts through the steps on
the beat, loops, and follows the speed master. Steps cannot nest.

**Undo/redo.** `⌘Z` / `⇧⌘Z`, or the ↺ ↻ buttons. The history lives in the
engine, so every screen — the laptop and the tablet — shares one: whoever made
the edit, ⌘Z steps it back, and the button's tooltip names the step it will
take ("undo rename song “Intro”"). A hundred steps; a drag counts as one.
Edits are steps: pads, looks, songs, columns, the rig, imports, Keep on a
nudge, a learned MIDI mapping. What you play is not — song switches, masters,
haze, nudges and blackout stay where they are when you undo, and undoing an
edit made on another song leaves you on the song you are on. History belongs
to the loaded project: switching projects clears it.

**Projects.** The project name in the top bar is a menu: switch between shows,
`+ new project…`, or `save as…`. Files live beside the app's data; the app
remembers which one you had open.

**Fixtures table.** Number fields (position, mount rotation, tilt, roll) accept typed
values including negatives, or **drag left/right on the field to scrub**. Select
rows first — click, ⇧-click for a range, ⌘-click to toggle, or drag a box — and
any edit applies to the whole selection. The toolbar then offers
`→ universe`, `⇢ re-address`, `⧉ duplicate`, `✕ delete`, and
`⊕ group from N selected`.

**Fixture aim.** `Rot°` is yaw, `Tilt°` is the mounting pitch, `Roll°` the roll.
They compose on top of each fixture type's default aim, so a bar hung at an
angle can be pointed where it actually points — visible in both stage views.

**Art-Net node health.** The `art-net` dot goes green only when a node has
answered an ArtPoll, with its name in the tooltip; amber means LIGHT is sending
but nothing is answering. The Output tab lists the nodes it found.

**Ableton Link.** `link` in the top bar joins a Link session (native engine
only) and shows the peer count. Tapping tempo in LIGHT leads the session.

**The band.** The `+ musician…` picker in the 2D bar drops dummy performers
on the plan — drag to place, double-click to remove. They appear in both 3D
views (`band` toggles them in-app, `M` in the pop-out window), so you can judge
how a look actually lands on people. `STAGE WINDOW` in the top bar opens the native
window with real beams, haze, and shadows.

**The native window.** It opens framed on your whole rig — however big the plot
is and wherever it sits — and stays where you put it after that; a patch edit
will not throw away the shot you were lining up. `1` `2` `3` are FOH, side and
top. Moving heads are drawn as real moving heads: the yoke pans and the head
tilts with the beam, so you can see a fixture running out of travel or turning
to point at the audience, not just where the light lands.

Truss is drawn wherever the hang implies one — three or more fixtures in a line
at the same height and depth. It is a reading of your patch, not something the
show file carries, so a rig that is not hung in rows will not get bars drawn
through it.

**Risers.** Drag a musician onto a riser in the 2D plan and they stand on top of
it, kit and all — in both 3D views. There is no height to set: the stage reads
it off the riser your performer is standing inside, so moving or resizing the
riser moves whoever is on it. Only risers hold someone up, and standing beside
one leaves you on the deck.

**Exposure.** `auto exp` in the stage bar is eye adaptation: the view stops
down when the rig comes up and opens back up in the quiet parts, the way your
eyes do. It is partial, so a brighter look still reads brighter, and a blackout
is never brightened. Switch it off to judge absolute levels or to compare two
looks without the view re-metering between them.

**Layout.** The stage is a band across the **top** of every view — stages are
wider than they are tall, so that is the shape that reads. `Pads` / `Stage` /
`Rig` / `Build` (⌥1–⌥4) choose what sits under it:

| View | Under the band | |
|---|---|---|
| **Pads** | the pad grid, with the **look library** and the **look editor** at the right | the audition sits at the band's right edge |
| **Rig** | the fixtures table, with the **2D plan** above it | arriving picks the plan; your previous view comes back when you leave |
| **Build** | pads and the editor tabs | |
| **Stage** | — | full screen |

Drag the edges between panels to resize them, and the layout is remembered. Each
view has its own **hide** for the band (`▴` at the left of the stage bar, and
the slim strip it leaves behind brings it back), so you can run a show
full-height on the pads while the Rig view keeps its plan. **preview** in the
same bar switches the audition pane off — it is a second render, and firing a
pad selects it, so a show run from the pads may not want it.

**The look editor, on the pads view.** Rightmost column — the same editor as
the bottom panel's Look tab, following the same selection, so you can build the
next song without leaving the surface you perform from. `▸` folds it away. Below
about 810px of window width only one of the two right-hand panels fits, so
opening one folds the other; on a phone both fold and the pads keep the width.

**Look library.** Bottom right of the pads view: every look in the pool,
searchable, with a `×N` count of the pads already using it in this song. **Drag
a row onto any pad** to point that pad at the look. Pads *share* looks — editing
one updates every pad using it — so a drag is how the same wash reaches six
songs. `▸` collapses the library when the grid wants the width.

Dropping onto the pad a layer is **currently playing** does not change the
stage: the engine keeps playing the look it captured when you fired it. The pad
turns amber on screen to say so — fire it again to swap. On the APC that pad
keeps reporting the *stage*: it stays lit in the colour of what is actually
playing, not the colour of the look now sitting on it.

**The dial row.** Under the four layer rows, ruled off from them, sits a row
of **Dials**. They are not looks and not effects: a dial is one fader that
reaches *into* whatever is playing, each of its links driving one
parameter of one look's part between a `min` and a `max` you set. So it changes
nothing until the looks it links to are on stage, and it nudges live — the amber
**NUDGED** chip appears, and `Keep` writes the positions into the show while
`Discard` throws them away. A dial with no links yet is flagged ⚠.

The row is eight slots wide and the grid is capped at four layer rows for a
reason: four layers plus the dial row is exactly the 5 × 8 clip grid of an
APC40 mk2, so what is on screen is the shape of what is under your hands. Click
`+` on the next free slot to add a dial; `edit` opens the Controls tab, where
links, brackets and pulses live. Each fader is MIDI-learnable from the row
itself.

**On the network.** The engine serves this UI over HTTP too — open
`http://<your-mac>:9900` on a phone or tablet on the same network to drive the
show from the floor. On a phone the look library folds itself away so the pads
keep the width.

**On a tablet.** The console notices a fingertip and switches to touch sizing:
every control is at least 24px, the pad's name strip is big enough to select a
look without firing it, and the song chips show their × and ‹ › all the time.
What a mouse reaches by right-click or hover, a finger reaches by **holding**:
hold a column head to rename, insert or delete it; hold a song to rename, move
or delete it; hold a musician or a piece of stage in the 2D plan to remove it.
In the plan a Move · Turn · Select picker stands in for ⌥ and ⇧. The **?** in
the top bar is help: tap it, then tap any control to read what it does (tap ?
again, or Escape, to stop). Settings ▸ Display forces touch sizing on or off —
for a laptop with a touchscreen, or a tablet with a trackpad.
