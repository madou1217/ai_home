# Go 迁移 TODO（2026-09-24 暂停点）

上下文：[`2026-09-24-go-migration-plan.md`](./2026-09-24-go-migration-plan.md)，PR madou1217/ai_home#6（已 Ready for review）。

## 已完成（已提交并推送）

- [x] P0：`npm run go:build`；Go Core 由长驻 Server 进程监督；manifest 驱动的 Node→Go 透明转发（默认不转发）
- [x] S1 账号统一：`lib/server/go-account-sync.js` 双向同步（Go→Node 凭据回写 CAS、Node→Go 推送、启停/默认账号、安全删除、Go 独有账号收养）
- [x] S2：PR #6 标记 Ready for review
- [x] S3 P1 迁移工具：`npm run go:migrate-accounts -- plan|apply|verify`（演练账本 `migration/go-account-ledger.json`）
- [x] S4 工作区对齐：Node 采用 Go 工作区语义（21 条共享向量）；Go schema v6 `workspace_id` 列；Go API `workspace_id` 与 Node `workspaceId` 一致
- [x] 监督门限改为 `/healthz`（不再要求 aih.db 先有账号）；首轮同步完成前不转发

## 待办（按顺序）

- [x] **在真实机器上执行 P1**：`npm run go:build && npm run go:migrate-accounts -- plan`，检查账本里 `unsupported_in_go` / `rejected_by_go`，再 `apply`、`verify`（本容器无真实账号，只在夹具上验证过）
  - 2026-09-25 真实机器 `plan` 已跑：33 个账号 → 29 可迁（same_ref 17 / rekeyed 11 / merged 1），留 Node 4 个
    （zcode 3：无静态凭据或 artifact 无效；opencode 1：artifact 无效）。演练中发现并修复原生 `api-key`
    auth_kind 违反列约束导致 OpenCode API Key 导入全部 `account_not_found`（4748d838）。
  - 2026-09-25 已 `apply` + `verify`（ok）：Go `aih.db` 28 个账号（29 条迁移，其中 1 条并入同一 Codex 身份），0 失败、0 Go 独有账号；apply 前备份在 `~/.ai_home/backups/aih.db.pre-p1-apply.20260925021035`。
- [x] S5 就绪态：Node `/readyz` 汇合 Go 状态（进程、首轮同步、Go `/readyz.ready`、已划转路由）；补真实 `startLocalServer` + 真 Go 的端到端测试
  - 2026-09-25 完成：`goCoreHost.readiness()` 按需探测 Go `/readyz`，Node `/readyz` 增加 `go_core` 字段；有 Go 路由而转发不可用或 Go 不 ready 时整体 `ready=false`。`test/server.go-core-e2e.test.js` 用真实 startLocalServer + 真实 Go 验证就绪汇合、转发与杀进程后的失败关闭。
- [x] S6 `/v1/models` 对齐（以 Node 为准）：
  - 影子工具加目录语义比对（id 集合差、共同 id 顺序、owned_by、aih_modalities）与 capability 探针。
  - Go 改动：`aih_modalities` 默认输出；Codex 目录按 Node 规则剔除 `visibility` 非 list/default/public 与 `supported_in_api=false` 的项（真实比对抓到 `gpt-reserve`）。
  - 2026-09-25 真实影子（Node 生产 9527 vs Go 读 aih.db 快照，委托刷新）：结构一致、无 Go 独有 id，38 个共同 id 的顺序/owned_by/modalities 全部一致。
  - 剩余差异是**模型全集**：Node 396 / Go 38，差集是 Node 独有的中转/原生 Provider 模型。结论：目录描述「本网关能路由的模型」，Go 目录只能在推理全部划给 Go 后跟随。`go-core-route-ownership` 强制该约束（单独划转 `gateway.models.list` 整体拒绝）。
