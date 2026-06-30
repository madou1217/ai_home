# 2026-06-28 M6 Transport Promotion Gate

## Scope

本证据记录 M6 Transport Promotion 的聚合 gate。目标不是把任何 transport 强行设为默认，而是用同一条真实命令同时验证：

- WebRTC DataChannel candidate 是否当前可用。
- TURN relay 是否具备默认晋级条件。
- WebTransport/QUIC 是否具备 HTTPS/H3/WebTransport endpoint。
- Multipath/MPTCP/OpenMPTCPRouter underlay 是否具备默认晋级条件。

约束：

- 只使用 AWS current：`ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com`。
- 只使用默认端口 `9527`。
- 不访问旧 `152/155/39.104` 服务器。
- 不导入 provider 凭据。
- 不启动临时产品端口。
- 不把单项 smoke success 冒充为默认 transport promotion。

## Code Added

新增：

```text
scripts/fabric-m6-promotion-gate.js
test/fabric-m6-promotion-gate.test.js
```

设计边界：

- 聚合器只负责调度和归一化 promotion decision。
- 底层真实探测继续复用已有脚本：
  - `lib/cli/services/fabric/transport-echo.js`
  - `scripts/fabric-real-webrtc-datachannel-smoke.js`
  - `scripts/fabric-real-webtransport-smoke.js`
  - `scripts/fabric-multipath-diagnosis.js`
- Relay fallback baseline 必须先通过真实 WS echo；否则 `defaultTransport` 不能假定为 `relay`。
- TURN 不默认使用公共服务；没有受控 TURN 配置时明确输出 `turn_ice_server_not_configured`。
- WebRTC DataChannel smoke 通过只代表 `candidateReady=true`，不会自动标记 `promotionReady=true`。

## Command

```bash
DIAG_DIR="/tmp/aih-m6-promotion-gate-20260628183031"
mkdir -p "$DIAG_DIR"
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
/tmp/aih-m6-promotion-gate-20260628183031/aggregate.json
/tmp/aih-m6-promotion-gate-20260628183031/webrtc-direct.json
/tmp/aih-m6-promotion-gate-20260628183031/webtransport.json
/tmp/aih-m6-promotion-gate-20260628183031/multipath.json
```

## Result

Sanitized aggregate summary:

```json
{
  "ok": true,
  "target": {
    "endpoint": "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527",
    "ssh": "ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com"
  },
  "summary": {
    "promotionReady": false,
    "promotedTransports": [],
    "defaultTransport": "relay",
    "fallbackRequired": true,
    "fallbackReady": true,
    "blockers": [
      "webrtc:turn_relay_gate_not_ready",
      "webrtc:remote_rpc_webrtc_adapter_not_enabled",
      "turn:turn_ice_server_not_configured",
      "webtransport:webtransport_connect_failed",
      "multipath:local_mptcp_unavailable",
      "multipath:openmptcprouter_not_detected",
      "multipath:default_listener_is_plain_http_not_multipath_transport"
    ]
  }
}
```

### Relay Fallback Baseline

After the hardening pass, the same M6 aggregate gate runs a real WebSocket echo baseline before selecting relay as fallback.

Command:

```bash
DIAG_DIR="/tmp/aih-m6-relay-baseline-gate-20260628190002"
mkdir -p "$DIAG_DIR"
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
/tmp/aih-m6-relay-baseline-gate-20260628190002/aggregate.json
/tmp/aih-m6-relay-baseline-gate-20260628190002/relay.json
/tmp/aih-m6-relay-baseline-gate-20260628190002/webrtc-direct.json
/tmp/aih-m6-relay-baseline-gate-20260628190002/webtransport.json
/tmp/aih-m6-relay-baseline-gate-20260628190002/multipath.json
```

Relay result:

```json
{
  "ran": true,
  "candidateReady": true,
  "promotionReady": true,
  "target": "ws://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527/v0/fabric/transport/echo",
  "count": 20,
  "successes": 20,
  "payloadSize": 64,
  "rtt": {
    "count": 20,
    "min": 107,
    "max": 111,
    "avg": 108.9,
    "p50": 109,
    "p95": 110
  },
  "failures": [],
  "blockers": []
}
```

Aggregate summary with relay baseline:

```json
{
  "promotionReady": false,
  "promotedTransports": [],
  "defaultTransport": "relay",
  "fallbackRequired": true,
  "fallbackReady": true,
  "blockers": [
    "webrtc:turn_relay_gate_not_ready",
    "webrtc:remote_rpc_webrtc_adapter_not_enabled",
    "turn:turn_ice_server_not_configured",
    "webtransport:webtransport_connect_failed",
    "multipath:local_mptcp_unavailable",
    "multipath:openmptcprouter_not_detected",
    "multipath:default_listener_is_plain_http_not_multipath_transport"
  ]
}
```

