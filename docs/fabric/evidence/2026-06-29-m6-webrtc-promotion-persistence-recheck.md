# 2026-06-29 M6 WebRTC promotion persistence recheck

## Scope

Close the gap where direct WebRTC promotion passed the real gate but did not
persist into the Fabric registry/readiness path.

This step does not promote TURN, WebTransport, MPTCP, or OpenMPTCPRouter. Those
remain separate candidate paths with their own prerequisites.

## Code paths

- `scripts/fabric-m6-promotion-gate.js`
- `lib/cli/commands/fabric-router.js`
- `test/fabric-m6-promotion-gate.test.js`

## Implementation

`aih fabric transport promotion-gate` now supports:

- `--publish-promotion`
- `--node-id <id>`
- `--promotion-ttl-ms <n>`
- `--promotion-evidence-ref <path>`

When the real WebRTC gate passes, the command publishes an expiring WebRTC
promotion through SSH by asking the remote node to run its own
`fabric registry agent --once` with the node token-file. The token is not read
locally and is not passed as an argv `--token`.

Default promotion TTL is 24 hours. After expiry, readiness falls back to relay
until a fresh real promotion gate republishes current evidence.

## Real AWS publish

Command:

```bash
node bin/ai-home.js fabric transport promotion-gate \
  --endpoint "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527" \
  --allow-direct-webrtc-promotion \
  --skip-webtransport \
  --skip-multipath \
  --publish-promotion \
  --node-id "aws-current-node" \
  --promotion-evidence-ref "docs/fabric/evidence/2026-06-29-m6-webrtc-promotion-persistence-recheck.md" \
  --json
```

Result:

- process status: `0`
- report: `ok=true`, `exitOk=true`
- relay fallback: `20/20` echo, p95 `105ms`
- WebRTC DataChannel: `candidateReady=true`, `promotionReady=true`
- direct evidence: selected pair stats unavailable, candidate kind evidence
  verified on both peers
- DataChannel RTT: `5` samples, p95 `642.6ms`
- DataChannel RPC: `3/3` responses, `3` handled, p95 `298.2ms`
- `summary.defaultTransport=webrtc`
- `summary.promotionPublished=true`
- publish result: `attempts=1`, `failures=0`
- registry counts after publish: `nodes=2`, `relayNodes=2`,
  `transports=3`, `projects=2`, `runtimes=8`

Published promotion:

```json
{
  "remoteRequestReady": true,
  "mode": "direct",
  "evidenceRef": "docs/fabric/evidence/2026-06-29-m6-webrtc-promotion-persistence-recheck.md",
  "rttP95Ms": 642.6,
  "rpcP95Ms": 298.2,
  "promotedAt": 1782700917270,
  "expiresAt": 1782787317270
}
```

Promotion window:

- promoted at: `2026-06-29T02:41:57.270Z`
- expires at: `2026-06-30T02:41:57.270Z`

## Persistence recheck

After multiple registry-agent heartbeat cycles, AWS registry still had
promotion metadata:

- `aws-current-node-webrtc.health=online`
- `lastSeenAt=1782701240403` (`2026-06-29T02:47:20.403Z`)
- `promotion.remoteRequestReady=true`
- `promotion.expiresAt=1782787317270`

Local client readiness against AWS current:

```bash
node bin/ai-home.js fabric transport readiness \
  --endpoint "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527" \
  --node-id "aws-current-node" \
  --json
```

Result:

- unauthenticated readiness: HTTP `401`
- authorized readiness: HTTP `200`
- `defaultTransport=webrtc`
- `promotionReady=true`
- `promotedTransports=["webrtc"]`
- `fallbackReady=true`
- `relayMeasurementPass=true`

Local client transport status:

```bash
node bin/ai-home.js fabric transport status \
  --endpoint "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527" \
  --node-id "aws-current-node" \
  --skip-cloud-edge \
  --json
```

Result:

- `summary.status=complete`
- `remoteDevelopmentReady=true`
- `defaultTransport=webrtc`
- `advancedPromotionReady=true`
- `promotedTransports=["webrtc"]`
- `fallbackReady=true`

WebUI node test:

- route: `POST /v0/webui/nodes/aws-current-node/test`
- HTTP status: `200`
- selected transport: `aws-current-node-webrtc`
- selected kind: `webrtc`
- `fallbackUsed=false`
- `rejectedTransports=[]`

## AWS deployment checks

Updated files were synced to:

```text
/home/ubuntu/aih-fabric-current
```

Remote checks:

```bash
node --check scripts/fabric-m6-promotion-gate.js
node --test test/fabric-m6-promotion-gate.test.js
```

Result:

- `node --check`: pass
- focused remote tests: `23/23` pass

Remote `fabric transport readiness` was not used as evidence because the AWS
host itself does not have a local paired server profile. The supported product
path is local client profile -> AWS server profile, which passed above.

## Local verification

```bash
node --check scripts/fabric-m6-promotion-gate.js
node --check lib/cli/commands/fabric-router.js
node --test \
  test/fabric-m6-promotion-gate.test.js \
  test/fabric-transport-promotion-gate.test.js \
  test/fabric-transport-status.test.js \
  test/fabric-registry-agent.test.js \
  test/fabric-transport-readiness.test.js \
  test/webrtc-management-adapter.test.js
npm test
```

Result:

- focused local tests: `51/51` pass
- full local suite: `2791/2791` pass

## Verdict

Direct WebRTC promotion is now a real, persisted, expiring registry capability
for `aws-current-node`. Local WebUI/node management requests now select the
WebRTC management path while relay remains available as fallback.

Remaining M6 work is unchanged:

- controlled TURN relay credentials and UDP path
- HTTPS/H3 WebTransport endpoint
- real OpenMPTCPRouter/MPTCP underlay
