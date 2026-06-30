# 2026-06-28 M6 Transport Decision Diagnostics

## Scope

继续收敛 M6 Transport Promotion 的运行时诊断闭环：

- `remote-gateway` 不只返回最终 transport，还返回 selector 的 `transportDecision`。
- WebRTC/WebTransport candidate 未 promotion 时，真实 RPC 结果和 audit 必须能解释 fallback 原因。
- relay 不在线或 relay handler 抛错时，也必须保留 decision，不能只返回 `remote_relay_session_unavailable`。
- 不改变默认 transport，不新增端口，不使用 mock 数据，不碰旧服务器。

## Code Changes

- `lib/server/remote/remote-gateway.js`
  - 改用 `selectTransportDecision()`。
  - `requestRemoteManagement()` / `streamRemoteManagement()` result 增加 `transportDecision`。
  - relay handler throw、direct timeout/failure、stream timeout/failure 都会把 `transportDecision` 附到 error details。
- `lib/server/remote/audit-log.js`
  - audit event 增加 `transportPurpose`、`fallbackUsed`、`fallbackFrom`、`rejectedTransports`。
  - rejected transports 最多保留 8 条，避免日志膨胀。
- `lib/server/webui-remote-node-routes.js`
  - remote node 错误响应透出 gateway 生成的安全 details。
- Tests:
  - `remote gateway records transport promotion fallback decision in result and audit`
  - `remote gateway keeps transport decision when relay request throws`
  - `web ui remote node test returns transport decision when relay is unavailable`

## Commits

```text
a311ac9 feat(fabric): Record remote transport decision diagnostics
53b378f fix(fabric): Preserve transport decisions on relay errors
```

## Local Validation

Focused tests:

```bash
node --test \
  test/remote-node-registry.test.js \
  test/web-ui-router.remote-nodes.test.js

node --test \
  test/remote-relay-server.test.js \
  test/node-relay-client.test.js
```

Result:

```text
remote-node-registry + web-ui-router.remote-nodes: 45/45 pass
remote-relay-server + node-relay-client: 27/27 pass
```

Full regression:

```bash
npm test
```

Result:

```text
tests 2613
pass 2613
fail 0
duration_ms 146619.073625
```

## AWS Deployment

Source was deployed from committed `HEAD=53b378f`, not from the dirty worktree.

```bash
git archive --format=tar.gz -o /tmp/aih-fabric-head-53b378f.tar.gz HEAD
shasum -a 256 /tmp/aih-fabric-head-53b378f.tar.gz
```

Archive:

```text
c7ac0694abe0257e4cc5af95e37aa192916f6b9bcdd35c3208c3d78feae7f063  /tmp/aih-fabric-head-53b378f.tar.gz
```

AWS current:

```text
remote_dir=/home/ubuntu/aih-fabric-current
server_pid=223645
listen=http://0.0.0.0:9527
```

`/readyz`:

```json
{
  "ok": true,
  "service": "aih-server",
  "ready": false,
  "accounts": {
    "codex": 0,
    "gemini": 0,
    "claude": 0,
    "agy": 0,
    "opencode": 0
  }
}
```

Interpretation: AWS remains a control/broker/relay-capable node with no provider runtime accounts. That is expected for this test.

Port check:

```text
223645 node bin/ai-home.js server serve --host 0.0.0.0 --port 9527
9528 readyz: timeout / unreachable
```

## Real AWS Route Smoke

Created a temporary AWS remote node through the real WebUI API:

```json
{
  "id": "m6-decision-audit-node",
  "preferredTransports": ["webrtc", "relay"],
  "capabilities": ["status", "sessions"],
  "transports": [
    {
      "id": "m6-decision-audit-node-webrtc",
      "kind": "webrtc",
      "endpoint": "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527",
      "status": "up",
      "score": 100
    },
    {
      "id": "m6-decision-audit-node-relay",
      "kind": "relay",
      "status": "up",
      "score": 55
    }
  ]
}
```

Called the real route:

```bash
curl --noproxy "*" -s --max-time 12 -X POST \
  http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527/v0/webui/nodes/m6-decision-audit-node/test
```

Result:

```json
{
  "ok": false,
  "error": "remote_relay_session_unavailable",
  "message": "remote_relay_session_unavailable",
  "transportDecision": {
    "transportPurpose": "status",
    "selectedTransportId": "m6-decision-audit-node-relay",
    "selectedTransportKind": "relay",
    "fallbackUsed": true,
    "fallbackFrom": ["webrtc"],
    "rejectedTransports": [
      {
        "id": "m6-decision-audit-node-webrtc",
        "kind": "webrtc",
        "reason": "webrtc_not_promoted"
      }
    ]
  }
}
```

## Real AWS Audit

Remote audit file:

```text
/home/ubuntu/.ai_home/remote-audit.jsonl
```

Sanitized audit event:

```json
{
  "nodeId": "m6-decision-audit-node",
  "rpc": "node.status.read",
  "scope": "status:read",
  "method": "GET",
  "transportId": "m6-decision-audit-node-relay",
  "transportKind": "relay",
  "transportPurpose": "status",
  "fallbackUsed": true,
  "fallbackFrom": ["webrtc"],
  "rejectedTransports": [
    {
      "id": "m6-decision-audit-node-webrtc",
      "kind": "webrtc",
      "reason": "webrtc_not_promoted"
    }
  ],
  "status": 503,
  "ok": false,
  "error": "remote_relay_session_unavailable"
}
```

## Cleanup

The temporary node and transports were removed from AWS `remote-nodes.json` after the smoke:

```json
{
  "nodes": 1,
  "transports": 1,
  "hasTempNode": false,
  "hasTempTransport": false
}
```

Final AWS readback:

- `/v0/webui/nodes` returns only the existing `m4-8-5-artifact-node`.
- `/readyz` HTTP 200.
- Only default `9527` server process remains.

## Conclusion

M6 transport candidate promotion is still blocked by TURN/WebTransport prerequisites, but the runtime decision is now observable:

- WebRTC candidate rejection is visible as `webrtc_not_promoted`.
- relay fallback selection is visible as `fallbackUsed=true`.
- relay unavailable errors retain the same decision in HTTP response and audit.
- No default transport behavior was promoted or changed.
