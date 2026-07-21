# 2026-06-27 M3 Current Code Sync And Preflight Ready

## 范围

按 M3 7.3 todo 顺序推进第一步：

```text
同步当前 Fabric 代码到 AWS current
-> 重新运行只读 preflight，确认 remoteCode.ready=true
```

本轮只访问 AWS current：

- `ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com`
- `/home/ubuntu/aih-fabric-current`
- 默认端口 `9527`

未访问旧服务器：

- `152.70.105.41`
- `155.248.183.169`
- `39.104.59.31`

## 同步方式

当前本地 worktree 仍有另一条 Claude/Anthropic 未提交改动。为避免污染 AWS current，本轮没有使用会打包工作区的部署脚本，而是只同步已提交的 `HEAD`：

```bash
git archive --format=tar.gz -o /tmp/aih-fabric-head-27b9d13.tar.gz HEAD
scp -i ~/.ssh/aws.pem /tmp/aih-fabric-head-27b9d13.tar.gz \
  ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:/tmp/aih-fabric-head-27b9d13.tar.gz
ssh -i ~/.ssh/aws.pem ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com \
  "tar -xzf /tmp/aih-fabric-head-27b9d13.tar.gz -C /home/ubuntu/aih-fabric-current"
```

归档：

```text
path=/tmp/aih-fabric-head-27b9d13.tar.gz
bytes=2.6M
sha256=a29e6fc6eccfccc6065391d6ac1508f8e4d468647cb1ead7b967f09e93befd5c
```

未导入账号，未启动/重启 server，未写 AWS config，未安装 systemd service。

## 远端代码复核

```text
scripts/fabric-m3-daemon-preflight.js contains export PATH=${shQuote(nodeBin)}:$PATH
lib/server/server-config-command.js contains --generate-management-key
docs/fabric/13-m3-supervised-daemon-runbook.md exists
```

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
    "ready": true,
    "generateManagementKey": true,
    "supervisedDaemonRunbook": true
  },
  "residue": [],
  "remainingGate": [
    "management_key_missing",
    "relay_service_not_running",
    "registry_agent_service_not_running"
  ]
}
```

## 远端进程复核

```text
121002 ... node bin/ai-home.js server serve --host 0.0.0.0 --port 9527
```

没有发现：

- `fabric registry agent`
- `node relay connect`
- `fabric broker connect`
- `fabric-real`
- `browser-smoke`

## 结论

M3 7.3 的“同步当前 Fabric 代码到 AWS current”子步已完成。

7.3 仍不能标记为 done；剩余 gate：

- 生成并加载 `managementKey`
- 安装并启动 relay user service
- 安装并启动 registryAgent user service
- 重启 service 后验证 heartbeat 与 Fabric Nodes UI fresh measurement

上述剩余 gate 会写 AWS config 并安装 user systemd unit，必须先得到明确：

```text
确认执行 7.3
```
