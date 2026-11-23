# Workspace Connector：本地目录 + 远程 Agent（第一阶段）

日期：2026-11-22（Asia/Shanghai）
状态：Phase 1 已实现并完成本地端到端验收；Provider/AGY 执行适配仍属下一阶段。

## 1. 解决什么问题

远程开发不再需要先在对话里解释「哪台 Server、哪个目录、哪个账号、哪个模型」。
控制端只选择一个已经解析好的执行目标：

```text
本地浏览器 / CLI
  -> AIH Server（目标解析、账号、模型、Agent）
    -> 本地 Workspace Connector（只暴露一个显式目录，无 Provider、无模型）
```

Provider、账号、模型和 Agent 进程留在 AIH Server；本地 Connector 只做文件读写、
目录列举和受限搜索。Management Key 不会注入 Connector 或 Provider 子进程。

## 2. 本地工作区

### 2.1 一条命令登记并连接

```bash
cd ~/Projects/my-app
aih workspace connect --server aws --root .
```

首次运行会：

1. 通过已保存的 Server Profile 创建一次性 enrollment code；
2. 建立出站 WebSocket；
3. 服务端绑定 `workspaceId` / `connectorId`；
4. 本地保存 session token（`~/.ai_home/run/workspace-connector-sessions.json`，0600），
   后续断线自动重连，不重复登记。

也可以先在 WebUI 侧生成 code，再在目标机器执行：

```bash
aih workspace enroll --server aws --label my-app
aih workspace connect --server aws --code <code> --root .
```

### 2.2 可观测

```bash
aih workspace ls --server aws
aih workspace ls --server aws --json
aih remote target ls --server aws
aih remote target doctor --server aws --workspace <workspaceId> --harness agy --model gemini-4-neon-xhigh
```

WebUI 的「Server → SSH 开发机」页新增「本地工作区」面板：在线/离线/已撤销状态、
心跳、只读目录浏览、一次性 code 生成与撤销。目标面板会把 Connector workspace 和
SSH workspace 一起纳入候选，并显示 `connector` 标签与目录标签。

### 2.3 撤销

```bash
aih workspace revoke --server aws <workspaceId>
```

撤销是持久语义：服务端清除 token 摘要并主动关闭在线连接；Connector 收到
`workspace_revoked` 后立即退出，不会用旧 token 反复重连。

## 3. 协议边界（Phase 1）

WebSocket 首帧 `hello` 携带 enrollment code 或 session token；之后只在
`hello.accepted` 中下发一次新的 session token。所有操作都是能力受限的 RPC：

| Operation | 说明 |
| --- | --- |
| `workspace.read_file` | 读取普通文件，base64 内容 + 内容哈希版本 |
| `workspace.write_file` | 原子写入，要求匹配 `expectedVersion` |
| `workspace.list_directory` | 列出目录，默认 200 条，上限 1000 |
| `workspace.search` | 文件名子串搜索，限制深度/条数/访问量 |
| `workspace.run_command` | 在工作区内同步执行一条 shell 命令，返回退出码与输出 |
| `workspace.start_job` | 启动后台命令作业，立即返回 `jobId` 与初始 cursor |
| `workspace.watch_job` | 按 cursor 读取增量输出，可长轮询等待新输出 |
| `workspace.interrupt_job` | 终止仍在运行的作业（整个进程组） |
| `workspace.list_approvals` | 列出待审批命令与当前审批模式 |
| `workspace.decide_approval` | 批准或拒绝一条待审批命令 |

作业在 Connector 退出/重启后仍可继续观察。高危命令审批见 3.4。
Connector 不声明未实现的能力，Server 也不会把未声明能力当成可用。

### 3.1 路径约束

- 只接受相对路径；绝对路径、`..`、NUL 字节直接拒绝；
- 解析路径时对已存在的父链执行 `EvalSymlinks`，symlink 指向 root 外即拒绝；
- 写入要求父目录已存在，不自动创建目录；
- 文件读写上限 4 MiB；目录/搜索有独立上限。

### 3.2 命令执行约束

`run_command` 是同步调用，不产生持久 job：

- 默认开启；`aih workspace connect --no-command` 关闭。关闭后 hello 不声明
  `workspace.run_command`，Server 返回 `capability_not_allowed`，Provider 的工具列表
  里也不会出现 `run_command`；
- `cwd` 必须是工作区内的相对路径，按与文件操作相同的沙箱解析；命令本身以本机当前
  用户权限运行，这是“工作目录约束”，不是 OS 沙箱；
- 超时默认 120s，上限 10 分钟；超时后 Unix 上 `SIGKILL` 整个进程组，避免子进程残留；
- stdout / stderr 各自保留前 256 KiB，超出标记 `truncated` 并继续排空，命令不会因
  管道写满而阻塞；
- 断线或进程退出时结果丢失；需要重连游标与后台任务时走下一阶段的 `start_job`。

### 3.3 持久作业约束

- `start_job` 立即返回 `jobId`；命令由独立 runner 进程执行，spool 在
  `~/.ai_home/run/workspace-jobs/<jobId>/`（meta、status、stdout.log、stderr.log、
  heartbeat）。Connector 退出/重启、Server 重启、会话重连后，同一 `jobId` 仍可
  `watch_job`；
- runner 以新 session 启动，Connector 死亡不会带走作业；runner 每 2s 写心跳，心跳超过
  10s 且没有 status 时作业为 `lost`；
