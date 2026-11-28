"""Glacier Glass & Deep Sea Glass palette, GTK4 CSS, syntax tokenizer, and GSK vector widgets.

Strictly adheres to AGENTS.md UI visual constraints:
- Never uses thick left colored accent bars (`border-left` decoration bars) on
  cards, list rows, navigation items, or quote blocks.
- Never uses large full-width Alert banners; uses compact inline status pills
  and floating toast overlays.
- 100% native GTK4 + GSK vector drawing (zero HTML/SVG/WebKitGTK).
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from typing import Callable, Optional

from gi.repository import Graphene, Gsk

from .capabilities import Adw, Gdk, GLib, Gtk, Pango
from .config import LumenVisualPreferences
from .models import DisplayCategory


def rgba(r: float, g: float, b: float, a: float = 1.0) -> Gdk.RGBA:
    color = Gdk.RGBA()
    color.red = float(r)
    color.green = float(g)
    color.blue = float(b)
    color.alpha = float(a)
    return color


def rgba_hex(hex_str: str, alpha: float = 1.0) -> Gdk.RGBA:
    c = Gdk.RGBA()
    c.parse(hex_str)
    c.alpha = float(alpha)
    return c


def make_color_stop(offset: float, color: Gdk.RGBA) -> Gsk.ColorStop:
    stop = Gsk.ColorStop()
    stop.offset = float(offset)
    stop.color = color
    return stop


@dataclass(frozen=True)
class LumenPalette:
    is_dark: bool
    window_bg: str
    sidebar_top: str
    sidebar_bottom: str
    surface: str
    surface_elevated: str
    border: str
    border_strong: str
    ink: str
    muted: str
    accent: str
    accent_soft: str
    accent_border: str
    danger: str
    danger_soft: str
    success: str
    warning: str
    code_bg: str
    code_toolbar: str
    code_gutter: str
    code_text: str

    def category_tint(self, cat: DisplayCategory) -> str:
        if self.is_dark:
            return {
                DisplayCategory.TEXT: "#a2ace2",
                DisplayCategory.CODE: "#91bffa",
                DisplayCategory.IMAGE: "#c3a9f9",
                DisplayCategory.LINK: "#77d0d0",
                DisplayCategory.COLOR: "#efa4c3",
                DisplayCategory.FILE: "#e5c084",
            }[cat]
        return {
            DisplayCategory.TEXT: "#7a82b0",
            DisplayCategory.CODE: "#5b88ce",
            DisplayCategory.IMAGE: "#9177cb",
            DisplayCategory.LINK: "#4d989b",
            DisplayCategory.COLOR: "#c56d93",
            DisplayCategory.FILE: "#b08c57",
        }[cat]

    def source_badge_color(self, source: str) -> str:
        lower = (source or "").lower()
        if any(k in lower for k in ("code", "xcode", "cursor", "vim", "neovim", "idea", "terminal", "kitty", "alacritty")):
            return "#568aca"
        if any(k in lower for k in ("figma", "sketch", "blender", "gimp", "inkscape")):
            return "#9c83c6"
        if any(k in lower for k in ("chrome", "safari", "arc", "firefox", "chromium", "brave")):
            return "#699e91"
        if any(k in lower for k in ("finder", "nautilus", "dolphin", "thunar", "files")):
            return "#7b9ecf"
        if any(k in lower for k in ("notes", "备忘", "obsidian", "notion")):
            return "#e2ad59"
        return "#7a94d2"


PALETTE_LIGHT = LumenPalette(
    is_dark=False,
    window_bg="#f9fafc",
    sidebar_top="#e8ecf5",
    sidebar_bottom="#f1f3f7",
    surface="#ffffff",
    surface_elevated="#f1f4fa",
    border="#e2e6ee",
    border_strong="#c9d2e4",
    ink="#202634",
    muted="#7a8190",
    accent="#546de1",
    accent_soft="rgba(129, 148, 225, 0.16)",
    accent_border="rgba(129, 148, 225, 0.42)",
    danger="#c95667",
    danger_soft="rgba(212, 103, 119, 0.12)",
    success="#5eb595",
    warning="#dfa44b",
    code_bg="#151c2c",
    code_toolbar="#202a3c",
    code_gutter="#697a94",
    code_text="#dbe6f9",
)

PALETTE_DARK = LumenPalette(
    is_dark=True,
    window_bg="#171b25",
    sidebar_top="#252d41",
    sidebar_bottom="#202531",
    surface="#1e2636",
    surface_elevated="#273144",
    border="#303746",
    border_strong="#445067",
    ink="#e9edf7",
    muted="#8d98aa",
    accent="#a0b0ff",
    accent_soft="rgba(129, 149, 230, 0.22)",
    accent_border="rgba(145, 168, 247, 0.46)",
    danger="#f598ad",
    danger_soft="rgba(212, 103, 119, 0.18)",
    success="#6ecba8",
    warning="#f1b963",
    code_bg="#151c2c",
    code_toolbar="#202a3c",
    code_gutter="#697a94",
    code_text="#dbe6f9",
)


def current_palette(prefs: Optional[LumenVisualPreferences] = None) -> LumenPalette:
    if prefs is not None and prefs.theme == "dark":
        return PALETTE_DARK
    return PALETTE_LIGHT


LUMEN_CSS = """
/* === Paste Lumen V7 Native GTK4 Stylesheet (Glacier Glass & Deep Sea Glass) === */
/* Zero left accent bars; zero full-width alert banners. */

