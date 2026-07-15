# 2026-06-28 AWS Runtime Diagnostics Readback

## Scope

This evidence records the runtime gap refinement for `aws-current-node`.

No mock data was used. Only AWS current was touched:

- SSH: `ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com`
- key: `/Users/model/.ssh/aws.pem`
- remote dir: `/home/ubuntu/aih-fabric-current`
- product port: default `9527`

No provider credentials were imported to AWS.

## Code Change

Commit:

```text
95190ca feat(fabric): report runtime diagnostics from nodes
```

The registry agent can now be started with:

```text
--runtime-diagnostics
```

When enabled, the node reports:

- whether provider CLI commands are present on the node PATH;
- provider account counts from the same node server `/readyz`;
- no raw token, no provider credential, and no provider CLI execution output.

The server persists this under `runtimeDiagnostics[]`, and Node Inventory uses
it to refine runtime blockers:

- `missing_provider_cli:<provider>`
- `missing_provider_account:<provider>`
- `provider_runtime_not_registered:<provider>`
- fallback: `missing_provider_runtime:<provider>`

## Local Verification

Focused tests:

```text
node --test test/fabric-registry-agent.test.js
node --test test/fabric-registry-heartbeat.test.js
node --test test/fabric-role-registry.test.js
node --test test/fabric-registry-agent-service.test.js
node --test test/fabric-node-inventory.test.js
node --test test/fabric-nodes-client.test.js
node --test test/fabric-registry-client.test.js
node --test test/fabric-registry-publish.test.js
```

Result:

```text
all focused tests passed
```

Full suite:

```text
npm test
```

Result:

```text
2684/2684 pass
```

## AWS Deployment

Clean source artifact from committed `HEAD`:

```text
HEAD=95190ca
archive=/tmp/aih-fabric-head-95190ca.tar.gz
sha256=72ca41683a78180d4be0786f8bb23c9ae69f8a43848c0b95f87bed670c9f28e3
bytes=3105685
```

The archive was copied to AWS and extracted into:

```text
/home/ubuntu/aih-fabric-current
```

AWS server was restarted on default port `9527` only:

```text
server_pid=266437
```

AWS `/readyz` after restart:

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

`ready=false` is expected because AWS still has no provider accounts.

## Registry Agent Service

The AWS user-level registry agent service was reinstalled and restarted with
runtime diagnostics enabled.

Service:

```text
com.clawdcodex.ai_home.fabric-registry-agent.aws-current-node.service
```

Runtime proof:

```text
MainPID=266541
ExecStart:
  /home/ubuntu/aih-fabric-current/bin/ai-home.js fabric registry agent
  http://127.0.0.1:9527
  --node-id aws-current-node
  --token-file /home/ubuntu/aih-fabric-current/.aih-host-home/.ai_home/fabric/aws-current-node.token
  --status online
  --relay-status online
  --transport relay=online
  --transport webrtc=online
  --probe-transport relay=ws://127.0.0.1:9527/v0/fabric/transport/echo
  --probe-timeout-ms 10000
  --probe-method HEAD
  --probe-count 20
  --probe-payload-size 64
  --runtime-diagnostics
  --interval-ms 30000
```

Heartbeat after restart:

```text
[aih fabric agent] heartbeat #1 node=aws-current-node status=online relay=online transports=2 probes=relay:online nodes=2 relayNodes=2 transports=3 projects=2 runtimes=4
[aih fabric agent] heartbeat #2 node=aws-current-node status=online relay=online transports=2 probes=relay:online nodes=2 relayNodes=2 transports=3 projects=2 runtimes=4
```

## Local Profile Repair

Before readback, the local server profile existed and still had a device token,
but its local state was `degraded`, so the CLI refused to use it as ready.

The profile was not manually re-paired or given a new token. A real authorized
request to AWS `/v0/fabric/registry` returned HTTP `200`; only after that the
local profile state was repaired back to `paired`.

Repair proof:

```json
{
  "ok": true,
  "status": 200,
  "profile": {
    "id": "cp-51hq70",
    "state": "paired",
    "authState": "paired",
    "endpoint": "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527"
  },
  "counts": {
    "nodes": 2,
    "relayNodes": 2,
    "transports": 3,
    "projects": 2,
    "runtimes": 4
  }
}
```

The active profile pointer was then restored to the same verified profile:

```text
activeProfileId=cp-51hq70
profile.state=paired
profile.authState=paired
deviceTokenPresent=true
```

Default-profile readback without `--endpoint` also passed:

