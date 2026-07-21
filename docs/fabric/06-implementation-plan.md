# AIH Fabric Implementation Plan

> **历史归档（禁止作为当前实现依据）**：本文保留旧阶段设计；其中客户端 pairing、device token、scope/revoke、Control Plane 或 Node-first 表述仅用于追溯，**不得实现或恢复**。当前客户端只使用 `Server URL + Management Key`；worker join invite 仅用于高级 worker 接入，不是客户端授权。当前规范见 [20-current-server-client-model.md](20-current-server-client-model.md) 和仓库根 [README.md](../../README.md)。

## 工程原则

- 先设计再开发：拓扑、流程、ER、协议、UI 线框没有落地前，不进入功能实现。
- 先跑真实网络实验：当前 active lab 只使用 AWS current；家里、公司、手机链路以后按阶段补 evidence，非 AWS 服务器不再作为当前测试目标。
- 不继续扩大旧 Control Plane 页面；旧实现只能作为参考或迁移来源。
- Server、Client UI、Node runtime、Relay transport 必须分层。
- 所有新增行为要能被测试或诊断，不做“理论可用”。

## 里程碑

### M0: Design Freeze

交付：

- `docs/fabric/00-product-brief.md`
- `docs/fabric/01-network-topology.md`
- `docs/fabric/02-user-flows.md`
- `docs/fabric/03-data-model.md`
- `docs/fabric/04-protocol.md`
- `docs/fabric/05-ui-wireframes.md`
- `docs/fabric/07-test-plan.md`
- `docs/fabric/09-development-lifecycle.md`
- `docs/fabric/10-legacy-control-plane-migration.md`
- `docs/fabric/15-unified-node-product-model.md`
- `docs/fabric/skills/*`

验收：

- 用户可以从文档看懂产品怎么配置、怎么使用、流量怎么走。
- 每个核心名词都有定义：server profile、node、capability、transport、health、runtime。
- 后续任务能按阶段门追溯到设计、实现、证据和复盘。

### M1: Transport Lab

交付：

- WS/WSS echo baseline probe。
- Outbound broker routing ADR and minimal broker proxy smoke。
- Raw TCP application-data echo probe。
- WebRTC signaling and data channel prototype。
- WebTransport/QUIC prototype。
- Multi-relay health collector。
- 实验结果落到 `tmp/fabric-network-lab-*.md` 或后续正式 evidence store。
- 当前已完成 WebRTC signaling API/UI lab；DataChannel open 在当前 Playwright Chromium 环境未通过，必须继续用 headed browser、手机/跨机或 STUN/TURN 实测补证据。

验收：

- 当前阶段只用 AWS current 做真实验证；非 AWS 服务器不再参与新测试。多 VPS gate 作为后续扩展保留，不作为当前推进阻塞。
- 至少一台家里/公司机器作为 node 做 24h 心跳。
- 输出 RTT、p95、重连、吞吐、失败原因。
- TCP reachable 不能替代 echo/session success；echo fail 必须记录失败层级。
- `probe -> tcp-echo -> ws echo -> runtime session` 必须逐层通过，不能越级宣称 relay 可用。
- Public HTTP ingress 失败不能阻塞产品路线；默认应推进 [12-outbound-broker-routing.md](12-outbound-broker-routing.md) 的 outbound broker proxy。
- WebRTC 必须区分 `signaling pass`、`ICE connected`、`DataChannel open`、`RTT sampled` 四个层级；只有 room 内有 offer/answer/candidate 不能标记为 transport pass。

### M2: Server Profile 解耦

交付：

