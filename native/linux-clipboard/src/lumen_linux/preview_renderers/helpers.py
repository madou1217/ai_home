"""Shared toolbar and OS desktop launcher helpers for GTK4 preview renderers."""

from __future__ import annotations

import os
import subprocess
from typing import Callable, Optional

from ..capabilities import Gio, GLib, Gtk


def make_renderer_toolbar(dark_override: bool = False) -> tuple[Gtk.Box, Gtk.Label, Gtk.Box]:
    bar = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
    bar.add_css_class("lumen-renderer-toolbar")
    if dark_override:
        bar.add_css_class("lumen-code-toolbar")
    bar.set_hexpand(True)

    info_label = Gtk.Label(label="")
    info_label.set_xalign(0.0)
    info_label.set_ellipsize(3)  # Pango.EllipsizeMode.END
    info_label.set_hexpand(True)
    if not dark_override:
        info_label.add_css_class("lumen-muted")

    right_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
    right_box.set_valign(Gtk.Align.CENTER)

    bar.append(info_label)
    bar.append(right_box)
    return bar, info_label, right_box


def make_pill_button(
    label: str,
    on_click: Callable[[], None],
    dark: bool = False,
    tooltip: str = "",
) -> Gtk.Button:
    btn = Gtk.Button(label=label)
    btn.add_css_class("lumen-pill-btn")
    if dark:
        btn.add_css_class("lumen-code-pill")
    if tooltip:
        btn.set_tooltip_text(tooltip)
    btn.connect("clicked", lambda _b: on_click())
    return btn


def open_uri_external(uri: str, parent: Optional[Gtk.Window] = None) -> None:
    if not uri:
        return
    if hasattr(Gtk, "UriLauncher"):
        try:
            launcher = Gtk.UriLauncher.new(uri)
            launcher.launch(parent, None, None)
            return
        except Exception:
            pass
    try:
        Gio.AppInfo.launch_default_for_uri(uri, None)
    except Exception:
        try:
            subprocess.Popen(["xdg-open", uri], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except OSError:
            pass


def open_file_external(path: str, parent: Optional[Gtk.Window] = None) -> None:
    if not path or not os.path.exists(path):
        return
    gfile = Gio.File.new_for_path(path)
    if hasattr(Gtk, "FileLauncher"):
        try:
            launcher = Gtk.FileLauncher.new(gfile)
            launcher.launch(parent, None, None)
            return
        except Exception:
            pass
    open_uri_external(gfile.get_uri(), parent=parent)


def reveal_file_in_manager(path: str, parent: Optional[Gtk.Window] = None) -> None:
    """Reveals a file via freedesktop D-Bus FileManager1.ShowItems, falling back to parent folder."""
    if not path or not os.path.exists(path):
        return
    gfile = Gio.File.new_for_path(os.path.abspath(path))
    uri = gfile.get_uri()
    try:
        bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        bus.call_sync(
            "org.freedesktop.FileManager1",
            "/org/freedesktop/FileManager1",
            "org.freedesktop.FileManager1",
            "ShowItems",
            GLib.Variant("(ass)", ([uri], "")),
            None,
            Gio.DBusCallFlags.NONE,
            1200,
            None,
        )
        return
    except Exception:
        pass
    parent_dir = os.path.dirname(os.path.abspath(path))
    if os.path.isdir(parent_dir):
        open_uri_external(Gio.File.new_for_path(parent_dir).get_uri(), parent=parent)
