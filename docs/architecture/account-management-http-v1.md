# Go 账号管理 HTTP API v1

## 1. 状态与边界

本合同实现于 `internal/transport/http/accountsapi`，并由 `cmd/aih-server` 的 Go
Composition Root 挂载（当前只由独立 Preview 进程验收）。该命令直接装配 Provider Catalog、账号应用用例和
`$AIH_HOME/aih.db`，不接入旧 Node Server，也不读取 `app-state.db`。Host 设计见
[Go Server Host v1](go-server-host-v1.md)。

G1 闭环前，本合同只在独立 Go Preview 中验收：Server 固定监听 `127.0.0.1:19527`，
账号页固定监听 `127.0.0.1:19528`，数据库位于系统临时目录。正式 `aih`、Node Server
和默认 WebUI 继续使用现有 Node 链；本文件描述 API 能力不等于已经正式切流。

本阶段只覆盖 Codex/Claude，并包括：

- Codex API Key 账号创建；
- Claude API Key/Auth Token 账号创建；
- Codex 官方 `auth.json` 原生账号导入；
- Claude 官方 secure storage 与 `oauthAccount` 原生账号导入；
- 无敏感字段的账号列表和详情；
- 用户启用、关闭和删除账号；
- Codex API Key、Claude API Key/Auth Token 静态凭据原地轮换；
- 账号模型查询、人工策略与显式刷新；
- usage 最近快照查询与显式刷新；
- 单账号 sub2api / CLIProxyAPI 导入导出。

OAuth 发起、回调和重新认证由独立的 `accountauthapi` 作业接口负责，不与账号资源或
静态凭据 PUT 混成一个请求。原生导入只消费用户已经拥有的官方登录 artifact；模型
cooldown 和 Provider 运行健康仍属于独立 runtime 边界。

创建、原生/sub2api 导入、OAuth 注册、OAuth 重登和静态凭据轮换遵守同一个提交边界：
先原子提交账号事实，再向异步模型刷新协调器发出低敏信号。HTTP 成功响应不等待
Provider 模型目录；刷新入队失败或上游失败不能回滚、也不能把已提交写入伪装成失败。
协调器按 Provider 隔离 worker，把首次任务与退避重试放在独立 FIFO，同一 AccountRef
任务合并；新账号不会被同 Provider 的长退避重试堵住，换凭据/删除会切断旧任务代次。

## 2. 分层

```text
HTTP Client
    ↓ Bearer Management Key + JSON
internal/transport/http/accountsapi
    鉴权、路由、DTO、输入限制、HTTP 错误映射
    ↓ NativeAccountDecoder + 细粒度应用端口
internal/adapters/accounts/nativeaccount
    组合 Provider 官方 codec，输出 Credential / PublicProfile
    ↓
application/accounts
    Management / Registrar / Reauthenticator / CredentialRotator
    ↓ 提交后 Decorator
    Provider 隔离的 ModelRefreshCoordinator
    ↓ Store 端口
internal/adapters/accounts/sqliteaccount
    aih.db 事务和查询
```

Transport 不打开数据库、不读取文件路径、不执行 Provider OAuth，也不依赖 Node
Server 或 WebUI。原生 JSON 只传给 Provider codec；`internal/host/aihserver` 负责
Composition Root 和进程生命周期。

### 2.1 Preview CLI 控制面

```text
npm run go-cli:preview -- account add/list/show/models
npm run go-cli:preview -- account import <provider>
        │
        ├─ add/list/show/models：Management API Client → 当前 AIH_SERVER_BASE_URL
        └─ import：本机官方 CODEX_HOME/CLAUDE_CONFIG_DIR artifact
                   → Management API Client → 当前 AIH_SERVER_BASE_URL
                                      ↓
                                  目标 Server 的 aih.db
```

Go Preview 账号管理 CLI 不打开本机 `aih.db`，也不把目标 Server 的 `AIH_HOME` 当作共享文件系统。
`AIH_HOME` 仅由 Native Direct 和 Server 自身作为本地运行态目录使用；Gateway Relay
的账号事实始终由目标 Server 决定。导入命令只读取本机官方登录 artifact，不创建
Provider 或账号级 HOME，不修改官方登录态。

