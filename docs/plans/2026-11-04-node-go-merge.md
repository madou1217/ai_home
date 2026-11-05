# Node → Go 合并与单库方案

> 状态：方案（部分实施）
> 日期：2026-11-04
> 目标：一个后端（Go）、一个数据库（`aih.db`）、一个账号身份（`account_ref`）。
> 原则：先切账号单库（Go 存储、Node 采集），再合数据，最后搬控制面/运行时；任何阶段都不允许 Node 与 Go 同时写账号表。
>
> 已落地切片（2026-11-04）：
> 1. codex/claude 静态凭据编辑写入口切到 Go；Node 补丁表中的 codex/claude 分支删除；
>    Node 适配层 `go-static-credential-rotation.js` 随后也被删除——空密钥/未带地址的
>    语义改由 Go 的 `StaticCredentialEdit` 解释。
> 2. Go 静态身份指纹改为 Node 的 16 位公式；Node 预测器与 contract vectors 同步；
>    3 个现有静态账号（codex 1、claude 2）重键到 Node `account_ref`，模型/默认引用一并迁移。
>    新账号两端派生出的 `accountRef` 已相同。
> 3. 真机验证：codex/claude 改 URL 立即由 Go 落库、Node/Go ref 相同且不变；
>    claude api-key→auth-token 切换后 Go `auth_kind=auth_token`、Node 投影同步；
>    均未新增账号。重键前备份在 `~/.ai_home/backups/rekey-2026-11-04T12-18-13-351Z/`。
> 4. Go 删除墓碑：`aih.db` v10 新增 `account_tombstones`；`DeleteAccount` 在同一事务里写
>    `account:<ref>` 与 `api_key:<provider>:<sha256(provider NUL secret)>` 两条墓碑，再级联删除。
>    真机用 Go 管理 API 建/删临时账号，两条墓碑均落库、账号行已删。
> 5. 删除路由：codex/claude 的 `DELETE /v0/webui/accounts/...` 先调 Go DELETE（持久行 +
>    墓碑），Node 再清理 runtime 投影、宿主授权和本地读模型。真机：临时 codex 账号删除后
>    Go 行=0、Go 墓碑=2、Node 行=0、Node 墓碑=2，返回 200。Node 的本地删除/墓碑写入仍作为
>    host-scan 投影保留，等宿主扫描迁 Go 后再删。
> 6. 启停：codex/claude 的 `POST /status` 先调 Go PATCH `enabled`，Node 的 `account_state`
>    只做状态投影。真机 down→Go enabled=0/Node down，up→Go enabled=1/Node up。
> 7. 默认账号：codex/claude 的 set/clear-default 先写 Go `account_defaults`，Node 的
>    app_kv/宿主配置只做投影。真机：Go 默认关系 set→有行、clear→0；Node clear-default 返回 200。
> 8. 导出：Go 新增 `aih-accounts` v1 导出格式（`GET /v1/management/accounts/{ref}/export/aih-accounts`），
>    先覆盖 codex/claude 静态凭据（env + 账号/状态/CLI 别名）。真机导出 codex 返回 200，
>    `kind=aih-accounts`、`env` 键完整。Node 的集合导出仍走自己的路径，下一步切换并删除。
> 9. 覆盖补齐：Go 的 native credential codec 注册表加入 `cline`，两个 cline 账号已进 Go；
>    opencode 的旧拒绝是缓存脏数据，清除后已同步（`opencode` 2/2，新增回归测试）。
>    当前 Node 43 / Go 42；只剩 gemini Vertex 占位 1 个（指向本机网关的导出-only 账号）。
> 10. Go 集合导出：`GET /v1/management/accounts/export/aih-accounts` 已上线，支持 provider/ref 过滤，
>    真机导出 **42/42 Go 账号**（3 个 env + 39 个 native），0 skipped。
> 11. WebUI 集合导出已切 Go：`GET /v0/webui/accounts/export` 走 Go 集合导出；
>    Node 的 `webui-account-routes-export.js` 已删除，`native-account-transfer` 测试改为直接测文档构建。
>    真机：42 个账号、provider 过滤 1、legacy format 400、未知 ref 404；
>    `X-AIH-Node-Only-Accounts: 1` 明确标出唯一未迁的 gemini Vertex 占位。
> 12. Go 批量导入：`POST /v1/management/account-imports/aih-accounts` 已上线，支持
>    codex/claude 静态 env 与 nativeAuth envelope；真机 round-trip（Go 建号→导出→删除→导入）
>    成功，导入结果 `created:1`、`accountRef` 与导出相同。
> 13. WebUI 导入 job 已切 Go：`executeAccountImportPayload` 不再调 `importNativeAccounts`，
>    改为逐文档调 Go 批量导入 + `reconcileAccounts`；Node 只保留上传解析/任务外壳/进度。
>    真机：WebUI 导入临时 codex 账号，job=`succeeded`、`created:1`，Node/Go 均出现同一账号。
> 14. Gemini Vertex 占位已进 Go：新增 `core/accounts/gemini.VertexAuth`（身份
>    `vertex_ai:gemini:<project>:<location>:<h16(secret)>`）与 gemini codec；同步强制
>    `enabled=false`，只展示/导出、不进路由池。真机 Node 43 / Go 43、ref 相同；
>    WebUI 导出 43 个账号、`Node-Only=0`；该账号导出后再导入为 `unchanged`。
> 15. Gemini Vertex 也可原地编辑：`credential/edit` 支持 `*gemini.VertexAuth`，保留
>    project/location/placeholder；真机改 base URL 后 ref 不变。Node 的显式 gemini/agy
>    补丁已删除，`account-credential-patch.js` 只剩合同派生的通用 env 补丁。
> 16. 通用 env 补丁内联进 `webui-account-routes.js`，删除 `account-credential-patch.js`；
>    真机用临时 opencode api-key 账号改 URL，`OPENCODE_BASE_URL` 正确落库、账号删除干净。
>    该路径仍服务 Go 尚未接管的 Provider，但是单文件、无 per-provider 表。
> 17. 额度写入口进 Go：`PUT /v1/management/accounts/{ref}/usage` 支持完整快照 DTO，
>    按当前凭据版本 CAS 落 `account_usage`，提交后投影 runtime quota block。真机临时 codex
>    账号 PUT 后 GET 返回 1 条 `quota_probe` 条目，删除干净。Node 的 quota 探测尚未改为推送 Go。
> 18. 额度批量读进 Go：`GET /v1/management/account-usage` 支持 provider/ref 过滤，返回
>    每个账号的 usage view；真机临时账号 PUT 后批量读 1 条、删除后 `account_usage` 归零。
>    Node WebUI 尚未改读该接口。
> 19. 额度快照文档进 Go：`aih.db` v11 新增 `account_usage_snapshots`，`payload_json` 原样保存
>    Provider 快照对象；新增 `PUT/GET /v1/management/accounts/{ref}/usage-document` 与批量
>    `GET /v1/management/account-usage-documents`。规则：采集时间单调（旧文档不能覆盖新文档）、
>    换凭据时与 `account_usage` 同事务清除、删号外键级联。Node 的 `go-account-sync` 每轮把
>    本地更新的文档推给 Go、把 Go 更新的文档回填 `app_kv`，本地缓存因此可重建；
>    采集时间早于当前凭据的文档不再推回（Go 已按换凭据删除）。
>    验证：真实 43 账号库副本 v10→v11 迁移成功；PUT/GET payload 逐字节一致、旧文档被忽略、
>    provider 过滤与级联删除通过；用真实 `app-state.db` 副本对临时 Go 全量对账 31 推/1 拉，
>    第二轮 0/0（稳态零写入）。
>    **为什么存原样 payload**：WebUI 的额度视图模型（`lib/usage/quota/view.js` + provider
>    描述符）是 Provider 专属形状，Go 的 `account_usage`（窗口/credits）是路由事实，两者
>    字段集不同。先把展示文档的存储与写入口收敛到 Go，视图模型后续随 WebUI 一起迁。
>    读路径已切到 Go 优先（2026-11-05）：`readAccountUsageSnapshot` /
>    `loadAccountUsageSnapshotReader` 同时读 `aih.db` 的文档与 `app_kv` 暂存，按 capturedAt 取较新者；
>    Go 有更新文档时以 Go 为准，采集刚写本地、尚未同步时仍用本地。
> 20. 归一化额度事实上行：Node 按额度视图模型把快照映射成 Go 的 window 条目
>    （`lib/account/go-bridge/go-usage-facts.js`），`go-account-sync` 按 capturedAt 增量推送。
>    口径：账号级窗口用 `account` scope；模型级额度用 `model_family`（不产生账号级阻塞）；
>    gift/detail 旁路不参与；无可渲染额度时写一条 `usage_unknown`，显式覆盖 Go 里的旧事实。
>    `PUT /usage` 新增 `collected=true` 语义：采集方已完成凭据代次门禁，Go 不再要求解析
>    该账号凭据（Go 自己的探针仍走凭据 CAS）。
>    验证：真实库副本 31 账号 90 条、零错误、第二轮 0 写入；真机重启后 33 账号 96 条
>    （account: available 27 / exhausted 3 / unknown 6，model_family available 60），
>    WebUI 43 账号 / 36 快照不变。3 个 exhausted 都是快照真实 0%（cline 30days ×2、zcode weekly）。
> 21. 账号额度状态派生进 Go（含 codex team）：`core/accountusage.DeriveQuotaState` 按与 Node
>    相同的口径派生 available / exhausted / pending；codex `fallbackSource=account_read`
>    且 `planType=team`（或 free）时返回 `codex_team_plan_pending_rate_limits`（或 free 版本），
>    不再把这类账号当成上游不可用。`GET /v1/management/account-quota-states` 批量返回
>    状态、原因、剩余比例与快照采集时间。Node 的 Go 运行态叠加层同时拉取该接口，
>    账号页在「无探针失败且 Go 状态不比本地快照旧」时优先使用 Go 的额度状态；
>    探针失败仍是 Node 的瞬时事实，由本地派生。真机临时 codex 账号验证：
>    account_read + team + 无 rate limits → `pending/codex_team_plan_pending_rate_limits`；
>    随后写入 42.5% 快照 → `available/42.5`。Node 的 team 分支暂留作 CLI/Go 不可用时的兜底。
> 22. 额度状态物化 + Node team 分支删除：`aih.db` v12 在 `account_usage_snapshots` 上物化
>    `quota_status/quota_reason/remaining_bps/has_numeric_remaining`；写文档、写归一化事实、
>    读状态接口三处都会重算，旧库升级后首次读即回填。CLI 的 `getAccountQuotaState` 直接读
>    物化状态（`go-account-store-reader.readGoQuotaStates`），`derived-state.js` 的
>    codex team/free/auth_json 分支已删除，本地推导只保留通用 `pending` 结论。
>    真机：v12 迁移成功、33 份文档全部物化；WebUI 与物化状态逐账号比对 29/29 一致
>    （其余 4 条 Go 状态不在 WebUI 账号表）；CLI 读取器返回 33 条
>    （available 25 / exhausted 3 / pending 5）。
> 23. `account_state` 写投影进 Go：`aih.db` v13 新增 `account_ui_state`
>    （status / display_name / auth_mode / api_key_mode / base_url / updated_at）；
>    `PUT/GET /v1/management/accounts/{ref}/ui-state` 上线。`go-account-sync` 每轮按内容指纹
>    把 Node `account_state` 的展示字段投影到 Go，内容不变不重推。
>    真机：v13 迁移成功，43 个账号全部投影（up 33 / down 10）；与 WebUI 逐账号比对
>    38/38 状态一致（其余 5 个是 Go 独有账号）。批量读取 `GET /v1/management/account-ui-states`
>    已上线，供账号 watch 一次预取全量。
>    读取已切换：`webui-account-live` 的 `stateInfo` 对 **authMode / apiKeyMode** 使用 Go
>    物化值（Go 更新较新时），displayName 仍由 Node 按 baseUrl 推导（直接覆盖曾出现错名）；
>    `status` 仍走 Node 实时推导。真机 38 账号比对：apiKeyMode 全一致，authMode 仅在
>    Node 状态本身为 NULL 的账号上有差异，UI 用 `||` 回退保持原值。
>    建��账号编辑/状态接口的 `buildPersistedAccountState` 也改为 Go 优先
>    （`readGoUIStates` + 1 秒缓存）。**但列还不能删**：`isPendingOauthStateRow` 仍用
>    `stateRow.authMode` 判定 OAuth 待登录，删除前要把这段判定迁走。
> 24. **账号运行态文档进 Go（2026-11-05）**：`aih.db` v16 新增 `account_runtime_states`
>    （`account_ref` / `state_json` / `updated_at_ms`），保存 Node `account_state.runtime_state`
>    的完整 JSON；`PUT/GET /v1/management/accounts/{ref}/runtime-state` 与批量
>    `GET /v1/management/account-runtime-states` 上线。写入与派生在同一事务里：
>    `core/accountruntime.AccountState.DeriveStatus` 复刻 Node `deriveAccountRuntimeStatus`
>    的优先级（routingBlock → auth_invalid → rate_limited → overloaded → transient_network →
>    service_unavailable → upstream_error → cooldownUntil → healthy），
>    `DeriveBlock` 把 Node 失败词映射成 Go `FailureKind` 并物化 `account_runtime_blocks`，
>    文档消失时同事务清掉阻塞。
>    Node 侧：`state-service` 每次事件转移后经 `go-runtime-state-report` 推完整文档
>    （`recordRuntimeFailure` / `clearRuntimeBlock` 的所有持久化分支），`go-account-sync`
>    每轮按内容指纹补推；`go-runtime-block-report.js` 与其映射测试已删除，
>    `syncRuntimeBlocks` 改为 `syncRuntimeStates`。账号页的 `go-runtime-overlay`
>    新增 `runtimeState` 通道：Go 文档不早于本地 `stateInfo.updatedAt` 时直接采用 Go 的
>    status/until/reason（Node 本地推导保留为 Go 不可用时的兜底）。
>    验证：`go test` 三个包全绿；隔离实例（真实库副本）PUT→`rate_limited` + 60s 阻塞、
>    批量读回、非法文档 400、`state:null` 同事务删除两张表；真机 v16 迁移成功
>    （`user_version=16`，`account_runtime_states` 已建）。
> 25. **运行态读写切到 Go 的内存/持久化双层（2026-11-05）**：服务端的
>    `account_state_index` 不再写 `account_state.runtime_state` 列；运行态由
>    `lib/server/go-runtime-state-store.js` 持有（进程内 Map 为热路径权威值，
>    每次写入异步 `PUT /runtime-state` 给 Go，失败条目按 60s 窗口重试）。
>    启动时 `hydrate()` 从 `account_runtime_states` 回填，崩溃/重启不丢；
>    读取按「内存 → Go 文档 → 旧列」优先级合并，旧列只作迁移兜底。
>    CLI 不再直写运行态列：`state-service` 经 `state-index-client` 的
>    `POST /v0/management/state-index/runtime-state` 交给服务端统一落库并推送；
>    CLI 读侧用 `go-runtime-state-reader`（aih.db 只读 + 1s 快照）看到同一份文档。
>    `go-runtime-state-report.js` 已删除，`go-account-sync` 的 `syncRuntimeStates`
>    改为「旧列引导 + store.flush 重试」。
>    验证：store/index/CLI 漏斗单测全绿；隔离 Go 实例上 set→flush→
>    `rate_limited`、重建 store 后 hydrate 回填、clear→Go 行消失；
>    相关 Node 用例 63 项全绿。
> 26. **kiro 模型目录 + 令牌刷新落 Go（2026-11-05）**：
>    `core/accounts/kiro` 解析两种 kiro 原生凭据（oidc / desktop），提供过期判定、
>    刷新结果回写（`WithGrant` 会重算 `identityEvidence.tokenBinding`，身份种子不变）；
>    `internal/adapters/kiro/modelcatalog` 走控制面 ListAvailableModels（V3 按套餐，
>    失败回落 V2），凭据缺 `profileArn` 时先用 ListAvailableProfiles 解析唯一 profile，
>    列不出则用官方 CLI 的 Builder-ID 固定 ARN，企业多 profile 不替用户选择（只走 V2）；
>    `internal/adapters/accounts/kirocred` 用 refresh_token 走 AWS SSO OIDC / Kiro Desktop
>    两种刷新端点，成功后按凭据版本 CAS 落库，冲突时回读胜出的快照。
>    `ModelManagement` 新增可选 `ModelCredentialRefresher`，发现前刷新。
>    **同时修掉一个静默失效**：刷新队列原来是一张手写 Provider 表（codex/claude/agy + 透传），
>    与发现注册表不同源，导致新加的 kiro 永远不会被周期重扫（账号在池里、目录一直为空）。
>    现在 `modelRefreshProviderConcurrency` 直接由 `ModelDiscovery.ProviderIDs()` 派生。
>    真机：5 个 kiro 账号全部从 0 个模型变为各 5 个（deepseek-3.2 / glm-5 /
>    minimax-m2.1 / minimax-m2.5 / qwen3-coder-next），与 Node 自己的发现结果逐条一致；
>    其中 4 个账号的 access token 已过期，由 Go 刷新并写回后完成发现。
> 27. **OpenCode 模型目录两条腿 + OAuth 发现（2026-11-05）**：
>    `internal/adapters/opencode/modelcatalog` 从只探 Go 订阅腿改为同时探
>    `zen/go/v1/models`（`opencode-go/` 前缀）与 `zen/v1/models`（`opencode/` 前缀）并取并集，
>    单腿失败保留另一腿结果；凭据在 api-key 之外接受 OAuth 的 `access` 令牌
>    （**仅发现**，推理仍只走 api-key，边界留在 opencoderelay）。
>    真机：OAuth opencode 账号从 0 个模型变为 68 个；另一个 `auth.codex` 占位账号仍按不支持处理。
> 28. **zcode 模型目录落 Go（2026-11-05）**：`internal/adapters/zcode/modelcatalog`
>    用凭据里的 `credentials.zcodejwttoken` 调 plan 计费接口：先读
>    `billing/balance` 的 `data.balances[].capabilities`（`model:*`），
>    为空时回退 `billing/preview` 的 `plans[].entitlements[].capabilities`（「领臭鸡蛋」
>    类账号的模型只在预览里）。客户端元数据头与 Node 同口径：`X-Device-Mid` 由账号
>    身份种子派生稳定 UUID，另带 `X-ZCode-App-Version` / `X-Platform` /
>    `X-Release-Channel` 等；只暴露 glm*/codegeex*/zcode* 裸命名空间（伙伴命名空间
>    会被 bigmodel 判 400）。真机：8 个 zcode 账号中 5 个拿到目录
>    （4 个 `glm-5.3-flash`、1 个 `glm-5.3`+`glm-5.3-flash`），其余 3 个上游余额与
>    预览都为空，与直接探测结果一致。
>    覆盖度更新：kiro 25、opencode 68、zcode 5 个账号有目录；claude 两个第三方代理
>    不实现 `/v1/models`，仍是 0。
> 29. **剩余模型提供方覆盖（2026-11-05）**：
>    - **claude 第三方 Anthropic 兼容代理**：Anthropic 分页目录失败后，按同一凭据回退
>      OpenAI 风格的 `GET {base|origin}/v1/models` 与 `/models`（`internal/adapters/claude/messages`
>      的 `fetchOpenAICompatibleCatalog`）。DeepSeek 的 `/anthropic` 代理本身没有
>      `/anthropic/v1/models`，但 origin 的 `/v1/models` 返回 `{object,data:[{id}]}`。
>      真机：`acct_9ebdea56` 从 0 → 2 个模型（deepseek-flash / deepseek-v4-pro）；
>      另一个 claude 账号 enabled=0，不参与重扫。
>    - **zcode paas 兜底**：余额与活动预览都为空时，用 `credentials["oauth:bigmodel:access_token"]`
>      读 `https://api.z.ai/api/coding/paas/v4/models`。真机：`acct_d88d9008` 从 0 → 12 个
>      （glm-4.5 … glm-5.3）。
>    - **剩余空目录均与 Node 同源、非 Go 缺口**：
>      opencode `acct_e9b5` 的凭据是 `auth.codex` 占位（dummy，无 opencode token）；
>      zcode `acct_ae47` / `acct_4dbc` 没有 `oauth:bigmodel:access_token` 且余额/预览为空；
>      gemini `acct_7205` 是 enabled=0 的 Vertex 导出占位（指向本机网关，不进路由池）。
>      这四类在 Node 侧同样没有可发现目录。
>    覆盖结果：启用账号中只剩上述三个占位/无凭据账号没有目录。
> 30. **gemini 模型目录落 Go（2026-11-05）**：新增 `internal/adapters/gemini/modelcatalog`，
>    对 Vertex 占位/网关号（`*gemini.VertexAuth`）按 `base_url` 读 `/v1/models`（OpenAI 风格）
>    并回退 `/models`（Gemini 风格，`models/` 前缀自动剥除）；登录态 code-assist
>    账号需要 loadCodeAssist/fetchAvailableModels 预检，仍返回「凭据形态不支持」。
>    隔离实例（真实库副本）上对 `acct_720524e8` 显式 `POST .../models/refresh` 成功返回
>    **184 个模型**；真机上该账号是 enabled=0 的 Vertex 导出占位（指向本机网关），
>    周期重扫会跳过它，因此线上仍显示 0，这是设计边界而不是缺口。
>    **至此每个有 models 策略的 Provider 都有 Go 发现器**：codex/claude/agy/kimi/grok/
>    opencode/codebuddy 家族/kiro/zcode/gemini/cline/qoder。
> 31. **模型目录保真修正（2026-11-05，审计后）**：
>    - **opencode 匿名探测**：没有 opencode 密钥的账号（`auth.codex` 占位）也要探两个官方端点
>      ——Node 的行为是「有 key 才加 Authorization，否则匿名」。Go 之前直接报
>      「凭据形态不支持」；现在匿名请求，两个 leg 仍按 `opencode-go/` / `opencode/` 并集。
>      真机：`acct_e9b5` 从 0 → **109 个模型**，与 Node 的 byAccount 快照一致；
>      opencode 覆盖变为 2/2。
>    - **claude 候选循环统一**：按 Node 的候选顺序（`<base>/models` → `<base>/v1/models` →
>      `<origin>/v1/models` → `<origin>/models`）逐个探测，每个候选只发一次请求，
>      同一份响应同时按 Anthropic 分页与 OpenAI `{data:[{id}]}` 形状解析；
>      所有候选失败时错误里带上每个端点与状态码（401/429/超时不再被报成
>      404 media_type=missing）；每个候选都带 `anthropic-version`。
>      删除了 `fetchModelCatalogPage` / `buildModelsRequest` / 旧的
>      `fetchOpenAICompatibleCatalog`（被候选循环取代）。
>    - **gemini 占位保护**：`*gemini.VertexAuth` 的 `Placeholder()` 或 loopback base_url
>      直接拒绝，避免显式 refresh 把本机网关的整份目录灌进 account_models。
>      占位账号仍然 enabled=0、不进路由池。
>    - 最终覆盖（真机）：所有**启用**账号都有目录；剩余 0 行只有 claude/gemini 两个
>      enabled=0 的占位，以及两个 zai token 已过期、余额/预览皆空的 zcode 账号
>      （Node 同样无目录，需要重新登录）。
> 32. **kiro 额度采集迁 Go（2026-11-05）**：新增 `internal/adapters/kiro/usage`，
>    按 Node 的协议调 `AmazonCodeWhispererService.GetUsageLimits`
>    （`POST https://codewhisperer.<region>.amazonaws.com/`，query 与 body 同形：
>    `origin=CLI` / `resourceType=AGENTIC_REQUEST` / `isEmailRequired=true` /
>    可选 `profileArn`）。响应取 `usageBreakdownList` 里 `resourceType=CREDIT` 的资源，
>    折算剩余基点写 `account_usage`，同时产出与 Node 同形、`schemaVersion=2` 的
>    `account_usage_snapshots` 文档（`kind=kiro_credit_usage`，account.email/planName/planType，
>    entries 保留 total/used/remaining 原始单位与 resetAtMs）。
>    额度应用层新增可选 `CredentialRefresher`（探测前用 `kirocred` 刷新过期 token 并沿用
>    CAS 版本）与 `ProviderSnapshotStrategy`（一次采集同时产出快照与展示文档）。
>    协调器把 kiro 加入刷新队列。
>    Node 侧删除：`lib/providers/defs/kiro.js` 的 quota 策略改为 `supported:false`
>    （只读 Go 文档），`lib/cli/services/usage/snapshot.js` 里未被使用的探针实例移除，
>    `lib/cli/services/usage/kiro-quota-probe.js` 删除；展示名所需的邮箱由 Go 文档的
>    `account.email` 提供。
>    验证：隔离实例显式刷新写入了正确文档（KIRO FREE / 50 credits / 97.7%）；
>    真机重启后 5 个 kiro 账号全部产生 `account_usage` 行与快照文档；
>    Node 相关用例 33 项全绿。
> 33. **模型目录评审修复（2026-11-05，对抗评审后）**：
>    - **显式 Models 端点**：`base_url` 本身以 `/models` 结尾时（如
>      `https://gateway/anthropic/v1/models`），候选列表第一个就是该端点本身，
>      不再拼成 `/models/models`；重构前 `modelsEndpoint` 支持这种配置，回退后保证不丢。
>    - **loopback 语义**：`isLoopbackBase` 改用 `net.ParseIP` + `IsLoopback/IsUnspecified`
>      并去掉主机名尾部点，覆盖 `localhost.`、`[::1]`、`[::ffff:127.0.0.1]`、
>      `[0:0:0:0:0:0:0:1]`、`0.0.0.0` —— 之前只比对字面量，这些写法会绕过占位保护
>      并把账号 Key 发到本机网关。
>    - **回归守卫**：gemini 补 8 种 loopback 写法的表驱动用例；opencode 补
>      `New()` 的 `GoBaseURL→opencode-go/` / `ZenBaseURL→opencode/` 映射断言；
>      claude 补显式端点「只请求一次」的用例。
>    验证：三个包测试全绿，真机重启后覆盖与 kiro 额度行数不变。
> 34. **agy 额度采集迁 Go（2026-11-05）**：新增 `internal/adapters/agy/usage`：
>    `POST {base}/v1internal:loadCodeAssist`（`metadata.ideType=ANTIGRAVITY`）取 project
>    与套餐 tier，再 `POST {base}/v1internal:fetchAvailableModels`（带 project；403 时回退
>    空对象重试）读 `models[*].quotaInfo.remainingFraction/resetTime`。额度按模型计：
>    每个模型一条 `model_family` 条目（bucket/scopeKey=模型 ID），可用性按剩余比例
>    标 available/exhausted；同时产出 `schemaVersion=2` 的 `agy_code_assist_quota` 文档
>    （account email/planType/subscriptionTier/project + models[] 的剩余比例、resetIn、
>    展示名与能力标记 + modelForwardingRules）。
>    凭据刷新复用 credential resolver 里已有的 `agyoauth` 策略（无需新增 Refresher）；
>    协调器把 agy 加入刷新队列。
>    Node 侧：`lib/providers/defs/agy.js` 的 quota 策略改为 `supported:false`（只读 Go 文档）。
>    **验证边界**：本机 6 个 agy 账号全部 enabled=0 且 access token 自 2026-10-24 起过期，
>    上游探测无法复现；单测覆盖了 loadCodeAssist→fetchAvailableModels、403 回退、
>    内部模型过滤、快照与文档形状。`lib/server/agy-usage-snapshot.js` 里失败触发的
>    Node 兜底探针仍在，等该链路整体切换后再删。
> 35. **zcode 额度采集迁 Go（2026-11-05）**：新增 `internal/adapters/zcode/usage`：
>    GET `billing/balance`（Bearer `zcodeJwtToken` + `X-Device-Mid` 等客户端头 +
>    `app_version`），把 `data.balances[]` 映射成账号级 window 条目
>    （bucket 取首个 `model:*` capability，窗口按 `period` 或 period_start/end 推导，
>    remaining 优先用上游 remaining_units）。
>    三类结论都保留：余额非空 → 正常条目；`plans` 与 `balances` 都是显式空数组 →
>    「没有套餐」（写一条 remaining 未知的条目清掉旧权重，文档 entries 为空）；
>    `plans` 非空、`balances` 为空 → 「套餐已领取未生效」，文档带 `pendingEffectiveAtMs`。
>    展示文档 `schemaVersion=2`、`kind=zcode_plan_balance`，entries 保留 total/used/remaining
>    原始单位、planId/planGroupId/planName/planStatus/planEndsAt，account 带
>    planType/planNames/planIds。
>    复用 `zcode/modelcatalog` 导出的 `ClientHeaders` / `JWTFromPayload` / `SeedAppVersion`，
>    避免两套客户端元数据漂移。协调器加入 zcode。
>    Node 侧：`lib/providers/defs/zcode.js` 的 quota 策略改为 `supported:false`。
>    真机：重启后 Go 已分别刷新「无套餐」账号（文档 entries=0）与有套餐账号
>    （GLM Coding Plan，3 条 entries），按 30s 错峰逐个推进。
>    未迁：Node 的 BigModel coding-plan 附加额度（5h/每周/MCP），它是附加信息，后续可补。
> 36. **CodeBuddy 家族额度采集迁 Go（2026-11-05）**：新增
>    `internal/adapters/codebuddyfamily/usage`，按发行版域名 POST
>    `/billing/meter/get-user-resource-summary`（Bearer accessToken、`X-User-Id`、
>    `X-Domain`、`User-Agent: CodeBuddy/1.0 (ai-home)`）。`Packages[]` 的
>    CycleTotal/Remain/UsedCapacity 折成积分条目：
>    **归一化快照只放一条聚合条目**（sum(remain)/sum(total)），明细包只进展示文档
>    （`category:'detail'`）——否则一个用尽的赠包会把账号级 min(remaining) 拖成 0，
>    健康账号被误判耗尽。`Packages=[]` 且 `TotalCredits=0` 是确定的 0 积分
>    （exhausted），不是未知；付费档位只在 `IsPaidUser=true` 时按
>    `SubscriptionPackageCode` 映射。
>    四个 Provider 各注册一条策略（codebuddy/codebuddycn/workbuddy/workbuddycn），
>    协调器加入四个刷新队列；Node 的共享描述符
>    `lib/providers/defs/_shared/codebuddy-family.js` 的 quota 改为 `supported:false`。
>    真机：重启后 **15/15 家族账号**在 ~80s 内全部产生快照文档（3–5 条 entries，
>    付费账号带 planType），account_usage 15 条。

