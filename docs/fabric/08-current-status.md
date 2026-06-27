# AIH Fabric Current Status

## 2026-06-27 Current VPS Target Set

当前新验证目标已经切换为单节点验证：

- Active:
  - `ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com` with `/Users/model/.ssh/aws.pem`
- Do not use for new tests:
  - `opc@152.70.105.41`
  - `ubuntu@155.248.183.169`
  - `root@39.104.59.31`

除 AWS current 外，其他服务器只保留历史证据，不再做新部署、新探测、新清理。

最新真实证据：

- Active Todo（后续有新需求先追加到这里，再按顺序推进）：

  | 顺序 | 状态 | 事项 | 当前证据 | 下一步验收 |
  |---:|---|---|---|---|
  | 1 | done | M0 设计包落地：产品说明、拓扑、流程、ER、协议、线框、测试计划、生命周期、迁移边界、竞品/传输研究 | `docs/fabric/00-*.md` 到 `12-outbound-broker-routing.md` 已存在 | 后续只随真实实现补差，不重新发散 |
  | 2 | done | 当前测试目标收敛为 AWS current，禁止继续使用旧 152/155/39.104 | 本文件 “Current VPS Target Set” 已声明 AWS only | 所有新 smoke 命令只访问 AWS current 或本机默认端口 |
  | 3 | done | AWS current 默认 `9527` 上完成真实 `/v1/responses`、relay Codex 会话、broker relay Codex 会话、broker diagnostics recovery | `2026-06-27-outbound-broker-relay-aws-smoke.md`、`2026-06-27-broker-diagnostics-recovery.md` | 后续复测仍要用默认 `9527`，不新增端口 |
  | 4 | done | Server Profile 解耦第一刀：无 profile 进入 `/ui/server-setup`，配对成功后进入工作台 | `2026-06-26-fabric-browser-pairing-smoke.md` | 保持 browser smoke 作为 UI 改动回归门 |
  | 5 | done | Broker Proxy 接入 Server Setup 的真实浏览器 smoke | `2026-06-27-browser-broker-profile-smoke.md`：真实浏览器配对、device profile/status/accounts/sessions 全部经 broker proxy 返回 200，console 0 error/0 warning，进入 `/ui`；同 allowlist 已同步到 AWS current 默认 `9527` 并通过 broker proxy device route smoke | 已由第 6 项跨主机 broker endpoint 验收闭环 |
  | 6 | done | 跨主机 outbound-only broker 验收 | `2026-06-27-crosshost-outbound-broker-profile-smoke.md`：本机 client -> AWS public broker -> 本机 server outbound link -> 本机 node relay -> Codex 远程会话已完成；readyz、descriptor、device pair、device scoped reads、sessions RPC 和真实 Codex marker 均通过 | 下一步进入 M3 Role Registry 产品闭环 |
  | 7 | done | M3 Role Registry 产品闭环：home/company node + relay-node、周期心跳/daemon、UI 节点页、relay health measurement、本地 AWS 可见性 | server API、publisher、heartbeat、foreground agent、Fabric Nodes UI 已有；`2026-06-27-m3-role-registry-measurement.md` 已证明 AWS current 默认 `9527` 可持久化 relay measurement 并在 UI 展示；`2026-06-27-m3-role-registry-two-nodes.md` 已证明本机 + AWS current 两个真实 node/relay-node 可同屏展示；`2026-06-27-m3-relay-health-strong-metrics.md` 已证明默认 `9527` WS echo p95/成功率/networkMeasurements trace；`2026-06-27-m3-fabric-nodes-mobile-regression.md` 已证明移动端多节点 UI 回归；`2026-06-28-m3-supervised-daemon-aws.md` 已证明 AWS current 默认 `9527` 上 relay + registryAgent 两个 user systemd service 长期运行、`supervisor.ready=true`、fresh `ws_echo_pass` measurement、unit/process 不含 raw secret；`2026-06-28-m3-local-aws-visibility.md` 已证明本机真实浏览器有 paired AWS server profile、Fabric Nodes 从 AWS registry 读到 2 个真实 node/relay-node、AWS 已加入本地 SSH 开发机管理且连接/目录浏览通过 | M3 完成；下一步进入 8/M4 远程开发会话重新规划 |
  | 8 | pending | M4 远程开发会话：以 server profile -> node -> project -> runtime -> session 的可理解路径替代旧 M4 专用入口路线 | `14-m4-remote-development-session.md` 已冻结新方向；旧入口路线已删除 | 继续 M4 Todo Queue：先做 8.2 Session catalog + attach contract，再做 command/event/recovery |
  | 9 | pending | M5 Recovery：ack/resume、relay failover、audit events、diagnostics export | broker 同 `serverId` 断开恢复已验证；未覆盖 multi-broker/failover/semantic event 不丢 | kill relay/broker 后 3 秒内恢复，session event 可 resume 且不重复 |
  | 10 | pending | WebRTC DataChannel / WebTransport QUIC / Multipath QUIC promotion lab | WebRTC signaling pass，但 DataChannel open/RTT 未通过；QUIC/WebTransport 未成 promotion evidence | 用 headed browser、手机/跨机、STUN/TURN 和明确 RTT 指标补证；未达 gate 前不设默认 |

- AWS Japan 已收敛为唯一 current 部署目录：`/home/ubuntu/aih-fabric-current`。
- AWS current 默认端口部署已重新收敛到 `9527`：
  - Deploy command 未传 `--port`，启动日志为 `listen: http://0.0.0.0:9527`。
  - 最新 source artifact 为 `94de613e7fe53fd1a0b145307c8256f4e3c8990f2cd2a3df41ab59bf6f1a6895`，`26340463` bytes。
  - PID 检查只发现一个 `77912 node bin/ai-home.js server serve --host 0.0.0.0 --port 9527`，没有 `9528`。
  - `http://127.0.0.1:9527/readyz` 返回 `ready=true`，账号池为 `codex=3, gemini=1, claude=4, agy=7, opencode=0`。
  - 公网 TCP `43.207.102.163:9527` 可连接，但 `curl --noproxy "*" --max-time 10 http://43.207.102.163:9527/readyz` 仍 0 bytes timeout；公网 HTTP ingress 不能作为当前产品依赖。
- AWS current 默认端口真实 broker relay + Codex remote session 已通过：
  - `scripts/fabric-real-broker-relay-smoke.js --endpoint http://127.0.0.1:9527 --server-id aws-current --token-file /home/ubuntu/aih-fabric-current/.broker-token` 返回 `ok=true`。
  - device/client endpoint 为 `http://127.0.0.1:9527/v0/fabric/broker/servers/aws-current/proxy`，报告 `viaProxy=true`。
  - broker outbound link connected，relay online，`transportKind=relay`，`sessions.status=200`，`rpc=control_plane.device.node_sessions`。
  - 真实 Codex remote session 使用 `codex account 1`、`model=gpt-5.5`，`startStatus=200`，runId present，模型输出命中 `AIH_REAL_BROKER_RELAY_OK_627A`。
  - marker 不在 prompt 中原样出现，prompt 只要求模型用 underscores 拼接分散单词。
  - `/quit` accepted，cleanup completed；本地和远端均无 `fabric-real`、`fabric broker connect`、`node relay connect`、`aws-current-broker` 残留进程。
  - 本地回归：focused 49/49 pass，`npm test` 2507/2507 pass，`git diff --check` pass。
  - 证据：`docs/fabric/evidence/2026-06-27-outbound-broker-relay-aws-smoke.md`。
- Broker Proxy 已接入 Server Profile 产品入口：
  - `/ui/server-setup` 的配对和探测保存表单都支持 `直连 Server` / `Broker Proxy`。
  - Broker 模式使用 `brokerEndpoint + serverId` 生成 `/v0/fabric/broker/servers/{serverId}/proxy` endpoint。
  - 保存、导入导出和配对都会保留 `connectionMode=broker-proxy` 与 broker metadata；device token 仍不导出。
  - 粘贴 direct pair URL 但选择 Broker 模式时，device pair 请求仍走 broker proxy endpoint。
  - 本地回归：`control-plane-profiles + fabric-profile-gate` 33/33 pass，`npm --prefix web run build` pass。
  - AWS current 默认 `9527` profile-entry broker relay smoke 通过：`viaProxy=true`，relay online，sessions RPC 200，远端无残留进程。
  - `aih claude` 按 AIH Server profile 路径尝试前端审查，但超过 60 秒仍停在 `Waiting for claude to boot`，没有产出审查文本。
  - 证据：`docs/fabric/evidence/2026-06-27-broker-profile-ui-entry.md`。
