# 2026-06-29 Provider accounts profile targeting

## Scope

This closes the provider-account management gap where a local client could see a
paired AWS server profile, but `fabric provider accounts audit|revalidate` still
required manual SSH flags.

Final target:

```text
endpoint=http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527
ssh=ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com
remoteDir=/home/ubuntu/aih-fabric-current
nodeId=aws-current-node
port=9527
```

The old `152.*`, `155.*`, and `39.104.*` servers were not touched.

## Fix

`fabric provider accounts audit|revalidate` now accepts:

```text
--endpoint URL
--profile-id ID
```

When either flag is present, the command reads the paired server profile and
node inventory, selects the node `localSshBindings[]`, then derives the runtime
activation target:

```text
--node-id
--ssh
--remote-dir
--port
```

Explicit `--ssh`, `--remote-dir`, `--node-id`, or `--port` still wins. If no
node SSH binding exists and no explicit SSH target was supplied, the command
fails with a direct `target node has no local SSH binding` error instead of
guessing.

No local provider credentials are uploaded by this path.

## Local verification

```text
node --check lib/cli/services/fabric/provider-accounts.js
node --check lib/cli/commands/fabric-router.js
node --test test/fabric-provider-accounts.test.js test/fabric-runtime-account-activation.test.js test/fabric-closure-audit.test.js
node --test test/repository-policy.test.js
npm test
```

Results:

```text
focused provider/runtime/closure: 35/35 pass
repository policy: 2/2 pass
full npm test: 2860/2860 pass
```

Scoped commit:

```text
9d7c09fd8a53c65612d7c9863364fedee423d69a
fix(fabric): resolve provider account targets from profiles
```

Staged set before commit:

```text
M lib/cli/commands/fabric-router.js
M lib/cli/services/fabric/provider-accounts.js
M test/fabric-provider-accounts.test.js
```

`git diff --cached --check` passed.

## AWS deployment

Clean artifact from `HEAD`:

```text
local=/tmp/aih-fabric-head-9d7c09f.tar.gz
remote=/home/ubuntu/aih-fabric-current/source-9d7c09f.tar.gz
sha256=63c7996bf99f89ec900238b48f57f6bdc6b84d24725a987d07da4156b41151e4
remote sha256 readback=63c7996bf99f89ec900238b48f57f6bdc6b84d24725a987d07da4156b41151e4
DEPLOYED_GIT_HEAD=9d7c09fd8a53c65612d7c9863364fedee423d69a
```

Remote verification before restart:

```text
node --check lib/cli/services/fabric/provider-accounts.js
node --check lib/cli/commands/fabric-router.js
node --test test/fabric-provider-accounts.test.js test/fabric-runtime-account-activation.test.js test/fabric-closure-audit.test.js
```

Result:

```text
remote focused tests: 35/35 pass
```

AWS default `9527` restart:

```text
old pid=466493
new node pid=470602
readyz.ok=true
readyz.ready=true
accounts=codex:1,gemini:0,claude:4,agy:7,opencode:1
```

Only the node child was kept:

```text
470602 ./.node-runtime/node-v22.16.0-linux-x64/bin/node bin/ai-home.js server serve --host 0.0.0.0 --port 9527
```

## Real endpoint-only provider audit

Command:

```text
node bin/ai-home.js fabric provider accounts audit \
  --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 \
  --providers codex,claude,agy,opencode \
  --json
```

Result summary:

```text
ok=true
mode=remote-audit
target.ssh=ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com
target.remoteDir=/home/ubuntu/aih-fabric-current
target.nodeId=aws-current-node
target.port=9527
remoteAudit.target.deployedGitHead=9d7c09fd8a53c65612d7c9863364fedee423d69a
summary.profileCount=13
summary.configured=13
summary.runtimeBlocked=12
opencode.runtimeBlocked=0
codex.runtimeReason=auth_invalid:upstream_401
claude.runtimeReason=auth_invalid:claude_not_logged_in
agy.runtimeReason=auth_invalid:agy_not_signed_in
```

This proves the local client can pass only `--endpoint`, and the command reaches
the correct AWS runtime through the paired profile/node registry.

