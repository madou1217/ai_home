"""Preview item classification, bounded LRU preview cache, and Renderer Registry."""

from __future__ import annotations

import os
from collections import OrderedDict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Generic, Optional, Protocol, TypeVar

from .api import ClipboardStore
from .capabilities import Gdk, Gtk
from .models import Classifier, ClipboardItem, Formatters, ServerPreview
from .theme import LumenPalette

T = TypeVar("T")


@dataclass(frozen=True)
class PreviewKind:
    category: str  # pdf|audio|video|office|image|color|code|collection|text|link|file
    subtype: str = ""  # language for code, format ("docx"|"xlsx"|"pptx") for office

    @property
    def display_label(self) -> str:
        if self.category == "code":
            return Classifier.language_display_name(self.subtype)
        if self.category == "office":
            return {
                "docx": "Word 文档",
                "xlsx": "Excel 工作簿",
                "pptx": "PowerPoint 演示文稿",
            }.get(self.subtype.lower(), "Office 文档")
        return {
            "text": "文本",
            "image": "图片",
            "color": "颜色",
            "link": "链接",
            "pdf": "PDF 文档",
            "audio": "音频",
            "video": "视频",
            "collection": "文件集合",
            "file": "文件",
        }.get(self.category, "文件")

    @property
    def badge_code(self) -> str:
        if self.category == "code":
            return (self.subtype or "CODE").upper()[:4]
        if self.category == "office":
            return {"docx": "DOC", "xlsx": "XLS", "pptx": "PPT"}.get(self.subtype.lower(), "OFF")
        return {
            "text": "TXT",
            "image": "IMG",
            "color": "HEX",
            "link": "URL",
            "pdf": "PDF",
            "audio": "MP3",
            "video": "MP4",
            "collection": "SET",
            "file": "FILE",
        }.get(self.category, "FILE")

    @property
    def is_media(self) -> bool:
        return self.category in ("audio", "video")


