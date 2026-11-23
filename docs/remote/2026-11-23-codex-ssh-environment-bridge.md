# Codex 的 SSH/远端环境接口调研：能否与 AIH ssh-hosts 双向同步

日期：2026-11-23（Asia/Shanghai）
状态：**仅调研，未实施**。以下每条结论都标注了证据等级（真机 / 二进制实证 / 官方文档 / 上游 issue）。

## 0. 结论先行

1. **Codex 确实有"远端环境"这一等公民，但它不是"SSH 主机管理"**。CLI/app-server 侧的环境是
   **exec-server 连接**（`program` 子进程 或 `url` WebSocket），没有 host/user/key/port 这套主机模型；
   "SSH 主机管理"只存在于 **Desktop 壳**（读 `~/.ssh/config`，状态落在 `.codex-global-state.json`）。
2. **AIH → Codex 同步：可行，且已有两条真机跑通的接法**（都比写 Desktop 私有状态干净）：
   - `program = "ssh"`：由 Codex 自己拉起 `ssh <host> codex exec-server --listen stdio`；
   - `url = ws://127.0.0.1:<port>`：AIH 建 SSH 本地转发，Codex 连本机回环端口。
3. **Codex → AIH 反向同步：只能读 Desktop 的私有状态，没有公开接口**。`~/.ssh/config` 是双方共同源头，
   可以从那里对齐；Desktop 的 `remote-projects` / `remote-connection-auto-connect-by-host-id` 是
   Electron 全局状态（未文档化、版本敏感、运行中会被内存状态覆写），上游明确有 issue 在要，
   官方至今**没有**提供 CLI/app-server 方法。
4. **app-server 的 `environment/add` 只对当前连接生效、不落盘**（真机验证：进程重启后
   `environment/status` 返回 `unknown environment id`）。因此"运行时注入"只能当辅助，持久化必须走
   `environments.toml`。

## 1. Codex 侧的三个不同概念（这是最容易搞混的地方）

| 概念 | 存储 | 是否有 host/user/key 模型 | 能否被外部程序化写入 |
| --- | --- | --- | --- |
| **CLI 远端执行环境** | `$CODEX_HOME/environments.toml` | 否（只有 exec-server 连接方式） | ✅ 纯 TOML，可写 |
| **app-server 运行时环境** | 内存（`environment/add`） | 否 | ✅ 但重启即失效 |
| **Desktop SSH 主机/远端项目** | `~/.ssh/config` + `~/.codex/.codex-global-state.json` | 是（主机别名 + 远端项目目录） | ⚠️ 私有状态，不受支持 |

## 2. `environments.toml` 的真实 schema（二进制实证）

从 `codex` 0.170.0 的解析报错逐字段探测得到（`unknown field ... expected one of`）：

```
EnvironmentsToml :
  default        = "<环境 id>"          # 默认环境；空串报 "default environment id cannot be empty"
  include_local  = <bool>              # 是否同时保留本机环境
  environments   = [EnvironmentToml]   # 注意是**数组表** [[environments]]，不是 map

EnvironmentToml (10 个字段) :
  id                    = "<环境 id>"           # 必填
  skills                = { required = [...] }  # 可选
  url                   = "ws://host:port"      # 二选一：WebSocket exec-server
  auth_bearer_token     = "<token>"             # url 模式的可选 bearer
  program               = "<可执行文件>"         # 二选一：spawn 一个 stdio exec-server
  args                  = ["..."]
  env                   = { ... }
  cwd                   = "<路径>"
  connect_timeout_sec   = <int>   # 仅 url 模式允许；与 program 同用会报 "connect_timeout_sec requires url"
  initialize_timeout_sec= <int>
```

要点：
- 顶层 `default = ""` 会直接拒载（`default environment id cannot be empty`）。
- `[environments.box1]` 的 table 写法是错的，会报 `invalid type: map, expected a sequence`。
- 未知字段在 **app-server 启动时**报错退出，`exec-server --strict-config` 反而不报（实测）。

## 3. 真机证据（本机 macOS 26.7.2 → AWS Ubuntu，SSH 别名 `aws`）

### 3.1 接法 A：`program = "ssh"`（Codex 自己拉 ssh）

```toml
default = "awsbox"

[[environments]]
id = "awsbox"
program = "ssh"
args = ["-o","BatchMode=yes","-T","aws","codex","exec-server","--listen","stdio"]
initialize_timeout_sec = 30
```

- `environment/info` → `{"shell":{"name":"bash","path":"/bin/bash"},"cwd":"file:///home/ubuntu"}`
- 完整模型回合（aih 网关 + `gpt-6.2-sol`）：模型调用 shell 工具 → `commandExecution`
  `aggregatedOutput="ip-172-31-36-89\n"`，`exitCode=0`，最终答复同值。**远端执行闭环成立**。