## 0. 结论先行

当前不是「两份代码、一个数据库」，而是**两套账号真相**：

- Node 是**账号写入口、状态/展示、模型目录、用量与会话引用**的持有者；
- Go 是**推理路由、凭据代际/CAS、运行态结果**的持有者；
- `go-account-sync` 只是把两边互相投影，不是单一真相；编辑 URL 派生新账号的 bug 就是投影失败的一种表现。

合并不能直接「把 Node 表倒进 Go」：两边对同一个静态 Key 会算出**不同的 `account_ref`**，而 Node 的 ref 被 103 万条用量记录（其中 27.88 万条带账号）和 185 条会话引用。方案的核心是：

1. **保留 Node 现有 `account_ref` 作为唯一账号主键**；
2. 把 Go 现有账号 ref 一次性映射到 Node ref（Go 侧数据量小）；
3. **账号存储先收敛到 Go**：Node 保留 OAuth/宿主扫描等采集能力，但采集结果只经 Go 的存储/导入 API 落库，不再写 `app-state.db`；
4. 再按域把 Node 其余表迁入 `aih.db`，最后搬 WebUI/运行时。

## 1. Go 与 Node 账号的真实差异

### 1.1 身份与 accountRef

| 项 | Node | Go |
| --- | --- | --- |
| 静态 Key 种子 | `api_key:<provider>:<去尾斜杠 baseUrl>:<sha256(key)[:16]>` | `api_key:<provider>:<Go 规范化 baseUrl，空则官方地址>:<sha256(key) 全 64 位>` |
| auth-token 种子 | `auth_token:<provider>:<baseUrl>:<sha256(secret)[:16]>` | 同构，哈希全 64 位 |
| accountRef | `acct_` + `sha256("unique:" + seed)[:20]` | 同一公式 |
| OAuth/native 种子 | 各 Provider 策略（codex 用 ID token 的 user_id 等） | 多数已复刻；zcode 存在差异 |
| 现有结果 | 43 个账号 | 39 个账号 |
| ref 交集 | 34 个共享 / 9 个 Node-only / 5 个 Go-only | 与左列同一口径 |

