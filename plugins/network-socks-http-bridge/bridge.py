#!/usr/bin/env python3
"""SOCKS5h -> local HTTP CONNECT bridge as an AIH network.connector plugin.

Protocol: line-delimited JSON-RPC on stdin/stdout. Logs go to stderr.
The bridge only listens on loopback. The upstream SOCKS URL is stored in
state/ and is never returned by describe/status.

Upstream can come from a static `socksUrl` or from `socksUrlFile`: a JSON
file published by the local `aih proxy serve` service. The file is re-read
when it changes, so a restarted service (new port and lease token) is picked
up without reconfiguring or restarting the bridge.
"""

import json
import os
import socket
import socketserver
import struct
import sys
import threading
import time
import urllib.parse

VERSION = "1.1.1"
DEFAULTS = {
    "socksUrl": "",
    "socksUrlFile": "",
    "listenHost": "127.0.0.1",
    "listenPort": 3128,
    "autoStart": True,
}
LOOPBACK_HOSTS = {"127.0.0.1", "::1", "localhost"}


class UpstreamError(OSError):
    """上游代理本身不可用（连接、认证或协议失败），区别于目标不可达。"""


class TargetError(OSError):
    """上游代理可达，但拒绝/无法连到目标地址。"""


def log(message):
    print("[socks-http-bridge] " + str(message), file=sys.stderr, flush=True)


def sanitize_instance(value):
    text = "".join(ch if ch.isalnum() or ch in "-_." else "_" for ch in str(value or ""))
    return text[:80] or "default"


def parse_socks_url(value):
    text = str(value or "").strip()
    if not text:
        raise ValueError("socksUrl 为空")
    parsed = urllib.parse.urlsplit(text)
    if parsed.scheme not in ("socks5h", "socks5"):
        raise ValueError("socksUrl 只支持 socks5h:// 或 socks5://")
    host = parsed.hostname or ""
    port = parsed.port or 1080
    if not host:
        raise ValueError("socksUrl 缺少主机")
    username = urllib.parse.unquote(parsed.username) if parsed.username else ""
    password = urllib.parse.unquote(parsed.password) if parsed.password else ""
    return host, int(port), username, password


def parse_listen_host(value):
    host = str(value or "127.0.0.1").strip()
    if host not in LOOPBACK_HOSTS:
        raise ValueError("listenHost 只允许回环地址（127.0.0.1 / ::1 / localhost）")
    return "127.0.0.1" if host == "localhost" else host


def recv_exact(sock, size):
    chunks = []
    remaining = size
    while remaining > 0:
        data = sock.recv(remaining)
        if not data:
            raise UpstreamError("unexpected EOF")
        chunks.append(data)
        remaining -= len(data)
    return b"".join(chunks)


def socks5_connect(upstream, host, port):
    proxy_host, proxy_port, username, password = upstream
    try:
        sock = socket.create_connection((proxy_host, proxy_port), timeout=20)
    except OSError as exc:
        raise UpstreamError("upstream unreachable: " + type(exc).__name__)
    try:
        methods = b"\x00" if not username else b"\x00\x02"
        sock.sendall(b"\x05" + bytes([len(methods)]) + methods)
        version, method = recv_exact(sock, 2)
        if version != 5:
            raise UpstreamError("SOCKS5 version mismatch")
        if method == 0x02:
            user_bytes = username.encode("utf-8")[:255]
            pass_bytes = password.encode("utf-8")[:255]
            sock.sendall(b"\x01" + bytes([len(user_bytes)]) + user_bytes + bytes([len(pass_bytes)]) + pass_bytes)
            _, status = recv_exact(sock, 2)
            if status != 0:
                raise UpstreamError("SOCKS5 authentication rejected")
        elif method != 0x00:
            raise UpstreamError("SOCKS5 no acceptable authentication method")

        host_bytes = host.encode("idna") if not _is_ip_literal(host) else host.encode("ascii")
        if _is_ipv4_literal(host):
            address = b"\x01" + socket.inet_aton(host)
        elif _is_ipv6_literal(host):
            address = b"\x04" + socket.inet_pton(socket.AF_INET6, host)
        else:
            address = b"\x03" + bytes([len(host_bytes)]) + host_bytes
        sock.sendall(b"\x05\x01\x00" + address + struct.pack("!H", port))

        _, reply, _, atyp = recv_exact(sock, 4)
        if reply != 0:
            raise TargetError("SOCKS5 connect rejected: " + str(reply))
        if atyp == 0x01:
            recv_exact(sock, 4)
        elif atyp == 0x03:
            length = recv_exact(sock, 1)[0]
            recv_exact(sock, length)
        elif atyp == 0x04:
            recv_exact(sock, 16)
        else:
            raise UpstreamError("SOCKS5 invalid address type")
        recv_exact(sock, 2)
        sock.settimeout(None)
        return sock
    except (UpstreamError, TargetError):
        sock.close()
        raise
    except OSError as exc:
        sock.close()
        raise UpstreamError("SOCKS5 transport failed: " + type(exc).__name__)


