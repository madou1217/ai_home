# Go 账号管理 HTTP API v1

## 1. 状态与边界

本合同实现于 `internal/transport/http/accountsapi`，并由 `cmd/aih-server` 的 Go
Composition Root 挂载。该命令直接装配 Provider Catalog、账号应用用例和
`$AIH_HOME/aih.db`，不接入旧 Node Server，也不读取 `app-state.db`。Host 设计见
[Go Server Host v1](go-server-host-v1.md)。

本阶段只覆盖：

- Codex API Key 账号创建；
- Claude API Key 账号创建；
- 无敏感字段的账号列表和详情；
- 用户启用或关闭账号。

本阶段明确不覆盖 OAuth 发起、回调、刷新、删除、导入导出、usage、模型运行态和
Provider 运行健康。OAuth 是独立作业和 Provider Adapter，不与 API Key 凭据创建混成
一个请求。

## 2. 分层

```text
HTTP Client
    ↓ Bearer Management Key + JSON
internal/transport/http/accountsapi
    鉴权、路由、DTO、输入限制、HTTP 错误映射
    ↓ 细粒度应用端口
application/accounts
    Management / Registrar 用例
    ↓ Store 端口
internal/adapters/accounts/sqliteaccount
    aih.db 事务和查询
```

Transport 不打开数据库、不读取凭据内容、不执行 Provider OAuth，也不依赖 Node
Server 或 WebUI。`internal/host/aihserver` 负责 Composition Root 和进程生命周期。

## 3. 通用合同

### 3.1 基础地址

默认完整地址为：

```text
http://127.0.0.1:9527/v1/management/accounts
```

可以使用 `--port 0` 让操作系统为 smoke 分配临时 loopback 端口。命令启动后输出实际
监听地址；真实进程 smoke 会记录当次地址、脱敏 payload、状态码和 response。

### 3.2 鉴权

所有路由都要求：

```http
Authorization: Bearer <Management Key>
```

- 缺失、空值、格式错误、多个 `Authorization` 请求头或错误 Key 均返回 `401`。
- 当前 Key 由 Composition Root 从 `AIH_SERVER_MANAGEMENT_KEY` 注入
  `ManagementKeyProvider`；不接受命令行密钥，避免出现在进程参数中。
- 比较过程使用 SHA-256 摘要和常量时间比较。
- Management Key、API Key 和内部错误文本不得进入响应。

### 3.3 JSON 与缓存

- 写请求必须使用 `Content-Type: application/json`，允许标准媒体类型参数。
- 单个请求体最大 `64 KiB`。
- 拒绝未知字段、任意层级重复 JSON key、尾随 JSON 和非法 JSON。
- 所有响应使用 `application/json; charset=utf-8`。
- 所有响应设置 `Cache-Control: no-store` 和
  `X-Content-Type-Options: nosniff`。

统一错误 envelope：

```json
{
  "error": {
    "code": "invalid_request",
    "message": "JSON 请求体无效"
  }
}
```

错误消息只描述安全的稳定语义，不回传领域、SQLite 或凭据 codec 的原始错误。

## 4. 路由

| 方法 | 路径 | 用途 | 成功状态 |
| --- | --- | --- | --- |
| `GET` | `/v1/management/accounts` | keyset 分页列出账号 | `200` |
| `POST` | `/v1/management/accounts` | 创建 Codex/Claude API Key 账号 | `201` |
| `GET` | `/v1/management/accounts/{account_ref}` | AccountRef 点查 | `200` |
| `PATCH` | `/v1/management/accounts/{account_ref}` | 幂等设置用户启停 | `200` |

集合列表只接受 `after_ref` 和 `limit`。其他三个操作不接受 query 参数。未知参数、
重复参数、显式空值和 malformed query 均返回 `400 invalid_query`。

## 5. 创建 API Key 账号

请求：

```http
POST /v1/management/accounts
Authorization: Bearer <Management Key>
Content-Type: application/json
```

Codex payload：

```json
{
  "provider_id": "codex",
  "auth": {
    "kind": "api_key",
    "api_key": "<Codex API Key>",
    "base_url": "https://api.openai.com/v1"
  }
}
```

Claude payload：

```json
{
  "provider_id": "claude",
  "auth": {
    "kind": "api_key",
    "api_key": "<Claude API Key>",
    "base_url": "https://api.anthropic.com"
  }
}
```

`base_url` 由对应 Provider 领域构造器校验和规范化；没有传入时使用该领域定义的官方
默认值。Transport 不自行猜测 Provider，也不修剪调用方输入。

响应示例：

```json
{
  "data": {
    "account_ref": "acct_ad95f22070cc1ca83830",
    "provider_id": "codex",
    "cli_account_id": 1,
    "enabled": true,
    "has_credential": true,
    "auth_kind": "api_key",
    "auth_mode": "",
    "has_profile": false,
    "display_name": "",
    "email": "",
    "subscription_kind": "",
    "subscription_raw": "",
    "created_at": "2026-07-27T19:00:00Z",
    "updated_at": "2026-07-27T19:00:00Z"
  }
}
```