## Real endpoint-only revalidation

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
target.ssh=ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com
target.remoteDir=/home/ubuntu/aih-fabric-current
target.nodeId=aws-current-node
target.port=9527
provider=opencode
runId=315ab0a7-4e5e-458e-bef8-1e633f1f54e1
transportKind=webrtc
fallbackUsed=false
eventCount=5
events=ready,session-created,delta,result,done
markerFound=true
registryPublish.ok=true
managementReload.ok=true
```

Only `opencode` was revalidated here. Codex, Claude, and AGY were not
revalidated because their account blockers are already known and require real
operator-side login/reauth.

## Real business stream proof

Command:

```text
node bin/ai-home.js fabric closure audit \
  --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 \
  --node-id aws-current-node \
  --provider opencode \
  --session-marker AIH_PROFILE_TARGETING_DEPLOY_STREAM_20260629_2228 \
  --event-timeout-ms 60000 \
  --session-timeout-ms 120000 \
  --skip-cloud-edge \
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
runId=32d44d89-665f-4597-a112-fcd1ac6e894b
sessionId=ses_0ec37ec1affe7Kwn0bvdMA2Cb3
accountId=1
projectPath=/home/ubuntu/aih-fabric-current
cursor=5
completed=true
eventCount=5
events=ready,session-created,delta,result,done
marker=AIH_PROFILE_TARGETING_DEPLOY_STREAM_20260629_2228
markerFoundIn=delta,result,done
```

Current business closure:

```text
local client -> paired AWS server profile -> aws-current-node -> opencode runtime -> WebRTC stream -> canonical done event
```

## Failure ledger

These are the concrete causes observed in this closure loop:

| Symptom | Cause | Resolution / next guard |
|---|---|---|
| `fabric provider accounts audit --endpoint ...` failed with `unknown option: --endpoint` | The command only forwarded SSH-oriented activation args and did not parse paired server profile flags. | Fixed in `provider-accounts.js`; endpoint/profile now derive `--ssh`, `--remote-dir`, `--node-id`, and `--port` from node inventory. |
| Remote deploy helper failed with `bash: node: command not found` | AWS non-interactive SSH shell does not have `node` on PATH. The running server uses the bundled runtime under `.node-runtime`. | Use `/home/ubuntu/aih-fabric-current/.node-runtime/node-v22.16.0-linux-x64/bin/node` for all remote checks and file writes. |
| A wrong full `DEPLOYED_GIT_HEAD` was briefly written | Manual hash was typed before reading `git rev-parse HEAD`. | Corrected to `9d7c09fd8a53c65612d7c9863364fedee423d69a`; future deploys must read `git rev-parse HEAD` before writing. |
| Server startup left a sleeping bash wrapper | Remote `nohup ... & echo $!` returns the wrapper PID first; the node child is the real server process. | Verify `pgrep -af 'node.*bin/ai-home.js server serve --host 0.0.0.0 --port 9527'`, keep the node child, kill only the wrapper. |
| SSH output includes `setlocale: LC_ALL: cannot change locale` | AWS image lacks `zh_CN.UTF-8` locale. | Benign for current commands; do not treat as deployment or runtime failure. |
| Codex remains unavailable | AWS codex account `2` is runtime-blocked by `auth_invalid:upstream_401`. | Requires real AWS-side Codex reauth/fix; do not copy local credentials implicitly. |
| Claude remains unavailable | AWS Claude accounts `1..4` are runtime-blocked by `auth_invalid:claude_not_logged_in`. | Requires real AWS-side Claude login/reauth. |
| AGY remains unavailable | AWS AGY accounts `1..7` are runtime-blocked by `auth_invalid:agy_not_signed_in`. | Requires real AWS-side AGY login/reauth. |
| TURN/UDP default `9527` is not promotable | Prior packet capture showed UDP datagrams do not arrive on AWS `enp39s0`. | Needs cloud/network operator action; not an AIH code retry loop. |
| WebTransport is not promotable | Default `9527` listener is plain HTTP, not HTTPS/H3 WebTransport. | Needs real HTTPS/H3 endpoint before browser WebTransport probe can pass. |
| Multipath is not promotable | No real OpenMPTCPRouter/MPTCP underlay is present; local macOS has no generic MPTCP socket for this path. | Needs real dual-ended underlay before promotion. |

## Remaining work

The AWS node is usable today for:

```text
read node registry
open project metadata
configure SSH binding
run measurement
start opencode session
stream opencode session over WebRTC
fallback to relay when selected transport is unavailable
```

Still blocked by real external prerequisites:

```text
codex/claude/agy provider account login state
controlled TURN relay or UDP reachability
HTTPS/H3 WebTransport endpoint
OpenMPTCPRouter/MPTCP underlay
```
