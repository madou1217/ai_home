"""Local endpoint/credential resolution and visual preferences persistence.

Resolution order matches docs/architecture/paste-lumen-v7-native-contract.md:
1. Explicit runtime parameters (e.g. IPC configure from aih-server)
2. Process environment (AIH_SERVER_ORIGIN or AIH_SERVER_HOST + AIH_SERVER_PORT,
   AIH_SERVER_MANAGEMENT_KEY, AIH_HOME_DIR)
3. Read-only SQLite lookup at <AIH_HOME>/aih.db (`app_kv` -> `config:server`)

Credentials are never hardcoded and never accepted as command-line arguments.
"""

from __future__ import annotations

import json
import os
import sqlite3
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Mapping, Optional
from urllib.parse import quote


DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 9527


@dataclass(frozen=True)
class LumenEndpointConfig:
    origin: str = ""
    management_key: str = ""

    @property
    def is_valid(self) -> bool:
        return bool(self.origin and self.management_key)


class LumenLocalConfigLoader:
    @staticmethod
    def normalize_origin(raw: str) -> str:
        return (raw or "").strip().rstrip("/")

    @staticmethod
    def normalize_host(raw: str) -> str:
        trimmed = (raw or "").strip()
        if not trimmed or trimmed in ("0.0.0.0", "::", "[::]"):
            return DEFAULT_HOST
        return trimmed

    @staticmethod
    def resolve_ai_home_dir(env: Optional[Mapping[str, str]] = None) -> Path:
        source = env if env is not None else os.environ
        custom = (source.get("AIH_HOME_DIR") or "").strip()
        if custom:
            return Path(os.path.expanduser(custom))
        return Path.home() / ".ai_home"

    @classmethod
    def resolve_origin_from_env(cls, env: Mapping[str, str]) -> str:
        origin = (env.get("AIH_SERVER_ORIGIN") or "").strip()
        if origin:
            return cls.normalize_origin(origin)
        raw_port = (env.get("AIH_SERVER_PORT") or "").strip()
        if raw_port:
            try:
                port = int(raw_port)
                if 1 <= port <= 65535:
                    host = cls.normalize_host(env.get("AIH_SERVER_HOST") or DEFAULT_HOST)
                    return f"http://{host}:{port}"
            except ValueError:
                pass
        return ""

    @classmethod
    def read_from_local_sqlite(cls, ai_home_dir: Path) -> Optional[LumenEndpointConfig]:
        db_path = ai_home_dir / "aih.db"
        if not db_path.is_file():
            return None
        uri = f"file:{quote(str(db_path))}?mode=ro"
        conn: Optional[sqlite3.Connection] = None
        try:
            conn = sqlite3.connect(uri, uri=True, timeout=2.0)
            cur = conn.cursor()
            cur.execute("SELECT value FROM app_kv WHERE key = 'config:server' LIMIT 1")
            row = cur.fetchone()
            if not row or not row[0]:
                return None
            payload = json.loads(row[0])
            if not isinstance(payload, dict):
                return None
            host = cls.normalize_host(str(payload.get("host") or DEFAULT_HOST))
            port = DEFAULT_PORT
            raw_port = payload.get("port")
            if isinstance(raw_port, int) and 1 <= raw_port <= 65535:
                port = raw_port
            elif isinstance(raw_port, str):
                try:
                    parsed = int(raw_port.strip())
                    if 1 <= parsed <= 65535:
                        port = parsed
                except ValueError:
                    pass
            key = str(payload.get("managementKey") or "").strip()
            return LumenEndpointConfig(origin=f"http://{host}:{port}", management_key=key)
        except (sqlite3.Error, OSError, ValueError, TypeError):
            return None
        finally:
            if conn is not None:
                try:
                    conn.close()
                except sqlite3.Error:
                    pass

    @classmethod
    def resolve(
        cls,
        explicit_origin: str = "",
        explicit_key: str = "",
        env: Optional[Mapping[str, str]] = None,
    ) -> LumenEndpointConfig:
        clean_origin = cls.normalize_origin(explicit_origin)
        clean_key = (explicit_key or "").strip()
        if clean_origin and clean_key:
            return LumenEndpointConfig(origin=clean_origin, management_key=clean_key)

        source = env if env is not None else os.environ
        env_key = (source.get("AIH_SERVER_MANAGEMENT_KEY") or "").strip()
        env_origin = cls.resolve_origin_from_env(source)

        db_cfg = cls.read_from_local_sqlite(cls.resolve_ai_home_dir(source))

        final_origin = (
            clean_origin
            or env_origin
            or (db_cfg.origin if db_cfg else f"http://{DEFAULT_HOST}:{DEFAULT_PORT}")
        )
        final_key = clean_key or env_key or (db_cfg.management_key if db_cfg else "")
        return LumenEndpointConfig(
            origin=cls.normalize_origin(final_origin),
            management_key=final_key,
        )


@dataclass
class LumenVisualPreferences:
    theme: str = "light"  # "light" | "dark"
    particles: bool = True
    glow: bool = True
    motion: bool = True

    @staticmethod
    def _prefs_path() -> Path:
        xdg = (os.environ.get("XDG_CONFIG_HOME") or "").strip()
        base = Path(os.path.expanduser(xdg)) if xdg else (Path.home() / ".config")
        return base / "ai-home" / "lumen-v7-prefs.json"

    @classmethod
    def load(cls) -> "LumenVisualPreferences":
        path = cls._prefs_path()
        try:
            if path.is_file():
                raw = json.loads(path.read_text(encoding="utf-8"))
                if isinstance(raw, dict):
                    theme = raw.get("theme") if raw.get("theme") in ("light", "dark") else "light"
                    return cls(
                        theme=theme,
                        particles=bool(raw.get("particles", True)),
                        glow=bool(raw.get("glow", True)),
                        motion=bool(raw.get("motion", True)),
                    )
        except (OSError, ValueError, TypeError):
            pass
        return cls()

    def save(self) -> None:
        path = self._prefs_path()
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(asdict(self), indent=2), encoding="utf-8")
        except OSError:
            pass

    def copy(self) -> "LumenVisualPreferences":
        return LumenVisualPreferences(
            theme=self.theme,
            particles=self.particles,
            glow=self.glow,
            motion=self.motion,
        )
