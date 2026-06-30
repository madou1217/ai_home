# 2026-06-29 Selected provider runtime block plan

## Scope

This closes the loop for a repeated AWS-only failure mode: the selected
provider looked schedulable in node inventory, but the real session later
emitted a provider runtime block. The closure plan then pointed at a generic
session retry instead of the provider repair command.

Target:

```text
endpoint=http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527
ssh=ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com
remoteDir=/home/ubuntu/aih-fabric-current
nodeId=aws-current-node
provider=opencode
port=9527
```

Only AWS current was used. The old `152.*`, `155.*`, and `39.104.*` servers
were not touched.

## Root cause

The real failed audit was saved at:

```text
/tmp/aih-fabric-continuation-20260629-233044.json
```

Failure summary:

```text
ok=false
status=blocked
targetProviderReady=true
sessionReady=false
runId=1f981466-5c47-4059-bdae-c54774f8076d
selectedTransportKind=webrtc
fallbackUsed=false
events=ready,session-created,runtime-blocked,delta,result
markerFound=true
doneObserved=false
blockers=runtime_blocked:opencode:upstream_401,session_done_not_observed
old immediateNext=session-marker-proof-blocked
old command=aih fabric closure audit --node-id aws-current-node --provider opencode --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 --json
```

This was not a WebRTC, relay, SSH, or timeout problem. The selected provider
account failed during the real runtime session. Retrying the same session proof
without repairing the provider account can only repeat the failure.

## Product fix

`closurePlan` now inspects selected-provider session blockers such as:

```text
runtime_blocked:opencode:upstream_401
```

When that happens, the selected provider item becomes the immediate next step:

```text
id=provider-opencode-blocked
status=blocked_external
command=aih fabric provider accounts revalidate --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 --providers opencode --yes --json
nextQueue=provider-opencode-blocked,session-marker-proof-blocked,transport-cloud-edge-udp
```

Provider blocker commands and blocker catalog details now include the current
server endpoint, so the displayed command is directly runnable against the
paired AWS server profile instead of silently targeting the wrong default.

## Local verification

Commands:

```text
node --check lib/cli/services/fabric/closure-plan.js
node --check lib/cli/services/fabric/blocker-catalog.js
node --test test/fabric-blocker-catalog.test.js test/fabric-closure-audit.test.js
node --test test/fabric-provider-accounts.test.js test/fabric-session-client.test.js test/fabric-nodes-client.test.js test/fabric-transport-status.test.js test/fabric-closure-audit.test.js
npm test
```

Results:

```text
focused blocker/closure tests: 15/15 pass
expanded fabric focused tests: 35/35 pass
full npm test: 2865/2865 pass, duration_ms=164526.292833
```

Real failed JSON replay with the new plan:

```text
state=blocked
immediateNext.id=provider-opencode-blocked
immediateNext.command=aih fabric provider accounts revalidate --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 --providers opencode --yes --json
nextQueue=provider-opencode-blocked,session-marker-proof-blocked,transport-cloud-edge-udp
```

Scoped commit:

```text
5f58e99661e408de796c334cde2926907b1b14e3
fix(fabric): prioritize provider revalidation after runtime blocks
```

Staged set before commit:

```text
M lib/cli/services/fabric/blocker-catalog.js
M lib/cli/services/fabric/closure-plan.js
M test/fabric-blocker-catalog.test.js
M test/fabric-closure-audit.test.js
```

`git diff --cached --check` passed.

## AWS deployment

Artifact:

```text
local=/tmp/aih-fabric-head-5f58e99.tar.gz
remote=/home/ubuntu/aih-fabric-current/source-5f58e99.tar.gz
sha256=573cc1bf6cbaf57dc1eba7ee7ece576a37de40bbc33bc76df95370205db66f4b
remote sha256 readback=573cc1bf6cbaf57dc1eba7ee7ece576a37de40bbc33bc76df95370205db66f4b
DEPLOYED_GIT_HEAD=5f58e99661e408de796c334cde2926907b1b14e3
```

Remote focused verification:

```text
./.node-runtime/node-v22.16.0-linux-x64/bin/node --test test/fabric-blocker-catalog.test.js test/fabric-closure-audit.test.js
remote focused tests: 15/15 pass
```

