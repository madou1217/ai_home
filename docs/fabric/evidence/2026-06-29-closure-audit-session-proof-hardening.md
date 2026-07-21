# 2026-06-29 Closure audit session proof hardening

本轮目标是先恢复 AWS current 默认 `9527` 的真实业务链路，再复跑串流 proof，并记录导致反复卡住的真实失败原因。

## Scope

- Target: `ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com`
- Remote dir: `/home/ubuntu/aih-fabric-current`
- Default product port: `9527`
- Node id: `aws-current-node`
- No mock data.
- No old `152.*` / `155.*` / `39.104.*` servers were touched.
- No provider credentials were copied from the Mac.

## AWS server recovery

After deploying commit `6113d0b`, the previous default server process had been stopped. The first manual restart used the correct code but missed the host-home environment, so `/readyz` returned an empty account pool:

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

That process was stopped. The server was restarted on the same default `9527` port with the real AWS host-home state:

```text
AIH_HOST_HOME=/home/ubuntu/aih-fabric-current/.aih-host-home
HOME=/home/ubuntu/aih-fabric-current/.aih-host-home
AIH_HOME=/home/ubuntu/aih-fabric-current/.aih-host-home/.ai_home
AI_HOME=/home/ubuntu/aih-fabric-current/.aih-host-home/.ai_home
AIH_SERVER_DISABLE_SOURCE_AUTO_RESTART=1
AIH_SERVER_STRICT_PORT=1
```

Final process state:

```text
pid=447349
ppid=1
command=./.node-runtime/node-v22.16.0-linux-x64/bin/node bin/ai-home.js server serve --host 0.0.0.0 --port 9527
```

Final `/readyz`:

```json
{
  "ok": true,
  "service": "aih-server",
  "ready": true,
  "accounts": {
    "codex": 1,
    "gemini": 0,
    "claude": 4,
    "agy": 7,
    "opencode": 1
  }
}
```

Operational note: `server.pid` was stale during this repair, so process evidence used `ps` and `/proc/<pid>/environ` as the source of truth.

## Provider and node readback before session proof

Provider account audit before the Codex run:

```text
codex profileCount=1 stateRows=1 configured=1 runtimeBlocked=0
claude profileCount=4 runtimeBlocked=4 reason=auth_invalid:claude_not_logged_in
agy profileCount=7 runtimeBlocked=7 reason=auth_invalid:agy_not_signed_in
```

Node inventory readback:

```text
profile=cp-51hq70 paired
registry counts: nodes=2 relayNodes=2 transports=3 projects=2 runtimes=8
aws-current-node runtimeHost=true
transports=relay,webrtc
start-session:codex enabled
start-session:opencode enabled
start-session:claude disabled provider_account_unavailable:claude
start-session:agy disabled provider_account_unavailable:agy
ssh binding: AWS Current Japan -> /home/ubuntu/aih-fabric-current
```

## Business closure: opencode

The current usable AWS business path is `opencode`, not Codex. It completed a real closure audit through WebRTC with no relay fallback:

```text
provider=opencode
marker=AIH_OPENCODE_BUSINESS_CLOSURE_REAL_20260629_2058
runId=efbcfad0-e008-4a14-be30-c92c5787968d
status=usable_with_blockers
coreReady=true
sessionReady=true
targetProviderReady=true
selectedTransportKind=webrtc
fallbackUsed=false
markerFound=true
doneObserved=true
eventCount=5
eventTypes=ready,session-created,delta,result,done
closureState=usable_with_external_blockers
immediateNext=transport-cloud-edge-udp
blockedExternal=7
```

This is the real end-to-end session proof for the currently schedulable AWS node runtime.

## Codex failure root cause

The previous Codex run reached the native CLI and upstream, so the earlier `cli_not_found` blocker is fixed. The new real blocker is the AWS Codex API key:

```text
runId=1e644c76-8ccc-49ad-972b-3dd6c5162093
eventCount=100
eventTypes=ready,terminal-output,runtime-blocked,error
runtime-blocked: provider=codex accountId=2 status=auth_invalid reason=upstream_401
error: native_runtime_blocked
upstream detail: 401 Unauthorized, Incorrect API key provided
doneObserved=false
```

Follow-up provider audit after that run:

```text
codex profileCount=1 stateRows=1 configured=1 runtimeBlocked=1
reason=auth_invalid:upstream_401
sampleClearableAccountIds=2
```

## Product bug fixed

The `closure audit` session proof was too optimistic:

- it searched the entire JSON report for the marker, so terminal echo text could count as marker proof;
- it allowed `summary.completed=true` to imply `doneObserved=true`;
- it did not treat `runtime-blocked`, `error`, or `aborted` session events as proof blockers.

Fix:

- marker proof now reads only canonical session output events: `delta`, `result`, `done`, `assistant_text`;
- session proof requires both canonical marker output and a real `done` event;
- `runtime-blocked`, `error`, and `aborted` events produce blockers and make `sessionProof.ok=false`.

Focused verification:

