# Provider 能力描述符、额度抽象与策略链

状态：已落地（2026-10-14）

范围：`lib/providers/`（能力描述符 + 注册表 + 倒排索引）、`lib/usage/quota/`（额度领域）、
`lib/usage/provider-usage/`（用量展示端口），以及额度审计脚本 `scripts/quota-usage-audit.js`。
不包含：网关主链的额度判定（`lib/server/provider-usage-policy.js`）。

## 1. 设计约束（为什么不是「中央清单」）

历史问题：额度知识散落在五处，且每新增一个 provider 都要在若干中央名单里加行；
「哪些 provider 没有额度」这种决定被写进一张需要同步维护的常量表，漏一处就是静默缺口。

现在只有一条规则：

> **provider 的能力由它自己的描述符声明；注册表只做索引（provider → 能力、能力 → providers 的倒排）；
> 消费方问能力名，不问 provider 名。**

新增 provider = 新增 `lib/providers/defs/<id>.js` 一个文件；
新增/修改能力 = 改它自己的描述符；
额度「没有」也必须**显式写原因**（`quota.supported = false` + `reason`），否则描述符校验直接报错。

## 2. 分层与文件职责

| 文件 | 职责 |
| --- | --- |
| `lib/providers/contract.js` | 描述符契约与校验（叶子模块，无 I/O）。`quota` 能力必填：`supported:true` + 策略链，或 `supported:false` + reason |
| `lib/providers/registry.js` | 注册表：`byId` 索引 + **能力倒排**；策略排序（不依赖客户端的优先）；冲突策略（内置优先） |
| `lib/providers/loader.js` | 目录扫描：内置 `defs/`、`AIH_PROVIDER_DEFS_DIR`、`<AIH_HOME_DIR>/provider-defs`；兼容旧额度插件形状（`AIH_QUOTA_PLUGIN_DIR`、`<AIH_HOME_DIR>/quota-plugins`） |
| `lib/providers/defs/<id>.js` | **每个 provider 自己的能力自描述**（quota / usage / relay） |
| `lib/providers/index.js` | 门面：倒排查询、能力读取、加载错误、诊断行 |
| `lib/usage/quota/index.js` | 额度领域派生：谁有额度、可信规则、时间窗 kind、策略链执行、诊断 |
| `lib/usage/quota/strategies.js` | 策略链执行器（默认最稳 + 失败切换 + attempts 可观察） |
| `lib/usage/quota/probes/*.js` | 探针实现（当前 `cline.js`：Cline Pass） |
| `lib/usage/quota/view.js` | **展示视图模型**：快照 → 统一 scope（label / category / 顺序 / 单位），不含任何 provider 名单 |
| `lib/cli/services/usage/{window-format,credit-format}.js` | CLI 渲染适配层（输出与历史逐字节一致），形态判定来自描述符 |
| `web/src/components/account/quota-scopes.ts` | WebUI 展示行派生（消费服务端下发的 `entryShape` + `label`，同样无 kind 名单） |
| `lib/usage/provider-usage/index.js` | 用量展示端口视图（`getProviderUsageStrategy`），不再有 `USAGE_MODULES` 手写数组 |

## 3. 描述符契约（contractVersion = 1）

```js
module.exports = {
  contractVersion: 1,
  id: 'cline',
  capabilities: {
    quota: {
      supported: true,                 // 或 { supported: false, reason: '为什么拿不到' }
      kind: 'cline_pass_usage',        // 必须已在 USAGE_SNAPSHOT_KINDS 登记
      source: 'cline_plan_usages_api',
      shape: 'entries',                // entries | models
      entryShape: 'window',            // window（滚动时间窗）| bucket（余额桶）| models
      strategies: [                    // 默认 = 第一条（不依赖客户端的排前面）
        { id: 'cline-plan-usage-limits', transport: 'http', clientDependent: false,
          probe: (deps) => createProbe(deps), description: '…' }
      ]
    },
    usage: { accountSnapshotRefresh: true, planLabel, liveAccountIdentity, cachedAccountMetadata },
    relay: { transport: 'http', clientDependent: false }
  }
};
```

- `transport`: `http` | `client-cli` | `client-desktop`；`clientDependent` 必须与之自洽（校验会拒绝矛盾声明）。
- `clientOptional: true`：不依赖客户端也能跑，但可能顺手读一下（例如 codex 的 `--version` 探测）。
- 策略实现二选一：`probe`（自包含探针）或 `handler`（原生实现由组合根 `lib/cli/services/usage/snapshot.js` 提供）。
  有守卫测试断言「声明的 handler 在组合根里真的存在」，防止声明漂移。

## 4. 策略链（默认最稳 + 失败切换）

排序规则：`clientDependent: false` 的策略优先，组内保持声明顺序（`orderQuotaStrategies`）。
执行：`runQuotaStrategies(provider, accountRef, { deps, timeoutMs, handlers })` 依次尝试，
命中第一条成功即返回，并返回 `strategyId` 与 `attempts`。

可观察性：
- 只有**一条**策略时，探针错误保持原始文案（既有判定与展示都依赖它，如 `missing_oauth_credentials`）；
- 真的切换过多条策略时，错误文案变成 `stable:upstream_down | fallback:…`（每条尝试的原因）。

