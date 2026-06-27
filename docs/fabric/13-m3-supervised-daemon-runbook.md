# M3 Supervised Daemon Runbook

## 目标

关闭 M3 7.3：

```text
AWS current 默认 9527
-> server managementKey 已配置并生效
-> aws-current-node relay service 常驻
-> aws-current-node registryAgent service 常驻
-> service restart 后仍能 heartbeat
-> Fabric Nodes UI 显示 fresh measurement
```

本 runbook 只适用于当前 AWS current：

- Host: `ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com`
- Key: `/Users/model/.ssh/aws.pem`
- Dir: `/home/ubuntu/aih-fabric-current`
- Port: `9527`
- Node id: `aws-current-node`

不得访问旧服务器：

- `152.70.105.41`
- `155.248.183.169`
- `39.104.59.31`

## 当前 Preflight

2026-06-27 只读 preflight 第一版：

| check | result |
|---|---|
| token file | `/home/ubuntu/aih-fabric-current/.aih-host-home/.ai_home/fabric/aws-current-node.token` |
| token file mode | `600` |
| token file bytes | `44` |
| server process | one `bin/ai-home.js server serve --host 0.0.0.0 --port 9527` |
| `/readyz` | HTTP 200 |
| `node service status` | `ok=false`, `supervisor.ready=false` |
| blocker | `management_key_missing` |
| relay service | `systemd-user`, `state=missing`, `running=false` |
| registryAgent service | `systemd-user`, `state=missing`, `running=false` |
| install dry-run | `ok=true`, `writes=false`, services `relay`, `registryAgent` |
| residue | no remote registry agent / relay / broker / smoke process |

本地已新增安全配置入口：

```bash
aih server config set --generate-management-key
```

该入口在进程内部生成 `managementKey`，写入 `server-config.json`，输出只显示
`management_key: configured`，不会把 key 放到命令行参数或标准输出中。

验证：

```bash
node --test \
  test/server.command-fast-start.test.js \
  test/node-doctor.test.js \
  test/node-relay-service.test.js \
  test/fabric-registry-agent-service.test.js
```

结果：`52/52 pass`。

只读 preflight 可重复入口：

```bash
node scripts/fabric-m3-daemon-preflight.js --json
```

2026-06-27 真实 AWS current 结果：

```text
verdict=ready_for_confirmed_7_3_execution
token.mode=600
token.bytes=44
readyzHttp=200
server.processCount=1
installDryRun.writes=false
residue=[]
remainingGate=management_key_missing,relay_service_not_running,registry_agent_service_not_running
```

证据：`docs/fabric/evidence/2026-06-27-m3-daemon-preflight-script.md`。

后续 code readiness audit 修正了该结论：AWS current 远端代码尚未包含
`--generate-management-key`，且未同步本 runbook，因此当前真实 preflight 为：

```text
verdict=preflight_failed
remoteCode.ready=false
remoteCode.generateManagementKey=false
remoteCode.supervisedDaemonRunbook=false
remainingGate=remote_code_missing_generate_management_key,remote_runbook_missing,management_key_missing,relay_service_not_running,registry_agent_service_not_running
```

证据：`docs/fabric/evidence/2026-06-27-m3-preflight-code-readiness-audit.md`。

所以真实执行顺序必须是：

```text
同步当前 Fabric 代码到 AWS current
-> 重新运行只读 preflight，确认 remoteCode.ready=true
-> 再进入 managementKey 生成和 service install
```

## 执行前确认

以下步骤会写 AWS current 配置并安装 user systemd unit，必须先得到明确确认。

确认文本：

```text
确认执行 7.3
```

## 执行步骤

### 1. 同步当前 Fabric 代码到 AWS current

必须先同步当前 worktree，因为 `--generate-management-key` 是本轮新增的安全入口。
同步仍使用单一 current 目录，不能创建 vNN/isolated 目录，不能新增产品端口。

验收：

```text
/home/ubuntu/aih-fabric-current contains current server-config-command.js
AWS current still serves only default 9527
```

### 2. 生成并保存 server managementKey

在 AWS current 执行：