- Broker link 断开诊断与同 `serverId` 恢复已在 AWS current 默认 `9527` 验证：
  - registry 保存 `lastDisconnected` 快照，包含 `disconnectReason`、`closeCode`、`connectedAt`、`lastSeenAt`、`disconnectedAt`。
  - broker proxy 离线响应返回 HTTP 503、`fabric_broker_server_offline` 和 `brokerStatus.lastDisconnected.disconnectReason=broker_server_link_closed`。
  - 同一 `serverId` 重新建立 outbound broker link 后，broker proxy `readyz` 恢复 HTTP 200。
  - `aih fabric broker connect` 前台模式支持 `--reconnect-delay-ms` 和 `--max-attempts`，可作为长期 outbound link 的受控重连入口。
  - AWS current 默认 `9527` 再次通过 broker proxy -> relay -> real Codex remote session；模型输出命中 `AIH_BROKER_DIAGNOSTICS_RECOVERY_OK_20260627`，`/quit` 与 abort cleanup 均 accepted。
  - 远端残留进程检查为空，没有留下 diagnostics smoke、broker relay smoke、broker connect 或 relay connect 进程。
  - 证据：`docs/fabric/evidence/2026-06-27-broker-diagnostics-recovery.md`。
- Broker Proxy 的 Server Setup 真实浏览器 smoke 已完成：
  - 新增 `scripts/fabric-browser-broker-profile-smoke-server.js`，启动隔离 AIH server，并建立真实 outbound broker control link。
  - 真实浏览器打开 `/ui/server-setup`，选择 `Broker Proxy`，填写 broker endpoint 和 server id，通过 broker proxy 消费真实 pair URL。
  - 首轮发现真实 403 缺口：Server Setup refresh 需要 `device-profile`、`device-status`、`device-accounts`、`device-sessions` 四个 device-scoped GET 路由通过 broker。
  - Broker allowlist 已补这四个最小路由，仍不开放 management API 或 `/v1/responses`。
  - 复测请求均为 200：`device-pair`、`descriptor`、`device-profile`、`device-nodes`、`device-status`、`device-accounts`、`device-sessions`。
  - 浏览器 console 为 0 errors / 0 warnings；profile 保存为 `connectionMode=broker-proxy`、`state=paired`、`authState=paired`，点击 `进入工作台` 后进入 `/ui`。
  - 本地回归：`node --test test/fabric-broker-routing.test.js test/control-plane-profiles.test.js test/fabric-profile-gate.test.js` -> 41/41 pass；`npm --prefix web run build` pass。
  - AWS current 默认 `9527` 已同步 allowlist 并重启，唯一 server 进程为 `110864 node bin/ai-home.js server serve --host 0.0.0.0 --port 9527`，`AIH_FABRIC_BROKER_TOKEN` env present。
  - AWS current 远端 `node --test test/fabric-broker-routing.test.js` -> 8/8 pass；broker proxy device route smoke 返回 pair 200，`descriptor/profile/nodes/status/accounts/sessions` 全部 200。
  - AWS current 事后无 broker connect 或 smoke 残留进程；`/readyz` 仍为账号清理后的 `ready=false, accounts=0`，不影响本次 broker/device route 结论。
  - 证据：`docs/fabric/evidence/2026-06-27-browser-broker-profile-smoke.md`。
- 跨主机 outbound broker Server Profile/node relay/remote session 已完成：
  - AWS public `http://43.207.102.163:9527/readyz` 当前 HTTP 200。
  - 本机 AIH server 通过 `aih fabric broker connect http://43.207.102.163:9527 --server-id local-mac-crosshost --local-url http://127.0.0.1:9527` 主动 outbound 注册到 AWS broker。
  - 本机 client 通过 AWS public broker proxy 访问本机 server：`readyz` 和 `/v0/fabric/descriptor` 均 200。
  - 真实 local device invite 通过 AWS broker proxy 完成 pair，返回 device token；`device-profile`、`device-nodes`、`device-status`、`device-accounts`、`device-sessions` 均 200。
  - 同一 broker proxy endpoint 触发 `scripts/fabric-real-outbound-relay-smoke.js`，node relay online，`transportKind=relay`，sessions RPC HTTP 200。
  - 同一 broker proxy endpoint 启动真实 Codex 远程会话，`codex account 1`、`model=gpt-5.5`、runId present，输出命中预期 marker。
  - `/quit` accepted，abort cleanup accepted；cleanup 后本机无 `local-mac-crosshost` / smoke / broker connect 残留，AWS 只剩默认 `9527` server pid `110864`；broker proxy 对 `local-mac-crosshost` 返回可诊断 offline。
  - 证据：`docs/fabric/evidence/2026-06-27-crosshost-outbound-broker-profile-smoke.md`。
- M3 Role Registry measurement + UI slice 已完成：
  - 本轮修复 agent -> heartbeat -> server registry -> Web UI 的 relay measurement 链路。
  - `aih fabric registry agent` 会把 probe 摘要写入 transport `measurement`，server 按白名单持久化 `status/durationMs/successes/failures/rttMs/measuredAt`。
  - Fabric Nodes UI 不再把 `online` relay transport 误判为 `pending-measurement`，并显示 measurement 摘要。
  - AWS current 默认 `9527` 已同步服务端最小变更和 Web build；当前 server pid 为 `113275`。
  - 真实 local agent -> AWS current heartbeat 通过：`ok=true`、`attempts=1`、`failures=0`、probe `health=online`、`status=reachable`、`durationMs=238`。
  - 独立 registry readback 返回 `counts=nodes:1, relayNodes:1, transports:1, projects:1, runtimes:4`，relay transport 含 `measurement.status=reachable`、`durationMs=238`。
  - 真实浏览器打开 `http://43.207.102.163:9527/ui/fabric/nodes`，节点、Relay Health、measurement 和 online 均可见，console 0 error/0 warning。
  - 本地回归：Fabric registry focused 21/21 pass，`node --check` pass，`npm --prefix web run build` pass。
  - 证据：`docs/fabric/evidence/2026-06-27-m3-role-registry-measurement.md`。
- M3 Role Registry two-node slice 已完成：
  - AWS current 自身通过 `scripts/fabric-real-vps-registry-publish.js --port 9527 --node-id aws-current-node` 注册为第二个真实 `node + relay-node`。
  - 本轮未访问旧 `152/155/39.104`，未新增产品端口；AWS current 仍使用默认 `9527`。
  - AWS self publish `ok=true`，roles 为 `node, relay-node`，heartbeat `ok=true`，foreground agent `ok=true`、`attempts=1`、`failures=0`、probe `status=reachable`、`durationMs=33`。
  - 独立 registry readback 返回 `nodes=2, relayNodes=2, transports=2, projects=2, runtimes=4`；node ids 为 `aws-current-node` 和 `local-mac-remote-node`。
  - 两条 relay transport 均为 `online`，且均含 measurement。
  - 真实浏览器打开 `http://43.207.102.163:9527/ui/fabric/nodes`，两个节点、两个 relayNodes、Relay Health、reachable 和 online 均可见，console 0 error/0 warning。
  - 证据：`docs/fabric/evidence/2026-06-27-m3-role-registry-two-nodes.md`。
- M3 Role Registry service/daemon partial 已补：
  - AWS current 生成了持久 Fabric device token file：`/home/ubuntu/aih-fabric-current/.aih-host-home/.ai_home/fabric/aws-current-node.token`，权限 `600`，证据不打印 token。
  - 首次 5 次 heartbeat 长跑失败为 `forbidden_fabric_node_owner`，确认 7.2 自注册使用一次性内存 token，未持久化 owner token。
  - 通过真实 `POST /v0/fabric/registry/nodes` 将 `aws-current-node` 重新绑定到持久 token 设备 `fabric-agent-aws-current-node`，registry 总计仍为 `nodes=2, relayNodes=2, transports=2, projects=2, runtimes=4`。
  - 第二次 `aih fabric registry agent` 以 10 秒间隔运行 5 次，返回 `ok=true`、`attempts=5`、`failures=0`，probe `status=reachable`、`durationMs=4`，独立 readback 显示 `aws-current-node-relay` measurement 已更新。
  - `node service install --dry-run` 在 AWS current 返回 `ok=true`、`writes=false`，计划包含 `relay` 和 `registryAgent`；`node service status` 明确两个 systemd user unit 仍为 `missing`，且 `management_key_missing` 阻塞真实安装。
  - `aih server config set --generate-management-key` 已补为本地安全前置入口，后续 7.3 可由 CLI 内部生成 management key，避免在 argv/stdout 暴露。
  - `scripts/fabric-m3-daemon-preflight.js --json` 已补为只读 preflight 入口；真实 AWS current 返回 `verdict=ready_for_confirmed_7_3_execution`、`installDryRun.writes=false`、`residue=[]`。
  - `13-m3-supervised-daemon-runbook.md` 已落地 7.3 执行、验收和回退步骤。
  - 事后无 `fabric registry agent` 或 `node relay connect` 残留进程，未安装 systemd unit。
  - 本地服务/registry focused tests：53/53 pass；`fabric-m3-daemon-preflight + server.command-fast-start + node-doctor + node-relay-service + fabric-registry-agent-service` 56/56 pass。
  - 证据：`docs/fabric/evidence/2026-06-27-m3-node-service-daemon-partial.md`。