Interpretation:

- Relay fallback is no longer assumed; it is proven by the same gate before `defaultTransport=relay` is emitted.
- Advanced transport promotion is still blocked, so `promotionReady=false` remains correct.
- Post-deploy AWS listener is recorded below; it remains the plain AIH HTTP server on default `9527`.

### WebRTC DataChannel

```json
{
  "ran": true,
  "candidateReady": true,
  "promotionReady": false,
  "rtt": {
    "count": 5,
    "avg": 214.48,
    "p50": 217.1,
    "p95": 219.3,
    "min": 206.2,
    "max": 219.3
  },
  "selectedCandidatePair": {
    "state": "succeeded",
    "nominated": true,
    "localCandidateType": "srflx",
    "remoteCandidateType": "srflx",
    "currentRoundTripTime": 0.354
  },
  "blockers": [
    "turn_relay_gate_not_ready",
    "remote_rpc_webrtc_adapter_not_enabled"
  ]
}
```

Interpretation:

- WebRTC DataChannel 当前真实可用，是 transport candidate。
- 仍不能作为默认 remote RPC transport，因为没有通过 TURN relay gate，也没有启用 remote RPC WebRTC adapter。

### TURN Relay

```json
{
  "ran": false,
  "candidateReady": false,
  "promotionReady": false,
  "blockers": [
    "turn_ice_server_not_configured"
  ]
}
```

Interpretation:

- 当前没有受控 TURN `iceServers` 和凭据。
- 本轮不使用公共 TURN 冒充受控 TURN。
- TURN gate 不通过。

### WebTransport

```json
{
  "ran": true,
  "candidateReady": false,
  "promotionReady": false,
  "webTransportUrl": "https://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527/v0/fabric/webtransport/echo",
  "failureReason": "webtransport_connect_failed",
  "blockers": [
    "webtransport_connect_failed"
  ]
}
```

Interpretation:

- 浏览器 secure context 下尝试真实 WebTransport handshake。
- AWS default `9527` 仍不是 HTTPS/H3/WebTransport endpoint。
- WebTransport gate 不通过。

### Multipath/MPTCP/OpenMPTCPRouter

```json
{
  "ran": true,
  "candidateReady": true,
  "promotionReady": false,
  "verdict": "diagnostic_pass_promotion_blocked",
  "blockers": [
    "local_mptcp_unavailable",
    "openmptcprouter_not_detected",
    "default_listener_is_plain_http_not_multipath_transport"
  ],
  "local": {
    "platform": "Darwin",
    "arch": "arm64",
    "kernelMptcp": false,
    "pythonMptcpSocket": false
  },
  "remote": {
    "platform": "Linux",
    "arch": "x86_64",
    "kernelMptcp": true,
    "pythonMptcpSocket": true,
    "listener9527": "node pid=237041"
  },
  "openMptcpRouterDetected": false
}
```

Interpretation:

- AWS Linux 侧具备 MPTCP capability。
- 本机 macOS 当前没有通用 MPTCP socket。
- 未检测到 OpenMPTCPRouter。
- 默认 `9527` listener 是 AIH Node HTTP server，不是 multipath transport gateway。
- Multipath gate 不通过。

## Tests

```text
node --check scripts/fabric-m6-promotion-gate.js
pass

node --test test/fabric-m6-promotion-gate.test.js
tests 8
pass 8
fail 0

node --test test/fabric-real-webrtc-datachannel-smoke.test.js test/fabric-real-webtransport-smoke.test.js test/fabric-multipath-diagnosis.test.js
tests 18
pass 18
fail 0

node --test test/fabric-m6-promotion-gate.test.js test/fabric-transport-echo.test.js test/repository-policy.test.js
tests 18
pass 18
fail 0

npm test
tests 2639
pass 2639
fail 0
```

## Post-Commit AWS Deployment Verification

Scoped change:

```text
fix(fabric): Prove relay fallback in M6 gate
```

Deployment command used a clean git archive source tree for the scoped runtime change, built WebUI locally, and deployed only to AWS current default `9527` with `--skip-import`.

Deployment result:

```text
web:build pass
source artifact sha256=f6f60bdd4cd38020962977d9512788b0cb215674a7979e3d4900247ff295c090
source artifact bytes=5148139
remote server pid=242090
listen=http://0.0.0.0:9527
provider accounts codex=0 gemini=0 claude=0 agy=0 opencode=0
```

AWS `/readyz` after deployment:

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

