# QLC+ starter workspace — light rig

Companion files to the [rig guide](https://claude.ai/code/artifact/bdd31d3c-3101-4a79-ba72-76f61fc8425e). Written in QLC+ 4 format for maximum compatibility; **verified to load cleanly in the QLC+ 5.2.2 installed on this Mac** (all fixtures resolved, all functions and console widgets parsed).

## What's here

| File | What it is |
|---|---|
| `light-rig.qxw` | The workspace: patch, 8 looks, chase, Virtual Console |
| `Kam-Power-Partybar-WFS.qxf` | Custom fixture definition (20CH + 12CH modes) — **required**, QLC+ doesn't ship one |
| `Generic-Hazer-2CH.qxf` | Generic 2-channel hazer definition — **required** |
| `Varytec-LED-Derby-ST.qxf` | Copy of the official definition — install **only if** QLC+ says the fixture is missing (it was added to the library recently) |

## Install

**Already done on this Mac** — the KAM and hazer definitions are installed in `~/Library/Application Support/QLC+/Fixtures/`, and your QLC+ 5.2.2 bundles the Varytec Derby ST natively. Just open `light-rig.qxw`.

On any other machine: copy `Kam-Power-Partybar-WFS.qxf` and `Generic-Hazer-2CH.qxf` to that same folder (plus `Varytec-LED-Derby-ST.qxf` only if QLC+ reports it missing), restart QLC+, open the workspace.

## Check the plumbing (Inputs/Outputs tab)

The workspace pre-selects plugins, but line numbers are machine-specific, so verify:

- **Output**: universe "Effects (Art-Net U1)" → **ArtNet** on the network interface that reaches your node (the 2.x.x.x one). Click the wrench: output universe **1**; either broadcast (2.255.255.255) or unicast to your node's IP.
- **Input**: same universe → **OSC**, default port **7700**.

## The patch (matches the guide)

| Fixture | Mode | DMX address |
|---|---|---|
| Derby 1 / Derby 2 | 4 Channel | 001 / 011 |
| Partybar 1 / Partybar 2 | 20 Channel | 021 / 051 |
| Hazer | 2 Channel | 101 |

Set the physical fixtures to those modes/addresses (derby menu: `dMH → 04Ch`, address `A001`/`A011`; KAM menu: `20CH`, `d021`/`d051`).

## The looks (Virtual Console, keys 1–8)

Warm wash · Cold split · Bar chase + derby spin (chaser, 300 ms steps — retime to taste) · Strobe hit · Blinder · Deep red room · RGBW party · Blackout. They live in a **solo frame**: activating one releases the previous, like one clip per Resolume layer. Haze and fan are on separate sliders so looks never touch the hazer.

Derby quirks baked into the values: motor ≥128 = spin (looks use 200), 0 = parked; white-ring channel ≥180 = constant blinder (the Blinder look uses 255, Strobe hit uses 170 = fastest strobe pattern).

## Sync with Resolume

1. Resolume → Preferences → OSC → enable **OSC Output**, target `127.0.0.1`, port `7700`.
2. In QLC+ design mode, right-click a look button → Properties → **External Input → Auto Detect**, then launch the clip/column in Resolume you want tied to it. Stop detection, OK, done — repeat per button.
3. Buttons are Toggle; switch "Strobe hit"/"Blinder" to **Flash** in the same dialog if you'd rather have them momentary.

Test without the rig: Simple Desk or the DMX monitor (Function Manager → monitor icon) shows outgoing values live.
