# 2026-06-29 M6 WebRTC selector capability

## Scope

Close the capability handoff after the direct WebRTC promotion gate:

- persist verified WebRTC promotion evidence on the Fabric transport record
- preserve that evidence across normal node heartbeat updates
- feed promotion state into readiness, selector, and gateway decisions
- keep normal remote RPC on relay until a real WebRTC management adapter exists

This is not a claim that ordinary remote requests are already routed over a
real WebRTC node-side RPC runtime.

## Code paths

- `lib/cli/services/fabric/registry-heartbeat.js`
- `lib/cli/services/fabric/registry-agent.js`
- `lib/cli/services/fabric/registry-agent-service.js`
- `lib/server/fabric-role-registry.js`
- `lib/server/fabric-transport-readiness.js`
- `lib/server/remote/transport-registry.js`
- `lib/server/remote/transport-selector.js`
- `lib/server/remote/remote-gateway.js`
- `lib/server/fabric-router.js`

## Local verification

```bash
node --check lib/cli/services/fabric/registry-heartbeat.js
node --check lib/cli/services/fabric/registry-agent.js
node --check lib/cli/services/fabric/registry-agent-service.js
node --check lib/server/fabric-role-registry.js
node --test \
  test/fabric-registry-heartbeat.test.js \
  test/fabric-registry-agent.test.js \
  test/fabric-role-registry.test.js \
  test/fabric-transport-readiness.test.js \
  test/remote-node-registry.test.js
```

Result: 52/52 pass.

## AWS current deployment

Target:

```text
ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com
/home/ubuntu/aih-fabric-current
```

Synced only the changed Fabric source and test files. The server was restarted
in place on the default port only:

```text
PID 306784
node .../bin/ai-home.js server serve --host 0.0.0.0 --port 9527
readyz 200
```

Focused AWS tests:

```bash
.node-runtime/node-v22.16.0-linux-x64/bin/node --test \
  test/fabric-registry-heartbeat.test.js \
  test/fabric-registry-agent.test.js \
  test/fabric-role-registry.test.js \
  test/fabric-transport-readiness.test.js \
  test/remote-node-registry.test.js
```

Result: 52/52 pass.

## Real AWS promotion persistence

The direct WebRTC gate evidence comes from
`docs/fabric/evidence/2026-06-29-m6-direct-webrtc-promotion.md`:

- selected candidate pair: `srflx -> srflx`
- DataChannel p95: `200.9ms`
- RPC p95: `200.5ms`
- `promotedTransports=["webrtc"]`

One real heartbeat was sent through the protected registry endpoint using the
existing AWS node token file, without printing token contents:

```bash
aih fabric registry agent http://127.0.0.1:9527 \
  --node-id aws-current-node \
  --token-file /home/ubuntu/aih-fabric-current/.aih-host-home/.ai_home/fabric/aws-current-node.token \
  --once \
  --status online \
  --relay-status online \
  --transport relay=online \
  --transport webrtc=online,promotion=ready,mode=direct,evidence-ref=docs/fabric/evidence/2026-06-29-m6-direct-webrtc-promotion.md,rtt-p95-ms=201,rpc-p95-ms=201,promoted-at=1782691200000 \
  --runtime-diagnostics \
  --json
```

Result:

- `ok=true`
- `attempts=1`
- `failures=0`
- `transports=2`
- `aws-current-node-webrtc.promotion.remoteRequestReady=true`
- `mode=direct`
- `evidenceRef=docs/fabric/evidence/2026-06-29-m6-direct-webrtc-promotion.md`
- `rttP95Ms=201`
- `rpcP95Ms=201`

## Real AWS readiness result

Read through `GET /v0/fabric/transport/readiness?nodeId=aws-current-node`
with the device bearer token.

Summary:

```json
{
  "defaultTransport": "relay",
  "promotionReady": false,
  "promotedTransports": [],
  "selectedKind": "relay",
  "fallbackUsed": true,
  "fallbackFrom": ["webrtc"],
  "blockers": [
    "webrtc:webrtc_adapter_not_available",
    "webtransport:webtransport_endpoint_not_configured",
    "webtransport:webtransport_not_promoted",
    "omr:openmptcprouter_not_detected",
    "mptcp:mptcp_data_plane_not_promoted"
  ]
}
```

WebRTC gate:

```json
{
  "candidateReady": true,
  "candidates": ["aws-current-node-webrtc"],
  "promotionReady": false,
  "blockers": ["webrtc_adapter_not_available"]
}
```

This is the expected boundary: the transport has verified promotion evidence,
but the gateway cannot select it for real remote RPC until a WebRTC management
adapter is implemented.

## Preservation check

A second real heartbeat without promotion fields was sent:

```bash
aih fabric registry agent http://127.0.0.1:9527 \
  --node-id aws-current-node \
  --token-file /home/ubuntu/aih-fabric-current/.aih-host-home/.ai_home/fabric/aws-current-node.token \
  --once \
  --status online \
  --relay-status online \
  --transport relay=online \
  --transport webrtc=online \
  --json
```

Registry check after that heartbeat:

```json
{
  "heartbeatOk": true,
  "webrtcPromotionPreserved": true,
  "promotion": {
    "remoteRequestReady": true,
    "mode": "direct",
    "evidenceRef": "docs/fabric/evidence/2026-06-29-m6-direct-webrtc-promotion.md",
    "rttP95Ms": 201,
    "rpcP95Ms": 201,
    "expiresAt": 0
  }
}
```

## Verdict

WebRTC promotion evidence now has a real, traceable path:

```text
promotion gate evidence -> node heartbeat -> Fabric registry transport ->
legacy remote transport mirror -> readiness/selector/gateway decision
```

The current runtime decision is deliberately conservative:

- registry records `webrtc` as promoted for remote-request capability evidence
- selector/readiness reject it for normal RPC with
  `webrtc_adapter_not_available`
- relay remains the default transport for live remote requests

Next closure requires a real WebRTC management adapter and node-side RPC path,
then a live AWS request/audit proving `transportKind=webrtc`.
