"""Canonical domain models, smart classification, and formatting helpers."""

from __future__ import annotations

import base64
import datetime as dt
import os
import re
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urlparse

from .capabilities import Gdk, GLib


class DisplayCategory(Enum):
    TEXT = "text"
    CODE = "code"
    IMAGE = "image"
    LINK = "link"
    COLOR = "color"
    FILE = "file"

    @property
    def label(self) -> str:
        return {
            DisplayCategory.TEXT: "文本",
            DisplayCategory.CODE: "代码",
            DisplayCategory.IMAGE: "图片",
            DisplayCategory.LINK: "链接",
            DisplayCategory.COLOR: "颜色",
            DisplayCategory.FILE: "文件",
        }[self]

    @property
    def icon_name(self) -> str:
        return {
            DisplayCategory.TEXT: "format-text-bold-symbolic",
            DisplayCategory.CODE: "utilities-terminal-symbolic",
            DisplayCategory.IMAGE: "image-x-generic-symbolic",
            DisplayCategory.LINK: "insert-link-symbolic",
            DisplayCategory.COLOR: "color-select-symbolic",
            DisplayCategory.FILE: "text-x-generic-symbolic",
        }[self]


class Classifier:
    CODE_EXTENSIONS = frozenset({
        "swift", "go", "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "php", "rs",
        "java", "kt", "c", "h", "cc", "cpp", "hpp", "cs", "rb", "sh", "zsh", "bash",
        "json", "jsonl", "yaml", "yml", "toml", "css", "scss", "sql", "xml", "html", "htm",
    })
    IMAGE_EXTENSIONS = frozenset({
        "png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff", "heic", "ico", "svg",
    })
    AUDIO_EXTENSIONS = frozenset({
        "mp3", "wav", "m4a", "aac", "ogg", "flac", "aiff", "aif", "opus",
    })
    VIDEO_EXTENSIONS = frozenset({
        "mp4", "m4v", "mov", "webm", "mkv", "ogv", "avi",
    })
    OFFICE_EXTENSIONS = frozenset({"docx", "xlsx", "pptx"})
    TEXT_EXTENSIONS = frozenset({
        "txt", "md", "markdown", "log", "csv", "tsv", "ini", "conf", "env",
    })

    _HEX_RE = re.compile(r"^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$")

    @classmethod
    def parse_hex_color(cls, raw: str) -> Optional[tuple[float, float, float, float]]:
        trimmed = (raw or "").strip()
        m = cls._HEX_RE.match(trimmed)
        if not m:
            return None
        hex_part = m.group(1)
        if len(hex_part) == 3:
            hex_part = "".join(ch * 2 for ch in hex_part)
        value = int(hex_part, 16)
        if len(hex_part) == 8:
            return (
                ((value >> 24) & 0xFF) / 255.0,
                ((value >> 16) & 0xFF) / 255.0,
                ((value >> 8) & 0xFF) / 255.0,
                (value & 0xFF) / 255.0,
            )
        return (
            ((value >> 16) & 0xFF) / 255.0,
            ((value >> 8) & 0xFF) / 255.0,
            (value & 0xFF) / 255.0,
            1.0,
        )

    @staticmethod
    def looks_like_code(text: str) -> bool:
        if len(text) < 12:
            return False
        if (text.startswith("{") and text.endswith("}")) or (text.startswith("[") and text.endswith("]")):
            if '":' in text or '",' in text:
                return True
        markers = (
            "func ", "function ", "async function", "const ", "let ", "import ", "package ",
            "class ", "struct ", "enum ", "def ", "return ", "SELECT ", "<?php", "#!/",
            "=>", "::", "->", "interface ", "protocol ", "public ", "private ",
        )
        hits = 0
        for marker in markers:
            if marker in text:
                hits += 1
                if hits >= 2:
                    return True
        if "\n" in text and "{" in text and "}" in text and (";" in text or "func " in text or "def " in text):
            return True
        return False

    @staticmethod
    def detect_language(file_name: Optional[str], content: str) -> str:
        if file_name:
            ext = Path(file_name).suffix.lstrip(".").lower()
            ext_map = {
                "go": "go",
                "swift": "swift",
                "ts": "ts",
                "tsx": "ts",
                "js": "js",
                "jsx": "js",
                "mjs": "js",
                "cjs": "js",
                "py": "py",
                "php": "php",
                "json": "json",
                "jsonl": "json",
                "css": "css",
                "scss": "css",
                "rs": "rust",
                "sql": "sql",
                "sh": "sh",
                "zsh": "sh",
                "bash": "sh",
                "yaml": "yaml",
                "yml": "yaml",
                "xml": "xml",
                "html": "xml",
                "htm": "xml",
                "c": "c",
                "h": "c",
                "cpp": "cpp",
                "cc": "cpp",
                "hpp": "cpp",
                "cs": "cs",
                "java": "java",
                "rb": "rb",
                "toml": "toml",
            }
            if ext in ext_map:
                return ext_map[ext]
        trimmed = (content or "").strip()
        if trimmed.startswith("<?php"):
            return "php"
        if trimmed.startswith("package ") and "func " in content:
            return "go"
        if "import AppKit" in content or "import Foundation" in content or "final class " in content:
            return "swift"
        if "def " in content and ("import " in content or "from " in content):
            return "py"
        if (trimmed.startswith("{") or trimmed.startswith("[")) and '":' in content:
            return "json"
        if "interface " in content or ": string" in content or ": number" in content:
            return "ts"
        if "SELECT " in content and "FROM " in content:
            return "sql"
        if "transition:" in content or "display:" in content:
            return "css"
        return "js"

    @staticmethod
    def language_display_name(lang: str) -> str:
        mapping = {
            "go": "Go",
            "swift": "Swift",
            "ts": "TypeScript",
            "js": "JavaScript",
            "py": "Python",
            "php": "PHP",
            "json": "JSON",
            "css": "CSS",
            "rust": "Rust",
            "sql": "SQL",
            "sh": "Shell",
            "yaml": "YAML",
            "xml": "XML / HTML",
            "c": "C",
            "cpp": "C++",
            "cs": "C#",
            "java": "Java",
            "rb": "Ruby",
            "toml": "TOML",
        }
        return mapping.get((lang or "").lower(), (lang or "CODE").upper())


