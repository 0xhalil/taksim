#!/bin/sh
# Builds native/build/Taksim.app from the Swift package (release), with an Info.plist so macOS treats it as
# a regular app. The engine is still the Node server in this checkout; the app finds it from its own path
# (or TAKSIM_ROOT) and starts it when it isn't running.
set -e
cd "$(dirname "$0")/.."
swift build -c release --product Taksim
swift build -c release --product taksim-computer
# CodeEditLanguages looks for its tree-sitter queries one "Resources" deeper than `swift build` puts them
# (Xcode's bundle layout); a link inside the bundle makes both layouts work, or the editor shows no colors
LANGS="$(swift build -c release --show-bin-path)/CodeEditLanguages_CodeEditLanguages.bundle/Resources"
[ -d "$LANGS" ] && [ ! -e "$LANGS/Resources" ] && ln -s . "$LANGS/Resources"
APP=build/Taksim.app
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$(swift build -c release --show-bin-path)/Taksim" "$APP/Contents/MacOS/Taksim"
# computer control's hands and eyes (src/computer/): inside the app, so macOS grants them as taksim
cp "$(swift build -c release --show-bin-path)/taksim-computer" "$APP/Contents/MacOS/taksim-computer"
# the editor's tree-sitter queries: Bundle.module only looks beside the app or in this .build, so the app points
# it here at launch (EditorResources); without it, opening a file in the IDE traps on any other Mac
cp -R "$(swift build -c release --show-bin-path)/CodeEditLanguages_CodeEditLanguages.bundle" "$APP/Contents/Resources/"
# the icon (drawn by scripts/make-icon.swift)
cp Resources/AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>taksim</string>
  <key>CFBundleDisplayName</key><string>taksim</string>
  <key>CFBundleIdentifier</key><string>dev.taksim.app</string>
  <key>CFBundleExecutable</key><string>Taksim</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundleShortVersionString</key><string>__VERSION__</string>
  <key>CFBundleVersion</key><string>__BUILD__</string>
  <key>LSMinimumSystemVersion</key><string>15.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
</dict>
</plist>
PLIST
# a release (native/scripts/release.sh) sets its version and where updates come from; a dev build has neither,
# so it never offers to replace itself with a release
VERSION="${TAKSIM_VERSION:-0.1}"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $VERSION" "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $(echo "$VERSION" | tr -cd '0-9.')" "$APP/Contents/Info.plist"
[ -n "$TAKSIM_RELEASE_REPO" ] && /usr/libexec/PlistBuddy -c "Add :TaksimReleaseRepo string $TAKSIM_RELEASE_REPO" "$APP/Contents/Info.plist"
# when it was built and from which commit: the app offers ↻ Güncelle once native/ on disk is newer
/usr/libexec/PlistBuddy -c "Add :TaksimBuiltAt real $(date +%s)" "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Add :TaksimCommit string $(git rev-parse --short HEAD 2>/dev/null || echo -)$(git diff --quiet HEAD -- . 2>/dev/null || echo +)" "$APP/Contents/Info.plist"
codesign --force --sign - "$APP/Contents/MacOS/taksim-computer" >/dev/null
codesign --force --sign - "$APP" >/dev/null
echo "$APP"
