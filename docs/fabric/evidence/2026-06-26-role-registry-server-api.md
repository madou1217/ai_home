# 2026-06-26 Role Registry Server API

## Scope

验证 M3 Role Registry 的第一刀：

- AIH instance 可以通过 Fabric API 声明 `node` / `relay-node` 角色。
- Node 注册 payload 可以包含 projects、runtimes、transport endpoints 和 relay capacity。
- Server 将 Fabric registry 写入 `fabric-registry.json`。
- 可兼容的 node/relay transport 同步镜像到旧 `remote-nodes.json`，让旧 `/v0/node-rpc/device-nodes` 视图继续可用。
- Registry 写操作需要 device token 具备 `nodes:write`，读操作需要 `nodes:read`。

本轮不启动真实远端 provider runtime，不创建 native PTY session，不验证 relay long-running link。

## Environment

- Date: 2026-06-26
- Runtime: Node built-in test runner
- Storage: test-only temp `aiHomeDir`
- Server: isolated `startLocalServer` test instances on loopback dynamic ports

## Commands

```bash
node --test test/fabric-role-registry.test.js
node --test test/server-node-rpc-wiring.test.js
```

## API Contract

Read registry:

```text
GET /v0/fabric/registry
Authorization: Bearer <device-token with nodes:read>
```

Register or replace one node snapshot:

```text
POST /v0/fabric/registry/nodes
Authorization: Bearer <device-token with nodes:write>
Content-Type: application/json
```

Payload shape:

```json
{
  "node": {
    "id": "home-mac",
    "name": "Home Mac",
    "roles": ["node", "relay-node"],
    "platform": "darwin",
    "arch": "arm64",
    "capabilities": ["projects", "sessions"]
  },
  "relayNode": {
    "capacityClass": "tiny",
    "bandwidthLimitKbps": 2048
  },
  "transports": [
    { "id": "home-mac-relay", "kind": "relay", "health": "up" }
  ],
  "projects": [
    { "path": "/Users/model/projects/feature/ai_home", "name": "ai_home", "vcs": "git" }
  ],
  "runtimes": [
    { "provider": "codex", "mode": "tui", "version": "0.142.0" }
  ]
}
```

## Metrics

| metric | value | note |
|---|---:|---|
| Fabric role registry unit tests | pass | 1/1 pass |
| Server wiring tests | pass | 6/6 pass |
| Unauthorized write check | pass | missing bearer returns 401 |
| Scoped write check | pass | `nodes:write` token registers node |
| Scoped read check | pass | `nodes:read` token reads registry |
| Node roles stored | pass | `node`, `relay-node` |
| Projects stored | pass | 1 project with path hash |
| Runtimes stored | pass | `codex` TUI runtime |
| Relay metadata stored | pass | `tiny`, 2048 Kbps |
| Raw fingerprint leakage | pass | raw hardware id not serialized |
| Legacy mirror | pass | `/v0/node-rpc/device-nodes` lists mirrored relay node |

## Result Shape

Successful register response includes:

```json
{
  "ok": true,
  "rpc": "fabric.registry.node.register",
  "result": {
    "node": {
      "id": "home-mac",
      "roles": ["node", "relay-node"],
      "ownerDeviceId": "device-home-mac"
    },
    "registry": {
      "counts": {
        "nodes": 1,
        "relayNodes": 1,
        "transports": 1,
        "projects": 1,
        "runtimes": 1
      }
    }
  }
}
```

Legacy node-rpc compatibility check:

```json
{
  "ok": true,
  "result": {
    "nodes": [
      {
        "id": "home-mac",
        "transports": [{ "kind": "relay" }]
      }
    ]
  }
}
```

## Interpretation

This completes the first server-side role registry slice. It turns the product model from a document-only concept into a persisted API: a machine can declare itself as node and relay-node, publish project/runtime inventory, and become visible through both Fabric registry and legacy node-rpc read paths.

It is still not a full M3 completion. A one-shot CLI publisher is now covered separately in `2026-06-26-registry-publisher-smoke.md`; the missing pieces are a node-side heartbeat/daemon publisher, first-class Node onboarding, relay capacity health measurements, UI surfaces for Nodes/Relay Health, and real home/company machine evidence.

## Verdict

partial

## Next Checks

1. Run `aih fabric registry publish` from real home/company machines against a real server profile.
2. Add server UI surfaces for Fabric Nodes and Relay Health instead of relying on legacy Remote Nodes.
3. Record real node registration from at least one home/company machine.
4. Add relay heartbeat and capacity measurement before scheduling traffic through relay-node roles.
