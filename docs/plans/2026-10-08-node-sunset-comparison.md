# Node 逐步下线：Go/Node 逐项对比与分阶段方案

日期：2026-10-08。状态：方案，待确认；尚未下线任何 Node 能力。

规则（用户定）：
1. 下线任何一项之前，先比较 Go 和 Node 哪边更好。
2. Go 不如 Node 的，先把 Go 补上。
3. 只有 Go ≥ Node 的能力才列为下线候选，并且逐项确认。

依据有两类：
- 四份只读代码核查，基于 HEAD `ee46b203`，分别覆盖数据面路由、provider 适配、横切能力、控制面。
- 本机实测（2026-10-08）：访问日志统计，以及对 9527 发的几次小请求。

相关文档：[迁移计划](2026-09-24-go-migration-plan.md)、[收口报告](2026-09-25-go-migration-status.md)、[todo](todo.md)。

## 1. 结论

1. **Go 健康时，本机推理几乎全由 Go 承接。**
   - Go Core 修复后的约 1 小时里，各端点由 Go 处理的比例：

     | 端点 | Go 处理占比 |
     |---|---|
     | `/v1/messages` | 98.4% |
     | `/v1/chat/completions` | 93% |
     | `/v1/images` | 90% |

   - 在此之前的 25 小时里，Node 承接了 21%–35%（因端点而异），来自两段停摆：
     - 10-07 06:40Z 起约 2.5 小时，正值流量高峰。Go 多次因 `go_core_not_ready`（7 秒就绪门限）启动失败，约 2500 个请求里有六成回落到 Node。
     - 10-07 11Z 至 10-08 01:36Z 约 14 小时，原因是 `go_core_build_mismatch`。这段在夜里，只有约 90 个请求。
   - 两类停摆的共同问题是：启动失败后 Go 再也不重试。这个问题已在本轮修复，见附录。
2. **AWS 和 Windows 没有运行 Go。** 部署流程不带 Go 二进制，这两台机器上的推理全部由 Node 处理。
3. **目前没有一项 Node 能力可以直接删除。**
   - 以下能力只有 Node 实现：
     - 模型别名与 fallback
     - 计费
     - token 刷新
     - 代理与出口
     - codex、claude、agy 以外的所有 provider
     - 全部 `/v0` 控制面
   - 即使是 Go 已经接管的路由，Node 也还在兜底：Go 解码拒收的请求、Go 停摆期间的请求，都由 Node 处理。
   - 因此近期各阶段的工作是让 Go 追平 Node，而不是关掉 Node。
4. **在 Go 已接管的路由上，有 3 处确认比 Node 差，需要先修（§4 P0）：**
   - codex 请求带 `temperature` 或 `top_p` 时，Go 不会发往上游：流式请求返回 503（客户端 SDK 会自动重试），非流式返回 400。已实测。
   - 压缩过的 `/v1/responses` 发往非 codex 模型时，Go 返回 415。已实测。
   - Go 的所有 HTTP 流到 10 分钟会被硬切断。已从代码确认；近 25 小时内没有请求触发。

## 2. 现状数据

### 2.1 谁承接哪些路由

| | 本机 | AWS | Windows |
|---|---|---|---|
| Go Core | 已启用 | 未启用（没有二进制） | 未启用（没有二进制） |
| 划给 Go 的路由 | 推理、blobs、props、models.detail；`/v1/models` 仍在 Node | — | — |
| 推理承接 | 见 2.2 | 全部 Node | 全部 Node |

**Go 不可用时由 Node 接手，不返回 503。** 下列任一情况成立时，请求交给 Node 处理（判定逻辑在 `lib/server/go-core-route-deferral.js` 和 `lib/server/go-core-gateway-forwarder.js`）：
- Go 未就绪，或账号尚未同步成功；
- 插件条件不满足；
- 模型命中别名；
- 模型不在 Go 的可路由集合里；
- 钉选的账号没有 Go 映射；
- Fabric 在线；
- 连接失败；
- Go 返回 400 并带 `X-AIH-Decode-Rejected` 头，即 Go 解码拒收。