- M3 preflight code readiness audit 已完成：
  - 只读 SSH 复核发现 AWS current 远端代码尚未包含 `--generate-management-key`，且未包含 `13-m3-supervised-daemon-runbook.md`。
  - `scripts/fabric-m3-daemon-preflight.js --json` 已补远端代码就绪度检查：`remoteCode.generateManagementKey`、`remoteCode.supervisedDaemonRunbook`、`remoteCode.ready`。
  - 修复后真实 AWS current preflight 返回 `ok=false`、`verdict=preflight_failed`，remaining gate 增加 `remote_code_missing_generate_management_key` 和 `remote_runbook_missing`。
  - 本地 preflight/service focused tests：59/59 pass；`node --check` pass。
  - 证据：`docs/fabric/evidence/2026-06-27-m3-preflight-code-readiness-audit.md`。
- M3 current code sync + preflight ready 已完成：
  - 为避免 dirty worktree 中 Claude/Anthropic 未提交改动污染 AWS current，本轮使用 `git archive HEAD` 同步已提交代码，未使用工作区打包路径。
  - 同步归档 `/tmp/aih-fabric-head-27b9d13.tar.gz`，sha256=`a29e6fc6eccfccc6065391d6ac1508f8e4d468647cb1ead7b967f09e93befd5c`，大小 `2.6M`。
  - AWS current 远端复核：preflight 脚本包含 PATH 修复，`server-config-command.js` 包含 `--generate-management-key`，`13-m3-supervised-daemon-runbook.md` 已存在。
  - 真实 `node scripts/fabric-m3-daemon-preflight.js --json` 返回 `ok=true`、`verdict=ready_for_confirmed_7_3_execution`、`remoteCode.ready=true`、`installDryRun.writes=false`、`residue=[]`。
  - AWS current 进程表只剩一个默认 `9527` server，没有 registry agent、relay connect、broker 或 smoke 残留。
  - 证据：`docs/fabric/evidence/2026-06-27-m3-current-code-sync-preflight-ready.md`。
- M3 Relay Health strong metrics 已完成：
  - AWS current 默认 `9527` server listener 已增加 `/v0/fabric/transport/echo` WS echo endpoint，不新增产品端口。
  - 真实 direct WS echo 返回 `ok=true`、`successes=20`、`failures=0`、`rttMs.count=20`、`p95=1ms`。
  - 真实 `aih fabric registry agent` 通过 `relay=ws://127.0.0.1:9527/v0/fabric/transport/echo` 写入 `aws-current-node-relay` latest measurement：`status=ws_echo_pass`、`sampleCount=20`、`successRate=1`、`rttMs.p95=2`。
  - 同次 heartbeat 追加 `networkMeasurements` trace；独立 readback 返回 `networkMeasurements=2`，latest entry 指向 `aws-current-node-relay`。
  - 真实浏览器打开 `http://43.207.102.163:9527/ui/fabric/nodes`，两个节点、`p95`、`100% ok (20)`、`ws_echo_pass` 均可见，console 0 error/0 exception。
  - AWS current 只剩默认 `9527` server pid `121002`，无 registry agent、relay connect、transport echo 或 browser smoke 残留进程。
  - 本地 focused tests 36/36 pass；AWS current focused tests 36/36 pass；Web build pass。
  - 证据：`docs/fabric/evidence/2026-06-27-m3-relay-health-strong-metrics.md`。
- M3 Fabric Nodes mobile regression 已完成：
  - 真实 Chrome mobile viewport `390x844` + touch emulation，通过 AWS current 真实 device pair profile 打开 `/ui/fabric/nodes`。
  - 首轮发现并修复移动端空白首屏：`.fabric-nodes-page` 被布局到 `y=-1008`，根因是 mobile `.app-content` 缺少稳定 height/flex 边界。
  - 修复后复测 `headerRect.y=106`、`pageRect.y=68`、content scroll container `720/3633`，无横向溢出，`overflowEls=[]`。
  - 两个 node row 可见；点击 `local-mac-remote-node` 后详情切换为 `Local Mac Remote Node`，项目、runtime、transport、Relay Metadata 均可查看。
  - 页面仍显示 `p95`、`100% ok (20)`、`ws_echo_pass`，console 0 warning/error/exception。
  - 截图：`/tmp/aih-m3-fabric-nodes-mobile-390-fixed.png`、`/tmp/aih-m3-fabric-nodes-mobile-390-detail.png`。
  - 证据：`docs/fabric/evidence/2026-06-27-m3-fabric-nodes-mobile-regression.md`。
- M3 continuation audit 已完成：
  - 当前 authoritative todo 仍是本文件的 Active Todo 和 M3 Todo Queue；后续新增需求必须先追加到对应 todo，再按顺序推进。
  - 本轮复核确认 top-level 1-6 done，7 partial，8-10 pending；M3 7.1、7.2、7.4、7.5 done，只有 7.3 partial。
  - 复核命令不访问旧 `152/155/39.104`，只使用本机与 AWS current 默认 `9527`。
  - 本地 focused tests 36/36 pass，AWS focused tests 36/36 pass，Web build pass，AWS WS echo 20/20 pass 且 p95=2ms。
  - AWS current 只剩默认 `9527` server，无 registry agent、relay connect、broker 或 smoke 残留；本机移动端验证 Chrome 已关闭。
  - 工作区仍混有另一条 Anthropic/Claude 改动，Fabric/M3 后续提交只能 stage Fabric 文件。
  - 证据：`docs/fabric/evidence/2026-06-27-m3-continuation-audit.md`。
- AWS current 默认端口真实 Codex `/v1/responses` 已在重新部署后通过：
  - non-stream：`POST http://127.0.0.1:9527/v1/responses`，`x-provider=codex`，`model=gpt-5.5`，`store=false`，HTTP 200，`response.output_text` 包含 `AIH_AWS_CODEX_NONSTREAM_REDEPLOY_9527_OK_20260627`。
  - stream：同 endpoint，`stream=true`，HTTP 200，`response.output_text.done` 包含 `AIH_AWS_CODEX_STREAM_REDEPLOY_9527_OK_20260627`。
- AWS current 默认端口真实 relay Codex runtime 会话已通过：
  - `scripts/fabric-real-outbound-relay-smoke.js --endpoint http://127.0.0.1:9527 --session-provider codex --session-account 1 --session-model gpt-5.5` 返回 `ok=true`。
  - control/node health 均为 `true`，`relay.status=online`，`transportKind=relay`，device scopes 包含 `sessions:read` 和 `sessions:write`。
  - Codex runtime 会话输出命中预期 marker。
  - output events 为 `ready=1, output=437, aborted=1`；`/quit` accepted，`session-run-abort` accepted，cleanup `completed=true`。
  - smoke 后远端进程表无 Codex/relay 残留，只剩 `node bin/ai-home.js server serve --host 0.0.0.0 --port 9527`。
- 跨主机 API relay smoke 已推进到真实 node join 准备阶段：
  - `scripts/fabric-real-outbound-relay-smoke.js` 新增 `--node-join-url` 和 `--device-pair-url`，endpoint 模式可通过真实 `/v0/node-rpc/join` 与 `/v0/fabric/device-pair` 准备 node/device，不再要求共享 server host-home。
  - 本机 -> AWS 公网 `http://43.207.102.163:9527` 真实 API-mode smoke 在 `node_join` 阶段超时：`node_join_request_failed:The operation was aborted due to timeout`。
  - 失败报告明确 `preparation.mode=api`、`phase=node_join`；relay child 未启动，AWS 事后仍只剩 `--port 9527` server。
  - 证据：`docs/fabric/evidence/2026-06-27-cross-host-api-relay-smoke-attempt.md`。