def _is_ipv4_literal(host):
    try:
        socket.inet_aton(host)
        return host.count(".") == 3
    except OSError:
        return False


def _is_ipv6_literal(host):
    try:
        socket.inet_pton(socket.AF_INET6, host)
        return True
    except OSError:
        return False


def _is_ip_literal(host):
    return _is_ipv4_literal(host) or _is_ipv6_literal(host)


def split_target(target):
    target = target.strip()
    if target.startswith("["):
        end = target.find("]")
        if end < 0 or end + 2 > len(target) or target[end + 1] != ":":
            raise ValueError("invalid CONNECT target")
        return target[1:end], int(target[end + 2:])
    host, separator, port = target.rpartition(":")
    if not separator or not host or not port.isdigit():
        raise ValueError("invalid CONNECT target")
    return host, int(port)


def http_error(sock, status, message):
    body = (message + "\n").encode("utf-8", "replace")
    header = (
        "HTTP/1.1 " + str(status) + " " + message + "\r\n"
        "Content-Type: text/plain; charset=utf-8\r\n"
        "Content-Length: " + str(len(body)) + "\r\n"
        "Connection: close\r\n\r\n"
    ).encode("latin1", "replace")
    try:
        sock.sendall(header + body)
    except OSError:
        pass


def read_http_head(sock):
    data = b""
    while b"\r\n\r\n" not in data:
        chunk = sock.recv(4096)
        if not chunk:
            raise OSError("client closed before request head")
        data += chunk
        if len(data) > 64 * 1024:
            raise ValueError("request head too large")
    head, _, rest = data.partition(b"\r\n\r\n")
    return head, rest


def relay(left, right):
    def pump(source, destination):
        try:
            while True:
                data = source.recv(65536)
                if not data:
                    break
                destination.sendall(data)
        except OSError:
            pass
        finally:
            try:
                destination.shutdown(socket.SHUT_WR)
            except OSError:
                pass

    first = threading.Thread(target=pump, args=(left, right), daemon=True)
    second = threading.Thread(target=pump, args=(right, left), daemon=True)
    first.start()
    second.start()
    first.join()
    second.join()
    for connection in (left, right):
        try:
            connection.close()
        except OSError:
            pass


class BridgeHandler(socketserver.BaseRequestHandler):
    def handle(self):
        bridge = self.server.bridge
        try:
            head, rest = read_http_head(self.request)
            lines = head.decode("latin1").split("\r\n")
            method, target, _ = lines[0].split(" ", 2)
            if method.upper() != "CONNECT":
                http_error(self.request, 501, "only HTTPS CONNECT is supported")
                return
            host, port = split_target(target)
        except Exception as exc:
            log("request head failed: " + type(exc).__name__)
            http_error(self.request, 400, "invalid CONNECT request")
            return

        upstream_socket = None
        for attempt in (0, 1):
            # 首次使用当前上游；上游握手失败时强制重读入口文件再试一次，
            # 覆盖常驻服务重启、端口和租约令牌已变化的窗口。
            upstream, source = bridge.upstream(force=attempt > 0)
            if upstream is None:
                http_error(self.request, 503, "bridge upstream is not configured")
                return
            try:
                upstream_socket = socks5_connect(upstream, host, port)
                break
            except UpstreamError as exc:
                log("upstream attempt " + str(attempt + 1) + " failed via " + str(source) + ": " + str(exc))
                if attempt == 1:
                    http_error(self.request, 502, "upstream connection failed")
                    return
            except Exception as exc:
                log("CONNECT failed: " + type(exc).__name__)
                http_error(self.request, 502, "upstream connection failed")
                return
        if upstream_socket is None:
            http_error(self.request, 502, "upstream connection failed")
            return
        try:
            self.request.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            if rest:
                upstream_socket.sendall(rest)
            relay(self.request, upstream_socket)
        except OSError:
            try:
                upstream_socket.close()
            except OSError:
                pass


class BridgeServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

    def __init__(self, address, handler, bridge):
        self.bridge = bridge
        super().__init__(address, handler)


class Bridge:
    def __init__(self):
        self.lock = threading.RLock()
        self.instance_id = "default"
        self.config = dict(DEFAULTS)
        self.server = None
        self.thread = None
        self.last_error = ""
        self.started_at = 0.0
        # 入口文件缓存：签名用于判断是否需要重读；缓存值在上游短暂
        # 不可用（如常驻服务重启中）时继续服务，避免直接断流。
        self.entry_signature = None
        self.entry_upstream = None
        self.upstream_source = ""

    def state_path(self):
        os.makedirs("state", exist_ok=True)
        return os.path.join("state", "config-" + sanitize_instance(self.instance_id) + ".json")

    def host_config_path(self):
        os.makedirs("state", exist_ok=True)
        return os.path.join("state", "host-" + sanitize_instance(self.instance_id) + ".json")

    def load_json(self, path):
        if not os.path.exists(path):
            return {}
        try:
            with open(path, "r", encoding="utf-8") as handle:
                value = json.load(handle)
            return value if isinstance(value, dict) else {}
        except Exception as exc:
            log("state load failed: " + type(exc).__name__)
            return {}

    def save_json(self, path, value):
        temporary = path + ".tmp"
        with open(temporary, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)

    def load_persisted(self):
        return self.load_json(self.state_path())

    def load_host_config(self):
        return self.load_json(self.host_config_path())

    def save(self):
        self.save_json(self.state_path(), self.config)

    def merge_config(self, incoming):
        saved = self.load_persisted()
        last_host = self.load_host_config()
        incoming = incoming if isinstance(incoming, dict) else {}
        incoming = {key: value for key, value in incoming.items() if value is not None}
        if incoming and incoming != last_host:
            merged = dict(DEFAULTS)
            merged.update(incoming)
            self.config = self.normalize(merged)
            self.save_json(self.host_config_path(), incoming)
            self.save()
            return
        merged = dict(DEFAULTS)
        if saved:
            merged.update(saved)
        else:
            merged.update(incoming)
        self.config = self.normalize(merged)

    def normalize(self, config):
        result = dict(DEFAULTS)
        result.update(config or {})
        result["listenHost"] = parse_listen_host(result.get("listenHost"))
        try:
            result["listenPort"] = int(result.get("listenPort") or 3128)
        except (TypeError, ValueError):
            result["listenPort"] = 3128
        if result["listenPort"] < 0 or result["listenPort"] > 65535:
            raise ValueError("listenPort 超出范围")
        result["autoStart"] = bool(result.get("autoStart", True))
        result["socksUrl"] = str(result.get("socksUrl") or "").strip()
        if result["socksUrl"]:
            parse_socks_url(result["socksUrl"])
        result["socksUrlFile"] = str(result.get("socksUrlFile") or "").strip()
        return result

    def read_entry_file(self, path, force):
        """读取入口文件里的 SOCKS5 URL；读不到时保留上一次的有效值。"""
        try:
            info = os.stat(path)
            signature = (info.st_mtime_ns, info.st_size)
        except OSError:
            return self.entry_upstream
        if not force and signature == self.entry_signature:
            return self.entry_upstream
        try:
            with open(path, "r", encoding="utf-8") as handle:
                payload = json.load(handle)
        except Exception as exc:
            log("entry file read failed: " + type(exc).__name__)
            return self.entry_upstream
        raw = ""
        if isinstance(payload, dict):
            raw = str(payload.get("socks5Url") or payload.get("socksUrl") or "").strip()
        if not raw:
            return self.entry_upstream
        try:
            parsed = parse_socks_url(raw)
        except ValueError:
            log("entry file has invalid socks5Url")
            return self.entry_upstream
        self.entry_signature = signature
        self.entry_upstream = parsed
        return parsed

    def upstream(self, force=False):
        """返回 (上游, 来源)；来源只用于状态展示，不含凭据。"""
        with self.lock:
            path = self.config.get("socksUrlFile") or ""
            if path:
                parsed = self.read_entry_file(path, force)
                if parsed is not None:
                    self.upstream_source = "socksUrlFile"
                    return parsed, "socksUrlFile"
            static = self.config.get("socksUrl") or ""
            if static:
                try:
                    self.upstream_source = "socksUrl"
                    return parse_socks_url(static), "socksUrl"
                except ValueError:
                    pass
            self.upstream_source = ""
            return None, ""

    def has_upstream(self, force=False):
        upstream, _ = self.upstream(force=force)
        return upstream is not None

    def start(self):
        with self.lock:
            if self.server is not None:
                return True
            if not self.has_upstream(force=True):
                self.last_error = "上游 SOCKS5 未配置（socksUrl 或 socksUrlFile）"
                return False
            host = self.config["listenHost"]
            port = self.config["listenPort"]
            family = socket.AF_INET6 if ":" in host else socket.AF_INET
            class FamilyServer(BridgeServer):
                address_family = family
            # 插件宿主重启时新旧实例可能短暂重叠；端口释放有延迟时短暂重试，
            # 避免一次 listen 失败就让桥永久停在 error。
            attempts = 10
            for attempt in range(attempts):
                try:
                    self.server = FamilyServer((host, port), BridgeHandler, self)
                    break
                except Exception as exc:
                    self.server = None
                    self.last_error = "listen failed: " + type(exc).__name__
                    if attempt + 1 < attempts:
                        time.sleep(0.25)
            if self.server is None:
                return False
            self.last_error = ""
            self.started_at = time.time()
            self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.2}, daemon=True)
            self.thread.start()
            log("listening on " + host + ":" + str(self.server.server_address[1]))
            return True

    def stop(self):
        with self.lock:
            server = self.server
            self.server = None
            thread = self.thread
            self.thread = None
        if server is not None:
            try:
                server.shutdown()
            except Exception:
                pass
            try:
                server.server_close()
            except Exception:
                pass
        if thread is not None and thread.is_alive():
            thread.join(timeout=2)

    def listen_address(self):
        with self.lock:
            if self.server is None:
                return ""
            host, port = self.server.server_address[:2]
            return str(host) + ":" + str(port)

    def status(self):
        with self.lock:
            running = self.server is not None
            source = self.upstream_source or ("socksUrlFile" if self.config.get("socksUrlFile") else "")
            if running:
                detail = "listening on loopback:" + str(self.server.server_address[1])
                if source:
                    detail += " (upstream: " + source + ")"
                message = self.last_error or detail
            else:
                message = self.last_error or "stopped"
            if running:
                state = "listening"
            elif self.last_error:
                state = "error"
            elif not self.has_upstream():
                state = "needs_configuration"
            else:
                state = "stopped"
            connectivity = {
                "mode": "outbound-tunnel" if running else "unavailable",
                "confidence": "observed" if running else "unknown",
                "observedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "evidence": {
                    "source": "local listener + socks5h upstream",
                    "path": "socks5h->http-connect",
                    "transport": "tcp",
                },
            }
            return {
                "installed": True,
                "enabled": True,
                "running": running,
                "state": state,
                "version": VERSION,
                "message": message,
                "upstream": {"source": source or "none", "configured": self.has_upstream()},
                "connectivity": connectivity,
            }

    def describe(self):
        return {
            "id": "socks-http-bridge",
            "name": "SOCKS5h → HTTP 代理桥",
            "description": "把上游 SOCKS5h 代理暴露为本机回环 HTTP CONNECT 代理；仅支持 TCP/HTTPS，不支持 UDP。",
            "transport": "proxy",
            "operations": [
                {"id": "configure", "label": "配置", "inputKind": "custom", "confirmation": "required"},
                {"id": "start", "label": "启动", "inputKind": "none", "confirmation": "none"},
                {"id": "stop", "label": "停止", "inputKind": "none", "confirmation": "none"},
                {"id": "restart", "label": "重启", "inputKind": "none", "confirmation": "none"},
                {"id": "probe", "label": "探测", "inputKind": "none", "confirmation": "none"},
            ],
            "config": {
                "schema": {
                    "type": "object",
                    "properties": {
                        "socksUrl": {"type": "string", "title": "SOCKS5h 上游", "description": "socks5h://[user:pass@]host:port"},
                        "socksUrlFile": {"type": "string", "title": "入口文件", "description": "读取 aih proxy serve 发布的 entry.json（服务重启后自动更新上游）"},
                        "listenPort": {"type": "integer", "title": "监听端口", "minimum": 1, "maximum": 65535},
                        "autoStart": {"type": "boolean", "title": "随插件启动"},
                    },
                    "required": [],
                },
                "secretFields": ["socksUrl"],
            },
            "connectivityModes": ["outbound-tunnel", "unavailable", "unknown"],
        }

    def configure(self, payload):
        if not isinstance(payload, dict):
            raise ValueError("configure input must be an object")
        current = dict(self.config)
        current.update({key: value for key, value in payload.items() if value is not None})
        self.config = self.normalize(current)
        if not self.config.get("socksUrl") and not self.config.get("socksUrlFile"):
            raise ValueError("socksUrl 与 socksUrlFile 至少配置一个")
        self.save()
        self.stop()
        if self.config.get("autoStart", True) and self.has_upstream(force=True):
            self.start()
        return True

    def probe(self):
        upstream, source = self.upstream(force=True)
        if upstream is None:
            return {"ok": False, "message": "上游 SOCKS5 未配置（socksUrl 或 socksUrlFile）"}
        started = time.time()
        try:
            sock = socks5_connect(upstream, "example.com", 443)
            sock.close()
        except Exception as exc:
            log("probe via " + source + " failed: " + type(exc).__name__)
            return {"ok": False, "message": "上游 SOCKS5 探测失败"}
        return {"ok": True, "message": "上游 SOCKS5 可达（" + source + "）", "latencyMs": int((time.time() - started) * 1000)}

    def handle_operate(self, action, payload):
        if action == "configure":
            changed = self.configure(payload)
        elif action == "start":
            changed = self.start()
        elif action == "stop":
            self.stop()
            changed = True
        elif action == "restart":
            self.stop()
            changed = self.start()
        elif action == "probe":
            result = self.probe()
            return {
                "ok": bool(result.get("ok")),
                "changed": False,
                "message": result.get("message", ""),
                "status": self.status(),
            }
        else:
            return {"ok": False, "changed": False, "message": "unsupported action"}
        return {"ok": bool(changed), "changed": bool(changed), "message": self.status()["message"], "status": self.status()}