### 2.2 本机流量

**统计方法：**
- 数据来自 `~/.ai_home/logs/server.log` 的访问日志。
- Node 自己处理推理请求时，会多写一条 `model_usage_request_context`。用 requestId 对得上的，计为 Node 承接，其余计为 Go。
- 口径校验：Go 确定停摆的几个小时（10-07 12Z、16Z、20Z，10-08 00Z），按这个口径统计出的 Node 占比都是 100%。说明这个口径没有把 Node 处理的请求算到 Go 头上。

| 端点 | 25 小时（10-07 04:48Z 起） | 其中 Node | 修复后约 1 小时（10-08 04:45Z 起） | 其中 Node |
|---|---|---|---|---|
| `/v1/messages` | 4688 | 34.6% | 425 | 1.6%（7 次，主要是 `server_tool_use` 解码拒收） |
| `/v1/responses` | 899 | 21.1% | 1 | 0 |
| `/v1/chat/completions` | 308 | 26.6% | 118 | 6.8%（8 次中有 6 次是本次探测） |
| `/v1/images/generations` | 38 | 7.9% | 30 | 10%（grok、gemini 图片只有 Node 支持） |

补充数据：
- **请求时长（25 小时内）：** `/v1/responses` 最长 548 秒，`/v1/messages` 最长 321 秒，没有请求达到 10 分钟。
- **10 分钟超时：** 10-06 有一次 codex 请求因上游 10 分钟没有返回响应头，被 Go 在 600 秒时切断。
- **Go 解码拒收：** 近两天共 11 次，全部交还 Node，而且都是 `server_tool_use` 内容块。

## 3. 逐项对比

判定分五种：Go 更好 / 相当 / Node 更好 / 仅 Node / 两边都不可用。

标"实测"的，是本机实际发请求确认过的；其余来自代码核查。

### 3.1 数据面：路由

| 路由 | 判定 | 要点 |
|---|---|---|
| `/v1/messages` | 相当 | Go 对 claude OAuth 做原生字节中继，回落时走 Canonical；`server_tool_use` 等内容块被 Go 解码拒收，交还 Node |
| `/v1/responses`（HTTP） | 相当 | codex 原生透传；非 codex 模型走 Canonical。压缩请求体发往非 codex 模型时 Go 返回 415，且不交还 Node（实测） |
| `/v1/responses`（WS） | Go 更好 | Go 按首帧的模型选号，额度耗尽时以 1011 关闭，让客户端重连。Node 在升级连接时就选号，此时还不知道模型 |
| `/v1/chat/completions` | Node 更好 | Go 只有 Canonical 路径。编码器拒收的请求（如 codex 的采样参数）返回 503，不交还 Node（实测） |
| `/v1/messages/count_tokens` | 相当 | 两边都是本地估算；本机没有划给 Go |
| Gemini `/v1beta/*` | Node 更好 | Go 解码器拒收 `fileData`、`candidateCount` 等字段，而且不交还 Node |
| `/v1/images/*` | Node 更好 | Go 不支持 grok、gemini key 和 `llm-api`；multipart 请求会绕过模型判定 |
| `/v1/blobs`、props、`/v1/models/{id}` | 相当 | |
| `/v1/models` | 仅 Node | 列表含别名，约 396 个模型；Go 只有约 40 个 |
| 其它 `/v1/*` 透传 | 仅 Node | Go 返回 404 |

### 3.2 数据面：provider 适配