@dataclass
class PreviewItem:
    id: str
    title: str
    subtitle: str
    kind: PreviewKind
    clipboard_item: Optional[ClipboardItem] = None
    file_index: Optional[int] = None
    local_path: Optional[str] = None
    byte_size: int = 0
    inline_text: Optional[str] = None
    seed_index: int = 0
    collection_children: list["PreviewItem"] = field(default_factory=list)

    @property
    def cache_key(self) -> str:
        if self.clipboard_item is not None:
            if self.file_index is not None:
                return f"clip:{self.clipboard_item.id}:file:{self.file_index}"
            return f"clip:{self.clipboard_item.id}"
        if self.local_path:
            return f"local:{self.local_path}"
        return f"inline:{self.id}"

    @property
    def size_label(self) -> str:
        if self.collection_children:
            return f"{len(self.collection_children)} 个项目"
        if self.byte_size > 0:
            return Formatters.byte_count(self.byte_size)
        if self.inline_text is not None:
            return Formatters.byte_count(len(self.inline_text.encode("utf-8")))
        if self.clipboard_item is not None:
            return self.clipboard_item.formatted_size
        return "内容预览"

    @staticmethod
    def classify_file_path(file_path: str) -> PreviewKind:
        ext = Path(file_path).suffix.lstrip(".").lower()
        if ext == "pdf":
            return PreviewKind("pdf")
        if ext in Classifier.OFFICE_EXTENSIONS:
            return PreviewKind("office", ext)
        if ext in Classifier.IMAGE_EXTENSIONS:
            return PreviewKind("image")
        if ext in Classifier.AUDIO_EXTENSIONS:
            return PreviewKind("audio")
        if ext in Classifier.VIDEO_EXTENSIONS:
            return PreviewKind("video")
        if ext in Classifier.CODE_EXTENSIONS:
            return PreviewKind("code", Classifier.detect_language(file_path, ""))
        if ext in Classifier.TEXT_EXTENSIONS:
            return PreviewKind("text")
        return PreviewKind("file")

    @classmethod
    def classify_item(cls, item: ClipboardItem) -> PreviewKind:
        if item.kind == "image":
            return PreviewKind("image")
        if item.kind == "link":
            return PreviewKind("link")
        if item.kind == "file":
            if len(item.files) > 1:
                return PreviewKind("collection")
            if item.primary_file_path:
                return cls.classify_file_path(item.primary_file_path)
            return PreviewKind("file")
        text = item.effective_text.strip()
        if Classifier.parse_hex_color(text) is not None:
            return PreviewKind("color")
        if Classifier.looks_like_code(text):
            return PreviewKind("code", Classifier.detect_language(None, text))
        return PreviewKind("text")

    @classmethod
    def from_clipboard_item(cls, item: ClipboardItem, seed_index: int = 0) -> "PreviewItem":
        kind = cls.classify_item(item)
        if item.kind == "file" and len(item.files) > 1:
            children = [
                cls._from_indexed_file(item, idx, path, idx)
                for idx, path in enumerate(item.files)
            ]
            return cls(
                id=item.id,
                title=item.display_title,
                subtitle=f"{item.source_label} · {item.relative_time}",
                kind=PreviewKind("collection"),
                clipboard_item=item,
                file_index=None,
                local_path=None,
                byte_size=item.byte_size,
                inline_text="\n".join(item.files),
                seed_index=seed_index,
                collection_children=children,
            )
        single_path: Optional[str] = None
        if item.kind == "file" and item.primary_file_path and os.path.isfile(item.primary_file_path):
            single_path = item.primary_file_path
        return cls(
            id=item.id,
            title=item.display_title,
            subtitle=f"{item.source_label} · {item.relative_time}",
            kind=kind,
            clipboard_item=item,
            file_index=0 if item.kind == "file" else None,
            local_path=single_path,
            byte_size=item.byte_size,
            inline_text=item.effective_text if item.kind in ("text", "link") else None,
            seed_index=seed_index,
            collection_children=[],
        )

    @classmethod
    def _from_indexed_file(cls, item: ClipboardItem, index: int, path: str, seed_index: int) -> "PreviewItem":
        clean = path.strip()
        exists = os.path.isfile(clean)
        size = 0
        if exists:
            try:
                size = os.path.getsize(clean)
            except OSError:
                size = 0
        return cls(
            id=f"{item.id}#{index}",
            title=os.path.basename(clean) or f"文件 {index + 1}",
            subtitle=item.source_label,
            kind=cls.classify_file_path(clean),
            clipboard_item=item,
            file_index=index,
            local_path=clean if exists else None,
            byte_size=size,
            inline_text=None,
            seed_index=seed_index,
            collection_children=[],
        )

    @classmethod
    def flatten(cls, items: list[ClipboardItem]) -> list["PreviewItem"]:
        result: list[PreviewItem] = []
        for idx, item in enumerate(items):
            wrapped = cls.from_clipboard_item(item, seed_index=idx)
            if wrapped.collection_children:
                result.extend(wrapped.collection_children)
            else:
                result.append(wrapped)
        return result

    @classmethod
    def from_local_paths(cls, paths: list[str]) -> list["PreviewItem"]:
        result: list[PreviewItem] = []
        for idx, raw in enumerate(paths):
            clean = os.path.abspath(raw)
            size = 0
            try:
                if os.path.isfile(clean):
                    size = os.path.getsize(clean)
            except OSError:
                size = 0
            result.append(
                cls(
                    id=f"local:{clean}",
                    title=os.path.basename(clean) or clean,
                    subtitle="本地文件",
                    kind=cls.classify_file_path(clean),
                    clipboard_item=None,
                    file_index=None,
                    local_path=clean,
                    byte_size=size,
                    inline_text=None,
                    seed_index=idx,
                    collection_children=[],
                )
            )
        return result


class _LRUCache(Generic[T]):
    def __init__(self, max_items: int, max_cost: Optional[int] = None) -> None:
        self._max_items = max(1, max_items)
        self._max_cost = max_cost
        self._store: OrderedDict[str, tuple[T, int]] = OrderedDict()
        self._total_cost = 0

    def get(self, key: str) -> Optional[T]:
        entry = self._store.get(key)
        if entry is None:
            return None
        self._store.move_to_end(key)
        return entry[0]

    def put(self, key: str, value: T, cost: int = 1) -> None:
        item_cost = max(1, int(cost))
        old = self._store.pop(key, None)
        if old is not None:
            self._total_cost -= old[1]
        self._store[key] = (value, item_cost)
        self._total_cost += item_cost
        while len(self._store) > self._max_items or (
            self._max_cost is not None and self._total_cost > self._max_cost and len(self._store) > 1
        ):
            _, (_, evicted_cost) = self._store.popitem(last=False)
            self._total_cost -= evicted_cost

    def clear(self) -> None:
        self._store.clear()
        self._total_cost = 0

    def __len__(self) -> int:
        return len(self._store)