**关键事实（本机库）**：

- 3 个静态账号（codex 1、claude 2）的 key+baseUrl **逐条匹配**，但 Node ref 与 Go ref **全部不同**；Go 侧多出的 5 个 ref 中有 3 个就是这三条的“ref 双胞胎”。
- zcode 有 2 个账号只在 Node、2 个只在 Go，且无法按现有信息配对（一方 `enc:v1`，一方无 access token）。
- cline 2、gemini 1、opencode 1 只在 Node；Go 没有对应静态形态或身份策略。
- 9 个 Node-only 中其余 4 个需逐条核对（同一 Provider 计数相同、但 ref 不同）；5 个 Go-only 是 3 个静态 ref 双胞胎 + 2 个 zcode。
- agy/kiro/codebuddy 等多数 native 账号 ref 相同；但仍有若干 Provider 的 ref 差异需逐条裁决。
- 根因是静态种子哈希长度（Node 16 位 vs Go 64 位）与 baseUrl 归一化规则不同；**不要用 ref 做跨库匹配，先按 provider+key（+baseUrl）匹配，再按身份种子核对。**

### 1.2 凭据存储

| 项 | Node | Go |
| --- | --- | --- |
| 表 | `account_credentials.env_json` + `native_auth_json` | `account_credentials.auth_kind` + `auth_mode` + `credential_json` |
| 形态 | 进程环境变量包 / Provider 原生 JSON | 每个 Provider 一个严格 codec |
| 查重 | 身份种子 + `findAccountRefByIdentity` | `credential_ref = cred_` + 种子派生，唯一索引 |
| 覆盖 | 任何 Provider 都可用 env 表示静态凭据 | 只对 codex/claude 有静态凭据；其余走 native envelope |