| Provider | 判定 | 要点 |
|---|---|---|
| codex ChatGPT OAuth | 相当 | 两边都完整。Go 拒收 `temperature`、`top_p`、`top_k`、`stop`，Node 静默丢弃这些参数。ChatGPT 的无状态请求仍要靠 Node 归一化 |
| codex API key / 中转 | Node 更好 | Go 只会发往 `<base>/responses`，没有 chat-wire。`OPENAI_WIRE_API` 等字段在同步到 Go 时丢失。本机测过的中转模型都由 Node 处理，没有触发这个问题 |
| claude OAuth | 相当 | |
| claude API key / 中转 | Node 更好 | Go 只能走 Canonical，会丢掉 `stop_details`、`service_tier`、`cache_creation`；Node 是字节透传 |
| agy | Node 更好 | Go 的问题：每个请求都调用一次 `loadCodeAssist`；不传递 thinking effort；User-Agent 写死为 darwin/arm64；只看 Retry-After 头；用量不入账（工作区里有其他会话未提交的修复） |
| gemini API key（已弃用）、opencode、grok、kimi、zcode、qoder | 仅 Node | Go 推理核心只认 codex、claude、agy |
| kiro | 两边都不可用 | Node 只是名义支持，没有实现 CodeWhisperer 协议 |
| codebuddy / workbuddy | 不进推理池 | 设计如此，只用于模型发现 |

### 3.3 横切能力

| 能力 | 判定 | 要点 |
|---|---|---|
| 模型别名与 fallback | 仅 Node | Go 有路由规则引擎，但生产环境的 builder 只生成精确匹配规则，引擎成了死代码 |
| 选号 | Node 更好 | Node 按剩余额度加权，并有 30 分钟会话亲和（加密推理内容会粘住原账号）；Go 只做公平轮转 |
| (账号, 模型) 冷却 | Node 更好 | Node 持久化；Go 只存在内存里，重启即丢 |
| 额度识别 | 相当 | Node 覆盖更多 provider 和提示格式；Go 遇到 codex 额度耗尽会封锁整个账号 |
| 空响应 | Node 更好 | Node 换号重试，不冷却；Go 没有这一类，空的 STOP 被当成成功 |
| 安全拒答 | 相当 | 两边都不换号 |
| 用量与费用 | 仅 Node | Go 只记录 token 数，放在 4096 条的内存环形缓冲里；Node 拉取后按定价计费。这个分工可以保留 |
| 请求日志 | Node 更好 | Go 只记录失败摘要 |
| 代理与出口 | 仅 Node | Go 只认环境变量里的代理；交还判定也不检查 egress 绑定 |
| 视觉守卫 | Go 更好 | Go 在 Canonical 层按路由处理，跨协议生效；Node 只处理 `messages` |
| thinking 预算 | Node 更好 | 差在 agy：Go 不传递 effort |
| 流式 | Node 更好 | Go 的所有 HTTP 流有 10 分钟硬上限，WS 不受影响 |
| gzip / zstd | 相当 | 两边都只支持 `/v1/responses`；Go 的回落路径会返回 415 |
| token 刷新 | 仅 Node | delegated 模式下 Node 是唯一的刷新者；Go 只实现了 codex、claude、agy |

### 3.4 控制面

| 领域 | Node 规模 | Go 现状 | 判定 |
|---|---|---|---|
| WebUI 后端 `/v0/webui/*` | 约 2.4 万行，152 个路径 | 无 | 仅 Node |
| 管理 API | 约 1.7 千行 | 有 13 条 `/v1/management/*`，只有预览页在用 | 生产环境仅 Node |
| 账号域 | 约 3.5 万行 | 源码 3.6 万行，测试 4.3 万行。OAuth 只支持 agy、claude、codex，额度只支持 codex、claude | 结构 Go 更好，覆盖面 Node 更好 |
| chat runtime、app-server、native 会话 | 约 3.1 万行 | 无 | 仅 Node |
| PTY/tmux 与 `aih <provider>` 启动 | 约 3 万行 | 4.9 千行，只支持 codex、claude；没有 PTY、持久化和 Windows 支持 | 功能 Node 更好 |
| 桌面应用启动器 | 约 7.4 千行 | 无 | 仅 Node |
| CLI 命令与 autostart | 约 1.4 万行 | `cmd/aih` 只有 account 子命令和 codex、claude 启动 | Node 更好 |
| provider CLI 自动升级 | 约 2.6 千行 | 无 | 仅 Node |
| 插件 | 宿主约 3.6 千行 | 约 1.7 千行，只实现了 request、observe、account 三个阶段 | 宿主保留为 sidecar |
| Fabric、node-rpc、frp、webrtc | 约 4 万行，9/7 之后没有提交 | 无 | 先决定去留 |
| 会话读取与用量扫描 | 约 2.4 万行 | 无 | 仅 Node |
| hooks、host-sync、shim | 约 9 千行 | 无 | 仅 Node |
| toolkit、代理池、ssh-clipboard | 约 1.7 万行 | 无 | 仅 Node |

