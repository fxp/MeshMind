#!/bin/zsh
set -euo pipefail

script_dir=${0:A:h}
saas_dir=${script_dir:h}
dist_dir="$script_dir/dist"
build_dir="$script_dir/build"
app="$build_dir/MeshMind Connect.app"
version=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$script_dir/Info.plist")
archive="$dist_dir/MeshMind-Connect-macOS-arm64-$version.zip"
node_bin="$(command -v node)"
development=false

if [[ "${1:-}" == "--development" ]]; then
  development=true
elif [[ $# -ne 0 ]]; then
  print -u2 "Usage: $0 [--development]"
  exit 2
fi

if [[ "$(uname -m)" != "arm64" ]]; then
  print -u2 "This release build targets Apple Silicon."
  exit 1
fi
if [[ ! -x "$saas_dir/node_modules/.bin/esbuild" ]]; then
  print -u2 "Run npm ci in saas/ before building."
  exit 1
fi

mkdir -p "$build_dir" "$dist_dir"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$script_dir/Info.plist" "$app/Contents/Info.plist"
iconset="$build_dir/AppIcon.iconset"
mkdir -p "$iconset"
for size in 16 32 128 256 512; do
  magick -background none "$script_dir/AppIcon.svg" -resize "${size}x${size}" "$iconset/icon_${size}x${size}.png"
  doubled=$((size * 2))
  magick -background none "$script_dir/AppIcon.svg" -resize "${doubled}x${doubled}" "$iconset/icon_${size}x${size}@2x.png"
done
iconutil -c icns "$iconset" -o "$app/Contents/Resources/AppIcon.icns"
swiftc -parse-as-library -O -target arm64-apple-macos14 \
  "$script_dir/MeshMindConnect.swift" -o "$app/Contents/MacOS/MeshMindConnect"
cp "$node_bin" "$app/Contents/Resources/node"
chmod 755 "$app/Contents/Resources/node"
"$saas_dir/node_modules/.bin/esbuild" "$script_dir/gateway-entry.ts" \
  --bundle --platform=node --format=cjs --target=node22 \
  '--external:node:*' --log-level=error \
  --outfile="$app/Contents/Resources/gateway.cjs"
if $development; then
  codesign --force --deep --sign - "$app"
  codesign --verify --deep --strict "$app"
  print "Built local development app at $app"
  print "Development builds are ad-hoc signed and are never written to macos/dist."
  exit 0
fi

: "${MESHMIND_CODESIGN_IDENTITY:?Set MESHMIND_CODESIGN_IDENTITY to an Apple Developer ID Application identity}"
: "${MESHMIND_NOTARY_PROFILE:?Set MESHMIND_NOTARY_PROFILE to a notarytool keychain profile}"

codesign --force --deep --options runtime --timestamp --sign "$MESHMIND_CODESIGN_IDENTITY" "$app"
codesign --verify --deep --strict --verbose=2 "$app"

notary_archive="$build_dir/MeshMind-Connect-notary-upload.zip"
ditto -c -k --sequesterRsrc --keepParent "$app" "$notary_archive"
xcrun notarytool submit "$notary_archive" --keychain-profile "$MESHMIND_NOTARY_PROFILE" --wait
xcrun stapler staple "$app"
xcrun stapler validate "$app"
spctl --assess --type execute --verbose=2 "$app"

ditto -c -k --sequesterRsrc --keepParent "$app" "$archive"
digest="$(shasum -a 256 "$archive" | awk '{print $1}')"
print "$digest  ${archive:t}" > "$archive.sha256"
print "Built signed and notarized $archive"
ls -lh "$archive"
