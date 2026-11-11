#!/usr/bin/env bash
# Wraps a darwin portplane binary into Portplane.app and a .dmg.
# Called by goreleaser after each darwin build (see .goreleaser.yaml):
#   packaging/macos/app.sh <binary> <arch> <version>
set -euo pipefail
bin=$1 arch=$2 version=$3
root=$(cd "$(dirname "$0")/../.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
app="$work/Portplane/Portplane.app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$bin" "$app/Contents/MacOS/portplane"
cp "$root/build/icons/portplane.icns" "$app/Contents/Resources/portplane.icns"
sed "s/__VERSION__/$version/g" "$root/packaging/macos/Info.plist" > "$app/Contents/Info.plist"
ln -s /Applications "$work/Portplane/Applications"
out="$root/dist/portplane_${version}_darwin_${arch}.dmg"
rm -f "$out"
if ! command -v hdiutil >/dev/null; then
  echo "hdiutil not found: skipping $out (only built on macOS)" >&2
  exit 0
fi
# Seal the whole bundle with an ad-hoc signature: Apple silicon refuses a
# bundle whose Info.plist and resources are unsigned ("is damaged"), while an
# ad-hoc signed one gets the usual "Open Anyway" (ADR-0012: no notarization).
codesign --force --deep --sign - "$app"
codesign --verify --deep --strict "$app"
# goreleaser builds both architectures at once; hdiutil sometimes reports
# "Resource busy" when two images are created together.
for attempt in 1 2 3 4 5; do
  if hdiutil create -quiet -volname "Portplane" -srcfolder "$work/Portplane" -ov -format UDZO "$out"; then
    exit 0
  fi
  echo "hdiutil failed (attempt $attempt), retrying" >&2
  sleep $((attempt * 3))
done
exit 1
