# 2026-06-29 M6 WebRTC promotion refresh after runtime guards

## Scope

This evidence refreshes the live AWS current state after runtime account
revalidation. It verifies the product path that matters for current remote
development:

- local client reads the paired AWS server profile;
- AWS current is visible as a Fabric node;
- AWS current exposes an enabled `opencode` runtime action;
- default remote stream transport is promoted WebRTC;
- relay remains ready as fallback;
- a real OpenCode session starts and completes through WebRTC.

No mock data was used. The test did not upload local provider credentials and
did not touch the retired `152.*`, `155.*`, or `39.104.*` servers.

## Target

```text
server profile: cp-51hq70
endpoint: http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527
node id: aws-current-node
ssh: ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com
remote dir: /home/ubuntu/aih-fabric-current
product port: 9527
```

## Node readback

Command:

```bash
node bin/ai-home.js fabric nodes aws-current-node
```

Result summary:

```text
http unauth=401 auth=200
registry nodes=2 relay_nodes=2 projects=2 runtimes=8 transports=3
roles=node,relay-node
capabilities relay=yes project_host=yes runtime_host=yes ssh=yes measured=yes
transports=relay,webrtc online
runtimes=agy,claude,codex,opencode
open-project=enabled
configure-ssh=enabled
start-session:opencode=enabled
start-session:codex=blocked provider_account_unavailable:codex
start-session:claude=blocked provider_account_unavailable:claude
start-session:agy=blocked provider_account_unavailable:agy
```

Runtime blocker truth:

| Provider | Accounts | Schedulable | Reason |
|---|---:|---:|---|
| codex | 1 | 0 | `runtime:auth_invalid:upstream_401=1` |
| claude | 4 | 0 | `runtime:auth_invalid:claude_not_logged_in=4` |
| agy | 7 | 0 | `runtime:auth_invalid:agy_not_signed_in=7` |
| opencode | 1 | 1 | none |

## Transport readiness

Command:

```bash
node bin/ai-home.js fabric transport readiness --node-id aws-current-node --json
```

Result summary:

```json
{
  "authorizedStatus": 200,
  "defaultTransport": "webrtc",
  "fallbackReady": true,
  "promotionReady": true,
  "promotedTransports": ["webrtc"],
  "relayMeasurementPass": true,
  "relayRttP95Ms": 1,
  "blockers": [
    "webtransport:webtransport_endpoint_not_configured",
    "webtransport:webtransport_not_promoted",
    "omr:openmptcprouter_not_detected",
    "mptcp:mptcp_data_plane_not_promoted"
  ]
}
```

The important distinction is that direct WebRTC is promoted and selected now.
The remaining blockers belong to other candidate paths, not to the current
usable remote development path.

## Transport status

Command:

```bash
node bin/ai-home.js fabric transport status --node-id aws-current-node --json
```

Result summary:

```json
{
  "status": "complete",
  "remoteDevelopmentReady": true,
  "defaultTransport": "webrtc",
  "fallbackReady": true,
  "advancedPromotionReady": true,
  "promotedTransports": ["webrtc"],
  "cloudEdgeReady": false,
  "udpReachable": false,
  "packetArrivalCaptured": false,
  "hostFirewallBlocksUdp": false,
  "cloudApiCredentialsReady": false,
  "nextActions": []
}
```

The same status run kept the cloud-edge diagnostics honest:

```text
publicIpv4=43.207.102.163
securityGroupIds=sg-01e33f3412fabfded,sg-01e7f50a205d7b308
turn_default_udp_9527_unreachable
aws_public_udp_path_blocked
aws_cli_missing
aws_iam_role_missing
```

## Real WebRTC OpenCode session

Command:

```bash
node bin/ai-home.js fabric session start aws-current-node \
  --provider opencode \
  --prompt "Do not use tools. Output exactly: AIH_RUNTIME_OPENCODE_WEBRTC_CLOSE_OK_20260629_1556" \
  --timeout-ms 120000 \
  --json
```

Result summary:

```json
{
  "blocked": false,
  "sessionStartStatus": 200,
  "selectedTransportKind": "webrtc",
  "fallbackUsed": false,
  "provider": "opencode",
  "accountId": "1",
  "runId": "c808cd28-0921-4290-8d1b-04d96d5e9e00",
  "status": "running"
}
```

Events command:

```bash
node bin/ai-home.js fabric session events aws-current-node \
  --run-id c808cd28-0921-4290-8d1b-04d96d5e9e00 \
  --limit 100 \
  --timeout-ms 30000 \
  --json
```

Events result:

```json
{
  "status": "completed",
  "selectedTransportKind": "webrtc",
  "fallbackUsed": false,
  "cursor": 5,
  "eventTypes": {
    "ready": 1,
    "session-created": 1,
    "delta": 1,
    "result": 1,
    "done": 1
  },
  "content": "AIH_RUNTIME_OPENCODE_WEBRTC_CLOSE_OK_20260629_1556"
}
```

## Product conclusion

From the local WebUI/client point of view, AWS current is now a real Fabric
server node that can be selected for remote development. It can currently do:

- show as an authorized Fabric node from the paired local profile;
- expose SSH/project metadata;
- open the AWS project action;
- run real OpenCode sessions on AWS;
- stream those session commands/events through promoted WebRTC;
- retain relay as fallback.

It cannot truthfully claim schedulable Codex, Claude, or AGY sessions until
their AWS-side provider accounts are logged in or repaired. It also cannot
claim TURN relay, WebTransport/H3, or Multipath/OMR promotion until those
external underlays pass their own real probes.
