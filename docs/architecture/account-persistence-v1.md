# Go 账号持久化 v1

## 1. 边界

本设计只覆盖当前已经研究和实现的 Codex、Claude 账号领域，不迁移或读取旧
`app-state.db`，也不为 Gemini、runtime、usage、模型 cooldown、OAuth 登录作业、
历史记录或 outbox 预建结构。

数据库固定为 `$AIH_HOME/aih.db`。v1 只包含三个存在当前查询依据的表：

| 表 | 责任 | 热路径 |
| --- | --- | --- |
| `accounts` | 稳定身份、Provider 内 CLI 别名、用户启停和生命周期时间 | Server 账号征召 |
| `account_credentials` | 当前可用凭据的版本化 Provider JSON | 选中账号后按需读取 |
| `account_profiles` | 不含凭据的公开资料与订阅快照 | 账号列表和详情 |

OAuth refresh token 是长期账号凭据，属于 `account_credentials`。OAuth 登录过程中的
`state`、PKCE verifier、device code 和进度不是账号凭据，v1 不持久化这些临时作业。

## 2. 分层

```text
core/accounts + core/accountruntime
    账号不变量、运行态策略和值对象，不认识数据库和 JSON
        ↓
application/accounts + application/accountcredentials
    Store 端口、账号用例和按需凭据可用化
        ↓
application/accountruntime + application/accountrouting
    稀疏模型元组索引；有界扫描并返回首个可用账号
        ↓
internal/adapters/accounts/sqliteaccount
    aih.db、migration、SQL、Provider credential/profile codec
        ↓
cmd / server / cli composition root
    后续阶段负责装配，不允许反向进入 core
```

Provider 凭据和公开资料分别使用 codec strategy 注册到 SQLite Adapter。增加 Provider
时只增加已经研究确认的领域值和对应 codec，不修改表结构、Account Core 或账号查询
SQL。账号管理列表使用独立只读投影端口，不让管理查询依赖或反序列化凭据。

`application/accounts.Management` 当前只编排有界列表、AccountRef 详情和用户启停。
读取端口与生命周期写入端口保持独立，启停时间通过应用时钟注入。注册、凭据刷新、
删除、导入导出不得继续堆入该类型。

`application/accounts.Registrar` 只负责构造新账号注册命令：从经过 Provider
领域校验的 Credential 派生 `account_ref`，校验可选 Profile 属于同一身份，并注入
毫秒精度业务时间。CLI 别名分配和三表原子写入属于 SQLite Adapter，不泄漏到应用层。

## 3. `accounts`

| 字段 | SQLite 类型 | 约束与含义 |
| --- | --- | --- |
| `account_ref` | `TEXT` | 主键；固定 `acct_` + 20 位小写十六进制，不包含凭据 |
| `provider_id` | `TEXT` | 1–64 位规范小写 ID；不在 DDL 枚举 Provider |
| `cli_account_id` | `INTEGER` | Provider 内正整数用户别名，不参与稳定身份派生 |
| `enabled` | `INTEGER` | 只允许 `0/1`；仅表达用户启停，不表达健康或可调度状态 |
| `created_at_ms` | `INTEGER` | UTC Unix 毫秒；范围为 1970-01-01 至 9999-12-31 |
| `updated_at_ms` | `INTEGER` | 最后基础账号变更时间，不得早于 `created_at_ms` |

唯一约束：

- `account_ref`
- `(provider_id, cli_account_id)`

不设置 `deleted_at`。当前删除语义是硬删除，未来只有在出现真实审计需求时才增加归档设计。

### 3.1 新账号注册与 CLI 别名分配

新账号注册不允许调用方指定 `cli_account_id`。SQLite Adapter 在一个事务中依次完成：

1. 使用单条 `INSERT ... SELECT MAX(cli_account_id) + 1 ... RETURNING` 写语句，为当前
   Provider 分配下一个正整数别名并创建 `accounts`；
2. 写入对应的 `account_credentials`；
3. 仅在命令携带同身份公开资料时写入 `account_profiles`；
4. 三步全部成功后提交，否则回滚整笔注册。

