# AGY：Node → Go 对齐矩阵

- 切片：10（只读盘点，不改代码）
- 快照时间：2026-11-12 10:20（本机时区）
- 范围：agy 的凭据刷新、额度采集与展示、暖机会话池、认证元数据/恢复、原生投影、settings 自愈、账号级出口
- 读法：每节先给逐条对照表，再列「缺口与建议归属」。行号以快照时的文件为准；文件继续变动后需重新 `grep -n` 校准。
- 状态口径：
  - **已对齐**：实现存在，且已接入生产链路；
  - **已对齐·未接线**：实现与测试已存在，但当前没有调用方（只在包内/测试中被引用）；
  - **故意不同**：Go 侧有意采用不同边界或语义，备注给出理由；
  - **仍缺**：Go 侧没有对应行为。

## 0. 先决边界（读表前必看）

1. **会话运行时仍在 Node。** WebUI 浏览器路由、PTY 会话、桌面端启动、出口保存/探测仍由 Node 拥有；Go 承接的是管理面 HTTP、推理 relay、账号库、凭据刷新与额度采集。`internal/transport/http/webuichatapi/handler.go:27-31` 明确写着「浏览器路由仍由 Node 拥有」，Go 只挂管理前缀接收 Node 的轮次执行调用。因此暖机 LS 池、Desktop 出口重启这类「进程/窗口编排」不是迁移遗漏，而是当前服务边界。
2. **两套凭据真值。** Node 台账在 `app-state.db`，Go 账号库在 `aih.db`。刷新所有权按 Node 台账判定（`internal/host/aihserver/composition.go:631-649`）：台账里的账号由 Node 刷新，Go 只刷新 Go 独有账号。两边都会物化 `run/auth-projections/agy/<accountRef>`。
3. **本轮新增的 Go 包多数尚未接线。** `internal/adapters/agy/{authmeta,egress,settings,writerlifecycle}` 与 `internal/adapters/agy/usage` 的读回/视图函数都是「实现+测试已落地、调用方待接」，表中标 **已对齐·未接线**，接线点集中在文末。

## 1. `lib/server/agy-token-refresh.js` → `internal/adapters/accountauth/agyoauth`

| Node 能力 | Node 位置(行号) | Go 位置 | 状态 | 证据/备注 |
| --- | --- | --- | --- | --- |
| 前置校验：provider=agy、authType=oauth-personal | 253-272 | `refresh.go:177-188`；`composition.go:650-662` | 已对齐 | Go 用领域类型 `*agy.OAuthAuth` 代替 authType 字符串；agy 策略只在 Resolver 注册表内 |
| 内置 client 候选（新 secret + legacy secret） | 17-39, 93-122 | `client_credential.go:12-31`；`refresh.go:192-219` | 已对齐 | 顺序、client_id、两个 secret 与 Node 逐字一致；`addCredentialCandidate` 的去重对应 `refresh.go:209-219` |
| 账号自定义 client 优先（oauth 根与 oauth.token 两处） | 93-122 | `refresh.go:196-206`；`nativeaccount/decoder.go:127-128` | 已对齐 | Node 读 `oauth.client_id` / `oauth.token.client_id`；Go 在导入时归一到 `ClientID/ClientSecret` |
| options 注入候选（`options.clientId` / `clientCredentials`） | 93-122 | 无 | 故意不同 | Go 刷新链没有宿主 options；候选取自账号凭据与内置表 |
| form 请求、端点、超时 | 17, 32, 331-338 | `refresh.go:252-270` | 已对齐 | `grant_type=refresh_token`、form-urlencoded、Accept json；超时统一由调用方 ctx 控制 |
| 候选链：单个 client 网络失败继续下一个 | 361-380 | `refresh.go:270-278` | 已对齐 | 注释同源（2026-10-22 新 secret `invalid_client`、legacy 200 的真机结论） |
| 仅 `invalid_client` 换下一个 secret | 169-175, 391-400 | `refresh.go:290-302`、`233-236` | 已对齐 | `invalid_grant`、限流、5xx 立即终止 |
| 失败保留 upstream status 与机器码 | 383-392 | `refresh.go:285-302` | 已对齐 | Go 不落响应正文（避免泄密），`detail` 文本比 Node 短，但 code/status 都在 |
| OAuth 错误解析与已知 secret 脱敏 | 124-168 | `oauthutil.DecodeErrorCode` / `ClassifyRefreshError`（`refresh.go:285-302`） | 已对齐 | code 是固定枚举；响应正文不进入错误 |
| 到期判定（默认提前 5 分钟） | 177-191, 34 | `accountcredentials/resolver.go:19-20`、`431-442`；`refresh.go:98-106` | 已对齐 | `DefaultRefreshSkew = 5 * time.Minute` |
| 无 expiry 但有 refresh_token 时强制刷新 | 183-191 | 无（领域构造要求 `ExpiresAtMS > 0`，`sqliteaccount/credential_agy.go:57-73`） | 仍缺 | 只影响「只有 refresh_token」的旧凭据；这类账号当前在 Node 台账，由 Node 刷新（`composition.go:631-649`） |
| 并发合并（`_refreshPromise`） | 255-257, 476-477 | `accountcredentials/resolver.go:291-293` `executeRefreshFlight` | 已对齐 | 单飞由共享 Resolver 统一负责 |
| 最小尝试间隔 30s | 33, 301-317 | 无 | 仍缺 | 预刷新窗口内刷新失败后，Go 每次解析都会再试（`resolver.go:297-308`）；建议在 agy Provider 或 Resolver 增加按账号 `lastAttempt` |
| 成功写回：access/refresh/token_type/expiry/expires_at_ms/refreshed_at_ms/last_refresh | 200-251, 421-438 | `agy/projection/writer.go:131-155`、`68-112` | 已对齐 | `auth_method` 自愈在 Go 读侧（`nativeaccount/decoder.go:74-80`）；`expiry` 固定毫秒 ISO（`writer.go:171-173`） |
| `id_token` 邮箱作为新身份 | 56-66, 417-420 | `refresh.go:332-335`、`448` | 已对齐 | id_token 解析失败时回退旧邮箱 |
| 刷新后物化 `run/auth-projections/agy/<ref>` | 234-244 | `composition.go:669-684`；`projection/writer.go:68` | 已对齐 | 只写已存在的投影目录；不存在时留给 Node 启动时物化 |
| 宿主默认账号通知 `notifyDefaultAccountAuthUpdated` | 426-437 | 无 | 仍缺 | Node 用它刷新宿主 default-account 缓存；Go 刷新后宿主缓存可能滞后，建议在 `OnCredentialRefreshed` 增加通知端口 |
| `expires_in` 缺失时容忍 | 402-412 | `refresh.go:315-320` 拒绝 | 故意不同 | Google 正常总带 `expires_in`；Go 选择明确失败而不是保留旧过期时间 |
| access token 首尾空白容忍 | 41-46（trim） | `refresh.go:366-370`（不 trim） | 故意不同 | Go 领域要求 token 无首尾空白；上游异常值时 Node 可用、Go 报无效 |