### 2.2 Preview WebUI 控制面

默认 `web/src/pages/Accounts.tsx` 和正式 Web 路由继续使用 Node `/v0/webui/accounts*`。
只有显式执行 `npm run go-preview:web` 时，独立进程才加载
`web/src/pages/AccountsGoPreview.tsx`，并通过 TypeScript `AccountManagementFacade`
访问同源 `/v1/management/**`；开发代理只把该精确路径转发到 Go 19527。Preview 不读取
active Server Profile，也不会把正式 Node 账号写链改成双写。

Go 账号基础投影当前不包含 runtime、quota 或 schedulable 事实，Web 防腐层必须把这些
字段保持为 `unknown`，不得因为“有 API Key”或“列表为空”伪造为健康、可调度、额度
充足或模型不支持。页面可见时使用 30 秒低频快照轮询和本地 mutation 通知；这不是把
旧 Node SSE 状态投影继续接回账号写链。

## 3. 通用合同

### 3.1 基础地址

Preview 固定完整地址为：

```text
http://127.0.0.1:19527/v1/management/accounts
http://127.0.0.1:19527/v1/management/account-imports
```

测试内部可以使用 `--port 0` 让操作系统分配临时 loopback 端口。人工或浏览器验收必须
通过 Preview 启动器使用 19527/19528，不能占用、重启或探测写入正式 Node 9527。真实
进程 smoke 会记录当次地址、脱敏 payload、状态码和 response。

### 3.2 鉴权

所有路由都要求：

```http
Authorization: Bearer <Management Key>
```

- 缺失、空值、格式错误、多个 `Authorization` 请求头或错误 Key 均返回 `401`。
- 当前 Key 由 Composition Root 从 `AIH_SERVER_MANAGEMENT_KEY` 注入
  `ManagementKeyProvider`；不接受命令行密钥，避免出现在进程参数中。
- 比较过程使用 SHA-256 摘要和常量时间比较。
- Management Key、API Key、OAuth Token 和内部错误文本不得进入响应。

### 3.3 JSON 与缓存

- 写请求必须使用 `Content-Type: application/json`，允许标准媒体类型参数。
- 普通账号写请求最大 `64 KiB`；原生 artifact 导入最大 `1 MiB`。
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

### 3.4 浏览器跨端口访问

Go Host 只给精确的 `/v1/management` 路径段开启 CORS。允许来源仅为 `http/https` 的
`localhost` 或真实 loopback IP，预检方法只含 `DELETE/GET/PATCH/POST/PUT`，请求头只含
`Accept/Authorization/Content-Type`，且不启用 Cookie credentials。推理 `/v1/**`、
相似前缀、远端域名和路径穿越都不会获得 CORS 权限。桌面端使用 Rust 原生 HTTP，
不依赖此 CORS 例外。

## 4. 路由

| 方法 | 路径 | 用途 | 成功状态 |
| --- | --- | --- | --- |
| `GET` | `/v1/management/accounts` | keyset 分页列出账号 | `200` |
| `POST` | `/v1/management/accounts` | 创建 Codex API Key 或 Claude API Key/Auth Token 账号 | `201` |
| `POST` | `/v1/management/account-imports` | 导入 Codex/Claude 官方认证 artifact | 首建 `201`；安全幂等/更新 `200` |
| `POST` | `/v1/management/account-imports/sub2api` | 导入单个 sub2api 文档 | 首建 `201`；安全幂等/更新 `200` |
| `GET` | `/v1/management/accounts/{account_ref}` | AccountRef 点查 | `200` |
| `PATCH` | `/v1/management/accounts/{account_ref}` | 幂等设置用户启停 | `200` |
| `DELETE` | `/v1/management/accounts/{account_ref}` | 通过持久会话门禁后删除账号及其从属数据 | `204` |
| `PUT` | `/v1/management/accounts/{account_ref}/credential` | 原地轮换静态凭据 | `200` |
| `GET/PATCH` | `/v1/management/accounts/{account_ref}/models` | 查询或维护账号模型 | `200` |
| `POST` | `/v1/management/accounts/{account_ref}/models/refresh` | 显式刷新账号模型 | `200` |
| `GET` | `/v1/management/accounts/{account_ref}/usage` | 读取最近 usage 快照 | `200` |
| `POST` | `/v1/management/accounts/{account_ref}/usage/refresh` | 显式刷新 usage | `200` |
| `GET` | `/v1/management/accounts/{account_ref}/export` | 导出单账号 sub2api 文档 | `200` |
| `GET` | `/v1/management/accounts/{account_ref}/export/cliproxyapi` | 导出 CPA auth 文档 | `200` |
| `POST` | `/v1/management/account-auth-jobs` | 发起 OAuth 注册或已有账号重登作业 | `201` |
| `GET/DELETE` | `/v1/management/account-auth-jobs/{job_id}` | 查询或取消 OAuth 作业 | `200` |
| `POST` | `/v1/management/account-auth-jobs/{job_id}/callback` | 提交一次性 OAuth 回调 | `200` |

