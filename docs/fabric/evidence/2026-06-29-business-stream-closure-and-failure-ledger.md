# 2026-06-29 Business stream closure and failure ledger

## Scope

This evidence closes the current AWS-only business path without mock data:

```text
endpoint=http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527
ssh=ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com
remoteDir=/home/ubuntu/aih-fabric-current
nodeId=aws-current-node
provider=opencode
port=9527
```

The old `152.*`, `155.*`, and `39.104.*` servers were not touched.

## Runtime proof

AWS current is running the deployed Fabric server on the default port:

```text
readyz.ok=true
readyz.ready=true
accounts=codex:1,claude:4,agy:7,opencode:1
pid=461644
command=./.node-runtime/node-v22.16.0-linux-x64/bin/node bin/ai-home.js server serve --host 0.0.0.0 --port 9527
DEPLOYED_GIT_HEAD=5fdfc6fffbf6e8c706f6edc6bc975cdbb7d0f8b8
```

The process environment is isolated to the AWS deployment and is not using the
local macOS profile store:

```text
HOME=/home/ubuntu/aih-fabric-current/.aih-host-home
AIH_HOST_HOME=/home/ubuntu/aih-fabric-current/.aih-host-home
AIH_HOME=/home/ubuntu/aih-fabric-current/.aih-host-home/.ai_home
AI_HOME=/home/ubuntu/aih-fabric-current/.aih-host-home/.ai_home
AIH_SERVER_DISABLE_SOURCE_AUTO_RESTART=1
AIH_SERVER_STRICT_PORT=1
```

## Node product proof

Command:

```text
node bin/ai-home.js fabric nodes aws-current-node --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 --json
```

Result summary:

```text
profile=cp-51hq70
registry.nodes=2
registry.relayNodes=2
registry.transports=3
registry.projects=2
registry.runtimes=8
aws.roles=node,relay-node
aws.transportKinds=relay,webrtc
aws.runtimeProviders=agy,claude,codex,opencode
aws.sshBootstrap=true
aws.projectHost=true
aws.runtimeHost=true
open-project.enabled=true
start-session:opencode.enabled=true
configure-ssh.enabled=true
run-measurement.enabled=true
```

The same readback shows why the other providers cannot be used yet:

```text
codex cli=yes account_total=1 schedulable=0 reason=runtime:auth_invalid:upstream_401 sampleAccountIds=2
claude cli=yes account_total=4 schedulable=0 reason=runtime:auth_invalid:claude_not_logged_in sampleAccountIds=1,2,3,4
agy cli=yes account_total=7 schedulable=0 reason=runtime:auth_invalid:agy_not_signed_in sampleAccountIds=1,2,3,4,5
```

This means AWS current is a runtime host, but only `opencode` is currently
schedulable.

## Business stream proof

Command:

```text
node bin/ai-home.js fabric closure audit \
  --node-id aws-current-node \
  --provider opencode \
  --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 \
  --session-marker AIH_OPENCODE_CLOSURE_STREAM_20260629_2150 \
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
nodeReady=true
transportReady=true
targetProviderReady=true
sessionReady=true
selectedTransportKind=webrtc
fallbackUsed=false
provider=opencode
accountId=1
runId=551624ef-7834-4fd0-87a6-c576ba5cf4a5
sessionId=ses_0ec5c4a11ffexYWOsvYGr5Y2ES
projectPath=/home/ubuntu/aih-fabric-current
cursor=5
completed=true
eventCount=5
events=ready,session-created,delta,result,done
marker=AIH_OPENCODE_CLOSURE_STREAM_20260629_2150
markerFoundIn=delta,result,done
```

This is the current business closure: a local client can select the paired AWS
server profile, use `aws-current-node`, start a real AWS `opencode` session,
and receive the canonical stream over WebRTC without falling back to relay.

## Transport proof

Current runtime status readback:

```text
node bin/ai-home.js fabric transport status \
  --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 \
  --node-id aws-current-node \
  --skip-cloud-edge \
  --json
```

Result summary:

```text
remoteDevelopmentReady=true
defaultTransport=webrtc
fallbackReady=true
relayMeasurementPass=true
advancedPromotionReady=true
promotedTransports=webrtc
```

Strict aggregate gate without direct WebRTC promotion:

```text
node bin/ai-home.js fabric transport promotion-gate \
  --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 \
  --node-id aws-current-node \
  --json
```

Result summary:

```text
relay=20/20 p95=101ms
webrtc.candidateReady=true
webrtc.rtt.p95=419ms
webrtc.rpc.ok=true
webrtc.rpc.p95=418.8ms
webrtc.selectedCandidatePair=srflx->srflx
webrtc.promotionReady=false
webrtc.blockers=turn_relay_gate_not_ready
summary.promotionReady=false
summary.defaultTransport=relay
```

Runtime-aligned gate with direct WebRTC promotion explicitly enabled:

```text
node bin/ai-home.js fabric transport promotion-gate \
  --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 \
  --node-id aws-current-node \
  --allow-direct-webrtc-promotion \
  --json
```

Result summary:

```text
relay=20/20 p95=114ms
webrtc.candidateReady=true
webrtc.promotionReady=true
webrtc.promotionMode=direct
webrtc.rtt.p95=804.5ms
webrtc.rpc.ok=true
webrtc.rpc.p95=805.1ms
webrtc.selectedCandidatePair=srflx->srflx
directPairVerified=true
summary.promotionReady=true
summary.defaultTransport=webrtc
summary.fallbackReady=true
summary.blockers=[]
summary.nonPromotedGateBlockers=turn:turn_ice_server_not_configured,turn:turn_default_udp_9527_unreachable,webtransport:webtransport_connect_failed,multipath:local_mptcp_unavailable,multipath:openmptcprouter_not_detected,multipath:default_listener_is_plain_http_not_multipath_transport
```

Interpretation:

1. The current product data path is WebRTC direct, and the real session proof
   used it.
2. Relay is still healthy and remains the fallback path.
3. TURN, WebTransport, and multipath are still independent advanced paths; they
   must not be marked complete from the direct WebRTC proof.

## Cloud-edge proof

The closure audit also ran the real cloud-edge probe serially:

```text
remote UDP echo ready=true port=9527
local UDP probe ok=false error=udp_echo_timeout sent=13 durationMs=5002
packetCapture.interface=enp39s0
packetCapture.captured=false
packetCapture.stderr=0 packets captured / 0 packets received by filter / 0 packets dropped by kernel
hostFirewallBlocksUdp=false
publicIpv4=43.207.102.163
privateAddress=172.31.47.163
securityGroupIds=sg-01e33f3412fabfded,sg-01e7f50a205d7b308
```

Cloud API readback is also blocked by missing read-only tooling/permission:

```text
remote awsCli.available=false
remote imds.tokenAvailable=true
remote iamRoleAvailable=false
remote iamRoleProbeHttpStatus=404
local awsCli.available=false
blockers=aws_cli_missing,aws_iam_role_missing,aws_local_cli_missing
```

## Failure ledger

These are the current failure causes and how to avoid repeating the same loop:

| Symptom | Real cause | Current handling | Next action |
|---|---|---|---|
| Codex session retries or timeout | AWS Codex account exists but is not schedulable: `auth_invalid:upstream_401` | Do not retry session proof before auth is fixed | `aih fabric provider accounts reauth --provider codex --account-id 2 --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 --json` |
| Claude session retries or timeout | AWS Claude accounts are not logged in: `auth_invalid:claude_not_logged_in` | Treat as operator auth blocker | `aih fabric provider accounts reauth --provider claude --account-id 1 --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 --json` |
| AGY session retries or timeout | AWS AGY accounts are not signed in: `auth_invalid:agy_not_signed_in` | Treat as operator auth blocker | `aih fabric provider accounts reauth --provider agy --account-id 1 --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 --json` |
| UDP diagnostic returns `turn_default_udp_probe_busy` | Two diagnostics tried to bind AWS UDP `9527` at the same time | Fixed in commit `5fdfc6f`: classify as diagnostic concurrency, not cloud failure | Run only one default UDP diagnostic at a time |
| UDP `9527` timeout | Packets do not arrive at AWS `enp39s0`; host firewall is not blocking | Recorded as cloud-edge external blocker | Check Security Group inbound UDP `9527` and subnet NACL return path |
| Cannot inspect SG/NACL automatically | AWS CLI is missing locally/remotely and the instance has no read-only IAM role | Reported as diagnostic blocker, not a network blocker | Install/configure read-only AWS CLI or attach read-only EC2 IAM role |
| WebTransport fails | Default `9527` listener is plain HTTP, not HTTPS/H3 WebTransport | Kept as advanced blocker | Provide a real HTTPS/H3 endpoint and rerun `transport webtransport` |
| Multipath remains blocked | Local macOS has no generic MPTCP socket, no OpenMPTCPRouter detected, AWS `9527` is plain HTTP | Kept as advanced blocker | Validate real OMR/MPTCP underlay before promotion |
| Strict promotion gate says `relay` while runtime uses WebRTC | Gate default requires TURN relay for WebRTC promotion; runtime has direct WebRTC already published | Documented as product semantics split | Use `--allow-direct-webrtc-promotion` when validating the current direct WebRTC runtime path |

## Remaining work

1. Keep `opencode` as the current schedulable AWS provider until Codex/Claude/AGY
   finish real remote auth.
2. Do not rerun blocked provider session proof before the matching reauth job is
   completed.
3. Keep cloud-edge diagnostics serial to avoid `turn_default_udp_probe_busy`.
4. Split product language between current data path and stricter advanced
   transport prerequisites:
   - current data path: WebRTC direct, relay fallback
   - advanced prerequisites: TURN relay, HTTPS/H3 WebTransport, MPTCP/OMR
