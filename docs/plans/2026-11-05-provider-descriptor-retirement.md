# Node Provider 描述符退役评估（2026-11-05）

> 范围：`lib/providers/defs/*.js` 与 `lib/providers/defs/_shared/*.js`。
> 基线：`main` @ `2df3de75`（工作区另有他人未提交的 go-usage-facts 改动，与本评估无关）。
> 方法：静态引用 + 目录扫描 + Go 合同对照；只读，未改代码、未重启服务。

## 0. 结论（可执行答案）

1. **今天没有任何一个 defs 文件可以整体删除。** 16/16 都仍在提供 Node 仍在执行的 `models` 采集策略；`quota` 是契约强制字段（`lib/providers/contract.js:838`），缺了整个文件会加载失败，而不是只少一个能力。
2. **纯镜像/死字段只有三处**：
   - `acp: { supported: true }`：与 Go 合同 `acp_session` 是**精确 1:1**（10 个 provider 完全一致），且没有任何生产消费者。
   - `hooks.adapter`：与 Go 合同 `sessionSync.adapter` 重复（6 个 provider 完全一致）；Node 已以 Go 为真值源，描述符里的这份只用于一致性比对。
   - `relay.strategy`：只有契约校验器写入（`lib/providers/contract.js:426`），没有任何读取方。
3. 退役顺序必须是 **字段 → 能力 → 文件**，能力级按 provider 分组；先动 `models` 的 cline/家族，最后动 claude/codex/grok 的 `quota`。
4. 不能一次性删光：目录扫描没有静态引用、删文件不会报错只会让 provider 静默消失、Go 合同不能推导额度归属（qoder/qodercn 反例）、builtin 优先级会被外部描述符顶替。

## 1. 加载与消费基线

### 1.1 唯一加载链

- `lib/providers/defs` 不是普通模块目录，而是**目录扫描**：`lib/providers/loader.js:21` 定义 `BUILTIN_DEFS_DIR`，`:41-47` 枚举 `*.js`，`:171-177` 逐个 `require` 并注册。
- 注册前统一过契约校验：`lib/providers/registry.js:93-107` → `lib/providers/contract.js:826-861`。
- 消费方只允许走门面：`lib/providers/index.js:26-49`（`listProviders` / `getProviderCapability` / `getProviderRegistry`）。
- 插件路径共用同一套描述符形状：`lib/plugins/provider/descriptor-collector.js:21` 直接 import 了 `BUILTIN_DEFS_DIR` / `listDefinitionFiles`；其 `collectBuiltinProviderDescriptors()`（`:181-201`）当前只有导出、没有生产调用方，是死代码，但它决定了将来谁还能读这个目录。

### 1.2 当前能力索引（运行时真值）

```
provider capabilities: 10 kind(s) over 16 provider(s)
  acp: claude,cline,codebuddy,codebuddycn,codex,gemini,kimi,opencode,workbuddy,workbuddycn
  activity: codebuddycn,qoder,qodercn,workbuddycn,zcode
  authSources: agy,claude,cline,codebuddy,codebuddycn,codex,gemini,grok,kimi,kiro,opencode,qoder,qodercn,workbuddy,workbuddycn,zcode
  egress: agy,claude,codex,gemini,opencode,zcode
  hooks: agy,claude,codex,gemini,grok,opencode
  models: 全部 16 家
  providerModelPrefix: zcode
  quota: 全部 16 家（但 supported:true 只有 claude/codex/grok）
  relay: 全部 16 家
  usage: agy,claude,cline,codex,gemini,grok,kimi,kiro,zcode
```

复现命令：

```bash
node -e "const p=require('./lib/providers');console.log(p.formatProviderCapabilityLines().join('\n'))"
```

### 1.3 与 Go 合同的重合度

Go 合同（`contracts/providers/manifest.json`，生成自 `core/providers/builtins.go`）已经持有：provider 身份、展示、CLI/凭据事实、`capabilities[]`、`sessionSync`、`relayHosts`。

