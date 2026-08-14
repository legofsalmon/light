#!/usr/bin/env bash
# Set the six Apple secrets the release workflow reads.
#
#   ./scripts/setup-signing-secrets.sh                 # export the cert for you
#   ./scripts/setup-signing-secrets.sh path/to/cert.p12  # use one you exported
#
# With no argument this exports your Developer ID certificate itself, so there
# is no trip through Keychain Access. macOS will show one "security wants to
# export a key" prompt — click Allow and enter your login password. The .p12 is
# wrapped in a random one-shot password the script generates, uses, and throws
# away, and the file is shredded at the end: it carries your private signing key
# and exists only long enough to be encrypted into a GitHub secret.
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
if [ -n "$P12" ]; then
  if [ ! -f "$P12" ]; then
    echo "No such file: $P12" >&2
    echo >&2
    echo "Either pass a .p12 you exported yourself, or run with no argument" >&2
    echo "and this script will export the certificate for you:" >&2
    echo "    $0" >&2
    exit 1
  fi
  read -r -s -p "Password for $P12: " P12_PASS; echo
else
  echo "Exporting: $IDENT"
  echo "macOS will ask permission — click Allow and enter your login password."
  P12=$(mktemp -t light-signing).p12
  CLEANUP_P12=1
  # A random wrapper password nobody needs to remember. It appears in `ps` for
  # the moment security runs (single-user machine, and the file it protects is
  # deleted seconds later), which beats a human password reused elsewhere.
  P12_PASS=$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 40)
  rm -f "$P12"
  security export -t identities -f pkcs12 -P "$P12_PASS" -o "$P12"
  echo "exported ($(wc -c <"$P12" | tr -d ' ') bytes)"
fi

echo
echo "identity : $IDENT"
echo "team     : $TEAM"
echo
read -r -p  "Apple ID email                          : " APPLE_ID_VALUE
read -r -s -p "App-specific password (xxxx-xxxx-xxxx-xxxx): " APP_PASS; echo
[ -n "$APPLE_ID_VALUE" ] || { echo "Apple ID cannot be empty" >&2; exit 1; }
[ -n "$APP_PASS" ]       || { echo "app-specific password cannot be empty" >&2; exit 1; }

REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
echo
echo "setting six secrets on $REPO ..."
base64 -i "$P12"               | gh secret set APPLE_CERTIFICATE
printf '%s' "$P12_PASS"        | gh secret set APPLE_CERTIFICATE_PASSWORD
printf '%s' "$APPLE_ID_VALUE"  | gh secret set APPLE_ID
printf '%s' "$APP_PASS"        | gh secret set APPLE_PASSWORD
printf '%s' "$IDENT"           | gh secret set APPLE_SIGNING_IDENTITY
printf '%s' "$TEAM"            | gh secret set APPLE_TEAM_ID
unset P12_PASS APP_PASS

if [ "$CLEANUP_P12" = "1" ]; then
  rm -P "$P12" 2>/dev/null || rm -f "$P12"
  echo "temporary .p12 shredded"
fi

echo
gh secret list
echo
echo "Done. All six are set — tag a release and CI will sign and notarise it."
