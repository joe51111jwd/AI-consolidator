#!/bin/bash
# Pushes a new version into the installed app in seconds, without repackaging: copies the app's
# own code (electron/, the built renderer, package.json) into /Applications/Switchboard vX.app,
# renames it to the new version, re-seals it and relaunches. Falls back to a full rebuild when
# the app's dependencies changed.  Usage: scripts/push-update.sh 3.8
set -euo pipefail
cd "$(dirname "$0")/.."
NEW="${1:?version, e.g. 3.8}"
FULL="$NEW.0"; [[ "$NEW" == *.*.* ]] && FULL="$NEW"
OLD_APP=$(ls -d /Applications/Switchboard\ v*.app 2>/dev/null | head -1)
NEW_APP="/Applications/Switchboard v$NEW.app"
node -e "const f='package.json',p=require('./'+f);p.version='$FULL';require('fs').writeFileSync(f,JSON.stringify(p,null,2)+'\n')"
npm run build --silent >/dev/null
deps() { node -e "const p=require(process.argv[1]);console.log(JSON.stringify(p.dependencies||{}))" "$1"; }
if [ -z "$OLD_APP" ] || [ "$(deps ./package.json)" != "$(deps "$OLD_APP/Contents/Resources/app/package.json")" ]; then
  echo "Dependencies changed (or no app installed): full rebuild"
  rm -rf release && npx electron-builder --mac --dir >/dev/null
  osascript -e "tell application \"$(basename "${OLD_APP:-x}" .app)\" to quit" 2>/dev/null || true; sleep 2
  [ -n "$OLD_APP" ] && rm -rf "$OLD_APP"
  mv release/mac-arm64/Switchboard.app "$NEW_APP" && rm -rf release
else
  osascript -e "tell application \"$(basename "$OLD_APP" .app)\" to quit" 2>/dev/null || true; sleep 2
  pkill -f "$OLD_APP/Contents/MacOS" 2>/dev/null || true
  R="$OLD_APP/Contents/Resources/app"
  # Everything package.json's build.files ships (top-level dirs/files), so new folders come along too.
  for item in $(node -e "for (const g of require('./package.json').build.files) console.log(g.replace(/\/\*\*$/, ''))"); do
    rm -rf "$R/$item"; mkdir -p "$R/$(dirname "$item")"; cp -R "$item" "$R/$item"
  done
  plutil -replace CFBundleShortVersionString -string "$FULL" "$OLD_APP/Contents/Info.plist"
  plutil -replace CFBundleVersion -string "$FULL" "$OLD_APP/Contents/Info.plist"
  [ "$OLD_APP" != "$NEW_APP" ] && mv "$OLD_APP" "$NEW_APP"
  codesign --force --sign - "$NEW_APP" 2>/dev/null
fi
xattr -dr com.apple.quarantine "$NEW_APP" 2>/dev/null || true
open "$NEW_APP"
echo "Switchboard v$NEW is running"
