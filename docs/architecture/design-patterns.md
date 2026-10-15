# 设计模式与架构清单（aih）

> 本文是**唯一的设计模式清单**：现有代码哪里用了什么模式、哪里还在用 if/else 该改、改成什么、验收标准。
> 规则（AGENTS.md 同步）：**新增 provider 能力 / 采集面 / 协议分支，禁止写 `if (provider === '…')`**，
> 一律走「描述符声明 + 注册表倒排 + 策略链执行」。改动架构后必须回来更新本文。

## 0. 为什么（一句话）

provider 从 4 个长到 16 个、且还会加：**每加一个 provider，散落的 if/else 就多一份维护成本和漏改风险**。
2026-10-15 的两次事故都是这个结构问题：kiro 的额度/模型采集各自只有一条硬编码路径，没人回答过
「没装本地客户端时怎么办」，于是两个看似权限问题的报错（`kiro_identity_access_denied`、
`native_cli_model_discovery_cli_not_found`）其实是缺抽象。

## 1. 已落地的模式（现状）

| 模块 | 模式 | 作用 | 验证 |
| --- | --- | --- | --- |
| `lib/providers/contract.js` | **Contract / Schema 校验** | provider 描述符契约：能力必须显式回答（`supported` + `reason`/策略），transport↔clientDependent 自洽，只有客户端通道必须写 `clientFreeReason` | `test/provider-capability-registry.test.js`、`test/quota-provider-coverage.test.js` |
| `lib/providers/registry.js` | **Registry + 倒排索引** | 能力名 → provider 集合；`getProviderCapability(provider, face)` / `listProviders(face)`，消费方问能力不问 provider | 同上 |
| `lib/providers/loader.js` | **Plugin Loader** | 扫描 `defs/`、`AIH_PROVIDER_DEFS_DIR`、`<AIH_HOME>/provider-defs`，外部插件与内置同构 | `test/provider-capability-registry.test.js` |
| `lib/providers/index.js` | **Facade（门面）** | 消费方唯一入口：`getProviderCapability` / `listProviders` / `listQuotaStrategies` | 全仓只 import 这里 |
| `lib/usage/quota/strategies.js` | **Chain of Responsibility（策略链）** | 额度：`clientDependent=false` 优先、失败自动切下一条、`attempts` 可观察 | `test/quota-provider-coverage.test.js` |
| `lib/server/provider-model-strategies.js` | **Chain of Responsibility** | 模型发现策略链（同一套语义，避免两套行为） | `test/kiro-pure-api.test.js` |
| `lib/usage/quota/view.js` | **ViewModel + Adapter（形态驱动）** | 各家快照形态 → 统一 scope（label/category/顺序/单位），展示层不认 provider | `test/quota-view.test.js` |
| `lib/cli/services/usage/{window,credit}-format.js` | **Adapter（保输出兼容）** | 视图模型的 CLI 适配层，输出与历史逐字节一致 | `test/usage.window-format.test.js` |
| `lib/server/account-usage-view.js` | **Table-Driven Mapping** | 账号 payload 归一：账号字段用声明式字段表，条目交给视图模型 | `test/quota-view-provider-coverage.test.js` |
| `web/src/components/account/quota-scopes.ts` | **Single Source of Truth（跨端契约）** | WebUI 展示行唯一派生处，只镜像服务端契约，不镜像 provider 名单 | 同上 |
| `lib/account/native-auth-projection.js` | **Strategy（每 provider 一个投影策略）+ CAS** | 凭据投影/回写；`compareAndSwapAccountNativeAuth` 防并发覆盖 | `test/cline-*`、`test/kiro-*` |
| `lib/account/host-account-sync/index.js` | **Observer Registry** | 宿主登录态观察者注册表；与删除墓碑集合互相守卫 | `test/host-account-sync-registry.test.js` |
| `lib/runtime/provider-resume.js` | **Strategy Table** | 「恢复会话」策略表（各 provider 的 resume 参数） | `test/provider-resume.test.js` |
| `lib/runtime/host-capabilities.js` | **Facade + Adapter（宿主机能力门面）** | 「是不是桌面环境 / 某个应用装了吗 / 装不了能不能装」三问收敛到一处，组合既有 app-entries 探测器与安装器注册表，不重复实现探测 | `test/host-capabilities.test.js`、与 `isCliInstallSupported` 的交叉守卫 |
| `lib/account/auth-sources.js` | **Chain of Responsibility（认证来源链）** | 「这台机器上有哪些账号来源」= 描述符声明 + 宿主机能力 → 可用性排序（**可用优先 → 本机来源优先**，刻意与采集链的「不依赖客户端优先」相反）+ 已入库去重；不可用来源不给实现 | `test/auth-sources.test.js`、真机 `/v0/webui/accounts/provider-auth-sources` |
| `lib/account/host-auth-import.js` | **Adapter（宿主凭据 → 账号投影）** | 把宿主 CLI/IDE 的登录态物化进新账号 runtime dir，注册仍走既有 `registerProviderAuthProjection`；去重指纹两侧同源（`identitySeed`，对 token 轮换免疫） | `test/auth-sources-import.test.js`、真机 claude/gemini（可导入）与 codex/kimi（已入库不显示） |
| `lib/providers/loader.js` | **Convention over Configuration（默认注入）** | 有宿主凭据产物 + 认证方式含 `oauth-browser` 的 provider **自动**获得 `<provider>-host-local` 来源，显式声明优先；新增 provider 不必再抄声明 | 同上 |
| `lib/server/account-runtime-gate.js` | **Facade / Mediator** | 账号运行态唯一门禁，六条臂统一记账，禁止旁路 | `test/account-runtime-gate-wiring.test.js` |
| `lib/account/runtime-target.js` | **Value Object（运行目标）** | 把「具体账号 / 网关作用域（`gateway:<provider>`）」统一成一个目标对象；调用方（codex app-server、原生会话、chat harness）不再各自判断账号形态 | `test/runtime-target.test.js` |
| `lib/server/chat-runtime/chat-session-coordinator.js` | **Rebind（会话换执行凭据）** | 同 provider 换账号 = 换执行凭据而非换会话：会话 id/时间线不变，harness 重绑 + history seed 回填 | `test/chat-runtime-composition.test.js` |
| `lib/server/chat-runtime/chat-harness-gateway.js` + `chat-harness-model-reader.js` | **Strategy（按运行作用域分流）** | 网关作用域：不写 `X-Account-Ref`（网关池化选号 + 别名回落）、模型目录取 provider 全池；账号作用域：钉选 + 单账号目录 | `test/chat-harness-gateway.test.js` |
| `web/src/features/chat-runtime/session-surface-policy.ts` | **Policy（纯函数决策）** | `resolveChatAccountChange`（ignore / retarget / new-session）与网关目标解析，渲染层只执行结论 | `web/src/features/chat-runtime/session-surface-policy.test.ts` |
| `scripts/provider-collection-audit.js` | **可观察性审计** | 把「有没有不依赖客户端的通道」变成可打印、可守卫的事实 | `npm run providers:audit` |


