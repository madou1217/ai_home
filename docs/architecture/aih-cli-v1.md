# AIH Go CLI v1 命令说明

本文件说明 Go 重构线 `cmd/aih` 的账号命令，以及它与正式 npm 入口、现有 Provider
runtime 的边界。G1 闭环前，Go 账号链只允许通过独立 Preview 运行；正式 `aih`、Node
Server 和默认 WebUI 均保持现状。命令级用法以 Preview `--help` 为准；本文件额外交代
数据流、异步语义和验收方式，不能用计划中的能力替代当前命令事实。

## 1. 命令总览

正式 Node runtime 继续处理：

```
aih <codex|claude> [provider_args...]                          # Gateway 账号池
aih <codex|claude> relay [account_id] [provider_args...]        # Gateway 同 Provider 固定账号
aih <client> relay <provider> <account_id> [provider_args...]   # Gateway 跨 Provider 固定账号
aih <codex|claude> <account_id> [provider_args...]              # Native Direct
```

Go 账号重构线当前只通过 Preview wrapper 暴露：

```
npm run go-cli:preview -- account add <codex|claude> --from-env
npm run go-cli:preview -- account import <codex|claude>
npm run go-cli:preview -- account transfer export <target> --format sub2api --output <file>
npm run go-cli:preview -- account transfer import --format sub2api --input <file>
npm run go-cli:preview -- account transfer export <target> --format cliproxyapi --output <file>
npm run go-cli:preview -- account credential update <target> --from-env
```

约束：AIH 模式与账号 token 必须放在最前面，其后的参数原样交给官方 CLI，AIH 不解释、
不改写、不补充官方参数。

## 2. 正式 Node 与 Go Preview 隔离

正式 npm 入口仍是 `bin/ai-home.js -> lib/cli/app.js`，所有正式命令继续由现有 Node
Composition Root 处理。当前没有 Go sidecar 分发、`postinstall` 构建或旧账号命令禁用；
在 G1 完成真实闭环、发行和回滚验收前，不得把 `aih account ...` 接入正式入口。

Go 账号链只有以下三个显式入口：

```text
npm run go-preview:server                         # 127.0.0.1:19527
npm run go-preview:web                            # 127.0.0.1:19528
npm run go-cli:preview -- account <subcommand>   # 只访问 Preview Server
```

`scripts/go-accounts-preview.js` 固定使用系统临时目录下的
`aih-go-accounts-preview`，覆盖子进程的 `AIH_HOME`、Server URL 和 Preview 专用密钥；
Server/Web 启动前分别独占探测 19527/19528。默认 Web 路由仍加载 Node `Accounts.tsx`；
只有 `AIH_GO_ACCOUNTS_PREVIEW=1` 的独立 Web 进程加载 `AccountsGoPreview.tsx`，且只代理
`/v1/management` 到 19527。

这个隔离是硬边界：不得用默认端口直接启动 Go Server 做验收，不得让 Preview 读取
`~/.ai_home`，也不得停止、重启或改写正在使用的 Node Server。Provider 原生启动、
Gateway Relay、tmux 会话和其他正式能力继续由 Node runtime 承载。

## 3. 共享状态边界

目标架构中，四种启动模式都继承同一个官方配置目录（`CODEX_HOME` /
`CLAUDE_CONFIG_DIR`），不创建 Provider 级或账号级 HOME；会话、信任、MCP 与插件配置
共享，凭据按 AccountRef 隔离。Gateway Relay 的账号事实由目标 Server 管理，不要求
客户端与 Server 共享 `AIH_HOME`。

当前 G1 Preview 只验收 Go 账号管理控制面，不能据此宣称正式 Native Direct/Relay 已改为
读取 `aih.db`。正式运行模式仍走 Node；Go Preview CLI 只通过 Management API 访问
19527 对应的临时 `aih.db`。

## 4. 跨 Provider 固定账号

```
aih codex relay claude 9 --model claude-opus-5
```

- 客户端仍是官方 Codex CLI，仍然发 OpenAI Responses 请求。
- Server 用 Canonical Adapter 把请求转码成目标 Provider 的线协议（Claude Messages），
  回程再把上游 Anthropic 帧渲染成 Responses 事件流；两个方向都转码，客户端不会
  看到对端协议的原始帧。
- 固定账号通过 `X-Account-Ref` 请求头下发，失败不换号。
- `--model` 必须是该账号真实可用的模型，见第 6 节的模型目录边界。

## 5. `aih account add`