**缺口与建议归属**
- 30s 节流（P1）：`internal/adapters/accountauth/agyoauth/refresh.go` 或 `application/accountcredentials/resolver.go`。归属：agy 刷新切片。
- 无 expiry 强刷（P2）：需先决定「只有 refresh_token」的账号由哪一侧建模；若 Go 要接，`agy.NewNativeOAuthAuth` 与 `credential_agy.go` 的严格校验需要放宽。归属：agy 凭据建模切片 + 刷新切片。
- 宿主通知（P2）：建议给 Resolver 增加 `OnCredentialRefreshed` 之外的 `NotifyHost` 端口，由 composition 注入。归属：宿主接线（主 agent 统一做）。

## 2. `lib/server/agy-usage-snapshot.js` → `internal/adapters/agy/usage`

依赖实现文件：`lib/server/code-assist-quota.js`（采集协议）。

| Node 能力 | Node 位置(行号) | Go 位置 | 状态 | 证据/备注 |
| --- | --- | --- | --- | --- |
| 可信快照判定（schemaVersion=2/kind/source/models） | 27-36 | `usage/document.go:95` `trusted` | 已对齐 | 字段与判据一致 |
| 可用模型列表（remainingPct > 0） | 38-44 | `usage/document.go:124`、`192` | 已对齐 | 返回模型 id，空值过滤 |
| apply 到账号的事实（capturedAt/models/available/project/min） | 46-58 | `usage/document.go:172` `BuildSnapshotFacts` | 已对齐·未接线 | Node 直接改 account 对象；Go 由调用方拿投影落库/建视图 |
| TTL 与超时（60s / 8s，带上下界） | 12-13, 60-78 | `usage/document.go:221`、`229` | 已对齐·未接线 | 5s–30min / 1s–30s 夹取一致 |
| stale 判定 | 80-85 | `usage/document.go:202` | 已对齐·未接线 | 不可信/缺 capturedAt/超 TTL 都算 stale |
| 单账号刷新 + 单飞（`refreshInFlight`） | 100-150 | `application/accountusage/service.go:333`、`refreshFlightGroup` `647` | 已对齐 | 由额度服务统一合并；Go 协调器负责触发 |
| 池级错峰刷新（活跃 1–2min、静默 10–20min、batch=2） | 152-200 | `application/accountusage/coordinator.go:464-474`；`host/aihserver/usage.go:22-23,153-163` | 故意不同 | Go 用统一协调器：5min 周期 + 30s 确定性错峰 + 每 Provider 1 并发；不再按每次推理触发。理由：统一调度避免请求风暴（Node 注释 176-178 的同一目标） |
| 失败后强制刷新（4 种 kind） | 202-215 | `usage/document.go:238`；`host/aihserver/quota_failure_refresh.go:65-99` | 仍缺 | 判定函数已存在但未接线；且 `observe` 只接受 `FailureQuotaExhausted`，agy 的 429 在 Go 分类为 `FailureRateLimited`（`agy/upstreamfailure/classifier.go:72-79`），不会触发 |
| 快照写盘 | 87-90 | `accountusage/service.go:440-452`（快照 + 展示文档同刻落库） | 已对齐 | 存储介质不同（Node 文件 / Go DB），效果一致 |
| 按账号出口采集额度 | 115-127 | 无（`usage_providers.go:95-101` 用服务级 HTTP client） | 仍缺 | Node 每次采集都解析 `account:egress:<ref>`；Go 的 agy 额度请求始终走进程默认网络策略 |
| 账号级 project/tier 缓存 | 171-175（`code-assist-quota.js`） | `usage/strategy.go:199`（每次重读） | 故意不同 | Go Strategy 无账号状态，多一次 `loadCodeAssist`；load 失败时 Node 用缓存，Go 丢 project 后仍尝试空 body |
| 端点顺序回退（sandbox → daily → 正式，404/429/5xx） | `code-assist-quota.js:17-21,102-105,321-363` | `usage/strategy.go:44-53,295-347` | 已对齐 | `shouldFallbackEndpoint` 判据一致 |
| 200 但解析不出模型时继续下一个 body | `code-assist-quota.js:332-357` | `usage/strategy.go:295-320`（直接返回首个 200） | 仍缺 | 边角：首个 body 返回空 models 时不会尝试 `{}` |
| 窗口推断（>6h 视为周窗口） | `lib/account/quota-reset/agy-strategy.js` | `usage/strategy.go:415` | 已对齐 | 5h / 7d 两档 |
| 套餐归一 + 展示 `planType` | `agy-account-usage-view.js:14-24`；`code-assist-quota.js:300` | `usage/strategy.go:426`、`641` | 已对齐 | 快照侧未知档位留空，文档侧回落 `oauth`，与 Node 两处差异一致 |
| 模型 id 过滤 | `lib/server/model-id.js:21-27` | `usage/strategy.go:498-547`（`validQuotaModelID`） | 已对齐 | 排除 `*`、内部枚举、`models/`、placeholder 等占位 id |

