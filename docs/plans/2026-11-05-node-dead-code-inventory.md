# Node 死代码清单：额度采集 / 模型目录 / 凭据解密

> 审计日期：2026-11-05
> 仓库：`/Users/model/projects/feature/ai_home`
> 基线：HEAD `594da688`，审计开始时工作区干净；审计期间仓库可能有其它并行改动，本清单未触碰它们。
> 性质：只读审计。未改代码、未删文件、未执行 git 写操作、未重启/停止任何服务。

## 0. 结论摘要

本次只盘点三块已由 Go 接管的能力在 Node 侧的遗留模块：

- 额度采集：kiro / agy / zcode / CodeBuddy 家族四支 / cline / qoder
- 模型目录：codex / claude / agy / kimi / grok / opencode / kiro / zcode / gemini / 家族四支 / qoder
- 凭据解密：zcode / qoder

| 分类 | 数量 | 含义 |
| --- | ---: | --- |
| 零引用 | 3 | 仓库内无 require/import/动态字符串引用，可进入删除候选 |
| 仅测试引用 + 死构造 | 1 | 生产只 require/构造、从未调用；测试仍直接引用 |
| 仍被使用 | 36 | 有 lib 生产引用，或位于动态加载路径，当前不能删 |
| **合计** | **40** | 主清单 |

风险分级汇总：

- **安全删：3 个**
- **需人工确认：1 个**
- **不能删：36 个**

三条关键结论：

1. 真正可以立即删的只有 3 个文件：cline 探针、zcode 静态模型表、模型发现兼容层。
2. `lib/cli/services/usage/zcode-quota-probe.js` 是“看起来死、实际带未迁功能”的最大文件：生产只构造不调用，但测试锁住 BigModel 5h/每周/MCP 附加额度映射，而 Go 尚未接这块（见 `docs/plans/2026-11-04-node-go-merge.md` §35）。不要放进第一批。
3. 大多数 Provider 专属模块仍在生产链上：Node 的模型发现 scheduler 仍按描述符探测；额度展示端口仍提供 plan badge；agy 失败兜底、CodeBuddy/Qoder 签到仍复用探针；zcode/qoder 解密仍服务导入、投影和 relay。**“Go 已接管”不等于“Node 文件可删”**。

## 1. Go 接管证据与判断边界

| 能力 | Go 侧已落地 | 代码证据 | Node 侧现状 |
| --- | --- | --- | --- |
| 额度采集 | kiro / agy / zcode / 家族 / cline / qoder 的 usage 策略 | `internal/adapters/{kiro,agy,zcode,codebuddyfamily,cline,qoder}/usage`；合并记录 §32–§39 | 这些 Provider（含家族四支与 qoder 双区）的描述符已写 `quota.supported:false`，但 Node 仍保留探针、展示端口与 agy 兜底 |
| 模型目录 | 全部目标 Provider 的目录源 | `internal/host/aihserver/composition.go` 的 `newModelDiscovery` 注册 codex/claude/agy/家族四支/kimi/grok/qoder/opencode/kiro/zcode/gemini | 描述符仍写 `models.supported:true`；`lib/server/webui-model-refresh-scheduler.js` 仍会调用 Node 发现链 |
| 凭据解密 | qodercred（wazero 跑厂商 wasm）、zcodecred | `internal/adapters/accounts/{qodercred,zcodecred}`；合并记录 §38 | Node 的 qoder/zcode 解密仍用于账号导入、身份推导、桌面投影、qoder relay、备份/导出 |

判断边界：

- Go 已接管的是**权威存储/采集能力**，不是 Node 的所有消费路径。
- 只有“Node 生产引用为零 + 不在动态加载路径 + 无测试依赖”才归为安全删。
- 只要 Node 还有生产引用，即使功能与 Go 重复，也归为“不能删”，并在备注里写清切换前置条件。

## 2. 测试组定义

删除后按下表选择测试组；每组命令都可直接执行。仓库没有 `npm test` 脚本，全量用 `node --test`。

