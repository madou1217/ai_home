"""Linux Wayland (gtk4-layer-shell) & X11 (EWMH/libX11) edge-rail integration.

Provides:
1. Wayland `gtk4-layer-shell` overlay surface anchoring (`bottom` | `left` | `right`,
   `LAYER_OVERLAY`, exclusive zone `0`, on-demand keyboard focus) via GI or ctypes.
2. X11 undecorated keep-above skip-taskbar fallback using `GdkX11` + `libX11`
   (`_NET_WORKAREA` / multi-monitor lowest-band geometry, `_NET_WM_STATE_ABOVE`,
   `_NET_WM_STATE_SKIP_TASKBAR`, `_NET_WM_STATE_SKIP_PAGER`, `_NET_WM_STATE_STICKY`).
3. Foreground OS focus capture (`_NET_ACTIVE_WINDOW`) before showing Orbit and
   restoration on paste or `Esc` dismiss.
"""

from __future__ import annotations

import ctypes
import os
from dataclasses import dataclass
from typing import Optional

from .capabilities import (
    Gdk,
    GdkWayland,
    GdkX11,
    Gtk,
    Gtk4LayerShell,
    get_layer_shell_cdll,
    get_x11_cdll,
)


@dataclass(frozen=True)
class RailGeometry:
    x: int
    y: int
    width: int
    height: int
    edge: str  # "bottom" | "left" | "right"


# GTK4 Layer Shell C enum values (gtk4-layer-shell.h)
_LS_LAYER_OVERLAY = 3
_LS_EDGE_LEFT = 0
_LS_EDGE_RIGHT = 1
_LS_EDGE_TOP = 2
_LS_EDGE_BOTTOM = 3
_LS_KEYBOARD_NONE = 0
_LS_KEYBOARD_EXCLUSIVE = 1
_LS_KEYBOARD_ON_DEMAND = 2


class _X11ClientMessageData(ctypes.Union):
    _fields_ = [("b", ctypes.c_char * 20), ("s", ctypes.c_short * 10), ("l", ctypes.c_long * 5)]


class _XClientMessageEvent(ctypes.Structure):
    _fields_ = [
        ("type", ctypes.c_int),
        ("serial", ctypes.c_ulong),
        ("send_event", ctypes.c_int),
        ("display", ctypes.c_void_p),
        ("window", ctypes.c_ulong),
        ("message_type", ctypes.c_ulong),
        ("format", ctypes.c_int),
        ("data", _X11ClientMessageData),
    ]


class _XEvent(ctypes.Union):
    _fields_ = [("xclient", _XClientMessageEvent), ("pad", ctypes.c_long * 24)]