class Formatters:
    @staticmethod
    def byte_count(num_bytes: int) -> str:
        if num_bytes < 1024:
            return f"{max(0, num_bytes)} B"
        kb = num_bytes / 1024.0
        if kb < 1024:
            return f"{kb:.1f} KB"
        mb = kb / 1024.0
        if mb < 1024:
            return f"{mb:.1f} MB"
        return f"{mb / 1024.0:.2f} GB"

    @staticmethod
    def relative_time(from_ms: int) -> str:
        if from_ms <= 0:
            return "刚刚"
        now = dt.datetime.now()
        ts = dt.datetime.fromtimestamp(from_ms / 1000.0)
        delta = (now - ts).total_seconds()
        if delta < 45:
            return "刚刚"
        if delta < 3600:
            return f"{max(1, int(delta // 60))} 分钟前"
        if delta < 86400 and ts.date() == now.date():
            return f"{max(1, int(delta // 3600))} 小时前"
        yesterday = now.date() - dt.timedelta(days=1)
        if ts.date() == yesterday:
            return "昨天"
        return f"{ts.month}/{ts.day} {ts.hour:02d}:{ts.minute:02d}"

    @staticmethod
    def media_duration(seconds: float) -> str:
        if seconds != seconds or seconds < 0 or seconds == float("inf"):
            return "0:00"
        total = int(seconds)
        mins, secs = divmod(total, 60)
        return f"{mins}:{secs:02d}"


def decode_data_url_texture(data_url: str) -> Optional[Gdk.Texture]:
    if not data_url or "," not in data_url:
        return None
    try:
        _, b64 = data_url.split(",", 1)
        raw = base64.b64decode(b64)
        return Gdk.Texture.new_from_bytes(GLib.Bytes.new(raw))
    except Exception:
        return None


def texture_from_bytes(raw: bytes) -> Optional[Gdk.Texture]:
    if not raw:
        return None
    try:
        return Gdk.Texture.new_from_bytes(GLib.Bytes.new(raw))
    except Exception:
        return None


