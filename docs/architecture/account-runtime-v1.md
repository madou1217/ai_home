# Go 账号运行态 v1

## 1. 目标与边界

本阶段只为 Codex、Claude 固化账号征召所需的运行态规则，核心定义是：

> cooldown 只表示“预计经过有限时间可以自动恢复，因此在截止时间前暂缓自动重试”。

因此，凭据失效、额度耗尽、工作区停用、模型或地区不支持都不是 cooldown。v1 不修改
SQLite schema，也不读取旧 Node `runtime_state`。Codex / Claude HTTP、SSE 和 Go
transport Observer 已经接入各自的 Go Adapter；Adapter 经 Canonical Coordinator 把
成功或结构化失败写入与账号征召共享的进程级运行态。该接线已经生效，但不代表旧 Node
Gateway 的全部管理面和数据面已经完成切换。

模型 cooldown 固定按 `(account_ref, effective_model_id)` 隔离。`effective_model_id`
是完成模型别名解析后的真实上游模型 ID；客户端别名不能作为 cooldown 键。v1 不提供
账号级请求 cooldown：所有已确认的 Server 瞬态失败都缩小到模型元组，不能因为缺少
模型上下文而退化成全账号处罚。硬阻塞使用独立 `BlockDirective` 明确账号级或账号模型
级作用域，不能复用 cooldown 键推断。

OAuth refresh 的临时网络失败也不进入模型运行态。它属于凭据刷新边界，当前征召器只
跳过本次候选；后续若真实压力证明需要抑制重复刷新，应在 `accountcredentials` 内实现
独立、短期的 refresh suppression，不能复用 Server 请求 cooldown。

## 2. 稳定失败矩阵

Provider Adapter 必须先把 HTTP、SDK 或 streaming 结果映射为稳定 `FailureKind`，
运行态领域不读取响应正文、Token、请求内容或 Provider SDK 错误对象。

| FailureKind | Codex / Claude 证据 | 状态动作 | 阈值 | 默认等待 | 解除条件 |
| --- | --- | --- | ---: | ---: | --- |
| `rate_limited` | 普通 429，且没有 quota/billing 证据 | `model_cooldown` | 1 | 5 分钟 | 到期或当前模型成功 |
| `model_overloaded` | Claude 529、`overloaded_error`、明确模型 capacity | `model_cooldown` | 1 | 1 分钟 | 到期或当前模型成功 |
| `upstream_unavailable` | 确认是上游暂不可用的 5xx | `model_cooldown` | 1 | 30 秒 | 到期或当前模型成功 |
| `request_timeout` | 非用户取消的上游请求超时 | `model_cooldown` | 同类连续 2 次 | 30 秒 | 到期或当前模型成功 |
| `connection_reset` | `ECONNRESET`、等价连接中断 | `model_cooldown` | 同类连续 2 次 | 30 秒 | 到期或当前模型成功 |
| `stream_disconnected` | 缺少正常完成事件的真实流中断 | `model_cooldown` | 同类连续 2 次 | 30 秒 | 到期或当前模型成功 |
| `credential_rejected` | 401、invalid API key | `credential_block` | 不适用 | 不适用 | 凭据更新成功 |
| `reauthentication_required` | Refresh Token 失效或明确 revoked | `credential_block` | 不适用 | 不适用 | reauth 写入新凭据 |
| `quota_exhausted` | 明确 usage window / quota 已耗尽 | `quota_block` | 不适用 | 不适用 | 新 usage 快照确认恢复 |
| `billing_blocked` | 明确 billing 不可用 | `quota_block` | 不适用 | 不适用 | 新账单/usage 快照确认恢复 |
| `workspace_deactivated` | `deactivated_workspace` | `policy_block` | 不适用 | 不适用 | Provider 账号状态重新确认 |
| `model_unsupported` | 账号或 Provider 明确不支持目标模型 | `policy_block` | 不适用 | 不适用 | 模型能力快照更新 |
| `region_unsupported` | Provider 明确拒绝当前地区 | `policy_block` | 不适用 | 不适用 | 地区或策略状态更新 |
| `permission_denied` | 凭据有效但无权访问当前资源或能力 | `policy_block` | 不适用 | 不适用 | 权限或策略快照更新 |
| `invalid_request` | 400/422 请求参数或上下文错误 | `no_state_change` | 不适用 | 不适用 | 当前请求结束 |
| `not_found` | 404，且没有模型能力变化证据 | `no_state_change` | 不适用 | 不适用 | 当前请求结束 |
| `safety_rejected` | 内容或安全策略拒绝 | `no_state_change` | 不适用 | 不适用 | 当前请求结束 |
| `malformed_response` | 响应结构无法解释 | `no_state_change` | 不适用 | 不适用 | 记录诊断并结束当前请求 |
| `request_cancelled` | 客户端或上层主动取消 | `no_state_change` | 不适用 | 不适用 | 当前请求结束 |
| `unclassified` | 证据不足 | `no_state_change` | 不适用 | 不适用 | 补充分类证据 |