**控制面整体：**
- 约 23 万行，占 `lib/` 的约 80%。
- Go 已有基础可接的部分，上限约 30%。

**真正离不开 Node 运行时的只有三样：**
- 插件宿主：插件本身是 JS。
- 已经装在用户机器上的 hooks 和 shim：它们会调用 node。
- npm：作为安装 provider CLI 的工具。

## 4. 先补 Go：分阶段

### P0 修复 Go 已接管路由上的退化

这些路由本机正在用，问题会直接影响真实请求，建议立即做。

| # | 问题 | 证据 | 修法 |
|---|---|---|---|
| G1 | codex 的跨协议请求（chat、messages 客户端）带 `temperature`、`top_p`、`top_k` 或 `stop` 时，Go 不发往上游，也不交还 Node，日志里没有记录。流式请求返回 503 "Inference service is unavailable"（`openaichatcompletionsapi/handler.go:263-268` 把所有执行错误都映射为 503），非流式返回 400。这类拒收不会记为账号失败，所以不会让账号进入冷却（`coordinator.go:674-676`） | 实测 gpt-6.1-sol、gpt-6-sol：去掉 `temperature` 返回 200，带上返回 503。拒收逻辑在 `internal/adapters/codex/responses/request_encoder.go:110-127`，有单测覆盖 | 跨协议入口改为静默丢弃，与现在处理 `max_tokens`、`user_id` 的策略一致，也和 Node 行为一致；同协议的 codex 客户端仍然拒绝。需要你确认，见 §6 D1 |
| G2 | Go 处理不了的请求返回 415 或 503，而不是交还 Node | 压缩的 `/v1/responses` 发往 claude 返回 415（实测）；chat 和 gemini 的编码拒收没有标记 | 凡是"Go 不支持这种请求形状"导致的失败，都打上 `X-AIH-Decode-Rejected`，由 Node 重放 |
| G3 | 所有 HTTP 流有 10 分钟绝对上限 | `internal/host/aihserver/server.go:15`、`claudenativerelay/handler.go:43,289`、`codexresponseshttp/handler.go:111` | 改为空闲超时，持续没有数据才断开；总时长上限保留，但放宽 |
| G4 | agy 的用量不入账 | `application/inferencegateway/attempt_stream.go:45-59` | 工作区里有其他会话未提交的修复，等它落地 |
| G5 | 回落到 Node 没有计数 | — | 按原因统计 Node 接手的次数，并在 `/readyz` 暴露 |

### P1 让 AWS 和 Windows 跑上 Go

这是后续所有"Node 计数为 0"门槛的前提。

- **部署带上 Go 二进制。**
  - `scripts/deploy-server.js` 交叉编译 linux-x64 和 win32-x64，并写入 stamp。
  - 部署脚本里 `rsync --delete` 的保留名单要加上 `bin/native`。
  - 以上来自代码核查，还没有实际部署验证。
- **代理配置。** Go 不读 server config 里的 proxy。AWS 上要么改用环境变量，要么先完成 P2 的代理支持。
- **Windows 上的关闭方式。** Node 停止 Go 时，Windows 实际执行的是 TerminateProcess，Go 的优雅关闭不会运行，内存里的运行态和用量事件每次都会丢。需要增加一个管理端点来触发优雅退出。
- **启用节奏。** 逐台启用 Go Core，确认连续 7 天 `go_core.ready=true`，再用 G5 的计数观察回落情况。

### P2 Go 追平数据面横切能力