- 真实请求中发现并本地修复两个 Codex adapter 缺口：
  - 本地路由字段 `provider` 不应转发给上游 Codex。
  - non-stream `/v1/responses` 需要从 `response.output_item.done` 事件补齐 `response.completed.output=[]` 的可见文本。
  - 本地验证：`node --check lib/server/codex-adapter.js` pass；`node --test test/server.codex-adapter.test.js` 28/28 pass；Fabric/session/Codex adapter 定向集合 70/70 pass。
- 本轮为 relay runtime completion 补了真实 cleanup 链：
  - Codex project trust 写入账号级 `CODEX_HOME` 下的 `.codex/config.toml`，避免 runtime CLI 仍弹 trust prompt。
  - control-plane/node-rpc/relay allowlist 增加 `session-run-abort`，smoke 在 marker 命中后通过 abort RPC 关闭 runtime 子进程。
  - account 3 的 relay runtime 失败已确认为账号密钥问题：Codex 返回 `401 Incorrect API key provided: yesboss-****udou`；不计为 relay/control-plane 失败。
- AWS 不可用期间，本机默认 `9527` 已用当前 worktree 补充真实 runtime 排错证据：
  - 临时停止并恢复本机 `com.clawdcodex.ai_home` LaunchAgent；当前 worktree server 以 `AIH_SERVER_STRICT_PORT=1` 启动在 `0.0.0.0:9527`，未使用新端口作为有效证据。
  - 当前 worktree `/v1/responses` non-stream 真实返回 `AIH_LOCAL_CODEX_NONSTREAM_9527_OK_20260627`，`response.output` 与 `response.output_text` 均有可见文本。
  - 当前 worktree `POST /v0/node-rpc/session-start` 启动真实 Codex runtime session，返回 runId；output events 为 `ready=1, output=2730`，模型回复包含预期 marker。
  - 本轮发现并修复 macOS runtime session spawn 两个真实问题：primary loader spawn 失败时需 fallback 到 secondary loader；POSIX shell shim 需要通过 shell wrapper 启动。
  - 本地回归：runtime/session/server/relay/deploy focused tests -> 79/79 pass。
  - 本机原 LaunchAgent 已恢复，`127.0.0.1:9527/readyz` 返回 `ready=true`，本轮 marker 子进程无残留。
- `scripts/fabric-real-vps-deploy.js` 默认远端目录已改为 `/home/ubuntu/aih-fabric-current`；`--skip-import` 时不再要求 `--accounts`，transfer-only 不传账号包、不启动 server、不创建版本目录。
- 2026-06-27 current-only 真实同步结果：
  - Source artifact: `dbfeed88fce56b2f80926c3496593e9cbf78c15ef0cd5a374bcf99945f3f0956`，`26319739` bytes。
  - `node-runtime-cache-hit`、`node-modules-cache-hit`。
  - 远端目录复核只剩 `aih-fabric-current`；没有 `aih-fabric-real-*` 版本目录。
  - 远端残留进程检查为空，没有留下 `server serve`、`node relay connect`、registry agent 或 smoke 进程。
- AWS current 验证结果：
  - `node --check lib/server/control-plane-device-session-start.js lib/server/node-rpc-router.js lib/cli/services/node/relay-client.js lib/server/remote/relay-server.js scripts/fabric-real-outbound-relay-smoke.js` -> pass。
  - `node --test test/fabric-real-outbound-relay-smoke.test.js` -> 9/9 pass。
  - `node --test test/control-plane-device-session-start.test.js test/server-node-rpc-wiring.test.js test/node-relay-client.test.js test/fabric-real-outbound-relay-smoke.test.js test/codex-project-registry.test.js` -> 43/43 pass。
  - runtime/session/server/relay/deploy focused tests -> 79/79 pass。
  - `node --test test/fabric-real-vps-deploy.test.js test/control-plane-profiles.test.js test/fabric-profile-gate.test.js` -> 49/49 pass。
  - `npm --prefix web run build` -> pass，仅保留既有 Vite chunk size warning。
  - `node scripts/fabric-real-outbound-relay-smoke.js --timeout-ms 30000` -> `ok=true`、`relay.status=online`、`transportKind=relay`、`sessions.status=200`、`sessions.rpc=control_plane.device.node_sessions`。
- `155.248.183.169` 保留历史 v12 证据，但不再作为 active target 使用。
- AWS Japan 历史 v16 部署：`/home/ubuntu/aih-fabric-real-20260627-isolated-v16`，端口 `19684`。该证据保留用于追溯，不再作为新部署形态。
- AWS 初始无系统 Node/npm，但有 `curl/python3`；导入真实账号包时使用 Python zipfile fallback，没有安装系统包。
- AWS v16 真实导入为 `imported=15 duplicates=0 invalid=0 failed=0`，账号池为 `codex=3, gemini=1, claude=4, agy=7`。
- AWS v16 `fabric registry agent service status` 只读检查通过，识别为 `systemd-user`，状态为 `missing`，没有安装 service。
- AWS v16 完成真实 registry publish、heartbeat、foreground agent `--count 2` 和 TCP echo probe：
  - `agent.ok=true`
  - `agent.attempts=2`
  - `agent.failures=0`
  - `agent.probes[0].status=tcp_echo_pass`
  - `registryCounts=nodes=1, relayNodes=1, transports=1, projects=1, runtimes=4`
  - `runtimeProviders=codex/gemini/claude/agy`
  - `transportKinds=relay:online`
- 小水管部署优化新增 source artifact cache：
  - 本地连续两次 source artifact 构建 sha/bytes 一致：`2ff0d858463a62a11fb7a21d7710c451980bfee3db99d83a3369e9712fb13aad`，`26298869` bytes。
  - AWS v16 首次上传稳定 source artifact 后，AWS v17 transfer-only 命中 `source-cache-hit`，同时命中 `node-runtime-cache-hit` 和 `node-modules-cache-hit`。
- AWS v18 完成真实 outbound relay smoke：
  - Remote dir: `/home/ubuntu/aih-fabric-real-20260627-isolated-v18`。
  - 部署模式：`--skip-import --skip-start`，只同步当前源码和依赖缓存，不启动持久 server。
  - Source artifact: `e7e4389f4eca4f3f36e01fa1d149f0ba8c25f04814f2d1aa702a83a220ca88e2`，`26304154` bytes；远端 `node-runtime-cache-hit`、`node-modules-cache-hit`。
  - `node scripts/fabric-real-outbound-relay-smoke.js --timeout-ms 30000` 在 AWS 上返回 `ok=true`。
  - Smoke 使用两个真实 AIH server 子进程和一个真实 `aih node relay connect` 子进程；`relay.status=online`、`transportKind=relay`、`transportStatuses=relay:up`。
  - 设备端通过 `/v0/node-rpc/device-node-sessions` 经 relay 读到远端 node local server，`status=200`、`rpc=control_plane.device.node_sessions`。
  - Smoke 后远端进程残留检查为空；没有安装 systemd、没有改防火墙/安全组、没有开放公网端口。
- AWS v19 完成真实 `node doctor` / supervisor 只读验证：
  - Remote dir: `/home/ubuntu/aih-fabric-real-20260627-isolated-v19`。
  - 部署模式：`--skip-import --skip-start`，只同步当前源码和依赖缓存，不启动 server，不安装 service。
  - Source artifact: `ad447fa105b2b218913531600c6c2d1cf697c8368d97ec5130dcf63de0ba4aaf`，`26305489` bytes。
  - 远端 `AIH_CLI_PATH` 指向 v19 `bin/ai-home.js` 后，doctor 识别 `aih.ok=true`、`platform=linux/x64`、`services.relay.type=systemd-user`、`services.registryAgent.type=systemd-user`。
  - 隔离 home 未写 server config，doctor 正确报告 `management_key_missing`；两个 service 都是 `state=missing/running=false`，`nodeSupervisor.ready=false`。
  - v19 未留下新进程；只读检查发现 AWS 上仍有 v13-v16 旧 `server serve` 进程，未获确认前不停止。
- AWS v20 完成真实 `node service status` 产品入口验证：
  - Remote dir: `/home/ubuntu/aih-fabric-real-20260627-isolated-v20`。
  - 部署模式：`--skip-import --skip-start`，只同步当前源码和依赖缓存，不启动 server，不安装 service。
  - Source artifact: `ed232cc0c1ecbb9c63b1b7c1474ab328a77ddac46ce906d61f4bc01f17338db1`，`26307277` bytes。
  - 远端 `node bin/ai-home.js node service status --control-url http://127.0.0.1:19885 --node-id aws-v20 --json` 返回 `action=status`、`services.relay.type=systemd-user`、`services.registryAgent.type=systemd-user`、`supervisor.ready=false`。
  - v20 无残留进程；该命令是面向用户的统一节点长期在线状态入口，不再要求用户分别理解 relay service 与 registry agent service。