- `watch_job` 的 cursor 是 stdout / stderr 各自的绝对字节偏移，格式 `stdout:stderr`；
  重复使用同一 cursor 不会重复消费，cursor 超过已落盘字节会被拒绝；
- 每个流保留前 8 MiB；超出后继续排空但标记 `truncated`，单次返回每流最多 128 KiB；
- 作业默认最长 30 分钟、上限 2 小时；超时由 runner 杀进程组并写入 `timed_out`；
  `interrupt_job` 先发 SIGTERM 让 runner 收尾，5 秒无响应再 SIGKILL 整个进程组；
- 同时最多 4 个运行中作业、保留最近 16 个作业目录；`--no-command` 会同时关闭
  `run_command` 与三个作业工具；
- 边界：Windows 只能终止 runner 进程本身，没有 POSIX 进程组语义；审批仍未实现。
  `aih workspace __job-runner <dir>` 是 Connector 内部入口，不对用户暴露。

### 3.4 高危命令审批

- 连接时用 `--approval=never|destructive|all` 选择策略，默认 `destructive`；
- `destructive` 是启发式规则集：`rm -rf`、`sudo`、`git push`、`git reset --hard`、
  `git clean -fd`、`chmod 777`、`dd of=`、`mkfs`、关机命令、`curl|sh`；不是沙箱，
  需要严格模式时用 `all`；
- 命中策略的命令不会执行，返回 `approval_required` 与 approval id；用户在 WebUI
  「本地工作区」面板或 `aih workspace approvals` 批准/拒绝；
- 批准后用同一命令和 cwd 带 `approval_id` 重试；审批与命令+cwd 哈希绑定、一次性、
  10 分钟过期。拒绝/过期/重复使用分别返回 `approval_denied` / `approval_expired` /
  `approval_used`；
- `run_command` 与 `start_job` 共用同一网关，不能绕过；`--approval=never` 关闭审批。
- 审批记录保存在 Connector 进程内：Connector 重启后未决审批失效，代理会收到
  `approval_not_found`，需要重新发起命令。

### 3.5 Token 约束

- enrollment code 与 session token 只以 SHA-256 摘要落在 `aih.db` 的
  `remote:workspace-connectors` 键中；
- token 不进 URL、不进 argv、不进日志、不进模型 prompt；
- 每个 WebSocket 只允许一次成功 hello，超过 5 秒未认证即关闭；
- 浏览器 Origin 一律拒绝连接端点。

## 4. 服务端身份

远程执行目标必须同时有控制端 profile 和 Server 自身稳定身份。服务端启动时通过
`appstate.EnsureServerIdentity` 自举 `server:identity`（已有合法值不会被覆盖），
CLI/WebUI 不再依赖历史 Node 数据才能解析目标。

## 5. 验收记录（2026-11-22）

环境：本机临时 AIH 数据根 + 临时端口；真实 WebSocket、真实文件、真实 SQLite。
不使用单元测试替代。

已实际验证：

1. 全新数据根启动后自动生成 `server:identity`，`aih remote target ls` 正常返回；
2. `aih workspace connect` 首次自动 enrollment，第二次复用 token；
3. Server 重启后 Connector 自动重连，`workspace ls` 重新显示 online；
4. `entries` / `read_file` / `write_file` 成功；
5. 无 `expectedVersion` 覆盖已有文件返回 `version_conflict`；
6. `../../etc/passwd` 返回 `path_outside_workspace`；
7. root 内指向 `/etc` 的 symlink 读取返回 `path_outside_workspace`；
8. 撤销后在线连接收到 `workspace_revoked` 并立即退出，entries 返回 409；
9. 目标预检：online Connector 通过 workspace 阶段，但 tools/launch 阶段明确
   `remote_tools_unsupported` / `native_launch_unavailable`；offline/revoked 分别在
   workspace 阶段阻断；
10. `go build ./...`、`go vet`（改动包）与 `npm run build` 通过；
11. 真实浏览器（Work 模式）检查：本地工作区面板显示在线状态、目录浏览、enrollment
    code 完整显示与复制按钮；无 console error，无大面积告警块或左侧粗色条。

原始命令输出保存在本地 `run/remote-execution-connector-20261122/`（未入库）。

## 6. 下一阶段

- Provider Adapter：把 Connector 的 `ToolChannel` 接到 AWS 侧 AGY/Codex/Claude
  的原生工具协议；在此之前 preflight 的 tools/launch 阶段保持 unsupported；
- 持久 job：`start_job` / `watch_job` / `interrupt_job` 与重连游标；
- 审批：只在 Provider 真正支持审批通道时开放 unattended；
- 用真实 AWS Server + `gemini-4-neon-xhigh` 完成一次 Agent 真实读写本地项目的验收，
  不能把目录可见当成推理/工具循环成功。

## 7. 相关代码

- `internal/remoteexecution`：目标解析与 preflight；
- `internal/remoteconnector`：Server/Connector 共享协议与错误码；
- `internal/runtime/workspaceconnector`：enrollment/store、Hub、连接代际；
- `internal/adapters/workspaceconnector`：本地 sandbox 与文件操作；
- `internal/transport/http/webuiworkspaceconnectorapi`：管理 API、WebSocket、RPC 网关；
- `cmd/aih/workspace.go`：CLI；
- `web/src/features/workspace-connectors`：WebUI 面板。
