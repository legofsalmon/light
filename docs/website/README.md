# LIGHT — documentation set

Source for the public documentation. Each file is one page; they are written to
be read in order but each stands alone.

| Page | What it covers |
|---|---|
| [01 · Overview](01-overview.md) | What LIGHT is, the mental model, how a frame is built |
| [02 · The console](02-console.md) | The four views, the panels, what collapses where |
| [03 · Looks, pads and songs](03-looks.md) | The grid, decks, looks, parts, cue lists, flash |
| [04 · Effects and fans](04-effects.md) | Waves, rate and depth, and how a phase fans across a group |
| [05 · Controls and modulators](05-controls.md) | Macro faders, LFOs, and riding a show live |
| [06 · Patching and fixtures](06-patch.md) | Addresses, profiles, GDTF and MVR import, groups, pixel layouts |
| [07 · Previz](07-previz.md) | The 3D stage, the 2D plan, the audition pane, the native window |
| [08 · Tempo, MIDI and Resolume](08-sync.md) | The beat clock, the APC40, OSC, Ableton Link |
| [09 · Output and safety](09-output.md) | Universes, Art-Net and sACN, masters, blackout, ALL STOP |
| [10 · Reference](10-reference.md) | Keyboard, glossary, where files live |

## Illustrations

`img/` holds what this set uses:

- `signal-flow.svg`, `console-layout.svg` — diagrams, authored for the docs.
  They explain structure better than a screenshot of the same thing would.
- `plan-view.jpg` — a real capture of the 2D plan from the demo show.

**Screenshots and motion are still to do**, and are worth doing properly: the
things this app does that a still cannot show are a fan sweeping across a group,
a chase running, and a control moving twenty parameters at once.

The 2D plan is an ordinary canvas and can be captured from the page. The 3D
previz cannot — three.js runs with `preserveDrawingBuffer: false`, so reading
the canvas returns an empty buffer. Capture it with a screen recorder, or flip
that flag temporarily while shooting.

Shot list, in the order the pages want them:

1. **Pads view, whole window**, a cue live — for 02.
2. **A look open in the editor**, a part expanded with colour, position and an
   effect row — for 03.
3. **A fan sweeping** (short loop): one look, `distribute` cycling
   index → x → radial, spread at 100 % — for 04. This is the page that most
   needs motion.
4. **The control row** with a macro being moved and the RIDING chip appearing —
   for 05.
5. **Patch table** with a fixture selected and its row highlighted in the plan —
   for 06.
6. **3D previz** on a peak look with haze up — for 07 and the front page.
7. **APC40** photographed with the grid lit, if the hardware is to hand — for 08.

## House style

Write for someone who runs shows and has used other consoles, not for someone
learning what a dimmer is. Say what a control does, then what it costs. Where
behaviour is surprising, say why it is that way — most of the surprises here are
deliberate, and the reason is usually "so it cannot ruin a show".
