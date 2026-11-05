# http-utils 模型发现兜底：核对、删除条件与替代方案

> 范围：`lib/server/http-utils.js` 的 `fetchModelsForAccount`（620–745），重点为 706 / 710 / 726 / 728 / 739 五处 provider 名硬编码。
> 基线：`main` @ `8840c414`。评估期间 HEAD 前进到 `3092d6c8`（描述符删纯镜像字段、补 peer 测试），
> 两次提交都不涉及 `lib/server/http-utils.js`，行号与结论不变；本评估未触碰任何并行改动。
> 方法：静态引用 + 描述符倒排对照 + 叶子打桩追踪（stub 只替换最底层实现，派发走真实策略链）。
> 性质：**只读分析**。未改代码、未提交、未重启服务。

---

## 0. 结论（可执行答案）

1. **五处兜底里没有一处是「另一条独立策略」。** 描述符倒排索引已经为全部 16 个 provider 声明了 `models.strategies`；这五处要么是同一策略的**第二次重复调用**，要么是**永远执行不到的死代码**：

   | 位置 | 判定 | 依据 |
   | --- | --- | --- |
   | 706–708 opencode | 重复探测 | `fetchOpenCodeModels` 只是 `probeOpenCodeCatalog().models`（`opencode-server-client.js:393-396`），而 `opencode-models` handler 已经调用过 `probeOpenCodeCatalog` |
   | 709–722 zcode | **登录态不可达** | `zcode-plan-models` handler 在无 plan 目录时抛 `terminal: true` 的错误，`model-discovery/index.js` 直接上抛，永远走不到 710 |
   | 723–726 claude | **纯死代码** | `claudeAuthTokenProxy` 声明后从未被读取（全文件仅此一处出现）；同逻辑真实存在的位置是 `generic-models-probe.js:97` |
   | 727–738 codex | 重复探测 | `codex-native-models` handler 已调用 `fetchCodexModelsForAccount`，参数逐项相同 |
   | 739–741 code-assist | 重复探测 | `code-assist-models` handler 已调用 `fetchGeminiCodeAssistModels`，参数逐项相同 |

2. **删除的真正前置不是「描述符缺策略」**，而是三件语义小事：
   - zcode 的「空目录是权威结果」需要能表达（现在 `[]` 会被链当成 `empty_catalog` 继续下探）；
   - gemini/agy 的策略需要按认证形态收窄（现在 `modes: ['login']` 比 `shouldUseGeminiCodeAssist` 宽）；
   - 「失败后再试一次」是否保留要显式决定（不保留时，重试责任移交给刷新调度器，代价是 10 分钟错误退避）。
3. **建议顺序**：死变量 → zcode → opencode/codex/code-assist → CLI 收敛与 744 收口。每步独立提交、独立验证、可单独回滚。
4. **Go 目录驱动是终态，但不能作为本次删除的前置。** Go 的 `modelProviderModules()` 已覆盖 12 个模块家族，但明确不覆盖 grok OAuth（`model_providers.go` 自述为「能力边界，不是缺陷」），且 Go core 允许启动失败、失败时路由交还 Node —— 把模型目录完全押在 Go 上会让「Go 起不来」变成「模型列表空」。

---

## 1. 被测代码

`fetchModelsForAccount` 的派发顺序（620–745）：

```
620  async function fetchModelsForAccount(options, account, timeoutMs = 8000) {
621    const provider = String(account && account.provider || 'codex')...   // ← 相邻硬编码，见 §7.3
629    // ① local 通道先跑（不依赖出网）
629    discoverProviderModelsViaStrategies(provider, account, { transports: ['local'] })
634    if (命中) return
640    // ② 解析账号 egress
668    // ③ 策略链：http → cli（描述符声明）
687    if (命中) return markCatalogCompleteness(...)
696    // ④ 链外 CLI 兜底
705    if (nativeCliModels) return
706    if (provider === 'opencode') return fetchOpenCodeModels(...)          // ①
709    if (provider === 'zcode' && 非 api-key) { ... throw ... }            // ②
726    const claudeAuthTokenProxy = provider === 'claude' && ...            // ③ 未被使用
728    if (provider === 'codex' && 非 api-key) return fetchCodexModelsForAccount(...)  // ④
739    if (isCodeAssistProvider(provider) && shouldUseGeminiCodeAssist(...)) return fetchGeminiCodeAssistModels(...)  // ⑤
744    return fetchGenericModelsProbe(...)                                  // 通用兜底
745  }
```

