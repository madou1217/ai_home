# 2026-06-28 Fabric Nodes CLI Capability Smoke

## Scope

This evidence records the productized local client command for reading Fabric node capabilities from a paired server profile:

- add `aih fabric nodes [node-id]`;
- reuse the same local paired server profile/device token path as transport readiness;
- explain per-node server/relay/project/runtime/SSH capability and action blockers;
- remove the stale `m4_remote_session_action_pending` blocker from start-session action gates after M4 was already proven by real session smoke.

No mock AWS data was used. No old `152.*`, `155.*`, or `39.104.*` servers were touched.

## Code Surface

| File | Purpose |
|---|---|
| `lib/cli/services/fabric/server-profile-client.js` | Shared paired server profile selection and protected JSON fetch helper |
| `lib/cli/services/fabric/nodes-client.js` | `fabric nodes` client read model, redacted output, registry normalization |
| `lib/cli/services/fabric/transport-readiness-client.js` | Reused shared profile client without changing readiness behavior |
| `lib/cli/commands/fabric-router.js` | Adds `aih fabric nodes` command routing |
| `lib/server/fabric-node-inventory.js` | Enables `start-session:<provider>` when project/runtime/transport are present |
| `web/src/services/fabric-registry.ts` | Keeps client-side fallback node inventory action gate aligned |

## Local Verification

```text
node --test test/fabric-node-inventory.test.js test/fabric-role-registry.test.js test/fabric-registry-client.test.js test/fabric-nodes-client.test.js
node --test test/fabric-real-transport-readiness-client-smoke.test.js
npm --prefix web run build
npm test
```

Results:

- focused node/readiness tests passed: 19/19;
- Web build passed;
- full local test suite passed: 2665/2665.

## AIH Claude Review Attempt

Command:

```text
env AIH_NO_PERSIST=1 aih claude -p "<review prompt>"
```

Result:

- command correctly used `claude (AIH Server)` path;
- after 30 seconds it was still at `Waiting for claude to boot`;
- no review text was produced;
- the process was interrupted so no hanging reviewer process remained.

## AWS Deployment

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
source artifact: a5dd0902f555934a0906ef2018342d1dceb3cf7934427909c055c192121f67e4
server pid: 256368
port: 9527
accounts: codex=0, gemini=0, claude=0, agy=0, opencode=0
```

## Post-Deploy Preflight

Command:

```text
node scripts/fabric-m3-daemon-preflight.js --json
```

Result summary:

```json
{
  "ok": true,
  "processCount": 1,
  "supervisorReady": true,
  "registry": {
    "counts": {
      "nodes": 2,
      "relayNodes": 2,
      "projects": 2,
      "runtimes": 4,
      "transports": 2,
      "nodeInventory": 2
    },
    "targetNode": {
      "id": "aws-current-node",
      "present": true,
      "runtimeHost": false,
      "runtimeProviders": [],
      "runtimeGaps": [
        "codex:missing_provider_runtime:codex",
        "claude:missing_provider_runtime:claude",
        "agy:missing_provider_runtime:agy",
        "opencode:missing_provider_runtime:opencode"
      ]
    }
  },
  "residue": [],
  "remainingGate": []
}
```

## Real Local Client Smoke

Command:

```text
node bin/ai-home.js fabric nodes aws-current-node
```

Output summary:

```text
AIH Fabric nodes
  profile: http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 (cp-51hq70)
  endpoint: http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527
  http: unauth=401 auth=200
  registry: nodes=2 relay_nodes=2 projects=2 runtimes=4 transports=2
  node: AWS Current Node (aws-current-node)
  roles: node, relay-node
  capabilities: server=no relay=yes project_host=yes runtime_host=no ssh=no measured=yes
  transports: relay (online)
  runtimes: none
  runtime_gaps:
    - codex: missing_provider_runtime:codex
    - claude: missing_provider_runtime:claude
    - agy: missing_provider_runtime:agy
    - opencode: missing_provider_runtime:opencode
  actions:
    - open-project: pending (m4_project_action_pending)
    - start-session:codex: blocked (missing_provider_runtime:codex)
    - start-session:claude: blocked (missing_provider_runtime:claude)
    - start-session:agy: blocked (missing_provider_runtime:agy)
    - start-session:opencode: blocked (missing_provider_runtime:opencode)
    - configure-ssh: blocked (missing_ssh_bootstrap_transport)
  result: pass
```

JSON smoke also passed:

```json
{
  "ok": true,
  "profile": {
    "id": "cp-51hq70",
    "deviceTokenPresent": true
  },
  "http": {
    "unauthenticatedStatus": 401,
    "authorizedStatus": 200
  },
  "summary": {
    "nodes": 2,
    "runtimeHostNodes": 1,
    "targetNodeId": "aws-current-node",
    "targetRuntimeHost": false,
    "targetRuntimeProviders": []
  },
  "targetNode": {
    "id": "aws-current-node",
    "capabilities": {
      "relayNode": true,
      "projectHost": true,
      "runtimeHost": false,
      "measured": true
    },
    "runtimes": [],
    "runtimeGaps": [
      { "provider": "codex", "blocker": "missing_provider_runtime:codex" },
      { "provider": "claude", "blocker": "missing_provider_runtime:claude" },
      { "provider": "agy", "blocker": "missing_provider_runtime:agy" },
      { "provider": "opencode", "blocker": "missing_provider_runtime:opencode" }
    ]
  }
}
```

## Readiness Regression

Command:

```text
node bin/ai-home.js fabric transport readiness --json
```

Result summary:

```json
{
  "ok": true,
  "http": {
    "unauthenticatedStatus": 401,
    "authorizedStatus": 200
  },
  "summary": {
    "defaultTransport": "relay",
    "fallbackReady": true,
    "promotionReady": false
  },
  "node": {
    "nodeId": "aws-current-node",
    "relayMeasurementPass": true,
    "relayRttMs": {
      "p95": 1,
      "max": 1,
      "count": 20
    }
  }
}
```

## Conclusion

The local client can now query AWS as a real Fabric node through the paired server profile without SSH token reads. AWS current is usable as a registered node, relay node, measured transport target, and project host. It is not a provider runtime host because provider runtime records/accounts are intentionally absent on AWS.

The next core gap is not visibility. It is a real action path from `fabric nodes` inventory into `device-node-session-start` for nodes where `start-session:<provider>.enabled=true`, plus a deliberate provider runtime provisioning story if AWS itself should become a runtime host.