class BoundedPreviewCache:
    """Bounded in-memory LRU cache conforming to Section 3.4 of the native contract."""

    _instance: Optional["BoundedPreviewCache"] = None

    def __init__(self) -> None:
        self._images: _LRUCache[Gdk.Texture] = _LRUCache(max_items=96, max_cost=64 * 1024 * 1024)
        self._pdfs: _LRUCache[Any] = _LRUCache(max_items=12)
        self._waveforms: _LRUCache[list[float]] = _LRUCache(max_items=32)
        self._server_previews: _LRUCache[ServerPreview] = _LRUCache(max_items=48)
        self._texts: _LRUCache[str] = _LRUCache(max_items=48, max_cost=8 * 1024 * 1024)

    @classmethod
    def shared(cls) -> "BoundedPreviewCache":
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    def image(self, key: str) -> Optional[Gdk.Texture]:
        return self._images.get(key)

    def store_image(self, key: str, texture: Gdk.Texture) -> None:
        cost = max(1, int(texture.get_width()) * int(texture.get_height()) * 4)
        self._images.put(key, texture, cost=cost)

    def pdf(self, key: str) -> Optional[Any]:
        return self._pdfs.get(key)

    def store_pdf(self, key: str, doc: Any) -> None:
        self._pdfs.put(key, doc, cost=1)

    def waveform(self, key: str) -> Optional[list[float]]:
        return self._waveforms.get(key)

    def store_waveform(self, key: str, peaks: list[float]) -> None:
        self._waveforms.put(key, peaks, cost=1)

    def server_preview(self, key: str) -> Optional[ServerPreview]:
        return self._server_previews.get(key)

    def store_server_preview(self, key: str, preview: ServerPreview) -> None:
        self._server_previews.put(key, preview, cost=1)

    def text(self, key: str) -> Optional[str]:
        return self._texts.get(key)

    def store_text(self, key: str, content: str) -> None:
        self._texts.put(key, content, cost=max(1, len(content.encode("utf-8"))))

    def clear_all(self) -> None:
        self._images.clear()
        self._pdfs.clear()
        self._waveforms.clear()
        self._server_previews.clear()
        self._texts.clear()


@dataclass
class PreviewContext:
    store: ClipboardStore
    cache: BoundedPreviewCache
    palette: LumenPalette
    on_step_queue: Callable[[int, bool], None]
    on_select_queue_index: Callable[[int], None]
    on_toast: Callable[[str], None]
    on_copy_item: Callable[[PreviewItem], None]
    parent_window: Optional[Gtk.Window] = None


class PreviewRendererView(Gtk.Box):
    """Base GTK4 widget for all native preview renderers."""

    def __init__(self) -> None:
        super().__init__(orientation=Gtk.Orientation.VERTICAL, spacing=0)
        self.set_hexpand(True)
        self.set_vexpand(True)
        self.current_item: Optional[PreviewItem] = None
        self.current_context: Optional[PreviewContext] = None
        self._load_generation: int = 0

    def next_generation(self) -> int:
        self._load_generation += 1
        return self._load_generation

    def is_current_generation(self, gen: int) -> bool:
        return self._load_generation == gen

    def load(self, item: PreviewItem, context: PreviewContext) -> None:
        self.current_item = item
        self.current_context = context

    def apply_theme(self, palette: LumenPalette) -> None:
        pass

    def zoom_in(self) -> None:
        pass

    def zoom_out(self) -> None:
        pass

    def reset_zoom(self) -> None:
        pass

    def toggle_play_pause(self) -> bool:
        return False

    def step_page(self, delta: int) -> bool:
        return False

    def copy_primary_content(self) -> None:
        if self.current_item is not None and self.current_context is not None:
            self.current_context.on_copy_item(self.current_item)

    def teardown(self) -> None:
        self._load_generation += 1


class PreviewRenderer(Protocol):
    renderer_id: str
    priority: int

    def can_render(self, item: PreviewItem) -> bool: ...

    def create_view(self, item: PreviewItem, context: PreviewContext) -> PreviewRendererView: ...


class PreviewRegistry:
    """Ordered priority registry resolving the best native renderer per item."""

    _instance: Optional["PreviewRegistry"] = None

    def __init__(self) -> None:
        self._renderers: list[PreviewRenderer] = []

    @classmethod
    def shared(cls) -> "PreviewRegistry":
        if cls._instance is None:
            cls._instance = cls()
            from .preview_renderers import register_default_renderers

            register_default_renderers(cls._instance)
        return cls._instance

    def register(self, renderer: PreviewRenderer) -> None:
        self._renderers = [r for r in self._renderers if r.renderer_id != renderer.renderer_id]
        self._renderers.append(renderer)
        self._renderers.sort(key=lambda r: r.priority, reverse=True)

    def registered_ids(self) -> list[str]:
        return [r.renderer_id for r in self._renderers]

    def resolve(self, item: PreviewItem) -> PreviewRenderer:
        for renderer in self._renderers:
            if renderer.can_render(item):
                return renderer
        return self._renderers[-1]

    def make_view(self, item: PreviewItem, context: PreviewContext) -> PreviewRendererView:
        renderer = self.resolve(item)
        view = renderer.create_view(item, context)
        view.load(item, context)
        return view