```bash
cd /home/ubuntu/aih-fabric-current
PATH=/home/ubuntu/aih-fabric-current/.node-runtime/node-v22.16.0-linux-x64/bin:$PATH \
AIH_HOST_HOME=/home/ubuntu/aih-fabric-current/.aih-host-home \
node bin/ai-home.js server config set \
  --generate-management-key \
  --open-network \
  --port 9527 \
  --json
```

要求：

- 不使用 `--management-key <secret>`。
- 不打印 secret。
- 输出只允许出现 `managementKeyConfigured=true` 等脱敏状态。

### 3. 重启 AWS current server

配置写入后必须让 9527 server 重新加载配置：

```bash
cd /home/ubuntu/aih-fabric-current
PATH=/home/ubuntu/aih-fabric-current/.node-runtime/node-v22.16.0-linux-x64/bin:$PATH \
AIH_HOST_HOME=/home/ubuntu/aih-fabric-current/.aih-host-home \
node bin/ai-home.js server restart
```

验收：

```bash
curl --noproxy '*' -s -o /tmp/aih-readyz-after-mgmt.json -w '%{http_code}' \
  http://127.0.0.1:9527/readyz
```

必须返回 `200`。

再确认 supervisor 不再报 `management_key_missing`：

```bash
cd /home/ubuntu/aih-fabric-current
PATH=/home/ubuntu/aih-fabric-current/.node-runtime/node-v22.16.0-linux-x64/bin:$PATH \
AIH_HOST_HOME=/home/ubuntu/aih-fabric-current/.aih-host-home \
AIH_CLI_PATH=/home/ubuntu/aih-fabric-current/bin/ai-home.js \
node bin/ai-home.js node service status \
  --control-url http://127.0.0.1:9527 \
  --node-id aws-current-node \
  --json
```

要求：

- `status.server.managementKeyConfigured=true`
- `issues` 不包含 `management_key_missing`
- `services.relay.state=missing`
- `services.registryAgent.state=missing`

### 4. 安装 supervised services

先复核 dry-run：

```bash
cd /home/ubuntu/aih-fabric-current
PATH=/home/ubuntu/aih-fabric-current/.node-runtime/node-v22.16.0-linux-x64/bin:$PATH \
AIH_HOST_HOME=/home/ubuntu/aih-fabric-current/.aih-host-home \
AIH_CLI_PATH=/home/ubuntu/aih-fabric-current/bin/ai-home.js \
node bin/ai-home.js node service install \
  http://127.0.0.1:9527 \
  --node-id aws-current-node \
  --token-file /home/ubuntu/aih-fabric-current/.aih-host-home/.ai_home/fabric/aws-current-node.token \
  --status online \
  --relay-status online \
  --transport relay=online \
  --probe-transport relay=ws://127.0.0.1:9527/v0/fabric/transport/echo \
  --probe-count 20 \
  --probe-payload-size 64 \
  --probe-timeout-ms 10000 \
  --interval-ms 30000 \
  --dry-run \
  --json
```

要求：`plan.writes=false`。

确认 dry-run 后执行真实 install：

```bash
cd /home/ubuntu/aih-fabric-current
PATH=/home/ubuntu/aih-fabric-current/.node-runtime/node-v22.16.0-linux-x64/bin:$PATH \
AIH_HOST_HOME=/home/ubuntu/aih-fabric-current/.aih-host-home \
AIH_CLI_PATH=/home/ubuntu/aih-fabric-current/bin/ai-home.js \
node bin/ai-home.js node service install \
  http://127.0.0.1:9527 \
  --node-id aws-current-node \
  --token-file /home/ubuntu/aih-fabric-current/.aih-host-home/.ai_home/fabric/aws-current-node.token \
  --status online \
  --relay-status online \
  --transport relay=online \
  --probe-transport relay=ws://127.0.0.1:9527/v0/fabric/transport/echo \
  --probe-count 20 \
  --probe-payload-size 64 \
  --probe-timeout-ms 10000 \
  --interval-ms 30000 \
  --yes \
  --json
```

要求：

- `ok=true`
- `dryRun=false`
- `status.services.relay.running=true`
- `status.services.registryAgent.running=true`
- `status.supervisor.ready=true`

### 5. 重启后验证

重启两个 user service：

```bash
systemctl --user restart com.clawdcodex.ai_home.node-relay.aws-current-node.service
systemctl --user restart com.clawdcodex.ai_home.fabric-registry-agent.aws-current-node.service
```

