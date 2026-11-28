"""Code (priority 84), Collection (82), Text/Link (70), and File Fallback (0) renderers."""

from __future__ import annotations

import os
import threading
from typing import Optional
from urllib.parse import urlparse

from ..capabilities import Gio, GLib, Gtk, GtkSource, Pango
from ..models import Classifier, Formatters
from ..preview_registry import PreviewContext, PreviewItem, PreviewRendererView
from ..theme import SyntaxTokenizer
from .helpers import (
    make_pill_button,
    make_renderer_toolbar,
    open_file_external,
    open_uri_external,
    reveal_file_in_manager,
)


class CodeRendererView(PreviewRendererView):
    """Uses GtkSourceView 5 when installed, else native Gtk.TextView + Pango tokenizer & line gutter."""

    def __init__(self) -> None:
        super().__init__()
        self._language = "js"
        self._content = ""
        self._font_size = 12.5
        self._using_sourceview = GtkSource is not None

        toolbar, self._info_label, right_box = make_renderer_toolbar(dark_override=True)
        self._info_label.set_text("代码预览")
        right_box.append(make_pill_button("A−", self.zoom_out, dark=True))
        right_box.append(make_pill_button("A+", self.zoom_in, dark=True))
        right_box.append(make_pill_button("复制代码", self.copy_primary_content, dark=True))
        self.append(toolbar)

        self._scroll = Gtk.ScrolledWindow()
        self._scroll.set_hexpand(True)
        self._scroll.set_vexpand(True)

        self._gutter_view: Optional[Gtk.TextView] = None
        if self._using_sourceview and GtkSource is not None:
            buf = GtkSource.Buffer.new(None)
            view = GtkSource.View.new_with_buffer(buf)
            view.set_editable(False)
            view.set_show_line_numbers(True)
            view.set_monospace(True)
            view.set_left_margin(12)
            view.set_right_margin(16)
            view.set_top_margin(14)
            view.set_bottom_margin(14)
            self._text_view: Gtk.TextView = view
            self._buffer: Gtk.TextBuffer = buf
            self._scroll.set_child(view)
        else:
            row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=0)
            row.set_hexpand(True)
            row.set_vexpand(True)

            gutter = Gtk.TextView()
            gutter.set_editable(False)
            gutter.set_cursor_visible(False)
            gutter.set_can_focus(False)
            gutter.set_monospace(True)
            gutter.set_justification(Gtk.Justification.RIGHT)
            gutter.set_left_margin(12)
            gutter.set_right_margin(10)
            gutter.set_top_margin(14)
            gutter.set_bottom_margin(14)
            gutter.add_css_class("lumen-code-gutter")
            self._gutter_view = gutter

            tv = Gtk.TextView()
            tv.set_editable(False)
            tv.set_monospace(True)
            tv.set_hexpand(True)
            tv.set_vexpand(True)
            tv.set_left_margin(14)
            tv.set_right_margin(16)
            tv.set_top_margin(14)
            tv.set_bottom_margin(14)
            tv.add_css_class("lumen-code-surface")
            self._text_view = tv
            self._buffer = tv.get_buffer()

            row.append(gutter)
            row.append(tv)
            self._scroll.set_child(row)

        self._font_provider = Gtk.CssProvider()
        self._apply_font_css()
        self.append(self._scroll)

    def _apply_font_css(self) -> None:
        css = f"textview {{ font-size: {self._font_size:.1f}pt; }}"
        self._font_provider.load_from_string(css)
        self._text_view.get_style_context().add_provider(
            self._font_provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION + 1
        )
        if self._gutter_view is not None:
            self._gutter_view.get_style_context().add_provider(
                self._font_provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION + 1
            )

    def load(self, item: PreviewItem, context: PreviewContext) -> None:
        super().load(item, context)
        gen = self.next_generation()
        self._language = item.kind.subtype or "js"

        cached = context.cache.text(item.cache_key)
        if cached is not None:
            self._apply_code(cached)
            return

        if item.local_path and os.path.isfile(item.local_path):
            path = item.local_path

            def _worker() -> None:
                try:
                    with open(path, "rb") as fh:
                        text = fh.read(128_000).decode("utf-8", errors="replace")
                except OSError:
                    text = ""
                GLib.idle_add(self._finish_text, text, item.cache_key, context, gen)

            threading.Thread(target=_worker, name="lumen-code-local", daemon=True).start()
            return

        if item.inline_text is not None:
            self._apply_code(item.inline_text)

        if item.clipboard_item is None:
            return

        if item.clipboard_item.kind == "file":
            def _ok_file(res: tuple[bytes, str]) -> None:
                if not self.is_current_generation(gen):
                    return
                text = res[0][:128_000].decode("utf-8", errors="replace")
                context.cache.store_text(item.cache_key, text)
                self._apply_code(text)

            context.store.api.fetch_item_file_data(
                item.clipboard_item.id,
                index=item.file_index or 0,
                on_success=_ok_file,
            )
        else:
            def _ok_detail(detailed: Optional[object]) -> None:
                if not self.is_current_generation(gen) or detailed is None:
                    return
                full = getattr(detailed, "effective_text", "")
                context.cache.store_text(item.cache_key, full)
                self._apply_code(full)

            context.store.hydrate_item_detail(item.clipboard_item.id, _ok_detail)

    def _finish_text(self, text: str, cache_key: str, context: PreviewContext, gen: int) -> bool:
        if not self.is_current_generation(gen):
            return False
        context.cache.store_text(cache_key, text)
        self._apply_code(text)
        return False

    def _apply_code(self, source: str) -> None:
        self._content = source
        line_count = max(1, source.count("\n") + 1)
        lang_name = Classifier.language_display_name(self._language)
        engine = "GtkSourceView" if self._using_sourceview else "Pango"
        self._info_label.set_text(f"● {lang_name} · {line_count} 行 · UTF-8 ({engine})")

        if self._using_sourceview and GtkSource is not None:
            self._buffer.set_text(source[:48_000])
            lm = GtkSource.LanguageManager.get_default()
            lang_map = {"py": "python3", "js": "js", "ts": "typescript", "sh": "sh", "rs": "rust", "rust": "rust"}
            gtks_lang = lm.get_language(lang_map.get(self._language, self._language))
            if gtks_lang is not None:
                self._buffer.set_language(gtks_lang)
            ssm = GtkSource.StyleSchemeManager.get_default()
            for scheme_id in ("Adwaita-dark", "oblivion", "cobalt", "classic-dark"):
                scheme = ssm.get_scheme(scheme_id)
                if scheme is not None:
                    self._buffer.set_style_scheme(scheme)
                    break
        else:
            SyntaxTokenizer.apply_to_text_buffer(self._buffer, source, self._language, dark_canvas=True)
            if self._gutter_view is not None:
                shown_lines = max(1, source[:48_000].count("\n") + 1)
                self._gutter_view.get_buffer().set_text("\n".join(str(i) for i in range(1, shown_lines + 1)))

    def zoom_in(self) -> None:
        self._font_size = min(22.0, self._font_size + 1.5)
        self._apply_font_css()

    def zoom_out(self) -> None:
        self._font_size = max(9.0, self._font_size - 1.5)
        self._apply_font_css()

    def reset_zoom(self) -> None:
        self._font_size = 12.5
        self._apply_font_css()


