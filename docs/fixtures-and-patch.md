# Fixtures & patch

Patching fixtures, building groups, and the full channel reference for every built-in profile.

## Patching

**Fixtures tab ▸ Patch.** Each fixture has a profile, a universe, a DMX start address (1-based, as printed on the fixture's display), and a position for the previz. Address ranges that overlap another fixture on the same universe turn red. `+ add fixture` picks the next free address automatically.

Place fixtures by dragging them in the **2D previz** (top-down plan; x is stage left→right, the bottom edge is the audience). Height (`Y`) is set numerically in the patch table — rigged fixtures at ~3 m aim down-stage in the 3D view automatically.

## Groups

Looks target **groups**, and group members are *heads*, not fixtures — a 4-par bar contributes four independently-controllable heads. Toggle membership with the chips in the Fixtures tab. **Chip order is chase order**: a chase effect runs across the group's heads in exactly this order, so "Bar Pars L→R" ordered bar1-p1 … bar2-p4 sweeps the stage left to right.

## Universes

**Output tab.** Each universe has:

- **Art-Net universe** — the 15-bit port-address exactly as your node expects it (0-based on the wire; this rig's node listens on universe 1).
- **sACN universe** — 1-based, if sACN is enabled.
- **Destination** — empty = Art-Net broadcast (255.255.255.255) / sACN multicast; or enter your node's IP for unicast (IP literal only). **If the Mac is on Wi-Fi and the rig on Ethernet, set the node's unicast IP** — broadcast follows the default route (usually Wi-Fi) and the rig would hear nothing; unicast always routes out the correct interface.

Output runs continuously at 40 Hz per enabled universe. The DMX monitor at the bottom shows live channel values; engine health (refresh rate, tick jitter) sits above it.

The default architecture this app was built around: **universe 0** carries Resolume Arena → Octostrip pixel data directly (Arena's Advanced Output), **universe 1** is LIGHT's — derbies, bars, hazer via the Art-Net→DMX node. Default patch: Derby1 @001 · Derby2 @011 · Bar1 @021 · Bar2 @051 · Hazer @101.

## Built-in profiles

### Varytec LED Derby ST — 4 Channel

A macro-colour derby: it cannot mix RGB. LIGHT's look editor still shows a colour control — the engine quantises your colour to the nearest macro below (or pick one explicitly).

| CH | Function | Values |
|---|---|---|
| 1 | Colour macro | see table below |
| 2 | Strobe | 0–5 open · 6–255 slow→fast |
| 3 | Motor | 0 off · 1–127 static aim · 128–255 rotate slow→fast |
| 4 | White LED ring | 0–9 off · 10–179 strobe patterns 1–17 · 180–255 full on |

The ring is **on/off hardware** — no proportional dimming exists. LIGHT sends 220 for "ring blinder", or a value in 10–179 for "ring FX" patterns.

Colour macro bands (LIGHT transmits the band midpoint):

| DMX | Colour | | DMX | Colour |
|---|---|---|---|---|
| 0–5 | off | | 126–140 | green + white |
| 6–20 | red | | 141–155 | blue + white |
| 21–35 | green | | 156–170 | red + green + blue |
| 36–50 | blue | | 171–185 | red + green + white |
| 51–65 | white | | 186–200 | green + blue + white |
| 66–80 | red + green | | 201–215 | red + green + blue + white |
| 81–95 | red + blue | | 216–230 | colour change 1 |
| 96–110 | red + white | | 231–255 | colour change 2 |
| 111–125 | green + blue | | | |

Auto-quantisation only picks static bands; the two colour-change programs are explicit-only. "Off" doubles as the derby's blackout — the profile sends 0 when the look's dimmer is at zero.

### KAM Power Partybar WFS — 20 Channel

Four RGB pars on a T-bar, each par an independent head:

| Offset | Function |
|---|---|
| +0/+1/+2 | Par N red / green / blue |
| +3 | Par N dimmer |
| +4 | Par N flash — 0–5 steady · 6–255 slow→fast |

Par N starts at offset (N−1)×5 from the fixture address. LIGHT drives colour on the RGB channels at full and intensity on the dimmer channel, so colour crossfades stay clean at any brightness.

### Generic Hazer — 2 Channel

| CH | Function |
|---|---|
| 1 | Haze output |
| 2 | Fan speed |

The top-bar haze slider writes here directly (merged highest-wins with any look that sets haze).

### Generics for growth

| Profile | Channels |
|---|---|
| Dimmer | 1: dimmer |
| RGB Par | 3: R, G, B (intensity folded into colour) |
| RGBW Par | 4: R, G, B, W |
| Moving Head RGBW | 10: pan, pan fine, tilt, tilt fine, dimmer, strobe, R, G, B, W (16-bit position) |

## How looks become DMX

Per 40 Hz tick the engine resolves every head's parameters (layer merge → effects → masters), then each profile renders parameters to its channels: masters scale dimmer/white before rendering; profiles without a dimmer channel fold intensity into their colour channels; banded channels (derby macros, motor modes) snap rather than fade. The maths is identical in both engines and locked by the parity test.

## Importing a whole design (MVR)

The same import button accepts **.mvr** scene files (exported from
Vectorworks, Depence, grandMA, and most planning tools): fixtures arrive with
their patch addresses, plan positions, and fixture types (the GDTFs embedded
in the file), plus one group per MVR layer. You choose merge (keep the
current patch) or full replace on import. Universes named in the file that
don't exist yet are created automatically. Conventions: positions convert
from MVR millimetres/Z-up to LIGHT metres/Y-up; addresses accept both the
absolute and `universe.channel` forms — exporters vary, so check the patch
table after a first import.

## Importing fixtures (GDTF)

For anything beyond the built-ins, click **⇩ import .gdtf** in the Fixtures tab and pick a fixture file (e.g. from [gdtf-share.com](https://gdtf-share.com)). Every DMX mode in the file becomes a selectable profile (marked ⇩ in the dropdown), stored inside the project so it travels with your show. Supported in v1: dimmer, RGB(W) colour, 16-bit pan/tilt, shutter/strobe, and colour wheels (with automatic nearest-colour quantisation, like the derby); unmapped channels hold the fixture's own defaults. Both engines interpret imported profiles through one shared implementation, and the parity suite covers it.

**Pixel arrays.** A fixture with many emitters is usually written the way the
GDTF spec intends: the colour channels are declared once on a template lens,
and each physical pixel is a *GeometryReference* to that lens carrying its own
position and a DMX offset per break. The importer expands those references,
so a Robin Spiider comes in as its nineteen pixels in two rings plus the
flower, on every mode, with the footprint the fixture actually occupies —
a Pixel RGB mode is 91 channels, a Pattern full RGBW mode is 123. A reference
lists one offset per break; a channel declared on a numbered break takes the
matching entry, and one declared as an *Overwrite* takes the last, which is
how one file serves both its three- and four-channel modes. Both spellings
of the position matrix are read: the spec's 4×4 with the translation in the
last column, and the axis-vectors-plus-origin form some consoles export. The
face is laid out in whichever plane the pixels actually lie in, so a bar or
panel reads across and up as before and a moving head's face reads as a
face, not a line.

A profile compiled by an older build carries its compiler version, and the
Rig view flags it with **rebuild from library** when the importer has learned
something since. Take the offer: a pixel array compiled before this could have
been short of both heads and channels, and the address after it may need to
move.