**缺口与建议归属**
- 失败后刷新接线（P1）：`quota_failure_refresh.observe` 需要识别 agy 的 `rate_limited`（或调用 `usage.ShouldRefreshAfterFailure`）。归属：额度切片 + 运行态切片。
- 按账号出口采集（P1）：`usage.Strategy` 需要账号级传输注入（类似 `agyoauth.NewWithEgress`），由 `usage_providers` 的装配上下文提供。归属：额度切片 + egress 接线。
- 空 models 继续下一个 body（P2）：`usage/strategy.go:fetchModels` 需要把「解析为空」当成候选失败继续。归属：额度切片。
- 账号级 project/tier 缓存（P2）：等 Go 有账号快照存储后再补；当前接受多一次请求。归属：额度切片。

## 3. `lib/server/agy-account-usage-view.js` → `internal/adapters/agy/usage/view.go`

| Node 能力 | Node 位置(行号) | Go 位置 | 状态 | 证据/备注 |
| --- | --- | --- | --- | --- |
| `normalizeAgyPlanType`（tier 关键字 → ultra/pro/free，fallback 规则） | 14-24 | `usage/view.go:83` | 已对齐·未接线 | fallback 的 starter/default→free 也保留 |
| `isFreeAgyPlan` | 26-28 | `usage/view.go:109` | 已对齐·未接线 | trim + lowercase |
| `isAgyUsageSnapshot`（只认 kind+models 数组） | 30-37 | `usage/view.go:115` | 已对齐·未接线 | 比 `trusted()` 宽松，与 Node 两处判据差异一致 |
| `hasQuotaExhaustionSignal`（4 组文本） | 44-55 | `usage/view.go:244` | 已对齐·未接线 | 文本拼装/小写/换行规则一致 |
| `buildActiveModelCooldowns`（含 legacy 迁移、删到期） | 57-66 | `usage/view.go:258` | 已对齐·未接线 | 刻意差异：Go 归一与过滤用同一个 `nowMS`，重放稳定 |
| `cloneAgySnapshotWithPlan` / `markAllModelsExhausted` | 68-89 | `usage/view.go:171` | 已对齐·未接线 | 保留未知字段 |
| `buildAgyEffectiveUsageView` | 91-124 | `usage/view.go:127` | 已对齐·未接线 | 免费档 + 有活跃 cooldown → 全模型归零、remainingPct=0 |
| WebUI 账号页消费（account-view-hints / management / provider-usage） | `lib/server/account-view-hints.js:43`、`lib/server/management.js:277`、`lib/usage/provider-usage/agy.js:11` | `webuiaccountsapi/row.go:214`、`246-258`（只按 subscription 派生 planType） | 仍缺 | Go 账号页没有免费档归零与 effective view；若账号页已由 Go 全量服务，需要接 `BuildEffectiveUsageView` |

