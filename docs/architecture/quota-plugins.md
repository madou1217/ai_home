# 额度（Quota / Remaining）来源抽象与插件

状态：已落地（2026-10-14）

范围：`lib/usage/quota/` 的额度源抽象、插件契约、消费方接线，以及 Cline Pass 的实现取证。
不包含：网关主链的额度判定（那是 `lib/server/provider-usage-policy.js` 的职责）。

## 1. 为什么需要这一层

额度知识此前分散在五处，且没有原生额度接口的 provider 无处安放：

| 位置 | 当时承担的事实 |
| --- | --- |
| `contracts/providers/manifest.json`（`core/providers/builtins.go` 生成） | 谁有 `quota_usage` 能力 |
| `lib/account/usage-remaining.js` | provider → 快照 kind、remainingPct 提取 |
| `lib/cli/services/usage/cache.js` | 可信快照的 kind / source / 形状名单 |
| `lib/server/accounts.js` | 逐 provider 的可信校验分支 |
| `lib/cli/services/usage/snapshot.js` | 探针表 |

后果（真实事故）：CodeBuddy 家族被写死名单漏掉、额度从未采集；Cline Pass 没有原生额度接口，
账号页只能显示「未知」；展示层还各存一份 kind 名单（`window-format.js`、WebUI 的
`ENTRY_WINDOW_SNAPSHOT_KINDS`），新增 provider 要改一串文件，漏一处就是「静默无额度」。

现在只有一处回答「谁提供额度、快照长什么样、怎么探测」：**额度源注册表**。

## 2. 分层与文件职责

| 文件 | 职责 |
| --- | --- |
| `lib/usage/quota/contract.js` | 插件契约与校验（叶子模块，无 I/O）。kind 必须已在 `USAGE_SNAPSHOT_KINDS` 登记，否则拒绝注册 |
| `lib/usage/quota/registry.js` | 原生源 ∪ 插件的唯一视图：`has` / `get` / `listProviders` / `listSources` / `listSnapshotKinds(entryShape)` / `trustRule` / `isTrustedSnapshot` / `createProbe` |
| `lib/usage/quota/native-sources.js` | 原生源**数据**（id / providers / snapshotKind / sources / shape / entryShape），不含行为 |
| `lib/usage/quota/loader.js` | 插件目录发现与加载；单个失败只记录不中断 |
| `lib/usage/quota/plugins/*.js` | 随内核发布的插件（当前 `cline.js`） |
| `lib/usage/quota/index.js` | 门面：消费方只 require 这里；进程级单例 + `describeQuotaSources()` / `formatQuotaSourceLines()` |

原生探针实现留在原地（codex / claude / agy / gemini 的刷新阶梯在 `usage/snapshot.js`，
kimi / grok / kiro / zcode / CodeBuddy 家族是 `*-quota-probe.js`）——注册表只登记事实，
避免把行为搬进数据层。

## 3. 插件契约（contractVersion = 1）

```js
module.exports = {
  id: 'cline-pass',                 // 小写，^[a-z][a-z0-9_-]{0,63}$
  contractVersion: 1,
  providers: ['cline'],             // 该插件负责的 provider（非空、去重）
  snapshotKind: 'cline_pass_usage', // 必须已在 USAGE_SNAPSHOT_KINDS 登记
  source: 'cline_plan_usages_api',  // 写进 snapshot.source，可信校验用
  shape: 'entries',                 // 'entries' | 'models'
  entryShape: 'window',             // 'window' | 'bucket' | 'models'
  createProbe(deps) {
    return {
      // 不抛异常；失败返回 { error }，鉴权类失败带 auth: true
      async probe(accountRef, timeoutMs) {
        return { snapshot } // 或 { error: 'xxx', auth?: true }
      }
    };
  }
};
```

- `entryShape` 决定展示语义：`window` = 滚动时间窗（`window` / `windowMinutes` / `remainingPct` /
  `resetIn`），`bucket` = 余额桶（credits 等），`models` = 按模型型。展示层据此判断，
  **不再各写 kind 名单**。