到 706 为止已经发生过两次尝试：③ 的策略链（http+cli）与 ④ 的链外 CLI。

---

## 2. 可达性验证

### 2.1 方法

只替换叶子实现（`probeOpenCodeCatalog` / `fetchOpenCodeModels` / `fetchZcodePlanBalanceModels` / `fetchCodexModelsForAccount` / `fetchGeminiCodeAssistModels` / `fetchGenericModelsProbe` / `discoverNativeCliModels`），**不替换** `discoverProviderModelsViaStrategies`。这样派发、mode 过滤、terminal 上抛、`describeNativeCliFallbackFailure` 全部走真实代码，只把网络换成可控桩。脚本见附录 A。

### 2.2 结果

| provider | 账号模式 | 真实调用顺序 | 判定 |
| --- | --- | --- | --- |
| opencode | login / api-key | `probeOpenCodeCatalog` → `discoverNativeCliModels` → `fetchOpenCodeModels` | 706 **重复** |
| zcode | login | `fetchZcodePlanBalanceModels` → throw `zcode_jwt_missing_relogin` | 710 **不可达** |
| zcode | api-key | `fetchGenericModelsProbe` → CLI → `fetchGenericModelsProbe` | 710 条件为假；744 **重复** |
| claude | 任意 | `fetchGenericModelsProbe` → CLI → `fetchGenericModelsProbe` | 726 **死变量**；744 **重复** |
| codex | login | `fetchCodexModelsForAccount` → CLI → `fetchCodexModelsForAccount` | 728 **重复** |
| codex | api-key | `fetchGenericModelsProbe` → CLI → `fetchGenericModelsProbe` | 728 条件为假；744 **重复** |
| gemini / agy | `oauth-personal` | `fetchGeminiCodeAssistModels` → CLI → `fetchGeminiCodeAssistModels` | 739 **重复** |
| 其余 8 家（有 `cli` 规格） | 任意 | 链 → `discoverNativeCliModels` **抛错** → `describeNativeCliFallbackFailure` 抛错 | 尾部整体**不可达** |

关键结构性事实：**尾部只对「没有 CLI 规格」的 8 家结构可达** —— agy、claude、cline、codex、gemini、kimi、opencode、zcode（其中 cline 的 `local` 静态清单必定先命中，实际也走不到尾部）。另外 8 家（codebuddy / codebuddycn / grok / kiro / qoder / qodercn / workbuddy / workbuddycn）在 `http-utils.js:703` 就抛出了，永远到不了 706。

复现能力矩阵（16 家全部 `models.supported: true`）：

```
agy       agy-http-models[http:login]      agy-generic-models[http:api-key]
claude    claude-http-models[http:]
cline     cline-static-models[local:]
codebuddy codebuddy-http-models[http:login] codebuddy-native-cli-models[cli]
codex     codex-http-models[http:login]    codex-generic-models[http:api-key]
gemini    gemini-http-models[http:login]   gemini-generic-models[http:api-key]
grok      grok-http-models[http:]          grok-native-cli-models[cli]
kimi      kimi-http-models[http:]
kiro      kiro-http-models[http:]          kiro-native-cli-models[cli]
opencode  opencode-http-models[http:]
qoder     qoder-http-models[http:]         qoder-native-cli-models[cli]
qodercn   qodercn-http-models[http:]       qodercn-native-cli-models[cli]
workbuddy / workbuddycn / codebuddy / codebuddycn 同上（家族共享）
zcode     zcode-http-models[http:login]    zcode-generic-models[http:api-key]
```

### 2.3 被删掉的到底是什么

不是「fallback 策略」，而是**同一条策略的第二次执行**。这解释了一个反直觉现象：删掉之后，正常路径的行为完全不变；只有「第一次探测失败」时的行为会变（少一次立即重试）。

