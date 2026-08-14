# Architecture

How LIGHT is put together, and the complete control-protocol reference.

## The split

```
UI (React) ── previz (three.js) ── tablet on the LAN ── native previz (Bevy, shipped)
        │            │                  │                      │
        └────────────┴──── WebSocket, JSON, :9900 ─────────────┘
                                │
                     ENGINE  (one process)
        clock → layer merge → effects → masters → profile render
                                │
                 Art-Net :6454 / sACN :5568  @ 40 Hz
```

The engine is the only real-time component. Everything else — the window, the previz, a phone on the LAN — is a **client** of one WebSocket protocol and can crash, lag, or disconnect without touching output. Clients hold no authority: every command goes to the engine, the engine broadcasts back the truth.

## Two engines, one contract

| | `engine/` (Node/TS) | `core/` (Rust) |
|---|---|---|
| Role | reference implementation, dev iteration | production core (in the Tauri app) |
| MIDI | forwarded from browser WebMIDI | native CoreMIDI (`midir`), hot-plug |
| Runs via | `node engine/index.ts` (type stripping) | `cargo run -p light-core --bin light-engine` |

Both speak the identical protocol on the identical port. `npm run test:parity` boots both against pristine copies of the same project, drives them with the same command sequence over real WebSockets, and asserts **byte-identical DMX on all 512 channels** at every checkpoint, plus BPM and live-state parity. Unit suites (`npm test`, `cargo test -p light-core`) additionally pin behaviour per engine, including exact packet bytes over loopback.

## The 40 Hz tick

Every 25 ms (self-correcting schedule, sleep/wake recovery):

1. **Clock** — beat position from the BPM anchor; a separately *integrated* effect-beat means speed-master changes never jump effect phase.
2. **Layer merge** (param space, not channel space) — for each layer bottom→top: crossfade-weight the outgoing and incoming look per head (colour lerps in RGB; banded fields like derby macros and motor modes snap at fade start), then apply onto the stack by blend mode — `normal` lerp-replaces (master scales intensity), `multiply` multiplies dimmer/white, `htp` takes the max.
3. **Effects** — waveforms evaluated per head with per-group phase spread, applied inside the part before merging.
4. **Masters** — grand master scales dimmer/white; blackout zeroes intensity, strobe, and ring effects.
5. **Profile render** — each fixture profile converts resolved params to DMX bytes (see [fixtures-and-patch.md](fixtures-and-patch.md)).
6. **Output** — full 512-byte frames per enabled universe: Art-Net ArtDmx and/or sACN E1.31, broadcast/multicast or unicast.
7. **Snapshot** — every second tick (20 fps), clients receive the full live state for previz and meters.

Nothing on this path touches the filesystem or blocks on the network; autosave is debounced off the command path and writes atomically (temp file + rename, five rotating backups).

## Data model (project JSON)

```jsonc
{
  "version": 1,
  "universes": [{ "id": "u1", "artnetUniverse": 1, "sacnUniverse": 1,
                  "artnet": true, "sacn": false, "unicast": null, "label": "…" }],
  "fixtures":  [{ "id": "derby1", "profileId": "varytec-derby-st-4ch",
                  "universeId": "u1", "address": 1,
                  "pos": { "x": -2.6, "y": 3, "z": 0 }, "rotY": 0, "name": "…" }],
  "groups":    [{ "id": "g-pars", "name": "Bar Pars L→R",
                  "heads": [{ "fixtureId": "bar1", "head": 0 }, …] }],
  "looks":     { "wash-red": { "id": "wash-red", "name": "Red Wash", "parts": [
                   { "id": "…", "groupId": "g-pars",
                     "params": { "dimmer": 1, "color": { "h": 0, "s": 1 } },
                     "effects": [{ "id": "…", "target": "dimmer", "wave": "chase",
                                    "rate": 2, "size": 1, "spread": 0, "width": 0.25,
                                    "phase": 0 }] }],
                   "flash": false, "fade": 0.5 } },
  "layers":    [{ "id": "layer-wash", "name": "WASH", "blend": "normal",
                  "master": 1, "fade": 0.8, "cells": ["wash-amber", null, …] }],
  "columns":   ["Intro", "Build", …],
  "midi":      [{ "id": "…", "type": "note", "channel": 0, "number": 36,
                  "action": { "kind": "column", "col": 0 } }],
  "sync":      { "oscEnabled": true, "oscPort": 7700,
                 "followColumns": true, "bpmFromOsc": true },
  "settings":  { "haze": 0, "hazeFan": 0.35 }
}
```

