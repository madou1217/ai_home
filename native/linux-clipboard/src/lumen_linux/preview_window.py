"""Shared native Quick Look preview window (`LumenPreviewWindow`).

Reusable floating Gtk.Window invoked from both the App Management Window and the
separate Orbit rail. Owns the queue sidebar, drag-and-drop local file preview,
unified Preview keyboard contract, interruptible enter/exit/switch transitions,
and mounts format-specific renderers via `PreviewRegistry`.
"""

from __future__ import annotations

import os
from typing import Callable, Optional

from .api import ClipboardStore
from .capabilities import Gdk, Gio, GLib, Gtk
from .models import ClipboardItem
from .motion import CURVE_ENTER, CURVE_EXIT, CURVE_SWITCH, InterruptibleValueAnimator, LumenMotion
from .preview_registry import (
    BoundedPreviewCache,
    PreviewContext,
    PreviewItem,
    PreviewRegistry,
    PreviewRendererView,
)
from .theme import AlbumCoverWidget, CssThemeManager, current_palette


class LumenPreviewWindow(Gtk.Window):
    _shared_instance: Optional["LumenPreviewWindow"] = None

    def __init__(self, application: Optional[Gtk.Application] = None) -> None:
        super().__init__(application=application, title="Lumen Quick Look")
        self.add_css_class("lumen-window")
        self.set_default_size(1040, 740)
        self.set_hide_on_close(True)

        self._store = ClipboardStore.shared()
        self._cache = BoundedPreviewCache.shared()
        self._registry = PreviewRegistry.shared()

        self._queue: list[PreviewItem] = []
        self._active_index: int = 0
        self._active_view: Optional[PreviewRendererView] = None
        self._maximized: bool = False
        self.on_toast: Optional[Callable[[str], None]] = None

        self._fade_anim = InterruptibleValueAnimator(self, initial=1.0)
        self._stage_anim: Optional[InterruptibleValueAnimator] = None

        self._build_layout()
        self._install_controllers()
        self.apply_theme()

        self._obs_id = self._store.add_observer(self._on_store_event)
        self.connect("close-request", self._on_close_request)

    @classmethod
    def shared(cls, application: Optional[Gtk.Application] = None) -> "LumenPreviewWindow":
        if cls._shared_instance is None:
            cls._shared_instance = cls(application=application)
        elif application is not None and cls._shared_instance.get_application() is None:
            cls._shared_instance.set_application(application)
        return cls._shared_instance

    def _build_layout(self) -> None:
        root = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)
        root.set_hexpand(True)
        root.set_vexpand(True)

        # Header bar
        header = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=10)
        header.add_css_class("lumen-preview-header")

        identity = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=2)
        identity.set_hexpand(True)
        self._title_lbl = Gtk.Label(label="Lumen Quick Look")
        self._title_lbl.add_css_class("lumen-heading")
        self._title_lbl.set_xalign(0.0)
        self._title_lbl.set_ellipsize(3)

        self._sub_lbl = Gtk.Label(label="QUICK LOOK")
        self._sub_lbl.add_css_class("lumen-subheading")
        self._sub_lbl.set_xalign(0.0)
        identity.append(self._title_lbl)
        identity.append(self._sub_lbl)

        actions = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        actions.set_valign(Gtk.Align.CENTER)

        prev_btn = self._icon_button("go-previous-symbolic", "上一项 (←)", lambda: self.step_queue(-1))
        self._counter_lbl = Gtk.Label(label="0 / 0")
        self._counter_lbl.add_css_class("lumen-muted")
        next_btn = self._icon_button("go-next-symbolic", "下一项 (→)", lambda: self.step_queue(1))
        import_btn = self._icon_button("list-add-symbolic", "导入本地文件", self.open_local_file_picker)
        copy_btn = self._icon_button("edit-copy-symbolic", "复制 (Ctrl+C)", self._copy_active)
        max_btn = self._icon_button("view-fullscreen-symbolic", "最大化 / 还原", self._toggle_maximize)
        close_btn = self._icon_button("window-close-symbolic", "关闭 (Esc)", self.close_animated)

        for w in (prev_btn, self._counter_lbl, next_btn, import_btn, copy_btn, max_btn, close_btn):
            actions.append(w)

        header.append(identity)
        header.append(actions)

        # Main split: queue sidebar + stage container
        body = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=0)
        body.set_hexpand(True)
        body.set_vexpand(True)

        self._queue_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
        self._queue_box.add_css_class("lumen-preview-queue")
        self._queue_box.set_size_request(236, -1)
        self._queue_box.set_visible(False)

        self._queue_header = Gtk.Label(label="文件集合")
        self._queue_header.add_css_class("lumen-section-label")
        self._queue_header.set_xalign(0.0)
        self._queue_header.set_margin_top(12)
        self._queue_header.set_margin_start(14)
        self._queue_header.set_margin_end(12)

        queue_scroll = Gtk.ScrolledWindow()
        queue_scroll.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
        queue_scroll.set_vexpand(True)
        self._queue_list = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=4)
        self._queue_list.set_margin_top(4)
        self._queue_list.set_margin_bottom(8)
        queue_scroll.set_child(self._queue_list)

        self._queue_box.append(self._queue_header)
        self._queue_box.append(queue_scroll)

        self._stage = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)
        self._stage.set_hexpand(True)
        self._stage.set_vexpand(True)
        self._stage_anim = InterruptibleValueAnimator(self._stage, initial=1.0)

        body.append(self._queue_box)
        body.append(self._stage)

        # Footer bar
        footer = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=12)
        footer.add_css_class("lumen-footer")
        self._footer_left = Gtk.Label(label="")
        self._footer_left.set_xalign(0.0)
        self._footer_left.set_hexpand(True)

        import_local = Gtk.Button(label="＋ 本地文件预览")
        import_local.add_css_class("lumen-icon-btn")
        import_local.connect("clicked", lambda _b: self.open_local_file_picker())

        hints = Gtk.Label(label="← → 切换 · Space 播放/暂停 · Ctrl+/− 缩放 · Esc 关闭")
        hints.add_css_class("lumen-muted")

        footer.append(self._footer_left)
        footer.append(import_local)
        footer.append(hints)

        root.append(header)
        root.append(body)
        root.append(footer)
        self.set_child(root)

    @staticmethod
    def _icon_button(icon_name: str, tip: str, on_click: Callable[[], None]) -> Gtk.Button:
        btn = Gtk.Button.new_from_icon_name(icon_name)
        btn.add_css_class("lumen-icon-btn")
        btn.set_tooltip_text(tip)
        btn.connect("clicked", lambda _b: on_click())
        return btn

    def _install_controllers(self) -> None:
        key_ctrl = Gtk.EventControllerKey.new()
        key_ctrl.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)
        key_ctrl.connect("key-pressed", self._on_key_pressed)
        self.add_controller(key_ctrl)

        drop_target = Gtk.DropTarget.new(Gdk.FileList, Gdk.DragAction.COPY)
        drop_target.connect("drop", self._on_files_dropped)
        self.add_controller(drop_target)

    def _on_files_dropped(self, _target: Gtk.DropTarget, value: object, _x: float, _y: float) -> bool:
        paths: list[str] = []
        if isinstance(value, Gdk.FileList):
            for gfile in value.get_files():
                path = gfile.get_path()
                if path and os.path.isfile(path):
                    paths.append(path)
        elif isinstance(value, Gio.File):
            path = value.get_path()
            if path and os.path.isfile(path):
                paths.append(path)
        if not paths:
            return False
        self.present_local_files(paths)
        return True

    def _on_store_event(self, event: str, _payload: object) -> None:
        if event == "preferences":
            self.apply_theme()
            if self._queue and self.get_visible():
                self._rebuild_queue_sidebar()
                if self._active_view is not None:
                    self._active_view.apply_theme(current_palette(self._store.preferences))

    def apply_theme(self) -> None:
        CssThemeManager.apply_to_window(self, self._store.preferences)

    def open_clipboard_items(self, items: list[ClipboardItem], initial_id: Optional[str] = None) -> None:
        flattened = PreviewItem.flatten(items)
        if not flattened:
            return
        start_idx = 0
        if initial_id:
            for idx, entry in enumerate(flattened):
                if entry.id == initial_id or (entry.clipboard_item and entry.clipboard_item.id == initial_id):
                    start_idx = idx
                    break
        self._present_queue(flattened, start_idx)

    def present_local_files(self, paths: list[str]) -> None:
        items = PreviewItem.from_local_paths([p for p in paths if os.path.isfile(p)])
        if items:
            self._present_queue(items, 0)

    def open_local_file_picker(self) -> None:
        if not hasattr(Gtk, "FileDialog"):
            return
        dialog = Gtk.FileDialog.new()
        dialog.set_title("选择本地文件进行预览")

        def _done(dlg: Gtk.FileDialog, res: Gio.AsyncResult) -> None:
            try:
                files = dlg.open_multiple_finish(res)
                if files is None:
                    return
                paths = []
                for i in range(files.get_n_items()):
                    gf = files.get_item(i)
                    if isinstance(gf, Gio.File) and gf.get_path():
                        paths.append(gf.get_path())
                if paths:
                    self.present_local_files(paths)
            except Exception:
                pass

        dialog.open_multiple(self if self.get_visible() else None, None, _done)

    def _present_queue(self, queue: list[PreviewItem], start_index: int) -> None:
        self._queue = queue
        self._active_index = max(0, min(len(queue) - 1, start_index))
        self._rebuild_queue_sidebar()
        self._mount_active_renderer(animated=False)
        self._show_animated()

    def _show_animated(self) -> None:
        was_visible = self.get_visible()
        motion_ok = LumenMotion.is_enabled(self._store.preferences.motion)
        if not was_visible:
            self.set_opacity(0.0 if motion_ok else 1.0)
            self._fade_anim.value = 0.0 if motion_ok else 1.0
        self.present()
        if motion_ok:
            self._fade_anim.animate_timed(
                1.0,
                LumenMotion.enter_ms(self._store.preferences.motion),
                CURVE_ENTER,
                on_update=lambda v: self.set_opacity(max(0.0, min(1.0, v))),
            )
        else:
            self.set_opacity(1.0)

    def close_animated(self) -> None:
        if not self.get_visible():
            self._teardown_active()
            return
        self._teardown_active()
        motion_ok = LumenMotion.is_enabled(self._store.preferences.motion)
        if not motion_ok:
            self.set_visible(False)
            self.set_opacity(1.0)
            return

        def _done() -> None:
            self.set_visible(False)
            self.set_opacity(1.0)

        self._fade_anim.animate_timed(
            0.0,
            LumenMotion.exit_ms(self._store.preferences.motion),
            CURVE_EXIT,
            on_update=lambda v: self.set_opacity(max(0.0, min(1.0, v))),
            on_done=_done,
        )

    def _teardown_active(self) -> None:
        if self._active_view is not None:
            try:
                self._active_view.teardown()
            except Exception:
                pass
            if self._active_view.get_parent() is self._stage:
                self._stage.remove(self._active_view)
            self._active_view = None

    def _rebuild_queue_sidebar(self) -> None:
        show_queue = len(self._queue) > 1
        self._queue_box.set_visible(show_queue)
        if not show_queue:
            return
        audio_only = all(it.kind.category == "audio" for it in self._queue)
        self._queue_header.set_text(f"{'播放队列' if audio_only else '文件集合'} · {len(self._queue)}")

        while True:
            child = self._queue_list.get_first_child()
            if child is None:
                break
            self._queue_list.remove(child)

        for idx, item in enumerate(self._queue):
            selected = idx == self._active_index
            btn = Gtk.Button()
            btn.add_css_class("lumen-queue-row")
            if selected:
                btn.add_css_class("lumen-selected")
            row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=9)

            if item.kind.category == "audio":
                thumb: Gtk.Widget = AlbumCoverWidget(seed_index=item.seed_index, badge_text="", size=34)
            else:
                thumb = Gtk.Label(label=item.kind.badge_code)
                thumb.add_css_class("lumen-orbit-key")
                thumb.set_size_request(34, 34)

            text_col = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=2)
            text_col.set_hexpand(True)
            name = Gtk.Label(label=item.title)
            name.set_xalign(0.0)
            name.set_ellipsize(2)
            sub = Gtk.Label(label=f"{item.kind.display_label} · {item.size_label}")
            sub.add_css_class("lumen-subheading")
            sub.set_xalign(0.0)
            sub.set_ellipsize(3)
            text_col.append(name)
            text_col.append(sub)

            idx_lbl = Gtk.Label(label="●" if selected else f"{idx + 1:02d}")
            idx_lbl.add_css_class("lumen-muted")

            row.append(thumb)
            row.append(text_col)
            row.append(idx_lbl)
            btn.set_child(row)
            btn.connect("clicked", lambda _b, i=idx: self.select_queue_index(i))
            self._queue_list.append(btn)

    def _mount_active_renderer(self, animated: bool) -> None:
        if not (0 <= self._active_index < len(self._queue)):
            return
        item = self._queue[self._active_index]
        palette = current_palette(self._store.preferences)

        self._title_lbl.set_text(item.title)
        self._sub_lbl.set_text(f"QUICK LOOK  /  {item.kind.display_label.upper()}")
        self._counter_lbl.set_text(f"{self._active_index + 1} / {len(self._queue)}")
        self._footer_left.set_text(f"{item.kind.display_label} · {item.size_label}")

        # Mandatory synchronous Teardown() before mounting next renderer.
        self._teardown_active()

        ctx = PreviewContext(
            store=self._store,
            cache=self._cache,
            palette=palette,
            on_step_queue=lambda delta, _auto: self.step_queue(delta),
            on_select_queue_index=self.select_queue_index,
            on_toast=lambda msg: self.on_toast(msg) if self.on_toast else None,
            on_copy_item=self._copy_preview_item,
            parent_window=self,
        )
        view = self._registry.make_view(item, ctx)
        self._stage.append(view)
        self._active_view = view

        if animated and LumenMotion.is_enabled(self._store.preferences.motion) and self._stage_anim is not None:
            self._stage.set_opacity(0.25)
            self._stage_anim.value = 0.25
            self._stage_anim.animate_timed(
                1.0,
                LumenMotion.switch_ms(self._store.preferences.motion),
                CURVE_SWITCH,
                on_update=lambda v: self._stage.set_opacity(max(0.0, min(1.0, v))),
            )
        else:
            self._stage.set_opacity(1.0)

    def select_queue_index(self, idx: int) -> None:
        if not (0 <= idx < len(self._queue)) or idx == self._active_index:
            return
        self._active_index = idx
        self._rebuild_queue_sidebar()
        self._mount_active_renderer(animated=True)

    def step_queue(self, delta: int) -> None:
        nxt = self._active_index + delta
        if 0 <= nxt < len(self._queue):
            self.select_queue_index(nxt)

    def _copy_active(self) -> None:
        if self._active_view is not None:
            self._active_view.copy_primary_content()

    def _copy_preview_item(self, item: PreviewItem) -> None:
        if item.clipboard_item is not None:
            self._store.copy_to_os_clipboard(
                item.clipboard_item.id,
                on_success=lambda: self.on_toast("已复制到剪贴板") if self.on_toast else None,
                on_error=lambda err: self.on_toast(f"复制失败：{err}") if self.on_toast else None,
            )
            return
        if item.local_path:
            display = Gdk.Display.get_default()
            if display is not None:
                uri = Gio.File.new_for_path(os.path.abspath(item.local_path)).get_uri() + "\r\n"
                provider = Gdk.ContentProvider.new_for_bytes(
                    "text/uri-list",
                    GLib.Bytes.new(uri.encode("utf-8")),
                )
                display.get_clipboard().set_content(provider)
                if self.on_toast:
                    self.on_toast("已复制文件引用")

    def _toggle_maximize(self) -> None:
        if self._maximized:
            self.unmaximize()
            self._maximized = False
        else:
            self.maximize()
            self._maximized = True

    def _on_key_pressed(
        self,
        _ctrl: Gtk.EventControllerKey,
        keyval: int,
        _keycode: int,
        state: Gdk.ModifierType,
    ) -> bool:
        ctrl_down = bool(state & (Gdk.ModifierType.CONTROL_MASK | Gdk.ModifierType.META_MASK))
        if keyval == Gdk.KEY_Escape:
            self.close_animated()
            return True
        if keyval == Gdk.KEY_Left:
            if len(self._queue) > 1:
                self.step_queue(-1)
                return True
            return self._active_view.step_page(-1) if self._active_view else False
        if keyval == Gdk.KEY_Right:
            if len(self._queue) > 1:
                self.step_queue(1)
                return True
            return self._active_view.step_page(1) if self._active_view else False
        if keyval == Gdk.KEY_space:
            if self._active_view and self._active_view.toggle_play_pause():
                return True
            self.close_animated()
            return True
        if keyval in (Gdk.KEY_Page_Up, Gdk.KEY_bracketleft):
            return self._active_view.step_page(-1) if self._active_view else False
        if keyval in (Gdk.KEY_Page_Down, Gdk.KEY_bracketright):
            return self._active_view.step_page(1) if self._active_view else False
        if ctrl_down and keyval in (Gdk.KEY_plus, Gdk.KEY_equal, Gdk.KEY_KP_Add):
            if self._active_view:
                self._active_view.zoom_in()
            return True
        if ctrl_down and keyval in (Gdk.KEY_minus, Gdk.KEY_KP_Subtract):
            if self._active_view:
                self._active_view.zoom_out()
            return True
        if ctrl_down and keyval in (Gdk.KEY_0, Gdk.KEY_KP_0):
            if self._active_view:
                self._active_view.reset_zoom()
            return True
        if ctrl_down and keyval in (Gdk.KEY_c, Gdk.KEY_C):
            focus = self.get_focus()
            if isinstance(focus, Gtk.TextView):
                return False
            self._copy_active()
            return True
        if keyval in (Gdk.KEY_Return, Gdk.KEY_KP_Enter):
            self._copy_active()
            return True
        return False

    def _on_close_request(self, _win: Gtk.Window) -> bool:
        self.close_animated()
        return True

    def shutdown(self) -> None:
        self._teardown_active()
        self._store.remove_observer(self._obs_id)
        if LumenPreviewWindow._shared_instance is self:
            LumenPreviewWindow._shared_instance = None
