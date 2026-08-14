#!/usr/bin/env bash
# One-shot setup of the six Apple secrets the release workflow reads.
#
#   ./scripts/setup-signing-secrets.sh ~/Desktop/light-signing.p12
#
# Two of the six are derived from your keychain automatically. The rest are
# prompted for with the terminal echo off, so no password is typed on a command
# line, stored in shell history, or passed through anything but gh — which
# encrypts locally before sending. The .p12 is offered for secure deletion at
# the end, because it contains your private signing key.
#
# To get the .p12: Keychain Access > My Certificates > right-click your
# "Developer ID Application" certificate > Export > .p12, and set a password.
# (Exporting via the GUI is deliberate — it is the one step where you pick
# exactly which identity leaves the keychain.)
#
# App-specific password: appleid.apple.com > Sign-In and Security >
# App-Specific Passwords. Your normal Apple ID password will NOT work for
# notarisation.
set -euo pipefail

P12="${1:-}"
if [ -z "$P12" ] || [ ! -f "$P12" ]; then
  echo "usage: $0 /path/to/exported-cert.p12" >&2
  exit 1
fi

command -v gh >/dev/null || { echo "gh CLI not found" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "run 'gh auth login' first" >&2; exit 1; }

# --- derived, not secret: both appear in any signature this cert produces ---
IDENT=$(security find-identity -v -p codesigning | grep "Developer ID Application" | head -1 | sed 's/.*"\(.*\)"/\1/')
TEAM=$(echo "$IDENT" | sed -n 's/.*(\([A-Z0-9]\{10\}\)).*/\1/p')
[ -n "$IDENT" ] || { echo "no Developer ID Application identity in the keychain" >&2; exit 1; }
echo "identity : $IDENT"
echo "team     : $TEAM"

read -r -p "Apple ID email: " APPLE_ID_VALUE
read -r -s -p "Password you set when exporting the .p12: " P12_PASS; echo
read -r -s -p "App-specific password (xxxx-xxxx-xxxx-xxxx): " APP_PASS; echo

echo
echo "setting secrets on $(gh repo view --json nameWithOwner -q .nameWithOwner)..."
base64 -i "$P12" | gh secret set APPLE_CERTIFICATE
printf '%s' "$P12_PASS"        | gh secret set APPLE_CERTIFICATE_PASSWORD
printf '%s' "$APPLE_ID_VALUE"  | gh secret set APPLE_ID
printf '%s' "$APP_PASS"        | gh secret set APPLE_PASSWORD
printf '%s' "$IDENT"           | gh secret set APPLE_SIGNING_IDENTITY
printf '%s' "$TEAM"            | gh secret set APPLE_TEAM_ID
unset P12_PASS APP_PASS

echo
gh secret list
echo
read -r -p "Securely delete $P12 now? [y/N] " DEL
if [ "$DEL" = "y" ] || [ "$DEL" = "Y" ]; then
  # rm -P overwrites before unlinking; harmless no-op on APFS but costs nothing
  rm -P "$P12" 2>/dev/null || rm -f "$P12"
  echo "deleted."
else
  echo "left in place — it holds your private key, so do not leave it on Desktop."
fi
