# GDTF Share API and libMVRgdtf — investigation (19 Aug 2026)

Five parallel research angles, then a skeptic pass on the decision-critical
claims: 70 facts gathered, 10 checked, 9 confirmed, 1 corrected, 0 unverifiable.
Claims are sourced; what could not be established is listed explicitly at the end
rather than filled in.

---

## The three calls

1. **GDTF Share — build it, but as "fetch the fixture I'm missing", not "browse the catalogue".** Small, quarantined, desktop-only, off the tick thread. Do it *after* (3). One legal question needs an email before it ships in anything you distribute.
2. **libMVRgdtf — no.** The C++/WASM problem is fatal, but it isn't the reason. The reason is that it doesn't solve the problem you have.
3. **MVR geometry — yes, solvable, pure Rust, and the parsing is the cheap part.** The cost is transport and rendering, not decoding. Your actual file makes this concrete in a way that changes the plan.

---

## 1. GDTF Share

### The feature is smaller than it looks — reframe it

Don't build a catalogue browser. Build "resolve this missing fixture". LIGHT already knows, in two places, exactly which fixture it can't find:

- `core/src/engine.rs:819` — `unknown_profiles`, with the comment "a fixture pointing at a profile that no longer exists renders as nothing at all… so surface it rather than leaving an operator hunting a dead fixture on the truss." Already dimmed in `PatchView.tsx:90,:324` and counted in `TopBar.tsx:265-270`.
- `core/src/mvr.rs:261` — `bundle.warnings.push(format!("{name}: GDTF '{spec}' not in archive — skipped"))`.

And the string you'd search with is already in your hand. Your real MVR's five `<GDTFSpec>` values are `Acme@Lyra@r3006.gdtf`, `Ayrton@Rivale Profile@r3014.gdtf`, `Robe@Robin Spiider@r3045.gdtf`, etc. — manufacturer, fixture, revision. `getList.php` returns `manufacturer`, `fixture`, `revision`, `rid` per entry. That's a near-mechanical match. (I have *not* verified that the `r3014` in the filename equals the integer `rid`; treat that as a lookup to confirm, not a given.)

Framed that way, the UI is a filtered shortlist next to a warning, not a search engine over ~9,365 devices — which matters, because **there is no server-side search**. `getList.php`: "This function does not require any parameters." No filter, no pagination, no detail endpoint. Any browsing UI means pulling and filtering the whole catalogue client-side.

### Cost

The API is three PHP endpoints and it is the easy part. Ranked by actual work:

- **Picker UI** — largest piece, and mostly shrinks to nothing under the reframing above.
- **Credential storage** — new territory. LIGHT has *no* secret storage today. Critically: **the Share password must not go anywhere near the project JSON**, because `shared/types.ts:402` broadcasts `{ type: 'project'; project: Project }` — the whole document — to every connected client, including the LAN tablet on `:9900`. Keychain or nothing.
- **Catalogue cache + guard rails** — see below.
- **Engine changes: zero.** `parse_gdtf(bytes: &[u8])` (`core/src/gdtf.rs:14-22`) opens a zip over an in-memory `Cursor` and reads only `description.xml`. A download response body feeds straight into the existing `importGdtf` command, which already exists in the Rust enum (`core/src/types.rs:518`), the TS union, the Node switch, and `QUEUEABLE` in `ui/src/store.ts:105`. Nothing new on the wire, nothing new in the engine, no parity risk.

**Where the HTTP goes: `src-tauri`, not `light-core`.** `light-core`'s deps are serde, serde_json, tungstenite, midir, dirs, getrandom, zip, roxmltree, rusty_link — no HTTP client, and the whole workspace `Cargo.lock` has no TLS crate at all. Tauri already pulls `reqwest`. Putting TLS into the crate that drives DMX to save a shim is the wrong trade under your own directive. Consequence: this is a desktop-app-only feature; the browser UI at `:5173` and the LAN tablet won't have it. That's acceptable — it's a prep-room feature. *Unverified:* the lock's `reqwest` entry lists no TLS backend, so adding it as a direct `src-tauri` dep with `rustls-tls` will pull new crates. Ten-minute check before you commit to the shape.

### The blockers, in order of severity

