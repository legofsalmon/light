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

`img/` holds what this set uses. All of it is real output from the demo show
except the two diagrams, which are authored — they explain structure better than
a screenshot of the same thing would.

| File | What it is |
|---|---|
| `signal-flow.svg` | how one frame is built — diagram |
| `console-layout.svg` | the pads view, annotated — diagram |
| `fan-sweep.gif` / `.mp4` | a hue fan sweeping the rig, captured from the 3D previz |
| `fan-still.jpg` | a single frame of the fan, for pages that want a still |
| `plan-view.jpg` | the 2D plan of the 129-fixture rig |

### Capturing more

The 2D plan is an ordinary canvas and can be read straight off the page. The 3D
previz cannot: three.js runs with `preserveDrawingBuffer: false`, so
`toDataURL` returns an empty buffer. To capture it, turn that flag on
temporarily in `ui/src/components/Previz3D.tsx` (there is a comment at the
renderer marking the spot), **full-reload the page** — HMR keeps the old
renderer instance — shoot, then turn it back off. It costs a per-frame copy, so
it must not ship enabled.

Frames come out of the page as base64; `ffmpeg` turns a numbered sequence into
both a GIF and an MP4:

```bash
ffmpeg -framerate 8 -i f%03d.jpg   -vf "scale=560:-2,split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse" out.gif
```

Two things learned the hard way. The previz camera is persisted in
`localStorage` under `previz3d.camera` (`{pos:[x,y,z], target:[x,y,z]}`), so a
known-good pose can be written directly rather than orbited to — but note the
controls overwrite it as soon as anything drags, so set it and shoot without
touching the view.

And composition matters more than exposure now. Filmic tone mapping rolls the
highlights off instead of clipping them, and `auto exp` (on by default) meters
the frame, so even a full-blast look photographs with structure in it — leave
both on unless you are deliberately shooting the blown-out version. Two things
still help: keep the camera out in the room rather than under the rig, and
remember the exposure takes about a second to settle after a cue change, so
shoot a beat late.

Still wanted, in the order the pages want them:

1. **A hero shot** for the front page — a beam-heavy look composed by eye. The
   automated attempts all came out as a lit floor; this one wants a human.
2. **Pads view, whole window**, a cue live — for 02. Needs a window-level
   screenshot rather than a canvas capture.
3. **A look open in the editor**, a part expanded with colour, position and an
   effect row — for 03.
4. **The control row** with a macro being moved and the RIDING chip appearing —
   for 05.
5. **Patch table** with a fixture selected and its row highlighted in the plan —
   for 06.
6. **APC40** photographed with the grid lit, if the hardware is to hand — for 08.

## House style

Write for someone who runs shows and has used other consoles, not for someone
learning what a dimmer is. Say what a control does, then what it costs. Where
behaviour is surprising, say why it is that way — most of the surprises here are
deliberate, and the reason is usually "so it cannot ruin a show".
