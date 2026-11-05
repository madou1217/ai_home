# WebUI 模型缓存切换到 Go account_models（2026-11-06）

> 状态：方案（只读分析，未改代码、未提交）
> 基线：`main` @ `75eda502`（分析时 `a6c25ea1`；`75eda502` 由并发任务修复 opencode 双腿完整性，并把本方案一并提交）
> 说明：本文档的实测数字来自 `a6c25ea1` 时的数据库状态；`75eda502` 只改了 opencode 发现策略，不回填存量行
> 目标：WebUI 的模型目录读取从 Node 探测快照切到 Go `aih.db.account_models`，前端响应形状不变
> 非目标：不改 Go 推理路由；不在 Phase 1 退役 Node 探测；不改 Node→Go 的公共 model-catalog 投影

## 0. 结论（可执行答案）

1. **切换点不在前端，也不在 `webui-model-cache.js` 内部**，而在三个读入口对 `catalogResult` 生产者的调用：`webui-openai-model-routes.js:607`、`webui-openai-model-routes.js:881`、`webui-project-routes.js:182`。把 `getWebUiModelsCache()` 换成返回同一 `catalogResult` 形状的 Go 投影读取器，下游 `buildCatalogModelEntries` / `buildManagedModelItems` / `buildModelAccountRefProjection` 全部不动。
2. **必须先做 Go 侧五件前置**：Node→Go 账号 ref 映射、批量读端点、探测事实（last_attempt/last_error/last_model_count/source）、目录 generation、多腿目录的 incomplete 语义。其中多腿完整性已由 `75eda502` 采用 fail-closed 关闭（见 §2.4 P0-4）；其余四件仍未落地。缺任何一项都会产生可见回归。
3. **不能只切管理页**：`GET /v0/webui/openai-models`（模型管理页）与 `GET /v0/webui/models`（会话/项目模型选择器）必须同源；只切一个会让两个页面看到不同模型集合。
4. **不能顺手删 Node 探测**：`state.webUiModelsCache` 同时服务 Node 推理路由、`/v1/models`、别名预检、CLI 补全、Claude harness 的 context window。本方案 Phase 1 只切 WebUI 管理面读取，Node 探测保留为回退与对照。
5. **缓存失效以 Go 为真值**：Node 只保留「短 TTL 投影 + ETag + 首屏持久化投影」；Go 侧后台重扫/路由未命中刷新通过 generation 条件 GET 被动发现，不要求 Go 反向通知 Node。
6. **本机实测不是零差异**：43 个账号里 29 个模型集合完全一致；13 个账号 Go 已覆盖而 Node 快照没有（净 +92 个模型）；1 个 opencode 账号 Go 少 41 个 `opencode/*` 模型（单腿失败被当成完整目录，已由 `75eda502` 改为 fail-closed）。存量行仍要等一次成功刷新回填，切换门禁见 §5 Step 9。

## 1. 现状调用链

### 1.1 前端入口

| 页面 | 调用 | 位置 |
| --- | --- | --- |
| 模型管理页（全局） | `modelsAPI.listOpenAICompatible({})` | `web/src/pages/Models.tsx:128`、`web/src/features/models/use-model-catalog-page.ts:79` |
| 模型管理页（单账号） | `modelsAPI.listOpenAICompatible({ accountRef })` | `web/src/features/models/use-account-models.ts:77` |
| 单账号「刷新模型」 | `modelsAPI.refreshOpenAICompatible({ accountRef })` | `web/src/features/models/use-account-models.ts:133` |
| 账号页自动探测 | `modelsAPI.refreshOpenAICompatible(...)` | `web/src/features/accounts/useModelCatalog.ts:169` |
| 会话/项目模型选择器 | `GET /webui/models` | `web/src/services/api.ts:1690` 附近的 `fetchWebUiModels` |

前端只认 `WebUiOpenAIModelsResponse`（`web/src/types/index.ts:936`）。只要服务端保持这个形状，前端无需改。

### 1.2 Node 读路径

```
GET /v0/webui/openai-models
  -> web-ui-router.js:885
  -> webui-openai-model-routes.js:580 handleGetOpenAIModelsRequest
  -> :607 getWebUiModelsCache(state, options, { accountScope, ... })
  -> webui-model-cache.js:1011 getWebUiModelsCache
       :310 ensureWebUiModelsCacheLoaded
       :245 readPersistedWebUiModelsCache  (app-state KV: cache:webui-models-snapshot.json)
       :992 buildWebUiModelsCacheResult    (byAccount / errorsByAccount / accountProbedAt / labels)
  -> :607 之后的 buildModelEntrySets
       :217 buildCatalogModelEntries       (byAccount + availableModels/descriptors + retained + manual settings + gateway entries)
       :500 buildManagedModelItems         (enabled/default/manual/customPricing/description)
  -> webui-model-account-ref-projection.js:66 buildModelAccountRefProjection
  -> JSON { ok, cached, updatedAt, source, data, managedData, accounts, byProvider, byAccountRef, errorsByAccountRef, accountProbedAt, labels, ... }
```

`GET /v0/webui/models` 走同一套缓存：

```
web-ui-router.js:843
  -> webui-project-routes.js:152 handleGetModelsRequest
  -> :182 getWebUiModelsCache
  -> buildModelAccountRefProjection -> selectableByAccountRef/defaultByAccountRef
```

关键事实：

- `getWebUiModelsCache` 默认**不探测**：只要 `cache.updatedAt > 0` 就直接返回缓存（`webui-model-cache.js:1011-1030`）。探测只发生在显式刷新、后台调度器、或缓存为空/冷账号强制探测时。
- 快照持久化在 Node 的 app-state KV：`webui-cache-store.js:31` -> key `cache:webui-models-snapshot.json`。它不是 Go 的 `aih.db`。
- `WEBUI_MODELS_CACHE_TTL_MS = 10 分钟`（`webui-model-cache.js:21`）只被 `chat-harness-model-reader.js:50` 使用；WebUI GET 本身不看这个 TTL。
- HTTP 层还有 3 秒响应缓存 + ETag：`webui-openai-model-routes.js:52`、`:821-838`。

### 1.3 刷新与后台探测

显式单账号刷新：

```
POST /v0/webui/openai-models/refresh?accountRef=...
  -> webui-openai-model-routes.js:1002 handleRefreshOpenAIModelsRequest
  -> :967 startModelCatalogRefreshJob
  -> :875 runModelCatalogJob
  -> webui-model-cache.js:821 refreshWebUiModelsCache
  -> provider-model-discovery.js:236 discoverProviderModels
  -> :332 fetchModelsForAccount(...) 逐账号探测（Node 侧的 provider HTTP handler）
  -> mergeByAccountCache / mergeByProviderCache / mergeErrorsByAccount
  -> writePersistedWebUiModelsCache
```

后台调度器（`webui-model-refresh-scheduler.js`）：

- 用户活跃窗口 2 分钟，探测间隔 45 秒–3 分钟；空闲 5–60 分钟。
- 每个 tick 最多 3 个账号；失败退避 10 分钟；冷账号优先。
- 账号启用/导入/凭据变更会插队探测。
- 探测结果同时写入 `state.webUiModelsCache`，供推理路由和 WebUI 共用。

### 1.4 Go 侧现状

写入：

| 入口 | 位置 | 行为 |
| --- | --- | --- |
| 单账号显式刷新 | `application/accounts/model_management.go:172`；HTTP `POST /v1/management/accounts/{ref}/models/refresh` | 读凭据 → 必要时刷新 → Provider 发现 → 原子替换上游发现部分 |
| 启动首次恢复 | `internal/host/aihserver/initial_model_refresh_recovery.go` | 异步扫描「有凭据但从未物化过模型」的已启用账号并入队 |
| 6 小时全量重扫 | `internal/host/aihserver/model_refresh_sweep_worker.go:12-19` | 每 6 小时把已启用账号入队；只入队不等待 |
| 路由未命中触发 | `application/accounts/route_miss_model_refresh.go` | 同 Provider 最小间隔 5 分钟 |
| 账号生命周期装饰器 | `application/accounts/model_refresh_lifecycle.go` | 注册/重登/静态凭据轮换后触发 |