## 2. 反模式清单（该改的地方）

扫描口径：`grep -rn "provider === \|provider !== \|normalizedProvider ===" lib/ --include='*.js'`（排除测试）。
**同一文件出现 2 处以上 provider 名比较 = 该文件需要一次策略化改造**（2026-10-15 扫描）。

| 优先级 | 文件 | 处数 | 现在在做什么 | 目标模式 |
| --- | --- | --- | --- | --- |
| P0 | `lib/server/http-utils.js` | 11 | 模型发现按 provider 名分支（opencode/zcode/codex/gemini/kimi/claude…） | **Handler Registry**：描述符声明 `models.strategies[].handler`，实现在 `lib/server/model-discovery/handlers/*.js`；http-utils 只做门面调用 |
| P0 | `lib/server/native-cli-model-discovery.js` | 中央表 | `NATIVE_CLI_MODEL_STRATEGIES` provider→CLI 参数表 | **策略表迁进描述符**（`cli: { args, format }`），该文件降级为执行器 |
| P1 | `lib/server/webui-account-live.js` | 26 | 账号视图按 provider 拼字段/行为 | **Descriptor-driven ViewModel**（`accountView` 能力） |
| P1 | `lib/server/webui-chat-routes.js` | 24 | 聊天/会话按 provider 分支 | **Adapter + Strategy**（`launch/attach/stream` 适配器接口） |
| P1 | `lib/server/webui-account-routes.js` | 22 | 账号操作按 provider 分支（登录/刷新/删除） | **Command Registry**（路由只做鉴权与派发） |
| P1 | `lib/server/native-session-chat.js` / `-command.js` | 21 / 15 | 原生会话命令按 provider 拼 argv | **Strategy Table**（同 `provider-resume.js`） |
| P2 | `lib/account/native-auth-projection.js` | 20 | 投影按 provider 特判 | **Strategy**：每 provider 一个 projection strategy 模块 |
| P2 | `lib/server/provider-session-hook-config.js` | 15 | hook 配置按 provider 分支 | **Descriptor**（`hooks` 能力） |
| P2 | `lib/usage/model-usage-store.js` | 10 | 用量读取按 provider 分支 | **Adapter**（`usage` 能力扩展） |
| P2 | `lib/server/upstream-endpoints-path.js` | 10 | 上游路径按 provider 分支 | **Strategy**（协议适配器表，与 `protocol-*.js` 合并） |
| P3 | `lib/account/credential-layout.js`、`lib/account/transfer-core.js`、`lib/sessions/session-reader.js`、`lib/server/models.js`、`lib/server/models-dev-metadata.js`、`lib/server/web-account-auth*.js`、`lib/server/webui-project-cache.js` | 6–10 | 凭据布局 / 导入导出 / 会话解析 / 模型元数据 | Strategy / Table / Adapter，随对应能力面迁移 |