**Terms — the real one, and it already applies to you.** The API doc explicitly blesses your use case ("Integration of the GDTF database into the fixture type patching process"). The doc carries no terms of its own; the site T&C are the only governing instrument, and they are narrow. §9: "You may print off one copy, and may download extracts, of any page(s) from our Website **for your personal reference**"; "You **must not modify** the paper or digital copies of any materials you have printed off or downloaded in any way"; "You must not use any part of the materials on our Website **for commercial purposes without obtaining a license** to do so from us or our licensors"; "Our status (and that of any identified contributors) as the authors of material on our Website must always be acknowledged." German law, exclusive German jurisdiction (§15).

LIGHT compiles a `.gdtf` into a `CompiledProfile` and embeds it in a project JSON that travels with the show. On the plain wording that's transformation plus redistribution, and you're a working LD, i.e. commercial. **This is true today, by hand, without the feature.** The API integration doesn't create the exposure; it raises the volume. So send the email now — the T&C names the route: "please address your request to info@gdtf-share.com" — because the answer takes weeks and it gates shipping, not building.

Two things sharpen the position while you wait, both cheap:
- `CompiledProfile` (`core/src/cprofile.rs:108-119`) has no creator/copyright field. Add one. The Share list already returns `creator` and `uploader`, and `description.xml` carries the same. That converts "no attribution" into "attribution present", which is the one condition you can unilaterally satisfy.
- Note §1: rights stay with "the respective content owner". VPLT may not be able to grant what you're asking for, because it doesn't own the definitions. Expect a partial answer.

**Auth.** Mandatory per-user account — "The GDTF Share and the API are not accessible to users who do not have a registered account", and explicitly addressed to integrators: "If you are not the end user, you should direct your customers… to create an account." So no shipped app credential, no server-side proxy. I confirmed the gate empirically with read-only GETs (no account created, no login attempted): both `getList.php` and `downloadFile.php?rid=1` return `HTTP/1.1 401` with body `{"result":false,"error":"Unauthorized."}` and a fresh `PHPSESSID`. Note the 401 body is JSON served as `Content-Type: text/html` — parse on status, not content-type. Session is a cookie with a 2-hour idle timeout, no token, no refresh, no locally-checkable expiry. You discover expiry by getting a 401. Practically: store the password in Keychain and re-login on 401, or re-prompt every two hours.

**Silent failure — design around it.** On 23 Oct 2025 `getList.php` returned `{ "result" : true , "list" :[]}` — success-shaped, empty. Reproduced across two accounts and both URLSession and Safari. Robe's Petr Vanek, 24 Oct: "While the server was running correctly, for some reason, the buffer containing the data got empty. **We will add a test for this in the future.**" — i.e. there was no such test. Fixed same day. ([forum thread](https://gdtf-share.com/forum/index.php?/topic/1705-gdtf-share-api-returns-empty-fixture-list/)) Nobody reported client data loss; that inference is mine, not theirs. But the rule follows: **the cache is additive-only. Never delete a local profile because the remote list lacks it. Reject a list that is empty or materially smaller than the last known good.**

**Offline at a venue.** Two halves, and the good half is already true: once a fixture is patched, its `CompiledProfile` lives in the project document (`core/src/types.rs:375-377`, "travel with the project"), so the show runs with no network. The bad half: never fetch on startup, never on the tick path, manual refresh only. You will be on a phone hotspot at some point.

**Integrity.** No checksum anywhere — not in `getList`, and I never saw a success response's headers, so `Content-Length`/`ETag`/`Content-Disposition` on download are unverified. Your validator is free: parse the download with `parse_gdtf` before writing it to the library. A truncated zip fails to open, and parse costs 28.8 µs (`docs/benchmarks.md:97`).

**Cache validation is unspecified.** The intro promises "Get List: Revision listing with a simple versioning hash." No hash field exists anywhere in the document. The sample envelope instead carries a top-level `"timestamp":1672531200` which the field table never defines. Don't build cache-invalidation logic on either until you've watched real responses.

**Downloaded files have no home.** `ROADMAP.md:81` says "Library lives in `~/Library/Application Support/LIGHT/fixtures/`." I grepped `core/src`, `engine`, `ui/src`, `src-tauri/src`: nothing. The only directory resolver is `persist::project_dir()`. That directory is new code, and it needs doing twice (the Node engine has its own `DIR` at `engine/persist.ts:6`).

