# 2026-06-28 Node Inventory Read Model

## Scope

This evidence records the first M3.5 code slice:

- build a unified Node Inventory read model from Fabric registry data;
- gate node actions by per-node capability instead of global registry counts;
- verify the new read model with real AWS current registry data.

No mock AWS data was used. No old servers were touched.

## Code Surface

| File | Purpose |
|---|---|
| `lib/server/fabric-node-inventory.js` | Server-side read model and action gating |
| `lib/server/fabric-role-registry.js` | Adds `nodeInventory` to serialized registry reads |
| `web/src/services/fabric-registry.ts` | Client-side normalization and fallback Node Inventory builder |
| `web/src/pages/FabricNodes.tsx` | Shows unified node capabilities and action blockers |
| `test/fabric-node-inventory.test.js` | Prevents global runtime count from being misread as per-node runtime readiness |

## Real AWS Readback

Command summary:

```text
1. Read local shared profiles from http://127.0.0.1:9527/v0/webui/control-plane/profiles
2. Select paired AWS profile.
3. GET {awsProfile.endpoint}/v0/fabric/registry with Authorization: Bearer [redacted]
4. Run buildFabricNodeInventory(registry.result)
```

Sanitized result:

```json
{
  "status": 200,
  "counts": {
    "nodes": 2,
    "relayNodes": 2,
    "transports": 2,
    "projects": 2,
    "runtimes": 4
  },
  "summary": [
    {
      "id": "aws-current-node",
      "name": "AWS Current Node",
      "capabilities": {
        "node": true,
        "relayNode": true,
        "projectHost": true,
        "runtimeHost": false,
        "sshBootstrap": false,
        "measured": true,
        "transportKinds": ["relay"],
        "runtimeProviders": [],
        "relayState": "online",
        "transportState": "online"
      },
      "projects": ["aih-fabric-current"],
      "runtimes": [],
      "startActions": [
        {
          "id": "start-session:codex",
          "eligible": false,
          "enabled": false,
          "blockers": [
            "missing_provider_runtime:codex",
            "m4_remote_session_action_pending"
          ]
        },
        {
          "id": "start-session:claude",
          "eligible": false,
          "enabled": false,
          "blockers": [
            "missing_provider_runtime:claude",
            "m4_remote_session_action_pending"
          ]
        },
        {
          "id": "start-session:agy",
          "eligible": false,
          "enabled": false,
          "blockers": [
            "missing_provider_runtime:agy",
            "m4_remote_session_action_pending"
          ]
        },
        {
          "id": "start-session:opencode",
          "eligible": false,
          "enabled": false,
          "blockers": [
            "missing_provider_runtime:opencode",
            "m4_remote_session_action_pending"
          ]
        }
      ]
    },
    {
      "id": "local-mac-remote-node",
      "name": "Local Mac Remote Node",
      "capabilities": {
        "node": true,
        "relayNode": true,
        "projectHost": true,
        "runtimeHost": true,
        "sshBootstrap": false,
        "measured": true,
        "transportKinds": ["relay"],
        "runtimeProviders": ["agy", "claude", "codex", "opencode"],
        "relayState": "online",
        "transportState": "online"
      },
      "projects": ["ai_home"],
      "runtimes": [
        { "provider": "codex", "mode": "tui", "status": "available" },
        { "provider": "claude", "mode": "tui", "status": "available" },
        { "provider": "agy", "mode": "tui", "status": "available" },
        { "provider": "opencode", "mode": "tui", "status": "available" }
      ],
      "startActions": [
        {
          "id": "start-session:codex",
          "eligible": true,
          "enabled": false,
          "blockers": ["m4_remote_session_action_pending"]
        }
      ]
    }
  ]
}
```

## What AWS Is Missing

AWS is not missing Node.js. The server process is already running with the bundled Node runtime.

AWS is missing **provider runtime records** for `aws-current-node`:

- `codex`
- `claude`
- `agy`
- `opencode`

Those records mean: this node can launch that provider runtime for a project. They normally come from explicit `--runtime provider:mode` publish or from `aih fabric registry publish --from-server` when the target server has real provider accounts.

Current AWS also has no provider accounts loaded in `/readyz`, so the product must not claim AWS can start Codex/Claude/AGY/OpenCode sessions until runtime/account authority is restored and a real session smoke passes.

## Verification

```text
node --check lib/server/fabric-node-inventory.js
node --test test/fabric-node-inventory.test.js test/fabric-role-registry.test.js test/fabric-registry-client.test.js
npm --prefix web run build
npm test
```

Results:

- syntax check passed;
- focused tests passed: 9/9;
- Web build passed.
- full local test suite passed: 2575/2575.

## Recheck

Later in the same 2026-06-28 closure pass, the paired AWS profile was read again from the local server setup registry and the AWS registry was fetched through the stored device bearer.

Sanitized recheck result:

```json
{
  "registryStatus": 200,
  "registryCounts": {
    "nodes": 2,
    "relayNodes": 2,
    "transports": 2,
    "projects": 2,
    "runtimes": 4
  },
  "aws-current-node": {
    "projectHost": true,
    "relayNode": true,
    "runtimeHost": false,
    "runtimeProviders": [],
    "runtimeCount": 0,
    "startCodexBlockers": [
      "missing_provider_runtime:codex",
      "m4_remote_session_action_pending"
    ]
  },
  "local-mac-remote-node": {
    "runtimeHost": true,
    "runtimeProviders": ["agy", "claude", "codex", "opencode"],
    "runtimeCount": 4,
    "startCodexBlockers": ["m4_remote_session_action_pending"]
  }
}
```

## Browser Smoke

Real browser target:

```text
http://127.0.0.1:9527/ui/fabric/nodes
```

Result:

- Page title: `节点总览 - AIH`.
- Fabric menu labels are now `Server 管理`, `连接方式`, `SSH / Bootstrap`, `节点总览`, `传输候选`.
- Active server profile is the paired AWS endpoint.
- Node list shows:
  - `AWS Current Node`: `1 projects`, `0 runtimes`, transport `online`.
  - `Local Mac Remote Node`: `1 projects`, `4 runtimes`, includes `runtime-host`.
- AWS detail shows:
  - project `aih-fabric-current`;
  - no provider runtime snapshot;
  - `Start codex`: `缺少 codex runtime · 远程会话动作待 M4 接入`;
  - `Start claude`: `缺少 claude runtime · 远程会话动作待 M4 接入`;
  - `Start agy`: `缺少 agy runtime · 远程会话动作待 M4 接入`;
  - `Start opencode`: `缺少 opencode runtime · 远程会话动作待 M4 接入`.
- Console has one known static asset error: `/favicon.ico` 404. No registry/runtime UI logic error remained after removing the stale `buildFabricRegistryNodeViews` call.

Artifacts:

- Snapshot: `.playwright-cli/page-2026-06-28T02-01-21-926Z.yml`
- Screenshot: `.playwright-cli/page-2026-06-28T02-01-56-086Z.png`