读取：

| 入口 | 位置 | 返回 |
| --- | --- | --- |
| 单账号模型 | `GET /v1/management/accounts/{ref}/models`；`accountsapi/handler.go:998` | `[{model_id, upstream_available, manual_policy, effective, updated_at}]` |
| 账号列表 | `GET /v1/management/accounts`；`contracts.go:138` | 含 `provider_id/enabled/display_name/email/model_summary{stored_count,effective_count,updated_at}` |
| 可路由模型 | `GET /v1/models`；`modelsapi` | 只含 effective 模型 |
| 公共目录投影 | `GET/PUT /v1/management/model-catalog` | Node→Go 的展示元数据，**不是**账号级发现 |

存储：

- 表 `account_models`（`internal/adapters/accounts/sqliteaccount/schema_v2.sql:1`）：`account_ref, model_id, upstream_available, manual_policy, updated_at_ms`，主键 `(account_ref, model_id)`。
- 写路径：`sqliteaccount/model_store.go:18` List、`:53` ReplaceDiscovered、`:224` SetManualPolicy。
- 路由索引：`sqliteaccount/routing_index.go:55`，只把 `EffectiveModelIDs` 投影到进程内倒排。
- Provider 发现注册表：`internal/host/aihserver/model_providers.go:59`，12 个模块覆盖 16 个 Provider。
- 刷新协调器：`composition.go:391`；单 Provider 并发 1，刷新超时 20 秒，失败退避 1 秒→1 分钟，最多 8 次（`inference.go:37-44`）。

Go 侧**没有**的东西（与本方案直接相关）：

1. 没有「上次探测时刻 / 上次错误 / 上次是否为空」的持久化事实。刷新失败只写 `go-core.log`（`composition.go:1305` 的 observer）。
2. 没有目录 generation/版本号，无法给 Node 做条件 GET。
3. 没有批量读取所有账号模型的端点；现有只有逐账号 GET。
4. 当前 HEAD 的 opencode 已改为 fail-closed：两条腿任意一条失败就返回错误，不再把部分并集写进 `account_models`（`75eda502`）。在这之前，`succeeded` 分支会把半份目录整体替换，本机实测丢过 41 个 `opencode/*` 模型。`ProviderModelDiscoverer` 接口本身仍不携带 incomplete 语义；如果将来要「一条腿成功也更新另一条腿」，需要 §2.4 P0-4 的可选接口。
5. 重扫只覆盖 `enabled = 1` 的账号（`model_refresh_sweep_store.go:15-24`、`initial_model_refresh_recovery_store.go:16-30`）。

### 1.5 两条链不要混

- **账号级发现链**：Provider 探测 → `account_models` → Go 路由索引 → 本方案要读的东西。
- **公共目录投影链**：Node 的完整展示目录 → `PUT /v1/management/model-catalog` → Go 的 `/v1/models` 展示。它不含账号级事实，不能拿来替代 `account_models`。

迁移矩阵（`docs/plans/2026-11-05-migration-matrix.md:139`）已经写明：「公共模型目录仍归 Node」「Go 的 account_models 只是可路由索引」「两条链不能一次切」。本方案只动第一条链的**读取侧**。

### 1.6 本机实测基线（2026-11-05 18:48，只读）

数据源：`~/.ai_home/aih.db`（Go）与 `~/.ai_home/app-state.db` 的 `cache:webui-models-snapshot.json`（Node）。Node 快照 `updatedAt=2026-11-05T10:26:54Z`。

| 指标 | Node 快照 | Go aih.db |
| --- | --- | --- |
| 账号身份 | 43 个 Node ref | 43 个 Go ref |
| 有模型列表的账号 | 26 | 39 |
| 模型条目总数 | 629（byAccount 逐账号去重后） | 680 行 |
| 已启用账号 | — | 32 |
| ref 完全相同 | — | 38/43；5 个 Node↔Go 不同，`go-account-sync:state.links` 有完整映射 |

按 `links` 把 Go ref 还原成 Node ref 后逐账号比较：

- 29/43 模型集合完全一致。
- 13/43 是 Go 领先，合计 92 个模型：
  - 6 个 agy 账号（全部 `enabled=0`）各 12 个，共 72；
  - 2 个 cline 账号（`enabled=0`）各 2 个，共 4；
  - 1 个 zcode 账号 12 个 + 4 个 zcode 账号各 1 个，共 16。
- 1/43 是 Node 领先：一个 opencode 账号 Node 109 个、Go 68 个，少的 41 个**全部是 `opencode/*`（Zen 腿）**，见 §4.1。
- 4 个 Go 账号没有任何模型行：2 个停用的 claude/gemini 占位账号；2 个已启用的 zcode 账号，日志持续报 `zcode 模型目录为空`。
- 680 = 629 − 41 + 92，差异可完全解释。

Node 快照只有 26 个账号有 `byAccount` 条目，剩下 17 个账号在页面上会回落到 `account.availableModels`/descriptors，因此上表是「探测快照 vs Go 行」的比较，不等于页面最终条数。

## 2. 精确切换点

### 2.1 原则：只替换 catalogResult 的生产者

`handleGetOpenAIModelsRequest` 把 `getWebUiModelsCache(...)` 的结果当作 `catalogResult` 传给后续纯函数。`catalogResult` 的形状是：

```js
{
  cached: boolean,
  updatedAt: number,
  source: 'remote' | 'local' | 'error' | 'empty',
  sourceCount: number,
  scannedAccounts: number,
  firstError: string,
  models: { [provider]: string[] },
  byAccount: { [accountRef]: string[] },
  errorsByAccount: { [accountRef]: string },
  accountProbedAt: { [accountRef]: number },
  labels: { [provider]: { [modelId]: displayName } }
}
```

只要新读取器返回同一形状，`buildCatalogModelEntries`、`buildManagedModelItems`、`buildModelAccountRefProjection`、job/SSE、前端全部不变。**这是本方案最重要的边界**。

### 2.2 新增模块

新增 `lib/server/webui-model-catalog-go.js`（名字可调整），只做投影与缓存，不把 Go 细节漏到路由层：

```js
// 读：返回与 getWebUiModelsCache 同形的 catalogResult
async function getWebUiModelCatalog(state, options, deps) {}

// 刷新：先让 Go 刷新指定账号/全部，再读回投影
async function refreshWebUiModelCatalog(state, options, deps) {}

// 失效：按 Node accountRef 失效；空数组表示全部
function invalidateWebUiModelCatalog(state, accountRefs) {}

// 首屏：启动时同步加载持久化投影；后台再拉 Go
function loadPersistedGoModelCatalog(state, deps) {}
```

依赖只从 `deps.goCoreSync` 取，不直接拿 `goCoreHost`。新增到 `lib/server/go-core-sync-facade.js` 的 `FACADE_METHODS`：

- `readGoAccountModels(query)`：批量读 `GET /v1/management/account-models`。
- `refreshGoAccountModels({ accountRef, provider })`：单账号同步刷新或全局入队刷新。
- `setAccountModelPolicy(nodeRef, modelId, policy)`：WebUI 写路径的 write-through。
- `readGoRefsByNodeRef()`：一次读取 Node→Go ref 映射。

对应在 `lib/server/go-core-host.js` 实现并加入返回对象。`server.js` 不需要改。

`lib/account/go-bridge/go-management-client.js` 的 `call()` 目前不支持额外请求头；批量读需要加一个最小的 `extraHeaders` 选项（只给 `If-None-Match` 用），并在 `status === 304` 时把 `data` 保持为 `null` 而不是错误。

### 2.3 逐文件改动点

#### A. 三个读入口

```diff
// lib/server/webui-openai-model-routes.js:607
- const result = await getWebUiModelsCache(state, options, {
+ const result = await getWebUiModelCatalog(state, options, {
      accountScope,
      fs: ctx.fs || deps.fs,
      aiHomeDir: ctx.aiHomeDir || deps.aiHomeDir,
-     fetchModelsForAccount: deps.fetchModelsForAccount,
-     accountStateService: deps.accountStateService
+     goCoreSync: deps.goCoreSync
  });
```

