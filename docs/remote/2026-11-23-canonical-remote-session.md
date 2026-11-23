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

## 3. 接口

- `GET /v1/management/webui/remote-execution/sessions`：按创建时间倒序返回会话；
- `POST /v1/management/webui/remote-execution/sessions/{id}/stop`：终止对应 terminal，
  并把记录置为 `stopped`；
- WebUI 本地工作区面板显示最近 6 条（agent · 账号 · 模型 · 状态），running/unknown 可停止。

## 4. 边界

- usage 仍归属到账号与网关既有路径，尚未按 remote session 汇总；
- 事件/消息尚未绑定到该 session（terminal 输出仍由 WebTerminal 承担）；
- terminal 服务重启后旧 session 显示 unknown，记录保留用于审计；
- 只有 Connector agent 终端会写记录；SSH workspace 终端仍走原有路径。

## 5. 验收（2026-11-23）

本机真实 Server + Connector + 假 codex/aih CLI：

1. `agent-terminal` 启动后列表出现
   `rx-4f582b849355406ae7 codex 10 gpt-5.6-luna running`；
2. `POST …/{id}/stop` 返回 `stopped`，列表状态同步为 stopped；
3. `go build ./...`、`go vet`、WebUI `tsc` + `npm run build` 通过。
