# Canonical 远程执行会话（第一阶段）

日期：2026-11-23（Asia/Shanghai）
状态：会话台账、列表与停止已实现；按会话的 usage/事件归属仍未接入。

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

- usage 仍归属到账号与网关既有路径，尚未按 remote session 汇总；
- 事件/消息尚未绑定到该 session（terminal 输出仍由 WebTerminal 承担）；
- terminal 服务重启后旧 session 显示 unknown，记录保留用于审计；
- 只有 Connector agent 终端会写记录；SSH workspace 终端仍走原有路径。

## 5. 按会话 usage 归属（已实现数据链路，验证待补）

已实现：

- Codex 启动侧为受管 Provider 注入
  `env_http_headers.x-aih-remote-session=AIH_REMOTE_SESSION_ID`，并在终端环境里写入本次
  `rx-…` 会话 id（账号模式与网关模式共用同一 `-c` 参数）；
- relaycore 推理入口读取 `x-aih-remote-session` 写入 context；
- `clientkeystats.Tracker.RecordUsage` 按会话累积 token，Flush 时通过可选
  `SessionUsageStore` 落库；
- `sqliteaccount` 新增 `remote_session_usage`（首次写入惰性建表，不迁移既有表）；
- 会话详情 `GET …/sessions/{id}` 返回 `usage`（input/output/cached/cacheWrite/
  reasoning/total）。

未完成：codexresponseshttp / claudenativerelay / webuichatapi 等其他入口尚未读头；
UI 未展示用量；尚未用真实推理请求做端到端验证。

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
