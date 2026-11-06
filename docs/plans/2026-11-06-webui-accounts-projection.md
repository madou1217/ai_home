# WebUI 账号页投影迁 Go：切分方案

日期：2026-11-06
状态：切片 A/B 已落地；切片 C 列表与 watch 已接线，剩 UI 逐 Tab 验收

## 1. 现状

/v0/webui/accounts 的响应由 Node 的 lib/server/webui-account-live.js（2185 行）拼装：
账号事实来自 state.accounts（Node 运行池），运行态来自 accountStateIndex，
额度来自 Go 的快照，模型数来自 Go 的 account_models，探针状态来自 Node 内存。
页面还有 SSE /v0/webui/accounts/watch 做增量更新。

Go 侧已有的对应事实：
- 账号与凭据：aih.db 的 accounts / account_credentials（/v1/management/accounts）
- 运行态：account_runtime_state / account_runtime_blocks
- 额度快照：account_usage_snapshots（/v1/management/accounts/:ref/quota-stats）
- 模型数：account_models

## 2. 为什么不能整体搬

webui-account-live.js 里有三类 Node 独有事实：

1. 探针状态（getLastUsageProbeState/Error）：Node 进程内存里的最近一次额度探测结果；
2. 凭据形态判定：家族 nativeAuth、zcode 桌面会话过期等，依赖 Node 的凭据读取器；
3. watch 增量：SSE 由 Node 的事件源驱动。

这三类要么先在 Go 侧重建（探针结果落库、凭据事实进投影），要么保留 Node 覆盖层。

## 3. 三个切片

### A. Go 出「账号静态视图」（只读、可对账）
- 新接口 GET /v1/management/accounts/:ref/view：账号标识、Provider、启用、计划、
  运行态、额度剩余、模型数——全部来自 aih.db。
- Node 加影子对账（同 alias 的做法）：/v0/webui/accounts 返回后异步拉 Go 视图，
  逐字段比较并记 state.accountShadow。
- 验收：跑一天，state.accountShadow.equal 恒为 true。

### B. Node 把三处独有事实推给 Go
- 探针结果：Node 每次探测完写 PATCH /v1/management/accounts/:ref/probe（Go 落库）；
- 凭据形态：Node 在账号同步时一并推 auth_kind / native_auth_kind 投影；
- watch：Node 保留 SSE，事件里的账号行改为 Go 视图 + Node 覆盖层。

### C. 前门翻转
- /v0/webui/accounts 改为转发 Go 视图并叠加 Node 覆盖层，Node 只保留 state 供 CLI 使用；
- watch 事件载荷同步换形状；
- 验收：账号页 6 个 Tab 逐个真机对比，字段零差异。

**落地进展（2026-11-06）**：列表响应已接入 `assembleAccountListWithGo`
（`lib/server/account-row-live.js`），每次请求**同步**取一次 Go 账号视图再装配，
响应新增 `goAssembled` 标志。两个与原计划的偏离及理由：

1. **不返回 503，改为降级到 Node 行。** 原计划的 503 是针对「整行都由 Go 提供」的场景；
   现在装配只覆盖 6 个字段，Node 行本身完整，硬 503 会把 Go 的一次抖动放大成「账号页打不开」。
   取数失败/超时（1200ms）/未启用时原样返回 Node 行并置 `goAssembled=false`，失败后冷却 5s。
2. **不为列表加正向缓存。** 启停按钮已经同步写 Go（Phase 1），若读侧用 60s 影子缓存，
   点完「停用」会回弹。这里每次请求打一次本地管理接口（43 行），实测不影响首屏。
   影子对账仍拿**装配前**的 Node 行比较，否则 `assembledChanged` 永远为 0、守卫失效。

真机验证（2026-11-06 10:42 重启后）：43 行 `goAssembled=true`，`row_identical=true`、
`field_mismatch=0`，服务日志无 `[aih:account-shadow]` 告警（即装配未改动任何一行）。

**watch 与列表同口径（2026-11-06）**：`/v0/webui/accounts/watch` 的 SSE 与 WebSocket
首帧 snapshot 也走 `assembleAccountListWithGo`；增量 `account` 事件与 `refreshLiveAccountRecord`
的单账号响应走新增的 `assembleAccountRowWithGo`（按 Node ref 调 `GET /v1/management/accounts/{ref}`，
Go 侧负责 ref 翻译）。三点取舍：

1. **不缓存 Go 事实**：启停/凭据编辑后立刻可能发事件，用旧缓存装配会把新值覆盖回去（回弹）。
   单账号取数的失败冷却与列表共用（5s），Go 抖动时事件原样用 Node 行。
