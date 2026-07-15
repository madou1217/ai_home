# AWS Runtime Account Health Gate

Date: 2026-06-29

Scope:
- Target: `ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com`
- Remote dir: `/home/ubuntu/aih-fabric-current`
- Server port: `9527`
- Node id: `aws-current-node`

## Code Verification

Local focused tests:

```text
node --test test/node-doctor.test.js test/fabric-m3-daemon-preflight.test.js test/native-session-chat.test.js test/fabric-registry-agent.test.js test/fabric-role-registry.test.js test/fabric-node-inventory.test.js test/fabric-nodes-client.test.js test/fabric-session-start-client.test.js
# pass 99, fail 0
```

Local full suite:

```text
npm test
# tests 2777
# pass 2777
# fail 0
```

## AWS Deployment

The AWS server was updated in place and kept on the default port:

```text
server process:
342895 node bin/ai-home.js server serve --host 0.0.0.0 --port 9527

readyz:
ok=true ready=true accounts codex=2 claude=4 agy=7 opencode=1
```

The supervised registry agent service was reinstalled so the generated systemd user unit includes runtime diagnostics:

```text
ExecStart includes:
--runtime-diagnostics

running process:
345182 node /home/ubuntu/aih-fabric-current/bin/ai-home.js fabric registry agent http://127.0.0.1:9527 ... --runtime-diagnostics --interval-ms 30000
```

## Real Session Smoke

Command:

```text
node bin/ai-home.js fabric session start aws-current-node --provider codex --prompt "只回复 OK，用于 AIH AWS node 真实连通测试。" --json
```

Observed real AWS run:

```json
{
  "runId": "3273f5d6-0d8c-489a-a730-af0d73ef9479",
  "runtimeBlocked": {
    "provider": "codex",
    "accountId": "2",
    "status": "auth_invalid",
    "reason": "upstream_401",
    "persisted": true
  }
}
```
The upstream terminal output contained a real `401 Unauthorized` for the masked API-key account. The raw key and token values were not recorded.

## Final Registry Readback

Local client readback:

```text
node bin/ai-home.js fabric nodes aws-current-node --json
```

Result:

```json
{
  "targetRuntimeHost": true,
  "targetRuntimeProviders": ["agy", "claude", "codex", "opencode"],
  "codexDiagnostic": {
    "total": 2,
    "schedulable": 0,
    "source": "runtime_accounts"
  },
  "codexAction": {
    "enabled": false,
    "eligible": false,
    "blockers": ["provider_account_unavailable:codex"]
  }
}
```

Client gate check:

```text
node bin/ai-home.js fabric session start aws-current-node --provider codex --prompt "只回复 OK，用于 AIH AWS node gate 测试。" --json
```

Result:

```json
{
  "ok": false,
  "blocked": true,
  "blockers": ["provider_account_unavailable:codex"],
  "http": {
    "registryAuthorizedStatus": 200,
    "sessionStartStatus": 0
  }
}
```

## Preflight

Command:

```text
node scripts/fabric-m3-daemon-preflight.js --json
```

Result:

```json
{
  "ok": true,
  "verdict": "ready_for_confirmed_7_3_execution",
  "server": {
    "readyzHttp": 200,
    "processCount": 1
  },
  "serviceStatus": {
    "relay": "running",
    "registryAgent": "running",
    "webrtc": "running"
  },
  "registryRuntimeGaps": [
    "codex:provider_account_unavailable:codex"
  ],
  "duplicateSupervisedProcesses": [],
  "remainingGate": []
}
```