需要消失或降级为「契约派生」的中央 provider 清单：`lib/server/providers.js`、`lib/server/accounts.js`、
`lib/server/protocol-fallback-bridge.js`、`lib/server/web-account-auth*.js`、`lib/server/webui-project-cache.js`、
`lib/server/provider-session-hook-config.js`、`lib/usage/codebuddy-*`、`lib/usage/model-usage-read-projection.js`、
`lib/server/native-cli-model-discovery.js`。

## 3. 改造路线（每步独立可验证、可回滚）

**Phase 1 — 采集面（额度 + 模型）彻底策略化**
1. ✅ 额度：16/16 provider 声明策略链，`clientDependent=false` 优先 + CLI 兜底（kiro 已实测纯 API）。
2. ✅ 模型：16/16 provider 显式回答（`models` 能力），CLI-only 必须写 `clientFreeReason`。
3. ✅ **Handler Registry**：`lib/server/model-discovery/{handler-registry,http-handlers,generic-models-probe}.js` + 门面；
   描述符声明 `handler: '<id>'`；通用探测已搬出 `http-utils.js`（provider 名分支逐面删除，等价性测试 71/71）。
4. ✅ CLI 模型表迁进描述符（`models.strategies[].cli = { args, format, configDirFlag, minTimeoutMs }`），
   `native-cli-model-discovery.js` 只留执行器，中央 provider→CLI 参数表已删除。
5. ✅ `local` transport 策略在出网解析之前执行（cline 的静态规范清单不再依赖出网配置）。

**Phase 2 — 账号视图与操作**
5. ⬜ `accountView` 能力：账号视图字段/行为由描述符声明。
   * 形状（设计已定）：`capabilities.accountView = { fields: ['planType','planName',…], badges: ['plan','subscription'], actions: ['refresh','relogin','delete','set-default'], desktop?: {…} }`
   * 迁移对象：`lib/server/webui-account-live.js`（25 处）→ 视图层只读 `accountView`，不再判 provider。
6. ⬜ 账号操作 Command Registry（登录 / 刷新 / 删除 / set-default）。
   * 形状：`capabilities.actions = { refresh: 'handler-id', relogin: 'handler-id', … }`；路由只做鉴权 + `Facade.dispatchAction(provider, action)`。
   * 迁移对象：`lib/server/webui-account-routes.js`（22 处）。
7. ⬜ 协议路径策略化（`upstream-endpoints-path.js` 24 处）。
   * 注意：该文件是 `upstream-endpoints-split` 脚本生成的（文件头写明 do not edit manually）——
     必须改**生成器 + 模板**，并新增 `capabilities.protocolPath = { resolve(account, reqUrl, upstreamBase) }`；
     claude 的 `/v1` 去重、codebuddy 家族的 `/v1→/v2` 抬升等规则随描述符走。
8. ✅ `hooks` 能力：`lib/server/provider-session-hook-config.js` 的 15 处 provider 名分支**清零**。
   形状：描述符声明**档案**（`adapter` / `target` 路径段 / `timeoutUnit` / `eventMatchers` / `featureFlag`），
   格式实现留在**适配器策略表**（`HOOK_ADAPTERS`：`json_hooks` / `agy_named_hooks` / `opencode_plugin`，
   与 Go 合同 `sessionSync.adapter` 同源）；派发处零 provider 名，targetKind 直接取合同字段
   （原 `HOOKS_JSON_TARGET_PROVIDERS` 手写集合已删除）。漂移由 `test/design-pattern-guard.test.js`
   的「描述符 ↔ 合同一致性」用例双向守住。
9. ⬜ 用量读取适配器：`lib/usage/model-usage-store.js`（10 处）→ `usage` 能力扩展。

**Phase 3 — 会话与聊天**
10. ⬜ `native-session-chat*`（21 + 18 处）与 `webui-chat-routes.js`（26 处）→ **Adapter + Strategy Table**。
    * 形状（设计已定）：每 provider 一个会话适配器 `{ launchArgs(ctx), resumeArgs(ctx), streamParser, sessionIdFrom(event) }`，
      由描述符 `capabilities.sessionAdapter` 声明；命令层只做「取适配器 → 拼 argv → 执行」。
    * 参照实现：`lib/runtime/provider-resume.js`（策略表）与 `lib/cli/services/ai-cli/launch-profile/*-strategy.js`（每 provider 一个策略模块）。

**Phase 4 — 收口守卫**
11. ✅ 收口守卫：`test/design-pattern-guard.test.js` —— 描述符声明的 handler 必须已注册；63 个已知文件
   记录基线（只能减不能增）；`lib/` 下新增文件 ≥2 处 provider 名比较即红；基线里已清零的文件必须移除条目。

**验收标准（每个 provider × 每个采集面）**
- `npm run providers:audit` 显示该面的通道与依赖；CLI-only 必须带原因。
- 该 provider 的**纯 API 路径有真实账号实测证据**（不是「应该可以」）。
- 失败时账号页只呈现**原因**（结构化 reason + attempts）；不要给用户写「操作建议」——修复是开发者的责任，不是用户的作业。