| 组 | 命令 | 覆盖 |
| --- | --- | --- |
| T0 全量 | `node --test test/*.test.js` | 全量回归；首次删除后建议跑一次 |
| T1 额度核心 | `node --test test/provider-scope.test.js test/account-config-view.test.js test/go-usage-facts.test.js test/go-quota-state-store.test.js test/go-runtime-overlay-quota.test.js test/usage-snapshot-go-source.test.js` | 描述符加载、Go 额度事实/状态、账号页额度叠加 |
| T2 额度探针/展示 | `node --test test/zcode-coding-plan-quota.test.js test/zcode-plan-claim.test.js test/provider-activity-workbuddy.test.js test/account-selection-healthy.test.js test/healthy-account-selector.test.js` | zcode/家族探针、签到、额度窗口与健康选择 |
| T3 模型目录/路由 | `node --test test/model-catalog-invalidation.test.js test/gateway-model-cache.test.js test/go-model-catalog-projection.test.js test/model-route-source-scheduler.test.js test/model-alias-routes.test.js test/chat-harness-gateway.test.js` | 目录缓存/投影、刷新调度、模型别名与网关路由 |
| T4 凭据/账号 | `node --test test/native-account-transfer.test.js test/zcode-projection-credential-profile.test.js test/go-account-sync-edit-url.test.js test/account-display-names.test.js` | 账号导入导出、zcode 投影凭据、Go 对账、展示身份 |
| T5 用量/CLI 装配 | `node --test test/model-usage-scan-executor.test.js test/model-usage-scan-scheduler.test.js test/session-usage-refresh.test.js test/aih-node-warning-silent.test.js` | 用量 worker、CLI 装配、警告静默名单 |

## 3. 主清单

### 3.1 零引用：安全删（3 个）

| 文件 | 行数 | 引用证据 | 风险 | 删除后测试 |
| --- | ---: | --- | --- | --- |
| `lib/usage/quota/probes/cline.js` | 359 | **零引用**。require/import/字符串拼路径均无命中。`lib/providers/loader.js:62-64` 的 legacy 扫描只覆盖 `lib/usage/quota/plugins` 与外部目录，**不覆盖 `probes/`**，所以不是动态加载假阴性。Go 侧已有 `internal/adapters/cline/usage`。 | **安全删** | T1 + T2；无直接单测，重点确认描述符加载正常、cline 额度不再回退 Node 探针 |
| `lib/server/zcode-models.js` | 24 | **零引用**。仅 `lib/server/cline-models.js:13` 的注释提到它，没有 require。Go 侧 `internal/adapters/zcode/modelcatalog` 已接管目录。 | **安全删** | T3 |
| `lib/server/provider-model-strategies.js` | 19 | **零引用**。只把旧名字转发到 `lib/server/model-discovery/index.js`，没有调用方，也没有测试引用。 | **安全删**（仓库内）。若仓库外有插件直接 require 这个内部路径，不属于受支持扩展契约；保守做法是先查外部插件目录再删。 | T3 |

### 3.2 仅测试引用 + 死构造：需人工确认（1 个）

| 文件 | 行数 | 引用证据 | 风险 | 删除后测试 |
| --- | ---: | --- | --- | --- |
| `lib/cli/services/usage/zcode-quota-probe.js` | 639 | `lib/cli/services/usage/snapshot.js:86` require、`:161` 构造 `zcodeQuotaProbe`，但该变量在全文件**没有任何调用**；`test/zcode-coding-plan-quota.test.js:11` 与 `test/zcode-plan-claim.test.js:13` 直接 require 它。 | **需人工确认** | **不要第一批删**。T2 会直接红（两个测试直接 require）。先决定 BigModel 5h/每周/MCP 附加额度由 Go 补，还是保留纯映射模块。 |

为什么不能按“安全删”处理：

- 生产路径确实不调用：`snapshot.js` 的 `probeStrategyProviders` 走描述符策略，而 zcode 描述符的 `quota.supported` 已是 `false`。
- 但测试覆盖的是 `buildCodingPlanEntries` / `buildMcpUsageEntry` / `mergeCodingPlanIntoSnapshot`，对应 Go 尚未迁的 BigModel coding-plan 附加额度（合并记录 §35 明确写了“未迁”）。
- 直接删会同时删掉这段协议映射的唯一实现和回归守卫。建议二选一：
  - 先让 Go 产出这部分附加额度，再删文件与测试；
  - 或者把纯映射函数留在独立模块，只删网络探针与 `snapshot.js` 的死构造。

### 3.3 仍被使用：不能删（36 个）

#### 额度采集（15 个）

