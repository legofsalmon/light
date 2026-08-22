# Output and safety

## Universes

The Output tab lists the show's DMX universes. Each has a label, an **Art-Net**
toggle with its universe number, an **sACN** toggle, and a destination. Both
protocols can run at once.

**Outputs are off until you turn them on.** A new show sends nothing, and
opening someone else's show does not start transmitting on your network. This is
the single most important default in the app: it means you can build, demo and
experiment anywhere without wondering what is plugged in.

The `art-net` dot in the top bar goes green only when a node has actually
answered an ArtPoll, with its name in the tooltip. Amber means LIGHT is sending
and nothing is answering — which is what a wrong IP, a wrong subnet or an
unplugged node looks like.

There is a live DMX monitor per universe in the same tab: the actual bytes
leaving the app, which is the end of most "is it the desk or the fixture?"
arguments.

## Masters

- **Grand master** scales all intensity output.
- **Layer masters** scale one layer's contribution.
- **Speed** multiplies every effect rate, 0.25× to 4×, without jumping phase.
- **Haze** is merged highest-wins with whatever the looks are asking for.

## The three ways to stop

**Blackout** (top bar, or `B`) zeroes intensity and strobe instantly and always
wins, while the layers keep running underneath. Release it and the stage returns
exactly as it was. This is the one to use when something needs to go dark *now*
and come back in a moment.

**Clear layer** (`✕` on a layer head) stops that layer and leaves the rest.

**ALL STOP** is the panic key: blackout on, every layer cleared, held flashes
released, haze and motors off, and any live ride dropped. It asks for
confirmation, because it ends the state of the show — everything needs re-firing
afterwards. On an APC40 it is STOP ALL CLIPS.

## Muting

A universe can be muted: the engine keeps running and keeps sending, but that
universe carries zeros. It is the polite way to silence one part of a rig
without changing the show or unplugging anything.

## What survives a restart

The show does: looks, songs, patch, mappings, masters as saved.

The **live state does not**. Which looks were running, blackout, held flashes —
all gone. A restart always comes up dark. That is deliberate: an app that
restores "everything at full" while someone is standing on a ladder is an app
that hurts someone.

## Saving

Everything autosaves about a second after you stop editing, with five rotating
backups beside the project file. `⌘S` forces a save. `⌘Z` / `⇧⌘Z` undo and redo
thirty steps, and a drag counts as one step rather than two hundred.

History belongs to the loaded project: switching shows clears it, rather than
risking one show's state being undone into another.

## On the network

The engine serves the same interface over HTTP, so a phone or tablet on the same
network can drive the show from the floor. Note what that means: **anyone on
that network who finds the address gets a working console**, including ALL STOP.
On a venue's open WiFi, treat it accordingly.
