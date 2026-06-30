# 2026-06-29 Remote Session Transport Evidence

## Scope

This evidence records a real local-client to AWS-node remote session after
shipping transport evidence through Fabric device-node session APIs.

No mock data was used for the final verification. Only AWS current was touched.

## Environment

| item | value |
|---|---|
| local repo | `/Users/model/projects/feature/ai_home` |
| code commit deployed | `fdd6ef628c1df6577d23f352a809e0682768f25f` |
| AWS endpoint | `http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527` |
| AWS SSH | `ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com` |
| AWS key | `/Users/model/.ssh/aws.pem` |
| AWS dir | `/home/ubuntu/aih-fabric-current` |
| node id | `aws-current-node` |
| product port | `9527` |

## Deployment

Commands:

```text
git archive --format=tar.gz -o /tmp/aih-fabric-source-fdd6ef6.tar.gz HEAD
shasum -a 256 /tmp/aih-fabric-source-fdd6ef6.tar.gz
scp -i /Users/model/.ssh/aws.pem /tmp/aih-fabric-source-fdd6ef6.tar.gz \
  ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:/home/ubuntu/aih-fabric-current/source-fdd6ef6.tar.gz
ssh -i /Users/model/.ssh/aws.pem ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com \
  'cd /home/ubuntu/aih-fabric-current && sha256sum source-fdd6ef6.tar.gz && tar -xzf source-fdd6ef6.tar.gz'
```

Result summary:

```text
sha256=0f640bd0bc02632de2e7375570fca79a234adb3e3940a4c0adfdd9e0d6330566
DEPLOYED_GIT_HEAD=fdd6ef628c1df6577d23f352a809e0682768f25f
server pid after restart=380063
readyz.ready=true
readyz.accounts=codex:1,claude:4,agy:7,opencode:1
```

## Tests

Local:

```text
node --test test/node-rpc-router.test.js test/server-node-rpc-wiring.test.js \
  test/fabric-session-start-client.test.js test/fabric-session-control-client.test.js
npm test
```

Result:

```text
focused=73/73 pass
npm test=2803/2803 pass
```

AWS focused:

```text
node --check lib/server/node-rpc-router.js
node --test test/node-rpc-router.test.js test/server-node-rpc-wiring.test.js \
  test/fabric-session-start-client.test.js test/fabric-session-control-client.test.js
```

Result:

```text
AWS focused=73/73 pass
```

## Real Session Results

Inventory:

```text
node bin/ai-home.js fabric nodes aws-current-node --json
```

Result summary:

```text
profile.id=cp-51hq70
node.id=aws-current-node
node.roles=node,relay-node
node.transports=relay,webrtc
start-session:opencode=enabled
start-session:codex=blocked provider_account_unavailable:codex
start-session:claude=blocked provider_account_unavailable:claude
start-session:agy=blocked provider_account_unavailable:agy
```

First real opencode turn:

```text
node bin/ai-home.js fabric session start aws-current-node \
  --provider opencode \
  --prompt "请只回复 AIH_TRANSPORT_EVIDENCE_REAL_OK" \
  --json
```

Result summary:

```text
ok=true
runId=d5e83b39-d17d-41db-82c8-aafb611128b4
sessionId=ses_0ee2e3024ffex0Xtuks4NDJcyU
transport.kind=webrtc
transportDecision.selectedTransportKind=webrtc
transportDecision.fallbackUsed=false
marker=AIH_TRANSPORT_EVIDENCE_REAL_OK
done=true
```

Attach:

```text
node bin/ai-home.js fabric session attach aws-current-node \
  --run-id d5e83b39-d17d-41db-82c8-aafb611128b4 \
  --cursor 0 --limit 20 --json
```

Result summary:

```text
ok=true
transport.kind=webrtc
transportDecision.selectedTransportKind=webrtc
snapshot.events=5
allowedCommands=attach,detach
```

Second real opencode resume turn:

```text
node bin/ai-home.js fabric session start aws-current-node \
  --provider opencode \
  --session-id ses_0ee2e3024ffex0Xtuks4NDJcyU \
  --prompt "请只回复 AIH_TRANSPORT_SECOND_REAL_OK" \
  --json
```

Result summary:

```text
ok=true
runId=cfbc6386-c27a-4ec8-bfbe-7f729f64af93
sessionId=ses_0ee2e3024ffex0Xtuks4NDJcyU
start.transport.kind=relay
start.transportDecision.fallbackUsed=true
start.transportDecision.fallbackFrom=webrtc
start.transportDecision.rejectedTransports=aws-current-node-webrtc:remote_webrtc_session_closed
events.transport.kind=webrtc
marker=AIH_TRANSPORT_SECOND_REAL_OK
done=true
```

## Current Transport Readiness

Command:

```text
node bin/ai-home.js fabric transport readiness --node-id aws-current-node --timeout-ms 20000 --json
```

Result summary:

```text
ok=true
summary.defaultTransport=webrtc
summary.fallbackReady=true
summary.promotionReady=true
summary.promotedTransports=webrtc
node.relayMeasurementPass=true
node.relayRttMs.p95=7
blockers=webtransport:webtransport_endpoint_not_configured,webtransport:webtransport_not_promoted,omr:openmptcprouter_not_detected,mptcp:mptcp_data_plane_not_promoted
```

Prerequisite audit remains globally blocked for advanced transports:

```text
turn=turn_ice_server_not_configured,turn_default_udp_9527_unreachable
webtransport=webtransport_connect_failed
multipath=local_mptcp_unavailable,openmptcprouter_not_detected,default_listener_is_plain_http_not_multipath_transport
```

## Interpretation

- The local client can use the paired AWS server profile to see `aws-current-node`.
- AWS node can start real opencode remote sessions from the local client.
- Start, events, and attach now expose selected transport evidence.
- The selected transport is not hardcoded: first turn used WebRTC, the resume
  start fell back from closed WebRTC to relay, and later events used WebRTC.
- Relay fallback remains useful and observable.
- Codex, Claude, and Agy are still blocked by real AWS account schedulability,
  not by Fabric session routing.

## Verdict

pass

## Next Checks

- Fix or re-import AWS provider accounts if Codex/Claude/Agy remote sessions are
  required.
- Add controlled TURN credentials before requiring WebRTC relay-candidate
  promotion.
- WebTransport/QUIC needs a real endpoint before it can be promoted.
- Multipath/OpenMPTCPRouter needs a real multi-WAN topology; the current macOS
  local side cannot promote MPTCP.