原生 handler 型 provider（codex/claude/agy/gemini）内部自带刷新阶梯，
描述符声明它们的通道与客户端依赖；策略型 provider（kimi/grok/kiro/zcode/CodeBuddy 家族/Cline Pass）走链。

## 5. 消费方接线（谁问什么）

| 消费方 | 问注册表/额度门面的什么 |
| --- | --- |
| `account-quota-probe-scheduler.js` / `webui-account-live.js` | `listQuotaProviders()`（倒排 + `quota.supported`） |
| `usage/snapshot.js` | `listQuotaProviders()` + `runQuotaStrategies()`（探针依赖 + 代理设置由组合根注入） |
| `usage/cache.js` | `resolveQuotaTrustRule(provider)` |
| `server/accounts.js` | `isTrustedQuotaSnapshot()`（native 分支保留其归一化语义） |
| `usage/window-format.js` | `listQuotaSnapshotKinds('window')` |
| `account/derived-state.js` | `hasQuotaProvider()` |
| `server/account-usage-view.js` | 按 kind 归一化（新 kind 需加一支） |
| `web/src/features/accounts/account-state.ts` | WebUI 侧 kind 集合（跨语言镜像，有守卫测试） |
| `server/command-handler.js` | `formatQuotaSourceLines()` → `aih server status` |

## 6. 审计：每个账号都跑一遍

```bash
node scripts/quota-usage-audit.js --json /tmp/quota-audit.json
```

对每个已登记账号执行 `aih <provider> usage --refresh`，并记录：
- provider 自己声明的额度能力与策略链（脚本不写 provider 名单）；
- `NODE_DEBUG=child_process` 抓到的 spawn 命令，按「本机客户端 vs 系统探测」分类；
- 结果（窗口百分比 / 错误 / 耗时）。

矩阵输出：有额度的 provider、各自声明「无额度」的 provider、额度策略全部依赖客户端的 provider、
中继依赖客户端的 provider、以及实测探测期真的 spawn 了客户端进程的 provider。

## 7. Cline Pass 案例（2026-10-14 实测）

| 端点 | 用途 |
| --- | --- |
| `GET /api/v1/users/me/plan/usage-limits` | **服务端权威用量**：`data.limits[{type: five_hour\|weekly\|monthly, percentUsed, resetsAt}]` |
| `GET /api/v1/users/me/plan` | 窗口上限 `entitlements.cline_pass.inferenceCapThreshold.*`（单位 **1e-8 USD**）、套餐名、`currentPeriodStart/End` |

`remainingPct = 100 - percentUsed`，重置时间用上游 `resetsAt`（滚动窗口，不自己推算）。

### 禁止用 `/users/{uid}/usages` 做窗口聚合（踩过的坑）

1. `limit` 上限 200（传 1000 被夹到 200）；
2. `nextToken` 游标上游**实际不生效**（实测第 2~4 页完全重合），`offset` 也被忽略；
3. 结果：窗口只能扫到最近十几分钟，`used` 严重低估（实测 5h 算成 7.4%，服务端权威值 24%），
   `remaining` 虚高，会误导调度。

`/usages` 只适合「最近 N 笔明细」。

### Cline API Key 账号

只有余额没有上限（`/users/{uid}/balance` 有值；`/users/me/budget`、`/users/{uid}/budget`、
`/users/me/spend-limits` 实测 404），因此返回 `api_key_mode_not_applicable`，
不把余额伪装成「剩余百分比」——没有分母的百分比就是编造。

## 8. 不变量与守卫

- 每个 catalog provider 必须有自己的描述符并显式回答额度（`test/quota-provider-coverage.test.js`）。
- 插件/外部描述符不得覆盖内置 provider（冲突记为可观察错误）。
- `snapshotKind` 必须已在 `USAGE_SNAPSHOT_KINDS` 登记；缺失窗口不产出条目（宁可 Unknown）。
- 声明的 handler 必须在组合根里存在；展示层不得维护 kind 名单（按 `entryShape` 渲染）。
- 策略链默认最稳、失败切换，attempts 可观察。
- 每个声明了额度的 provider，按其声明的 `entryShape` 都必须能渲染出行内摘要与明细
  （`test/quota-view.test.js` / `test/quota-view-provider-coverage.test.js`）：新增 provider 或
  新增形态时展示层没跟上就直接红。

## 10. 展示层：额度视图模型（`lib/usage/quota/view.js`）

各家的快照形态不同（滚动时间窗 / 余额积分桶 / 每模型额度），但展示需求是同一组：
「哪个额度、还剩多少、什么时候重置、单位是什么、是不是旁路信息」。视图模型把这层归一一次，
CLI（`ls` / `usage` / PTY 标题）与 WebUI（账号列表 / 详情）都渲染同一份结果：