- AWS v21 完成真实 `node service install --dry-run` 产品入口验证：
  - Remote dir: `/home/ubuntu/aih-fabric-real-20260627-isolated-v21`。
  - 部署模式：`--skip-import --skip-start`，只同步当前源码和依赖缓存，不启动 server，不安装 service。
  - Source artifact: `412a2f1311c29181a536e9437076d3dd6b1296dac326e1c19eccf2151686fc87`，`26311266` bytes。
  - 远端 `node bin/ai-home.js node service install http://127.0.0.1:19886 --node-id aws-v21 --token-file ... --dry-run --json` 返回 `ok=true`、`dryRun=true`、`plan.writes=false`、`services=[relay,registryAgent]`。
  - v21 明确返回 `no-service-dir` 与 `no-v21-process`；没有写 systemd unit，没有启动后台进程。
- AWS v22 完成真实 `node service uninstall --dry-run` 回退入口验证：
  - Remote dir: `/home/ubuntu/aih-fabric-real-20260627-isolated-v22`。
  - 部署模式：`--skip-import --skip-start`，只同步当前源码和依赖缓存，不启动 server，不卸载 service。
  - Source artifact: `3d96dff582250a7cde53357ab8e3f5cd6ab06e25208521b29bf12a4644b6bdc7`，`26314708` bytes。
  - 远端 `node bin/ai-home.js node service uninstall --node-id aws-v22 --dry-run --json` 返回 `ok=true`、`dryRun=true`、`plan.writes=false`、`services=[registryAgent,relay]`。
  - v22 明确返回 `no-service-dir` 与 `no-v22-process`；没有写/删 systemd unit，没有启动后台进程。
- 本地 M2 Server Profile bundle 入口完成：
  - Web client `/ui/server-setup` 增加 `导出当前`、`导出全部`、`导入 Profile`。
  - bundle 格式为 `kind=aih-control-plane-profile-bundle, version=1`。
  - 导出只包含 endpoint、descriptor、node/account/session 摘要和 warnings；不包含 `deviceToken`、本地 profile id 或任何 raw secret。
  - 导入到新客户端后 profile 为 `discovered/unpaired`，必须重新 device pairing 才能 ready。
  - 本地验证：`node --test test/control-plane-profiles.test.js test/fabric-profile-gate.test.js` 29/29 pass；`npm --prefix web run build` pass。
- 本轮重新按正确路径尝试 Claude worker：
  - 错误路径 `aih claude 4/5` 不应作为前端 worker 证据。
  - 正确路径 `node bin/ai-home.js claude --print ...` 显示 `Running claude (AIH Server)`，但超过 60 秒停在 `Waiting for claude to boot`，未产出审阅内容或 diff。
- 本地公网 HTTP ingress probe 仍失败：
  - `nc -vz -w 5 43.207.102.163 9527 -> TCP connect succeeded`
  - `curl --noproxy "*" --max-time 10 http://43.207.102.163:9527/readyz -> timeout with 0 bytes received`
- 已接受并实现 outbound broker routing 第一刀：
  - 新增 [12-outbound-broker-routing.md](12-outbound-broker-routing.md)，明确 direct public ingress 不再作为默认依赖；server/node/client 都应能走 outbound broker/relay。
  - `aih server` 同一 HTTP/WSS listener 支持 broker control WebSocket `/v0/fabric/broker/control` 和 broker proxy base `/v0/fabric/broker/servers/<serverId>/proxy`。
  - 新增 `aih fabric broker connect <broker-url> --server-id ID --token TOKEN --local-url http://127.0.0.1:9527`，用于 AIH Server 主动 outbound 注册到 broker。
  - 新增 `scripts/fabric-real-broker-smoke.js`，作为默认端口真实 broker smoke 入口；它不启动 server、不分配新端口，只连接已运行 endpoint，并通过 broker proxy 验证 readyz/descriptor/device-pair。
  - 新增 `scripts/fabric-real-broker-relay-smoke.js`，保持 broker outbound link 在线，再把 broker proxy base 作为 device/client endpoint 调用现有 outbound relay smoke。
  - Broker allowlist 第一阶段只开放 `/readyz`、Fabric descriptor/pair/registry 和 device node session API；不代理 `/v0/management/accounts` 或 `/v1/responses`。
  - 本地真实 socket 验证通过：`node --test test/fabric-broker-routing.test.js` -> 6/6 pass；真实 HTTP server + 真实 WebSocket broker control link 完成 readyz、descriptor、device-pair 和 `device-node-session-start` 代理。
  - 相关回归通过：`node --test test/fabric-broker-routing.test.js test/fabric-transport-echo.test.js test/fabric-registry-publish.test.js test/server-node-rpc-wiring.test.js test/root.router.test.js test/help.messages.test.js` -> 53/53 pass。
  - 本机默认 `127.0.0.1:9527` broker smoke 当前返回结构化失败 `phase=broker_connect` / `Unexpected server response: 404`，原因是正在运行的 `/opt/homebrew/bin/aih server serve` 进程尚未包含本轮 broker upgrade 路径；未停止或替换该本机服务。
  - AWS current 默认 `9527` broker relay + real Codex remote session 通过，证据：`docs/fabric/evidence/2026-06-27-outbound-broker-relay-aws-smoke.md`。
  - 本地协议证据：`docs/fabric/evidence/2026-06-27-outbound-broker-routing-local-smoke.md`。

当前结论：

- 当前部署纪律已经改为单一 `/home/ubuntu/aih-fabric-current`，后续不得再用 vNN / isolated 目录作为默认验证路径。
- Registry/agent/本机 TCP echo 的历史证据在 AWS v16 上成立；真实 outbound relay 管理链路、sessions RPC smoke、`/v1/responses` non-stream/stream、relay Codex 会话 cleanup、以及 broker proxy -> relay -> Codex 远程会话已在 AWS current 默认 `9527` 上验证成立；节点长期在线前置诊断和双服务 supervisor 汇总的历史证据在 AWS v19 上成立；面向用户的统一 `node service status` 入口历史证据在 AWS v20 上成立；受监督 `node service install` / `uninstall` dry-run 产品入口历史证据在 AWS v21/v22 上成立；Server Profile bundle 的本地迁移入口已成立；非 AWS 服务器只保留历史证据，不再继续验证。
- Raw public HTTP ingress 仍不成立，产品默认路线不能依赖开放高端口。
- 小水管部署路径已经从“每个 isolated deploy 都重传源码”推进到“稳定 source artifact 远端缓存复用”；受监督 node agent 已有统一 status、install dry-run 和 uninstall dry-run 入口，并已在 AWS current 默认 `9527` 完成真实 systemd user service 安装、重启、heartbeat 和 fresh measurement 验收；多客户端 Server Profile 已有无 secret bundle 迁移入口；outbound broker routing 已完成本地真实 socket 闭环、AWS current 默认端口真实远程会话闭环、Broker Profile 产品入口、broker link 断开诊断和同 `serverId` 恢复、Broker Profile 的真实浏览器 Server Setup smoke，以及真实可达 AWS broker endpoint 的跨主机 outbound-only Server Profile/node relay/Codex 远程会话验收。本机真实浏览器已完成 paired AWS server profile，Fabric Nodes 能从 AWS registry 看到 2 个真实 node/relay-node，AWS current 也已加入本地 SSH 开发机管理并通过连接/目录浏览。M3 已完成；M4 已重新收敛为远程开发会话入口设计，旧 M4 专用入口删除，不再作为计划推进；不再卡 AWS 高端口 public ingress。

## M3 Todo Queue

后续新增 M3 需求先追加到这里，再按顺序推进：

