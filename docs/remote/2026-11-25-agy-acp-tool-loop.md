# AGY 结构化远程工具循环：ACP / MCP / Peer 取舍

日期：2026-11-25
状态：ACP 客户端已实现（本地工作区）；远程 Connector 映射与 WebUI 会话视图待接入。

## 1. 先修正一个过时结论

此前台账把 AGY 写成“只有 PTY、没有工具/审批协议”，因此把
`AGY 结构化远程工具循环` 当成了协议约束。这个结论对旧版 AGY 成立，
但对 AGY 1.5+ 不成立。

官方文档已经提供：

- `agy acp`：以 ACP（Agent Client Protocol）服务器运行，JSON-RPC over stdio；
- `agy acp --login`：无头登录；
- ACP 的 `initialize` / `session/new` / `session/prompt` / `session/update` /
  `session/request_permission` 流程；
- 客户端能力 `fs.readTextFile`、`fs.writeTextFile`、`terminal.*`；
- 官方 ACP 说明：<https://antigravity.google/docs/cli/acp>
- ACP 协议：<https://agentclientprotocol.com/>

因此“需 AGY 提供协议”不再是正确阻塞项。当前真正的缺口是：
AIH 还没有 ACP 客户端，`agent-terminal` 对 AGY 仍直接返回
`agy_remote_workspace_unsupported`。

## 2. 推荐链路

不要在 AGY 上强行套 Codex 的 MCP 桥；AGY 原生支持 ACP，直接用 ACP。

```text
AIH Server
  agy acp（Agent，JSON-RPC/NDJSON over stdio）
    <-> AIH ACP Client
          initialize(clientCapabilities: fs + terminal)
          session/new(cwd, mcpServers?)
          session/prompt
            <- session/update (agent_message_chunk / tool_call / tool_call_update)
            <- fs/read_text_file, fs/write_text_file
            <- terminal/create, terminal/output, terminal/wait_for_exit,
               terminal/kill, terminal/release
            <- session/request_permission
          -> AIH 审批（WebUI / CLI）
          -> Workspace Connector RPC
```

关键点：Agent 进程仍在 AIH Server；文件/命令实际落在本地 Workspace
Connector 管理的项目根目录内。Provider 凭据不进入 Connector，Connector
也不持有 Management Key。

## 3. ACP -> Connector 映射

| ACP 客户端方法 | Connector/工具 | 说明 |
|---|---|---|
| `fs/read_text_file` | `read_file` | 只允许工作区内的规范化绝对路径；保留 line/limit 语义 |
| `fs/write_text_file` | `write_file` | 写入前做工作区边界检查；后续可接 version/hash 冲突检测 |
| `terminal/create` | `run_command` 或 `start_job` | 短命令同步；长任务走持久 job，返回 jobId/terminalId 映射 |
| `terminal/output` | `watch_job` | cursor 增量读取，最大 chunk 受 Connector 限制 |
| `terminal/wait_for_exit` | `watch_job` 终态 | 返回 exitCode / timedOut / truncated |
| `terminal/kill` | `interrupt_job` | 杀进程组，不释放 job |
| `terminal/release` | job 清理 | 释放 terminalId 到 jobId 的映射 |
| `session/request_permission` | AIH approval | 只接受一次性 allow/reject；不把 `allow_always` 默认升级为持久授权 |

路径、符号链接、`..`、绝对路径越界必须在 AIH 客户端和 Connector 两侧
都检查；ACP 不是沙箱。

## 4. MCP、ACP、Peer 各自的位置

- **ACP**：AGY 的结构化 Agent 通道。工具调用、终端、权限请求都由 ACP
  定义，是这条需求的主协议。
- **MCP**：继续服务 Codex / Claude 的 remote tools。它不是 AGY 的入口；
  不要把 AGY 塞进 Codex dynamic tools。未来若需要客户端向 AGY 提供 MCP
  server，可走 ACP 的 `mcpServers` 或 MCP-over-ACP，而不是反向适配。
- **Peer**：用于跨会话的任务投递、状态/结果通知和审批提醒，不是工具
  RPC。ACP 的 `session/request_permission` 可以触发一条 peer 通知，但
  审批结果必须回到 ACP 请求本身，不能靠 peer 文本猜测。

## 5. 实现分期

### Phase 1：ACP 客户端最小闭环

- 新增 `internal/adapters/agy/acpclient`；
- 用 `github.com/coder/acp-go-sdk` 建 stdio 连接；
- 实现 `initialize`、`session/new`、`session/prompt`、`session/update`；
- 用本地 `ToolExecutor` 实现 read/write/run；
- 用 fake ACP agent 跑通协议测试，不依赖本机安装 AGY。

### Phase 2：Agent 移到 Connector 主机

- Connector 新增 `workspace.agent_acp.start/write/read/close`；
- Agent 进程在 Connector 的 workspace root 运行，Server 只转发 ACP
  JSON-RPC，不把文件/命令再映射到 shadow；
- `session/request_permission` 进入 WebUI 审批，选项只允许
  `allow_once` / `reject_once`；
- Connector 必须显式 `--agent-acp --agent-command <agy>`，并使用已登录的
  AGY 账号 HOME。

### Phase 3：WebUI 会话视图

