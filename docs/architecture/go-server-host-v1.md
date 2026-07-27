# Go Server Host v1

## 1. 状态与范围

`cmd/aih-server` 是当前 Go Server 的真实可执行 Composition Root。v1 只挂载：

- `GET /healthz`；
- `GET /readyz`；
- `/v1/management/accounts` 账号管理 API。

它还不是完整 AIH Gateway，不提供 OpenAI/Anthropic 推理协议、OAuth 作业、usage、
模型刷新、运行态路由、WebUI 或 Fabric。`readyz.capabilities` 固定公开
`account_management_v1`，防止调用方把“账号管理已就绪”误判为“完整 Gateway 已就绪”。

本阶段不创建 Node bridge，不启动 stdio worker，不读取、迁移或双写 `app-state.db`。
账号持久化只使用 `$AIH_HOME/aih.db`。

## 2. 分层与依赖方向

```text
cmd/aih-server
    参数、环境、OS signal、Listener
        ↓
internal/host/aihserver
    Composition Root、HTTP 生命周期、系统探针
        ↓
internal/transport/http/accountsapi
    账号 HTTP 入站适配器
        ↓
application/accounts
    Registrar / Management 用例
        ↓
internal/adapters/accounts/sqliteaccount
    $AIH_HOME/aih.db
        ↓
core/accounts + core/providers
    领域不变量和 Provider Catalog
```

只有 Host 知道 Transport、Application 和 SQLite Adapter 的具体实现。Core 和
Application 不反向依赖进程、HTTP、环境变量或命令行。

## 3. 启动配置

| 来源 | 默认值 | 含义 |
| --- | --- | --- |
| `AIH_HOME` | `$HOME/.ai_home` | 唯一数据库目录 |
| `AIH_SERVER_HOST` | `127.0.0.1` | 监听主机，只允许 loopback |
| `AIH_SERVER_PORT` | `9527` | 监听端口；`0` 只用于系统分配临时端口 |
| `AIH_SERVER_MANAGEMENT_KEY` | 无 | 必填的管理 Bearer 凭据 |
| `--host` | 环境值 | 显式覆盖 loopback 主机 |
| `--port` | 环境值 | 显式覆盖端口 |

Management Key 必须为 32–8192 个非空白、非控制字符。命令刻意不提供
`--management-key`，避免密钥进入 shell history、进程参数和 `ps`。

只读取规范 `AIH_HOME`，不接受 `AI_HOME`、`AIH_HOME_DIR` 或旧数据库路径 fallback。
端口被占用时启动失败，不自动选择另一个固定端口，避免同一机器同时存在两个调用方
误认为是“当前 Server”的进程。只有调用方显式传入 `--port 0` 时才允许临时端口。

### 3.1 启动

先通过当前终端或进程监督器设置：

```text
AIH_HOME
AIH_SERVER_MANAGEMENT_KEY
```

然后启动：

```bash
go run ./cmd/aih-server --host 127.0.0.1 --port 9527
```

成功后输出：

```text
aih-server listening on http://127.0.0.1:9527
```

当前只允许 loopback 明文监听。远程使用应通过 SSH tunnel、VPN 或后续明确实现的 TLS
入口，不允许用 `0.0.0.0` 绕过这一阶段的安全边界。

## 4. 生命周期

Go Server 使用标准库 `net/http`：

| 设置 | 值 |
| --- | ---: |
| `ReadHeaderTimeout` | 5s |
| `ReadTimeout` | 30s |
| `WriteTimeout` | 30s |
| `IdleTimeout` | 60s |
| `MaxHeaderBytes` | 64 KiB |
| 优雅关闭上限 | 10s |

`SIGINT` 和 `SIGTERM` 进入同一关闭路径：

1. 停止接受新连接；
2. 在 10 秒内等待当前请求；
3. 关闭 HTTP 连接；
4. 关闭 SQLite 连接池；
5. 任一步失败时返回非零退出，不吞掉错误。

Management Key、API Key 和请求体不进入启动输出或 `net/http` 错误日志。

## 5. 系统探针

### 5.1 存活

```http
GET /healthz
```

```json
{
  "ok": true,
  "service": "aih-server"
}
```

### 5.2 就绪

```http
GET /readyz
```

```json
{
  "ok": true,
  "service": "aih-server",
  "ready": true,
  "capabilities": [
    "account_management_v1"
  ]
}
```

进程只有在 Provider Catalog、aih.db 和账号 Handler 全部装配成功后才开始监听，因此
`ready=true` 表示当前声明的账号管理能力可接收请求，不表示存在可征召账号。

## 6. 安全边界

- Management Key 只来自进程环境，不进入 argv。
- 所有账号接口包括 loopback 请求都必须携带 Management Key。
- Health/ready 不返回数据库路径、账号数量、凭据或内部错误。
- Host 启动前校验 Management Key；弱 Key 不会创建 `aih.db`。
- Host 只绑定 loopback；不提供“自动信任局域网”分支。
- 账号 HTTP 层继续限制 JSON 大小、重复字段、未知字段和 query。
- SQLite 文件和目录权限继续由 Adapter 固定为 `0600` / `0700`。

## 7. 验证

```bash
go test ./internal/host/aihserver ./cmd/aih-server
go test -race ./internal/host/aihserver ./cmd/aih-server
go vet ./internal/host/aihserver ./cmd/aih-server
go build ./cmd/aih-server
```

测试包含真实 TCP Listener、Codex API Key 创建、账号列表、Management Key 拒绝、
health/ready、未知路由、方法错误、临时 `aih.db` 和上下文取消后的优雅关闭。

## 8. 设计模式

| 模块 | 模式 | 目的 |
| --- | --- | --- |
| `cmd/aih-server` | Composition Root | 只在最外层选择具体 Adapter 和运行参数 |
| `internal/host/aihserver` | Application Host | 集中进程、HTTP 和资源生命周期 |
| `accountsapi.Management` / `Registrar` | Ports and Adapters | Host 依赖应用端口，不把 SQL 放入路由 |
| `ManagementKeyProvider` | Strategy | 鉴权读取与密钥来源解耦 |
| `commandRuntime` | Dependency Injection | 测试不读取真实环境，也不占用固定端口 |

没有加入 IoC 容器、动态插件、配置数据库、服务发现、TLS 管理器或第二套账号模型。当前
需求使用显式构造函数和标准库即可。