2. **先装配再开流**：若先开 SSE 再异步装配，期间的事件会先于 snapshot 到达、随后被旧
   snapshot 覆盖；WebSocket 同样在装配完成后才挂 watcher。
3. **token 用量事件不装配**：只改 `tokenUsage`（Node 独有字段），逐次打 Go 会把热路径变成
   N+1；hydration 在无人监听时也跳过装配（首轮会让每个账号都变一次）。

## 3.5 前门翻转的字段来源（2026-11-06 盘点，切片 B 收尾时补）

Go 的 `GET /v1/management/accounts` 已经能给出：`account_ref / provider_id / cli_account_id /
enabled / has_credential / auth_kind / auth_mode / has_profile / display_name / email /
subscription_kind / subscription_raw / model_summary / usage_snapshot / probe`。

Node 账号行（`/v0/webui/accounts`）目前 34 个字段，按来源分三类：

| 来源 | 字段 | 说明 |
| --- | --- | --- |
| Go 事实（直接取） | provider, accountRef, configured, authMode, updatedAt, usageSnapshot | `enabled` 仍需按 `status !== 'down'` 翻译一次（Vertex 占位账号除外） |
| Go 派生（翻译） | remainingPct（usage_snapshot 取最小）、status（runtime）、isDefault（provider defaults 接口） | 不新增 Go 字段，Node 侧做视图适配 |
| Node 覆盖层（暂不迁） | displayName, email, displayNames, planType, apiKeyMode, tokenUsage, upstreamErrorRules, upstreamErrorGroupIds, isMobile, baseUrl, customUpstream, authPending*, windowActivationSupported, aliasPoolParticipates, activityActions, gatewayTargetSupported, lastUsedAt, runtime*, quotaStatus, schedulableStatus | 见下方决策 |

**决策：展示用身份不进 `account_profiles`。** Go 的 `account_profiles` 绑定的是
「Provider 派生身份」（`NewProfileSnapshot` 会用 `DeriveAccountRef` 反算 accountRef，
必须与账号 ref 一致），而 Node 的 `displayName` 是**标签**（例如 api-key 账号显示
`proxy.meadeo.com`），两者语义不同；把标签写进 picture 会让 ref 反算失败或写错行。
该表当前为空也不是 bug——这些 Provider 的 native decoder 不产出 profile。

因此切片 C 的覆盖层保留 Node 的这 20 个字段，Go 只提供事实。

**已落地（2026-11-06）**：字段来源写成数据表 `lib/server/account-row-sources.js`
（39 项，39 = Go 判定 6 + Go 投影 Node 直读 4 + Node 独有 29），装配器
`assembleAccountRow` 只用 Go 有值且语义等价的字段覆盖，其余原样保留；
对拍器 `scripts/compare-account-rows.js` 在真机上跑出 **43 行 × 39 字段零差异**
（`row_identical=true field_mismatch=0`，退出码 0）。回退项固定为
`displayName / planType / email`（Go 的 profiles 为空），两条已禁用 agy 账号的
Node 快照停在 10-24（Go 无快照），按告警列出、不阻断。

装配器已在运行时影子对账里当守卫用（`assembledChanged` 必须为 0），但**还没有**
接到 `/v0/webui/accounts` 的响应路径：那一步需要同步拿 Go 事实，异步缓存会让
启停开关回弹，留到前门翻转时随开关一起做。

**切片 B 的真机边界（2026-11-06）**：探针推送只对「Node 亲自探测」的账号有内容，
而 Node 现在只探 `claude` / `codex`（其余 13 个 Provider 的额度都已 Go 接管，
见 `lib/providers/quota-ownership.js`）。本机这两个 Provider 的 3 个账号全部是
`api_key`，`refresh-usage` 与探针调度器都会跳过（`apiKeyMode` 门禁），
所以**本机无法触发真实探针**来验证推送。已验证的替代路径：Go 侧 PATCH 落库 + 列表回读、
以及 `test/go-account-sync-probe-http.test.js` 用真实管理客户端打本地 HTTP 的传输层验收。

## 4. 风险

| 风险 | 对策 |
| --- | --- |
| Go 缺 Node-only Provider（gemini）的账号 | A 阶段对账会直接暴露；先在 Go 补账号导入 |
| 探针状态在内存里，重启即丢 | B 阶段落库；过渡期接受「重启后探针未知」 |
| SSE 增量与全量形状不一致 | 先冻结行结构，再改两端 |
| 账号数 35 vs 43 的口径差异 | 以「可调度账号」为准，写进契约文档 |