| 顺序 | 状态 | 子项 | 当前证据 | 下一步验收 |
|---:|---|---|---|---|
| 7.1 | done | heartbeat 写入 relay measurement，Fabric Nodes UI 正确展示 relay health | `2026-06-27-m3-role-registry-measurement.md` | 作为后续 UI/agent 回归门保留 |
| 7.2 | done | 第二真实节点 evidence：至少区分 home/company 风格的 node + relay-node | `2026-06-27-m3-role-registry-two-nodes.md`：`local-mac-remote-node` + `aws-current-node` 两个真实 node/relay-node 已同屏展示 | 作为后续多节点 UI/registry 回归门保留 |
| 7.3 | done | 长期 daemon/service：registry agent + relay 自动在线 | `2026-06-28-m3-supervised-daemon-aws.md`：AWS current 默认 `9527` 已完成真实 `node service install --yes`、relay + registryAgent user systemd service active、`supervisor.ready=true`、重启后 fresh `aws-current-node-relay` measurement 为 `ws_echo_pass` / `20` samples / `successRate=1` / `p95=1ms`；同时修复 service `AIH_HOST_HOME` 传递、remote-node secret 缺失导致的 relay 401、server restart argv raw secret 泄露 | 作为后续 7.6、本地 Fabric Nodes 和远程开发会话的长期在线回归门保留 |
| 7.4 | done | relay health 强指标：p95 RTT、echo 成功率、失败原因 | `2026-06-27-m3-relay-health-strong-metrics.md`：AWS current 默认 `9527` WS echo 20/20 pass，latest measurement 和 `networkMeasurements` trace 均落盘，Fabric Nodes UI 显示 `p95`、`100% ok (20)`、`ws_echo_pass` | 作为后续 relay health/UI 回归门保留 |
| 7.5 | done | 节点页移动端/多节点真实浏览器回归 | `2026-06-27-m3-fabric-nodes-mobile-regression.md`：390x844 mobile viewport 真实配对 profile，两个节点可见，点击节点后详情可用，无横向溢出，console 0 issue | 作为后续移动端 UI 回归门保留 |
| 7.6 | done | 本地 AWS 可见性：完成本地 ready server profile，并将 AWS 加入 SSH 开发机管理 | `2026-06-28-m3-local-aws-visibility.md`：本地真实浏览器 Playwright `aih-76` 的 active server 为 `http://43.207.102.163:9527`、profile state 为 `paired`、Fabric Nodes 显示 `nodes=2` / `relayNodes=2` / `projects=2` / `runtimes=4` / `transports=2`，AWS Current Node 在线且 relay health 为 `p95 1ms · 100% ok (20) · ws_echo_pass`；本地 SSH 开发机包含 `AWS Current Japan` 和 `AIH Fabric Current` workspace，SSH test `status=reachable`，browse `/home/ubuntu/aih-fabric-current` 返回真实目录 | M3 完成；后续如果要让不同浏览器免重新配对，需要做共享本地 server-profile store |

## M4 Todo Queue

后续新增 M4 需求先追加到这里，再按顺序推进。详细设计以 [14-m4-remote-development-session.md](14-m4-remote-development-session.md) 为准。

| 顺序 | 状态 | 子项 | 当前证据 | 下一步验收 |
|---:|---|---|---|---|
| 8.0 | done | 删除旧 M4 路线和历史 M4 baseline 证据 | commit `9da184a` 删除旧路线、M4 baseline 证据和相关计划文案；全仓搜索无废弃 route 标识 | 作为后续防回归搜索门保留 |
| 8.1 | done | M4 远程开发会话设计冻结：拓扑、流程、功能矩阵、状态机、数据模型增量、协议边界、验收 gate | `14-m4-remote-development-session.md` 已落地 | 后续新增需求必须先追加到本 queue，再实现 |
| 8.2 | pending | Session catalog + attach contract | 当前只有旧 sessions RPC 和远程会话数据面 smoke，缺少稳定 session catalog/attach contract | server 可按 node/project/runtime 列出 active/recent session，并按 stable session id attach，返回 snapshot/cursor/allowed commands |
| 8.3 | pending | Canonical command envelope：message、slash、approval_response、stop 分离 | 现有 input payload 语义不足，slash 与 approval prompt id 边界需要协议化 | 普通 slash 不携带 approval id；approval_response 只能引用 active approval；所有命令带 idempotency key |
| 8.4 | pending | Event store + seq/ack/resume | broker 同 `serverId` 恢复已验证，但 session event resume 未形成统一 contract | client 断开重连后从 cursor 续流，不重复、不丢 semantic event |
| 8.5 | pending | Approval and artifact lanes | 当前缺少 approval/artifact 与普通消息流的分层验收 | approval request 可审批/拒绝；大输出以 artifact ref 出现，不阻塞消息和诊断 |
| 8.6 | pending | AWS current 真实 smoke | 只能使用 AWS current 默认 `9527`，不能碰旧服务器或 mock | paired AWS profile 经默认 `9527` 打开或 attach 真实远程开发会话，记录 session id、cursor、status、cleanup/detach evidence |
| 8.7 | pending | Mobile/PWA smoke | M3 只证明 Fabric Nodes mobile 可浏览，未证明远程开发会话可用 | 移动 viewport attach、发送 message/slash、approval response、reconnect 恢复均通过 |

## 2026-06-26

已完成：

- Fabric 立项和设计包初版。
- 角色叠加模型：client、server、node、relay node、agent runtime。
- server-first 客户端流程：未配置 server 时不得直接进入旧 WebUI。
- 公司/家里互管 walkthrough。
- command/output + semantic 双层协议草案。
- Provider runtime 交互能力边界：MVP 承诺消息、slash、审批和会话恢复；GUI bridge 进入后续独立 contract。
- 数据模型补齐 audit、relay link、transport session、network measurement、evidence run。
- Transport promotion gate：WSS、WebRTC、WebTransport/QUIC、multi-relay、OpenMPTCPRouter/MPTCP。
- 从立项到发布的 Fabric 阶段门和追溯规则。
- 旧 Control Plane/remote node 到 Fabric 的迁移映射。
- 项目内协作 skills：
  - `docs/fabric/skills/aih-codex-implementer`
  - `docs/fabric/skills/aih-claude-architect-reviewer`
  - `docs/fabric/skills/aih-claude-frontend-worker`
- Fabric transport CLI 初版：
  - `aih fabric transport probe`
  - `aih fabric transport tcp-echo`
  - `aih fabric transport tcp-echo-server`
  - `aih fabric transport echo`
  - `aih fabric transport echo-server`
- M2 Server Profile 解耦第一刀：
  - Web client 启动时检查 ready server profile。
  - 未 paired / 缺 device token 时重定向到独立 `/ui/server-setup`。
  - `/ui/server-setup` 提供 pair URL/code、endpoint 探测、profile 列表、ready 后进入工作台。
  - Server 公开 `/v0/fabric/descriptor` 和 `/v0/fabric/device-pair`，新 invite URL 指向 `/ui/server-setup`。
  - 前端 Server Setup 优先读取 Fabric descriptor / pairing endpoint，再落到现有 profile store。
  - 侧栏和移动顶部显示当前 server selector。
  - 旧 `Settings -> 控制面` 保留为高级设置入口，不再作为默认 first-run 页面。
- M1 WebRTC Signaling Lab 第一刀：
  - Server 公开 `/v0/fabric/webrtc/signaling/rooms` 和 room messages endpoint。
  - Web UI 新增 `/ui/fabric/webrtc-lab`，可创建 room、生成 answerer 分享 URL、展示 connection/ICE/signaling/candidate/signal 诊断状态。
  - Answerer 通过 `room&role=answerer` URL 自动启动，避免只打开页面但没有 join。
  - 当前只证明 signaling 和 UI 状态机；DataChannel open/RTT 仍未通过 promotion gate。
- M3 Role Registry Server API 第一刀：
  - Server 公开 `/v0/fabric/registry` 和 `/v0/fabric/registry/nodes`。
  - Node registration 可声明 `node` / `relay-node` 角色、projects、runtimes、transport endpoints 和 relay capacity。
  - 写入需要 `nodes:write` device token；读取需要 `nodes:read`。
  - Fabric registry 写入 `fabric-registry.json`，同时把兼容的 node/relay transport 镜像到旧 remote registry。
- M3 Role Registry Publisher 第一刀：
  - 新增 `aih fabric registry publish <server-url> --token TOKEN ...`。
  - 支持 `--node-id`、`--relay-node`、`--bandwidth-kbps`、`--project`、`--runtime`、`--transport`、`--json`。
  - 当前只发送一次 node snapshot，不保存 token、不安装服务、不启动 daemon。
- M3 Real Registry Publisher 第二刀：
  - `aih fabric registry publish` 新增 `--from-server`，从目标 server 的真实 `/v0/management/accounts` 推导 API runtimes。
  - Fabric runtime provider 白名单补入 `gemini`，避免真实账号池中的 Gemini 被 registry 丢弃。
  - 新增 `scripts/fabric-real-vps-registry-publish.js`，用于远端本机创建 device invite、发布真实 node+relay-node snapshot、读回 Fabric registry 和旧 node view，输出脱敏证据。
