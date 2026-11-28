"""Paste Lumen V7 Linux Native Application entrypoint and IPC coordinator.

Hosts the three strictly separate native GTK4 surfaces sharing one reactive
`ClipboardStore`, one `PreviewRegistry`, and one `BoundedPreviewCache`:
1. `LumenWorkspaceWindow` (App Management Window)
2. `LumenOrbitWindow` (Separate floating screen-edge Orbit rail)
3. `LumenPreviewWindow` (Shared floating Quick Look preview window)
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import threading
from typing import Any, Optional

from . import APP_ID, __version__
from .api import ClipboardStore
from .capabilities import Adw, CAPABILITIES, Gio, GLib, Gtk
from .orbit_window import LumenOrbitWindow
from .preview_window import LumenPreviewWindow
from .theme import CssThemeManager
from .workspace_window import LumenWorkspaceWindow


_BaseApplication = Adw.Application if Adw is not None else Gtk.Application


def _build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="aih-lumen",
        description="Paste Lumen V7 — Native Linux GTK4/Adwaita Clipboard Client",
    )
    parser.add_argument("--app", "--workspace", action="store_true", help="Open App Management Window (default)")
    parser.add_argument("--orbit", action="store_true", help="Open separate Orbit screen-edge rail")
    parser.add_argument("--toggle-orbit", action="store_true", help="Toggle Orbit screen-edge rail")
    parser.add_argument("--both", action="store_true", help="Open both App Management Window and Orbit rail")
    parser.add_argument("--preview", nargs="+", metavar="FILE", help="Open shared native Quick Look on local files")
    parser.add_argument("--position", choices=["bottom", "left", "right"], help="Override Orbit edge anchor")
    parser.add_argument("--origin", default="", help="AIH Server origin URL (key read from env/IPC/aih.db)")
    parser.add_argument("--ipc", action="store_true", help="Read NDJSON control commands from stdin")
    parser.add_argument("--non-unique", action="store_true", help="Allow parallel isolated process instance")
    parser.add_argument("--capabilities", action="store_true", help="Print detected GTK4/Linux capabilities and exit")
    parser.add_argument("--version", action="version", version=f"aih-lumen {__version__}")
    return parser


class LumenLinuxApplication(_BaseApplication):
    def __init__(self, non_unique: bool = False) -> None:
        flags = Gio.ApplicationFlags.HANDLES_COMMAND_LINE
        if non_unique:
            flags |= Gio.ApplicationFlags.NON_UNIQUE
        super().__init__(application_id=APP_ID, flags=flags)
        self._store = ClipboardStore.shared()
        self._workspace: Optional[LumenWorkspaceWindow] = None
        self._orbit: Optional[LumenOrbitWindow] = None
        self._preview: Optional[LumenPreviewWindow] = None
        self._ipc_started = False
        self._holding = False

    def do_startup(self) -> None:
        _BaseApplication.do_startup(self)
        CssThemeManager.ensure_installed()

        for name, cb in (
            ("show-app", lambda _a, _p: self.show_app()),
            ("show-orbit", lambda _a, _p: self.show_orbit()),
            ("toggle-orbit", lambda _a, _p: self.toggle_orbit()),
            ("hide-orbit", lambda _a, _p: self.hide_orbit()),
            ("new-clip", lambda _a, _p: self.open_new_clip()),
            ("quit", lambda _a, _p: self._request_quit()),
        ):
            act = Gio.SimpleAction.new(name, None)
            act.connect("activate", cb)
            self.add_action(act)

    def _ensure_surfaces(self) -> None:
        if self._preview is None:
            self._preview = LumenPreviewWindow.shared(self)
        if self._workspace is None:
            self._workspace = LumenWorkspaceWindow(application=self)
            self._workspace.on_open_orbit = self.show_orbit
            self._workspace.on_quick_orbit_position_changed = self._on_orbit_position_changed
        if self._orbit is None:
            self._orbit = LumenOrbitWindow(application=self)
            self._orbit.on_open_workspace = self.show_app
            self._orbit.get_own_windows = self._own_windows

    def _own_windows(self) -> list[Gtk.Window]:
        wins: list[Gtk.Window] = []
        for w in (self._workspace, self._orbit, self._preview):
            if w is not None:
                wins.append(w)
        return wins

    def _on_orbit_position_changed(self, pos: str) -> None:
        if self._orbit is not None:
            self._orbit.set_edge_position(pos)

    def show_app(self) -> None:
        self._ensure_surfaces()
        assert self._workspace is not None
        self._workspace.show_workspace()

    def show_orbit(self) -> None:
        self._ensure_surfaces()
        assert self._orbit is not None
        self._orbit.show_rail()

    def toggle_orbit(self) -> None:
        self._ensure_surfaces()
        assert self._orbit is not None
        self._orbit.toggle_rail()

    def hide_orbit(self) -> None:
        if self._orbit is not None:
            self._orbit.hide_rail(restore_focus=True)

    def open_new_clip(self) -> None:
        self.show_app()
        assert self._workspace is not None
        self._workspace.open_new_clip_dialog()

    def do_activate(self) -> None:
        self._store.ensure_configured_from_local()
        self.show_app()

    def do_command_line(self, command_line: Gio.ApplicationCommandLine) -> int:
        argv = command_line.get_arguments()[1:]
        parser = _build_arg_parser()
        try:
            args = parser.parse_args(argv)
        except SystemExit as exc:
            return int(exc.code or 0)

        if args.origin:
            self._store.configure(origin=args.origin, management_key="")
        else:
            self._store.ensure_configured_from_local()

        self._ensure_surfaces()
        if args.position and self._orbit is not None:
            self._orbit.set_edge_position(args.position)

        if args.ipc and not self._ipc_started:
            self._ipc_started = True
            if not self._holding:
                self.hold()
                self._holding = True
            self._start_ipc_reader()

        if args.preview:
            assert self._preview is not None
            self._preview.present_local_files(args.preview)
            return 0

        if args.both:
            self.show_app()
            self.show_orbit()
        elif args.toggle_orbit:
            self.toggle_orbit()
        elif args.orbit:
            self.show_orbit()
        elif not args.ipc or args.app:
            self.show_app()
        return 0

    def _start_ipc_reader(self) -> None:
        """NDJSON stdin IPC compatible with server-managed helper protocol."""

        def _emit(payload: dict[str, Any]) -> None:
            try:
                sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
                sys.stdout.flush()
            except OSError:
                pass

        _emit({"event": "ready", "version": __version__, "capabilities": CAPABILITIES.summary_lines()})

        def _reader() -> None:
            for raw in sys.stdin:
                line = raw.strip()
                if not line:
                    continue
                try:
                    msg = json.loads(line)
                except ValueError:
                    continue
                if isinstance(msg, dict):
                    GLib.idle_add(self._handle_ipc_message, msg, _emit)
            GLib.idle_add(self._request_quit)

        threading.Thread(target=_reader, name="lumen-ipc", daemon=True).start()

    def _request_quit(self) -> bool:
        for win in (self._preview, self._orbit, self._workspace):
            if win is not None:
                try:
                    win.set_hide_on_close(False)
                    win.shutdown()
                    win.destroy()
                except Exception:
                    pass
        self._preview = None
        self._orbit = None
        self._workspace = None
        if self._holding:
            self._holding = False
            try:
                self.release()
            except Exception:
                pass
        self.quit()
        return False

    def _handle_ipc_message(self, msg: dict[str, Any], emit: Any) -> bool:
        cmd = str(msg.get("type") or msg.get("event") or msg.get("command") or "").strip()
        if cmd == "configure":
            origin = str(msg.get("clipboardOrigin") or msg.get("origin") or "")
            key = str(msg.get("clipboardKey") or msg.get("managementKey") or "")
            pos = str(msg.get("quickOrbitPosition") or "")
            self._store.configure(origin=origin, management_key=key)
            if pos and self._orbit is not None:
                self._orbit.set_edge_position(pos)
            emit({"event": "configured", "ok": self._store.is_configured})
        elif cmd in ("clipboard.open", "app.show"):
            self.show_app()
        elif cmd == "orbit.show":
            self.show_orbit()
        elif cmd == "orbit.hide":
            self.hide_orbit()
        elif cmd == "orbit.toggle":
            self.toggle_orbit()
        elif cmd == "preview.files":
            files = msg.get("files") or []
            if isinstance(files, list) and files:
                self._ensure_surfaces()
                assert self._preview is not None
                self._preview.present_local_files([str(p) for p in files])
        elif cmd == "quit":
            emit({"event": "quitting"})
            self._request_quit()
        return False

    def do_shutdown(self) -> None:
        if self._preview is not None:
            self._preview.shutdown()
            self._preview = None
        if self._orbit is not None:
            self._orbit.shutdown()
            self._orbit = None
        if self._workspace is not None:
            self._workspace.shutdown()
            self._workspace = None
        self._store.shutdown()
        _BaseApplication.do_shutdown(self)


def main(argv: Optional[list[str]] = None) -> int:
    raw_argv = list(sys.argv[1:] if argv is None else argv)
    # Fast-path flags that do not need a display server
    if "--capabilities" in raw_argv:
        print(json.dumps({
            "version": __version__,
            "gtk": CAPABILITIES.gtk_version,
            "summary": CAPABILITIES.summary_lines(),
            "details": CAPABILITIES.__dict__,
        }, ensure_ascii=False, indent=2))
        return 0
    if "-h" in raw_argv or "--help" in raw_argv or "--version" in raw_argv:
        _build_arg_parser().parse_args(raw_argv)
        return 0

    non_unique = "--non-unique" in raw_argv or "--ipc" in raw_argv or bool(os.environ.get("LUMEN_NON_UNIQUE"))
    app = LumenLinuxApplication(non_unique=non_unique)
    return int(app.run([sys.argv[0], *raw_argv]))


if __name__ == "__main__":
    raise SystemExit(main())