| 概念 | 说明 |
| --- | --- |
| `entryShape` | 由 provider 描述符声明（`window` / `bucket` / `models`），展示层据此选渲染路径 |
| scope | 一条额度行：`label` / `category` / `remainingPct` / `resetIn` / 单位绝对值 |
| `category` | `primary` 参与账号级 min 剩余；`gift`（赠送包）与 `detail`（每包明细）是旁路信息，不参与 |
| `label` | 展示标签：通用桶显示窗口（`7days`/`5h`），具名桶显示身份（`glm-5.3 1days`、`Invite to Earn Credit`） |
| 顺序 | 主额度按窗口长度升序（短的在前），没有窗口长度的排最后，旁路条目最后 |

服务端账号 payload 因此带上 `entryShape` 与每行的 `label`（`lib/server/account-usage-view.js`）：
展示层不需要知道任何 provider 名，也不需要第二份 kind 名单。形态与快照结构不匹配时不静默返回空，
而是给出 `unrenderable` 原因（`entry_shape_bucket_without_entries` 等），便于诊断。

`lib/cli/services/usage/window-format.js` 与 `credit-format.js` 现在都是这个视图模型的适配层
（输出与历史逐字节一致），`presenter.formatUsageSnapshotLines` 的兜底也改成「列出全部 scope」，
不再把没登记 kind 的快照丢成原始 JSON。

## 9. 可观察性

```
$ aih server status
  quota sources: 16 provider(s), with quota=13, no quota=3
    opencode: OpenCode 官方没有额度/剩余百分比接口：…
    qoder: Qoder 凭据是 WASM + machineId 加密的本地 blob…
    qodercn: 同 qoder（国内站）…
```

程序内：`describeQuotaSources()` / `formatQuotaSourceLines()` / `formatProviderCapabilityLines()` /
`listProviderDescriptorLoadErrors()`。

## 11. kiro：不依赖本地 CLI / App 的纯 API 采集（2026-10-15 实测）

**症状**：账号页同时报「模型：`native_cli_model_discovery_cli_not_found`」与「额度：
`kiro_identity_access_denied`」。看起来像权限问题，实际是两条都**只依赖本机客户端**：

| 报错 | 真实原因 |
| --- | --- |
| `kiro_identity_access_denied` | access token 已过期（实测 `expires_at` 比当天早 3 天）。AWS 对过期 SSO token 返回 **403**（不是 401），被映射成 access_denied。刷新此前只能从本地 CLI 的 `data.sqlite3` 里抄，CLI 不在就永远 403 |
| `native_cli_model_discovery_cli_not_found` | 模型清单只有「跑本地 CLI」一条路（`native-cli-model-discovery.js` 的 provider→CLI 参数表） |

**纯 API 通道（已实测打通，全程不碰 CLI）**：

1. **凭据**：导入时那份 CLI sqlite 以 base64 存在 `nativeAuth.database`，其中 `auth_kv` 表有
   `kirocli:odic:device-registration`（`client_id` / `client_secret`，实测有效期到 2027-01）。
   解析见 `lib/account/kiro-device-registration.js`（显式字段优先，内嵌 sqlite 兜底，都拿不到就 fail closed）。
2. **刷新**：`POST https://oidc.<region>.amazonaws.com/token`
   `{clientId, clientSecret, grantType: 'refresh_token', refreshToken}` → 200 `{accessToken, expiresIn, refreshToken}`
   （实测 refresh_token **不轮换**）。见 `lib/account/kiro-token-refresh.js`。
3. **额度**：`POST codewhisperer.<region>.amazonaws.com/` + `x-amz-target: AmazonCodeWhispererService.GetUsageLimits`
   → 200（`usageBreakdownList` / `subscriptionInfo` / `nextDateReset`）。
4. **模型**：同一个端点 + `AmazonCodeWhispererService.ListAvailableModels` → 200（`defaultModel` + `models[]`）。
   见 `lib/account/kiro-model-catalog.js`。

**策略链（自动抉择 + 兜底，两条路都在）**：

```
quota.strategies  = [ kiro-http-refresh (clientDependent:false, http)   ← 默认走这条
                    , kiro-cli-capture (clientDependent:true,  client-cli) ]  ← 拿不到 registration 时兜底
models.strategies = [ kiro-http-models  (clientDependent:false, http)
                    , kiro-native-cli-models (clientDependent:true, cli) ]
```

链执行器（`lib/usage/quota/strategies.js` / `lib/server/provider-model-strategies.js`）按
`clientDependent=false` 优先排序，失败自动切下一条，`attempts` 全程可观察。
`models` 能力在描述符契约里（`lib/providers/contract.js` 的 `CAPABILITY_NAMES`），
校验 http↔不依赖客户端、cli↔依赖客户端 的自洽性；**新增能力忘了登记进白名单会导致整个描述符
被拒（表现为「策略链查不到任何策略」），`test/quota-provider-coverage.test.js` 用
「描述符加载零错误」守住这一点**。

**验收（真实账号）**：`aih kiro usage --refresh` → `age: 0s`，`credits: 48.7/50 remaining (97.40%)`；
模型策略链 → `strategyId=kiro-http-models`，3 个模型；本地 CLI 路径在未安装 CLI 的机器上仍报
`native_cli_model_discovery_cli_not_found`（证明它确实依赖 CLI，因此只作兜底）。
