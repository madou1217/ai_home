# AIH Fabric Test Plan

> **历史归档（禁止作为当前实现依据）**：本文保留旧阶段设计；其中客户端 pairing、device token、scope/revoke、Control Plane 或 Node-first 表述仅用于追溯，**不得实现或恢复**。当前客户端只使用 `Server URL + Management Key`；worker join invite 仅用于高级 worker 接入，不是客户端授权。当前规范见 [20-current-server-client-model.md](20-current-server-client-model.md) 和仓库根 [README.md](../../README.md)。

## 测试原则

- 不以单元测试代替真实网络验收。
- 不以 WebUI 能打开代替产品可用。
- 不以 relay 能连上代替远程会话可用。
- 每个实验必须记录环境、命令、时间、结果和失败原因。

## Lab 节点

当前 active 测试节点：

| 名称 | SSH | 预期角色 |
|---|---|---|
| AWS Japan | `ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com` with `/Users/model/.ssh/aws.pem` | server + relay smoke + deployment baseline |

这些记录只包含地址和登录用户，不包含私钥或 token。

当前真实状态：

- AWS Japan 新验证统一使用 `/home/ubuntu/aih-fabric-current`；不得再创建 vNN / isolated 默认部署目录。
- 当前只使用 AWS Japan 做新验证；`152.70.105.41`、`155.248.183.169`、`39.104.59.31` 只保留历史记录，不再做新部署、新探测、新清理。
- `scripts/fabric-real-vps-deploy.js` 默认远端目录为 `/home/ubuntu/aih-fabric-current`；`--skip-import` 的 transfer-only 验证不要求 `--accounts`，也不传账号包。
- AWS Japan current 已完成 transfer-only 同步、远端代码测试、Web build 和 outbound relay smoke：
  - source artifact `dbfeed88fce56b2f80926c3496593e9cbf78c15ef0cd5a374bcf99945f3f0956`，`26319739` bytes。
  - `node-runtime-cache-hit`、`node-modules-cache-hit`。
  - `node --test test/fabric-real-vps-deploy.test.js test/control-plane-profiles.test.js test/fabric-profile-gate.test.js` 49/49 pass。
  - `npm --prefix web run build` pass。
  - `node scripts/fabric-real-outbound-relay-smoke.js --timeout-ms 30000` 返回 `ok=true`、relay online、sessions RPC HTTP 200。
  - 远端复核只剩 `aih-fabric-current`，无 `aih-fabric-real-*` 目录；smoke 后无后台进程残留。
- AWS Japan current 默认 `9527` 已完成真实 relay Codex 会话 smoke：marker 命中、`/quit` accepted、`session-run-abort` accepted、cleanup `completed=true`，事后无 Codex/relay 残留。
- AWS Japan current 默认 `9527` 已完成真实 broker relay + Codex 远程会话 smoke：
  - broker outbound link connected。
  - device/client endpoint 为 `/v0/fabric/broker/servers/aws-current/proxy`，`viaProxy=true`。
  - relay online，`transportKind=relay`，`sessions.status=200`。
  - 真实 Codex 输出 `AIH_REAL_BROKER_RELAY_OK_627A`，不是 prompt 原文命中。
  - 证据：`docs/fabric/evidence/2026-06-27-outbound-broker-relay-aws-smoke.md`。
- Broker Proxy 已进入 Server Profile 配置流程：
  - Server Setup 的配对和探测保存表单都能选择 `Broker Proxy`。
  - 服务层验证 direct/broker endpoint resolver、broker metadata 持久化、bundle 导出导入、以及 direct pair URL 在 broker 模式下不覆盖 proxy endpoint。
  - `node --test "test/control-plane-profiles.test.js" "test/fabric-profile-gate.test.js"` -> 33/33 pass。
  - `npm --prefix web run build` -> pass。
  - AWS Japan current 默认 `9527` broker profile entry smoke 返回 `ok=true`、`viaProxy=true`、relay online、sessions RPC HTTP 200。
  - 证据：`docs/fabric/evidence/2026-06-27-broker-profile-ui-entry.md`。
- Broker link 断线诊断与恢复已补真实 evidence：
  - Broker proxy 离线响应返回 HTTP 503、`fabric_broker_server_offline`、`brokerStatus.online=false` 和 `lastDisconnected.disconnectReason=broker_server_link_closed`。
  - 同一个 `serverId` 重新连接后 broker proxy `readyz` 恢复 HTTP 200。
  - `aih fabric broker connect` 前台模式支持 `--reconnect-delay-ms` 与 `--max-attempts`。
  - AWS Japan current 默认 `9527` 再次通过 broker proxy -> relay -> real Codex remote session，模型输出 `AIH_BROKER_DIAGNOSTICS_RECOVERY_OK_20260627`。
  - 证据：`docs/fabric/evidence/2026-06-27-broker-diagnostics-recovery.md`。
