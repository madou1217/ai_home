"""Native PDF preview renderer (priority 100).

Rendering chain:
1. Poppler-GLib (GI `Poppler 0.18`) + `pycairo` rendered directly to `Gdk.MemoryTexture`
   with thumbnail page rail, zoom (50%-250% / Fit), and keyboard page stepping.
2. `pdftoppm` CLI fallback (if poppler-utils is installed without GI bindings).
3. Graceful native metadata & external-open view (extracts PDF version/page count/title
   from raw PDF bytes without external dependencies).
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import tempfile
import threading
from dataclasses import dataclass
from typing import Any, Optional

from ..capabilities import Gdk, Gio, GLib, Gtk, Poppler, pycairo
from ..models import Formatters, texture_from_bytes
from ..preview_registry import PreviewContext, PreviewItem, PreviewRendererView
from .helpers import make_pill_button, make_renderer_toolbar, open_file_external, reveal_file_in_manager


@dataclass
class _PdfMetadata:
    version: str = "1.4"
    page_count: int = 0
    title: str = ""
    byte_size: int = 0


def _inspect_pdf_metadata(data: bytes) -> _PdfMetadata:
    meta = _PdfMetadata(byte_size=len(data))
    if not data:
        return meta
    head = data[:32].decode("latin-1", errors="ignore")
    m_ver = re.search(r"%PDF-(\d+\.\d+)", head)
    if m_ver:
        meta.version = m_ver.group(1)
    # Count explicit /Type /Page objects or /Count N in Pages tree.
    counts = [int(m.group(1)) for m in re.finditer(rb"/Count\s+(\d+)", data[:2_000_000])]
    if counts:
        meta.page_count = max(counts)
    else:
        meta.page_count = len(re.findall(rb"/Type\s*/Page\b(?!s)", data[:2_000_000]))
    m_title = re.search(rb"/Title\s*\(([^)]{1,120})\)", data[:512_000])
    if m_title:
        try:
            meta.title = m_title.group(1).decode("utf-8", errors="ignore").strip()
        except Exception:
            pass
    return meta


def _render_poppler_page_to_texture(page: Any, scale: float) -> Optional[Gdk.Texture]:
    if pycairo is None:
        return None
    try:
        pw, ph = page.get_size()
        width = max(1, int(round(pw * scale)))
        height = max(1, int(round(ph * scale)))
        surface = pycairo.ImageSurface(pycairo.FORMAT_ARGB32, width, height)
        ctx = pycairo.Context(surface)
        ctx.set_source_rgb(1.0, 1.0, 1.0)
        ctx.paint()
        ctx.scale(scale, scale)
        page.render(ctx)
        surface.flush()
        raw = bytes(surface.get_data())
        stride = surface.get_stride()
        # Cairo FORMAT_ARGB32 on little-endian stores B, G, R, A premultiplied bytes.
        return Gdk.MemoryTexture.new(
            width,
            height,
            Gdk.MemoryFormat.B8G8R8A8_PREMULTIPLIED,
            GLib.Bytes.new(raw),
            stride,
        )
    except Exception:
        return None


class PDFRendererView(PreviewRendererView):
    def __init__(self) -> None:
        super().__init__()
        self._doc: Optional[Any] = None
        self._pdf_path: Optional[str] = None
        self._temp_pdf_path: Optional[str] = None
        self._page_count: int = 0
        self._current_page: int = 0
        self._zoom_percent: float = 100.0
        self._fit_mode: bool = True
        self._backend: str = "graceful"
        self._page_textures: dict[tuple[int, int], Gdk.Texture] = {}

        toolbar, self._info_label, right_box = make_renderer_toolbar()
        self._info_label.set_text("PDF 文档")

        self._prev_btn = make_pill_button("‹", lambda: self.step_page(-1), tooltip="上一页 (PageUp)")
        self._page_label = Gtk.Label(label="第 1 / 1 页")
        self._page_label.add_css_class("lumen-muted")
        self._next_btn = make_pill_button("›", lambda: self.step_page(1), tooltip="下一页 (PageDown)")
        self._zoom_out_btn = make_pill_button("−", self.zoom_out, tooltip="缩小 (Ctrl-)")
        self._zoom_label = Gtk.Label(label="适配")
        self._zoom_label.add_css_class("lumen-muted")
        self._zoom_in_btn = make_pill_button("+", self.zoom_in, tooltip="放大 (Ctrl+)")
        self._open_btn = make_pill_button("外部打开", self._open_external)

        for w in (
            self._prev_btn,
            self._page_label,
            self._next_btn,
            self._zoom_out_btn,
            self._zoom_label,
            self._zoom_in_btn,
            self._open_btn,
        ):
            right_box.append(w)

        self.append(toolbar)

        self._body = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=0)
        self._body.set_hexpand(True)
        self._body.set_vexpand(True)
        self.append(self._body)

        # Left thumbnail page rail
        self._thumb_scroll = Gtk.ScrolledWindow()
        self._thumb_scroll.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
        self._thumb_scroll.set_size_request(112, -1)
        self._thumb_scroll.add_css_class("lumen-preview-queue")
        self._thumb_list = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
        self._thumb_list.set_margin_top(8)
        self._thumb_list.set_margin_bottom(8)
        self._thumb_list.set_margin_start(8)
        self._thumb_list.set_margin_end(8)
        self._thumb_scroll.set_child(self._thumb_list)
        self._thumb_scroll.set_visible(False)

        # Right main page canvas / graceful card
        self._page_scroll = Gtk.ScrolledWindow()
        self._page_scroll.set_hexpand(True)
        self._page_scroll.set_vexpand(True)
        self._stage_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12)
        self._stage_box.set_halign(Gtk.Align.CENTER)
        self._stage_box.set_valign(Gtk.Align.CENTER)
        self._stage_box.set_margin_top(20)
        self._stage_box.set_margin_bottom(20)
        self._stage_box.set_margin_start(20)
        self._stage_box.set_margin_end(20)
        self._page_scroll.set_child(self._stage_box)

        self._picture = Gtk.Picture()
        self._picture.set_can_shrink(True)
        self._picture.set_content_fit(Gtk.ContentFit.CONTAIN)

        self._status_label = Gtk.Label(label="正在加载 PDF…")
        self._status_label.add_css_class("lumen-muted")
        self._stage_box.append(self._status_label)

        self._body.append(self._thumb_scroll)
        self._body.append(self._page_scroll)

    def _clear_stage(self) -> None:
        while True:
            child = self._stage_box.get_first_child()
            if child is None:
                break
            self._stage_box.remove(child)

    def _clear_thumbs(self) -> None:
        while True:
            child = self._thumb_list.get_first_child()
            if child is None:
                break
            self._thumb_list.remove(child)

    def load(self, item: PreviewItem, context: PreviewContext) -> None:
        self.teardown()
        super().load(item, context)
        gen = self.next_generation()
        self._page_textures.clear()
        self._clear_stage()
        self._clear_thumbs()
        self._thumb_scroll.set_visible(False)
        self._status_label.set_text("正在加载 PDF…")
        self._stage_box.append(self._status_label)

        cached = context.cache.pdf(item.cache_key)
        if cached is not None and Poppler is not None and pycairo is not None:
            self._apply_poppler_document(cached)
            return

        if item.local_path and os.path.isfile(item.local_path):
            self._pdf_path = item.local_path
            self._load_from_local_file(item.local_path, item, context, gen)
            return

        if item.clipboard_item is None:
            self._show_graceful_fallback(_PdfMetadata(byte_size=item.byte_size), "PDF 文件不可用")
            return

        def _on_data(res: tuple[bytes, str]) -> None:
            if not self.is_current_generation(gen):
                return
            data, _mime = res
            self._load_from_bytes(data, item, context, gen)

        def _on_err(exc: Exception) -> None:
            if not self.is_current_generation(gen):
                return
            self._show_graceful_fallback(_PdfMetadata(byte_size=item.byte_size), f"加载失败：{exc}")

        context.store.api.fetch_item_file_data(
            item.clipboard_item.id,
            index=item.file_index or 0,
            on_success=_on_data,
            on_error=_on_err,
        )

    def _load_from_local_file(
        self,
        path: str,
        item: PreviewItem,
        context: PreviewContext,
        gen: int,
    ) -> None:
        def _worker() -> None:
            if Poppler is not None and pycairo is not None:
                try:
                    uri = Gio.File.new_for_path(os.path.abspath(path)).get_uri()
                    doc = Poppler.Document.new_from_file(uri, None)
                    if doc is not None:
                        GLib.idle_add(self._finish_poppler_load, doc, item.cache_key, context, gen)
                        return
                except Exception:
                    pass
            try:
                with open(path, "rb") as fh:
                    raw = fh.read(2_000_000)
                meta = _inspect_pdf_metadata(raw)
                meta.byte_size = os.path.getsize(path)
            except OSError:
                meta = _PdfMetadata(byte_size=item.byte_size)
            if shutil.which("pdftoppm"):
                GLib.idle_add(self._finish_pdftoppm_ready, path, meta, gen)
            else:
                GLib.idle_add(self._finish_graceful_load, meta, gen)

        threading.Thread(target=_worker, name="lumen-pdf-load", daemon=True).start()

    def _load_from_bytes(
        self,
        data: bytes,
        item: PreviewItem,
        context: PreviewContext,
        gen: int,
    ) -> None:
        def _worker() -> None:
            if Poppler is not None and pycairo is not None:
                try:
                    doc = Poppler.Document.new_from_bytes(GLib.Bytes.new(data), None)
                    if doc is not None:
                        GLib.idle_add(self._finish_poppler_load, doc, item.cache_key, context, gen)
                        return
                except Exception:
                    pass
            meta = _inspect_pdf_metadata(data)
            if shutil.which("pdftoppm"):
                try:
                    fd, tmp_path = tempfile.mkstemp(prefix="lumen-pdf-", suffix=".pdf")
                    with os.fdopen(fd, "wb") as out:
                        out.write(data)
                    self._temp_pdf_path = tmp_path
                    GLib.idle_add(self._finish_pdftoppm_ready, tmp_path, meta, gen)
                    return
                except OSError:
                    pass
            GLib.idle_add(self._finish_graceful_load, meta, gen)

        threading.Thread(target=_worker, name="lumen-pdf-bytes", daemon=True).start()

    def _finish_poppler_load(self, doc: Any, cache_key: str, context: PreviewContext, gen: int) -> bool:
        if not self.is_current_generation(gen):
            return False
        context.cache.store_pdf(cache_key, doc)
        self._apply_poppler_document(doc)
        return False

    def _apply_poppler_document(self, doc: Any) -> None:
        self._doc = doc
        self._backend = "poppler"
        self._page_count = max(0, int(doc.get_n_pages()))
        self._current_page = 0
        self._zoom_percent = 100.0
        self._fit_mode = True
        self._zoom_label.set_text("适配")
        self._info_label.set_text(f"PDF · {self._page_count} 页 (Poppler)")
        self._populate_poppler_thumbnails()
        self._render_current_page()

    def _populate_poppler_thumbnails(self) -> None:
        self._clear_thumbs()
        if self._doc is None or self._page_count <= 1:
            self._thumb_scroll.set_visible(False)
            return
        self._thumb_scroll.set_visible(True)
        for idx in range(min(self._page_count, 40)):
            page = self._doc.get_page(idx)
            pw, _ph = page.get_size()
            scale = 82.0 / max(1.0, float(pw))
            tex = _render_poppler_page_to_texture(page, scale)
            btn = Gtk.Button()
            btn.add_css_class("lumen-queue-row")
            box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=4)
            if tex is not None:
                pic = Gtk.Picture.new_for_paintable(tex)
                pic.set_size_request(82, 106)
                pic.set_content_fit(Gtk.ContentFit.CONTAIN)
                box.append(pic)
            num = Gtk.Label(label=str(idx + 1))
            num.add_css_class("lumen-muted")
            box.append(num)
            btn.set_child(box)
            btn.connect("clicked", lambda _b, page_idx=idx: self._jump_to_page(page_idx))
            self._thumb_list.append(btn)

    def _finish_pdftoppm_ready(self, path: str, meta: _PdfMetadata, gen: int) -> bool:
        if not self.is_current_generation(gen):
            return False
        self._pdf_path = path
        self._backend = "pdftoppm"
        self._page_count = max(1, meta.page_count)
        self._current_page = 0
        self._zoom_percent = 100.0
        self._fit_mode = True
        self._zoom_label.set_text("适配")
        self._info_label.set_text(f"PDF · {self._page_count} 页 (pdftoppm)")
        self._render_current_page()
        return False

    def _finish_graceful_load(self, meta: _PdfMetadata, gen: int) -> bool:
        if not self.is_current_generation(gen):
            return False
        self._show_graceful_fallback(meta, "")
        return False

    def _show_graceful_fallback(self, meta: _PdfMetadata, error_msg: str) -> None:
        self._backend = "graceful"
        self._page_count = meta.page_count
        self._page_label.set_text(f"{meta.page_count} 页" if meta.page_count > 0 else "PDF")
        self._info_label.set_text(
            f"PDF {meta.version}" + (f" · {meta.page_count} 页" if meta.page_count > 0 else "")
        )
        self._clear_stage()

        card = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12)
        card.set_halign(Gtk.Align.CENTER)
        card.set_valign(Gtk.Align.CENTER)
        card.add_css_class("lumen-hero-box")
        card.set_size_request(440, -1)

        icon = Gtk.Image.new_from_icon_name("application-pdf-symbolic")
        icon.set_pixel_size(56)
        card.append(icon)

        title_text = meta.title or (self.current_item.title if self.current_item else "PDF 文档")
        title_lbl = Gtk.Label(label=title_text)
        title_lbl.add_css_class("lumen-heading")
        title_lbl.set_wrap(True)
        card.append(title_lbl)

        parts = [f"PDF {meta.version}"]
        if meta.page_count > 0:
            parts.append(f"约 {meta.page_count} 页")
        if meta.byte_size > 0:
            parts.append(Formatters.byte_count(meta.byte_size))
        meta_lbl = Gtk.Label(label=" · ".join(parts))
        meta_lbl.add_css_class("lumen-muted")
        card.append(meta_lbl)

        note_text = error_msg or "当前宿主未安装 Poppler-GLib (gir1.2-poppler-0.18)，已降级为原生文档信息视图。"
        note_lbl = Gtk.Label(label=note_text)
        note_lbl.add_css_class("lumen-subheading")
        note_lbl.set_wrap(True)
        note_lbl.set_max_width_chars(52)
        card.append(note_lbl)

        actions = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        actions.set_halign(Gtk.Align.CENTER)
        open_btn = make_pill_button("默认应用打开", self._open_external)
        reveal_btn = make_pill_button("在文件管理器中显示", self._reveal_external)
        copy_btn = make_pill_button("复制引用", self.copy_primary_content)
        actions.append(open_btn)
        actions.append(reveal_btn)
        actions.append(copy_btn)
        card.append(actions)

        self._stage_box.append(card)

    def _jump_to_page(self, idx: int) -> None:
        if self._page_count <= 0:
            return
        clamped = max(0, min(self._page_count - 1, idx))
        if clamped != self._current_page:
            self._current_page = clamped
            self._render_current_page()

    def _render_current_page(self) -> None:
        if self._page_count <= 0:
            self._page_label.set_text("0 / 0")
            return
        self._page_label.set_text(f"第 {self._current_page + 1} / {self._page_count} 页")
        scale_key = int(round(self._zoom_percent))
        cache_pair = (self._current_page, scale_key)

        if cache_pair in self._page_textures:
            self._display_page_texture(self._page_textures[cache_pair])
            return

        if self._backend == "poppler" and self._doc is not None:
            page = self._doc.get_page(self._current_page)
            scale = max(0.5, min(3.0, (self._zoom_percent / 100.0) * 1.4))
            tex = _render_poppler_page_to_texture(page, scale)
            if tex is not None:
                self._page_textures[cache_pair] = tex
                self._display_page_texture(tex)
            return

        if self._backend == "pdftoppm" and self._pdf_path:
            gen = self._load_generation
            page_num = self._current_page + 1
            dpi = int(max(72, min(220, round(110 * (self._zoom_percent / 100.0)))))
            path = self._pdf_path

            def _run_ppm() -> None:
                try:
                    proc = subprocess.run(
                        ["pdftoppm", "-png", "-r", str(dpi), "-f", str(page_num), "-l", str(page_num), "-singlefile", path],
                        capture_output=True,
                        timeout=10,
                        check=False,
                    )
                    tex = texture_from_bytes(proc.stdout) if proc.returncode == 0 else None
                except Exception:
                    tex = None
                GLib.idle_add(self._finish_ppm_page, cache_pair, tex, gen)

            threading.Thread(target=_run_ppm, name="lumen-pdftoppm", daemon=True).start()

    def _finish_ppm_page(self, key: tuple[int, int], tex: Optional[Gdk.Texture], gen: int) -> bool:
        if not self.is_current_generation(gen):
            return False
        if tex is not None:
            self._page_textures[key] = tex
            self._display_page_texture(tex)
        return False

    def _display_page_texture(self, tex: Gdk.Texture) -> None:
        self._clear_stage()
        self._picture.set_paintable(tex)
        if self._fit_mode:
            self._picture.set_size_request(-1, -1)
            self._picture.set_hexpand(True)
            self._picture.set_vexpand(True)
            self._picture.set_content_fit(Gtk.ContentFit.CONTAIN)
        else:
            w = max(120, int(round(tex.get_width() * (self._zoom_percent / 100.0))))
            h = max(120, int(round(tex.get_height() * (self._zoom_percent / 100.0))))
            self._picture.set_size_request(w, h)
            self._picture.set_hexpand(False)
            self._picture.set_vexpand(False)
        self._stage_box.append(self._picture)

    def _open_external(self) -> None:
        target = self._pdf_path or (self.current_item.local_path if self.current_item else None)
        if target:
            open_file_external(target, parent=self.current_context.parent_window if self.current_context else None)

    def _reveal_external(self) -> None:
        target = self._pdf_path or (self.current_item.local_path if self.current_item else None)
        if target:
            reveal_file_in_manager(target, parent=self.current_context.parent_window if self.current_context else None)

    def step_page(self, delta: int) -> bool:
        if self._backend == "graceful" or self._page_count <= 1:
            return False
        nxt = self._current_page + delta
        if 0 <= nxt < self._page_count:
            self._current_page = nxt
            self._render_current_page()
            return True
        return False

    def zoom_in(self) -> None:
        self._fit_mode = False
        self._zoom_percent = min(250.0, self._zoom_percent + 25.0)
        self._zoom_label.set_text(f"{int(self._zoom_percent)}%")
        if self._backend != "graceful":
            self._render_current_page()

    def zoom_out(self) -> None:
        self._fit_mode = False
        self._zoom_percent = max(50.0, self._zoom_percent - 25.0)
        self._zoom_label.set_text(f"{int(self._zoom_percent)}%")
        if self._backend != "graceful":
            self._render_current_page()

    def reset_zoom(self) -> None:
        self._fit_mode = True
        self._zoom_percent = 100.0
        self._zoom_label.set_text("适配")
        if self._backend != "graceful":
            self._render_current_page()

    def teardown(self) -> None:
        super().teardown()
        self._doc = None
        self._page_textures.clear()
        self._picture.set_paintable(None)
        if self._temp_pdf_path:
            try:
                os.unlink(self._temp_pdf_path)
            except OSError:
                pass
            self._temp_pdf_path = None


class PDFRenderer:
    renderer_id = "native.gtk4.poppler.pdf"
    priority = 100

    def can_render(self, item: PreviewItem) -> bool:
        return item.kind.category == "pdf"

    def create_view(self, item: PreviewItem, context: PreviewContext) -> PreviewRendererView:
        return PDFRendererView()