集合列表只接受 `after_ref` 和 `limit`。其他操作不接受 query 参数。未知参数、
重复参数、显式空值和 malformed query 均返回 `400 invalid_query`。

## 5. 创建静态账号

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

Claude Auth Token payload：

```json
{
  "provider_id": "claude",
  "auth": {
    "kind": "auth_token",
    "auth_token": "<Claude Auth Token>",
    "base_url": "https://api.anthropic.com"
  }
}
```

`base_url` 由对应 Provider 领域构造器校验和规范化；没有传入时使用该领域定义的官方
默认值。Codex 只接受 `api_key`；Claude 接受 `api_key` 或 `auth_token`，两个敏感字段
同时出现会被拒绝。Transport 不自行猜测 Provider，也不修剪调用方输入。

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
    "model_summary": null,
    "usage_snapshot": null,
    "created_at": "2026-07-27T19:00:00Z",
    "updated_at": "2026-07-27T19:00:00Z"
  }
}
```

API Key/Auth Token 不出现在响应、应用错误或 smoke 证据中。OAuth 或其他 Provider 分别返回
`unsupported_auth_kind` 或 `unsupported_provider`，不会进入错误的兼容分支。

响应只证明账号、凭据和可选公开资料已经提交。首次模型列表允许暂时为空，并在提交后
异步刷新；调用方不得把 `201` 解释为模型目录已经完成，也不得把空列表解释成账号不
支持任何模型。需要同步等待模型结果时，显式调用
`POST /v1/management/accounts/{account_ref}/models/refresh`。

## 6. 导入 Provider 原生账号

请求：

```http
POST /v1/management/account-imports
Authorization: Bearer <Management Key>
Content-Type: application/json
```

Codex payload 直接携带官方 `auth.json` 对象：

```json
{
  "provider_id": "codex",
  "artifacts": {
    "auth_json": {
      "auth_mode": "chatgpt",
      "OPENAI_API_KEY": null,
      "tokens": {
        "id_token": "<ID Token>",
        "access_token": "<Access Token>",
        "refresh_token": "<Refresh Token>",
        "account_id": "<ChatGPT workspace ID 或 null>"
      },
      "last_refresh": "2026-07-27T10:00:00Z"
    }
  }
}
```

Codex 官方 `apikey` auth.json 也可导入；由于官方文件不保存 endpoint，该模式使用
Codex 领域定义的官方默认 Base URL。自定义 endpoint 应继续使用第 5 节创建接口。

Claude payload 必须同时携带 secure storage 和全局 `oauthAccount`：

```json
{
  "provider_id": "claude",
  "artifacts": {
    "credentials_json": {
      "claudeAiOauth": {
        "accessToken": "<Access Token>",
        "refreshToken": "<Refresh Token>",
        "expiresAt": 4102444800000,
        "scopes": ["user:inference"],
        "subscriptionType": "max",
        "rateLimitTier": "default_claude_max_20x"
      }
    },
    "global_config_json": {
      "oauthAccount": {
        "accountUuid": "<Claude account UUID>",
        "emailAddress": "<公开邮箱>"
      }
    }
  }
}
```

Codex 只允许 `auth_json`；Claude 只允许
`credentials_json + global_config_json`。缺失、混用、显式兼容字段或 Provider codec
拒绝的内容统一返回 `422 invalid_native_artifacts`。HTTP 错误不回显底层 artifact。

成功响应与第 5 节共享无敏感账号投影。Registrar 在一个 SQLite 事务中创建账号、
凭据和公开资料。首次创建返回 `201`；相同静态身份再次导入返回 `200` 且严格
no-op，不重复写入。相同 OAuth 身份按 Provider 自带代次事实仲裁：Codex 使用凭据
中的 `last_refresh`，Claude 使用 `expires_at`。严格更新的凭据原地更新并返回 `200`；
相等或更旧的凭据返回当前账号且不得覆盖；缺失或不可比较的代次返回
`409 account_import_generation_unordered`。请求到达顺序和 sub2api 的 `exported_at`
都不能被当作凭据新旧依据。

注册事务成功后立即返回 `201`（首建）或 `200`（安全幂等/可证明更新），模型发现和
额度刷新在后台执行。模型上游超时、限流或
解析失败不会改变本次导入结果；Server 下次启动会扫描仍没有首次上游模型快照的账号
并重新入队。恢复扫描使用 AccountRef keyset、每批最多 256 个候选，只读账号引用和
Provider，不读取凭据 JSON，也不逐账号执行 N+1 查询。

接口只接收 JSON 对象，不接收文件路径，因此不存在 Server 任意文件读取或路径穿越
入口。请求仍只允许 loopback，并要求 Management Key；API Key 和 OAuth Token 不进入
日志、响应或错误。

## 7. 账号列表

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
      "model_summary": null,
      "usage_snapshot": null,
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

只有 `has_more=true` 时 `next_after_ref` 才包含下一页游标。`model_summary` 和
`usage_snapshot` 为 `null` 表示没有持久化证据；有值时只返回 SQLite 中的模型数量与
最近一次成功 usage 快照。每页仍由一次 SQLite 查询完成，不读取或反序列化
`credential_json`、`profile_json`，不逐账号查询，也不请求上游。

## 8. 详情与启停

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

## 9. 静态凭据原地轮换

请求：

```http
PUT /v1/management/accounts/acct_ad95f22070cc1ca83830/credential
Authorization: Bearer <Management Key>
Content-Type: application/json
```

Codex API Key payload：

```json
{
  "auth": {
    "kind": "api_key",
    "api_key": "<new Codex API Key>",
    "base_url": "https://api.openai.com/v1"
  }
}
```

Claude Auth Token payload：

```json
{
  "auth": {
    "kind": "auth_token",
    "auth_token": "<new Claude Auth Token>",
    "base_url": "https://api.anthropic.com"
  }
}
```

Codex 只允许 `api_key → api_key`。Claude 允许 `api_key ↔ auth_token`，并严格拒绝
两个敏感字段混用。OAuth 账号返回
`422 static_credential_rotation_unsupported`，必须走重新认证作业。

`account_ref` 是稳定逻辑账号身份，不会因 Key、Token、认证类型或 Base URL 改变；
响应继续返回原 `account_ref`、`provider_id`、`cli_account_id` 和 `enabled`，且不包含
新旧凭据。SQLite 单事务先执行以下动作：

1. compare-and-swap 替换当前凭据，并通过 `credential_ref` 唯一约束查重；
2. 保持账号主键、数字别名、启停、默认关系、人工模型策略和最后成功模型快照；
3. 删除可能属于旧凭据主体的 usage；
4. 提交后清理旧 usage/runtime/cooldown 任务代次，并异步刷新自动发现模型。

并发修改、SQLite 锁冲突或新凭据已被其他账号占用统一返回
`409 static_credential_rotation_conflict`，整笔事务回滚。成功响应不等待新目录；异步
刷新失败时保留旧模型快照，旧凭据发起但晚到的目录结果还会被凭据 `updated_at` CAS
拒绝，不能覆盖新凭据对应状态。

### 9.1 OAuth 重新认证

创建 OAuth Job 时携带 `target_account_ref` 即表示 reauth。开始授权前先确认目标存在、
Provider 一致且凭据形态允许原地重登；回调解码出的凭据和公开资料必须重新派生出同一
AccountRef。SQLite 在一个事务中替换凭据、公开资料和账号更新时间，任何一步失败都
回滚，旧快照不被部分覆盖。

回调返回的 completed Job 只表示同身份凭据事务已经提交，不表示模型目录已刷新完成。
提交后解除旧 credential block、切换模型刷新代次、保留 last-known-good，并异步刷新
模型和 usage。OAuth Job reauth 与原生 artifact 导入是不同入口，但同身份
原生/sub2api OAuth 导入复用同一套代次仲裁和原地更新语义；不得因请求到达顺序或
文档导出时间覆盖更新凭据。
较旧或无法证明代次的主机快照必须在代次/CAS 校验处失败关闭，不得静默覆盖现有账号。

### 9.2 删除前的持久会话门禁

`application/accounts.DeletionGuard` 位于数据库删除之前；Go Host Composition Root
（当前只由独立 Preview 进程验收，尚未正式切流）将其
实现绑定为 `internal/adapters/accounts/persistentsessionguard.Guard`。Guard 从
`$AIH_HOME/run/persistent-sessions` 读取并严格校验登记，只筛选目标 AccountRef 的非
Gateway 项，按 socket 合并探测后核对每个登记的 exact tmux session 名：

```text
DELETE account
  → 读取目标 AccountRef 的持久会话登记
  → 每个 socket 执行一次 list-sessions
      ├─ exact session 存活       → 409 account_runtime_active，不删除
      ├─ server/session 确认不存在 → 删除 stale 登记，再继续数据库删除
      └─ 引擎缺失/超时/损坏/未知错误
                                  → 503 account_runtime_unverifiable，不删除
  → SQLite 删除账号图
  → 提交后遗忘模型、usage 和 runtime 派生状态
