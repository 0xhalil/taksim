#!/bin/sh
# A clean-room start of the built app: it is copied to a fresh folder and run under a macOS sandbox profile that
# cannot read this checkout (the .build folder, the sources) nor TAKSIM_* settings, the way it runs on another Mac.
# It opens what opening a file opens (TAKSIM_SELFTEST) and must exit 0. Used by build checks and release.sh.
#   native/scripts/smoke.sh [path/to/Taksim.app]
set -e
cd "$(dirname "$0")/../.."
ROOT="$(pwd -P)"
APP="${1:-native/build/Taksim.app}"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
ditto "$APP" "$WORK/Taksim.app"
cat > "$WORK/smoke.sb" <<SB
(version 1)
(allow default)
(deny file-read* (subpath "$ROOT"))
SB
set +e
OUT=$(env -i HOME="$WORK" PATH=/usr/bin:/bin TAKSIM_SELFTEST=1 \
  sandbox-exec -f "$WORK/smoke.sb" "$WORK/Taksim.app/Contents/MacOS/Taksim" 2>&1)
CODE=$?
set -e
echo "$OUT" | tail -5
[ $CODE -eq 0 ] && echo "smoke: ok" || { echo "smoke: failed ($CODE)" >&2; exit 1; }