---

## 3. 删除条件

### 3.1 全局前置（所有分支共用）

| 编号 | 条件 | 验收方式 |
| --- | --- | --- |
| G1 | 取代它的描述符策略与分支**逐项等价**：端点、凭据形态、header、timeout、`incomplete` 标记传播 | 对每个 provider × mode 记录链上命中的 `strategyId` 与请求 URL/header，与旧分支对比 |
| G2 | 没有消费方依赖分支特有的错误对象（`zcode_jwt_missing_relogin`、plan badge 文案等） | 搜索 `.code === 'zcode_jwt_missing_relogin'` / `reloginRequired` 的读取点并逐个确认 |
| G3 | 回归守卫**能在旧代码上变红** | 先写守卫、在 HEAD 上跑一次确认失败，再删 |
| G4 | `webui-model-refresh-scheduler` 注入路径已覆盖 | 该 scheduler 通过 `ctx.deps.fetchModelsForAccount` 调用（`webui-model-refresh-scheduler.js:206`），需一条集成用例 |
| G5 | 外部/插件描述符仍有兜底 | 插件无法进入这五处（它们按 provider 名匹配）；未知 provider 落在 744。删除 706–741 不影响插件 |

### 3.2 逐分支前置

**① 706–708 opencode**
- 条件 O1：接受「第一次探测失败后不再立即重试」。链上 `opencode-http-models` 是唯一且无 mode 限制的策略，覆盖 login 与 api-key。
- 条件 O2：明确删除后的回落目标。删掉后链失败 → CLI（无规格，返回 null）→ **744 通用探测**。opencode 没有 OpenAI 兼容的 `/v1/models`，744 大概率抛错而不是返回目录。**因此 O2 必须与 744 的处置一起决定**（见 §5.4）。
- 若不满足 O2：保留 706，或把 744 改成「链上已有 http 策略且全部失败时直接抛 `describeModelStrategyFailure`」。

**② 709–722 zcode**
- 条件 Z1：登录态无 jwt 时，链上 handler 必须继续抛 `terminal`（现状已满足，`http-handlers.js:79-95`）。
- 条件 Z2：**「有 jwt 但目录为空」必须保留返回 `[]` 的语义**。这是本次最容易被忽略的一条：`fetchZcodePlanBalanceModels` 在 balance 无模型时会走 `fetchZcodePreviewModels`，而 preview 的 `catch` 返回 `[]`（`http-utils-zcode.js:154,175-177`）。链上会把它记成 `empty_catalog` 并返回 null；旧分支因为 `[]` 是 truthy 而直接 `return []`。删掉后同一场景会落到 744，对 OAuth 账号拼出推理端点 URL 并抛错。
  - 满足方式：给策略加 `emptyAuthoritative: true`（或让 handler 返回 `{ models: [], resolved: true }`），由门面直接返回 `[]`，不继续下探、不落 744。
  - 附带修掉一个既有缺陷：preview 的网络错误被吞成 `[]`，等于把「探测失败」伪装成「账号零模型」。乘这次改动把「异常」与「空」分开。
- 条件 Z3：确认 `accounts` 视图对「无模型」与「探测失败」的两种呈现都已有文案。

**③ 723–726 claude**
- 条件 C1：无。**这是纯死代码，可立即删除，零行为变化。**
- 条件 C2：同时删除 `http-utils.js:35` 的 `isClaudeAuthTokenAccount` 导入（删掉 726 后全文件唯一使用点消失）。同处的 `isApiCredentialAccount`（`:36`）与 `KNOWN_CLINE_MODELS`（`:68`）**当前就已经是死导入**，可一并清理（不属于本次语义变更）。

**④ 727–738 codex**
- 条件 X1：接受不再立即重试。链上 `codex-http-models`（login）与 `codex-generic-models`（api-key）已覆盖两种模式，参数与 732 逐项相同。
- 条件 X2：确认 `shouldRejectEmptyRemoteModels`（`provider-model-discovery.js:161-168`）的上游保护仍然成立 —— 它把 codex 的空目录一律当探测失败、保留上次绑定。旧分支的第二次探测是这层保护的补充，删掉后依赖它单独生效。
- 条件 X3：codex 是网关默认 provider，必须排在 opencode 之后单独提交。