@dataclass
class ClipboardItem:
    id: str
    sha256: str = ""
    kind: str = "text"
    mime: str = ""
    byte_size: int = 0
    width: int = 0
    height: int = 0
    preview: str = ""
    thumbnail_data_url: str = ""
    files: list[str] = field(default_factory=list)
    file_hashes: list[str] = field(default_factory=list)
    source_device: str = ""
    source_app: str = ""
    pinned: bool = False
    deleted: bool = False
    seen_count: int = 1
    created_at_ms: int = 0
    last_seen_at_ms: int = 0
    synced_at_ms: int = 0
    remote_id: str = ""
    materialized: bool = True
    text: Optional[str] = None
    text_truncated: Optional[bool] = None
    blob_path: Optional[str] = None

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> "ClipboardItem":
        created = int(data.get("createdAtMs") or 0)
        last_seen = int(data.get("lastSeenAtMs") or created)
        return cls(
            id=str(data.get("id") or ""),
            sha256=str(data.get("sha256") or ""),
            kind=str(data.get("kind") or "text"),
            mime=str(data.get("mime") or ""),
            byte_size=int(data.get("byteSize") or 0),
            width=int(data.get("width") or 0),
            height=int(data.get("height") or 0),
            preview=str(data.get("preview") or ""),
            thumbnail_data_url=str(data.get("thumbnailDataUrl") or ""),
            files=[str(x) for x in (data.get("files") or []) if x is not None],
            file_hashes=[str(x) for x in (data.get("fileHashes") or []) if x is not None],
            source_device=str(data.get("sourceDevice") or ""),
            source_app=str(data.get("sourceApp") or ""),
            pinned=bool(data.get("pinned", False)),
            deleted=bool(data.get("deleted", False)),
            seen_count=int(data.get("seenCount") or 1),
            created_at_ms=created,
            last_seen_at_ms=last_seen,
            synced_at_ms=int(data.get("syncedAtMs") or 0),
            remote_id=str(data.get("remoteId") or ""),
            materialized=bool(data.get("materialized", True)),
            text=data.get("text") if isinstance(data.get("text"), str) else None,
            text_truncated=data.get("textTruncated") if isinstance(data.get("textTruncated"), bool) else None,
            blob_path=data.get("blobPath") if isinstance(data.get("blobPath"), str) else None,
        )

    @property
    def effective_text(self) -> str:
        if self.text:
            return self.text
        return self.preview

    @property
    def primary_file_path(self) -> Optional[str]:
        for path in self.files:
            cleaned = path.strip()
            if cleaned:
                return cleaned
        return None

    @property
    def display_category(self) -> DisplayCategory:
        if self.kind == "image":
            return DisplayCategory.IMAGE
        if self.kind == "link":
            return DisplayCategory.LINK
        if self.kind == "file":
            if len(self.files) == 1 and self.primary_file_path:
                ext = Path(self.primary_file_path).suffix.lstrip(".").lower()
                if ext in Classifier.CODE_EXTENSIONS:
                    return DisplayCategory.CODE
            return DisplayCategory.FILE
        body = self.effective_text.strip()
        if Classifier.parse_hex_color(body) is not None:
            return DisplayCategory.COLOR
        if Classifier.looks_like_code(body):
            return DisplayCategory.CODE
        return DisplayCategory.TEXT

    @property
    def display_title(self) -> str:
        if self.kind == "file":
            if len(self.files) > 1:
                first = os.path.basename(self.files[0])
                return f"{len(self.files)} 个文件 · {first}"
            if self.primary_file_path:
                return os.path.basename(self.primary_file_path)
            return self.preview or "文件引用"
        if self.kind == "image":
            if self.width > 0 and self.height > 0:
                return f"图片 · {self.width} × {self.height}"
            return self.preview or "剪贴板图片"
        if self.kind == "link":
            raw = self.effective_text.strip()
            parsed = urlparse(raw)
            if parsed.netloc:
                path_part = "" if parsed.path in ("", "/") else parsed.path
                return parsed.netloc + path_part
            return (raw[:72] if raw else "链接")
        trimmed = self.effective_text.strip()
        if Classifier.parse_hex_color(trimmed) is not None:
            return trimmed.upper()
        for line in trimmed.splitlines():
            clean = line.strip()
            if clean:
                return clean[:72] + "…" if len(clean) > 72 else clean
        return "空内容"

    @property
    def source_label(self) -> str:
        if self.source_app.strip():
            return self.source_app.strip()
        if self.source_device.strip():
            return self.source_device.strip()
        return "本机"

    @property
    def formatted_size(self) -> str:
        if self.kind == "file" and len(self.files) > 1:
            return f"{len(self.files)} 项文件"
        if self.byte_size <= 0:
            if self.kind == "image" and self.width > 0 and self.height > 0:
                return f"{self.width} × {self.height}"
            return f"{len(self.effective_text.encode('utf-8'))} B"
        return Formatters.byte_count(self.byte_size)

    @property
    def timestamp_ms(self) -> int:
        return self.last_seen_at_ms if self.last_seen_at_ms > 0 else self.created_at_ms

    @property
    def relative_time(self) -> str:
        return Formatters.relative_time(self.timestamp_ms)

    @property
    def is_today(self) -> bool:
        if self.timestamp_ms <= 0:
            return True
        return dt.datetime.fromtimestamp(self.timestamp_ms / 1000.0).date() == dt.date.today()

    @property
    def is_yesterday(self) -> bool:
        if self.timestamp_ms <= 0:
            return False
        yesterday = dt.date.today() - dt.timedelta(days=1)
        return dt.datetime.fromtimestamp(self.timestamp_ms / 1000.0).date() == yesterday