- WebUI 通过独立 ACP 抽屉展示 message/tool_call/approval，不复用 PTY；
- SSE 事件流、审批按钮、prompt 输入；
- `agent-terminal` 对 AGY 保持显式 409，ACP 走独立入口。

### Phase 4：真实 AGY 验收

- 在 AWS 上确认 `agy --version >= 1.5` 且 `agy acp --help` 可用；
- 真实 Gemini 账号下执行 read/write/run_command；
- 审批：未批准前无本机产物，批准后执行，重复使用 approval id 被拒绝；
- 跨 Connector 重启的 job 继续可读；
- 记录 ACP 方法、toolCallId、exitCode、审批 id 和本机文件哈希。

## 6. 安全边界

- ACP 客户端必须显式声明能力；AGY 若请求未声明的 fs/terminal 方法，应
  返回协议错误而不是本机兜底。
- 文件/命令只允许 Connector 工作区根内；Agent 的 cwd 是建议值，不是授权。
- 审批与 toolCallId + 命令/路径 + cwd 绑定，一次性、短期过期。
- 不在 Agent 环境注入 Management Key 或 Connector token；工具 token 单独
  签发、单 workspace、可撤销。
- 不把 `allow_always` 当作跨会话持久授权。

## 6.1 WebUI + Connector 真机结果（2026-11-25）

环境：AWS AGY 1.5.16；测试 server 独立端口；Connector root 为临时 workspace；
WebUI 通过 ACP 抽屉启动会话。

第一次尝试把 Agent 跑在 Server shadow，确认失败：AGY 的内置工具直接写
shadow，output.txt 没有落到 Connector root，pwd && ls 看到空 shadow。
因此改为 Agent 跑在 Connector 主机：

- Connector 新增 workspace.agent_acp.start/write/read/close；
- Server 只承载 ACP JSON-RPC，stdin/stdout 通过 Connector 长轮询/小请求转发；
- AGY 进程 cwd 是 Connector 真实 workspace root，内置文件/终端工具直接落到
  真实目录；
- 审批仍由 ACP session/request_permission 回到 WebUI。

真机结果（WebUI 实际点击）：

1. 抽屉打开，会话 ready；
2. SSE 实时出现 File input.txt、File output.txt、printf UI_E2E_RUN 工具卡片；
3. 两次审批卡片点击“允许一次”，均返回 approved；
4. assistant 最终消息 stop=end_turn；
5. Connector 的真实 workspace 中 output.txt 内容为
   UI_E2E_OK + seed-content，printf 输出 UI_E2E_RUN。

前置条件：

- Connector 必须显式 --agent-acp --agent-command <agy>；
- Connector 进程的 HOME 必须是已登录的 AGY 账号投影，否则
  session/new 返回 Authentication required；
- 没有启用 --agent-acp 的 Connector 仍然只提供文件/命令工具，不暴露 Agent ACP。

结论：WebUI + Connector 真机闭环通过；这要求 Agent 与 workspace 同机，
不是把 AGY 强行塞进 Server 侧 shadow。

## 7. 实现进度（2026-11-25）

已落地：

- `internal/adapters/agy/acpclient`：ACP 客户端、领域事件、`FileSystem` / `TerminalHost` /
  `PermissionBroker` / `EventSink` 接口；
- `LocalWorkspaceHost`：工作区内读写、路径/符号链接越界拒绝、终端进程组与
  output/wait/kill/release；
- `aih agy acp`：用 `agy acp` 启动一轮 ACP 会话，支持交互审批和 `--auto-approve`；
- `ConnectorHost` + `HTTPToolClient`：把 fs/terminal 映射到 `read_file` / `write_file` /
  `start_job` / `watch_job` / `interrupt_job`，工具 token 只走 header；
- WebUI ACP 会话抽屉：SSE 事件流、工具卡片、审批按钮、prompt 输入；
- Connector 主机 Agent ACP（`workspace.agent_acp.*`）：AGY 在真实 workspace
  运行，Server 只转发 JSON-RPC；WebUI 真机闭环已通过；
- 测试：ACP JSON-RPC 往返、子进程 agent 真实启动、文件越界/终端 kill、Connector 映射；
- AWS 真机 AGY 1.5.16：`aih agy acp` 真实会话读取 `input.txt`、写入
  `output.txt`、执行 `printf RUN_OK`；两次 `allow_once` 审批后写入
  `approval.txt` 并返回 `end_turn`。
- 依赖：`github.com/coder/acp-go-sdk v0.20.0`。

仍未完成：

- 通过 WebUI 抽屉 + Workspace Connector 跑同一条 read/write/run/审批闭环（真机 CLI 路径已 PASS）；
- 现有 `agent-terminal` 对 AGY 仍返回 409；ACP 走独立的 WebUI 抽屉，不占用终端会话。

## 8. 当前结论

- `AGY 结构化远程工具循环` 应从台账的“协议约束”恢复为“未完成/待接入”。
- ACP 是主路径；MCP 保留给 Codex/Claude；peer 只做任务与通知，不做工具 RPC。
- 在 ACP 客户端接入前，现有 `agent-terminal` 的 409 与回归测试仍然正确，
  但它只代表当前实现，不代表 AGY 没有协议。
