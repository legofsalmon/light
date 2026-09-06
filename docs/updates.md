# Updates

LIGHT checks whether a newer build exists and tells you. It does not install
anything. That split is the whole design, and the reasoning is the same one that
governs everything else here: replacing the app stops the output, and nothing
gets to stop the output without a person deciding to.

## What happens

One check, a minute after launch, once per run. Never on the startup path, never
on the tick. It reads GitHub's Releases API for this repo, picks the best release
this copy should be offered, and sets a flag the Output tab reads. A failed check
is a missing banner, not a message — being on a phone hotspot in a car park is
not a fault worth reporting.

Turn it off with `LIGHT_NO_UPDATE_CHECK=1`.

## No manifest, no host, no key

There is no update server and nothing to publish beside the release:

- **The manifest is GitHub's Releases API.** `api.github.com/repos/legofsalmon/light/releases`.
  Nothing to generate, nothing to deploy, nothing that can drift from the build.
- **The payload already existed.** `release.yml` runs `ditto -c -k --keepParent`
  over the finished bundle — after the previz graft, the re-sign, notarisation
  and stapling — and publishes it as `LIGHT.zip`. Every release back to v1.0.0
  has one. No new build step was added; a test asserts every release carries it.
- **The trust anchor is Apple's, not a key of ours.** See below.

## Channels

A stable copy is only offered stable releases. A copy already running a
prerelease is offered prereleases too.

This matters more than it sounds. `release.yml` marks any hyphenated tag as a
GitHub prerelease, and GitHub excludes prereleases from `/releases/latest` — so
an updater reading `/latest`, which is what vizz does, is invisible to exactly
the people who were handed a beta and asked to test it. LIGHT reads the release
*list* and filters by channel instead.

Version comparison is real semver precedence, so
`1.3.0-beta.2 < 1.3.0-rc.1 < 1.3.0 < 1.3.1`. vizz truncates the prerelease and
would strand a beta tester until the next patch release.

## The trust model, when installing lands

Not minisign, not a hash — the anchor is that the download is the same
Developer-ID-signed, Apple-notarised bundle this copy is:

1. `codesign --verify --strict` on the extracted bundle — the seal is intact.
2. The same, on `Contents/MacOS/light-previz` — the grafted binary specifically,
   because that is the file whose presence broke the seal in the first place.
3. `codesign --verify -R '=anchor apple generic and certificate leaf[subject.OU] = "<team>"'`,
   where `<team>` is read at runtime from the *running* copy. The `anchor apple
   generic` clause is load-bearing: without it a self-signed certificate can
   assert any team OU it likes.
4. `xcrun stapler validate` — proves Apple notarised *this exact build*. Works
   offline, and unlike `spctl` it is not disabled by `spctl --master-disable`.
5. `CFBundleIdentifier` matches, or the swap silently costs the operator their
   Keychain items and their Local Network permission.
6. The version is the one that was offered.
7. **This Mac can run it.** Both the app binary and the grafted previz binary
   must carry a Mach-O slice this machine executes.

Note 4 versus a signing key of our own: minisign would prove we signed it.
Stapling proves Apple scanned it and the ticket travelled inside the file.

### Why check 7 exists

An arm64 bundle does not run on an Intel Mac at all. Rosetta translates x86_64
to arm64 and never the other way. Checks 1 to 6 all pass for a perfectly good
build of the wrong architecture, so without check 7 the first arm64-only stable
release would have been offered to every Intel Mac still on the last universal
build, verified, swapped in, and never opened again. The documented rollback
covers a failed `mv`, not a failed launch.

The slices are read out of the Mach-O headers directly rather than by running
`lipo`, which is an Xcode Command Line Tools shim: on a Mac without those
installed it pops the "install developer tools" panel, and firing that during
an update is the class of surprise this whole path exists to avoid.

Which architecture this Mac *is* comes from `sysctl.proc_translated`, not from
the build LIGHT happens to be. On a universal build those are different
questions: an x86_64 slice running under Rosetta is an Apple Silicon Mac, and
reading the build would call it Intel and refuse a build that would have run
perfectly. Rosetta is only ever credited when the running process proves it is
there; a native arm64 build cannot cheaply know whether Rosetta was installed,
so an x86_64-only download is refused rather than gambled on. LIGHT does not
ship one.

A refusal names both architectures and points at the releases page, and it
lands before anything is replaced — the download is staged, not installed.

## Installing

Nothing downloads until you press download, and nothing installs until you press
install twice. The check is the only automatic part of this.

The sequence, and every step of it exists for a reason:

```
download → unpack (ditto) → verify → write the swap script → ARM → quit normally
   → engine flushes the project → script waits for the pid AND the port
   → mv aside → mv in → reopen
```

**The bundle is never modified in place.** Adding a file to a signed bundle
breaks its seal, and a broken seal is worse than no signature — Gatekeeper
rejects outright rather than offering Open Anyway. The only safe operation is a
whole-bundle swap by a process that is not inside the bundle, which is why a
detached `/bin/sh` script does it after LIGHT has gone.

**The swap is spawned from `ExitRequested`, after the flush.** Not from the
install command, and never through `app.restart()` or `process::exit` — both
skip the shutdown that writes the project. An update that ate the last hour of
patching would be worse than whatever it fixed.

**It refuses rather than queues.** With the rig lit — any head above zero within
the last 30 seconds — or with more than one client connected, install refuses
and says why. "It will install when you stop" is a promise to do something
disruptive at a moment nobody chose. The 30 seconds is so a blackout between
songs does not read as "the room is empty".

**The previz child is killed on shutdown.** It reconnects forever and never
exits on disconnect, so a copy left running across a swap would silently
reattach to the *new* engine speaking the *old* protocol.

**It waits for the port, not just the pid.** `resolve_port` pops a blocking
dialog if `:9900` is still held, which on relaunch would be the worst possible
moment for one.

**Rollback.** `mv` aside, `mv` in, and if the second fails the first is undone.
The window where neither is in place is two same-volume renames wide. If the
staging directory and the app are on different volumes — a rig running LIGHT
from an external SSD — `mv` would degrade to copy-then-unlink, which is neither
atomic nor safe to interrupt, so the install refuses and points at the manual
download instead of shipping an untested path.

Three tests run the real script through `sh` with `open`, `lsof` and `xattr`
stubbed: the happy path, the rollback, and a target path containing a space, a
quote and a semicolon.

## What is deliberately not here

- **No background download and no install-on-quit.** Both are ways for an update
  to happen at a time nobody picked.
- **No modal, ever.** `ask()` shells to `osascript` and blocks the calling
  thread until a human clicks — it already needed a 10 s watchdog elsewhere. The
  updater is a panel and at most a status dot.
- **No install from a tablet.** The panel is hidden without a Tauri bridge, the
  same way the licence panel is. Pressing install from a phone would quit the
  machine running the show from a device that is not it.