Layer index 0 is the bottom of the stack. Look params are sparse — a look only writes what it enables. The engine is the source of truth: the UI edits by sending a whole updated project (`updateProject`), and the engine's echo is authoritative.

## Protocol reference

Plain JSON text frames over `ws://<host>:9900`. Anything that can open a WebSocket can control LIGHT.

### Commands (client → engine)

| `type` | Fields | Effect |
|---|---|---|
| `hello` | — | no-op (state arrives on connect) |
| `trigger` | `layerId`, `col` | fire a cell |
| `release` | `layerId`, `col` | release a held flash cell |
| `clearLayer` | `layerId` | fade the layer out |
| `column` | `col` (0-based) | fire a column as a cue |
| `setBpm` | `bpm` | set tempo (20–500) |
| `tap` | — | tap tempo (also lands the downbeat) |
| `resync` | — | snap phase to next downbeat |
| `setSpeed` | `v` | effect-rate multiplier (0.1–8) |
| `setMaster` | `v` | grand master 0–1 |
| `setLayerMaster` | `layerId`, `v` | layer master 0–1 |
| `setBlackout` | `v` (bool) | blackout on/off |
| `setHaze` / `setHazeFan` | `v` | manual hazer output / fan |
| `updateProject` | `project` | replace the whole project (edits) |
| `midi` | `status`, `d1`, `d2` | forward a raw MIDI event |
| `learn` | `action` \| `null` | arm/cancel MIDI learn — engine maps the next note/CC |
| `save` | — | force a save now |

### Events (engine → clients)

| `type` | Payload | When |
|---|---|---|
| `project` | full project | on connect and after any change |
| `snap` | live state (below) | 20 fps while any client is connected |
| `osc` | `{ t, addr, args }` | every OSC message received (for the monitor) |
| `saved` | `{ path }` | after an explicit save |
| `midiInputs` | `{ names[] }` | native MIDI devices (empty from the Node engine) |
| `learned` | `{ mapping }` | a learn completed |

**Snapshot** (`snap`): `beat`, `bpm`, `speed`, `master`, `blackout`, `haze`/`hazeFan`, `stats {fps, jitter, artnet, sacn}`, `layers[] {id, lookId, prevId, col, t}` (crossfade progress), `dmx {universeId: [512 bytes]}`, and `heads[]` — per fixture head: resolved `r g b` colour, intensity `i`, strobe `st`, derby `ring` and motor `mm`/`mv`, `pan`/`tilt`, and `mc` (derby macro component colours) — everything a previz needs without knowing fixture internals.

## Wire formats

- **Art-Net ArtDmx**: `"Art-Net\0"` · OpCode 0x5000 LE · protocol 14 · sequence 1–255 · SubUni/Net from the 15-bit universe · length 512 · data. Sent to port 6454, broadcast or unicast, every tick.
- **sACN E1.31**: root/framing/DMP layers, source name "LIGHT look engine", priority 100, start code 0, 512 slots — multicast to `239.255.hi.lo` or unicast. Universe 1–63999.

## Environment

| Variable | Meaning | Default |
|---|---|---|
| `LIGHT_PORT` | WS/HTTP port | 9900 |
| `LIGHT_PROJECT_DIR` | project storage | `./projects` in the repo; `~/Library/Application Support/LIGHT/projects` in the app |
| `LIGHT_NO_MIDI` | disable native MIDI (Rust core) | unset |

The engine also serves the built UI over HTTP on its port (`npm run build` first), so a LAN device just opens `http://<mac-ip>:9900`. There is deliberately no auth on the LAN protocol yet — treat the show network as trusted (an auth token is on the roadmap).
