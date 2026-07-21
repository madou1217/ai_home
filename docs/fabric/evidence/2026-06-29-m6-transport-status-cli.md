# 2026-06-29 M6 transport status CLI

## Scope

Add one product entry for the current closure state:

```bash
aih fabric transport status
```

The command aggregates the already-productized readiness and cloud-edge
preflight checks. It does not open ports, install transport software, import
provider credentials, or mutate AWS. The default path is intentionally light:
it verifies the paired server readiness and the current AWS cloud edge state.
The heavier aggregate promotion gate remains opt-in through
`--with-promotion-gate`.

## Code paths

- `lib/cli/services/fabric/transport-status.js`
- `lib/cli/commands/fabric-router.js`
- `test/fabric-transport-status.test.js`

## Verification

Local syntax and focused tests:

```bash
node --check lib/cli/services/fabric/transport-status.js
node --check lib/cli/commands/fabric-router.js
node --test \
  test/fabric-transport-status.test.js \
  test/fabric-transport-cloud-edge.test.js \
  test/fabric-cloud-edge-preflight.test.js \
  test/fabric-real-transport-readiness-client-smoke.test.js
```

Result: 18/18 pass.

Full local suite:

```bash
npm test
```

Result: 2737/2737 pass.

## Real AWS status run

Command:

```bash
node bin/ai-home.js fabric transport status \
  --endpoint "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527" \
  --json
```

Result:

- process status: `0`
- report: `ok=true`, `exitOk=true`
- `summary.status=usable_partial`
- `remoteDevelopmentReady=true`
- `defaultTransport=relay`
- `fallbackReady=true`
- `relayMeasurementPass=true`
- `advancedPromotionReady=false`
- `cloudEdgeReady=false`
- `udpReachable=false`
- `packetArrivalCaptured=false`
- `hostFirewallBlocksUdp=false`
- `cloudApiCredentialsReady=false`
- `publicIpv4=43.207.102.163`
- `securityGroupIds=sg-01e33f3412fabfded,sg-01e7f50a205d7b308`
- blockers:
  - `webrtc:webrtc_not_promoted`
  - `webrtc:turn_relay_gate_not_ready`
  - `webtransport:webtransport_endpoint_not_configured`
  - `webtransport:webtransport_not_promoted`
  - `omr:openmptcprouter_not_detected`
  - `mptcp:mptcp_data_plane_not_promoted`
  - `turn_default_udp_9527_unreachable`
  - `aws_public_udp_path_blocked`
  - `aws_cli_missing`
  - `aws_iam_role_missing`

Strict command:

```bash
node bin/ai-home.js fabric transport status \
  --endpoint "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527" \
  --fail-on-blocked \
  --json
```

Result:

- process status: `1`
- report: `ok=true`, `exitOk=false`
- `summary.status=usable_partial`
- `advancedPromotionReady=false`

Promotion-gate opt-in smoke:

```bash
node bin/ai-home.js fabric transport status \
  --endpoint "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527" \
  --with-promotion-gate \
  --skip-webtransport \
  --skip-multipath \
  --skip-webrtc \
  --json
```

Result:

- process status: `0`
- report: `ok=true`, `exitOk=true`
- relay gate: `20/20` echo, p95 `113ms`
- promotion summary: `promotionReady=false`, `defaultTransport=relay`,
  `fallbackReady=true`
- promotion blockers:
  - `turn:turn_ice_server_not_configured`
  - `turn:turn_default_udp_9527_unreachable`

## AWS current focused checks

Sync artifact:

```text
0f72c00ad2873f4ea74383200be84202c65a9c13ebbf6299b7ca19d12d7ece8b  source-transport-status.tar.gz
```

Remote focused checks:

```bash
node --check lib/cli/services/fabric/transport-status.js
node --check lib/cli/commands/fabric-router.js
node --test \
  test/fabric-transport-status.test.js \
  test/fabric-transport-cloud-edge.test.js \
  test/fabric-cloud-edge-preflight.test.js \
  test/fabric-real-transport-readiness-client-smoke.test.js
```

Result: 18/18 pass.

## Verdict

The default single command now answers the current product question directly:

- AWS current is usable as a paired server/node through relay fallback.
- Advanced transport promotion is still not complete.
- The current cloud-edge blocker remains outside the AIH process:
  public UDP `9527` does not arrive at AWS `enp39s0`, host firewall is not the
  apparent blocker, and the instance has no AWS CLI or IAM role for SG/NACL
  readback.
- `--fail-on-blocked` is available for CI or release gates that require
  advanced promotion before passing.
