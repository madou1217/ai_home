# 2026-06-28 Fabric Session Start CLI Gate

## Scope

This evidence records the first product CLI action from Fabric node inventory into the protected session-start route:

- add `aih fabric session start <node-id> --provider <provider> --prompt <text>`;
- reuse the paired server profile and device token path from `aih fabric nodes`;
- read Node Inventory before posting;
- refuse to POST when `start-session:<provider>` is not enabled;
- keep raw device tokens out of output and diagnostics.

No mock AWS data was used for the AWS gate. No retired `152.*`, `155.*`, or `39.104.*` servers were touched. No provider credentials were imported to AWS.

## Code Surface

| File | Purpose |
|---|---|
| `lib/cli/commands/fabric-router.js` | Routes `aih fabric session start` and prints JSON/text reports |
| `lib/cli/services/fabric/server-profile-client.js` | Extends shared fetch helper to support POST body/method |
| `lib/cli/services/fabric/session-start-client.js` | Implements profile selection, node action gate, protected POST, redacted report |
| `test/fabric-session-start-client.test.js` | Covers parser, disabled action gate, enabled POST, and router wiring |

## Local Verification

Commands:

```text
node --test test/fabric-session-start-client.test.js
node --test test/fabric-nodes-client.test.js test/fabric-node-inventory.test.js test/fabric-role-registry.test.js
npm test
```

Results:

```text
fabric session start focused tests: 4/4 pass
node inventory / nodes / role registry focused tests: 10/10 pass
full local test suite: 2669/2669 pass
```

Covered behavior:

- positional node id and `--provider` / `--prompt` parsing;
- blocked AWS-style action returns `sessionStartStatus=0`;
- enabled action posts to `/v0/node-rpc/device-node-session-start` with bearer auth;
- report serialization never includes the raw device token;
- command router exits `0` only when the client report is `ok=true`.

## Real AWS Gate

Command:

```text
node bin/ai-home.js fabric session start aws-current-node --provider codex --prompt "AIH_FABRIC_AWS_RUNTIME_BLOCK_CHECK" --json
```

Result summary:

```json
{
  "ok": false,
  "blocked": true,
  "profile": {
    "id": "cp-51hq70",
    "connectionMode": "direct",
    "authState": "paired",
    "deviceTokenPresent": true
  },
  "target": {
    "endpoint": "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527",
    "nodeId": "aws-current-node",
    "provider": "codex",
    "sessionStartUrl": "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527/v0/node-rpc/device-node-session-start"
  },
  "node": {
    "id": "aws-current-node",
    "capabilities": {
      "relayNode": true,
      "projectHost": true,
      "runtimeHost": false,
      "measured": true,
      "runtimeProviders": []
    },
    "runtimeGaps": [
      { "provider": "codex", "blocker": "missing_provider_runtime:codex" },
      { "provider": "claude", "blocker": "missing_provider_runtime:claude" },
      { "provider": "agy", "blocker": "missing_provider_runtime:agy" },
      { "provider": "opencode", "blocker": "missing_provider_runtime:opencode" }
    ]
  },
  "action": {
    "id": "start-session:codex",
    "enabled": false,
    "eligible": false,
    "blockers": ["missing_provider_runtime:codex"],
    "runtimeStatus": "missing"
  },
  "http": {
    "registryAuthorizedStatus": 200,
    "sessionStartStatus": 0
  },
  "blockers": ["missing_provider_runtime:codex"]
}
```

Interpretation:

- The local paired AWS profile works: authorized registry read returned `200`.
- AWS current is visible as a real node, relay node, measured transport target, and project host.
- AWS current is not a provider runtime host: no Codex/Claude/AGY/OpenCode runtime records are registered on `aws-current-node`.
- The CLI did not call session-start when Node Inventory said the action was disabled. `sessionStartStatus=0` is expected and intentional here.

## Clean Commit AWS Deployment

Code commit:

```text
5a8113e feat(fabric): add session start gate CLI
```

Deployment used a clean `git archive HEAD` export from that commit, not the dirty local worktree.

Command:

```text
node scripts/fabric-real-vps-deploy.js \
  --ssh ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com \
  --ssh-key "/Users/model/.ssh/aws.pem" \
  --remote-dir /home/ubuntu/aih-fabric-current \
  --node-runtime "/Users/model/projects/feature/ai_home/tmp/fabric-real-deploy/node-runtime/node-v22.16.0-linux-x64.tar.xz" \
  --skip-import \
  --skip-build \
  --broker-token-file /home/ubuntu/aih-fabric-current/.broker-token
```

Deployment result:

```text
source artifact: 5b016a0c1c64bb4622a675fc1cb26db9e78d4bdc28cf092ab6dc4834d142c66a
server pid: 257703
port: 9527
accounts: codex=0, gemini=0, claude=0, agy=0, opencode=0
```

Post-deploy preflight:

```json
{
  "ok": true,
  "processCount": 1,
  "supervisorReady": true,
  "registryCounts": {
    "nodes": 2,
    "relayNodes": 2,
    "projects": 2,
    "runtimes": 4,
    "transports": 2,
    "nodeInventory": 2
  },
  "targetNode": {
    "id": "aws-current-node",
    "runtimeHost": false,
    "runtimeProviders": [],
    "runtimeGaps": [
      "codex:missing_provider_runtime:codex",
      "claude:missing_provider_runtime:claude",
      "agy:missing_provider_runtime:agy",
      "opencode:missing_provider_runtime:opencode"
    ]
  },
  "residue": [],
  "remainingGate": []
}
```

## Post-Deploy AWS Client Regression

Commands:

```text
node bin/ai-home.js fabric nodes aws-current-node --json
node bin/ai-home.js fabric transport readiness --json
node bin/ai-home.js fabric session start aws-current-node --provider codex --prompt "AIH_FABRIC_AWS_RUNTIME_BLOCK_CHECK_POST_DEPLOY" --json
```

Result summary:

```json
{
  "nodes": {
    "ok": true,
    "unauthenticatedStatus": 401,
    "authorizedStatus": 200,
    "registryCounts": {
      "nodes": 2,
      "relayNodes": 2,
      "projects": 2,
      "runtimes": 4,
      "transports": 2
    },
    "awsCurrentNode": {
      "relayNode": true,
      "projectHost": true,
      "runtimeHost": false,
      "runtimeProviders": []
    },
    "localMacRemoteNode": {
      "runtimeHost": true,
      "runtimeProviders": ["agy", "claude", "codex", "opencode"]
    }
  },
  "transportReadiness": {
    "ok": true,
    "unauthenticatedStatus": 401,
    "authorizedStatus": 200,
    "defaultTransport": "relay",
    "fallbackReady": true,
    "relayMeasurementPass": true,
    "promotionReady": false
  },
  "awsSessionStartGate": {
    "ok": false,
    "blocked": true,
    "registryAuthorizedStatus": 200,
    "sessionStartStatus": 0,
    "blockers": ["missing_provider_runtime:codex"]
  }
}
```

## Enabled Node Start/Stop Smoke

Command:

```text
node bin/ai-home.js fabric session start local-mac-remote-node \
  --provider codex \
  --account-id 1 \
  --model gpt-5.5 \
  --project-path "/Users/model/projects/feature/ai_home" \
  --prompt "Reply with the five tokens AIH SESSION START CLI OK joined by underscores." \
  --timeout-ms 120000 \
  --json
```

Result summary:

```json
{
  "ok": true,
  "blocked": false,
  "http": {
    "registryAuthorizedStatus": 200,
    "sessionStartStatus": 200
  },
  "node": {
    "id": "local-mac-remote-node",
    "runtimeHost": true,
    "runtimeProviders": ["agy", "claude", "codex", "opencode"]
  },
  "result": {
    "accepted": true,
    "mode": "native-session",
    "status": "running",
    "provider": "codex",
    "accountId": "1",
    "runId": "cfa2ee75-e48a-444c-806c-bc015a3557ae"
  }
}
```

Cleanup / marker check:

```json
{
  "ok": false,
  "markerFound": false,
  "cursor": 276,
  "stopStatus": 200,
  "stopAccepted": true,
  "stopType": "stop",
  "runIdPresent": true
}
```

Interpretation:

- Enabled node action path is real: registry read `200`, session-start `200`, native Codex run accepted.
- Cleanup was real: stop command returned HTTP `200` and `accepted=true`.
- The temporary marker parser did not prove model output before the stop deadline. This run is not counted as a successful conversation marker smoke. Full marker-producing remote conversation evidence remains the M4 AWS/mobile smoke listed below.

## Relationship To Existing Real Session Smoke

This CLI owns only the product start entrypoint and gate. The full remote session lifecycle after a valid start is already proven by existing real AWS smokes:

- `2026-06-28-m4-aws-real-remote-session-smoke.md`: start, event polling, artifact retrieval, marker output, cleanup.
- `2026-06-28-m4-mobile-pwa-session-smoke.md`: start, attach, message, slash command, cursor reconnect, stop.

Those smokes use the same protected `POST /v0/node-rpc/device-node-session-start` server route. This change avoids reimplementing a full CLI session client before the client UX contract is settled.

## Conclusion

The next user-visible action after `aih fabric nodes` is now wired: the client can request a session start for nodes whose inventory action is enabled, and it gives a concrete blocker when the selected node lacks a provider runtime.

For AWS current specifically, the missing runtime means there are no provider accounts/runtimes installed on AWS. Until provider runtime provisioning is explicitly approved, AWS can act as control plane, relay-capable node, SSH/project host, and registry source, but not as the machine that runs Codex/Claude sessions.
