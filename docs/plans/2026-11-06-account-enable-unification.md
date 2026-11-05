# 账号启用状态统一写 Go（2026-11-06 方案）

> 只读盘点 + 方案，不改代码。基线 `main` @ `752abbc1`。
> 起因：cline 账号在 WebUI 显示 `up`，Go `accounts.enabled` 却是 0，模型目录因此一直为空；
> 真机验证 14 条静态清单时必须手工 `PATCH enabled=true` 才生效。

## 0. 结论先行

现状不是「没有同步」，而是**三条链路各自为政**：

| 链路 | 今天的行为 | 问题 |
| --- | --- | --- |
| WebUI 启停 | codex/claude 写 Go；其他 Provider 只写 Node `account_state.status` | 同一操作两种语义，cline 类账号点「启用」对 Go 无效 |
| 周期对账 | `go-account-sync.js:521` 已经会把 `status !== 'down'` 推成 Go `enabled` | 但它只遍历**本轮凭据推送成功**的账号；cline 的 import 每次都 500，所以永远轮不到 |
| Go 侧 | `SetAccountEnabled` 只翻 `accounts.enabled` | 启用后不触发模型/额度刷新，账号仍不可用 |

另有一个语义坑：Node 的 `account_state.status` 同时承载「用户关掉」和「系统因 auth_invalid
自动 retain（`codex-auth-invalid-reconciler.js:266`）」。所以 Go 的 `enabled` 实际上是
**可路由门**，不是纯粹的「用户意图」。

推荐分两步：
- **Phase 1（本周，低风险）**：统一写入口 + 解耦对账 + 启用即刷新，语义定为「可路由门」。
- **Phase 2（后续）**：把「用户意图」与「运行态阻塞」拆成两个字段，Node 只写意图，
  Go 用 `enabled && 无 block` 计算可路由。

## 1. 目标与不变量

1. **单一写入口**：WebUI/CLI 的启停只有一个写者（Phase 1 选 Node，Phase 2 再讨论是否翻转到 Go）。
2. **Go 的可路由门永远等于 Node 的判定**：差异只允许出现在同步延迟内（目标 < 1 个 tick）。
3. **失败可见**：写 Go 失败必须回滚 UI 并返回 502，不能「界面成功、Go 没变」。
4. **不因副作用丢用户意图**：auth_invalid 自动 retain 的账号，恢复后可以自动 up；
   用户手动 down 的账号，恢复后**不得**自动 up（现有 `isSystemRetainedRecoveryState` 语义保留）。
5. **Vertex 占位账号永远 disabled**（`go-account-sync.js:521` 的 vertexPlaceholder 规则）。

## 2. Phase 1：统一写入口 + 解耦对账

### 2.1 WebUI 启停统一写 Go

文件：`lib/server/webui-account-routes.js`（`handleUpdateAccountStatusRequest`）

- 去掉 `provider === 'codex' || provider === 'claude'` 的特判，改为：
  - `deps.goCoreSync.isEnabled()` 为真 → **先写 Go** `setAccountEnabled(nodeRef, enabled)`；
    成功后才写 Node `account_state`（作为展示缓存），失败返回 502 且不改 Node。
  - Go core 关闭 → 只写 Node（保留纯 Node 部署能力），日志标注 `go_disabled`。
- `setAccountEnabled` 接受 **Node ref**，内部走 `goAccountRefFor` 翻译（现有实现已如此，
  见 `go-core-host.js:650`），避免路由层自己翻译。

### 2.2 对账与凭据推送解耦

文件：`lib/server/go-account-sync.js`（第 3 步「启停与默认账号以 Node 为准」）

- 现在的 `primaryByGoRef` 只在本轮 `pushAccount` 成功/跳过后才登记；push 失败直接 `continue`，
  该账号的 enabled/default/modelPolicy 全部跳过。
- 改为：先按 `state.links` + `source.accounts` 构建 `primaryByGoRef`
  （同一 Go 身份仍以首个 Node 账号为主），**与凭据推送结果无关**；推送失败只影响凭据，
  不影响启停/default/模型策略的对账。
