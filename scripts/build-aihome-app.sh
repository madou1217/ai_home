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
  "$ROOT/native/clipboard/LumenModels.swift" \
  "$ROOT/native/clipboard/LumenContentIdentity.swift" \
  "$ROOT/native/clipboard/LumenLocalConfig.swift" \
  "$ROOT/native/clipboard/LumenClipboardAPI.swift" \
  "$ROOT/native/clipboard/LumenTheme.swift" \
  "$ROOT/native/clipboard/LumenPreviewRegistry.swift" \
  "$ROOT/native/clipboard/LumenPreviewRenderers.swift" \
  "$ROOT/native/clipboard/LumenPreviewZipRenderer.swift" \
  "$ROOT/native/clipboard/LumenPreviewWindow.swift" \
  "$ROOT/native/clipboard/LumenWorkspaceViews.swift" \
  "$ROOT/native/clipboard/ClipboardWorkspaceWindow.swift" \
  "$ROOT/native/clipboard/LumenOrbitViews.swift" \
  "$ROOT/native/clipboard/LumenOrbitOpticalDotsView.swift" \
  "$ROOT/native/clipboard/LumenOrbitDissolveEffect.swift" \
  "$ROOT/native/clipboard/LumenOrbitViewport.swift" \
  "$ROOT/native/clipboard/LumenOrbitDisplayCoordinator.swift" \
  "$ROOT/native/clipboard/QuickOrbitWindow.swift" \
  "$ROOT/native/aihome-app/main.swift" \
  -framework AppKit -framework ApplicationServices -framework CoreGraphics \
  -framework QuartzCore -framework PDFKit -framework AVFoundation -framework AVKit \
  -lsqlite3
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