- `createProbe(deps)` 收到的 deps 与原生探针同形：`fs` / `aiHomeDir` /
  `readAccountCredentialRecord` / `fetchWithTimeout` / `processObj` / `accountEgressDeps` /
  `accountArtifactHooks` / `resolveAccountEgressRequestOptions` / `usageSnapshotSchemaVersion`。

### 加载目录与顺序（先注册者生效）

1. 内置 `lib/usage/quota/plugins/`（`origin='builtin'`）
2. `AIH_QUOTA_PLUGIN_DIR`（冒号分隔，可多个；`origin='external'`）
3. `<AIH_HOME>/quota-plugins`（`origin='external'`）

冲突策略：**native 优先**；同一 provider 被两个插件认领时保留先注册者，后者的失败被记录。
加载失败（语法错误 / 契约不合法 / 冲突）一律进 `listQuotaPluginLoadErrors()`，
**绝不静默跳过**（AGENTS.md：降级必须显式可观察）。

### 快照形状（entries 型）

```json
{
  "schemaVersion": 2,
  "kind": "cline_pass_usage",
  "source": "cline_plan_usages_api",
  "capturedAt": 1791991459251,
  "account": { "userId": "usr-…", "planName": "Cline Pass (Monthly)", "periodEndMs": 1794634204000 },
  "entries": [
    { "bucket": "5h", "window": "5h", "windowMinutes": 300, "remainingPct": 74,
      "totalUnits": 10, "usedUnits": 2.6, "remainingUnits": 7.4, "unitType": "usd",
      "resetAtMs": 1791992557463, "resetIn": "18m" }
  ]
}
```
`category: 'gift' | 'detail'` 的条目只是旁路信息，不参与账号级 `min(remainingPct)`。

## 4. 消费方接线（谁问注册表什么）

| 消费方 | 问什么 |
| --- | --- |
| `lib/server/account-quota-probe-scheduler.js` | `listQuotaProviders()` → 定时探测哪些 provider |
| `lib/server/webui-account-live.js` | `listQuotaProviders()` → 账号页是否读该账号的额度快照 |
| `lib/cli/services/usage/snapshot.js` | `listQuotaProviders()` + `createQuotaProbe()` → 插件探针实例（原生实例仍由本文件构造） |
| `lib/cli/services/usage/cache.js` | `trustRule()` → 可信快照的 kind / source / shape |
| `lib/server/accounts.js` | `isTrustedQuotaSnapshot()` → 插件型 provider 的通用可信分支（native 分支保留，因为还带归一化语义） |
| `lib/cli/services/usage/window-format.js` | `listQuotaSnapshotKinds('window')` → 哪些 kind 按「5h: 91%」渲染 |
| `lib/account/derived-state.js` | `hasQuotaProvider()` → 合同 `quota_usage` 能力 ∪ 插件，决定 `quotaStatus` |
| `lib/server/account-usage-view.js` | 按 kind 归一化（插件新 kind 需加一支，否则快照被丢成空） |
| `web/src/features/accounts/account-state.ts` | WebUI 侧的 kind 集合（跨语言，必须同步；有守卫测试） |
| `lib/server/command-handler.js` | `formatQuotaSourceLines()` → `aih server status` 的额度来源与插件加载错误 |

## 5. Cline Pass 案例（2026-10-14 实测）

端点（`api.cline.bot`，Bearer 用带 `workos:` 前缀的 Cline OAuth access token）：

| 端点 | 用途 |
| --- | --- |
| `GET /api/v1/users/me/plan/usage-limits` | **服务端权威用量**：`data.limits[{type: five_hour\|weekly\|monthly, percentUsed, resetsAt}]` |
| `GET /api/v1/users/me/plan` | 窗口上限 `data.plan.entitlements.cline_pass.inferenceCapThreshold.{last5Hours,last7days,last30days}UsageCostUSDPerUser`（单位 **1e-8 USD**）、套餐名、`currentPeriodStart/End` |

`remainingPct = 100 - percentUsed`，重置时间直接用上游 `resetsAt`（滚动窗口，不自己推算）。

### 禁止用 `/users/{uid}/usages` 做窗口聚合（踩过的坑）

`GET /api/v1/users/{uid}/usages` 只能拿「最近若干笔明细」：

