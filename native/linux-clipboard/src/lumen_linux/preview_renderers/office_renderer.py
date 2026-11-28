"""Server-backed Structured Office Renderer (DOCX / XLSX / PPTX, priority 90).

Renders structured Office JSON from `GET /items/{id}/preview?index=N` using
100% native GTK4 widgets:
- DOCX: Scrollable white paper Gtk.Box + Gtk.Label (h1, h2, quote, p) + Gtk.Grid tables.
- XLSX: Formula bar (`A1` + `ƒx`) + Gtk.Stack + Gtk.StackSwitcher sheet tabs +
  native Gtk.ColumnView backed by Gio.ListStore & Gtk.SignalListItemFactory.
- PPTX: Slide deck Gtk.Box card with prev/next keyboard & button navigation.
Also includes a lightweight local OOXML extractor fallback for locally dropped files.
"""

from __future__ import annotations

import os
import re
import threading
import xml.etree.ElementTree as ET
import zipfile
from typing import Any, Optional

from gi.repository import GObject

from ..capabilities import Gio, GLib, Gtk, Pango
from ..models import (
    DocumentPreview,
    OfficeBlock,
    OfficePreview,
    PresentationPreview,
    ServerPreview,
    SheetPreview,
    SlidePreview,
    WorkbookPreview,
)
from ..preview_registry import PreviewContext, PreviewItem, PreviewRendererView
from .helpers import make_pill_button, make_renderer_toolbar, open_file_external


def _column_letter(index: int) -> str:
    n = index + 1
    out = ""
    while n > 0:
        rem = (n - 1) % 26
        out = chr(65 + rem) + out
        n = (n - 1) // 26
    return out


class _SheetRowObject(GObject.Object):
    """Row wrapper for GTK4 Gtk.ColumnView + Gio.ListStore."""

    def __init__(self, row_index: int, cells: list[str]) -> None:
        super().__init__()
        self.row_index = row_index
        self.cells = cells


