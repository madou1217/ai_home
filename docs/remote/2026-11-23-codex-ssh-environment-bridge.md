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
  （写入必须"先退出 App → 写 → 再启动"；实现在 §9 有真机验证，但仍不建议作为默认路径。）

### 6.4 实测后的修正：Desktop 侧的真实连接契约（见 §9）

真机验证推翻了三条早期假设，落地必须按实测来：

1. **ssh config 里的别名不会自动变成连接**。`loadRemoteConnections()` 只从已保存的
   `codex-managed-remote-connections` 出发；`eeu(~/.ssh/config)` 的结果只用于
   "已有 remote-projects 时补回连接"和设置页Discover，不进连接列表。
2. **深链 `?name=` 只打开表单**，不会直接建连接（实测路由到达、状态文件无新增条目）。
3. **连接必须先有一条 remote project 才能真正连上**；且远端 codex 必须有**已配置的认证**
   （`authMethod != null`），否则停在 `login-required`。OAuth **不是**必需的，见 §9.5。

### 6.3 Codex → AIH：只做"导入"，不做"双向同步"

- 可读且稳定的只有 **`~/.ssh/config`**（双方共同源头）→ 提供"从 ssh config 导入为 AIH 连接"
  （已有连接按 host+port+user 去重）。
- Desktop 的 `remote-projects` 只在用户明确要求时**一次性读取**（识别远端项目目录 → 建档为 AIH ssh_workspaces），
  并明确标注"非官方状态格式，版本变化后可能读不到"。

## 7. 未验证 / 风险清单

- Desktop 的 **remote-project 注册**未跑通（`remote-projects` 仍是 null）：连接本身已 `connected`，
  但要新建远端项目、跑任务还需要 UI 侧动作；其状态格式同属未文档化私有格式，需下一步验证。
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

## 9. Desktop 壳真机验证（2026-11-24）

### 9.1 安装路径（走 AIH 自己的 WebUI，不是手工 brew）

`/v1/management/webui/toolkit/apps` 里 `codex-desktop`（type=desktop）未安装；计划接口
`POST .../toolkit/apps/plan` 返回 `brew install --cask chatgpt`。

实测踩到两个坑：
- 任务队列在内存里，**服务重启后 job 记录丢失**（查询 404 `job_not_found`），要重新发起；
- cask 记录存在但 `/Applications/ChatGPT.app` 已被删除 → brew 报
  `It seems the App source '/Applications/ChatGPT.app' is not there`。先
  `brew uninstall --cask --force chatgpt` 再装即可，之后 WebUI 正确显示
  `installed: true, version 26.1117.41037`。

### 9.2 状态文件与键名（从 app.asar 解包实证）

主进程 `.vite/build/early-bootstrap*.js`，状态文件 `~/.codex/.codex-global-state.json`：

| 键 | 含义 |
| --- | --- |
| `codex-managed-remote-connections` | 连接列表（**唯一**的连接来源） |
| `remote-projects` | 远端项目（hostId + 目录），连接恢复以它为前提 |
| `remote-connection-auto-connect-by-host-id` | 按 hostId 的自动连接开关 |
| `selected-remote-host-id` / `active-remote-project-id` / `project-order` | 选择与排序 |

连接对象两种形态：

```js
// source=discovered —— 引用 ~/.ssh/config 别名
{hostId:"remote-ssh-discovered:<encodeURIComponent(alias)>", displayName, source:"discovered",
 alias:"aws", hostname:null, sshPort:null, identity:null}
// source=codex-managed —— 直接 host/port/identity
{hostId:"remote-ssh-codex-managed:<uuid>", displayName, source:"codex-managed",
 alias:null, hostname:"host", sshPort:22, identity:"~/.ssh/id_x"}
```

hostId 生成：`remote-ssh-discovered:` + `encodeURIComponent(alias)`（实测 `aws` → `remote-ssh-discovered:aws`）。

别名发现算法（`eeu`/`eeh`，已按源码复刻并跑真实配置）：
- 入口固定 `~/.ssh/config`；支持 `Include` 递归（相对路径按入口所在目录解析，支持 glob）；
- 每个 `Host` **只取第一个别名**；跳过含 `!*?[]` 的通配别名；过滤 `colima`；
- 随后对每个别名执行 `ssh -G -F <config> <alias>` 解析真实 hostname/port/identity，
  hostname 为 `github.com` 的直接排除。
