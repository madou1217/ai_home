# dev-4：http-utils 模型发现兜底分支核对

日期：2026-11-05
范围：`lib/server/http-utils.js` 的 `fetchModelsForAccount`（620–745），重点 706 / 710 / 726 / 728 / 739。
约束：只读 + 文档。**未改代码、未提交、未重启服务**；工作区他人改动未触碰。

## 交付物

- 新增：`docs/plans/2026-11-06-http-utils-provider-fallback.md`（核对、删除条件、两套替代方案、风险、落地顺序）
- 报告：本文件

## 核对结论

| 位置 | 原判断 | 实测判定 | 证据 |
| --- | --- | --- | --- |
| 706–708 `opencode` | 硬编码兜底 | **重复探测**，非独立策略 | `fetchOpenCodeModels` 就是 `probeOpenCodeCatalog().models`（`opencode-server-client.js:393-396`）；链上 `opencode-models` handler 已调用同一函数 |
| 709–722 `zcode` | 硬编码兜底 | **登录态不可达**；api-key 条件恒假 | `zcode-plan-models` handler 在无目录时抛 `terminal: true`，`model-discovery/index.js:95` 直接上抛 |
| 723–726 `claude` | 硬编码兜底 | **纯死变量** | `claudeAuthTokenProxy` 全文件只出现在 726，从未被读；同逻辑真实位置是 `generic-models-probe.js:97` |
| 727–738 `codex` | 硬编码兜底 | **重复探测** | `codex-native-models` handler 的入参与 732 逐项相同（同一 `requestOptions`、同一 `fetchWithTimeout`） |
| 739–741 code-assist | 硬编码兜底 | **重复探测**（对 `oauth-personal` 账号） | `code-assist-models` handler 已调用 `fetchGeminiCodeAssistModels(deps.requestOptions, account, timeoutMs)`，与 740 完全相同 |
| 742–744 通用探测 | 「未声明策略」兜底 | 对已声明 generic 策略的 provider 是**第三次探测** | claude / codex(api-key) / zcode(api-key) / gemini(api-key) 的链尾都是它 |

**一句话**：这五处不是「另一条策略」，而是同一条策略的第二次执行；其中一处（zcode 登录态）根本执行不到，一处（726）连变量都没人读。

## 验证方式（关键）

没有只做静态判断。用「叶子打桩 + 真实派发链」追踪：只替换 `probeOpenCodeCatalog` / `fetchZcodePlanBalanceModels` / `fetchCodexModelsForAccount` / `fetchGeminiCodeAssistModels` / `fetchGenericModelsProbe` / `discoverNativeCliModels` 六个叶子，**不替换** `discoverProviderModelsViaStrategies`，让 mode 过滤、terminal 上抛、`describeNativeCliFallbackFailure` 全部走真实代码。

实测 trace：

```
opencode login              => probeOpenCodeCatalog -> discoverNativeCliModels -> fetchOpenCodeModels
zcode login                 => fetchZcodePlanBalanceModels -> throw:zcode_jwt_missing_relogin
zcode api-key               => fetchGenericModelsProbe -> discoverNativeCliModels -> fetchGenericModelsProbe
claude login                => fetchGenericModelsProbe -> discoverNativeCliModels -> fetchGenericModelsProbe
codex login                 => fetchCodexModelsForAccount -> discoverNativeCliModels -> fetchCodexModelsForAccount
codex api-key               => fetchGenericModelsProbe -> discoverNativeCliModels -> fetchGenericModelsProbe
gemini login+oauth-personal => fetchGeminiCodeAssistModels -> discoverNativeCliModels -> fetchGeminiCodeAssistModels
```

附带的两个结构性发现：

1. **尾部只对 8 家可达**。有 `cli` 规格的 8 家（codebuddy / codebuddycn / grok / kiro / qoder / qodercn / workbuddy / workbuddycn）在 `http-utils.js:703` 就抛了，永远到不了 706。可达的只有 agy / claude / cline / codex / gemini / kimi / opencode / zcode。
2. **grok 的 CLI 会跑两次**。描述符用 `handler: 'native-cli'`，链内执行一次；链失败后 `:701` 再执行一次。qoder / kiro / 家族则用 `discover: () => null` 占位，只执行一次 —— 同一执行器、不同调用次数，取决于 provider。