本机差异：

- cline 2 个、gemini 1 个（Vertex/自环占位）、opencode 1 个只在 Node；
- 6 个共享 ref 的 native 账号存在 `enc:v1` 与 Go 明文的“编码漂移”（5 zcode + 1 qoder），不是值冲突，但迁移时要用 Node 的解密能力核对；
- 3 个静态账号的 Go credential 形态是 `{api_key,base_url}`，Node 是 `env_json`，需要逐条 codec 转换。

### 1.3 状态、模型、默认账号、用量

| 域 | Node | Go |
| --- | --- | --- |
| 账号状态 | `account_state`：status/displayName/apiKeyMode/authMode/baseUrl/remainingPct/runtime block | `accounts.enabled` 只有用户开关；runtime/outcomes/usage 分层，本机 runtime/usage 为空 |
| 额度 | `account_quota_detector_state` 260 行、`account_quota_reset_events` 201 行 | `account_usage` 0 行、`usage_ledger` 0 行 |
| 模型 | 全 Provider 模型目录与缓存 | `account_models` 445 行，仅 7 个 Provider |
| 默认账号 | `app_kv account:default:*` | `account_defaults` 0 行 |
| CLI 别名 | `account_cli_aliases` 43 行 | `accounts.cli_account_id`（21 个与 Node 数字不同） |
| 用量/会话 | `model_usage_records` 1,037,405 行（其中 **278,805** 行带 `account_ref`）；`model_usage_sessions` 8,333 行（185 条 `chat_runtime_sessions` 带 `execution_account_ref`） | `usage_ledger` 0 行；无会话表 |
| 结果事件 | `native_account_outcomes` 552 行 | `account_outcomes` 109 行（预聚合日桶，Node 是事件） |

