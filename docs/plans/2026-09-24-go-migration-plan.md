# Go 迁移执行计划（2026-09-24）

> 目标：解决 Node 网关性能问题，把热路径迁到 Go。
> 上位决策：[`product-direction-node-go-2026-08-15.md`](../architecture/product-direction-node-go-2026-08-15.md)
> （单 Go 业务核心 + Node 产品宿主，Strangler Fig）。本文不改变该决策，只把它落成可执行阶段，
> 并记录本阶段（P0）已交付的内容。

## 1. 结论先行

- **不做 Go 全量重写。** `lib/` 约 27 万行，其中 PTY/tmux/Session/Fabric/WebUI BFF/平台
  启动器（约 10 万行）与性能无关，而且是 Windows/psmux/launchd 等大量事故教训的沉淀
  （见 `AGENTS.md`）。重写它们风险高、收益为零，上位决策已明确拒绝。
- **性能热点是数据面 `/v1*`**：每个推理请求在 Node 里做账号选择、协议转换、SSE 重编码、
  失败归因。这部分 Go 已经实现：14 条数据面路由 `missing_in_go=0`，`go test ./...` 全绿。
- **真正缺的不是 Go 代码，而是把流量交给 Go 的链路。** 本计划按
  「构建 → 监督 → 转发 → 账号迁移 → 逐能力切流 → 安装链 → 性能验收」推进，
  每一步都可独立回退。

## 2. 现状盘点

| 区域 | Node | Go |
| --- | ---: | ---: |
| 网关/Server (`lib/server` ↔ `internal`+`application`) | 146k 行 | 74k 行（非测试） |
| CLI/PTY/tmux (`lib/cli`, `lib/runtime`) | 94k 行 | `cmd/aih` 预览 CLI |
| 账号域 (`lib/account` ↔ `core/accounts`) | 12.5k 行 | 11.6k 行（非测试，含 core 全部） |
| 数据面路由 | 14 | 14（全部实现；11 条已 `go_owned`） |
| 生产 owner（`contracts/route-ownership/manifest.json`） | 4 条 Node-owned / 11 条 Go-owned | 公开 9527 仍由 Node 宿主监听 |

### 2.1 阻止 Go 承接流量的缺口

| # | 缺口 | 影响 | 处理阶段 |
| --- | --- | --- | --- |
| G1 | npm 没有构建 Go 构件的入口，`bin/native/<platform>-<arch>/aih-server` 无人生产 | supervisor 永远 `go_core_binary_missing` | **P0 已修** |
| G2 | **监督器活在短命的 `aih server start` CLI 进程里**：CLI 退出后没有任何进程监督 Go；`aih server stop` 在新进程里 `child=null`，Go 被孤儿化；Node Server 进程也拿不到 Go 的 endpoint 和内部密钥 | 监督合同事实上不成立 | **P0 已修** |
| G3 | Node 没有任何转发到 Go 的路径，manifest 只是静态文档 | Go 实现再多也接不到流量 | **P0 已修** |
| G4 | 账号双库：Node 用 `app-state.db`，Go 用 `aih.db`；Go 在 `aih.db` 无账号时 `/readyz` 为 not ready | 转发后 Go 无号可用 | P1 |
| G5 | Go 不支持 `x-account-ref` 账号钉选（WebUI chat / codex app-server 依赖）和 Fabric 远端节点网关路由 | 切流后这两类请求会丢语义 | P2 前置 |
| G6 | 安装包不含/不校验 Go 构件；readiness 未汇合 `go_ready`/`build_sha`/`manifest_hash` | 无法正式发布 | P3 |
| G7 | 没有「Node 直出 vs 经 Go」的性能基线 | 无法证明迁移达到目的 | P4 |

### 2.2 已接入的推理通道（2026-10-16）

Go 侧推理上游不止 canonical 一条通道；Node 按**入口感知的通道表**判断某 Provider 在该
入口上 Go 服务得了与否（`lib/server/go-core-servable-providers.js`）：

| 通道 | Provider | 入口 | 模型目录 | 未钉选推理 |
| --- | --- | --- | --- | --- |
| canonical | codex / claude / agy | 全部推理入口 | Go 侧探测目录（catalog source） | 钉选可承接；未钉选仍交还 Node（canonical 单 Provider 解禁未做，见 §3 P2） |
| relay（家族透传） | codebuddy / codebuddycn / workbuddy / workbuddycn | 仅 `gateway.openai.chat_completions` | `GET {站点}/v3/config`（不依赖本机 CLI） | 承载者全为家族时承接（家族表链式征召，复用 Canonical 调度器） |

未钉选推理的放行收窄到**模型级**：只有当「这个模型的承载者（Node 索引里真有该模型账号的
Provider，与 `getModelBindingScore` 同源正向证据）全为 relay 通道」才交给 Go；其余情形
（承载者混合 / 索引里没有绑定 / 别名命中 / Go 目录里没有该模型 / Go 未就绪）一律交还
Node。交还原因逐项计数在 Node `/readyz` 的 `node_fallbacks`（`pool_model_carriers_unknown`
是新增的一条：索引证据不足时不由 Go 提前合成 503）。

