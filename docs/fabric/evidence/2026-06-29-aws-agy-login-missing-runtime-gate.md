# 2026-06-29 AWS AGY Login Missing Runtime Gate

## Scope

Only AWS current was used:

- SSH: `ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com`
- remote dir: `/home/ubuntu/aih-fabric-current`
- product port: default `9527`
- node id: `aws-current-node`

No old VPS host was touched. No mock registry data or fake provider responses
were used.

## Product Change

AGY native session output from the real Antigravity CLI login screen is now
classified as an account-level auth block:

```json
{
  "status": "auth_invalid",
  "reason": "agy_not_signed_in"
}
```

The native session stream kills the interactive child after the runtime blocker
is detected, records the runtime block through the account state service, and
finishes the run with `native_runtime_blocked` instead of emitting a normal
`done` event.

`agy_not_signed_in` is non-recoverable by background token refresh. It can only
be cleared by an explicit login success or manual admin clear.

## Local Verification

```text
node --test test/account.state-service.test.js test/native-session-chat.test.js test/server.token-refresh-daemon.test.js test/server.accounts.test.js
```

Result:

```text
85/85 pass
```

## AWS Deployment Verification

AWS server readiness on the default port:

```text
curl http://127.0.0.1:9527/readyz
```

Result:

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

Remote focused verification:

```text
node --test test/account.state-service.test.js test/native-session-chat.test.js test/server.token-refresh-daemon.test.js test/server.accounts.test.js
```

Result:

```text
85/85 pass
```

## Deployment Correction

The first AGY runtime block was recorded by the real session event stream, but
the DB row was later cleared. The cause was not the new server process: the AWS
user systemd services for the Fabric registry agent, relay connector, and WebRTC
connector were still running old code from before the sync.

The official user services were restarted:

```text
systemctl --user restart \
  com.clawdcodex.ai_home.fabric-registry-agent.aws-current-node.service \
  com.clawdcodex.ai_home.node-relay.aws-current-node.service \
  com.clawdcodex.ai_home.node-webrtc.aws-current-node.service
```

Process readback after restart:

```text
node bin/ai-home.js server serve --host 0.0.0.0 --port 9527
node /home/ubuntu/aih-fabric-current/bin/ai-home.js fabric registry agent http://127.0.0.1:9527 --node-id aws-current-node ...
node /home/ubuntu/aih-fabric-current/bin/ai-home.js node relay connect http://127.0.0.1:9527 --node-id aws-current-node
node /home/ubuntu/aih-fabric-current/bin/ai-home.js node webrtc connect http://127.0.0.1:9527 --node-id aws-current-node
```

## Real AGY Account Gate Sequence

Every account below was triggered through the real Fabric session start command:

```text
node bin/ai-home.js fabric session start aws-current-node --provider agy --prompt "AIH_TEST" --json
node bin/ai-home.js fabric session events aws-current-node --run-id <runId> --cursor 0 --limit 80 --json
```

Observed sequence:

```text
accountId=1 runId=fc7bf20d-ee4e-4287-b7fc-6bb3f640690e reason=agy_not_signed_in persisted=true error=native_runtime_blocked
accountId=2 runId=fc932811-8331-422a-9092-bcef4fb8ccbd reason=agy_not_signed_in persisted=true error=native_runtime_blocked
accountId=3 runId=eb083a70-0c70-463b-bb25-20f7e5489ffe reason=agy_not_signed_in persisted=true error=native_runtime_blocked
accountId=4 runId=dd0cbd06-55cf-4e60-b92c-33adaf58e86c reason=agy_not_signed_in persisted=true error=native_runtime_blocked
accountId=5 runId=d9f3eb8c-f5ed-4fd6-b779-376884f582b3 reason=agy_not_signed_in persisted=true error=native_runtime_blocked
accountId=6 runId=cf72b23e-fc64-4fed-92f1-84fd4be741a1 reason=agy_not_signed_in persisted=true error=native_runtime_blocked
accountId=7 runId=136f1ab7-c4c1-4982-9961-ccf55a62d121 reason=agy_not_signed_in persisted=true error=native_runtime_blocked
```

The real terminal output contained the Antigravity CLI login screen:

```text
Welcome to the Antigravity CLI. You are currently not signed in.
Select login method:
> 1. Google OAuth
2. Use a Google Cloud project
```

## DB Readback

After a full registry-agent refresh window, all seven AGY accounts still had the
runtime block:

```json
[
  { "accountId": "1", "reason": "agy_not_signed_in" },
  { "accountId": "2", "reason": "agy_not_signed_in" },
  { "accountId": "3", "reason": "agy_not_signed_in" },
  { "accountId": "4", "reason": "agy_not_signed_in" },
  { "accountId": "5", "reason": "agy_not_signed_in" },
  { "accountId": "6", "reason": "agy_not_signed_in" },
  { "accountId": "7", "reason": "agy_not_signed_in" }
]
```

## Final Gate Readback

After all seven AGY accounts were marked unavailable, a new AGY start was
blocked before posting a remote session start:

```text
node bin/ai-home.js fabric session start aws-current-node --provider agy --prompt "AIH_TEST" --json
```

Result:

```json
{
  "ok": false,
  "blocked": true,
  "blockers": ["provider_account_unavailable:agy"],
  "http": {
    "registryAuthorizedStatus": 200,
    "sessionStartStatus": 0
  }
}
```

Final Fabric node inventory:

```text
node bin/ai-home.js fabric nodes aws-current-node --json
```

Result summary:

```json
{
  "targetRuntimeHost": true,
  "targetRuntimeProviders": ["agy", "claude", "codex", "opencode"],
  "agyDiagnostic": {
    "total": 7,
    "schedulable": 0,
    "source": "runtime_accounts"
  },
  "agyAction": {
    "enabled": false,
    "eligible": false,
    "blockers": ["provider_account_unavailable:agy"]
  }
}
```

## Conclusion

The AWS node is reachable, starts real AGY native sessions, detects the real
Antigravity login screen, persists all AGY accounts as unavailable, survives a
registry-agent refresh, and blocks further AGY starts before any remote CLI is
spawned.