**状态语义不能折叠**：Node 的 `status=down` 可能是额度/运行态阻塞，不等于用户停用；Go 的 `enabled=0` 只是用户开关。本机 34 个共享 ref 中只有 7 个 down↔disabled、27 个 up↔enabled，说明其余 down 不能直接映射成 disabled。迁移必须保留 `account_state` 的独立状态投影。

### 1.4 写入口与控制面

- WebUI 实际调用的是 Node 的 `/v0/webui/accounts*`；Go 的 `/v1/management/accounts*` 是内部/预览面，两者语义不同，不能互为别名。
- 生产 route ownership 中 `go.preview.account_management` 仍是 `node_owned`；Go 只承接 12 条推理数据面。
- 规模：Node 约 297 条路由记录 / 662 个 server 文件（其中 WebUI 195 个路由模式、62 个 `webui-*-routes` 模块）；Go 38 条路由 / 约 79k 行 Go。
- Go 已有 PTY/persistent/multiplexer 运行时（约 3.2k 行），但没有静态 WebUI、聊天、SSH、插件、定时任务等控制面/运行时。

### 1.5 合并影响一句话

**Node 的 ref 是业务事实，Go 的 ref 是路由事实。** 合并必须让 Go 接受并保留 Node ref，而不是让两边继续各算各的。

