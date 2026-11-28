"""Clipboard HTTP/SSE API client and shared reactive ClipboardStore.

All network I/O executes on background threads and marshals callbacks back onto
the GTK main loop via GLib.idle_add so UI widgets are mutated strictly on the
main thread.
"""

from __future__ import annotations

import concurrent.futures
import http.client
import json
import os
import socket
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass
from typing import Any, Callable, Optional

from .capabilities import GLib
from .config import LumenEndpointConfig, LumenLocalConfigLoader, LumenVisualPreferences
from .models import (
    ClipboardItem,
    ClipboardSettings,
    ClipboardStatus,
    ServerPreview,
    ServerProfile,
)


API_PREFIX = "/v1/management/webui/clipboard"


class ClipboardAPIError(Exception):
    def __init__(self, message: str, status_code: int = 0, code: str = ""):
        super().__init__(message)
        self.status_code = status_code
        self.code = code


def _parse_error_message(raw: bytes, status: int) -> str:
    try:
        obj = json.loads(raw.decode("utf-8", errors="replace"))
        if isinstance(obj, dict):
            nested = obj.get("error")
            if isinstance(nested, dict) and nested.get("message"):
                return str(nested["message"])
            if obj.get("message"):
                return str(obj["message"])
            if isinstance(nested, str) and nested:
                return nested
    except Exception:
        pass
    return f"请求失败 (HTTP {status})" if status else "网络请求失败"


def _dispatch_main(fn: Callable[..., Any], *args: Any) -> None:
    def _run() -> bool:
        fn(*args)
        return False

    GLib.idle_add(_run)