| 文件 | 行数 | 引用证据 | 风险 | 删除后测试 |
| --- | ---: | --- | --- | --- |
| `lib/cli/services/usage/codebuddy-quota-probe.js` | 341 | `lib/account/activity-claim/workbuddy-daily.js:29` 引用 `CODEBUDDY_PROBE_USER_AGENT` / `readCodebuddySharedCredential`；`snapshot.js:91` 的构造未调用，但文件本身仍服务签到。 | **不能删**（可清理 snapshot 死构造） | T2 + T5 |
| `lib/usage/quota/probes/qoder-family.js` | 285 | `lib/account/activity-claim/qoder-daily.js:20` 复用 `__private` 做签到 token 解析。 | **不能删** | T2 + T1 |
| `lib/usage/provider-usage/kiro.js` | 19 | `lib/providers/defs/kiro.js:24` 作为 `usage` 展示端口。 | **不能删** | T1 + T2 |
| `lib/usage/provider-usage/agy.js` | 16 | `lib/providers/defs/agy.js:12` 作为 `usage` 展示端口。 | **不能删** | T1 + T2 |
| `lib/usage/provider-usage/zcode.js` | 29 | `lib/providers/defs/zcode.js:11` 作为 `usage` 展示端口（套餐名进账号记录）。 | **不能删** | T1 + T2 |
| `lib/usage/provider-usage/cline.js` | 36 | `lib/providers/defs/cline.js:10` 作为 `usage` 展示端口。 | **不能删** | T1 + T2 |
| `lib/server/agy-usage-snapshot.js` | 229 | 7 处生产引用：`server/accounts.js:64`、`upstream-endpoints-attempt.js:9`、`upstream-endpoints-transport-code-assist-{anthropic,gemini}.js`、`upstream-endpoints-transport-general.js:92`、`upstream-endpoints.js:34`、`v1-router.js:69`；`defs/agy.js` 注释明确保留失败兜底。 | **不能删** | T1 |
| `lib/server/code-assist-quota.js` | 378 | `lib/server/agy-usage-snapshot.js:7` 与 `lib/cli/services/usage/snapshot.js:47`；agy/gemini 的 code-assist 额度抓取仍服务失败兜底。 | **不能删** | T1 |
| `lib/account/kiro-usage-client.js` | 104 | `lib/account/kiro-identity-probe.js:4` 引用；用于 OAuth 入学的身份证据，不是额度展示。 | **不能删** | T4 + T1 |
| `lib/account/kiro-identity-probe.js` | 15 | `lib/account/kiro-native-login.js:5` 引用。 | **不能删** | T4 |
| `lib/usage/quota/index.js` | 264 | 15 处引用（`derived-state`、`go-usage-facts`、CLI 展示、server 额度门禁等）；仍服务未迁 Provider 与展示/派生状态。 | **不能删** | T1 + T2 + T5 |
| `lib/usage/quota/strategies.js` | 124 | `lib/usage/quota/index.js:23`。 | **不能删** | T1 |
| `lib/usage/quota/view.js` | 393 | `lib/usage/quota/index.js:55`；WebUI/CLI 额度视图共用。 | **不能删** | T1 + T2 |
| `lib/usage/quota/agy-groups.js` | 138 | `lib/usage/quota/index.js:62`。 | **不能删** | T1 + T2 |
| `lib/cli/services/usage/snapshot.js` | 1438 | `lib/cli/bootstrap/usage-wiring.js:4`；文件是 CLI 用量装配入口。内部有 4 个未使用探针实例（见 §5）。 | **不能删**（可清理死接线） | T2 + T5 |

#### 模型目录（14 个）

