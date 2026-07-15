# 2026-06-28 AWS Registry Heartbeat Self-Heal

## Scope

本证据记录 AWS current 默认 `9527` 的真实部署、守护进程验证、registry heartbeat 自愈修复和本地授权 profile 读回结果。

约束：

- 只使用 AWS current：`ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com`。
- 只使用默认端口 `9527`，部署命令未新增产品端口。
- 不访问旧 `152/155/39.104` 服务器。
- 不导入 provider 凭据。
- 不打印 device token、management key 或 provider secret。

## Problem Found

第一次干净 `HEAD=91d2043` 部署后，AWS server 和两个长期守护进程都是真实 running：

```json
{
  "server": {
    "processCount": 1,
    "processes": [
      "234496 node bin/ai-home.js server serve --host 0.0.0.0 --port 9527"
    ]
  },
  "serviceStatus": {
    "supervisorReady": true,
    "relay": { "running": true },
    "registryAgent": { "running": true }
  }
}
```

但本地授权 profile 读取 AWS registry 仍为空：

```json
{
  "profiles": {
    "count": 1,
    "activeProfileId": "cp-51hq70",
    "endpoint": "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527",
    "hasDeviceToken": true
  },
  "registry": {
    "nodes": 0,
    "relayNodes": 0,
    "transports": 0,
    "projects": 0,
    "runtimes": 0
  }
}
```

Server log showed real heartbeat traffic returning HTTP 200 from both AWS local loopback and local public client IP:

```text
POST /v0/fabric/registry/heartbeat status=200 clientIp=127.0.0.1
POST /v0/fabric/registry/heartbeat status=200 clientIp=106.123.61.90
GET /v0/fabric/registry status=200 clientIp=106.123.61.90
```

Root cause: `heartbeatFabricNode()` only updated existing nodes. After a clean deploy/registry reset, the registry agent kept sending valid heartbeat payloads, but heartbeat could not create the missing node. The result was a live daemon with an empty registry read model.

## Code Fixed

Commits:

- `91d2043 fix(fabric): Verify AWS deploy server restart`
- `a7ecba5 fix(fabric): Bootstrap registry nodes from heartbeat`

Changed behavior:

- Deploy script now stops stale `9527` server processes, rejects lingering port ownership, verifies the new pid, checks server log failure text, and only succeeds after `/readyz`.
- Registry heartbeat now bootstraps missing node liveness through the existing `registerFabricNode()` path.
- Heartbeat bootstrap creates only factual liveness data from the heartbeat payload:
  - node id/status/owner
  - relay-node role when relay heartbeat intent exists
  - relay transport and measurement
- It does not invent projects or provider runtimes. Projects/runtimes still require explicit publish/register data.

## Clean Deploy Evidence

Final clean deploy:

```text
deploy_head=a7ecba5
clean_source=/tmp/aih-head-deploy-4USWRR/src
source artifact sha256=f66c01cb33beb0bfa3652f7be9a7aed5016ad1d8a4ff049f0ffd85f8fc0e7cfd
source artifact bytes=5133642
remote dir=/home/ubuntu/aih-fabric-current
port=9527
new pid=235769
```

Startup output:

```text
listen: http://0.0.0.0:9527
accounts: codex=0, gemini=0, claude=0, agy=0, opencode=0
management_auth: enabled (Bearer key required)
```

## Real AWS Preflight

Command summary:

```text
node scripts/fabric-m3-daemon-preflight.js --json
```

Sanitized result:

```json
{
  "ok": true,
  "verdict": "ready_for_confirmed_7_3_execution",
  "target": {
    "nodeId": "aws-current-node",
    "port": 9527
  },
  "server": {
    "readyzHttp": 200,
    "processCount": 1,
    "processes": [
      "235769 node bin/ai-home.js server serve --host 0.0.0.0 --port 9527"
    ],
    "expectedHostHome": "/home/ubuntu/aih-fabric-current/.aih-host-home"
  },
  "serviceStatus": {
    "managementKeyConfigured": true,
    "supervisorReady": true,
    "relay": { "state": "running", "running": true },
    "registryAgent": { "state": "running", "running": true },
    "issues": []
  },
  "residue": [],
  "remainingGate": []
}
```

Supervised processes:

```text
fabric registry agent http://127.0.0.1:9527 --node-id aws-current-node --interval-ms 30000
node relay connect http://127.0.0.1:9527 --node-id aws-current-node
```

## Authorized Registry Readback

Command summary:

```text
GET http://127.0.0.1:9527/v0/webui/control-plane/profiles
GET {activeAwsProfile.endpoint}/v0/fabric/registry
Authorization: Bearer [redacted local paired device token]
```

Sanitized result:

```json
{
  "profile": {
    "count": 1,
    "activeProfileId": "cp-51hq70",
    "endpoint": "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527",
    "hasDeviceToken": true
  },
  "counts": {
    "nodes": 2,
    "relayNodes": 2,
    "transports": 2,
    "projects": 2,
    "runtimes": 4,
    "nodeInventory": 2
  },
  "nodeIds": [
    "aws-current-node",
    "local-mac-remote-node"
  ]
}
```

Node inventory read model:

```json
{
  "aws-current-node": {
    "runtimeHost": false,
    "runtimeProviders": [],
    "runtimeGaps": [
      "codex:missing_provider_runtime:codex",
      "claude:missing_provider_runtime:claude",
      "agy:missing_provider_runtime:agy",
      "opencode:missing_provider_runtime:opencode"
    ],
    "actions": [
      "open-project:eligible",
      "start-session:codex:blocked",
      "start-session:claude:blocked",
      "start-session:agy:blocked",
      "start-session:opencode:blocked",
      "run-measurement:eligible"
    ]
  },
  "local-mac-remote-node": {
    "runtimeHost": true,
    "runtimeProviders": [
      "agy",
      "claude",
      "codex",
      "opencode"
    ],
    "runtimeGaps": [],
    "actions": [
      "open-project:eligible",
      "start-session:codex:eligible",
      "start-session:claude:eligible",
      "start-session:agy:eligible",
      "start-session:opencode:eligible",
      "run-measurement:eligible"
    ]
  }
}
```

Interpretation:

- 本地 WebUI/client 已可通过授权 server profile 读取 AWS registry。
- AWS node 已真实回到 Fabric node list。
- AWS 仍不是 provider runtime host，因为没有导入 provider accounts；这符合本轮约束。
- 本机 node 是当前可启动 Codex/Claude/AGY/OpenCode session 的 runtime host。

## Tests

```text
node --test test/fabric-role-registry.test.js
tests 4
pass 4
fail 0

node --test test/server-node-rpc-wiring.test.js
tests 9
pass 9
fail 0

node --test test/fabric-real-vps-deploy.test.js
tests 21
pass 21
fail 0

node --test test/fabric-registry-heartbeat.test.js test/fabric-registry-agent.test.js
tests 15
pass 15
fail 0

node --test test/fabric-node-inventory.test.js test/fabric-registry-client.test.js
tests 6
pass 6
fail 0

npm run web:build
Webpack: Compiled successfully

npm test
tests 2626
pass 2626
fail 0
```

## Conclusion

当前闭环状态：

- AWS current 只保留默认 `9527` server。
- AWS server restart/deploy 不再对端口残留或 failed start 假成功。
- AWS registry agent 可以在 registry 被清空后通过真实 heartbeat 自愈出 `aws-current-node`。
- 本地授权 profile 读 AWS registry 返回 `nodes=2`，WebUI 的 Fabric Nodes 数据源不再是空。
- AWS 缺 runtime 是真实状态：缺 provider accounts/runtime snapshots，不是连接失败。
