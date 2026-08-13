# Code review — LIGHT v0.1

**Date:** 2026-08-13 · **Scope:** everything (both engines, UI, previz, app shell, protocol)

**Method & candour:** a multi-agent adversarial review (7 independent reviewers + per-finding verification) was attempted twice and lost both times to a sustained platform outage on the agent API. The findings below are from a disciplined author self-review — line-by-line re-reads targeting live-show failure modes — which found and fixed real defects, but an author reviewing their own code has blind spots by definition. **The independent adversarial pass is queued as a follow-up** and this document will be updated with its findings.

What *is* independently verified: the behaviour of both engines against each other. The differential parity test drives Node and Rust implementations over the real protocol and requires byte-identical DMX output — a defect must be made twice, identically, to survive it.

## Fixed during review

| Sev | Where | Defect | Fix |
|---|---|---|---|
| **Critical** | `core/src/server.rs` | **Path traversal in the static file server.** Rust's `Path::join` *replaces* the base when handed an absolute path, so `GET //etc/passwd` served arbitrary files. (The Node server was safe — `path.join` differs.) | Reject absolute paths, `..`, `\`, and `:` in request paths; 403. |
| **Major** | both engines | **Stuck flash look on client loss.** A blinder held via mouse or forwarded MIDI stayed latched forever if the holding client crashed — on stage, with no way to release it short of blackout. | Engine releases all held flash looks when its last client disconnects (`releaseAllHeld` / `release_all_held`); regression-tested in both suites. |
| **Major** | `core/src/renderer.rs` | **Panic paths on corrupt project data.** Three `unwrap()`/index sites could panic the render thread on duplicate fixture ids or a malformed patch — a crashed engine mid-show is the worst possible failure. | All lookups now degrade gracefully (skip the fixture/layer, never panic). |
| Major | both engines | **Column cues could latch flash looks** (fire with no release path). Found and fixed pre-review during construction. | Cues skip flash looks by design; tested. |

## Open findings (accepted or scheduled)

| Sev | Where | Finding | Disposition |
|---|---|---|---|
| Major | protocol | **`updateProject` is last-write-wins** — two UIs editing simultaneously clobber each other silently. Single-operator use is fine. | Roadmap (v0.6+): edit operations or revision checks. |
| Major | both servers | **Per-client send queues are unbounded.** A connected-but-stalled LAN client accumulates snapshots (~4 KB × 20/s) in memory indefinitely. | Roadmap: drop-oldest policy / disconnect stalled clients. Low practical risk on a show LAN; monitor. |
| Minor | `engine/persist.ts` | Autosave uses synchronous writes on the event-loop thread; a pathologically slow disk could delay a 25 ms tick. Debounced, atomic, ~15 KB file — measured effect is sub-millisecond. | Accept; revisit if projects grow large. Rust core writes between ticks on the engine thread — same reasoning. |
| Minor | OSC | A hostile/buggy OSC sender can restart column fades at packet rate (no rate limiting), and `/light/blackout 0` from the network can *clear* blackout. | Accept for trusted show LANs; auth token + rate limits on the roadmap. |
| Minor | protocol | **No authentication** on the LAN WebSocket — anyone on the network controls the rig. Deliberate for v0.x (trusted network, tablet remotes work zero-config). | Roadmap: optional token. |
| Minor | persistence | **No project schema versioning/migrations** beyond a version int check — a future format change could strand old saves. | Roadmap item before any format change ships. |
| Minor | sACN | Implemented in both engines and unit-checked against the E1.31 layout, but **not yet bench-tested against real sACN hardware** (Art-Net path is verified end-to-end). | Bench-test before relying on sACN at a gig. |
| Minor | clock | Long laptop suspend recovers the tick schedule (tested logic) but fade timestamps in flight during suspend complete instantly on wake. Cosmetic. | Accept. |
| Minor | UI | MIDI-learn armed state lives in both UI and engine; an engine restart while armed leaves the UI showing "learn" until toggled. | Accept; cosmetic. |
| Info | dev mode | `npm run dev` restarts the Node engine on file edits (`--watch`), dropping live look state (project state persists). Dev-only by design. | Accept. |

## Strengths worth keeping honest about

- **The parity harness is the crown jewel** — it caught real divergence during development and makes the Rust core trustworthy. Every future DMX-affecting change must extend it (see docs/development.md).
- Test suites pin packet bytes (Art-Net verified over loopback in both engines), merge maths, cue semantics, masters, blackout, flash behaviour, clock maths, and protocol JSON shapes.
- Engine isolation held up in practice: the window was killed mid-output during verification with zero DMX interruption; clients auto-reconnect.

## Follow-ups

1. Re-run the independent multi-agent review when agent capacity returns; fold findings in here.
2. Bench-test sACN against the Art-Net node (it also speaks sACN) before the first gig that relies on it.
3. Wire the four test suites into CI (GitHub Actions: node + cargo + parity on push).