- M3 Registry Heartbeat 第三刀：
  - Server 新增 `POST /v0/fabric/registry/heartbeat`。
  - 新增 `aih fabric registry heartbeat <server-url> --node-id ID ...`。
  - Heartbeat 只更新 node/relay/transport liveness，不替换已发布的 projects/runtimes。
  - Heartbeat 使用 `nodes:write` device token，并校验 node owner device。
  - 真实 VPS registry evidence runner 已扩展为 publish 后立即 heartbeat，再读回 registry 和旧 node view。
- M3 Foreground Registry Agent 第四刀：
  - 新增 `aih fabric registry agent <server-url> --node-id ID ...`。
  - Agent 复用 heartbeat sender，按 interval 循环上报 node/relay/transport liveness。
  - 支持 `--count` / `--once`，用于真实 smoke 时有限循环，不留下后台进程。
  - 当前是前台进程，不安装 systemd/launchd，不保存 token，不改系统配置。
  - 真实 VPS registry evidence runner 已扩展为 publish -> heartbeat -> agent `--count 2` -> registry readback。
- M3 Registry Agent Transport Probe 第五刀：
  - `aih fabric registry agent` 新增 `--probe-transport kind=url`。
  - Agent 每轮 heartbeat 前执行真实 transport probe，并让 probe 结果覆盖同 kind 的手填 health。
  - probe 结果只输出 `kind/health/error/duration/status`，不回显完整 URL。
  - 真实 VPS registry evidence runner 默认探测 `relay=http://127.0.0.1:<port>/healthz`。
  - 这证明 agent 可接入真实测量，但还不是跨机器 relay/data-plane echo。
- 小水管真实部署优化：
  - `scripts/fabric-real-vps-deploy.js` 增加远端 Node runtime 缓存，按 sha256 校验后复用。
  - 增加远端 `node_modules` 缓存，缓存 key 来自本地 `package.json + package-lock.json`。
  - 目标是让 2-3Mbps VPS 不再每次 evidence 部署都重传 29-30MB runtime 或重跑完整 npm install。
  - 仍不安装系统包、不改 systemd、不改防火墙/安全组。

真实证据：

- `docs/fabric/evidence/2026-06-26-vps-ssh-baseline.md`
  - `root@39.104.59.31` 可 SSH，且有 node/curl/python3。
  - `opc@152.70.105.41` 和 `ubuntu@155.248.183.169` TCP 22 可达，但 SSH banner 8s/25s 超时，暂不适合作为首批 relay 安装目标。
  - `aih fabric transport probe` 已验证三台 VPS 的 TCP 22 都可达。
- `docs/fabric/evidence/2026-06-26-legacy-remote-node-source-audit.md`
  - 旧实现是 Control Plane hub-and-spoke，不是 Fabric 终态。
  - `node-router`、`relay-client`、`relay-server`、`remote-gateway` 可作为 Fabric WSS/relay baseline 资产复用。
  - `/test` 只能证明管理链路，不等于真实 provider runtime session 成功。
- `docs/fabric/evidence/2026-06-26-ws-echo-lab.md`
  - 本地 `fabric transport echo-server` + `fabric transport echo` 已跑通，能产出 RTT。
  - 本地 `fabric transport tcp-echo-server` + `fabric transport tcp-echo` 已跑通，能验证 raw TCP 应用数据往返。
  - `39.104.59.31` 上 Node 可用但缺 `ws`；未安装依赖。
  - `39.104.59.31:18768` 公网 TCP 可达，但 HTTP/WS 应用层超时，不能作为 WSS baseline 通过。
  - `39.104.59.31:18770` 公网 TCP probe 可达，但 raw TCP echo 失败，远端临时进程没有收到 `conn/data` 日志，说明高端口路径不能作为 relay baseline。
- `docs/fabric/evidence/2026-06-26-server-profile-gate-smoke.md`
  - `npm run web:build` 通过。
  - 无 ready server profile 打开 `/ui/` 会进入 `/ui/server-setup`，不会直接进入 Dashboard/Chat。
  - 侧栏配置入口指向 `/ui/server-setup`；高级控制面仍可从 `/ui/settings?tab=control-planes` 进入。
  - 模拟 paired profile 后访问 `/ui/chat` 不被 gate 误拦，server selector 显示 `Ready Smoke`。
- `docs/fabric/evidence/2026-06-26-fabric-server-endpoint-smoke.md`
  - `server fabric descriptor and device pair endpoints support server setup onboarding` 通过。
  - `/v0/fabric/descriptor` 返回 `service=aih-fabric`。
  - `/v0/fabric/device-pair` 可消费 invite 并返回 device token。
  - 新生成的 invite `pairUrl` 指向 `/v0/fabric/device-pair`，`webPairUrl` 指向 `/ui/server-setup`。
- `docs/fabric/evidence/2026-06-26-fabric-browser-pairing-smoke.md`
  - 真实 Playwright Chromium 打开 `/ui/server-setup?pair=...` 后自动配对成功。
  - ready profile 显示 `1 READY` / `1 PROFILES`。
  - smoke server 隔离项目快照后显示 `0 会话`，不再泄露宿主历史会话数量。
  - 点击 `进入工作台` 后进入 `/ui`，没有被 gate 拉回 setup 页面。
  - 浏览器 console warning/error 为 0。
- `docs/fabric/evidence/2026-06-26-webrtc-signaling-lab.md`
  - `fabric-webrtc-signaling` store/server wiring 定向测试通过。
  - `npm run web:build` 通过，只有既有 Vite chunk size warning。
  - Playwright 浏览器完成 Server Setup 配对后进入 `/ui/fabric/webrtc-lab`。
  - Offerer/answerer 完成 `offer,candidate,candidate,ready,answer,candidate,candidate` 信令交换。
  - 浏览器 console warning/error 为 0。
  - DataChannel 未 open；同页最小 `RTCPeerConnection` 自检也停在 `connecting/checking`，因此 verdict 为 `partial`。
- `docs/fabric/evidence/2026-06-26-role-registry-server-api.md`
  - `fabric-role-registry` 单测通过。
  - Server wiring 测试通过：未授权写入 401，`nodes:write` 可注册 node，`nodes:read` 可读取 registry。
  - 注册结果包含 node roles、project、runtime、relay metadata。
  - 原始机器指纹不出现在 registry 序列化结果中。
  - `/v0/node-rpc/device-nodes` 能读到 mirrored relay node，迁移期兼容成立。
- `docs/fabric/evidence/2026-06-26-registry-publisher-smoke.md`
  - `node scripts/fabric-registry-publish-smoke.js` 通过。
  - 隔离 server pair 成功，CLI publisher 退出码 0。
  - Registry counts: nodes=1、relayNodes=1、projects=1、runtimes=2、transports=1。
  - 旧 `/v0/node-rpc/device-nodes` 能读到 `local-dev-smoke` mirrored node。
- `docs/fabric/evidence/2026-06-26-real-vps-deploy-attempt.md`
  - 不使用 mock registry；已把当前 worktree 和真实账号导出包传到 `root@39.104.59.31:/root/aih-fabric-real-20260626-215410`。
  - 账号导出包 hash 本地/远端一致：`9ad393b02850a8c2623576588757b8ef59718c16aab71a744e152d351367c99f`。
  - 远端 root `npm install` 通过；显式 `npm run web:build` 在 1.6GB 弱机上停在 Vite/Rollup 阶段并导致 SSH banner 超时。
  - `39.104.59.31:9527/8317` TCP 可达，但 HTTP `/healthz` 和 `/v0/fabric/descriptor` 为 5s 后 502 空响应，不能算 AIH server running。
  - 本轮尚未完成远端 `aih import`、本次版本 server 启动、真实 registry publish。
  - 真实 `aih claude -p` 前端 worker 尝试超过 60s 停在 `Waiting for claude to boot`，没有产出前端 patch；不能伪装成稳定非交互 worker。
  - 新增 `scripts/fabric-real-vps-deploy.js`，恢复后按本地 build、远端 `npm install --ignore-scripts`、真实账号导入、临时 server 启动继续，避免弱 VPS 再跑 Vite build。