class X11Helper:
    """Thin, safe ctypes wrapper over libX11 for EWMH state, geometry, and focus."""

    _CLIENT_MESSAGE = 33
    _SUBSTRUCTURE_REDIRECT_MASK = 1 << 20
    _SUBSTRUCTURE_NOTIFY_MASK = 1 << 19
    _PROP_MODE_REPLACE = 0
    _ANY_PROPERTY_TYPE = 0
    _XA_ATOM = 4
    _XA_CARDINAL = 6
    _XA_WINDOW = 33
    _REVERT_TO_POINTER_ROOT = 1
    _CURRENT_TIME = 0

    def __init__(self) -> None:
        self._lib = get_x11_cdll()
        self._ready = False
        if self._lib is None:
            return
        try:
            self._lib.XOpenDisplay.argtypes = [ctypes.c_char_p]
            self._lib.XOpenDisplay.restype = ctypes.c_void_p
            self._lib.XCloseDisplay.argtypes = [ctypes.c_void_p]
            self._lib.XCloseDisplay.restype = ctypes.c_int
            self._lib.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
            self._lib.XDefaultRootWindow.restype = ctypes.c_ulong
            self._lib.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
            self._lib.XInternAtom.restype = ctypes.c_ulong
            self._lib.XGetWindowProperty.argtypes = [
                ctypes.c_void_p,
                ctypes.c_ulong,
                ctypes.c_ulong,
                ctypes.c_long,
                ctypes.c_long,
                ctypes.c_int,
                ctypes.c_ulong,
                ctypes.POINTER(ctypes.c_ulong),
                ctypes.POINTER(ctypes.c_int),
                ctypes.POINTER(ctypes.c_ulong),
                ctypes.POINTER(ctypes.c_ulong),
                ctypes.POINTER(ctypes.c_void_p),
            ]
            self._lib.XGetWindowProperty.restype = ctypes.c_int
            self._lib.XChangeProperty.argtypes = [
                ctypes.c_void_p,
                ctypes.c_ulong,
                ctypes.c_ulong,
                ctypes.c_ulong,
                ctypes.c_int,
                ctypes.c_int,
                ctypes.c_void_p,
                ctypes.c_int,
            ]
            self._lib.XChangeProperty.restype = ctypes.c_int
            self._lib.XSendEvent.argtypes = [
                ctypes.c_void_p,
                ctypes.c_ulong,
                ctypes.c_int,
                ctypes.c_long,
                ctypes.POINTER(_XEvent),
            ]
            self._lib.XSendEvent.restype = ctypes.c_int
            self._lib.XMoveResizeWindow.argtypes = [
                ctypes.c_void_p,
                ctypes.c_ulong,
                ctypes.c_int,
                ctypes.c_int,
                ctypes.c_uint,
                ctypes.c_uint,
            ]
            self._lib.XMoveResizeWindow.restype = ctypes.c_int
            self._lib.XSetInputFocus.argtypes = [
                ctypes.c_void_p,
                ctypes.c_ulong,
                ctypes.c_int,
                ctypes.c_ulong,
            ]
            self._lib.XSetInputFocus.restype = ctypes.c_int
            self._lib.XRaiseWindow.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
            self._lib.XRaiseWindow.restype = ctypes.c_int
            self._lib.XFlush.argtypes = [ctypes.c_void_p]
            self._lib.XFlush.restype = ctypes.c_int
            self._lib.XFree.argtypes = [ctypes.c_void_p]
            self._lib.XFree.restype = ctypes.c_int
            self._ready = True
        except Exception:
            self._ready = False

    def _open_display(self) -> Optional[int]:
        if not self._ready or self._lib is None:
            return None
        if not os.environ.get("DISPLAY"):
            return None
        try:
            dpy = self._lib.XOpenDisplay(None)
            return int(dpy) if dpy else None
        except Exception:
            return None

    def get_workarea(self) -> Optional[tuple[int, int, int, int]]:
        dpy = self._open_display()
        if not dpy or self._lib is None:
            return None
        try:
            root = self._lib.XDefaultRootWindow(dpy)
            atom = self._lib.XInternAtom(dpy, b"_NET_WORKAREA", 0)
            if not atom:
                return None
            actual_type = ctypes.c_ulong()
            actual_format = ctypes.c_int()
            nitems = ctypes.c_ulong()
            bytes_after = ctypes.c_ulong()
            prop = ctypes.c_void_p()
            status = self._lib.XGetWindowProperty(
                dpy,
                root,
                atom,
                0,
                4,
                0,
                self._XA_CARDINAL,
                ctypes.byref(actual_type),
                ctypes.byref(actual_format),
                ctypes.byref(nitems),
                ctypes.byref(bytes_after),
                ctypes.byref(prop),
            )
            if status == 0 and prop.value and nitems.value >= 4:
                vals = ctypes.cast(prop.value, ctypes.POINTER(ctypes.c_long))
                res = (int(vals[0]), int(vals[1]), int(vals[2]), int(vals[3]))
                self._lib.XFree(prop)
                if res[2] > 0 and res[3] > 0:
                    return res
            if prop.value:
                self._lib.XFree(prop)
            return None
        except Exception:
            return None
        finally:
            try:
                self._lib.XCloseDisplay(dpy)
            except Exception:
                pass

    def get_active_window(self) -> Optional[int]:
        dpy = self._open_display()
        if not dpy or self._lib is None:
            return None
        try:
            root = self._lib.XDefaultRootWindow(dpy)
            atom = self._lib.XInternAtom(dpy, b"_NET_ACTIVE_WINDOW", 0)
            if not atom:
                return None
            actual_type = ctypes.c_ulong()
            actual_format = ctypes.c_int()
            nitems = ctypes.c_ulong()
            bytes_after = ctypes.c_ulong()
            prop = ctypes.c_void_p()
            status = self._lib.XGetWindowProperty(
                dpy,
                root,
                atom,
                0,
                1,
                0,
                self._XA_WINDOW,
                ctypes.byref(actual_type),
                ctypes.byref(actual_format),
                ctypes.byref(nitems),
                ctypes.byref(bytes_after),
                ctypes.byref(prop),
            )
            xid: Optional[int] = None
            if status == 0 and prop.value and nitems.value >= 1:
                xid = int(ctypes.cast(prop.value, ctypes.POINTER(ctypes.c_ulong))[0])
            if prop.value:
                self._lib.XFree(prop)
            return xid if xid and xid > 0 else None
        except Exception:
            return None
        finally:
            try:
                self._lib.XCloseDisplay(dpy)
            except Exception:
                pass

    def restore_active_window(self, target_xid: int) -> bool:
        if not target_xid or target_xid <= 0:
            return False
        dpy = self._open_display()
        if not dpy or self._lib is None:
            return False
        try:
            root = self._lib.XDefaultRootWindow(dpy)
            atom = self._lib.XInternAtom(dpy, b"_NET_ACTIVE_WINDOW", 0)
            if atom:
                ev = _XEvent()
                ev.xclient.type = self._CLIENT_MESSAGE
                ev.xclient.window = target_xid
                ev.xclient.message_type = atom
                ev.xclient.format = 32
                ev.xclient.data.l[0] = 2  # pager/client request
                ev.xclient.data.l[1] = self._CURRENT_TIME
                ev.xclient.data.l[2] = 0
                self._lib.XSendEvent(
                    dpy,
                    root,
                    0,
                    self._SUBSTRUCTURE_REDIRECT_MASK | self._SUBSTRUCTURE_NOTIFY_MASK,
                    ctypes.byref(ev),
                )
            self._lib.XSetInputFocus(dpy, target_xid, self._REVERT_TO_POINTER_ROOT, self._CURRENT_TIME)
            self._lib.XFlush(dpy)
            return True
        except Exception:
            return False
        finally:
            try:
                self._lib.XCloseDisplay(dpy)
            except Exception:
                pass

    def configure_floating_rail(self, xid: int, geom: RailGeometry) -> bool:
        """Applies EWMH keep-above + skip-taskbar/pager + sticky + edge placement."""
        if not xid or xid <= 0:
            return False
        dpy = self._open_display()
        if not dpy or self._lib is None:
            return False
        try:
            root = self._lib.XDefaultRootWindow(dpy)
            wm_state = self._lib.XInternAtom(dpy, b"_NET_WM_STATE", 0)
            states = [
                self._lib.XInternAtom(dpy, b"_NET_WM_STATE_ABOVE", 0),
                self._lib.XInternAtom(dpy, b"_NET_WM_STATE_SKIP_TASKBAR", 0),
                self._lib.XInternAtom(dpy, b"_NET_WM_STATE_SKIP_PAGER", 0),
                self._lib.XInternAtom(dpy, b"_NET_WM_STATE_STICKY", 0),
            ]
            valid_states = [s for s in states if s]
            if wm_state and valid_states:
                arr = (ctypes.c_ulong * len(valid_states))(*valid_states)
                self._lib.XChangeProperty(
                    dpy,
                    xid,
                    wm_state,
                    self._XA_ATOM,
                    32,
                    self._PROP_MODE_REPLACE,
                    arr,
                    len(valid_states),
                )
                # Also send EWMH ClientMessage pairs for WMs that ignore pre-map property writes.
                for idx in range(0, len(valid_states), 2):
                    ev = _XEvent()
                    ev.xclient.type = self._CLIENT_MESSAGE
                    ev.xclient.window = xid
                    ev.xclient.message_type = wm_state
                    ev.xclient.format = 32
                    ev.xclient.data.l[0] = 1  # _NET_WM_STATE_ADD
                    ev.xclient.data.l[1] = valid_states[idx]
                    ev.xclient.data.l[2] = valid_states[idx + 1] if idx + 1 < len(valid_states) else 0
                    ev.xclient.data.l[3] = 2
                    self._lib.XSendEvent(
                        dpy,
                        root,
                        0,
                        self._SUBSTRUCTURE_REDIRECT_MASK | self._SUBSTRUCTURE_NOTIFY_MASK,
                        ctypes.byref(ev),
                    )

            wm_type = self._lib.XInternAtom(dpy, b"_NET_WM_WINDOW_TYPE", 0)
            type_utility = self._lib.XInternAtom(dpy, b"_NET_WM_WINDOW_TYPE_UTILITY", 0)
            if wm_type and type_utility:
                t_arr = (ctypes.c_ulong * 1)(type_utility)
                self._lib.XChangeProperty(
                    dpy,
                    xid,
                    wm_type,
                    self._XA_ATOM,
                    32,
                    self._PROP_MODE_REPLACE,
                    t_arr,
                    1,
                )

            self._lib.XMoveResizeWindow(
                dpy,
                xid,
                int(geom.x),
                int(geom.y),
                max(100, int(geom.width)),
                max(100, int(geom.height)),
            )
            self._lib.XRaiseWindow(dpy, xid)
            self._lib.XFlush(dpy)
            return True
        except Exception:
            return False
        finally:
            try:
                self._lib.XCloseDisplay(dpy)
            except Exception:
                pass