- Broker Proxy 的 Server Setup 真实浏览器 smoke 已补：
  - 真实浏览器选择 `Broker Proxy` 并通过 broker proxy 完成 device pair。
  - `device-pair`、`descriptor`、`device-profile`、`device-nodes`、`device-status`、`device-accounts`、`device-sessions` 均返回 HTTP 200。
  - profile 持久化为 `connectionMode=broker-proxy`、`state=paired`、`authState=paired`，点击 `进入工作台` 后进入 `/ui`。
  - 浏览器 console 为 0 errors / 0 warnings。
  - 证据：`docs/fabric/evidence/2026-06-27-browser-broker-profile-smoke.md`。
- Cross-host outbound broker Server Profile/node relay/远程会话已补：
  - AWS public broker endpoint `http://43.207.102.163:9527` 当前可由本机 client 访问。
  - 本机 server 通过 outbound broker link 注册到 AWS broker，client 通过 AWS broker proxy 访问本机 default `9527`。
  - `readyz`、`descriptor`、`device-pair`、`device-profile`、`device-nodes`、`device-status`、`device-accounts`、`device-sessions` 均 HTTP 200。
  - 同一 AWS broker proxy endpoint 上，node relay sessions RPC 返回 `ok=true`、`viaProxy=true`、`relay.online=true`、sessions HTTP 200。
  - 同一 AWS broker proxy endpoint 上，真实 Codex 远程会话返回 `ok=true`、runId present、模型输出命中预期 marker，`/quit` 与 abort cleanup 均 accepted。
  - 跨主机 M2.5 判定为 pass；当前作为 broker/outbound 回归门保留。
  - 证据：`docs/fabric/evidence/2026-06-27-crosshost-outbound-broker-profile-smoke.md`。
- Cross-host API-mode relay smoke 工具已落地：`scripts/fabric-real-outbound-relay-smoke.js --node-join-url ... --device-pair-url ...` 可通过真实 join/pair API 准备 node/device，不再要求共享 host-home。
- 本机 -> AWS 公网 `http://43.207.102.163:9527` 的 API-mode smoke 当前失败在 `node_join` 阶段，错误为 HTTP timeout；这证明跨主机默认路径当前被 AWS public HTTP ingress 阻塞，而不是 relay/session cleanup 逻辑阻塞。
- 已接受 [12-outbound-broker-routing.md](12-outbound-broker-routing.md)：AWS public HTTP ingress 不再作为当前阶段阻塞点，下一步以 server/node/client 都能 outbound 的 broker proxy 路线闭环。
- M3 Role Registry measurement + UI slice 已补：
  - 当前工作区 `aih fabric registry agent` 会把 probe 摘要传入 heartbeat transport `measurement`。
  - AWS current 默认 `9527` 持久化 `local-mac-remote-node` relay measurement：`status=reachable`、`durationMs=238`。
  - Fabric Nodes 页面真实浏览器 smoke 通过：`/ui/fabric/nodes` HTTP 200，节点、Relay Health、measurement 和 online 均可见，console 0 error/0 warning。
  - 证据：`docs/fabric/evidence/2026-06-27-m3-role-registry-measurement.md`。
- M3 Role Registry two-node slice 已补：
  - AWS current 自身注册为 `aws-current-node`，与本机 `local-mac-remote-node` 共用 AWS current registry。
  - 两个节点均声明 `node + relay-node`，独立 registry readback 返回 `nodes=2`、`relayNodes=2`、`projects=2`、`transports=2`。
  - Fabric Nodes 页面真实浏览器 smoke 通过：两个 node 名称、两个 relayNodes 计数、Relay Health、reachable 和 online 均可见，console 0 error/0 warning。
  - 证据：`docs/fabric/evidence/2026-06-27-m3-role-registry-two-nodes.md`。
