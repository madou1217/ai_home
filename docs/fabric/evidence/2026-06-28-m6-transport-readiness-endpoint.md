# M6 Transport Readiness Endpoint

Date: 2026-06-28

## Objective

Expose transport readiness as a real server-side product endpoint, not only as local scripts and evidence files.

The endpoint answers:

- Which transport is currently selected for a node.
- Whether relay fallback is available.
- Whether the selected relay has a real measurement.
- Which advanced transport gates are still blocking promotion.

It is read-only. It does not run browser probes, import provider credentials, open new ports, or mutate registry state.

## Endpoint

```text
GET /v0/fabric/transport/readiness?nodeId=<optional>&purpose=runtime
Authorization: Bearer <device token with nodes:read>
```

Response RPC:

```text
fabric.transport.readiness
```

The broker allowlist also permits this GET path, so a paired client can read the same readiness through an outbound broker profile.

## Implementation

- `lib/server/fabric-transport-readiness.js`
  - Builds a report from the existing Fabric registry.
  - Reuses transport selector semantics.
  - Maps Fabric transport health into selector status.
  - Reports relay fallback and advanced transport blockers separately.
- `lib/server/fabric-router.js`
  - Adds authenticated `GET /v0/fabric/transport/readiness`.
- `lib/server/fabric-broker-router.js`
  - Adds the read-only endpoint to the broker allowlist.

## Tests

Focused tests:

```bash
node --test test/fabric-transport-readiness.test.js
node --test test/server-node-rpc-wiring.test.js
node --test test/fabric-broker-routing.test.js
```

Result:

```text
fabric-transport-readiness: 2/2 pass
server-node-rpc-wiring: 10/10 pass
fabric-broker-routing: 8/8 pass
```

Full regression:

```bash
npm test
```

Result:

```text
tests 2656
pass 2656
fail 0
duration_ms 255641.851792
```

## Clean HEAD AWS Deployment

Command source:

```text
git archive HEAD
```

Deployment command:

```bash
node scripts/fabric-real-vps-deploy.js \
  --ssh ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com \
  --ssh-key "/Users/model/.ssh/aws.pem" \
  --remote-dir /home/ubuntu/aih-fabric-current \
  --node-runtime "/Users/model/projects/feature/ai_home/tmp/fabric-real-deploy/node-runtime/node-v22.16.0-linux-x64.tar.xz" \
  --skip-import \
  --skip-build \
  --broker-token-file /home/ubuntu/aih-fabric-current/.broker-token
```

Deployment result:

```text
source artifact: 783f0a692ad965b82690c6c021dd69567baa022a1055f87088635a1c4807a2a5
server pid: 252371
accounts: codex=0, gemini=0, claude=0, agy=0, opencode=0
```

Post-deploy preflight:

```json
{
  "ok": true,
  "processCount": 1,
  "supervisorReady": true,
  "registryCounts": {
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
  },
  "residue": [],
  "remainingGate": []
}
```

## Real AWS Verification

Unauthenticated request:

```bash
curl -s -o /tmp/aih-readiness-unauth.json -w "%{http_code}\n" \
  "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527/v0/fabric/transport/readiness?purpose=runtime"
```

Result:

```text
401
```

Authorized AWS current read, all nodes:

```json
{
  "http": 200,
  "ok": true,
  "rpc": "fabric.transport.readiness",
  "summary": {
    "nodes": 2,
    "defaultTransports": [
      "relay"
    ],
    "defaultTransport": "relay",
    "fallbackReady": true,
    "promotionReady": false,
    "promotedTransports": [],
    "blockers": [
      "webrtc:webrtc_transport_candidate_not_registered",
      "webrtc:turn_relay_gate_not_ready",
      "webtransport:webtransport_endpoint_not_configured",
      "webtransport:webtransport_not_promoted",
      "omr:openmptcprouter_not_detected",
      "mptcp:mptcp_data_plane_not_promoted"
    ]
  }
}
```

Authorized AWS current read, filtered to `aws-current-node`:

```json
{
  "http": 200,
  "ok": true,
  "nodes": 1,
  "defaultTransport": "relay",
  "fallbackReady": true,
  "promotionReady": false,
  "nodeId": "aws-current-node",
  "relayMeasurementPass": true,
  "relayRtt": {
    "min": 0,
    "p50": 0,
    "p95": 1,
    "max": 1,
    "avg": 0,
    "count": 20
  },
  "blockers": [
    "webrtc:webrtc_transport_candidate_not_registered",
    "webrtc:turn_relay_gate_not_ready",
    "webtransport:webtransport_endpoint_not_configured",
    "webtransport:webtransport_not_promoted",
    "omr:openmptcprouter_not_detected",
    "mptcp:mptcp_data_plane_not_promoted"
  ]
}
```

## Conclusion

M6 readiness is now observable from the AWS server itself:

- The new endpoint is protected by `nodes:read`.
- AWS current default transport is `relay`.
- AWS relay fallback is ready and has a passing real measurement.
- Advanced transport promotion remains false and has explicit blockers.
- AWS current still is not a provider runtime host because provider accounts were intentionally not imported.
