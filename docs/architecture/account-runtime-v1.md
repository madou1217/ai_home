# Go 账号运行态 v1

## 1. 目标与边界

本阶段只为 Codex、Claude 固化账号征召所需的运行态规则，核心定义是：

> cooldown 只表示“预计经过有限时间可以自动恢复，因此在截止时间前暂缓自动重试”。

因此，凭据失效、额度耗尽、工作区停用、模型或地区不支持都不是 cooldown。v1 不修改
SQLite schema，也不读取旧 Node `runtime_state`。Go Server 上游适配器尚未接入本合同，
不能把本阶段解释成旧 Node Gateway 已经完成切换。

运行态固定按 `(account_ref, effective_model_id)` 隔离。`effective_model_id` 是完成模型
别名解析后的真实上游模型 ID；客户端别名不能作为 cooldown 键。v1 不提供账号级请求
cooldown：所有已确认的 Server 瞬态失败都缩小到模型元组，不能因为缺少模型上下文而
退化成全账号处罚。

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
| `credential_rejected` | 401/403、invalid API key | `credential_block` | 不适用 | 不适用 | 凭据版本更新 |
| `reauthentication_required` | Refresh Token 失效或明确 revoked | `credential_block` | 不适用 | 不适用 | reauth 写入新凭据 |
| `quota_exhausted` | 明确 usage window / quota 已耗尽 | `quota_block` | 不适用 | 不适用 | 新 usage 快照确认恢复 |
| `billing_blocked` | 明确 billing 不可用 | `quota_block` | 不适用 | 不适用 | 新账单/usage 快照确认恢复 |
| `workspace_deactivated` | `deactivated_workspace` | `policy_block` | 不适用 | 不适用 | Provider 账号状态重新确认 |
| `model_unsupported` | 账号或 Provider 明确不支持目标模型 | `policy_block` | 不适用 | 不适用 | 模型能力快照更新 |
| `region_unsupported` | Provider 明确拒绝当前地区 | `policy_block` | 不适用 | 不适用 | 地区或策略状态更新 |
| `invalid_request` | 400/422 请求参数或上下文错误 | `no_state_change` | 不适用 | 不适用 | 当前请求结束 |
| `not_found` | 404，且没有模型能力变化证据 | `no_state_change` | 不适用 | 不适用 | 当前请求结束 |
| `safety_rejected` | 内容或安全策略拒绝 | `no_state_change` | 不适用 | 不适用 | 当前请求结束 |
| `malformed_response` | 响应结构无法解释 | `no_state_change` | 不适用 | 不适用 | 记录诊断并结束当前请求 |
| `request_cancelled` | 客户端或上层主动取消 | `no_state_change` | 不适用 | 不适用 | 当前请求结束 |
| `unclassified` | 证据不足 | `no_state_change` | 不适用 | 不适用 | 补充分类证据 |

未知 `FailureKind` 必须返回错误，不能获得默认 cooldown。显式 `Retry-After` 或 reset
提示只允许覆盖三个直接 cooldown 和三个 streak cooldown 的默认等待时间，且最长为
24 小时；更长限制必须重新分类为 quota 或 policy block。

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
Provider Adapter（后续）
    HTTP / SDK / stream error -> 稳定 FailureKind
        ↓
core/accountruntime
    FailurePolicy + ModelState + Eligibility + ModelRoute
        ↓
application/accountruntime
    线程安全稀疏 Registry，只保存出现过失败的模型元组
        ↓
application/accountrouting
    enabled 候选 -> runtime eligibility -> credential resolver
```

`ModelState` 是单个模型元组的紧凑值，不包含 map。`Registry` 使用
`map[ModelRoute]ModelState`，健康账号没有条目；10,000 个账号不会预分配 10,000 个
运行态对象。健康读取使用读锁，过期或失败更新才进入写锁。

征召器必须先检查运行态资格，再读取凭据。`available` 才进入 Credential Resolver；
`credential_blocked`、`quota_blocked`、`policy_blocked`、`model_cooldown` 都只跳过
当前候选。运行态端口异常或返回非法零值时失败关闭，不能把系统错误当成账号不可用。

## 5. 当前持久化决定

v1 的模型 cooldown 是进程内瞬态索引，不新增数据库字段或表。原因：

- 当前只确认了路由读取与状态转换，还没有确定 Go Server 的写入吞吐和跨进程所有权；
- cooldown 到期后无长期业务价值，不能先把旧 Node JSON 原样迁入新数据库；
- 凭据、quota、policy 各有独立解除条件，不能为了“一张运行态表”重新混在一起。

如果后续确认存在多个 Go Server 进程同时征召同一账号池，再基于真实一致性需求决定
共享存储；届时持久化合同必须保持当前稳定分类和模型元组作用域，不能退回万能 JSON。

## 6. 当前验证

验证环境：2026-07-28，Apple M4、darwin/arm64、Go 1.26.4。

```text
BenchmarkRegistryCheckEligibilityHealthy-10       84.24 ns/op   0 B/op   0 allocs/op
BenchmarkRegistryCheckEligibilityCooldown-10     147.80 ns/op   0 B/op   0 allocs/op

BenchmarkStoreQueries/accounts_10000/recruit_ready_account-10    31.489 µs/op
BenchmarkStoreQueries/accounts_100000/recruit_ready_account-10   32.619 µs/op
```

完整征召基准已经包含运行态资格读取、SQLite 候选查询和真实 Credential Resolver。
账号规模扩大十倍后仍保持同一数量级；运行态索引没有全量加载账号。
数值取 `-benchtime=1s -count=3` 三轮中位数。