```diff
// lib/server/webui-openai-model-routes.js:881（刷新作业）
- const result = await getWebUiModelsCache(ctx.state, ctx.options, {
-   forceRefresh: true,
+ const result = await refreshWebUiModelCatalog(ctx.state, ctx.options, {
      accountScope: job.accountScope,
-   probeCodex: job.probeCodex === true,
-   timeoutMs: WEBUI_MODELS_REFRESH_TIMEOUT_MS,
-   ...
+   timeoutMs: 30_000
  });
```

```diff
// lib/server/webui-project-routes.js:182
- const result = await getWebUiModelsCache(state, options, {...});
+ const result = await getWebUiModelCatalog(state, options, {...});
```

注意：`webui-project-routes.js:175-181` 的 `forceScopedProbe = accountScopeNeverProbed(...)` 是 Node 探测语义，Go 路径下应改为「Go 从未 attempt 过就后台入队」，见 §3.3；不要保留 Node 的强制探测。

#### B. 写路径

`webui-openai-model-routes.js` 的三个写入口：

| 位置 | 写完后 |
| --- | --- |
| `:673` createManual | `await goCoreSync.setAccountModelPolicy(nodeRef, modelId, 'force_enable')`；失败则记录 dirty，15 秒对账兜底 |
| `:721` update | `enabled=false` → `force_disable`；`enabled=true` 且 `manual=true` → `force_enable`；其余 → `inherit` |
| `:774` deleteManual | `inherit`（Go 端会删除 `upstream_available=0 AND manual_policy=inherit` 的空行） |

写完后调用 `invalidateWebUiModelCatalog(state, [accountRef])` 和现有的 `clearModelResponseCache(state)`。**写路径不能只依赖 15 秒一次的 `go-account-sync`**（`go-account-sync.js:35`，默认 15 秒），否则用户刚关掉模型，页面下一次 GET 从 Go 读回来又会变成启用。

#### C. 设置优先级（Go policy 覆盖默认值）

`buildManagedModelItems`（`:500`）与 `isAccountModelEnabled`（`model-catalog-settings-store.js:279`）目前只看 Node settings，缺省 `enabled=true`。切到 Go 后需要把 Go 的 `manual_policy` 传进来：

```text
settings 有显式记录        -> 以 settings.enabled 为准（用户刚点的值）
否则 go.policy=force_disable -> false
否则 go.policy=force_enable  -> true
否则                        -> true（缺省启用）
```

建议在 `catalogResult` 增加可选字段 `policiesByAccount: { [accountRef]: { [modelId]: policy } }`，只改 `buildManagedModelItems` 一个函数；不要改 `isAccountModelEnabled` 的公共签名，避免影响其它调用方。这里的「settings 有显式记录」指 setting 对象里确实有 `enabled` 字段；只有 `defaultModel`/`description`/`customPricing` 的记录不算，否则会把 Go 的 force_disable 覆盖回启用。

#### D. labels

`labels` 来自 Node 运行态账号的 descriptors（`webui-model-cache.js:154-181` 的 `collectAccountModelLabels`），不是 Go。把 `collectModelDisplayLabels` 从 `webui-model-cache.js` 导出，Go 适配器复用它；否则 kimi 这类 `display_name` 与 id 不同的模型会在页面上退化成裸 id。

#### E. retainedByAccount

`buildCatalogModelEntries`:249 在 `catalogResult.retainedByAccount` 缺失时回落到 `state.webUiModelsCache.retainedByAccount`。Phase 1 保持这个回落即可：Node 探测仍在跑，停用/删除账号的留档目录继续由 Node 快照提供。Phase 2 再决定是否在 Go 里保留一份删除账号目录。

### 2.4 Go 侧前置（P0，必须先落地）

#### P0-1 批量读端点

新增 `GET /v1/management/account-models`（集合在现有 `accountsapi` 或新 handler 均可，建议沿用 `accountsapi` 的管理鉴权）：

```json
{
  "data": [
    {
      "account_ref": "acct_...",
      "provider_id": "opencode",
      "enabled": true,
      "last_attempt_at_ms": 1793874527089,
      "last_success_at_ms": 1793874527089,
      "last_error_code": "",
      "last_error_message": "",
      "last_source": "remote",
      "last_model_count": 68,
      "models": [
        {
          "model_id": "opencode/gpt-5.6",
          "upstream_available": true,
          "manual_policy": "inherit",
          "effective": true,
          "updated_at_ms": 1793874527089
        }
      ]
    }
  ],
  "generation": 123,
  "updated_at_ms": 1793874527089
}
```

- 过滤：`provider`、`account_ref`（可重复）、`after_ref`、`limit`（默认 200，最大 1000）。
- 一次 SQL 完成 `accounts LEFT JOIN account_models`，按 `account_ref, model_id` 排序；同一读事务内读 generation，保证快照一致。
- 零模型账号也必须返回（`models: []`），否则 Node 无法区分「从未探测」与「探测过但为空」。
- 响应加 `ETag: "amc-<generation>"`；`If-None-Match` 命中返回 304。
- 失败错误码沿用 `accountsapi` 的 `writeApplicationError` 风格，不泄露凭据。

#### P0-2 探测事实表（schema v21）

新增 `account_model_probes`：

```sql
CREATE TABLE account_model_probes (
  account_ref TEXT PRIMARY KEY,
  last_attempt_at_ms INTEGER NOT NULL DEFAULT 0,
  last_success_at_ms INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT NOT NULL DEFAULT '',
  last_error_message TEXT NOT NULL DEFAULT '',
  last_source TEXT NOT NULL DEFAULT '',
  last_model_count INTEGER NOT NULL DEFAULT 0,
  last_incomplete INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (account_ref) REFERENCES accounts(account_ref) ON DELETE CASCADE
) STRICT;
```

写点放在 `application/accounts/model_management.go:172` 的 `RefreshAccountModels`：

- 发现前：`last_attempt_at_ms = now`；保留上一次 error，直到本次成功。
- 成功：`last_success_at_ms = now`、清空 error、`last_model_count = len(models)`、`last_source = StrategySource()`。
- 失败（含空目录）：只写 `last_error_code/last_error_message`；**保持上一次的 `last_success_at_ms` 与 `last_model_count` 不变，也不要删除旧行**。
- 部分成功（incomplete）：`last_incomplete = 1`、记录原因；不要整体替换。

这张表同时解决 WebUI 的三个字段：`accountProbedAt`、`errorsByAccount`、`source`。不要用 `account_models.updated_at_ms` 当探测时间：人工策略写入也会更新它（`SetManualModelPolicy` 写 `updated_at_ms`），会把「刚改过开关」误判成「刚探测过」。

#### P0-3 目录 generation

新增单行表 `account_model_catalog_state(id=1, generation, updated_at_ms)`，在同一事务里与 `account_models` 的以下写入一起自增：

- `ReplaceDiscoveredModelsIfCredentialVersion`
- `SetManualModelPolicy`
- 账号创建/导入（新账号即使没有模型行，也会改变批量投影的账号集合）
- 账号删除（级联删除模型行，不会经过 model store）
- 账号启停（如果投影包含 `enabled`）

Node 用 generation 做 ETag 和投影缓存键；这样即使删除了一行旧模型、`MAX(updated_at_ms)` 没变，也能被发现。

#### P0-4 多腿目录的 incomplete 语义（已由 `75eda502` 关闭，Phase 1 不需要再实现）

`75eda502` 选择的是更简单的方案：opencode 两条腿任意一条失败就返回错误，整次刷新失败并保留旧行，不再用半份并集替换。这满足「不把残缺目录当结论」的要求；代价是一条腿抖动时整次刷新要等下次重试。

如果以后希望「一条腿成功也更新另一条腿」，再考虑下面的可选接口（不要改 `ProviderModelDiscoverer` 的全局签名，16 个 Provider 都要改，违背「新增 Provider 不改公共文件」的既有约束）：

