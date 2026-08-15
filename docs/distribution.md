# Distributing LIGHT

What it takes for someone who is not you to download LIGHT and have it just
open. Written 2026-08-14; macOS distribution rules have moved twice in the last
two years, so check the dates before trusting any of it.

## Where the build stands

| | Status |
|---|---|
| Architecture | universal (arm64 + x86_64) ✅ |
| Format | `.dmg` (drag to Applications) + `.zip` ✅ |
| Signature | Developer ID Application, hardened runtime ✅ |
| Notarisation | accepted by Apple, ticket stapled to both the app and the dmg ✅ |

**As of v1.1.0 this is done.** LIGHT opens on a double-click: no Gatekeeper
detour, no System Settings step. macOS still shows the standard "downloaded
from the internet" confirmation once, which every app gets, and asks for local
network permission on first launch — that one matters, because Art-Net and
sACN are how LIGHT reaches a rig.

Stapling is what makes a first launch work offline: the ticket travels inside
the file rather than being fetched from Apple. Verify a build with
`xcrun stapler validate LIGHT.dmg`.

The rest of this document is kept because it explains why the alternatives do
not work, which matters if the certificate ever lapses.

## Why there was no free alternative

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

So there was no way round a **Developer ID Application** certificate and
notarisation, which means the **Apple Developer Program, $99/year**. That is
now in place and wired into the release workflow.

Worth knowing before you decide: notarisation is *not* App Store review. It is
an automated malware scan, usually a few minutes, with no human judgement about
what the app does and no approval to be refused on taste. It also does not
require the App Store, sandboxing, or a cut of anything.

## How the signing pipeline works

`.github/workflows/release.yml` reads these from repository secrets. Set them
with `./scripts/setup-signing-secrets.sh`, which derives what it can from the
keychain and verifies the certificate password before uploading anything.

Signing — always required:

| Secret | What it is |
|---|---|
| `APPLE_CERTIFICATE` | base64 of the exported `.p12` Developer ID cert |
| `APPLE_CERTIFICATE_PASSWORD` | the password set when exporting it |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: Your Name (TEAMID)` |
| `APPLE_TEAM_ID` | 10-character team id |

Notarising — an App Store Connect API key is preferred, because it is scoped,
revocable on its own, and survives an Apple ID password change:

| Secret | What it is |
|---|---|
| `APPLE_API_KEY` | base64 of the `AuthKey_XXXX.p8` |
| `APPLE_API_KEY_ID` | the `XXXX` from that filename |
| `APPLE_API_ISSUER` | issuer UUID, App Store Connect > Users and Access > Integrations > Keys |

Or the older pair, used only when no API key is set: `APPLE_ID` and
`APPLE_PASSWORD` (an **app-specific** password, not the account one).

`scripts/build-app.sh` switches to hardened-runtime signing with a timestamp
when `APPLE_SIGNING_IDENTITY` is present, which notarisation requires. The
release job then prints the resulting authority chain and runs
`xcrun stapler validate`, so a release that silently fell back to ad-hoc is
visible in the log rather than discovered by a user.

Two things that cost a night each, worth not rediscovering:

- **The keychain has to outlive the preflight.** Tauri imports the certificate
  into a keychain of its own and signs from there, but `build-app.sh` re-signs
  afterwards and that call needs the identity on the *search list*. The workflow
  creates one keychain, unlocked with auto-lock off and a key partition list
  set, and leaves it up for the whole build.
- **`secrets` is not a valid context in a step-level `if:`.** Using it is a
  startup failure: GitHub creates a run with no jobs, marks it failed, and
  schedules nothing — so the workflow silently stops running while the YAML
  still parses fine locally. Test the value inside the shell instead.

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