- 这样 cline 这种 import 500 的账号，启停也能收敛（凭据问题另行修）。

### 2.3 启用即刷新

文件：`application/accounts/management.go`（`SetAccountEnabled`）

- `enabled=true` 且账号从 disabled → enabled 时，向已有的 `ModelRefreshCoordinator`
  投递一次刷新任务（与 `POST /accounts/{ref}/models/refresh` 同一条
  `RefreshAccountModels` 路径），并触发一次额度探测（如果 Provider 有 Go 额度策略）。
- 位置放在 Go 而不是 Node：CLI/API/同步三条入口都受益，Node 不需要知道刷新细节。
- 失败不影响启用结果（异步、可观察），但要写日志/观测。

### 2.4 修 cline import 500（阻塞项）

- 真机：`POST /v1/management/account-imports`（cline native 凭据）返回
  `500 internal_error`；同步每轮都失败，`state.rejectedImports` 不缓存（不是终态错误）。
- 需要拿到 Go 侧真实错误：当前 handler 把细节吞成 `internal_error`，
  建议在 `writeApplicationError` 里对 5xx 记录 `error_id + error` 到日志（不回给客户端）。
- 大概率是 cline native 凭据 codec 没覆盖该字段组合（两个账号都是 `auth_kind=oauth`、
  3.3KB native JSON）；修好前 cline 的凭据更新一直不落 Go。

### 2.5 守卫与验收

- Node 单测：
  - Go core 可用时，`POST /v0/webui/accounts/:p/:ref/status` 必须调 `setAccountEnabled`；
    Go 失败 → 502 且 `account_state.status` 不变。
  - Go core 关闭时只写 Node（不回归纯 Node 模式）。
  - 构造「push 失败 + link 存在」的同步夹具，断言 enabled/default 仍然收敛。
- Go 单测：`SetAccountEnabled(true)` 会入队一次模型刷新；`false` 不入队。
- 真机：
  1. WebUI 启用 cline → 立即 `accounts.enabled=1`，`/v0/management/models` 出现 14 条；
  2. 禁用 → `enabled=0`，路由池不再选中该账号；
  3. 重启 Node → 状态不漂移（Go 持久 + Node 展示缓存一致）。

## 3. Phase 2：语义拆分（后续）

目标：`accounts.enabled` 只表示**用户意图**，运行态阻塞单独存放。

- Node：`account_state` 增加 `user_enabled`（或把当前 `status` 解释为意图），
  auth_invalid 自动 retain 改为只写 runtime block，不再改 `status`。
- Go：`accounts.enabled` = 意图；路由判定 = `enabled && 无有效 runtime block`。
- 迁移：
  1. 先双写 `user_enabled` 与现有 `status`，观察差异；
  2. 切读 `user_enabled`，保留回滚开关；
  3. 删除 `status` 的启停语义（只留 `up/down` 兼容 CLI）。
- 验收：auth_invalid 自动 retain 的账号在 Go 里 `enabled=1` 但不可路由；
  恢复后无需再写 enabled；用户手动关闭的账号恢复后仍不可路由。

## 4. 风险

| 风险 | 缓解 |
| --- | --- |
| 双写不一致（Go 成功、Node 写失败） | 以 Go 为准回读一次再更新 Node；失败时展示「已启用（待同步）」 |
| 启用触发刷新打上游 | 复用协调器的 Provider 并发/退避；Free/无额度账号失败可观察，不回滚启用 |
| 自动 retain 与用户意图混淆 | Phase 1 明确 `enabled` = 可路由门，文档写清；Phase 2 拆分 |
| cline import 修复引入凭据格式回归 | 先加 Go 解析单测（现有 native JSON 夹具），再改 codec |

## 5. 不做的事

- 不把 Node 的 `account_state` 整表迁到 Go（运行态仍由 Node 计算）。
- 不在 Phase 1 改 auth_invalid 的 retain 语义（属于 Phase 2）。
- 不由 Go 反向修改 Node 的启停（单向 Node → Go）。