class CodeRenderer:
    renderer_id = "native.gtk4.code"
    priority = 84

    def can_render(self, item: PreviewItem) -> bool:
        return item.kind.category == "code"

    def create_view(self, item: PreviewItem, context: PreviewContext) -> PreviewRendererView:
        return CodeRendererView()


class CollectionRendererView(PreviewRendererView):
    def __init__(self) -> None:
        super().__init__()
        self._scroll = Gtk.ScrolledWindow()
        self._scroll.set_hexpand(True)
        self._scroll.set_vexpand(True)

        self._stack = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
        self._stack.set_margin_top(22)
        self._stack.set_margin_bottom(24)
        self._stack.set_margin_start(28)
        self._stack.set_margin_end(28)
        self._scroll.set_child(self._stack)
        self.append(self._scroll)

    def load(self, item: PreviewItem, context: PreviewContext) -> None:
        super().load(item, context)
        while True:
            child = self._stack.get_first_child()
            if child is None:
                break
            self._stack.remove(child)

        heading = Gtk.Label(label=f"文件集合 · {len(item.collection_children)} 项")
        heading.add_css_class("lumen-heading")
        heading.set_xalign(0.0)
        self._stack.append(heading)

        for idx, child_item in enumerate(item.collection_children):
            btn = Gtk.Button()
            btn.add_css_class("lumen-secondary-btn")
            row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=10)
            row.set_hexpand(True)

            badge = Gtk.Label(label=child_item.kind.badge_code)
            badge.add_css_class("lumen-orbit-key")
            name = Gtk.Label(label=child_item.title)
            name.set_xalign(0.0)
            name.set_hexpand(True)
            name.set_ellipsize(2)  # MIDDLE
            meta = Gtk.Label(label=f"{child_item.kind.display_label} · {child_item.size_label}")
            meta.add_css_class("lumen-muted")

            row.append(badge)
            row.append(name)
            row.append(meta)
            btn.set_child(row)
            btn.connect("clicked", lambda _b, i=idx: context.on_select_queue_index(i))
            self._stack.append(btn)