**⑤ 739–741 code-assist**
- 条件 A1：**先把描述符的宽度与 `shouldUseGeminiCodeAssist` 对齐**。现状 `modes: ['login']` 比 `shouldUseGeminiCodeAssist` 宽：一个 baseUrl 指向普通 OpenAI 兼容端点的 gemini 登录账号，也会先走 `code-assist-models`。这是**已经存在**的行为差异（链在 739 之前就跑了），删除 739 不会扩大它，但会把它固化成唯一行为。
  - 满足方式（二选一）：(a) 接受现状，在描述符注释里写明「登录态一律先试 code-assist」；(b) 增加描述符条件字段（如 `accountAuthTypes: ['oauth-personal']` 或 `when: 'code-assist-base-url'`），把 739 的判定下沉为数据。
- 条件 A2：确认 `api-key + code-assist baseUrl` 这一组合不再需要 —— 旧 739 对 api-key 账号同样会命中（只要 `requestOptions.geminiBaseUrl` 是 code-assist 地址），而描述符的 `modes: ['api-key']` 只允许 generic 策略。这是删除带来的**唯一真实行为收窄**，需要产品口径确认。

### 3.3 反向条件（出现即不能删）

- 有 provider 的 `models.supported` 被改成 `false`，但仍有兜底在跑 —— 这正是本次要消除的「声明已迁、实际双跑」。
- 有消费方把「第二次探测成功」当成 SLA 的一部分（例如首启冷账号必须在一次调用内出目录）。
- Go core 被要求成为模型目录的唯一来源，而 Node 探测路径需要保留为降级通道。

---

## 4. 替代方案 A：描述符驱动（推荐先做）

### 4.1 目标形状

`fetchModelsForAccount` 收缩为：

```
local 通道 → 解析 egress → 策略链（http+cli）→ 打完整性标记 → 返回 / 抛结构化错误
```

派发路径里不再出现任何 provider 名。新增 provider 只改 `lib/providers/defs/<id>.js` 与（必要时）一个 handler，不改共享文件 —— 这正是 `handler-registry.js` 文件头写下的目标。

### 4.2 需要补的三条描述符语义

| 语义 | 解决的问题 | 形状（数据，不是分支） |
| --- | --- | --- |
| `emptyAuthoritative: true` | zcode「空目录是权威结果」 | 策略级布尔值；门面见到 `{models: [], resolved: true}` 时直接返回空数组，不继续下探 |
| 认证形态条件 | gemini/agy 的 739 比 `modes` 更细 | 策略级 `accountAuthTypes: ['oauth-personal']`，或 `when` 谓词（由组合根注册，仍不出现 provider 名） |
| CLI 策略的真实执行 | 现在 cli 策略有两种写法，语义不一致 | 统一为 `handler: 'native-cli'`；`discover: () => null` 的占位写法（qoder / qodercn / kiro / codebuddy 家族）改为同一 handler |

### 4.3 迁移后 `fetchModelsForAccount` 的等价物

```js
const localModels = await discoverProviderModelsViaStrategies(provider, account, { deps: { provider }, transports: ['local'], timeoutMs });
if (hasModels(localModels)) return localModels.models;
const requestOptions = await resolveEgress(...);
const result = await discoverProviderModelsViaStrategies(provider, account, { deps: {...}, transports: ['http', 'cli'], timeoutMs });
if (result.models) return markCatalogCompleteness(result.models, result.incomplete, result.incompleteReason);
if (result.authoritativeEmpty) return [];
throw describeModelStrategyFailure(result);   // 取代 744
```

### 4.4 顺带修掉的相邻问题