按影响从大到小：
1. **别名与 fallback 链。** Go 的引擎已经有了，只需接上 Node 的别名表（只读同步）。这一步完成后，`/v1/models` 才能迁到 Go。
2. **冷却与选号。** (账号, 模型) 冷却要持久化；选号要加上额度权重和会话亲和。
3. **代理与出口。** 补上 config 里的 proxy 和按账号的 egress。在补齐之前，交还判定先加一条：有 egress 绑定的账号交给 Node。
4. **空响应。** 遇到空响应时换号。
5. **agy。** 缓存 `loadCodeAssist` 的结果；传递 thinking effort；User-Agent 按操作系统区分；解析 body 里的 retryDelay。
6. **中转账号。** claude API key 改为无损字节透传；codex 支持 chat-wire 中转。
7. **请求日志。**

计费保持现状，不迁：Go 只记 token，Node 拉取后按定价计算。

### P3 provider 覆盖

- **迁：** grok、kimi、opencode、zcode（x-api-key）。前三个是 HTTP 透传类，工作量小。
- **待定：** qoder，它靠编排原生 CLI 完成推理。
- **建议删除而不是迁移：**
  - kiro：两边都不可用。
  - gemini API key：已弃用，Google 账号已改用 agy。
  - 这两项见 §6 D3。

### P4 控制面

这一阶段要先写新 ADR，取代旧文档里"PTY、会话、WebUI 后端、桌面永久留在 Node"的决定。

迁移顺序：
1. 账号域
2. 前门反转：Go 接管 9527
3. 低风险的 `/v0` 路由组
4. PTY、启动、桌面、hooks
5. chat runtime

Fabric 要在这之前先决定去留。

## 5. 下线 Node 的候选与门槛

目前没有可以下线的项。

每一项要同时满足以下四个条件，才会逐项来问你：
1. §3 的判定是 Go ≥ Node。
2. 三台机器都在运行 Go，并且连续 7 天稳定。
3. 该能力由 Node 接手的计数（包括解码拒收）连续 14 天为 0。
4. 你确认下线。

**最早可能满足条件的：**
- `/v1/responses` WS 和视觉守卫：判定为 Go 更好。
- blobs、props、`models.detail`。
- codex OAuth 和 claude OAuth 的透传。

即便这些满足了条件，Node 的推理实现仍然是 Go 停摆时的兜底。所以第一步只能是冻结 Node 这部分的新功能，而不是删除代码。

## 6. 需要你决定

| # | 问题 | 选项 |
|---|---|---|
| D1 | codex 跨协议请求里的采样参数怎么处理 | 静默丢弃（与 Node 一致，推荐），或交还 Node 处理 |
| D2 | 什么时候在 AWS 和 Windows 启用 Go Core | 建议先 AWS 后 Windows |
| D3 | kiro 和 gemini API key | 删除，或迁移 |
| D4 | Fabric（约 4 万行，9/7 之后没有提交） | 保留、迁移，或删除 |
| D5 | 是否写新 ADR | 正式取代"PTY、会话、WebUI 后端、桌面永久留在 Node"的旧决定 |

## 附：本轮已完成（2026-10-08）

**提交：**
- `5e4951f7`
  - Go 首次启动失败时（未就绪、构件不匹配、缺二进制）按退避重试。
  - 重启后重新执行账号对账和模型刷新。
  - build stamp 只哈希路由合同，manifest 里的计数、状态等改动不再让二进制失效。
  - `go:build` 先写临时文件，再原子替换。
- `33b31805`
  - 重试时就绪门限逐次翻倍：第一次启动 7 秒，之后最长 60 秒。
  - 首轮账号同步失败后，后续任意一轮同步成功即放行。
- `1e58c8d6`：测试套件不再在 /tmp 留下目录，其中包括一个服务停止后仍在写 `account-activity.json` 的定时器。

**本机验证：**
- SIGKILL 杀掉 Go 后 2 秒内恢复。
- 重启后 `ready=true`、`accounts_synced=true`、`forwarding=true`。