```text
# 以下 `aih account ...` 均通过 `npm run go-cli:preview -- account ...` 执行。
# Codex API Key
OPENAI_API_KEY=<key> OPENAI_BASE_URL=https://api.openai.com/v1 \
  npm run go-cli:preview -- account add codex --from-env

# Claude API Key 或 Auth Token，必须二选一
ANTHROPIC_AUTH_TOKEN=<token> ANTHROPIC_BASE_URL=https://api.anthropic.com \
  npm run go-cli:preview -- account add claude --from-env
```

CLI 只读取官方环境变量，把静态凭据提交给当前目标 Server 的
`POST /v1/management/accounts`。Codex 只接受 API Key；Claude 接受 API Key 或
Auth Token，二者不会混成同一种凭据。账号、凭据和公开资料在目标 `aih.db` 原子提交，
`201` 返回不包含凭据正文。

首次模型发现是提交后的异步派生工作：账号创建不会等待上游模型目录，入队或上游失败
也不会把已提交账号伪装成创建失败。此时模型状态应视为“未知/尚无首次成功快照”，而
不是“不支持所有模型”；可稍后使用
`npm run go-cli:preview -- account models list` 查看，或使用
`npm run go-cli:preview -- account models refresh <account_ref\|provider:id>` 显式等待一次刷新。

## 6. `aih account import`

```
npm run go-cli:preview -- account import <codex|claude>
```

把该 Provider 官方 CLI 的**当前登录态**注册成一个 AIH 账号：

| 步骤 | 行为 |
| --- | --- |
| 读取 | claude: `$CLAUDE_CONFIG_DIR/.credentials.json` + `.claude.json` 的 `oauthAccount`；codex: `$CODEX_HOME/auth.json` |
| 解码 | 只接受官方格式，凭据不落盘、不进日志、不进错误文本 |
| 注册 | 目标 Server 在一次事务内原子分配 Provider 内数字别名并写入其 `AIH_HOME/aih.db` |
| 模型维护 | 注册提交后向 Server 的 Provider 隔离队列发出刷新信号，不等待上游 |

只读取官方文件，不修改官方登录态，不创建任何 Provider 或账号级 HOME。

**模型目录只在账号管理或明确的运行时修复信号下物化。** 运行期不会为每个请求
实时查询上游 `/v1/models`。导入、创建、重新认证和凭据轮换在事务提交后异步刷新；
人工刷新会显式等待刷新结果；推理侧只有明确的 `model_unsupported` 才会发出异步目录
刷新信号。异步失败保留 last-known-good，不用空结果覆盖已有快照。

首次刷新完成前账号模型列表可以为空。空列表表示“还没有首次成功目录证据”，不能
解释成 Provider 不支持所有模型，也不能随手填一个未经账号目录确认的模型。Server
重启时会按 AccountRef keyset 扫描“有凭据但没有上游模型快照”的账号并重新入队；
扫描和上游发现都在后台执行，不阻塞 Server 就绪。

输出示例（不含任何凭据）：

```
已导入 claude 官方登录态:
  账号别名   1
  账号身份   acc_xxxxxxxx
  登录邮箱   someone@example.com
  官方来源   /Users/you/.claude/.credentials.json
             /Users/you/.claude.json
  模型目录   Server 后台异步刷新（不阻塞账号导入）
```

### 隔离验收

导入写入 **Preview Server** 的临时 `AIH_HOME`，因此隔离验收不碰正式数据。Gateway
Relay 不要求客户端与 Server 共享 `AIH_HOME`；它只需要目标 Server URL 和客户端密钥。
固定数字别名还需要目标 Server 的 Management Key，用于远端别名解析。当前统一使用
Preview 启动器，不手工选择端口和目录：

```
# 1. 先起隔离 Server；不会占用或重启正式 Node 9527
npm run go-preview:server

# 2. 另一个终端导入官方登录态；成功立即返回，模型在 Server 后台刷新
npm run go-cli:preview -- account import claude

# 3. 等待后台完成，或显式等待一次模型刷新
npm run go-cli:preview -- account models refresh claude:<别名>

# 4. 独立预览账号页
npm run go-preview:web
# 浏览器打开 http://127.0.0.1:19528/ui/accounts
```

以上是隔离执行配方，不是本文件对本轮真实 Provider 请求结果的声明；真实验收必须另附
当次脱敏请求、响应、模型、耗时和临时数据清理证据。

## 7. 单账号迁移

sub2api 双向迁移：

```text
npm run go-cli:preview -- account transfer export claude:9 --format sub2api --output ./claude-9.json
npm run go-cli:preview -- account transfer import --format sub2api --input ./claude-9.json
```

CLIProxyAPI OAuth auth-file 导出：