别名依赖现有 `(provider_id, cli_account_id)` 唯一索引和 SQLite 单写者事务语义。
Codex 与 Claude 独立从 `1` 开始；不新增 sequence 表，也不在 Go 内执行“先读再写”
的竞争窗口。达到 SQLite 最大正整数时返回 `ErrCLIAccountIDExhausted`，不发生整数
溢出。相同稳定身份或其他唯一约束竞争统一返回 `ErrAccountConflict`。

当前没有删除用例，因此分配只向当前最大别名之后增长。未来若加入删除，必须先明确
数字别名是否允许复用，不能通过修改本 SQL 隐式决定业务语义。

## 4. `account_credentials`

| 字段 | SQLite 类型 | 约束与含义 |
| --- | --- | --- |
| `account_ref` | `TEXT` | 主键及 `accounts` 外键；账号删除时级联删除 |
| `auth_kind` | `TEXT` | `oauth`、`api_key`、`auth_token` 等 Provider 领域认证类型 |
| `auth_mode` | `TEXT` | Claude OAuth 使用 `refreshable`/`access_token`；其他类型为空 |
| `format_version` | `INTEGER` | v1 固定为 `1` |
| `credential_json` | `TEXT` | 严格 JSON object；只允许对应 codec 声明的字段 |
| `updated_at_ms` | `INTEGER` | 最近一次凭据写入或刷新时间 |

数据库文件必须创建为 `0600`。凭据 JSON 不进入日志、错误、`String()`、账号列表或
RoutingAccount。加密密钥若与数据库同文件保存没有安全收益，因此 v1 不实现伪加密；
后续只有在确定 OS Keychain/TPM/用户主密钥来源后才增加真正的 envelope encryption。

### 4.1 Codex OAuth

`auth_kind=oauth`，`auth_mode=""`：

```json
{
  "access_token": "string，必填",
  "refresh_token": "string，必填",
  "id_token": "string，必填",
  "refreshed_at_ms": "正整数 UTC Unix 毫秒",
  "explicit_account_id": "工作区 ID；个人账号为空字符串"
}
```

`access_token` 的 `exp`、用户 ID、邮箱、套餐和 FedRAMP 均由领域构造器重新派生，
不在凭据 JSON 重复保存。

### 4.2 Codex API Key

`auth_kind=api_key`，`auth_mode=""`：

```json
{
  "api_key": "string，必填",
  "base_url": "规范化 HTTP(S) URL，必填"
}
```

### 4.3 Claude 可刷新 OAuth

`auth_kind=oauth`，`auth_mode=refreshable`：

```json
{
  "access_token": "string，必填",
  "refresh_token": "string，必填",
  "expires_at_ms": "正整数 UTC Unix 毫秒",
  "refresh_token_expires_at_ms": "零或正整数 UTC Unix 毫秒",
  "client_id": "官方未提供时为空字符串",
  "scopes": ["非空权限字符串，必须包含 user:inference"],
  "account_uuid": "规范 UUID"
}
```

### 4.4 Claude setup-token OAuth

`auth_kind=oauth`，`auth_mode=access_token`：

```json
{
  "access_token": "string，必填",
  "base_url": "规范化 HTTP(S) URL，必填"
}
```

### 4.5 Claude API Key

`auth_kind=api_key`，`auth_mode=""`：

```json
{
  "api_key": "string，必填",
  "base_url": "规范化 HTTP(S) URL，必填"
}
```

### 4.6 Claude Auth Token

`auth_kind=auth_token`，`auth_mode=""`：

```json
{
  "auth_token": "string，必填",
  "base_url": "规范化 HTTP(S) URL，必填"
}
```

所有 codec 解码时必须拒绝未知字段、缺失字段、尾随 JSON 和超过大小上限的 payload，
然后调用现有 Provider 领域构造器重新校验，不能直接反序列化到私有字段。

## 5. `account_profiles`

公共列表字段保持标量，避免 10,000 个账号列表解析 Provider JSON：

| 字段 | 含义 |
| --- | --- |
| `display_name` | 公开显示名称；未知为空 |
| `email` | 公开邮箱；未知为空 |
| `subscription_kind` | 稳定套餐分类；未知固定为 `unknown` |
| `subscription_raw` | Provider 原始套餐值；未知为空 |
| `format_version` | v1 固定为 `1` |
| `profile_json` | 只保存 Provider 专属的非敏感扩展字段 |
| `updated_at_ms` | 最近一次资料采集时间 |