class CollectionRenderer:
    renderer_id = "native.gtk4.collection"
    priority = 82

    def can_render(self, item: PreviewItem) -> bool:
        return item.kind.category == "collection"

    def create_view(self, item: PreviewItem, context: PreviewContext) -> PreviewRendererView:
        return CollectionRendererView()


class TextRendererView(PreviewRendererView):
    def __init__(self) -> None:
        super().__init__()
        self._font_size = 13.5
        self._active_url: Optional[str] = None

        toolbar, self._info_label, right_box = make_renderer_toolbar()
        self._info_label.set_text("文本预览")

        self._open_link_btn = make_pill_button("打开链接", self._open_link)
        self._open_link_btn.set_visible(False)
        right_box.append(self._open_link_btn)
        right_box.append(make_pill_button("复制内容", self.copy_primary_content))
        self.append(toolbar)

        scroll = Gtk.ScrolledWindow()
        scroll.set_hexpand(True)
        scroll.set_vexpand(True)

        self._text_view = Gtk.TextView()
        self._text_view.set_editable(False)
        self._text_view.set_wrap_mode(Gtk.WrapMode.WORD_CHAR)
        self._text_view.set_left_margin(28)
        self._text_view.set_right_margin(28)
        self._text_view.set_top_margin(22)
        self._text_view.set_bottom_margin(22)
        self._text_view.set_pixels_below_lines(4)
        self._buffer = self._text_view.get_buffer()

        self._font_provider = Gtk.CssProvider()
        self._apply_font_css()

        scroll.set_child(self._text_view)
        self.append(scroll)

    def _apply_font_css(self) -> None:
        self._font_provider.load_from_string(f"textview {{ font-size: {self._font_size:.1f}pt; }}")
        self._text_view.get_style_context().add_provider(
            self._font_provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION + 1
        )

    def load(self, item: PreviewItem, context: PreviewContext) -> None:
        super().load(item, context)
        gen = self.next_generation()
        self._active_url = None
        self._open_link_btn.set_visible(False)
        is_link = item.kind.category == "link"

        cached = context.cache.text(item.cache_key)
        if cached is not None:
            self._apply_text(cached, is_link)
            return

        if item.local_path and os.path.isfile(item.local_path):
            path = item.local_path

            def _worker() -> None:
                try:
                    with open(path, "rb") as fh:
                        text = fh.read(128_000).decode("utf-8", errors="replace")
                except OSError:
                    text = ""
                GLib.idle_add(self._finish_text, text, False, item.cache_key, context, gen)

            threading.Thread(target=_worker, name="lumen-text-local", daemon=True).start()
            return

        if item.inline_text is not None:
            self._apply_text(item.inline_text, is_link)

        if item.clipboard_item is None:
            return

        if item.clipboard_item.kind == "file":
            def _ok_file(res: tuple[bytes, str]) -> None:
                if not self.is_current_generation(gen):
                    return
                text = res[0][:128_000].decode("utf-8", errors="replace")
                context.cache.store_text(item.cache_key, text)
                self._apply_text(text, False)

            context.store.api.fetch_item_file_data(
                item.clipboard_item.id,
                index=item.file_index or 0,
                on_success=_ok_file,
            )
        else:
            def _ok_detail(detailed: Optional[object]) -> None:
                if not self.is_current_generation(gen) or detailed is None:
                    return
                full = getattr(detailed, "effective_text", "")
                context.cache.store_text(item.cache_key, full)
                self._apply_text(full, is_link)

            context.store.hydrate_item_detail(item.clipboard_item.id, _ok_detail)

    def _finish_text(self, text: str, is_link: bool, cache_key: str, context: PreviewContext, gen: int) -> bool:
        if not self.is_current_generation(gen):
            return False
        context.cache.store_text(cache_key, text)
        self._apply_text(text, is_link)
        return False

    def _apply_text(self, content: str, is_link: bool) -> None:
        self._buffer.set_text(content)
        lines = max(1, content.count("\n") + 1)
        bcount = Formatters.byte_count(len(content.encode("utf-8")))
        self._info_label.set_text(f"{'链接' if is_link else '文本'} · {len(content)} 字 · {lines} 行 · {bcount}")
        trimmed = content.strip()
        parsed = urlparse(trimmed)
        if is_link and parsed.scheme in ("http", "https") and parsed.netloc:
            self._active_url = trimmed
            self._open_link_btn.set_visible(True)

    def _open_link(self) -> None:
        if self._active_url:
            open_uri_external(
                self._active_url,
                parent=self.current_context.parent_window if self.current_context else None,
            )

    def zoom_in(self) -> None:
        self._font_size = min(24.0, self._font_size + 2.0)
        self._apply_font_css()

    def zoom_out(self) -> None:
        self._font_size = max(10.0, self._font_size - 2.0)
        self._apply_font_css()

    def reset_zoom(self) -> None:
        self._font_size = 13.5
        self._apply_font_css()


