# Effects and fans

An effect is a **wave over one parameter**, locked to the beat, fanned across the
heads of a group. Each part of a look can stack as many as it needs, and they
apply in the order they are listed.

## The wave

| Wave | Feels like |
|---|---|
| **sine** | smooth swell |
| **triangle** | swell with a harder turn |
| **ramp up** | build, then reset |
| **ramp down** | beat-pulse — hit, then decay |
| **square** | on/off gate; `width` sets the duty |
| **chase** | one head at a time across the group; `width` is how many are lit |
| **random** | sample-and-hold flicker, reproducible from its seed |

**Targets:** dimmer, hue, white, strobe, pan, tilt, zoom, focus, beam size, soften,
warmth, gobo spin, prism spin. A target the group cannot take is flagged rather
than silently ignored.

## The knobs

- **rate** — beats per cycle. `4` is one cycle per bar in 4/4, `0.25` is four
  per beat. It is musical, not in hertz, so the rig stays in time when the
  tempo moves.
- **size** — depth. How far the parameter is pushed from where the look set it.
- **spread** — how far the phase is fanned across the group. At 0 every head
  moves together; at 1 the spread covers a full cycle. Chase forces full spread.
- **width** — duty, for square and chase.
- **phase** — a fixed offset, for running two effects against each other.
- **mix** — wet/dry. Useful for easing an effect in without changing its depth.
- **bypass** — parked: the effect is kept, contributes nothing this tick.

The **speed** master in the top bar multiplies every rate at once, 0.25× to 4×,
without jumping any phase — so you can halve the whole rig's motion mid-song and
nothing stutters.

## The spread

The spread is the part worth understanding, because it is what separates a rig that
looks programmed from a rig that looks switched on.

![A hue spread sweeping across the rig](img/fan-sweep.gif)

*One effect: a saw on hue, `spread` at 100 %, `distribute: x`. The phase is laid
across the stage by world position, so the colour walks the rig from one side to
the other. Nothing is programmed per fixture, and moving a fixture in the patch
moves its place in the spread.* ([MP4](img/fan-sweep.mp4))

`spread` says *how much* phase difference there is across the group. **distribute**
says *in what order the heads are counted*:

| Basis | Order |
|---|---|
| **index** | patch order — the order the heads appear in the group |
| **x** | left to right across the stage, by real world position |
| **y** | low to high |
| **z** | upstage to downstage |
| **radial** | outward from the centre of the group — a ripple |
| **shuffle** | a seeded scatter; re-roll the seed for a different one |
| **row** / **col** | the fixture's own pixel grid, *within* each fixture |

`row` and `col` are the ones that make a rig of multi-pixel fixtures behave:
every strobe runs the same pixel wave by construction, whatever order they were
patched in.

Then three modifiers:

- **fold** — `mirror` puts the ends in phase and sweeps toward the centre (the
  wings figure); `centre` leads from the middle and trails at the ends.
- **reverse** — run the order backwards.
- **tile** — tile the spread into *k* repeats across the group.
- **buddy** — clump adjacent heads so pairs (or threes) share a phase.

These compose. A saw on dimmer, `distribute: x`, `fold: mirror`, `parts: 2` is
two mirrored wipes running outward from two points on the truss — one effect,
four numbers, and no per-fixture programming.

Because positions come from the patch, a spread by `x` keeps working when you move
a fixture. Nothing needs re-teaching.

## Reusing an effect

`☆` saves an effect to the FX pool as a preset, ready to drop onto another part.
The pool is per show.

## Worked examples

**Slow breathing wash.** sine on dimmer, rate 16, size 0.25, spread 0.5,
distribute `x`, fold `mirror`. The room lifts and falls, the ends leading.

**Beat chase across the bar.** chase on dimmer, rate 1, width 0.18,
distribute `x`. One head per beat, left to right, regardless of patch order.

**Rainbow spread.** ramp up on hue, rate 8, size 1.0, spread 1.0, distribute `x`.
A full spectrum laid across the stage, cycling once per two bars.

**Nervous flicker.** random on dimmer, rate 0.25, size 0.7, spread 1.0,
distribute `shuffle`. Reproducible — the same seed gives the same scatter every
night.