- 顺带证实：`codex exec`（非 app-server）也读 `environments.toml` 的 `default`，同样在远端跑出
  `ip-172-31-36-89`。其中一次 `unified exec` 报 `-32603 No such file or directory` 后自动回退
  `/bin/bash -c` 成功——远端首次启动的 shell 快照问题，不影响结论。

### 3.2 接法 B：`url = ws://127.0.0.1:<port>`（AIH 建转发，Codex 连回环）

远端：`codex exec-server --listen ws://127.0.0.1:7788`（需 `setsid nohup ... </dev/null` 才能脱离 ssh 会话存活）；
本机：`ssh -f -N -L 17788:127.0.0.1:7788 aws`。

```toml
[[environments]]
id = "awsbox"
url = "ws://127.0.0.1:17788"
connect_timeout_sec = 15
initialize_timeout_sec = 30
```

- `environment/status` → `pending` → `ready`；`environment/info` 同上。
- 完整模型回合：shell 工具执行 `hostname; cat /etc/hostname` → `ip-172-31-36-89`，最终答复一致。
- 未启动 ws 服务时，状态明确为 `disconnected` + 具体原因
  （`failed to connect to exec-server websocket ... Connection refused`），失败可观测。

### 3.3 exec-server 协议要点（若 AIH 自建代理时需要）

stdio 上是 JSON-RPC：`initialize{clientName,clientVersion}` → 通知 `initialized` →
`process/start{processId,argv,cwd(file://),env,tty}` → `process/read{processId}`。
`initialized` **必须是通知**，作为 request 会得到 `exec-server stub does not implement 'initialized' yet`。
输出以 base64 分块，`process/exited` 带 exitCode。

### 3.4 `environment/add` 不持久（真机）

`environment/add{environmentId,execServerUrl}` 返回 `{}`，随后 `environment/status` 为 `ready`；
**同一 CODEX_HOME 重启 app-server 后** 变为 `unknown environment id`；目录内也没有任何环境配置文件。
→ 运行时注入只能当"本次会话内临时挂载"。

## 4. Desktop 壳的 SSH 主机管理（用于反向同步判断）

官方文档（learn.chatgpt.com → `codex-manual.md` §"Connect to an SSH host"）：

- 主机来源是 **`~/.ssh/config` 里的具体 Host 别名**，"resolves them with OpenSSH, and ignores pattern-only hosts"；
- 远端会通过 SSH 启动 **远端 Codex app-server**，要求远端 `codex` 在该用户登录 shell 的 `PATH` 上；
- 深链：`codex://settings/connections/ssh`、`codex://settings/connections/ssh/add?name=<别名>`
  （**唯一官方文档化的程序化入口**，且别名必须已存在于 `~/.ssh/config`）。

持久化状态（上游 issue #21554 与 #59931 实证，本机 `.codex-global-state.json` 未启用远端项目故无这些键）：

- `remote-connection-auto-connect-by-host-id`
- `remote-projects`、`project-order`、`active-remote-project-id`、`selected-remote-host-id`
- `electron-persisted-atom-state.agent-mode-by-host-id`

本机现状（只读，未改动）：`.codex-global-state.json` 只有 `local-projects`（ai_home）与
`app-server-projects-migration-by-host: {"local:/Users/model/.codex": ...}`，**没有 remote-\*** 键；
`~/.codex/state_5.sqlite` 的 `projects` 只有 ai_home；`codex-dev.db` 的
`local_thread_catalog_hosts` 只有 `local` 与 `chatgpt:...`，无 `ssh` 行。
→ 这台机器的 Codex 目前没有任何 SSH 主机登记，反向同步没有现成数据可读。

上游对这块的态度（均未关闭）：#21554 要求"支持的方式从自动化注册 SSH 远端项目"（现只能 best-effort
写 global-state，且 App 运行中会被覆写）；#41401 要求文档化"App 到底读哪些文件、哪些稳定"，
跟进评论确认：托管配置（`requirements.toml` / `managed_config.toml`）**没有**声明 SSH 连接的键，
只有 `[[remote_sandbox_config]]` 按 hostname 选 sandbox。

## 5. 与 AIH ssh-hosts 的事实对照

AIH 侧（`app_kv: ssh_connections`，本机 4 条）：

```
{id, label, host, user, port, authType(agent|key|key-file|password),
 identityFile, privateKey, password, egressConnectionId, reverseTunnel, proxyEnabled, createdAt}
```

- 认证方式比 OpenSSH config 更宽：`password` 需要 askpass（AIH 已有：
  私钥落 `run/ssh-remote/<key>.key` 0600，密码走 `SSH_ASKPASS` + `SSH_ASKPASS_REQUIRE=force`，密码只进环境变量）。
- 有跳板链（`Connection.Jump`，最多 5 跳）、出口绑定（`egressConnectionId`）、反向隧道（`reverseTunnel`）。
  → 这些**无法用一行 `Host` 块表达**（跳板可 `ProxyJump`，出口/反向隧道不行）。
