#!/bin/zsh
set -euo pipefail

script_dir=${0:A:h}
saas_dir=${script_dir:h}
dist_dir="$script_dir/dist"
build_dir="$script_dir/build"
app="$build_dir/MeshMind Connect.app"
archive="$dist_dir/MeshMind-Connect-macOS-arm64-0.1.2.zip"
node_bin="$(command -v node)"

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
codesign --force --deep --sign - "$app"
codesign --verify --deep --strict "$app"
ditto -c -k --sequesterRsrc --keepParent "$app" "$archive"
digest="$(shasum -a 256 "$archive" | awk '{print $1}')"
print "$digest  ${archive:t}" > "$archive.sha256"
print "Built $archive"
ls -lh "$archive"
