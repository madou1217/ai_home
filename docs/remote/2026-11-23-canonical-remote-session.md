# Canonical 远程执行会话（第一阶段）

日期：2026-11-23（Asia/Shanghai）
状态：会话台账、列表、停止与按会话 usage 归属已实现；usage 已在 AWS 真机 Codex 网关会话闭环，事件仍以生命周期为准。

## 1. 目的

Connector agent 终端启动后，Server 现在写入一条持久会话记录，作为「同一个远程执行」
的稳定身份：workspace、Connector、agent、账号、模型、terminal id、状态和时间。它解决
“谁在哪个工作区用哪个账号/模型跑了什么”的审计缺口，并提供统一的停止入口。

## 2. 数据

存储：`aih.db` 的 app_kv `remote:execution-sessions`（最多保留 100 条）。

字段：`id`（rx-…）、`workspaceId`、`connectorId`、`agent`、`account`、`model`、
`sessionKey`、`termId`、`status`、`toolExpiresAt`、`createdAt`、`updatedAt`、`stoppedAt`。
记录不含 token、路径或命令内容。

状态：`running` / `exited` / `stopped` / `unknown`。列表读取时用 terminal 快照校正，
terminal 已不存在且记录仍是 running 时显示 `unknown`。

生命周期事件：`events[]`（最多 20 条，`{at,type,detail}`）。启动写 `started`，复用终端
写 `started`，自然退出由列表观察后持久化 `exited`，主动停止写 `stopped`。

## 3. 接口

- `GET /v1/management/webui/remote-execution/sessions`：按创建时间倒序返回会话；
- `GET /v1/management/webui/remote-execution/sessions/{id}`：单条会话与事件时间线；
- `POST /v1/management/webui/remote-execution/sessions/{id}/stop`：终止对应 terminal，
  并把记录置为 `stopped`；
- WebUI 本地工作区面板显示最近 6 条（agent · 账号 · 模型 · 状态），running/unknown 可停止。

## 4. 边界

- usage 已按 remote session 汇总（见第 5 节），账号级路径保持不变；
- 事件/消息尚未绑定到该 session（terminal 输出仍由 WebTerminal 承担）；
- terminal 服务重启后旧 session 显示 unknown，记录保留用于审计；
- 只有 Connector agent 终端会写记录；SSH workspace 终端仍走原有路径。

## 5. 按会话 usage 归属（已在 AWS 真机闭环）

实现：

- Codex 启动侧为受管 Provider 注入
  `env_http_headers.x-aih-remote-session=AIH_REMOTE_SESSION_ID`，并在终端环境里写入本次
  `rx-…` 会话 id；
- 所有推理入口读取请求头：relaycore、codexresponseshttp、codexresponsesws（握手头）、
  claudenativerelay、webuichatapi；
- Claude 启动侧把真实会话 id 并入 `ANTHROPIC_CUSTOM_HEADERS`（与账号钉选共用同一变量时
  按换行追加，不覆盖既有头）；
- `worknative` 注册 Codex 网关档：`agent-terminal` 不指定账号时，Codex 直接请求 Server
  的 `/v1/responses`，模型、账号与用量都留在 Server；
- `clientkeystats.Tracker.RecordUsage` 按会话累积 token，Flush 时通过可选
  `SessionUsageStore` 落库；`sqliteaccount` 的 `remote_session_usage` 首次写入惰性建表；
- 列表与详情返回 `usage`（lowerCamel）；客户端在读到最终答案后立即断开时，只要上游已
  发送 `response.completed`，仍记录该次尝试与用量；
- WebUI 最近会话在状态行显示 `N tok`。

真机验证（2026-11-23，AWS）：

- 部署二进制 sha256 `c1c0f886643c004f106abc625753f03913d7bd7c8956f14543afbbc05f140e1d`；
- 新 workspace `wc-2bf25b91406ce32111`，`agent-terminal` 网关模式（codex +
  `gpt-5.6-luna`）；
