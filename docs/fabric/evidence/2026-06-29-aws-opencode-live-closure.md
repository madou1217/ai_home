# 2026-06-29 AWS Opencode Live Closure

## Scope

This evidence records the current AWS node live remote-development closure after
WebRTC promotion, using the local paired server profile and AWS current on the
default product port `9527`.

No mock data was used. Only AWS current was touched.

## Environment

| item | value |
|---|---|
| local repo | `/Users/model/projects/feature/ai_home` |
| AWS endpoint | `http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527` |
| AWS SSH | `ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com` |
| AWS dir | `/home/ubuntu/aih-fabric-current` |
| node id | `aws-current-node` |
| server profile | `cp-51hq70` |
| product port | `9527` |
| deployed head | `a307260e8045265c50ae868b96b797c556594fe5` |

## Current Readback

Commands:

```text
node bin/ai-home.js fabric nodes aws-current-node --json
node bin/ai-home.js fabric transport status --node-id aws-current-node --json
curl -s http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527/readyz
```

Result summary:

```text
readyz.ready=true
readyz.accounts=codex:1,gemini:0,claude:4,agy:7,opencode:1
fabric.nodes.http=unauthenticated 401, authorized 200
registry.counts=nodes:2,relayNodes:2,transports:3,projects:2,runtimes:8
aws-current-node.roles=node,relay-node
aws-current-node.transports=relay,webrtc
aws-current-node.runtimeProviders=agy,claude,codex,opencode
start-session:opencode=enabled
start-session:codex=blocked provider_account_unavailable:codex
start-session:claude=blocked provider_account_unavailable:claude
start-session:agy=blocked provider_account_unavailable:agy
transport.status=complete
defaultTransport=webrtc
fallbackReady=true
promotedTransports=webrtc
relayMeasurementPass=true
cloudEdgeReady=false
udpReachable=false
```

AWS supervised service names currently running:

```text
com.clawdcodex.ai_home.fabric-registry-agent.aws-current-node.service
com.clawdcodex.ai_home.node-relay.aws-current-node.service
com.clawdcodex.ai_home.node-webrtc.aws-current-node.service
```

## Real Session Start

Command:

```text
node bin/ai-home.js fabric session start aws-current-node \
  --provider opencode \
  --prompt "请只回复 AIH_AWS_OPENCODE_LIVE_OK_20260629" \
  --timeout-ms 120000 \
  --json
```

Result summary:

```text
ok=true
http.sessionStartStatus=200
transport.kind=webrtc
transportDecision.selectedTransportKind=webrtc
transportDecision.fallbackUsed=false
runId=01eae841-135b-4045-946c-5342b74bb09c
sessionId=ses_0ee0c2e50ffesAQqB3wl72FM90
projectPath=/home/ubuntu/aih-fabric-current
accountId=1
```

Events:

```text
completed=true
cursor=5
eventTypes=ready,session-created,delta,result,done
marker=AIH_AWS_OPENCODE_LIVE_OK_20260629
```

## Completed Run Resume

Command:

```text
node bin/ai-home.js fabric session message aws-current-node \
  --run-id 01eae841-135b-4045-946c-5342b74bb09c \
  --text "请只回复 AIH_AWS_OPENCODE_RESUME_LIVE_OK_20260629" \
  --timeout-ms 120000 \
  --json
```

Result summary:

```text
ok=true
http.status=200
accepted=true
resumed=true
resumedFromRunId=01eae841-135b-4045-946c-5342b74bb09c
newRunId=4f269d6a-c8f9-45a2-b677-9fb2626fa43e
sessionRef=ses_0ee0c2e50ffesAQqB3wl72FM90
message.transport.kind=webrtc
message.transportDecision.fallbackUsed=false
```

Final events:

```text
completed=true
cursor=4
eventTypes=ready,delta,result,done
marker=AIH_AWS_OPENCODE_RESUME_LIVE_OK_20260629
events.transport.kind=relay
events.transportDecision.fallbackUsed=true
events.transportDecision.fallbackFrom=webrtc
events.transportDecision.rejected=aws-current-node-webrtc:remote_webrtc_session_closed
```

The final event read used relay fallback because the prior WebRTC runtime
session had already closed. This is expected and observable; the resume command
itself still used WebRTC and the event read completed through relay fallback.

## Remaining Blockers

The core AWS node remote-development path is usable now:

- paired local client -> AWS current server profile;
- authorized registry and node readback;
- default WebRTC management RPC selector;
- AWS opencode session start;
- completed-run message resume;
- relay fallback for closed WebRTC sessions.

Remaining blockers are external transport/provider concerns, not Fabric
connectivity blockers:

```text
TURN/self-hosted UDP 9527: turn_default_udp_9527_unreachable, aws_public_udp_path_blocked
Cloud introspection: aws_cli_missing, aws_iam_role_missing
WebTransport: webtransport_endpoint_not_configured, webtransport_not_promoted
Multipath: openmptcprouter_not_detected, mptcp_data_plane_not_promoted
Codex/Claude/AGY start on AWS: provider_account_unavailable
```
