# Provider 写死分支收敛方案（M4 前置）

日期：2026-10-05。状态：方案，未实施。范围：内置 Provider 在 Node 服务端、CLI 与 WebUI 中按 provider 名写死的分支。与 [插件化规划](2026-09-30-plugin-architecture-plan.md) 的 M4「内置 Provider 以现有注册表 Adapter 暴露、分能力端口」对齐，本方案只做 M4 的前置整理，不改插件合同、不改插件宿主、不改 Go 侧 `ProviderID.IsValid`。

## 1. 现状

统计口径：`lib/` 与 `web/src/`（不含测试）中 `=== '<provider>'`、`!== '<provider>'`、`case '<provider>':`，且所在行与 provider/family 相关。共 **654 处，分布在 163 个文件**。

按 provider：

| codex | claude | agy | kimi | gemini | opencode | zcode | grok | kiro | qoder | workbuddy | codebuddy |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 169 | 109 | 108 | 72 | 71 | 53 | 41 | 31 | 22 | 10 | 4 | 2 |

按关注点（按文件归类，粗分）：

| 关注点 | 处数 | 集中文件（处数） |
|---|---|---|
| 账号凭据 / 身份 / 导入导出 / 账号页数据 | 217 | `account/standard-transfer.js`(38)、`server/webui-account-live.js`(36)、`account/transfer-core.js`(23)、`server/webui-account-routes.js`(19)、`account/account-identity.js`(19)、`account/native-auth-projection.js`(12) |
| 会话读取 / 原生会话驱动 / hook | 164 | `sessions/session-reader.js`(34)、`server/webui-chat-routes.js`(22)、`server/native-session-chat.js`(20)、`server/native-session-chat-command.js`(16)、`server/provider-session-hook-config.js`(15) |
| 网关路由 / 上游 / 模型目录 | 81 | `server/upstream-endpoints-path.js`(10)、`server/http-utils.js`(10)、`server/provider-model-discovery.js`(8)、`server/models-dev-metadata.js`(7) |
| WebUI 展示 | 71 | `pages/AccountsGoPreview.tsx`(10)、`features/accounts/AddAccountModal.tsx`(8)、`components/account/UsageSnapshotCell.tsx`(8)、`features/accounts/account-state.ts`(6) |
| 用量 / 额度 / 令牌刷新 | 44 | `server/token-refresh-daemon.js`(8)、`usage/model-usage-store.js`(7)、`server/kimi-token-refresh.js`(5) |
| 桌面 / 出口 / 安装 | 11 | `server/zcode-egress-service.js`(10) |
| 其他（CLI 诊断、技能安装、Go 账号同步等） | 66 | 分散，单文件 ≤4 |

典型形态（抽样）：

- **静态事实写成代码**：`if (provider === 'codex') return 'openai'; if (provider === 'claude') return 'anthropic'; …`（厂商标识）、`if (provider === 'codex') return env.OPENAI_BASE_URL`（基址环境变量）、`provider === 'claude' || provider === 'codex' || provider === 'opencode' || …`（能力名单）。
- **按 provider 分派的行为**：`account-identity.js` 里 codex 取 `auth`、claude 取 `credentials`、kimi 走 `readKimiOAuthCredentials`；`session-reader.js` 的 `switch (provider)`。
- **单家运行时特例混在通用流程里**：`native-session-chat.js` 中 `provider === 'agy'` 的写锁/预热池、`provider === 'gemini'` 的会话文件续写。
- **前端按 provider 渲染**：`UsageSnapshotCell` 里 `provider === 'kimi' && snapshot.kind === 'kimi_oauth_usage'`。

已有可复用的模式：`contracts/providers/manifest.json` + `lib/provider-catalog.js`（数据驱动的 Provider 清单，已含 authOptions、cli、headless、clients、sessionSync、gateway、capabilities 等）、`lib/provider-native-capability-registry.js`、`lib/server/oauth-strategies/`、`lib/server/desktop-launch/`（策略注册表，启动器零 provider 分支）、`image-generation-strategy-registry.js`、启动失败的 `requiredAction` 声明（9ce57c88）。

## 2. 原则

