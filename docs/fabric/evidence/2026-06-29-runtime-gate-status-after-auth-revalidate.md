# 2026-06-29 Runtime gate status after auth revalidate

## Scope

This evidence continues the AWS-only closure work after the selected-provider
runtime-block fix. It records the next real blockers and closes a product-state
bug where Node Inventory could show provider runtimes as `available` while the
same row was blocked by `provider_account_unavailable:*`.

Target:

```text
endpoint=http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527
ssh=ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com
remoteDir=/home/ubuntu/aih-fabric-current
nodeId=aws-current-node
port=9527
```

Only AWS current was used. The old `152.*`, `155.*`, and `39.104.*` servers
were not touched.

## Full closure audit

Command:

```text
node bin/ai-home.js fabric closure audit \
  --node-id aws-current-node \
  --provider opencode \
  --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 \
  --diagnostics-file /tmp/aih-fabric-full-closure-next-20260629.json \
  --json
```

Result summary:

```text
ok=true
status=usable_with_blockers
provider=opencode
runId=70035473-9263-45ba-b270-ce1a5d9a741f
sessionId=ses_0ebeb67b2ffepQuzFjtVUieLTp
marker=AIH_FABRIC_CLOSURE_AUDIT_20260629_155157
events=ready,session-created,delta,result,done
selectedTransportKind=webrtc
fallbackUsed=false
closurePlan.immediateNext=transport-cloud-edge-udp
```

The real next queue was:

```text
1. transport-cloud-edge-udp
2. transport-cloud-api-readback
3. transport-webtransport-h3
4. transport-multipath-underlay
5. provider-agy-blocked
6. provider-claude-blocked
7. provider-codex-blocked
```

## Cloud-edge blocker

The full audit ran the real UDP probe on the default `9527` port:

```text
remote UDP echo ready=true port=9527
local UDP probe ok=false error=udp_echo_timeout sent=13 durationMs=5002
packetCapture.interface=enp39s0
packetCapture.captured=false
tcpdump=0 packets captured / 0 packets received by filter / 0 packets dropped by kernel
hostFirewallBlocksUdp=false
publicIpv4=43.207.102.163
privateAddress=172.31.47.163
securityGroupIds=sg-01e33f3412fabfded,sg-01e7f50a205d7b308
blockers=turn_default_udp_9527_unreachable,aws_public_udp_path_blocked
```

Read-only AWS policy readback is also blocked:

```text
local aws cli=missing
remote aws cli=missing
remote IMDS token=true
remote IAM role probe=http 404
blockers=aws_cli_missing,aws_iam_role_missing,aws_local_cli_missing
```

Conclusion: this is not an AIH session timeout. UDP packets are not reaching
the instance, and AIH currently has no read-only AWS API credentials to inspect
SG/NACL rules. The next real action needs cloud-side UDP `9527` policy readback
or correction.

## Provider auth revalidate

Command:

```text
node bin/ai-home.js fabric provider accounts revalidate \
  --yes \
  --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 \
  --providers codex,claude,agy \
  --json
```

Result summary:

```text
ok=true
mode=remote-revalidate
deployedGitHead=5f58e99661e408de796c334cde2926907b1b14e3
runtimeBlockClear.cleared=12
postClearAudit.runtimeBlocked=0
postSessionAudit.runtimeBlocked=12
conclusion.status=credentials_still_invalid
providersAttempted=codex,claude,agy
providersValidated=none
providersBlocked=codex,claude,agy
```

The command proved that clearing stale runtime blocks is not enough; real
session guards immediately reproduce the auth failures:

```text
codex account=2 run=d19f525a-19df-46e6-83b3-db0acf783789 reason=auth_invalid:upstream_401 markerFound=false transport=webrtc fallbackUsed=false
claude accounts=1,2,3,4 lastRun=f10cf76b-6a9c-4a3d-96fd-5b2e7f83ff96 reason=auth_invalid:claude_not_logged_in markerFound=false transport=webrtc fallbackUsed=false
agy accounts=1,2,3,4,5,6,7 lastRun=e6ca3074-0ba8-4967-992a-656ba4933150 reason=auth_invalid:agy_not_signed_in markerFound=false transport=webrtc fallbackUsed=false
```

This is real provider credential state on AWS. AIH must not claim these
providers are ready until AWS-side login/import/reauth is completed.

## Product bug found

After the real revalidate, `fabric nodes aws-current-node --json` still
correctly disabled `start-session:codex|claude|agy`, but the action
`runtimeStatus` and `runtimeGaps[].status` were derived from the raw runtime
snapshot and still displayed `available`.

That was misleading because the same object also carried:

```text
provider_account_unavailable:codex
provider_account_unavailable:claude
provider_account_unavailable:agy
```

## Fix

When runtime diagnostics produce a provider account blocker, the Node Inventory
gate now reports the provider runtime gate as `degraded` even if the raw runtime
binary is present and the registry runtime row says `available`.