**缺口与建议归属**
- WebUI 账号页接线（P1）：`internal/transport/http/webuiaccountsapi` 的 agy 行构造应调用 `usage.BuildEffectiveUsageView`，把 `planType/usageSnapshot/remainingPct/freeQuotaExhausted` 一起下发。归属：WebUI 账号页切片。
- 其他消费方（management/provider-usage）仍 Node：在 Node 路由退役前不需要 Go 重复实现。

## 4. `lib/server/agy-warm-ls-pool.js` → 当前无 Go 对应

| Node 能力 | Node 位置(行号) | Go 位置 | 状态 | 证据/备注 |
| --- | --- | --- | --- | --- |
| 池常量（空闲 10min、上限 4、发送 20s、回复 180s） | 26-32 | 无 | 故意不同 | 会话 PTY 仍由 Node 拥有；Go 没有暖机 LS 的宿主进程 |
| 进程存活/端口发现（lsof / netstat） | 47-98 | 无 | 故意不同 | 同上；端口发现属于进程内状态 |
| 空闲/超限驱逐、显式 evict | 107-127, 191-211, 296-311 | 无 | 故意不同 | 池条目只存在于 Node 进程内存，无法被 Go 枚举 |
| adopt 刚跑完的 agy 进程 | 215-277 | 无 | 故意不同 | 依赖 Node 的 PTY child 对象 |
| writer 租约包装 | 140-164 | `agy/writerlifecycle/coordinator.go` | 已对齐·未接线 | 状态机已移植，见第 5 节；池本身未迁 |
| 模型粘滞判定（send-message 不能换模型） | 313-324 | 无 | 故意不同 | 属于暖机快路径语义 |
| send-message + transcript 轮询 | 327-419 | 无 | 故意不同 | Go 的 WebUI 轮次是 HTTP 推理（`webuichatapi`），不驱动 CLI 会话 |
| shutdownAll / stats | 421-438 | 无 | 故意不同 | 进程内管理面 |
| 删除账号前驱逐暖机 writer | `lib/server/node-only-deletion-hooks.js:22-32`；`webui-account-routes-delete.js` | 无 | 故意不同 | Node-only 删除钩子已把「池状态只存在 Node 内存」登记为双侧合同；Go 侧 `deletionprojection` 只记录原因 |

**缺口与建议归属**
- 如果后续 Go 接管 PTY 会话/终端（`internal/runtime/providercli/sessionchat` 目前无调用方），暖机池必须与 writer 生命周期一起迁，否则 agy 每轮冷启动 ~100s 的体验会回退。归属：会话运行时切片（未来）。
- 当前结论：**不属于本轮迁移缺口**，但要在会话切换时把这条列为阻塞项。

## 5. `lib/server/agy-writer-lifecycle.js` → `internal/adapters/agy/writerlifecycle`

| Node 能力 | Node 位置(行号) | Go 位置 | 状态 | 证据/备注 |
| --- | --- | --- | --- | --- |
| accountRef 归一（trim） | 3-5 | `coordinator.go:443`、`168-178` | 已对齐·未接线 | 空引用返回 `ErrAccountRefRequired`（Node 抛同 code） |
| generation 预留（pending） | 59-77 | `coordinator.go:168` | 已对齐·未接线 | 单调递增，租约身份用指针 |
| activate 绑定 live writer | 79-85 | `coordinator.go:183` | 已对齐·未接线 | 重复 activate 覆盖 writer |
| release 的 finalWriter / coordinatedGeneration | 87-101 | `coordinator.go:200-236` | 已对齐·未接线 | 同一账号最终释放只报告一次 |
| hasWriter / isQuiescing 分离 | 103-116 | `coordinator.go:238`、`257` | 已对齐·未接线 | kill 已发出但 PID 尚存时仍算有 writer |
| canReconcileBeforeSpawn | 118-132 | `coordinator.go:269` | 已对齐·未接线 | 有更新 pending 或存活 live 时禁止对账 |
| quiesce：kill → 轮询等退出 → 清状态 | 134-169 | `coordinator.go:312-385` | 已对齐·未接线 | kill 失败保持 quiescing；panic 被吞 |
| 池内使用（reserve/activate/release/quiesce） | `agy-warm-ls-pool.js:140-190` | 无调用方 | 仍缺 | 需要等 Go 暖机池落地才有接线对象 |

**缺口与建议归属**
- 仅接线缺口：等会话/暖机池迁 Go 时，用 `writerlifecycle.New` 包住 writer 的 kill/存活探测即可。归属：会话运行时切片。