```go
type ProviderModelDiscovererWithCompleteness interface {
    DiscoverModelsWithCompleteness(ctx context.Context, credential Credential) (ModelDiscoveryResult, error)
}

type ModelDiscoveryResult struct {
    Models     []string
    Complete   bool
    Reason     string
}
```

只有 opencode 实现它：两条腿都成功 → `Complete=true`；只成功一条 → `Complete=false`，`Reason=opencode_catalog_incomplete(<leg>)`。`ModelDiscovery` 发现 strategy 实现该接口时优先调用；否则按原接口调用并视为 `Complete=true`。

只有实现该接口的 strategy 才需要返回 `Complete`；`ModelManagement.RefreshAccountModels` 可以按 `Complete` 决定是否整体替换：

- `Complete=true`：沿用现在的「清空旧 upstream 标记 → upsert 新集合 → 删除 inherit 且缺失的行」。
- `Complete=false`：只 upsert 本次返回的模型，**不删除**未返回的旧行；把 `last_incomplete=1`。

Phase 1 以 fail-closed 为准，不需要 `Complete=false` 的部分写入路径；这段是未来选项。

#### P0-5 Node→Go ref 映射

Node 侧现成的 `goCoreHost.goRefsByNodeRef()`（`go-core-host.js:154-161`）返回整张映射。适配器必须：

1. 先建 `goRef -> [nodeRef...]` 的反向表（一个 Go 账号可能对应多个 Node 账号，见 `go-account-sync.js:117-119`）。
2. 把 Go 行的模型 fan-out 到每个 nodeRef。
3. 找不到映射的 Go 账号：忽略（它不是当前页面上的账号）。
4. 找不到映射的 Node 账号：Phase 1 回落到 Node 快照/`availableModels`，并标 `source='node-fallback'`；Phase 2 收紧为「未同步账号」提示。

实测 5/43 的 ref 不同（见 §1.6）。如果直接拿 Go ref 当页面 key，这 5 个账号会整块消失，同时多出 5 个孤儿账号。

### 2.5 数据映射表

| Go 事实 | WebUI 字段 | 规则 |
| --- | --- | --- |
| `models[].model_id`（所有行） | `byAccount[ref]` 的展示集合 | 管理页要看到停用/人工行；`effective` 不用于过滤展示 |
| `models[].upstream_available` | 行级状态/诊断 | 不直接映射为 enabled；force_disable 的行仍要展示为「停用」 |
| `manual_policy=force_enable` | `manual=true`、`enabled=true` | 人工补充的模型 |
| `manual_policy=force_disable` | `enabled=false` | Go 策略优先于 settings 缺省 |
| `last_attempt_at_ms` | `accountProbedAt[ref]` | 没有 attempt 才是「待探测」 |
| `last_error_message` | `errorsByAccount[ref]`、`firstError` | 失败但保留旧模型时仍展示旧模型 + 错误标签 |
| `last_model_count=0` 且 `last_success` 有值且 error 为空 | 「未发现模型」 | 与「待探测」区分；空数组要显式写入 `byAccount[ref]=[]` |
| `last_source` | `source/sources` | 映射到现有 `remote/local/error/empty` 词汇，避免模型页 LED 语义变化 |
| 全局 `generation` | `cached/ETag` | GET 读投影 `cached=true`；刚刷新返回 `cached=false` |
| `models` 并集 | `models[provider]` | 仅供 `buildCatalogModelEntries` 的兜底分支使用 |

### 2.6 不采用的方案

| 方案 | 为什么不 |
| --- | --- |
| 直接把 `getWebUiModelsCache` 改成读 Go | 会同时影响别名校验（`webui-model-alias-routes.js:54`）、请求路径探测（`upstream-endpoints.js:429`）、`/v1/models`、CLI 补全、harness；爆炸半径远超 WebUI |
| Node 逐账号 `GET /accounts/{ref}/models` | 43 个账号已经 43 次调用；10k 账号不可用，且首屏会被 N+1 拖慢 |
| 直接把 Go `account_ref` 当页面 ref | 5/43 不同，实测会丢账号/多孤儿 |
| 用 `model_summary.updated_at` 当探测时间 | 策略写入也会更新，会把「刚改开关」显示成「刚探测」 |
| 直接读 Go 的 `aih.db` 作为生产读路径 | 可以做为 Phase 1 的临时降级，但会把 Node 锁死在 Go 表结构上；长期仍应走管理 API。见 §3.6 |

## 3. 缓存失效策略

### 3.1 三层缓存

| 层 | 位置 | 作用 | 失效方式 |
| --- | --- | --- | --- |
| L1 Go `aih.db.account_models` | Go 进程 | 唯一真值；可路由索引 | 发现刷新、人工策略、账号删除/启停 |
| L2 Node 投影 | `state.webUiModelCatalogGo` + app-state KV | 首屏/短 TTL 读缓存；把 Go 行投影成 `catalogResult` | generation 变化、WebUI 写、账号事件、TTL |
| L3 HTTP 响应 | `state.modelCatalogLive.responseCache` | 3 秒内同一 scope 直接返回 + ETag | 现有 `clearModelResponseCache` + TTL |

### 3.2 读路径与首屏

目标不是「每次请求读 Go」，而是「首帧用本地投影，后台补 Go」：

1. 进程启动时（`server.js:799` 的 `ensureWebUiModelsCacheLoaded` 旁边）同步加载上一次成功投影到 `state.webUiModelCatalogGo`，标记 `stale=true`。
2. 第一次 WebUI GET：
   - 有持久化投影 → 立即返回（`cached=true, source='go-stale'`），同时触发一次后台 Go 拉取；
   - 没有投影 → 返回空目录 + `source='empty'`，同时后台拉取；不阻塞首帧。
3. 后续 GET：
   - 内存投影年龄 < 3 秒 → 直接返回；
   - 否则条件 GET（`If-None-Match: "amc-<generation>"`）：
     - 304 → 复用投影，刷新年龄；
     - 200 → 替换投影、异步落盘、清空该 scope 的 HTTP 响应缓存。
4. 单飞：同一 scope 同时只允许一个 Go 拉取；并发请求复用同一个 Promise 或直接读旧投影。

这条规则与现有「列表先出内容再异步补数据」的体验约束一致；不要为了拿 Go 的实时数据把首屏卡住。

### 3.3 失效事件矩阵

| 事件 | 动作 | 失效范围 | 用户可见 |
| --- | --- | --- | --- |
| WebUI create manual | 保存 settings → `setAccountModelPolicy(force_enable)` → 失效投影 → 清响应缓存 | 该 accountRef | 新模型立即出现 |
| WebUI update enabled/default/pricing | 保存 settings → 按映射写 Go policy → 失效投影 → 清响应缓存 | 该 accountRef | 开关立即生效；pricing 只影响 Node |
| WebUI delete manual | 保存 settings → `inherit` → 失效投影 → 清响应缓存 | 该 accountRef | 行立即消失/变回未发现 |
| 单账号「刷新模型」 | Go 同步刷新 → 读回投影 → 清响应缓存 | 该 accountRef | SSE job 完成后新目录 |
| 全局「刷新模型」 | Go 批量入队（不等待）→ 202 | 全部 | 后续 GET 按 generation 变化逐步出现 |
| 账号启用/停用 | Go 行不变；失效该账号投影（enabled 变了） | 该 accountRef | 停用后仍可管理模型，标记「已关闭」 |
| 账号导入/重登/rekey | `reconcileAccounts` 更新 links → 失效映射缓存与投影 | 该 nodeRef 或全部 | 新 ref 立即可见 |
| 账号删除 | Go 级联删模型行 → 失效投影；Phase 1 保留 Node retained 目录 | 该 accountRef | 行消失，留档按现有逻辑 |
| 凭据失效/认证失败 | 失效该账号投影；后台入队 Go 刷新；旧模型先保留 | 该 accountRef | 先看到旧模型 + 错误标签，成功后更新 |
| Go 后台 6h 重扫 | generation +1 | 变化账号 | 下一次 GET 最多 3 秒后看到 |
| 路由未命中触发 | generation +1 | 该 Provider | 同上 |
| Go Core 不可用 | 继续服务持久化投影，`source='go-stale'`、`cached=true` | 全部 | 页面可用 + 一条降级提示；不要 500 |
| Go Core 恢复 | 后台拉取 → 替换投影 | 全部 | 自动恢复 |