@dataclass
class ClipboardSettings:
    capture_enabled: bool = False
    sync_enabled: bool = False
    sync_target_profile_id: str = ""
    retention_days: int = 30
    max_items: int = 500
    max_item_bytes: int = 8 * 1024 * 1024
    quick_orbit_position: str = "bottom"

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> "ClipboardSettings":
        return cls(
            capture_enabled=bool(data.get("captureEnabled", False)),
            sync_enabled=bool(data.get("syncEnabled", False)),
            sync_target_profile_id=str(data.get("syncTargetProfileId") or ""),
            retention_days=int(data.get("retentionDays") or 30),
            max_items=int(data.get("maxItems") or 500),
            max_item_bytes=int(data.get("maxItemBytes") or (8 * 1024 * 1024)),
            quick_orbit_position=str(data.get("quickOrbitPosition") or "bottom"),
        )


@dataclass
class CaptureStatus:
    enabled: bool = False
    supported: bool = True
    running: bool = False
    reason: Optional[str] = None

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> "CaptureStatus":
        return cls(
            enabled=bool(data.get("enabled", False)),
            supported=bool(data.get("supported", True)),
            running=bool(data.get("running", False)),
            reason=data.get("reason"),
        )


@dataclass
class SyncStatus:
    enabled: bool = False
    target_profile_id: Optional[str] = None
    last_sync_at_ms: Optional[int] = None
    last_error: Optional[str] = None

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> "SyncStatus":
        return cls(
            enabled=bool(data.get("enabled", False)),
            target_profile_id=data.get("targetProfileId"),
            last_sync_at_ms=data.get("lastSyncAtMs"),
            last_error=data.get("lastError"),
        )


@dataclass
class ClipboardStatus:
    platform: str = "linux"
    capture: CaptureStatus = field(default_factory=CaptureStatus)
    sync: SyncStatus = field(default_factory=SyncStatus)
    device_id: str = ""
    device_name: str = ""
    key_fingerprint: str = ""
    item_count: int = 0
    pinned_count: int = 0
    quick_orbit_position: str = "bottom"

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> "ClipboardStatus":
        return cls(
            platform=str(data.get("platform") or "linux"),
            capture=CaptureStatus.from_json(data.get("capture") or {}),
            sync=SyncStatus.from_json(data.get("sync") or {}),
            device_id=str(data.get("deviceId") or ""),
            device_name=str(data.get("deviceName") or ""),
            key_fingerprint=str(data.get("keyFingerprint") or ""),
            item_count=int(data.get("itemCount") or 0),
            pinned_count=int(data.get("pinnedCount") or 0),
            quick_orbit_position=str(data.get("quickOrbitPosition") or "bottom"),
        )