- M3 Role Registry service/daemon 已完成当前默认 gate：
  - AWS current 已生成不打印 token 的持久 Fabric token file，权限 `600`。
  - `aws-current-node` 已通过真实 registry HTTP register 绑定到持久 token 设备。
  - AWS current 默认 `9527` 已完成真实 `node service install --yes`，relay + registryAgent 两个 user systemd service 处于 running。
  - `scripts/fabric-m3-daemon-preflight.js --json` 当前真实返回 `ok=true`、`supervisorReady=true`、`processCount=1`、registry readback `nodes=2 relayNodes=2 projects=2 runtimes=4 transports=2`、`residue=[]`、`remainingGate=[]`。
  - 7.3 执行和回退 runbook：`docs/fabric/13-m3-supervised-daemon-runbook.md`。
  - 完成证据：`docs/fabric/evidence/2026-06-28-m3-supervised-daemon-aws.md`。
  - 早期 partial 证据 `docs/fabric/evidence/2026-06-27-m3-node-service-daemon-partial.md` 仅保留历史追溯，不再代表当前状态。
- M3 Relay Health strong metrics 已补：
  - AWS current 默认 `9527` server listener 增加 `/v0/fabric/transport/echo` WS echo endpoint，不新增产品端口。
  - 真实 `aih fabric transport echo ws://127.0.0.1:9527/v0/fabric/transport/echo --count 20` 返回 `successes=20`、`failures=0`、`rttMs.count=20`、`p95=1ms`。
  - `aih fabric registry agent` 通过 WS echo probe 写入 latest transport `measurement`：`status=ws_echo_pass`、`sampleCount=20`、`successRate=1`、`rttMs.p95=2`。
  - 同次 heartbeat 追加 `networkMeasurements` trace entry，独立 readback 返回 `networkMeasurements=2`。
  - Fabric Nodes 页面真实浏览器 smoke 通过：两个 node、`p95`、`100% ok (20)`、`ws_echo_pass` 均可见，console 0 error/0 exception。
  - 本地 focused tests 36/36 pass，AWS current focused tests 36/36 pass，Web build pass。
  - 证据：`docs/fabric/evidence/2026-06-27-m3-relay-health-strong-metrics.md`。
- M3 Fabric Nodes mobile regression 已补：
  - 390x844 mobile viewport + touch emulation 下使用真实 device pair profile 打开 AWS current `/ui/fabric/nodes`。
  - 首轮真实截图发现移动端空白：`.fabric-nodes-page.y=-1008`，根因是 mobile `.app-content` 没有稳定 flex/height 边界。
  - 修复共享 shell content 高度后复测：`headerRect.y=106`、`pageRect.y=68`、`scrollWidth=clientWidth=390`、`overflowEls=[]`。
  - 两个 node row 可见；点击 `local-mac-remote-node` 后详情标题为 `Local Mac Remote Node`，项目、runtime、transport、Relay Metadata 均可查看。
  - 页面文本仍包含 `p95`、`100% ok (20)`、`ws_echo_pass`，console 0 warning/error/exception。
  - 证据：`docs/fabric/evidence/2026-06-27-m3-fabric-nodes-mobile-regression.md`。
- AWS Japan v16 已完成真实部署、真实账号导入、server 启动、registry publish/heartbeat、foreground agent 和本机 TCP echo probe。
- AWS Japan v18 已完成 source artifact 部署和真实 outbound relay smoke：两个真实 AIH server 子进程 + 一个真实 `aih node relay connect` 子进程，设备端通过 relay 读 `/v0/node-rpc/device-node-sessions` 返回 HTTP 200。
- AWS Japan v19 已完成 `node doctor --json` 只读 supervisor 验证：Linux `systemd-user` relay service 与 Fabric registry agent service 都能被识别，隔离 home 下两者为 `missing/running=false`，`nodeSupervisor.ready=false`，没有安装或启动服务。
- AWS Japan v20 已完成 `node service status --json` 产品入口验证：同一条用户命令能汇总 relay service、Fabric registry agent service 和 supervisor readiness，隔离 home 下返回 `supervisor.ready=false` 并给出 relay/agent service 安装下一步；没有安装或启动服务。
- AWS Japan v21 已完成 `node service install --dry-run --json` 产品入口验证：同一条用户命令生成 relay service + Fabric registry agent service 安装计划，返回 `plan.writes=false`，没有写 systemd unit，没有启动后台进程。
- AWS Japan v22 已完成 `node service uninstall --dry-run --json` 回退入口验证：同一条用户命令生成 Fabric registry agent service + relay service 回退计划，返回 `plan.writes=false`，没有写/删 systemd unit，没有启动后台进程。
- 本地 M2 profile bundle 已完成服务层和 WebUI 入口验证：bundle 只导出 endpoint/descriptor/非敏感摘要，不导出 device token 或本地 profile id；导入新客户端后为 `discovered/unpaired`，必须重新 pair。
- `opc@152.70.105.41`、`ubuntu@155.248.183.169`、`root@39.104.59.31` 均不再用于新验证；测试命令不得访问这些机器。
- 弱机部署使用 `scripts/fabric-real-vps-deploy.js`；该脚本只传真实账号导出包，不生成 mock registry 数据，不写 systemd，不改防火墙，不安装系统包。
- Claude worker 必须通过 `aih claude` 的 AIH Server profile 路径调用，不应直接指定单账号；本轮正确路径 `node bin/ai-home.js claude --print ...` 超过 60 秒停在 `Waiting for claude to boot`，没有可用审阅输出。