1. **事实入数据**：只是「某 provider 对应某个值/是否支持某能力」的，进 `contracts/providers/manifest.json`，经 `provider-catalog` 读取；代码里不再出现 provider 字面量。
2. **行为入能力端口**：按关注点拆端口（凭据、用量、会话、上游、桌面），每个端口一个注册表、每家一个实现模块，调用方只依赖端口。这正是 M4 要求的「分能力端口，未实现的能力明确缺席」。没注册的 provider 走中性默认实现或明确返回「不支持」。
3. **展示由服务端声明**：WebUI 不按 provider 名分支，读服务端给出的展示描述（如用量快照的 `presentation`、启动失败的 `requiredAction`），只保留通用渲染器。
4. **行为不变**：每批先对涉及的函数做 golden 采集（同一组输入的输出逐字节比对），改完必须一致；不顺手改语义。
5. **小步、按文件、不碰他人改动**：每批开始前比对 `git status`，有其它会话未提交改动的文件先跳过或等对方提交；只提交自己的 hunk。

## 3. 目标结构

| 端口 | 位置（新建） | 每家实现提供 | 吸收的现有分支 |
|---|---|---|---|
| 静态事实 | `contracts/providers/manifest.json` 新字段 | `vendorId`、`baseUrlEnvKeys`、`capabilities.nativeChatApiKey` 等 | 散落各处的 `return '<literal>'` 与 `a === 'x' \|\| a === 'y'` 名单 |
| 凭据 `provider.credentials` | `lib/account/provider-credentials/{index,<id>}.js` | 从原生凭据文件提取 auth、身份字段（邮箱/workspace）、投影布局、标准导入导出格式 | account-identity、native-auth-projection、credential-layout、standard-transfer、transfer-core、unified-import |
| 用量 `provider.usage` | `lib/usage/provider-usage/{index,<id>}.js` | 用量快照解析、额度窗口、令牌刷新钩子、展示描述 | webui-account-live 的用量部分、model-usage-store、token-refresh-daemon、kimi-token-refresh、前端 UsageSnapshotCell/account-state |
| 会话 `provider.session` | 复用 `lib/server/chat-runtime/*-session-driver` 的驱动边界，补 `lib/sessions/provider-session-readers/` | 会话文件读取、续写方式、写锁/预热需求、hook 配置与事件归一 | session-reader、native-session-chat*、provider-session-hook-config、provider-hook-event-normalizer、native-slash-commands |
| 上游 `provider.upstream` | `lib/server/provider-upstream/{index,<id>}.js` | 路径拼接、模型探测方式、失败分类特例 | upstream-endpoints-path、http-utils、provider-model-discovery、upstream-failure-policy |
| 桌面启动 | 已有 `lib/server/desktop-launch/` | — | zcode-egress-service 中剩余的判断 |

端口契约字段名与 `contracts/plugins` 对齐（`id` / `capability` / `platforms`），以便 M4 直接把这些内置实现作为 Adapter 暴露。

## 4. 分批计划

| 批次 | 内容 | 预计收敛 | 风险 | 验收 |
|---|---|---|---|---|
| 1 | 静态事实入 manifest：厂商标识、凭据环境变量（已完成，见下） | 实际 2 处写死逻辑 + 1 张 15 家的表；另有 3 处待决 | 低：纯查表替换 | golden 一致；manifest 生成/校验测试；全量单测 |
| 2 | 凭据端口：身份提取、凭据投影、导入导出格式 | 约 120 处 | 中：涉及账号身份唯一键（见 `account-identity.js` 单一来源约定） | golden 覆盖 12 家导入/导出往返；真实账号导入导出各 1 次；账号页对比 |
| 3 | 用量端口 + 前端展示声明 | 约 100 处 | 中：额度显示与刷新时机 | golden；账号页 1440/390 两种宽度真浏览器；各家用量快照逐一核对 |
| 4 | 会话端口：会话读取、原生会话驱动特例、hook | 约 160 处 | 高：原生会话最易回归；chat-runtime 有其它会话在改 | 先与 chat-runtime 负责会话对齐；每家真实发消息/续写/列表可见各 1 次（Playwright） |
| 5 | 上游端口：路径、模型探测、失败分类 | 约 80 处 | 高：与 Go Core 数据面、插件 M2 网关接线重叠 | 与插件主线会话确认边界后再做；真账号打真上游 |

批 1–3 可独立推进；批 4、5 需要先和对应主线会话确认边界。

### 批 2 进展（2026-10-05）

凭据端口落在 `lib/account/provider-credentials/`（每家一个模块，qoder、codebuddy 家族用工厂；无模块的 provider 走中性默认）。已完成、行为不变的三步：

