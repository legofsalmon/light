#!/usr/bin/env bash
# Set the six Apple secrets the release workflow reads.
#
#   ./scripts/setup-signing-secrets.sh path/to/cert.p12   # normal use
#   ./scripts/setup-signing-secrets.sh --export           # try to export for me
#
# Export the certificate first, in Keychain Access:
#   My Certificates > right-click "Developer ID Application" > Export > .p12,
#   and set any password (you paste it below, then forget it).
#
# --export attempts the same thing via `security export`, but macOS answers
# that with a GUI permission dialog which frequently opens BEHIND the terminal
# or on another Space — the script then appears to hang with nothing on screen.
# It is offered because it works when the dialog is visible, not because it is
# the reliable path. If it sits there, check for a hidden dialog (Mission
# Control) or Ctrl-C and use the Keychain Access route.
#
# You will be asked for two things only:
#   - your Apple ID email
#   - an app-specific password from appleid.apple.com > Sign-In and Security
#     (your normal Apple ID password does NOT work for notarisation)
#
# Both are read with the terminal echo off, so nothing is typed on a command
# line or kept in shell history. gh encrypts locally before sending.
set -euo pipefail

command -v gh >/dev/null || { echo "gh CLI not found — brew install gh" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "not logged in — run: gh auth login" >&2; exit 1; }

IDENT=$(security find-identity -v -p codesigning | grep "Developer ID Application" | head -1 | sed 's/.*"\(.*\)"/\1/' || true)
if [ -z "$IDENT" ]; then
  echo "No 'Developer ID Application' certificate found in your keychain." >&2
  echo "Create one at developer.apple.com > Certificates, then download and" >&2
  echo "double-click it to install before running this again." >&2
  exit 1
fi
TEAM=$(echo "$IDENT" | sed -n 's/.*(\([A-Z0-9]\{10\}\)).*/\1/p')

P12="${1:-}"
CLEANUP_P12=0
# a .p12 sitting in the usual place is almost always the one you meant
DEFAULT_P12="$HOME/Documents/certs/developerIDapplication/Certificates.p12"
if [ -z "$P12" ] && [ -f "$DEFAULT_P12" ]; then
  P12="$DEFAULT_P12"
  echo "using $P12"
fi
if [ -z "$P12" ]; then
  echo "usage: $0 path/to/cert.p12     (or --export to try exporting it here)" >&2
  echo >&2
  echo "Export it in Keychain Access: My Certificates > right-click your" >&2
  echo "\"Developer ID Application\" certificate > Export > .p12, set a password." >&2
  exit 1
elif [ "$P12" != "--export" ]; then
  if [ ! -f "$P12" ]; then
    echo "No such file: $P12" >&2
    echo >&2
    echo "Export it in Keychain Access: My Certificates > right-click your" >&2
    echo "\"Developer ID Application\" certificate > Export > .p12, set a password." >&2
    exit 1
  fi
  IFS= read -r -s -p "Password for $P12: " P12_PASS; echo
  # Verify with `security import` into a throwaway keychain — the exact call CI
  # makes, so a pass here means a pass there.
  #
  # NOT openssl: Keychain Access encrypts .p12 files with RC2-40-CBC, which
  # OpenSSL 3 dropped from its default provider. openssl therefore fails on a
  # perfectly good file AFTER the password has already verified, reporting
  # "unsupported ... RC2-40-CBC" — which reads like a bad password and is not.
  VFY_KC="$(mktemp -d)/verify.keychain-db"
  security create-keychain -p verify "$VFY_KC" >/dev/null 2>&1
  security unlock-keychain -p verify "$VFY_KC" >/dev/null 2>&1
  if ! security import "$P12" -k "$VFY_KC" -P "$P12_PASS" -T /usr/bin/codesign >/dev/null 2>&1; then
    security delete-keychain "$VFY_KC" >/dev/null 2>&1 || true
    echo >&2
    echo "That password does not open $P12." >&2
    echo "Mind any leading or trailing space — paste it rather than retyping." >&2
    echo "Or re-export the certificate from Keychain Access with a fresh one." >&2
    exit 1
  fi
  security delete-keychain "$VFY_KC" >/dev/null 2>&1 || true
  echo "password verified against the certificate"