| 文件 | 行数 | 引用证据 | 风险 | 删除后测试 |
| --- | ---: | --- | --- | --- |
| `lib/account/kiro-model-catalog.js` | 145 | `lib/account/kiro-model-discovery.js:14`。 | **不能删** | T3 + T4 |
| `lib/account/kiro-model-discovery.js` | 62 | `lib/providers/defs/kiro.js:17`；Node 发现链仍活跃。 | **不能删** | T3 + T4 |
| `lib/account/qoder-model-catalog.js` | 615 | 4 处：`defs/qoder.js:12`、`defs/qodercn.js:12`、`server/qoder-cli-transport.js:38`、`server/qoder-http-transport.js:58`；qoder relay 仍用它解析模型。 | **不能删** | T3 + T4 |
| `lib/account/codebuddy-family-model-discovery.js` | 171 | `lib/providers/defs/_shared/codebuddy-family.js:8`；四支共享。 | **不能删** | T3 |
| ~~`lib/server/cline-models.js`~~ | 56 | **已删除（2026-11-11）**：Go 的 `internal/adapters/cline/modelcatalog` 已是唯一真值源，Node 只经 `go-account-models` 读 `account_models`；删除时全仓零 require。 | 已删除 | T3 |
| `lib/server/http-utils-zcode.js` | 252 | `lib/server/http-utils.js:66`、`lib/server/model-discovery/generic-models-probe.js:12`、`lib/server/model-discovery/http-handlers.js:17`；zcode plan/paas 目录 handler 仍在 Node 发现链上。 | **不能删** | T3 |
| `lib/server/provider-model-discovery.js` | 457 | 12 处生产引用（`v1-router`、`model-endpoints`、`webui-model-cache/scheduler` 等）。 | **不能删** | T3 + T5 |
| `lib/server/native-cli-model-discovery.js` | 136 | `http-utils.js:46`、`model-discovery/http-handlers.js:19`、`provider-model-discovery.js:9`。 | **不能删** | T3 + T5 |
| `lib/server/model-discovery-accounts.js` | 99 | 6 处（`model-probe-index`、`webui-model-cache`、`account-lifecycle-event-listeners` 等）。 | **不能删** | T3 |
| `lib/server/model-discovery/index.js` | 116 | `lib/server/http-utils.js:49`；另外 `provider-model-strategies.js` 也引用它（后者本身零引用）。 | **不能删** | T3 |
| `lib/server/model-discovery/http-handlers.js` | 113 | `lib/server/http-utils.js:48`；同时是 `codex-native-models` / `code-assist-models` / `opencode-models` / `zcode-plan-models` / `cline-static-catalog` 的字符串入口。 | **不能删** | T3 |
| `lib/server/model-discovery/handler-registry.js` | 43 | 4 处（`providers/handler-registry.js`、`model-discovery/index.js` 等），是按字符串解析 handler 的注册表。 | **不能删** | T3 |
| `lib/server/model-discovery/generic-models-probe.js` | 191 | `http-utils.js:47`、`model-discovery/http-handlers.js:11`；claude/kimi/grok/agy/gemini/zcode 的 API-key 策略共用。 | **不能删** | T3 |
| `lib/server/workbuddy-model-discovery.js` | 76 | `lib/server/native-cli-model-discovery.js:62`；家族 CLI 兜底。 | **不能删** | T3 |

#### 凭据解密（7 个）

| 文件 | 行数 | 引用证据 | 风险 | 删除后测试 |
| --- | ---: | --- | --- | --- |
| `lib/account/qoder-credential-decrypt.js` | 290 | 5 处：`provider-credentials/qoder-family.js:6`、`qoder-model-catalog.js:35`、`server/accounts.js:67`、`qoder-http-transport.js:41`、`usage/quota/probes/qoder-family.js:31`。 | **不能删** | T4 |
| `lib/account/qoder-auth-wasm.js` | 345 | `qoder-model-catalog.js:31`、`qoder-http-transport.js:37`。 | **不能删** | T4 |
| `lib/account/provider-credentials/qoder-family.js` | 63 | `lib/account/provider-credentials/index.js:4`。 | **不能删** | T4 |
| `lib/account/zcode-credential.js` | 269 | 27 处（22 个 lib + 5 个 test）；导入/导出、投影、CLI、桌面启动、备份都依赖。 | **不能删** | T4 + T1 |
| `lib/account/zcode-projection-credentials.js` | 123 | `cli/.../zcode-strategy.js:6`、`server/desktop-launch/zcode-strategy.js:22`、`test/zcode-projection-credential-profile.test.js:27`。 | **不能删** | T4 |
| `lib/account/provider-credentials/zcode.js` | 31 | `lib/account/provider-credentials/index.js:41`。 | **不能删** | T4 |
| `lib/account/go-bridge/zcode-native-auth.js` | 31 | `go-bridge/go-import-translator.js:13`、`server/go-account-sync.js:27`。 | **不能删** | T4 |

补充观察（未逐条展开，均有生产引用，不能按“Go 已接管”删除）：

- 模型目录：`lib/server/codex-model-client.js`（142 行，`http-utils.js:45` 等）、`lib/server/chat-runtime/codex-native-model-catalog.js`（157 行，`codex-session-driver.js:17`）、`lib/server/code-assist-model-registry.js`（504 行，`http-utils-code-assist` 等）、`lib/server/http-utils-code-assist.js`（653 行，`http-utils.js:60`）、`lib/server/opencode-server-client.js`（572 行，`http-utils.js:34` 与 opencode relay）。
- 额度编排：`lib/server/provider-usage-policies.js`（209 行，`provider-usage-policy.js` 延迟加载）、`lib/server/account-quota-probe-scheduler.js`（151 行，`server.js:175`）、`lib/server/agy-account-usage-view.js`（133 行，`code-assist-quota` / `management` 等）。

