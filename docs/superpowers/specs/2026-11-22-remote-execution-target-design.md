# Remote Execution Target：AWS Agent 驱动本地工作区设计

日期：2026-11-22（Asia/Shanghai）  
状态：设计草案，未批准实现  
范围：`/Users/model/projects/feature/ai_home`

## 1. 背景与目标

用户需要从本地浏览器或 CLI 指挥 AWS Server 上的 AIH/AGY 使用指定模型开发本地任意项目，例如：

```text
本地控制端
  -> AWS AIH Server
    -> AWS 上的 AGY/harness
      -> 本地开发机上的项目目录
```

同时，模型请求不能直接 relay 到本地 harness/agent，因为这会扩大账号风控、封号和身份混用风险。因而本设计要求：

1. Provider、账号、模型和 Agent 进程留在 AWS AIH Server；
2. 本地机器只运行一个无模型、无 Provider 账号、无 harness 的 Workspace Connector；
3. Connector 只暴露被明确授权的工作区文件和任务能力；
4. 本地浏览器/CLI 只选择一个已解析的执行目标，不再手工拼接 Server、`aih`、SSH 工作区、账号和模型；
5. `gemini-4-neon-xhigh` 必须在任务启动前完成目录、账号策略、AGY CLI 映射和实际可执行能力的闭环检查；
6. 远程任务必须能够观察、恢复、停止、审计，并能明确区分“模型在 AWS”与“文件在本地”。

## 2. 非目标

本设计不做以下事情：

- 不把本地 Provider CLI、Claude/Codex/AGY、pi 或其它 harness 作为模型 relay 客户端；
- 不把本地项目静默复制到 AWS 作为默认方案；
- 不把当前 `remote_agent.go` 的 raw `exec.LookPath("claude")` / `exec.LookPath("codex")` 继续扩展成第二套启动体系；
- 不把路径校验误称为操作系统级 sandbox；
- 不在 AGY 没有可用远程工具或审批协议时静默降级到 shadow directory；
- 不在本设计阶段修改 Provider CLI、账号凭据、生产 AWS 服务或共享数据库。

## 3. 当前实现证据与问题边界

当前仓库存在多个相互独立的远程能力：

- `webuiopenappapi.Request` 已经表达 `Provider`、`AccountRef`、`Harness`、`Model`、`Workdir`、`Transport` 和 `SessionKey`，但只用于宿主机打开 App/CLI；
- `NativeLaunchPreparer` 已经负责账号执行目标、凭据投影、环境和 release 生命周期；
- `chatruntime` 已经负责 Canonical session、事件、运行态和 native launch；
- `webuisshapi/remote_agent.go` 直接启动本机 `claude`/`codex`，只注入 `aih_remote` MCP，未绑定 AIH account/model/harness；
- Remote Workspace 通过 Server 本机 shadow path 表示远端目录，Canonical AGY native process 若直接使用 `ProjectPath` 会看到 shadow 而非真实远端目录；
- Codex 远程 dynamic tools 需要 `RemoteTools` executor，但当前 WebUI runtime composition 没有注入该依赖；
- `remote_tools.go` 每次调用重新 SSH 拨号和新建 session，且 `run_command` 仍是远程用户级 shell，不是 OS sandbox；
- `sshtunnel` 和 `sshremote.OpenReverseTunnel` 已存在，但 Remote Workspace 的 `ToSSHConfig` 对 reverse tunnel 显式 fail-closed；
- 当前 AGY 能力登记为 PTY、无审批通道；AGY headless command 仍使用 `--dangerously-skip-permissions`；
- 当前 AGY ID→CLI 显示名表未证明包含 `gemini-4-neon-xhigh`。模型目录可见性不能替代 native AGY 实际执行证据。

这些事实说明：本设计必须统一已有启动计划和 session，而不是在 Remote Workspace 旁边再造一个 raw provider launcher。

## 4. 推荐架构总览