- 已有可复用的通道建设能力：`sshremote.Client.DialTCP`（direct-tcpip，不执行远端命令）、
  `sshremote` 反向隧道、`runtime/sshtunnel` 守护（断线退避重建 + 30s 探活）、
  `proxytransport`（把 remote loopback 变成本机 loopback）。

**关键结论：AIH 的 SSH 事实模型比 Codex 的远端环境模型信息量更大**（认证/跳板/出口/隧道 vs 只有"怎么连 exec-server"）。
所以同步不能是"逐字段映射"，只能是"在 Codex 侧的两种连接原语里挑一个落地"。

## 6. 推荐的落地方案（供决策，尚未实现）

### 6.1 AIH → Codex：生成 `environments.toml`（主推）

- 位置：AIH 已经在管理 Codex 的 `CODEX_HOME` 投影（`codex_default_cli.go`、`codexappconfig`），
  所以可以按"账号/投影根"写 `<CODEX_HOME>/environments.toml`，不改用户私有目录里的手写内容；
  已有 `environments.toml` 时按 id 合并（保留用户自定义条目，AIH 条目加前缀 `aih-<connId>`）。
- 每条 `ssh_connections` 映射为一个环境：
  - 默认用 `program = "ssh"` + 显式 `-o` 参数（`BatchMode=yes`、`ConnectTimeout`、`StrictHostKeyChecking`
    沿用 AIH 的 known_hosts 事实），认证尽量复用 AIH 落盘的临时 key/askpass 文件路径；
  - 需要多跳/出口/反向隧道时用 `url`：由 AIH 建 `DialTCP` 本地监听 → 环境指向 `ws://127.0.0.1:<port>`。
    这条路径还能顺带解决"password 认证 + 跳板"这些 ssh config 表达不了的情况。
- 远端前置条件要显式校验：远端 `codex` 在登录 shell `PATH` 内（可用 AIH 已有 `sshhost.Probe` 探）。
- 命名与 UI：环境 id 稳定为 `aih-<connectionId>`，这样重复生成幂等；删除连接时删对应条目。

### 6.2 AIH → Desktop：只在用户明确要 Desktop 场景时做

- 先读 `~/.ssh/config`，对 AIH 连接生成**受管块**（标记注释包裹，`Host aih-<label>` + `HostName/User/Port/IdentityFile`，
  跳板写 `ProxyJump`），再触发深链 `codex://settings/connections/ssh/add?name=aih-<label>`。
- 明确写不进去的情况：`password` 认证、`egressConnectionId`、`reverseTunnel` —— 必须显式告知用户"这条在 Desktop 里连不了/会绕开出口"，
  不能静默降级（符合仓库的"禁止静默失败"原则）。
- 不要直接写 `.codex-global-state.json`：App 运行中会被内存覆盖，且属于未文档化的私有格式。

### 6.3 Codex → AIH：只做"导入"，不做"双向同步"

- 可读且稳定的只有 **`~/.ssh/config`**（双方共同源头）→ 提供"从 ssh config 导入为 AIH 连接"
  （已有连接按 host+port+user 去重）。
- Desktop 的 `remote-projects` 只在用户明确要求时**一次性读取**（识别远端项目目录 → 建档为 AIH ssh_workspaces），
  并明确标注"非官方状态格式，版本变化后可能读不到"。

## 7. 未验证 / 风险清单

- Desktop 深链 `codex://settings/connections/ssh/add` **未在本机验证**：本机没有安装 ChatGPT 桌面端
  （LaunchServices 只注册了 `com.openai.codex.cli`，`com.openai.chat` 目录下只有 pairing 扩展）。
- `environments.toml` 属于未文档化接口（官方文档只有 `environment/info` 这一个实验性方法），
  字段可能随版本变化 → 需要做"版本探测 + 解析失败不阻断 CLI 启动"的降级。
- `url` 模式要求远端常驻 `exec-server`，AIH 需要负责其生命周期（复用 `sshtunnel` 的退避/探活思路）。
- exec-server 的 `stdout` 首次 unified-exec 失败（`-32603`）说明远端 shell 快照有冷启动问题，实施时要做重试。
- 反向同步读 Desktop 状态在 Codex 更新后可能失效，必须做成"只读探测 + 读不到就明说"。

## 8. 附：本次验证用到的命令（可复现）

```bash
# 二进制实证 schema（故意写错字段看 expected one of）
CODEX_HOME=$(mktemp -d); printf 'default = "b"\n[[environments]]\nid = "b"\nprogram = "/bin/cat"\nbogus = 1\n' \
  > $CODEX_HOME/environments.toml; codex app-server < /dev/null   # → unknown field `bogus`, expected one of ...

# 远端 exec-server 直连验证
ssh aws 'codex --version'                                        # codex-cli 0.171.0
ssh -o BatchMode=yes -T aws codex exec-server --listen stdio     # 初始化后 process/start 返回 AIH_EXEC_OK
```