| 能力 | Node 描述符 → Go 合同 | 判定 |
| --- | --- | --- |
| `acp` | 10 家，与 Go `acp_session` 精确一致 | **纯镜像** |
| `hooks` 的「有没有」与 `adapter` | 6 家，与 Go `sessionSync.mode=hook` / `adapter` 精确一致 | **存在性/适配器名是镜像**；路径、超时单位、事件 matcher、特性开关是 Node 独有 |
| `models` | 16/16 都有 Go `model_catalog`，但 Go 只声明「有目录」，不声明策略 | 存在性镜像，**实现不是** |
| `quota` | 13/16 有 Go `quota_usage`，但 qoder/qodercn 有 Go 采集却没有该能力位；grok 有该能力位却仍由 Node 探测 | **不能当镜像/不能推导** |
| `relay` | Go `relayHosts` 回答「哪个宿主能承接推理」；Node `relay` 回答「Node 的传输/凭据/节流怎么做」 | 语义不同，不能互推 |
| `usage` / `egress` / `activity` / `providerModelPrefix` | Go 合同无对应声明 | Node 独有 |

## 2. 逐文件生产消费者

> 共同消费者（下表不再重复）：`loader.js:21/56/171-177`（加载）、`registry.js:93-107`（索引）、`contract.js:826-861`（校验）。
> 「展示」指 `listQuotaAnswers` / `describeQuotaProvider`（`lib/usage/quota/index.js:75-115`），账号页与 `aih ls` 会显示 `quota.reason`。