```text
┌────────────────────┐
│ Local Browser / CLI │
└─────────┬──────────┘
          │ select target / commands / events
          ▼
┌────────────────────────────┐
│ AIH Server: Target Resolver │
│ + Preflight + Supervisor    │
└─────────┬──────────────────┘
          │ native provider launch
          ▼
┌────────────────────────────┐
│ AWS Agent Adapter           │
│ AGY / Claude / Codex / ...  │
└─────────┬──────────────────┘
          │ workspace tool RPC
          ▼
┌────────────────────────────┐
│ Workspace Tool Gateway      │
│ session-scoped capabilities │
└─────────┬──────────────────┘
          │ outbound authenticated session
          ▼
┌────────────────────────────┐
│ Local Workspace Connector   │
│ no model, no provider auth  │
└─────────┬──────────────────┘
          ▼
┌────────────────────────────┐
│ Explicit local project root │
└────────────────────────────┘
```

### 4.1 核心原则

- **Execution ownership**：AWS Server 拥有模型、账号、Agent 和 Agent session；本地 Connector 拥有项目根目录和本地命令执行。
- **Target first**：所有启动、恢复、停止、模型检查和权限判断都先解析 `ExecutionTarget`。
- **No silent fallback**：Provider、模型、Connector、工具协议或审批能力不满足时显式失败；不回退到本机 agent、shadow path 或未绑定账号。
- **Capability-scoped transport**：Connector 使用 workspace/session scoped 短期 token，不接收完整 Management Key。
- **Provider-specific adapter**：AGY、Codex、Claude 和外部 harness 不共享未经验证的工具/审批假设。
- **One canonical session**：Terminal、Agent、Workspace Connector、usage 和事件都通过同一个 remote execution session 关联。

## 5. Domain model

### 5.1 ExecutionTarget

逻辑模型：

```go
type ExecutionTarget struct {
    ID              string
    ServerProfileID string // 控制端选中的 Server profile
    ServerID        string // Server 自身稳定身份

    WorkspaceID     string
    ConnectorID     string
    ProjectLabel    string

    Provider        string
    AccountRef      string
    Harness         string

    CatalogModelID  string
    CLIModelName    string

    ExecutionMode   string // server-native-agent
    PermissionMode  string // confirm / plan / unattended
    Capabilities    map[string]any
}
```

`ServerProfileID` 是控制端路由身份；`ServerID` 是服务端运行身份。业务 session 不再只靠 shadow `projectPath` 反推 workspace。

### 5.2 RemoteExecutionSession

```go
type RemoteExecutionSession struct {
    ID              string
    TargetID        string
    WorkspaceID     string
    ConnectorID     string
    Provider        string
    AccountRef      string
    Harness         string
    CatalogModelID  string
    CLIModelName    string
    AgentRunID      string
    State           string // preparing / connecting / running / waiting / stopped / failed
    PermissionMode  string
    ConnectorToken  string // 持久化时只保存 hash 或引用，不保存明文
    CreatedAt       int64
    UpdatedAt       int64
}
```

现有 Canonical `Session` 可以继续保存对话和时间线，但需要增加稳定的 `target/session` 绑定，而不是把远程身份压缩成 `ProjectPath`。

## 6. Local Workspace Connector

### 6.1 启动方式

Connector 应作为 `aih` 的一个独立、无 Provider 的命令，例如：

```bash
cd ~/Projects/my-app
aih workspace connect --target aws-home
```

它只读取当前目录或显式 `--root`，不读取本地 Provider token，不启动任何 AI CLI。

### 6.2 Enrollment

首次绑定流程：

1. WebUI 或 AWS Server 创建 workspace connector enrollment；
2. Server 返回一次性、短时有效的 enrollment code/QR；
3. 本地 `aih workspace connect` 使用 code 建立 outbound TLS/WebSocket 连接；
4. Server 将 connector 绑定到 `WorkspaceID`；
5. enrollment code 立即失效；
6. 后续每个 Agent session 使用独立的 session-scoped capability token。

Management Key 不得注入 Connector 或 Provider 子进程。

