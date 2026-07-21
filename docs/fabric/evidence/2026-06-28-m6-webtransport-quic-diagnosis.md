# 2026-06-28 M6 WebTransport/QUIC Diagnosis

## Scope

验证 M6 11.4：WebTransport/QUIC smoke。

本轮目标是用真实浏览器确认当前 AWS default `9527` 是否已经具备 WebTransport 前置条件，并记录 connect time、stream RTT 或 fallback reason。

不新增产品端口，不启动临时 QUIC server，不把 HTTP/WSS 成功冒充 WebTransport 成功。

## Environment

| item | value |
|---|---|
| Date | 2026-06-28 |
| Local cwd | `/Users/model/projects/feature/ai_home` |
| AWS endpoint | `http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527` |
| Product page | `http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527/ui/` |
| WebTransport URL attempted | `http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527/v0/fabric/webtransport/echo` |
| HTTPS WebTransport URL attempted | `https://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527/v0/fabric/webtransport/echo` |
| Browser | Chromium via system Chrome channel |
| Reference | MDN WebTransport API: `https://developer.mozilla.org/en-US/docs/Web/API/WebTransport_API` |

## Script Changes

新增 `scripts/fabric-real-webtransport-smoke.js`：

- 使用真实 browser context 探测 `globalThis.WebTransport`。
- 记录 `isSecureContext`、`webTransportType`、connect time、stream RTT、bytes read、failure reason。
- 默认不启动 QUIC server；如果 endpoint 不支持 HTTPS/H3，报告真实失败。
- 支持 `--page-url` 和 `--url` 分离：可以区分产品 HTTP 页面前置失败和 secure context 下的连接失败。

## Runtime Preconditions

Local Node:

```json
{
  "node": "v22.16.0",
  "webtransport": "undefined",
  "quic": false,
  "openssl": "3.0.16"
}
```

AWS Node:

```json
{
  "node": "v22.16.0",
  "webtransport": "undefined",
  "quic": false,
  "openssl": "3.0.16"
}
```

AWS listeners:

```text
tcp LISTEN 0 511 0.0.0.0:9527 0.0.0.0:* users:(("node",pid=207577,fd=27))
```

Interpretation:

- Node runtime does not provide a built-in WebTransport/QUIC server.
- AWS current only has AIH HTTP server on TCP `9527`; there is no HTTPS/H3/QUIC listener.

## Commands

Focused regression:

```bash
node --check scripts/fabric-real-webtransport-smoke.js
node --check scripts/fabric-real-webrtc-datachannel-smoke.js
node --test \
  test/fabric-real-webtransport-smoke.test.js \
  test/fabric-real-webrtc-datachannel-smoke.test.js
```

Product HTTP context smoke:

```bash
node scripts/fabric-real-webtransport-smoke.js \
  --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 \
  --timeout-ms 15000 \
  --diagnostics-file /tmp/aih-m6-webtransport-product-context.json
```

Secure context connection attempt:

```bash
node scripts/fabric-real-webtransport-smoke.js \
  --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 \
  --page-url https://example.com \
  --url https://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527/v0/fabric/webtransport/echo \
  --timeout-ms 15000 \
  --diagnostics-file /tmp/aih-m6-webtransport-secure-context.json
```

HTTP/TLS endpoint probe:

```bash
curl --noproxy "*" -I -s --max-time 8 \
  http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527/readyz

curl --noproxy "*" -k -I -s --max-time 8 \
  https://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527/readyz
```

Result:

- HTTP `/readyz` returns HTTP 200.
- HTTPS `/readyz` returns no response in this probe; current listener is not TLS.

## Product HTTP Context Result

```json
{
  "ok": false,
  "pageUrl": "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527/ui/",
  "webTransportUrl": "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527/v0/fabric/webtransport/echo",
  "probe": {
    "ok": false,
    "isSecureContext": false,
    "webTransportType": "undefined",
    "failureReason": "insecure_context"
  },
  "console": {
    "errors": 0,
    "warnings": 0,
    "pageErrors": []
  }
}
```

Interpretation:

- Current product page is HTTP, not a secure context.
- Browser does not expose `WebTransport` in this context.

## Secure Context Attempt Result

```json
{
  "ok": false,
  "pageUrl": "https://example.com",
  "webTransportUrl": "https://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527/v0/fabric/webtransport/echo",
  "probe": {
    "ok": false,
    "isSecureContext": true,
    "webTransportType": "function",
    "failureReason": "webtransport_connect_failed",
    "error": {
      "name": "WebTransportError",
      "message": "Opening handshake failed."
    }
  },
  "console": {
    "errors": 1,
    "warnings": 0,
    "pageErrors": []
  }
}
```

Interpretation:

- Chrome has a WebTransport API in a secure context.
- AWS `9527` cannot complete WebTransport opening handshake because it is not an HTTPS/H3 WebTransport endpoint.

## Metrics

| metric | value |
|---|---:|
| Script syntax | pass |
| Focused regression | 12/12 pass |
| Product context secure | false |
| Product context WebTransport type | `undefined` |
| Secure context WebTransport type | `function` |
| WebTransport connect | fail |
| Stream RTT | 0 |
| Bytes read | 0 |
| Fallback reason | `insecure_context`, then `Opening handshake failed` |
| HTTP `/readyz` | 200 |
| HTTPS `/readyz` | no TLS response |

## Verdict

diagnostic-pass / webtransport-fail

Current AWS default `9527` is not a WebTransport/QUIC endpoint. Do not promote WebTransport. Keep WSS/broker relay as the default path.

## Next Checks

1. Add an explicit HTTPS + HTTP/3/WebTransport server endpoint if WebTransport remains in scope.
2. Decide whether this endpoint may use a new UDP/TLS port, or whether it must be fronted by a reverse proxy that can terminate H3.
3. Only after a real H3 endpoint exists, rerun this smoke and require connect success plus stream RTT before marking 11.4 pass.