## 6. `lib/account/agy-auth-metadata.js` → `internal/adapters/agy/authmeta`

| Node 能力 | Node 位置(行号) | Go 位置 | 状态 | 证据/备注 |
| --- | --- | --- | --- | --- |
| `AGY_CLI_AUTH_METHOD = consumer` | 3-9 | `core/accounts/agy/auth.go:29-31`；`authmeta/metadata.go:37` | 已对齐 | 领域枚举与字符串导出同名同值 |
| Gemini OAuth scope（4 项、含顺序） | 10-15 | `authmeta/metadata.go:42-44`；`projection/writer.go:47-50` | 已对齐 | 登录 flow 也用同一组 scope |
| `readAgyOAuthTokenFields`（snake/camel、direct-token 两形态） | 24-37 | `authmeta/metadata.go:283-296` | 已对齐·未接线 | 明确保留两套读法 |
| `buildAgyGeminiOAuthCredentials` | 42-53 | `authmeta/metadata.go:185`；`projection/writer.go:160` | 已对齐 | 包含 `id_token`（authmeta 版）；writer 版缺 id_token（见第 8 节） |
| `buildAgyGoogleAccounts`（active/old=[]） | 55-59 | `authmeta/metadata.go:203`；`projection/writer.go:104-107` | 已对齐 | 空邮箱返回 false/不写 |
| `buildAgyOAuthTokenSnapshot`（只读 token 内层 snake_case） | 61-80 | `authmeta/metadata.go:246-270` | 已对齐·未接线 | 与兼容投影的宽松读法刻意分开 |
| `isAgyAccessTokenFresh` | 82-90 | `authmeta/metadata.go:216` | 已对齐·未接线 | 数字时间戳不接受，等价 Node `Date.parse` 行为 |
| `hasRecoverableAgyOAuthCredentials` | 92-100 | `authmeta/metadata.go:228` | 已对齐·未接线 | access 新鲜或仍有 refresh token |
| `readAgyEnvToken`（AGY_ACCESS_TOKEN 优先，空白短路） | 102-108 | `authmeta/metadata.go:165-178` | 已对齐·未接线 | 保留 JS `||` 的短路细节 |
| `readAgyAuthMetadata`（OAuth → env → 未配置） | 110-150 | `authmeta/metadata.go:114-157` | 已对齐·未接线 | accountName 占位文案一致 |
| 消费方：账号视图/调度判断 | `lib/server/account-view-hints.js`、`lib/server/accounts.js` | 无调用方 | 仍缺 | Go 账号页/调度目前直接看凭据快照，没有这套 authMetadata 投影 |

**缺口与建议归属**
- 接线（P2）：`authmeta.ReadMetadata` 接到账号视图/调度读模型；如果 WebUI 账号页继续由 Node 提供，可暂不接。归属：WebUI 账号页切片。

## 7. `lib/account/agy-auth-recovery.js` → `internal/adapters/agy/authmeta/recovery.go` + `core/accounts`

| Node 能力 | Node 位置(行号) | Go 位置 | 状态 | 证据/备注 |
| --- | --- | --- | --- | --- |
| 恢复证据常量 `agy_oauth_credentials_recoverable` | 6 | `authmeta/recovery.go:28`；`core/accounts/status_transition.go:85` | 已对齐 | 字符串两端一致，可直接对拍日志 |
| 不可恢复原因集合 `agy_not_signed_in` | 7-9 | `authmeta/recovery.go:32`；`status_transition.go:64` | 已对齐 | 唯一成员 |
| `normalizeRuntimeReason`（reason→detail→lastFailureReason→lastError） | 15-25 | `authmeta/recovery.go:73-85` | 已对齐·未接线 | 保留「空白串也是真值」的 JS 细节 |
| 不可恢复判定 | 27-33 | `authmeta/recovery.go:93`；`status_transition.go:499-503` | 已对齐 | agy + auth_invalid + 原因匹配 |
| 可恢复判定（无原因 + 本地凭据可恢复） | 35-45 | `authmeta/recovery.go:103-113` | 已对齐·未接线 | 有原因的失败不会被静态凭据洗白 |
| 对外呈现 healthy（until=0/reason 空） | 47-56 | `authmeta/recovery.go:117-127` | 已对齐·未接线 | 返回零值状态 |
| 清除运行态阻塞（gate / service 两条路） | 58-87 | `status_transition.go:492-497` `canClearStatusRuntime` + 事件表 `902-906` | 已对齐·未接线 | Go 采用事件化：发 `StatusEventAgyOAuthCredentialsRecoverable` / `StatusEventAgyUsageProbeVerified`；当前仓库内没有发射方 |
| 不可恢复块的清除证据闸门 | 39-44 | `status_transition.go:488-497`、`902-906` | 已对齐 | 只认 login_success / manual_admin_clear / agy_usage_probe_verified |