## 删除条件（摘要）

全局：等价性、错误对象无外部依赖、守卫能在旧代码上变红、scheduler 注入路径有用例、插件不受影响。

逐分支：

- **726**：无前置，**可立即删**（连带 `:35` 的 `isClaudeAuthTokenAccount` 导入）。同处 `isApiCredentialAccount`（`:36`）与 `KNOWN_CLINE_MODELS`（`:68`）是**既有死导入**，可一并清理。
- **706**：需先决定 744 的去向。删掉后链失败会落到 744，而 opencode 没有 OpenAI 兼容 `/v1/models`，大概率把「opencode 失败」变成「通用探测抛错」。
- **709–722**：**必须先补 `emptyAuthoritative`**。`fetchZcodePlanBalanceModels` 在 balance 无模型时走 preview，preview 的 `catch` 返回 `[]`；旧分支因 `[]` 为 truthy 而直接 `return []`。删掉后会落 744 并对 OAuth 账号拼出推理端点 URL。这是本次唯一的高风险项。
- **727–738**：codex 是默认 provider，单独提交；另需确认 `shouldRejectEmptyRemoteModels` 的上游保护单独成立。
- **739–741**：先对齐描述符宽度。`modes: ['login']` 比 `shouldUseGeminiCodeAssist` 宽，且旧分支还覆盖「api-key + code-assist baseUrl」这一描述符无法表达的组合 —— 删除会让它收窄，需要口径确认。

## 替代方案

- **A 描述符驱动（推荐先做）**：补三条描述符语义 —— `emptyAuthoritative`（zcode）、认证形态条件（gemini/agy）、CLI 策略统一走 `handler: 'native-cli'`（消除 grok 双跑与 `discover: () => null` 占位）。做完后 `fetchModelsForAccount` 只剩「local → 解析 egress → 策略链 → 打标 → 返回/抛错」。
- **B Go 目录驱动（终态，不能作为本次前置）**：Go 的 `modelProviderModules()` 覆盖 12 个模块家族，但明确不覆盖 grok OAuth（`model_providers.go` 自述为能力边界），且 Go core 允许启动失败、失败时路由交还 Node。把目录完全押 Go 会让「Go 起不来」变成「模型列表空」。迁移文档 §8 也写明目录不能按 provider 直接搬。

## 风险

| 风险 | 级别 | 说明 |
| --- | --- | --- |
| zcode 空目录变抛错 | 高 | 必须先做 `emptyAuthoritative`，否则不要删 709–722 |
| codex 默认 provider 回归 | 高 | 单独提交 + login/api-key 双模式集成用例 |
| 首启冷账号变慢 | 中 | 丢失「立即重试一次」；调度器补课 60–120s、错误退避 10min |
| opencode 落到错误端点 | 中 | 与 744 处置同批提交 |
| code-assist 策略过宽被固化 | 中 | 先对齐描述符宽度 |
| 并发改动冲突 | 中 | 仓库有他人未提交改动；提交只带自己的 pathspec |

## 未做 / 边界

1. 未改任何代码，未运行全量测试（本次没有代码变更需要回归）。
2. 未做真机探测（受上游风控/额度限制），所有结论来自静态引用与本地打桩。
3. `http-utils.js:621` 的默认值 `account.provider || 'codex'` 也是 provider 名硬编码，比五处兜底更隐蔽；本次只记录、未纳入范围。
4. 工作区在评估期间被其它 agent 改过（描述符删 `acp` / `relay.strategy`），已核对**不触及** `models.strategies`，结论不受影响。

## 改动清单

`git status` 中本次只新增：

- `docs/plans/2026-11-06-http-utils-provider-fallback.md`
- `docs/agent-reports/dev-4.md`

其余改动均来自其它并行任务，未触碰。
