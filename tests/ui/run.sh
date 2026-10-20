#!/bin/zsh
# UI scenarios in real Chromium (headless shell), driven over CDP.
# usage: tests/ui/run.sh <scenario.mjs>   (env: LANG_UI=de|en THEME=dark|light W= H= AB_UI_OUT=)
# Starts the Vite dev server (test bridges are dev-only) on 127.0.0.1:5794
# and a throw-away Chromium profile on port 9494; screenshots go to
# $AB_UI_OUT (default testdata-out/ui, gitignored).
set -u
HERE=${0:A:h}
ROOT=${HERE:h:h}
CHROME=${CHROME:-$(ls -d ~/Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-*/chrome-headless-shell 2>/dev/null | tail -1)}
[[ -x "$CHROME" ]] || { echo "set CHROME to a chrome-headless-shell binary"; exit 2; }
export AB_UI_OUT=${AB_UI_OUT:-$ROOT/testdata-out/ui}
mkdir -p "$AB_UI_OUT"
TMP=$(mktemp -d)
cd "$ROOT"
pnpm exec vite --host 127.0.0.1 --port 5794 --strictPort > "$TMP/vite.log" 2>&1 &
VP=$!
"$CHROME" --headless --remote-debugging-port=9494 --user-data-dir="$TMP/ud" --window-size=1280,800 about:blank > "$TMP/chrome.log" 2>&1 &
CP=$!
sleep 4
SCEN=${1:A}
node "$HERE/cdp.mjs" 9494 "$SCEN"
RC=$?
kill $CP $VP 2>/dev/null; wait 2>/dev/null
rm -rf "$TMP"
exit $RC