API Key、Auth Token 和没有公开资料的 setup-token 账号可以没有 profile 行。

公开资料快照使用 `updated_at_ms` 作为版本：

- 新版本覆盖旧版本；
- 相同版本且内容完全一致时幂等成功；
- 旧版本或相同版本但内容不同均返回冲突；
- 读取时重新进入 Provider 领域构造器，并重新派生 `account_ref`；资料身份与基础账号
  不一致时失败关闭。

Codex 资料来源是 ID Token 的公开 claim；Claude 资料来源是 `oauthAccount` 和 secure
storage 中的订阅元数据。Profile 不是 Credential，不保存 Access Token、Refresh
Token、API Key 或 Auth Token。

### 5.1 Codex OAuth profile JSON

```json
{
  "user_id": "稳定用户 ID",
  "account_id": "工作区 ID 或 personal",
  "is_fedramp": false
}
```

`email`、`subscription_kind`、`subscription_raw` 分别写入公共标量列，不在 JSON
重复。

### 5.2 Claude OAuth profile JSON

```json
{
  "account_uuid": "规范 UUID",
  "organization_uuid": "未知时为空字符串",
  "organization_name": "未知时为空字符串",
  "organization_role": "未知时为空字符串",
  "workspace_role": "未知时为空字符串",
  "extra_usage_enabled": "true、false 或 null",
  "billing_type": "未知时为空字符串",
  "account_created_at_ms": "零或正整数 UTC Unix 毫秒",
  "subscription_created_at_ms": "零或正整数 UTC Unix 毫秒",
  "rate_limit_tier": "官方未提供时为空字符串"
}
```

`display_name`、`email`、`subscription_kind`、`subscription_raw` 使用公共标量列。

## 6. 查询矩阵与索引

| 用例 | SQL 形状 | 索引 |
| --- | --- | --- |
| 稳定身份点查 | `WHERE account_ref = ?` | `accounts` 主键 |
| CLI 别名点查 | `WHERE provider_id = ? AND cli_account_id = ?` | 唯一约束自动索引 |
| 账号征召 | `WHERE provider_id = ? AND enabled = 1 AND account_ref > ? ORDER BY account_ref LIMIT ?` | `idx_accounts_routing` |
| 按需读取凭据 | `WHERE account_ref = ?` | `account_credentials` 主键 |
| 按需读取资料 | `WHERE account_ref = ?` | `account_profiles` 主键 |
| 账号管理列表 | 三表按主键 `LEFT JOIN`，`account_ref > ? ORDER BY account_ref LIMIT ?` | 三张表主键 |
| 账号管理详情 | 三表按主键 `LEFT JOIN`，`account_ref = ? LIMIT 1` | 三张表主键 |

`idx_accounts_routing(provider_id, account_ref, cli_account_id) WHERE enabled=1`
覆盖完整 RoutingAccount 查询。SQL 只读取 `account_ref`、`cli_account_id`；
`provider_id` 来自已经校验的 RoutingQuery，避免每行重复读取相同字符串。禁止
`SELECT *`，禁止 offset pagination，禁止在征召路径 JOIN 凭据、资料、usage、模型
或运行态。

当前不为 `enabled` 单列、订阅类型或更新时间建立索引；这些查询没有已确认的高频依据。
账号管理查询只选择认证类型和公开资料标量，SQL 合同明确禁止读取
`credential_json`、`profile_json`。

账号征召器自身保持无状态，不把候选池或凭据缓存到进程内：

1. 使用 `RoutingQuery` 一次读取最多 32 条紧凑投影；
2. 使用别名解析后的真实模型 ID 检查稀疏运行态资格；
3. 只有运行态可用的候选才通过 `AccountRef` 点查凭据，并在 OAuth 即将过期时刷新；
4. 硬阻塞、quota 阻塞、模型 cooldown、缺失凭据、需要重新认证、刷新被拒绝或刷新
   暂时不可用只淘汰当前候选；