```text
node --check lib/cli/services/fabric/closure-audit.js
node --test test/fabric-closure-audit.test.js
```

Result:

```text
fabric closure audit tests: 9/9 pass
```

New regression coverage:

```text
fabric closure audit rejects terminal marker echo when runtime is blocked
```

## Deployment

Runtime commit:

```text
777b35f4418f38ed1d221571e02cd635e03689fd
```

Source artifact:

```text
/tmp/aih-fabric-head-777b35f.tar.gz
sha256=a6ba8bc63ff2d98173cd7457402d34f91dcc22883f570afea59ba28c26ec246a
remote=/home/ubuntu/aih-fabric-current/source-777b35f.tar.gz
sha256sum -c: OK
```

AWS focused verification after unpack:

```text
./.node-runtime/node-v22.16.0-linux-x64/bin/node --check lib/cli/services/fabric/closure-audit.js
./.node-runtime/node-v22.16.0-linux-x64/bin/node --test test/fabric-closure-audit.test.js test/fabric-provider-accounts.test.js
```

Result:

```text
remote focused tests: 15/15 pass
```

The default `9527` server was restarted on the same port with the same host-home environment:

```text
old pid=447349
new pid=450401
new ppid=1
DEPLOYED_GIT_HEAD=777b35f4418f38ed1d221571e02cd635e03689fd
readyz.ready=true
accounts=codex:1,claude:4,agy:7,opencode:1
```

Post-deploy business proof:

```text
provider=opencode
marker=AIH_POST_DEPLOY_OPENCODE_CLOSURE_REAL_20260629_2110
runId=896a8adb-ddf5-4ad5-924d-429b587597fd
status=usable_with_blockers
coreReady=true
sessionReady=true
targetProviderReady=true
selectedTransportKind=webrtc
fallbackUsed=false
markerFound=true
doneObserved=true
eventCount=5
eventTypes=ready,session-created,delta,result,done
closureState=usable_with_external_blockers
immediateNext=transport-cloud-edge-udp
```

Post-deploy Codex blocker proof:

```text
provider=codex
marker=AIH_POST_DEPLOY_CODEX_BLOCKER_REAL_20260629_2111
ok=false
exitOk=false
status=blocked
coreReady=false
sessionReady=false
targetProviderReady=false
runId=
markerFound=false
doneObserved=false
eventCount=0
blockers=provider_account_unavailable:codex
closureState=blocked
immediateNext=session-marker-proof-blocked
nextQueue=session-marker-proof-blocked,provider-codex-blocked,transport-cloud-edge-udp,transport-cloud-api-readback
```

## Codex gate after the fix

After the session proof hardening, Codex no longer appears as a successful closure:

```text
provider=codex
marker=AIH_CODEX_BLOCKER_GATE_REAL_20260629_2059
ok=false
exitOk=false
status=blocked
coreReady=false
sessionReady=false
targetProviderReady=false
selectedTransportKind=webrtc
fallbackUsed=null
runId=
sessionProofOk=false
markerFound=false
doneObserved=false
eventCount=0
blockers=provider_account_unavailable:codex
closureState=blocked
immediateNext=session-marker-proof-blocked
nextQueue=session-marker-proof-blocked,provider-codex-blocked,transport-cloud-edge-udp,transport-cloud-api-readback
```

## Failure causes recorded for future runs

1. Non-interactive SSH does not reliably have `node` on `PATH`.
   - Use `/home/ubuntu/aih-fabric-current/.node-runtime/node-v22.16.0-linux-x64/bin/node` or explicitly set `PATH`.
2. AWS server started without `AIH_HOST_HOME/HOME/AIH_HOME/AI_HOME` reads the wrong data root and returns account counts `0`.
   - Always verify `/proc/<pid>/environ` after restarting default `9527`.
3. Background SSH launch can leave a parent shell holding the SSH session.
   - Verify with `ps`; if a parent shell remains, stop only the parent shell and keep the node child running as `PPID=1`.
4. `server.pid` can be stale after manual repair.
   - Use `ps` and `/proc/<pid>/environ` as authoritative runtime evidence.
5. Terminal echo is not a valid session marker proof.
   - Only canonical `delta/result/done` output plus a real `done` event closes M4/M5.
6. Codex current blocker is not networking and not CLI resolution.
   - It is AWS-side provider auth: `auth_invalid:upstream_401`.

## Remaining external blockers

- `transport-cloud-edge-udp`: AWS public UDP `9527` path still blocked or not arriving.
- `transport-cloud-api-readback`: no AWS CLI/read-only IAM path on the node or local Mac.
- `transport-webtransport-h3`: no real HTTPS/H3 WebTransport endpoint.
- `transport-multipath-underlay`: no real OpenMPTCPRouter/MPTCP underlay.
- `provider-codex-blocked`: AWS Codex API key returns upstream 401.
- `provider-claude-blocked`: AWS Claude accounts are not logged in.
- `provider-agy-blocked`: AWS AGY accounts are not signed in.