def _extract_local_ooxml_preview(path: str, fmt: str) -> Optional[ServerPreview]:
    """Lightweight local OOXML structured fallback when previewing dropped local files."""
    if not os.path.isfile(path):
        return None
    try:
        with zipfile.ZipFile(path, "r") as zf:
            if fmt == "docx" and "word/document.xml" in zf.namelist():
                root = ET.fromstring(zf.read("word/document.xml")[:4_000_000])
                ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
                blocks: list[OfficeBlock] = []
                body = root.find("w:body", ns)
                if body is not None:
                    for elem in body:
                        tag = elem.tag.split("}")[-1]
                        if tag == "p":
                            txt = "".join(t.text or "" for t in elem.findall(".//w:t", ns)).strip()
                            if not txt:
                                continue
                            style_el = elem.find("./w:pPr/w:pStyle", ns)
                            style = (style_el.attrib.get(f"{{{ns['w']}}}val") or "").lower() if style_el is not None else ""
                            kind = "h1" if "heading1" in style or style == "title" else (
                                "h2" if "heading" in style else ("quote" if "quote" in style else "p")
                            )
                            blocks.append(OfficeBlock(kind=kind, text=txt))
                        elif tag == "tbl":
                            rows: list[list[str]] = []
                            for tr in elem.findall("./w:tr", ns)[:30]:
                                row = [
                                    "".join(t.text or "" for t in tc.findall(".//w:t", ns)).strip()
                                    for tc in tr.findall("./w:tc", ns)
                                ]
                                rows.append(row)
                            if rows:
                                blocks.append(OfficeBlock(kind="table", rows=rows))
                        if len(blocks) >= 200:
                            break
                if blocks:
                    return ServerPreview(
                        kind="text",
                        file_name=os.path.basename(path),
                        office=OfficePreview(format="docx", document=DocumentPreview(title=os.path.basename(path), blocks=blocks)),
                    )

            if fmt == "xlsx":
                shared: list[str] = []
                if "xl/sharedStrings.xml" in zf.namelist():
                    sroot = ET.fromstring(zf.read("xl/sharedStrings.xml")[:4_000_000])
                    for si in sroot.iter():
                        if si.tag.endswith("}si"):
                            shared.append("".join(t.text or "" for t in si.iter() if t.tag.endswith("}t")))
                sheet_files = sorted(
                    n for n in zf.namelist() if re.match(r"^xl/worksheets/sheet\d+\.xml$", n)
                )[:12]
                sheets: list[SheetPreview] = []
                for idx, sf in enumerate(sheet_files):
                    sroot = ET.fromstring(zf.read(sf)[:4_000_000])
                    rows_out: list[list[str]] = []
                    formulas: dict[str, str] = {}
                    for r_el in sroot.iter():
                        if not r_el.tag.endswith("}row"):
                            continue
                        row_vals: list[str] = []
                        for c_el in r_el:
                            if not c_el.tag.endswith("}c"):
                                continue
                            ref = c_el.attrib.get("r", "")
                            ctype = c_el.attrib.get("t", "")
                            val = ""
                            for child in c_el:
                                if child.tag.endswith("}f") and child.text:
                                    formulas[ref] = "=" + child.text
                                elif child.tag.endswith("}v") and child.text is not None:
                                    if ctype == "s":
                                        try:
                                            val = shared[int(child.text)]
                                        except (ValueError, IndexError):
                                            val = child.text
                                    else:
                                        val = child.text
                                elif child.tag.endswith("}is"):
                                    val = "".join(t.text or "" for t in child.iter() if t.tag.endswith("}t"))
                            row_vals.append(val)
                        if row_vals:
                            rows_out.append(row_vals[:40])
                        if len(rows_out) >= 200:
                            break
                    sheets.append(SheetPreview(name=f"Sheet{idx + 1}", rows=rows_out, formulas=formulas))
                if sheets:
                    return ServerPreview(
                        kind="text",
                        file_name=os.path.basename(path),
                        office=OfficePreview(format="xlsx", workbook=WorkbookPreview(sheets=sheets)),
                    )

            if fmt == "pptx":
                slide_files = sorted(
                    (n for n in zf.namelist() if re.match(r"^ppt/slides/slide\d+\.xml$", n)),
                    key=lambda s: int(re.search(r"(\d+)\.xml$", s).group(1)),
                )[:30]
                slides: list[SlidePreview] = []
                for idx, sf in enumerate(slide_files):
                    sroot = ET.fromstring(zf.read(sf)[:2_000_000])
                    lines = [
                        "".join(t.text or "" for t in p.iter() if t.tag.endswith("}t")).strip()
                        for p in sroot.iter()
                        if p.tag.endswith("}p")
                    ]
                    lines = [ln for ln in lines if ln]
                    title = lines[0] if lines else f"第 {idx + 1} 页"
                    body = lines[1:] if len(lines) > 1 else []
                    slides.append(SlidePreview(number=idx + 1, title=title, lines=body))
                if slides:
                    return ServerPreview(
                        kind="text",
                        file_name=os.path.basename(path),
                        office=OfficePreview(format="pptx", presentation=PresentationPreview(slides=slides)),
                    )
    except Exception:
        return None
    return None


