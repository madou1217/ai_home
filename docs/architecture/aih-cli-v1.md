# AIH Go CLI v1 命令说明

本文件是 Go 重构线 `cmd/aih` 已实现命令的唯一说明。每个命令都可以用 `--help`
在终端拿到同一份内容；本文件额外交代模式边界、数据边界和验收方式。

## 1. 命令总览

```
aih <codex|claude> [provider_args...]                          # Gateway 账号池
aih <codex|claude> relay [account_id] [provider_args...]        # Gateway 同 Provider 固定账号
aih <client> relay <provider> <account_id> [provider_args...]   # Gateway 跨 Provider 固定账号
aih <codex|claude> <account_id> [provider_args...]              # Native Direct
aih account import <codex|claude>                               # 导入官方 CLI 登录态
```

约束：AIH 模式与账号 token 必须放在最前面，其后的参数原样交给官方 CLI，AIH 不解释、
不改写、不补充官方参数。

## 2. 共享状态边界

四种启动模式都继承同一个官方配置目录（`CODEX_HOME` / `CLAUDE_CONFIG_DIR`）。
AIH **不创建** Provider 级或账号级 HOME，会话、信任、MCP 与插件配置全部共享，
多个账号并发使用互不干扰。唯一属于 AIH 的数据是 `AIH_HOME/aih.db`（默认
`~/.ai_home/aih.db`），只存账号、凭据、模型目录与路由。

## 3. 跨 Provider 固定账号

```
aih codex relay claude 9 --model claude-opus-5
```

- 客户端仍是官方 Codex CLI，仍然发 OpenAI Responses 请求。
- Server 用 Canonical Adapter 把请求转码成目标 Provider 的线协议（Claude Messages），
  回程再把上游 Anthropic 帧渲染成 Responses 事件流；两个方向都转码，客户端不会
  看到对端协议的原始帧。
- 固定账号通过 `X-Account-Ref` 请求头下发，失败不换号。
- `--model` 必须是该账号真实可用的模型，见下一节。

## 4. `aih account import`

```
aih account import <codex|claude>
```

把该 Provider 官方 CLI 的**当前登录态**注册成一个 AIH 账号：

| 步骤 | 行为 |
| --- | --- |
| 读取 | claude: `$CLAUDE_CONFIG_DIR/.credentials.json` + `.claude.json` 的 `oauthAccount`；codex: `$CODEX_HOME/auth.json` |
| 解码 | 只接受官方格式，凭据不落盘、不进日志、不进错误文本 |
| 注册 | 在一次事务内原子分配 Provider 内数字别名并写入 `AIH_HOME/aih.db` |
| 物化模型 | 导入阶段拉取一次该账号真实可用的模型目录并落库 |

只读取官方文件，不修改官方登录态，不创建任何 Provider 或账号级 HOME。

**模型目录只在账号管理阶段物化。** 运行期不实时查询上游 `/v1/models`，
导入、重新认证、凭据轮换和人工刷新是模型目录仅有的写入时机。因此
`--model` 只能从导入输出里列出的真实模型中选，不允许随手填一个。

模型目录拉取失败时导入整体失败，不会写入一个空目录账号——空目录账号只会
诱导后续随手填模型。失败错误带上游 HTTP 状态码与分类后的媒体类型
（如 `status=401 media_type=application/json`），据此区分鉴权、限流与上游故障；
上游错误正文一律丢弃，不进错误链、不进日志。

输出示例（不含任何凭据）：

```
已导入 claude 官方登录态:
  账号别名   1
  账号身份   acc_xxxxxxxx
  登录邮箱   someone@example.com
  数据目录   /tmp/aih-verify
  官方来源   /Users/you/.claude/.credentials.json
             /Users/you/.claude.json
  可用模型   N 个
             ...
```

### 隔离验收

导入写入 `AIH_HOME` 指向的库，因此真实验收可以完全不碰正式数据。
注意跨 Provider relay 属于 Gateway 模式，**必须先起一个指向同一个 `AIH_HOME`
的 Server**，且端口要避开 legacy Node 常驻的 9527：

```
mkdir -p /tmp/aih-verify

# 1. 导入官方登录态并物化真实模型目录
AIH_HOME=/tmp/aih-verify go run ./cmd/aih account import claude

# 2. 起隔离 Server（Client/Management Key 只从环境变量读取，不接受命令行传入）
AIH_HOME=/tmp/aih-verify \
AIH_SERVER_CLIENT_KEY=<本次验收随机串> \
AIH_SERVER_MANAGEMENT_KEY=<本次验收随机串> \
go run ./cmd/aih-server --port 9531

# 3. 跨 Provider 固定账号真实调用，--model 只能取第 1 步输出里的模型
AIH_HOME=/tmp/aih-verify \
AIH_SERVER_BASE_URL=http://127.0.0.1:9531 \
AIH_SERVER_CLIENT_KEY=<同上> \
go run ./cmd/aih codex relay claude <别名> --model <真实模型>
```

## 5. 环境变量

| 变量 | 作用 |
| --- | --- |
| `AIH_HOME` | 唯一业务数据库所在目录，默认 `~/.ai_home` |
| `AIH_SERVER_BASE_URL` | Gateway 模式的 Server 地址，默认 `http://127.0.0.1:9527` |
| `AIH_SERVER_CLIENT_KEY` | Gateway 模式必需的客户端密钥，CLI 与 Server 两侧都要 |
| `AIH_SERVER_MANAGEMENT_KEY` | Server 启动必需的管理密钥，只从环境变量读取 |
| `AIH_SERVER_HOST` / `AIH_SERVER_PORT` | Server 监听地址与端口，只允许 loopback |
| `AIH_CODEX_BINARY` / `AIH_CLAUDE_BINARY` | 可选官方 CLI 路径 |
| `CODEX_HOME` / `CLAUDE_CONFIG_DIR` | 官方 CLI 自己的配置目录，AIH 原样继承 |
