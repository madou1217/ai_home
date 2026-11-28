# Paste Lumen V7 — Linux Native Client (GTK4 / Adwaita)

100% native Linux GTK4/Adwaita implementation of Paste Lumen V7 (Phase 3), with zero WebKitGTK, WebView, or HTML rendering.

## Surfaces
1. **App Management Window** (`aih-lumen --app`): Sidebar, List & Gallery history views, single & batch multi-select Inspector, 3-tab Settings (Orbit / Appearance / Sync & Data), New Clip dialog, and full keyboard navigation.
2. **Orbit Edge Rail** (`aih-lumen --orbit` / `--toggle-orbit`): Separate borderless floating screen-edge rail (`bottom` continuous rail, `left` / `right` vertical rail) using `gtk4-layer-shell` on Wayland when installed, with X11 EWMH undecorated keep-above + skip-taskbar + `_NET_ACTIVE_WINDOW` focus restoration fallback, interruptible `GtkRevealer` / spring animations, ambient particles, release-light burst, and concurrent card removal/reflow.
3. **Shared Quick Look Preview Window** (`aih-lumen --preview <files...>`): Queue sidebar, drag-and-drop local files, bounded LRU cache, and 10-renderer Registry (Poppler PDF with graceful fallback, GStreamer/`GtkVideo` audio & video with 66-bar GSK waveform, `GdkTexture` zoomable images, GSK color inspector, `GtkSourceView` or Pango tokenizer code with line numbers, structured Office JSON via native `GtkBox`/`GtkColumnView`/`GtkStackSwitcher`, collections, text/link, and file fallback).

## Dependencies
- **Required**: Python 3.10+, GTK 4 (`gir1.2-gtk-4.0`), PyGObject (`python3-gi`).
- **Optional (auto-detected with graceful native fallbacks)**:
  - `gir1.2-adw-1` (libadwaita `AdwApplicationWindow`, `AdwSpringAnimation`, `AdwStyleManager`)
  - `gir1.2-gtk4layershell-1.0` or `libgtk4-layer-shell.so.0` (Wayland overlay edge anchoring)
  - `gir1.2-poppler-0.18` + `python3-cairo` (or `poppler-utils` `pdftoppm`) for PDF page rasterization
  - `gir1.2-gstreamer-1.0` (GTK4's built-in `GtkGstMediaFileBuiltin` is also supported out of the box)
  - `gir1.2-gtksource-5` (GtkSourceView 5 code canvas)

## Usage
```bash
# Check detected runtime capabilities
./native/linux-clipboard/aih-lumen --capabilities

# Launch App Management Window
./native/linux-clipboard/aih-lumen --app

# Toggle or show separate Orbit edge rail
./native/linux-clipboard/aih-lumen --orbit
./native/linux-clipboard/aih-lumen --orbit --position right

# Direct native Quick Look preview on local files
./native/linux-clipboard/aih-lumen --preview /path/to/file.pdf /path/to/song.wav

# Install local binary symlink + freedesktop .desktop entry
./native/linux-clipboard/scripts/install-desktop.sh
```

## Credential Resolution
Management credentials are never hardcoded and never accepted on argv. Endpoints and keys resolve strictly in order:
1. Runtime IPC `configure` message (`--ipc` NDJSON stdin mode)
2. Environment variables (`AIH_SERVER_ORIGIN` or `AIH_SERVER_HOST`+`AIH_SERVER_PORT`, `AIH_SERVER_MANAGEMENT_KEY`, `AIH_HOME_DIR`)
3. Read-only SQLite lookup at `~/.ai_home/aih.db` (`app_kv` → `config:server`)
