# Looks, pads and songs

## The grid

Rows are layers, columns are the sections of the song. In the demo show the
columns are Intro, Build, Break, Drop, Bridge, Peak, Outro, Blackout — name them
after your own arrangement; they are per-song.

| Action | How |
|---|---|
| Fire a look | Click the pad |
| Select without firing | Click the pad's **name strip** |
| Fire a whole column as a cue | Click the column header, or keys `1`–`9` |
| Hold a flash look | Press and hold; it releases on mouse-up |
| Clear a layer | `✕` in the layer head |
| Rename / insert / delete a column | **Right-click** the column header |

Column editing is on right-click on purpose: left-click fires the column, and
editing must not be reachable by the gesture that triggers cues.

**A column is a cue.** Firing it fires every layer's pad in that column and
clears the layers whose pad is empty — so a column is a complete description of
the stage, not a set of additions. Momentary flash looks are skipped by cues,
deliberately: a cue can never latch a blinder on.

An empty pad is also where you *start* a look, so clicking one does not black
out a layer that is currently running. It selects, and offers to create. The
deliberate stop is the `✕` on the layer head.

## Layers

Each layer has a master and a blend mode, and they merge bottom to top:

- **replaces** — replaces what is below on the channels the look touches. For base
  washes.
- **dims** — scales the intensity below it. This is what an FX layer wants:
  a chase or a pulse that carves whatever colour the wash is showing, without
  owning colour itself.
- **brightest** — the brighter of the two layers wins. For strobes and blinders that sit on top
  and must never *remove* light.

Blend affects intensity only. Colour, position, strobe and colour slots always take
the upper layer's value — worth knowing, because "multiply" reads like it should
multiply colours and it does not.

## Songs

The chips under the top bar are pages of the grid. Click to switch, double-click
to rename, `⧉ duplicate` copies the current song's pads into a new one — the
usual way to start the next song. `[` and `]` step through them, as do the
APC40's bank arrows.

Switching is held for a moment on click so that starting a rename does not
switch the show underneath you. The eyes-off paths — the bank arrows and the
bracket keys — are instant.

## What a look is made of

A look is a list of **parts**. Each part points at one fixture group and carries:

- **Dimmer** — intensity.
- **Colour** — hue and saturation, plus swatches. Fixtures that cannot mix
  colour quantise to their nearest fixed colour slot.
- **White** — the dedicated white emitter on an RGBW head. Offered when
  something in the group actually drives one.
- **Position** — pan and tilt, offered when something in the group has the
  channels for it.
- **Beam** — zoom, focus, beam size, soften, warmth. Each offered only if a fixture in
  the group has it. Absent means the look says nothing about that parameter and
  the fixture keeps whatever its profile parks it at — not that it is zero.
- **Strobe**, and the derby-specific ring controls where they apply.

Enable a parameter with the checkbox beside it. A look only writes the
parameters it has enabled, which is what lets layers combine cleanly: a colour
look and a position look can live on different layers without fighting.

> If a control you expect is missing, the group has no fixture that takes it.
> Where the *profile* lists the channel but drives nothing — which happens with
> definitions pulled out of an MVR — the editor says so and points at the fix.
> See [Patching](06-patch.md).

## Fades

Each layer has a default fade; a look can override it with its own. Colours fade
through RGB, intensities fade linearly, and *banded* values — colour slots,
motor modes — snap at the start of the fade, because the hardware cannot cross
between bands.

## Flash looks

Mark a look **FLASH** and it becomes momentary: active only while the pad or the
mapped MIDI note is held. If the client holding one disconnects, the engine
releases it rather than leaving a blinder on.

## Steps

Any look can become a chaser. Open it, press `⛓ steps`, and add steps — each
a look and a beat count. It hard-cuts through them on the beat, loops, and
follows the speed master. Steps cannot nest.

A look with steps is anchored at the moment you fire it, so a chase started on the
downbeat stays on the downbeat.

## Editing while the show runs

Dropping a look onto a pad that is **currently playing** does not change the
stage. The engine keeps playing the look it captured when you fired it, so a
build-ahead edit cannot change what the audience is looking at. The pad turns
amber to say the two disagree, and firing it again swaps to the new look.