## M1 网络实验

### Evidence Schema

每个 evidence 文件必须包含：

- scope
- environment
- commands
- raw result summary
- metrics table
- interpretation
- next checks
- verdict: `pass`, `fail`, `partial`, `inconclusive`

正式实现后，evidence 文件还要对应一条 `evidence_runs` 记录，并把指标写入 `network_measurements`。

### 1. SSH 基础连通

目标：确认测试节点可达。

命令：

```bash
ssh -i ~/.ssh/aws.pem ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com 'hostname; uname -a'
```

证据：

- 输出保存到 `docs/fabric/evidence/<date>-<topic>.md`。
- 记录延迟、失败节点、系统版本。

### 2. 小水管基准

目标：确认当前 active AWS VPS 的实际吞吐和抖动。历史多 VPS 目标暂停，非 AWS 服务器不再参与新测试。

指标：

- TCP connect time。
- TCP application-data echo RTT p50/p95。
- WSS echo RTT p50/p95。
- WebTransport connect and stream RTT。
- WebRTC signaling time and data channel RTT。
- 1KB、16KB、256KB 消息传输耗时。

### Transport Promotion Gate

Transport 只有满足 gate 后才能进入 MVP 默认路径。

当前统一执行入口：

```bash
node scripts/fabric-m6-promotion-gate.js --json
```

该入口聚合 relay fallback baseline、WebRTC DataChannel、TURN relay、WebTransport/QUIC 和 Multipath/MPTCP/OpenMPTCPRouter 的真实检查；单项 `candidateReady=true` 不能替代 `promotionReady=true`，`defaultTransport=relay` 也必须先证明 relay echo 可用。

| Transport | Promotion gate |
|---|---|
| WSS | 当前 AWS active 节点可稳定连接；1h p95 RTT 可记录；断线后 3s 内重连；resume 成功率 >= 99%。多 VPS gate 暂停，不触碰非 AWS 服务器 |
| Outbound Broker WSS | direct public ingress 失败时，server outbound link + client broker proxy 能完成 descriptor、device pair、node session API；broker 不保存 provider credentials；断开后有 diagnosable error |
| WebRTC DataChannel | 家里到公司、家里到手机、公司到手机至少 2 类场景打通；失败时可解释 NAT/ICE/TURN 原因；fallback 到 WSS 可用 |
| WebTransport/QUIC | 至少 2 台 VPS 可部署；浏览器/PWA 可连；p95 RTT 优于或接近 WSS；失败时自动降级 WSS |
| Multi-relay failover | 主 relay kill 或网络断开后 3s 内恢复 control lane；semantic event 不丢；重复事件按 seq 去重 |
| OpenMPTCPRouter/MPTCP | 只有多 WAN 环境实测优于单链路时进入高级模式；不作为 MVP 默认依赖 |

失败判定：

- 无法解释的断线为 fail。
- 只能证明 TCP 端口通但无法完成 `tcp-echo`、WebSocket echo 或 runtime session 为 fail。
- 只有本地 loopback 成功，不能证明远程可用。
- Broker 本地 loopback 成功只能证明协议和实现切片成立；跨主机 pass 必须使用真实可达 broker endpoint。
- 没有原始命令和结果的结论为 inconclusive。
- WebRTC 只有 signaling room、offer/answer/candidate 时最多为 partial；必须看到 `ICE connected`、`DataChannel open` 和 RTT 样本才能判定 data channel pass。
- Role Registry 只有 server-side API 或本地 loopback publisher smoke 通过时最多为 partial；必须有真实多节点 publisher、UI 展示、heartbeat/relay health、supervised daemon 和 readback evidence 才能判定 M3 pass。
- 弱 VPS 上不得把远端 `npm run web:build` 作为默认部署步骤；前端 production build 应在本地或 CI 完成，VPS 验收只运行 server、导入账号、发布真实 registry。

### Evidence Template

```markdown
# <date> <topic>

## Scope
## Environment
## Commands
## Metrics
| metric | value | note |
|---|---:|---|
## Results
## Interpretation
## Verdict
## Next Checks
```

### 3. 24h 心跳

目标：验证长连接稳定性。

场景：

