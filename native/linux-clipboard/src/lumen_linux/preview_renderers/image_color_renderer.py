"""Native GdkTexture Image (priority 88) and GSK Color Swatch (priority 86) renderers."""

from __future__ import annotations

import colorsys
import os
import threading
from typing import Optional

from ..capabilities import Gdk, GLib, Gtk, Pango
from ..models import Classifier, decode_data_url_texture, texture_from_bytes
from ..preview_registry import PreviewContext, PreviewItem, PreviewRendererView
from ..theme import ColorSwatchWidget
from .helpers import make_pill_button, make_renderer_toolbar


class ImageRendererView(PreviewRendererView):
    def __init__(self) -> None:
        super().__init__()
        self._texture: Optional[Gdk.Texture] = None
        self._zoom_factor: float = 1.0
        self._fit_mode: bool = True

        toolbar, self._info_label, right_box = make_renderer_toolbar()
        self._info_label.set_text("图片预览")
        self._zoom_label = Gtk.Label(label="适配")
        self._zoom_label.add_css_class("lumen-muted")

        right_box.append(make_pill_button("−", self.zoom_out))
        right_box.append(self._zoom_label)
        right_box.append(make_pill_button("+", self.zoom_in))
        right_box.append(make_pill_button("适配", self.reset_zoom))
        self.append(toolbar)

        self._scroll = Gtk.ScrolledWindow()
        self._scroll.set_hexpand(True)
        self._scroll.set_vexpand(True)

        self._picture = Gtk.Picture()
        self._picture.set_can_shrink(True)
        self._picture.set_content_fit(Gtk.ContentFit.CONTAIN)
        self._picture.set_halign(Gtk.Align.CENTER)
        self._picture.set_valign(Gtk.Align.CENTER)
        self._picture.set_margin_top(16)
        self._picture.set_margin_bottom(16)
        self._picture.set_margin_start(16)
        self._picture.set_margin_end(16)

        self._scroll.set_child(self._picture)
        self.append(self._scroll)

    def load(self, item: PreviewItem, context: PreviewContext) -> None:
        super().load(item, context)
        gen = self.next_generation()
        self._fit_mode = True
        self._zoom_factor = 1.0
        self._zoom_label.set_text("适配")

        cached = context.cache.image(item.cache_key)
        if cached is not None:
            self._present_texture(cached, item)
            return

        if item.clipboard_item and item.clipboard_item.thumbnail_data_url:
            thumb = decode_data_url_texture(item.clipboard_item.thumbnail_data_url)
            if thumb is not None:
                self._present_texture(thumb, item)

        if item.local_path and os.path.isfile(item.local_path):
            path = item.local_path

            def _worker() -> None:
                try:
                    tex = Gdk.Texture.new_from_filename(path)
                except Exception:
                    tex = None
                GLib.idle_add(self._finish_texture, tex, item, context, gen)

            threading.Thread(target=_worker, name="lumen-img-local", daemon=True).start()
            return

        if item.clipboard_item is None:
            return

        def _on_data(res: tuple[bytes, str]) -> None:
            if not self.is_current_generation(gen):
                return
            tex = texture_from_bytes(res[0])
            if tex is not None:
                context.cache.store_image(item.cache_key, tex)
                self._present_texture(tex, item)

        if item.clipboard_item.kind == "file":
            context.store.api.fetch_item_file_data(
                item.clipboard_item.id,
                index=item.file_index or 0,
                on_success=_on_data,
            )
        else:
            context.store.api.fetch_item_content(item.clipboard_item.id, on_success=_on_data)

    def _finish_texture(
        self,
        tex: Optional[Gdk.Texture],
        item: PreviewItem,
        context: PreviewContext,
        gen: int,
    ) -> bool:
        if not self.is_current_generation(gen):
            return False
        if tex is not None:
            context.cache.store_image(item.cache_key, tex)
            self._present_texture(tex, item)
        return False

    def _present_texture(self, tex: Gdk.Texture, item: PreviewItem) -> None:
        self._texture = tex
        self._picture.set_paintable(tex)
        w, h = tex.get_width(), tex.get_height()
        self._info_label.set_text(f"图片 · {w} × {h} · {item.size_label}")
        self._apply_zoom_size()

    def _apply_zoom_size(self) -> None:
        if self._texture is None:
            return
        if self._fit_mode:
            self._picture.set_size_request(-1, -1)
            self._picture.set_hexpand(True)
            self._picture.set_vexpand(True)
            self._picture.set_content_fit(Gtk.ContentFit.CONTAIN)
            return
        w = max(64, int(round(self._texture.get_width() * self._zoom_factor)))
        h = max(64, int(round(self._texture.get_height() * self._zoom_factor)))
        self._picture.set_hexpand(False)
        self._picture.set_vexpand(False)
        self._picture.set_size_request(w, h)

    def zoom_in(self) -> None:
        self._fit_mode = False
        self._zoom_factor = min(4.0, self._zoom_factor + 0.25)
        self._zoom_label.set_text(f"{int(self._zoom_factor * 100)}%")
        self._apply_zoom_size()

    def zoom_out(self) -> None:
        self._fit_mode = False
        self._zoom_factor = max(0.25, self._zoom_factor - 0.25)
        self._zoom_label.set_text(f"{int(self._zoom_factor * 100)}%")
        self._apply_zoom_size()

    def reset_zoom(self) -> None:
        self._fit_mode = True
        self._zoom_factor = 1.0
        self._zoom_label.set_text("适配")
        self._apply_zoom_size()

    def teardown(self) -> None:
        super().teardown()
        self._picture.set_paintable(None)
        self._texture = None


