# Paste Lumen V15 — Implementation Plan (macOS first)

> Design baseline: `docs/design/v15/paste-lumen-v15.html` + `docs/design/v15/README-Lumen-V15.md`.
> The README is the behavioural contract; §19 > §18 > §17 > §16 > earlier sections.
> This plan only records decisions, capability facts, and ticket slices — it never
> overrides the contract.

## Decisions taken with the product owner (2026-11-28)

| Topic | Decision |
| --- | --- |
| URL preview | An isolated WebView is allowed **only** inside the Quick Look URL renderer (user-initiated load, no scripts/cookies/clipboard access, external-open fallback). Every other surface stays 100% native. |
| Orbit global shortcut | macOS `⌘⌥V`, Windows/Linux `Alt+V`. Recorded as a platform-specific deviation from the V15 default `Option+V` because Option+V is a text-input character on macOS. |
| Delivery order | macOS first at 1:1, then port to Windows (WPF) and Linux (GTK4). |
| Migration | Develop on branch `lumen/v15`; the shipped V7 clients keep working; switch after the A-set acceptance passes. |

## M0 capability matrix (measured, to keep current)

| Capability | macOS 27 (this machine) | Windows 11 (host) | Linux (Ubuntu 24.04, GTK 4.22) |
| --- | --- | --- | --- |
| Clipboard capture | `NSPasteboard` changeCount + types — verified | Win32 clipboard + notification — verified via existing client | X11 selection owner — verified under Xvfb; Wayland untested |
| Global hotkey | Carbon `RegisterEventHotKey` — verified (no Accessibility dependency) | `RegisterHotKey` + `WH_KEYBOARD_LL` fallback — implemented in helper | X11 `XGrabKey` not yet wired in GTK client |
| Positioned overlay | `NSPanel` non-activating, borderless — verified | WPF borderless topmost `WS_EX_NOACTIVATE` — verified | undecorated `GtkWindow` under X11 — verified; Wayland needs `gtk4-layer-shell` |
| Multi-display continuous rail | NSScreen topology available; per-display windows **not implemented yet** | `MonitorFromWindow`/`EnumDisplayMonitors` available; not implemented | XRandR via GDK monitors; not implemented |
| Auto paste | Accessibility + CGEvent — implemented in helper | SendInput — implemented in helper | X11 XTEST — planned |
| Native blur | `NSVisualEffectView` — verified | DWM Mica/Acrylic — implemented | compositor dependent; Xvfb shows none |

Gaps are recorded rather than silently degraded: Wayland positioning/paste, multi-display
viewport windows and 120/144Hz budgets still need real-device proof.

## Ticket slices (macOS first)

### P1 — Orbit V15 (contract §3, §16, §17, §18.4, §19.1)

1. **Type model**: 10 logical categories (all, text, code, link, image, color, document, audio, video, other-file) + group/collection semantics; shared `ContentIdentityRegistry` used by Orbit, Library list/gallery, Inspector, Quick Look and archive members.
2. **Optical dots 3.0**: left column 38 DIP, five-point sliding window, low-idle brightness, hover wake, neighbour stagger, wheel/click/Shift+wheel/↑↓, first/last no wrap, empty categories keep position.
3. **Card geometry**: header 34 DIP (type + relative time), content-first body, footer source, corner 16, lift tokens (0/-2/-5/-7), remove button 28×28 hit / 22 visual / 13 glyph, time yields 210ms then X fades in at 145ms, leave reverses (X first, time +100ms).
4. **Removal**: soft dissolution (front ~480ms, particle life 320–500ms, peak alpha ≈0.58), reservation keeps the slot until particles finish, reflow 420ms after, undo restores by original sequence, filters untouched.
5. **Capture**: new item aggregates while Orbit is open; viewport/selection preserved when scrolled; no forced jump; no auto paste.
6. **Keyboard/pointer map**: ←→ cards, ↑↓ categories, Home/End, 1–9 quick pick, Enter paste, Space preview, Delete remove, ⌘Z undo, Esc chain (menu → preview → Orbit), Alt/Option+V toggle.
7. **Multi-display**: one transparent borderless window per participating bottom screen sharing one logical rail coordinate; no mirroring; separate-Spaces behaviour documented.

### P2 — Library V15 (contract §6, §17.3, §13, §18)

1. Native window chrome; sidebar / history / resizable inspector; list and gallery; time groups, search (content + source), sort, pin, batch operations.
2. Remove the global footer and the sidebar “本地资料库 / xxx 条记录” block (A54).
3. Inspector toolbar 48 DIP, 32×32 hit targets, copy button 88×34 content-width, no duplicated preview/type/meta.
4. Panel collapse/expand as continuous width changes (~380ms, interruptible), focus/accessibility state, splitter drag without easing lag.
5. Semantic identity icons across list, gallery, inspector (reuse the registry from P1).

### P3 — Quick Look V15 (contract §7)

1. Keep the renderer registry; align titles/metadata/queue with the identity registry.
2. Add: ZIP (central directory, inline password, member preview), CSV table, HTML/Markdown/SVG source-render toggle, URL renderer with the isolated WebView decision, colour conversions, text statistics.
3. Media queue semantics for collections; no autoplay; stop and release on close; keyboard scoped to the preview.

### P4 — Platform port and acceptance

1. Port P1–P3 to Windows (WPF) and Linux (GTK4) with the same tokens and acceptance vectors.
2. Run A01–A79 on real devices; record evidence per §19.4; publish differences for the owner's approval.

## Non-goals in this branch

- No changes to the clipboard server API unless a V15 capability needs new data (source confidence, formats, group semantics).
- No re-introduction of browser shells; the only web engine is the URL renderer.