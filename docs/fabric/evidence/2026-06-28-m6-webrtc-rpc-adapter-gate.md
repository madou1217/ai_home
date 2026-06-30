# 2026-06-28 M6 WebRTC DataChannel RPC Adapter Gate

## Scope

本证据记录 WebRTC DataChannel 的软件侧 RPC adapter readiness。目标是证明同一条 AWS current 默认 `9527` signaling 路径不仅能打开 DataChannel 和 ping/pong，还能承载最小 JSON RPC request/response 帧。

约束：

- 只使用 AWS current：`ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com`。
- 只使用默认端口 `9527`。
- 不访问旧 `152/155/39.104` 服务器。
- 不导入 provider 凭据。
- 不启动临时产品端口。
- 不把 RPC echo pass 冒充成 WebRTC 默认 transport promotion；TURN relay gate 仍必须通过。

## Code Changed

```text
scripts/fabric-real-webrtc-datachannel-smoke.js
scripts/fabric-m6-promotion-gate.js
test/fabric-real-webrtc-datachannel-smoke.test.js
test/fabric-m6-promotion-gate.test.js
```

设计边界：

- `fabric-real-webrtc-datachannel-smoke.js` 继续负责真实浏览器、真实 signaling 和真实 DataChannel。
- RPC adapter probe 复用同一个 DataChannel，发送 `rpc_request` / `rpc_response` JSON frame，method 为 `fabric.webrtc.echo`。
- M6 promotion gate 只消费 `report.rpc.ok`，不改变默认 transport selector。
- WebRTC 只有在 DataChannel、RPC adapter 和 TURN relay gate 全部通过时才可能 `promotionReady=true`。

## Real AWS Gate

Command:

```bash
DIAG_DIR="/tmp/aih-m6-webrtc-rpc-gate-6I9GSd"
node scripts/fabric-m6-promotion-gate.js \
  --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 \
  --ssh ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com \
  --ssh-key "$HOME/.ssh/aws.pem" \
  --diagnostics-dir "$DIAG_DIR" \
  --diagnostics-file "$DIAG_DIR/aggregate.json" \
  --json
```

Diagnostics written:

```text
/tmp/aih-m6-webrtc-rpc-gate-6I9GSd/aggregate.json
/tmp/aih-m6-webrtc-rpc-gate-6I9GSd/relay.json
/tmp/aih-m6-webrtc-rpc-gate-6I9GSd/webrtc-direct.json
/tmp/aih-m6-webrtc-rpc-gate-6I9GSd/webtransport.json
/tmp/aih-m6-webrtc-rpc-gate-6I9GSd/multipath.json
```

WebRTC result:

```json
{
  "ran": true,
  "candidateReady": true,
  "promotionReady": false,
  "mode": "webrtc-datachannel-smoke",
  "rtt": {
    "count": 5,
    "avg": 342.12,
    "p50": 311,
    "p95": 538.8,
    "min": 207.6,
    "max": 538.8
  },
  "rpc": {
    "adapter": "datachannel-json-rpc-echo",
    "sampleCount": 3,
    "ok": true,
    "responses": 5,
    "requestsHandled": 5,
    "rtt": {
      "count": 5,
      "avg": 465.14,
      "p50": 414.3,
      "p95": 715.3,
      "min": 310.9,
      "max": 715.3
    }
  },
  "selectedCandidatePair": {
    "state": "succeeded",
    "nominated": true,
    "localCandidateType": "srflx",
    "remoteCandidateType": "srflx"
  },
  "blockers": [
    "turn_relay_gate_not_ready"
  ]
}
```

Aggregate summary:

```json
{
  "promotionReady": false,
  "promotedTransports": [],
  "defaultTransport": "relay",
  "fallbackRequired": true,
  "fallbackReady": true,
  "blockers": [
    "webrtc:turn_relay_gate_not_ready",
    "turn:turn_ice_server_not_configured",
    "webtransport:webtransport_connect_failed",
    "multipath:local_mptcp_unavailable",
    "multipath:openmptcprouter_not_detected",
    "multipath:default_listener_is_plain_http_not_multipath_transport"
  ]
}
```

## Tests

