# 2026-06-29 Closure plan provider priority

## Scope

This closes the loop where a selected provider account blocker could be hidden
behind a generic session retry step in `closurePlan.nextQueue`.

No mock data was used. The real target was AWS current:

```text
endpoint=http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527
nodeId=aws-current-node
provider=codex
```

## Root cause

`closurePlan` ranked every `blocked` item before every `blocked_external` item.
When Codex was not schedulable on AWS, the plan contained both:

- `provider-codex-blocked`
- `session-marker-proof-blocked`

The generic session blocker ranked first, so the immediate next action told the
operator to rerun session proof before fixing the real provider account blocker.
That was a product planning bug and could cause repeated no-op session retries.

## Fix

Plan ranking now separates:

1. `action_required` node/profile blockers
2. selected provider blocker
3. generic session/runtime blocked proof
4. unchecked session proof
5. transport/cloud/network external blockers
6. non-selected provider blockers

This does not change transport, provider, or session detection. It only changes
the order of the next actionable item.

## Local verification

```text
node --check lib/cli/services/fabric/closure-plan.js
node --test test/fabric-closure-audit.test.js
```

Result:

```text
fabric closure audit tests: 10/10 pass
```

New regression coverage:

```text
fabric closure audit prioritizes selected provider blocker before session retry
```

## Real AWS verification

Command shape:

```text
node -e 'runFabricClosureAudit({ nodeId:"aws-current-node", provider:"codex", sessionMarker:"AIH_CODEX_PLAN_ORDER_REAL_20260629", eventTimeoutMs:10000, sessionTimeoutMs:30000 })'
```

Result summary:

```text
ok=false
status=blocked
coreReady=false
targetProviderReady=false
sessionReady=false
runtimeBlockers=agy:provider_account_unavailable,claude:provider_account_unavailable,codex:provider_account_unavailable
sessionProof.runId=
sessionProof.ok=false
sessionProof.blockers=provider_account_unavailable:codex
```

Immediate next:

```text
id=provider-codex-blocked
status=blocked_external
owner=operator
priority=10
command=aih fabric provider accounts audit --providers codex --json
```

Next queue:

```text
1. provider-codex-blocked
2. session-marker-proof-blocked
3. transport-cloud-edge-udp
4. transport-cloud-api-readback
5. transport-webtransport-h3
```

## Remaining work after this fix

The product now points at the correct next blocker. It does not make Codex
schedulable. The real remaining Codex blocker is still AWS-side provider auth:

```text
provider_account_unavailable:codex
auth_invalid:upstream_401
```

## Reauth command wiring

A follow-up gap remained after the priority fix: the provider blocker pointed
at the correct item, but the first command was still a read-only audit. The node
runtime diagnostics already contain real `sampleAccountIds`, so the plan can
offer the concrete remote reauth command without guessing.

Current AWS diagnostic readback:

```text
codex sampleAccountIds=2 reason=runtime:auth_invalid:upstream_401
claude sampleAccountIds=1,2,3,4 reason=runtime:auth_invalid:claude_not_logged_in
agy sampleAccountIds=1,2,3,4,5 reason=runtime:auth_invalid:agy_not_signed_in
```

The plan now extracts the first sample account id from the selected provider's
diagnostic and prepends:

```text
aih fabric provider accounts reauth --provider <provider> --account-id <id> --endpoint <server> --json
```

When no sample account id exists, it falls back to audit/revalidate commands
and does not invent an account id.

Local verification:

```text
node --check lib/cli/services/fabric/closure-plan.js
node --test test/fabric-closure-audit.test.js
```

Result:

```text
fabric closure audit tests: 10/10 pass
```

Real AWS Codex readback after this change:

```text
marker=AIH_CODEX_REAUTH_COMMAND_REAL_20260629
ok=false
status=blocked
targetProviderReady=false
sessionReady=false
immediateNext.id=provider-codex-blocked
immediateNext.requiresConfirmation=true
immediateNext.command=aih fabric provider accounts reauth --provider codex --account-id 2 --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 --json
nextQueue[0]=provider-codex-blocked
nextQueue[1]=session-marker-proof-blocked
providerItem.commands[0]=aih fabric provider accounts reauth --provider codex --account-id 2 --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 --json
```

The reauth command was not executed in this step because it starts a real remote
auth job and requires an operator to complete the returned flow. The product now
shows the exact command required to proceed.

## Deployment

Runtime commit deployed to AWS current:

```text
6d2ba72980a9a584c06a38ba1dbc6bdfecccbbb7
```

Source artifact:

```text
/tmp/aih-fabric-head-6d2ba72.tar.gz
sha256=25d1bae5291bcb5c80e2817b81f15531221dda0ca6b11e3997b06e03ed95d498
remote=/home/ubuntu/aih-fabric-current/source-6d2ba72.tar.gz
sha256sum -c: OK
```

