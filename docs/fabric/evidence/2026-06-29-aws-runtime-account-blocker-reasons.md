# 2026-06-29 AWS Runtime Account Blocker Reasons

## Scope

This evidence records the live closure for runtime account blocker diagnostics
on AWS current after commit `a34122a`.

Only AWS current was touched:

- SSH: `ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com`
- key: `/Users/model/.ssh/aws.pem`
- remote dir: `/home/ubuntu/aih-fabric-current`
- product port: default `9527`

No mock data was used. No old VPS host was touched.

## Clean Source Deploy

The AWS source tree was updated from committed `HEAD`, not from the dirty local
worktree.

```text
git archive --format=tar.gz -o /tmp/aih-fabric-source-a34122a.tar.gz HEAD
shasum -a 256 /tmp/aih-fabric-source-a34122a.tar.gz
scp /tmp/aih-fabric-source-a34122a.tar.gz AWS:/home/ubuntu/aih-fabric-current/source-a34122a.tar.gz
ssh AWS sha256sum source-a34122a.tar.gz
ssh AWS tar -xzf source-a34122a.tar.gz -C /home/ubuntu/aih-fabric-current
```

Artifact:

```text
sha256=d27fe2ca73623460e736f6d9140b76ef28018445e907951095a41a5784e30d1f
size=3.1M
remote=/home/ubuntu/aih-fabric-current/source-a34122a.tar.gz
```

Remote verification:

```text
node --check lib/server/fabric-role-registry.js
node --check lib/cli/services/fabric/nodes-client.js
DEPLOYED_GIT_HEAD=a34122a08c41dc5c6145d4c17bd412f720774f86
```

The AWS default `9527` server was restarted with the existing host home:

```text
AIH_HOST_HOME=/home/ubuntu/aih-fabric-current/.aih-host-home
server_pid=385159
readyz.ready=true
readyz.accounts=codex:1,gemini:0,claude:4,agy:7,opencode:1
```

The registry agent was restarted so it would publish diagnostics from the new
source:

```text
systemctl --user restart com.clawdcodex.ai_home.fabric-registry-agent.aws-current-node.service
MainPID=385254
command includes --runtime-diagnostics --interval-ms 30000
```

## Fabric Nodes Readback

Command:

```text
node bin/ai-home.js fabric nodes aws-current-node
```

Result:

```text
profile=cp-51hq70
endpoint=http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527
http=unauthenticated 401, authorized 200
registry=nodes:2 relay_nodes:2 projects:2 runtimes:8 transports:3
node=aws-current-node
capabilities=relay yes, project_host yes, runtime_host yes, ssh yes, measured yes
transports=relay,webrtc online
runtimes=agy,claude,codex,opencode
```

Runtime gaps now include actionable account reason chains:

```text
codex: provider_account_unavailable:codex
  cli=yes account_total=1 account_available=0 account_unavailable=1
  account_source=runtime_accounts
  account_reasons=cooldown:upstream_401=1

claude: provider_account_unavailable:claude
  cli=yes account_total=4 account_available=0 account_unavailable=4
  account_source=runtime_accounts
  account_reasons=cooldown:claude_not_logged_in=4

agy: provider_account_unavailable:agy
  cli=yes account_total=7 account_available=0 account_unavailable=7
  account_source=runtime_accounts
  account_reasons=cooldown:agy_not_signed_in=7

opencode: provider_account_unavailable:opencode
  cli=yes account_total=1 account_available=0 account_unavailable=1
  account_source=runtime_accounts
  account_reasons=cooldown:upstream_401=1
```

Current actions:

```text
open-project=enabled
start-session:codex=blocked provider_account_unavailable:codex
start-session:claude=blocked provider_account_unavailable:claude
start-session:agy=blocked provider_account_unavailable:agy
start-session:opencode=blocked provider_account_unavailable:opencode
configure-ssh=enabled
```

## Management Account Readback

The management key was read only on AWS and was not printed. Output below is
redacted to provider, id, runtime status, reason, and schedulable status.

Command class:

```text
ssh AWS node -e 'read server-config.json managementKey; GET /v0/management/accounts; print redacted fields'
```

Result:

```text
status=200
count=13
codex: id=2 runtimeStatus=auth_invalid runtimeReason=upstream_401 schedulableStatus=blocked_by_runtime_status
claude: ids=1,2,3,4 runtimeStatus=auth_invalid runtimeReason=claude_not_logged_in schedulableStatus=blocked_by_runtime_status
agy: ids=1,2,3,4,5,6,7 runtimeStatus=auth_invalid runtimeReason=agy_not_signed_in schedulableStatus=blocked_by_runtime_status
opencode: id=1 runtimeStatus=auth_invalid runtimeReason=upstream_401 schedulableStatus=blocked_by_runtime_status
```

This proves the blocker is provider account/runtime auth state, not Fabric
registry, node visibility, or transport connectivity.

## Opencode Live Run Recheck

Before the registry publish cycle observed the new opencode blocker, a real
opencode run was started through AWS current to test the live path.

Command:

```text
node bin/ai-home.js fabric session start aws-current-node \
  --provider opencode \
  --prompt "AIH_AWS_RUNTIME_BLOCKER_REASON_DEPLOY_OK_20260629" \
  --json
```

Start result:

```text
ok=true
sessionStartStatus=200
transport.kind=webrtc
transportDecision.selectedTransportKind=webrtc
transportDecision.fallbackUsed=false
runId=e10838c7-ce95-4476-a755-c6f5f966835c
sessionId=ses_0edf74573ffeLOJSuhZVbW3x2Y
```

Events then proved the account failed at runtime:

```text
eventTypes=ready,session-created,runtime-blocked,terminal-output
runtime-blocked.provider=opencode
runtime-blocked.accountId=1
runtime-blocked.status=auth_invalid
runtime-blocked.reason=upstream_401
runtime-blocked.persisted=true
```

The run was stopped to avoid background residue:

```text
node bin/ai-home.js fabric session stop aws-current-node \
  --run-id e10838c7-ce95-4476-a755-c6f5f966835c \
  --json

stop.accepted=true
transport.kind=webrtc
cursor=6
```

Final event read:

```text
status=completed
completed=true
cursor=7
eventTypes=ready,session-created,runtime-blocked,terminal-output,artifact_ref,aborted,error
error.code=native_runtime_blocked
```

After the next registry agent publish cycle, `aih fabric nodes aws-current-node`
correctly changed `start-session:opencode` from enabled to blocked with
`account_reasons=cooldown:upstream_401=1`.

## Transport Status

Command:

```text
node bin/ai-home.js fabric transport status --node-id aws-current-node --json
```

Result summary:

```text
status=complete
remoteDevelopmentReady=true
defaultTransport=webrtc
fallbackReady=true
relayMeasurementPass=true
advancedPromotionReady=true
promotedTransports=webrtc
cloudEdgeReady=false
```

Remaining external transport blockers:

```text
webtransport:webtransport_endpoint_not_configured
webtransport:webtransport_not_promoted
omr:openmptcprouter_not_detected
mptcp:mptcp_data_plane_not_promoted
turn_default_udp_9527_unreachable
aws_public_udp_path_blocked
aws_cli_missing
aws_iam_role_missing
```

## Conclusion

Fabric connectivity is closed for this segment:

- local paired profile can authorize AWS registry reads;
- AWS node is visible as a project/runtime/relay/ssh-capable node;
- WebRTC remote management transport is selected and relay fallback is ready;
- runtime account blockers now expose concrete provider reason chains.

Current provider runtime state is blocked by real provider auth/account health:

- Codex: `upstream_401`
- Claude: `claude_not_logged_in`
- AGY: `agy_not_signed_in`
- OpenCode: `upstream_401`

The next functional blocker is provider account remediation on AWS, not another
Fabric transport or node-registry fix.

## Reason Label Correction

After the first live readback, the account diagnostics were actionable but the
reason label still used the generic account cooldown prefix:

```text
account_reasons=cooldown:upstream_401=1
account_reasons=cooldown:claude_not_logged_in=4
account_reasons=cooldown:agy_not_signed_in=7
```

Commit `093939689ae7fcbf2a57714144a4880b9f0ca8a7` changes account availability
classification so typed runtime buckets are reported before generic cooldowns.
This keeps ordinary cooldown explanations intact while making auth/runtime
failures explicit.

Verification before deploy:

```text
node --test test/server.router.test.js test/fabric-registry-agent.test.js \
  test/fabric-nodes-client.test.js test/server.codex-adapter.test.js \
  test/server.upstream-endpoints.test.js

focused tests: 107/107 pass
npm test: 2807/2807 pass
```

Clean AWS deploy:

```text
git archive --format=tar.gz -o /tmp/aih-fabric-source-0939396.tar.gz HEAD
sha256=6fe1b386d108e112beb47ea4ff8295934a3486d076d427a222ddf2c0227d7705
remote=/home/ubuntu/aih-fabric-current/source-0939396.tar.gz
DEPLOYED_GIT_HEAD=093939689ae7fcbf2a57714144a4880b9f0ca8a7
server old_pid=385159 new_pid=386417
registry-agent MainPID=386503
```

Live readback after registry-agent restart:

```text
node bin/ai-home.js fabric nodes aws-current-node
```

Result:

```text
codex: account_reasons=runtime:auth_invalid:upstream_401=1
claude: account_reasons=runtime:auth_invalid:claude_not_logged_in=4
agy: account_reasons=runtime:auth_invalid:agy_not_signed_in=7
opencode: account_reasons=runtime:auth_invalid:upstream_401=1
start-session:codex=blocked provider_account_unavailable:codex
start-session:claude=blocked provider_account_unavailable:claude
start-session:agy=blocked provider_account_unavailable:agy
start-session:opencode=blocked provider_account_unavailable:opencode
```

Transport readback remained healthy for the usable path:

```text
transport.status=complete
remoteDevelopmentReady=true
defaultTransport=webrtc
fallbackReady=true
relayMeasurementPass=true
promotedTransports=webrtc
cloudEdgeReady=false
```

Session-start guard recheck:

```text
node bin/ai-home.js fabric session start aws-current-node --provider codex --prompt AIH_BLOCK_GUARD_CODEX --json
node bin/ai-home.js fabric session start aws-current-node --provider claude --prompt AIH_BLOCK_GUARD_CLAUDE --json
node bin/ai-home.js fabric session start aws-current-node --provider agy --prompt AIH_BLOCK_GUARD_AGY --json
node bin/ai-home.js fabric session start aws-current-node --provider opencode --prompt AIH_BLOCK_GUARD_OPENCODE --json
```

Result:

```text
codex: blocked=true registryAuthorizedStatus=200 sessionStartStatus=0 blockers=provider_account_unavailable:codex
claude: blocked=true registryAuthorizedStatus=200 sessionStartStatus=0 blockers=provider_account_unavailable:claude
agy: blocked=true registryAuthorizedStatus=200 sessionStartStatus=0 blockers=provider_account_unavailable:agy
opencode: blocked=true registryAuthorizedStatus=200 sessionStartStatus=0 blockers=provider_account_unavailable:opencode
```
