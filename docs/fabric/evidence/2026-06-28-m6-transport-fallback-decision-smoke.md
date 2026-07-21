# 2026-06-28 M6 Transport Fallback Decision Smoke

## Scope

验证 M6 Transport Promotion 的 11.5 fallback gate：

- WebRTC candidate 失败时必须有明确诊断。
- Product transport selector 不能把未 promotion 的 WebRTC/WebTransport 当成正式 RPC 通道。
- 正式 fallback 数据面必须仍能通过 AWS current 默认 `9527` broker proxy 启动真实 Codex session。

本轮不新增端口，不触碰旧服务器，不使用 mock 数据。AWS current 仍只作为 broker/control/relay-capable endpoint；真实 provider runtime 在本机。

## Code Surface

| File | Purpose |
|---|---|
| `lib/server/remote/transport-registry.js` | 将 `webrtc` / `webtransport` 登记为 candidate-only transport kinds，不加入 remote request transport |
| `lib/server/remote/transport-selector.js` | 新增 `selectTransportDecision()`，保留 `selectTransport()` 兼容行为，并输出 candidate rejection/fallback reason |
| `test/remote-node-registry.test.js` | 覆盖 candidate-only catalog 和 WebRTC 未 promotion 时回落到 relay |

## Focused Regression

```bash
node --check lib/server/remote/transport-registry.js
node --check lib/server/remote/transport-selector.js
node --test \
  test/remote-node-registry.test.js \
  test/web-ui-router.remote-nodes.test.js \
  test/fabric-role-registry.test.js \
  test/fabric-real-webrtc-datachannel-smoke.test.js
```

Result: 51/51 pass.

Full regression:

```bash
npm test
```

Result: 2604/2604 pass.

## WebRTC Candidate Failure

Command:

```bash
npx --yes --package playwright node scripts/fabric-real-webrtc-datachannel-smoke.js \
  --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 \
  --no-default-stun \
  --ice-server stun:127.0.0.1:9 \
  --sample-count 3 \
  --timeout-ms 15000 \
  --headed \
  --diagnostics-file /tmp/aih-webrtc-fallback-failure.json
```

Sanitized result:

```json
{
  "ok": false,
  "roomId": "rtc_-q_lB1wWjSXsg3Nn",
  "iceServers": ["stun:127.0.0.1:9"],
  "rtt": { "count": 0 },
  "offerer": {
    "channelOpened": false,
    "connectionState": "failed",
    "iceConnectionState": "disconnected",
    "localCandidateKinds": { "host": 2 },
    "remoteCandidateKinds": { "host": 2 }
  },
  "answerer": {
    "channelOpened": false,
    "connectionState": "failed",
    "iceConnectionState": "disconnected",
    "localCandidateKinds": { "host": 2 },
    "remoteCandidateKinds": { "host": 2 }
  },
  "console": {
    "errors": 0,
    "warnings": 0,
    "pageErrors": []
  }
}
```

Interpretation: AWS signaling works, but this candidate has no usable srflx/relay path. DataChannel did not open and no RTT sample was produced.

## Selector Decision With Real AWS Registry

Command summary:

```text
1. Read local paired AWS server profile from http://127.0.0.1:9527/v0/webui/control-plane/profiles.
2. Read AWS registry with the paired device bearer.
3. Build a decision using the real `local-mac-remote-node` relay transport plus the explicit WebRTC candidate endpoint.
4. Call selectTransportDecision(..., { purpose: 'runtime' }).
```

Sanitized result:

```json
{
  "registryStatus": 200,
  "counts": {
    "nodes": 2,
    "relayNodes": 2,
    "transports": 2,
    "projects": 2,
    "runtimes": 4
  },
  "nodeId": "local-mac-remote-node",
  "relayTransports": [
    {
      "id": "local-mac-remote-node-relay",
      "kind": "relay",
      "status": "online"
    }
  ],
  "decision": {
    "selectedTransportId": "local-mac-remote-node-relay",
    "selectedKind": "relay",
    "fallbackUsed": true,
    "fallbackFrom": ["webrtc"],
    "rejected": [
      {
        "id": "aws-current-webrtc-candidate",
        "kind": "webrtc",
        "reason": "webrtc_not_promoted"
      }
    ]
  }
}
```

## Real Fallback Session

Start local server outbound broker link to AWS current:

```bash
AIH_FABRIC_BROKER_TOKEN="$(ssh -i "$HOME/.ssh/aws.pem" \
  ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com \
  "cat /home/ubuntu/aih-fabric-current/.broker-token")" \
node bin/ai-home.js fabric broker connect \
  http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 \
  --server-id m6-fallback \
  --local-url http://127.0.0.1:9527 \
  --heartbeat-ms 1000
```

Proxy health check:

```bash
curl -s \
  http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527/v0/fabric/broker/servers/m6-fallback/proxy/readyz
```

Result: HTTP 200, local server `ready=true`, provider accounts present locally.

Native Codex session through AWS broker proxy and relay:

```bash
node scripts/fabric-real-outbound-relay-smoke.js \
  --endpoint http://127.0.0.1:9527 \
  --client-endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527/v0/fabric/broker/servers/m6-fallback/proxy \
  --host-home /Users/model \
  --node-id m6-fallback-relay-node \
  --timeout-ms 45000 \
  --session-provider codex \
  --session-account 1 \
  --session-model gpt-5.5 \
  --session-project /Users/model/projects/feature/ai_home \
  --session-prompt "Return one line by joining these words with underscores: AIH M6 FALLBACK RELAY OK 628A. Do not add any other text." \
  --expect-output AIH_M6_FALLBACK_RELAY_OK_628A \
  --session-timeout-ms 120000
```

Sanitized result:

```json
{
  "ok": true,
  "mode": "existing-endpoint-relay",
  "client": {
    "viaProxy": true
  },
  "relay": {
    "online": true,
    "transportKind": "relay",
    "transportId": "m6-fallback-relay-node-relay",
    "sessionIdPresent": true
  },
  "sessions": {
    "status": 200,
    "ok": true,
    "rpc": "control_plane.device.node_sessions"
  },
  "session": {
    "ok": true,
    "provider": "codex",
    "accountId": "1",
    "model": "gpt-5.5",
    "startStatus": 200,
    "runIdPresent": true,
    "expectedOutputFound": true,
    "cursor": 214,
    "eventCounts": {
      "ready": 1,
      "terminal-output": 212,
      "done": 1
    },
    "quit": {
      "status": 200,
      "ok": true,
      "accepted": true
    },
    "cleanup": {
      "completed": true
    }
  }
}
```

## Cleanup

- Stopped the temporary `m6-fallback` broker link.
- Local process check found no `m6-fallback`, WebRTC smoke, or broker connect process.
- AWS process check found no `m6-fallback`; only the existing long-running `aws-current-node` relay service remained.
- Removed local temporary remote-node config created by this smoke:
  - nodes removed: `m6-fallback-node`, `m6-fallback-relay-node`
  - transports removed: `m6-fallback-relay-node-relay`
  - secrets removed: `remote-node/m6-fallback-node`, `remote-node/m6-fallback-relay-node`
- Kept `remote-audit.jsonl` records for traceability.

## Verdict

pass

11.5 fallback decision gate is complete for the current default path:

- failed WebRTC candidate is diagnosable;
- candidate-only transports are not selected for remote runtime RPC;
- selector reports `webrtc_not_promoted` and falls back to relay;
- AWS current default `9527` broker proxy + relay + real Codex runtime session remains usable.

Remaining M6 work: phone/cross-device WebRTC, controlled TURN relay evidence, and WebTransport/QUIC smoke.