- Codex TUI 回复 `usage-fix`，会话 `rx-9124b1f3917c32c705` 详情的 usage 为
  input 7991 / output 7 / cached 6272 / total 7998；
- 手动非流式与流式 `/v1/responses` 请求分别累加到同一会话，证明多条请求按会话聚合；
- WebSocket 入口单独验证：握手头带同一 `rx-…` 会话，真实 WS 推理回复 `ws-ok`，该会话
  total 从 7998 增至 8016（input +12 / output +6），证明握手头上的会话标识进入记账；
- 浏览器进入 Work 模式的远程执行面板，最近会话显示 `· 8.0k tok` 与 `· 34 tok`。

### 多账号 WS 换号（2026-11-23）

- 握手阶段遇到账号级 401/403（`credential_rejected`）不再直接结束：把该账号加入
  exclude 后在池内继续尝试其它健康账号；普通 503/超时/断连仍保持单次握手语义；
- 同一请求实测：钉选失效账号 `acct_2b2f6702db12593c19cf` 仍拿到 `completed`
  （`ws-ok`），用量实际记到健康账号 `acct_9aa145b7fcd69a60cd73`，会话 total
  8070 → 8088（input +12 / output +6）；
- 修复前同一场景首个请求直接收到 401，需要客户端重连才恢复；修复后自动选号连续 2 次
  均一次成功；
- “本轮尚未输出时的可重试失败 → 1011 让 Codex 重连”分支已在 AWS 真实配额与隔离
  环境分别验证，见下节。

### 429 / 配额耗尽换号（2026-11-23）

AWS 真实配额验证：

- 账号 `acct_f543b2bf61e6241b1f72`（codex:5，plus）的真实 secondary 窗口已
  `exhausted`（`account_usage.remaining_bps=0`）。为让它进入可选集合，临时启用账号并
  放宽本地 quota 选择数据；验证后按备份精确恢复并重新停用，上游配额本身没有伪造；
- 第一连接钉选该账号：客户端收到 0 帧，close 1011 `retryable upstream failure`；
- 运行态：该账号 `blocks:["usage_snapshot"]`、`last_failure_kind=quota_exhausted`；
- 立即重连（不钉选）：14 帧、`completed`、输出 `ws-ok`，由健康账号
  `acct_9aa145b7fcd69a60cd73` 服务；
- 会话 `rx-9124b1f3917c32c705` total 8160 → 8196（input +24 / output +12）。

隔离复现（可重复，不消耗真实配额）：在临时 `AIH_HOME_DIR`、`127.0.0.1:19601` 上，
用两个假 Codex WS 上游验证同一份已提交代码：

- 上游 A（`127.0.0.1:19993`）：握手成功，发 `response.created` / `response.in_progress` /
  `response.metadata` 后返回 `{"type":"error","status":429,"error":{"type":"usage_limit_reached"...}}`；
- 上游 B（`127.0.0.1:19992`）：握手成功并返回完整 `response.completed`（`ws-ok`，
  usage 12/6/18）；
- 两个 API Key 账号均通过 `/models` 注册 `gpt-5.6-luna`；
- 第一连接钉选 A：客户端收到 0 帧，close 1011 `retryable upstream failure`；
- 运行态快照：A `blocks:["usage_snapshot"]`、`last_failure_kind=quota_exhausted`，B 成功；
- 1 秒后自动选号重连：10 帧、`completed`、输出 `ws-ok`；
- 会话 `rx-wsf-local` 的用量写入 12/6/18，证明换号后的请求仍按会话归属。

结论：预备帧被扣留、429 错误没有下发给客户端、失败账号按额度阻塞、下一连接换到健康
账号继续完成。

### Claude 真实会话用量（2026-11-23）

- 隔离 Server（临时 `AIH_HOME_DIR`、`127.0.0.1:19601`）添加真实 Claude 协议账号；
- 使用 Claude Code CLI 2.1.330，显式带
  `ANTHROPIC_CUSTOM_HEADERS="x-aih-remote-session: rx-claude-cli"`；