- `docs/fabric/evidence/2026-06-26-real-japan-vps-deploy.md`
  - `ubuntu@155.248.183.169` 和 `opc@152.70.105.41` 均已完成真实部署：源码/Web dist、Node runtime、当前账号导出包上传，远端 `npm install --ignore-scripts`，远端 `aih import`，临时 server 启动。
  - 两台 VPS 的账号包 hash 与本地一致：`14b8f3dd4745dc3ae1f6d3bd65aa3e7f604042a7a7c578abe1148f69e3c48bd2`。
  - `155` 使用官方 `node-v22.16.0-linux-x64`；`152` 使用 `node-v22.16.0-linux-x64-glibc-217` 兼容 CentOS 7 / glibc 2.17。
  - 两台远端本机 `/healthz`、`/v0/fabric/descriptor`、`/ui/` 均 HTTP 200。
  - 两台公网 `18080` 互访失败：`155 -> 152` 为 `No route to host`，`152 -> 155` 为 timeout；主因是 firewall/cloud ingress 未放行 18080，而不是 AIH server 未启动。
  - 本轮没有改 systemd、没有安装系统包、没有改防火墙、没有删除远端目录。
- `docs/fabric/evidence/2026-06-26-real-vps-refresh-and-claude-worker.md`
  - 复测 `ubuntu@155.248.183.169` 和 `opc@152.70.105.41` 远端本机 `/healthz`、`/v0/fabric/descriptor` 仍为 HTTP 200。
  - `39.104.59.31` TCP 22/8317/9527 可达，但 SSH 仍在 banner exchange 阶段超时；当前不能作为可管理部署目标。
  - `aih claude 4 -p "只输出 ok"` 真实通过；复杂 Fabric 前端审查也真实完成，发现 WebRTC Lab log key、share URL endpoint、Server Setup probe gate 三个问题。
  - 回归通过：runtime focused 118/118、`web-account-auth + fabric-real-vps-deploy` 50/50、Fabric/server wiring 44/44、`provider-launch-strategy` 27/27、全量 `npm test` 2417/2417。
- `docs/fabric/evidence/2026-06-27-real-vps-claude-worker-and-isolated-deploy.md`
  - 三台 VPS 使用真实账号导出包完成 v3/v4 隔离部署，导入均为 `imported=15 duplicates=0 invalid=0 failed=0`。
  - v3 验证修复 flat OAuth credential import 后，三台 server runtime pool 均为 `codex=3, gemini=1, claude=4, agy=7`。
  - 本地公网 HTTP ingress probe 对三台 VPS 均 timeout；远端 Node 监听 `0.0.0.0:<port>`，问题不在 Node bind，而在公网 ingress/安全组/防火墙/overlay 层。
  - v4 在 `152.70.105.41` 与 `39.104.59.31` 上完成真实 registry publish：node+relay-node、projects=1、runtimes=4、transport=relay，runtime providers 来自真实 `/v0/management/accounts`。
  - `155.248.183.169` v4 已部署并导入 15 账号，但后续 SSH health/script copy 连续 banner timeout，因此 registry publish 未验证。
  - v8/v5 后续补齐三台真实 registry publish + heartbeat：
    - `155.248.183.169:18881` -> `vps-155-jp-v8`
    - `152.70.105.41:18882` -> `vps-152-jp-v8`
    - `39.104.59.31:18583` -> `vps-39-cn-v5`
  - 三台 registry readback 均为 `nodes=1, relayNodes=1, transports=1, projects=1, runtimes=4`，runtime providers 为 `codex/gemini/claude/agy`，transport 为 `relay:online`。
  - `152` 和 `155` 的 v8 部署均命中 `node-runtime-cache-hit` 与 `node-modules-cache-hit`，真实导入均为 `imported=15 duplicates=0 invalid=0 failed=0`。
  - 最新本地公网 HTTP ingress probe 对 `18881/18882/18583` 仍全部 timeout，说明默认产品路径不能依赖 raw public HTTP ingress。
  - v9 使用当前代码重新部署三台 VPS：
    - `155.248.183.169:18981` -> `vps-155-jp-v9`
    - `152.70.105.41:18982` -> `vps-152-jp-v9`
    - `39.104.59.31:18983` -> `vps-39-cn-v9`
  - 三台 v9 均命中 `node-runtime-cache-hit` 与 `node-modules-cache-hit`，真实导入均为 `imported=15 duplicates=0 invalid=0 failed=0`。
  - 三台 v9 均完成 registry publish + heartbeat + foreground agent `--count 2`：`agent.attempts=2, agent.failures=0`，lastCounts 仍为 `nodes=1, relayNodes=1, transports=1, projects=1, runtimes=4`。
  - 最新本地公网 HTTP ingress probe 对 `18981/18982/18983` 仍全部 timeout。
  - v10 使用当前代码重新部署三台 VPS，并启用真实 agent transport probe：
    - `155.248.183.169:19081` -> `vps-155-jp-v10`
    - `152.70.105.41:19082` -> `vps-152-jp-v10`
    - `39.104.59.31:19083` -> `vps-39-cn-v10`
  - 三台 v10 均有远端 runtime cache 与 node_modules cache；账号池均为 `total=15`，provider 分布为 `codex=3, gemini=1, claude=4, agy=7`。
  - 三台 v10 均完成 registry publish + heartbeat + foreground agent `--count 2`，`agent.probes` 均为 `relay:online:reachable`，探测耗时分别约 4ms、3ms、14ms。
  - v10 registry readback 均为 `nodes=1, relayNodes=1, transports=1, projects=1, runtimes=4`，runtime providers 为 `codex/gemini/claude/agy`，transport 为 `relay:online`。
  - 最新本地公网 HTTP ingress probe 对 `19081/19082/19083` 仍全部 timeout。
  - 本轮再次真实尝试 `aih claude` 前端只读审阅，仍卡在 `Waiting for claude to boot` 超 90 秒；没有 Claude 输出或 Claude 生成的 diff。

下一步建议：

1. 明确真实客户端入口策略：优先把 outbound relay/SSH tunnel 作为默认 no-public-ingress 路径；开放端口/HTTPS 反代只作为显式配置选项。
2. 把前台 `aih fabric registry agent` 产品化为可监督 node agent：服务安装/卸载、退避策略、日志、token 持久化策略和安全边界。
3. 补跨机器/手机真实 server profile smoke：手机或另一台电脑打开 webPairUrl -> 自动配对 -> 进入工作台。
4. 继续优化 evidence deploy 的源码传输：减少 worktree tar 体积，或改成 release artifact / delta upload。
5. 把 agent probe 从本机 `/healthz` 扩展到真实 outbound relay/data-plane health：WSS relay RTT、echo payload、错误原因、可用性评分，并写入 heartbeat transport health。
6. 用 headed 浏览器、手机/跨机、STUN/TURN 继续验证 WebRTC DataChannel open 和 RTT；当前不能把 WebRTC 设为默认 transport。
7. 产品化 `aih claude -p` worker 入口后，再把复杂 Fabric 前端改动交给 Claude worker，并记录 command/evidence。
8. 扩展 transport lab：WebTransport/QUIC、旧 WSS relay metrics、multi-relay failover。

注意：

- 当前 `fabric transport probe` 只证明 TCP/HTTP 网络可达；`tcp-echo` 才证明应用数据能往返；HTTP `serviceHealthy=false` 时不能当作 Fabric endpoint 可用。
- WebRTC/WebTransport 在 promotion gate 前只能作为 lab/candidate transport 显式启用；WebRTC signaling pass 不等于 DataChannel pass。
- 当前 M2 gate 是路由级 gate + 独立 first-run Server Setup 页面 + Fabric descriptor/pairing 薄适配；本地真实浏览器 pairing smoke 已完成，但还没有完成跨设备/手机真实 server profile smoke。
- 当前 M3 registry 已证明 server-side API、迁移期双写、一次性 CLI publisher、heartbeat、foreground agent、agent transport probe、AWS v16 的 node+relay-node publish/readback，以及 AWS v18 的真实 outbound relay sessions RPC smoke；还没有真实 home/company 机器 evidence、受监督 node daemon、UI Nodes/Relay Health。
- 真实 VPS 部署现在仍是 `partial` 的原因不是 registry/relay baseline：AWS v16 已完成 source artifact cache、远端导入、server 启动、registry publish、heartbeat、foreground agent smoke 和本机 TCP echo probe；AWS v18 已完成真实 outbound relay sessions RPC smoke；剩余缺口是公网 HTTP ingress 仍未放行、`152` 当前 SSH 不稳定、`155` 和 `39.104` 已退役，以及还没有跨家庭/公司机器的真实 runtime coding session evidence。
- `docs/fabric/skills/*` 是项目内 skill；如果运行器不自动发现，需要显式传路径或安装到 Codex skills 目录。
- 当前 `aih claude -p` 最小 smoke 和一次复杂前端审查已真实通过，但复杂任务首 token 慢；后续前端 patch 应明确由 `aih claude` 执行并记录命令/evidence，再由 Codex 做验收。
