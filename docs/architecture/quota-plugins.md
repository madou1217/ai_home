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
| `lib/providers/loader.js` | 目录扫描：内置 `defs/`、`AIH_PROVIDER_DEFS_DIR`、`<AIH_HOME>/provider-defs`；兼容旧额度插件形状（`AIH_QUOTA_PLUGIN_DIR`、`<AIH_HOME>/quota-plugins`） |
| `lib/providers/defs/<id>.js` | **每个 provider 自己的能力自描述**（quota / usage / relay） |
| `lib/providers/index.js` | 门面：倒排查询、能力读取、加载错误、诊断行 |
| `lib/usage/quota/index.js` | 额度领域派生：谁有额度、可信规则、时间窗 kind、策略链执行、诊断 |
| `lib/usage/quota/strategies.js` | 策略链执行器（默认最稳 + 失败切换 + attempts 可观察） |
| `lib/usage/quota/probes/*.js` | 探针实现（当前 `cline.js`：Cline Pass） |
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
- 声明的 handler 必须在组合根里存在；WebUI 的 kind 镜像必须与服务端登记表一致。
- 策略链默认最稳、失败切换，attempts 可观察。

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