- `claude -p --model deepseek-flash` 实际返回 `claude-ok`；该账号当前可用的
  Claude-protocol 模型为 `deepseek-flash`，官方 Claude 模型在该账号上返回 429；
- 会话 `rx-claude-cli` 用量：input 15348 / output 243 / total 15591；同分钟尝试统计为
  1 次成功、token 与用量行一致；
- 顺带修复 `e2f50dfe`：Claude 流已观察到 `message_stop` 后，即使客户端立即断开，仍记录
  成功与用量。

可重复执行的步骤与取证模板见
[WebSocket 账号级 401/403 换号真机验收清单](2026-11-23-ws-credential-failover-acceptance.md)。

边界：

- Codex 账号模式（`aih codex <id>`）直连上游，不经过 Server 网关，无法按会话计量；只有
  网关模式会产生会话用量；
- Claude 真实会话用量已验证（Claude Code CLI + 显式会话头）；`agent-terminal` 的启动
  头 helper 仍以代码路径核对为准：本机 `~/.claude/settings.json` 会覆盖网关 env，AWS
  当前没有 Claude 账号；
- 客户端在 `response.completed` 之前主动断开时仍拿不到该次用量；
- 钉选账号在 401/403 时会回落到池内其它账号（与 HTTP native 的 pinned fallback 一致）；
- AWS 真实配额验证只临时放宽了本地 quota 选择数据（已按备份恢复），没有消耗真实配额；
  真实 429 由已耗尽账号的上游返回。

## 6. 原始设计（保留）

现状：usage 由 `clientkeystats.RecordUsage(ctx, accountRef, model, usage)` 按账号+模型记录，
没有会话维度；会话台账只有 account/model/时间。

落点：

1. `agent-terminal` 启动 Provider 时注入会话标识（env `AIH_REMOTE_SESSION_ID=rx-…`）；
   账号模式经 `aih codex` 启动时，用 Provider 配置的请求头把会话 id 带到网关。
   **已实装验证（2026-11-23，AWS Codex 0.171.0）**：`model_providers.<id>.http_headers`
   与 `model_providers.<id>.env_http_headers` 均生效——echo 服务分别收到
   `X-AIH-Remote-Session: rx-static` 和 `rx-env-test`。推荐静态头用 `http_headers`，
   动态会话 id 用 `env_http_headers` 指向启动环境变量。
   注意：本机 `~/.local/bin/codex` 0.170.0 是坏的 Node shim（MODULE_NOT_FOUND），
   此类验证必须在实装 CLI（AWS 0.171.0）上做；
2. 网关在推理完成写 usage 时读取该标识，落库到 `account_usage.remote_session_id`
   （可空列 + 索引，走既有 schema 升级流程）；
3. 会话详情聚合 `remote_session_id` 对应的 token/成本；无标识的历史行保持账号级；
4. Claude/其他 Provider 按各自可注入请求头的方式补齐，未支持时明确显示“会话级用量不可用”。

验收：一次 Codex 会话产生请求后，usage 行带 `remote_session_id`，会话详情显示
token/成本；同一账号并发两个会话时各自独立。风险：Provider 是否允许注入请求头、
账号模式与网关模式的差异、历史数据不可回填。

## 6. 验收（2026-11-23）

本机真实 Server + Connector + 假 codex/aih CLI：

1. `agent-terminal` 启动后列表出现
   `rx-4f582b849355406ae7 codex 10 gpt-5.6-luna running`；
2. `POST …/{id}/stop` 返回 `stopped`，列表状态同步为 stopped；
3. 事件时间线：启动后 `events=[started]`，停止后 `[started,stopped]`；单条详情接口
   返回同一时间线；
3. `go build ./...`、`go vet`、WebUI `tsc` + `npm run build` 通过。
