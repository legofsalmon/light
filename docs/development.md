# Development

Building, testing, and extending LIGHT.

## Prerequisites

- **Node.js ≥ 23.6** (the Node engine runs TypeScript directly via type stripping; developed on 25.x)
- **Rust stable** (`rustup`, any recent stable) for the core, parity test, and app
- **Xcode Command Line Tools** (macOS builds)

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Node engine (`--watch`) + Vite UI → http://localhost:5173 |
| `npm run dev:rust` | Same, but the Rust core is the engine |
| `npm run build` | Production UI bundle → `ui/dist` |
| `npm start` | Gig mode: Node engine serves the built UI on :9900 |
| `npm run start:rust` | Gig mode on the Rust core (release build) |
| `npm run app:dev` | Tauri window + Vite dev server |
| `npm run app:build` | `LIGHT.app` → `target/release/bundle/macos/` |
| `npm test` | Node engine smoke suite |
| `cargo test -p light-core` | Rust core suite (same checks + protocol shapes) |
| `npm run test:parity` | **Differential test: both engines, byte-identical DMX** |
| `npm run typecheck` | `tsc` over engine+shared and ui |

## Repo layout

```
shared/     TS data model + fixture profiles + effect maths (engine + UI)
engine/     Node reference engine (+ test/smoke.ts, test/diff.ts)
core/       Rust core: same behaviour, same protocol (+ tests/smoke.rs)
ui/         React app (Vite): grid, editors, previz
src-tauri/  Tauri 2 shell (engine thread + window)
site/       Static landing page (point Vercel at this folder)
docs/       You are here
```

## The rules that keep it reliable

1. **Both engines or neither.** Any behavioural change lands in `engine/` (TS) *and* `core/` (Rust), with the parity test green before merge. If you only prototype in one, gate it off in the other — never let them silently diverge.
2. **Erasable TypeScript only** in `engine/` and `shared/` — Node runs these files raw with types stripped: no `enum`, no constructor parameter properties, no namespaces; type-only imports must use `import type`. (`ui/` is bundled by Vite and has no such restriction, but keeps the same style.)
3. **Nothing blocking on the tick path.** The 25 ms loop must not touch fs/network-blocking calls; persistence is debounced and atomic.
4. **The protocol is the contract.** `shared/types.ts` and `core/src/types.rs` are mirrors; change them together (serde uses camelCase renames + `skip_serializing_if` to match TS optionals exactly). `protocol_json_shapes` in `core/tests/smoke.rs` pins the encoding.

## Adding a fixture profile (until GDTF lands)

1. **`shared/profiles.ts`** — add a `Profile` with `heads` (kind + previz offset), `channelNames`, `beamDeg`, and a `render(heads, buf, base)` that writes DMX bytes from `ResolvedParams`.
2. **`core/src/profiles.rs`** — port the same profile: a `HeadDef` slice, a render fn, an entry in `PROFILES`. Keep byte-for-byte identical maths (`b255`, `strobe_byte` helpers exist in both).
3. Add a case to both smoke suites asserting a known param set produces known bytes, and (if the fixture ships in the default project) extend `engine/test/diff.ts`.
4. UI needs nothing: profiles appear in the patch dropdown automatically; the previz renders from `heads[].kind` + `beamDeg`.

The v0.4 roadmap milestone replaces this dance with data-driven GDTF profiles interpreted by one shared implementation — see [ROADMAP.md](../ROADMAP.md).

## Adding a protocol command end-to-end

1. `shared/types.ts` — add the variant to `Command`.
2. `engine/index.ts` — handle it in `handleCommand` (state mutations live in `engine/state.ts`).
3. `core/src/types.rs` — mirror the variant (`rename_all = "camelCase"` handles field names).
4. `core/src/state.rs` — handle it in `handle_command`, returning an `Outcome` if it changed the project.
5. UI — send it via `useStore().send(...)`.
6. Tests: exercise it in both smoke suites; add a parity checkpoint if it affects DMX.

## Testing notes

- `engine/test/diff.ts` boots both engines on side ports (9901/9902) with network output disabled and compares snapshots — extend its command script when you add DMX-affecting features. It needs `cargo build -p light-core` first.
- The Node smoke test binds UDP :6454 for the Art-Net loopback check and skips gracefully if something else (another Art-Net tool) holds the port; same for the Rust suite.
- Effects are deterministic (integrated beat + hashed sample-and-hold), so assertions sample *off* whole beats where waveforms sit at extremes.

## Tauri app

`src-tauri/` is a thin shell: `main.rs` spawns the engine thread and opens the window; the window is just a WS client like any browser. Icons regenerate with `npx tauri icon src-tauri/icons/icon-source.png` (source rendered from `icon.svg`). `npm run app:build` produces an ad-hoc-signed `.app`; distribution signing/notarisation is not set up yet.

## Release checklist

1. `npm test` · `cargo test -p light-core` · `npm run typecheck` · `npm run test:parity` — all green.
2. `npm run build` then `npm run app:build`.
3. Launch the `.app`, fire a column, watch the Art-Net counter and a real node.
4. Tag, push, update `ROADMAP.md` checkboxes.