## 4. 动态加载与易误判点

以下文件“零静态引用”是正常的，**不能按引用计数判死**：

1. **Provider 描述符目录扫描**
   - `lib/providers/loader.js:21` 定义 `BUILTIN_DEFS_DIR = lib/providers/defs`，`:41-47` 按目录枚举 `*.js`，`:171-174` 逐个 require。
   - 因此 `lib/providers/defs/{agy,cline,kiro,qoder,qodercn,zcode}.js` 即使零静态引用也在生产加载；本次清单里的描述符一个都不能删。
   - `lib/providers/defs/_shared/codebuddy-family.js` 不是目录扫描入口，但被四个 defs 通过 `require('./_shared/codebuddy-family')` 引用。

2. **App 安装器目录扫描**
   - `lib/server/app-installers/index.js:13` 读目录，`:26` `require(path.join(__dirname, entry.name))`。
   - `lib/server/app-installers/{agy,cline,kiro,qoder,qodercn,zcode}.js` 零直接引用但都在安装器注册表里。

3. **Harness activity 探针目录扫描**
   - `lib/harness/activity/index.js:97` `require(path.join(dir, entry.name))`。
   - `lib/harness/activity/probes/{cline,kiro}-session-store.js` 零直接引用但会被动态加载。

4. **`require.resolve` 字符串路径**
   - `lib/server/desktop-launch/zcode-strategy.js:29-31` 用 `require.resolve('../../runtime/zcode-electron-captcha-hook')` 与 `.../zcode-session-attribution-runner`。
   - 这两个 runtime 文件在 require 图里是零入边，但仍是生产入口。

5. **Worker 文件路径拼接**
   - `lib/usage/model-usage-query-executor.js:47`、`lib/usage/model-usage-scan-executor.js:47` 用 `path.join(__dirname, '...worker.js')` 创建 Worker。
   - 两个 worker 文件零静态引用但必须保留。

6. **模型发现 handler 字符串**
   - 描述符只写 `handler: 'codex-native-models' | 'code-assist-models' | 'opencode-models' | 'zcode-plan-models' | 'cline-static-catalog' | 'generic-models-probe' | 'native-cli'`，由 `lib/server/model-discovery/handler-registry.js` / `http-handlers.js` 解析。
   - 实现文件可能没有直接 require，删除前必须同时检查这些字符串。

7. **Lazy require**
   - `lib/account/qoder-model-catalog.js:487` 使用 `require(id)` 延迟加载 runtime 模块；该文件本身仍被 4 处生产代码引用，不能按“内部有动态 require”误判。

