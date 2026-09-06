# Output and safety

## Universes

The Output tab lists the show's DMX universes. Each has a label, an **Art-Net**
toggle with its universe number, an **sACN** toggle, and a destination. Both
protocols can run at once.

**Outputs are off until you turn them on**, twice over. A new show has no
universe switched on, and separately LIGHT starts **offline** every time it
opens: nothing reaches the wire until you say so, whatever the show file says.
It means you can open anything — a demo, a show someone emailed you, your own
set in a venue where somebody else is mid-patch — without wondering what is
plugged in.

The `art-net` dot in the top bar goes green only when a node has actually
answered an ArtPoll, with its name in the tooltip. Amber means LIGHT is sending
and nothing is answering — which is what a wrong IP, a wrong subnet or an
unplugged node looks like.

There is a live DMX monitor per universe in the same tab: the actual bytes
leaving the app, which is the end of most "is it the desk or the fixture?"
arguments.

## Going live

The button at the left of the top bar's safety group reads **offline** or
**live**, and clicking it switches. The Output tab says the same thing in
sentences, with the universes it is gating right underneath.

Offline is not blackout. Blackout is the show being dark: the engine keeps
transmitting, and it is the transmitting that holds the rig at zero. Offline is
LIGHT not speaking to the network at all — the show carries on running on
screen, the stage view and the DMX monitor still show exactly what it is doing,
and none of it leaves the Mac.

Going offline **blacks the rig out first**. Art-Net and sACN nodes hold the last
frame they were sent, so simply falling silent would leave the rig lit at
whatever was on it. LIGHT sends a few frames of zeros, then stops.

The output dot beside the button reads **not sending** whenever universes are
switched on but LIGHT is offline. That combination is the one thing in the app
that looks like a fault and is not, so it is called out rather than left to be
discovered with a dark rig and a soundcheck running.

Node discovery is not gated. ArtPoll is a question, not output, so LIGHT keeps
finding nodes while offline — which is exactly when you want to know what is out
there.

## Masters

- **Grand master** scales all intensity output.
- **Layer masters** scale one layer's contribution.
- **Speed** multiplies every effect rate, 0.25× to 4×, without jumping phase.
- **Haze** is merged highest-wins with whatever the looks are asking for.

## Freeze

**freeze** in the top bar holds the rig on the frame it is showing. The show
carries on underneath: the pads still fire, the stage view still follows, the
look you are editing changes on screen exactly as it would live. The room does
not see any of it until you press **held** again to release.

It is for the thing everyone does mid-set — opening a look to change it with
the rig up — where every edit is otherwise live and a half-built look is on
stage while it is being built.

Freeze holds **everything**, including the raw channel check tool and find this
light. There is a case for letting a diagnostic through, but only one of the
two could be, and one punching through while the other silently did not would
be worse than a rule that is simply true. The DMX monitor shows the held frame
for the same reason: it reports what is leaving the app, and while frozen that
is the held frame.

Blackout and ALL STOP release it rather than being held by it. A hold that
could swallow a panic is not a hold worth having. Opening a different show
releases it too.

While it is held, the pads view says so above the grid, with a release button —
freezing and forgetting is the failure this feature can cause, so it is not
left to a lit button in a busy top bar.

## The ways to stop

**Blackout** (top bar, or `B`) zeroes intensity and strobe instantly and always
wins, while the layers keep running underneath. Release it and the stage returns
exactly as it was. This is the one to use when something needs to go dark *now*
and come back in a moment.

**Clear layer** (`✕` on a layer head) stops that layer and leaves the rest.

**Freeze** holds the rig on one frame while you work. It is the only one of
these that leaves the rig lit, which is the point of it.

**Going offline** stops LIGHT talking to the rig at all, after blacking it out.
Use it when the rig belongs to someone else for a while, or when you want to
build a show at a venue without touching what is hanging.

**ALL STOP** is the panic key: blackout on, every layer cleared, held flashes
released, haze and motors off, and any live nudge dropped. It asks for
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

**Being live does not survive either.** LIGHT comes back offline every time, on
purpose and for the same reason. Going live is one click, and it is a click
somebody made on purpose rather than a setting a file remembered.

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