1. 「按原生身份去重」名单（`native-auth-projection.js` 两处、`unified-import.js` 一处，三份成员一致）→ 模块标记 `dedupeByNativeIdentity`。
2. 「只靠环境变量即可鉴权」表（`provider-runtime-env.js`）→ 由合同 `apiKeyEnv ∪ authTokenEnv` 推出；opencode、grok 的例外改为合同事实 `credentials.cliRequiresAuthFile`。988 组输入黄金比对一致。
3. `resolveNativeAuthIdentitySeed` 的取载荷与出种子 → 模块的 `extractNativeAuth` / `nativeIdentitySeed` / `fallbackIdentity`（qoder PAT）；账号描述对象的邮箱身份白名单 → `emailIsIdentity`。黄金比对：测试夹具 586 组输入、本机 32 个真实账号（仅比对哈希）全部一致。

第 4 步（注册身份 vs 导入导出身份）结论：同一份载荷下 14 家三条路径种子一致；kiro 例外——它的种子需要完整原生凭据，导入导出路径只拿到 `auth`，因此算不出（kiro 本来也不支持导出）。拆包差异只影响包了一层的导入文件格式。

`native-auth-projection.js` 的运行时特例（kiro CAS 写入、codebuddy 收编、claude 钥匙串）与会话端口耦合，移到批 4 一起做。

第 5 步（导入导出编解码，用户选方案 A：只搬结构、缺口原样保留）已完成：`transfer-core.js` 与 `standard-transfer.js` 不再按 provider 名分支——导入别名、邮箱位置、导入导出身份种子、导入时的专属凭据变量、导出记录、可否导出、sub2api 凭据形状、API 密钥导入写哪些变量、导入载荷 → 原生布局、标准格式 OAuth 规范化，都由模块声明（gemini、agy、kimi 的规范化函数整体移入各自模块）。黄金比对全部一致：纯函数 4058 组（录制的测试输入 × 全部 provider，codex 的 last_refresh 时间戳已屏蔽）、导出记录 2400 组 + 本机 32 个真实账号（同一时刻比对）、标准格式内部函数 8528 组。

保留的缺口（测试固定，待用户按需补齐，即方案 B）：zcode 与 CodeBuddy 家族不可导入；grok、kiro、zcode、CodeBuddy 家族、qoder 不可按 OAuth 导出；qoder 的标准格式 OAuth 导入判无效。仍留在原处、未搬的 provider 特例：`inferImportProvider` 的载荷形状启发式（跨 provider 的识别顺序）、`buildFlatAccountExportFileName` 的 opencode/kimi/codex 文件名、kimi 的旧身份兼容与可用性门槛、`buildStandardOAuthIdentity` 的 opencode/kimi 不拆包。

### 批 3 进展（2026-10-05，服务端部分完成）

用量端口落在 `lib/usage/provider-usage/`（codex、claude、gemini、agy、kimi；快照 kind 引用现有的 `USAGE_SNAPSHOT_KINDS`，不另立注册表）。按位置计数（非行数），用量相关约 90 处分支：静态事实约 25、服务端行为约 35、前端展示约 20、确属单家流程约 12（kimi 扫码登录、codex 重置卡、claude 凭据模式等，保留）。

已完成、行为不变：
1. 套餐展示名表（codex、claude）→ 模块 `planLabel`；两份含义不同的「用量托管」名单 → `accountSnapshotRefresh`（codex/claude/gemini/agy/kimi）与 `ptyUsageStatus`（codex/claude/gemini）；删掉未使用的 `PROVIDER_GLOBAL_DIR`。2058 种组合一致。
2. 令牌刷新守护进程 → `lib/server/token-refresh-strategies.js` 策略表（grok 强制自愈、kimi 自行处理失效抑制写成字段）。用假刷新器跑两轮 tick，调用日志与守护日志前后一致。
3. 异步配额探测 → 与同步表并列的 `asyncUsageProbeHandlers`；codex 恢复阶梯原样移入 `probeCodexUsageAsyncWithCachePolicy`。`cache.js` 的可信快照校验依赖注入的来源常量，改表收益小，暂留。
4. 账号页邮箱/套餐/主标识的取法 → 模块 `cachedAccountMetadata` / `liveAccountIdentity`。与旧代码逐字抄录版在 9264 种输入上比对一致。