**缺口与建议归属**
- 接线（P1）：在账号读取/调度前调用 `authmeta.ResolveRuntimeStatus`（等价 Node `accounts.js:1453`、CLI `account-runtime.js:209`），或在状态服务里补「旧空块修复」的事件发射。归属：账号状态切片。

## 8. `lib/account/native-auth-projection.js` → `internal/adapters/agy/projection` + `internal/runtime/storagepolicy`

| Node 能力 | Node 位置(行号) | Go 位置 | 状态 | 证据/备注 |
| --- | --- | --- | --- | --- |
| `PROVIDER_ARTIFACTS` 来自 storage policy | 47-49 | `runtime/storagepolicy/policy.go:128-137` | 已对齐 | agy 五份 artifact 的 field/path/format/optional 一致 |
| agy artifact 声明（oauthToken 必选；desktop/email/oauthCreds/googleAccounts 派生） | `lib/runtime/provider-storage-policy.js:252-282` | `storagepolicy/policy.go:128-137` | 已对齐 | 路径顺序一致 |
| `resolveProjectionSource` 的 agy 分支（desktop=oauthToken、派生 gemini 文件） | 197-210 | `projection/writer.go:131-168`；`authmeta/metadata.go:185/203` | 已对齐 | writer 直接从领域凭据构造，等价于派生 |
| `mergeProviderAuthProjection` 的 agy 分支（只覆盖 oauthToken/email） | 236-246 | 无（Go 账号库是结构化列，不是整份 JSON merge） | 故意不同 | 刷新路径整体构造领域凭据；不存在 Node 式「整份 nativeAuth 合并」 |
| `materializeProviderAuth`（五份文件、缺失即删除） | 338-458 | `projection/writer.go:68-112` | 已对齐（主路径）/ 仍缺（删除语义） | Go 只写不删；agy 领域凭据始终含 token，删除分支实际不可达，但「账号被清空后自愈」行为没有对应 |
| liveStore 代际判定（磁盘更新则保留） | 318-336, 420-435 | 无 | 故意不同 | agy artifact 在 Node policy 里没有 `liveStore` 声明；Go 只服务 agy，不需要通用分支 |
| 原子写 + 0600 | 140-179 | `projection/writer.go:230-260` | 已对齐 | 临时文件 + rename；目录 0700 |
| 未知键保留 | 338-458（整份快照来自 capture） | `projection/writer.go:175-215`（merge 而不是替换） | 已对齐（已知字段一致）/ 故意不同（未知键策略） | Go 用叠加保留 CLI 自写键；Node 靠「捕获整份文档」幸存，效果相同 |
| `oauth_creds.json` 的 `id_token` | 42-53 | `projection/writer.go:160-168` 不写 id_token | 仍缺 | 领域凭据不保存 id_token；已有文件靠 merge 保留，新建投影会缺该字段（scope/access 仍在，桌面端通常可用） |
| `captureProviderAuth`（CLI 落盘 → 账号库） | 460-498 | 无 | 故意不同 | 宿主扫描/登录捕获仍归 Node；Go 只在登录/导入时解码 native auth（`nativeaccount/decoder.go:83`） |
| `findExistingAccountByNativeAuthIdentity` | 500-520 | 无 | 故意不同 | 同上，属于 Node 的「观察注册」路径 |
| `registerProviderAuthProjection`（去重、墓碑、realm 换 Provider） | 522-674 | 无 | 故意不同 | 宿主登录注册仍 Node；Go 登录走 accountauth 作业 |
| Go-only 账号回读（`readGoNativeAuth`） | 113-119, 349-352 | Go 自己就是账号库 | 故意不同 | 方向相反：Node 读 Go 库补投影，Go 不需要 |

**缺口与建议归属**
- `id_token` 透传（P2）：给 `agy.OAuthAuth` 增加可选 `IDToken`（或让 writer 从投影读取），归属：agy 凭据建模切片。
- 投影删除/自愈（P2）：如果 Go 接管账号清理/导入，需要在 `projection` 补「artifact 不可用则删除」的语义；当前只服务刷新，低优先级。归属：投影切片。

## 9. `lib/runtime/agy-settings-heal.js` → `internal/adapters/agy/settings`