AWS focused verification after unpack:

```text
./.node-runtime/node-v22.16.0-linux-x64/bin/node --check lib/cli/services/fabric/closure-plan.js
./.node-runtime/node-v22.16.0-linux-x64/bin/node --test test/fabric-closure-audit.test.js
```

Result:

```text
remote focused tests: 10/10 pass
```

The default `9527` server was restarted on the same port with the same host-home environment:

```text
old pid=453080
new pid=455026
new ppid=1
DEPLOYED_GIT_HEAD=6d2ba72980a9a584c06a38ba1dbc6bdfecccbbb7
readyz.ready=true
accounts=codex:1,claude:4,agy:7,opencode:1
AIH_HOST_HOME=/home/ubuntu/aih-fabric-current/.aih-host-home
HOME=/home/ubuntu/aih-fabric-current/.aih-host-home
AIH_HOME=/home/ubuntu/aih-fabric-current/.aih-host-home/.ai_home
AI_HOME=/home/ubuntu/aih-fabric-current/.aih-host-home/.ai_home
AIH_SERVER_DISABLE_SOURCE_AUTO_RESTART=1
AIH_SERVER_STRICT_PORT=1
```

Post-deploy real AWS Codex gate:

```text
marker=AIH_CODEX_REAUTH_COMMAND_POST_DEPLOY_20260629
ok=false
status=blocked
targetProviderReady=false
sessionReady=false
immediateNext.id=provider-codex-blocked
immediateNext.requiresConfirmation=true
immediateNext.command=aih fabric provider accounts reauth --provider codex --account-id 2 --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 --json
nextQueue[0]=provider-codex-blocked
nextQueue[1]=session-marker-proof-blocked
nextQueue[2]=transport-cloud-edge-udp
sessionProof.ok=false
sessionProof.blockers=provider_account_unavailable:codex
```

Post-deploy real business stream proof uses the current schedulable provider
instead of retrying blocked Codex:

```text
provider=opencode
marker=AIH_OPENCODE_BUSINESS_STREAM_CLOSE_20260629
runId=76b21038-1bf9-4ac5-a936-ae8e698db819
sessionId=ses_0ec70e323ffe04qBNSLd6sthXX
projectPath=/home/ubuntu/aih-fabric-current
status=completed
events=ready,session-created,delta,result,done
cursor=5
markerFound=true
doneObserved=true
selectedTransportKind=webrtc
fallbackUsed=false
```

Transport status after the same stream proof:

```text
status=complete
remoteDevelopmentReady=true
defaultTransport=webrtc
fallbackReady=true
advancedPromotionReady=true
cloudEdgeReady=false
udpReachable=false
packetArrivalCaptured=false
hostFirewallBlocksUdp=false
cloudApiCredentialsReady=false
securityGroupIds=sg-01e33f3412fabfded,sg-01e7f50a205d7b308
blockers=webtransport:webtransport_endpoint_not_configured,webtransport:webtransport_not_promoted,omr:openmptcprouter_not_detected,mptcp:mptcp_data_plane_not_promoted,turn_default_udp_9527_unreachable,aws_public_udp_path_blocked,aws_cli_missing,aws_iam_role_missing,aws_local_cli_missing
```

## Failure ledger

These are the causes that made this look like a loop:

1. `closurePlan` sorted generic session blockers before the selected provider
   blocker. This made the product tell the operator to rerun Codex session proof
   even though Codex could not be scheduled. The fix is the selected-provider
   priority rule and the regression test in `test/fabric-closure-audit.test.js`.
2. The provider blocker originally offered a read-only audit as the first
   command. That was correct but not actionable enough. The plan now extracts
   the real `sampleAccountIds` from node diagnostics and puts the concrete
   remote `reauth` command first without inventing account ids.
3. Codex is not a transport or timeout failure. Current AWS truth is
   `provider_account_unavailable:codex` with account `2` blocked by
   `auth_invalid:upstream_401`. Re-running session proof before reauth is a
   no-op.
4. The currently closed business path is `opencode` over WebRTC. It produced a
   real remote run, canonical `delta/result/done` events, and `fallbackUsed=false`.
5. `transport status` takes about 10 seconds because `cloud-edge` performs the
   real UDP echo and packet-capture timeout window. That latency is diagnostic
   cost, not a hung session.
6. Advanced transport blockers are external prerequisites, not core business
   blockers: AWS public UDP `9527` packets do not reach `enp39s0`, AWS CLI/IAM
   readback is unavailable, WebTransport lacks a HTTPS/H3 endpoint, and
   OpenMPTCPRouter/MPTCP underlay is not present.

The next product action is therefore deterministic: keep `opencode` as the
current working business proof, and only attempt Codex after the returned
remote reauth flow is completed by an operator.