未知 `FailureKind` 必须返回错误，不能获得默认 cooldown。显式 `Retry-After` 或 reset
提示只允许覆盖三个直接 cooldown 和三个 streak cooldown 的默认等待时间，且最长为
24 小时。普通 rate limit 的更长窗口重新分类为 quota block；如果 529/5xx 等明确瞬态
信号携带冲突的超长 Header，Adapter 丢弃该提示并使用领域默认 cooldown，不能因此把
模型容量不足猜成额度耗尽。只有 Provider 提供 quota 或 policy 的稳定证据时才进入硬
阻塞。

### 2.1 Provider 结构化映射

共享入口只允许 `status_code`、`error_type`、`error_code`、`retry_after` 四类低敏字段。
错误标识统一为小写，只能包含 ASCII 字母、数字、`_-.` 且最长 80 字符；空格、换行、
message 和原始响应正文都会被拒绝。HTTP 200 被保留用于 SSE 流内结构化错误。

Observer 读取错误正文时使用 64 KiB 固定上限；非 JSON、过大或读取失败的 HTTP 错误
仍可按状态码保守分类，但不会保存正文。`Retry-After` 只接受 RFC 秒数或 HTTP 日期，
非法值被忽略。timeout、`ECONNRESET`、调用方取消都使用 Go `errors.Is/errors.As`
身份判断，不使用 error message 文本。

Codex 分类器使用以下稳定证据：

| 结构化信号 | FailureKind |
| --- | --- |
| 普通 429、`rate_limit_error`、`rate_limit_exceeded` | `rate_limited` |
| 限流恢复提示超过 24 小时、`insufficient_quota` | `quota_exhausted` |
| `billing_not_active` | `billing_blocked` |
| 401、`invalid_api_key` | `credential_rejected` |
| 无明确 code 的 403 | `permission_denied` |
| `deactivated_workspace` | `workspace_deactivated` |
| 529、`model_at_capacity` | `model_overloaded` |
| `model_not_found` | `model_unsupported` |
| 408 | `request_timeout` |
| 5xx | `upstream_unavailable` |
| 400/422、`invalid_request_error` | `invalid_request` |
| `content_policy_violation` | `safety_rejected` |
| 普通 404 | `not_found` |

Codex `response.failed` 允许对当前已确认的
`Selected model is at capacity. Please try a different model.` 做精确匹配；匹配后只生成
`model_at_capacity`，原始 message 立即丢弃。相似文案不会按容量不足猜测。

Claude 分类器使用以下稳定证据：