### 6.3 长连接协议

Connector session 必须支持：

- `hello` / `capabilities`；
- `workspace_bind`；
- request/response multiplexing；
- streamed job output；
- keepalive；
- reconnect with cursor；
- session close；
- server-side cancellation。

### 6.4 工具边界

第一阶段工具：

```text
read_file
write_file
edit_file
list_directory
search
start_job
watch_job
interrupt_job
read_artifact
```

文件路径必须使用 Connector 的 workspace root 解析；每次写入携带版本或变更 token。命令任务必须返回 `jobId`，不能把长任务绑定在单次 HTTP/SSH request 上。

`run_command` 的权限模式必须显式声明：

```text
workspace-only
workspace-plus-approved-command
full-remote-user
```

默认不允许隐式升级。

## 7. Agent Supervisor 与 Provider Adapter

### 7.1 复用现有启动链

Supervisor 不直接 `exec.LookPath` Provider CLI。它应该：

1. Resolve `ExecutionTarget`；
2. 调用现有 `NativeLaunchPreparer.GetTarget`；
3. 调用 `NativeLaunchPreparer.Prepare`；
4. 让 Provider Adapter 在安全边界内追加协议参数；
5. 通过现有 native process/session lifecycle 启动；
6. 将 Agent events、tool calls、approval、usage 和 release 绑定到 `RemoteExecutionSession`。

候选复用模块：

- `internal/transport/http/webuiopenappapi` 的启动计划和 launcher；
- `internal/runtime/chatruntime` 的 session、events、runs、recovery；
- `internal/runtime/chatruntime/native_launch.go` 的 `NativeLaunchPreparer`；
- `application/providerlaunch` 的 provider/harness/model 意图解析。

### 7.2 Adapter contract

```text
PrepareLaunch(target, session) -> LaunchPlan
ResolveModel(target) -> catalogId + cliModelName
AttachWorkspace(session, connector) -> ToolChannel
ReadEvents(process) -> canonical events
SendInput(process, input)
Interrupt(process)
Recover(session)
Capabilities() -> tools / approval / resume / artifacts
```

### 7.3 AGY adapter

AGY 必须先做真实 capability probe：

- stream-json 是否可用；
- 指定模型是否可用；
- 是否存在可用工具协议；
- 是否存在审批协议；
- 是否支持恢复；
- 当前 CLI 是否接受 `CLIModelName`。

如果 AGY 没有可用的远程工具协议，必须返回 `agy_remote_workspace_unsupported`，不能启动到 shadow path。

AGY 无审批通道时，默认不允许自动进入 unattended 高权限模式。若未来支持 unattended，必须由用户显式授权，并绑定 workspace/session/capability policy。

## 8. Model preflight

启动前必须按顺序检查：

1. Server catalog 是否包含 `CatalogModelID`；
2. `AccountRef` 的 account model policy 是否允许；
3. Provider Adapter 能否把 catalog ID 转换成 `CLIModelName`；
4. Server 上安装的 CLI 是否接受该 CLI model name；
5. Provider native execution protocol 是否与 adapter 匹配；
6. Connector 是否在线并拥有要求的能力。

任何一步失败都返回结构化原因，例如：

```text
model_not_in_server_catalog
model_not_enabled_for_account
provider_cli_model_mapping_missing
provider_cli_model_rejected
agent_workspace_protocol_unsupported
workspace_connector_offline
```

目录可见不得被解释为 inference 或 agent/tool loop 已成功。

## 9. Session、状态和 UI

### 9.1 状态机

```text
created
  -> preflight
  -> connector_connecting
  -> agent_starting
  -> running
  -> waiting_input / waiting_approval
  -> running
  -> stopped / failed / expired
```

### 9.2 UI 必须显示

```text
Server profile / Server ID
Workspace label / local project root label
Provider / Harness
Account
Catalog model / CLI model
Agent capability
Connector state
Permission mode
Last event / last tool / current job
```

不要再仅显示：

```text
远程工作区 · user@host · /some/path
```

