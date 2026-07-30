# Go Server Host v1

## 1. 状态与范围

`cmd/aih-server` 是当前 Go Server 的真实可执行 Composition Root。当前挂载：

- `GET /healthz`；
- `GET /readyz`；
- `/v1/management/accounts` 账号管理 API；
- `/v1/management/account-imports` Codex/Claude 原生账号导入 API；
- `/v1/management/account-auth-jobs` OAuth Job API；
- `GET /v1/models` 本地模型目录；
- `POST /v1/responses`、`POST /v1/chat/completions`、`POST /v1/messages`；
- Claude Native Relay 租约和同路径透传。

Go Host 已装配账号模型倒排、原子 Route Catalog、账号征召、进程内 Runtime 和
Codex/Claude Adapter。它仍不提供 usage、WebUI 或 Fabric。

Canonical 账号征召会使用目标 Adapter 的凭据传输策略。Claude 官方 OAuth 只允许
Native Relay；普通 `/v1/messages` 会跳过它并继续征召 API Key/Auth Token 账号，
不会把本地传输不兼容写成账号失败或 cooldown。

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
internal/host/inferencehttp + internal/transport/http/*
    账号、模型和三种推理 HTTP 入站适配器
        ↓
application/inferencecatalog + application/inferencegateway
    不可变路由快照、Canonical Coordinator
        ↓
application/accountrouting + application/accounts
    账号征召、管理和模型刷新
        ↓
internal/adapters/{accounts,accountruntime,codex,claude}
    aih.db、内存运行态和上游协议
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
| `AIH_SERVER_CLIENT_KEY` | 无 | 必填的模型目录和推理客户端凭据 |
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
AIH_SERVER_CLIENT_KEY
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
| `WriteTimeout` | 10m |
| `IdleTimeout` | 60s |
| `MaxHeaderBytes` | 64 KiB |
| 优雅关闭上限 | 10s |

`SIGINT` 和 `SIGTERM` 进入同一关闭路径：

1. 停止接受新连接；
2. 在 10 秒内等待当前请求；
3. 关闭 HTTP 连接；
4. 停止账号模型和 Route Catalog 后台 worker；
5. 关闭 SQLite 连接池；
6. 任一步失败时返回非零退出，不吞掉错误。

Management Key、API Key、OAuth Token 和请求体不进入启动输出或 `net/http` 错误日志。

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
    "account_management_v1",
    "account_auth_jobs_v1",
    "local_model_catalog_v1",
    "canonical_inference_v1",
    "claude_relay_leases_v1",
    "claude_native_relay_v1"
  ],
  "inference_catalog_ready": true
}
```

`ready=true` 表示生产 Route Catalog 已发布；空账号集合也是有效的空快照。后续刷新
失败但存在 last-known-good 时保持 ready，同时返回 `inference_catalog_stale=true`。

## 6. 安全边界

- Management Key 只来自进程环境，不进入 argv。
- Client Key 与 Management Key 必须不同。
- 所有账号接口包括 loopback 请求都必须携带 Management Key。
- 模型和推理接口只接受 Client Key；Messages 支持标准 `x-api-key`。
- Health/ready 不返回数据库路径、账号数量、凭据或内部错误。
- Host 启动前校验 Management Key；弱 Key 不会创建 `aih.db`。
- Host 只绑定 loopback；不提供“自动信任局域网”分支。
- 账号 HTTP 层继续限制 JSON 大小、重复字段、未知字段和 query。
- 原生导入只接收 JSON artifact，不接受任何服务端文件路径。
- SQLite 文件和目录权限继续由 Adapter 固定为 `0600` / `0700`。

## 7. 验证

```bash
go test ./internal/host/aihserver ./cmd/aih-server
go test -race ./internal/host/aihserver ./cmd/aih-server
go vet ./internal/host/aihserver ./cmd/aih-server
go build ./cmd/aih-server
```

测试包含真实 TCP Listener、Codex/Claude API Key 推理、三种客户端协议、Claude
原生 OAuth 导入与 Relay 分流、OAuth 在前而 API Key 在后的 Canonical 征召、
重复导入、账号列表、权限域拒绝、health/ready、临时 `aih.db` 和优雅关闭。上游由
合成 HTTP Client 提供，不使用真实凭据或网络。

## 8. 设计模式

| 模块 | 模式 | 目的 |
| --- | --- | --- |
| `cmd/aih-server` | Composition Root | 只在最外层选择具体 Adapter 和运行参数 |
| `internal/host/aihserver` | Application Host | 集中进程、HTTP 和资源生命周期 |
| `application/inferencecatalog` | Immutable Snapshot | 原子发布模型展示与路由解析的单一真相 |
| `RefreshCoordinator` | Coalescing Worker | 合并账号写入触发的目录刷新 |
| `ProviderRouteFactory` | Strategy + Registry | Provider 自己声明协议和能力 |
| `CredentialTransportPolicy` | Strategy | Adapter 决定当前线协议支持哪些凭据，征召器保持 Provider 无关 |
| `accountsapi.Management` / `Registrar` | Ports and Adapters | Host 依赖应用端口，不把 SQL 放入路由 |
| `ManagementKeyProvider` | Strategy | 鉴权读取与密钥来源解耦 |
| `commandRuntime` | Dependency Injection | 测试不读取真实环境，也不占用固定端口 |

没有加入 IoC 容器、动态插件、配置数据库、服务发现、TLS 管理器或第二套账号模型。当前
需求使用显式构造函数和标准库即可。