| 结构化信号 | FailureKind |
| --- | --- |
| 普通 429、`rate_limit_error` | `rate_limited` |
| 明确统一额度窗口、限流恢复提示超过 24 小时、`quota_error` | `quota_exhausted` |
| 529、`overloaded_error` | `model_overloaded` |
| 401、`authentication_error` | `credential_rejected` |
| 403、`permission_error` | `permission_denied` |
| `oauth_token_revoked` | `reauthentication_required` |
| `billing_error` | `billing_blocked` |
| `deactivated_workspace` | `workspace_deactivated` |
| `model_not_found` | `model_unsupported` |
| 400/422、`invalid_request_error` | `invalid_request` |
| `api_error`、5xx | `upstream_unavailable` |
| `safety_rejected` | `safety_rejected` |
| 普通 404 | `not_found` |

Claude 统一额度只在 `anthropic-ratelimit-unified-status=rejected` 且 overage 不是
`allowed/allowed_warning` 时成立；普通 429 或仍可使用 overage 的请求继续保持模型级
`rate_limited`。

明确错误 code/type 的优先级高于宽泛 HTTP 状态。例如 429 +
`insufficient_quota` 不能降级为普通限流；403 + `oauth_token_revoked` 不能降级为普通
权限不足。泛化 403 或 `permission_error` 也不能升级成账号级凭据失效。硬阻塞分类
不允许携带 `Retry-After`，避免调用方误把 quota 或 policy 当成自动恢复 cooldown。

### 2.2 硬阻塞作用域与解除信号

`FailureKind` 只说明失败语义，不能单独决定所有硬阻塞作用域。Provider 分类器必须把
结构化证据转换为低敏 `BlockDirective(scope, recovery_trigger)`，随后由
`AttemptFailure` 原样传给生产账号运行态端口。

| FailureKind | 允许作用域 | 解除信号 | 作用域证据 |
| --- | --- | --- | --- |
| `credential_rejected` | `account` | `credentials_updated` | 凭据属于账号，更新成功后直接解除阻塞 |
| `reauthentication_required` | `account` | `credentials_updated` | reauth 成功写入凭据后直接解除阻塞 |
| `quota_exhausted` | `account` 或 `account_model` | `usage_snapshot` | 必须由 Provider 的统一额度或当前模型长窗口证据明确选择 |
| `billing_blocked` | `account` | `billing_snapshot` | 账单状态属于账号 |
| `workspace_deactivated` | `account` | `account_status` | 工作区状态属于账号 |
| `model_unsupported` | `account_model` | `model_catalog` | 模型目录只修正指定账号模型关系 |
| `region_unsupported` | `account` 或 `account_model` | `policy_snapshot` | 必须由 Provider 明确地区策略作用域 |
| `permission_denied` | `account` 或 `account_model` | `policy_snapshot` | 必须由 Provider 明确资源权限作用域 |

`quota_exhausted`、`region_unsupported` 和 `permission_denied` 没有共享默认作用域；
缺少 Provider 证据时构造分类直接失败。当前已确认的差异为：

- Codex `insufficient_quota` 是账号级；仅由超长模型限流窗口推导时是账号模型级；
- Claude unified rate-limit 或 `quota_error` 是账号级；非 unified 的超长窗口是账号
  模型级；
- Codex/Claude 泛化 403 或 Claude `permission_error` 当前使用最小账号模型级作用域；
- 凭据、billing、workspace 和 model-not-found 使用上表固定作用域。

`RecoveryTrigger` 只声明哪个外部真相源可以解除对应阻塞。v1 不传播、不比较也不持久化
凭据或快照版本：重新认证或凭据更新成功后直接清除 `credentials_updated` 位，模型目录
刷新成功后直接清除 `model_catalog` 位。迟到旧请求若产生真实错误，再按当次上游结果
重新记录；在没有实际并发故障证据前不引入版本机制。

## 3. 连续失败规则

`request_timeout`、`connection_reset`、`stream_disconnected` 使用一分钟 streak
窗口。只有同一个 `(account_ref, effective_model_id)`、相同 `FailureKind` 且前一次
streak 尚未过期时才累加：