```text
node bin/ai-home.js fabric nodes aws-current-node --json
node bin/ai-home.js fabric transport readiness --node-id aws-current-node --timeout-ms 20000 --json

result:
  profile.id=cp-51hq70
  authorizedStatus=200
  nodeFound=true
  fallbackReady=true
```

## Real Node Readback

Command:

```text
node bin/ai-home.js fabric nodes aws-current-node \
  --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 \
  --json
```

Result:

```text
unauthenticatedStatus=401
authorizedStatus=200
nodeFound=true
registry counts: nodes=2 relayNodes=2 transports=3 projects=2 runtimes=4
aws-current-node counts: projects=1 runtimes=0 runtimeDiagnostics=4 transports=2
aws-current-node transportKinds: relay,webrtc
aws-current-node runtimeHost=false
```

Runtime gaps after diagnostics:

```text
codex:
  blocker=missing_provider_account:codex
  cli.available=true
  cli.path=/home/ubuntu/aih-fabric-current/node_modules/.bin/codex
  accounts.total=0

claude:
  blocker=missing_provider_cli:claude
  cli.available=false
  accounts.total=0

agy:
  blocker=missing_provider_cli:agy
  cli.available=false
  accounts.total=0

opencode:
  blocker=missing_provider_cli:opencode
  cli.available=false
  accounts.total=0
```

Action gates:

```text
start-session:codex blocked by missing_provider_account:codex
start-session:claude blocked by missing_provider_cli:claude
start-session:agy blocked by missing_provider_cli:agy
start-session:opencode blocked by missing_provider_cli:opencode
```

Direct session-start guard:

```text
node bin/ai-home.js fabric session start aws-current-node \
  --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 \
  --provider codex \
  --prompt AIH_AWS_RUNTIME_DIAGNOSTIC_CODEX_BLOCK_CHECK \
  --json

result:
  ok=false
  blocked=true
  registryAuthorizedStatus=200
  sessionStartStatus=0
  blockers=missing_provider_account:codex
```

```text
node bin/ai-home.js fabric session start aws-current-node \
  --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 \
  --provider claude \
  --prompt AIH_AWS_RUNTIME_DIAGNOSTIC_CLAUDE_BLOCK_CHECK \
  --json

result:
  ok=false
  blocked=true
  registryAuthorizedStatus=200
  sessionStartStatus=0
  blockers=missing_provider_cli:claude
```

This answers the runtime question precisely:

- AWS has a Codex CLI shim in deployed `node_modules`, but no Codex provider
  account on the AWS server.
- AWS does not currently have Claude, AGY, or OpenCode CLI commands available
  on the registry agent PATH.
- AWS still has zero provider accounts, so it remains `runtimeHost=false`.

## Transport Regression

Transport readiness command:

```text
node bin/ai-home.js fabric transport readiness \
  --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 \
  --node-id aws-current-node \
  --timeout-ms 20000 \
  --json
```

Result:

```text
unauthenticatedStatus=401
authorizedStatus=200
defaultTransport=relay
fallbackReady=true
relayMeasurementPass=true
promotionReady=false
blockers:
  webrtc:webrtc_not_promoted
  webrtc:turn_relay_gate_not_ready
  webtransport:webtransport_endpoint_not_configured
  webtransport:webtransport_not_promoted
  omr:openmptcprouter_not_detected
  mptcp:mptcp_data_plane_not_promoted
```

M6 promotion gate after deployment:

```text
relay: 5/5 echo, p95=111ms
webrtc: DataChannel candidateReady=true, RPC ok=true, selected pair srflx -> srflx
webrtc blocker: turn_relay_gate_not_ready
turn blocker: turn_ice_server_not_configured
webtransport blocker: webtransport_connect_failed
multipath blockers: local_mptcp_unavailable, openmptcprouter_not_detected, default_listener_is_plain_http_not_multipath_transport
summary: promotionReady=false, defaultTransport=relay, fallbackReady=true
```

## Conclusion

The AWS node is no longer opaque. It is still a valid Fabric node, relay node,
project host, and WebRTC candidate carrier, but it is not a runtime host yet.

Remaining work to make AWS a runtime host:

1. Install/make available the missing provider CLIs on AWS:
   `claude`, `agy`, and `opencode`.
2. Add/import provider accounts to AWS only with explicit credential approval.
3. Register actual runtime records after CLI and account facts are ready.

The default transport remains `relay`; advanced transport promotion is unchanged
and still depends on controlled TURN, HTTPS/H3 WebTransport, or a real
OpenMPTCPRouter/Linux underlay.
