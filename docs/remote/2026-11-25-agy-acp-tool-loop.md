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

### Phase 2：Connector 映射与审批

- 把 Phase 1 的 ToolExecutor 换成 Workspace Connector 适配器；
- `terminal/*` 映射到现有 `run_command` / job API；
- `session/request_permission` 进入现有 approval store，选项只允许
  `allow_once` / `reject_once`；
- 补路径越界、symlink、超时、进程组清理测试。

### Phase 3：Server/UI 接线

- `agent-terminal` 接受 `agent="agy"`，启动 `agy acp` 而不是 PTY；
- WebUI 用 ACP 的 message/tool_call 更新渲染会话，不把 JSON-RPC 当终端流；
- 保留当前 409 路径作为“AGY 版本过旧/ACP 启动失败”的显式回退，不静默降级。

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

环境：AWS AGY 1.5.16；测试 server 独立端口；本地 Workspace Connector 指向临时
workspace；WebUI 通过 ACP 抽屉启动会话。

通过的控制面：

1. `POST .../acp-sessions` 返回 ready 会话；
2. SSE 收到 `tool_call` / `tool_update` / `approval` / `message`；
3. 三次 `allow_once` 审批都从 WebUI API 返回 200，agent 继续执行；
4. prompt 最终 `stop=end_turn`。

未通过的工具面：

- AGY 的 `File input.txt` / `File output.txt` / `pwd && ls -la` 工具直接在
  **Server 侧 shadow cwd** 执行，没有调用 ACP `fs/*` 或 `terminal/*`；
- `output.txt` 只出现在 shadow，Connector root 的 `ws` 中没有；
- `pwd && ls -la` 看到的是空 shadow，而不是 Connector 的
  `input.txt`；
- 因此 WebUI + Connector 只完成了审批/事件控制面，文件/命令实际没有落到
  Connector，闭环不成立。

原因：AGY 1.5.16 的 ACP server 使用内置文件/终端工具，即使客户端声明了
`fs.readTextFile` / `fs.writeTextFile` / `terminal`，它仍不把执行委托给
ACP client。ACP 协议本身允许 agent 自带工具，不能强制。

可行修复方向：

1. **镜像 + 回写**：启动前 `StartMirror` 拉取 Connector 工作区，AGY 在 mirror
   directory 上运行；每轮结束 `SyncMirror` 回写文件。文件可闭环，但命令仍在
   Server 执行，副作用不回 Connector。
2. **把 AGY 跑在 Connector 主机**：通过本地 ACP stdio 或反向隧道让 Agent 与
   真实工作区同机，这是语义上正确的远程执行。
3. **等待 AGY 支持 ACP client 工具**或提供“use client fs/terminal”开关。

认证/路径前置条件：server 必须用 AGY 账号投影作为 `HOME`，且 PATH 包含
`agy`；当前 WebUI 进程没有按账号选择 HOME，需要后续按会话注入。

结论：不能把这次 WebUI+Connector 结果标为通过。

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