等待至少一个 registry agent interval：

```bash
sleep 40
```

再次查询：

```bash
cd /home/ubuntu/aih-fabric-current
PATH=/home/ubuntu/aih-fabric-current/.node-runtime/node-v22.16.0-linux-x64/bin:$PATH \
AIH_HOST_HOME=/home/ubuntu/aih-fabric-current/.aih-host-home \
AIH_CLI_PATH=/home/ubuntu/aih-fabric-current/bin/ai-home.js \
node bin/ai-home.js node service status \
  --control-url http://127.0.0.1:9527 \
  --node-id aws-current-node \
  --json
```

要求：

- `ok=true`
- `supervisor.ready=true`
- `relay.running=true`
- `registryAgent.running=true`

### 6. Registry 和 UI 验收

Registry readback：

```text
读取 /home/ubuntu/aih-fabric-current/.aih-host-home/.ai_home/fabric-registry.json
确认 aws-current-node-relay latest measurement measuredAt 晚于 service restart
确认 status=ws_echo_pass 或 reachable
确认 sampleCount/successRate/p95 存在
```

真实浏览器打开：

```text
http://43.207.102.163:9527/ui/fabric/nodes
```

要求：

- `aws-current-node` 可见
- Relay Health 可见
- p95 / success rate / status 可见
- console error/warning 为 0

### 7. 残留和 secret 检查

检查只有预期后台服务：

```bash
ps -axo pid,command | grep -E 'fabric registry agent|node relay connect|fabric broker connect|fabric-real|browser-smoke' | grep -v grep
```

要求：

- 只允许 systemd 管理的 `node relay connect` 和 `fabric registry agent`。
- 不允许 smoke/browser/broker 临时进程。

检查 service 文件不含 raw token 或 management key：

```bash
grep -R "Bearer\\|managementKey\\|AIH_SERVER_MANAGEMENT_KEY" \
  /home/ubuntu/aih-fabric-current/.aih-host-home/.config/systemd/user/com.clawdcodex.ai_home.*aws-current-node.service
```

要求：

- service 文件不得包含 raw token。
- service 文件不得包含 raw management key。
- registry agent service 只能引用 `--token-file`。
- relay service 必须从 server config 读取 management key，不允许在 unit 中持久化 key。

## 回退步骤

如果 relay 或 registryAgent 持续失败：

```bash
cd /home/ubuntu/aih-fabric-current
PATH=/home/ubuntu/aih-fabric-current/.node-runtime/node-v22.16.0-linux-x64/bin:$PATH \
AIH_HOST_HOME=/home/ubuntu/aih-fabric-current/.aih-host-home \
AIH_CLI_PATH=/home/ubuntu/aih-fabric-current/bin/ai-home.js \
node bin/ai-home.js node service uninstall \
  --node-id aws-current-node \
  --yes \
  --json
```

如需清除 managementKey：

```bash
cd /home/ubuntu/aih-fabric-current
PATH=/home/ubuntu/aih-fabric-current/.node-runtime/node-v22.16.0-linux-x64/bin:$PATH \
AIH_HOST_HOME=/home/ubuntu/aih-fabric-current/.aih-host-home \
node bin/ai-home.js server config set \
  --clear-management-key \
  --json

PATH=/home/ubuntu/aih-fabric-current/.node-runtime/node-v22.16.0-linux-x64/bin:$PATH \
AIH_HOST_HOME=/home/ubuntu/aih-fabric-current/.aih-host-home \
node bin/ai-home.js server restart
```

回退验收：

- `node service status --json` 返回 `relay.state=missing`
- `registryAgent.state=missing`
- `/readyz` 仍 HTTP 200
- 无临时 smoke 残留进程

## Done 条件

M3 7.3 只能在以下条件全部满足时改为 done：

- AWS current 使用默认 `9527`。
- `management_key_missing` 消失。
- relay service installed/enabled/running。
- registryAgent service installed/enabled/running。
- `node service status --json` 返回 `supervisor.ready=true`。
- service restart 后 heartbeat 继续刷新。
- Fabric Nodes UI 真实浏览器 smoke 通过。
- service 文件不包含 raw token 或 raw management key。
- evidence 文件记录命令、脱敏结果、截图路径、残留检查。
