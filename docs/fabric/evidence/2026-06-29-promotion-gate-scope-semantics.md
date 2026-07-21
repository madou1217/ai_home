# 2026-06-29 Promotion gate scope semantics

## Scope

This closes a product semantics gap in the M6 promotion gate. The real runtime
can already use direct WebRTC as the current data path, while the strict
promotion gate can still report `defaultTransport=relay` when direct WebRTC
promotion is not explicitly allowed. That output was technically correct for
the strict gate, but it was easy to read as "runtime went back to relay".

No mock data was used for the final verification. The real target was AWS
current:

```text
endpoint=http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527
ssh=ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com
remoteDir=/home/ubuntu/aih-fabric-current
nodeId=aws-current-node
port=9527
```

## Fix

`scripts/fabric-m6-promotion-gate.js` keeps the existing compatible
`summary.defaultTransport` field, and now adds explicit scope metadata:

```text
summary.defaultTransportScope=promoted_transport|fallback_transport|none
summary.fallbackTransport=relay|none
summary.candidateTransports=[...]
summary.blockedTransports=[...]
summary.promotionPolicy.webrtc=direct_allowed|turn_relay_required
summary.promotionPolicy.directWebrtcMaxP95Ms=<n>
```

The human-readable CLI output also prints:

```text
default_transport_scope
fallback_transport
webrtc_policy
```

This is intentionally a narrow change. It does not alter routing, promotion
criteria, registry writes, WebRTC behavior, TURN/WebTransport/MPTCP gates, or
the existing `defaultTransport` field.

## Local verification

```text
node --check scripts/fabric-m6-promotion-gate.js
node --test test/fabric-m6-promotion-gate.test.js
node --test test/fabric-transport-promotion-gate.test.js test/fabric-transport-status.test.js test/fabric-closure-audit.test.js
npm test
```

Results:

```text
fabric-m6-promotion-gate focused: 23/23 pass
adjacent transport/closure focused: 21/21 pass
full npm test: 2857/2857 pass
```

New regression assertions:

```text
strict blocked gate: defaultTransport=relay, defaultTransportScope=fallback_transport, fallbackTransport=relay, promotionPolicy.webrtc=turn_relay_required
relay probe blocked: defaultTransport=none, defaultTransportScope=none, fallbackTransport=none
direct WebRTC allowed: defaultTransport=webrtc, defaultTransportScope=promoted_transport, fallbackTransport=relay, promotionPolicy.webrtc=direct_allowed
```

## Pre-deploy real AWS verification

Direct WebRTC policy:

```text
node bin/ai-home.js fabric transport promotion-gate \
  --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 \
  --node-id aws-current-node \
  --allow-direct-webrtc-promotion \
  --json
```

Result summary:

```text
promotionReady=true
defaultTransport=webrtc
defaultTransportScope=promoted_transport
fallbackTransport=relay
fallbackReady=true
candidateTransports=relay,webrtc
blockedTransports=turn,webtransport,multipath
promotionPolicy.webrtc=direct_allowed
webrtc.selectedCandidatePair=srflx->srflx
webrtc.rtt.p95=804.5ms
webrtc.rpc.p95=805.1ms
```

Strict TURN-relay-required policy:

```text
node bin/ai-home.js fabric transport promotion-gate \
  --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 \
  --node-id aws-current-node \
  --skip-webtransport \
  --skip-multipath \
  --json
```

Result summary:

```text
promotionReady=false
defaultTransport=relay
defaultTransportScope=fallback_transport
fallbackTransport=relay
fallbackReady=true
candidateTransports=relay,webrtc
blockedTransports=webrtc,turn
promotionPolicy.webrtc=turn_relay_required
webrtc.blockers=turn_relay_gate_not_ready
```

## Deployment

Commit deployed to AWS current:

```text
896b1a9439dd2f28f71febf1736b7c3a98d8e921
```

Artifact:

```text
local=/tmp/aih-fabric-head-896b1a9.tar.gz
remote=/home/ubuntu/aih-fabric-current/source-896b1a9.tar.gz
sha256=76d1d4db7f13ff33c946c7c9ac0df7099d2dda3c4414c7ed986dd41462b18646
sha256sum -c: OK
DEPLOYED_GIT_HEAD=896b1a9439dd2f28f71febf1736b7c3a98d8e921
```

