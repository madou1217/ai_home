# 2026-06-29 M6 direct WebRTC promotion

## Scope

Close the first real advanced transport promotion path without adding ports or
mocking transport state:

- keep WebRTC promotion explicitly opt-in with
  `--allow-direct-webrtc-promotion`
- require real DataChannel smoke, real JSON-RPC echo, RTT samples, and direct
  candidate evidence
- keep TURN/WebTransport/Multipath as separate non-promoted candidates when
  their prerequisites are still missing
- do not change the runtime remote request selector in this step

## Code paths

- `scripts/fabric-m6-promotion-gate.js`
- `lib/cli/services/fabric/transport-status.js`
- `test/fabric-m6-promotion-gate.test.js`
- `test/fabric-transport-status.test.js`

## Local verification

```bash
node --check scripts/fabric-m6-promotion-gate.js
node --check lib/cli/services/fabric/transport-status.js
node --test \
  test/fabric-m6-promotion-gate.test.js \
  test/fabric-transport-promotion-gate.test.js \
  test/fabric-transport-status.test.js
```

Result: 29/29 pass.

Full local suite:

```bash
npm test
```

Result: 2744/2744 pass.

## Real AWS promotion gate

Command:

```bash
node bin/ai-home.js fabric transport promotion-gate \
  --endpoint "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527" \
  --allow-direct-webrtc-promotion \
  --skip-webtransport \
  --skip-multipath \
  --json
```

Result:

- process status: `0`
- report: `ok=true`, `exitOk=true`
- relay fallback: `20/20` echo, p95 `109ms`
- WebRTC: `candidateReady=true`, `promotionReady=true`,
  `promotionMode=direct`
- selected candidate pair: `srflx -> srflx`
- direct evidence: `directPairVerified=true`,
  `directCandidateKindsVerified=true`, `directCandidateVerified=true`
- DataChannel RTT: `5` samples, p95 `200.9ms`
- RPC echo: `3/3` responses, `3` handled, p95 `200.5ms`
- summary: `promotionReady=true`, `promotedTransports=["webrtc"]`,
  `defaultTransport=webrtc`, `fallbackRequired=false`, `fallbackReady=true`,
  `blockers=[]`
- non-promoted candidate blockers:
  - `turn:turn_ice_server_not_configured`
  - `turn:turn_default_udp_9527_unreachable`

## Real AWS transport status

Command:

```bash
node bin/ai-home.js fabric transport status \
  --endpoint "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527" \
  --with-promotion-gate \
  --allow-direct-webrtc-promotion \
  --skip-webtransport \
  --skip-multipath \
  --json
```

Result:

- process status: `0`
- report: `ok=true`, `exitOk=true`
- `summary.status=complete`
- `remoteDevelopmentReady=true`
- `defaultTransport=webrtc`
- `fallbackReady=true`
- `relayMeasurementPass=true`
- `advancedPromotionReady=true`
- `promotedTransports=["webrtc"]`
- `blockers=[]`
- `nextActions=[]`
- cloud edge remains diagnostic-only in this path:
  `cloudEdgeReady=false`, `udpReachable=false`,
  `hostFirewallBlocksUdp=false`

## AWS current focused checks

Synced to:

```text
/home/ubuntu/aih-fabric-current/source-direct-webrtc-promotion.tar.gz
```

Remote focused checks:

```bash
node --check scripts/fabric-m6-promotion-gate.js
node --check lib/cli/services/fabric/transport-status.js
node --test \
  test/fabric-m6-promotion-gate.test.js \
  test/fabric-transport-promotion-gate.test.js \
  test/fabric-transport-status.test.js
```

Result: 29/29 pass.

## Verdict

Direct WebRTC is now a verified advanced promotion candidate for the promotion
gate and aggregate transport status when explicitly enabled. This does not
silently route normal remote requests over WebRTC yet; runtime selector changes
must be a separate step with persistent capability state and end-to-end request
routing evidence.