- Client 启动先进入 server profile 流程。
- Server profile endpoint 支持 direct server endpoint 和 broker proxy endpoint 两种形态。
- 当前 WebUI 只能作为已登录 server 后的一个页面。
- API client 不再默认写死本机 server。
- 本地保存多个 server profile。
- 第一刀已落地：未 ready profile 时，Web client 重定向到独立 `/ui/server-setup`。
- `/ui/server-setup` 已承载 pair URL/code、endpoint 探测、profile 列表、ready 后进入工作台。
- Server 已提供 `/v0/fabric/descriptor` 和 `/v0/fabric/device-pair`，作为 Server Setup 的新配置入口。
- CLI 已提供 `aih fabric profile pair` 和 `aih fabric profile pair-self`，可用同一真实 device-pair 流程为本机或远端 server 保存 ready profile；AWS current 已用 `pair-self` 闭合自检缺口。
- 新生成的 device invite URL 指向 `/ui/server-setup`，旧 node-rpc pair URL 仍可消费历史链接。
- 旧 `Settings -> 控制面` 只保留为高级入口。
- 本地真实浏览器 pairing smoke 已完成：新 invite -> `/ui/server-setup?pair=...` -> ready profile -> 进入 `/ui`。

验收：

- 新浏览器/手机无 profile 时无法直接误入 chat。
- 添加 server、测试、配对、切换全链路可用。
- Server 自身也能通过 CLI pair-self 生成自有 ready profile；不能通过复制其他机器 profile 数据绕过配对。
- 独立 first-run Add Server 页面可用；后续必须补真实跨设备/手机 browser smoke 和 server profile 切换持久化测试。
- Broker proxy endpoint 必须能完成 descriptor、device pair 和 node/session API 的真实请求；不能只保存一个 URL。

### M2.5: Outbound Broker Underlay

交付：

- Broker 监听默认 AIH server 端口策略下的 HTTP/WSS endpoint。
- AIH Server 通过 `aih fabric broker connect <broker-url>` 建立 outbound server link。
- Client 使用 broker proxy base 作为 server profile endpoint。
- Broker 只维护在线 link 和转发 allowlist route，不保存 provider credentials。
- Evidence 记录 direct ingress 失败时 broker 路径如何继续工作。

验收：

- 本机真实 broker + 真实 AIH server outbound link 可访问 `/readyz` 和 `/v0/fabric/descriptor`。
- 通过 broker proxy 完成真实 device pairing。
- 如果 node relay 在线，通过 broker proxy 触发 remote session smoke；否则明确记录阻塞原因。
- AWS current 默认 `9527` 已完成 broker proxy -> outbound relay -> real Codex remote session smoke；证据见 `docs/fabric/evidence/2026-06-27-outbound-broker-relay-aws-smoke.md`。
- Broker Proxy 已接入 Server Profile 配置入口；Server Setup 可保存/配对 broker profile，服务层会持久化 `connectionMode` 和 broker metadata。证据见 `docs/fabric/evidence/2026-06-27-broker-profile-ui-entry.md`。
- Broker link 断开诊断与同 `serverId` 恢复已在 AWS current 默认 `9527` 验证：proxy 离线返回 `brokerStatus.lastDisconnected`，重连后 readyz 恢复 200，并再次通过 broker relay real Codex remote session。证据见 `docs/fabric/evidence/2026-06-27-broker-diagnostics-recovery.md`。
- Browser-level Server Setup broker profile smoke 已完成：真实浏览器选择 Broker Proxy，配对、descriptor、device profile/status/accounts/sessions 全部经 broker proxy 返回 200，console 0 error/0 warning，并进入 `/ui`。证据见 `docs/fabric/evidence/2026-06-27-browser-broker-profile-smoke.md`。
- Cross-host outbound broker 的完整 M2.5 路径已完成：本机 server outbound 到 AWS public broker，本机 client 经 AWS broker proxy 完成 readyz、descriptor、device pair、device scoped reads、node relay sessions RPC 和真实 Codex remote session。证据见 `docs/fabric/evidence/2026-06-27-crosshost-outbound-broker-profile-smoke.md`。
- 跨设备/跨主机验收必须使用真实可达 broker endpoint；当前 AWS `9527` 可作为 broker endpoint 验证，但产品仍不能要求每个 AIH server 自己暴露公网 HTTP ingress。