- [x] S7 切只读路由：按 S6 结论，`gateway.models.list` 随推理最后划转；本步只划与目录无关的 `gateway.props`、`gateway.models.detail`：`aih server config set --go-core --go-core-routes gateway.props,gateway.models.detail`
  - 2026-09-25 已在生产（launchd 9527）启用：`go_core.state=ready`、首轮同步完成、`go_ready=true`、`forwarding=true`；`/v1/props` 与 `/v1/models/{id}` 经 Go 应答且与切换前 Node 基线逐字段一致，无 key 仍 401；Go 以 `AIH_SERVER_CREDENTIAL_REFRESH=delegated` 运行（Node 唯一刷新者）；切换后 `/v1/messages`、`/v1/responses` 真实流量 200。回退：`aih server config set --no-go-core --clear-go-core-routes && aih server restart`。
- [x] S8 `/v1/messages`：前置——Go 支持 `x-account-ref` 钉选（现在转发层返回 501）、Fabric 远端网关语义；真实 Claude 上游 shadow + 流式/取消/attempt 审计证据
  - 2026-09-25 前置已完成：Go 已支持 `x-account-ref` 独占路由；转发前由 Node 判定（可用钉选→Go，不可用/未知/非法钉选与 Fabric 在线时的未钉选推理→Node），去掉 501。真实 Claude 上游影子：非流式与 SSE 状态、结构、事件序列一致。
  - 2026-09-25 切流缺口已补（3d148724）：命中启用 Node 别名的推理请求由转发前判定交还 Node（Node 复用已缓冲请求体）；Go 推理响应带 `x-aih-server-account-ref` / `x-aih-server-provider`。
  - 2026-09-25 隔离端到端（真实 Node 宿主 → 真实 Go → 真实 Claude 上游，aih.db 快照、委托刷新、临时目录用后即删）：非流式 200 `message`、SSE 完整事件序列、取消流后下一请求 200 且 Go 仍 ready、别名请求留在 Node、未知钉选 Node 404；响应头 `x-aih-server-account-ref` 为实际账号（修复 Claude 原生中继路径漏写）。
  - 未完成：生产 canary 需运维者本人执行（自动化权限拒绝了生产切流）：`scripts/go-core-canary.sh gateway.anthropic.messages`（近 10 条 5xx≥3 或 Go 20s 不可转发即自动回滚）。
  - 2026-09-25 生产切流完成（`scripts/go-core-canary.sh`，30 分钟无回滚）：00:21:48 起 `/v1/messages` 由 Go 应答，canary 期间 10/10 200，之后持续 200。
- [x] S9 依次：chat completions → responses（HTTP+WS 成对）→ gemini → images/blobs；每步 shadow + 改 manifest 为 `go_owned`
  - 2026-09-25 影子证据：chat completions / responses 200/200 且 Go 为结构超集；Gemini generateContent 修复 Go 思考模型 400 与 Node 信封泄漏后 200/200。切流同 S8 需确认。
  - 切流方式同 S8：`scripts/go-core-canary.sh gateway.openai.chat_completions` → `gateway.openai.responses,gateway.openai.responses.websocket`（必须成对）→ `gateway.gemini.generate_content,gateway.gemini.stream_generate_content`；images/blobs 尚无影子证据（生图有真实成本）。
  - 2026-09-25 生产切流全部完成，每步 30 分钟 canary 无回滚：chat completions → responses（HTTP+WS 成对；真实 codex CLI 经 WS 一轮验证）→ Gemini generateContent/stream → images.generations/edits + vision.blobs（成对）。
  - 切流中发现并修复：Go 本地编码拒绝被报成 503（改 400，2cdb92dc）；agy 刷新漏写 `expires_at_ms` 致 Go 全部 401（8a5fdd12）；agy 生图缺 Code Assist 信封、blob URL 指向 Go 私有端口（a91d4840）；Gemini 思考吃光答案预算（c1e4db84）；Go 路由不了的模型与 Go 重启窗口交还 Node（170319e8）。
  - `gateway.models.list` 保持 Node：共存期 Node 独有 Provider（kimi/grok/opencode/zcode…）永久留在 Node，网关对外的模型全集是 Node∪Go，Go 目录只含 Go 能路由的模型。manifest 仍为 `node_owned`，生产所有权由 server config 表达；Go Core 随发布默认开启时再改 manifest（否则未启用 Go 的安装会报 not ready）。