The raw runtime row is preserved; only the gate/status shown on
`runtimeGaps[]` and `start-session:*` actions is degraded.

## Local verification

Commands:

```text
node --check lib/server/fabric-node-inventory.js
node --test test/fabric-nodes-client.test.js
node --test test/fabric-closure-audit.test.js test/fabric-session-client.test.js
node --test test/fabric-provider-accounts.test.js test/fabric-nodes-client.test.js test/fabric-closure-audit.test.js
```

Results:

```text
fabric-nodes-client: 6/6 pass
closure-audit adjacent: 10/10 pass
provider/nodes/closure focused: 28/28 pass
```

Scoped commit:

```text
71fc5c4cc3f386972b390fd90cbe51775ee2876d
fix(fabric): degrade blocked provider runtime gates
```

Staged set before commit:

```text
M lib/server/fabric-node-inventory.js
M test/fabric-nodes-client.test.js
```

`git diff --cached --check` passed.

## AWS deployment

Artifact:

```text
local=/tmp/aih-fabric-head-71fc5c4.tar.gz
remote=/home/ubuntu/aih-fabric-current/source-71fc5c4.tar.gz
sha256=0a04dd9f8821b84afe00dc060de0f741112ec59eafb41fc8c5fde77941288a15
remote sha256 readback=0a04dd9f8821b84afe00dc060de0f741112ec59eafb41fc8c5fde77941288a15
DEPLOYED_GIT_HEAD=71fc5c4cc3f386972b390fd90cbe51775ee2876d
```

Remote focused verification:

```text
./.node-runtime/node-v22.16.0-linux-x64/bin/node --check lib/server/fabric-node-inventory.js
./.node-runtime/node-v22.16.0-linux-x64/bin/node --test test/fabric-nodes-client.test.js test/fabric-closure-audit.test.js test/fabric-provider-accounts.test.js
remote focused tests: 28/28 pass
```

AWS default `9527` restart:

```text
old node pid=483367
wrapper pid=487269
new node pid=487271
readyz.ok=true
readyz.ready=true
accounts=codex:1,gemini:0,claude:4,agy:7,opencode:1
```

Runtime environment readback:

```text
HOME=/home/ubuntu/aih-fabric-current/.aih-host-home
AIH_HOST_HOME=/home/ubuntu/aih-fabric-current/.aih-host-home
AIH_HOME=/home/ubuntu/aih-fabric-current/.aih-host-home/.ai_home
AI_HOME=/home/ubuntu/aih-fabric-current/.aih-host-home/.ai_home
AIH_SERVER_DISABLE_SOURCE_AUTO_RESTART=1
AIH_SERVER_STRICT_PORT=1
```

The `nohup` wrapper stayed alive again after node readiness. It was cleaned by
killing only wrapper pid `487269`; node pid `487271` remained ready.

## Real node readback after deploy

Command:

```text
node bin/ai-home.js fabric nodes aws-current-node \
  --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 \
  --json
```

Result summary:

```text
summary.targetRuntimeGaps:
  codex status=degraded blocker=provider_account_unavailable:codex
  claude status=degraded blocker=provider_account_unavailable:claude
  agy status=degraded blocker=provider_account_unavailable:agy

actions:
  start-session:codex enabled=false runtimeStatus=degraded blockers=provider_account_unavailable:codex
  start-session:claude enabled=false runtimeStatus=degraded blockers=provider_account_unavailable:claude
  start-session:agy enabled=false runtimeStatus=degraded blockers=provider_account_unavailable:agy
  start-session:opencode enabled=true runtimeStatus=available blockers=none
```

## Real session proof after deploy

Command:

```text
node bin/ai-home.js fabric closure audit \
  --node-id aws-current-node \
  --provider opencode \
  --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 \
  --skip-cloud-edge \
  --diagnostics-file /tmp/aih-fabric-runtime-gate-status-71fc5c4-closure.json \
  --json
```

Result summary:

```text
ok=true
status=usable_with_blockers
runId=3530daec-be7a-41a5-bec7-c15bf7f59d29
sessionId=ses_0ebe27861ffe01ik69qmiXQr3g
events=ready,session-created,delta,result,done
markerFound=true
doneObserved=true
eventCount=5
selectedTransportKind=webrtc
fallbackUsed=false
provider=opencode
```

## Remaining blockers

```text
cloud-edge UDP 9527: packet does not reach AWS instance; SG/NACL/read-only AWS API access required
codex: real AWS-side credential still returns auth_invalid:upstream_401
claude: real AWS-side credential still returns auth_invalid:claude_not_logged_in
agy: real AWS-side OAuth state still returns auth_invalid:agy_not_signed_in
webtransport: real HTTPS/H3 endpoint required
multipath: real OpenMPTCPRouter/MPTCP underlay required
```