过渡期的权威划分必须写死，不能靠同步器猜：

| 域 | 过渡期权威 | 终态 |
| --- | --- | --- |
| 账号/凭据存储、ref 签发、代际/CAS | Go | Go |
| OAuth/宿主扫描/导入采集 | Node（Go 只覆盖 codex/claude） | 逐步迁 Go |
| 状态/展示/额度可调度性 | Node（`account_state` + gate） | 迁 Go 的 UI/status 投影 |
| 模型目录 | Go（`account_models`）+ Node 设置意图 | Go |
| CLI 数字别名/默认账号 | Node 数字为准，写入 Go | Go |
| 墓碑/删除语义 | Node 产生，Go 存储并执行 | Go |

## 2. 目标架构

```
浏览器 / CLI
    │
    ▼
Go aih-server（唯一后端，9527）
    ├── 推理/Relay（已有）
    ├── 账号/模型/用量/运行态（已有，需补齐）
    ├── WebUI 静态资源 + /v0/webui 控制面（待迁）
    ├── Chat / Session / PTY / SSH / Plugin / Task（按能力迁）
    └── 唯一数据库 aih.db
            ├── accounts / credentials / profiles / models
            ├── account_state / quota / outcomes / usage
            ├── chat_runtime_* / app_kv
            └── migration_ledger（旧 ref 映射与回滚账本）

Node 进程（过渡期，逐渐缩小）
    ├── 凭据采集器：OAuth 登录 / 宿主扫描 / 导入 / 本机检测
    │     └── 采集完成后只调 Go 的账号存储 API，不写 app-state.db 账号表
    ├── 未迁 WebUI/运行时的执行器（被 Go 反向代理）
    └── 最终保留 aih CLI 启动器/构建工具，不再监听 9527
```

**唯一身份规则**：`account_ref` 由 Node 现有公式产生；迁移只做「Go ref → Node ref」映射，不重新派生已有账号。34 个共享 ref 原样保留；3 个静态 Go ref 按 key+baseUrl 合并到 Node ref；2 个 zcode Go-only ref 待人工裁决；9 个 Node-only 账号直接以 Node ref 插入 Go。新账号也使用同一公式（Go 实现同一份归一化与 16 位哈希），彻底消除两套 ref 风格。

## 3. 分阶段方案

### P0：冻结与账本（先做，1 个批次）

1. 冻结 Node 账号 schema 与身份公式变更；所有新账号能力只进 Go。
2. 在 `aih.db` 增加 `migration_ledger`（旧 Go ref、目标 Node ref、Provider、迁移状态、校验和）。
3. 盘点并冻结三类例外：gemini Vertex 占位、cline native、opencode 边界账号；在迁移账本中标记 `node_only` 或 `needs_codec`。
4. 给 `go-account-sync` 加开关：迁移期间只允许「读校验」，禁止新增/收养/删除（现有 `adopt` 是派生账号 bug 的来源）。

**验收**：迁移账本可重放；同步开关可一键停写；两份库快照可校验。

### P1：账号域单库（Go 存储 + Node 采集）

**关键口径**：从 P1 第一天起，`aih.db` 是唯一的账号库；Node 仍是**凭据采集器**（OAuth 登录、宿主扫描、导入、本机检测），但采集完成后只调用 Go 的账号存储/导入 API，不再写 `app-state.db` 的账号表。这样不必等 Go 补齐所有 OAuth 流程，也能先消灭「两个账号库」。

| Provider 类别 | 采集方 | 存储方 | 过渡期写路径 |
| --- | --- | --- | --- |
| codex/claude 静态 | Node WebUI 表单 | Go | 直接调 Go create/rotate |
| codex/claude OAuth | Node 登录 job | Go | Node 采集 → Go import |
| agy / kiro / kimi / zcode / codebuddy 家族等 native | Node 宿主扫描/OAuth | Go native envelope | Node 采集 → Go upsert |
| gemini Vertex 占位 | Node | Go（需补占位 codec） | 补完前标记 `node_only`，仍写 Go 但存不透明信封 |
| cline | Node | Go（缺 codec） | 补 codec 前走不透明 `native_auth_json` |
| opencode | Node | Go（部分） | 补齐 `{"codex":...}` 边界 |

1. **Go 增加「按给定 ref upsert」用例**：只对内部采集/迁移入口开放（management API 仍派生 ref，不允许外部指定）；Node 采集新账号时按 Node 公式算出 ref 后交给 Go；对 Go 尚未研究的 Provider 接受不透明 `native_auth_json` 信封（现有 15 个 Provider 已支持）。
2. **Go 采纳 Node 静态身份公式**：16 位哈希 + Node baseUrl 归一化；Go 的严格 URL 校验只约束新写入，迁移账号原样保留、不重新校验。这样新老账号只有一套 ref。
3. **补齐 Go 的账号能力缺口**（按阻塞程度）：
   - **tombstone**：Go 没有 `account:retired/deleted/deleted-api-key`，必须补；否则宿主扫描会复活已删账号；
   - **cline codec**：decoder 已声明 cline，但 SQLite credential registry 未注册，native 持久化会失败；
   - **gemini Vertex**：Node 有 `vertex_ai:` 身份构造，Go 只有 authMode 枚举，需要补占位凭据/身份或标 `node_only`；
   - **qoder PAT / zcode region / claude setup-token**：三处 seed 公式不一致，按 Node 现行公式对齐或显式保留双读；
   - **export**：Go 的 export registry 为空，迁移期保留 Node export，Go 补齐后再切；
   - **OAuth job**：Go 只支持 codex/claude，其他 Provider 的登录仍由 Node 采集后写 Go。
4. **映射 Go 现有 39 个 ref**：
   - 34 个共享 ref 原样保留；
   - 3 个静态 ref 双胞胎按 provider+key+baseUrl 合并到 Node ref，更新 `account_models`（445）、`account_outcomes`（109）等引用；
   - 2 个 zcode Go-only ref 先按真实登录态核对，确认是同一账号则合并，否则作为独立账号保留；
   - `credential_ref` 可重新派生，它只用于查重，不是身份。
5. **处理 Node 独有的迁移数据**：43 个 CLI 别名中有 21 个与 Go 数字不同，保留 Node 数字（用户可见），重排 Go 的 `cli_account_id`；`enc:v1` 的 6 条 native 账号用 Node 解密后核对再写入 Go；tombstone 迁入 Go。
6. **WebUI 账号操作改道**：`/v0/webui/accounts` 的 add/update/delete/enable/default/reauth 保留 Node 入口；静态 codex/claude 直接调 Go 的 create/rotate，其他 Provider 由 Node 完成采集后调 Go 的 upsert/import。Node 不再写账号表，只刷新读缓存。
7. **删除 go-account-sync 的双向补偿**：改为一次性迁移 + 只读校验；不再 push/adopt。

**验收**：
- 43 个账号全部在 `aih.db`，ref 与 Node 完全一致；
- Node 代码路径对 `account_refs` / `account_credentials` **零写入**（用 DB trigger 或测试断言）；
- 编辑 URL/Key 后 Node 账号数不变、Go ref 不变（已有回归守卫）；
- 278,805 条带 `account_ref` 的用量记录与 185 条会话引用全部可解析；
- 新增/删除/默认/启停/重登/导入导出在 WebUI 与 CLI 等价；
- 已删账号不会被宿主扫描复活（tombstone 回归）。