| Node 能力 | Node 位置(行号) | Go 位置 | 状态 | 证据/备注 |
| --- | --- | --- | --- | --- |
| 路径常量 `.gemini/antigravity-cli/settings.json` | 15 | `settings/heal.go:48`；`modelnames.go` | 已对齐·未接线 | 同名常量 |
| 读文件失败/非对象 → skipped | 17-23, 38-39 | `settings/heal.go:93-100` | 已对齐·未接线 | Go 额外把「顶层数组」按不可读跳过（Node 会覆盖成对象），理由见 83-87 |
| 当前 model 已合法 → ok，不写 | 40-41 | `settings/heal.go:101-104` | 已对齐·未接线 | 合法 id 或显示名都算 |
| preferred / 首个合法显示名回落 | 42-43 | `settings/heal.go:105-111`；`modelnames.go:54/72/78` | 已对齐·未接线 | 默认取显示名列表第一项 |
| 首次备份 `*.aih-model-heal.bak` | 45-46 | `settings/heal.go:114-126` | 已对齐·未接线 | 已存在不覆盖；权限随原文件 |
| 只改 model、2 空格、结尾换行 | 47 | `settings/heal.go:127-137`、`259-307` | 已对齐·未接线 | Go 还保留键顺序与非 model 值原文（注释 83-87 的刻意差异） |
| 写失败 → failed，不拦启动 | 48-50 | `settings/heal.go:130-138` | 已对齐·未接线 | 调用方按 best effort |
| 启动准备阶段调用 | `lib/server/native-session-launch-preparation.js:22,35` | 无调用方 | 仍缺 | Go 尚未接管会话启动；若接管，需在 `BuildStartCommand` 前调用 |

**缺口与建议归属**
- 接线（P2）：会话启动迁 Go 时，在 `internal/runtime/providercli/sessionchat` 的启动准备阶段调用 `settings.HealModel(settings.ProjectionSettingsPath(runtimeDir), preferred)`。归属：会话运行时切片。

## 10. `lib/server/zcode-egress-service.js` → `internal/adapters/agy/egress` + `host/aihserver`

| Node 能力 | Node 位置(行号) | Go 位置 | 状态 | 证据/备注 |
| --- | --- | --- | --- | --- |
| 绑定读取/形状归一（url/system/tun/pool/direct、retired、pool scope） | `lib/account/zcode-egress-binding-store.js`；132-138 | `agy/egress/binding.go:109-184` | 已对齐·未接线 | 记录损坏 fail-closed，不当作未绑定 |
| 出口目标解析 `resolveEgressTarget` | `lib/server/zcode-egress-resolver.js`；146-215 | `agy/egress/resolver.go:93-247` | 已对齐·未接线 | 五模式；失败返回 `*Error` |
| 系统代理探测（scutil / networksetup） | 文本同源 `macos.js` | `agy/egress/detect.go:71-210` | 已对齐·未接线 | 未启用时按网络服务顺序回退 |
| 外部 TUN 探测（ifconfig/netstat/ps） | 同上 | `agy/egress/detect.go:222-267` | 已对齐·未接线 | 生效时客户端直连 |
| 出口池运行文件（state.json、账号车道、PID 存活） | `lib/runtime/egress-pool-state-file.js` | `agy/egress/pool.go:45-133` | 已对齐·未接线 | 按 accountRef 查车道；无内核时 fail-closed |
| 代理 URL 归一/scheme 白名单 | 319-329 | `agy/egress/proxyurl.go:28-100` | 已对齐·未接线 | http/https/socks5/socks5h |
| 请求选项注入（proxyUrl / noProxy='*' 或 localhost 列表） | 315-335 | `agyoauth/refresh.go:34-37,127-174` | 仍缺 | agyoauth 仍用自带的简化 Egress（只认 direct/proxy/default）；没有 noProxy，也没有 system/tun/pool |
| 解析时连通性探测 / 池节点轮换 | 177-213 | 无 | 故意不同 | Go 只在 OAuth 刷新（小时级）解析，不在热路径探测；池轮换需要池内核，仍归 Node |
| 保存出口后应用（Desktop 重启收敛） | 471-511 | 无 | 故意不同 | Desktop 生命周期归 Node |
| 运行态查询（binding/resolved/desktopPid） | 537-583 | 无 | 故意不同 | WebUI 展示仍由 Node 路由提供 |
| 启动 Desktop 时套用出口（preflight/egress/竞态提示） | 585-671 | 无 | 故意不同 | 启动归 Node |
| 错误码/文案表 | 673-702 | `agy/egress/egress.go:38-58`（仅 code） | 已对齐（code）/ 仍缺（文案） | Go 返回同一组 code，中文文案仍由宿主映射 |
| re-key 时搬出口绑定 | Node 端 `account-egress-rekey` 逻辑 | `host/aihserver/account_egress_rekey.go:16-45` | 已对齐 | 键 `account:egress:<ref>` 整值搬家；键不存在视为未绑定 |

**缺口与建议归属**
- 接线（P0）：`composition.go:527-561` 的 agy 出口解析仍读自建 struct（只取 mode/proxyUrl），应改为 `agy/egress.NewResolver(...).Resolve`，让 `agyoauth` 支持 system/tun/pool 与 noProxy。归属：egress 接线（主 agent 统一做；涉及 `internal/host/aihserver/composition.go`）。
- 额度采集同样需要账号级出口（见第 2 节）。归属：额度切片。
- Desktop 启动/探测/重启/运行态：**当前边界不迁**；若 WebUI 的「打开客户端」迁 Go，需要整段移植并保留 fail-closed 语义。