1. **CLI 双跑**：grok 的描述符用 `handler: 'native-cli'`，链内会执行一次 `discoverNativeCliModels`；链失败后 `http-utils.js:701` 再执行一次。qoder/kiro/家族则用 `discover: () => null` 占位（`index.js` 记 `strategy_factory_invalid`，被 `describeNativeCliFallbackFailure` 当噪声过滤）。两种写法并存导致「同一执行器调用一次还是两次」取决于 provider。收敛为一种后，`http-utils.js:694-705` 整段可以删除。
2. **CLI 失败吞掉 HTTP 真实原因**：`describeNativeCliFallbackFailure` 在 CLI 抛错时用链上 attempts 覆盖 `cliError`，只保留 `cliFallbackError` 字符串。收敛 CLI 后，这条包装逻辑可以并入门面，错误结构统一。
3. **744 的去向**：它至今仍是「未知/插件 provider」的唯一入口。两种选择——
   - 保留：在描述符里给每个 provider 补一条无 mode 限制的 `generic-models-probe` 尾部策略，744 退化为「无任何策略」错误；
   - 删除：未知 provider 直接拿到 `no_model_strategy`，可观察但不静默探测。

   建议**保留但降级**：只对「未声明任何 http 策略」的 provider 生效，避免所有 provider 都多打一次上游。

---

## 5. 替代方案 B：Go 目录驱动（终态）

### 5.1 Go 侧现状

- `internal/host/aihserver/model_providers.go` 的 `modelProviderModules()` 是模型目录源的唯一注册点，覆盖 12 个模块家族：codex、claude、agy、kimi、grok、opencode、kiro、zcode、gemini、codebuddy-family、qoder(+qodercn)、cline。
- 发现结果写入 `aih.db` 的 `account_models`。
- Node 已经把**公共模型目录投影**推给 Go（`PUT /v1/management/model-catalog`，`internal/transport/http/modelcatalogapi`），`go-core-host.js` 周期性 `refreshRoutableModels()` + `pushModelCatalogProjection()`。方向是 Node → Go。
- Node 读 `account_models` 的现有入口只有 CLI 补全与人工策略对账（`lib/account/go-bridge/go-account-store-reader.js`），**WebUI 模型缓存不读它**。

### 5.2 接线点

若要改为 Go 目录驱动，需要新增「Node 读 Go 目录」这一反方向：

1. `fetchModelsForAccount` 改为：先读 `account_models`（带 `collected_at` 新鲜度），未命中或过期才回落 Node 探测；
2. 刷新触发改为 Go 侧 `ModelDiscovery`（`ProviderIDs()` 已是刷新队列的派生源，见 `model_management.go` 注释）；
3. `markCatalogCompleteness` 的「残缺目录不作为否定证据」语义要在 Go 侧有等价物，否则 `model-pool-narrowing` 会把未采集当成「不支持」。

### 5.3 前置条件

| 编号 | 前置 | 现状 |
| --- | --- | --- |
| B1 | Go 覆盖全部 provider 的目录发现 | 12 个模块，但 grok OAuth 明确不覆盖（`buildGrokModelProvider` 注释：只有 API Key 能探，OAuth 只能靠本地 CLI） |
| B2 | 凭据 codec 在 Go 侧齐备 | zcode/kiro/qoder 已迁；仍需确认与 Node 写入路径同代 |
| B3 | Node 降级路径明确 | Go core 允许启动失败（`go-core-host.js` 的 supervisor 退避重试），此时模型列表必须仍可用 |
| B4 | 空目录语义对齐 | Node 侧 `shouldRejectEmptyRemoteModels` 只对 codex 特判；Go 侧需同等规则 |
| B5 | 新鲜度契约 | 谁触发刷新、多久算过期、过期但 Go 不可达时怎么办 |

### 5.4 为什么不能作为本次删除的前置

- B1 不成立：纯 Go 驱动会让 grok OAuth 账号失去目录，进而被判 `model_not_routable` 交还 Node —— 等于通道白接。
- B3 不成立：Node 探测是 Go 不在场时的唯一目录来源。
- 迁移文档 `2026-11-04-node-go-merge.md` §8 已写明「模型目录不能按 Provider 直接搬」，且终态是 Go，但顺序是先 codec、再目录、最后删 Node 写入。

**结论：本次按方案 A 删除 706–741；方案 B 作为后续独立计划，删除条件是把「Node 探测」整体降级为兜底并最终移除，而不是分支级删除。**

