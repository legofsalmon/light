# Controls, modulators and riding a show

Three ways to change what is on stage without editing a look: ride a fader,
move a named control, or let a modulator do it continuously.

## Riding

Arm **ride** in the look editor and the numeric controls stop writing the show.
They send a **soft override** instead: live, immediate, and not saved.

While anything is riding, an amber **RIDING** chip sits in the top bar wherever
you are, carrying two buttons:

- **Store** — write the live positions into the show, so the looks keep them
  next time they fire. Undoable.
- **Discard** — throw them away and snap back to what the looks have stored.

ALL STOP disarms ride and drops any fader movement still in flight, so a drag
mid-gesture cannot re-create the rides the panic just cleared.

## Named controls

A control is a **macro fader**: one knob driving many parameters at once. They
are neither looks nor effects — they sit outside the grid and reach *into*
whatever is playing.

Each control has **links**. A link says: this look, this part, this parameter,
between *min* and *max*. Moving the control to 0.7 puts every linked parameter
70 % of the way through its own bracket. Set min above max to invert one link
against the others — a single knob that opens one group while closing another.

Controls live in the grid's **fifth row**, ruled off from the layers, eight
slots wide. Four layer rows plus that one is exactly the 5 × 8 clip grid of an
APC40 mk2, so what is on screen is the shape of what is under your hands. The
`edit` button opens the Controls tab, where links and brackets are built.

Things worth knowing:

- A control changes nothing until the looks it links to are **on stage**. The
  override is written and waiting.
- Moving one is a ride. It shows up in the RIDING chip and needs Store to
  persist.
- A control with no links, or whose links all point at looks that have since
  been deleted, is flagged `⚠`. It moves and nothing happens, which is otherwise
  hard to see.

### On the APC40

Load the APC40 mk2 preset in Sync · MIDI and the eight **device knobs** drive
the eight controls. The control row shows which knob is on which macro, read
from the mappings themselves — so it is blank until something is really bound
and cannot promise hardware you do not have.

Two hardware facts:

- The knobs are **absolute**. The first move jumps the control to wherever the
  knob is physically sitting — the same pickup behaviour as the track faders on
  the layer masters.
- In the APC's generic mode the `[TRACK SELECTION]` buttons **bank** the device
  knobs onto a different MIDI channel. The preset therefore binds all nine banks
  to the same eight controls, so a stray press of a track button cannot take
  your macros away mid-set. A binding that covers only some banks — which is
  what MIDI-learn creates — is flagged, because it will work on the bench and
  die on stage.

Prefer an encoder or fader to a pad for a control. A pad drives a continuous
target by its velocity on press only, so it can push a macro to full and never
bring it back.

## Modulators

A modulator is a beat-locked LFO that rides parameters continuously — no pad
press, no hand on a fader.

Give it a wave, a rate in beats and a phase, then **bind** it to parameters.
Each binding has a **depth** from −1 to 1: how far it swings, and in which
direction. It offsets whatever the value would otherwise be, so it rides on top
of a ride, which rides on top of the stored look.

Switch one off and the parameters return to where the look and any ride left
them; nothing is left stranded.

Rate is deliberately **not** something a control or modulator can drive. A rate
that changes continuously turns the per-part phase correction into an integrator
of its own tick schedule, and two engines integrating separately would drift
apart. Depth, size, spread, mix and the parameters themselves are all fair game.

## Which one to reach for

- **Ride** when you are shaping this moment and might keep it.
- **A control** when one gesture should move several things — a warmth knob
  across every wash, a size knob across every beam.
- **A modulator** when the movement should happen on its own for as long as the
  song lasts.