**Not documented, deliberately not probed:** rate limits, quotas, concurrency caps. The doc has none, the T&C has no automated-access clause, and `gdtf-share.com/robots.txt` 404s. Absent documentation is not permission — treat unknown, not absent. There is also no API versioning of any kind: bare `.php` paths, no version param, no version header, no changelog, no stability marking. The `version` field in the payload is the fixture's GDTF spec version, not the API's. A breaking change lands on you silently at runtime.

---

## 2. libMVRgdtf

**No.** Reasons ordered by how robust they are — the decision survives losing any one of them.

**It doesn't give you geometry.** This is the one that matters, because geometry is why you asked. `IGdtfModel` exposes raw file access only: `virtual VCOMError VCOM_CALLTYPE GetBuffer3DS(void** bufferToCopy, size_t& length) = 0;` (`IMediaRessourceVectorInterface.h:723-729`), plus `GetGeometryFile_3DS_FullPath`. The MVR read side exposes attached files as filesystem paths via `GetFileFullPath`. `CGdtfModel.cpp:148-159` just forwards the buffer — no triangle or vertex decoding anywhere in the public surface. You get the scene graph and a byte blob. **You would still write a 3DS decoder from scratch.** Everything below is on top of that.

**It is destructive on your filesystem.** `SceneDataExchange`'s constructor: `fWorkingFolder->Set(EFolderSpecifier::kSpotlightFolder, true, "MVR_Export"); … if (exists) { fWorkingFolder->DeleteOnDisk(); } fWorkingFolder->CreateOnDisk();` (`SceneDataExchange.cpp:2856-2878`) — recursive delete on **every** construction, read or write. `FilingWrapper.cpp:364-412` resolves that on macOS to `~/Library/Application Support/mvrexchange/MVR_Export`. And `OpenForRead` unzips every non-XML zip member to disk (`SceneDataExchange.cpp:3737-3765`). For your file that's 200+ files written per import, into a directory it wipes each time, and which Vectorworks may also use. There is no in-memory read path. *I did not trace whether the deletion is guarded further up the call chain.*

**It links a network server by default.** `CMakeLists.txt`: `set(BUILD_MVR_XCHANGE TRUE CACHE BOOL …)`, plus `add_subdirectory(mdns_cpp)`. That's a TCP server and an mDNS responder in your binary — `mvrxchange_server.cpp`, `mvrxchange_client.cpp`, `mvrxchange_session.cpp`. Switchable off, but on by default, and you have a rig on the network. Under your standing directive that's disqualifying on its own.

**Rust can't call it.** Exactly one `extern "C"` symbol in the entire library: `VWQueryInterface` (`ModuleMain.cpp:95`). Everything else is COM-style pure-virtual interfaces with manual `AddRef`/`Release`, and one public method takes `const std::function<void(bool&)>&` (`IMediaRessourceVectorInterface.h:474`). You would hand-write a C++ shim flattening hundreds of virtual methods to a C ABI — plausibly larger than the 1,230 lines of `gdtf.rs` + `mvr.rs` + `cprofile.rs` it replaces (I counted: 426 + 314 + 490).