---

## 6. 风险

| # | 风险 | 严重度 | 触发条件 | 缓解 |
| --- | --- | --- | --- | --- |
| R1 | 首启冷账号目录变慢 | 中 | 第一次探测瞬时失败 | 调度器冷账号补课间隔 60–120s（`COLD_BACKLOG_MIN/MAX_DELAY_MS`），可接受；如需更快，可在门面加 `retry: 1` 数据化重试 |
| R2 | 失败账号退避 10 分钟 | 中 | 链失败且无第二次探测 | `ERROR_BACKOFF_MS = 10min`；删除后错误更快暴露，恢复更慢一次 |
| R3 | zcode 空目录变成抛错 | **高** | 有 jwt、balance 与 preview 都为空/失败 | 必须先做 `emptyAuthoritative`（Z2），否则不要删 709–722 |
| R4 | opencode 失败后落到错误端点 | 中 | 链失败 → CLI null → 744 | 与 744 处置同批提交；或让 744 在「已有 http 策略」时直接抛 |
| R5 | code-assist 策略过宽被固化 | 中 | gemini/agy 登录账号 + 非 code-assist baseUrl | 先对齐描述符宽度（A1），再删 739 |
| R6 | codex 是默认 provider，回归面最大 | **高** | 删除 728 后探测失败路径变化 | 单独提交 + 集成用例覆盖 login/api-key 两模式 |
| R7 | 错误对象形态变化 | 低 | 调用方按 `code` 分支 | 删除后统一为门面的 `attempts` 摘要；保留 `code` 字段名 |
| R8 | 插件/外部 provider 失去通用兜底 | 低 | 删除 744 | 保留 744 作为「无策略」兜底（推荐） |
| R9 | 并发改动冲突 | 中 | 仓库有他人未提交改动 | 每个提交只带自己的 pathspec；不要 `git add -A` |

---

## 7. 落地顺序（本次不执行，只给提交边界）

### 第 0 步：基线守卫（先写测试，不改实现）

- 用例：16 provider × 2 mode 的「命中的 strategyId」快照；断言 `fetchModelsForAccount` 的派发不出现 provider 名比较。
- 在 HEAD 上跑，确认守卫对 726（死变量）之外的四处**不能**直接变红 —— 所以守卫要写成「行为矩阵」而不是「源码扫描」，源码扫描只能防回退。

### 第 1 步：纯死代码（零行为）

- 删 `http-utils.js:723-726` 与 `:35` 的 `isClaudeAuthTokenAccount` 导入。
- 顺手删已死的 `isApiCredentialAccount`（:36）、`KNOWN_CLINE_MODELS`（:68）。
- 验证：全量 `node --test test/*.js`；此步不应有任何行为变化。

### 第 2 步：zcode（唯一需要新语义的一步）

- 加 `emptyAuthoritative`（或 handler `{models: [], resolved: true}`）+ 单测；把 preview 的「异常→[]」与「真空」分开。
- 删 `http-utils.js:709-722`。
- 验证：登录态无 jwt → `zcode_jwt_missing_relogin`；有 jwt 空目录 → `[]`；有 jwt 有目录 → 目录；api-key → generic。

### 第 3 步：opencode / codex / code-assist

- 三个分支可同批，但 codex 单独一个提交（默认 provider）。
- 同批决定 744 的处置。
- 验证：每个 provider 的 login/api-key 矩阵 + scheduler 集成用例。

### 第 4 步：CLI 收敛（可选，但建议）

- 统一 `handler: 'native-cli'`，删除 `http-utils.js:694-705`。
- 修掉 grok 的双跑。
- 这一步做完，`fetchModelsForAccount` 才真正只剩「门面 + egress」。

---

## 8. 回归守卫要求

1. **行为矩阵**：对 16 × 2 组合断言「第一个产生目录的 strategyId」与「失败时的第一个 attempts 条目」。
2. **旧代码必红**：守卫要先在 `8840c414` 上跑出失败，再合入修复（否则无法证明它守住了什么）。
3. **禁止源码回退**：一条轻量用例断言 `lib/server/*.js` 的模型发现派发路径不新增 `provider === '<name>'`（白名单只留 621 的默认值，见 §9）。
4. **不依赖真实上游**：全部打桩，遵循「验证码/上游调用限频」的既有约束。

