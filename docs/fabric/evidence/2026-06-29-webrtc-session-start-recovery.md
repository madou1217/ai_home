# 2026-06-29 WebRTC session-start recovery

## Scope

- Target: AWS current only.
- SSH: `ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com`
- Remote dir: `/home/ubuntu/aih-fabric-current`
- Product port: `9527`
- Node id: `aws-current-node`

No mock data was used. The real session proof used the AWS node, the paired
server profile, the real OpenCode runtime account, and the real WebRTC
management DataChannel.

## Product change

The previous closure audit proved WebRTC was promoted/default, but
`device-node-session-start` could still fall back to relay when the selected
WebRTC session closed during the request. Events polling then often succeeded
over WebRTC after the connector reconnected.

This change keeps the relay fallback but adds a narrow recovery path for
session-class RPCs:

- If a promoted WebRTC transport is rejected only because the adapter has no
  open session, wait briefly for a fresh session before selecting relay.
- If a selected WebRTC session closes, errors, or becomes unavailable during a
  session request, wait for a fresh session and retry WebRTC once.
- If recovery does not happen inside the window, preserve the existing relay
  fallback behavior.
- Normal read/status requests are not delayed by this recovery window.

## Local verification

```sh
node --check lib/server/remote/remote-gateway.js
node --check lib/server/remote/webrtc-management-adapter.js
node --check lib/server/server.js
node --test test/remote-node-registry.test.js test/webrtc-management-adapter.test.js
node --test test/node-rpc-router.test.js test/server-node-rpc-wiring.test.js
node --test test/fabric-session-start-client.test.js test/fabric-closure-audit.test.js test/fabric-real-session-recovery-smoke.test.js
npm test
```

Result:

- WebRTC gateway/adapter focused tests: `32/32 pass`
- Node RPC/server wiring tests: `65/65 pass`
- Fabric session/closure focused tests: `17/17 pass`
- Full suite: `2838/2838 pass`

## AWS runtime deployment for live proof

The runtime patch was synchronized to AWS current and the default server was
restarted on the existing `9527` port using the correct host-home state:

```text
AIH_HOME=/home/ubuntu/aih-fabric-current/.aih-host-home/.ai_home
AI_HOME=/home/ubuntu/aih-fabric-current/.aih-host-home/.ai_home
HOME=/home/ubuntu/aih-fabric-current/.aih-host-home
server pid: 419790
```

The first manual restart without this host-home environment returned an empty
account pool. It was stopped and replaced with the host-home launch above.

AWS `/readyz` after recovery:

```json
{
  "ok": true,
  "ready": true,
  "accounts": {
    "codex": 1,
    "gemini": 0,
    "claude": 4,
    "agy": 7,
    "opencode": 1
  }
}
```

Long-running connector processes after restart:

- registry agent: pid `388812`
- relay connector: pid `419813`
- WebRTC connector: pid `419814`

## AWS transport status

Command:

```sh
node bin/ai-home.js fabric transport status \
  --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 \
  --node-id aws-current-node \
  --json
```

Result:

- `summary.status=complete`
- `summary.remoteDevelopmentReady=true`
- `summary.defaultTransport=webrtc`
- `summary.advancedPromotionReady=true`
- `summary.promotedTransports=["webrtc"]`
- `summary.fallbackReady=true`
- `summary.relayMeasurementPass=true`

External transport blockers are unchanged:

- `webtransport:webtransport_endpoint_not_configured`
- `webtransport:webtransport_not_promoted`
- `omr:openmptcprouter_not_detected`
- `mptcp:mptcp_data_plane_not_promoted`
- `turn_default_udp_9527_unreachable`
- `aws_public_udp_path_blocked`
- `aws_cli_missing`
- `aws_iam_role_missing`

## Real closure audit

Command:

```sh
node bin/ai-home.js fabric closure audit \
  --node-id aws-current-node \
  --provider opencode \
  --session-marker AIH_WEBRTC_RECOVERY_OK_20260629_1019 \
  --event-timeout-ms 60000 \
  --session-timeout-ms 120000 \
  --json
```

Result:

- `ok=true`
- `exitOk=true`
- `summary.status=usable_with_blockers`
- `summary.coreReady=true`
- `summary.transportReady=true`
- `summary.targetProviderReady=true`
- `summary.sessionReady=true`
- `capabilities.defaultTransport=webrtc`
- `capabilities.advancedPromotionReady=true`
- `closurePlan.state=usable_with_external_blockers`

Real session proof:

- run: `175b38ad-f607-4bfd-800f-c3337ef911b0`
- provider: `opencode`
- account: `1`
- marker: `AIH_WEBRTC_RECOVERY_OK_20260629_1019`
- `markerFound=true`
- `doneObserved=true`
- `eventCount=5`
- event types: `ready`, `session-created`, `delta`, `result`, `done`

Transport proof:

| Path | Transport | Fallback |
|---|---|---|
| `device-node-session-start` | `aws-current-node-webrtc` | `fallbackUsed=false` |
| `device-node-session-run-events` | `aws-current-node-webrtc` | `fallbackUsed=false` |

The previous `remote_webrtc_session_closed -> relay fallback` gap did not
reproduce in this real AWS closure audit after the recovery path was deployed.

## Remaining blockers

These are external/account blockers, not this WebRTC session-start defect:

- Codex: `auth_invalid:upstream_401`
- Claude: `auth_invalid:claude_not_logged_in`
- AGY: `auth_invalid:agy_not_signed_in`
- TURN/UDP: public UDP `9527` packets still do not arrive at AWS instance
- WebTransport: no HTTPS/H3 endpoint
- Multipath: no real OpenMPTCPRouter/MPTCP underlay
- AWS readback: AWS CLI missing and no read-only IAM role