class ImageRenderer:
    renderer_id = "native.gtk4.gdktexture.image"
    priority = 88

    def can_render(self, item: PreviewItem) -> bool:
        return item.kind.category == "image"

    def create_view(self, item: PreviewItem, context: PreviewContext) -> PreviewRendererView:
        return ImageRendererView()


class ColorRendererView(PreviewRendererView):
    def __init__(self) -> None:
        super().__init__()
        wrap = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12)
        wrap.set_halign(Gtk.Align.CENTER)
        wrap.set_valign(Gtk.Align.CENTER)
        wrap.set_hexpand(True)
        wrap.set_vexpand(True)

        self._swatch = ColorSwatchWidget(radius=18.0)
        self._swatch.set_size_request(360, 210)
        self._swatch.set_halign(Gtk.Align.CENTER)

        self._hex_lbl = Gtk.Label(label="")
        self._hex_lbl.set_selectable(True)
        hex_attrs = Pango.AttrList()
        hex_attrs.insert(Pango.attr_scale_new(2.0))
        hex_attrs.insert(Pango.attr_weight_new(Pango.Weight.BOLD))
        hex_attrs.insert(Pango.attr_family_new("Monospace"))
        self._hex_lbl.set_attributes(hex_attrs)

        self._rgb_lbl = Gtk.Label(label="")
        self._rgb_lbl.add_css_class("lumen-muted")
        self._rgb_lbl.set_selectable(True)

        self._hsb_lbl = Gtk.Label(label="")
        self._hsb_lbl.add_css_class("lumen-muted")
        self._hsb_lbl.set_selectable(True)

        copy_btn = make_pill_button("复制色值", self.copy_primary_content)
        copy_btn.set_halign(Gtk.Align.CENTER)

        for w in (self._swatch, self._hex_lbl, self._rgb_lbl, self._hsb_lbl, copy_btn):
            wrap.append(w)
        self.append(wrap)

    def load(self, item: PreviewItem, context: PreviewContext) -> None:
        super().load(item, context)
        raw = (item.inline_text or item.title).strip()
        parsed = Classifier.parse_hex_color(raw) or (0.33, 0.43, 0.88, 1.0)
        r, g, b, a = parsed
        self._swatch.set_swatch(r, g, b, a, label="")
        self._hex_lbl.set_text(raw.upper())
        self._rgb_lbl.set_text(f"RGB({int(round(r * 255))}, {int(round(g * 255))}, {int(round(b * 255))})")
        h, s, v = colorsys.rgb_to_hsv(r, g, b)
        self._hsb_lbl.set_text(f"HSB({round(h * 360)}°, {round(s * 100)}%, {round(v * 100)}%)")


class ColorRenderer:
    renderer_id = "native.gtk4.color"
    priority = 86

    def can_render(self, item: PreviewItem) -> bool:
        return item.kind.category == "color"

    def create_view(self, item: PreviewItem, context: PreviewContext) -> PreviewRendererView:
        return ColorRendererView()