class TextRenderer:
    renderer_id = "native.gtk4.text"
    priority = 70

    def can_render(self, item: PreviewItem) -> bool:
        return item.kind.category in ("text", "link")

    def create_view(self, item: PreviewItem, context: PreviewContext) -> PreviewRendererView:
        return TextRendererView()


class FileFallbackRendererView(PreviewRendererView):
    def __init__(self) -> None:
        super().__init__()
        wrap = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12)
        wrap.set_halign(Gtk.Align.CENTER)
        wrap.set_valign(Gtk.Align.CENTER)
        wrap.set_hexpand(True)
        wrap.set_vexpand(True)
        wrap.set_margin_start(32)
        wrap.set_margin_end(32)

        self._icon = Gtk.Image.new_from_icon_name("text-x-generic-symbolic")
        self._icon.set_pixel_size(64)

        self._name_lbl = Gtk.Label(label="")
        self._name_lbl.add_css_class("lumen-heading")
        self._name_lbl.set_ellipsize(2)
        self._name_lbl.set_max_width_chars(56)

        self._meta_lbl = Gtk.Label(label="")
        self._meta_lbl.add_css_class("lumen-muted")
        self._meta_lbl.set_wrap(True)
        self._meta_lbl.set_justify(Gtk.Justification.CENTER)
        self._meta_lbl.set_max_width_chars(58)

        actions = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=10)
        actions.set_halign(Gtk.Align.CENTER)
        actions.append(make_pill_button("在文件管理器中显示", self._reveal))
        actions.append(make_pill_button("默认应用打开", self._open))
        actions.append(make_pill_button("复制引用", self.copy_primary_content))

        for w in (self._icon, self._name_lbl, self._meta_lbl, actions):
            wrap.append(w)
        self.append(wrap)

    def load(self, item: PreviewItem, context: PreviewContext) -> None:
        super().load(item, context)
        self._name_lbl.set_text(item.title)
        if item.local_path and os.path.exists(item.local_path):
            try:
                gfile = Gio.File.new_for_path(item.local_path)
                info = gfile.query_info("standard::icon", Gio.FileQueryInfoFlags.NONE, None)
                gicon = info.get_icon()
                if gicon is not None:
                    self._icon.set_from_gicon(gicon)
            except Exception:
                self._icon.set_from_icon_name("text-x-generic-symbolic")
            self._meta_lbl.set_text(
                f"{item.local_path}\n{item.size_label} · 尚无此格式的内置渲染器，可调用系统默认应用打开。"
            )
        else:
            self._icon.set_from_icon_name("text-x-generic-symbolic")
            self._meta_lbl.set_text(f"{item.size_label} · 尚无此格式的内置渲染器。")

    def _reveal(self) -> None:
        if self.current_item and self.current_item.local_path:
            reveal_file_in_manager(
                self.current_item.local_path,
                parent=self.current_context.parent_window if self.current_context else None,
            )

    def _open(self) -> None:
        if self.current_item and self.current_item.local_path:
            open_file_external(
                self.current_item.local_path,
                parent=self.current_context.parent_window if self.current_context else None,
            )


class FileFallbackRenderer:
    renderer_id = "native.gtk4.file.fallback"
    priority = 0

    def can_render(self, item: PreviewItem) -> bool:
        return True

    def create_view(self, item: PreviewItem, context: PreviewContext) -> PreviewRendererView:
        return FileFallbackRendererView()
