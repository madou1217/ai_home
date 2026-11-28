"""Runtime capability probing for optional GTK4/Linux native libraries.

Core requirements are GTK 4.0 + PyGObject. Optional native integrations
(libadwaita, gtk4-layer-shell, Poppler, GStreamer GI, GtkSourceView 5,
pycairo, X11) are detected gracefully at runtime without hard failures.
"""

from __future__ import annotations

import ctypes
import ctypes.util
import shutil
from dataclasses import dataclass
from typing import Any, Optional

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Gdk", "4.0")
gi.require_version("Gio", "2.0")
gi.require_version("GLib", "2.0")
gi.require_version("Pango", "1.0")
gi.require_version("GdkPixbuf", "2.0")

from gi.repository import Gdk, GdkPixbuf, Gio, GLib, Gtk, Pango  # noqa: E402


def _try_import_gi(namespace: str, version: str) -> Optional[Any]:
    try:
        gi.require_version(namespace, version)
        return __import__(f"gi.repository.{namespace}", fromlist=[namespace])
    except Exception:
        return None


def _try_import_module(name: str) -> Optional[Any]:
    try:
        return __import__(name)
    except Exception:
        return None


def _try_load_cdll(candidates: tuple[str, ...]) -> Optional[ctypes.CDLL]:
    for name in candidates:
        try:
            return ctypes.CDLL(name)
        except OSError:
            continue
    return None


Adw = _try_import_gi("Adw", "1")
Gtk4LayerShell = _try_import_gi("Gtk4LayerShell", "1.0")
Poppler = _try_import_gi("Poppler", "0.18")
Gst = _try_import_gi("Gst", "1.0")
GtkSource = _try_import_gi("GtkSource", "5")
GdkX11 = _try_import_gi("GdkX11", "4.0")
GdkWayland = _try_import_gi("GdkWayland", "4.0")
pycairo = _try_import_module("cairo")

_layer_shell_cdll = None if Gtk4LayerShell is not None else _try_load_cdll(
    ("libgtk4-layer-shell.so.0", "libgtk4-layer-shell.so")
)
_x11_cdll = _try_load_cdll(("libX11.so.6", "libX11.so"))

if Gst is not None:
    try:
        Gst.init(None)
    except Exception:
        Gst = None


@dataclass(frozen=True)
class RuntimeCapabilities:
    gtk_version: str
    has_adwaita: bool
    has_layer_shell_gi: bool
    has_layer_shell_ctypes: bool
    has_poppler_gi: bool
    has_pycairo: bool
    has_pdftoppm: bool
    has_gst_gi: bool
    has_gtk_media_file: bool
    has_gtksource: bool
    has_gdk_x11: bool
    has_gdk_wayland: bool
    has_libx11: bool

    @property
    def has_layer_shell(self) -> bool:
        return self.has_layer_shell_gi or self.has_layer_shell_ctypes

    @property
    def can_render_pdf_pages(self) -> bool:
        return (self.has_poppler_gi and self.has_pycairo) or self.has_pdftoppm

    def summary_lines(self) -> list[str]:
        return [
            f"GTK {self.gtk_version}",
            f"Adwaita: {'yes' if self.has_adwaita else 'fallback(GTK4)'}",
            f"LayerShell: {'GI' if self.has_layer_shell_gi else ('ctypes' if self.has_layer_shell_ctypes else 'X11-fallback')}",
            f"Poppler: {'GI+Cairo' if (self.has_poppler_gi and self.has_pycairo) else ('pdftoppm' if self.has_pdftoppm else 'graceful-fallback')}",
            f"Media: {'Gst+GtkVideo' if self.has_gst_gi else ('GtkGstMediaFile' if self.has_gtk_media_file else 'fallback')}",
            f"Code: {'GtkSourceView5' if self.has_gtksource else 'Pango-Tokenizer'}",
        ]


def probe_capabilities() -> RuntimeCapabilities:
    gtk_ver = f"{Gtk.get_major_version()}.{Gtk.get_minor_version()}.{Gtk.get_micro_version()}"
    has_media = hasattr(Gtk, "MediaFile") and hasattr(Gtk, "Video")
    return RuntimeCapabilities(
        gtk_version=gtk_ver,
        has_adwaita=Adw is not None,
        has_layer_shell_gi=Gtk4LayerShell is not None,
        has_layer_shell_ctypes=_layer_shell_cdll is not None,
        has_poppler_gi=Poppler is not None,
        has_pycairo=pycairo is not None,
        has_pdftoppm=shutil.which("pdftoppm") is not None,
        has_gst_gi=Gst is not None,
        has_gtk_media_file=has_media,
        has_gtksource=GtkSource is not None,
        has_gdk_x11=GdkX11 is not None,
        has_gdk_wayland=GdkWayland is not None,
        has_libx11=_x11_cdll is not None,
    )


def get_layer_shell_cdll() -> Optional[ctypes.CDLL]:
    return _layer_shell_cdll


def get_x11_cdll() -> Optional[ctypes.CDLL]:
    return _x11_cdll


CAPABILITIES = probe_capabilities()

__all__ = [
    "Adw",
    "CAPABILITIES",
    "Gdk",
    "GdkPixbuf",
    "GdkWayland",
    "GdkX11",
    "Gio",
    "GLib",
    "Gst",
    "Gtk",
    "Gtk4LayerShell",
    "GtkSource",
    "Pango",
    "Poppler",
    "RuntimeCapabilities",
    "get_layer_shell_cdll",
    "get_x11_cdll",
    "probe_capabilities",
    "pycairo",
]
