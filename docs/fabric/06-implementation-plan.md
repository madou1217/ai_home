# AIH Fabric Implementation Plan

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
- `docs/fabric/skills/*`

验收：

- 用户可以从文档看懂产品怎么配置、怎么使用、流量怎么走。
- 每个核心名词都有定义：server、node、relay node、client、runtime。
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
- 新生成的 device invite URL 指向 `/ui/server-setup`，旧 node-rpc pair URL 仍可消费历史链接。
- 旧 `Settings -> 控制面` 只保留为高级入口。
- 本地真实浏览器 pairing smoke 已完成：新 invite -> `/ui/server-setup?pair=...` -> ready profile -> 进入 `/ui`。

验收：

- 新浏览器/手机无 profile 时无法直接误入 chat。
- 添加 server、测试、配对、切换全链路可用。
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
- 如果 node relay 在线，通过 broker proxy 触发 native session smoke；否则明确记录阻塞原因。
- AWS current 默认 `9527` 已完成 broker proxy -> outbound relay -> real Codex native session smoke；证据见 `docs/fabric/evidence/2026-06-27-outbound-broker-relay-aws-smoke.md`。
- Broker Proxy 已接入 Server Profile 配置入口；Server Setup 可保存/配对 broker profile，服务层会持久化 `connectionMode` 和 broker metadata。证据见 `docs/fabric/evidence/2026-06-27-broker-profile-ui-entry.md`。
- Broker link 断开诊断与同 `serverId` 恢复已在 AWS current 默认 `9527` 验证：proxy 离线返回 `brokerStatus.lastDisconnected`，重连后 readyz 恢复 200，并再次通过 broker relay real Codex native session。证据见 `docs/fabric/evidence/2026-06-27-broker-diagnostics-recovery.md`。
- Browser-level Server Setup broker profile smoke 已完成：真实浏览器选择 Broker Proxy，配对、descriptor、device profile/status/accounts/sessions 全部经 broker proxy 返回 200，console 0 error/0 warning，并进入 `/ui`。证据见 `docs/fabric/evidence/2026-06-27-browser-broker-profile-smoke.md`。
- 跨设备/跨主机验收必须使用真实可达 broker endpoint；AWS `9527` 公网 HTTP 当前不可作为 client public ingress 依赖。

### M3: Role Registry

交付：

- AIH 实例声明角色：client、server、node、relay-node。
- Node 注册项目、runtime、transport。
- Relay node 注册容量和健康。
- 第一刀已落地：`/v0/fabric/registry` 和 `/v0/fabric/registry/nodes` 支持 scoped read/write。
- `fabric-registry.json` 保存 node roles、projects、runtimes、relayNodes、transport endpoints。
- 可兼容的 node/relay transport 双写到旧 remote node registry，保证迁移期 `/v0/node-rpc/device-nodes` 可读。
- `aih fabric registry publish` 已支持一次性 node snapshot 上报，不保存 token、不安装服务、不启动 daemon。

验收：

- 家里电脑可在 server1 上显示为 node + relay node。
- 公司电脑可在 server1 上显示为 node + relay node。
- 当前完成 server-side API、测试和本地 loopback CLI publisher smoke；真实 home/company evidence、周期心跳/daemon、UI 节点页、relay health measurement 仍待实现。

### M4: Native Session

交付：

- PTY layer session stream。
- semantic event layer。
- 输入、slash、resize、stop、detach。
- provider runtime adapter：codex、claude 优先，agy/opencode 后接。

验收：

- 公司电脑从家里 node 启动 `aih codex`。
- 家里电脑从公司 node 启动 `aih claude`。
- 手机可以发送 slash 和审批。

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
- 当前 `aih claude` 已验证会进入原生 TUI/PTY，不是稳定的非交互 patch worker；后续需要把它产品化成可传任务、可限制文件范围、可回收 evidence 的委派入口。
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

## 代码边界建议

后续实现应按边界拆分，不继续扩大单个 WebUI/router 文件：

- `lib/fabric/client-profile/*`: server profile 读写、active server、探测。
- `lib/fabric/registry/*`: node、relay、runtime、project 注册。
- `lib/fabric/transport/*`: WSS/WebRTC/WebTransport 适配。
- `lib/fabric/session/*`: seq、ack、resume、semantic event。
- `lib/fabric/runtime/*`: provider runtime adapter。
- `web/src/fabric/*`: 新客户端入口和状态管理。

如果现有模块已能复用，先做 adapter；如果边界不清，先迁移到 fabric 命名空间再接入。