API Key 不出现在响应、应用错误或 smoke 证据中。OAuth 或其他 Provider 分别返回
`unsupported_auth_kind` 或 `unsupported_provider`，不会进入错误的兼容分支。

## 6. 账号列表

请求：

```http
GET /v1/management/accounts?limit=50&after_ref=acct_ad95f22070cc1ca83830
Authorization: Bearer <Management Key>
```

参数：

| 参数 | 必填 | 含义 |
| --- | --- | --- |
| `limit` | 否 | 默认 `50`，范围 `1..255` |
| `after_ref` | 否 | 上一页最后一个规范 AccountRef，不包含在下一页 |

Transport 向应用层请求 `limit + 1` 条数据，用额外一条准确判断 `has_more`。查询使用
AccountRef keyset pagination，不使用 offset，也不执行 `COUNT(*)`。

响应示例：

```json
{
  "data": [
    {
      "account_ref": "acct_e2c7b29b592fd5cae691",
      "provider_id": "claude",
      "cli_account_id": 1,
      "enabled": true,
      "has_credential": true,
      "auth_kind": "api_key",
      "auth_mode": "",
      "has_profile": false,
      "display_name": "",
      "email": "",
      "subscription_kind": "",
      "subscription_raw": "",
      "created_at": "2026-07-27T19:00:00Z",
      "updated_at": "2026-07-27T19:00:00Z"
    }
  ],
  "page": {
    "limit": 50,
    "has_more": false,
    "next_after_ref": ""
  }
}
```

只有 `has_more=true` 时 `next_after_ref` 才包含下一页游标。账号列表读取公开标量，不
读取或反序列化 `credential_json`、`profile_json`。

## 7. 详情与启停

详情：

```http
GET /v1/management/accounts/acct_ad95f22070cc1ca83830
Authorization: Bearer <Management Key>
```

启停：

```http
PATCH /v1/management/accounts/acct_ad95f22070cc1ca83830
Authorization: Bearer <Management Key>
Content-Type: application/json

{"enabled":false}
```

PATCH 只允许 `enabled`，不接受隐含的 `status`、Provider、别名、凭据或 Profile
修改。成功后返回与详情相同的公开账号投影。

## 8. 错误码

| HTTP | code | 含义 |
| ---: | --- | --- |
| `400` | `invalid_query` | query 未声明、重复、为空或 malformed |
| `400` | `invalid_request` | JSON 或 DTO 结构无效 |
| `400` | `invalid_account_ref` | 成员路径不是规范 AccountRef |
| `401` | `unauthorized` | Management Key 无效 |
| `404` | `account_not_found` | 账号不存在 |
| `404` | `route_not_found` | 路由不存在 |
| `405` | `method_not_allowed` | HTTP 方法不受支持，并返回 `Allow` |
| `409` | `account_conflict` | 稳定身份或 Provider 数字别名冲突 |
| `409` | `cli_account_id_exhausted` | Provider 数字别名耗尽 |
| `413` | `request_too_large` | 请求体超过 `64 KiB` |
| `415` | `unsupported_media_type` | 写请求不是 JSON |
| `422` | `unsupported_provider` | 不是当前确认的 Codex/Claude |
| `422` | `unsupported_auth_kind` | 创建接口收到非 API Key 认证 |
| `422` | `invalid_api_key` | API Key 或 Base URL 未通过领域校验 |
| `422` | `invalid_account` | 应用层账号数据违反领域不变量 |
| `500` | `internal_error` | 未公开内部细节的服务错误 |

## 9. 验证命令

```bash
go test ./internal/transport/http/accountsapi
go test ./internal/host/aihserver ./cmd/aih-server
go test -run '^TestAccountsAPILiveSmoke$' -v \
  ./internal/transport/http/accountsapi
```

真实 TCP 和命令级 smoke 使用临时 `aih.db` 完成 Codex 创建、Claude 创建、列表、
Codex 详情、关闭账号及优雅退出的完整链路。测试只使用合成凭据，日志中的 `api_key`
固定显示为 `<redacted>`。

## 10. 设计模式

| 模块 | 模式 | 目的 |
| --- | --- | --- |
| `Handler` + 细粒度端口 | Ports and Adapters | HTTP 只依赖应用能力，不依赖 SQLite 实现 |
| `APIKeyCredentialFactory` | Strategy + Registry | Provider 构造差异集中扩展，不增长路由分支 |
| `Authorizer` | Strategy | 鉴权策略与账号路由解耦，默认失败关闭 |
| request/response DTO | Anti-Corruption Layer | 阻止 HTTP JSON 形状进入领域对象和凭据内部 |

没有引入 Web 框架、IoC 容器、OAuth 状态机、Node bridge 或旧数据库兼容。当前边界
使用标准库即可，符合 KISS 和 YAGNI。