### 3.4 新鲜度预算

| 项 | 值 | 说明 |
| --- | --- | --- |
| HTTP 响应缓存 | 3 秒 | 现有 `MODEL_RESPONSE_CACHE_TTL_MS`，保留 |
| Node 投影内存 TTL | 3 秒 | 与响应缓存对齐；避免每请求打 Go |
| Node 持久化投影 | 只用于首屏/降级；超过 24 小时标 `very_stale` | 不把一周前的目录当实时 |
| Go 周期重扫 | 6 小时 | 现有；用户主动刷新不受限 |
| Go 路由未命中 | 最小 5 分钟/Provider | 现有 |
| Node 原探测调度 | Phase 1 保留，45 秒–60 分钟 | 继续服务路由/CLI，不再喂 WebUI |

### 3.5 回滚

拟新增配置项 `modelCatalogSource: 'node' | 'go'`（`lib/server/server-config-schema.js` 注册，flag `--model-catalog-source`；未实现前用 `deps.modelCatalogSource` 注入做测试）。不新增任何 Go 侧 `AIH_*` 环境变量；Go 只提供服务端事实，开关属于 Node 宿主配置。

- Phase 1 默认 `node`，Go 路径先影子运行/双读；
- Phase 2 默认 `go`，保留 `node` 回滚；
- 回滚只需改配置 + 重启，**不迁移数据**：Node 快照在 Phase 1/2 仍在写，Go 行不动。
- 回滚后用户可能看到模型集合变化（Go 与 Node 的差异），这是预期；双读报告负责解释。

### 3.6 可选降级：直接读 Go SQLite

如果批量 HTTP 端点来不及先上，可以临时在 Node 用只读 SQLite 读 `aih.db`：

- 现有先例：`lib/account/go-bridge/go-account-store-reader.js` 已经只读 `account_models` 的 `manual_policy`。
- 优点：零 Go API、单查询、无 N+1；43 账号 680 行是微秒级。
- 缺点：Node 绑定 Go 表结构；WAL/锁竞争；跨机器（SSH peer）不成立；没有 generation（只能短 TTL）。
- 定位：只作为 Phase 1 的应急开关，不作为目标架构；一旦批量端点上线即删除。

## 4. 回归风险

### 4.1 P0：切换前必须关闭

| # | 风险 | 证据 | 缓解 | 守卫 |
| --- | --- | --- | --- | --- |
| 1 | Node↔Go ref 不一致导致账号丢失/孤儿 | 本机 43 对 43，5 个 ref 不同；`go-account-sync:state.links` 43 条 | 适配器用 `goRefsByNodeRef` 建反向表并 fan-out | 单测覆盖 5 个真实映射 + 多对一；上线前断言「未映射 Node 账号 = 0」 |
| 2 | opencode 单腿失败被当作完整目录，目录从 109 缩到 68 | 实测 41 个缺失全是 `opencode/*`；`75eda502` 已改为 fail-closed | 已修复；存量 68 行需一次成功刷新回填 | 双读脚本对 opencode 账号断言「缺失 = 0」；Go 单测已覆盖一条腿 503 |
| 3 | 没有探测错误/空目录事实，UI 丢失「探测失败/未发现模型」 | Go 只有日志；2 个 enabled zcode 账号 0 行，日志报 `zcode 模型目录为空` | P0-2 探测事实表 | Go store 单测 + Node 映射单测 |
| 4 | settings 与 Go policy 15 秒同步窗口，开关会「弹回去」 | `go-account-sync.js:35` 默认 15 秒 | 写路径 write-through + settings 显式值优先 | 路由测试：PATCH 后 1 秒查 Go policy；失败路径标 dirty |
| 5 | 只切管理页导致两个页面目录不一致 | `/v0/webui/openai-models` 与 `/v0/webui/models` 是两个入口 | 两个入口共用同一适配器 | 快照测试：同账号两接口的 `byAccountRef` 交集/差集为 0 |

### 4.2 P1：需要明确取舍

| # | 风险 | 说明 | 缓解 |
| --- | --- | --- | --- |
| 6 | 停用账号不再重扫 | Go 重扫 SQL 只选 `enabled=1`；Node 对停用账号也可能探测 | 保留旧行；显式刷新可用；可选「停用账号 24h 一次低频发现」 |
| 7 | 一个 Go 账号被多个 Node 账号映射 | `go-account-sync.js:117-119` 明确允许 | fan-out + 每个 Node ref 独立 settings；UI 标注「共享身份」 |
| 8 | 手动模型/默认模型不在 Go | Go 只有 `force_enable` 行；`defaultModel`、description、customPricing 只在 Node | 保留 settings；默认模型每次校验 effective 集合，失效则清空并提示 |
| 9 | Provider 边界差异 | grok OAuth 不发现；kimi token 刷新依赖 Go；codex 原生/API Key 两模式；qoder wasm；agy wire | 双读按 Provider 报告；Go 未 attempt 的账号回退 Node |
| 10 | 展示名丢失 | `labels` 来自 Node descriptors，不在 Go | 导出 `collectModelDisplayLabels` 并在适配器复用 |
| 11 | `source` 语义变化影响模型页 LED | 页面判断 `catalog.source === 'remote'`（`Models.tsx:588`） | 映射到原词汇：remote/local/error/empty |
| 12 | 大小写敏感 id | qoder `Auto/Sonus` 与别家 `auto` 不同 | 全链路保留原始字符串，不做小写去重 |
| 13 | 空目录被 Go 当失败 | `NormalizeDiscoveredModels` 拒绝空数组 | 探测事实记 `empty_catalog`；保留旧行；UI 可显示「未发现模型」 |
| 14 | 大账号池 N+1/大响应 | 10k 账号不可能逐账号 GET | 批量端点 + keyset 分页 + Node 投影缓存；首屏不阻塞 |
| 15 | Go 同步刷新 20 秒超时 vs Node 15 秒 | `inference.go:37` `modelRefreshTimeout=20s` | Node 客户端/作业超时 30 秒；job 错误原样展示 |
| 16 | 删除账号的留档目录 | Go 级联删除行；Node `retainedByAccount` 保留 | Phase 1 继续读 Node retained；Phase 2 再决定是否加墓碑目录 |

### 4.3 P2：可接受/后续处理

- Go Core 未启用/重启窗口：返回持久化投影，不 500；页面显示降级提示。
- 回滚后目录差异：双读报告解释，不阻塞回滚。
- 观测：新增 `source/cached/generation` 到 access log 或 metrics，避免「页面少模型」时只能猜。
- Phase 2 把 Node 路由缓存也改成 Go 投影时，会触碰 `model-account-index`、`capability-router`、`/v1/models`；那是独立方案，不在本次范围。

## 5. 分步验证命令

> 注意：以下命令中的 `aih server restart` 会重启真实服务；本仓库同时跑着多个 agent，执行前先看 `git status` 和当前会话，避免打断别人的验证。jq 在本机不可用，统一用 Node 解析 JSON。

### Step 0：基线

```bash
cd /Users/model/projects/feature/ai_home
git status --short
git rev-parse --short HEAD

go test ./application/accounts ./internal/adapters/accounts/sqliteaccount \
  ./internal/transport/http/accountsapi ./internal/host/aihserver

node --test test/go-model-policy-sync.test.js \
  test/model-catalog-invalidation.test.js \
  test/chat-harness-model-reader.test.js
```

已知 `dbpool` 性能测试在本机偶发超标，不要用 `go test ./...` 作为本方案的基线。

### Step 1：ref 映射与两侧覆盖（只读）