### 9.3 URL 和恢复

URL 只保存 opaque `targetId` / `sessionId`，不得把 AWS Server 的 shadow absolute path 写进 URL。恢复通过服务端 target/session 查询，不通过 `WorkspaceIDFromProjectPath` 猜测。

## 10. 安全模型

### 10.1 Token

- Management Key 只留在控制端到 Server 的管理链路；
- Connector enrollment token 一次性、短期、单 workspace；
- Agent tool token 单 session、单 workspace、可撤销；
- token 不能出现在 argv、普通日志、模型 prompt 或工具结果中。

### 10.2 Connector 隔离

- root 绑定在连接建立时确认；
- 不能通过 `cd /`、symlink、环境变量或命令参数静默扩大根目录；
- 命令能力必须与文件能力分开授权；
- 远程命令是否有 OS sandbox 必须显式报告；
- 长任务必须可取消并清理子进程。

### 10.3 Agent prompt injection

项目文件、README、AGENTS 和命令输出都视为不可信输入。工具 policy 不能只依赖系统提示词；高风险命令和 workspace 外访问必须在协议层拒绝或请求明确审批。

## 11. 迁移策略

### Phase 0：只读 target/preflight

- 不改变现有 Remote Workspace；
- 增加 target 解析和 capability/preflight 视图；
- 证明 Server、workspace、account、model、CLI、connector 的身份链可追踪。

### Phase 1：Connector 基础

- 增加本地 `aih workspace connect`；
- enrollment、短期 token、长连接、文件只读和版本写入；
- 不接 AGY，不做任意 shell。

### Phase 2：持久 job 和 session

- `start_job/watch_job/interrupt_job`；
- connector reconnect；
- canonical session/event/usage 归属；
- 实时状态和恢复。

### Phase 3：Provider Adapter

- 先接一个拥有结构化工具协议和审批能力的 Provider，验证通用边界；
- 再接 AGY，必须经过真实 model mapping、stream、tool loop 和 permission acceptance；
- 未通过能力检查的 Provider 保持明确 unsupported，不做 shadow fallback。

### Phase 4：兼容旧 Remote Workspace

- 旧 SSH workspace 作为 legacy transport；
- 能力足够时迁移到 Connector；
- 旧 terminal/session key 不再承担 Agent session 状态；
- 删除 raw `remote_agent.go` 的 Provider-specific 旁路前，先完成真实业务迁移。

## 12. 真实验收边界

实现后必须分别证明：

1. 本地 Connector 只运行连接器，不运行 Provider/Agent；
2. AWS Agent 进程的 PID、账号投影、Provider、模型和 egress 都属于 AWS Server；
3. `gemini-4-neon-xhigh` 通过 catalog、account policy、CLI mapping 和真实启动检查；
4. Agent 读取和修改的是本地真实项目，而不是 shadow path；
5. 长任务可观察、取消、重连和恢复；
6. 不把 Management Key 注入 Connector 或 Agent 子进程；
7. workspace 外路径和未授权命令被拒绝；
8. AGY 无审批能力时不会静默开启 unattended；
9. 断开 Connector 后 Agent 状态明确为等待/失败，不伪装成功；
10. usage、session、tool events 和最终文件变更能关联到同一个 target/session。

这些是实际运行验收要求，不是单元测试替代物。

## 13. 设计决策

推荐方案是：

```text
AWS-side Agent + Local Workspace Connector + ExecutionTarget + Provider Adapter
```

不推荐：

- 继续扩展 raw `remote_agent.go`；
- 让本地 `aih agy` 通过远端 gateway 假装成 AWS Agent；
- 把 AGY 强行塞进 Codex dynamic tools；
- 默认把项目复制到 AWS；
- 通过 shadow path 继续隐式判断远程 workspace；
- 继续使用每工具一次 SSH 拨号的实现作为主链路。

本 spec 只描述目标架构和证据边界。未得到用户批准前，不进入实现计划、不修改产品代码、不部署、不重启 AWS。