else
  echo "Exporting: $IDENT"
  echo "macOS will show a permission dialog. It often opens BEHIND this window —"
  echo "if nothing happens within a few seconds, check Mission Control, or press"
  echo "Ctrl-C and export via Keychain Access instead."
  # mktemp creates the file at the name it prints; appending .p12 to the string
  # leaves that one behind and writes somewhere else. Build the name explicitly.
  TMPDIR_P12=$(mktemp -d -t light-signing)
  P12="$TMPDIR_P12/cert.p12"
  CLEANUP_P12=1
  # A random wrapper password nobody needs to remember. It appears in `ps` for
  # the moment security runs (single-user machine, and the file it protects is
  # deleted seconds later), which beats a human password reused elsewhere.
  P12_PASS=$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 40)
  security export -t identities -f pkcs12 -P "$P12_PASS" -o "$P12"
  [ -s "$P12" ] || { echo "export produced nothing — use the Keychain Access route" >&2; exit 1; }
  echo "exported ($(wc -c <"$P12" | tr -d ' ') bytes)"
fi

echo
echo "identity : $IDENT"
echo "team     : $TEAM"
echo
# An App Store Connect API key beats an app-specific password: it is scoped to
# what it can do, revocable by itself, and survives an Apple ID password change.
P8=$(ls "$HOME"/Documents/certs/appleauthkey/AuthKey_*.p8 2>/dev/null | head -1 || true)
USE_KEY=0
if [ -n "$P8" ]; then
  KEY_ID=$(basename "$P8" | sed 's/AuthKey_\(.*\)\.p8/\1/')
  echo "Found App Store Connect key $KEY_ID at $P8"
  IFS= read -r -p "Use it for notarisation instead of an app-specific password? [Y/n] " ANS
  [ "$ANS" = "n" ] || [ "$ANS" = "N" ] || USE_KEY=1
fi

if [ "$USE_KEY" = "1" ]; then
  echo "Issuer ID is on the same App Store Connect page as the key:"
  echo "  Users and Access > Integrations > Keys — shown above the key list."
  IFS= read -r -p "Issuer ID (UUID): " ISSUER
  [ -n "$ISSUER" ] || { echo "issuer id cannot be empty" >&2; exit 1; }
else
  IFS= read -r -p  "Apple ID email                          : " APPLE_ID_VALUE
  IFS= read -r -s -p "App-specific password (xxxx-xxxx-xxxx-xxxx): " APP_PASS; echo
  [ -n "$APPLE_ID_VALUE" ] || { echo "Apple ID cannot be empty" >&2; exit 1; }
  [ -n "$APP_PASS" ]       || { echo "app-specific password cannot be empty" >&2; exit 1; }
fi

REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
echo
echo "setting six secrets on $REPO ..."
base64 -i "$P12"               | gh secret set APPLE_CERTIFICATE
printf '%s' "$P12_PASS"        | gh secret set APPLE_CERTIFICATE_PASSWORD
printf '%s' "$IDENT"           | gh secret set APPLE_SIGNING_IDENTITY
printf '%s' "$TEAM"            | gh secret set APPLE_TEAM_ID
if [ "$USE_KEY" = "1" ]; then
  base64 -i "$P8"              | gh secret set APPLE_API_KEY
  printf '%s' "$KEY_ID"        | gh secret set APPLE_API_KEY_ID
  printf '%s' "$ISSUER"        | gh secret set APPLE_API_ISSUER
else
  printf '%s' "$APPLE_ID_VALUE" | gh secret set APPLE_ID
  printf '%s' "$APP_PASS"       | gh secret set APPLE_PASSWORD
fi
unset P12_PASS APP_PASS

if [ "$CLEANUP_P12" = "1" ]; then
  rm -P "$P12" 2>/dev/null || rm -f "$P12"
  rmdir "$TMPDIR_P12" 2>/dev/null || true
  echo "temporary .p12 shredded"
fi

echo
gh secret list
echo
echo "Done. All six are set — tag a release and CI will sign and notarise it."