前端（`UsageSnapshotCell` 改为按快照 kind 的渲染器表、剩余额度计算、`AccountsGoPreview` 的重复副本）待用户对以下差异做决定后再做：前端自算的最低剩余不认 codebuddy、预览页副本还漏了 zcode；前端优先快照最低值而服务端 `remainingPct` 可能优先状态值；`ptyUsageStatus` 不含 agy、kimi。

### 批 1 实施结果（2026-10-05）

普查后发现「纯静态事实」比估计的少：大部分 `cliName !== 'codex'` 是厂商专属模块开头的防卫判断，属于批 2–4 的行为端口。批 1 实际做法：

- Go 合同新增可选的 `credentials`（`vendorId`、`apiKeyEnv`、`authTokenEnv`、`baseUrlEnv`，列表按优先级），生成期校验环境变量名与厂商标识；Node 经 `getProviderCredentialFacts` 读取。
- 收敛两处含义完全一致的写死逻辑：sub2api 导出的 `platform` 映射（`standard-transfer.js`）、按 API 密钥环境变量判定账号类型的整张表（`account-identity.js`，15 家）。黄金比对：12 家 × 14 种环境变量的账号类型判定 210 种组合全部一致；`platform` 映射仅对未规范化输入（如 `'CODEX'`）有差异，调用方实际只传规范化 id。
- 刻意保留 `cli.envKeys`（无类型的混合列表，含 `GROK_HOME`、`KIRO_TEST_DB_PATH` 等），不改其含义。

**扩大行为的三处（用户 2026-10-05 同意后已改，统一经 `lib/account/provider-credential-env.js` 读取）：**

| 位置 | 现状覆盖 | 换成查表后新增 |
|---|---|---|
| `cli/services/usage/presenter.js` `isApiKeyAccount` | codex、claude（含 AUTH_TOKEN）、gemini、kimi | opencode、grok、qoder、zcode、codebuddy 家族被识别为 API 密钥账号 |
| `server/webui-account-live.js` `resolveApiKeyBaseUrl` | codex、claude、gemini | opencode、grok、kimi、zcode、codebuddy 显示环境变量里的基础地址 |
| `cli/services/account/selection.js` `readApiKeyInfo` | codex、claude、gemini（gemini 基础地址漏了 `GOOGLE_BASE_URL`） | 同上，并补上 `GOOGLE_BASE_URL` |

`cli/services/ai-cli/provider-runtime-env.js` 的 `ENV_AUTH_KEYS_BY_PROVIDER` 含义不同（「只靠环境变量即可鉴权、不需凭据文件投影」，故意不含 opencode/grok），归入批 2 凭据端口。kiro 的 `KIRO_API_KEY` 目前不参与账号类型判定，合同里暂不列入 `apiKeyEnv`，待批 2 确认。

## 5. 与其它工作的边界

- **插件主线（M2→M5）**：不改 `contracts/plugins/contract.json`、`lib/plugins/**`、Go `internal/adapters/pluginruntime`、`core/inference` 的 ProviderID 校验。本方案产出的端口注册表是 M4「内置 Provider Adapter」的输入。
- **当前有其它会话未提交改动的相关文件**（2026-10-05 快照，开工前须重新比对）：`server/upstream-failure-policy.js`、`account/account-removal.js`、`usage/model-usage-api-record.js`、`server/chat-runtime/codex-session-driver-support.js`、`server/upstream-endpoints-attempt.js`、`server/server.js`。
- **Go Core**：Go 侧已接管 9527 推理主路径；批 5 只整理 Node 侧回落路径，不改变路由所有权。

## 6. 不做

- 不新增 provider，不改任何 provider 的对外行为。
- 不把端口做成跨进程插件（那是 M4 的事）。
- 不清理测试里的 provider 字面量（测试按 provider 断言是正当的）。

## 7. 设计模式

| 模式 | 用在哪里 | 目的 |
|---|---|---|
| 数据驱动（Table-Driven） | 静态事实进 manifest | 事实只有一份，新增 provider 不改代码 |
| 策略 + 注册表（按能力端口） | 凭据 / 用量 / 会话 / 上游 | 开闭原则：加一家 = 加一个实现模块 + 一行注册 |
| Null Object / 明确缺席 | 未注册 provider 的端口实现 | 不支持的能力明确返回，不靠散落的 `!==` 兜底 |
| 服务端声明式展示 | 用量展示、启动后续动作 | WebUI 只保留通用渲染器 |
| 黄金快照比对 | 每批改造前后 | 证明行为不变 |