## 11. 缺口汇总（按优先级）

| 优先级 | 缺口 | 影响 | 建议归属 |
| --- | --- | --- | --- |
| P0 | agy 刷新/额度没有接 `agy/egress` 的完整解析（system/tun/pool + noProxy） | 绑定这类出口的账号刷新/采集会走错网络或直接失败 | 主 agent 接线 + egress 切片 |
| P1 | 失败后额度刷新未接线，且 agy 429 分类为 rate_limited 不触发 | 额度耗尽后快照不能立即纠正，选号可能继续撞墙 | 额度切片 + 运行态切片 |
| P1 | 30s 最小刷新间隔缺失 | 刷新失败且 token 未过期时，每个请求都会重试上游 | agy 刷新切片 |
| P1 | WebUI 账号页没有 `BuildEffectiveUsageView` | 免费档模型 cooldown 时页面仍显示非零余额 | WebUI 账号页切片 |
| P1 | agy 恢复判定没有调用方（reason-less 旧块不会自愈） | 旧 `auth_invalid` 空块可能一直挂着 | 账号状态切片 |
| P2 | 无 expiry 的 refresh-only 凭据 Go 无法建模 | 旧账号只能永远由 Node 刷新 | agy 凭据建模切片 |
| P2 | 账号级 project/tier 缓存缺失 | 每次采集多一次 loadCodeAssist；load 失败丢 project | 额度切片 |
| P2 | 200 空 models 不尝试下一个 body | 极端上游形状下采集失败 | 额度切片 |
| P2 | `oauth_creds.json` 新建投影缺 id_token | 桌面端兼容文件不完整 | 投影切片 |
| P2 | 宿主 default-account 通知缺失 | Node 侧缓存可能滞后 | 宿主接线 |
| P3 | 暖机 LS 池未迁 Go | 当前无影响（会话仍 Node）；未来迁 PTY 时必须一起迁 | 会话运行时切片（未来） |

## 12. 接线点清单（文件 + 位置）

1. `internal/host/aihserver/composition.go:527-561`
   - 用 `internal/adapters/agy/egress` 的 `Resolver` 替换现有 `appstate.ReadKV` + 手写 `mode/proxyUrl` 解析；`agyoauth.Egress` 增加 `Target/Direct/NoProxy` 字段。
2. `internal/host/aihserver/composition.go:669-684`（已接）
   - `OnCredentialRefreshed` 已调用 `agyprojection.Write`；如需宿主通知，在这里加端口。
3. `internal/host/aihserver/quota_failure_refresh.go:65-99`
   - `observe` 增加 agy 的 `rate_limited` / `model_capacity_unavailable` / `region/location unsupported` 判定（可直接调用 `agyusage.ShouldRefreshAfterFailure`）。
4. `internal/host/aihserver/usage_providers.go:95-101`
   - `buildAgyUsage` 需要账号级传输/出口注入；`usageProviderContext` 目前只有服务级 client。
5. `internal/transport/http/webuiaccountsapi/row.go`（agy 行构造，约 186-258）
   - agy 行调用 `agyusage.BuildEffectiveUsageView`，下发 `planType/usageSnapshot/remainingPct/freeQuotaExhausted/activeModelCooldowns`。
6. `internal/host/aihserver/account_outcomes.go:132`（调用方）
   - 已把 `failure.RuntimeKind()` 传给 `quotaRefresh.observe`；修 3 即可让 agy 429 触发刷新。
7. `internal/runtime/providercli/sessionchat/command.go:270`（`BuildStartCommand`）与 `473`（`BuildResumeCommand`）
   - 若 Go 接管会话启动：先调用 `settings.HealModel(settings.ProjectionSettingsPath(runtimeDir), preferredModel)`；再按 `writerlifecycle.New` 管理暖机 writer。
8. 账号状态读取路径（`application/accounts` / `webuiaccountsapi`）
   - 调用 `authmeta.ResolveRuntimeStatus` 或发射 `StatusEventAgyOAuthCredentialsRecoverable`，替代 Node `clearRecoverableAgyAuthInvalidBlock`。
9. `internal/adapters/accountauth/agyoauth/refresh.go`
   - 增加按账号的 30s 最小尝试间隔（可用 `sync.Map[AccountRef]time.Time` 或 Resolver 的扩展端口）。

## 13. 本轮快照的已知变动

- 快照时 `internal/adapters/agy/writerlifecycle`、`settings`、`authmeta`、`egress`、`usage/{document,view}.go` 均为新增且未接线。
- `internal/adapters/agy/projection/settings.go` 在盘点过程中出现又被删除（与 `settings/heal.go` 重复），最终以 `settings/heal.go` 为准；如果后续两处同时存在，先合并再接线。
- 所有 `已对齐·未接线` 项在接线前不应被当作「已生效」；验收时以调用方 + 端到端行为为准。