AWS default `9527` restart:

```text
old node pid=478728
wrapper pid=483365
new node pid=483367
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

The `nohup` startup wrapper stayed alive after the node child was ready. This
is an operational wrapper behavior, not a Fabric runtime failure. It was
cleaned by killing only wrapper pid `483365`; node pid `483367` remained ready.

The remote `setlocale` warning is still benign and unrelated to Fabric state.

## Real revalidate proof

Command:

```text
node bin/ai-home.js fabric provider accounts revalidate \
  --yes \
  --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 \
  --providers opencode \
  --json
```

Result summary:

```text
ok=true
mode=remote-revalidate
deployedGitHead=5f58e99661e408de796c334cde2926907b1b14e3
remoteAudit.opencode.runtimeBlocked=0
postClearAudit.opencode.runtimeBlocked=0
postSessionAudit.opencode.runtimeBlocked=0
managementReload.reloaded=13
registryPublish.ok=true
registryPublish.runtimes=4
registryPublish.transports=2
readyz.ready=true
sessionStarts[0].provider=opencode
sessionStarts[0].runId=a7aa271d-52ea-4654-a425-fd6ee10a6257
sessionStarts[0].ok=true
sessionStarts[0].markerFound=true
sessionStarts[0].transportKind=webrtc
sessionStarts[0].fallbackUsed=false
sessionStarts[0].events=ready,session-created,delta,result,done
conclusion.status=provider_session_validated
conclusion.providersValidated=opencode
```

## Real closure audit proof

Command:

```text
node bin/ai-home.js fabric closure audit \
  --node-id aws-current-node \
  --provider opencode \
  --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 \
  --skip-cloud-edge \
  --diagnostics-file /tmp/aih-fabric-provider-runtime-block-plan-5f58e99-healthy.json \
  --json
```

Result summary:

```text
ok=true
status=usable_with_blockers
runId=ef27fb6e-ee50-43e1-961b-13bdf01cd8f8
sessionId=ses_0ebf1cf9effeI8F5CHSyZ7qQ5e
marker=AIH_FABRIC_CLOSURE_AUDIT_20260629_154458
markerFound=true
doneObserved=true
eventCount=5
events=ready,session-created,delta,result,done
selectedTransportKind=webrtc
fallbackUsed=false
closurePlan.state=usable_with_external_blockers
immediateNext=transport-webtransport-h3
```

The current business path is closed again: a local client can use the paired AWS
server profile, select `aws-current-node`, start a real AWS `opencode` session,
and receive the canonical stream over WebRTC.

## Failure ledger

The failures from this loop are now classified:

```text
runtime_blocked:opencode:upstream_401
cause=selected provider account failed during real session proof
fix=closurePlan immediateNext points to provider accounts revalidate with endpoint
repeat prevention=test/fabric-closure-audit.test.js covers runtime-blocked selected provider priority
```

```text
generic session retry loop
cause=old plan ignored selected-provider runtime blocker after session start
fix=provider-opencode-blocked ranks before session-marker-proof-blocked
repeat prevention=real failed diagnostics replay validates nextQueue order
```

```text
wrong or incomplete provider command
cause=provider blocker command omitted endpoint in some plan/catalog surfaces
fix=provider audit/revalidate commands include --endpoint when context has one
repeat prevention=test/fabric-blocker-catalog.test.js checks endpoint in command
```

```text
npm test looked slow or noisy
cause=large suite output can be truncated; the suite itself passed
fix=record final TAP summary before making a failure judgment
evidence=2865/2865 pass, duration_ms=164526.292833
```

```text
AWS startup command did not return immediately
cause=nohup wrapper bash stayed alive while node child was already ready
fix=verify child node and /readyz, then kill wrapper only
repeat prevention=do not kill the child node when readyz is healthy
```

## Remaining blockers

These are still real external prerequisites, not software-side closure failures:

```text
codex=auth_invalid:upstream_401
claude=auth_invalid:claude_not_logged_in
agy=auth_invalid:agy_not_signed_in
webtransport=real HTTPS/H3 endpoint required
multipath=real OpenMPTCPRouter/MPTCP underlay required
udp_turn_cloud_edge=controlled UDP/TURN path or AWS SG/NACL/read-only API access required
```