- 单次网络抖动只记录 streak，不进入 cooldown；
- 不同 FailureKind 立即从 1 重新计数；
- 任何非 cooldown 失败切断旧 streak；
- streak 到期后下一次从 1 开始；
- 计数器饱和而不回绕；
- 成功只清当前账号与模型元组，不清兄弟模型；
- cooldown 到期在读取路径主动回收，不依赖后台定时任务。

这组规则专门避免旧实现把早先的 `stream disconnected` 与之后的 `ECONNRESET`
累计成同一 streak，进而错误触发模型 cooldown。

## 4. 分层与数据结构

```text
Go Server Codex Responses / Claude Messages Adapter
    HTTP Response / 单个 SSE data payload / Go transport error
        ↓
internal/adapters/upstreamfailure
    有界 JSON + Retry-After + transport 低敏投影
        ↓
internal/adapters/{codex,claude}/upstreamfailure observer + classifier
    Provider envelope / safe Header -> FailureKind + BlockDirective
        ↓
core/accountruntime
    FailurePolicy + BlockDirective + ModelState + Eligibility + ModelRoute
        ↓
application/accountruntime
    线程安全稀疏 Registry，只保存出现过失败的模型 cooldown 元组
        ↓
internal/adapters/accountruntime/inmemory
    AccountRuntime Dispatcher + 账号/账号模型硬阻塞 bitset
        ↕ 同一个进程级 Runtime
application/accountrouting
    enabled 候选 -> runtime eligibility -> credential resolver
                    -> adapter credential transport policy
```

`ModelState` 是单个模型元组的紧凑值，不包含 map。`Registry` 使用
`map[ModelRoute]ModelState`，健康账号没有条目；10,000 个账号不会预分配 10,000 个
运行态对象。生产 `Runtime` 使用 `map[AccountRef]uint8` 与
`map[ModelRoute]uint8` 保存发生过硬阻塞的稀疏条目，每个 bit 对应一个恢复事件。
健康读取使用读锁，过期、失败或明确恢复事件才进入写锁。

征召器必须先检查运行态资格，再读取凭据。`available` 才进入 Credential Resolver；
`credential_blocked`、`quota_blocked`、`policy_blocked`、`model_cooldown` 都会跳过
当前候选。账号级硬阻塞会让该账号的所有模型都返回不可用；账号模型级阻塞不影响兄弟
模型。凭据解析成功后还必须通过当前 Adapter 的传输策略；例如 Canonical Claude
Messages 跳过官方 OAuth 并继续选择 API Key，而 Native Relay 仍使用官方 OAuth。
这种本地不兼容不属于账号失败，不写 credential block、policy block 或 cooldown。
运行态端口异常或返回非法零值时失败关闭，不能把系统错误当成账号不可用。

### 4.1 事务后恢复接线

账号写用例本身不依赖运行态实现。`internal/adapters/accountruntime/accountrecovery`
使用 Decorator 包装重新认证与模型管理端口，并固定以下顺序：

```text
重新认证或模型目录事务成功
    ↓
校验返回的账号或完整模型快照
    ↓
使用不继承请求取消的同进程上下文
    ↓
清除 credentials_updated 或有效模型的 model_catalog 位
```

持久化失败、目录发现失败或返回快照无效时都不会清除阻塞。模型恢复只处理
`AccountModel.Effective()` 为真的排序模型集合：仍不受支持或人工强制禁用的模型不会
被误放行。批量清理会先验证整个集合，再使用一次 Runtime 写锁完成，非法批次不会产生
部分更新。

`internal/host/aihserver` 当前创建一个进程级 `inmemory.Runtime`，由重新认证、模型
管理 Decorator、账号征召和 Canonical Coordinator 共享。Go Host 已挂载生产推理
Executor；请求资格读取和成功/失败终态写入使用同一个 Runtime 实例。

## 5. 当前持久化决定

v1 的模型 cooldown 与硬阻塞都是进程内稀疏索引，不新增数据库字段或表。原因：

