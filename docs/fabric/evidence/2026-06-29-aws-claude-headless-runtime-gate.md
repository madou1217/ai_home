# 2026-06-29 AWS Claude Headless Runtime Gate

## Scope

Only AWS current was used:

- SSH: `ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com`
- remote dir: `/home/ubuntu/aih-fabric-current`
- product port: default `9527`
- node id: `aws-current-node`

No old VPS host was touched. No mock registry data or fake provider responses
were used.

## Product Change

Remote Fabric device sessions now start Claude through the headless stream path
instead of the interactive TUI path. This avoids blocking on first-run terminal
prompts and lets the native session event parser classify real upstream auth
failures.

Provider runtime CLI lookup now uses the same provider runtime environment that
is passed to the spawned process. Project-local runtime tool directories are
prepended to `PATH`:

- `.runtime-tools/bin`
- `.runtime-tools/npm/node_modules/.bin`
- `.node-runtime/*/bin`

Claude headless output containing `authentication_failed` and
`Not logged in · Please run /login` is recorded as:

```json
{
  "status": "auth_invalid",
  "reason": "claude_not_logged_in"
}
```

## Local Verification

```text
node --check lib/server/native-session-chat.js
node --test test/native-session-chat.test.js test/control-plane-device-session-start.test.js test/provider-runtime-env.test.js
node --test test/fabric-node-inventory.test.js test/fabric-registry-agent.test.js
```

Result:

```text
native/device/runtime env: 37/37 pass
fabric inventory/registry: 16/16 pass
```

## AWS Verification

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
node --check lib/server/native-session-chat.js
node --test test/native-session-chat.test.js test/control-plane-device-session-start.test.js test/provider-runtime-env.test.js
```

Result:

```text
37/37 pass
```

## Real Claude Account Gate Sequence

The first failing account had already been observed in the previous run:

```text
runId=222fd2bc-c820-4926-80e9-7144752601bf
provider=claude
accountId=1
status=auth_invalid
reason=claude_not_logged_in
persisted=true
```

This run continued from the live AWS state and verified the remaining accounts.

### Account 2

Command:

```text
node bin/ai-home.js fabric session start aws-current-node --provider claude --prompt "<real marker prompt>" --json
node bin/ai-home.js fabric session events aws-current-node --run-id 4481bdbf-11b3-4d27-b701-890c3c389255 --cursor 0 --limit 200 --json
```

Observed:

```text
runId=4481bdbf-11b3-4d27-b701-890c3c389255
sessionId=2228098a-d61e-40e0-a9c3-da1eb2b35b42
runtime-blocked provider=claude accountId=2 status=auth_invalid reason=claude_not_logged_in persisted=true
upstream text: Not logged in · Please run /login
```

### Account 3

Command:

```text
node bin/ai-home.js fabric session start aws-current-node --provider claude --prompt "<real marker prompt>" --json
node bin/ai-home.js fabric session events aws-current-node --run-id 25164f16-08b4-47c8-be7f-36f81160533f --cursor 0 --limit 200 --json
```

Observed:

```text
runId=25164f16-08b4-47c8-be7f-36f81160533f
sessionId=70e90c95-7cd9-4966-9040-599c930c7a92
runtime-blocked provider=claude accountId=3 status=auth_invalid reason=claude_not_logged_in persisted=true
upstream text: Not logged in · Please run /login
```

### Account 4

Command:

```text
node bin/ai-home.js fabric session start aws-current-node --provider claude --prompt "<real marker prompt>" --json
node bin/ai-home.js fabric session events aws-current-node --run-id a0ba0fa8-7fb0-46f0-87ae-1cfc14ff718f --cursor 0 --limit 200 --json
```

Observed:

```text
runId=a0ba0fa8-7fb0-46f0-87ae-1cfc14ff718f
sessionId=ca71a881-2387-453e-8529-bd0b57f5693e
runtime-blocked provider=claude accountId=4 status=auth_invalid reason=claude_not_logged_in persisted=true
upstream text: Not logged in · Please run /login
```

## Final Gate Readback

After all four Claude accounts were marked unavailable, a new Claude start was
blocked before posting a remote session start:

```text
node bin/ai-home.js fabric session start aws-current-node --provider claude --prompt "<should not start>" --json
```

Result:

```json
{
  "ok": false,
  "blocked": true,
  "blockers": ["provider_account_unavailable:claude"],
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
  "claudeDiagnostic": {
    "total": 4,
    "schedulable": 0,
    "source": "runtime_accounts"
  },
  "claudeAction": {
    "enabled": false,
    "eligible": false,
    "blockers": ["provider_account_unavailable:claude"]
  }
}
```

## Conclusion

The AWS node is reachable and can start real remote native sessions. The current
Claude provider is correctly blocked because every configured AWS Claude account
is genuinely not logged in. The product no longer keeps retrying bad accounts or
starts an interactive TUI that waits forever.