```bash
AIH_DATA_DIR="${AIH_HOME_DIR:-$HOME/.ai_home}" node <<'EOF'
const { DatabaseSync } = require('node:sqlite');
const dir = process.env.AIH_DATA_DIR;
const app = new DatabaseSync(dir + '/app-state.db', { readOnly: true });
const go = new DatabaseSync(dir + '/aih.db', { readOnly: true });
const cache = JSON.parse(app.prepare("select value from app_kv where key='cache:webui-models-snapshot.json'").get().value);
const sync = JSON.parse(app.prepare("select value from app_kv where key='go-account-sync:state'").get().value);
const links = sync.links || {};
const nodeRefs = new Map(app.prepare('select account_ref, provider from account_refs').all().map(r => [String(r.account_ref), String(r.provider)]));
const goRefs = new Map(go.prepare('select account_ref, provider_id, enabled from accounts').all().map(r => [String(r.account_ref), r]));
const mismatches = Object.entries(links).filter(([nodeRef, link]) => nodeRef !== String(link.goRef));
console.log({ nodeRefs: nodeRefs.size, goRefs: goRefs.size, links: Object.keys(links).length, mismatches: mismatches.length });
const nodeOnly = [...nodeRefs.keys()].filter(r => !goRefs.has(r));
const goOnly = [...goRefs.keys()].filter(r => !nodeRefs.has(r));
console.log({ unmappedNodeRefs: nodeOnly.length, orphanGoRefs: goOnly.length });
const goBy = new Map();
for (const row of go.prepare('select account_ref, model_id from account_models').all()) {
  const ref = String(row.account_ref);
  if (!goBy.has(ref)) goBy.set(ref, new Set());
  goBy.get(ref).add(String(row.model_id));
}
let identical = 0, goAhead = 0, nodeAhead = 0;
for (const nodeRef of new Set([...Object.keys(cache.byAccount || {}), ...Object.keys(links)])) {
  const goRef = links[nodeRef] ? String(links[nodeRef].goRef) : nodeRef;
  const n = new Set(Array.isArray(cache.byAccount[nodeRef]) ? cache.byAccount[nodeRef] : []);
  const g = goBy.get(goRef) || new Set();
  const missingInGo = [...n].filter(id => !g.has(id)).length;
  const missingInNode = [...g].filter(id => !n.has(id)).length;
  if (!missingInGo && !missingInNode) identical += 1;
  if (missingInNode) goAhead += missingInNode;
  if (missingInGo) nodeAhead += missingInGo;
}
console.log({ identical, goAheadModels: goAhead, nodeAheadModels: nodeAhead });
EOF
```

当前基线应为：`mismatches=5`、`unmappedNodeRefs=0`、`identical=29`、`goAheadModels=92`。`nodeAheadModels` 在 opencode 存量行刷新前仍可能是 41；`75eda502` 修复后只要成功刷新一次，就应变成 0。切换门禁：`nodeAheadModels=0`，且每一处差异都能在报告里解释。

### Step 2：Go 存储与探测事实

```bash
AIH_DATA_DIR="${AIH_HOME_DIR:-$HOME/.ai_home}"
DB="file:${AIH_DATA_DIR}/aih.db?mode=ro"

sqlite3 "$DB" "select count(*) as accounts, sum(enabled) as enabled from accounts;"
sqlite3 "$DB" "select count(*) as rows, count(distinct account_ref) as accounts, sum(upstream_available) as upstream, sum(manual_policy<>'inherit') as manual from account_models;"
sqlite3 "$DB" "select a.provider_id, a.enabled, count(m.model_id) as models from accounts a left join account_models m on m.account_ref=a.account_ref group by a.account_ref order by models asc, a.provider_id limit 10;"
```

P0-2 落地后追加：

```bash
DB="file:${AIH_HOME_DIR:-$HOME/.ai_home}/aih.db?mode=ro"
sqlite3 "$DB" "select account_ref, last_attempt_at_ms, last_success_at_ms, last_error_code, last_model_count, last_incomplete from account_model_probes order by last_attempt_at_ms desc limit 20;"
```

期望：所有 `enabled=1` 的账号在一次重扫后 `last_attempt_at_ms > 0`；`last_model_count=0` 的账号能对应到明确的 `last_error_code`（例如 `zcode_empty_catalog`）。

### Step 3：Go API 契约

新增/修改的 Go 包：

```bash
go test ./internal/adapters/accounts/sqliteaccount -run 'AccountModel|Probe' -v
go test ./internal/transport/http/accountsapi -run 'AccountModel' -v
go test ./application/accounts -run 'ModelManagement|ModelRefresh' -v
go test ./internal/host/aihserver -run 'ModelProvider|ModelRefresh' -v
```

必须覆盖：

- 批量端点：鉴权 401、方法 405、过滤、keyset 分页、零模型账号、ETag 304、generation 变化。
- 探测事实：成功、失败保留旧行、空目录、incomplete。
- 多腿：一条腿 503 时返回 `Complete=false`，不删除旧行。
- ref 映射：不通过 Go 测；Node 单测覆盖。

### Step 4：Node 投影单测

```bash
node --test test/webui-model-catalog-go.test.js \
  test/webui-model-catalog-invalidation-go.test.js \
  test/webui-model-openai-routes-go.test.js
```

用例：

1. 29/43 一致场景：投影后 `byAccount` 与 Go 行逐账号相等。
2. 5 个 ref 不同：按 `goRefsByNodeRef` 还原后不丢账号。
3. 一个 Go 账号对应多个 Node 账号：模型 fan-out 到每个 Node ref。
4. 失败保留旧模型：`last_error_message` 非空 + `last_model_count>0` → `byAccount` 保留、`errorsByAccount` 有值。
5. 失败且无旧模型：不写 `byAccount[ref]`（未知），但写 error/probedAt。
6. 成功空目录：`byAccount[ref]=[]`，`accountProbedAt>0` → 页面「未发现模型」。
7. 从未 attempt：既不写 `byAccount` 也不写 probedAt → 「待探测」。
8. force_disable 行：出现在列表且 `enabled=false`；force_enable 行：`manual=true`。
9. Go 不可用：返回持久化投影 `source='go-stale'`，不抛 500。
10. 大小写：`Auto` 与 `auto` 不合并。

### Step 5：真机读路径

先取管理密钥（不要把值写进日志/文档）：

```bash
KEY=$(aih server config show --json --show-secrets | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).config.managementKey))")
BASE=http://127.0.0.1:9527

curl -s -H "Authorization: Bearer $KEY" \
  "$BASE/v0/webui/openai-models?accountRef=<NODE_ACCOUNT_REF>" \
| node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log({ok:j.ok,source:j.source,cached:j.cached,managed:j.managedData.length,byAccount:Object.keys(j.byAccountRef).length,firstError:j.firstError,updatedAt:j.updatedAt})})"

curl -s -H "Authorization: Bearer $KEY" \
  "$BASE/v0/webui/models?accountRef=<NODE_ACCOUNT_REF>" \
| node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log({selectable:j.selectableByAccountRef,defaults:j.defaultByAccountRef,source:j.source})})"
```

期望：两个接口对同一账号的模型集合一致；`source` 不再是 Node 的 `remote/empty` 混杂，而是带 `go` 前缀或映射后的原词汇（按 §2.5 决定）。

### Step 6：写路径 write-through

```bash
curl -s -X PATCH -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"id":"<MODEL_ID>","accountRef":"<NODE_ACCOUNT_REF>","provider":"<PROVIDER>","enabled":false}' \
  "$BASE/v0/webui/openai-models" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).ok))"

sleep 1
sqlite3 "file:${AIH_HOME_DIR:-$HOME/.ai_home}/aih.db?mode=ro" \
  "select account_ref, model_id, manual_policy from account_models where account_ref='<GO_ACCOUNT_REF>' and model_id='<MODEL_ID>';"
```

期望：1 秒内 `manual_policy=force_disable`；紧接着的 GET 中该行 `enabled=false`。再切回 enabled=true 验证 `inherit` 或 `force_enable`（取决于 manual 标志）。