Remote focused verification before restart:

```text
./.node-runtime/node-v22.16.0-linux-x64/bin/node --check scripts/fabric-m6-promotion-gate.js
./.node-runtime/node-v22.16.0-linux-x64/bin/node --test test/fabric-m6-promotion-gate.test.js test/fabric-transport-promotion-gate.test.js test/fabric-transport-status.test.js
```

Result:

```text
remote focused tests: 34/34 pass
```

AWS default server restart:

```text
old pid=461644
new pid=466493
new ppid=1
readyz.ok=true
readyz.ready=true
accounts=codex:1,gemini:0,claude:4,agy:7,opencode:1
```

Node process environment after restart:

```text
HOME=/home/ubuntu/aih-fabric-current/.aih-host-home
AIH_HOST_HOME=/home/ubuntu/aih-fabric-current/.aih-host-home
AIH_HOME=/home/ubuntu/aih-fabric-current/.aih-host-home/.ai_home
AI_HOME=/home/ubuntu/aih-fabric-current/.aih-host-home/.ai_home
AIH_SERVER_DISABLE_SOURCE_AUTO_RESTART=1
AIH_SERVER_STRICT_PORT=1
```

The temporary startup wrapper bash was killed after the node child was verified
and reparented. Post-cleanup process check shows only:

```text
466493 ./.node-runtime/node-v22.16.0-linux-x64/bin/node bin/ai-home.js server serve --host 0.0.0.0 --port 9527
```

## Post-deploy real AWS verification

Transport status with direct WebRTC policy:

```text
node bin/ai-home.js fabric transport status \
  --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 \
  --node-id aws-current-node \
  --skip-cloud-edge \
  --with-promotion-gate \
  --allow-direct-webrtc-promotion \
  --skip-webtransport \
  --skip-multipath \
  --json
```

Result summary:

```text
status=complete
remoteDevelopmentReady=true
defaultTransport=webrtc
fallbackReady=true
advancedPromotionReady=true
promotedTransports=webrtc
promotionGate.summary.defaultTransport=webrtc
promotionGate.summary.defaultTransportScope=promoted_transport
promotionGate.summary.fallbackTransport=relay
promotionGate.summary.candidateTransports=relay,webrtc
promotionGate.summary.blockedTransports=turn
promotionGate.summary.promotionPolicy.webrtc=direct_allowed
relay=20/20 p95=114ms
webrtc.rtt.p95=444.1ms
webrtc.rpc.p95=728.8ms
webrtc.selectedCandidatePair=srflx->srflx
```

Real business stream after deploy:

```text
node bin/ai-home.js fabric closure audit \
  --node-id aws-current-node \
  --provider opencode \
  --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 \
  --session-marker AIH_PROMOTION_SCOPE_DEPLOY_STREAM_20260629_2208 \
  --skip-cloud-edge \
  --event-timeout-ms 45000 \
  --session-timeout-ms 120000 \
  --json
```

Result summary:

```text
ok=true
exitOk=true
status=usable_with_blockers
coreReady=true
transportReady=true
targetProviderReady=true
sessionReady=true
selectedTransportKind=webrtc
fallbackUsed=false
runId=63f9d63b-eab6-4e2c-9256-40d9fbb5e014
sessionId=ses_0ec4b46eaffeaAb9Kl0OnP2opr
provider=opencode
accountId=1
projectPath=/home/ubuntu/aih-fabric-current
events=ready,session-created,delta,result,done
eventCount=5
cursor=5
completed=true
marker=AIH_PROMOTION_SCOPE_DEPLOY_STREAM_20260629_2208
markerFoundIn=delta,result,done
```

## Remaining blockers

This change does not and should not mark external transports complete:

```text
TURN: turn_ice_server_not_configured, turn_default_udp_9527_unreachable
WebTransport: webtransport_endpoint_not_configured, webtransport_not_promoted
Multipath: openmptcprouter_not_detected, mptcp_data_plane_not_promoted
Provider auth: codex/claude/agy accounts remain not schedulable on AWS
```

The next automatic action should not be another blind session retry. The next
operator actions are still provider reauth or real external transport
infrastructure.