class ClipboardAPIClient:
    """Thread-safe HTTP client speaking to `/v1/management/webui/clipboard/*`."""

    def __init__(self) -> None:
        self._config = LumenEndpointConfig()
        self._executor = concurrent.futures.ThreadPoolExecutor(max_workers=6, thread_name_prefix="lumen-http")
        self._temp_dir = tempfile.mkdtemp(prefix="lumen-media-")
        self._temp_files: list[str] = []

    @property
    def config(self) -> LumenEndpointConfig:
        return self._config

    @property
    def is_configured(self) -> bool:
        return self._config.is_valid

    def configure(self, next_cfg: LumenEndpointConfig) -> bool:
        changed = next_cfg != self._config
        self._config = next_cfg
        return changed

    def auth_headers(self) -> dict[str, str]:
        if not self._config.management_key:
            return {}
        return {"Authorization": f"Bearer {self._config.management_key}"}

    def item_file_stream_url(self, item_id: str, index: int) -> Optional[str]:
        if not self.is_configured:
            return None
        seg = urllib.parse.quote(item_id, safe="")
        return f"{self._config.origin}{API_PREFIX}/items/{seg}/file?index={max(0, int(index))}"

    def _build_url(self, path: str, query: Optional[dict[str, str]] = None) -> str:
        url = f"{self._config.origin}{API_PREFIX}{path}"
        if query:
            url += "?" + urllib.parse.urlencode(query)
        return url

    def _request_sync(
        self,
        path: str,
        method: str = "GET",
        query: Optional[dict[str, str]] = None,
        json_body: Optional[dict[str, Any]] = None,
        timeout: float = 12.0,
    ) -> tuple[int, bytes, str]:
        if not self.is_configured:
            raise ClipboardAPIError("本机 AIH Server 或管理密钥未配置", status_code=0, code="unconfigured")
        url = self._build_url(path, query)
        headers = {
            "Authorization": f"Bearer {self._config.management_key}",
            "Accept": "application/json",
        }
        data: Optional[bytes] = None
        if json_body is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(json_body).encode("utf-8")
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                body = resp.read()
                ctype = resp.headers.get("Content-Type", "application/octet-stream")
                return resp.status, body, ctype
        except urllib.error.HTTPError as err:
            body = err.read() if err.fp else b""
            ctype = err.headers.get("Content-Type", "") if err.headers else ""
            return err.code, body, ctype
        except Exception as exc:
            raise ClipboardAPIError(str(exc), status_code=0, code="network_error") from exc

    def _submit(
        self,
        work: Callable[[], Any],
        on_success: Optional[Callable[[Any], None]] = None,
        on_error: Optional[Callable[[Exception], None]] = None,
    ) -> None:
        def _runner() -> None:
            try:
                result = work()
                if on_success is not None:
                    _dispatch_main(on_success, result)
            except Exception as exc:
                if on_error is not None:
                    _dispatch_main(on_error, exc)

        self._executor.submit(_runner)

    def _json_sync(
        self,
        path: str,
        method: str = "GET",
        query: Optional[dict[str, str]] = None,
        json_body: Optional[dict[str, Any]] = None,
        accepted: tuple[int, ...] = (200,),
        timeout: float = 12.0,
    ) -> dict[str, Any]:
        status, body, _ = self._request_sync(path, method=method, query=query, json_body=json_body, timeout=timeout)
        if status not in accepted:
            raise ClipboardAPIError(_parse_error_message(body, status), status_code=status)
        try:
            decoded = json.loads(body.decode("utf-8"))
            if not isinstance(decoded, dict):
                raise ClipboardAPIError("服务端返回格式无法解析", status_code=status)
            return decoded
        except ClipboardAPIError:
            raise
        except Exception as exc:
            raise ClipboardAPIError("服务端返回格式无法解析", status_code=status) from exc

    def list_items(
        self,
        limit: int = 200,
        query: str = "",
        kind: str = "",
        on_success: Optional[Callable[[list[ClipboardItem]], None]] = None,
        on_error: Optional[Callable[[Exception], None]] = None,
    ) -> None:
        params: dict[str, str] = {"limit": str(min(max(1, limit), 200))}
        if query:
            params["q"] = query
        if kind:
            params["kind"] = kind

        def _work() -> list[ClipboardItem]:
            data = self._json_sync("/items", query=params)
            return [ClipboardItem.from_json(x) for x in (data.get("items") or []) if isinstance(x, dict)]

        self._submit(_work, on_success, on_error)

    def get_item_detail(
        self,
        item_id: str,
        on_success: Optional[Callable[[ClipboardItem], None]] = None,
        on_error: Optional[Callable[[Exception], None]] = None,
    ) -> None:
        seg = urllib.parse.quote(item_id, safe="")

        def _work() -> ClipboardItem:
            data = self._json_sync(f"/items/{seg}")
            return ClipboardItem.from_json(data.get("item") or {})

        self._submit(_work, on_success, on_error)

    def _materialize_sync(self, item_id: str) -> bool:
        seg = urllib.parse.quote(item_id, safe="")
        data = self._json_sync(f"/items/{seg}/materialize", method="POST")
        return data.get("state") == "ready"

    def fetch_item_content(
        self,
        item_id: str,
        retries: int = 3,
        on_success: Optional[Callable[[tuple[bytes, str]], None]] = None,
        on_error: Optional[Callable[[Exception], None]] = None,
    ) -> None:
        seg = urllib.parse.quote(item_id, safe="")

        def _work() -> tuple[bytes, str]:
            remaining = retries
            while True:
                status, body, ctype = self._request_sync(f"/items/{seg}/content", timeout=20.0)
                if status == 200:
                    return body, ctype
                if status == 409 and remaining > 0:
                    remaining -= 1
                    ready = self._materialize_sync(item_id)
                    time.sleep(0.05 if ready else 0.8)
                    continue
                if status == 409:
                    raise ClipboardAPIError("正在从源设备获取内容，请稍候", status_code=409, code="pending")
                raise ClipboardAPIError(_parse_error_message(body, status), status_code=status)

        self._submit(_work, on_success, on_error)

    def fetch_item_file_data(
        self,
        item_id: str,
        index: int = 0,
        on_success: Optional[Callable[[tuple[bytes, str]], None]] = None,
        on_error: Optional[Callable[[Exception], None]] = None,
    ) -> None:
        seg = urllib.parse.quote(item_id, safe="")

        def _work() -> tuple[bytes, str]:
            status, body, ctype = self._request_sync(
                f"/items/{seg}/file",
                query={"index": str(max(0, index))},
                timeout=25.0,
            )
            if status != 200:
                raise ClipboardAPIError(_parse_error_message(body, status), status_code=status)
            return body, ctype

        self._submit(_work, on_success, on_error)

    def download_item_file_to_temp(
        self,
        item_id: str,
        index: int,
        suffix: str,
        on_success: Optional[Callable[[str], None]] = None,
        on_error: Optional[Callable[[Exception], None]] = None,
    ) -> None:
        """Downloads an authenticated file stream to a session temp file for GStreamer/Poppler."""
        seg = urllib.parse.quote(item_id, safe="")
        clean_suffix = suffix if suffix.startswith(".") else (f".{suffix}" if suffix else "")

        def _work() -> str:
            if not self.is_configured:
                raise ClipboardAPIError("本机 AIH Server 或管理密钥未配置", status_code=0)
            url = self._build_url(f"/items/{seg}/file", {"index": str(max(0, index))})
            req = urllib.request.Request(
                url,
                headers={"Authorization": f"Bearer {self._config.management_key}"},
                method="GET",
            )
            fd, target = tempfile.mkstemp(prefix="clip-", suffix=clean_suffix, dir=self._temp_dir)
            try:
                with urllib.request.urlopen(req, timeout=30.0) as resp, os.fdopen(fd, "wb") as out:
                    while True:
                        chunk = resp.read(65536)
                        if not chunk:
                            break
                        out.write(chunk)
            except Exception as exc:
                try:
                    os.unlink(target)
                except OSError:
                    pass
                if isinstance(exc, urllib.error.HTTPError):
                    raise ClipboardAPIError(_parse_error_message(exc.read(), exc.code), status_code=exc.code) from exc
                raise ClipboardAPIError(str(exc)) from exc
            self._temp_files.append(target)
            return target

        self._submit(_work, on_success, on_error)

    def fetch_file_preview(
        self,
        item_id: str,
        index: Optional[int] = None,
        on_success: Optional[Callable[[ServerPreview], None]] = None,
        on_error: Optional[Callable[[Exception], None]] = None,
    ) -> None:
        seg = urllib.parse.quote(item_id, safe="")
        query = {"index": str(max(0, index))} if index is not None else None

        def _work() -> ServerPreview:
            data = self._json_sync(f"/items/{seg}/preview", query=query, timeout=15.0)
            return ServerPreview.from_json(data.get("preview") or {})

        self._submit(_work, on_success, on_error)

    def copy_item_to_os_clipboard(
        self,
        item_id: str,
        retries: int = 3,
        on_success: Optional[Callable[[None], None]] = None,
        on_error: Optional[Callable[[Exception], None]] = None,
    ) -> None:
        """Authoritative OS clipboard write via POST /items/{id}/copy with 409 materialize retry."""
        seg = urllib.parse.quote(item_id, safe="")

        def _work() -> None:
            remaining = retries
            while True:
                status, body, _ = self._request_sync(f"/items/{seg}/copy", method="POST", timeout=15.0)
                if status == 200:
                    return None
                if status == 409 and remaining > 0:
                    remaining -= 1
                    ready = self._materialize_sync(item_id)
                    time.sleep(0.05 if ready else 0.8)
                    continue
                if status == 409:
                    raise ClipboardAPIError("正在从源设备获取内容，请稍候", status_code=409, code="pending")
                raise ClipboardAPIError(_parse_error_message(body, status), status_code=status)

        self._submit(_work, on_success, on_error)

    def ingest_text(
        self,
        text: str,
        kind: Optional[str] = None,
        source_app: str = "Lumen",
        on_success: Optional[Callable[[ClipboardItem], None]] = None,
        on_error: Optional[Callable[[Exception], None]] = None,
    ) -> None:
        payload: dict[str, Any] = {"text": text, "sourceApp": source_app}
        if kind:
            payload["kind"] = kind

        def _work() -> ClipboardItem:
            data = self._json_sync("/items", method="POST", json_body=payload, accepted=(200, 201))
            return ClipboardItem.from_json(data.get("item") or {})

        self._submit(_work, on_success, on_error)

    def set_pinned(
        self,
        item_id: str,
        pinned: bool,
        on_success: Optional[Callable[[ClipboardItem], None]] = None,
        on_error: Optional[Callable[[Exception], None]] = None,
    ) -> None:
        seg = urllib.parse.quote(item_id, safe="")

        def _work() -> ClipboardItem:
            data = self._json_sync(f"/items/{seg}/pin", method="POST", json_body={"pinned": pinned})
            return ClipboardItem.from_json(data.get("item") or {})

        self._submit(_work, on_success, on_error)

    def delete_item(
        self,
        item_id: str,
        on_success: Optional[Callable[[None], None]] = None,
        on_error: Optional[Callable[[Exception], None]] = None,
    ) -> None:
        seg = urllib.parse.quote(item_id, safe="")

        def _work() -> None:
            status, body, _ = self._request_sync(f"/items/{seg}", method="DELETE")
            if not (200 <= status < 300):
                raise ClipboardAPIError(_parse_error_message(body, status), status_code=status)
            return None

        self._submit(_work, on_success, on_error)

    def batch_delete_items(
        self,
        ids: list[str],
        on_success: Optional[Callable[[int], None]] = None,
        on_error: Optional[Callable[[Exception], None]] = None,
    ) -> None:
        if not ids:
            if on_success is not None:
                _dispatch_main(on_success, 0)
            return

        def _work() -> int:
            data = self._json_sync("/items/batch-delete", method="POST", json_body={"ids": ids})
            return int(data.get("deleted") or 0)

        self._submit(_work, on_success, on_error)

    def get_settings(
        self,
        on_success: Optional[Callable[[ClipboardSettings], None]] = None,
        on_error: Optional[Callable[[Exception], None]] = None,
    ) -> None:
        def _work() -> ClipboardSettings:
            data = self._json_sync("/settings")
            return ClipboardSettings.from_json(data.get("settings") or {})

        self._submit(_work, on_success, on_error)

    def patch_settings(
        self,
        patch: dict[str, Any],
        on_success: Optional[Callable[[ClipboardSettings], None]] = None,
        on_error: Optional[Callable[[Exception], None]] = None,
    ) -> None:
        def _work() -> ClipboardSettings:
            data = self._json_sync("/settings", method="PATCH", json_body=patch)
            return ClipboardSettings.from_json(data.get("settings") or {})

        self._submit(_work, on_success, on_error)

    def get_status(
        self,
        on_success: Optional[Callable[[ClipboardStatus], None]] = None,
        on_error: Optional[Callable[[Exception], None]] = None,
    ) -> None:
        def _work() -> ClipboardStatus:
            data = self._json_sync("/status")
            return ClipboardStatus.from_json(data)

        self._submit(_work, on_success, on_error)

    def list_servers(
        self,
        on_success: Optional[Callable[[list[ServerProfile]], None]] = None,
        on_error: Optional[Callable[[Exception], None]] = None,
    ) -> None:
        def _work() -> list[ServerProfile]:
            data = self._json_sync("/servers")
            return [ServerProfile.from_json(s) for s in (data.get("servers") or []) if isinstance(s, dict)]

        self._submit(_work, on_success, on_error)

    def trigger_sync(
        self,
        on_success: Optional[Callable[[None], None]] = None,
        on_error: Optional[Callable[[Exception], None]] = None,
    ) -> None:
        def _work() -> None:
            status, body, _ = self._request_sync("/sync-run", method="POST", timeout=20.0)
            if not (200 <= status < 300):
                raise ClipboardAPIError(_parse_error_message(body, status), status_code=status)
            return None

        self._submit(_work, on_success, on_error)

    def shutdown(self) -> None:
        self._executor.shutdown(wait=False, cancel_futures=True)
        for path in self._temp_files:
            try:
                os.unlink(path)
            except OSError:
                pass
        try:
            os.rmdir(self._temp_dir)
        except OSError:
            pass