class OfficeRendererView(PreviewRendererView):
    def __init__(self) -> None:
        super().__init__()
        self._zoom_percent: float = 100.0
        self._paper_box: Optional[Gtk.Box] = None
        self._presentation: Optional[PresentationPreview] = None
        self._slide_index: int = 0
        self._slide_title: Optional[Gtk.Label] = None
        self._slide_body: Optional[Gtk.Label] = None
        self._slide_counter: Optional[Gtk.Label] = None

        toolbar, self._info_label, right_box = make_renderer_toolbar()
        self._info_label.set_text("Office 文档预览")
        self._zoom_label = Gtk.Label(label="100%")
        self._zoom_label.add_css_class("lumen-muted")

        right_box.append(make_pill_button("−", self.zoom_out))
        right_box.append(self._zoom_label)
        right_box.append(make_pill_button("+", self.zoom_in))
        right_box.append(make_pill_button("外部打开", self._open_external))
        self.append(toolbar)

        self._body = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)
        self._body.set_hexpand(True)
        self._body.set_vexpand(True)
        self.append(self._body)

    def _clear_body(self) -> None:
        while True:
            child = self._body.get_first_child()
            if child is None:
                break
            self._body.remove(child)
        self._paper_box = None
        self._presentation = None
        self._slide_title = None
        self._slide_body = None
        self._slide_counter = None

    def _show_status(self, message: str) -> None:
        self._clear_body()
        lbl = Gtk.Label(label=message)
        lbl.add_css_class("lumen-muted")
        lbl.set_wrap(True)
        lbl.set_halign(Gtk.Align.CENTER)
        lbl.set_valign(Gtk.Align.CENTER)
        lbl.set_hexpand(True)
        lbl.set_vexpand(True)
        lbl.set_margin_start(28)
        lbl.set_margin_end(28)
        self._body.append(lbl)

    def load(self, item: PreviewItem, context: PreviewContext) -> None:
        super().load(item, context)
        gen = self.next_generation()
        self._zoom_percent = 100.0
        self._zoom_label.set_text("100%")
        self._show_status("正在解析结构化 Office 预览…")

        cached = context.cache.server_preview(item.cache_key)
        if cached is not None:
            self._render_server_preview(cached)
            return

        if item.clipboard_item is not None:
            def _ok(preview: ServerPreview) -> None:
                if not self.is_current_generation(gen):
                    return
                context.cache.store_server_preview(item.cache_key, preview)
                self._render_server_preview(preview)

            def _err(exc: Exception) -> None:
                if not self.is_current_generation(gen):
                    return
                if item.local_path:
                    self._load_local_ooxml(item.local_path, item.kind.subtype, item.cache_key, context, gen)
                else:
                    self._show_status(f"结构化预览不可用：{exc}")

            context.store.api.fetch_file_preview(
                item.clipboard_item.id,
                index=item.file_index,
                on_success=_ok,
                on_error=_err,
            )
            return

        if item.local_path:
            self._load_local_ooxml(item.local_path, item.kind.subtype, item.cache_key, context, gen)
        else:
            self._show_status("本地 Office 文件不可用，可使用右上角“外部打开”。")

    def _load_local_ooxml(
        self,
        path: str,
        fmt: str,
        cache_key: str,
        context: PreviewContext,
        gen: int,
    ) -> None:
        def _worker() -> None:
            preview = _extract_local_ooxml_preview(path, fmt)
            GLib.idle_add(self._finish_local_ooxml, preview, cache_key, context, gen)

        threading.Thread(target=_worker, name="lumen-ooxml", daemon=True).start()

    def _finish_local_ooxml(
        self,
        preview: Optional[ServerPreview],
        cache_key: str,
        context: PreviewContext,
        gen: int,
    ) -> bool:
        if not self.is_current_generation(gen):
            return False
        if preview is not None:
            context.cache.store_server_preview(cache_key, preview)
            self._render_server_preview(preview)
        else:
            self._show_status("此 Office 文档暂无可提取的结构化预览，可使用右上角“外部打开”。")
        return False

    def _render_server_preview(self, preview: ServerPreview) -> None:
        self._clear_body()
        office = preview.office
        if office is not None:
            if office.document and office.document.blocks:
                self._info_label.set_text(f"Word · 结构化内容预览 ({len(office.document.blocks)} 段落)")
                self._render_docx(office.document)
                return
            if office.workbook and office.workbook.sheets:
                self._info_label.set_text(f"Excel · {len(office.workbook.sheets)} 个工作表")
                self._render_workbook(office.workbook)
                return
            if office.presentation and office.presentation.slides:
                self._info_label.set_text(f"PowerPoint · {len(office.presentation.slides)} 页幻灯片")
                self._render_presentation(office.presentation)
                return
        if preview.text:
            self._info_label.set_text("文档文本预览")
            self._render_plain_text(preview.text)
        else:
            self._show_status("此文档暂无可提取的结构化预览，可使用右上角“外部打开”。")

    def _render_docx(self, doc: DocumentPreview) -> None:
        scroll = Gtk.ScrolledWindow()
        scroll.set_hexpand(True)
        scroll.set_vexpand(True)

        center = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)
        center.set_halign(Gtk.Align.CENTER)
        center.set_margin_top(22)
        center.set_margin_bottom(28)
        center.set_margin_start(20)
        center.set_margin_end(20)

        paper = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12)
        paper.add_css_class("lumen-doc-paper")
        paper.set_size_request(int(580 * self._zoom_percent / 100.0), -1)
        self._paper_box = paper

        for block in doc.blocks:
            if block.kind == "h1":
                lbl = Gtk.Label(label=block.text)
                lbl.set_xalign(0.0)
                lbl.set_wrap(True)
                lbl.set_selectable(True)
                attrs = Pango.AttrList()
                attrs.insert(Pango.attr_scale_new(1.55))
                attrs.insert(Pango.attr_weight_new(Pango.Weight.BOLD))
                lbl.set_attributes(attrs)
                paper.append(lbl)
            elif block.kind == "h2":
                lbl = Gtk.Label(label=block.text)
                lbl.set_xalign(0.0)
                lbl.set_wrap(True)
                lbl.set_selectable(True)
                attrs = Pango.AttrList()
                attrs.insert(Pango.attr_scale_new(1.22))
                attrs.insert(Pango.attr_weight_new(Pango.Weight.SEMIBOLD))
                lbl.set_attributes(attrs)
                paper.append(lbl)
            elif block.kind == "quote":
                # Rounded surface fill + crisp 1px full border (NO left accent bar)
                qbox = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
                qbox.add_css_class("lumen-doc-quote")
                lbl = Gtk.Label(label=block.text)
                lbl.set_xalign(0.0)
                lbl.set_wrap(True)
                lbl.set_selectable(True)
                attrs = Pango.AttrList()
                attrs.insert(Pango.attr_style_new(Pango.Style.ITALIC))
                lbl.set_attributes(attrs)
                qbox.append(lbl)
                paper.append(qbox)
            elif block.kind == "table" and block.rows:
                grid = Gtk.Grid()
                grid.add_css_class("lumen-doc-table")
                grid.set_row_spacing(1)
                grid.set_column_spacing(1)
                grid.set_column_homogeneous(True)
                col_count = max(1, max(len(r) for r in block.rows))
                for r_idx, row in enumerate(block.rows[:30]):
                    for c_idx in range(col_count):
                        txt = row[c_idx] if c_idx < len(row) else ""
                        cell = Gtk.Label(label=txt)
                        cell.set_xalign(0.0)
                        cell.set_wrap(True)
                        cell.set_selectable(True)
                        cell.add_css_class("lumen-doc-table-hdr" if r_idx == 0 else "lumen-doc-table-cell")
                        grid.attach(cell, c_idx, r_idx, 1, 1)
                paper.append(grid)
            else:
                lbl = Gtk.Label(label=block.text)
                lbl.set_xalign(0.0)
                lbl.set_wrap(True)
                lbl.set_selectable(True)
                paper.append(lbl)

        center.append(paper)
        scroll.set_child(center)
        self._body.append(scroll)

    def _render_workbook(self, wb: WorkbookPreview) -> None:
        formula_bar = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        formula_bar.add_css_class("lumen-formula-bar")
        ref_lbl = Gtk.Label(label="A1")
        ref_lbl.add_css_class("lumen-cell-ref")
        fx_lbl = Gtk.Label(label="ƒx")
        fx_lbl.add_css_class("lumen-muted")
        formula_lbl = Gtk.Label(label="")
        formula_lbl.set_xalign(0.0)
        formula_lbl.set_hexpand(True)
        formula_lbl.set_selectable(True)
        formula_lbl.set_ellipsize(3)
        formula_bar.append(ref_lbl)
        formula_bar.append(fx_lbl)
        formula_bar.append(formula_lbl)

        stack = Gtk.Stack()
        stack.set_hexpand(True)
        stack.set_vexpand(True)
        stack.set_transition_type(Gtk.StackTransitionType.CROSSFADE)

        switcher = Gtk.StackSwitcher()
        switcher.set_stack(stack)
        switcher.set_halign(Gtk.Align.START)

        tab_bar = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        tab_bar.add_css_class("lumen-formula-bar")
        tab_bar.append(switcher)

        def update_formula(sheet: SheetPreview, row_idx: int, col_idx: int) -> None:
            ref = f"{_column_letter(col_idx)}{row_idx + 1}"
            ref_lbl.set_text(ref)
            if ref in sheet.formulas and sheet.formulas[ref]:
                formula_lbl.set_text(sheet.formulas[ref])
            elif 0 <= row_idx < len(sheet.rows) and 0 <= col_idx < len(sheet.rows[row_idx]):
                formula_lbl.set_text(sheet.rows[row_idx][col_idx])
            else:
                formula_lbl.set_text("")

        for s_idx, sheet in enumerate(wb.sheets):
            store = Gio.ListStore.new(_SheetRowObject)
            row_count = max(16, len(sheet.rows))
            col_count = max(6, max((len(r) for r in sheet.rows), default=6))
            for r_idx in range(row_count):
                row_data = sheet.rows[r_idx] if r_idx < len(sheet.rows) else []
                store.append(_SheetRowObject(r_idx, row_data))

            sel_model = Gtk.SingleSelection.new(store)
            col_view = Gtk.ColumnView.new(sel_model)
            col_view.set_show_column_separators(True)
            col_view.set_show_row_separators(True)

            # Row number column
            rn_factory = Gtk.SignalListItemFactory.new()
            rn_factory.connect("setup", self._setup_row_num_cell)
            rn_factory.connect("bind", self._bind_row_num_cell)
            rn_col = Gtk.ColumnViewColumn.new("#", rn_factory)
            rn_col.set_fixed_width(44)
            col_view.append_column(rn_col)

            for c_idx in range(col_count):
                factory = Gtk.SignalListItemFactory.new()
                factory.connect(
                    "setup",
                    lambda _f, li, sh=sheet, ci=c_idx: self._setup_data_cell(li, sh, ci, update_formula),
                )
                factory.connect("bind", lambda _f, li, ci=c_idx: self._bind_data_cell(li, ci))
                col = Gtk.ColumnViewColumn.new(_column_letter(c_idx), factory)
                col.set_fixed_width(120)
                col.set_resizable(True)
                col_view.append_column(col)

            sel_model.connect(
                "selection-changed",
                lambda sm, _pos, _n, sh=sheet: update_formula(sh, max(0, sm.get_selected()), 0),
            )

            scroll = Gtk.ScrolledWindow()
            scroll.set_hexpand(True)
            scroll.set_vexpand(True)
            scroll.set_child(col_view)
            stack.add_titled(scroll, f"sheet-{s_idx}", sheet.name or f"Sheet{s_idx + 1}")

        if wb.sheets:
            update_formula(wb.sheets[0], 0, 0)

        self._body.append(formula_bar)
        self._body.append(stack)
        self._body.append(tab_bar)

    @staticmethod
    def _setup_row_num_cell(_factory: Gtk.SignalListItemFactory, list_item: Gtk.ListItem) -> None:
        lbl = Gtk.Label(label="")
        lbl.set_xalign(0.5)
        lbl.add_css_class("lumen-muted")
        list_item.set_child(lbl)

    @staticmethod
    def _bind_row_num_cell(_factory: Gtk.SignalListItemFactory, list_item: Gtk.ListItem) -> None:
        obj = list_item.get_item()
        lbl = list_item.get_child()
        if isinstance(obj, _SheetRowObject) and isinstance(lbl, Gtk.Label):
            lbl.set_text(str(obj.row_index + 1))

    @staticmethod
    def _setup_data_cell(
        list_item: Gtk.ListItem,
        sheet: SheetPreview,
        col_idx: int,
        on_cell_click: Any,
    ) -> None:
        lbl = Gtk.Label(label="")
        lbl.set_xalign(0.0)
        lbl.set_ellipsize(3)
        lbl.set_margin_start(6)
        lbl.set_margin_end(6)
        gesture = Gtk.GestureClick.new()
        gesture.connect(
            "pressed",
            lambda _g, _n, _x, _y: on_cell_click(
                sheet,
                list_item.get_item().row_index if isinstance(list_item.get_item(), _SheetRowObject) else 0,
                col_idx,
            ),
        )
        lbl.add_controller(gesture)
        list_item.set_child(lbl)

    @staticmethod
    def _bind_data_cell(list_item: Gtk.ListItem, col_idx: int) -> None:
        obj = list_item.get_item()
        lbl = list_item.get_child()
        if not isinstance(obj, _SheetRowObject) or not isinstance(lbl, Gtk.Label):
            return
        val = obj.cells[col_idx] if col_idx < len(obj.cells) else ""
        lbl.set_text(val)
        is_header = obj.row_index == 0
        is_num = (not is_header) and bool(val) and (val[0].isdigit() or val[0] in ("-", "$", "¥"))
        lbl.set_xalign(1.0 if is_num else 0.0)
        attrs = Pango.AttrList()
        if is_header:
            attrs.insert(Pango.attr_weight_new(Pango.Weight.SEMIBOLD))
        lbl.set_attributes(attrs)

    def _render_presentation(self, pres: PresentationPreview) -> None:
        self._presentation = pres
        self._slide_index = 0

        wrap = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=14)
        wrap.set_halign(Gtk.Align.CENTER)
        wrap.set_valign(Gtk.Align.CENTER)
        wrap.set_hexpand(True)
        wrap.set_vexpand(True)
        wrap.set_margin_top(20)
        wrap.set_margin_bottom(20)
        wrap.set_margin_start(24)
        wrap.set_margin_end(24)

        card = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=16)
        card.add_css_class("lumen-slide-card")
        card.set_size_request(620, 380)

        title = Gtk.Label(label="")
        title.set_xalign(0.0)
        title.set_wrap(True)
        title.set_selectable(True)
        t_attrs = Pango.AttrList()
        t_attrs.insert(Pango.attr_scale_new(1.6))
        t_attrs.insert(Pango.attr_weight_new(Pango.Weight.BOLD))
        title.set_attributes(t_attrs)
        self._slide_title = title

        body_scroll = Gtk.ScrolledWindow()
        body_scroll.set_hexpand(True)
        body_scroll.set_vexpand(True)
        body = Gtk.Label(label="")
        body.set_xalign(0.0)
        body.set_yalign(0.0)
        body.set_wrap(True)
        body.set_selectable(True)
        body_scroll.set_child(body)
        self._slide_body = body

        card.append(title)
        card.append(body_scroll)

        nav = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=10)
        nav.set_halign(Gtk.Align.CENTER)
        nav.append(make_pill_button("‹ 上一页", lambda: self.step_page(-1)))
        counter = Gtk.Label(label=f"第 1 / {len(pres.slides)} 页")
        counter.add_css_class("lumen-muted")
        self._slide_counter = counter
        nav.append(counter)
        nav.append(make_pill_button("下一页 ›", lambda: self.step_page(1)))

        wrap.append(card)
        wrap.append(nav)
        self._body.append(wrap)
        self._update_active_slide()

    def _update_active_slide(self) -> None:
        if self._presentation is None or not self._presentation.slides:
            return
        idx = max(0, min(len(self._presentation.slides) - 1, self._slide_index))
        self._slide_index = idx
        slide = self._presentation.slides[idx]
        if self._slide_title is not None:
            self._slide_title.set_text(slide.title or f"第 {slide.number} 页")
        if self._slide_body is not None:
            self._slide_body.set_text("\n\n".join(f"• {line}" for line in slide.lines))
        if self._slide_counter is not None:
            self._slide_counter.set_text(f"第 {idx + 1} / {len(self._presentation.slides)} 页")

    def _render_plain_text(self, text: str) -> None:
        scroll = Gtk.ScrolledWindow()
        scroll.set_hexpand(True)
        scroll.set_vexpand(True)
        tv = Gtk.TextView()
        tv.set_editable(False)
        tv.set_wrap_mode(Gtk.WrapMode.WORD_CHAR)
        tv.set_left_margin(24)
        tv.set_right_margin(24)
        tv.set_top_margin(20)
        tv.set_bottom_margin(20)
        tv.get_buffer().set_text(text)
        scroll.set_child(tv)
        self._body.append(scroll)

    def _open_external(self) -> None:
        if self.current_item and self.current_item.local_path:
            open_file_external(
                self.current_item.local_path,
                parent=self.current_context.parent_window if self.current_context else None,
            )

    def step_page(self, delta: int) -> bool:
        if self._presentation is None or not self._presentation.slides:
            return False
        nxt = self._slide_index + delta
        if 0 <= nxt < len(self._presentation.slides):
            self._slide_index = nxt
            self._update_active_slide()
            return True
        return False

    def zoom_in(self) -> None:
        self._zoom_percent = min(180.0, self._zoom_percent + 20.0)
        self._zoom_label.set_text(f"{int(self._zoom_percent)}%")
        if self._paper_box is not None:
            self._paper_box.set_size_request(int(580 * self._zoom_percent / 100.0), -1)

    def zoom_out(self) -> None:
        self._zoom_percent = max(60.0, self._zoom_percent - 20.0)
        self._zoom_label.set_text(f"{int(self._zoom_percent)}%")
        if self._paper_box is not None:
            self._paper_box.set_size_request(int(580 * self._zoom_percent / 100.0), -1)

    def reset_zoom(self) -> None:
        self._zoom_percent = 100.0
        self._zoom_label.set_text("100%")
        if self._paper_box is not None:
            self._paper_box.set_size_request(580, -1)


class OfficeRenderer:
    renderer_id = "server.gtk4.office.structured"
    priority = 90

    def can_render(self, item: PreviewItem) -> bool:
        return item.kind.category == "office"

    def create_view(self, item: PreviewItem, context: PreviewContext) -> PreviewRendererView:
        return OfficeRendererView()
