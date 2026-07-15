# 2026-06-27 M3 Preflight Code Readiness Audit

## 范围

继续推进 M3 7.3 前，复核只读 preflight 是否能证明 AWS current 真正具备执行条件。

本轮只访问 AWS current：

- `ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com`
- `/home/ubuntu/aih-fabric-current`
- 默认端口 `9527`

未访问旧服务器：

- `152.70.105.41`
- `155.248.183.169`
- `39.104.59.31`

## 发现

原 preflight 只检查了 token、server、service status、install dry-run、residue，没有检查远端
代码是否已经同步到包含 7.3 安全入口的版本。

真实只读 SSH 检查显示：

```text
grep -- '--generate-management-key' lib/server/server-config-command.js -> no match
docs/fabric/13-m3-supervised-daemon-runbook.md -> missing
```

这意味着 AWS current 还不能直接执行 7.3 中的安全 management key 生成步骤。

## 修复

`scripts/fabric-m3-daemon-preflight.js` 增加远端代码就绪度检查：

- `remoteCode.generateManagementKey`
- `remoteCode.supervisedDaemonRunbook`
- `remoteCode.ready`

当 AWS current 缺少安全入口或 runbook 时，preflight 不再返回
`ready_for_confirmed_7_3_execution`。

新增 gate：

- `remote_code_missing_generate_management_key`
- `remote_runbook_missing`

## 本地验证

```bash
node --test \
  test/fabric-m3-daemon-preflight.test.js \
  test/server.command-fast-start.test.js \
  test/node-doctor.test.js \
  test/node-relay-service.test.js \
  test/fabric-registry-agent-service.test.js
```

结果：

```text
tests 59
pass 59
fail 0
```

语法检查：

```bash
node --check scripts/fabric-m3-daemon-preflight.js
node --check test/fabric-m3-daemon-preflight.test.js
```

结果：pass。

## 真实 AWS Preflight

命令：

```bash
node scripts/fabric-m3-daemon-preflight.js --json
```

脱敏结果：

```json
{
  "ok": false,
  "verdict": "preflight_failed",
  "target": {
    "ssh": "ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com",
    "remoteDir": "/home/ubuntu/aih-fabric-current",
    "nodeId": "aws-current-node",
    "port": 9527
  },
  "token": {
    "ok": true,
    "mode": "600",
    "bytes": 44
  },
  "server": {
    "readyzHttp": 200,
    "processCount": 1
  },
  "serviceStatus": {
    "managementKeyConfigured": false,
    "supervisorReady": false,
    "relay": {
      "state": "missing",
      "running": false
    },
    "registryAgent": {
      "state": "missing",
      "running": false
    },
    "issues": [
      "npm_missing",
      "management_key_missing",
      "server_loopback_only",
      "endpoint_candidate_missing"
    ]
  },
  "installDryRun": {
    "ok": true,
    "writes": false,
    "services": [
      "relay",
      "registryAgent"
    ]
  },
  "remoteCode": {
    "ready": false,
    "generateManagementKey": false,
    "supervisedDaemonRunbook": false
  },
  "residue": [],
  "remainingGate": [
    "remote_code_missing_generate_management_key",
    "remote_runbook_missing",
    "management_key_missing",
    "relay_service_not_running",
    "registry_agent_service_not_running"
  ]
}
```

## 结论

7.3 仍不能标记为 done。

下一步顺序不变：

1. 同步当前 Fabric 代码到 AWS current。
2. 重新运行只读 preflight，要求 `remoteCode.ready=true`。
3. 得到明确 `确认执行 7.3` 后，才生成 management key、重启 server、安装 user systemd services。
