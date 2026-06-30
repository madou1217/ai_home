# 2026-06-28 AWS Runtime Gap Diagnosis

## Scope

解释当前本地 WebUI 看到 AWS node 后，AWS 到底缺什么 `runtime`，以及为什么不能直接在 AWS project 上启动 Codex / Claude / AGY / OpenCode session。

约束：

- 只使用 AWS current：`ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com`。
- 只使用默认端口 `9527`。
- 不触碰旧服务器。
- 不导入 provider 凭据。
- 不打印 device token、management key 或 provider secret。

## Code Added

Node Inventory read model 新增结构化字段：

```json
{
  "runtimeGaps": [
    {
      "provider": "codex",
      "status": "missing",
      "blocker": "missing_provider_runtime:codex",
      "runtimeId": ""
    }
  ]
}
```

同一个 provider runtime gate 同时驱动：

- `runtimeGaps[]`
- `start-session:<provider>.blockers`

这样 UI / client 不需要从按钮 blocker 文案里反推缺口。

## Real AWS Evidence

### AWS readyz

Command summary:

```text
GET http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527/readyz
```

Sanitized result:

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

Interpretation: AWS server has no provider accounts loaded. `aih fabric registry publish --from-server` cannot derive provider runtimes from an empty account pool.

### AWS host-home profile directories

Command summary:

```text
ssh AWS current
count <AIH_HOST_HOME>/profiles/<provider> directories
```

Sanitized result:

```text
host_home_exists=yes
profile_dirs.codex=0
profile_dirs.gemini=0
profile_dirs.claude=0
profile_dirs.agy=0
profile_dirs.opencode=0
```

Interpretation: the current AWS host home has no local provider profile directories. This matches `/readyz.accounts`.

### Authorized registry readback

Command summary:

```text
GET {pairedAwsProfile.endpoint}/v0/fabric/registry
Authorization: Bearer [redacted local paired device token]
```

Sanitized result:

```json
{
  "counts": {
    "nodes": 2,
    "relayNodes": 2,
    "transports": 2,
    "projects": 2,
    "runtimes": 4
  },
  "runtimesByNode": {
    "local-mac-remote-node": [
      "codex:tui:available",
      "claude:tui:available",
      "agy:tui:available",
      "opencode:tui:available"
    ]
  }
}
```

Interpretation: registry has four runtimes, but all four belong to `local-mac-remote-node`. AWS has zero runtime records.

### Runtime gap read model on real AWS payload

Command summary:

```text
fetch authorized AWS registry
buildFabricNodeInventory(registry)
```

Sanitized result:

```json
{
  "nodes": [
    {
      "id": "aws-current-node",
      "runtimeHost": false,
      "runtimeProviders": [],
      "runtimeGaps": [
        {
          "provider": "codex",
          "status": "missing",
          "blocker": "missing_provider_runtime:codex"
        },
        {
          "provider": "claude",
          "status": "missing",
          "blocker": "missing_provider_runtime:claude"
        },
        {
          "provider": "agy",
          "status": "missing",
          "blocker": "missing_provider_runtime:agy"
        },
        {
          "provider": "opencode",
          "status": "missing",
          "blocker": "missing_provider_runtime:opencode"
        }
      ]
    },
    {
      "id": "local-mac-remote-node",
      "runtimeHost": true,
      "runtimeProviders": ["agy", "claude", "codex", "opencode"],
      "runtimeGaps": []
    }
  ]
}
```

## Tests

```text
node --test test/fabric-node-inventory.test.js
tests 2
pass 2
fail 0

node --test test/fabric-registry-client.test.js
tests 4
pass 4
fail 0

node --test test/fabric-role-registry.test.js
tests 3
pass 3
fail 0

node --test test/fabric-node-inventory.test.js test/fabric-registry-client.test.js test/fabric-role-registry.test.js
tests 9
pass 9
fail 0

npm run web:build
Webpack: Compiled successfully

npm test
tests 2625
pass 2625
fail 0
```

## Conclusion

AWS 缺的 runtime 不是 SSH，也不是 server node 本身。

AWS 缺的是 provider runtime snapshots：

- `codex`
- `claude`
- `agy`
- `opencode`

原因是 AWS current 没有导入或配置任何 provider accounts。当前 AWS 可以做：

- control plane
- broker / relay-capable node
- SSH development machine
- project host

当前 AWS 不能做：

- 直接用 AWS 自己的 provider runtime 启动 Codex / Claude / AGY / OpenCode session

要让 AWS 成为 runtime host，必须明确选择一种路径：

1. 在 AWS 配置 provider accounts，然后用 `aih fabric registry publish --from-server` 重新发布 runtimes。
2. 显式发布 AWS 可用 runtime，例如 `--runtime codex:tui`，但这必须有真实可启动的 AWS provider 环境支撑。
3. 保持 provider runtime 在本机，让 AWS 只做 control plane / relay / project host，由远程 session 路由到本机 runtime。