- 当前只确认了路由读取与状态转换，还没有确定 Go Server 的写入吞吐和跨进程所有权；
- cooldown 到期后无长期业务价值，不能先把旧 Node JSON 原样迁入新数据库；
- 凭据、quota、policy 各有独立解除条件，不能为了“一张运行态表”重新混在一起。

如果后续确认存在多个 Go Server 进程同时征召同一账号池，再基于真实一致性需求决定
共享存储；届时持久化合同必须保持当前稳定分类和 `BlockDirective` 作用域，不能退回
万能 JSON。

## 6. 当前验证

验证环境：2026-08-13，Apple M4、darwin/arm64、Go 1.26.4。

```text
BenchmarkRegistryCheckEligibilityHealthy-10       84.24 ns/op   0 B/op   0 allocs/op
BenchmarkRegistryCheckEligibilityCooldown-10     147.80 ns/op   0 B/op   0 allocs/op
BenchmarkRuntimeCheckEligibilityHealthy-10       140.50 ns/op   0 B/op   0 allocs/op

BenchmarkStoreQueries/accounts_10000/recruit_ready_account-10    31.489 µs/op
BenchmarkStoreQueries/accounts_100000/recruit_ready_account-10   32.619 µs/op
```

完整征召基准已经包含运行态资格读取、SQLite 候选查询和真实 Credential Resolver。
账号规模扩大十倍后仍保持同一数量级；运行态索引没有全量加载账号。
数值取 `-benchtime=1s -count=3` 三轮中位数。

Provider 分类到征召结果的集成场景：

```text
Codex:
  account A + gpt-5.6-sol 发生 HTTP 529
  gpt-5.6-sol -> 选择 account B
  gpt-5.4     -> 仍选择 account A
  gpt-5.6-sol 成功后 -> 恢复选择 account A

Claude:
  account A + claude-opus-4-1 发生流内 overloaded_error
  claude-opus-4-1 -> 选择 account B
  claude-sonnet-4 -> 仍选择 account A
  claude-opus-4-1 成功后 -> 恢复选择 account A

Transport:
  account A + gpt-5.6-sol 第一次 stream_disconnected -> 仍选择 account A
  相同元组第二次 stream_disconnected                  -> 选择 account B
  sibling gpt-5.4                                    -> 仍选择 account A
  Claude OAuth + claude-sonnet-4                      -> Canonical 跳过
  后续 Claude API Key + claude-sonnet-4               -> Canonical 使用
  同一 Claude OAuth                                   -> Native Relay 使用

Hard block:
  account A + gpt-overloaded 发生 credential_rejected
  sibling gpt-sibling -> 在凭据读取前被排除
  credentials_updated -> 账号两个模型恢复资格
  model_unsupported -> 只排除发生失败的账号模型元组
  model_catalog -> 只恢复该账号模型元组
```

真实上游失败验收使用单账号、单次 attempt，并让 Recruiter 与 Coordinator 共享同一个
生产 `inmemory.Runtime`。凭据只从权限为 `0600` 的有界临时文件进入测试进程；正式账号
数据库只读，不记录 Provider 正文、凭据、请求内容、账号身份或响应 ID。2026-08-13 的
低敏结果为：

```text
Codex OAuth:
  gpt-5.6-luna -> HTTP 503 -> upstream_unavailable
  (account, gpt-5.6-luna) -> model_cooldown
  同账号 gpt-5.4          -> available

Claude auth-token:
  glm-5.2 -> HTTP 429 -> rate_limited
  (account, glm-5.2) -> model_cooldown
  同账号 glm-5.1    -> available

Codex API Key:
  gpt-5.6-sol -> HTTP 200 但缺少成功终态 -> malformed_response
  目标模型与同账号 gpt-5.4 均保持 available
```

这三条证据分别锁定直接 cooldown 的模型作用域和 `no_state_change` 边界。合成回归继续
覆盖 timeout、`ECONNRESET`、断流必须同元组连续两次才 cooldown，以及
`ECONNREFUSED` 只能进入 `unclassified`、不得写账号级健康状态。