### 2.3 失败语义对齐：站点边缘拒绝（2026-10-16）

Node 的 `lib/server/upstream-edge-block.js`（2026-10-15 家族事故的修复）把两类 401/403 判为
**与账号无关的站点边缘拒绝**：WAF/CDN 拦截页（`cf-mitigated` 头 / HTML 正文 / `text/html`
且正文非 JSON）与 APISIX 类网关的请求格式拒绝（`server: APISIX/*` + 单键 `{message}` 且
message 无凭据语义）。语义：不记账号失败、不换号、不冷却（`scope: none`）、不透传上游原文、
客户端得 502。事故是一个健康账号因 401 `{"message":"invalid_format"}` 被挂 31 536 000 000 ms
冷却。

Go 已对齐：

- 分类：`core/accountruntime` 的 `FailureUpstreamEdgeRejected` → `ActionNoStateChange`
  （不阻塞、不冷却，`retryable` 自动为 false）；
- 识别：`internal/adapters/upstreamfailure/edge_rejection.go` 是唯一实现，家族（信封路径）、
  codex、claude 三个 observer 共用（插在 observer 内部，因此账号自定义规则仍优先求值，
  与 Node 规则先于边缘检查的顺序一致）；
- 交付：家族 relay、Claude native relay、codex 原生 HTTP/WS 一律合成 **502
  `upstream_edge_rejected`**（`contracts/codex-relay/errors.json`），绝不把拦截页交给客户端。

一处**有意**差异（不是遗漏）：Node 的 codex 原生入口（`clientProtocol: openai_responses`）会把
上游 401 原样重放给客户端——`codex-adapter.js` 的失败重放记录器对 `shouldPassthroughToClient:
false` 不设门，而 2026-10-15 的两个边缘拒绝提交只改了 policy 与 general transport，没改该分支。
Go 在该入口按 policy 声明交付 502；账号面语义（不记账 / 不换号 / 不冷却）两侧完全一致。

## 3. 阶段计划

### P0 — 让 Go 可以接流量（本 PR，默认零行为变化）

1. **构建**：`npm run go:build` → `scripts/build-go-server.js`，产物路径与
   `resolveGoServerBinary` 一致（`bin/native/<process.platform>-<process.arch>/aih-server[.exe]`，
   已被 `.gitignore` 排除），`-trimpath` 构建。版本戳（`build_sha`）属于 P3。
2. **监督迁入长驻宿主**：`AIH_GO_CORE_ENABLED=1` 时由 Node Server 进程（`startLocalServer`）
   在监听成功后拉起 Go，在 `stopServer` 时一起停止；CLI 的 `start/stop/restart`
   不再各自持有 Go 子进程。内部密钥未显式配置时按启动生成随机值，只经子进程 env 传递，
   不进 argv/日志。Go 启动失败不拖垮 Node：已划给 Go 的路由失败关闭（503）。
3. **manifest 驱动的透明转发**（`lib/server/go-core-gateway-forwarder.js`）：
   - 转发集合 = manifest 中 `production_owner=go && migration_state=go_owned` 的条目
     ∪ 运维显式 canary `AIH_GO_CORE_ROUTES=<entry id,...>`。当前默认转发集合包含已
     `go_owned` 的 11 个数据面条目；显式 canary 只用于尚未切换且满足实现闸门的条目。
   - 只接受 `gateway.*` 数据面条目；`/healthz`、`/readyz` 始终属于 Node 宿主；
     `gateway.openai.responses` 与其 WebSocket 条目必须成对划转（共享路径整条切流）。
     配置非法时整个 canary 作废并报错，不做部分生效。
   - 路径分类对**全部**条目做最长字面量匹配，避免 `/v1/models/{id}` 误吞
     `/v1/models/x:generateContent`。
   - Node 先按现行规则校验 Client Key，再剥离客户端凭据与 hop-by-hop 头，注入 Go 内部
     Client Key 与 `x-aih-request-id`；请求/响应体流式管道，不缓冲、不重试、不换号；
     客户端断开即取消 Go 请求；响应头发出前 Go 不可达 → `503 go_core_unavailable`，
     发出后断开 → 直接断开客户端连接，绝不重放。
   - 带 `x-account-ref` 的请求显式返回 `501 go_core_capability_unsupported`（G5），
     不静默丢钉选、也不回退 Node 选号。
   - WebSocket `/v1/responses`：鉴权后 TCP 拼接到 Go，同样替换凭据头。

运维入口（持久化在 server config，`aih server restart` 生效；`AIH_GO_CORE_*` 环境变量仅作开发覆盖）：

