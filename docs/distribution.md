# Distributing LIGHT

What it takes for someone who is not you to download LIGHT and have it just
open. Written 2026-08-14; macOS distribution rules have moved twice in the last
two years, so check the dates before trusting any of it.

## Where the build stands

| | Now | Needed for a clean first launch |
|---|---|---|
| Architecture | universal (arm64 + x86_64) | ✅ done |
| Format | `.dmg` (drag to Applications) + `.zip` | ✅ done |
| Signature | ad-hoc (`Signature=adhoc`, no Team ID) | Developer ID Application certificate |
| Notarisation | none | Apple notary service + stapled ticket |

The build is universal and ships as a DMG, so it runs on any Mac from the last
decade and installs the way people expect. What it cannot do yet is open
without macOS objecting once.

## The honest answer: there is no free path any more

Every workaround that used to let an unsigned Mac app install cleanly has been
closed, and the last one closes this month.

- **Control-click → Open** — removed in macOS Sequoia (15). It is the
  instruction in every old blog post and it no longer does anything. Users must
  go to **System Settings → Privacy & Security → Open Anyway** instead, and
  that button only appears for about an hour after a blocked launch.
- **Homebrew cask** — Homebrew deprecated `--no-quarantine`, and is removing
  **all casks that fail Gatekeeper on 1 September 2026**. Publishing an
  unsigned cask is not a route worth building on.
- **`xattr -dr com.apple.quarantine`** — still works, still fine for you and
  for technical friends, but asking a lighting tech to open Terminal before a
  show is not a distribution strategy.

So: for anything wider than people who trust you personally, LIGHT needs a
**Developer ID Application** certificate and notarisation. That means the
**Apple Developer Program, $99/year**. There is no equivalent-cost alternative;
this is Apple charging rent on distribution outside the App Store.

Worth knowing before you decide: notarisation is *not* App Store review. It is
an automated malware scan, usually a few minutes, with no human judgement about
what the app does and no approval to be refused on taste. It also does not
require the App Store, sandboxing, or a cut of anything.

## If you get the certificate, the pipeline is already wired

`.github/workflows/release.yml` passes six secrets through to the build. They
are empty today, so the bundler falls back to ad-hoc and the output is what you
already have. Set them and the *same workflow* starts producing a notarised,
stapled app — no other change:

| Secret | What it is |
|---|---|
| `APPLE_CERTIFICATE` | base64 of the exported `.p12` Developer ID cert |
| `APPLE_CERTIFICATE_PASSWORD` | the password you set exporting it |
| `APPLE_SIGNING_IDENTITY` | e.g. `Developer ID Application: Your Name (TEAMID)` |
| `APPLE_ID` | the Apple ID that owns the developer account |
| `APPLE_PASSWORD` | an **app-specific password**, not the account password |
| `APPLE_TEAM_ID` | 10-character team id from the developer portal |

`scripts/build-app.sh` switches to hardened-runtime signing with a timestamp
when `APPLE_SIGNING_IDENTITY` is present, which notarisation requires. The
release job then prints the resulting authority chain and runs
`xcrun stapler validate`, so a release that silently fell back to ad-hoc is
visible in the log rather than discovered by a user.

## Why re-signing matters

`build-app.sh` copies the previz binary into the bundle *after* Tauri builds it,
because the previz is a separate crate with its own window. Adding any file to a
signed bundle breaks its seal, and a broken seal is worse than no signature —
Gatekeeper rejects it outright rather than offering the Open Anyway path. The
script always re-signs afterwards. If you change the bundle contents, re-sign.

## Not yet answered

- **Windows / Linux.** Tauri and Bevy both support them and nothing in the
  engine is macOS-specific, but neither is built or tested. Windows has its own
  signing story (an EV certificate for SmartScreen, several hundred a year).
- **Auto-update.** Tauri's updater plugin can keep an installed app current,
  which matters once other people have it and you cannot ask them all to
  re-download. It needs its own signing keypair, separate from Apple's.
- **A crash reporter.** With users you cannot see, a show that dies is a bug
  report you never get.