| 文件 | 声明能力（行） | 生产消费者（file:line） | 退役判定 |
| --- | --- | --- | --- |
| `agy.js` | models:20 quota:44 hooks:50 usage:55 relay:56 egress:58 | models → `server/model-discovery/index.js:22`、`server/http-utils.js:668`；quota → 展示 `usage/quota/index.js:75`（真实探测在 `cli/services/usage/snapshot.js:623/1257` 的硬编码兜底）；hooks → `server/provider-session-hook-config.js:67`；usage → `usage/provider-usage/index.js:31`；relay → `server/webui-account-live.js:32`；egress → `server/egress-upstream.js:37` | 全部必留 |
| `claude.js` | models:20 quota:33 hooks:49 usage:54 relay:55 acp:57 egress:59 | models → `model-discovery/index.js:22`；quota → `usage/quota/index.js:67` + `cli/services/usage/snapshot.js:1408`（原生 handler 仍探测）；hooks → `provider-session-hook-config.js:67`；usage → `provider-usage/index.js:31`；relay → `webui-account-live.js:32`；egress → `egress-upstream.js:37`；acp → **0 生产消费者** | 除 acp 外全留 |
| `cline.js` | models:18 quota:34 usage:39 authSources:42 relay:56 acp:58 | models → `http-utils.js:629`（local 通道先跑）+ `model-discovery/http-handlers.js` 的 `cline-static-catalog`；quota → 展示；usage → `provider-usage/index.js:31`；authSources → `account/auth-sources.js:79/112`、`server/web-account-auth.js:1202`；relay → `webui-account-live.js:32`；acp → 0 | 除 acp 外全留 |
| `codebuddy.js` / `codebuddycn.js` / `workbuddy.js` / `workbuddycn.js` | 全部来自 `_shared/codebuddy-family.js`（models:22 quota:45 authSources:53 relay:69 acp:71）；CN 两支额外 activity | models → `http-utils.js:668` + `server/native-cli-model-discovery.js:20-23`（CLI 兜底读 `models.cli`）；quota → 展示；authSources → `auth-sources.js:79/112`；relay → `webui-account-live.js:32`；activity（CN）→ `account/activity-claim/actions.js:26`、`server/scheduled-task-events.js:52-54`、`cli/services/claim/claim-command.js:56`；acp → 0 | 除 acp 外全留 |
| `codex.js` | models:20 quota:44 hooks:61 usage:70 relay:71 acp:73 egress:75 | models → `model-discovery/index.js:22`；quota → `snapshot.js:1408`（原生 handler）+ `usage/quota/index.js:67`；hooks → `provider-session-hook-config.js:67`（`featureFlag` 在 `:80`）；usage → `provider-usage/index.js:31`；relay → `webui-account-live.js:32`；egress → `egress-upstream.js:37`；acp → 0 | 除 acp 外全留 |
| `gemini.js` | models:20 quota:44 hooks:49 usage:56 relay:57 acp:59 egress:61 | models → `model-discovery/index.js:22`；quota → 展示；hooks → `provider-session-hook-config.js:67`（`timeoutUnit` 在 `:78`）；usage → `provider-usage/index.js:31`；relay → `webui-account-live.js:32`；egress → `egress-upstream.js:37`；acp → 0 | 除 acp 外全留 |
| `grok.js` | models:19 quota:40 hooks:56 usage:62 relay:63 | models → `http-utils.js:668` + `native-cli-model-discovery.js:20-23`；quota → `snapshot.js:1211`（`probeStrategyProviders` 倒排）+ `:1405-1408`；hooks → `provider-session-hook-config.js:67`；usage → `provider-usage/index.js:31`；relay → `webui-account-live.js:32` | 全部必留 |
| `kimi.js` | models:18 quota:31 usage:36 relay:37 acp:39 | models → `model-discovery/index.js:22`；quota → 展示；usage → `provider-usage/index.js:31`；relay → `webui-account-live.js:32`；acp → 0 | 除 acp 外全留 |
| `kiro.js` | models:31 quota:52 usage:58 authSources:64 relay:112 | models → `http-utils.js:668` + `native-cli-model-discovery.js:20-23`；quota → 展示；usage → `provider-usage/index.js:31`；authSources → `auth-sources.js:79/112`（4 个来源）；relay → `webui-account-live.js:32` | 全部必留 |
| `opencode.js` | models:16 quota:29 hooks:33 relay:39 acp:41 egress:44 | models → `model-discovery/index.js:22` + `http-utils.js:706` 的硬编码兜底；quota → 展示；hooks → `provider-session-hook-config.js:67`（`opencode_plugin` 适配器）；relay → `webui-account-live.js:32`；egress → `zcode-egress-resolver.js:58` 的 scheme 白名单同款逻辑（`egress.proxySchemes`）；acp → 0 | 除 acp 外全留 |
| `qoder.js` / `qodercn.js` | models:21/19 quota:53/47 relay:58/52 activity:62/55 | models → `http-utils.js:668` + `native-cli-model-discovery.js:20-23`；quota → 展示；relay → `webui-account-live.js:32`（`relay.strategy` 无读者）；activity → `actions.js:26`、`scheduled-task-events.js:52-54`、`claim-command.js:56`、`webui-account-live.js:1397` | 全部必留；`relay.strategy` 可删 |
| `zcode.js` | models:19 quota:43 usage:49 relay:59 egress:106 providerModelPrefix:115 activity:121 | models → `model-discovery/index.js:22` + `http-utils.js:710` 兜底；quota → 展示；usage → `provider-usage/index.js:31`；relay.auth → `server/upstream-credential-resolver.js:31-35`、`server/upstream-endpoints-transport-general.js:10-11`、`server/codex-adapter.js:172-173`；relay.pacing → `server/account-pacing.js:73-74`；egress → `server/zcode-egress-resolver.js:58`；providerModelPrefix → `server/provider-model-prefix.js:59`；activity → `actions.js:26` 等 | 全部必留 |
| `_shared/region-policies.js` | claude/codex/gemini/agy 的 `egress.regionPolicy` 数据 | `egress-upstream.js:37/83`（hints + denySignatures） | 必留 |
| `_shared/workbuddy-checkin.js` | codebuddycn/workbuddycn 的 activity 数据 | `activity-claim/actions.js:26`、`scheduled-task-events.js:52` | 必留 |

## 3. 按能力的消费者索引（退役时按列检查）

