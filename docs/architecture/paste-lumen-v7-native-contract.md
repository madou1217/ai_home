# Paste Lumen V7 — Cross-Platform Native Client Contract

> Applies to **macOS (AppKit/Swift — implemented)**, **Windows (C# WPF — implemented)**,
> and **Linux (GTK4/Adwaita — implemented)**.
> All clients deliver **100% native UI**: no WebView, WKWebView, WebView2, WebKitGTK, or HTML rendering in any surface.
>
> Implementation status (2026-11-28): all three surfaces on all three platforms are
> implemented under `native/clipboard/` (Swift), `native/clipboard/windows/` (C#) and
> `native/linux-clipboard/` (Python + GTK4). Verified natively on macOS 27, Windows 11
> (WPF build + live window against the local server) and Ubuntu 24.04 / GTK 4.22 under
> Xvfb; the Windows/Linux Quick Look queue, the primary-button styling and the Windows
> helper build were fixed during that pass.

---

## 1. Surface Separation Model

Every platform implements **three separate native surfaces** sharing one in-process reactive `ClipboardStore`, one `PreviewRegistry`, and one bounded `PreviewCache`:

| Surface | Responsibility | macOS (Implemented) | Windows (C# WPF) | Linux (GTK4) |
| --- | --- | --- | --- | --- |
| **App Management Window** | Sidebar, history (list/gallery), inspector, batch/multi-select, settings, new clip modal | `NSWindow` (`ClipboardWorkspaceWindow`) | `Window` (`WindowChrome`, DWM Mica/Acrylic) | `GtkApplicationWindow` (`AdwNavigationSplitView` or `GtkPaned`) |
| **Orbit Edge Rail** | Borderless non-activating floating screen-edge rail with card removal & interruptible motion | `NSPanel` (`.borderless`, `.nonactivatingPanel`, `.floating`) | `Window` (`WindowStyle="None"`, `AllowsTransparency="True"`, `Topmost="True"`, `WS_EX_NOACTIVATE \| WS_EX_TOOLWINDOW`) | Wayland: `gtk4-layer-shell` (`LAYER_OVERLAY`, anchored edge, exclusive zone `0`); X11: undecorated `GtkWindow` (`skip-taskbar`, `keep-above`) |
| **Shared Preview Container** | Reusable Quick Look window with queue sidebar, keyboard nav, drag-and-drop local files | `NSPanel` (`LumenPreviewWindow.shared`) | Floating `Window` (`LumenPreviewWindow`) | Floating `GtkWindow` (`LumenPreviewWindow`) |

**Invariants:**
- App Management Window and Orbit are **never** hosted in the same window or toggled inside a single shell.
- Orbit does not steal OS focus permanently: before showing, record the active foreground window/app (`NSWorkspace.frontmostApplication`, Win32 `GetForegroundWindow`, X11 `_NET_ACTIVE_WINDOW` / Wayland compositor focus) and restore focus on paste or `Esc` dismiss.
- Visual rules: never use thick left colored accent bars on cards/rows/nav items, and never use full-width colored Alert banners. Express selection with rounded surface fills, 1px borders, semantic icons, and elevation.

---

## 2. Local Configuration & HTTP/SSE Data Contract

Credentials and endpoints are **never hardcoded**. Every client resolves `(origin, managementKey)` in strict order:
1. Runtime IPC `configure` message (`clipboardOrigin`, `clipboardKey`, `quickOrbitPosition`) when launched as a server-managed helper.
2. Process environment: `AIH_SERVER_ORIGIN` (or `AIH_SERVER_HOST` + `AIH_SERVER_PORT`), `AIH_SERVER_MANAGEMENT_KEY`, `AIH_HOME_DIR`.
3. Local SQLite read-only lookup at `<AIH_HOME>/aih.db` (`SELECT value FROM app_kv WHERE key = 'config:server'`), parsing JSON `host` (`""`/`"0.0.0.0"` → `127.0.0.1`), `port` (default `9527`), and `managementKey`.
   - macOS / Linux `<AIH_HOME>`: `~/.ai_home`
   - Windows `<AIH_HOME>`: `%USERPROFILE%\.ai_home` (using `Microsoft.Data.Sqlite` read-only mode)

All API calls target `<origin>/v1/management/webui/clipboard` with `Authorization: Bearer <managementKey>`:

| Endpoint | Purpose | Client Contract |
| --- | --- | --- |
| `GET /items?limit=200` | Fetch history | Shared store merges with hydrated text detail cache |
| `POST /items` | Create text/link clip or undo delete | Used by New Clip sheet and `Ctrl/Cmd+Z` restore |
| `GET /items/{id}` | Hydrate full text detail (≤ 64 KiB) | Lazy-fetched on Inspector/Preview focus |
| `GET /items/{id}/content` | Fetch full image/text payload | On `409 clipboard_content_pending`, call `/materialize` and retry |
| `POST /items/{id}/copy` | **Authoritative OS clipboard write** | Writes text, PNG image, or native file drop list (`CF_HDROP` / `NSPasteboard` / `text/uri-list`); retries after `/materialize` on `409` |
| `POST /items/{id}/pin` | Toggle pin (`{"pinned": bool}`) | Updates item + status counts |
| `DELETE /items/{id}` | Remove single item | Optimistic UI removal + undo stack entry |
| `POST /items/batch-delete` | Batch remove (`{"ids": [...]}`) | Used by Inspector multi-select & Clear All |
| `GET /items/{id}/preview?index=N` | **Server-backed structured preview** | Returns `kind`, `mime`, `text`, and additive `office` (`format`, `document.blocks`, `workbook.sheets`, `presentation.slides`) |
| `GET /items/{id}/file?index=N` | Range-capable inline file stream | Supports HTTP `Range` (`206 Partial Content`) for native audio/video seek and PDF/image fetch |
| `GET/PATCH /settings` | Capture, sync, retention, `quickOrbitPosition` | Synced live across App settings and Orbit edge anchor |
| `GET /status`, `GET /servers`, `POST /sync-run` | Live runtime health & manual sync | Shown in Sidebar status dot & Settings Data tab |
| `GET /events` | SSE live change feed (`event: clipboard`) | Debounced store refresh (`~160ms`) with exponential reconnect backoff |

---

## 3. Renderer Registry & Cache Contract

### 3.1 Canonical Preview Kinds & Priority Order
Every client classifies a clipboard item, a member of a multi-file item, or a locally imported file into one `PreviewKind`:
`pdf` (100) → `audio` (95) → `video` (94) → `office(docx|xlsx|pptx)` (90) → `image` (88) → `color` (86) → `code(lang)` (84) → `collection` (82) → `text`/`link` (70) → `file` fallback (0).

Multi-file clipboard items (`files.count > 1`) and multi-select batch previews flatten into the Preview Container's left **Queue Sidebar** (`播放队列` when all audio, otherwise `文件集合`).

### 3.2 Renderer Interface Contract
Each platform exposes equivalent interfaces:
```text
interface IPreviewRenderer {
  string RendererId { get; }
  int Priority { get; }
  bool CanRender(PreviewItem item);
  IPreviewRendererView CreateView(PreviewItem item, PreviewContext ctx);
}

interface IPreviewRendererView {
  void Load(PreviewItem item, PreviewContext ctx);
  void ApplyTheme(LumenPalette palette);
  void ZoomIn(); void ZoomOut(); void ResetZoom();
  bool TogglePlayPause();
  bool StepPage(int delta);
  void CopyPrimaryContent();
  void Teardown(); // Mandatory: stop timers, cancel async loads, pause media
}
```

### 3.3 Platform Native Renderer Matrix

| Kind | macOS (Swift / AppKit) | Windows (C# / WPF) | Linux (GTK4) |
| --- | --- | --- | --- |
| **PDF** | `PDFKit` (`PDFView` + `PDFThumbnailView`) | `Windows.Data.Pdf.PdfDocument` rendered to `BitmapImage` + page rail | `Poppler-GLib` (`poppler_page_render`) to Cairo surface / `GdkTexture` + page rail |
| **Audio** | `AVFoundation` (`AVPlayer`, `AVAudioFile` RMS waveform) + CoreGraphics waveform | `MediaPlayer` + `NAudio` peak decode + WPF `DrawingVisual` waveform | `GStreamer` (`playbin3` + `level`/PCM peak decode) + `GtkDrawingArea` Cairo waveform |
| **Video** | `AVKit` (`AVPlayerView`) + `AVURLAsset` | WPF `MediaElement` (or `MediaPlayer` + `VideoDrawing`) | `GtkVideo` backed by `GstPaintable` (`gtk4paintablesink`) |
| **Image** | `CoreGraphics` / `NSImageView` in zoomable `NSScrollView` | `BitmapImage` in `ScrollViewer` with `ScaleTransform` | `GdkTexture` / `GtkPicture` inside `GtkScrolledWindow` |
| **Color** | CoreGraphics swatch + HEX/RGB/HSB inspector | WPF `Border` + `SolidColorBrush` + HEX/RGB/HSB | `GtkDrawingArea` swatch + HEX/RGB/HSB |
| **Office (DOCX/XLSX/PPTX)** | Server structured JSON → native `NSStackView` doc, `NSTableView` grid + formula bar + sheet tabs, slide deck | Server structured JSON → native `FlowDocument` / `StackPanel` doc, `DataGrid` + formula bar + `TabControl` sheets, slide deck | Server structured JSON → native `GtkBox`/`GtkLabel` doc, `GtkColumnView` + formula bar + `GtkStackSwitcher` sheets, slide deck |
| **Code** | Tokenizer → `NSAttributedString` + line numbers | Tokenizer → `FlowDocument`/`Run` spans + line-number gutter | `GtkSourceView` (or tokenizer → `PangoAttrList`) + line numbers |
| **Text / Link** | `NSTextView` + Open URL | Read-only `TextBox` / `FlowDocumentScrollViewer` + `Process.Start` | `GtkTextView` + `gtk_uri_launcher_launch` |
| **File Fallback** | `NSWorkspace` icon + Reveal in Finder / Open | `SHGetFileInfo` icon + `explorer /select,` / `ShellExecute` | `GFileInfo` `GIcon` + `GtkFileLauncher` / D-Bus `FileManager1.ShowItems` |

### 3.4 Bounded Preview Cache Contract
Shared across Inspector thumbnails and Quick Look Preview; keyed by `clip:<id>`, `clip:<id>:file:<index>`, or `local:<path>`:
- Decoded images: **64 MiB** LRU budget
- Parsed PDF documents: **12** documents
- Decoded audio waveforms (66 bars): **32** entries
- Server structured previews: **48** entries
- Hydrated full texts: **48** entries (8 MiB cap)
- Every async load checks a monotonically increasing `loadGeneration` before mutating views to eliminate stale flashes.

---

## 4. Orbit Screen-Edge Rail & Interruptible Motion Contract

### 4.1 Screen-Edge Geometry
- **`bottom` (default)**: Flush along the bottom edge (`height = clamp(232, 0.29 * screenHeight, 292)`).
  - *macOS*: Spans the lowest display row continuously when `!NSScreen.screensHaveSeparateSpaces`; spans full active display width when Spaces are separate so WindowServer never clips the panel.
  - *Windows WPF*: Computes the lowest horizontal monitor band from `Screen.AllScreens` (`SystemParameters.VirtualScreen*` with Per-Monitor V2 DPI scaling) and creates either a continuous virtual-desktop span or synchronized edge rail per bottom-row monitor without mirroring cards.
  - *Linux GTK4*: Wayland `gtk4-layer-shell` binds to the focused output's bottom/left/right edge (`ANCHOR_BOTTOM | ANCHOR_LEFT | ANCHOR_RIGHT`); X11 uses monitor workarea `_NET_WORKAREA`.
- **`left` / `right`**: Full workarea height vertical rail (`width = clamp(236, 0.19 * screenWidth, 278)`).

### 4.2 Motion Tokens & Interruptibility
| Transition | Duration | Easing | Interruptibility Requirement |
| --- | --- | --- | --- |
| Orbit / Preview Enter | `380ms` | Cubic-bezier `(0.19, 1, 0.25, 1)` | Sample live window/layer presentation bounds & opacity; reverse immediately on `hide()` |
| Orbit / Preview Exit | `220ms` | Cubic-bezier `(0.4, 0, 0.5, 1)` | Increment `transitionToken`; stale completion handlers must no-op |
| Preview Content Switch | `280ms` | Cubic-bezier `(0.16, 1, 0.3, 1)` | Call `Teardown()` on old renderer synchronously before mounting next |
| Card Remove & Reflow | `340ms` | Spring (`damping 19, stiffness 280`) / ease-out | Track `removingIDs` set so consecutive deletes animate concurrently without blocking |
| Card Hover / Focus Lift | `200ms` | Spring (`+9px` selected, `+5px` hover, `+2px` near) | Read `presentation()` transform on macOS / WPF `Storyboard` `HandoffBehavior.SnapshotAndReplace` / GTK `AdwSpringAnimation` |

**Reduced Motion:** Honor macOS `accessibilityDisplayShouldReduceMotion`, Windows `SystemParameters.ClientAreaAnimation`, Linux `GtkSettings.gtk-enable-animations`, and the in-app `motion` toggle. When disabled, collapse durations to `≤10ms` and disable ambient & release-light particle effects.

---

## 5. Unified Keyboard Contract

| Context | Keys | Behavior |
| --- | --- | --- |
| **App Window** | `↑` `↓` `←` `→`, `Home`, `End` | Navigate history (supports `Shift` range & `Cmd/Ctrl` toggle multi-select) |
| **App Window** | `Cmd/Ctrl+A`, `Cmd/Ctrl+F` or `/`, `Cmd/Ctrl+N`, `Cmd/Ctrl+Z` | Select all filtered, focus search, new text clip, undo last delete |
| **App Window** | `Space`, `Enter`, `Delete`/`Backspace`, `Esc` | Open shared Preview (single or batch), copy via HTTP API, delete single/batch, clear multi-select |
| **Orbit Rail** | `←`/`→` (or `↑`/`↓`), `1`–`9`, `Enter` | Move focus, quick-copy item 1–9 & dismiss, copy focused & dismiss |
| **Orbit Rail** | `Space`, `Delete`/`Backspace`, `Cmd/Ctrl+Z`, `Esc` | Open shared Preview, animated remove + reflow, undo delete, dismiss & restore focus |
| **Preview Window** | `←`/`→`, `Space`, `PageUp`/`PageDown` or `[`/`]`, `Cmd/Ctrl +/−/0`, `Cmd/Ctrl+C`/`Enter`, `Esc` | Step queue, play/pause media (or close non-media), step PDF/PPTX page, zoom, copy active item, close |