**Is the C++/WASM problem fatal? Yes — but don't lean on it.** `profile-wasm/src/lib.rs:36` already exports `parse_mvr` to WASM. The browser path is not optional; it's how the Node engine and UI stay parity-locked. libMVRgdtf has zero WASM support in its tree, and an API built entirely on `OpenForRead(fullPath)` and `Get…_FullPath()` cannot run where there is no disk. So adopting it means the MVR parser exists twice — C++ natively, Rust in the browser — which is the exact regression the project forbids. **But** the specific mechanical claim (that Emscripten-produced object code can't link into a `wasm32-unknown-unknown` wasm-bindgen cdylib) was reasoned from build configs, not verified against a document. It doesn't need to hold. Reasons 1–4 stand without it.

**Licence, for completeness.** Not Apache-2.0 despite reading like it — "My Virtual Rig (MVR)SDK License, Version 1.0, June 2020", GitHub classifies it `NOASSERTION`/"Other". Permissive enough to ship in a closed signed app (§2 grants Object-form distribution, no copyleft), but with two riders — "Derivative Works are required to adhere to DIN SPEC 15800" (a paid standard) and "The GDTF file format, contained within the MVR SDK, cannot be modified" — plus a mandatory product-documentation acknowledgement, and an internal contradiction: the closing block grants a zlib-style right to "alter it and redistribute it freely" that sits against §2. Moot given the no, but noted so it doesn't get revisited casually.

**Notarisation is not a problem** and I want to say so rather than invent one: `light.entitlements` contains only `com.apple.security.cs.allow-jit`, you're not sandboxed, and a static `.a` linked into the Rust binary adds no new Mach-O to sign. The real build cost is that there are no prebuilt binaries anywhere (all recent releases have empty asset lists; the npm package 404s; GitHub Packages 401s), so you compile Xerces-C and Boost from source — and the macOS CI action passes `-arch x86_64` to both cmake invocations despite step names claiming arm/x64, while `scripts/build-app.sh:16-20` ships universal.

---

## 3. MVR geometry

This is the one worth doing, and I profiled your actual file to cost it. Read-only, extracted `GeneralSceneDescription.xml` (3,611,583 bytes) from `ATN 26 - Mainstage.mvr` (9,602,632 bytes, 206 zip entries).

### What's actually in your file

| | count |
|---|---|
| `<SceneObject>` | 12,810 |
| …of those, with a **non-empty `name`** | **0** |
| …of those, with an **empty `<Geometries/>`** | 5,202 (41%) |
| `<Geometry3D fileName=…>` references | 8,329 |
| **distinct `.3ds` files** | **200** |
| most-reused mesh | 720 instances |
| `<Truss>` | 14 (via `<Symbol>` → 1 `<Symdef>`, "GPM Rectangular section, 3m (B4401)") |
| `<Fixture>` | 129 |
| `<Layer>` | 25 |
| `<GroupObject>` / `<ChildList>` | 2,095 / 2,121 |

**This kills the obvious cheap first step.** My instinct was "draw bounding boxes from the model dimensions first, meshes later". Your file makes that impossible: every SceneObject is `name=""` with a `<Matrix>` and a filename and nothing else — no dimensions, no label, no primitive fallback. A no-mesh first pass gives you 7,608 unlabelled dots. **Geometry here is all-or-nothing: you decode the `.3ds` or you draw nothing.**

The good news in the same numbers: 8,329 references resolve to **200** unique meshes. That's a small asset set with ~40× average reuse, which means GPU instancing, 200 draw calls, and a bounded memory cost. Measured in this investigation across all 200 meshes: 196,490 vertices, 387,660 faces, ~5.5 MB of input.

### What LIGHT does with this today

`core/src/mvr.rs:199-233` — `walk()` matches exactly three tags: `"Fixture"`, `"GroupObject" | "ChildList"`, and `_ => {}`. So it correctly imports your 129 fixtures and 25 layers, and **silently discards 12,810 SceneObjects, 14 Trusses, and the entire `<AUXData>`/`<Symdef>` section**. It never even looks at `<Geometry3D>`. The extension is additive arms on an existing match, reusing the `Mat43` compose you already have.

### The four pieces, honestly costed

**(a) Scene tree — smallest, highest confidence.** Add `SceneObject`, `Truss`, `Support`, `VideoScreen`, `Projector`, `FocusPoint`, a `Symdef` uuid table, and `Symbol`/`Geometry3D` resolution to `walk()`. Same roxmltree, same file, same transform maths. Emit a manifest of ~8,343 `(world matrix, mesh name)` pairs. Skip the 5,202 empty ones rather than materialising 12,810 entities for 7,608 that draw.

**(b) 3DS decode — one dependency, and it's young.** `ds3` 0.1.0 (MIT/Apache-2.0, `no_std`+alloc, `thiserror` its only hard dep) decoded **200/200** of your meshes with zero failures in 2.59 ms, and compiles to a 23,191-byte wasm module. It is also a single release, 26 downloads, one author, no commits since publication, and its README says "All other chunks are silently skipped". `asset-importer-rs` lists 3DS as *Planned*; the only other option is `russimp`, which is bindings to C++ assimp — the thing you're avoiding.

That risk is acceptable **because meshes are display-only**: a decode failure means no picture, not no light. So: vendor `ds3` into the repo rather than tracking a crate that may be abandoned, wrap every per-mesh parse so failure degrades to a placeholder box, and never let it panic. If the dependency still bothers you, 3DS is a simple chunked binary format and ds3 covers ~11 chunk types — writing your own is a weekend, not a project. **Unverified: nobody has checked the decoded geometry is *correct*, only that it parses.** The 3DS `MESH_MATRIX` / world-space-vertices ambiguity is untested. Budget a round of "why is that truss upside down".

**(c) Transport — the part nobody costed, and the real cost.** Verified today: `parse_mvr` is a WASM export (`profile-wasm/src/lib.rs:36`), `MvrBundle` crosses that boundary as `serde_json::to_string`, `shared/types.ts:414` mirrors it, and the project document is broadcast whole (`shared/types.ts:402`; `core/src/server.rs:40-42` — "the SAME path carries the authoritative whole-project"). `projects/default.project.json` is 48,164 bytes today.

Mesh data cannot ride either path. Rough arithmetic (estimate, not measured): 196,490 verts + 387,660 faces is ~7 MB as packed binary, ~9 MB base64, and on the order of 10–20 MB as JSON numbers. The manifest alone (~8,343 entries × 12 floats + filename) is ~1.4 MB of JSON. Putting any of that in `Project` means re-broadcasting it to every client on every change, including the tablet.

**So: geometry gets its own path.** A binary asset store keyed by mesh name, written beside the project, fetched on demand by whichever previz wants it. Not in `MvrBundle`, not in `Project`, not in the broadcast. That's the design decision this whole question turns on, and it's plumbing work, not parsing work.

**(d) Rendering — two surfaces, neither has ever loaded a mesh.** `previz/` is a native Bevy 0.16 window; 387k triangles instanced is nothing to Bevy. `ui/src/components/Previz3D.tsx` is three.js 0.179, 572 lines, and *every* piece of geometry in it is procedural — `BoxGeometry`, `CylinderGeometry`, `CapsuleGeometry`, `TorusGeometry`. There is no loader of any kind. Adding a `BufferGeometry` + `InstancedMesh` path isn't hard, but 200 meshes across 7,608 instances in a browser tab that is also a live show surface needs a budget and a kill switch. **Completely unmeasured.**

### One thing to fix while you're in there

Imports run **on the DMX tick thread** — `core/src/engine.rs:226-250` drains control messages between ticks and `:601` calls `handle_command`. `REVIEW-v1.2.2.md:268` already lists "synchronous GDTF/MVR import on the engine thread" as accepted/unfixed, against `ROADMAP.md:20-21`: "Nothing heavy on the tick path… no filesystem, network-blocking, or unbounded work. Ever."

Parsing your MVR is not cheap. Anchor: a third-party Rust MVR reader took **74 ms** on this exact file (measured), before any GDTF parsing. Add the zip inflate of 9.6 MB and five `parse_gdtf` calls and today's import plausibly stalls output for 100 ms+ — four or more dropped frames at 40 Hz. That's an estimate, not a measurement; I did not run LIGHT. Adding scene-tree walking and mesh decoding makes an existing wart worse. If you're opening `mvr.rs` anyway, that's the moment to move import off the tick thread — parse on a worker, apply the finished bundle as one cheap command. It's the same argument that keeps the Share fetch out of `light-core`, and it's the reliability-first move.

### Order of work

1. Move MVR import off the tick thread.
2. Extend `walk()` for the full scene tree; emit a manifest, no meshes. Verify against the counts above (8,343 refs, 200 files, 5,202 empties).
3. Binary asset side-channel.
4. `ds3`, vendored and sandboxed; native Bevy previz first.
5. Browser `InstancedMesh` path, with a budget and a switch.
6. Then Share.

**Not recommended:** adopting `rigger` (proved the file parses, but `Mvr::from_archive` returns `Self` not `Result`, panicked on an unwrap against your own `core/tests/data/synthetic.mvr`, README lists "Implement error handling" and "Local to world transforms" as unchecked, self-described "early development and incomplete"). Use it as a reference implementation, not a dependency. Also not recommended: swapping `gdtf.rs` for the `gdtf` crate — it's genuinely good (98.5% on a ~3,700-file Share corpus per a third-party scan I did not reproduce, active, MIT), but it's 1.26 MB of wasm against your entire 434 KB `profile-wasm` bundle, it rejects your own `synthetic.gdtf` over a `@Position` the spec says defaults to identity, and you already have a working parser at 28.8 µs. Revisit only if you later want fixture-body geometry — your two real `.gdtf` files ship no models at all.

**Free finding:** that rigger panic is arguably your bug. MVR spec Table 26 lists `UnitNumber` as mandatory on `Fixture`; `core/tests/data/synthetic.mvr` omits it. Your lenient roxmltree parsers accept test data that any strict reader rejects. Worth fixing regardless of what you adopt.

---

## 4. What could not be established

**Hard gaps on Share** — every one of these needs an account, which was not created:

- **Size and latency of a `getList.php` response.** The single biggest design unknown. July 2026 report: 9,365 devices, 1,176 brands — and `getList` returns *revisions*, so more than that. (Note: the widely-cited "7000 files" milestone from May 2025 is revision-*inclusive* and 15 months stale; the device-only figure for April 2025 was 5,599. Plan against ~9,365 devices plus revisions, not 7,000.) Multi-megabyte JSON per refresh is likely. Unverified.
- **Conditional requests / delta sync.** No `ETag`, `If-Modified-Since` or incremental mechanism documented. If absent, every refresh is a full catalogue pull.
- **Whether the envelope `timestamp` is a usable cache validator** — the field is not defined anywhere in the document, so its semantics are genuinely unspecified rather than merely unknown to me.
- **Download success headers** — `Content-Disposition`, `Content-Length`, `ETag`, any checksum. Only ever saw the 401.
- **Rate limits.** Deliberately not probed; that would mean hammering a live third-party service without an account.
- **Whether a broader per-file licence exists behind the login.** Fixture detail pages and the manufacturer upload agreement are account-gated. It is entirely possible a more permissive grant lives there and changes the conclusion in §1. *This is the largest single gap in the legal picture.* Registration can't be automated anyway — the signup page carries a CAPTCHA and a consent checkbox.
- **Whether `gdtf-share.com` sends CORS headers.** Would decide whether a browser-origin fetch is even possible. Unverified — and moot under the src-tauri design, which is part of why I prefer it.
- **The JSON samples in the doc use curly quotes and omit commas** — almost certainly a Word-to-Markdown artifact, but the true wire format is unobserved. Treat field *names* as authoritative-ish and verify against a real response before relying on them.

**To close these:** create a Share account (free), run `curl -c session.txt -X POST …/login.php`, then one `curl -v -b session.txt …/getList.php -o list.json`. That single call answers size, latency, headers, the timestamp question, and the real wire format. Ten minutes. It requires you to accept their terms, which is why I didn't do it.

**Gaps on geometry:**

- **Is `ds3`'s output geometrically correct?** Only that it parses is established. Closing it means rendering one known mesh and looking at it — cheap, and it's the first thing to do in step 4.
- **Can the three.js previz carry 200 instanced meshes / 388k triangles alongside a live show?** Unmeasured. Prototype before committing the browser path.
- **Whether `zip 8.x` (needed by `gdtf`/`rigger`) can coexist with `light-core`'s `zip 2`** — untested. Irrelevant if you take neither crate, which is the recommendation.
- **What today's MVR import actually costs on the tick thread.** The 74 ms figure is a third-party library on your file, not LIGHT. One `Instant::now()` either side of `parse_mvr` in a test settles it.

**Gaps on libMVRgdtf** — none of which would change the answer:

- Not built, linked, or run; every build-cost claim is inference from CMake and CI files.
- I did not exhaustively prove no mesh decoding exists anywhere in the 375-file tree — I read the public headers, `CGdtfModel.cpp`, `CMediaRessourceVectorImpl.cpp` and `SceneDataExchange.cpp`. GitHub's code-search API needs auth.
- Whether the `mvrexchange/MVR_Export` deletion is guarded upstream, or whether Vectorworks itself uses that path.
- The Emscripten↔wasm-bindgen linkage mechanics, as flagged above.

**Legal, honestly:** whether German law would enforce §9 against a downloader here — including EU database right and any exhaustion analogue — is a qualified lawyer's question under the law §15 selects. I make no assessment. My read is only that the *API integration* is clearly sanctioned and the *embed-compiled-profiles-in-a-travelling-project-file* step is not clearly covered, and that the gap is worth one email before it ships in anything distributed.