| 能力 | 生产入口 | 删除前必须确认 |
| --- | --- | --- |
| `models` | `server/model-discovery/index.js:22,35`；`http-utils.js:629,668`；`native-cli-model-discovery.js:20-23,59-61,121-129`；`webui-model-refresh-scheduler.js:203-206`（把 `fetchModelsForAccount` 注入缓存刷新） | 账号级模型目录已由 Go `account_models` 投影；scheduler 不再调用 Node 探测；`http-utils.js:706/710/726/728/739` 的硬编码兜底已删 |
| `quota` | `usage/quota/index.js:67,75,94,134,139,164,170,180`；`view.js:164,183`；`cli/services/usage/snapshot.js:1211,1405-1408`；`server/account-quota-probe-scheduler.js:11`；`server/webui-account-live.js:41`；`account/derived-state.js:57-59`；`server/account-usage-gate.js:101`；`server/accounts.js:99,350` | Go 侧已有对应 usage 适配器；Node 原生 handler/兜底已下线；`quota.reason` 的展示文案有替代来源 |
| `hooks` | `server/provider-session-hook-config.js:67`（`:77-80` 取 `target/timeoutUnit/eventMatchers/featureFlag`） | 该 provider 的 hook 安装/诊断/升级存活不再由 Node 执行（当前 6 家都在执行） |
| `usage` | `usage/provider-usage/index.js:31,43`；`cli/services/profile/account-plan-badge.js:18`；`cli/services/usage/account-runtime.js:112`；`cli/services/pty/pty-runtime-launch.js:70`；`server/webui-account-live.js:762,1576` | plan badge、按需刷新、PTY 标题用量有替代；注意 `USAGE_MODULES`（`provider-usage/index.js:43`）本身零消费者 |
| `relay` | `webui-account-live.js:31-32`（transport+clientDependent）；`account-pacing.js:73-74`（pacing）；`upstream-credential-resolver.js:31-35`（auth）；`upstream-endpoints-transport-general.js:10-11`（auth）；`codex-adapter.js:172-173`（auth）；`scripts/quota-usage-audit.js:119,139` | Node 不再承接该 provider 的推理（zcode/qoder/kiro/gemini 仍在 Node），且 UI 不再需要「网关可直连」判定 |
| `egress` | `egress-upstream.js:37,83`（regionPolicy）；`zcode-egress-resolver.js:58`（proxySchemes） | Node 不再代理/探测该 provider 的上游 |
| `authSources` | `account/auth-sources.js:79,112`；`account/host-generic-detectors.js:16-17` | 本机导入/扫描/指纹去重已有替代；手写块（codebuddy 家族、cline）与 loader 自动注入的语义差异已处理 |
| `activity` | `activity-claim/actions.js:26`；`scheduled-task-events.js:52-54`；`claim-command.js:56-57,154`；`scheduled-task-service.js:267`；`webui-account-activity-routes.js:30,286`；`webui-account-live.js:1397,1733` | Go 未承接活动（`internal/` 无 checkin/claim 实现），不能先删 |
| `providerModelPrefix` | `server/provider-model-prefix.js:59` | 网关前缀解析已有替代；Go 侧无对应实现 |
| `acp` | **无** （仅注释 `runtime/acp-layouts.js:26-27` 提到「可以问」） | 可直接删；若未来仍要发现，直接从 `ACP_LAYOUTS` 派生 |

## 4. 字段分级：可删 / 必留

### 4.1 已可删（纯镜像或死字段）

| 字段 | 位置 | 证据 | 删法 |
| --- | --- | --- | --- |
| `relay.strategy` | `qoder.js:58`、`qodercn.js:52` | 全仓只有 `contract.js:426` 归一化写入，无任何读取；`qoder_http_sse` 在 `qoder-http-transport.js:61` 是独立常量 | 直接从两处删除；契约保留可选键，外部描述符不受影响 |
| `acp` | `claude.js:57`、`cline.js:58`、`_shared/codebuddy-family.js:71`、`codex.js:73`、`gemini.js:59`、`kimi.js:39`、`opencode.js:41` | 与 Go `acp_session` 10/10 精确一致；`listProviders('acp')` 在生产代码中零调用 | 删除能力块；`ACP_LAYOUTS` 仍是入口数据的唯一源 |
| `hooks.adapter` | `agy.js:51`、`claude.js:51`、`codex.js:63`、`gemini.js:51`、`grok.js:58`、`opencode.js:35` | `provider-session-hook-config.js:70` 已从 Go `sessionSync.adapter` 取真值，描述符的值只用于 `capability.adapter === adapterId` 的一致性比对 | 先改 `:70-80` 只用 `sync.adapter` + `capability.supported`，再删 6 处 `adapter`；必须补一个 profile 守卫测试（当前无覆盖） |

### 4.2 必须保留（Node 仍在执行）