```text
npm run go-cli:preview -- account transfer export claude:9 --format cliproxyapi --output ./claude-9-cpa.json
```

三条命令只访问 `AIH_SERVER_BASE_URL` 指定的 Management API，不打开本地 SQLite。
导出必须使用显式文件，独占创建为 `0600`，已有文件和 `-` 均拒绝；导入只接受一个
最大 `1 MiB` 的显式 sub2api JSON 文件。终端仅显示 Provider、数字别名、AccountRef、
格式和文件路径，不显示凭据正文。

sub2api 不携带来源机器的 AccountRef 或数字别名，目标 Server 根据 Provider 稳定身份
注册并重新分配别名。CLIProxyAPI 当前只导出官方单 OAuth auth-file：API Key 属于 CPA
配置，Claude Auth Token 不是 OAuth auth-file，二者都不会被伪装导出。

## 8. 静态凭据更新

```text
# Codex API Key
OPENAI_API_KEY=<new-key> OPENAI_BASE_URL=https://api.openai.com/v1 \
  npm run go-cli:preview -- account credential update codex:1 --from-env

# Claude API Key 或 Auth Token，必须二选一
ANTHROPIC_AUTH_TOKEN=<new-token> ANTHROPIC_BASE_URL=https://api.anthropic.com \
  npm run go-cli:preview -- account credential update claude:9 --from-env
```

CLI 先通过目标 Server 把 `provider:id` 解析为 AccountRef，再把官方环境变量映射成
`PUT /v1/management/accounts/{account_ref}/credential`。Server 先通过账号和凭据时间戳
CAS 原子提交新凭据、清理旧 usage，并保持账号身份、数字别名、启停、默认关系和
last-known-good 模型；响应不等待新模型目录。提交后清理旧 runtime/cooldown 代次并
异步刷新模型，新目录成功后才原子替换自动发现部分。OAuth 账号必须走重新授权，
不允许用本命令伪装成静态账号。

## 9. `aih account delete`

```text
npm run go-cli:preview -- account delete <account_ref|provider:id> --yes
```

CLI 先从目标 Server 读取公开账号快照，再调用
`DELETE /v1/management/accounts/{account_ref}`；`provider:id` 由目标 Server 解析，命令
不会打开本机数据库，也不会用本地别名猜测远端身份。`--yes` 是必需的显式不可恢复
确认，Go 不提供 `delete-all` 或 selector 批量删除。

数据库删除前，Server 的 `DeletionGuard` 会从
`$AIH_HOME/run/persistent-sessions` 筛选该 AccountRef 的非 Gateway 登记，并按 socket
探测登记的 exact tmux session：

- exact session 仍存活：API 返回 `409 account_runtime_active`，CLI 不删除账号；
- tmux server 或 exact session 被可靠确认不存在：先清理 stale 登记，再删除账号；
- tmux 不可用、探测超时/异常、登记损坏或无法清理：API 返回
  `503 account_runtime_unverifiable`，失败关闭且保留账号。

当前 probe 与数据库删除不是跨进程原子租约：检查结束后仍存在新会话恰好启动的极小
TOCTOU 窗口。它是已知剩余边界，后续 Node runtime 全迁移时由统一 account lease
消除；当前 CLI/API 不能宣称已经提供强原子 writer 排他。

## 10. 环境变量

| 变量 | 作用 |
| --- | --- |
| `AIH_HOME` | Go Server 业务数据库所在目录；Preview 启动器强制覆盖为系统临时目录 |
| `AIH_SERVER_BASE_URL` | Go 二进制保留默认 `http://127.0.0.1:9527`；G1 Preview wrapper 始终覆盖为 `http://127.0.0.1:19527`，验收禁止使用默认值 |
| `AIH_SERVER_CLIENT_KEY` | Gateway 模式必需的客户端密钥，CLI 与 Server 两侧都要 |
| `AIH_SERVER_MANAGEMENT_KEY` | 固定 Relay 数字别名解析和账号管理所需的管理密钥，只从环境变量读取 |
| `AIH_SERVER_HOST` / `AIH_SERVER_PORT` | Server 监听地址与端口，只允许 loopback |
| `AIH_CODEX_BINARY` / `AIH_CLAUDE_BINARY` | 可选官方 CLI 路径 |
| `CODEX_HOME` / `CLAUDE_CONFIG_DIR` | 官方 CLI 自己的配置目录，AIH 原样继承 |
| `OPENAI_API_KEY` / `OPENAI_BASE_URL` | Codex 静态账号新增/更新输入；Base URL 可选 |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL` | Claude 静态账号新增/更新输入；Key 与 Token 必须二选一 |