@dataclass(frozen=True)
class ServerProfile:
    id: str
    label: str
    endpoint: str
    active: bool

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> "ServerProfile":
        return cls(
            id=str(data.get("id") or ""),
            label=str(data.get("label") or ""),
            endpoint=str(data.get("endpoint") or ""),
            active=bool(data.get("active", False)),
        )


@dataclass
class OfficeBlock:
    kind: str
    text: str = ""
    rows: list[list[str]] = field(default_factory=list)

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> "OfficeBlock":
        raw_rows = data.get("rows") or []
        rows = [[str(cell) for cell in row] for row in raw_rows if isinstance(row, list)]
        return cls(kind=str(data.get("kind") or "p"), text=str(data.get("text") or ""), rows=rows)


@dataclass
class DocumentPreview:
    title: str = ""
    blocks: list[OfficeBlock] = field(default_factory=list)

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> "DocumentPreview":
        blocks = [OfficeBlock.from_json(b) for b in (data.get("blocks") or []) if isinstance(b, dict)]
        return cls(title=str(data.get("title") or ""), blocks=blocks)


@dataclass
class SheetPreview:
    name: str
    rows: list[list[str]] = field(default_factory=list)
    formulas: dict[str, str] = field(default_factory=dict)

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> "SheetPreview":
        raw_rows = data.get("rows") or []
        rows = [[str(cell) for cell in row] for row in raw_rows if isinstance(row, list)]
        raw_formulas = data.get("formulas") or {}
        formulas = {str(k): str(v) for k, v in raw_formulas.items()} if isinstance(raw_formulas, dict) else {}
        return cls(name=str(data.get("name") or "Sheet"), rows=rows, formulas=formulas)


@dataclass
class WorkbookPreview:
    sheets: list[SheetPreview] = field(default_factory=list)

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> "WorkbookPreview":
        sheets = [SheetPreview.from_json(s) for s in (data.get("sheets") or []) if isinstance(s, dict)]
        return cls(sheets=sheets)


@dataclass
class SlidePreview:
    number: int
    title: str = ""
    lines: list[str] = field(default_factory=list)

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> "SlidePreview":
        lines = [str(line) for line in (data.get("lines") or [])]
        return cls(number=int(data.get("number") or 1), title=str(data.get("title") or ""), lines=lines)


@dataclass
class PresentationPreview:
    slides: list[SlidePreview] = field(default_factory=list)

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> "PresentationPreview":
        slides = [SlidePreview.from_json(s) for s in (data.get("slides") or []) if isinstance(s, dict)]
        return cls(slides=slides)


@dataclass
class OfficePreview:
    format: str
    document: Optional[DocumentPreview] = None
    workbook: Optional[WorkbookPreview] = None
    presentation: Optional[PresentationPreview] = None

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> "OfficePreview":
        doc = DocumentPreview.from_json(data["document"]) if isinstance(data.get("document"), dict) else None
        wb = WorkbookPreview.from_json(data["workbook"]) if isinstance(data.get("workbook"), dict) else None
        pres = PresentationPreview.from_json(data["presentation"]) if isinstance(data.get("presentation"), dict) else None
        return cls(format=str(data.get("format") or ""), document=doc, workbook=wb, presentation=pres)


@dataclass
class ServerPreview:
    kind: str
    mime: str = ""
    text: str = ""
    truncated: bool = False
    index: int = 0
    file_name: str = ""
    file_size: int = 0
    office: Optional[OfficePreview] = None

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> "ServerPreview":
        office = OfficePreview.from_json(data["office"]) if isinstance(data.get("office"), dict) else None
        return cls(
            kind=str(data.get("kind") or "none"),
            mime=str(data.get("mime") or ""),
            text=str(data.get("text") or ""),
            truncated=bool(data.get("truncated", False)),
            index=int(data.get("index") or 0),
            file_name=str(data.get("fileName") or ""),
            file_size=int(data.get("fileSize") or 0),
            office=office,
        )