```bash
npm run go:build                                   # 构建 bin/native/<platform>-<arch>/aih-server
aih server config set --go-core                    # Node Server 进程拉起并监督 Go Core
aih server restart
# P1 账号迁移完成、Go /readyz ready 之后才划转路由：
aih server config set --go-core-routes gateway.models.detail,gateway.props
# gateway.models.list 只能在全部推理条目划给 Go 之后划转（Go 目录 = Go 能路由的模型，见 todo S6）
aih server restart
```

注意：Go `/readyz` 仅在 `aih.db` 已有账号时为 ready，supervisor 以此为门限；P1 之前启用
`--go-core` 会按设计报 `go_core_not_ready` 并让已划转路由失败关闭。

回退：`aih server config set --clear-go-core-routes --no-go-core` 并重启即回到纯 Node。
**首次 Go 生产写入（attempt 历史、cooldown）发生后，按上位决策只允许 roll-forward。**

### P1 — 账号迁移到 `aih.db`（按 `(provider, auth_kind)` 分批）

- 以 `write_frozen` 导出 Node 账号快照（带校验和），生成
  `old_account_ref -> account_ref + resolution` 映射账本（复用
  `lib/cli/services/account/codex-identity-rekey.js` 的账本格式）。
- 经 Go `POST /v1/management/account-imports` 导入；逐账号核对 generation、模型 LKG、
  默认值与数量；Codex 先执行已落地 ADR 的 `user_id` rekey。
- 顺序：codex OAuth → claude OAuth → API Key 账号 → 其余 provider（gemini/agy/kimi/…
  需要 Go adapter 覆盖确认后再入批）。qoder/zcode 等「客户端侧无解」的 provider 保持
  Node 原生 CLI 通道，不进入 Go relay。
- 验收：Go `/readyz` ready，`/v1/management/accounts` 数量与账本一致。

### P2 — 剩余能力切流（每步：shadow 证据 → canary → 改 manifest 为 `go_owned`）

前置：补齐 G5（Go 支持 `x-account-ref` 钉选语义；Fabric 网关仍由 Node 在转发前处理，
或明确该主机不启用 Fabric）。建议顺序从只读、无状态到有状态、长连接：

1. `gateway.anthropic.count_tokens`（已有 Go 实现，先补独立 shadow 证据）
2. `gateway.models.list`（模型全集与账号目录所有权满足后再切）
3. `gateway.health` / `gateway.readiness` 继续由 Node 宿主持有，不纳入 Go 公开端口切换

已完成的 11 个数据面 entry（含 Responses HTTP/WS、Chat、Messages、Gemini、Images 和
Blobs）不再重复走 canary；后续只需持续验证其转发和回滚闸门。

每步证据：`npm run gateway:shadow -- --include-inference` 差异逐条按「provider 契约高于
Node」裁决；真实 provider 流式终态、取消、attempt 审计；canary 运行 ≥ 1 个完整额度周期。

### P3 — 安装与发布链

- `postinstall` 在检测到 Go 工具链时构建，否则下载与 npm 版本匹配、带 sha256 的预编译构件；
  supervisor 启动前校验 `build_sha`/`contract_version`/`manifest_hash`。
- Node `/readyz` 汇合 `go_ready` 与各能力 owner；已 `go_owned` 的能力缺 Go 时失败关闭。
- 私有 endpoint 由固定端口改为 supervisor 分配并登记（Unix socket / named pipe spike）。

### P4 — 性能验收（迁移是否达成目的的唯一证据）

- 同机同账号对比：Node 直出 vs Node→Go 转发 vs Go 直连，指标为 TTFB、p50/p99 附加延迟、
  并发 50/200 下的吞吐、Node 与 Go 的 RSS/CPU。
- 验收门槛建议：经 Go 的附加 p99 延迟 ≤ Node 直出；Node 进程 CPU 在同负载下下降 ≥ 50%。
  若 Node→Go 这一跳本身成为瓶颈，再进入 P5。

### P5 — （需另立 ADR）Go 直接持有公开端口

所有数据面能力 `go_owned` 且 P4 证明 Node 转发是瓶颈后，才考虑让 Go 持有 `9527`、
Node 退为 WebUI/PTY 宿主。上位决策 §6.2 要求单独 ADR、兼容与回滚证据和显式确认。

## 4. 明确不迁移

原生 CLI 启动、PTY、tmux/psmux 持久会话、Session 读取、Fabric、WebUI BFF、桌面 App
启动器（kimi/zcode 等）、Windows cmd/wt 启动链。它们不在热路径上，且承载大量平台
兼容知识；继续由 Node 宿主持有。

## 5. 风险

| 风险 | 缓解 |
| --- | --- |
| 双写账号状态 | 能力级单所有者；canary 只在 P1 迁号后启用；manifest 状态机 |
| 转发层自身成为性能瓶颈 | 纯流式 pipe、keep-alive agent；P4 量化，必要时 P5 |
| Go 崩溃导致在途请求丢失 | 响应已提交则断开，不重放；Node 可重启 Go 进程但不重放请求 |
| 钉选/Fabric 语义丢失 | P0 显式 501；P2 前置补齐 |