- `models.strategies` 与 `strategy.cli`：Node 的模型发现门面与 CLI 兜底直接消费（`model-discovery/index.js:22`、`native-cli-model-discovery.js:20-23`）。Go 的 `account_models` 目前只服务网关/CLI 补全，**WebUI 模型缓存不读它**。
- `quota.strategies`：claude/codex 走原生 handler（`snapshot.js:1405-1408`），grok 走注册表倒排（`snapshot.js:1211`）。agy 的兜底虽然描述符写 `supported:false`，但 `snapshot.js:623/1257` 与 `server/agy-usage-snapshot.js` 仍按 provider 名执行。
- `hooks.target/timeoutUnit/eventMatchers/featureFlag`：Go 只声明 `adapter/events/targetKind`，不写客户端文件；这四项是 Node hook 写入器唯一的数据来源。
- `usage`：plan badge、按需刷新、PTY 标题用量的注册点（`provider-usage/index.js:31`）。
- `relay.transport/clientDependent`：账号页「网关可直连」判定（`webui-account-live.js:31-32`）。
- `relay.auth` / `relay.pacing`：zcode 的凭据换取、双鉴权头、账号级排队（`upstream-credential-resolver.js:31-35`、`account-pacing.js:73-74`）。
- `egress.regionPolicy` / `egress.proxySchemes`：地区提示/拒绝特征、代理 scheme 白名单（`egress-upstream.js:37,83`、`zcode-egress-resolver.js:58`）。
- `authSources`：kiro 的 4 个来源（IDE 导入/设备码/社交设备码/粘贴 token）是真实实现；codebuddy 家族/cline 的手写 `host-scan` 与各自的专用同步器绑定，不能按「通用注入已有」直接删（见 §7）。
- `activity.actions/kinds/params`：Go 完全没有活动实现；计划任务菜单与 CLI 直接由它生成。
- `providerModelPrefix.aliases`：Node 网关前缀解析的唯一声明（`provider-model-prefix.js:59`）。

### 4.3 不能按「Go 已接管」推导的字段

- `quota` 的 `supported:false + reason`：Go 合同的能力位不等于「Go 在采集」。反例：
  - qoder/qodercn 有 Go usage 适配器，但 `core/providers/builtins.go:376/440` 的能力列表里**没有** `quota_usage`；
  - grok 的能力列表里**有** `quota_usage`，但额度仍由 Node 探针采集（矩阵文档也把它标成 `node`）。
  因此不能用 `quota_usage` 自动生成 Node 的 `quota` 块；这块必须跟着迁移 PR 手工翻转。
- `models` 的 `source/strategies`：Go 只声明 `model_catalog` 存在，不声明策略链；Node 的 handler id、CLI 参数、mode 过滤都是 Node 运行时事实。

## 5. 三步退役顺序

### 第 0 步：基线快照（不改代码）

1. 记录能力索引：`node -e "const p=require('./lib/providers');console.log(p.formatProviderCapabilityLines().join('\n'))"`
2. 采集面审计：`node scripts/provider-collection-audit.js`（当前输出「只有 CLI 通道的采集面：0」）
3. 跑直接触及描述符的 3 个测试：
   `node --test test/provider-activity-workbuddy.test.js test/activity-claim-params.test.js test/zcode-plan-claim.test.js`

本次评估已执行：上述 3 个测试 26/26 通过；`node --test test/acp-session-runner.test.js test/agent-session-acp.test.js` 25/25 通过；`node scripts/provider-collection-audit.js` 输出「只有 CLI 通道的采集面：0」。

### 第 1 步：字段级去重（不改变采集/写入行为，可立即做）

| 顺序 | 改动 | 验证 | 风险 / 缓解 |
| --- | --- | --- | --- |
| 1.1 | 删 `relay.strategy`（qoder/qodercn） | `rg "relay.*strategy|qoder_http_sse"` 只剩 transport 常量；跑第 0 步 3 个测试 | 低；契约保留可选键，外部描述符仍可写 |
| 1.2 | 删 `acp` 能力块（7 个文件、10 个 provider） | 能力索引里 `acp:` 行消失；`rg "listProviders\('acp'\)|getProviderCapability\([^)]*'acp'"` 零命中；`node --test test/acp-session-runner.test.js test/agent-session-acp.test.js` | 低；仓库外若有插件查询 `listProviders('acp')` 会拿不到。缓解：未来需要发现时从 `runtime/acp-layouts.js` 派生，不恢复描述符字段 |
| 1.3 | 删 `hooks.adapter`（6 处）+ 改 `provider-session-hook-config.js:70-80` 只用 Go `sync.adapter` | 新增一个 profile 守卫测试（断言 6 家的 adapter/target/timeoutUnit 仍正确）；跑全量 hook 相关测试（当前无专门测试，必须先补） | 中；删掉一致性比对后，Go 合同与描述符漂移不再被拦住。缓解：守卫测试用 Go 合同 + 期望 profile 双向断言 |