### P2：数据库合并

按域迁入 `aih.db`，每域一个 migration + 回滚快照：

| 顺序 | 表 | 行数（本机） | 处理 |
| --- | --- | --- | --- |
| 1 | `account_refs` / `account_credentials` / `account_cli_aliases` | 43 / 43 / 43 | 已在 P1 完成；保留 Node ref，21 个 CLI 数字冲突以 Node 为准 |
| 2 | `account_state` → `account_profiles` + `account_ui_state` | 43 | **不要**把 status 合并成 `enabled`；保留 display/baseUrl/runtime block |
| 3 | `account_quota_detector_state` / `account_quota_reset_events` | 260 / 201 | 分别迁入 Go quota/usage 表；Node 按 quota_key 索引，Go 需补列 |
| 4 | `native_account_outcomes` | 552 | 与 Go `account_outcomes` 的 109 个日桶去重；事件粒度优先 |
| 5 | `model_usage_records` / `model_usage_sessions` | 1,037,405 / 8,333 | 其中 278,805 条带 `account_ref`；分批提交、建索引，保留全量历史 |
| 6 | `chat_runtime_*` | 185 sessions 等 | 原样迁入 `aih.db`，Go 暂不读 |
| 7 | `model_aliases` / `codex_reset_*` / `app_kv` | 2 / 0 / 配置/默认/墓碑 | 新表或 Go config/default/tombstone；墓碑必须保留 |

**在线合库方法**（避免长时间停服）：

1. 基线：`ATTACH` 两份库，按表 `INSERT ... SELECT` 全量拷贝，记录每表行数与校验和。
2. 增量：对 `updated_at`/`rowid` 可追踪的表做二次增量；`model_usage_records` 按 `id` 分批（建议 5k–20k/批）。
3. 停写窗口：切换前冻结 Node 账号与用量写入（只读），跑最后一次增量 + 校验和；窗口目标 < 1 分钟。
4. 切换：Go 打开 `aih.db` 作为唯一写库；Node 以只读连接打开同一文件，或改走 Go API。
5. 回滚：保留 `app-state.db` 切换前快照；失败时恢复快照并重启 Node 旧进程。

**`enc:v1` 前置条件**：Node 的部分 zcode/qoder native 字段用本机密钥加密（`platform:homedir:username` 派生），迁移必须在原 HOME/用户名下执行，或先由 Node 解密成明文再写入 Go；否则 Go 拿到的是不可用密文。这一步必须在退役 Node 前完成。

**三个必须先拍板的决策**：

1. **CLI 别名**：21 个冲突以 Node 数字为准（用户可见、CLI 脚本在用），Go 侧重新编号；不保留两套数字。
2. **`enc:v1` 权威**：以 Node 解密后的值为准，Go 存明文；没有 Node 密钥就阻塞迁移，不能猜。
3. **outcome 粒度**：保留 Node 事件级（552），Go 的日桶（109）在迁移后重算，避免丢失事件时间。

**验收**：每表行数与校验和一致；Node 能以只读方式打开 `aih.db`；回滚只需恢复 `app-state.db` 快照。

### P3：控制面/WebUI 迁到 Go

1. Go 提供 `web/dist` 静态资源与 SPA fallback。
2. `/v0/webui/*` 按能力迁移，先账号/仪表盘/模型/设置，后聊天/终端。
3. 过渡期 Go 反向代理未迁路由到 Node（同一 9527、同一 Management Key），但**账号路由不再代理回 Node 写库**。
4. SSE/WebSocket（账号 watch、任务、终端 mux）补 Go 实现。
5. 认证统一到 Go Management Key，删除 Node gate。

**验收**：浏览器只访问 Go 端口；账号页全部功能可用；未迁路由有明确清单与回退开关。

### P4：运行时能力迁移

按能力用 Strangler 模式逐项迁：Chat Runtime、Native Session、PTY/tmux、SSH/隧道、插件、定时任务、图片工作室、翻译、工具包/安装器。

**验收**：每个能力有独立契约测试 + 真机 smoke；Node 进程可停用该能力而不影响其他能力。

### P5：退役 Node server 与 app-state.db

1. Go 独占 9527；Node 只保留 CLI 启动/构建/安装角色。
2. 删除 `go-account-sync`、`go-core-proxy`、双读缓存与投影补偿。
3. `app-state.db` 保留一个版本的只读快照用于回滚，之后删除。
4. 更新 route ownership manifest：`node.webui_and_session_surface` 等从 `node_owned` 改为 `go_owned`。

## 4. 不可谈判的约束

1. **不重算 Node ref**：278,805 条带账号的用量记录、185 条会话、WebUI/CLI 绑定都以它为键（全量用量 1,037,405 条）。
2. **不允许双写**：`aih.db` 的账号表只有 Go 写；Node 的凭据采集结果必须经 Go API 落库。Node 不得再写 `app-state.db` 的账号/凭据表。
3. **不批量改 Provider 身份**：每加一个 Provider codec，先用 Node 真实凭据做等价测试。
4. **不删除墓碑**：`account:deleted:*` / `account:retired:*` 必须迁入 Go，否则宿主扫描会复活已删账号。
5. **每个阶段可回滚**：数据库快照 + 功能开关 + 旧进程可重启。

## 5. 主要风险

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| 静态 ref 不一致（codex/claude/zcode） | 账号重复、用量/会话断链 | P0 账本 + P1 统一公式 + 保留 Node ref |
| Go 不覆盖 gemini/cline/opencode 边界 | 合并后这些账号不可用 | 先补齐 codec，或显式 `node_only` 过渡 |
| Go 无 tombstone | 已删账号被宿主扫描复活 | P1 补 `account:retired/deleted/deleted-api-key` |
| Go export registry 为空 | 迁移/备份无出口 | 迁移期保留 Node export；Go 补齐后再切 |
| Go OAuth job 只支持 codex/claude | 其他 Provider 无法登录 | Node 采集后写 Go；不要先删 Node 登录链路 |
| 状态/展示只在 Node | Go 接管后账号页空白/状态错 | P1 先迁 `account_state` 投影 |
| 104 万条用量迁移耗时/锁库 | 服务不可用 | 分批 + WAL + 停写窗口 + 校验和；先迁 27.88 万条带账号记录 |
| WebUI 195 条路由 | 控制面迁移周期长 | 按能力切流 + Go 反代兜底 |
| 双写回归 | 派生账号/凭据覆盖再次出现 | 单写开关 + 禁止 sync adopt + 回归测试 |
| `enc:v1` 依赖原机密钥 | zcode/qoder 凭据迁移后不可用 | 在原 HOME 下迁移，或先解密；保留 Node 解密器直到校验通过 |

## 6. 第一批可立即执行的任务

1. 写 `migration_ledger` 与「按给定 ref upsert」Go 用例（迁移与 Node 采集共用）。
2. 把 Node 静态身份公式移植到 Go（16 位哈希 + Node 归一化），并用 codex/claude 现存凭据做逐条向量测试。
3. 生成 43 Node / 39 Go 的逐条映射：34 共享、9 Node-only、5 Go-only（3 静态 ref 双胞胎 + 2 zcode），人工裁决 2 个 zcode 与 9 个 Node-only 的落点。
4. Go 补齐账号存储缺口：tombstone、cline codec、gemini Vertex 占位、qoder PAT / zcode region / claude setup-token 的 seed 对齐；Node 采集结果统一走 Go API。
5. WebUI 账号 add/update/delete/default/reauth 保留 Node 入口，但落库改走 Go；用 DB trigger 或测试断言 Node 对账号表零写入。
6. 在第 5 步稳定后，关闭 `go-account-sync` 的 push/adopt，只保留只读校验；顺序不能反，否则切写期间账号不再传播。