8. **Legacy 额度插件扫描不覆盖 probes/**
   - `lib/providers/loader.js:62-64` 的兼容扫描只针对 `lib/usage/quota/plugins` 与外部 `quota-plugins`。
   - 因此 `lib/usage/quota/probes/cline.js` 的零引用是真实的，不会被 legacy loader 救活。

## 5. 同批建议的接线清理（不是删文件）

`lib/cli/services/usage/snapshot.js` 里构造了 4 个探针实例，但全文件没有任何调用：

- `:82` `createKimiQuotaProbe`，`:135` `const kimiQuotaProbe = ...`
- `:92` `createGrokQuotaProbe`，`:148` `const grokQuotaProbe = ...`
- `:86` `createZcodeQuotaProbe`，`:161` `const zcodeQuotaProbe = ...`
- `:90` `createCodebuddyQuotaProbe`，`:177` `const codebuddyQuotaProbe = ...`

建议删除这 4 组 import/构造，保留对应文件：

- `codebuddy-quota-probe.js` 仍被 `workbuddy-daily.js` 引用；
- `zcode-quota-probe.js` 仍被测试引用，是否删文件见 §3.2；
- kimi/grok 不在本次 Go 迁移范围，但实例同样是死接线，可一并清理。

这一步不是“删文件”，风险低于删文件，但会改变 CLI 启动时的构造次数；跑 T2 + T5 即可。

## 6. 建议第一批删除（3 个文件）

仅限证据充分、风险最低：

1. **`lib/usage/quota/probes/cline.js`**
   - 零引用；legacy loader 不覆盖 `probes/`；Go 已有 `internal/adapters/cline/usage`。
   - 删除后跑 T1 + T2。

2. **`lib/server/zcode-models.js`**
   - 零引用；Go 已有 `internal/adapters/zcode/modelcatalog`。
   - 删除后跑 T3。

3. **`lib/server/provider-model-strategies.js`**
   - 零引用；只是 `model-discovery/index.js` 的旧名转发。
   - 删除后跑 T3。
   - 保守前置：先确认仓库外插件目录没有 require 这个内部路径；没有就删。

**不要放进第一批**：`lib/cli/services/usage/zcode-quota-probe.js`。它是“仅测试引用 + 死构造”，但承载 Go 尚未迁移的 BigModel coding-plan 附加额度映射，删除会丢协议实现与回归守卫。

## 7. 附录：相邻零引用（不计入主清单）

以下两个文件也是零引用，但不属于“Go 接管的额度/模型/解密”三块能力，单独列出，避免混入第一批：

| 文件 | 行数 | 引用证据 | 风险 | 说明 |
| --- | ---: | --- | --- | --- |
| `lib/server/agy-cli-transport.js` | 5 | **零引用**；内容只有 `module.exports = Object.freeze({ removed: true })` | **已删除（2026-11-06）** | 旧的 agy CLI transport 占位，不是本次 Go 迁移产物 |
| `lib/server/account-model-denial.js` | 114 | **零引用**；注释说应被 `provider-model-discovery` 使用，但实际没有任何 require | **需人工确认** | 账号级“实测不能用某模型”的负面事实登记簿；当前未接线，可能是漏接而非废弃 |

## 8. 复现方法

静态引用分析口径：

- 遍历 `lib/`、`test/`、`scripts/`、`web/src/`、`bin/`、`examples/` 下的 `.js/.mjs/.cjs/.ts/.tsx/.jsx`。
- 解析 `require('...')`、`import ... from '...'`、`import('...')` 的相对路径，按 `.js/.mjs/.cjs/.ts/.tsx/index.js` 解析到真实文件。
- 排除 `node_modules`、`.git`、`dist`、`.cache`、构建产物目录。
- 行数用 `wc -l`；引用数为主清单文件的入边数量（不含自引用）。
- 动态加载通过人工检查目录扫描、`require.resolve`、`path.join` worker 路径、描述符 `handler:` 字符串补齐。

本次审计的关键 Go 证据：

- 额度：`internal/adapters/{kiro,agy,zcode,codebuddyfamily,cline,qoder}/usage`
- 模型：`internal/host/aihserver/composition.go` 的 `newModelDiscovery`（约 1438–1528 行）
- 凭据：`internal/adapters/accounts/{qodercred,zcodecred}`
- 迁移记录：`docs/plans/2026-11-04-node-go-merge.md` §32–§39


## 2026-11-06 追加删除

按「basename 在全部 js/ts/tsx/json/mjs/cjs 里出现 0 次」严格扫描后删除（每次均验证 CLI
入口可正常 require、相关测试全绿）：

| 文件 | 行数 | 说明 |
| --- | --- | --- |
| `lib/server/account-model-denial.js` | 114 | 账号级「实测用不了这个模型」登记簿，随 Provider 迁移失效 |
| `lib/server/device-fingerprint-mask.js` | 78 | 设备指纹收敛模式表 |
| `lib/server/sse-json-stream.js` | 89 | SSE 分块解码工具 |
| `lib/server/webui-archived-cache.js` | 296 | 归档快照缓存 |
| `lib/cli/commands/server-router.js` `tool-router.js` | — | 被 root router 取代的旧命令 |
| `lib/cli/services/account/rekey-{readonly-snapshot,rehearsal-copy}.js` | — | rekey 一次性脚本 |
| `lib/cli/services/ai-cli/native-cli-install-strategies.js` | — | 安装策略表 |
| `lib/cli/services/toolkit/env-manager.js` | — | 环境变量管理器 |
| `lib/cli/services/usage/grok-quota-probe.js` | — | 死构造删除后失引用 |
| `lib/plugins/runtime/{capability-pipeline,host-adapter}.js` | — | 插件运行时适配器 |
| `lib/server/provider-cli-upgrade/hook-survival.js` | — | hook 存活探测 |
| `lib/session/{codex-session-stream,global-source}.js` | — | 会话流与全局源 |
| `lib/usage/threshold-switch.js` | — | 阈值切换 |
| `lib/account/grok-endpoints.js` | 9 | grok 账单端点常量（额度已迁 Go） |
| `lib/cli/services/usage/grok-billing-grpc.js` | 136 | grok proto3 账单解码器 |

合计约 2200 行（含本轮之前的死 require、探针与墓碑）。