### Step 7：ETag / 缓存失效

```bash
ETAG=$(curl -s -D - -o /dev/null -H "Authorization: Bearer $KEY" \
  "$BASE/v0/webui/openai-models?accountRef=<REF>" | awk -F': ' 'tolower($1)=="etag"{print $2}' | tr -d '\r')

curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $KEY" \
  -H "If-None-Match: $ETAG" "$BASE/v0/webui/openai-models?accountRef=<REF>"
# 期望 304
```

再执行一次 Step 6 的开关，重新取 ETag，期望 ETag 变化、旧 ETag 不再 304。

### Step 8：重启与回滚

```bash
npm run go:build
aih server restart
curl -s http://127.0.0.1:9527/healthz | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(s))"
grep '账号模型' "${AIH_HOME_DIR:-$HOME/.ai_home}/logs/go-core.log" | tail -20
```

重启后验证：

1. 首个 WebUI GET 在 Go 就绪前返回持久化投影（不是 500、不是空白闪烁）。
2. Go 就绪后一次后台拉取把 `source` 从 `go-stale` 切到 `go`。
3. 回滚：`aih server config set --model-catalog-source node`（配置项落地后）→ `aih server restart` → 再取同一账号，目录回到 Node 快照。

### Step 9：切换门禁（双读报告）

在 Phase 2 默认切 `go` 之前，必须拿到一份双读报告：

```text
账号数：43
ref 完全一致：38/43；5 个通过 links 映射
模型集合一致：29/43
Go 领先：13 个账号，92 个模型（agy 6×12、cline 2×2、zcode 12+4×1）
Node 领先：0（`75eda502` 前为 1 个账号 / 41 个模型；修复后需一次成功刷新把 68 行回填到 109+）
未映射 Node 账号：0
Go 无模型行且 enabled=1：2 个 zcode（均有 last_error_code，页面显示探测失败/未发现）
```

门禁：`Node 领先 = 0`、`未映射 = 0`、每个 Go 无行账号都有可解释的 `last_error_code`。否则不切默认值。

## 6. 实施顺序与验收

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| Phase 0 | Go：探测事实表、generation、批量端点（incomplete 已由 `75eda502` 关闭）、单测 | 上述 Go 测试全绿；批量端点对 43 账号返回 680 行且 `ETag` 稳定 |
| Phase 1 | Node：适配器、三个读入口、写路径 write-through、双读脚本、特性开关（默认 node） | Step 4–7 全绿；双读报告 `Node 领先 = 0` |
| Phase 2 | 默认切 `go`，观察 1 周；保留 `node` 回滚与 Node 快照 | 页面条数与 Go 行一致；无 500；回滚演练成功 |
| Phase 3 | 把 Node 路由缓存也改为 Go 投影；退役 Node 探测/快照；迁移 CLI/harness 的 context limits | 独立方案，不在本次范围 |

Phase 1 的代码改动建议拆成三个可独立提交的切片：

1. Go 存储/端点/事实（不改 Node）。
2. Node 适配器 + 单测（不接线）。
3. 接线 + 开关 + 双读脚本（默认 node）。

这与仓库「先写端口、再接组合根」的迁移习惯一致，也避免一个提交同时改 16 个 Provider 的公共文件。

## 7. 待拍板

1. **展示口径**：严格按 Go 可路由集合展示，还是 Go 集合 ∪ Node `availableModels`/descriptors？推荐前者，Node 本地声明只作为「未进 Go」诊断行；否则用户会看到选不了/不可路由的模型。
2. **删除账号留档**：Phase 2 是否值得在 Go 加「删除账号目录墓碑」？推荐先保留 Node 留档，等用户明确需要跨重启的删除账号目录再投入。
3. **停用账号发现频率**：是否允许 Go 对 `enabled=0` 账号做低频（如 24h）发现？推荐允许，否则管理页的停用账号会长期停在旧目录/待探测。
4. **共享身份**：一个 Go 账号映射多个 Node 账号时，页面是否合并展示？推荐先 fan-out + 标「共享身份」，不要静默合并。
5. **`cached` 语义**：Go 读是否一律 `cached=true`？推荐保留「刚刷新返回 false、普通 GET 返回 true」的现有语义，避免模型页的「缓存/实时」标签失真。

## 附录 A：关键行号索引

| 主题 | 位置 |
| --- | --- |
| WebUI GET 路由 | `lib/server/web-ui-router.js:885` |
| WebUI 管理 GET | `lib/server/webui-openai-model-routes.js:580`，缓存调用 `:607` |
| WebUI 刷新作业 | `lib/server/webui-openai-model-routes.js:875`，缓存调用 `:881`，启动 `:967` |
| WebUI 写路径 | `lib/server/webui-openai-model-routes.js:673/721/774` |
| 会话/项目模型 GET | `lib/server/web-ui-router.js:843`；`webui-project-routes.js:152`，缓存 `:182` |
| Node 缓存读取 | `lib/server/webui-model-cache.js:1011` |
| Node 缓存加载/持久化 | `webui-model-cache.js:310/245/254/278` |
| Node 缓存刷新 | `webui-model-cache.js:821` |
| Node 失效 | `webui-model-cache.js:1049/1073/1166` |
| Node 探测调度 | `lib/server/webui-model-refresh-scheduler.js:13-34` |
| Node 账号同步 | `lib/server/go-account-sync.js:35`（15 秒），`:262`（模型策略） |
| Go 单账号读 | `internal/transport/http/accountsapi/handler.go:998` |
| Go 刷新 | `internal/transport/http/accountsapi/handler.go:1056`；`application/accounts/model_management.go:172` |
| Go 模型存储 | `internal/adapters/accounts/sqliteaccount/model_store.go:18/53/224` |
| Go 路由索引 | `internal/adapters/accounts/sqliteaccount/routing_index.go:55` |
| Go 重扫 | `internal/host/aihserver/model_refresh_sweep_worker.go:12-19` |
| Go 首次恢复 | `internal/host/aihserver/initial_model_refresh_recovery.go`；SQL `initial_model_refresh_recovery_store.go:16` |
| Go Provider 注册表 | `internal/host/aihserver/model_providers.go:59` |
| Go 刷新参数 | `internal/host/aihserver/inference.go:37-44` |
| Go 门面清单 | `lib/server/go-core-sync-facade.js:FACADE_METHODS` |
| Go ref 映射 | `lib/server/go-core-host.js:143-161` |

## 附录 B：本机实测命令

本报告 §1.6 的数字来自以下只读命令（2026-11-05 18:48 左右）：

```bash
# 1) 两侧规模
DB="file:${AIH_HOME_DIR:-$HOME/.ai_home}/aih.db?mode=ro"
sqlite3 "$DB" "select count(*), sum(enabled) from accounts;"
sqlite3 "$DB" "select count(*), count(distinct account_ref), sum(upstream_available) from account_models;"

# 2) ref 映射与逐账号差异（Node 脚本见 §5 Step 1）
# 3) 日志
grep '账号模型刷新' "${AIH_HOME_DIR:-$HOME/.ai_home}/logs/go-core.log" | tail -20
```

日志中的低敏样例：

```text
账号模型刷新失败: provider=zcode account=acct_4dbc… err=账号模型发现失败: zcode 模型目录为空
账号模型刷新放弃: provider=zcode account=acct_6738… attempts=8 err=账号模型发现失败: zcode 模型目录为空（等待下次周期重扫）
```

这说明：Go 侧已经有失败事实，但没有持久化到可读模型；P0-2 的价值不是「新增日志」，而是把日志里的事实变成 UI 可读字段。

## 附：Phase 1 接线后的真机核对（2026-11-05）

- 接线方式：`webui-model-catalog-source.js` 在 `getWebUiModelsCache` 之上做有界合并，
  Go 有数据的账号覆盖 `byAccount`；`models`/`accountProbedAt`/`labels` 仍用 Node 的（Phase 1 不动路由证据）。