5. 数据库、运行态端口、解码、Provider 合同或凭据身份不一致立即失败，不能静默跳过；
6. 未命中时返回最后检查的 `AccountRef`，调用方可继续 keyset 下一页。

模型能力和 usage 尚无 Go v1 持久化真相源，不在账号表伪造字段。模型 cooldown 已使用
独立的进程内稀疏索引接入征召流水线，详细状态矩阵和解除条件见
[`account-runtime-v1.md`](account-runtime-v1.md)；它不是账号池或凭据缓存。

## 7. Migration 与打开数据库

- `PRAGMA application_id=0x41494831`，用于拒绝误打开其他 SQLite 文件。
- `PRAGMA user_version=1`，不创建额外 migration 账本表。
- 只允许从空数据库创建 v1；不扫描、不复制、不修改旧 `app-state.db`。
- 打开已有数据库时，`application_id` 或 `user_version` 不匹配必须失败关闭。
- migration 使用 `BEGIN IMMEDIATE` 串行检查和创建；竞争者获得锁后重新检查版本，失败
  后数据库不得处于半结构状态。
- 每个连接固定启用 `foreign_keys=ON`、`busy_timeout=5000`、
  `trusted_schema=OFF`、`synchronous=NORMAL`。
- 数据库持久使用 WAL；并发进程首次打开时仅对 `SQLITE_BUSY/LOCKED` 做最多 8 次、
  5–100ms 有上限指数退避，不吞掉其他错误。
- `database/sql` 最大打开连接数和最大空闲连接数均为 4，避免 SQLite 单写者模型下
  无意义扩大写竞争。

## 8. 验证结果

验证环境：2026-07-27，Apple M4、darwin/arm64、Go 1.26.4、
`modernc.org/sqlite v1.42.2`。

### 8.1 正确性和并发

- DDL 原子创建三个 `STRICT, WITHOUT ROWID` 表，非法字段和非法 JSON 均被拒绝。
- `EXPLAIN QUERY PLAN` 明确使用
  `USING COVERING INDEX idx_accounts_routing`。
- Codex 两种、Claude 四种凭据 round-trip 后均重新进入 Provider 领域构造器；
  未知字段、重复字段、尾随 JSON 和超大 payload 均失败关闭。
- Codex、Claude 公开资料 round-trip 后重新进入 Provider 领域构造器；未知字段、
  重复字段、尾随 JSON、旧快照、同版本不同内容以及被篡改的资料身份均失败关闭。
- 账号管理列表只读取基础账号、认证类型和公开资料标量；查询计划对三张表都使用主键，
  SQL 自动化测试禁止选择两个 JSON 文档。
- 64 个不同账号并发自动分配别名、16 路同身份竞争、Provider 内别名冲突、跨
  Provider 同别名、别名耗尽、Profile 写入失败整笔回滚、关闭重开恢复均有自动化测试。
- 8 路并发首次打开同一个空数据库连续运行 50 轮通过。

### 8.2 性能

命令：

```bash
go test -run '^$' -bench '^BenchmarkStoreQueries$' \
  -benchmem -benchtime=2s -count=3 \
  ./internal/adapters/accounts/sqliteaccount
```

下表为三轮中位数；`B/op` 是单次操作的累计分配量，不等同于常驻内存。

| 账号数 | 操作 | 中位耗时 | B/op | allocs/op |
| ---: | --- | ---: | ---: | ---: |
| 10,000 | AccountRef 点查 | 6.02µs | 960 | 33 |
| 10,000 | Provider + CLI 别名点查 | 7.16µs | 1,008 | 34 |
| 10,000 | 征召 `LIMIT 32` | 24.41µs | 5,576 | 208 |
| 10,000 | keyset 分页加载全部紧凑投影 | 3.83ms | 3,484,481 | 70,515 |
| 100,000 | AccountRef 点查 | 6.95µs | 960 | 33 |
| 100,000 | Provider + CLI 别名点查 | 14.35µs | 1,008 | 34 |
| 100,000 | 征召 `LIMIT 32` | 24.51µs | 5,576 | 208 |
| 100,000 | keyset 分页加载全部紧凑投影 | 40.48ms | 38,693,212 | 707,194 |