class PlatformOrbitWindowHelper:
    """Selects gtk4-layer-shell (Wayland) or EWMH X11 edge-rail integration."""

    def __init__(self) -> None:
        self._x11 = X11Helper()
        self._layer_shell_initialized = False
        self._saved_focus_xid: Optional[int] = None
        self._own_xids: set[int] = set()
        self._backend_name = "generic-gtk4"

    @property
    def backend_name(self) -> str:
        return self._backend_name

    @staticmethod
    def is_wayland_display() -> bool:
        display = Gdk.Display.get_default()
        if display is None:
            return False
        if GdkWayland is not None:
            try:
                return isinstance(display, GdkWayland.WaylandDisplay)
            except Exception:
                pass
        return "wayland" in type(display).__name__.lower()

    @staticmethod
    def is_x11_display() -> bool:
        display = Gdk.Display.get_default()
        if display is None:
            return False
        if GdkX11 is not None:
            try:
                return isinstance(display, GdkX11.X11Display)
            except Exception:
                pass
        return "x11" in type(display).__name__.lower()

    @staticmethod
    def window_xid(window: Gtk.Window) -> Optional[int]:
        surface = window.get_surface()
        if surface is None:
            return None
        if GdkX11 is not None and isinstance(surface, GdkX11.X11Surface):
            try:
                return int(surface.get_xid())
            except Exception:
                return None
        if hasattr(surface, "get_xid"):
            try:
                return int(surface.get_xid())
            except Exception:
                return None
        return None

    def register_own_window(self, window: Gtk.Window) -> None:
        xid = self.window_xid(window)
        if xid:
            self._own_xids.add(xid)

    def capture_foreground_focus(self, own_windows: list[Gtk.Window]) -> None:
        for w in own_windows:
            self.register_own_window(w)
        if self.is_x11_display():
            active = self._x11.get_active_window()
            if active and active not in self._own_xids:
                self._saved_focus_xid = active

    def restore_foreground_focus(self) -> bool:
        xid = self._saved_focus_xid
        self._saved_focus_xid = None
        if xid and self.is_x11_display():
            return self._x11.restore_active_window(xid)
        return False

    def compute_rail_geometry(self, edge: str) -> RailGeometry:
        norm = edge if edge in ("bottom", "left", "right") else "bottom"
        display = Gdk.Display.get_default()
        rects: list[tuple[int, int, int, int]] = []
        if display is not None:
            monitors = display.get_monitors()
            for i in range(monitors.get_n_items()):
                mon = monitors.get_item(i)
                if mon is not None:
                    g = mon.get_geometry()
                    rects.append((int(g.x), int(g.y), int(g.width), int(g.height)))

        workarea = self._x11.get_workarea() if self.is_x11_display() else None
        if not rects:
            if workarea:
                rects.append(workarea)
            else:
                rects.append((0, 0, 1280, 800))

        primary = rects[0]
        if norm in ("left", "right"):
            wx, wy, ww, wh = workarea if workarea else primary
            width = int(min(278, max(236, round(ww * 0.19))))
            x = wx if norm == "left" else (wx + ww - width)
            return RailGeometry(x=x, y=wy, width=width, height=wh, edge=norm)

        # Bottom continuous rail: span lowest horizontal band across monitors.
        if len(rects) > 1:
            max_bottom = max(r[1] + r[3] for r in rects)
            bottom_band = [r for r in rects if abs((r[1] + r[3]) - max_bottom) <= 80]
            min_x = min(r[0] for r in bottom_band)
            max_x = max(r[0] + r[2] for r in bottom_band)
            min_h = min(r[3] for r in bottom_band)
            height = int(min(292, max(232, round(min_h * 0.29))))
            y = max_bottom - height
            if workarea:
                wa_bottom = workarea[1] + workarea[3]
                if abs(wa_bottom - max_bottom) <= 96:
                    y = wa_bottom - height
            return RailGeometry(x=min_x, y=max(0, y), width=max(400, max_x - min_x), height=height, edge="bottom")

        wx, wy, ww, wh = workarea if workarea else primary
        height = int(min(292, max(232, round(wh * 0.29))))
        return RailGeometry(x=wx, y=max(0, wy + wh - height), width=ww, height=height, edge="bottom")

    def prepare_before_realize(self, window: Gtk.Window, edge: str) -> bool:
        """Initializes gtk4-layer-shell before window realization when on Wayland."""
        window.set_decorated(False)
        window.set_resizable(False)
        if not self.is_wayland_display():
            self._backend_name = "x11-ewmh" if self.is_x11_display() else "gtk4-undecorated"
            return False

        if Gtk4LayerShell is not None:
            try:
                if Gtk4LayerShell.is_supported():
                    if not self._layer_shell_initialized:
                        Gtk4LayerShell.init_for_window(window)
                        Gtk4LayerShell.set_namespace(window, "lumen-orbit")
                        Gtk4LayerShell.set_layer(window, Gtk4LayerShell.Layer.OVERLAY)
                        Gtk4LayerShell.set_exclusive_zone(window, 0)
                        Gtk4LayerShell.set_keyboard_mode(window, Gtk4LayerShell.KeyboardMode.ON_DEMAND)
                        self._layer_shell_initialized = True
                    self._apply_layer_shell_anchors_gi(window, edge)
                    self._backend_name = "wayland-layer-shell-gi"
                    return True
            except Exception:
                pass

        cdll = get_layer_shell_cdll()
        if cdll is not None:
            try:
                cdll.gtk_layer_is_supported.restype = ctypes.c_int
                if cdll.gtk_layer_is_supported():
                    ptr = hash(window)
                    # Note: ctypes needs raw C GObject pointer if GI typelib isn't available;
                    # only invoke if PyGObject exposes __gpointer__ cleanly.
                    raw_ptr = getattr(window, "__gpointer__", None)
                    if raw_ptr is not None:
                        win_ptr = ctypes.c_void_p(int(raw_ptr))
                        if not self._layer_shell_initialized:
                            cdll.gtk_layer_init_for_window(win_ptr)
                            cdll.gtk_layer_set_namespace(win_ptr, b"lumen-orbit")
                            cdll.gtk_layer_set_layer(win_ptr, _LS_LAYER_OVERLAY)
                            cdll.gtk_layer_set_exclusive_zone(win_ptr, 0)
                            cdll.gtk_layer_set_keyboard_mode(win_ptr, _LS_KEYBOARD_ON_DEMAND)
                            self._layer_shell_initialized = True
                        self._apply_layer_shell_anchors_ctypes(cdll, win_ptr, edge)
                        self._backend_name = "wayland-layer-shell-ctypes"
                        return True
                    _ = ptr
            except Exception:
                pass

        self._backend_name = "wayland-fallback"
        return False

    def _apply_layer_shell_anchors_gi(self, window: Gtk.Window, edge: str) -> None:
        assert Gtk4LayerShell is not None
        e_left = Gtk4LayerShell.Edge.LEFT
        e_right = Gtk4LayerShell.Edge.RIGHT
        e_top = Gtk4LayerShell.Edge.TOP
        e_bottom = Gtk4LayerShell.Edge.BOTTOM
        if edge == "left":
            anchors = {e_left: True, e_right: False, e_top: True, e_bottom: True}
        elif edge == "right":
            anchors = {e_left: False, e_right: True, e_top: True, e_bottom: True}
        else:
            anchors = {e_left: True, e_right: True, e_top: False, e_bottom: True}
        for anchor, val in anchors.items():
            Gtk4LayerShell.set_anchor(window, anchor, val)

    def _apply_layer_shell_anchors_ctypes(self, cdll: ctypes.CDLL, win_ptr: ctypes.c_void_p, edge: str) -> None:
        if edge == "left":
            anchors = {_LS_EDGE_LEFT: 1, _LS_EDGE_RIGHT: 0, _LS_EDGE_TOP: 1, _LS_EDGE_BOTTOM: 1}
        elif edge == "right":
            anchors = {_LS_EDGE_LEFT: 0, _LS_EDGE_RIGHT: 1, _LS_EDGE_TOP: 1, _LS_EDGE_BOTTOM: 1}
        else:
            anchors = {_LS_EDGE_LEFT: 1, _LS_EDGE_RIGHT: 1, _LS_EDGE_TOP: 0, _LS_EDGE_BOTTOM: 1}
        for anchor, val in anchors.items():
            cdll.gtk_layer_set_anchor(win_ptr, anchor, val)

    def apply_geometry_and_flags(self, window: Gtk.Window, edge: str) -> RailGeometry:
        geom = self.compute_rail_geometry(edge)
        if self._layer_shell_initialized:
            if edge in ("left", "right"):
                window.set_default_size(geom.width, -1)
                window.set_size_request(geom.width, -1)
            else:
                window.set_default_size(-1, geom.height)
                window.set_size_request(-1, geom.height)
            if Gtk4LayerShell is not None:
                try:
                    self._apply_layer_shell_anchors_gi(window, edge)
                except Exception:
                    pass
            return geom

        window.set_default_size(geom.width, geom.height)
        window.set_size_request(geom.width, geom.height)
        if self.is_x11_display():
            xid = self.window_xid(window)
            if xid:
                self._own_xids.add(xid)
                self._x11.configure_floating_rail(xid, geom)
        return geom
