#!/usr/bin/env bash
# Build the macOS app bundle.
#
# Universal by default (Apple Silicon + Intel) so a download works on any Mac
# from the last decade — an arm64-only build simply will not launch on Intel,
# with no useful error.
#
# Signing: Tauri signs with a Developer ID and notarises automatically when
# APPLE_SIGNING_IDENTITY / APPLE_ID / APPLE_PASSWORD / APPLE_TEAM_ID are set.
# With none of them it falls back to an ad-hoc signature, which still runs but
# makes macOS ask once via System Settings > Privacy & Security. Either way the
# previz binary we graft in afterwards must be re-signed, or the bundle's seal
# is broken and Gatekeeper rejects it outright.
set -euo pipefail

TARGET="${LIGHT_TARGET:-universal-apple-darwin}"
BUNDLE="target/${TARGET}/release/bundle/macos/LIGHT.app"

case "$TARGET" in
  universal-apple-darwin) ARCHES=(aarch64-apple-darwin x86_64-apple-darwin) ;;
  *)                      ARCHES=("$TARGET") ;;
esac

echo "==> previz for: ${ARCHES[*]}"
for a in "${ARCHES[@]}"; do
  cargo build --release --target "$a" -p light-previz
done

echo "==> tauri build ($TARGET)"
# Deliberately hide the notarisation credentials from Tauri: it would notarise
# the bundle it just produced, and we then graft the previz binary in and
# re-sign, which invalidates that ticket. Notarising happens below, after the
# bundle stops changing. Signing credentials stay visible so the nested
# binaries Tauri signs carry the right identity.
env -u APPLE_ID -u APPLE_PASSWORD -u APPLE_TEAM_ID npx tauri build --target "$TARGET"

echo "==> grafting the previz binary into the bundle"
if [ "${#ARCHES[@]}" -gt 1 ]; then
  # one fat binary, or the previz window fails to open on the other arch
  lipo -create -output "$BUNDLE/Contents/MacOS/light-previz" \
    "target/aarch64-apple-darwin/release/light-previz" \
    "target/x86_64-apple-darwin/release/light-previz"
else
  cp "target/${ARCHES[0]}/release/light-previz" "$BUNDLE/Contents/MacOS/"
fi

echo "==> re-signing (adding a binary invalidates the bundle seal)"
# --entitlements is NOT optional here: re-signing without it silently drops the
# entitlements Tauri applied, and the app ships hardened but stripped. Verified
# the hard way — the first signed build came out with an empty entitlement set.
ENTS="src-tauri/light.entitlements"
if [ -n "${APPLE_SIGNING_IDENTITY:-}" ]; then
  codesign --force --deep --options runtime --timestamp \
    --entitlements "$ENTS" -s "$APPLE_SIGNING_IDENTITY" "$BUNDLE"
else
  codesign --force --deep --entitlements "$ENTS" -s - "$BUNDLE"
fi

# --- notarise, now that nothing else will touch the bundle ---
if [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_PASSWORD:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ]; then
  echo "==> notarising the app (a few minutes)"
  NOTARY_ZIP="$(dirname "$BUNDLE")/notarise.zip"
  ditto -c -k --keepParent "$BUNDLE" "$NOTARY_ZIP"
  xcrun notarytool submit "$NOTARY_ZIP" \
    --apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$APPLE_TEAM_ID" --wait
  rm -f "$NOTARY_ZIP"
  # stapling attaches the ticket so a first launch works offline too
  xcrun stapler staple "$BUNDLE"
  xcrun stapler validate "$BUNDLE"
else
  echo "==> not notarising (APPLE_ID / APPLE_PASSWORD / APPLE_TEAM_ID unset)"
fi

echo "==> dmg"
# Tauri's bundle_dmg.sh drives Finder over AppleScript to lay the window out,
# which fails headless (CI) and on a machine without Finder automation rights.
# A plain hdiutil image with an /Applications symlink is the same install
# gesture and always builds.
DMG_DIR="$(dirname "$BUNDLE")/dmg-stage"
DMG_OUT="$(dirname "$BUNDLE")/LIGHT.dmg"
rm -rf "$DMG_DIR" "$DMG_OUT"
mkdir -p "$DMG_DIR"
cp -R "$BUNDLE" "$DMG_DIR/"
ln -s /Applications "$DMG_DIR/Applications"
hdiutil create -volname LIGHT -srcfolder "$DMG_DIR" -ov -format UDZO -quiet "$DMG_OUT"
rm -rf "$DMG_DIR"
if [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_PASSWORD:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ]; then
  # the .dmg is what people download, so it needs its own ticket — a stapled
  # app inside an unstapled disk image still trips Gatekeeper on the image
  echo "==> notarising the dmg"
  codesign --force --timestamp -s "${APPLE_SIGNING_IDENTITY}" "$DMG_OUT"
  xcrun notarytool submit "$DMG_OUT" \
    --apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$APPLE_TEAM_ID" --wait
  xcrun stapler staple "$DMG_OUT"
  xcrun stapler validate "$DMG_OUT"
fi
echo "dmg: $DMG_OUT"

echo "==> result"
codesign -dv --verbose=2 "$BUNDLE" 2>&1 | grep -E 'Authority|TeamIdentifier|Signature|flags' || true
echo "-- entitlements --"
codesign -d --entitlements - --xml "$BUNDLE" 2>/dev/null | plutil -p - 2>/dev/null || echo "  (none)"
lipo -archs "$BUNDLE/Contents/MacOS/light-app"
lipo -archs "$BUNDLE/Contents/MacOS/light-previz"
du -sh "$BUNDLE"
echo "built: $BUNDLE"
echo "dmg:   $DMG_OUT"