class SSEClient:
    """Persistent SSE subscriber for `/v1/management/webui/clipboard/events`."""

    def __init__(self) -> None:
        self._config = LumenEndpointConfig()
        self._stop_event = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._active_conn: Optional[http.client.HTTPConnection] = None
        self._lock = threading.Lock()
        self.on_clipboard_changed: Optional[Callable[[], None]] = None
        self.on_connection_changed: Optional[Callable[[bool], None]] = None

    def start(self, next_cfg: LumenEndpointConfig) -> None:
        with self._lock:
            changed = next_cfg != self._config
            self._config = next_cfg
            if not next_cfg.is_valid:
                self._stop_locked()
                return
            if self._thread is not None and self._thread.is_alive() and not changed:
                return
            self._stop_locked()
            self._stop_event = threading.Event()
            stop_ev = self._stop_event
            cfg = self._config
            self._thread = threading.Thread(
                target=self._run_loop,
                args=(cfg, stop_ev),
                name="lumen-sse",
                daemon=True,
            )
            self._thread.start()

    def stop(self) -> None:
        with self._lock:
            self._stop_locked()

    def _stop_locked(self) -> None:
        self._stop_event.set()
        conn = self._active_conn
        self._active_conn = None
        if conn is not None:
            sock = getattr(conn, "sock", None)
            if sock is not None:
                try:
                    sock.shutdown(socket.SHUT_RDWR)
                except Exception:
                    pass
            try:
                conn.close()
            except Exception:
                pass

    def _run_loop(self, cfg: LumenEndpointConfig, stop_ev: threading.Event) -> None:
        backoff = 1.5
        parsed = urllib.parse.urlparse(cfg.origin)
        is_https = parsed.scheme == "https"
        host = parsed.hostname or "127.0.0.1"
        port = parsed.port or (443 if is_https else 80)
        path = f"{parsed.path.rstrip('/')}{API_PREFIX}/events"

        while not stop_ev.is_set():
            conn: Optional[http.client.HTTPConnection] = None
            try:
                conn = (
                    http.client.HTTPSConnection(host, port, timeout=120)
                    if is_https
                    else http.client.HTTPConnection(host, port, timeout=120)
                )
                with self._lock:
                    if stop_ev.is_set():
                        conn.close()
                        return
                    self._active_conn = conn
                conn.request(
                    "GET",
                    path,
                    headers={
                        "Authorization": f"Bearer {cfg.management_key}",
                        "Accept": "text/event-stream",
                        "Cache-Control": "no-cache",
                    },
                )
                resp = conn.getresponse()
                if resp.status != 200:
                    raise RuntimeError(f"SSE HTTP {resp.status}")
                backoff = 1.5
                if self.on_connection_changed:
                    _dispatch_main(self.on_connection_changed, True)

                event_lines: list[str] = []
                while not stop_ev.is_set():
                    raw_line = resp.readline()
                    if not raw_line:
                        break
                    line = raw_line.decode("utf-8", errors="replace").rstrip("\r\n")
                    if line == "":
                        frame = "\n".join(event_lines)
                        event_lines.clear()
                        if "event: clipboard" in frame and self.on_clipboard_changed:
                            _dispatch_main(self.on_clipboard_changed)
                    else:
                        event_lines.append(line)
                        if len(event_lines) > 256:
                            event_lines.clear()
            except Exception:
                pass
            finally:
                with self._lock:
                    if self._active_conn is conn:
                        self._active_conn = None
                if conn is not None:
                    try:
                        conn.close()
                    except Exception:
                        pass
                if not stop_ev.is_set() and self.on_connection_changed:
                    _dispatch_main(self.on_connection_changed, False)

            if stop_ev.wait(backoff):
                break
            backoff = min(backoff * 1.6, 15.0)


