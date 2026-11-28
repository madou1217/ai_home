"""Built-in native GTK4 preview renderer registration."""

from __future__ import annotations

from ..preview_registry import PreviewRegistry
from .code_text_renderer import CodeRenderer, CollectionRenderer, FileFallbackRenderer, TextRenderer
from .image_color_renderer import ColorRenderer, ImageRenderer
from .media_renderer import AudioRenderer, VideoRenderer
from .office_renderer import OfficeRenderer
from .pdf_renderer import PDFRenderer


def register_default_renderers(registry: PreviewRegistry) -> None:
    registry.register(PDFRenderer())
    registry.register(AudioRenderer())
    registry.register(VideoRenderer())
    registry.register(OfficeRenderer())
    registry.register(ImageRenderer())
    registry.register(ColorRenderer())
    registry.register(CodeRenderer())
    registry.register(CollectionRenderer())
    registry.register(TextRenderer())
    registry.register(FileFallbackRenderer())