BRIDGE = Bridge()


def respond(request_id, result=None, error=None):
    message = {"id": request_id}
    if error is not None:
        message["error"] = error
    else:
        message["result"] = result if result is not None else {}
    sys.stdout.write(json.dumps(message, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
            request_id = request.get("id", "")
            method = request.get("method", "")
            params = request.get("params") or {}
            if method == "prepare":
                plugins = params.get("plugins") or []
                if plugins:
                    plugin = plugins[0] or {}
                    BRIDGE.instance_id = plugin.get("instanceId") or "default"
                    BRIDGE.merge_config(plugin.get("configuration") or {})
                    if BRIDGE.config.get("autoStart", True) and BRIDGE.has_upstream(force=True):
                        BRIDGE.start()
                respond(request_id, {"state": "prepared"})
            elif method == "activate":
                if BRIDGE.config.get("autoStart", True) and BRIDGE.has_upstream(force=True) and BRIDGE.server is None:
                    BRIDGE.start()
                respond(request_id, {"state": "active"})
            elif method == "invoke":
                value = params.get("value") or {}
                kind = value.get("kind")
                if kind == "describe":
                    respond(request_id, {"connector": BRIDGE.describe()})
                elif kind == "status":
                    respond(request_id, {"status": BRIDGE.status()})
                elif kind == "operate":
                    respond(request_id, BRIDGE.handle_operate(value.get("action", ""), value.get("input") or {}))
                else:
                    respond(request_id, error={"code": "network_connector_operation_invalid", "message": "unknown invoke kind"})
            elif method == "status":
                respond(request_id, {"state": "ready"})
            elif method == "ping":
                respond(request_id, {"state": "pong"})
            elif method == "dispose":
                BRIDGE.stop()
                respond(request_id, {"state": "disposed"})
            elif method == "shutdown":
                BRIDGE.stop()
                respond(request_id, {"state": "shutdown"})
                return
            else:
                respond(request_id, error={"code": "plugin_rpc_method_unknown", "message": "unknown method"})
        except Exception as exc:
            log("request failed: " + type(exc).__name__ + ": " + str(exc))
            try:
                respond(request.get("id", ""), error={"code": "network_connector_error", "message": type(exc).__name__})
            except Exception:
                pass


if __name__ == "__main__":
    main()
