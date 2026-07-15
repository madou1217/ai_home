# M6 WebRTC RPC Adapter Evidence

Date: 2026-06-29

Scope:
- Control plane and node: `aws-current-node` on AWS current.
- Server: `/home/ubuntu/aih-fabric-current`, default port `9527`.
- Transport under test: real WebRTC DataChannel via `werift`, not WebSocket wrapping and not mock data.

## Deployment

AWS process state after deployment:

```text
fabric registry agent ... http://127.0.0.1:9527 --node-id aws-current-node ...
server serve --host 0.0.0.0 --port 9527
node relay connect http://127.0.0.1:9527 --node-id aws-current-node
node webrtc connect http://127.0.0.1:9527 --node-id aws-current-node
```

No `9528` server was running.

`/readyz` returned `200`.

Clean source sync:

```text
HEAD: 0b0a57b feat(fabric): route management rpc over webrtc
source artifact sha256: 644585c95f4839ecc50cfdf26475c5bfd92b120f7c7362d99f07710d8e23e675
remote server pid after HEAD sync: 313695
```

Post-readiness-fix source sync:

```text
source artifact sha256: 76a7488ee1d34c09dec9facf29a4420733583ed71b34b8c199b60e2217fc205f
remote server pid after readiness fix: 315609
relay service pid: 315694
registry agent pid: 315696
webrtc connector pid: 315712
```

Committed clean source sync:

```text
HEAD: 7ab862e fix(fabric): keep relay fallback ready with webrtc default
source artifact: /tmp/aih-fabric-7ab862e.tar.gz
source artifact sha256: 4fe98f6b7663b6b8e99b50eafb0764fe851c24a857e27da4f472646d6a72dcf8
remote artifact: /home/ubuntu/aih-fabric-current/source-7ab862e.tar.gz
remote server pid after restart: 317768
relay process pid after restart: 317794
registry agent pid after restart: 315696
webrtc connector pid after restart: 319046
```

The first post-restart readiness check returned `defaultTransport=relay`
because the WebRTC connector process still held the old DataChannel session.
Restarting only `node webrtc connect http://127.0.0.1:9527 --node-id
aws-current-node` rebuilt the real WebRTC management session and restored the
runtime selector result below.

## Real WebRTC Request

Request path:

```text
POST http://127.0.0.1:9527/v0/webui/nodes/aws-current-node/test
```

Observed result:

```json
{
  "ok": true,
  "kind": "webrtc",
  "decision": {
    "transportPurpose": "status",
    "selectedTransportId": "aws-current-node-webrtc",
    "selectedTransportKind": "webrtc",
    "fallbackUsed": false,
    "fallbackFrom": [],
    "rejectedTransports": []
  },
  "status": 200
}
```

Remote audit tail included:

```json
{
  "rpc": "node.status.read",
  "transportKind": "webrtc",
  "ok": true,
  "status": 200,
  "error": "",
  "durationMs": 41
}
```

## Readiness

After the WebRTC connector was online:

```json
{
  "summary": {
    "defaultTransport": "webrtc",
    "promotionReady": true,
    "promotedTransports": ["webrtc"]
  },
  "decision": {
    "selectedTransportId": "aws-current-node-webrtc",
    "selectedKind": "webrtc",
    "fallbackUsed": false,
    "fallbackFrom": [],
    "rejected": []
  },
  "webrtc": {
    "candidateReady": true,
    "promotionReady": true,
    "blockers": []
  }
}
```

The post-deploy readiness recheck found and fixed one product-state bug:
`fallbackReady` previously meant "the selected transport is relay". After
WebRTC became the selected transport, this incorrectly hid the still-healthy
relay fallback. The readiness report now evaluates relay fallback independently
from the selected default transport.

Final client readiness after the fix:

```json
{
  "ok": true,
  "checks": {
    "fallbackReady": true,
    "relayMeasurementPass": true
  },
  "summary": {
    "defaultTransport": "webrtc",
    "fallbackReady": true,
    "promotionReady": true,
    "promotedTransports": ["webrtc"]
  },
  "node": {
    "nodeId": "aws-current-node",
    "defaultTransport": "webrtc",
    "fallbackReady": true,
    "relayMeasurementPass": true,
    "relayRttMs": {
      "p95": 4,
      "count": 20
    }
  },
  "blockers": []
}
```

Final client readiness after committed clean source sync and connector restart:

```json
{
  "ok": true,
  "summary": {
    "defaultTransport": "webrtc",
    "fallbackReady": true,
    "promotionReady": true,
    "promotedTransports": ["webrtc"]
  },
  "node": {
    "nodeId": "aws-current-node",
    "defaultTransport": "webrtc",
    "fallbackReady": true,
    "relayMeasurementPass": true,
    "relayRttMs": {
      "p95": 1,
      "count": 20
    }
  },
  "blockers": []
}
```

Final aggregate status:

```json
{
  "ok": true,
  "summary": {
    "status": "complete",
    "remoteDevelopmentReady": true,
    "defaultTransport": "webrtc",
    "fallbackReady": true,
    "relayMeasurementPass": true,
    "advancedPromotionReady": true,
    "promotedTransports": ["webrtc"],
    "cloudEdgeReady": false
  }
}
```

Final aggregate status after committed clean source sync and connector restart:

```json
{
  "ok": true,
  "summary": {
    "status": "complete",
    "remoteDevelopmentReady": true,
    "defaultTransport": "webrtc",
    "fallbackReady": true,
    "relayMeasurementPass": true,
    "advancedPromotionReady": true,
    "promotedTransports": ["webrtc"],
    "cloudEdgeReady": false
  }
}
```

## Registry Stability

After waiting longer than one registry-agent heartbeat, remote registry retained the active WebRTC runtime state:

```json
{
  "id": "aws-current-node-webrtc",
  "kind": "webrtc",
  "endpoint": "http://127.0.0.1:9527",
  "status": "up",
  "score": 88,
  "lastError": "",
  "trustLevel": "managed",
  "promotion": {
    "remoteRequestReady": true,
    "mode": "direct"
  }
}
```

Final daemon preflight from the local machine:

```json
{
  "ok": true,
  "server": {
    "readyzHttp": 200,
    "processCount": 1
  },
  "serviceStatus": {
    "supervisorReady": true,
    "relay": { "state": "running", "running": true },
    "registryAgent": { "state": "running", "running": true }
  },
  "registry": {
    "http": 200,
    "counts": {
      "nodes": 2,
      "relayNodes": 2,
      "projects": 2,
      "runtimes": 4,
      "transports": 3,
      "nodeInventory": 2
    }
  },
  "residue": [],
  "remainingGate": []
}
```

Final daemon preflight after committed clean source sync:

```json
{
  "ok": true,
  "server": {
    "readyzHttp": 200,
    "processCount": 1,
    "processes": [
      "317768 node bin/ai-home.js server serve --host 0.0.0.0 --port 9527"
    ]
  },
  "serviceStatus": {
    "supervisorReady": true,
    "relay": { "state": "running", "running": true },
    "registryAgent": { "state": "running", "running": true }
  },
  "registry": {
    "http": 200,
    "counts": {
      "nodes": 2,
      "relayNodes": 2,
      "projects": 2,
      "runtimes": 4,
      "transports": 3,
      "nodeInventory": 2
    }
  },
  "residue": [],
  "remainingGate": []
}
```

## Tests

Local:

```text
node --test test/webrtc-management-adapter.test.js
node --test test/server-node-rpc-wiring.test.js
node --test test/web-ui-router.remote-nodes.test.js
node --test test/fabric-transport-readiness.test.js test/fabric-real-transport-readiness-client-smoke.test.js test/fabric-transport-status.test.js test/webrtc-management-adapter.test.js test/server-node-rpc-wiring.test.js test/web-ui-router.remote-nodes.test.js
npm test
```

AWS:

```text
node --test test/webrtc-management-adapter.test.js
node --test test/fabric-transport-readiness.test.js test/fabric-real-transport-readiness-client-smoke.test.js test/fabric-transport-status.test.js test/webrtc-management-adapter.test.js test/server-node-rpc-wiring.test.js test/web-ui-router.remote-nodes.test.js
```

All commands passed. Local focused readiness/WebRTC suite: 51/51 pass. AWS
focused readiness/WebRTC suite: 51/51 pass. Local full suite result: 2752 pass,
0 fail.

Post-commit deployment verification:

```text
AWS clean artifact sha256: 4fe98f6b7663b6b8e99b50eafb0764fe851c24a857e27da4f472646d6a72dcf8
AWS node --check lib/server/fabric-transport-readiness.js: pass
AWS focused readiness/WebRTC suite after clean artifact sync: 51/51 pass
Local focused readiness/WebRTC suite after commit: 51/51 pass
Local daemon preflight after AWS restart: ok=true, remainingGate=[]
```