Daemon preflight after deployment:

```json
{
  "ok": true,
  "verdict": "ready_for_confirmed_7_3_execution",
  "server": {
    "readyzHttp": 200,
    "processCount": 1,
    "processes": [
      "242090 node bin/ai-home.js server serve --host 0.0.0.0 --port 9527"
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
      "runtimeGaps": [
        "codex:missing_provider_runtime:codex",
        "claude:missing_provider_runtime:claude",
        "agy:missing_provider_runtime:agy",
        "opencode:missing_provider_runtime:opencode"
      ]
    }
  },
  "supervisedProcesses": [
    "140408 node /home/ubuntu/aih-fabric-current/bin/ai-home.js fabric registry agent http://127.0.0.1:9527 --node-id aws-current-node ...",
    "242118 node /home/ubuntu/aih-fabric-current/bin/ai-home.js node relay connect http://127.0.0.1:9527 --node-id aws-current-node"
  ],
  "residue": [],
  "remainingGate": []
}
```

Remote deployed script exists and prints the expected help:

```text
ssh -i ~/.ssh/aws.pem ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com \
  'test -f /home/ubuntu/aih-fabric-current/scripts/fabric-m6-promotion-gate.js && \
  /home/ubuntu/aih-fabric-current/.node-runtime/node-v22.16.0-linux-x64/bin/node \
  /home/ubuntu/aih-fabric-current/scripts/fabric-m6-promotion-gate.js --help'

AIH Fabric M6 transport promotion gate
--relay-count <n>
--relay-payload-size <n>
--skip-relay
```

Post-deploy aggregate gate diagnostics:

```text
/tmp/aih-m6-relay-baseline-after-deploy-1c81670-EpqzkT/aggregate.json
/tmp/aih-m6-relay-baseline-after-deploy-1c81670-EpqzkT/relay.json
/tmp/aih-m6-relay-baseline-after-deploy-1c81670-EpqzkT/webrtc-direct.json
/tmp/aih-m6-relay-baseline-after-deploy-1c81670-EpqzkT/webtransport.json
/tmp/aih-m6-relay-baseline-after-deploy-1c81670-EpqzkT/multipath.json
```

Post-deploy aggregate result:

```json
{
  "ok": true,
  "summary": {
    "promotionReady": false,
    "promotedTransports": [],
    "defaultTransport": "relay",
    "fallbackRequired": true,
    "fallbackReady": true,
    "blockers": [
      "webrtc:turn_relay_gate_not_ready",
      "webrtc:remote_rpc_webrtc_adapter_not_enabled",
      "turn:turn_ice_server_not_configured",
      "webtransport:webtransport_connect_failed",
      "multipath:local_mptcp_unavailable",
      "multipath:openmptcprouter_not_detected",
      "multipath:default_listener_is_plain_http_not_multipath_transport"
    ]
  }
}
```

Post-deploy signal details:

```text
Relay candidateReady=true promotionReady=true successes=20/20 p95=114ms
WebRTC candidateReady=true promotionReady=false p95=229.3ms selectedPair=srflx->srflx
TURN ran=false blocker=turn_ice_server_not_configured
WebTransport candidateReady=false blocker=webtransport_connect_failed
Multipath candidateReady=true promotionReady=false remote.listener9527=node pid=242090
```

Final relay-only live check:

```text
/tmp/aih-m6-final-relay-live-65ab1c4-FukCZt/aggregate.json
relay successes=20/20 payload=64B p95=107ms failures=0
summary defaultTransport=relay fallbackReady=true blockers=[]
```

## Verdict

M6 promotion gate is now executable and traceable.

Update:

- `2026-06-28-m6-webrtc-rpc-adapter-gate.md` supersedes the older WebRTC adapter blocker in this evidence. The latest AWS current default `9527` gate proves `datachannel-json-rpc-echo` over the same RTCDataChannel, so current WebRTC promotion is blocked by `turn_relay_gate_not_ready`, not by missing RPC adapter readiness.

Current result:

```text
promotionReady=false
defaultTransport=relay
fallbackRequired=true
fallbackReady=true
```

This is the correct product state under the current constraints. WebRTC remains a measured candidate; WebTransport, TURN relay, and Multipath are not promoted.

## Next Checks

To move M6 from `partial` to a real promotion pass, at least one advanced transport must satisfy its own gate:

- WebRTC: provide controlled TURN credentials and implement/enable remote RPC over WebRTC DataChannel.
- WebTransport: provide a real HTTPS/H3/WebTransport endpoint on the approved product topology.
- Multipath: provide a real dual-side Linux/OpenMPTCPRouter underlay while preserving externally stable default `9527`.
