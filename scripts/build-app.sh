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
npx tauri build --target "$TARGET"

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
if [ -n "${APPLE_SIGNING_IDENTITY:-}" ]; then
  codesign --force --deep --options runtime --timestamp \
    -s "$APPLE_SIGNING_IDENTITY" "$BUNDLE"
else
  codesign --force --deep -s - "$BUNDLE"
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
echo "dmg: $DMG_OUT"

echo "==> result"
codesign -dv --verbose=2 "$BUNDLE" 2>&1 | grep -E 'Authority|TeamIdentifier|Signature|flags' || true
lipo -archs "$BUNDLE/Contents/MacOS/light-app"
lipo -archs "$BUNDLE/Contents/MacOS/light-previz"
du -sh "$BUNDLE"
echo "built: $BUNDLE"
echo "dmg:   $DMG_OUT"