window.lumen-window {
  background-color: #f9fafc;
  color: #202634;
}
window.lumen-window.lumen-dark {
  background-color: #171b25;
  color: #e9edf7;
}

.lumen-sidebar {
  background-image: linear-gradient(155deg, #e8ecf5, #f1f3f7 70%);
  border-right: 1px solid #e2e6ee;
}
.lumen-dark .lumen-sidebar {
  background-image: linear-gradient(155deg, #252d41, #202531 70%);
  border-right: 1px solid #303746;
}

.lumen-toolbar {
  background-color: #f9fafc;
  border-bottom: 1px solid #e2e6ee;
  padding: 8px 14px;
}
.lumen-dark .lumen-toolbar {
  background-color: #171b25;
  border-bottom: 1px solid #303746;
}

.lumen-footer {
  background-color: #f1f3f7;
  border-top: 1px solid #e2e6ee;
  padding: 4px 14px;
  font-size: 11px;
  color: #7a8190;
}
.lumen-dark .lumen-footer {
  background-color: #202531;
  border-top: 1px solid #303746;
  color: #8d98aa;
}

.lumen-brand-title {
  font-size: 17px;
  font-weight: 700;
}
.lumen-brand-sub {
  font-size: 10px;
  color: #7a8190;
}
.lumen-dark .lumen-brand-sub {
  color: #8d98aa;
}

.lumen-section-label {
  font-size: 10px;
  font-weight: 700;
  color: #7a8190;
  letter-spacing: 0.6px;
}
.lumen-dark .lumen-section-label {
  color: #8d98aa;
}

.lumen-heading {
  font-size: 14px;
  font-weight: 700;
}
.lumen-subheading {
  font-size: 11px;
  color: #7a8190;
}
.lumen-dark .lumen-subheading {
  color: #8d98aa;
}

.lumen-muted {
  color: #7a8190;
}
.lumen-dark .lumen-muted {
  color: #8d98aa;
}

/* Sidebar Navigation Pill (rounded fill + 1px border, NO left bar) */
button.lumen-nav-btn {
  background: transparent;
  border: 1px solid transparent;
  border-radius: 8px;
  padding: 6px 10px;
  min-height: 32px;
  color: #202634;
  box-shadow: none;
}
.lumen-dark button.lumen-nav-btn {
  color: #e9edf7;
}
button.lumen-nav-btn:hover {
  background-color: rgba(129, 146, 191, 0.12);
}
button.lumen-nav-btn.lumen-active {
  background-color: rgba(129, 148, 225, 0.16);
  border: 1px solid rgba(129, 148, 225, 0.42);
  color: #546de1;
  font-weight: 600;
}
.lumen-dark button.lumen-nav-btn.lumen-active {
  background-color: rgba(129, 149, 230, 0.22);
  border: 1px solid rgba(145, 168, 247, 0.46);
  color: #a0b0ff;
}

.lumen-status-dot {
  min-width: 8px;
  min-height: 8px;
  border-radius: 99px;
}
.lumen-dot-ok { background-color: #5eb595; }
.lumen-dot-warn { background-color: #dfa44b; }
.lumen-dot-off { background-color: #8d98aa; }

/* Toolbar icon / pill buttons */
button.lumen-icon-btn {
  background: transparent;
  border: 1px solid transparent;
  border-radius: 7px;
  min-width: 30px;
  min-height: 28px;
  padding: 4px 6px;
  box-shadow: none;
}
button.lumen-icon-btn:hover {
  background-color: rgba(129, 146, 191, 0.15);
}
button.lumen-icon-btn.lumen-active {
  background-color: rgba(129, 148, 225, 0.18);
  border: 1px solid rgba(129, 148, 225, 0.36);
  color: #546de1;
}
.lumen-dark button.lumen-icon-btn.lumen-active {
  color: #a0b0ff;
}

button.lumen-orbit-launch {
  background-color: rgba(129, 148, 225, 0.16);
  border: 1px solid rgba(129, 148, 225, 0.42);
  border-radius: 8px;
  color: #546de1;
  font-weight: 600;
  font-size: 12px;
  padding: 4px 10px;
  min-height: 28px;
  box-shadow: none;
}
.lumen-dark button.lumen-orbit-launch {
  background-color: rgba(129, 149, 230, 0.22);
  border: 1px solid rgba(145, 168, 247, 0.46);
  color: #a0b0ff;
}
button.lumen-orbit-launch:hover {
  background-color: rgba(129, 148, 225, 0.26);
}

button.lumen-primary-btn {
  background-color: #546de1;
  color: #ffffff;
  border: 1px solid #4861d4;
  border-radius: 9px;
  font-weight: 600;
  padding: 7px 14px;
  min-height: 34px;
  box-shadow: 0 3px 10px rgba(84, 109, 225, 0.24);
}
button.lumen-primary-btn:hover {
  background-color: #425ad0;
}
.lumen-dark button.lumen-primary-btn {
  background-color: #6b82f0;
  border-color: #7c92ff;
  color: #ffffff;
}

button.lumen-secondary-btn {
  background-color: #ffffff;
  color: #202634;
  border: 1px solid #e2e6ee;
  border-radius: 9px;
  padding: 7px 12px;
  min-height: 34px;
  box-shadow: none;
}
.lumen-dark button.lumen-secondary-btn {
  background-color: #1e2636;
  color: #e9edf7;
  border-color: #303746;
}
button.lumen-secondary-btn:hover {
  background-color: rgba(129, 146, 191, 0.14);
}

button.lumen-danger-btn {
  background-color: rgba(212, 103, 119, 0.12);
  color: #c95667;
  border: 1px solid rgba(201, 86, 103, 0.36);
  border-radius: 9px;
  padding: 7px 12px;
  min-height: 34px;
  box-shadow: none;
}
.lumen-dark button.lumen-danger-btn {
  background-color: rgba(212, 103, 119, 0.18);
  color: #f598ad;
  border-color: rgba(245, 152, 173, 0.36);
}

button.lumen-pill-btn {
  background-color: #f1f4fa;
  color: #202634;
  border: 1px solid #e2e6ee;
  border-radius: 7px;
  padding: 3px 10px;
  min-height: 26px;
  font-size: 11.5px;
  font-weight: 500;
  box-shadow: none;
}
.lumen-dark button.lumen-pill-btn {
  background-color: #273144;
  color: #e9edf7;
  border-color: #303746;
}
button.lumen-pill-btn.lumen-code-pill {
  background-color: rgba(255, 255, 255, 0.08);
  color: #dbe6f9;
  border-color: rgba(255, 255, 255, 0.16);
}

/* History List Rows & Gallery Cards (rounded fill + full border, NO left bar) */
.lumen-history-row {
  background: transparent;
  border: 1px solid transparent;
  border-radius: 9px;
  padding: 8px 10px;
  margin: 2px 6px;
}
.lumen-history-row:hover {
  background-color: rgba(128, 149, 188, 0.10);
}
.lumen-history-row.lumen-selected {
  background-color: rgba(129, 148, 225, 0.16);
  border: 1px solid rgba(129, 148, 225, 0.42);
}
.lumen-dark .lumen-history-row.lumen-selected {
  background-color: rgba(129, 149, 230, 0.22);
  border: 1px solid rgba(145, 168, 247, 0.46);
}

.lumen-row-thumb {
  border-radius: 8px;
  background-color: #f1f4fa;
  border: 1px solid rgba(139, 154, 181, 0.20);
}
.lumen-dark .lumen-row-thumb {
  background-color: #273144;
  border-color: rgba(160, 180, 220, 0.16);
}

.lumen-gallery-card {
  background-color: #ffffff;
  border: 1px solid #e2e6ee;
  border-radius: 12px;
  padding: 10px;
  box-shadow: 0 2px 8px rgba(24, 39, 75, 0.06);
}
.lumen-dark .lumen-gallery-card {
  background-color: #1e2636;
  border-color: #303746;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.24);
}
.lumen-gallery-card.lumen-selected {
  border: 2px solid #546de1;
  background-color: rgba(129, 148, 225, 0.08);
}
.lumen-dark .lumen-gallery-card.lumen-selected {
  border: 2px solid #a0b0ff;
  background-color: rgba(129, 149, 230, 0.16);
}

/* Inspector & Hero Preview */
.lumen-inspector {
  background-color: #f9fafc;
}
.lumen-dark .lumen-inspector {
  background-color: #171b25;
}

.lumen-hero-box {
  background-color: #ffffff;
  border: 1px solid #e2e6ee;
  border-radius: 13px;
  padding: 14px;
}
.lumen-dark .lumen-hero-box {
  background-color: #1e2636;
  border-color: #303746;
}
.lumen-hero-code {
  background-color: #151c2c;
  color: #dbe6f9;
  border: 1px solid #2b3852;
  border-radius: 13px;
  padding: 14px;
}

/* Settings Cards & Theme Tiles */
.lumen-settings-group {
  background-color: #ffffff;
  border: 1px solid #e2e6ee;
  border-radius: 12px;
}
.lumen-dark .lumen-settings-group {
  background-color: #1e2636;
  border-color: #303746;
}
.lumen-setting-row {
  padding: 12px 16px;
  border-bottom: 1px solid #e2e6ee;
}
.lumen-dark .lumen-setting-row {
  border-bottom: 1px solid #303746;
}
.lumen-setting-row.lumen-last-row {
  border-bottom: none;
}

button.lumen-theme-tile {
  background-color: #ffffff;
  border: 1px solid #e2e6ee;
  border-radius: 12px;
  padding: 10px;
  box-shadow: none;
}
.lumen-dark button.lumen-theme-tile {
  background-color: #1e2636;
  border-color: #303746;
}
button.lumen-theme-tile.lumen-active {
  border: 2px solid #546de1;
}
.lumen-dark button.lumen-theme-tile.lumen-active {
  border: 2px solid #a0b0ff;
}

/* Preview Window & Renderers */
.lumen-preview-header {
  background-color: #ffffff;
  border-bottom: 1px solid #e2e6ee;
  padding: 10px 16px;
}
.lumen-dark .lumen-preview-header {
  background-color: #1e2636;
  border-bottom: 1px solid #303746;
}
.lumen-preview-queue {
  background-color: #f1f3f7;
  border-right: 1px solid #e2e6ee;
}
.lumen-dark .lumen-preview-queue {
  background-color: #202531;
  border-right: 1px solid #303746;
}
.lumen-queue-row {
  border-radius: 9px;
  border: 1px solid transparent;
  padding: 7px 9px;
  margin: 2px 6px;
}
.lumen-queue-row.lumen-selected {
  background-color: rgba(129, 148, 225, 0.16);
  border: 1px solid rgba(129, 148, 225, 0.42);
}
.lumen-dark .lumen-queue-row.lumen-selected {
  background-color: rgba(129, 149, 230, 0.22);
  border: 1px solid rgba(145, 168, 247, 0.46);
}

.lumen-renderer-toolbar {
  background-color: #ffffff;
  border-bottom: 1px solid #e2e6ee;
  padding: 6px 14px;
  min-height: 40px;
}
.lumen-dark .lumen-renderer-toolbar {
  background-color: #1e2636;
  border-bottom: 1px solid #303746;
}
.lumen-renderer-toolbar.lumen-code-toolbar {
  background-color: #202a3c;
  border-bottom: 1px solid rgba(255, 255, 255, 0.10);
  color: #dbe6f9;
}

.lumen-code-surface,
.lumen-code-surface text {
  background-color: #151c2c;
  color: #dbe6f9;
  font-family: monospace;
}
.lumen-code-gutter,
.lumen-code-gutter text {
  background-color: #111826;
  color: #697a94;
  font-family: monospace;
}

/* Office Document / Slide / Workbook Surfaces */
.lumen-doc-paper {
  background-color: #ffffff;
  color: #26354d;
  border: 1px solid #d9e0ed;
  border-radius: 8px;
  padding: 28px 34px;
}
.lumen-doc-quote {
  background-color: #eef3ff;
  color: #465872;
  border: 1px solid #c7d6f5;
  border-radius: 8px;
  padding: 10px 14px;
}
.lumen-doc-table {
  border: 1px solid #dbe2ee;
  border-radius: 6px;
}
.lumen-doc-table-hdr {
  background-color: #eef2f9;
  color: #24334b;
  font-weight: 700;
  padding: 6px 8px;
}
.lumen-doc-table-cell {
  background-color: #ffffff;
  color: #283850;
  padding: 6px 8px;
}
.lumen-formula-bar {
  background-color: #f1f5f3;
  border-bottom: 1px solid #d4dfd9;
  padding: 6px 12px;
  color: #263d42;
}
.lumen-cell-ref {
  background-color: #ffffff;
  border: 1px solid #d4dfd9;
  border-radius: 5px;
  padding: 2px 8px;
  font-family: monospace;
  font-weight: 700;
}
.lumen-slide-card {
  background-color: #ffffff;
  color: #24334d;
  border: 1px solid #dbe2ee;
  border-radius: 12px;
  padding: 28px 32px;
  box-shadow: 0 8px 26px rgba(16, 31, 63, 0.10);
}

/* Floating Compact Toast */
.lumen-toast {
  background-color: rgba(32, 50, 77, 0.94);
  color: #ffffff;
  border: 1px solid rgba(255, 255, 255, 0.22);
  border-radius: 12px;
  padding: 8px 15px;
  box-shadow: 0 8px 28px rgba(16, 33, 58, 0.30);
}
button.lumen-toast-undo {
  background: transparent;
  border: none;
  color: #b9d9ff;
  font-weight: 700;
  padding: 0 4px;
  box-shadow: none;
}

/* === Orbit Separate Borderless Floating Edge Rail === */
window.lumen-orbit-window {
  background-color: transparent;
}

.lumen-orbit-card {
  border-radius: 18px;
  background-image: linear-gradient(140deg, rgba(252, 253, 255, 0.94), rgba(223, 233, 247, 0.90));
  border: 1px solid rgba(255, 255, 255, 0.65);
  color: #26344e;
  box-shadow: 0 9px 24px rgba(11, 29, 57, 0.20);
  padding: 11px 12px;
}
.lumen-dark .lumen-orbit-card {
  background-image: linear-gradient(140deg, rgba(56, 76, 107, 0.90), rgba(32, 49, 75, 0.92));
  border: 1px solid rgba(165, 195, 237, 0.34);
  color: #edf5ff;
  box-shadow: 0 9px 24px rgba(0, 0, 0, 0.42);
}
.lumen-orbit-card.lumen-selected {
  border: 1.5px solid #ffffff;
  box-shadow: 0 0 0 2px rgba(201, 237, 255, 0.78), 0 14px 34px rgba(22, 41, 78, 0.38);
}
.lumen-dark .lumen-orbit-card.lumen-selected {
  border: 1.5px solid #cfebff;
  box-shadow: 0 0 0 1.5px rgba(184, 222, 255, 0.85), 0 14px 34px rgba(0, 0, 0, 0.54);
}
.lumen-no-glow .lumen-orbit-card.lumen-selected {
  box-shadow: 0 0 0 2px rgba(197, 224, 255, 0.70), 0 8px 18px rgba(0, 0, 0, 0.20);
}

.lumen-orbit-key {
  background-color: rgba(90, 115, 156, 0.14);
  color: #657693;
  border-radius: 5px;
  min-width: 20px;
  min-height: 19px;
  padding: 1px 5px;
  font-family: monospace;
  font-size: 10px;
  font-weight: 700;
}
.lumen-dark .lumen-orbit-key {
  background-color: rgba(170, 196, 255, 0.15);
  color: #b1c5e5;
}
.lumen-orbit-card.lumen-selected .lumen-orbit-key {
  background-color: #6589d7;
  color: #ffffff;
}

button.lumen-orbit-remove {
  background-color: rgba(237, 245, 255, 0.95);
  color: #536780;
  border: 1px solid #ffffff;
  border-radius: 99px;
  min-width: 24px;
  min-height: 24px;
  padding: 0;
  box-shadow: 0 4px 12px rgba(23, 47, 85, 0.28);
}
.lumen-dark button.lumen-orbit-remove {
  background-color: rgba(49, 72, 102, 0.95);
  color: #e8f3ff;
  border-color: rgba(181, 216, 255, 0.55);
}
button.lumen-orbit-remove:hover {
  background-color: #fff1f3;
  color: #b53e60;
}
.lumen-dark button.lumen-orbit-remove:hover {
  background-color: #653f55;
  color: #ffe2ed;
}

.lumen-orbit-code-body {
  background-color: #151c2c;
  color: #d3e8fa;
  border-radius: 9px;
  padding: 8px;
  font-family: monospace;
  font-size: 10.5px;
}

.lumen-orbit-subbox {
  background-color: rgba(255, 255, 255, 0.56);
  border-radius: 9px;
  padding: 8px 9px;
}
.lumen-dark .lumen-orbit-subbox {
  background-color: rgba(182, 204, 255, 0.10);
}
"""


class CssThemeManager:
    _installed = False
    _provider: Optional[Gtk.CssProvider] = None

    @classmethod
    def ensure_installed(cls) -> None:
        if cls._installed:
            return
        display = Gdk.Display.get_default()
        if display is None:
            return
        provider = Gtk.CssProvider()
        provider.load_from_string(LUMEN_CSS)
        Gtk.StyleContext.add_provider_for_display(
            display,
            provider,
            Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION,
        )
        cls._provider = provider
        cls._installed = True

    @classmethod
    def apply_to_window(cls, window: Gtk.Window, prefs: LumenVisualPreferences) -> None:
        cls.ensure_installed()
        if prefs.theme == "dark":
            window.add_css_class("lumen-dark")
            window.remove_css_class("lumen-light")
        else:
            window.add_css_class("lumen-light")
            window.remove_css_class("lumen-dark")

        if prefs.glow:
            window.remove_css_class("lumen-no-glow")
        else:
            window.add_css_class("lumen-no-glow")

        if Adw is not None:
            try:
                sm = Adw.StyleManager.get_default()
                sm.set_color_scheme(
                    Adw.ColorScheme.FORCE_DARK if prefs.theme == "dark" else Adw.ColorScheme.FORCE_LIGHT
                )
            except Exception:
                pass
        settings = Gtk.Settings.get_default()
        if settings is not None:
            try:
                settings.set_property("gtk-application-prefer-dark-theme", prefs.theme == "dark")
            except Exception:
                pass


class SyntaxTokenizer:
    """Pure Python syntax tokenizer producing GTK TextTags or Pango markup (no HTML/WebView)."""

    KEYWORDS_BY_LANG: dict[str, frozenset[str]] = {
        "js": frozenset("async function await return const let var new if else for while class import export from throw try catch true false null undefined switch case break continue".split()),
        "ts": frozenset("async function await return const let var new if else for while class import export from type interface extends implements readonly public private protected true false null string number boolean void".split()),
        "go": frozenset("package import func return if else for range var const type struct interface defer go select switch case default nil true false error map chan make len cap".split()),
        "swift": frozenset("import func return if else guard let var struct class final enum protocol extension private fileprivate public internal static override init deinit self Self true false nil switch case break continue where throw throws try catch async await in".split()),
        "php": frozenset("namespace use final class extends implements public private protected function return new if else foreach for while static true false null echo throw try catch".split()),
        "py": frozenset("from import as def async await return class if elif else for in while with try except finally raise True False None pass yield lambda and or not".split()),
        "rust": frozenset("fn let mut pub struct enum impl trait for in while loop if else match return use mod crate self Self true false Some None Ok Err async await".split()),
        "sql": frozenset("SELECT FROM WHERE JOIN LEFT RIGHT INNER OUTER ON GROUP BY ORDER LIMIT INSERT INTO VALUES UPDATE SET DELETE CREATE TABLE ALTER DROP AS AND OR NOT IN IS NULL".split()),
        "json": frozenset({"true", "false", "null"}),
        "css": frozenset({"important", "inherit", "initial", "unset", "none", "auto", "flex", "grid"}),
    }

    TOKEN_RE = re.compile(
        r'(\/\/[^\n]*|\/\*[\s\S]*?\*\/|#[^\n]*|"(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])*\'|`(?:\\.|[^`\\])*`|\$[A-Za-z_]\w*|\b\d+(?:\.\d+)?\b|\b[A-Za-z_]\w*\b)'
    )

    @classmethod
    def colors_for(cls, language: str, dark_canvas: bool = True) -> dict[str, str]:
        lang = (language or "js").lower()
        if dark_canvas:
            kw = "#80dcf2" if lang == "go" else ("#f2c478" if lang == "py" else "#c6a5ff")
            return {
                "base": "#dbe6f9",
                "comment": "#788aa6",
                "string": "#a6d99b",
                "number": "#f3be86",
                "var": "#eb91ad",
                "func": "#85c8f0",
                "keyword": kw,
            }
        kw = "#3287ad" if lang == "go" else ("#b07a31" if lang == "py" else "#8c6ac7")
        return {
            "base": "#2a364d",
            "comment": "#8293a5",
            "string": "#459568",
            "number": "#c68b4f",
            "var": "#bd5378",
            "func": "#3b82bd",
            "keyword": kw,
        }

    @classmethod
    def tokenize(cls, source: str, language: str) -> list[tuple[int, int, str]]:
        clamped = source[:48_000]
        lang = (language or "js").lower()
        keywords = cls.KEYWORDS_BY_LANG.get(lang, cls.KEYWORDS_BY_LANG["js"])
        spans: list[tuple[int, int, str]] = []
        n = len(clamped)
        for m in cls.TOKEN_RE.finditer(clamped):
            start, end = m.span()
            tok = m.group(0)
            if tok.startswith("//") or tok.startswith("/*") or (lang in ("py", "sh", "yaml", "toml") and tok.startswith("#")):
                spans.append((start, end, "comment"))
            elif tok[0] in ('"', "'", "`"):
                spans.append((start, end, "string"))
            elif tok.startswith("$"):
                spans.append((start, end, "var"))
            elif tok[0].isdigit():
                spans.append((start, end, "number"))
            elif tok in keywords or (lang == "sql" and tok.upper() in keywords):
                spans.append((start, end, "keyword"))
            elif end < n and clamped[end] == "(":
                spans.append((start, end, "func"))
        return spans

    @classmethod
    def to_pango_markup(cls, source: str, language: str, dark_canvas: bool = True, max_chars: int = 700) -> str:
        text = source[:max_chars]
        colors = cls.colors_for(language, dark_canvas=dark_canvas)
        spans = cls.tokenize(text, language)
        parts: list[str] = []
        cursor = 0
        for start, end, kind in spans:
            if start > cursor:
                parts.append(GLib.markup_escape_text(text[cursor:start]))
            color = colors.get(kind, colors["base"])
            escaped = GLib.markup_escape_text(text[start:end])
            parts.append(f'<span foreground="{color}">{escaped}</span>')
            cursor = end
        if cursor < len(text):
            parts.append(GLib.markup_escape_text(text[cursor:]))
        return "".join(parts)

    @classmethod
    def apply_to_text_buffer(cls, buf: Gtk.TextBuffer, source: str, language: str, dark_canvas: bool = True) -> None:
        clamped = source[:48_000] + ("\n… (已截断)" if len(source) > 48_000 else "")
        buf.set_text(clamped)
        table = buf.get_tag_table()
        colors = cls.colors_for(language, dark_canvas=dark_canvas)
        tags: dict[str, Gtk.TextTag] = {}
        for kind, color in colors.items():
            tag_name = f"lumen-tok-{kind}"
            tag = table.lookup(tag_name)
            if tag is None:
                tag = buf.create_tag(tag_name, foreground=color)
            else:
                tag.set_property("foreground", color)
            tags[kind] = tag
        for start, end, kind in cls.tokenize(clamped, language):
            tag = tags.get(kind)
            if tag is not None:
                it_start = buf.get_iter_at_offset(start)
                it_end = buf.get_iter_at_offset(end)
                buf.apply_tag(tag, it_start, it_end)


class BrandMarkWidget(Gtk.Widget):
    """Pure GTK4/GSK vector rendering of the Lumen luminous orbital mark."""

    def __init__(self, size: int = 32) -> None:
        super().__init__()
        self.set_size_request(size, size)
        self.set_valign(Gtk.Align.CENTER)
        self.set_halign(Gtk.Align.CENTER)

    def do_snapshot(self, snapshot: Gtk.Snapshot) -> None:
        w = max(1, self.get_width())
        h = max(1, self.get_height())
        rect = Graphene.Rect().init(0, 0, w, h)
        radius = min(w, h) * 0.32
        rrect = Gsk.RoundedRect()
        rrect.init_from_rect(rect, radius)
        snapshot.push_rounded_clip(rrect)

        stops = [
            make_color_stop(0.0, rgba(0.737, 0.914, 1.0, 1.0)),
            make_color_stop(0.55, rgba(0.506, 0.600, 0.980, 1.0)),
            make_color_stop(1.0, rgba(0.725, 0.627, 0.992, 1.0)),
        ]
        snapshot.append_linear_gradient(
            rect,
            Graphene.Point().init(0, 0),
            Graphene.Point().init(w, h),
            stops,
        )

        scale = min(w, h) / 24.0
        ox = (w - 24.0 * scale) / 2.0
        oy = (h - 24.0 * scale) / 2.0

        def pt(x: float, y: float) -> tuple[float, float]:
            return (ox + x * scale, oy + (24.0 - y) * scale)

        pb = Gsk.PathBuilder.new()
        pb.move_to(*pt(4.5, 11.0))
        pb.cubic_to(*pt(5.5, 16.0), *pt(9.5, 19.0), *pt(13.5, 19.0))
        pb.cubic_to(*pt(18.0, 19.0), *pt(20.5, 16.0), *pt(20.5, 13.0))
        pb.cubic_to(*pt(20.5, 8.5), *pt(16.0, 5.5), *pt(11.5, 5.5))
        pb.cubic_to(*pt(8.5, 5.5), *pt(7.0, 6.8), *pt(7.0, 8.5))
        pb.cubic_to(*pt(7.0, 11.5), *pt(10.5, 13.5), *pt(13.5, 13.5))

        stroke = Gsk.Stroke.new(max(1.4, 1.9 * scale))
        stroke.set_line_cap(Gsk.LineCap.ROUND)
        stroke.set_line_join(Gsk.LineJoin.ROUND)
        snapshot.append_stroke(pb.to_path(), stroke, rgba(1, 1, 1, 1))
        snapshot.pop()


class AlbumCoverWidget(Gtk.Widget):
    """Pure GTK4/GSK luminous abstract album cover for audio/video items."""

    PALETTES = (
        ((0.208, 0.282, 0.443), (0.698, 0.780, 0.906), (0.973, 0.851, 0.839)),
        ((0.192, 0.204, 0.322), (0.569, 0.533, 0.776), (0.902, 0.780, 0.937)),
        ((0.137, 0.341, 0.373), (0.604, 0.804, 0.800), (0.890, 0.914, 0.776)),
    )

    def __init__(self, seed_index: int = 0, badge_text: str = "LUMEN", size: int = 164) -> None:
        super().__init__()
        self._seed_index = seed_index
        self._badge_text = badge_text
        self._radius = 16.0
        if size > 0:
            self.set_size_request(size, size)

    def configure(self, seed_index: int, badge_text: str, radius: float = 16.0) -> None:
        self._seed_index = seed_index
        self._badge_text = badge_text
        self._radius = radius
        self.queue_draw()

    def do_snapshot(self, snapshot: Gtk.Snapshot) -> None:
        w = max(1, self.get_width())
        h = max(1, self.get_height())
        rect = Graphene.Rect().init(0, 0, w, h)
        rrect = Gsk.RoundedRect()
        rrect.init_from_rect(rect, min(self._radius, min(w, h) * 0.25))
        snapshot.push_rounded_clip(rrect)

        c0, c1, c2 = self.PALETTES[abs(self._seed_index) % len(self.PALETTES)]
        snapshot.append_linear_gradient(
            rect,
            Graphene.Point().init(0, 0),
            Graphene.Point().init(w, h),
            [make_color_stop(0.0, rgba(*c0, 1.0)), make_color_stop(1.0, rgba(*c1, 1.0))],
        )

        glow_cx, glow_cy = w * 0.66, h * 0.32
        rad = max(w, h) * 0.48
        snapshot.append_radial_gradient(
            rect,
            Graphene.Point().init(glow_cx, glow_cy),
            rad,
            rad,
            0.0,
            1.0,
            [make_color_stop(0.0, rgba(*c2, 0.72)), make_color_stop(1.0, rgba(*c1, 0.0))],
        )

        cx, cy = w / 2.0, h / 2.0
        unit = min(w, h) / 220.0
        ring_color = rgba(*c2, 0.52)
        stroke = Gsk.Stroke.new(max(0.65, unit * 0.85))
        for j in range(12):
            ang = math.radians(j * 11 + self._seed_index * 22)
            rx = (26.0 + j * 5.2) * unit
            ry = (12.0 + j * 3.1) * unit
            ca, sa = math.cos(ang), math.sin(ang)
            pb = Gsk.PathBuilder.new()
            steps = 28
            for k in range(steps + 1):
                theta = 2.0 * math.pi * k / steps
                lx = rx * math.cos(theta)
                ly = ry * math.sin(theta)
                px = cx + lx * ca - ly * sa
                py = cy + lx * sa + ly * ca
                if k == 0:
                    pb.move_to(px, py)
                else:
                    pb.line_to(px, py)
            pb.close()
            snapshot.append_stroke(pb.to_path(), stroke, ring_color)

        orb_r = 16.0 * unit
        orb_pb = Gsk.PathBuilder.new()
        orb_pb.add_circle(Graphene.Point().init(cx, cy), orb_r)
        snapshot.append_fill(orb_pb.to_path(), Gsk.FillRule.WINDING, rgba(*c2, 0.84))

        if self._badge_text and w >= 72:
            layout = self.create_pango_layout(self._badge_text)
            font_sz = max(8, int(round(10 * unit)))
            layout.set_font_description(Pango.FontDescription.from_string(f"Monospace Bold {font_sz}"))
            snapshot.save()
            snapshot.translate(Graphene.Point().init(12.0 * unit, h - 22.0 * unit))
            snapshot.append_layout(layout, rgba(1, 1, 1, 0.88))
            snapshot.restore()

        snapshot.pop()


class ColorSwatchWidget(Gtk.Widget):
    """Pure GTK4/GSK rounded color swatch tile."""

    def __init__(self, hex_color: str = "#546de1", radius: float = 14.0, label: str = "") -> None:
        super().__init__()
        self._color = rgba_hex(hex_color, 1.0)
        self._radius = radius
        self._label = label

    def set_swatch(self, r: float, g: float, b: float, a: float = 1.0, label: str = "") -> None:
        self._color = rgba(r, g, b, a)
        self._label = label
        self.queue_draw()

    def do_snapshot(self, snapshot: Gtk.Snapshot) -> None:
        w = max(1, self.get_width())
        h = max(1, self.get_height())
        rect = Graphene.Rect().init(0, 0, w, h)
        rrect = Gsk.RoundedRect()
        rrect.init_from_rect(rect, self._radius)
        snapshot.push_rounded_clip(rrect)
        snapshot.append_color(self._color, rect)
        if self._label:
            lum = 0.299 * self._color.red + 0.587 * self._color.green + 0.114 * self._color.blue
            fg = rgba(0.10, 0.14, 0.22, 0.92) if lum > 0.72 else rgba(1, 1, 1, 0.94)
            layout = self.create_pango_layout(self._label)
            font_sz = 16 if h >= 140 else 10
            layout.set_font_description(Pango.FontDescription.from_string(f"Monospace Bold {font_sz}"))
            _, logical = layout.get_pixel_extents()
            snapshot.save()
            snapshot.translate(Graphene.Point().init(12.0, max(6.0, h - logical.height - 10.0)))
            snapshot.append_layout(layout, fg)
            snapshot.restore()
        snapshot.pop()
        border_c = rgba(1, 1, 1, 0.28)
        snapshot.append_border(rrect, [1.0, 1.0, 1.0, 1.0], [border_c, border_c, border_c, border_c])


class MiniOrbitPreviewWidget(Gtk.Widget):
    """Settings visual hero showing miniature Orbit translucent glass cards."""

    def __init__(self) -> None:
        super().__init__()
        self.set_size_request(-1, 134)
        self.set_hexpand(True)

    def do_snapshot(self, snapshot: Gtk.Snapshot) -> None:
        w = max(1, self.get_width())
        h = max(1, self.get_height())
        rect = Graphene.Rect().init(0, 0, w, h)
        rrect = Gsk.RoundedRect()
        rrect.init_from_rect(rect, 13.0)
        snapshot.push_rounded_clip(rrect)

        snapshot.append_linear_gradient(
            rect,
            Graphene.Point().init(0, 0),
            Graphene.Point().init(w, h),
            [
                make_color_stop(0.0, rgba(0.090, 0.149, 0.255, 1.0)),
                make_color_stop(0.58, rgba(0.333, 0.447, 0.643, 1.0)),
                make_color_stop(1.0, rgba(0.557, 0.510, 0.714, 1.0)),
            ],
        )

        layout = self.create_pango_layout("ORBIT / LIVE MATERIAL")
        layout.set_font_description(Pango.FontDescription.from_string("Monospace Bold 9"))
        snapshot.save()
        snapshot.translate(Graphene.Point().init(16.0, 12.0))
        snapshot.append_layout(layout, rgba(1, 1, 1, 0.74))
        snapshot.restore()

        card_count = 5
        card_w = 68.0
        card_h = 72.0
        gap = 10.0
        total_w = card_count * card_w + (card_count - 1) * gap
        start_x = (w - total_w) / 2.0
        for i in range(card_count):
            is_center = i == 2
            x = start_x + i * (card_w + gap)
            y = (h - card_h - 22.0) if is_center else (h - card_h - 12.0)
            crect = Graphene.Rect().init(x, y, card_w, card_h)
            crrect = Gsk.RoundedRect()
            crrect.init_from_rect(crect, 10.0)
            snapshot.push_rounded_clip(crrect)
            snapshot.append_color(rgba(1, 1, 1, 0.36 if is_center else 0.20), crect)
            snapshot.pop()
            bc = rgba(1, 1, 1, 0.92 if is_center else 0.45)
            bw = 1.5 if is_center else 1.0
            snapshot.append_border(crrect, [bw, bw, bw, bw], [bc, bc, bc, bc])

        snapshot.pop()


class ToastBannerWidget(Gtk.Revealer):
    """Compact floating toast pill with optional inline Undo button."""

    def __init__(self, on_undo: Optional[Callable[[], None]] = None) -> None:
        super().__init__()
        self._on_undo = on_undo
        self._hide_source_id = 0
        self.set_transition_type(Gtk.RevealerTransitionType.CROSSFADE)
        self.set_transition_duration(180)
        self.set_halign(Gtk.Align.CENTER)
        self.set_valign(Gtk.Align.START)
        self.set_margin_top(12)
        self.set_can_target(True)
        self.set_reveal_child(False)

        box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=10)
        box.add_css_class("lumen-toast")

        self._label = Gtk.Label(label="")
        self._undo_btn = Gtk.Button(label="撤销")
        self._undo_btn.add_css_class("lumen-toast-undo")
        self._undo_btn.connect("clicked", self._handle_undo)
        self._undo_btn.set_visible(False)

        box.append(self._label)
        box.append(self._undo_btn)
        self.set_child(box)

    def show_message(self, message: str, show_undo: bool = False, motion_enabled: bool = True) -> None:
        if self._hide_source_id:
            GLib.source_remove(self._hide_source_id)
            self._hide_source_id = 0
        self._label.set_text(message)
        self._undo_btn.set_visible(show_undo)
        self.set_transition_duration(180 if motion_enabled else 10)
        self.set_reveal_child(True)

        def _auto_hide() -> bool:
            self._hide_source_id = 0
            self.set_reveal_child(False)
            return False

        self._hide_source_id = GLib.timeout_add(3200, _auto_hide)

    def _handle_undo(self, _btn: Gtk.Button) -> None:
        if self._hide_source_id:
            GLib.source_remove(self._hide_source_id)
            self._hide_source_id = 0
        self.set_reveal_child(False)
        if self._on_undo is not None:
            self._on_undo()
