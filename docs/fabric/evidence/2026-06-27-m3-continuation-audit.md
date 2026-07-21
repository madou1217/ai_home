# 2026-06-27 M3 Continuation Audit

## 范围

本审计回答当前执行问题：

```text
检查当前 plan，保持 todo list 为唯一权威来源；
中途新增需求先加到 todo，再按顺序推进并闭环。
```

本轮没有新增服务器目标，只使用本机和 AWS current：

- `ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com`
- `/home/ubuntu/aih-fabric-current`
- 默认端口 `9527`

未访问旧服务器 `152.70.105.41`、`155.248.183.169`、`39.104.59.31`。

## Todo 审计

权威 todo 来源：

- `docs/fabric/08-current-status.md`

当前顶层状态：

| item | state | evidence |
|---:|---|---|
| 1 | done | M0 设计包已落在 `docs/fabric/00-*.md` 到 `12-outbound-broker-routing.md` |
| 2 | done | AWS current 是唯一 active VPS target |
| 3 | done | AWS current 默认 `9527` 的真实 `/v1/responses`、relay Codex session、broker relay Codex session、diagnostics recovery 证据已存在 |
| 4 | done | Server Profile gate 真实浏览器 smoke 证据已存在 |
| 5 | done | Broker Proxy Server Setup 真实浏览器 smoke 证据已存在 |
| 6 | done | Cross-host outbound-only broker 证据已存在 |
| 7 | partial | M3 Role Registry 仍未关闭，唯一原因是 7.3 supervised daemon install/start 未完成 |
| 8 | pending | 7.3 未关闭前不得开始 |
| 9 | pending | 7.3 未关闭前不得开始 |
| 10 | pending | 7.3 未关闭前不得开始 |

当前 M3 状态：

| item | state | evidence |
|---:|---|---|
| 7.1 | done | `2026-06-27-m3-role-registry-measurement.md` |
| 7.2 | done | `2026-06-27-m3-role-registry-two-nodes.md` |
| 7.3 | partial | `2026-06-27-m3-node-service-daemon-partial.md` |
| 7.4 | done | `2026-06-27-m3-relay-health-strong-metrics.md` |
| 7.5 | done | `2026-06-27-m3-fabric-nodes-mobile-regression.md` |

## 验证

本地 scoped tests：

```bash
node --test \
  test/fabric-registry-agent.test.js \
  test/fabric-registry-heartbeat.test.js \
  test/fabric-role-registry.test.js \
  test/fabric-registry-client.test.js \
  test/server-node-rpc-wiring.test.js \
  test/fabric-transport-echo.test.js
```

结果：

```text
tests 36
pass 36
fail 0
```

本地 Web build：

```bash
npm --prefix web run build
```

结果：

```text
pass
仅保留既有 Vite chunk-size warning
```

AWS focused tests：

```bash
ssh -i "/Users/model/.ssh/aws.pem" \
  "ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com" \
  "cd /home/ubuntu/aih-fabric-current && \
   PATH=/home/ubuntu/aih-fabric-current/.node-runtime/node-v22.16.0-linux-x64/bin:\$PATH \
   node --test \
     test/fabric-registry-agent.test.js \
     test/fabric-registry-heartbeat.test.js \
     test/fabric-role-registry.test.js \
     test/fabric-registry-client.test.js \
     test/server-node-rpc-wiring.test.js \
     test/fabric-transport-echo.test.js"
```

结果：

```text
tests 36
pass 36
fail 0
```

AWS 默认端口 WS echo：

```bash
ssh -i "/Users/model/.ssh/aws.pem" \
  "ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com" \
  "cd /home/ubuntu/aih-fabric-current && \
   PATH=/home/ubuntu/aih-fabric-current/.node-runtime/node-v22.16.0-linux-x64/bin:\$PATH \
   node bin/ai-home.js fabric transport echo \
     ws://127.0.0.1:9527/v0/fabric/transport/echo \
     --count 20 \
     --json"
```

脱敏结果：

```json
{
  "ok": true,
  "target": "ws://127.0.0.1:9527/v0/fabric/transport/echo",
  "count": 20,
  "successes": 20,
  "failures": [],
  "rttMs": {
    "count": 20,
    "p95": 2
  }
}
```

AWS 残留检查：

```text
server serve: 默认端口 9527 上只有一个进程
fabric registry agent / node relay connect / broker / smoke residue: none
/readyz: HTTP 200
```

本机残留检查：

```text
移动端 browser smoke Chrome profile /tmp/aih-chrome-fabric-mobile-profile: 已关闭
local-mac-remote-node registry agent 和 relay connect: 仍作为真实本机节点链路运行，未杀
```

## 工作区边界

Fabric/M3 文件和另一条 Anthropic/Claude 改动混在同一个 dirty worktree。
后续 Fabric/M3 只能 stage 或 commit Fabric 文件。

不要把这些无关文件 stage 到 Fabric/M3：

- `lib/cli/services/ai-cli/launch-profile/claude-strategy.js`
- `lib/server/anthropic-server-tool-compat.js`
- `lib/server/upstream-endpoints.js`
- `test/anthropic-server-tool-compat.test.js`
- `test/provider-launch-strategy.test.js`
- `test/server.upstream-endpoints.test.js`
- `lib/account/anthropic-endpoint.js`
- `test/claude-strategy-advisor-tool.test.js`

## 剩余 Gate

M3 7.3 不能标记为 done，直到 AWS current 上完成真实 supervised daemon
install/start，并验证重启后仍然自动在线。

下一步执行会写 AWS current 配置和 user systemd unit，因此必须显式确认：

```text
写 AWS current managementKey / remote-node secret
执行 node service install ... --yes
验证 relay + registryAgent services running
验证 service restart 或 user daemon restart 后 heartbeat 仍继续
验证 Fabric Nodes UI 仍显示 aws-current-node online 且 measurement 刷新
```

## 结论

partial

Todo list 当前是有序且可追溯的。M3 只剩 7.3 真实 supervised daemon
install/start 的显式确认 gate；在 7.3 关闭前，不进入 M4/M5/transport
promotion。
