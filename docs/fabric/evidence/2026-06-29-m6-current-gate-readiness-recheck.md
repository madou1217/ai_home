# 2026-06-29 M6 Current Gate Readiness Recheck

## Scope

This evidence records a real M6 recheck against AWS current after the AWS
runtime account gap work.

Only AWS current was used:

- endpoint: `http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527`
- SSH: `ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com`
- key: `/Users/model/.ssh/aws.pem`
- remote dir: `/home/ubuntu/aih-fabric-current`
- node id: `aws-current-node`
- product port: default `9527`

No old VPS host was touched. No provider credentials were imported. No product
port was added.

## Transport Readiness

Command:

```text
node bin/ai-home.js fabric transport readiness --node-id aws-current-node --timeout-ms 20000 --json
```

Result summary:

```text
ok=true
profile.id=cp-51hq70
profile.authState=paired
unauthenticatedStatus=401
authorizedStatus=200
summary.defaultTransport=relay
summary.defaultTransports=relay
summary.fallbackReady=true
summary.promotionReady=false
summary.promotedTransports=[]
node.relayMeasurementPass=true
node.relayRttMs.p95=1
summary.blockers=webrtc:webrtc_not_promoted,webrtc:turn_relay_gate_not_ready,webtransport:webtransport_endpoint_not_configured,webtransport:webtransport_not_promoted,omr:openmptcprouter_not_detected,mptcp:mptcp_data_plane_not_promoted
```

Human-readable command:

```text
node bin/ai-home.js fabric transport readiness --node-id aws-current-node --timeout-ms 20000
```

Result:

```text
AIH Fabric transport readiness
  profile: http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 (cp-51hq70)
  endpoint: http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527
  node_id: aws-current-node
  http: unauth=401 auth=200
  default_transport: relay
  fallback_ready: yes
  relay_measurement_pass: yes
  promotion_ready: no
  transport_blockers:
    - webrtc:webrtc_not_promoted
    - webrtc:turn_relay_gate_not_ready
    - webtransport:webtransport_endpoint_not_configured
    - webtransport:webtransport_not_promoted
    - omr:openmptcprouter_not_detected
    - mptcp:mptcp_data_plane_not_promoted
  result: pass
```

The CLI title was changed from `transport readiness client smoke` to
`transport readiness` because this is now a product readiness check, not a lab
or temporary smoke entry.

## Prerequisite Audit

Command:

```text
node scripts/fabric-m6-prerequisite-audit.js \
  --endpoint "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527" \
  --ssh "ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com" \
  --ssh-key "/Users/model/.ssh/aws.pem" \
  --remote-dir "/home/ubuntu/aih-fabric-current" \
  --node-id aws-current-node \
  --port 9527 \
  --sample-count 3 \
  --rpc-sample-count 3 \
  --timeout-ms 30000 \
  --browser-channel chrome \
  --json
```

Result summary:

```text
ok=true
baseReady=true
promotionReady=false
readyTransports=[]
aws.candidateReady=true
aws.promotionReady=true
aws.server.processCount=1
aws.serviceStatus.supervisorReady=true
aws.registry.counts=nodes:2,relayNodes:2,projects:2,runtimes:4,transports:3,nodeInventory:2
aws.registry.targetNode.runtimeHost=false
aws.registry.targetNode.runtimeGaps=codex:missing_provider_account:codex,claude:missing_provider_account:claude,agy:missing_provider_account:agy,opencode:missing_provider_account:opencode
turn.ran=false
turn.blockers=turn_ice_server_not_configured
webtransport.ran=true
webtransport.blockers=webtransport_connect_failed
multipath.ran=true
multipath.candidateReady=true
multipath.blockers=local_mptcp_unavailable,openmptcprouter_not_detected,default_listener_is_plain_http_not_multipath_transport
```

## Promotion Gate

Command:

```text
node scripts/fabric-m6-promotion-gate.js \
  --endpoint "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527" \
  --ssh "ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com" \
  --ssh-key "/Users/model/.ssh/aws.pem" \
  --sample-count 3 \
  --rpc-sample-count 3 \
  --relay-count 10 \
  --timeout-ms 30000 \
  --browser-channel chrome \
  --json
```

Result summary:

```text
ok=true
summary.promotionReady=false
summary.defaultTransport=relay
summary.fallbackReady=true
relay.successes=10/10
relay.rtt.p95=425ms
webrtc.candidateReady=true
webrtc.promotionReady=false
webrtc.rtt.p95=206.1ms
webrtc.rpc.ok=true
webrtc.rpc.responses=3
webrtc.rpc.requestsHandled=3
webrtc.rpc.rtt.p95=338.8ms
webrtc.selectedCandidatePair=srflx->srflx
webrtc.blockers=turn_relay_gate_not_ready
turn.blockers=turn_ice_server_not_configured
webtransport.blockers=webtransport_connect_failed
multipath.blockers=local_mptcp_unavailable,openmptcprouter_not_detected,default_listener_is_plain_http_not_multipath_transport
```

Human-readable promotion gate recheck with smaller sample counts also returned:

```text
AIH Fabric M6 transport promotion gate
  promotion_ready: no
  default_transport: relay
  relay: candidate=yes promotion=yes
  webrtc: candidate=yes promotion=no
    - turn_relay_gate_not_ready
  turn: candidate=no promotion=no
    - turn_ice_server_not_configured
  webtransport: candidate=no promotion=no
    - webtransport_connect_failed
  multipath: candidate=yes promotion=no
    - local_mptcp_unavailable
    - openmptcprouter_not_detected
    - default_listener_is_plain_http_not_multipath_transport
```

## Product Change

The public Fabric CLI readiness output no longer calls this check a `client
smoke`. The compatibility script path remains unchanged, but the user-facing
heading is now:

```text
AIH Fabric transport readiness
```

When readiness authorization or data checks fail, the human-readable section is
now `readiness_blockers` instead of `smoke_blockers`.

The M6 external prerequisite audit is also available through the product CLI:

```text
node bin/ai-home.js fabric transport prerequisites \
  --endpoint "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527" \
  --ssh "ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com" \
  --ssh-key "/Users/model/.ssh/aws.pem" \
  --remote-dir "/home/ubuntu/aih-fabric-current" \
  --node-id aws-current-node \
  --port 9527 \
  --sample-count 2 \
  --rpc-sample-count 2 \
  --timeout-ms 30000 \
  --browser-channel chrome
```

Result:

```text
AIH Fabric M6 prerequisite audit
  endpoint: http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527
  base_ready: yes
  promotion_ready: no
  ready_transports: none
  aws: candidate=yes promotion=yes
  turn: candidate=no promotion=no
    - turn_ice_server_not_configured
  webtransport: candidate=no promotion=no
    - webtransport_connect_failed
  multipath: candidate=yes promotion=no
    - local_mptcp_unavailable
    - openmptcprouter_not_detected
    - default_listener_is_plain_http_not_multipath_transport
```

`--fail-on-blocked` was also verified against AWS current:

```text
status=1
ok=true
exitOk=false
promotionReady=false
blockers=turn:turn_ice_server_not_configured,webtransport:webtransport_connect_failed,multipath:local_mptcp_unavailable,multipath:openmptcprouter_not_detected,multipath:default_listener_is_plain_http_not_multipath_transport
```

## Verification

```text
node --check lib/cli/services/fabric/transport-readiness-client.js
node --check scripts/fabric-real-transport-readiness-client-smoke.js
node --test test/fabric-real-transport-readiness-client-smoke.test.js
node --check lib/cli/commands/fabric-router.js
node --check lib/cli/services/fabric/transport-prerequisites.js
node --test test/fabric-transport-prerequisites.test.js test/fabric-real-transport-readiness-client-smoke.test.js
```

Results:

```text
node --check: pass
test/fabric-real-transport-readiness-client-smoke.test.js: 5/5 pass
focused transport prerequisites/readiness tests: 8/8 pass
```

## AWS Source Sync

After commit `3a19962`, a clean `git archive HEAD` artifact was used to update
AWS current. The dirty local worktree was not used.

Artifact:

```text
/tmp/aih-fabric-3a19962.tar.gz
sha256=35aca81898977d5faf09854928470e1a2bd3764f8f178d6fa58f8db9daa3ded8
size=3.0M
remote=/home/ubuntu/aih-fabric-current/source-3a19962.tar.gz
```

Remote verification:

```text
node --check lib/cli/services/fabric/transport-readiness-client.js
node --check scripts/fabric-real-transport-readiness-client-smoke.js
node --test test/fabric-real-transport-readiness-client-smoke.test.js
```

Results:

```text
AWS node --check: pass
AWS test/fabric-real-transport-readiness-client-smoke.test.js: 5/5 pass
```

AWS default `9527` remained healthy after source sync:

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

The server was not restarted because this is a CLI/script wording and evidence
change, not a server request-path change.

After commit `6dc6a5b`, another clean `git archive HEAD` artifact was used to
update AWS current for the product `transport prerequisites` command. The dirty
local worktree was not used.

Artifact:

```text
/tmp/aih-fabric-6dc6a5b.tar.gz
sha256=1b5f551152fabdf5ebf7f3200f25e1d892df9c07694fd3c309bb48263a2087d9
remote=/home/ubuntu/aih-fabric-current/source-6dc6a5b.tar.gz
```

Remote verification used the deployed Node runtime because non-interactive SSH
does not put `node` on PATH:

```text
/home/ubuntu/aih-fabric-current/.node-runtime/node-v22.16.0-linux-x64/bin/node --check lib/cli/commands/fabric-router.js
/home/ubuntu/aih-fabric-current/.node-runtime/node-v22.16.0-linux-x64/bin/node --check lib/cli/services/fabric/transport-prerequisites.js
/home/ubuntu/aih-fabric-current/.node-runtime/node-v22.16.0-linux-x64/bin/node --test test/fabric-transport-prerequisites.test.js
```

Results:

```text
AWS node --check: pass
AWS test/fabric-transport-prerequisites.test.js: 3/3 pass
```

AWS default `9527` remained healthy after source sync:

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

The committed product command was re-run from the local client against AWS with
the real SSH key and endpoint:

```text
AIH Fabric M6 prerequisite audit
  endpoint: http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527
  base_ready: yes
  promotion_ready: no
  ready_transports: none
  aws: candidate=yes promotion=yes
  turn: candidate=no promotion=no
    - turn_ice_server_not_configured
  webtransport: candidate=no promotion=no
    - webtransport_connect_failed
  multipath: candidate=yes promotion=no
    - local_mptcp_unavailable
    - openmptcprouter_not_detected
    - default_listener_is_plain_http_not_multipath_transport
```

`--fail-on-blocked --json` was re-run after AWS sync and returned process status
`1` with `ok=true`, `exitOk=false`, and `promotionReady=false`.

## Conclusion

Current M6 status remains:

- relay fallback is live and usable;
- WebRTC DataChannel and DataChannel RPC are real candidates;
- WebRTC cannot be promoted without a controlled TURN relay candidate;
- WebTransport cannot be promoted because AWS default `9527` is not an
  HTTPS/H3 WebTransport endpoint;
- multipath cannot be promoted from the current macOS + AWS topology because
  local MPTCP and OpenMPTCPRouter underlay are absent and default `9527` is a
  plain AIH HTTP listener.

Default transport must remain `relay`.