完成这 6 项，账号域就不再是双真相；后续 P2-P5 是数据面与控制面的搬迁。

## 7. 下一块：状态推导迁 Go（可执行清单）

> 2026-11-05 盘点。`account_ui_state` 的写投影与批量读已就位（v13），但 `status` 仍由 Node
> 推导；直接把读取切到 Go 只会拿到 15 秒前的副本，必须先搬推导。

0. ✅ OAuth 待登录判定已落 Go 并物化：`aih.db` v15 的 `account_ui_state`
   增加 `configured` / `oauth_pending`；Node 的 `isPendingOauthStateRow` 优先读物化值。
   `core/accounts/oauth_pending.go`
   （`IsOauthAuthMode` / `ResolveOauthPendingState` / `ResolveOauthJobDeadline`，
   含 5 分钟兜底与 20 分钟浏览器窗口的表驱动测试）。下一步把 Node
   `oauth-pending-state.js` 的调用改为读 Go 输出。
1. **输入分层**（Go 侧已具备 / 待补）
   - 已具备：`accounts.enabled`、`account_usage`（额度事实）、`account_usage_snapshots.quota_status`、
     `account_runtime_state`（冷却/连续失败）、`account_outcomes`（成功/失败事件）、
     `account_ui_state`（展示元数据）。
   - 待补：探针错误（Node 内存 `getLastUsageProbeState`）、宿主认证状态（`status-file`）、
     agy/codex 的 `auth_invalid` 证据链。
2. **迁移顺序**
   - a. ✅ `status-file.js` 已搬为 `core/accounts/status_value.go`（含表驱动测试），并接入
     `NewUIState`：Go 写入 `account_ui_state.status` 前按 `up/down/disabled/enabled` 同一口径归一。
     `state-sync-policy.js` 只是 Node 的对象裁剪辅助，没有 Go 消费方，暂不搬。
   - b. ✅ 领域层已存在，**不要再造一份**：Go 的 `core/accountruntime/block.go` 已有
     `FailureKind` + `BlockDirective`（kind/scope/recovery trigger）+ `GuessedCooldown`，
     `internal/adapters/upstreamfailure/configured` 已按同一冷却策略分类。Node 的
     `runtime-state-builders.js` 只是把这些语义写成 Node 的 JSON 形状。
     **真正的缺口**：账号级 runtime block 的存储 + `PUT /v1/management/accounts/{ref}/runtime-block`
     写入接口，让 Node 把观察到的失败上报给 Go；之后删除 Node 的三个 builder。
     另需确认 Node 限流的 5h 默认 / 7d 上限是否要合并进 Go 的策略（Go 目前用 `GuessedCooldown`）。
     已完成存储层：`aih.db` v14 `account_runtime_blocks(account_ref, kind, scope, reason,
     observed_at_ms, until_ms)` + `ReplaceAccountBlock/DeleteAccountBlock/ListAccountBlocks`；
     `core/accountruntime.AccountBlock` 复用 `PolicyFor`/`BlockDirective` 校验，限流等冷却类型
     允许 account scope 但不要求解除信号。
     写入接口已上线：`PUT/DELETE/GET /v1/management/accounts/{ref}/runtime-block`
     （真机临时账号验证：PUT 200、GET 1 条、非法 scope 400 `invalid_runtime_block`、
     DELETE 204 后归零）。
     上报已接入：`lib/server/go-runtime-block-report.js` 在 `state-service.recordRuntimeFailure`
     成功后把 auth_invalid / rate_limited / permission_denied（及 billing/quota/region）映射为
     Go 的 FailureKind 并 `PUT .../runtime-block`；旁路失败不影响本地调度。
     真机重启后接口正常、`account_runtime_blocks` 为 0（当前无新失败），mapper 4 组测试全绿。
     下一步：观察期比对 Go 行与 Node runtime_state，一致后切读并删 Node 的 runtime_state 写入。
   - c. `state-service.js`（415 行）按「事件 → 状态转移」逐条搬：先 `login_success`/`credential_update_after_failure`
     这类凭据证据，再 `upstream_success`/`quota` 这类流量证据，最后 `route_block_recheck`。
   - d. Node 的 `accountStateService` 降级为只写展示元数据；`account_state.status/runtime_state`
     停止写入，读路径切 `account_ui_state.status`。
3. **回归守卫**
   - 用现有 `test/account-state*.test.js` 的事件矩阵生成 Go 表驱动测试，逐条对照 Node 期望。
   - 真机并行期：Node 计算值与 Go 计算值逐账号比对，出现分歧先修 Go 再切读。
4. **删除目标**：`lib/account/status-file.js`、`lib/account/state-sync-policy.js`、
   `lib/account/runtime-state-builders.js`、`lib/account/state-service.js` 的 status 分支，
   以及 `webui-account-live.js` 中对应的本地推导。

## 8. 迁移边界（2026-11-05 复核）

两个看似可继续「删 Node」的入口，实际被上游依赖卡住，先记录清楚，避免下一轮重复尝试：

1. ✅ **`account_state.runtime_state` 写入已切换（2026-11-05，切片 25）**。
   原阻塞是「选号器在请求热路径同步读这份状态，而 Go 的 blocks 是 15 秒镜像」。
   解法不是让 Node 每请求读 Go 的库，而是双层：进程内 Map 持有本进程最新值（写后立即可读），
   Go 是跨进程/跨重启的持久化真相；读取按「内存 → Go 文档 → 旧列」合并。
   Node 服务端不再写本地 `runtime_state` 列，CLI 写入经服务端管理接口汇入同一漏斗。
   剩余：旧列仍保留一版作为回滚快照，删除列需要 app-state.db 的一次性迁移与回滚计划。
2. **模型目录不能按 Provider 直接搬**。Go 的 `account_models` 目前覆盖 8 个 Provider
   （codebuddy 家族、codex、agy、qoder、cline），缺 zcode / kiro / claude / opencode；
   根因是 Go 解不开这些 Provider 的凭据（zcode `enc:v1`、kiro 形态），模型发现无法在 Go 内完成。
   前置是补 codec，而 codec 又依赖 Node 的解密能力迁移。

因此后续优先项应改为：
- 先把 zcode/kiro 的 codec 与凭据解密迁 Go（这是模型目录、额度探测、路由的共同前置）。
  - ✅ zcode `enc:v1` 解密已迁 `internal/adapters/accounts/zcodecred`（AES-256-GCM，
    与 Node 的 `enc:v1:<nonce>.<tag>.<ciphertext>` 及本机派生密钥同公式；用 Node 生成的
    向量做回归），并挂进 native codec：zcode 凭据在 decode 前先解密。
  - 注意：线上 zcode 凭据在 Go 库里已经是明文（Node 同步前已解密），该钩子主要服务
    导入/遗留数据。
  - **zcode 没有 refresh token**（`zcode-credential.js` 明确：OAuth 计划账号无 refresh，
    jwt 过期只能重新登录导入）。因此「zcode token 刷新迁 Go」不是一项可做的迁移；
    `PUT /usage` 的 CAS 路径返回 500 是 `ResolveCredential` 对无刷新能力 Provider 的拒绝，
    额度事实应走 `collected=true`。真正缺的是 zcode 的 usage/model **策略**，不是刷新。
- 再谈模型目录与 Node 写入的删除；
- WebUI 账号页/静态托管/Chat/PTY/SSH/插件按 P3–P5 单独排期。
