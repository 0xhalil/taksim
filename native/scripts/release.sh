#!/bin/sh
# Publishes a version of the app to GitHub Releases, where installed apps find it (Updater.swift):
#   native/scripts/release.sh 0.3.0 ["what changed"]
# builds the app with that version, packs the engine (bin, src, ui, its runtime modules) and this Mac's Node
# into it, zips it, writes the zip's SHA-256 beside it, and creates release v0.3.0 with both files.
# The releases repository is TAKSIM_RELEASE_REPO (default 0xhalil/taksim-releases); it must exist and be public.
# Without --publish it only builds the files under native/build/release/ (to try them first).
set -e
cd "$(dirname "$0")/../.."
VERSION="$1"; NOTES="${2:-}"; PUBLISH=""
for a in "$@"; do [ "$a" = "--publish" ] && PUBLISH=1; done
[ "$NOTES" = "--publish" ] && NOTES=""
case "$VERSION" in [0-9]*.[0-9]*) ;; *) echo "usage: release.sh <version, e.g. 0.3.0> [notes] [--publish]" >&2; exit 2 ;; esac
REPO="${TAKSIM_RELEASE_REPO:-0xhalil/taksim-releases}"

TAKSIM_VERSION="$VERSION" TAKSIM_RELEASE_REPO="$REPO" native/scripts/build-app.sh >/dev/null
APP=native/build/Taksim.app
ENGINE="$APP/Contents/Resources/engine"
rm -rf "$ENGINE"; mkdir -p "$ENGINE/node_modules" "$ENGINE/runtime"
cp -R bin src ui toolbox package.json "$ENGINE/"
# only what the engine loads at run time: ws, node-pty (its prebuilt binaries) and Monaco's built files
cp -R node_modules/ws "$ENGINE/node_modules/"
mkdir -p "$ENGINE/node_modules/node-pty" "$ENGINE/node_modules/monaco-editor"
cp -R node_modules/node-pty/package.json node_modules/node-pty/lib "$ENGINE/node_modules/node-pty/"
mkdir -p "$ENGINE/node_modules/node-pty/prebuilds"
cp -R node_modules/node-pty/prebuilds/darwin-* "$ENGINE/node_modules/node-pty/prebuilds/"
[ -d node_modules/node-pty/build ] && cp -R node_modules/node-pty/build "$ENGINE/node_modules/node-pty/"
cp -R node_modules/monaco-editor/package.json node_modules/monaco-editor/min "$ENGINE/node_modules/monaco-editor/"
cp "$(command -v node)" "$ENGINE/runtime/node"
find "$ENGINE" -name '*.test.mjs' -delete
codesign --force --deep --sign - "$APP" >/dev/null

OUT=native/build/release
rm -rf "$OUT"; mkdir -p "$OUT"
ZIP="$OUT/Taksim-$VERSION.zip"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP"
shasum -a 256 "$ZIP" | awk '{print $1}' > "$ZIP.sha256"
echo "$ZIP ($(du -h "$ZIP" | cut -f1)), sha256 $(cat "$ZIP.sha256")"

[ -n "$PUBLISH" ] || { echo "built; add --publish to release it on $REPO"; exit 0; }
gh release create "v$VERSION" "$ZIP" "$ZIP.sha256" --repo "$REPO" --title "taksim $VERSION" --notes "${NOTES:-taksim $VERSION}"
echo "published v$VERSION on $REPO"

# Homebrew: the cask in the tap (TAKSIM_TAP, default 0xhalil/homebrew-taksim) points at this release
TAP="${TAKSIM_TAP:-0xhalil/homebrew-taksim}"
CASK=$(sed -e "s/__VERSION__/$VERSION/g" -e "s/__SHA256__/$(cat "$ZIP.sha256")/g" -e "s#__REPO__#$REPO#g" native/scripts/taksim.rb.in)
SHA=$(gh api "repos/$TAP/contents/Casks/taksim.rb" --jq .sha 2>/dev/null || true)
gh api -X PUT "repos/$TAP/contents/Casks/taksim.rb" -f message="taksim $VERSION" \
  -f content="$(printf '%s\n' "$CASK" | base64)" ${SHA:+-f sha="$SHA"} >/dev/null
echo "cask updated on $TAP: brew install --cask ${TAP%%/*}/${TAP#*/homebrew-}/taksim"