### M3: Role Registry

交付：

- AIH 实例声明角色：client、server、node、relay-node。
- Node 注册项目、runtime、transport。
- Relay node 注册容量和健康。
- 第一刀已落地：`/v0/fabric/registry` 和 `/v0/fabric/registry/nodes` 支持 scoped read/write。
- `fabric-registry.json` 保存 node roles、projects、runtimes、relayNodes、transport endpoints。
- 可兼容的 node/relay transport 双写到旧 remote node registry，保证迁移期 `/v0/node-rpc/device-nodes` 可读。
- `aih fabric registry publish` 已支持一次性 node snapshot 上报，不保存 token、不安装服务、不启动 daemon。
- `aih fabric registry agent` 已把 probe 摘要写入 transport latest `measurement`，并追加 `networkMeasurements` trace；Fabric Nodes UI 已能显示 relay measurement、p95、成功率和 online health。

验收：

- 家里/公司风格的两类机器可在 server1 上显示为 node + relay node；当前真实证据以本机 `local-mac-remote-node` 和 AWS current `aws-current-node` 代表。
- AWS current 默认 `9527` 已完成长期 relay + registryAgent user systemd service，`supervisor.ready=true`，fresh relay measurement 为 `ws_echo_pass`，并且本地 Fabric Nodes 能从 AWS registry 看到两个真实 node/relay-node。
- M3 当前状态以 [08-current-status.md](08-current-status.md) 的 M3 Todo Queue 为准；核心证据包括 `2026-06-28-m3-supervised-daemon-aws.md`、`2026-06-28-m3-local-aws-visibility.md`、`2026-06-27-m3-role-registry-two-nodes.md`、`2026-06-27-m3-relay-health-strong-metrics.md` 和 `2026-06-27-m3-fabric-nodes-mobile-regression.md`。

### M3.5: Unified Node Product Model

交付：

- `docs/fabric/15-unified-node-product-model.md` 作为产品对象模型来源。
- Node Inventory read model：按 node 关联 registry nodes、projects、runtimes、relayNodes、transports、measurements 和 SSH inventory。
- 页面语义收敛：`控制面` 只做 server profile；`远程节点`、`SSH 开发机`、`节点健康` 都进入 node 体系。
- Node Detail action gating：启动会话、配置 SSH、启用 relay、运行测量都由 capability 决定。

验收：

- AWS current 默认 `9527` 授权 registry readback 显示 `nodes=2`、`relayNodes=2`、`projects=2`、`runtimes=4`、`transports=2`。
- AWS node 详情能明确显示：有 project 和 relay health，但没有 AWS provider runtime/account，因此不能启动 AWS provider session。
- Local Mac node 详情能明确显示：有 provider runtimes；M4 session start/attach/message/slash/cursor/artifact/stop 已在 AWS current default `9527` 真实 smoke 闭环。
- 当前 M3.5 完成状态以 `2026-06-28-node-inventory-read-model.md`、`2026-06-28-current-aws-node-model-readback.md` 和 `2026-06-28-aws-runtime-gap-diagnosis.md` 为证据。
- SSH host 只能作为 bootstrap/ops capability 展示，不能被误认为 remote development session 已 ready。
- WebRTC/QUIC 显示为 transport candidates，未过 promotion gate 前不进入自动选路默认路径。

### M4: 远程开发会话重新规划

交付：

- `docs/fabric/14-m4-remote-development-session.md` 作为 M4 权威 todo 和协议设计入口。
- 重新定义跨设备开发入口和用户流程。
- 明确 server、node、project、runtime、account grant 的选择顺序。
- 明确普通消息、slash、审批、停止、恢复的协议边界。
- 明确哪些能力走既有 Chat，哪些能力需要新的会话承载，不预设旧 M4 专用页面。

验收：

