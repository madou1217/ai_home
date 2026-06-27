# 2026-06-26 Registry Publisher Smoke

## Scope

验证 M3 Role Registry 的 node-side 最小 publisher：

- `aih fabric registry publish` 可以使用 device token 上报一台 node 的角色快照。
- 上报内容包含 `node` / `relay-node` roles、project、Codex/Claude TUI runtimes 和 relay transport。
- Server 端 `/v0/fabric/registry` 可以读到同一份 registry。
- 迁移期旧 `/v0/node-rpc/device-nodes` 可以读到 mirrored relay node。

本轮仍不安装 daemon、不保存 token、不启动真实 provider runtime、不验证 home/company 跨机器长期心跳。

## Environment

- Date: 2026-06-26
- Runtime: isolated loopback `startLocalServer`
- Storage: temp `aiHomeDir`
- Script: `scripts/fabric-registry-publish-smoke.js`

## Command

```bash
node scripts/fabric-registry-publish-smoke.js
```

## Result

```json
{
  "ok": true,
  "pairStatus": 200,
  "cliStatus": 0,
  "cliNodeId": "local-dev-smoke",
  "cliRoles": ["node", "relay-node"],
  "cliCounts": {
    "projects": 1,
    "runtimes": 2,
    "transports": 1
  },
  "registryStatus": 200,
  "registryCounts": {
    "nodes": 1,
    "relayNodes": 1,
    "transports": 1,
    "projects": 1,
    "runtimes": 2
  },
  "registryNodeIds": ["local-dev-smoke"],
  "runtimeProviders": ["codex:tui", "claude:tui"],
  "legacyNodeIds": ["local-dev-smoke"],
  "cliSignal": "",
  "cliError": ""
}
```

## Interpretation

This proves the first node-side publisher slice: a CLI node snapshot can pair with an isolated server, publish registry state, and become visible through both Fabric registry and the legacy node-rpc compatibility view.

The smoke harness must run the CLI child with asynchronous `spawn`, not `spawnSync`, because the smoke server runs in the same Node process. A synchronous child blocks the event loop and prevents the in-process server from responding.

## Verdict

partial

## Next Checks

1. Run the same publisher from a real home/company machine against a real server profile.
2. Add periodic heartbeat/daemon mode only after the one-shot publisher contract stays stable.
3. Add Nodes and Relay Health UI surfaces backed by `/v0/fabric/registry`.
4. Add relay capacity measurements before scheduling traffic through `relay-node`.