---

## 9. 边界与待确认

1. **621 行的默认值** `String(account.provider || 'codex')` 也是 provider 名硬编码，且比 706–739 更隐蔽：没有 `provider` 的账号会被当成 codex 去探测。是否改为「缺 provider 直接报错」需要产品确认（本次未纳入范围）。
2. **`discover: () => null` 的占位策略**（qoder/qodercn/kiro/家族）目前被 `describeNativeCliFallbackFailure` 当噪声过滤。它是「声明了 cli 但实际在链外执行」的过渡写法，收敛前不要单独删除，否则 CLI 兜底会静默消失。
3. **插件 provider**：它们落在 744。删除 744 会让外部 provider 直接 `no_model_strategy`，需确认插件契约是否承诺通用探测。
4. **本机验证范围**：无真实上游调用的验证（打桩矩阵、单测）可随时跑；真机探测受风控/额度限制，一次改动最多 1–2 次。

---

## 附录 A：可达性追踪脚本（只读，放在 /tmp）

```js
// 只替换叶子实现，派发链保持真实
const path = require('path');
const ROOT = '/Users/model/projects/feature/ai_home';
const trace = [];
function patch(modPath, fnName, impl) {
  const m = require(path.join(ROOT, modPath));
  m[fnName] = async (...a) => { trace.push(fnName); return impl(...a); };
}
const fail = () => { throw Object.assign(new Error('STUB_FAIL'), { code: 'stub' }); };
patch('lib/server/opencode-server-client.js', 'probeOpenCodeCatalog', fail);
patch('lib/server/opencode-server-client.js', 'fetchOpenCodeModels', () => ['fallback-opencode']);
patch('lib/server/http-utils-zcode.js', 'fetchZcodePlanBalanceModels', () => null);
patch('lib/server/codex-model-client.js', 'fetchCodexModelsForAccount', fail);
patch('lib/server/http-utils-code-assist.js', 'fetchGeminiCodeAssistModels', fail);
patch('lib/server/model-discovery/generic-models-probe.js', 'fetchGenericModelsProbe', fail);
patch('lib/server/native-cli-model-discovery.js', 'discoverNativeCliModels', () => null);

const { fetchModelsForAccount } = require(path.join(ROOT, 'lib/server/http-utils.js'));
// 逐 case 调用 fetchModelsForAccount，打印 trace 与返回/错误
```

实测输出（节选）：

```
opencode login              => probeOpenCodeCatalog -> discoverNativeCliModels -> fetchOpenCodeModels | models=["fallback-opencode"]
zcode login                 => fetchZcodePlanBalanceModels | throw:zcode_jwt_missing_relogin
zcode api-key               => fetchGenericModelsProbe -> discoverNativeCliModels -> fetchGenericModelsProbe | throw:stub
claude login                => fetchGenericModelsProbe -> discoverNativeCliModels -> fetchGenericModelsProbe | throw:stub
codex login                 => fetchCodexModelsForAccount -> discoverNativeCliModels -> fetchCodexModelsForAccount | throw:stub
codex api-key               => fetchGenericModelsProbe -> discoverNativeCliModels -> fetchGenericModelsProbe | throw:stub
gemini login+oauth-personal => fetchGeminiCodeAssistModels -> discoverNativeCliModels -> fetchGeminiCodeAssistModels | throw:stub
```

---

## 附录 B：相关文档

- `docs/plans/2026-11-05-provider-descriptor-retirement.md` §5.2 / §7：已把 `706/710/726/728/739` 列为退役 `models` 能力的前置阻塞。
- `docs/plans/2026-11-05-node-dead-code-inventory.md`：确认 `http-utils-zcode.js` / `opencode-server-client.js` / `code-assist-*` 仍不能删（本次删除的是**调用点**，不是模块）。
- `docs/plans/2026-11-04-node-go-merge.md` §1.3 / §8：模型目录终态归 Go，但不能按 provider 直接搬。