- 家里 node -> VPS 1/VPS 2。
- 公司 node -> VPS 1/VPS 3。
- 手机/PWA -> VPS 1。

验收：

- 24h 内重连次数可见。
- 每次重连有原因和耗时。
- 没有未知断开。

## Remote Session 验收

| 场景 | 验收 |
|---|---|
| 公司控制家里项目 | 从公司 client 进入家里 node/project/runtime，创建或 attach Codex 远程开发会话 |
| 家里控制公司项目 | 从家里 client 进入公司 node/project/runtime，创建或 attach Claude 远程开发会话 |
| 手机控制会话 | 手机发送 prompt、slash、审批 |
| viewport/session state | 客户端视图变化不影响会话状态，事件 cursor 可继续 |
| detach/attach | 关闭客户端后重连不丢会话 |
| relay failover | 主 relay 断开后会话恢复 |

## 弱网测试

模拟条件：

- 高 RTT：200ms、500ms。
- 丢包：1%、5%。
- 限速：256Kbps、512Kbps、2Mbps。
- 断线：10s、60s、5min。

验收：

- 输入和审批优先到达。
- semantic event 不丢。
- 高频输出 frame 可以降帧，但 semantic event、cursor 和最终状态必须正确。
- artifact/bulk 不阻塞 control/semantic。

## 安全测试

| 测试 | 预期 |
|---|---|
| 未配对 client 访问 server | 只能读取公开 descriptor |
| 撤销 device token | 旧 token 立即失效 |
| 未授权项目启动 session | 返回 `project_not_authorized` |
| 未授权 relay role | 不能注册 relay node |
| 账号跨 node 使用 | 必须存在 account grant |
| 高风险命令审批 | 必须生成 approval request |

## 回归命令

基础回归：

```bash
npm test
node bin/ai-home.js --help
node bin/ai-home.js node --help
node bin/ai-home.js server --help
```

Fabric 专项测试后续新增：

```bash
node --test test/fabric-*.test.js
node --test test/fabric-role-registry.test.js test/server-node-rpc-wiring.test.js
node --test test/fabric-registry-publish.test.js
node --test test/fabric-real-vps-deploy.test.js
node --test test/provider-launch-strategy.test.js
node --test test/control-plane-profiles.test.js test/fabric-profile-gate.test.js
npm --prefix web run build
node scripts/fabric-registry-publish-smoke.js
# planned: node bin/ai-home.js fabric doctor
node bin/ai-home.js fabric transport probe <endpoint...> --json
node bin/ai-home.js fabric transport tcp-echo-server --host 127.0.0.1 --port 0 --json
node bin/ai-home.js fabric transport tcp-echo tcp://127.0.0.1:<port> --count 5 --json
node bin/ai-home.js fabric transport echo-server --host 127.0.0.1 --port 0 --path /echo --json
node bin/ai-home.js fabric transport echo ws://127.0.0.1:<port>/echo --count 5 --json
# WebRTC browser lab: open /ui/fabric/webrtc-lab after Server Setup pairing and record evidence.
# Current real AWS transfer-only deploy example:
# node scripts/fabric-real-vps-deploy.js --ssh ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com --ssh-key /Users/model/.ssh/aws.pem --remote-dir /home/ubuntu/aih-fabric-current --node-runtime tmp/fabric-real-deploy/node-runtime/node-v22.16.0-linux-x64.tar.xz --skip-build --skip-import --skip-start
# Current real AWS broker relay/remote session smoke:
# node scripts/fabric-real-broker-relay-smoke.js --endpoint http://127.0.0.1:9527 --server-id aws-current --token-file /home/ubuntu/aih-fabric-current/.broker-token --host-home /home/ubuntu/aih-fabric-current/.aih-host-home
# Supervised node service plan smoke:
# node bin/ai-home.js node service install http://127.0.0.1:19886 --node-id aws-v21 --token-file /path/to/device.token --dry-run --json
# node bin/ai-home.js node service uninstall --node-id aws-v22 --dry-run --json
# Non-AWS hosts 152.70.105.41, 155.248.183.169, and 39.104.59.31 must not be used for new validation.
# Claude worker evidence must use AIH Server profile, not a direct account id:
# env AIH_NO_PERSIST=1 AIH_RUNTIME_SHOW_USAGE=0 node bin/ai-home.js claude --print "<frontend task>"
```

## 完成定义

一个 Fabric 功能只有同时满足以下条件才算完成：

- 有设计文档引用。
- 有代码实现。
- 有自动化测试。
- 有真实网络或真实 runtime evidence。
- 有失败诊断。
- 用户可以按文档复现。
