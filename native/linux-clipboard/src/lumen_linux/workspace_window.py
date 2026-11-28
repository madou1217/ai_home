"""Native App Management Window (`LumenWorkspaceWindow`).

Separate top-level GTK4/Adwaita window implementing Sidebar, History (List &
Gallery), Inspector (single & batch multi-select), Settings, New Clip modal,
and the complete App Window keyboard contract. Never hosts Orbit inline.
"""

from __future__ import annotations

from typing import Any, Callable, Optional

from .api import ClipboardStore
from .capabilities import Adw, Gdk, Gio, GLib, Gtk
from .models import ClipboardItem
from .motion import LumenMotion
from .preview_window import LumenPreviewWindow
from .theme import CssThemeManager, ToastBannerWidget, current_palette
from .workspace_views import (
    GalleryCardWidget,
    HistoryRowWidget,
    InspectorView,
    NAV_ALL,
    NAV_PINNED,
    NAV_RECENT,
    NAV_SETTINGS,
    NavDestination,
    NewClipDialog,
    SettingsView,
    SidebarView,
)


_BaseAppWindow = Adw.ApplicationWindow if Adw is not None else Gtk.ApplicationWindow


class LumenWorkspaceWindow(_BaseAppWindow):
    """Pure native GTK4/Adwaita App Management Window for Paste Lumen V7."""

    def __init__(self, application: Optional[Gtk.Application] = None) -> None:
        super().__init__(application=application, title="Lumen 剪贴板")
        self.add_css_class("lumen-window")
        self.set_default_size(1220, 800)
        self.set_size_request(820, 540)
        self.set_hide_on_close(True)

        self._store = ClipboardStore.shared()
        self._active_nav: NavDestination = NAV_ALL
        self._search_query: str = ""
        self._sort_order: int = 0  # 0 newest | 1 oldest | 2 title
        self._is_list_mode: bool = True
        self._sidebar_hidden: bool = False
        self._inspector_hidden: bool = False

        self._filtered_items: list[ClipboardItem] = []
        self._selected_id: Optional[str] = None
        self._multi_selected_ids: set[str] = set()
        self._selection_anchor_id: Optional[str] = None
        self._popover: Optional[Gtk.PopoverMenu] = None

        self.on_open_orbit: Optional[Callable[[], None]] = None
        self.on_quick_orbit_position_changed: Optional[Callable[[str], None]] = None

        self._build_layout()
        self._wire_callbacks()
        self._install_controllers()
        self.apply_theme()

        self._obs_id = self._store.add_observer(self._on_store_event)
        LumenPreviewWindow.shared(application).on_toast = self._on_preview_toast

    def _set_window_root(self, widget: Gtk.Widget) -> None:
        if Adw is not None and isinstance(self, Adw.ApplicationWindow):
            self.set_content(widget)
        else:
            self.set_child(widget)

    def _build_layout(self) -> None:
        root = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=0)
        root.set_hexpand(True)
        root.set_vexpand(True)

        self._sidebar = SidebarView(on_select=self.select_destination)
        root.append(self._sidebar)

        # Main workspace overlay (hosts floating toast above workspace column)
        overlay = Gtk.Overlay()
        overlay.set_hexpand(True)
        overlay.set_vexpand(True)

        workspace = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)
        workspace.set_hexpand(True)
        workspace.set_vexpand(True)

        # Top toolbar
        toolbar = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        toolbar.add_css_class("lumen-toolbar")

        toggle_side_btn = self._icon_btn("sidebar-show-symbolic", "切换侧边栏", self._toggle_sidebar)
        add_btn = self._icon_btn("list-add-symbolic", "新建文本记录 (Ctrl+N)", self.open_new_clip_dialog)
        local_btn = self._icon_btn("document-open-symbolic", "预览本地文件", self._open_local_preview)

        title_col = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=1)
        self._heading_lbl = Gtk.Label(label="所有记录")
        self._heading_lbl.add_css_class("lumen-heading")
        self._heading_lbl.set_xalign(0.0)
        self._sub_lbl = Gtk.Label(label="0 条内容")
        self._sub_lbl.add_css_class("lumen-subheading")
        self._sub_lbl.set_xalign(0.0)
        title_col.append(self._heading_lbl)
        title_col.append(self._sub_lbl)

        spacer = Gtk.Box()
        spacer.set_hexpand(True)

        self._search_entry = Gtk.SearchEntry()
        self._search_entry.set_placeholder_text("搜索记录 (Ctrl+F)")
        self._search_entry.set_size_request(210, -1)
        self._search_entry.connect("search-changed", self._on_search_changed)

        self._sort_dd = Gtk.DropDown.new_from_strings(["最新优先", "最早优先", "按标题"])
        self._sort_dd.connect("notify::selected", self._on_sort_changed)

        self._view_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=2)
        self._list_btn = self._icon_btn("view-list-symbolic", "列表视图", lambda: self._set_view_mode(True))
        self._grid_btn = self._icon_btn("view-grid-symbolic", "画廊视图", lambda: self._set_view_mode(False))
        self._list_btn.add_css_class("lumen-active")
        self._view_box.append(self._list_btn)
        self._view_box.append(self._grid_btn)

        toggle_insp_btn = self._icon_btn("view-dual-symbolic", "切换预览面板", self._toggle_inspector)
        self._theme_btn = self._icon_btn("weather-clear-night-symbolic", "切换外观", self._toggle_theme)

        orbit_btn = Gtk.Button(label="✦ Orbit")
        orbit_btn.add_css_class("lumen-orbit-launch")
        orbit_btn.set_tooltip_text("呼出 Orbit 快捷浮层")
        orbit_btn.connect("clicked", lambda _b: self.on_open_orbit() if self.on_open_orbit else None)

        for w in (
            toggle_side_btn,
            title_col,
            add_btn,
            local_btn,
            spacer,
            self._search_entry,
            self._sort_dd,
            self._view_box,
            toggle_insp_btn,
            self._theme_btn,
            orbit_btn,
        ):
            toolbar.append(w)

        workspace.append(toolbar)

        # Center stack: split (History | Inspector) vs Settings
        self._paned = Gtk.Paned(orientation=Gtk.Orientation.HORIZONTAL)
        self._paned.set_hexpand(True)
        self._paned.set_vexpand(True)
        self._paned.set_wide_handle(False)
        self._paned.set_position(580)

        history_host = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)
        history_host.set_hexpand(True)
        history_host.set_vexpand(True)
        history_host.set_size_request(320, -1)

        self._list_scroll = Gtk.ScrolledWindow()
        self._list_scroll.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
        self._list_scroll.set_hexpand(True)
        self._list_scroll.set_vexpand(True)
        self._list_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=2)
        self._list_box.set_margin_top(6)
        self._list_box.set_margin_bottom(14)
        self._list_scroll.set_child(self._list_box)

        self._gallery_scroll = Gtk.ScrolledWindow()
        self._gallery_scroll.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
        self._gallery_scroll.set_hexpand(True)
        self._gallery_scroll.set_vexpand(True)
        self._gallery_scroll.set_visible(False)
        self._gallery_flow = Gtk.FlowBox()
        self._gallery_flow.set_selection_mode(Gtk.SelectionMode.NONE)
        self._gallery_flow.set_homogeneous(True)
        self._gallery_flow.set_row_spacing(10)
        self._gallery_flow.set_column_spacing(10)
        self._gallery_flow.set_margin_top(12)
        self._gallery_flow.set_margin_bottom(16)
        self._gallery_flow.set_margin_start(14)
        self._gallery_flow.set_margin_end(14)
        self._gallery_flow.set_valign(Gtk.Align.START)
        self._gallery_scroll.set_child(self._gallery_flow)

        self._empty_lbl = Gtk.Label(label="暂无剪贴板记录")
        self._empty_lbl.add_css_class("lumen-muted")
        self._empty_lbl.set_halign(Gtk.Align.CENTER)
        self._empty_lbl.set_valign(Gtk.Align.CENTER)
        self._empty_lbl.set_vexpand(True)
        self._empty_lbl.set_visible(False)

        history_host.append(self._list_scroll)
        history_host.append(self._gallery_scroll)
        history_host.append(self._empty_lbl)

        self._inspector = InspectorView()
        self._paned.set_start_child(history_host)
        self._paned.set_resize_start_child(True)
        self._paned.set_shrink_start_child(False)
        self._paned.set_end_child(self._inspector)
        self._paned.set_resize_end_child(False)
        self._paned.set_shrink_end_child(False)

        self._settings = SettingsView()
        self._settings.set_visible(False)

        workspace.append(self._paned)
        workspace.append(self._settings)

        # Footer bar
        footer = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=12)
        footer.add_css_class("lumen-footer")
        self._footer_left = Gtk.Label(label="0 条记录 · 0 条固定")
        self._footer_left.set_xalign(0.0)
        self._footer_left.set_hexpand(True)
        footer_right = Gtk.Label(label="↑ ↓ 导航 · Space 预览 · ↵ 复制 · Ctrl+F 搜索")
        footer_right.add_css_class("lumen-muted")
        footer.append(self._footer_left)
        footer.append(footer_right)
        workspace.append(footer)

        self._toast = ToastBannerWidget(on_undo=self._undo_delete)
        overlay.set_child(workspace)
        overlay.add_overlay(self._toast)

        root.append(overlay)
        self._set_window_root(root)

    @staticmethod
    def _icon_btn(icon_name: str, tip: str, on_click: Callable[[], None]) -> Gtk.Button:
        btn = Gtk.Button.new_from_icon_name(icon_name)
        btn.add_css_class("lumen-icon-btn")
        btn.set_tooltip_text(tip)
        btn.connect("clicked", lambda _b: on_click())
        return btn

    def _wire_callbacks(self) -> None:
        self._inspector.on_copy_single = self._copy_item
        self._inspector.on_preview_single = lambda item: self._open_preview(self._filtered_items or [item], item.id)
        self._inspector.on_pin_single = self._toggle_pin
        self._inspector.on_delete_single = self._delete_single
        self._inspector.on_batch_preview = lambda items: self._open_preview(items, self._selected_id)
        self._inspector.on_batch_pin = self._batch_pin
        self._inspector.on_batch_delete = self._batch_delete
        self._inspector.on_clear_selection = self._clear_multi_selection

        self._settings.on_patch_server_settings = self._on_patch_settings
        self._settings.on_apply_preferences = self._on_apply_preferences
        self._settings.on_trigger_sync = self._on_trigger_sync
        self._settings.on_clear_all_items = self._confirm_clear_all

    def _install_controllers(self) -> None:
        key_ctrl = Gtk.EventControllerKey.new()
        key_ctrl.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)
        key_ctrl.connect("key-pressed", self._on_key_pressed)
        self.add_controller(key_ctrl)

        group = Gio.SimpleActionGroup.new()
        for name, cb in (
            ("copy", lambda _a, p: self._action_by_id(p.get_string(), self._copy_item)),
            ("preview", lambda _a, p: self._action_by_id(p.get_string(), lambda it: self._open_preview(self._filtered_items or [it], it.id))),
            ("pin", lambda _a, p: self._action_by_id(p.get_string(), self._toggle_pin)),
            ("delete", lambda _a, p: self._action_by_id(p.get_string(), self._delete_single)),
        ):
            act = Gio.SimpleAction.new(name, GLib.VariantType.new("s"))
            act.connect("activate", cb)
            group.add_action(act)
        self.insert_action_group("clip", group)

    def _action_by_id(self, item_id: str, fn: Callable[[ClipboardItem], None]) -> None:
        it = next((x for x in self._filtered_items if x.id == item_id), None)
        if it is not None:
            fn(it)

    def _on_store_event(self, event: str, payload: Any) -> None:
        if event == "items":
            self.rebuild_filtered_state()
        elif event == "settings":
            if self._active_nav == NAV_SETTINGS:
                self._settings.reload()
            self._update_sidebar()
        elif event in ("status", "connection"):
            self._update_sidebar()
            if self._active_nav == NAV_SETTINGS:
                self._settings.reload()
        elif event == "preferences":
            self.apply_theme()
            self.rebuild_filtered_state()
            if self._active_nav == NAV_SETTINGS:
                self._settings.reload()
        elif event == "error" and self.get_visible():
            self._show_toast(str(payload))

    def _on_preview_toast(self, msg: str) -> None:
        if self.get_visible():
            self._show_toast(msg)

    def _show_toast(self, msg: str, show_undo: bool = False) -> None:
        self._toast.show_message(
            msg,
            show_undo=show_undo,
            motion_enabled=LumenMotion.is_enabled(self._store.preferences.motion),
        )

    def show_workspace(self) -> None:
        self._store.ensure_configured_from_local()
        self._store.refresh_all()
        self.rebuild_filtered_state()
        self.present()

    def apply_theme(self) -> None:
        CssThemeManager.apply_to_window(self, self._store.preferences)
        is_dark = self._store.preferences.theme == "dark"
        self._theme_btn.set_icon_name("weather-clear-symbolic" if is_dark else "weather-clear-night-symbolic")
        self._update_sidebar()
        self._render_inspector()

    def _update_sidebar(self) -> None:
        self._sidebar.update(
            active=self._active_nav,
            items=self._store.items,
            connected=self._store.connected,
            status=self._store.status,
        )

    def select_destination(self, dest: NavDestination) -> None:
        self._active_nav = dest
        self._multi_selected_ids.clear()
        self._selection_anchor_id = None
        is_settings = dest == NAV_SETTINGS
        self._paned.set_visible(not is_settings)
        self._settings.set_visible(is_settings)
        self._search_entry.set_visible(not is_settings)
        self._sort_dd.set_visible(not is_settings)
        self._view_box.set_visible(not is_settings)
        self._heading_lbl.set_text(dest.title)
        if is_settings:
            self._sub_lbl.set_text("自定义 Lumen 原生体验")
            self._store.refresh_settings()
            self._store.refresh_status()
            self._store.refresh_servers()
            self._settings.reload()
        else:
            self.rebuild_filtered_state()
        self._update_sidebar()

    def rebuild_filtered_state(self) -> None:
        self._update_sidebar()
        if self._active_nav == NAV_SETTINGS:
            return

        q = self._search_query.strip().lower()
        items: list[ClipboardItem] = []
        for item in self._store.items:
            if self._active_nav == NAV_PINNED and not item.pinned:
                continue
            if self._active_nav == NAV_RECENT and not (item.is_today or item.is_yesterday):
                continue
            if self._active_nav.kind == "category" and item.display_category != self._active_nav.category:
                continue
            if q:
                hay = (
                    item.display_title.lower()
                    + "\n"
                    + item.effective_text.lower()
                    + "\n"
                    + item.source_label.lower()
                    + "\n"
                    + "\n".join(f.lower() for f in item.files)
                )
                if q not in hay:
                    continue
            items.append(item)

        if self._sort_order == 1:
            items.reverse()
        elif self._sort_order == 2:
            items.sort(key=lambda x: x.display_title.lower())

        self._filtered_items = items
        valid_ids = {it.id for it in items}
        self._multi_selected_ids.intersection_update(valid_ids)
        if self._selected_id not in valid_ids:
            self._selected_id = items[0].id if items else None

        self._heading_lbl.set_text(self._active_nav.title)
        self._sub_lbl.set_text(f"{len(items)} 条内容")
        self._empty_lbl.set_visible(len(items) == 0)
        self._empty_lbl.set_text("暂无剪贴板记录" if not q else f"没有匹配“{self._search_query}”的记录")

        self._reload_history_presentation()
        self._render_inspector()
        self._update_footer()

    def _is_selected(self, item_id: str) -> bool:
        if self._multi_selected_ids:
            return item_id in self._multi_selected_ids
        return self._selected_id == item_id

    def _reload_history_presentation(self) -> None:
        has_items = len(self._filtered_items) > 0
        self._list_scroll.set_visible(self._is_list_mode and has_items)
        self._gallery_scroll.set_visible((not self._is_list_mode) and has_items)
        palette = current_palette(self._store.preferences)

        if self._is_list_mode:
            while True:
                c = self._list_box.get_first_child()
                if c is None:
                    break
                self._list_box.remove(c)

            sections: list[tuple[str, list[ClipboardItem]]] = []
            if self._sort_order == 2:
                if self._filtered_items:
                    sections.append(("按标题", self._filtered_items))
            else:
                today = [it for it in self._filtered_items if it.is_today]
                yesterday = [it for it in self._filtered_items if not it.is_today and it.is_yesterday]
                earlier = [it for it in self._filtered_items if not it.is_today and not it.is_yesterday]
                order = [("更早", earlier), ("昨天", yesterday), ("今天", today)] if self._sort_order == 1 else [("今天", today), ("昨天", yesterday), ("更早", earlier)]
                sections = [(t, g) for t, g in order if g]

            for title, group in sections:
                hdr = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
                hdr.set_margin_top(10)
                hdr.set_margin_bottom(4)
                hdr.set_margin_start(14)
                hdr.set_margin_end(14)
                left = Gtk.Label(label=title)
                left.add_css_class("lumen-section-label")
                left.set_xalign(0.0)
                left.set_hexpand(True)
                right = Gtk.Label(label=f"{len(group)} 条")
                right.add_css_class("lumen-subheading")
                hdr.append(left)
                hdr.append(right)
                self._list_box.append(hdr)
                for item in group:
                    row = HistoryRowWidget(
                        item=item,
                        selected=self._is_selected(item.id),
                        on_click=self._on_item_clicked,
                        on_right_click=self._on_item_right_clicked,
                    )
                    self._list_box.append(row)
        else:
            while True:
                c = self._gallery_flow.get_first_child()
                if c is None:
                    break
                self._gallery_flow.remove(c)
            for item in self._filtered_items:
                card = GalleryCardWidget(
                    item=item,
                    selected=self._is_selected(item.id),
                    palette=palette,
                    on_click=self._on_item_clicked,
                    on_right_click=self._on_item_right_clicked,
                )
                self._gallery_flow.append(card)
        self._update_footer()

    def _render_inspector(self) -> None:
        palette = current_palette(self._store.preferences)
        if len(self._multi_selected_ids) > 1:
            batch = [it for it in self._filtered_items if it.id in self._multi_selected_ids]
            self._inspector.render(single=None, batch=batch, palette=palette)
            return
        active = next((it for it in self._filtered_items if it.id == self._selected_id), None)
        if active is not None and active.kind in ("text", "link") and active.text is None:
            active_id = active.id
            self._store.hydrate_item_detail(
                active_id,
                lambda _d: self._render_inspector_if_still_selected(active_id),
            )
        self._inspector.render(single=active, batch=[], palette=palette)

    def _render_inspector_if_still_selected(self, item_id: str) -> None:
        if self._selected_id != item_id or len(self._multi_selected_ids) > 1:
            return
        active = next((it for it in self._filtered_items if it.id == item_id), None)
        self._inspector.render(single=active, batch=[], palette=current_palette(self._store.preferences))

    def _update_footer(self) -> None:
        total = len(self._store.items)
        pinned = sum(1 for it in self._store.items if it.pinned)
        multi = f" · 已选 {len(self._multi_selected_ids)} 条" if len(self._multi_selected_ids) > 1 else ""
        self._footer_left.set_text(f"{total} 条记录 · {pinned} 条固定{multi}")

    # Selection & Actions

    def _on_item_clicked(self, item_id: str, state: Gdk.ModifierType, n_press: int) -> None:
        if n_press >= 2:
            it = next((x for x in self._filtered_items if x.id == item_id), None)
            if it is not None:
                self._copy_item(it)
            return
        self._choose_item(item_id, state)

    def _choose_item(self, item_id: str, state: Gdk.ModifierType) -> None:
        shift = bool(state & Gdk.ModifierType.SHIFT_MASK)
        ctrl = bool(state & (Gdk.ModifierType.CONTROL_MASK | Gdk.ModifierType.META_MASK))
        if shift and self._selection_anchor_id:
            a = next((i for i, x in enumerate(self._filtered_items) if x.id == self._selection_anchor_id), -1)
            b = next((i for i, x in enumerate(self._filtered_items) if x.id == item_id), -1)
            if a >= 0 and b >= 0:
                low, high = min(a, b), max(a, b)
                self._multi_selected_ids = {x.id for x in self._filtered_items[low : high + 1]}
        elif ctrl:
            if not self._multi_selected_ids and self._selected_id:
                self._multi_selected_ids.add(self._selected_id)
            if item_id in self._multi_selected_ids:
                self._multi_selected_ids.discard(item_id)
            else:
                self._multi_selected_ids.add(item_id)
            self._selection_anchor_id = item_id
        else:
            self._multi_selected_ids.clear()
            self._selection_anchor_id = item_id

        if len(self._multi_selected_ids) == 1:
            self._selected_id = next(iter(self._multi_selected_ids))
        else:
            self._selected_id = item_id
        self._reload_history_presentation()
        self._render_inspector()

    def _on_item_right_clicked(self, item_id: str, anchor: Gtk.Widget, x: float, y: float) -> None:
        self._choose_item(item_id, Gdk.ModifierType(0))
        menu = Gio.Menu.new()
        menu.append("复制到剪贴板", f"clip.copy('{item_id}')")
        menu.append("完整预览", f"clip.preview('{item_id}')")
        menu.append("固定 / 取消固定", f"clip.pin('{item_id}')")
        sec = Gio.Menu.new()
        sec.append("移除记录", f"clip.delete('{item_id}')")
        menu.append_section(None, sec)

        if self._popover is not None:
            self._popover.unparent()
        pop = Gtk.PopoverMenu.new_from_model(menu)
        pop.set_parent(anchor)
        rect = Gdk.Rectangle()
        rect.x, rect.y, rect.width, rect.height = int(x), int(y), 1, 1
        pop.set_pointing_to(rect)
        pop.popup()
        self._popover = pop

    def _clear_multi_selection(self) -> None:
        self._multi_selected_ids.clear()
        self._reload_history_presentation()
        self._render_inspector()

    def _copy_item(self, item: ClipboardItem) -> None:
        self._store.copy_to_os_clipboard(
            item.id,
            on_success=lambda: self._show_toast("已复制到剪贴板"),
            on_error=lambda err: self._show_toast(f"复制失败：{err}"),
        )

    def _open_preview(self, items: list[ClipboardItem], initial_id: Optional[str]) -> None:
        if items:
            LumenPreviewWindow.shared(self.get_application()).open_clipboard_items(items, initial_id=initial_id)

    def _toggle_pin(self, item: ClipboardItem) -> None:
        nxt = not item.pinned
        self._store.set_pinned(
            item.id,
            nxt,
            on_success=lambda _u: self._show_toast("已固定记录" if nxt else "已取消固定"),
        )

    def _delete_single(self, item: ClipboardItem) -> None:
        idx = next((i for i, x in enumerate(self._filtered_items) if x.id == item.id), -1)
        if idx >= 0:
            if idx + 1 < len(self._filtered_items):
                self._selected_id = self._filtered_items[idx + 1].id
            elif idx > 0:
                self._selected_id = self._filtered_items[idx - 1].id
            else:
                self._selected_id = None
        self._multi_selected_ids.discard(item.id)
        self._store.delete_item(
            item.id,
            on_success=lambda: self._show_toast("已移除剪贴板记录", show_undo=self._store.can_undo_delete),
        )

    def _batch_pin(self, items: list[ClipboardItem]) -> None:
        ids = [it.id for it in items]
        self._store.batch_set_pinned(ids, True, on_done=lambda: self._show_toast(f"已固定 {len(ids)} 条记录"))

    def _batch_delete(self, items: list[ClipboardItem]) -> None:
        ids = [it.id for it in items]
        self._multi_selected_ids.clear()
        self._store.batch_delete(
            ids,
            on_success=lambda cnt: self._show_toast(f"已移除 {cnt} 条记录", show_undo=self._store.can_undo_delete),
        )

    def _undo_delete(self) -> None:
        def _ok(restored: ClipboardItem) -> None:
            self._selected_id = restored.id
            self._show_toast("已恢复记录", show_undo=self._store.can_undo_delete)

        self._store.undo_last_delete(on_success=_ok, on_error=lambda err: self._show_toast(str(err)))

    def _on_patch_settings(self, patch: dict[str, Any]) -> None:
        def _ok(updated: Any) -> None:
            if self.on_quick_orbit_position_changed:
                self.on_quick_orbit_position_changed(updated.quick_orbit_position)
            self._show_toast("设置已保存")

        self._store.patch_settings(patch, on_success=_ok)

    def _on_apply_preferences(self, next_prefs: Any) -> None:
        def _mut(p: Any) -> None:
            p.theme = next_prefs.theme
            p.particles = next_prefs.particles
            p.glow = next_prefs.glow
            p.motion = next_prefs.motion

        self._store.update_preferences(_mut)

    def _on_trigger_sync(self) -> None:
        self._store.api.trigger_sync(
            on_success=lambda _: self._show_toast("同步已完成"),
            on_error=lambda err: self._show_toast(f"同步失败：{err}"),
        )

    def _confirm_clear_all(self) -> None:
        ids = [it.id for it in self._store.items]
        if not ids:
            self._show_toast("当前没有可清空的记录")
            return
        if hasattr(Gtk, "AlertDialog"):
            dlg = Gtk.AlertDialog()
            dlg.set_message("清空全部剪贴板记录？")
            dlg.set_detail(f"将通过管理接口移除当前列表中的 {len(ids)} 条记录。")
            dlg.set_buttons(["取消", "确认清空"])
            dlg.set_cancel_button(0)
            dlg.set_default_button(0)

            def _chosen(d: Gtk.AlertDialog, res: Gio.AsyncResult) -> None:
                try:
                    if d.choose_finish(res) == 1:
                        self._store.batch_delete(ids, on_success=lambda c: self._show_toast(f"已清空 {c} 条记录"))
                except Exception:
                    pass

            dlg.choose(self, None, _chosen)
        else:
            self._store.batch_delete(ids, on_success=lambda c: self._show_toast(f"已清空 {c} 条记录"))

    # Toolbar callbacks

    def _toggle_sidebar(self) -> None:
        self._sidebar_hidden = not self._sidebar_hidden
        self._sidebar.set_visible(not self._sidebar_hidden)

    def _toggle_inspector(self) -> None:
        self._inspector_hidden = not self._inspector_hidden
        self._inspector.set_visible(not self._inspector_hidden)

    def _toggle_theme(self) -> None:
        self._store.update_preferences(lambda p: setattr(p, "theme", "dark" if p.theme == "light" else "light"))

    def open_new_clip_dialog(self) -> None:
        def _save(text: str) -> None:
            def _ok(created: ClipboardItem) -> None:
                self._selected_id = created.id
                if self._active_nav == NAV_SETTINGS:
                    self.select_destination(NAV_ALL)
                self._show_toast("已保存新记录")

            self._store.create_text_item(
                text,
                on_success=_ok,
                on_error=lambda err: self._show_toast(f"保存失败：{err}"),
            )

        dlg = NewClipDialog(self, on_save=_save)
        CssThemeManager.apply_to_window(dlg, self._store.preferences)
        dlg.present()

    def _open_local_preview(self) -> None:
        LumenPreviewWindow.shared(self.get_application()).open_local_file_picker()

    def _on_search_changed(self, entry: Gtk.SearchEntry) -> None:
        self._search_query = entry.get_text()
        self._multi_selected_ids.clear()
        self.rebuild_filtered_state()

    def _on_sort_changed(self, dd: Gtk.DropDown, _pspec: Any) -> None:
        self._sort_order = int(dd.get_selected())
        self.rebuild_filtered_state()

    def _set_view_mode(self, list_mode: bool) -> None:
        self._is_list_mode = list_mode
        if list_mode:
            self._list_btn.add_css_class("lumen-active")
            self._grid_btn.remove_css_class("lumen-active")
        else:
            self._grid_btn.add_css_class("lumen-active")
            self._list_btn.remove_css_class("lumen-active")
        self._reload_history_presentation()

    # Unified App Window Keyboard Contract

    def _on_key_pressed(
        self,
        _ctrl: Gtk.EventControllerKey,
        keyval: int,
        _keycode: int,
        state: Gdk.ModifierType,
    ) -> bool:
        if self._active_nav == NAV_SETTINGS:
            return False
        ctrl = bool(state & (Gdk.ModifierType.CONTROL_MASK | Gdk.ModifierType.META_MASK))
        focus = self.get_focus()
        editing_search = focus is not None and (focus is self._search_entry or focus.is_ancestor(self._search_entry))

        if ctrl and keyval in (Gdk.KEY_f, Gdk.KEY_F):
            self._search_entry.grab_focus()
            return True
        if ctrl and keyval in (Gdk.KEY_n, Gdk.KEY_N):
            self.open_new_clip_dialog()
            return True
        if editing_search:
            if keyval == Gdk.KEY_Escape:
                self.set_focus(None)
                return True
            return False
        if ctrl and keyval in (Gdk.KEY_a, Gdk.KEY_A):
            self._multi_selected_ids = {it.id for it in self._filtered_items}
            self._reload_history_presentation()
            self._render_inspector()
            return True
        if ctrl and keyval in (Gdk.KEY_z, Gdk.KEY_Z) and self._store.can_undo_delete:
            self._undo_delete()
            return True
        if not ctrl and keyval == Gdk.KEY_slash:
            self._search_entry.grab_focus()
            return True
        if ctrl:
            return False

        if keyval in (Gdk.KEY_Up, Gdk.KEY_Left):
            self._step_selection(-1, state)
            return True
        if keyval in (Gdk.KEY_Down, Gdk.KEY_Right):
            self._step_selection(1, state)
            return True
        if keyval == Gdk.KEY_Home and self._filtered_items:
            self._choose_item(self._filtered_items[0].id, state)
            return True
        if keyval == Gdk.KEY_End and self._filtered_items:
            self._choose_item(self._filtered_items[-1].id, state)
            return True
        if keyval == Gdk.KEY_space:
            if len(self._multi_selected_ids) > 1:
                batch = [it for it in self._filtered_items if it.id in self._multi_selected_ids]
                self._open_preview(batch, self._selected_id)
            else:
                it = next((x for x in self._filtered_items if x.id == self._selected_id), None)
                if it is not None:
                    # Whole list so the preview queue can step through it.
                    self._open_preview(self._filtered_items, it.id)
            return True
        if keyval in (Gdk.KEY_Return, Gdk.KEY_KP_Enter):
            it = next((x for x in self._filtered_items if x.id == self._selected_id), None)
            if it is not None:
                self._copy_item(it)
                return True
            return False
        if keyval in (Gdk.KEY_Delete, Gdk.KEY_BackSpace):
            if len(self._multi_selected_ids) > 1:
                batch = [it for it in self._filtered_items if it.id in self._multi_selected_ids]
                self._batch_delete(batch)
            else:
                it = next((x for x in self._filtered_items if x.id == self._selected_id), None)
                if it is not None:
                    self._delete_single(it)
            return True
        if keyval == Gdk.KEY_Escape and self._multi_selected_ids:
            self._clear_multi_selection()
            return True
        return False

    def _step_selection(self, delta: int, state: Gdk.ModifierType) -> None:
        if not self._filtered_items:
            return
        idx = next((i for i, x in enumerate(self._filtered_items) if x.id == self._selected_id), 0)
        nxt = max(0, min(len(self._filtered_items) - 1, idx + delta))
        self._choose_item(self._filtered_items[nxt].id, state)

    def shutdown(self) -> None:
        self._store.remove_observer(self._obs_id)