- 注入点：`server.js` 的 `buildWebUiDeps()`（不是 `handleWebUIRequest` 的另一个 ctx 字面量）。
- 真机验证：scoped 请求 `acct_04a193ed26f71e4619c5` 的 `merged byAccount` = 26，
  与 `GET /v1/management/account-models?account_ref=…` 完全一致；此前该值是本地缓存值。
- **已修**：该账号并不是「不在账号池」，而是两侧 accountRef 不同（Node `acct_5339…` vs
  Go `acct_84c6…`）。合并层必须做 ref 翻译，否则目录挂到页面上不存在的 key。
  修复后真机 `GET /v0/webui/openai-models?accountRef=acct_533999af0033f08d6106` 返回 120 条，
  其中 `opencode/` 80 + `opencode-go/` 29 = Go 的 109 个目录，与 Node 探测口径一致。

## 附：Phase 2 前置已完成（2026-11-05）

- **探测事实落库**：aih.db v21 `account_model_probes`（attempt/error/source/model_count）。
  `ModelManagement.RefreshAccountModels` 成功写 `remote + len(discovered)`，失败写稳定错误码
  （timeout/discovery_* 等）并保留 `last_model_count`；`context.Canceled` 跳过、写事实用
  `WithoutCancel`，超时失败也能落盘。
- **批量端点**：`/v1/management/account-models` 增加 `last_attempt_at_ms/last_error_code/
  last_error_message/last_source/last_model_count`；只返回「有模型或有探测事实」的账号。
- **WebUI 合并层**：采用 Go 的 `accountProbedAt`（与 Node 取大）与错误（成功即清空旧错误）。
- 真机：opencode 109、codebuddy 26、全量 209，`source=remote`。


## Phase 2 第一批：opencode / cline 的 Node 探测链退役（2026-11-05）

### 形态

- **归属唯一真值源**：`lib/providers/model-ownership.js` 的 `GO_MODEL_OWNERS` +
  `goOwnedModels(id)`。descriptor 的 `models` 能力由它派生，不手写策略。
- **单策略**：`handler: 'go-account-models'`、`transport: 'local'`。Go 是本机服务，
  这份目录既不出网也不依赖客户端；`local` 让它在账号出口解析**之前**执行，
  出口配置异常不会拖垮目录读取。
- **实现**：`lib/server/model-discovery/go-account-models.js` 读
  `GET /v1/management/account-models`，并做 Node↔Go accountRef 翻译。
- **删除的探测链**：`opencode-models` / `cline-static-catalog` 两个 handler；
  `http-utils` 里按 provider 名的 opencode 分支；`opencode-server-client` 的
  `probeOpenCodeCatalog` / `fetchOpenCodeModels`。
- **不回退**：`fetchModelsForAccount` 对 Go 接管的 Provider 不再落到通用探测/原生 CLI；
  Go 读不到时抛 `go_model_catalog_unavailable`（缓存层保留上一份目录，不把账号判成
  「没有模型」）。
- **本地兜底退役**：`account.availableModels`、描述符目录、目录缓存不再参与 Go 接管
  Provider 的目录（停用的 cline 账号曾因此残留 2 条历史模型）。
- **账号引用翻译**：同步链接缺失时按**恒等**（两侧 ref 相同），不再返回空串。
  修复前 opencode 的 API Key 账号读不到 Go 目录（WebUI 显示 0 个模型）。

### 真机（2026-11-05，Node 9527 / Go 19550）

- opencode OAuth 账号（Node `acct_5339…` → Go `acct_84c6…`）：109，与 Go
  `account-models` 一致，`source=remote`。
- opencode API Key 账号（`acct_e9b5…`，两侧同 ref）：109（修复前 0）。
- cline 两个账号在 Go 里 `enabled=0`，Go 未刷新目录：scoped 目录为空，只剩手工模型
  设置。静态清单 14 条由 Go 单测锁定；**启用账号后补一次真机验收**。
- 回归守卫：`test/model-ownership.test.js`（10 项：descriptor 派生、无出网策略、
  不出网读取、Go 读不到时抛错、本地兜底不进目录、ref 恒等翻译）。

### 第二批：家族四支 / kiro / qoder 双端（2026-11-05）

- **codebuddy / codebuddycn / workbuddy / workbuddycn**：`_shared/codebuddy-family.js` 的
  HTTP（`/v3/config`）与本地 CLI（`--help`）两条策略一起退役；删除
  `lib/account/codebuddy-family-model-discovery.js`、`lib/server/workbuddy-model-discovery.js`
  与 `native-cli-model-discovery` 的 `codebuddy-help` 分支。
- **kiro**：HTTP（ListAvailableModels）与 CLI 兜底退役，删除 `lib/account/kiro-model-discovery.js`。
- **qoder / qodercn**：HTTP（WASM 签名目录）与 CLI 兜底退役；`qoder-model-catalog` 仅保留
  与推理传输共用的目录读取（`readQoderModelCatalog` 等）。
- **两处 UX 修正**：
  - `mergeGoCatalogResult` 在覆盖 `errorsByAccount` 后重算 `firstError`——否则账号恢复后
    页面仍显示旧探测错误（实测重启后 kiro 已正常仍报 `go_model_catalog_reader_missing`）。
  - scoped 空目录不再写入 3 秒响应缓存——启动早期 Go 未 ready 时的那一次空结果会被
    轮询反复续期（实测 opencode API Key 账号持续显示 0 个模型）。
- **真机**：qoder 15、kiro 5×5、codebuddy 26×N、opencode 109/109，全部
  `source=remote`、`errorsByAccountRef` 为空，与 `/v1/management/account-models` 相同。
- 说明：Go 的 opencode 目录在刷新窗口内会短暂为空（模型行被整体替换），WebUI 如实反映；
  这不是 Node 探测问题，属于 Go 侧刷新策略，后续单独观察。

### 第三批：收尾（16/16）

- **agy / gemini / kimi / grok / zcode / codex / claude** 全部改为 `goOwnedModels(id)`。
- 删除最后一批 Node 探测实现：`codex-native-models`、`code-assist-models`、`native-cli`
  三个 handler；`http-utils` 的 codex / code-assist 兜底分支与本地 CLI 兜底；
  `lib/server/native-cli-model-discovery.js` 整文件删除；`describeNativeCliFallbackFailure`
  一并删除（CLI 策略已全部退役）。
- `fetchModelsForAccount` 现在只剩两条路径：Go 接管（唯一策略）与「无策略时的通用
  /models 探测」（插件 Provider 用）。派发路径不再出现任何内置 provider 名。
- **停用账号的本地目录**：`getWebUiCatalogResult` 在 Go 正常作答后，丢弃 Go 没有返回的
  Go 接管账号的本地缓存（`dropGoOwnedLocalEntries`）；Go 不可达（null）时仍保留快照兜底。
  这样停用账号不会永远显示上一次 Node 探测的历史目录。

- **注入点回归**：`server.js` 的 `fetchModelsForAccountWithRefresh` 曾漏掉最后一跳的
  `withGoModelSource`，所有 Go 接管 Provider 都以 `go_model_catalog_reader_missing` 失败，
  `/v0/management/models` 从 178 个模型变成 0（WebUI 走合并层看不出来）。已抽成纯函数
  `lib/server/go-model-source-options.js` 并加单测（`test/go-model-source-options.test.js`）。
- **真机对比**（43 个账号，逐账号 scoped vs Go `account_models`）：
  - 35 个账号完全一致；
  - 6 个 agy 账号 `enabled=0` 不在运行池：页面不展示目录（Go 有 12 条），符合既有行为；
  - 2 个 cline 账号 `enabled=0`：页面只显示手工模型设置（Go 无目录）。启用后由 Go 刷新。
- **待真机**：kimi / grok / gemini / cline 的目录要等对应账号可用后验证；
  codex / claude / agy / zcode / qoder / kiro / 家族已用现网账号验证过条数。

### 下一步

- 模型目录迁移到此收口；后续 Provider 新增只改 descriptor 一行
  （`models: goOwnedModels(id)`）+ 在 Go 注册目录源。
- 停用账号的目录展示策略（是否在启用前也读 Go）留待产品确认。