正常 Server 征召只加载 32 条紧凑投影，不全量加载账号，更不会读取凭据。因此账号数
从 10,000 增长到 100,000 时，征召耗时和分配量基本不变。全量加载项是故意设置的
压力基线，不是 Server 运行策略。

### 8.3 完整账号征召性能

命令：

```bash
go test -run '^$' \
  -bench '^BenchmarkStoreQueries/accounts_(10000|100000)/recruit_ready_account$' \
  -benchmem -benchtime=1s -count=3 \
  ./internal/adapters/accounts/sqliteaccount
```

该基准执行真实 covering-index 候选查询、凭据主键点查、严格 JSON 解码、领域身份复核和
Resolver 编排。三轮中位数：

| 账号数 | 中位耗时 | B/op | allocs/op |
| ---: | ---: | ---: | ---: |
| 10,000 | 30.34µs | 6,990 | 122 |
| 100,000 | 31.53µs | 6,990 | 122 |

账号规模扩大十倍后完整征召耗时和分配量保持稳定；正常请求不会全量加载账号，更不会把
1 万个凭据保存在 Go 内存中。

### 8.4 公开资料与账号管理性能

命令：

```bash
go test -run '^$' -bench '^BenchmarkAccountReadModels$' \
  -benchmem -benchtime=2s -count=3 \
  ./internal/adapters/accounts/sqliteaccount
```

fixture 使用身份一致的 Codex 合成公开资料，不读取本机或真实账号凭据。下表为三轮
中位数：

| 账号数 | 操作 | 中位耗时 | B/op | allocs/op |
| ---: | --- | ---: | ---: | ---: |
| 10,000 | Profile 按 AccountRef 点查并领域重构 | 23.92µs | 4,484 | 110 |
| 10,000 | 账号管理详情按 AccountRef 点查 | 36.70µs | 2,040 | 48 |
| 10,000 | 账号管理首屏 `LIMIT 50` | 117.16µs | 51,168 | 1,027 |
| 10,000 | keyset 分页加载全部账号管理投影 | 33.06ms | 21,802,070 | 200,956 |
| 100,000 | Profile 按 AccountRef 点查并领域重构 | 44.53µs | 4,483 | 110 |
| 100,000 | 账号管理详情按 AccountRef 点查 | 36.17µs | 2,040 | 48 |
| 100,000 | 账号管理首屏 `LIMIT 50` | 124.08µs | 51,168 | 1,027 |
| 100,000 | keyset 分页加载全部账号管理投影 | 213.01ms | 235,039,235 | 2,011,496 |

账号管理正常路径固定分页 50 条，账号量扩大十倍后首屏耗时只增加约 6%，单次分配量
不变；详情点查在两个规模下均约 36µs。100,000 条全载会产生约 235MB 累计分配，
因此只保留为压力基线；CLI、Server 和 WebUI 均不得把全载作为常规列表或征召策略。

### 8.4 真实账号管理场景

场景命令：

```bash
go test -run '^TestAccountManagementScenario$' -v \
  ./internal/adapters/accounts/sqliteaccount
```

测试使用临时 `$AIH_HOME/aih.db` 和合成凭据，真实执行以下应用链路：

- 注册带公开 Profile 的 Codex OAuth 账号，分配 `codex/1`；
- 注册无 Profile 的 Claude API Key 账号，分配 `claude/1`；
- 通过 `Management` 执行 `after_ref=""、limit=50` 的账号列表；
- 按 Codex `account_ref` 查询详情；
- 停用 Codex 账号后再次查询详情，`enabled` 从 `true` 变为 `false`，
  `updated_at` 从 `10:00:00Z` 变为 `10:05:00Z`。

测试日志只输出基础账号、认证类型和公开资料标量；不读取或输出
`credential_json`、`profile_json`。这是 Go 应用用例和 SQLite Adapter 的集成场景，
当前阶段尚未暴露 HTTP API。

### 8.5 全量回归

- `go test ./...`：通过。
- `go vet ./...`：通过。
- `go test -race ./...`：通过。
- `golangci-lint run --new-from-rev=HEAD ./...`：0 issues。
- `npm test`：4557 pass、0 fail、3 skip。
- 本批变更路径逐项 `gitleaks dir --redact`：未发现凭据。
