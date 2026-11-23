#!/bin/bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
case "$(uname -m)" in
  arm64) TARGET="arm64-apple-macosx13.0"; KEY="darwin-arm64" ;;
  x86_64) TARGET="x86_64-apple-macosx13.0"; KEY="darwin-x64" ;;
  *) echo "unsupported arch" >&2; exit 1 ;;
esac
STAGE=$(mktemp -d)
APP="$STAGE/AI Home.app"
mkdir -p "$APP/Contents/MacOS"
swiftc -O -target "$TARGET" -o "$APP/Contents/MacOS/ai-home" \
  "$ROOT/native/aihome-app/main.swift" \
  -framework AppKit -framework ApplicationServices -framework CoreGraphics
cp "$ROOT/native/aihome-app/Info.plist" "$APP/Contents/Info.plist"
codesign --force --sign - --identifier com.meadeo.aihome \
  -r '=designated => identifier "com.meadeo.aihome"' "$APP"
codesign --verify --strict "$APP"
OUT="$ROOT/bin/native/$KEY/AI Home.app"
mkdir -p "$(dirname "$OUT")"
rm -rf "$OUT"
mv "$APP" "$OUT"
rmdir "$STAGE" 2>/dev/null || true
echo "$OUT"