```

登记文件不是“进程存活”的充分证据，只有 exact probe 才能区分 live 与 stale；反过来，
存在登记但不能可靠探测时必须失败关闭，不能以“可能已经退出”为由删除凭据。当前实现
仍存在“门禁检查结束后、数据库删除前又启动同账号新会话”的极小 TOCTOU 窗口，尚未
实现跨进程原子租约。后续 Node runtime 全部迁移时应以统一 account lease 消除该窗口，
不能把本阶段的 probe 描述成强原子保证。

## 10. 单账号 sub2api 迁移

导出：

```http
GET /v1/management/accounts/acct_ad95f22070cc1ca83830/export
Authorization: Bearer <Management Key>
```

成功返回 `200`、`Content-Type: application/json; charset=utf-8` 和
`Content-Disposition: attachment; filename="sub2api-data.json"`。正文是单账号标准
`sub2api-data` 文档，固定输出 `version: 1`，不携带来源 AccountRef、数字别名、模型、
usage 或运行状态。

导入：

```http
POST /v1/management/account-imports/sub2api
Authorization: Bearer <Management Key>
Content-Type: application/json

{
  "type": "sub2api-data",
  "version": 1,
  "exported_at": "2026-08-10T08:00:00Z",
  "proxies": [],
  "accounts": [
    {
      "name": "codex-account",
      "platform": "openai",
      "type": "apikey",
      "credentials": {"api_key": "<Codex API Key>"},
      "concurrency": 0,
      "priority": 0
    }
  ]
}
```

只允许一个 Codex 或 Claude 账号；接受 sub2api 现行 `version: 1` 与未声明版本的标准
文档，未知版本、批量账号、代理、本地身份或未知字段均拒绝。Codex/Claude 已确认的
snake_case 与官方 camelCase 同义字段在边界归一化；同义字段同时出现但值不一致时
拒绝导入，空字符串不会覆盖同组非空值。Claude OAuth 的 `expires_at`、`expiresAt`、
`expiry` 统一为 Unix 毫秒；Codex credential 的 `last_refresh` 与 `lastRefresh` 是可
比较代次事实，缺失时不伪造当前时间。顶层 `exported_at` 只表示文档导出时间，绝不
参与凭据排序。首次创建返回 `201`；安全幂等或同身份可证明更新返回 `200`；不可比较
代次返回 `409 account_import_generation_unordered`，响应不含 artifact、Token 或
代次值。导入复用统一 Registrar 和模型维护链，目标 Server 依据稳定 Provider 身份生成 AccountRef 并
分配数字别名。

与原生导入一致，sub2api 导入的 `201`/`200` 只表示账号事务完成；首次模型目录在
提交后异步维护，不把上游模型失败折叠成导入失败。

## 11. CLIProxyAPI OAuth auth-file 导出

```http
GET /v1/management/accounts/acct_ad95f22070cc1ca83830/export/cliproxyapi
Authorization: Bearer <Management Key>
```

成功返回 `200`、JSON 媒体类型和
`Content-Disposition: attachment; filename="cliproxyapi-auth.json"`。正文可直接放入
CLIProxyAPI `auth-dir`，没有 AIH 私有 envelope。只支持 Codex/Claude OAuth；API Key、
Claude Auth Token 和不可刷新的 OAuth 明确返回 `422 account_export_unsupported`。

当前合同按 sub2api `1e618dbc299fc0a82e9a690bcf2d5843be817113` 与 CLIProxyAPI
`bd34ceca04209ef0460f4b05e3a1a047fb7fad2a`（`v7.2.128`）源码核对。
CPA Claude
auth-file 保留账号/组织 UUID 与组织名；`claude_device_ids` 缺失时由 CPA 自行生成并
持久化，AIH 不伪造设备身份。

## 12. 从 Node 缺陷提炼的回归守卫

这些守卫是 Go 账号链的持续合同，不是继续复刻 Node 数据结构：

| 守卫 | 可执行断言 | 当前状态与证据 |
| --- | --- | --- |
| 新凭据不能被旧结果覆盖 | 凭据刷新/静态轮换使用 `updated_at` CAS；旧凭据发起的模型发现必须在写模型前再次匹配凭据版本；静态重复导入幂等，OAuth 只允许 Provider 代次可证明的新凭据原地更新，旧/同代不覆盖，不可比较时返回稳定 `409` | 已实现：`credential_version_store_test.go`、`static_credential_rotation_store_test.go`、`reauthentication_store_test.go`、并发导入 live 测试 |
| 空模型不是“不支持” | 首次注册可先提交空模型；只有非空、规范化的完整发现结果才能替换上游快照；失败保留 last-known-good；重启恢复仍无首次快照的账号 | 已实现：`model_management_test.go`、`server_test.go`、`initial_model_refresh_recovery_integration_test.go` |
| 请求错误不能污染账号状态 | `invalid_request`、`not_found`、安全拒绝、畸形响应、取消和无可靠证据的错误不得写 cooldown/block；只有明确 `model_unsupported` 才触发模型刷新，429/容量/5xx 不得删模型。反向恢复也必须有 AccountRef、Provider 匹配且不早于当前 block 的成功证据，普通 hook/会话完成不能清掉别的账号或更新后的失败 | 推理侧守卫已实现：`core/accountruntime/policy_test.go`、`application/inferencegateway/coordinator_test.go`、Codex/Claude `upstreamfailure/*_test.go`；Node `6940d76` 暴露的 native-session 恢复边界作为 Go 后续组合 runtime 投影时的合同输入 |
| 删除不能误杀活动 writer | `DeletionGuard` 在数据库写入前按 AccountRef 读取登记、逐 socket 探测 exact tmux session；live 返回冲突，无法验证返回服务不可用，可靠 stale 才先清登记后删除 | 已实现并接入 Go Host Composition Root，由 `deletion_composition_test.go` 在临时 AIH_HOME、假 tmux、真实 TCP/SQLite/worker 上验证；当前仍只在 Preview 验收，且保留检查与新会话启动之间的极小 TOCTOU，尚无跨进程原子租约 |

定向守卫可用以下命令复核：

```bash
go test ./internal/adapters/accounts/sqliteaccount \
  -run 'Test(ReauthenticateRejectsStaleVersionWithoutMutation|StoreRejectsDiscoveredModelsFromStaleCredentialVersion|CredentialVersionStoreReplacesCredentialWithCAS)' -count=1
go test ./application/accounts ./internal/host/aihserver \
  -run 'Test(ModelManagementKeepsSnapshotWhenDiscoveryFails|ServerCreatesAccountBeforeInitialModelRefreshCompletes|ServerRecoversInterruptedInitialModelRefreshAfterRestart)' -count=1
go test ./core/accountruntime ./application/inferencegateway \
  -run 'Test(FailurePolicyMatrix|CoordinatorRefreshesOnlyExplicitlyUnsupportedModels|CoordinatorDiscardsDeferredAccountFailuresAcrossFailedPool)' -count=1
```

## 13. 错误码

| HTTP | code | 含义 |
| ---: | --- | --- |
| `400` | `invalid_query` | query 未声明、重复、为空或 malformed |
| `400` | `invalid_request` | JSON 或 DTO 结构无效 |
| `400` | `invalid_account_ref` | 成员路径不是规范 AccountRef |
| `401` | `unauthorized` | Management Key 无效 |
| `403` | `browser_origin_forbidden` / `browser_preflight_forbidden` | 浏览器来源或预检超出 loopback 管理面白名单 |
| `404` | `account_not_found` | 账号不存在 |
| `404` | `job_not_found` / `reauthentication_target_not_found` | OAuth Job 或重登目标不存在 |
| `404` | `route_not_found` | 路由不存在 |
| `405` | `method_not_allowed` | HTTP 方法不受支持，并返回 `Allow` |
| `409` | `account_conflict` | 稳定身份或 Provider 数字别名冲突 |
| `409` | `account_import_generation_unordered` | 导入凭据缺失或无法证明其代次更新，不执行覆盖 |
| `409` | `account_runtime_active` | exact tmux session 仍在持有目标账号，删除被拒绝 |
| `409` | `cli_account_id_exhausted` | Provider 数字别名耗尽 |
| `409` | `static_credential_rotation_conflict` | 账号已并发变化或新凭据已被占用 |
| `409` | `active_job_exists` / `job_not_pending` | Provider 已有活动 Job，或该 Job 已被处理 |
| `409` | `reauthentication_identity_mismatch` / `reauthentication_conflict` | 重登身份不一致，或目标已有更新 |
| `410` | `job_expired` | OAuth Job 已过期 |
| `413` | `request_too_large` | 普通请求超过 `64 KiB`，或原生导入超过 `1 MiB` |
| `415` | `unsupported_media_type` | 写请求不是 JSON |
| `422` | `unsupported_provider` | 不是当前确认的 Codex/Claude |
| `422` | `unsupported_auth_kind` | 创建接口收到目标 Provider 不支持的静态认证类型 |
| `422` | `invalid_static_credential` | 静态凭据字段组合或 Base URL 无效 |
| `422` | `static_credential_rotation_unsupported` | OAuth 或当前凭据类型不能静态轮换 |
| `422` | `invalid_native_artifacts` | Provider 官方 artifact 缺失、混用或无效 |
| `422` | `invalid_callback` / `state_mismatch` | OAuth 回调无效或不属于当前 Job |
| `422` | `reauthentication_unsupported` / `invalid_reauthentication` | 目标形态或回调结果不能安全原地重登 |
| `422` | `account_export_unsupported` | 账号认证类型不能无损导出为目标格式 |
| `422` | `invalid_account` | 应用层账号数据违反领域不变量 |
| `500` | `internal_error` | 未公开内部细节的服务错误 |
| `502` | `model_refresh_failed` | 显式模型刷新失败，旧快照保持不变 |
| `502` | `provider_rejected` / `provider_unavailable` | OAuth Provider 拒绝或暂时不可用 |
| `503` | `job_capacity_exhausted` | OAuth Job 容器达到有界容量 |
| `503` | `account_runtime_unverifiable` | 存在会话登记，但 tmux/登记状态无法可靠验证，删除失败关闭 |

## 14. 验证命令

```bash
go test ./internal/transport/http/accountsapi
go test ./internal/adapters/accounts/nativeaccount
go test ./internal/adapters/accounts/persistentsessionguard
go test ./application/accounts ./internal/adapters/accounts/sqliteaccount
go test ./internal/host/aihserver ./cmd/aih ./cmd/aih-server
go test -run '^TestAccountsAPILiveSmoke$' -v \
  ./internal/transport/http/accountsapi
```

本地真实 TCP 和命令级 smoke 使用临时 `aih.db` 完成静态账号创建、Claude 原生 OAuth
导入、重复导入幂等/代次仲裁、Codex/Claude 静态凭据轮换、sub2api 导入导出、CLIProxyAPI
auth-file 导出、列表、详情、关闭账号及优雅退出。
真实 Provider harness 在发送推理前先读取该临时账号的模型目录，从返回的有效模型中选择
本次请求模型；测试夹具不再把某个历史模型名当作账号能力事实。模型刷新为异步时，
夹具只轮询临时 Go Server 的本地 `/v1/models`，不会把轮询误计为上游请求。
真实验收证据（均为临时 loopback Server、临时数据库，源 artifact 只读且脱敏）包括：

- Codex OAuth：模型目录 1 次、Responses 非流式/流式各 1 次，均 `200`，`gpt-5.6-sol`
  来自真实目录，marker 与 usage 均存在；
- Claude OAuth：Responses 文本/工具流式与非流式各 `200`，reasoning `effort=high`
  `200`，Native Messages Relay `200` 且收到 `message_stop`；
- 正式 Node Server `127.0.0.1:9527` 未被停止、重启或写入。

真实请求命令通过显式环境变量开启，默认测试仍跳过真实上游；日志和响应不包含原始
Key、Token 或完整上游正文。sub2api 双 Server 迁移的 Provider live 入口也已在同一临时
边界完成 Codex/Claude 源导出、目标导入、真实模型、Responses 和目标重新导出闭环；它
仍不代表正式 Node 入口已经切换。

## 15. 设计模式

| 模块 | 模式 | 目的 |
| --- | --- | --- |
| `Handler` + 细粒度端口 | Ports and Adapters | HTTP 只依赖应用能力，不依赖 SQLite 实现 |
| `BuiltinStaticCredentialFactory` | Strategy + Registry | Provider 与静态认证类型构造差异集中扩展，不增长路由分支 |
| `StaticCredentialRotation` 端口 | Ports and Adapters | HTTP 不依赖 SQLite 事务或 Provider 模型目录实现 |
| `DeletionGuard` + `persistentsessionguard` | Ports and Adapters + Guard | 应用删除用例依赖窄门禁端口，OS/tmux/登记细节留在外部适配器并默认失败关闭 |
| 生命周期刷新 Decorator | Decorator | 保持账号事务返回语义，并把模型/usage 派生刷新移到提交后 |
| `ModelRefreshCoordinator` | Work Queue + Coalescing | Provider 隔离并发、合并同账号任务、失败退避且不阻塞写请求 |
| `NativeAccountDecoder` | Strategy | HTTP 不认识 Codex/Claude 官方认证内部结构 |
| `nativeaccount.Decoder` | Anti-Corruption Layer + Facade | 组合现有 Provider codec，输出稳定应用合同 |
| `sub2api.Decoder/Exporter`、`cliproxyapi.Exporter` | Anti-Corruption Layer + Strategy | 外部迁移格式差异留在边界适配器，不污染账号领域 |
| `Authorizer` | Strategy | 鉴权策略与账号路由解耦，默认失败关闭 |
| request/response DTO | Anti-Corruption Layer | 阻止 HTTP JSON 形状进入领域对象和凭据内部 |

没有引入 Web 框架、IoC 容器、Node bridge、旧数据库兼容或一套额外的通用工作流引擎。
OAuth Job 生命周期由独立 `application/accountauth` 服务负责，账号 HTTP Handler 只依赖
它的窄端口；当前边界继续使用标准库，符合 KISS 和 YAGNI。
