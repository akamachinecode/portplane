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
if command -v hdiutil >/dev/null; then
  hdiutil create -quiet -volname "Portplane" -srcfolder "$work/Portplane" -ov -format UDZO "$out"
else
  echo "hdiutil not found: skipping $out (only built on macOS)" >&2
fi