- 用本机真实配置复刻结果：收集 `["colima","aws","github.com"]` → 过滤后 `["aws"]`。

### 9.3 实测结论（关键）

写入 `codex-managed-remote-connections`（`aws`，discovered 形态）+ 自动连接开关，
**退出 App 后写入再启动**，App 日志确认：

```
load_completed savedRemoteConnectionCount=1
ssh_websocket_v0.shell_env_load_completed sshAlias=aws sshAttempted=true
  sshHost=ec2-16-178-55-97.ap-southeast-2.compute.amazonaws.com sshPort=22 status=loaded
remote_connections.connection_state_changed hostId=remote-ssh-discovered:aws state=error
  error={"code":"login-required"}
```

即：**AIH 的连接事实可以被 Desktop 直接消费**，解析别名、起远端 app-server 都成功；
唯一关卡是桌面端与远端的 ChatGPT 账号登录。远端 app-server 报
`appServerVersion=0.171.0-alpha.13`（AWS 上装的就是 0.171.0）。

另有三条与预期不同的行为，落地时必须处理：
1. `refresh_completed discoveredConnectionCount=0`：ssh config 别名**不会**自动进连接列表，
   `loadRemoteConnections()` 只从已保存连接出发。
2. 深链 `codex://settings/connections/ssh/add?name=aws` 只把界面路由到
   `/settings/connections/ssh/add?name=aws`（日志 `ownerRoutePath` 证实），**不落连接**。
3. 没有 `remote-projects` 时 `remote_project_connection_restore_skipped reason=no_remote_projects`。

### 9.4 逆向得到的 App 内部错误码分类（用于把失败原因如实透出）

`remote-codex-not-found` / `login-required` / `update-required` / `restart-required` /
`connection-failed`。AIH 若接管这块 UI，应按这套分类映射，而不是笼统报"连接失败"。

### 9.5 `login-required` 的真实根因：**不是 OAuth**（实测纠正）

早先据此结论写成"必须登录 ChatGPT OAuth 账号"是错的。`app-server-host.js` 里的判定只有一句：

```js
async getPostInitializeConnectionState() {
  if (!this.options.ensureAuth) return {state:"connected", error:null};
  let e = await this.requestAuthStatus(false, false);
  return e?.authMethod == null && (e?.requiresOpenaiAuth ?? true)
    ? {state:"error", error:{code:"login-required"}}   // iQ
    : {state:"connected", error:null};
}
```

即：**只要远端 app-server 报 `authMethod != null` 就连上**；`requiresOpenaiAuth` 只是第二条件，
且缺省值是 `true`（所以"什么都没配"才落到 error）。真机对照：

| 远端 aws 的状态 | `getAuthStatus` 返回 | 桌面端结果 |
| --- | --- | --- |
| 无 auth.json | `authMethod:null, requiresOpenaiAuth:true` | `state=error, code=login-required` |
| 自定义 provider + 环境变量 key | `authMethod:null, requiresOpenaiAuth:**false**` | 判定通过（第一条件 false） |
| `codex login --with-api-key`（**非 OAuth**） | `authMethod:**"apikey"`** | 判定通过，`state=connected` |

最终实测（API key 登录后重启桌面端）：

```
[AppServerConnection] Starting app-server connection hostId=remote-ssh-discovered:aws transport=websocket
[AppServerConnection] Transport start success connectionId=2
[AppServerConnection] Current reported app-server version: currentVersion=0.171.0
[AppServerConnection] state_changed cause=post_initialize_connection_state
  next=connected connectionError=null
remote_connections.connection_state_changed hostId=remote-ssh-discovered:aws
  state=connected appServerVersion=0.171.0 error=null
```

**结论：桌面端远程连 codex 只需远端有任意可用认证（API key 即可），不需要 ChatGPT OAuth。**
这也解释了为什么 `codex login --with-api-key` 是存在的：它就是给无人值守/远程场景用的。

（注：`codex login --with-api-key` 存的是 `auth_mode: apikey`；登录后远端 models 刷新仍会打
`chatgpt.com/backend-api` 并 401，那是模型目录刷新，不影响连接与执行——用自定义 provider 即可避开。）