```text
node --check scripts/fabric-real-webrtc-datachannel-smoke.js
pass

node --check scripts/fabric-m6-promotion-gate.js
pass

node --test test/fabric-real-webrtc-datachannel-smoke.test.js test/fabric-m6-promotion-gate.test.js
tests 19
pass 19
fail 0

node --test test/fabric-real-webrtc-datachannel-smoke.test.js test/fabric-m6-promotion-gate.test.js test/fabric-real-webtransport-smoke.test.js test/fabric-multipath-diagnosis.test.js test/fabric-transport-echo.test.js test/repository-policy.test.js
tests 37
pass 37
fail 0

npm test
tests 2640
pass 2640
fail 0
```

## Verdict

WebRTC DataChannel RPC adapter readiness is now proven against AWS current default `9527`.

Current WebRTC blockers:

```text
turn_relay_gate_not_ready
```

This means the software-side `remote_rpc_webrtc_adapter` gap is closed for the M6 gate, but WebRTC still cannot become the default transport until controlled TURN relay promotion is proven.

## Post-Deploy AWS Verification

Scoped runtime change deployed:

```text
feat(fabric): Prove WebRTC RPC adapter gate
```

Deployment result:

```text
web:build pass
source artifact sha256=74a4a65621cec054ed5afdd6799dfaade6d6d020c9a733159cdb5e5dd99fb237
source artifact bytes=5151128
remote server pid=243661
listen=http://0.0.0.0:9527
provider accounts codex=0 gemini=0 claude=0 agy=0 opencode=0
```

Post-deploy preflight:

```json
{
  "ok": true,
  "server": {
    "readyzHttp": 200,
    "processCount": 1,
    "processes": [
      "243661 node bin/ai-home.js server serve --host 0.0.0.0 --port 9527"
    ]
  },
  "serviceStatus": {
    "supervisorReady": true,
    "relay": {
      "state": "running",
      "running": true
    },
    "registryAgent": {
      "state": "running",
      "running": true
    },
    "issues": []
  },
  "registry": {
    "ok": true,
    "counts": {
      "nodes": 2,
      "relayNodes": 2,
      "projects": 2,
      "runtimes": 4,
      "transports": 2,
      "nodeInventory": 2
    },
    "targetNode": {
      "id": "aws-current-node",
      "present": true,
      "runtimeHost": false,
      "runtimeGaps": [
        "codex:missing_provider_runtime:codex",
        "claude:missing_provider_runtime:claude",
        "agy:missing_provider_runtime:agy",
        "opencode:missing_provider_runtime:opencode"
      ]
    }
  },
  "residue": [],
  "remainingGate": []
}
```

Remote deployed script help includes the RPC gate option:

```text
--rpc-sample-count <n>    WebRTC DataChannel RPC echo samples, default 3.
```

Post-deploy aggregate diagnostics:

```text
/tmp/aih-m6-webrtc-rpc-after-deploy-423d6ea-ABlXH8/aggregate.json
/tmp/aih-m6-webrtc-rpc-after-deploy-423d6ea-ABlXH8/relay.json
/tmp/aih-m6-webrtc-rpc-after-deploy-423d6ea-ABlXH8/webrtc-direct.json
/tmp/aih-m6-webrtc-rpc-after-deploy-423d6ea-ABlXH8/webtransport.json
/tmp/aih-m6-webrtc-rpc-after-deploy-423d6ea-ABlXH8/multipath.json
```

Post-deploy signal details:

```text
Relay candidateReady=true promotionReady=true successes=20/20 p95=106ms
WebRTC candidateReady=true promotionReady=false datachannelP95=632.3ms rpc.ok=true rpcResponses=5 rpcRequestsHandled=5 rpcP95=725.3ms
TURN ran=false blocker=turn_ice_server_not_configured
WebTransport candidateReady=false blocker=webtransport_connect_failed
Multipath candidateReady=true promotionReady=false remote.listener9527=node pid=243661
Summary defaultTransport=relay fallbackReady=true blockers=webrtc:turn_relay_gate_not_ready,turn:turn_ice_server_not_configured,webtransport:webtransport_connect_failed,multipath:local_mptcp_unavailable,multipath:openmptcprouter_not_detected,multipath:default_listener_is_plain_http_not_multipath_transport
```