@dataclass
class UndoEntry:
    item: ClipboardItem
    full_text: Optional[str]


class ClipboardStore:
    """Shared reactive store backing App Window, Orbit Rail, and Preview Window."""

    _instance: Optional["ClipboardStore"] = None

    def __init__(self) -> None:
        self.api = ClipboardAPIClient()
        self._sse = SSEClient()
        self._observers: dict[str, Callable[[str, Any], None]] = {}

        self.items: list[ClipboardItem] = []
        self.settings: ClipboardSettings = ClipboardSettings()
        self.status: Optional[ClipboardStatus] = None
        self.servers: list[ServerProfile] = []
        self.connected: bool = False
        self.last_error: Optional[str] = None
        self.preferences: LumenVisualPreferences = LumenVisualPreferences.load()

        self._undo_stack: list[UndoEntry] = []
        self._detail_cache: dict[str, ClipboardItem] = {}
        self._refresh_debounce_id: int = 0
        self._is_refreshing_items: bool = False
        self.on_quick_orbit_position_changed: Optional[Callable[[str], None]] = None

        self._sse.on_clipboard_changed = self._schedule_debounced_refresh
        self._sse.on_connection_changed = self._handle_sse_connection

    @classmethod
    def shared(cls) -> "ClipboardStore":
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    @property
    def is_configured(self) -> bool:
        return self.api.is_configured

    @property
    def can_undo_delete(self) -> bool:
        return len(self._undo_stack) > 0

    def add_observer(self, handler: Callable[[str, Any], None]) -> str:
        obs_id = uuid.uuid4().hex
        self._observers[obs_id] = handler
        return obs_id

    def remove_observer(self, obs_id: str) -> None:
        self._observers.pop(obs_id, None)

    def _notify(self, event: str, payload: Any = None) -> None:
        for handler in list(self._observers.values()):
            try:
                handler(event, payload)
            except Exception:
                pass

    def _handle_sse_connection(self, online: bool) -> None:
        if self.connected != online:
            self.connected = online
            self._notify("connection")

    def configure(self, origin: str = "", management_key: str = "") -> None:
        resolved = LumenLocalConfigLoader.resolve(explicit_origin=origin, explicit_key=management_key)
        changed = self.api.configure(resolved)
        if resolved.is_valid:
            self._sse.start(resolved)
            if changed or not self.items:
                self.refresh_all()
        else:
            self._sse.stop()
            self.connected = False
            self._notify("connection")

    def ensure_configured_from_local(self) -> None:
        if self.api.is_configured:
            return
        resolved = LumenLocalConfigLoader.resolve()
        if resolved.is_valid:
            self.configure(resolved.origin, resolved.management_key)

    def update_preferences(self, mutate: Callable[[LumenVisualPreferences], None]) -> None:
        next_prefs = self.preferences.copy()
        mutate(next_prefs)
        if next_prefs == self.preferences:
            return
        self.preferences = next_prefs
        self.preferences.save()
        self._notify("preferences")

    def refresh_all(self) -> None:
        self.refresh_items()
        self.refresh_settings()
        self.refresh_status()
        self.refresh_servers()

    def _schedule_debounced_refresh(self) -> None:
        if self._refresh_debounce_id:
            GLib.source_remove(self._refresh_debounce_id)
            self._refresh_debounce_id = 0

        def _fire() -> bool:
            self._refresh_debounce_id = 0
            self.refresh_items()
            self.refresh_status()
            return False

        self._refresh_debounce_id = GLib.timeout_add(160, _fire)

    def refresh_items(self, on_done: Optional[Callable[[], None]] = None) -> None:
        if not self.api.is_configured or self._is_refreshing_items:
            if on_done:
                on_done()
            return
        self._is_refreshing_items = True

        def _ok(fetched: list[ClipboardItem]) -> None:
            self._is_refreshing_items = False
            merged: list[ClipboardItem] = []
            for item in fetched:
                cached = self._detail_cache.get(item.id)
                if cached and cached.text is not None:
                    item.text = cached.text
                    item.text_truncated = cached.text_truncated
                    item.blob_path = cached.blob_path
                merged.append(item)
            self.items = merged
            self.connected = True
            self.last_error = None
            self._notify("items")
            if on_done:
                on_done()

        def _err(exc: Exception) -> None:
            self._is_refreshing_items = False
            self.last_error = str(exc)
            self._notify("error", str(exc))
            if on_done:
                on_done()

        self.api.list_items(limit=200, on_success=_ok, on_error=_err)

    def hydrate_item_detail(self, item_id: str, on_done: Callable[[Optional[ClipboardItem]], None]) -> None:
        cached = self._detail_cache.get(item_id)
        if cached and cached.text is not None:
            on_done(cached)
            return

        def _ok(detailed: ClipboardItem) -> None:
            self._detail_cache[item_id] = detailed
            for idx, existing in enumerate(self.items):
                if existing.id == item_id:
                    self.items[idx] = detailed
                    self._notify("items")
                    break
            on_done(detailed)

        def _err(_exc: Exception) -> None:
            fallback = next((it for it in self.items if it.id == item_id), None)
            on_done(fallback)

        self.api.get_item_detail(item_id, on_success=_ok, on_error=_err)

    def refresh_settings(self) -> None:
        if not self.api.is_configured:
            return

        def _ok(loaded: ClipboardSettings) -> None:
            prev_pos = self.settings.quick_orbit_position
            self.settings = loaded
            self._notify("settings")
            if prev_pos != loaded.quick_orbit_position and self.on_quick_orbit_position_changed:
                self.on_quick_orbit_position_changed(loaded.quick_orbit_position)

        self.api.get_settings(on_success=_ok)

    def patch_settings(
        self,
        patch: dict[str, Any],
        on_success: Optional[Callable[[ClipboardSettings], None]] = None,
        on_error: Optional[Callable[[Exception], None]] = None,
    ) -> None:
        def _ok(updated: ClipboardSettings) -> None:
            prev_pos = self.settings.quick_orbit_position
            self.settings = updated
            self._notify("settings")
            if prev_pos != updated.quick_orbit_position and self.on_quick_orbit_position_changed:
                self.on_quick_orbit_position_changed(updated.quick_orbit_position)
            self.refresh_status()
            if on_success:
                on_success(updated)

        def _err(exc: Exception) -> None:
            self._notify("error", str(exc))
            if on_error:
                on_error(exc)

        self.api.patch_settings(patch, on_success=_ok, on_error=_err)

    def refresh_status(self) -> None:
        if not self.api.is_configured:
            return

        def _ok(status: ClipboardStatus) -> None:
            self.status = status
            self.connected = True
            self._notify("status")

        self.api.get_status(on_success=_ok)

    def refresh_servers(self) -> None:
        if not self.api.is_configured:
            return

        def _ok(servers: list[ServerProfile]) -> None:
            self.servers = servers
            self._notify("settings")

        self.api.list_servers(on_success=_ok)

    def copy_to_os_clipboard(
        self,
        item_id: str,
        on_success: Optional[Callable[[], None]] = None,
        on_error: Optional[Callable[[Exception], None]] = None,
    ) -> None:
        self.api.copy_item_to_os_clipboard(
            item_id,
            on_success=(lambda _: on_success()) if on_success else None,
            on_error=on_error,
        )

    def toggle_pin(
        self,
        item_id: str,
        on_success: Optional[Callable[[ClipboardItem], None]] = None,
        on_error: Optional[Callable[[Exception], None]] = None,
    ) -> None:
        existing = next((it for it in self.items if it.id == item_id), None)
        if existing is None:
            return
        self.set_pinned(item_id, not existing.pinned, on_success=on_success, on_error=on_error)

    def set_pinned(
        self,
        item_id: str,
        pinned: bool,
        on_success: Optional[Callable[[ClipboardItem], None]] = None,
        on_error: Optional[Callable[[Exception], None]] = None,
    ) -> None:
        def _ok(updated: ClipboardItem) -> None:
            for idx, it in enumerate(self.items):
                if it.id == item_id:
                    updated.text = it.text
                    self.items[idx] = updated
                    self._notify("items")
                    break
            self.refresh_status()
            if on_success:
                on_success(updated)

        def _err(exc: Exception) -> None:
            self._notify("error", str(exc))
            if on_error:
                on_error(exc)

        self.api.set_pinned(item_id, pinned, on_success=_ok, on_error=_err)

    def batch_set_pinned(self, ids: list[str], pinned: bool, on_done: Optional[Callable[[], None]] = None) -> None:
        if not ids:
            if on_done:
                on_done()
            return
        remaining = [len(ids)]

        def _step(_: Any = None) -> None:
            remaining[0] -= 1
            if remaining[0] <= 0:
                self.refresh_items(on_done=on_done)
                self.refresh_status()

        for item_id in ids:
            self.api.set_pinned(item_id, pinned, on_success=_step, on_error=_step)

    def delete_item(
        self,
        item_id: str,
        optimistic: bool = True,
        on_success: Optional[Callable[[], None]] = None,
        on_error: Optional[Callable[[Exception], None]] = None,
    ) -> None:
        removed_idx: Optional[int] = None
        removed_item: Optional[ClipboardItem] = None
        for idx, it in enumerate(self.items):
            if it.id == item_id:
                removed_idx = idx
                removed_item = it
                break
        if removed_item is not None:
            cached_text = (
                (self._detail_cache.get(item_id).text if item_id in self._detail_cache else None)
                or removed_item.text
                or (removed_item.preview if removed_item.kind in ("text", "link") else None)
            )
            self._undo_stack.append(UndoEntry(item=removed_item, full_text=cached_text))
            if len(self._undo_stack) > 25:
                self._undo_stack.pop(0)
        if optimistic and removed_idx is not None:
            self.items.pop(removed_idx)
            self._notify("items")

        def _ok(_: None) -> None:
            self._detail_cache.pop(item_id, None)
            if not optimistic:
                self.items = [it for it in self.items if it.id != item_id]
                self._notify("items")
            self.refresh_status()
            if on_success:
                on_success()

        def _err(exc: Exception) -> None:
            if optimistic and removed_item is not None and removed_idx is not None:
                self.items.insert(min(removed_idx, len(self.items)), removed_item)
                self._notify("items")
            self._notify("error", str(exc))
            if on_error:
                on_error(exc)

        self.api.delete_item(item_id, on_success=_ok, on_error=_err)

    def batch_delete(
        self,
        ids: list[str],
        on_success: Optional[Callable[[int], None]] = None,
        on_error: Optional[Callable[[Exception], None]] = None,
    ) -> None:
        id_set = set(ids)
        for item in self.items:
            if item.id in id_set:
                cached = self._detail_cache.get(item.id)
                full_text = (
                    (cached.text if cached else None)
                    or item.text
                    or (item.preview if item.kind in ("text", "link") else None)
                )
                self._undo_stack.append(UndoEntry(item=item, full_text=full_text))
        if len(self._undo_stack) > 40:
            del self._undo_stack[: len(self._undo_stack) - 40]
        self.items = [it for it in self.items if it.id not in id_set]
        self._notify("items")

        def _ok(deleted: int) -> None:
            for item_id in ids:
                self._detail_cache.pop(item_id, None)
            self.refresh_status()
            if on_success:
                on_success(deleted)

        def _err(exc: Exception) -> None:
            self.refresh_items()
            self._notify("error", str(exc))
            if on_error:
                on_error(exc)

        self.api.batch_delete_items(ids, on_success=_ok, on_error=_err)

    def create_text_item(
        self,
        text: str,
        on_success: Optional[Callable[[ClipboardItem], None]] = None,
        on_error: Optional[Callable[[Exception], None]] = None,
    ) -> None:
        trimmed = text.strip()
        kind = "link" if (trimmed.startswith("http://") or trimmed.startswith("https://")) else "text"

        def _ok(created: ClipboardItem) -> None:
            self.items = [it for it in self.items if it.id != created.id]
            created.text = text
            self._detail_cache[created.id] = created
            self.items.insert(0, created)
            self._notify("items")
            self.refresh_status()
            if on_success:
                on_success(created)

        self.api.ingest_text(text, kind=kind, source_app="Lumen", on_success=_ok, on_error=on_error)

    def undo_last_delete(
        self,
        on_success: Optional[Callable[[ClipboardItem], None]] = None,
        on_error: Optional[Callable[[Exception], None]] = None,
    ) -> None:
        if not self._undo_stack:
            if on_error:
                on_error(ClipboardAPIError("没有可撤销的删除记录"))
            return
        entry = self._undo_stack.pop()
        if entry.item.kind not in ("text", "link") or not entry.full_text:
            if on_error:
                on_error(ClipboardAPIError("该类型条目不支持撤销恢复", status_code=400))
            return

        def _ok(restored: ClipboardItem) -> None:
            if entry.item.pinned:
                self.set_pinned(restored.id, True)
            self.refresh_items()
            self.refresh_status()
            if on_success:
                on_success(restored)

        self.api.ingest_text(
            entry.full_text,
            kind=entry.item.kind,
            source_app=entry.item.source_app or "Lumen",
            on_success=_ok,
            on_error=on_error,
        )

    def shutdown(self) -> None:
        if self._refresh_debounce_id:
            GLib.source_remove(self._refresh_debounce_id)
            self._refresh_debounce_id = 0
        self._sse.stop()
        self.api.shutdown()
