# Provider Adapter 工具通道：Codex / Claude -> Workspace Connector

日期：2026-11-22（Asia/Shanghai）
状态：工具通道与 `run_command` 已实现；完成真实 MCP/HTTP 验收，以及真实 Codex free 账号下的
`run_command` 闭环验收。

## 1. 链路

```text
AIH Server 上的 Codex / Claude
  -> aih-server __mcp-remote-tools（stdio MCP）
    -> POST /v1/management/webui/workspace-connectors/{id}/tools
      -> workspace tool token（单 workspace、12h、可撤销）
        -> Connector Hub RPC
          -> 本地 Workspace Connector 文件操作
```

Provider 进程仍在 AIH Server；本地 Connector 不持有 Provider 凭据。MCP 子进程只拿到
一个 session-scoped tool token，拿不到 Management Key，也拿不到 Connector session token。

## 2. 能力边界

- Codex / Claude：通过 MCP 使用 `read_file` / `write_file` / `edit_file` /
  `list_directory` / `search`；search 为有界文本内容正则搜索。
- 持久作业：`start_job` / `watch_job` / `interrupt_job`。作业在本地 Connector 进程内运行，
  通过 cursor 增量读取；Provider 侧多次工具调用之间、MCP 桥进程重启之间都不丢状态。
  作业不跨 Connector 进程重启，仍无审批。
- AGY：没有结构化工具/审批通道，`agent-terminal` 明确返回
  `agy_remote_workspace_unsupported`，不伪装支持。
- `run_command`：同步执行本机命令，cwd 必须在工作区内；`aih workspace connect
  --no-command` 时不声明该能力，工具列表与调用入口同时消失（`capability_not_allowed`）。
  权限模式是 workspace-only cwd 约束，不是 OS 沙箱；持久 job 与审批仍未开放。
- Provider 审批：终端启动路径暂不声明审批能力；preflight 的 launch 阶段仍保持
  `native_launch_unavailable`，不把“工具通道可用”当成完整 Agent 执行已通过。

## 3. 已实际验证

1. `agent-terminal` 对 AGY 返回 409 `agy_remote_workspace_unsupported`；
2. Codex 启动请求返回持久 terminal session，launch context 为 0600，包含
   `toolsUrl` 与工具定义（不含 `run_command`）；
3. 直接调用工具端点：`list_directory`、`read_file`、`write_file`、
   `version_conflict`、`edit_file`、内容 `search` 均返回预期结果；
4. 非法 tool token 返回 401；
5. 以真实 `aih-server __mcp-remote-tools` 进程跑完 MCP
   `initialize` / `tools/list` / `tools/call`，工具列表与调用结果正确；
6. `go build ./...`、`go vet` 与 `npm run build` 通过。

### 3.1 `run_command`（2026-11-22）

用真实 Server + 真实 WebSocket Connector + 真实 `aih-server __mcp-remote-tools` 验证：

1. `tools/list` 返回 6 个工具，包含 `run_command`；
2. `run_command` 指定 `cwd: "sub"` 时 `pwd` 返回工作区内的子目录；`cwd: "../../"`
   返回 `path_outside_workspace`；`cwd` 指向文件返回 `not_a_directory`；
3. 非零退出码同时置 MCP `isError`，stderr 原样返回；
4. 400 KB 输出被截到 256 KiB 并标记 `truncated`；
5. `timeout_ms: 800` 的 `sleep 30` 在约 1s 内返回 `timedOut`、`exitCode: -1`，
   且没有残留 `sleep` 子进程；
6. 断开后以 `--no-command` 重连：`workspace ls` 的 live `runCommand=false`，
   工具列表只剩 5 个文件工具，直接调用返回 `capability_not_allowed`。

持久作业验收（2026-11-23，本机真实 Server + Connector + MCP 桥）：

1. `start_job` 立即返回 `jobId`，作业在独立 MCP 进程退出后继续运行；
2. cursor 增量读取：多次 watch 拼接恰好等于完整输出，不重复、不丢字节；长轮询在
   新输出到达时提前返回；
3. 作业结束时返回 `exited` + exit code，stderr 单独返回；
4. `interrupt_job` 返回 `interrupted`，进程组无残留；
5. `timeoutMs=400` 的作业进入 `timed_out`，进程组无残留；
6. 2 MB 输出触发 ring 丢弃，返回 `dropped`，单次 chunk 不超过 128 KiB；
7. 第 5 个并发作业返回 `job_limit_reached`；cursor 超前返回 `invalid_payload`；
   未知 job 返回 `job_not_found`；
8. `--no-command` 时工具列表不含作业工具，RPC 返回 `capability_not_allowed`。

真实模型闭环（2026-11-23）：AWS Server 上的 Codex（free 账号 10，`gpt-5.6-luna`）通过
`aih_remote.run_command` 在本地工作区执行命令，终端显示 `Calling aih_remote.run_command`、
`duration: 17ms`、`stdout: aws-codex-ok`，本机 `RUN_CMD.txt` 实际写入 `aws-codex-ok`。
证据与边界见 `docs/remote/2026-11-22-codex-free-live-verification.md`。

未完成：Claude 的真实模型闭环；持久 job 与审批协议。

## 4. 新增入口

- `POST /v1/management/webui/workspace-connectors/{id}/agent-terminal`
  （management auth；body: `{agent:"codex"|"claude", fresh, cols, rows}`）
- `POST /v1/management/webui/workspace-connectors/{id}/tools`
  （`X-AIH-Remote-Tools-Token`；MCP tool bridge 专用，不生成公开别名）
- WebUI 本地工作区行的 `AI 终端` 动作：Codex/Claude 二选一，接入现有 Web Terminal。

## 5. 相关代码

- `internal/runtime/workspaceconnector/tools.go`：工具名到 Connector RPC 的映射与工具定义；
- `internal/transport/http/webuiworkspaceconnectorapi/handler.go`：tool token 校验与 `/tools`；
- `internal/transport/http/webuisshapi/remote_agent.go`：Codex/Claude MCP 启动参数；
- `internal/transport/http/webuisshapi/connector_agent_terminal.go`：`agent-terminal` 入口；
- `internal/transport/http/webuisshapi/remote_tools_mcp.go`：MCP stdio 转发与 tools/list 覆盖；
- `web/src/features/workspace-connectors`：AI 终端动作。
