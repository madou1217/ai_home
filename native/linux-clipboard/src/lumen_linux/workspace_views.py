"""Modular GTK4 views for the App Management Window.

Includes:
- SidebarView (library + smart categories + settings + live status dot)
- HistoryRowWidget & GalleryCardWidget (strictly no thick left accent bars)
- InspectorView (single item hero + metadata + actions; batch multi-select actions)
- SettingsView (Orbit / Appearance / Sync & Data tabs)
- NewClipDialog (modal sheet creating text/code/link clips via POST /items)
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from typing import Any, Callable, Optional

from .api import ClipboardStore
from .capabilities import CAPABILITIES, Gdk, Gio, Gtk, Pango
from .config import LumenVisualPreferences
from .models import Classifier, ClipboardItem, ClipboardStatus, DisplayCategory, decode_data_url_texture
from .preview_registry import BoundedPreviewCache, PreviewItem
from .theme import (
    AlbumCoverWidget,
    BrandMarkWidget,
    ColorSwatchWidget,
    LumenPalette,
    MiniOrbitPreviewWidget,
    SyntaxTokenizer,
    current_palette,
)


@dataclass(frozen=True)
class NavDestination:
    kind: str  # "all" | "recent" | "pinned" | "category" | "settings"
    category: Optional[DisplayCategory] = None

    @property
    def title(self) -> str:
        if self.kind == "all":
            return "所有记录"
        if self.kind == "recent":
            return "最近记录"
        if self.kind == "pinned":
            return "已固定"
        if self.kind == "settings":
            return "偏好设置"
        if self.category is not None:
            return self.category.label
        return "所有记录"


NAV_ALL = NavDestination("all")
NAV_RECENT = NavDestination("recent")
NAV_PINNED = NavDestination("pinned")
NAV_SETTINGS = NavDestination("settings")


class SidebarView(Gtk.Box):
    """Left navigation rail with brand mark, library filters, smart categories, and status."""

    def __init__(self, on_select: Callable[[NavDestination], None]) -> None:
        super().__init__(orientation=Gtk.Orientation.VERTICAL, spacing=0)
        self.add_css_class("lumen-sidebar")
        self.set_size_request(206, -1)
        self.set_vexpand(True)

        self._on_select = on_select
        self._buttons: dict[NavDestination, tuple[Gtk.Button, Optional[Gtk.Label]]] = {}
        self._active: NavDestination = NAV_ALL

        # Brand header
        brand_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=10)
        brand_row.set_margin_top(16)
        brand_row.set_margin_bottom(14)
        brand_row.set_margin_start(14)
        brand_row.set_margin_end(12)

        brand_mark = BrandMarkWidget(size=32)
        brand_text = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=1)
        b_title = Gtk.Label(label="Lumen")
        b_title.add_css_class("lumen-brand-title")
        b_title.set_xalign(0.0)
        b_sub = Gtk.Label(label="Clipboard, reimagined.")
        b_sub.add_css_class("lumen-brand-sub")
        b_sub.set_xalign(0.0)
        brand_text.append(b_title)
        brand_text.append(b_sub)
        brand_row.append(brand_mark)
        brand_row.append(brand_text)
        self.append(brand_row)

        # Scrollable nav list
        scroll = Gtk.ScrolledWindow()
        scroll.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
        scroll.set_vexpand(True)
        nav_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=3)
        nav_box.set_margin_start(8)
        nav_box.set_margin_end(8)
        nav_box.set_margin_bottom(8)

        nav_box.append(self._make_section_label("资料库"))
        self._add_nav_row(nav_box, NAV_ALL, "view-list-symbolic", show_count=True)
        self._add_nav_row(nav_box, NAV_RECENT, "document-open-recent-symbolic", show_count=False)
        self._add_nav_row(nav_box, NAV_PINNED, "view-pin-symbolic", show_count=True)

        spacer = Gtk.Box()
        spacer.set_size_request(-1, 10)
        nav_box.append(spacer)

        nav_box.append(self._make_section_label("智能分类"))
        for cat in DisplayCategory:
            self._add_nav_row(nav_box, NavDestination("category", cat), cat.icon_name, show_count=True)

        scroll.set_child(nav_box)
        self.append(scroll)

        # Bottom settings button + live connection status
        sep = Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL)
        sep.set_margin_start(10)
        sep.set_margin_end(10)
        self.append(sep)

        bottom = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
        bottom.set_margin_top(8)
        bottom.set_margin_bottom(12)
        bottom.set_margin_start(8)
        bottom.set_margin_end(8)

        self._add_nav_row(bottom, NAV_SETTINGS, "emblem-system-symbolic", show_count=False)

        status_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        status_row.set_margin_start(6)
        status_row.set_margin_end(6)
        self._status_dot = Gtk.Box()
        self._status_dot.add_css_class("lumen-status-dot")
        self._status_dot.add_css_class("lumen-dot-off")
        self._status_dot.set_valign(Gtk.Align.CENTER)

        status_text = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=1)
        self._status_title = Gtk.Label(label="本地资料库")
        self._status_title.set_xalign(0.0)
        self._status_sub = Gtk.Label(label="0 条记录 · 0 固定")
        self._status_sub.add_css_class("lumen-subheading")
        self._status_sub.set_xalign(0.0)
        status_text.append(self._status_title)
        status_text.append(self._status_sub)

        status_row.append(self._status_dot)
        status_row.append(status_text)
        bottom.append(status_row)
        self.append(bottom)

    @staticmethod
    def _make_section_label(text: str) -> Gtk.Label:
        lbl = Gtk.Label(label=text)
        lbl.add_css_class("lumen-section-label")
        lbl.set_xalign(0.0)
        lbl.set_margin_top(4)
        lbl.set_margin_bottom(4)
        lbl.set_margin_start(10)
        return lbl

    def _add_nav_row(self, parent: Gtk.Box, dest: NavDestination, icon_name: str, show_count: bool) -> None:
        btn = Gtk.Button()
        btn.add_css_class("lumen-nav-btn")
        row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        ico = Gtk.Image.new_from_icon_name(icon_name)
        ico.set_pixel_size(15)
        lbl = Gtk.Label(label=dest.title)
        lbl.set_xalign(0.0)
        lbl.set_hexpand(True)
        row.append(ico)
        row.append(lbl)
        count_lbl: Optional[Gtk.Label] = None
        if show_count:
            count_lbl = Gtk.Label(label="0")
            count_lbl.add_css_class("lumen-subheading")
            row.append(count_lbl)
        btn.set_child(row)
        btn.connect("clicked", lambda _b, d=dest: self._on_select(d))
        self._buttons[dest] = (btn, count_lbl)
        parent.append(btn)

    def update(
        self,
        active: NavDestination,
        items: list[ClipboardItem],
        connected: bool,
        status: Optional[ClipboardStatus],
    ) -> None:
        self._active = active
        pinned_count = sum(1 for it in items if it.pinned)
        counts: dict[DisplayCategory, int] = {}
        for it in items:
            counts[it.display_category] = counts.get(it.display_category, 0) + 1

        capturing = bool(status and status.capture.running)
        for cls in ("lumen-dot-ok", "lumen-dot-warn", "lumen-dot-off"):
            self._status_dot.remove_css_class(cls)
        if connected:
            self._status_dot.add_css_class("lumen-dot-ok" if capturing else "lumen-dot-warn")
            self._status_title.set_text("本机实时采集" if capturing else "本地资料库")
        else:
            self._status_dot.add_css_class("lumen-dot-off")
            self._status_title.set_text("未连接服务")
        self._status_sub.set_text(f"{len(items)} 条记录 · {pinned_count} 固定")

        for dest, (btn, count_lbl) in self._buttons.items():
            if dest == active:
                btn.add_css_class("lumen-active")
            else:
                btn.remove_css_class("lumen-active")
            if count_lbl is not None:
                if dest == NAV_ALL:
                    count_lbl.set_text(str(len(items)))
                elif dest == NAV_PINNED:
                    count_lbl.set_text(str(pinned_count))
                elif dest.category is not None:
                    count_lbl.set_text(str(counts.get(dest.category, 0)))


class HistoryRowWidget(Gtk.Box):
    """Single row in List view (rounded pill fill + 1px border on selection, NO left bar)."""

    def __init__(
        self,
        item: ClipboardItem,
        selected: bool,
        on_click: Callable[[str, Gdk.ModifierType, int], None],
        on_right_click: Callable[[str, Gtk.Widget, float, float], None],
    ) -> None:
        super().__init__(orientation=Gtk.Orientation.HORIZONTAL, spacing=10)
        self.item = item
        self.add_css_class("lumen-history-row")
        if selected:
            self.add_css_class("lumen-selected")
        self.set_hexpand(True)

        cat = item.display_category
        thumb_wrap = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
        thumb_wrap.add_css_class("lumen-row-thumb")
        thumb_wrap.set_size_request(40, 40)
        thumb_wrap.set_valign(Gtk.Align.CENTER)
        thumb_wrap.set_halign(Gtk.Align.CENTER)

        if cat == DisplayCategory.COLOR:
            parsed = Classifier.parse_hex_color(item.effective_text) or (0.33, 0.43, 0.88, 1.0)
            sw = ColorSwatchWidget(radius=7.0)
            sw.set_swatch(*parsed)
            sw.set_size_request(38, 38)
            thumb_wrap.append(sw)
        elif cat == DisplayCategory.IMAGE and item.thumbnail_data_url:
            cache = BoundedPreviewCache.shared()
            tkey = f"thumb:{item.id}"
            tex = cache.image(tkey)
            if tex is None:
                tex = decode_data_url_texture(item.thumbnail_data_url)
                if tex is not None:
                    cache.store_image(tkey, tex)
            if tex is not None:
                pic = Gtk.Picture.new_for_paintable(tex)
                pic.set_size_request(38, 38)
                pic.set_content_fit(Gtk.ContentFit.COVER)
                thumb_wrap.append(pic)
            else:
                ico = Gtk.Image.new_from_icon_name(cat.icon_name)
                ico.set_pixel_size(18)
                ico.set_vexpand(True)
                thumb_wrap.append(ico)
        else:
            ico = Gtk.Image.new_from_icon_name(cat.icon_name)
            ico.set_pixel_size(18)
            ico.set_vexpand(True)
            thumb_wrap.append(ico)

        mid = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=2)
        mid.set_hexpand(True)
        mid.set_valign(Gtk.Align.CENTER)
        title = Gtk.Label(label=item.display_title)
        title.set_xalign(0.0)
        title.set_ellipsize(3)
        attrs = Pango.AttrList()
        attrs.insert(Pango.attr_weight_new(Pango.Weight.SEMIBOLD))
        title.set_attributes(attrs)

        if cat in (DisplayCategory.IMAGE, DisplayCategory.FILE):
            sub_txt = f"{cat.label} · {item.source_label} · {item.formatted_size}"
        else:
            sub_txt = re.sub(r"\s+", " ", item.effective_text).strip()
        excerpt = Gtk.Label(label=sub_txt[:140])
        excerpt.add_css_class("lumen-subheading")
        excerpt.set_xalign(0.0)
        excerpt.set_ellipsize(3)
        mid.append(title)
        mid.append(excerpt)

        right = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=4)
        right.set_valign(Gtk.Align.CENTER)
        right.set_halign(Gtk.Align.END)
        t_lbl = Gtk.Label(label=item.relative_time)
        t_lbl.add_css_class("lumen-subheading")
        right.append(t_lbl)
        if item.pinned:
            pin = Gtk.Image.new_from_icon_name("view-pin-symbolic")
            pin.set_pixel_size(12)
            pin.set_halign(Gtk.Align.END)
            right.append(pin)

        self.append(thumb_wrap)
        self.append(mid)
        self.append(right)

        click = Gtk.GestureClick.new()
        click.set_button(1)
        click.connect(
            "pressed",
            lambda g, n_press, _x, _y: on_click(item.id, g.get_current_event_state(), n_press),
        )
        self.add_controller(click)

        rclick = Gtk.GestureClick.new()
        rclick.set_button(3)
        rclick.connect("pressed", lambda _g, _n, x, y: on_right_click(item.id, self, x, y))
        self.add_controller(rclick)


class GalleryCardWidget(Gtk.Box):
    """Gallery mode grid card (full border highlight on selection, NO left bar)."""

    def __init__(
        self,
        item: ClipboardItem,
        selected: bool,
        palette: LumenPalette,
        on_click: Callable[[str, Gdk.ModifierType, int], None],
        on_right_click: Callable[[str, Gtk.Widget, float, float], None],
    ) -> None:
        super().__init__(orientation=Gtk.Orientation.VERTICAL, spacing=6)
        self.item = item
        self.add_css_class("lumen-gallery-card")
        if selected:
            self.add_css_class("lumen-selected")
        self.set_size_request(178, 174)

        cat = item.display_category
        head = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        dot = ColorSwatchWidget(palette.source_badge_color(item.source_label), radius=4.0)
        dot.set_size_request(13, 13)
        dot.set_valign(Gtk.Align.CENTER)
        src = Gtk.Label(label=item.source_label)
        src.add_css_class("lumen-subheading")
        src.set_xalign(0.0)
        src.set_hexpand(True)
        src.set_ellipsize(3)
        tm = Gtk.Label(label=item.relative_time)
        tm.add_css_class("lumen-subheading")
        head.append(dot)
        head.append(src)
        head.append(tm)

        title = Gtk.Label(label=item.display_title)
        title.set_xalign(0.0)
        title.set_ellipsize(3)
        attrs = Pango.AttrList()
        attrs.insert(Pango.attr_weight_new(Pango.Weight.SEMIBOLD))
        title.set_attributes(attrs)

        body = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
        body.set_vexpand(True)
        if cat == DisplayCategory.COLOR:
            parsed = Classifier.parse_hex_color(item.effective_text) or (0.33, 0.43, 0.88, 1.0)
            sw = ColorSwatchWidget(radius=8.0)
            sw.set_swatch(*parsed)
            sw.set_hexpand(True)
            sw.set_vexpand(True)
            body.append(sw)
        elif cat == DisplayCategory.IMAGE:
            cache = BoundedPreviewCache.shared()
            tkey = f"thumb:{item.id}"
            tex = cache.image(tkey)
            if tex is None and item.thumbnail_data_url:
                tex = decode_data_url_texture(item.thumbnail_data_url)
                if tex is not None:
                    cache.store_image(tkey, tex)
            if tex is not None:
                pic = Gtk.Picture.new_for_paintable(tex)
                pic.set_content_fit(Gtk.ContentFit.COVER)
                pic.set_vexpand(True)
                body.append(pic)
            else:
                ico = Gtk.Image.new_from_icon_name("image-x-generic-symbolic")
                ico.set_pixel_size(28)
                ico.set_vexpand(True)
                body.append(ico)
        elif cat == DisplayCategory.CODE:
            cbox = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
            cbox.add_css_class("lumen-orbit-code-body")
            cbox.set_vexpand(True)
            clbl = Gtk.Label()
            clbl.set_xalign(0.0)
            clbl.set_yalign(0.0)
            clbl.set_wrap(True)
            clbl.set_lines(4)
            clbl.set_ellipsize(3)
            lang = Classifier.detect_language(item.primary_file_path, item.effective_text)
            clbl.set_markup(SyntaxTokenizer.to_pango_markup(item.effective_text, lang, dark_canvas=True, max_chars=200))
            cbox.append(clbl)
            body.append(cbox)
        else:
            ex = Gtk.Label(label=item.effective_text[:150])
            ex.add_css_class("lumen-muted")
            ex.set_xalign(0.0)
            ex.set_yalign(0.0)
            ex.set_wrap(True)
            ex.set_lines(4)
            ex.set_ellipsize(3)
            body.append(ex)

        foot = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=5)
        fi = Gtk.Image.new_from_icon_name(cat.icon_name)
        fi.set_pixel_size(12)
        fl = Gtk.Label(label=cat.label)
        fl.add_css_class("lumen-subheading")
        fl.set_xalign(0.0)
        fl.set_hexpand(True)
        foot.append(fi)
        foot.append(fl)
        if item.pinned:
            pi = Gtk.Image.new_from_icon_name("view-pin-symbolic")
            pi.set_pixel_size(12)
            foot.append(pi)

        self.append(head)
        self.append(title)
        self.append(body)
        self.append(foot)

        click = Gtk.GestureClick.new()
        click.set_button(1)
        click.connect(
            "pressed",
            lambda g, n_press, _x, _y: on_click(item.id, g.get_current_event_state(), n_press),
        )
        self.add_controller(click)

        rclick = Gtk.GestureClick.new()
        rclick.set_button(3)
        rclick.connect("pressed", lambda _g, _n, x, y: on_right_click(item.id, self, x, y))
        self.add_controller(rclick)


class InspectorView(Gtk.Box):
    """Right-hand detail inspector supporting both single-item and batch multi-select views."""

    def __init__(self) -> None:
        super().__init__(orientation=Gtk.Orientation.VERTICAL, spacing=0)
        self.add_css_class("lumen-inspector")
        self.set_size_request(300, -1)
        self.set_hexpand(True)
        self.set_vexpand(True)

        self.on_copy_single: Optional[Callable[[ClipboardItem], None]] = None
        self.on_preview_single: Optional[Callable[[ClipboardItem], None]] = None
        self.on_pin_single: Optional[Callable[[ClipboardItem], None]] = None
        self.on_delete_single: Optional[Callable[[ClipboardItem], None]] = None
        self.on_batch_preview: Optional[Callable[[list[ClipboardItem]], None]] = None
        self.on_batch_pin: Optional[Callable[[list[ClipboardItem]], None]] = None
        self.on_batch_delete: Optional[Callable[[list[ClipboardItem]], None]] = None
        self.on_clear_selection: Optional[Callable[[], None]] = None

    def _clear(self) -> None:
        while True:
            child = self.get_first_child()
            if child is None:
                break
            self.remove(child)

    def render(self, single: Optional[ClipboardItem], batch: list[ClipboardItem], palette: LumenPalette) -> None:
        self._clear()
        if len(batch) > 1:
            self._build_batch_view(batch)
            return
        if single is None:
            empty = Gtk.Label(label="选择一条记录查看预览与详情")
            empty.add_css_class("lumen-muted")
            empty.set_halign(Gtk.Align.CENTER)
            empty.set_valign(Gtk.Align.CENTER)
            empty.set_vexpand(True)
            self.append(empty)
            return
        self._build_single_view(single, palette)

    def _build_batch_view(self, items: list[ClipboardItem]) -> None:
        top = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        top.set_margin_top(10)
        top.set_margin_bottom(8)
        top.set_margin_start(16)
        top.set_margin_end(12)
        title = Gtk.Label(label="多选批量操作")
        title.add_css_class("lumen-heading")
        title.set_xalign(0.0)
        title.set_hexpand(True)
        cancel = Gtk.Button.new_from_icon_name("window-close-symbolic")
        cancel.add_css_class("lumen-icon-btn")
        cancel.set_tooltip_text("取消多选 (Esc)")
        cancel.connect("clicked", lambda _b: self.on_clear_selection() if self.on_clear_selection else None)
        top.append(title)
        top.append(cancel)
        self.append(top)

        center = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12)
        center.set_halign(Gtk.Align.CENTER)
        center.set_valign(Gtk.Align.CENTER)
        center.set_vexpand(True)
        center.set_margin_start(20)
        center.set_margin_end(20)

        ico = Gtk.Image.new_from_icon_name("view-grid-symbolic")
        ico.set_pixel_size(48)
        cnt = Gtk.Label(label=f"{len(items)} 条记录")
        attrs = Pango.AttrList()
        attrs.insert(Pango.attr_scale_new(1.5))
        attrs.insert(Pango.attr_weight_new(Pango.Weight.SEMIBOLD))
        cnt.set_attributes(attrs)
        sub = Gtk.Label(label="对所选记录执行批量预览、固定或清理")
        sub.add_css_class("lumen-muted")

        preview_btn = Gtk.Button(label=f"批量预览 · {len(items)} 项")
        preview_btn.add_css_class("lumen-primary-btn")
        preview_btn.set_size_request(210, -1)
        preview_btn.connect("clicked", lambda _b: self.on_batch_preview(items) if self.on_batch_preview else None)

        row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        row.set_halign(Gtk.Align.CENTER)
        pin_btn = Gtk.Button(label="批量固定")
        pin_btn.add_css_class("lumen-secondary-btn")
        pin_btn.connect("clicked", lambda _b: self.on_batch_pin(items) if self.on_batch_pin else None)
        del_btn = Gtk.Button(label="批量移除")
        del_btn.add_css_class("lumen-danger-btn")
        del_btn.connect("clicked", lambda _b: self.on_batch_delete(items) if self.on_batch_delete else None)
        row.append(pin_btn)
        row.append(del_btn)

        for w in (ico, cnt, sub, preview_btn, row):
            center.append(w)
        self.append(center)

    def _build_single_view(self, item: ClipboardItem, palette: LumenPalette) -> None:
        kind = PreviewItem.classify_item(item)

        top = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        top.set_margin_top(10)
        top.set_margin_bottom(8)
        top.set_margin_start(16)
        top.set_margin_end(12)

        t_ico = Gtk.Image.new_from_icon_name(item.display_category.icon_name)
        t_ico.set_pixel_size(14)
        t_lbl = Gtk.Label(label=f"{kind.display_label}预览")
        t_lbl.add_css_class("lumen-heading")
        t_lbl.set_xalign(0.0)
        t_lbl.set_hexpand(True)

        expand_btn = Gtk.Button.new_from_icon_name("view-fullscreen-symbolic")
        expand_btn.add_css_class("lumen-icon-btn")
        expand_btn.set_tooltip_text("完整预览 (Space)")
        expand_btn.connect("clicked", lambda _b: self.on_preview_single(item) if self.on_preview_single else None)

        pin_btn = Gtk.Button.new_from_icon_name("view-pin-symbolic")
        pin_btn.add_css_class("lumen-icon-btn")
        if item.pinned:
            pin_btn.add_css_class("lumen-active")
        pin_btn.set_tooltip_text("取消固定" if item.pinned else "固定")
        pin_btn.connect("clicked", lambda _b: self.on_pin_single(item) if self.on_pin_single else None)

        del_btn = Gtk.Button.new_from_icon_name("user-trash-symbolic")
        del_btn.add_css_class("lumen-icon-btn")
        del_btn.set_tooltip_text("移除记录 (Delete)")
        del_btn.connect("clicked", lambda _b: self.on_delete_single(item) if self.on_delete_single else None)

        for w in (t_ico, t_lbl, expand_btn, pin_btn, del_btn):
            top.append(w)
        self.append(top)

        # Scrollable middle
        scroll = Gtk.ScrolledWindow()
        scroll.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
        scroll.set_vexpand(True)

        mid = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10)
        mid.set_margin_top(4)
        mid.set_margin_bottom(16)
        mid.set_margin_start(16)
        mid.set_margin_end(16)

        hero = self._make_hero_preview(item, kind)
        mid.append(hero)

        cap_title = Gtk.Label(label=item.display_title)
        cap_title.set_xalign(0.0)
        cap_title.set_wrap(True)
        cap_title.set_selectable(True)
        c_attrs = Pango.AttrList()
        c_attrs.insert(Pango.attr_scale_new(1.25))
        c_attrs.insert(Pango.attr_weight_new(Pango.Weight.SEMIBOLD))
        cap_title.set_attributes(c_attrs)

        cap_sub = Gtk.Label(label=f"{item.source_label} · {item.relative_time}")
        cap_sub.add_css_class("lumen-subheading")
        cap_sub.set_xalign(0.0)

        mid.append(cap_title)
        mid.append(cap_sub)
        mid.append(self._make_meta_grid(item, kind))

        scroll.set_child(mid)
        self.append(scroll)

        # Bottom action bar
        sep = Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL)
        self.append(sep)
        bottom = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        bottom.set_margin_top(12)
        bottom.set_margin_bottom(14)
        bottom.set_margin_start(16)
        bottom.set_margin_end(16)

        copy_btn = Gtk.Button(label="复制内容 ↵")
        copy_btn.add_css_class("lumen-primary-btn")
        copy_btn.set_hexpand(True)
        copy_btn.connect("clicked", lambda _b: self.on_copy_single(item) if self.on_copy_single else None)

        peek_btn = Gtk.Button(label="快速预览")
        peek_btn.add_css_class("lumen-secondary-btn")
        peek_btn.connect("clicked", lambda _b: self.on_preview_single(item) if self.on_preview_single else None)

        bottom.append(copy_btn)
        bottom.append(peek_btn)
        self.append(bottom)

    def _make_hero_preview(self, item: ClipboardItem, kind: object) -> Gtk.Widget:
        is_code = getattr(kind, "category", "") == "code"
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
        box.add_css_class("lumen-hero-code" if is_code else "lumen-hero-box")
        box.set_size_request(-1, 196)
        box.set_tooltip_text("单击打开完整预览")

        click = Gtk.GestureClick.new()
        click.connect("released", lambda _g, _n, _x, _y: self.on_preview_single(item) if self.on_preview_single else None)
        box.add_controller(click)

        cat = getattr(kind, "category", "text")
        if cat == "color":
            parsed = Classifier.parse_hex_color(item.effective_text) or (0.33, 0.43, 0.88, 1.0)
            sw = ColorSwatchWidget(radius=10.0)
            sw.set_swatch(*parsed, label=item.effective_text.strip().upper())
            sw.set_size_request(-1, 170)
            sw.set_hexpand(True)
            box.append(sw)
        elif cat == "image":
            tex = BoundedPreviewCache.shared().image(f"clip:{item.id}") or decode_data_url_texture(item.thumbnail_data_url)
            if tex is not None:
                pic = Gtk.Picture.new_for_paintable(tex)
                pic.set_size_request(-1, 184)
                pic.set_content_fit(Gtk.ContentFit.CONTAIN)
                box.append(pic)
            else:
                ico = Gtk.Image.new_from_icon_name("image-x-generic-symbolic")
                ico.set_pixel_size(44)
                ico.set_vexpand(True)
                box.append(ico)
        elif cat in ("audio", "video"):
            cover = AlbumCoverWidget(
                seed_index=abs(hash(item.id)) % 3,
                badge_text="AUDIO" if cat == "audio" else "VIDEO",
                size=164,
            )
            cover.set_halign(Gtk.Align.CENTER)
            cover.set_valign(Gtk.Align.CENTER)
            box.append(cover)
        elif cat == "code":
            lbl = Gtk.Label()
            lbl.set_xalign(0.0)
            lbl.set_yalign(0.0)
            lbl.set_wrap(True)
            lbl.set_lines(10)
            lbl.set_ellipsize(3)
            lbl.set_markup(
                SyntaxTokenizer.to_pango_markup(
                    item.effective_text,
                    getattr(kind, "subtype", "js") or "js",
                    dark_canvas=True,
                    max_chars=650,
                )
            )
            box.append(lbl)
        elif cat in ("pdf", "office", "collection", "file"):
            ico_name = "application-pdf-symbolic" if cat == "pdf" else "text-x-generic-symbolic"
            ico = Gtk.Image.new_from_icon_name(ico_name)
            ico.set_pixel_size(48)
            ico.set_halign(Gtk.Align.CENTER)
            ico.set_margin_top(18)
            name = Gtk.Label(label=item.display_title)
            name.add_css_class("lumen-heading")
            name.set_wrap(True)
            name.set_justify(Gtk.Justification.CENTER)
            hint = Gtk.Label(label=f"{kind.display_label} · {item.formatted_size} · 点击完整预览")
            hint.add_css_class("lumen-subheading")
            box.append(ico)
            box.append(name)
            box.append(hint)
        else:
            lbl = Gtk.Label(label=item.effective_text[:480])
            lbl.set_xalign(0.0)
            lbl.set_yalign(0.0)
            lbl.set_wrap(True)
            lbl.set_lines(9)
            lbl.set_ellipsize(3)
            box.append(lbl)

        return box

    @staticmethod
    def _make_meta_grid(item: ClipboardItem, kind: object) -> Gtk.Grid:
        entries = [
            ("内容类型", getattr(kind, "display_label", "文本")),
            ("大小", item.formatted_size),
            ("来源", item.source_label),
            ("收藏状态", "已固定" if item.pinned else "未固定"),
            ("落盘状态", "已就绪" if item.materialized else "远端按需拉取"),
            ("出现次数", f"{max(1, item.seen_count)} 次"),
        ]
        grid = Gtk.Grid()
        grid.set_row_spacing(10)
        grid.set_column_spacing(14)
        grid.set_column_homogeneous(True)
        for idx, (k, v) in enumerate(entries):
            cell = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=2)
            kl = Gtk.Label(label=k)
            kl.add_css_class("lumen-subheading")
            kl.set_xalign(0.0)
            vl = Gtk.Label(label=v)
            vl.set_xalign(0.0)
            vl.set_ellipsize(3)
            cell.append(kl)
            cell.append(vl)
            grid.attach(cell, idx % 2, idx // 2, 1, 1)
        return grid


class SettingsView(Gtk.ScrolledWindow):
    """Native 3-tab preferences surface (Orbit / Appearance / Sync & Data)."""

    def __init__(self) -> None:
        super().__init__()
        self.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
        self.set_hexpand(True)
        self.set_vexpand(True)

        self.on_patch_server_settings: Optional[Callable[[dict[str, Any]], None]] = None
        self.on_apply_preferences: Optional[Callable[[LumenVisualPreferences], None]] = None
        self.on_trigger_sync: Optional[Callable[[], None]] = None
        self.on_clear_all_items: Optional[Callable[[], None]] = None

        self._active_tab = "orbit"

        wrap = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=16)
        wrap.set_halign(Gtk.Align.CENTER)
        wrap.set_margin_top(22)
        wrap.set_margin_bottom(28)
        wrap.set_margin_start(24)
        wrap.set_margin_end(24)
        wrap.set_size_request(680, -1)

        self._stack = Gtk.Stack()
        self._stack.set_transition_type(Gtk.StackTransitionType.CROSSFADE)
        self._switcher = Gtk.StackSwitcher()
        self._switcher.set_stack(self._stack)
        self._switcher.set_halign(Gtk.Align.CENTER)

        self._orbit_page = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=14)
        self._appear_page = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=14)
        self._data_page = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=14)

        self._stack.add_titled(self._orbit_page, "orbit", "Orbit 浮层")
        self._stack.add_titled(self._appear_page, "appearance", "外观材质")
        self._stack.add_titled(self._data_page, "data", "同步与数据")

        wrap.append(self._switcher)
        wrap.append(self._stack)
        self.set_child(wrap)

    @staticmethod
    def _clear_box(box: Gtk.Box) -> None:
        while True:
            child = box.get_first_child()
            if child is None:
                break
            box.remove(child)

    def reload(self) -> None:
        store = ClipboardStore.shared()
        self._build_orbit_tab(store)
        self._build_appearance_tab(store)
        self._build_data_tab(store)

    def _build_orbit_tab(self, store: ClipboardStore) -> None:
        self._clear_box(self._orbit_page)
        self._orbit_page.append(MiniOrbitPreviewWidget())
        self._append_heading(
            self._orbit_page,
            "快捷浮层",
            "独立原生贴边轨道（Wayland gtk4-layer-shell / X11 Keep-Above），支持中断式动效与卡片移除重排。",
        )

        pos_values = ["bottom", "left", "right"]
        pos_dd = Gtk.DropDown.new_from_strings(["底部连续轨道", "左侧边栏轨道", "右侧边栏轨道"])
        cur_pos_idx = pos_values.index(store.settings.quick_orbit_position) if store.settings.quick_orbit_position in pos_values else 0
        pos_dd.set_selected(cur_pos_idx)
        pos_dd.connect(
            "notify::selected",
            lambda dd, _p: self._patch({"quickOrbitPosition": pos_values[dd.get_selected()]})
            if pos_values[dd.get_selected()] != store.settings.quick_orbit_position
            else None,
        )

        cap_sw = self._make_switch(
            store.settings.capture_enabled,
            lambda state: self._patch({"captureEnabled": state}),
        )
        part_sw = self._make_switch(
            store.preferences.particles,
            lambda state: self._update_pref(particles=state),
        )
        glow_sw = self._make_switch(
            store.preferences.glow,
            lambda state: self._update_pref(glow=state),
        )
        motion_sw = self._make_switch(
            store.preferences.motion,
            lambda state: self._update_pref(motion=state),
        )

        self._orbit_page.append(
            self._make_group([
                ("贴边位置", "同步写入服务端配置 quickOrbitPosition，并在 Orbit 浮层实时生效。", pos_dd),
                ("本机剪贴板自动采集", "开启后后台记录复制的文本、图片与文件引用。", cap_sw),
                ("高光粒子", "Orbit 轨道背景浮光粒子与卡片移除释放光点。", part_sw),
                ("动态光感", "焦点卡片微光边界与随指针移动的高光镜面反射。", glow_sw),
                ("流畅动效", "关闭后即时切换；始终尊重系统 gtk-enable-animations 设置。", motion_sw),
            ])
        )

    def _build_appearance_tab(self, store: ClipboardStore) -> None:
        self._clear_box(self._appear_page)
        self._append_heading(
            self._appear_page,
            "窗口外观",
            "App 管理窗口、Orbit 快捷浮层与 Quick Look 预览窗口共享同一外观主题。",
        )

        tiles = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=14)
        tiles.set_homogeneous(True)
        tiles.append(self._make_theme_tile("冰川玻璃 · 浅色", False, store.preferences.theme == "light"))
        tiles.append(self._make_theme_tile("深海玻璃 · 深色", True, store.preferences.theme == "dark"))
        self._appear_page.append(tiles)

        cap_lbl = Gtk.Label(label="本机运行时能力：" + " · ".join(CAPABILITIES.summary_lines()))
        cap_lbl.add_css_class("lumen-subheading")
        cap_lbl.set_xalign(0.0)
        cap_lbl.set_wrap(True)
        self._appear_page.append(cap_lbl)

    def _build_data_tab(self, store: ClipboardStore) -> None:
        self._clear_box(self._data_page)
        self._append_heading(
            self._data_page,
            "同步与数据",
            "通过本机 AIH Server 管理接口持久化；管理密钥仅从 IPC、环境变量或只读 SQLite 配置读取。",
        )

        ret_vals = [7, 30, 90, 365]
        ret_dd = Gtk.DropDown.new_from_strings(["7 天", "30 天", "90 天", "365 天"])
        ret_dd.set_selected(ret_vals.index(store.settings.retention_days) if store.settings.retention_days in ret_vals else 1)
        ret_dd.connect(
            "notify::selected",
            lambda dd, _p: self._patch({"retentionDays": ret_vals[dd.get_selected()]})
            if ret_vals[dd.get_selected()] != store.settings.retention_days
            else None,
        )

        max_vals = [200, 500, 1000, 2000]
        max_dd = Gtk.DropDown.new_from_strings(["200 条", "500 条", "1000 条", "2000 条"])
        max_dd.set_selected(max_vals.index(store.settings.max_items) if store.settings.max_items in max_vals else 1)
        max_dd.connect(
            "notify::selected",
            lambda dd, _p: self._patch({"maxItems": max_vals[dd.get_selected()]})
            if max_vals[dd.get_selected()] != store.settings.max_items
            else None,
        )

        sync_sw = self._make_switch(
            store.settings.sync_enabled,
            lambda state: self._patch({"syncEnabled": state}),
        )

        server_labels = ["未选择目标服务器"] + [f"{s.label} ({s.endpoint})" for s in store.servers]
        server_dd = Gtk.DropDown.new_from_strings(server_labels)
        cur_srv_idx = 0
        for i, srv in enumerate(store.servers):
            if srv.id == store.settings.sync_target_profile_id:
                cur_srv_idx = i + 1
                break
        server_dd.set_selected(cur_srv_idx)

        def _on_srv(dd: Gtk.DropDown, _p: Any) -> None:
            idx = dd.get_selected() - 1
            profile_id = store.servers[idx].id if 0 <= idx < len(store.servers) else ""
            if profile_id != store.settings.sync_target_profile_id:
                self._patch({"syncTargetProfileId": profile_id})

        server_dd.connect("notify::selected", _on_srv)

        sync_btn = Gtk.Button(label="立即同步")
        sync_btn.add_css_class("lumen-secondary-btn")
        sync_btn.connect("clicked", lambda _b: self.on_trigger_sync() if self.on_trigger_sync else None)

        clear_btn = Gtk.Button(label="清空当前列表")
        clear_btn.add_css_class("lumen-danger-btn")
        clear_btn.connect("clicked", lambda _b: self.on_clear_all_items() if self.on_clear_all_items else None)

        origin_lbl = Gtk.Label(label=store.api.config.origin or "未配置")
        origin_lbl.add_css_class("lumen-muted")

        dev_lbl = Gtk.Label(label=(store.status.device_name if store.status and store.status.device_name else "本机"))
        dev_lbl.add_css_class("lumen-muted")

        self._data_page.append(
            self._make_group([
                ("本机服务端点", "从 IPC、环境变量或 ~/.ai_home/aih.db 只读解析，绝不硬编码密钥。", origin_lbl),
                ("当前设备", "剪贴板历史来源设备标识。", dev_lbl),
                ("历史保留天数", "超过保留期的未固定记录自动清理。", ret_dd),
                ("最大条目上限", "本地 SQLite 资料库最大保存条数。", max_dd),
                ("跨设备加密同步", "启用后自动将新条目同步至选定中继服务器。", sync_sw),
                ("同步目标服务器", "从 AIH 控制平面服务器配置读取。", server_dd),
                ("手动同步", "立即执行一次增量双向同步。", sync_btn),
                ("清空历史记录", "通过批量删除接口清理当前列表中的所有记录。", clear_btn),
            ])
        )

    @staticmethod
    def _append_heading(parent: Gtk.Box, title: str, subtitle: str) -> None:
        h = Gtk.Label(label=title)
        h.set_xalign(0.0)
        attrs = Pango.AttrList()
        attrs.insert(Pango.attr_scale_new(1.3))
        attrs.insert(Pango.attr_weight_new(Pango.Weight.SEMIBOLD))
        h.set_attributes(attrs)
        p = Gtk.Label(label=subtitle)
        p.add_css_class("lumen-subheading")
        p.set_xalign(0.0)
        p.set_wrap(True)
        parent.append(h)
        parent.append(p)

    @staticmethod
    def _make_switch(active: bool, on_toggle: Callable[[bool], None]) -> Gtk.Switch:
        sw = Gtk.Switch()
        sw.set_active(active)
        sw.set_valign(Gtk.Align.CENTER)
        sw.connect("state-set", lambda _s, state: (on_toggle(bool(state)), False)[1])
        return sw

    @staticmethod
    def _make_group(rows: list[tuple[str, str, Gtk.Widget]]) -> Gtk.Box:
        group = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)
        group.add_css_class("lumen-settings-group")
        for idx, (title, desc, control) in enumerate(rows):
            row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=16)
            row.add_css_class("lumen-setting-row")
            if idx == len(rows) - 1:
                row.add_css_class("lumen-last-row")

            left = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=2)
            left.set_hexpand(True)
            t = Gtk.Label(label=title)
            t.set_xalign(0.0)
            attrs = Pango.AttrList()
            attrs.insert(Pango.attr_weight_new(Pango.Weight.SEMIBOLD))
            t.set_attributes(attrs)
            d = Gtk.Label(label=desc)
            d.add_css_class("lumen-subheading")
            d.set_xalign(0.0)
            d.set_wrap(True)
            left.append(t)
            left.append(d)

            control.set_valign(Gtk.Align.CENTER)
            row.append(left)
            row.append(control)
            group.append(row)
        return group

    def _make_theme_tile(self, title: str, dark: bool, active: bool) -> Gtk.Button:
        btn = Gtk.Button()
        btn.add_css_class("lumen-theme-tile")
        if active:
            btn.add_css_class("lumen-active")

        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
        mock = ColorSwatchWidget("#171b25" if dark else "#f1f3f7", radius=7.0, label="DARK" if dark else "LIGHT")
        mock.set_size_request(-1, 74)
        mock.set_hexpand(True)
        lbl = Gtk.Label(label=title)
        lbl.set_xalign(0.0)
        box.append(mock)
        box.append(lbl)
        btn.set_child(box)
        btn.connect("clicked", lambda _b: self._update_pref(theme="dark" if dark else "light"))
        return btn

    def _patch(self, data: dict[str, Any]) -> None:
        if self.on_patch_server_settings:
            self.on_patch_server_settings(data)

    def _update_pref(self, **kwargs: Any) -> None:
        prefs = ClipboardStore.shared().preferences.copy()
        for k, v in kwargs.items():
            setattr(prefs, k, v)
        if self.on_apply_preferences:
            self.on_apply_preferences(prefs)


class NewClipDialog(Gtk.Window):
    """Native modal sheet for creating a new text, code, or link clip."""

    def __init__(self, parent: Gtk.Window, on_save: Callable[[str], None]) -> None:
        super().__init__(transient_for=parent, modal=True, title="新建剪贴板记录")
        self.add_css_class("lumen-window")
        self.set_default_size(480, 300)
        self._on_save = on_save

        root = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12)
        root.set_margin_top(18)
        root.set_margin_bottom(16)
        root.set_margin_start(20)
        root.set_margin_end(20)

        heading = Gtk.Label(label="输入文本、代码或链接")
        heading.add_css_class("lumen-heading")
        heading.set_xalign(0.0)

        scroll = Gtk.ScrolledWindow()
        scroll.set_vexpand(True)
        scroll.set_hexpand(True)
        scroll.add_css_class("lumen-settings-group")

        self._tv = Gtk.TextView()
        self._tv.set_wrap_mode(Gtk.WrapMode.WORD_CHAR)
        self._tv.set_left_margin(10)
        self._tv.set_right_margin(10)
        self._tv.set_top_margin(8)
        self._tv.set_bottom_margin(8)
        scroll.set_child(self._tv)

        actions = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        actions.set_halign(Gtk.Align.END)
        cancel_btn = Gtk.Button(label="取消")
        cancel_btn.add_css_class("lumen-secondary-btn")
        cancel_btn.connect("clicked", lambda _b: self.close())

        save_btn = Gtk.Button(label="保存")
        save_btn.add_css_class("lumen-primary-btn")
        save_btn.connect("clicked", lambda _b: self._save())

        actions.append(cancel_btn)
        actions.append(save_btn)

        root.append(heading)
        root.append(scroll)
        root.append(actions)
        self.set_child(root)

        key = Gtk.EventControllerKey.new()
        key.connect("key-pressed", self._on_key)
        self.add_controller(key)

    def _on_key(self, _c: Gtk.EventControllerKey, keyval: int, _kc: int, state: Gdk.ModifierType) -> bool:
        if keyval == Gdk.KEY_Escape:
            self.close()
            return True
        if (state & Gdk.ModifierType.CONTROL_MASK) and keyval in (Gdk.KEY_Return, Gdk.KEY_KP_Enter):
            self._save()
            return True
        return False

    def _save(self) -> None:
        buf = self._tv.get_buffer()
        text = buf.get_text(buf.get_start_iter(), buf.get_end_iter(), True)
        self.close()
        if text.strip():
            self._on_save(text)