> 第 1 步**不要**顺手删 `quota` 的 false 块：契约强制它存在（`contract.js:838`），且 `reason` 是账号页/CLI 的展示文案。

### 第 2 步：能力级移交（按 provider 分组，一组一个提交）

**前置条件（缺一不可）：**

1. WebUI 账号模型目录改读 Go `account_models`（当前 `server/webui-model-cache.js:483-484` 只读自己的探测结果；Go 表已有数据，见 `test/cli-completion-harness.test.js:247-257`）。
2. `server/webui-model-refresh-scheduler.js` 不再为该 provider 触发 Node 探测（或只触发 Go 刷新）。
3. 删掉 `http-utils.js` 对应硬编码兜底：opencode `:706`、zcode `:710`、claude `:726`、codex `:728`、code-assist `:739`。否则 `models.supported=false` 仍有兜底在跑，形成「声明已迁、实际双跑」。

**models 移交顺序（风险从低到高）：**

1. `cline`：静态清单，不联网、不依赖客户端（`models.source=cline_static_catalog`）。
2. CodeBuddy 家族 4 支：HTTP `/v3/config` + CLI 兜底，四支共享一份实现。
3. `kimi` / `grok` / `kiro` / `qoder` / `qodercn`：各有 HTTP 通道，kiro/qoder 有 CLI 兜底。
4. `agy` / `gemini`：code-assist 目录，与 Go 的 `adapters/{agy,gemini}/modelcatalog` 同源。
5. `claude` / `codex`：最后动——`http-utils.js` 里仍有 provider 名分支，且 codex 是网关默认 provider。

每个 provider 的改动形态：`models: { supported: false, reason: '...由 Go 采集目录...' }`（契约允许，`contract.js:184-188`），而不是直接删字段——保留显式回答，避免「没人想过」的静默缺口。

**quota 移交顺序：**

1. `grok`：Go 侧尚无 usage 适配器（矩阵标 `node`），先补 Go 再翻 `supported:false`。
2. `claude` / `codex`：Node 原生 handler 仍带 token 刷新阶梯，必须等 Go 的刷新/采集完全替代后一起下线。
3. `agy`：先删 `cli/services/usage/snapshot.js:623/1257` 与 `server/agy-usage-snapshot.js` 的失败兜底，再把描述符的 false 视为真。

**每组验证：**

- 模型面：`node --test test/model-catalog-invalidation.test.js test/gateway-model-cache.test.js test/go-model-catalog-projection.test.js test/model-route-source-scheduler.test.js test/model-alias-routes.test.js`
- 额度面：`node --test test/go-usage-facts.test.js test/go-quota-state-store.test.js test/go-runtime-overlay-quota.test.js test/usage-snapshot-go-source.test.js test/zcode-coding-plan-quota.test.js test/account-selection-healthy.test.js`
- 人工：账号页该 provider 有模型、有额度/「不适用」结论；`aih ls` 不出现空目录。

### 第 3 步：文件级删除（生存级，最后做）

**进入条件：** 该文件声明的每个能力都已满足「Go 承接或 Node 不再执行」，且 §3 对应行的消费者已改完。**不要按文件行数或引用数判断。**

删除顺序：

1. 单 provider 叶子文件：cline → kimi/grok/kiro/qoder/qodercn → agy/gemini → claude/codex → zcode（zcode 的 relay.auth/pacing/prefix/activity 最晚）。
2. 家族文件放在最后：`codebuddy*.js` / `workbuddy*.js` 依赖 `_shared/codebuddy-family.js`，四支必须同一提交删除。
3. 最后处理 `_shared/workbuddy-checkin.js`（activity 最后一家）、`_shared/region-policies.js`（egress 最后一家）。
4. 目录清空后再删 `loader.js:21` 的 `BUILTIN_DEFS_DIR` 常量与 builtin 扫描分支；**保留** `loader.js` 的外部目录/legacy 插件扫描能力，也保留 `registry.js`/`contract.js`——插件描述符仍依赖它们。`plugins/provider/descriptor-collector.js:181-201` 的 builtin 收集死代码一并删除。

