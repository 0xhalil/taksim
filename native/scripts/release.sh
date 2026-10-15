#!/bin/sh
# Publishes a version of the app to GitHub Releases, where installed apps find it (Updater.swift):
#   native/scripts/release.sh 0.3.0 ["what changed"]
# builds the app with that version, packs the engine (bin, src, ui, its runtime modules) and this Mac's Node
# into it, zips it and wraps it in a disk image (Taksim-0.3.0-arm64.dmg), writes their SHA-256 beside them, and
# creates release v0.3.0 with the four files.
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
# node-pty's helper arrives without its exec bit; without it no terminal opens ("posix_spawnp failed")
chmod 755 "$ENGINE"/node_modules/node-pty/prebuilds/darwin-*/spawn-helper
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

# A smoke test of what ships: the bundled Node runs (with its JIT) and node-pty opens a terminal under the signed app's
# own rules. A release that can't open a terminal is not published.
if [ "$(uname -m)" = arm64 ]; then
  (cd "$ENGINE" && runtime/node --input-type=module -e '
    import pty from "node-pty";
    new Function("return 1")();
    const p = pty.spawn("/bin/echo", ["ok"], { cols: 80, rows: 24 });
    let out = ""; p.onData((d) => out += d);
    p.onExit(() => process.exit(out.includes("ok") ? 0 : 1));
    setTimeout(() => process.exit(1), 10000);
  ') || { echo "the packaged engine cannot open a terminal" >&2; exit 1; }
  echo "smoke test: the bundled node and node-pty work"
fi

# Apple's notary service looks a file over (minutes) and says Accepted or why not
notarize() {
  RESULT=$(xcrun notarytool submit "$1" --key "$TAKSIM_NOTARY_KEY" --key-id "$TAKSIM_NOTARY_KEY_ID" \
    --issuer "$TAKSIM_NOTARY_ISSUER" --wait --timeout 3h --output-format json) || true
  STATUS=$(printf '%s' "$RESULT" | node -pe 'try { JSON.parse(require("fs").readFileSync(0, "utf8")).status } catch { "unreadable" }')
  if [ "$STATUS" != "Accepted" ]; then
    echo "notarization of $1: $STATUS" >&2; printf '%s\n' "$RESULT" >&2
    ID=$(printf '%s' "$RESULT" | node -pe 'try { JSON.parse(require("fs").readFileSync(0, "utf8")).id } catch { "" }')
    [ -n "$ID" ] && xcrun notarytool log "$ID" --key "$TAKSIM_NOTARY_KEY" --key-id "$TAKSIM_NOTARY_KEY_ID" --issuer "$TAKSIM_NOTARY_ISSUER" >&2
    exit 1
  fi
}
NOTARIZING=""; [ -n "$TAKSIM_SIGN_IDENTITY" ] && [ -n "$TAKSIM_NOTARY_KEY" ] && NOTARIZING=1

if [ -n "$NOTARIZING" ]; then
  # the ticket is stapled to the app so it opens offline too
  NZ=$(mktemp -d)/notarize.zip
  ditto -c -k --sequesterRsrc --keepParent "$APP" "$NZ"
  notarize "$NZ"
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

# the disk image people expect to drag from: the app and a link to Applications, signed and notarized like the app
# (the zip stays: the app updates itself from it and the Homebrew cask installs it)
DMG="$OUT/Taksim-$VERSION-arm64.dmg"
DMGSRC=$(mktemp -d)
ditto "$APP" "$DMGSRC/Taksim.app"; ln -s /Applications "$DMGSRC/Applications"
hdiutil create -quiet -volname taksim -srcfolder "$DMGSRC" -fs HFS+ -format UDZO "$DMG"
[ -n "$TAKSIM_SIGN_IDENTITY" ] && codesign --force --timestamp --sign "$TAKSIM_SIGN_IDENTITY" "$DMG"
if [ -n "$NOTARIZING" ]; then
  notarize "$DMG"
  xcrun stapler staple "$DMG"
  spctl -a -t open --context context:primary-signature -vv "$DMG"
fi
shasum -a 256 "$DMG" | awk '{print $1}' > "$DMG.sha256"
echo "$DMG ($(du -h "$DMG" | cut -f1)), sha256 $(cat "$DMG.sha256")"

TAP="${TAKSIM_TAP:-0xhalil/homebrew-taksim}"
# The release page, laid out like the README: what it is, what changed, how to install, checksums
BODY="$OUT/notes.md"
PREV=$(git tag --list 'v[0-9]*' --sort=-v:refname | grep -v -x "v$VERSION" | head -1 || true)
# the tag message is the intro; a line "[zh]" in it starts the Chinese intro
HIGHLIGHTS=$(printf '%s\n' "$NOTES" | sed '/^\[zh\]$/,$d')
HIGHLIGHTS_ZH=""
case "$NOTES" in *'[zh]'*) HIGHLIGHTS_ZH=$(printf '%s\n' "$NOTES" | sed '1,/^\[zh\]$/d') ;; esac
{
  printf '%s\n\n' "${HIGHLIGHTS:-taksim $VERSION}"
  if [ -n "$PREV" ]; then
    CHANGES=$(git log --no-merges --format='- %s' "$PREV..HEAD" | grep -v -E '^- (release|tests?|ci|site|docs?|chore)[:(]' || true)
    [ -n "$CHANGES" ] && printf "## What's changed\n\n%s\n\n" "$CHANGES"
  fi
  printf '## Install\n\n| | |\n|---|---|\n'
  printf '| Homebrew | `brew install --cask %s/taksim/taksim` |\n' "${TAP%%/*}"
  printf '| Disk image | `%s`, drag to Applications |\n' "$(basename "$DMG")"
  printf '| ZIP | `%s` |\n\n' "$(basename "$ZIP")"
  printf 'macOS 15 or later on Apple silicon.'
  [ -n "$NOTARIZING" ] && printf ' Signed with a Developer ID and notarized by Apple.'
  printf ' The app updates itself.\n\n'
  printf '## SHA-256\n\n```\n%s  %s\n%s  %s\n```\n' "$(cat "$DMG.sha256")" "$(basename "$DMG")" "$(cat "$ZIP.sha256")" "$(basename "$ZIP")"
  [ -n "$PREV" ] && printf '\n**Full changelog:** https://github.com/%s/compare/%s...v%s\n' "$REPO" "$PREV" "$VERSION"
  # the same page in Chinese: users there read it too
  printf '\n---\n\n## 简体中文\n\n'
  [ -n "$HIGHLIGHTS_ZH" ] && printf '%s\n\n' "$HIGHLIGHTS_ZH"
  printf '| 安装方式 | |\n|---|---|\n'
  printf '| Homebrew | `brew install --cask %s/taksim/taksim` |\n' "${TAP%%/*}"
  printf '| 磁盘映像 | `%s`，拖入“应用程序” |\n' "$(basename "$DMG")"
  printf '| ZIP | `%s` |\n\n' "$(basename "$ZIP")"
  printf '需要 macOS 15 或更高版本，Apple 芯片。'
  [ -n "$NOTARIZING" ] && printf '已使用 Developer ID 签名并经过 Apple 公证。'
  printf '应用会自动更新。校验值（SHA-256）见上方。\n'
} > "$BODY"
if [ -z "$PUBLISH" ]; then echo; cat "$BODY"; echo; echo "built; add --publish to release it on $REPO"; exit 0; fi

gh release create "v$VERSION" "$ZIP" "$ZIP.sha256" "$DMG" "$DMG.sha256" --repo "$REPO" --title "taksim $VERSION" --notes-file "$BODY"
echo "published v$VERSION on $REPO"

# Homebrew: the cask in the tap (TAKSIM_TAP, default 0xhalil/homebrew-taksim) points at this release
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