1. `limit` 上限 200（传 1000 被夹到 200）；
2. `nextToken` 游标**上游实际不生效** —— 连续翻页返回同一批最新记录（实测第 2~4 页完全重合），
   翻不回历史；`offset` 也被忽略；
3. 结果：任何滚动窗口都只能扫到最近十几分钟，`used` 被严重低估（实测 5h 算成 7.4%，
   服务端权威值 24%），`remaining` 虚高，会误导调度。

因此插件只用 `plan/usage-limits` 的 `percentUsed`。`/usages` 仅适合「最近 N 笔」这类明细展示。

## 6. 新增 provider 的步骤

```
1) lib/usage/quota/plugins/<provider>.js   实现契约（最小模板见第 3 节）
2) lib/account/usage-remaining.js          登记 provider -> kind，并把 kind 加进 ENTRY_WINDOW_KINDS
3) lib/server/account-usage-view.js        加归一化分支（保留 entries/account 形状）
4) web/src/features/accounts/account-state.ts  把 kind 加进 ENTRY_WINDOW_SNAPSHOT_KINDS
```

原生实现（不需要插件）的 provider 只需在第 2 步 + `native-sources.js` 登记事实。
外部插件（不进内核）放在 `AIH_QUOTA_PLUGIN_DIR` 或 `<AIH_HOME>/quota-plugins`，
第 2~4 步仍然要做（kind 与归一化是内核侧的事实）。

## 7. 不变量与守卫

- 插件不得覆盖 native；插件不得抢占已被认领的 provider。
- `snapshotKind` 必须已在 `USAGE_SNAPSHOT_KINDS` 登记（否则 remainingPct 提取不出来）。
- 缺失窗口**不产出条目**（宁可 Unknown，不臆造）；一个窗口都算不出来时返回 `{ error }`
  且不带快照，调用方保留旧缓存。
- 规则只在存在真实证据时生效：普通 200 正文与成功事件绝不改写成失败。
- 守卫测试：`test/quota-plugin-registry.test.js`（契约/注册表/加载/entryShape/派生额度状态）、
  `test/cline-quota-probe.test.js`（探针映射、错误分支、401 重试、禁止 `/usages` 聚合）、
  `test/account-quota-probe-scheduler.test.js`（插件 provider 必须被定时采集）、
  `test/quota-provider-coverage.test.js`（注册表覆盖与跨语言 kind 同步）。

## 8. 可观察性

- `aih server status` → `quota sources: N (native=…, plugin=…: cline-pass→cline)`；
  有失败时追加 `quota plugin errors: N` 与逐条 `code + 文件路径 + detail`。
- 程序内：`listQuotaPluginLoadErrors()` / `describeQuotaSources()`。
- 探针失败会写进账号的 `quotaReason`（账号页与 `aih <p> usage` 都能看到）。

## 9. 未接入额度的 provider（决策记录）

`test/quota-provider-coverage.test.js` 用显式清单守住「哪些 provider 刻意没有额度」，
新增 provider 时如果不做决定，测试会直接失败。当前清单：

| provider | 结论 | 依据 |
| --- | --- | --- |
| `opencode` | 无额度概念 | 官方只有会话/账单统计面（属于 `usage_scan`），没有「剩余百分比」接口 |
| `qoder` / `qodercn` | 暂时不可得 | 凭据是 WASM + machineId 加密的本地 blob、请求过 sgsdk 签名，客户端侧无额度查询面；配额墙只在推理失败时以 `error_code 118`（`pricingUrl`）暴露，拿不到剩余量。接上它需要先有可用的 `qodercli` + 账号做上游取证 |

### Cline API Key 账号（同一插件的另一半）

Cline Pass 订阅走 `plan/usage-limits`（有上限，可算百分比）。**API Key 账号**只有余额、
没有上限：`GET /api/v1/users/{uid}/balance` 返回 `{userId, balance}`，而
`/users/me/budget`、`/users/{uid}/budget`、`/users/me/spend-limits`、`/users/me/plan/spend-limits`
在 2026-10-14 实测**全部 404**。

因此插件对 API Key 账号返回 `api_key_mode_not_applicable`（账号页显示「额度不适用」），
而不是把「余额」伪装成「剩余百分比」——没有分母的百分比就是编造。
