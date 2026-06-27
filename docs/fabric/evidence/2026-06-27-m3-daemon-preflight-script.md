# 2026-06-27 M3 Daemon Preflight Script

## 范围

为 M3 7.3 增加可重复的只读 preflight：

```text
AWS current default 9527
-> token file stat
-> node service status
-> node service install --dry-run
-> readyz
-> server process count
-> residue process check
```

该脚本不写 AWS 配置、不安装 systemd、不读取或打印 token 内容。

## 新增入口

```bash
node scripts/fabric-m3-daemon-preflight.js --json
```

默认目标：

- SSH: `ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com`
- Key: `~/.ssh/aws.pem`
- Remote dir: `/home/ubuntu/aih-fabric-current`
- Node id: `aws-current-node`
- Port: `9527`

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
tests 56
pass 56
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
  "ok": true,
  "verdict": "ready_for_confirmed_7_3_execution",
  "target": {
    "ssh": "ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com",
    "remoteDir": "/home/ubuntu/aih-fabric-current",
    "nodeId": "aws-current-node",
    "port": 9527
  },
  "token": {
    "ok": true,
    "path": "/home/ubuntu/aih-fabric-current/.aih-host-home/.ai_home/fabric/aws-current-node.token",
    "mode": "600",
    "bytes": 44
  },
  "server": {
    "readyzHttp": 200,
    "processCount": 1
  },
  "serviceStatus": {
    "ok": false,
    "managementKeyConfigured": false,
    "supervisorReady": false,
    "relay": {
      "state": "missing",
      "running": false,
      "unit": "com.clawdcodex.ai_home.node-relay.aws-current-node.service"
    },
    "registryAgent": {
      "state": "missing",
      "running": false,
      "unit": "com.clawdcodex.ai_home.fabric-registry-agent.aws-current-node.service"
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
  "residue": [],
  "remainingGate": [
    "management_key_missing",
    "relay_service_not_running",
    "registry_agent_service_not_running"
  ]
}
```

## 结论

pass

7.3 进入真实安装前的只读状态已可一键复核。AWS current 已准备好在明确确认后进入
`managementKey` 生成、server restart 和 `node service install --yes` 阶段。

7.3 仍不能标记为 done，因为 user systemd services 尚未安装，`supervisor.ready=false`。