验证：`node --test test/*.test.js`（T0 全量）+ 第 0 步能力索引（确认只剩外部/插件来源）+ `aih server status` 的 descriptor errors 为 0。

## 6. 为什么不能一次性删光 defs

1. **目录扫描没有静态引用。** `loader.js:41-47` 按文件名枚举；任何「零 require 即可删」的引用分析都会把这些文件判成死文件。反过来，删掉一个文件不会产生加载错误——provider 只是从索引里消失，问题要到账号页空白/模型 503 才暴露。
2. **契约是整文件校验。** `contract.js:838` 要求每个描述符必须有 `quota`；`loader.js:178-186` 对单个文件 fail-fast。你想「先删 models 保留 quota」可以，但想「先删 quota 回头再补」会让整个 provider 的所有能力一起消失。
3. **Node 仍在执行大量逻辑。** `models` 16/16、`quota` 3 家 + agy 兜底、`hooks` 6 家、`usage` 9 家、`activity` 5 家、zcode 的 relay.auth/pacing、6 家的 egress。删描述符 = 策略链变空 = 目录为空；下游的 model-pool-narrowing 会把「空目录」当成否定证据，直接 503。
4. **Go 合同不能推导 Node 描述符。** §4.3 的 qoder/qodercn/grok 反例说明 `quota_usage` 既不是「Go 在采集」的充分条件也不是必要条件。想自动生成 defs 会生成错误的额度归属。
5. **builtin 优先级是安全边界。** `registry.js:16,98-104` 规定 builtin > external > plugin。删掉 builtin 后，`<AIH_HOME_DIR>/provider-defs` 或插件可以用同一个 id 注册，改变 relay.auth/pacing、模型策略；这是行为与信任边界的变化，不是清理。
6. **守卫测试很少。** 全仓只有 3 个测试直接读能力（`test/provider-activity-workbuddy.test.js`、`test/activity-claim-params.test.js`、`test/zcode-plan-claim.test.js`）。多处注释引用的 `test/design-pattern-guard.test.js` 在当前检出里不存在（`rg -l design-pattern-guard test` 零命中），所以「三份集合同源」目前没有自动化守卫。

## 7. 遗留问题与前置修复

1. **Go 合同 capability 位不一致**：qoder/qodercn 有 Go usage 适配器但未声明 `quota_usage`；grok 声明了但 Node 仍采集。退役前先统一语义，否则任何「按合同生成 Node 描述符」的方案都会错。
2. **WebUI 模型目录未接 Go**：`webui-model-cache.js` 不读 `account_models`，是 `models` 无法整体退役的头号阻塞。需要 Go 暴露账号模型查询（HTTP 或 Node 直读 DB）。
3. **http-utils 的 provider 名兜底**：`http-utils.js:706/710/726/728/739` 让 `models.supported=false` 不能真正关闭探测；退役 `models` 前必须先删这些分支。
4. **hooks 无测试**：`provider-session-hook-config.js` 没有任何测试覆盖；第 1.3 步之前必须补 profile 守卫。
5. **两处死代码可先清**（不涉及描述符）：`usage/provider-usage/index.js:43` 的 `USAGE_MODULES` 零消费者；`plugins/provider/descriptor-collector.js:181-201` 的 `collectBuiltinProviderDescriptors` 零生产调用。
6. **热文件信号**：2026-11-05 一天内有 8 个提交只是把各家 `quota` 从 `supported:true` 改成 `false`（`git log --since=2026-11-05 -- lib/providers/defs`）。这说明「额度归属」不应继续靠逐文件手改；在退役完成前，至少应把这一步收敛成一处派生/校验（例如由迁移清单生成或由测试锁定），否则每迁一家仍要动 defs。

## 8. 边界

- 本文只读评估，不含代码改动、服务重启、数据库读写。
- 不评估 Go 侧实现质量；「Go 已接管」仅按现有文档与代码证据引用。
- 删除顺序里的每一项都应在独立提交中完成并跑对应验证；不要合并成「一次清空 defs」。
