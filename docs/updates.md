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

Note 4 versus a signing key of our own: minisign would prove we signed it.
Stapling proves Apple scanned it and the ticket travelled inside the file.

## Why it does not install itself

The bundle cannot be modified in place. Adding a file to a signed bundle breaks
its seal, and a broken seal is worse than no signature — Gatekeeper rejects
outright rather than offering the Open Anyway path. The only safe operation is a
whole-bundle swap by a process outside the bundle, after the app has quit and
flushed.

That is buildable, and the design is written down. What it needs first is a
liveness refusal in the engine (never swap with the rig lit), reaping the previz
child on shutdown (it reconnects forever and would silently attach to the new
engine), and the swap spawned from `ExitRequested` *after* the project flush —
never `app.restart()`, which skips it. Until those exist, the honest thing is a
link to the download.
