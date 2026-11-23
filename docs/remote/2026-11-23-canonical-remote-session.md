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

- 部署二进制 sha256 `09e5207ee875173ef21e5a59109ca94fc6abf9c792038088bb3f72e9679ab7f9`；
- 新 workspace `wc-2bf25b91406ce32111`，`agent-terminal` 网关模式（codex +
  `gpt-5.6-luna`）；
- Codex TUI 回复 `usage-fix`，会话 `rx-9124b1f3917c32c705` 详情的 usage 为
  input 7991 / output 7 / cached 6272 / total 7998；
- 手动非流式与流式 `/v1/responses` 请求分别累加到同一会话，证明多条请求按会话聚合；
- 浏览器进入 Work 模式的远程执行面板，最近会话显示 `· 8.0k tok` 与 `· 34 tok`。

边界：

- Codex 账号模式（`aih codex <id>`）直连上游，不经过 Server 网关，无法按会话计量；只有
  网关模式会产生会话用量；
- Claude 的启动头注入已实现，本轮未用真实 Claude 会话验证；
- 客户端在 `response.completed` 之前主动断开时仍拿不到该次用量。

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