- [x] S10 打包：postinstall 构建/下载 Go 构件 + 版本/sha 校验；Go 崩溃自动重启；Go stderr 落日志；基准测试（Node 直出 vs Node→Go vs Go 直连：TTFB、p50/p99、吞吐、RSS/CPU）
  - 2026-09-25 已完成：build stamp（版本 / manifest / 二进制 sha256）+ 启动前校验失败关闭；postinstall 本地构建或下载校验 sha256；`go-core-release` 工作流交叉编译 5 个目标；Go 崩溃指数退避自动重启；Go stdout/stderr 落 `logs/go-core.log`。
  - 基准 `node scripts/go-core-benchmark.js`（隔离 AIH_HOME，压测客户端独立进程，GET `/v1/models/{id}`，3000 请求 / 并发 50）：

    | 拓扑 | rps | p50 ms | p99 ms | Node CPU | Go CPU / RSS |
    | --- | ---: | ---: | ---: | ---: | ---: |
    | node-direct | 1454 | 33.4 | 66.6 | 2.21s | - |
    | node-to-go | 16713 | 2.7 | 7.3 | 0.36s | 0.11s / 28MB |
    | go-direct | 31519 | 1.3 | 7.0 | - | 0.09s / 30MB |

    经 Go 的 p99 ≤ Node 直出、Node CPU 下降 84%，满足 P4 门槛。推理端点基准需真实 token，随 S8/S9 划转后执行。
- [x] S11 收口报告：Node+Go 共存、能力对等、性能数据
  - 2026-09-25 现状报告：[`2026-09-25-go-migration-status.md`](./2026-09-25-go-migration-status.md)（共存拓扑、真实上游对等矩阵、性能、切流前缺口）。推理切流后需按最终数据更新。

## 已知差异 / 风险

- 2026-09-25 agy relay 两小时浸泡（钉选 agy 账号经 9527/Go，14 类用例 20 次：Messages 普通/思考流式/anyOf 工具/工具结果多轮/看图，Chat 普通/Pro 流式工具/长输出，Responses codex 形状，Gemini 原生/流式，真实 codex exec 与 claude -p，生图）。修复网关缺陷：Claude 原生中继无视钉选改派（5ac8b27a）、agy 不接受图片输入（dc76d6ef）、生图无视钉选、Claude Code 的 safeguards/advisor 工具/context_management 被拒（6118d9b7）。上游问题（非网关）：`gemini-3.1-pro-high` 在所有请求形态、多个账号上均被上游 INVALID_ARGUMENT 拒绝（-low 正常）；Claude Code 大请求（28 工具、~25k token）在 agy 上触发 429 RESOURCE_EXHAUSTED。

- Responses 经 Go 驱动 agy（WebUI agy 会话 = codex CLI）：2026-09-25 修齐 Codex CLI 请求形状——agy 路由声明 reasoning/web_search 能力、工具 schema 按 Node 规则清洗（Claude 目标折叠 anyOf 并用 `parameters` 键）、namespace 工具可逆重命名、签名函数调用接受、工具项不再发内容块事件。真实 codex CLI 工具往返经 Go 通过，非 codex 的 Responses 不再交还 Node。

- Go 不承接：Claude 以外 Provider 的 API Key 账号、Gemini Vertex、工作区冲突的 Codex 凭据 → 留在 Node（账本列出原因）
- Codex API Key 的 `OPENAI_WIRE_API` / `AIH_UPSTREAM_HEADERS` / `AIH_IMAGE_API` Go 无法表示（账本 `lossy_fields`）
- ~~Node 与 Go 两个 token 刷新器竞争同一 refresh_token~~：已解决（3c3a62bb），Node 监督 Go 时 Go 以 `AIH_SERVER_CREDENTIAL_REFRESH=delegated` 运行，Node 是唯一刷新者