- 用户能看懂从 server profile 到 node/project/runtime 的完整路径。
- 新设计有网络拓扑、流程图、功能矩阵、ER/状态模型和真实验收用例。
- 没有新设计冻结前，不新增客户端菜单或页面入口。
- 旧 M4 专用入口路线不得作为计划或验收目标回归。
- M3.5 Node Detail 能解释每个 session action 为什么可用或不可用。

### M5: Recovery and Hardening

交付：

- ack/resume。
- relay failover。
- audit events。
- diagnostics export。

验收：

- relay 断开后 3 秒内恢复控制链路。
- 会话事件不丢。
- 失败诊断能定位 server/node/transport/session。

## 多 Agent 分工

| Agent | 职责 | 入口 |
|---|---|---|
| 主 Codex | 维护计划、整合事实、最终决策 | 当前线程 |
| aih-claude-architect-reviewer | 架构、产品流程、安全、复杂度评审 | `docs/fabric/skills/aih-claude-architect-reviewer` |
| aih-claude-frontend-worker | 复杂 Client UI、交互状态、可用性修正 | `docs/fabric/skills/aih-claude-frontend-worker`；`aih claude` 非交互委派入口待产品化，当前可用独立 frontend worker 替代 |
| aih-codex-implementer | 已批准任务的窄范围代码实现和测试 | `docs/fabric/skills/aih-codex-implementer` |

协作规则：

- Claude reviewer 不能直接改代码，先出 review 和阻塞项。
- 复杂前端页面或交互失败必须交给前端 worker 先做实现/评审，主线程负责集成、真实浏览器验证和 evidence。
- 当前 `aih claude` 已验证会进入远程交互式 CLI，不是稳定的非交互 patch worker；后续需要把它产品化成可传任务、可限制文件范围、可回收 evidence 的委派入口。
- Codex implementer 只能执行已冻结的小任务，不改产品方向。
- 每个 agent 输出必须包含 evidence。
- 主线程负责把 evidence 写回测试计划或实现日志。

## 任务拆分模板

每个任务必须包含：

- 背景和目标。
- 关联设计文档。
- 输入和输出。
- 明确不做的范围。
- 变更文件范围。
- 验收命令。
- 真实运行 evidence。
- 回滚方式。

阶段门以 [09-development-lifecycle.md](09-development-lifecycle.md) 为准；旧 Control Plane/remote node 能力的复用和废弃边界以 [10-legacy-control-plane-migration.md](10-legacy-control-plane-migration.md) 为准。

## 当前下一步顺序

1. M3、M3.5、M4 和 M5 已完成当前默认产品切片；不要再按本文件旧顺序重复实现。
2. M6 软件侧 WebRTC DataChannel、RPC adapter、fallback decision、diagnostics surface、prerequisite audit 和 direct WebRTC promotion publish 已完成；direct WebRTC 必须显式跑真实 gate 并发布带 expiry 的 registry promotion，不能静默永久晋级。
3. M6 剩余外部前置复测：受控 TURN relay `iceServers`/凭据、HTTPS/H3 WebTransport endpoint、真实 OpenMPTCPRouter/Linux underlay。没有这些真实前置时不得把对应高级 transport 设为默认。
4. 新增里程碑或需求必须先追加到 [08-current-status.md](08-current-status.md) 对应 queue，再进入实现和证据闭环。

## 代码边界建议

后续实现应按边界拆分，不继续扩大单个 WebUI/router 文件：

- `lib/fabric/client-profile/*`: server profile 读写、active server、探测。
- `lib/fabric/registry/*`: node、relay、runtime、project 注册。
- `lib/fabric/transport/*`: WSS/WebRTC/WebTransport 适配。
- `lib/fabric/session/*`: seq、ack、resume、semantic event。
- `lib/fabric/runtime/*`: provider runtime adapter。
- `web/src/fabric/*`: 新客户端入口和状态管理。

如果现有模块已能复用，先做 adapter；如果边界不清，先迁移到 fabric 命名空间再接入。
