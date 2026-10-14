#!/bin/sh
# Publishes a version of the app to GitHub Releases, where installed apps find it (Updater.swift):
#   native/scripts/release.sh 0.3.0 ["what changed"]
# builds the app with that version, packs the engine (bin, src, ui, its runtime modules) and this Mac's Node
# into it, zips it, writes the zip's SHA-256 beside it, and creates release v0.3.0 with both files.
# The releases repository is TAKSIM_RELEASE_REPO (default 0xhalil/taksim, the source repository itself); it must be public.
# Without --publish it only builds the files under native/build/release/ (to try them first).
# Signing: with TAKSIM_SIGN_IDENTITY (a Developer ID Application certificate, its SHA-1 hash) the app gets the hardened
# runtime; with TAKSIM_NOTARY_KEY (an App Store Connect API key .p8), TAKSIM_NOTARY_KEY_ID and TAKSIM_NOTARY_ISSUER it is
# also notarized and stapled. Without them the app is signed ad-hoc and only runs on this Mac.
set -e
cd "$(dirname "$0")/../.."
VERSION="$1"; NOTES="${2:-}"; PUBLISH=""
for a in "$@"; do [ "$a" = "--publish" ] && PUBLISH=1; done
[ "$NOTES" = "--publish" ] && NOTES=""
case "$VERSION" in [0-9]*.[0-9]*) ;; *) echo "usage: release.sh <version, e.g. 0.3.0> [notes] [--publish]" >&2; exit 2 ;; esac
REPO="${TAKSIM_RELEASE_REPO:-0xhalil/taksim}"

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

if [ -n "$TAKSIM_SIGN_IDENTITY" ]; then
  # Developer ID: hardened runtime and a secure timestamp. Every Mach-O inside goes first (the bundled Node and
  # node-pty's helpers need the JIT entitlements), the app itself last; --deep would sign them all alike.
  SIGN="codesign --force --options runtime --timestamp --sign $TAKSIM_SIGN_IDENTITY"
  find "$ENGINE" -type f | while IFS= read -r f; do
    if file -b "$f" | grep -q '^Mach-O'; then $SIGN --entitlements native/scripts/engine.entitlements "$f"; fi
  done
  $SIGN "$APP" >/dev/null
  codesign --verify --deep --strict "$APP"
  echo "signed with Developer ID"
else
  # a local try-out: ad-hoc, which only runs on this Mac
  codesign --force --deep --sign - "$APP" >/dev/null
fi

if [ -n "$TAKSIM_SIGN_IDENTITY" ] && [ -n "$TAKSIM_NOTARY_KEY" ]; then
  # Apple's notary service looks the app over (minutes); the ticket is then stapled so it opens offline too
  NOTARIZE=$(mktemp -d)/notarize.zip
  ditto -c -k --sequesterRsrc --keepParent "$APP" "$NOTARIZE"
  RESULT=$(xcrun notarytool submit "$NOTARIZE" --key "$TAKSIM_NOTARY_KEY" --key-id "$TAKSIM_NOTARY_KEY_ID" \
    --issuer "$TAKSIM_NOTARY_ISSUER" --wait --timeout 40m --output-format json) || true
  STATUS=$(printf '%s' "$RESULT" | node -pe 'try { JSON.parse(require("fs").readFileSync(0, "utf8")).status } catch { "unreadable" }')
  if [ "$STATUS" != "Accepted" ]; then
    echo "notarization: $STATUS" >&2; printf '%s\n' "$RESULT" >&2
    ID=$(printf '%s' "$RESULT" | node -pe 'try { JSON.parse(require("fs").readFileSync(0, "utf8")).id } catch { "" }')
    [ -n "$ID" ] && xcrun notarytool log "$ID" --key "$TAKSIM_NOTARY_KEY" --key-id "$TAKSIM_NOTARY_KEY_ID" --issuer "$TAKSIM_NOTARY_ISSUER" >&2
    exit 1
  fi
  xcrun stapler staple "$APP"
  spctl -a -t exec -vv "$APP"
  echo "notarized and stapled"
fi

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
if [ -n "$TAKSIM_TAP_KEY" ]; then
  # CI: the workflow's token only reaches this repository, so the tap takes a deploy key (write access to it alone)
  W=$(mktemp -d)
  export GIT_SSH_COMMAND="ssh -i $TAKSIM_TAP_KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
  git clone -q "git@github.com:$TAP.git" "$W"
  mkdir -p "$W/Casks"; printf '%s\n' "$CASK" > "$W/Casks/taksim.rb"
  git -C "$W" add Casks/taksim.rb
  git -C "$W" -c user.name="halil akkaya" -c user.email="contact@halilakkaya.dev" commit -q -m "taksim $VERSION"
  git -C "$W" push -q origin HEAD
  rm -rf "$W"
else
  SHA=$(gh api "repos/$TAP/contents/Casks/taksim.rb" --jq .sha 2>/dev/null || true)
  gh api -X PUT "repos/$TAP/contents/Casks/taksim.rb" -f message="taksim $VERSION" \
    -f content="$(printf '%s\n' "$CASK" | base64)" ${SHA:+-f sha="$SHA"} >/dev/null
fi
echo "cask updated on $TAP: brew install --cask ${TAP%%/*}/${TAP#*/homebrew-}/taksim"
