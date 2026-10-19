# 能力插件标准：Provider / Account / Pricing / Quota

日期：2026-10-20
状态：**标准草案**。本文定义契约与迁移路线；除标注「已交付」的条目外，均未实现。
前置阅读：[插件化规划](../plans/2026-09-30-plugin-architecture-plan.md)、
[DSH / codex-proxy-rs 比较](./codex-proxy-rs-dsh-comparison.md)、
[插件 M2 报告](./plugin-m2-report.md)。

## 1. 结论

1. **核心只内置契约，不内置任何价格目录。** models.dev、官方定价页、LiteLLM、
   OpenRouter、爬虫、账号自定义价，全部通过同一条 `pricing` 契约提供数据；
   宿主只负责合并、裁决、缓存与展示。
2. **插件提供数据，宿主做决定。** 价格、额度、账号身份、Provider 能力都是
   「有权威性、有新鲜度、可能互相冲突」的事实，不能让任意插件直接决定最终值。
   最终值由宿主按 authority / freshness / specificity 合并，并保留 provenance。
3. **未知就是未知，不是 0。** 没有来源给出价格时返回 `unknown`，不允许默认 0；
   `0` 只能表达「来源明确声明免费」。
4. **复用现有插件底座，不另起框架。** 现有 M0–M2 已具备 Cordis 生命周期、
   manifest、capability contribution、跨进程 RPC、`observe/serial/waterfall/
   terminal/middleware` 五种执行语义。本文只新增能力名、数据对象和一种
   `collect` 语义，不新建插件运行时。
5. **先做价格，再做额度，最后做 Provider / 账号。** 价格插件风险最低、收益最直接；
   Provider 与账号插件触碰凭据、账号身份和路由，必须放在契约、权限和验收成熟之后。

## 2. 现状与缺口

### 2.1 已有基础（M0–M2）

| 能力 | 落点 | 状态 |
| --- | --- | --- |
| manifest / contribution 校验 | `contracts/plugins/contract.json`、`lib/plugins/sdk/manifest.js`、`scripts/generate-plugin-contract.js` | 已交付 |
| 插件安装、启停、卸载、配置 CAS | `lib/plugins/control/` | 已交付 |
| 跨进程 Host / RPC / 超时 / 排空 | `lib/plugins/transport/`、`lib/plugins/host/` | 已交付 |
| 执行语义 | `lib/plugins/runtime/capability-pipeline.js`：`observer / terminal / serial / waterfall / middleware` | 已交付 |
| 网关请求、路由、账号、attempt、alias、chat、tool、approval、ui | `contracts/plugins/contract.json` 的 `gateway.* / model.catalog / chat.* / tool / approval / ui` | 已交付（M2 主体） |
| Provider / upstream 能力名 | 合同里有 `provider`、`upstream` 两个 capability | **只有名字，没有 Provider 插件标准与验收** |
| 价格、额度、账号来源 | 无插件契约 | **缺口** |

### 2.2 本次价格事故暴露的问题

`gpt-6.1-sol` 显示无价格，根因不是 models.dev 没有数据，而是：

- `@opencode-ai/models` 被钉在 `0.0.71`（快照 `2026-09-11`），而 `0.0.109`
  （`2026-10-19`）才包含 `gpt-6.1-sol` / `gpt-6-sol` / `grok-4.7` 等新模型；
- models.dev 规范 `models` 条目通常 `cost: null`，真实价格在
  `providers.<provider>.models.<id>.cost`，旧解析器覆盖面不足；
- 同一模型在多个 provider 目录下价格不同，旧逻辑缺少「基座厂牌兜底」；
- 快照过期完全不可观察，界面上只表现为「价格未知」。

本次已交付的止血（`d5d79de7`、`33d0994b`）：

- 升级到 `0.0.109`，重新生成 `internal/adapters/modelmetadata/modelsdev/modalities.json`；
- `lib/server/models-dev-metadata.js` 增加版本点号、`[1m]`、`:0731` 变体，
  基座厂牌价格兜底，Grok/Kimi 目录映射；
- 282 个唯一 `provider|model` 行中，无价从 137 降到 33（Kimi 目录改名修正后）；
  `gpt-6.1-sol` 返回 input 2 / output 10 / cacheRead 0.1 / cacheWrite 2.5；
- 剩余 33 个主要是订阅别名、Ollama 标签、目录未收录模型，**不应猜价格**。

但这仍是「内置快照 + 内部 resolver」，不是标准。下一个模型改名（例如本次
`kimi-for-coding` → `kimi-code-plan-*`）还会以同样方式静默失效。

### 2.3 现有内部实现（未来插件的原型）

| 领域 | 现有实现 | 问题 |
| --- | --- | --- |
| Provider | `lib/providers/defs/<id>.js` + `lib/providers/contract.js` + `lib/providers/registry.js` | 描述符很完整，但只能内置；`lib/plugins/provider/registry.js` 另有一套 provider 插件校验，两边未统一 |
| 账号来源 | `lib/account/auth-sources.js`，来源与 `handler` 词汇表（`device-code` / `paste-token` / `host-account-scan`） | 声明式，但没有插件生命周期与外部来源标准 |
| 模型发现 | provider 描述符的 `models.strategies`，`lib/server/model-discovery/` | 策略链设计正确，可原样映射为插件 handler |
| 额度 | provider 描述符的 `quota.strategies` + `lib/usage/quota/strategies.js` + `lib/usage/quota/probes/` | 已有 `notApplicable` 语义，但没有插件契约和来源/新鲜度字段 |
| 价格 | `lib/usage/pricing-providers/models-dev.js`、`account-custom.js`、`lib/usage/model-pricing-resolver.js` | 是 decorator + resolver，不是多来源 collect；无 authority / provenance |
| 模型元数据 | `lib/server/models-dev-metadata.js` | models.dev 硬编码为唯一来源；无来源声明 |
| 用量扫描 | `lib/usage/*-model-usage-scanner.js`、`lib/usage/kiro-session-usage.js` | 与 Provider 绑定，未抽象为 `usage.scan` |

## 3. 设计原则

1. **Contract first**：先有 schema 和能力名，再有实现；Node / Go / TS 的类型由
   `contracts/plugins/contract.json` 生成，不手写第二份。
2. **Host owns truth**：账号身份（`accountRef`）、路由、失败策略、持久化、缓存、
   最终价格/额度裁决都在宿主；插件不能直接写 `app-state.db`。
3. **Data has provenance**：每一条价格、额度、模型元数据都必须带
   `source`（来源）、`authority`（权威级别）、`fetchedAt` / `expiresAt`、
   `confidence`，否则宿主拒绝采纳。
4. **Unknown ≠ zero**：`null` / 缺失表示未知；`0` 只能来自来源的显式零价。
5. **No network on the request path**：插件在后台刷新并落快照；推理请求只读缓存。
6. **Fail visible, not silent**：来源失败、冲突、过期、降级都必须可观察；
   不允许「悄悄换一个来源」或「悄悄按 0 计费」。
7. **Specificity before abbreviation**：精确模型 > 能力后缀变体 > 基座模型；
   派生值必须标 `derived: true`，并降低 confidence。
8. **No provider-name branches**：新增 Provider / 来源只加描述符或插件，
   不改中央 `if (provider === ...)`。`test/design-pattern-guard.test.js` 继续守这条。
9. **Offline-first**：没有网络时仍能用最后一次有效快照；过期只降权并提示，
   不阻断推理，也不清空价格。

## 4. 公共数据对象

所有对象都带 `schemaVersion`，并通过 `contracts/plugins/contract.json` 生成
Node / Go / TS 类型。下面是 v1 草案。

### 4.1 SourceRef

```ts
interface SourceRef {
  id: string;                 // 'models.dev' | 'openai-official' | 'account-custom' | ...
  kind: 'official' | 'provider' | 'aggregator' | 'community' | 'manual' | 'account';
  authority: number;          // 0..100，宿主定义的权威级别
  confidence: number;         // 0..1，来源自评 + 宿主校验后的置信度
  url?: string;
  license?: string;
  fetchedAt: string;          // ISO 8601
  effectiveAt?: string;       // 价格生效时间
  expiresAt?: string;         // 建议失效时间
  stale?: boolean;            // 宿主计算，不由插件填写
  notes?: string;
}
```

权威级别建议（宿主常量，插件只能声明 `kind`，不能自封 `authority`）：

| authority | 来源 | 说明 |
| --- | --- | --- |
| 100 | 账号自定义价 / 宿主人工覆盖 | 宿主所有，永远最高；不是插件 |
| 90 | 厂商官方 API / 官方定价页 | 需要来源 URL 与人工复核记录 |
| 80 | 厂商发布的机读目录 | 官方 JSON / SDK 快照 |
| 60 | Provider 专属目录（如 Cline Pass、Codex 套餐） | 只对对应 provider 生效 |
| 40 | 聚合目录（models.dev） | 覆盖广，但不保证最新/最准 |
| 20 | 社区目录（LiteLLM / OpenRouter） | 只作兜底，不参与主裁决 |
| 10 | 派生/推断（基座继承、后缀裁剪） | 必须 `derived: true` |

### 4.2 PriceQuote

```ts
interface PriceQuote {
  schemaVersion: 1;
  provider: string;           // 计费身份：'openai' | 'anthropic' | 'cline-pass' | ...
  model: string;              // 目录中的完整模型 ID
  accountRef?: string;        // 账号级报价时填写；宿主匹配时优先
  currency: 'USD';
  unit: 'per_1m_tokens';
  status: 'priced' | 'free';  // 'unknown' 不是 quote，由宿主合成
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;  // 5 分钟缓存写入（Anthropic 默认档）
  cacheWrite1h: number | null;// 1 小时缓存写入；没有就 null，绝不补齐
  reasoning: number | null;
  tiers?: Array<{
    when: { contextTokensGt: number };
    input: number | null;
    output: number | null;
    cacheRead: number | null;
    cacheWrite: number | null;
    cacheWrite1h: number | null;
  }>;
  source: SourceRef;
  derived?: boolean;
  derivedFrom?: string;       // 基座模型 ID
  warnings?: string[];
}
```

要点：

- 价格单位统一为 **USD / 1M tokens**；内部计算仍用 per-token 小数，避免二次舍入。
- `cacheRead` / `cacheWrite` / `cacheWrite1h` 分开表达；没有的维度是 `null`。
- 分档价格（>200k / >272k）用 `tiers`，不用 `contextOver200k` 这种单字段
  （保留旧字段做兼容投影即可）。
- 一个插件可以对同一模型返回多条 quote（不同 provider / 账号 / 生效时间），
  由宿主选择。

### 4.3 QuotaSnapshot

```ts
interface QuotaWindow {
  bucket: '5h' | '7d' | 'monthly' | 'gift' | 'credits' | string;
  used?: number | null;
  total?: number | null;
  remaining?: number | null;
  remainingPct?: number | null;
  resetAt?: string | null;
  unit?: 'tokens' | 'credits' | 'requests' | 'usd';
}

interface QuotaSnapshot {
  schemaVersion: 1;
  provider: string;
  accountRef: string;
  status: 'ok' | 'not_applicable' | 'unavailable';
  reason?: string;            // not_applicable / unavailable 的原因
  windows: QuotaWindow[];
  planName?: string;
  source: SourceRef;
  fetchedAt: string;
  expiresAt?: string;
}
```

`not_applicable` 是**结论**，不是失败（例如 Qoder Free 档 `credits=0` 但账号仍可跑免费模型）。
宿主必须区分 `not_applicable`、`unavailable`、`ok`，不能把前两者写成 0%。

### 4.4 ProviderDescriptor

沿用 `lib/providers/contract.js` 的字段，抽成可序列化对象：

```ts
interface ProviderDescriptor {
  contractVersion: 1;
  id: string;
  version: string;
  displayName: string;
  protocols: {
    client: string[];         // openai_chat / openai_responses / anthropic / gemini
    upstream: string;
  };
  capabilities: {
    models?: ModelDiscoveryCapability;
    quota?: QuotaCapability;
    usage?: UsageCapability;
    relay?: RelayCapability;
    authSources?: AuthSourcesCapability;
    hooks?: HooksCapability;
    egress?: EgressCapability;
  };
  metadata: {
    docs?: string;
    officialHosts?: string[];
    hostObserved?: boolean;
  };
  handlers: string[];        // 由插件注册的 handler id，不是函数引用
}
```

Provider 插件只声明**数据与 handler id**；handler 的实现由插件以单独的
capability contribution 提供，宿主按 id 解析。这样描述符可以安全地投影给 Go，
不会把函数/凭据带过去。

### 4.5 AccountSource / Login / Refresh

```ts
interface AccountSourceDescriptor {
  id: string;
  kind: 'local' | 'remote';
  app?: 'desktop' | 'cli';
  authMode: 'login' | 'api-key' | 'oauth-browser' | 'oauth-device' | 'paste-token';
  handler: 'host-account-scan' | 'device-code' | 'social-device-code' | 'paste-token';
  directImport: boolean;
  clientDependent: boolean;
  requires?: { app?: 'desktop' | 'cli' };
  description?: string;
}

interface AccountCredential {
  // 具体字段由 Provider 声明；宿主只做加密存储与投影，不解释业务字段
  [key: string]: unknown;
  accountIdentity?: string;  // 用于去重的稳定身份键（不是 accountRef）
}

interface LoginJob {
  jobId: string;
  status: 'pending' | 'waiting_user' | 'success' | 'failed' | 'cancelled';
  verificationUri?: string;
  verificationUriComplete?: string;
  userCode?: string;
  expiresAt?: string;
  error?: { code: string; message: string };
}
```

运行边界：

- 插件返回凭据/身份，**宿主**计算 `accountRef`、判重、写库、处理删除墓碑。
- `directImport` 只表示「凭据已是完整投影，可直接注册」，不表示插件可以写库。
- `refresh` 必须支持 CAS：返回 `consumedRefreshToken` / `rotated`，宿主只在文件里的
  token 仍是本次消费的那个时才覆盖（kimi 的轮换链是既有教训）。

## 5. 插件类型契约

### 5.1 Provider 插件

**目标**：新增一个 provider 只需提供一个描述符 + 可选 handler，不改派发代码。

**贡献方式**：

```json
{
  "id": "my-provider-descriptor",
  "capability": "provider.descriptor",
  "version": 1,
  "failurePolicy": "deny"
}
```

`provider.descriptor` 使用 `collect` 语义（一个插件可声明多个 Provider），
宿主校验后写入运行代次。handler 另以 `provider.auth` / `provider.models` /
`provider.quota` / `provider.relay` 等 capability 注册，manifest 里声明 handler id。

**宿主校验**（缺一不可）：

1. `id` 不覆盖内置 provider（现有 `plugin_provider_builtin_conflict` 规则保留）。
2. `contractVersion` / `protocols` / capability 名称在白名单内。
3. `authSources.handler` 必须在 `AUTH_SOURCE_HANDLERS` 白名单内。
4. `quota.strategies` 每一条必须声明 `clientDependent`，且至少有一条
   `clientDependent=false`，否则必须有 `clientFreeReason`（沿用现有契约校验器）。
5. `models.strategies` / `quota.strategies` 的 `handler` 必须能解析到本次代次注册的
   handler；解析失败整份描述符拒绝（fail closed）。
6. 描述符必须可 JSON 序列化，不能带函数、路径、凭据。

**不允许**：Provider 插件直接选账号、直接改路由、直接写账号状态、直接持有凭据文件。
这些仍是宿主领域。

**迁移**：现有 `lib/providers/defs/*.js` 原样作为「内置 Provider 插件」加载；
新增外部 Provider 插件走同一校验器。Go Core 只消费生成后的
`contracts/providers/manifest.json` 投影，不执行插件代码。

### 5.2 账号插件

账号不是「一个接口」，拆成四个窄接口，避免插件越权：

| capability | 职责 | 宿主保留 |
| --- | --- | --- |
| `account.source` | 列出本机可导入来源、读取候选凭据、给出身份键 | 判重、`accountRef`、入库、删除墓碑 |
| `account.login` | 设备码 / 浏览器 OAuth / 粘贴 token 的登录任务状态机 | 任务持久化、UI 呈现、取消、超时 |
| `account.refresh` | 用 refresh_token / API key 换取新凭据 | CAS 写回、轮换协调、失败分类 |
| `account.materialize` | 把凭据投影成 CLI/App 可用的 runtime dir / env | 沙箱、权限、HOME/XDG 隔离 |

**`account.source` 示例**：

```js
module.exports = {
  async list(ctx) {
    return [{
      id: 'local-desktop',
      kind: 'local',
      app: 'desktop',
      authMode: 'oauth-browser',
      directImport: false,
      clientDependent: true,
      identity: { subject: 'user@example.com' },
      credential: { /* opaque */ }
    }];
  }
};
```

宿主拿 `identity` 算指纹，命中已有账号就标 `alreadyImported` 并不显示（沿用现有
`auth-sources.js` 语义）；`directImport=true` 时才允许直接提交
`/v0/webui/accounts/local-import`，否则必须走登录任务。

**`account.login` 示例**：

```js
module.exports = {
  async start(input, ctx) {
    return { status: 'waiting_user', verificationUri, userCode, expiresAt };
  },
  async poll(jobId, ctx) {
    return { status: 'success', credential: { /* ... */ } };
  },
  async cancel(jobId, ctx) { /* ... */ }
};
```

登录插件**不**决定账号显示名、不写 `app-state.db`、不生成 `accountRef`。

**`account.refresh` 示例**：

```js
module.exports = {
  async refresh(credential, ctx) {
    const next = await exchange(credential.refreshToken);
    return {
      credential: next,
      rotated: true,
      consumedRefreshToken: credential.refreshToken,
      expiresAt: next.expiresAt
    };
  }
};
```

### 5.3 模型价格插件

这是本次最需要落地的部分。价格拆成两个 capability：

| capability | 语义 | 用途 |
| --- | --- | --- |
| `pricing.catalog` | `collect`：返回一批 `PriceQuote`（可全量/增量） | 目录型来源（models.dev、官方 JSON、LiteLLM） |
| `pricing.quote` | `collect`：按 `(provider, model, accountRef?, at)` 返回最多 N 条报价 | 需要实时查询/按账号定价的来源 |

**manifest 示例**：

```json
{
  "manifestVersion": 1,
  "protocolVersion": 2,
  "pluginId": "aih.pricing.models-dev",
  "version": "1.0.0",
  "runtime": "node",
  "entry": "index.js",
  "contributes": [
    {
      "id": "models-dev-catalog",
      "capability": "pricing.catalog",
      "version": 1,
      "failurePolicy": "delegate"
    }
  ],
  "configSchema": {
    "type": "object",
    "properties": {
      "snapshotPath": { "type": "string" },
      "refreshIntervalMs": { "type": "integer", "minimum": 60000 }
    }
  }
}
```

**`pricing.catalog` 返回**：

```js
module.exports = {
  async catalog(input, ctx) {
    return {
      generatedAt: '2026-10-19T05:32:55.764Z',
      quotes: [
        {
          schemaVersion: 1,
          provider: 'openai',
          model: 'gpt-6.1-sol',
          currency: 'USD',
          unit: 'per_1m_tokens',
          status: 'priced',
          input: 2,
          output: 10,
          cacheRead: 0.1,
          cacheWrite: 2.5,
          cacheWrite1h: null,
          reasoning: null,
          tiers: [
            { when: { contextTokensGt: 272000 }, input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5, cacheWrite1h: null }
          ],
          source: {
            id: 'models.dev',
            kind: 'aggregator',
            authority: 40,
            confidence: 0.8,
            url: 'https://models.dev',
            license: 'MIT',
            fetchedAt: '2026-10-19T05:32:55.764Z',
            expiresAt: '2026-10-26T00:00:00.000Z'
          }
        }
      ]
    };
  }
};
```

**宿主合并算法**（核心，不允许插件自己做最终选择）：

```
collect all quotes from all pricing.catalog / pricing.quote contributions
filter: provider/model 匹配, currency=USD, effectiveAt <= now, not expired
for each dimension (input/output/cacheRead/cacheWrite/cacheWrite1h/reasoning):
  candidates = quotes with non-null dimension
  rank by:
    1. accountRef exact match (account-specific quote)
    2. authority desc
    3. specificity desc (exact model > suffix variant > base/derived)
    4. fetchedAt desc
    5. confidence desc
  pick winner; if winner.derived -> keep derived flag on the merged quote
merge: account override (host) > manual override (host) > plugin winners
if a dimension has no candidate -> null (unknown), never 0
conflicts: record warnings [{ dimension, chosen, rejected: [...] }]
```

- **账号自定义价**是宿主 override，不经过插件；它永远覆盖插件结果，但仍保留
  `source.kind='account'` 供 UI 展示。
- **base model 继承**：例如 `claude-opus-4-8[1m]` 找不到时，落 `anthropic/claude-opus-4-8`；
  合并结果标 `derived: true`、`derivedFrom`，confidence 降一档。绝不能在没有任何
  记录时按 0 计费。
- **冲突**：官方价与 models.dev 不一致时，按 authority 选官方，但把两者都放进
  `warnings`/`alternatives`，UI 可展开查看；不静默丢弃。
- **过期**：超过 `expiresAt` 的 quote 仍可用于展示，但标 `stale: true` 并降权；
  新请求不应因价格过期而失败。

**models.dev 的定位**：

- 短期（P1）：保留 SDK 离线快照，但包装成内置 `pricing.catalog` 插件，
  `kind='aggregator'`、`authority=40`、`fetchedAt` 取快照 `generatedAt`；
  快照超过 14 天在 UI 和管理接口标 stale。
- 中期（P3）：抽成独立插件包 `@aih/pricing-models-dev`，核心只依赖契约；
  可以禁用、替换、升级而不发核心版本。
- 长期（P4）：官方源（OpenAI/Anthropic/Google/DeepSeek）作为 `kind='official'`
  插件并行存在；models.dev 只做覆盖兜底，不再决定最终价。

**官方源怎么做**：

- 优先官方机读 JSON / API；没有时用官方定价页抓取，但必须：
  - 固定 URL、固定解析器、固定 fixture；
  - 每次抓取留 `fetchedAt` / `url` / 原始内容摘要；
  - 解析失败不覆盖上一次有效快照；
  - 新价格与旧价格差异超过阈值时进入人工复核队列（不自动生效）。
- 不鼓励无审查的通用爬虫；价格是计费事实，不是搜索结果。

### 5.4 模型元数据插件

`model.catalog` 仍保留现有 alias 语义（`terminal`），另加：

| capability | 语义 | 数据 |
| --- | --- | --- |
| `model.metadata` | `collect` | modalities、context window、max output、capabilities（vision/tool/image_out） |

合并规则与价格类似：精确模型 > 后缀变体 > 基座；provider 记录 > 规范记录；
未知时 fail-open（沿用现有 `inferBaseModelIds` / `chat-harness` 的 `['text','image']`
策略），但必须记录 `source`。

### 5.5 额度与用量插件

| capability | 语义 | 说明 |
| --- | --- | --- |
| `quota.probe` | `serial`（策略链） | 每个 Provider 多条策略，按 `clientDependent=false` 优先；第一条成功/`not_applicable` 即停 |
| `usage.scan` | `collect` | 从本地会话文件扫描 token 用量；返回 `UsageRecord[]` |

**`quota.probe` 示例**：

```js
module.exports = {
  async probe(accountRef, timeoutMs, ctx) {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (res.status === 401) return { error: 'auth_invalid', auth: true };
    if (!res.ok) return { error: `http_${res.status}` };
    return {
      snapshot: {
        schemaVersion: 1,
        provider: 'qoder',
        accountRef,
        status: 'ok',
        windows: [{
          bucket: 'credits',
          used: 120,
          total: 500,
          remaining: 380,
          remainingPct: 76,
          resetAt: '2026-11-01T00:00:00.000Z',
          unit: 'credits'
        }],
        source: {
          id: 'qoder-account-api',
          kind: 'provider',
          authority: 80,
          confidence: 0.95,
          url: 'https://openapi.qoder.sh/api/v2/quota/usage',
          fetchedAt: new Date().toISOString()
        }
      }
    };
  }
};
```

- `notApplicable` 必须显式返回，不能用一个全 0 快照冒充。
- 宿主负责调度、缓存、失败冷却、账号归属（`registry-scope-ownership`）和 UI 投影；
  插件不写账号状态。
- `usage.scan` 只返回原始记录；计价由 `pricing` 在宿主侧完成。

## 6. 契约扩展

### 6.1 新增 capability 与 `collect` 语义

在 `contracts/plugins/contract.json` 增加：

```json
{ "id": "pricing.catalog", "version": 1, "mode": "collect" },
{ "id": "pricing.quote",   "version": 1, "mode": "collect" },
{ "id": "model.metadata",  "version": 1, "mode": "collect" },
{ "id": "quota.probe",     "version": 1, "mode": "serial" },
{ "id": "usage.scan",      "version": 1, "mode": "collect" },
{ "id": "provider.descriptor", "version": 1, "mode": "collect" },
{ "id": "account.source",  "version": 1, "mode": "collect" },
{ "id": "account.login",   "version": 1, "mode": "terminal" },
{ "id": "account.refresh", "version": 1, "mode": "terminal" }
```

`collect` 是新增的第六种语义：

- 所有 contribution 都被调用（并发或顺序由宿主决定）；
- 单个失败按 `failurePolicy` 隔离，不影响其他来源；
- 返回 `{ items: unknown[], attempts: [{ id, error? }] }`；
- 宿主负责合并；不允许 `collect` contribution 直接返回最终值。

**不要一次加完。** P1 只加 `pricing.catalog` + `collect`；其余按阶段加，
避免出现「合同里有、运行时永远不调用」的死能力。

### 6.2 manifest 权限扩展

现有 manifest 没有权限声明。处理凭据、网络、文件系统的插件必须显式声明：

```json
{
  "permissions": {
    "network": ["https://models.dev", "https://api.openai.com"],
    "filesystem": { "read": ["state"], "write": ["state"] },
    "secrets": ["apiKey"],
    "env": ["OPENAI_API_KEY"]
  },
  "stateSchemaVersion": 1
}
```

- `network` 是域名白名单，不是通配；`*` 只允许内置签名插件。
- `filesystem` 只能访问插件私有 state 目录；账号凭据目录不在白名单内。
- 插件需要宿主服务时，只能通过 `hostServices` 里的只读查询，不允许直连数据库。
- 权限校验在安装时与运行时各做一次；越权调用记审计日志并拒绝。

### 6.3 代次与 Go 投影

- 价格/额度/Provider 描述符都随插件代次发布；使用现有 generation/排空机制。
- Go Core 不加载插件，只消费宿主投影后的有效值：
  - `provider.descriptor` → `contracts/providers/manifest.json`；
  - `pricing` → 有效价格投影（按 provider/model 的最终 quote + source）；
  - `quota` → 账号可用性/额度快照（用于路由和 UI，不用于 Go 内部计费）。
- 投影失败时 fail closed：保留上一代有效投影，不把半成品发给 Go。

## 7. 安全、生命周期与可观测性

1. **插件不是可信代码**：签名/摘要只证明完整性，不证明安全。外部插件在独立进程运行，
   默认无凭据、无数据库、无任意文件系统。
2. **安装即授权**：安装/启用插件需要管理密钥 + 显式权限确认；自动更新默认关闭。
3. **凭据不落插件日志**：宿主对 `credential` 字段做脱敏；插件崩溃时的 stderr 也过滤。
4. **Cordis 生命周期**：`apply` / `inject` / `effect` 管理监听器、定时器、socket；
   卸载时 await `dispose`，与现有 M1 排空协议一致。
5. **可观测性**：`aih plugin doctor` 输出每个 capability 的：
   - 来源 id / kind / authority / fetchedAt / expiresAt；
   - 最近一次成功/失败、耗时、覆盖模型数；
   - 冲突数量、stale 数量、unknown 数量；
   - 与上一代相比的新增/删除/价格变化（供人工复核）。
6. **UI**：模型详情显示价格来源徽标（官方 / 账号自定义 / models.dev / 社区）、
   新鲜度、冲突提示；`unknown` 显示为「未知」，不显示 `$0`。

## 8. 缓存计价：正式结论

「缓存读/写是否分开计价」没有统一标准，**由厂商计费模型决定**，不能一律合并，
也不能用输入价强行推导：

| 厂商 | 缓存读 | 缓存写 | 备注 |
| --- | --- | --- | --- |
| Anthropic | 单独价格（约 0.1x 输入） | **5m / 1h 两档**（1.25x / 2x 输入） | 1h 缓存写入必须单独字段；没有数据就 `null` |
| OpenAI（gpt-6 系列） | cached input 折扣 | 通常不单独收费 | 只有 `cacheRead`，不要补 `cacheWrite` |
| Gemini | 上下文缓存读取价 | 缓存存储按时长计费 | 与 token 计价不同维度，不能塞进 `cacheWrite` |
| DeepSeek | cache hit / miss 输入价 | 无独立写入价 | 用 `cacheRead` 表达 hit 价，miss 用 `input` |

因此：

- 规范字段是 `cacheRead` / `cacheWrite`（5m）/ `cacheWrite1h`；没有的维度是 `null`。
- 来源只给一个 `cacheWrite` 时，不能自动复制成 `cacheWrite1h`；只能在 UI 标
  「1h 价格未知」。
- 计算成本时用精确 per-token 小数；只在展示边界舍入。
- 展示精度：当前 `web/src/utils/model-price.ts` 固定 2 位小数会把 `$0.003` 显示成
  `$0.00`。应改为自适应精度（至少 3 位有效数字，必要时 4 位小数），并保留
  `unknown` 与 `free` 的区分。

## 9. 借鉴 DSH / Cordis 的边界

| DSH 机制 | 可借鉴 | 不照搬 |
| --- | --- | --- |
| Cordis `apply/inject/effect` | 插件生命周期、依赖注入、资源回收 | 不引入第二套 Context/服务定位器；沿用现有 Plugin Host |
| profile / bundle / patch | 配置组合与覆盖的分层 | 不与账号 profile 混用；AIH 用 generation/revision 发布 |
| observer / serial / waterfall | 现有执行语义已对齐 | 不为价格/额度新增特殊语义（只加 `collect`） |
| tool pre/guard/execute/post | 宿主校验 → 插件执行 → 宿主合并 | 不让价格插件 veto 请求；价格缺失不阻断推理 |
| plugin manager / doctor / UI slots | 安装、诊断、状态展示 | 不复制 DSH 的 Agent loop / SessionStore；会话仍归 AIH |
| 官方 SDK / 模板 / 兼容性预检 | 降低插件开发门槛 | 不承诺与 DSH 插件二进制兼容 |

结论：**借鉴生命周期与组合方式，不借鉴 Agent 执行模型**。AIH 的账号、会话、路由、
失败策略继续由现有领域模块拥有。

## 10. 分阶段路线

### P0：止血（已交付，2026-10-20）

- SDK `0.0.71` → `0.0.109`，重生成 Go 模态索引；
- 修正 alias / 基座 / 版本点号 / `[1m]` / `:0731` 解析；
- 新增回归测试；`gpt-6.1-sol` 等恢复价格；无价唯一行 137 → 33；
- 提交：`d5d79de7`、`33d0994b`。

验收：`npm run models:check` 通过；定向测试 60 pass；`/v0/webui/openai-models`
返回 `gpt-6.1-sol` 的完整 cost。

### P1：价格插件第一切片（下一步，优先）

1. 在 `contracts/plugins/contract.json` 增加 `pricing.catalog` + `collect`，
   重新生成 Node/Go/TS 合同。
2. 新增 `lib/usage/pricing/price-quote.js`（值对象 + 校验）与
   `lib/usage/pricing/merge-quotes.js`（authority/freshness/specificity 合并），
   纯函数、无插件依赖、单测覆盖冲突/未知/派生/过期。
3. 把 `models-dev.js` 包成内置 `pricing.catalog` 插件适配器；账号自定义价仍是
   宿主 override（decorator 保留）。
4. `/v0/webui/openai-models` 的 `metadata` 增加
   `pricingSource / pricingAuthority / pricingFetchedAt / pricingStale /
   derivedFrom / warnings`；WebUI 显示来源与新鲜度。
5. 快照超过 14 天时在 `aih server status` 与 UI 标 stale。

验收：同一模型多来源冲突时官方优先且可见；无来源仍 `unknown`；不因价格缺失
拒绝推理；请求路径无网络；`test/design-pattern-guard.test.js` 仍绿。

### P2：额度与模型元数据插件

- `quota.probe` 包装现有 probes；`not_applicable` / `unavailable` 标准化；
- `model.metadata` 包装 modalities/context，保留 fail-open；
- `usage.scan` 抽象本地会话扫描；
- UI 显示来源/新鲜度，gift 余额仍不计入 min 剩余（现有口径）。

### P3：Provider 插件

- `provider.descriptor` + handler 注册；现有 `lib/providers/defs/*.js` 作为内置插件；
- 外部 Provider 插件样例 + conformance 套件；
- Go 投影 `contracts/providers/manifest.json` 保持同源。

### P4：账号插件

- `account.source` / `login` / `refresh` / `materialize`；
- 包装现有 authSources 与登录任务；
- kimi CAS 轮换、host-observed 墓碑、`directImport` 语义纳入契约；
- 外部账号插件必须显式授权网络/凭据/文件系统权限。

### P5：外部插件治理与官方价格源

- 插件包签名、权限、审计、`aih plugin doctor`；
- 官方 OpenAI/Anthropic/Google/DeepSeek 价格插件；
- LiteLLM / OpenRouter 作为 `community` 兜底；
- 价格变化人工复核队列；
- 自动刷新 + 离线快照 + 失败不覆盖。

### P6：Go Core 消费

- 有效价格/额度投影给 Go；Go 不执行插件；
- `npm run gateway:shadow` 覆盖价格相关响应；
- 双端 unknown/free/zero 语义一致。

## 11. 风险与边界

1. **官方页面抓取脆弱**：HTML 改版、地区差异、登录墙。必须有 fixture、差异告警、
   人工复核；解析失败保留旧快照。
2. **目录改名**：本次 `kimi-for-coding` → `kimi-code-plan-*` 就是实例。契约要允许
   alias 表与 legacy ID，并在 doctor 里报告「目录 ID 消失」。
3. **订阅 vs API 价**：Cline Pass、Kimi 套餐、CodeBuddy 套餐不是基础厂牌 API 价；
   必须用 provider-specific quote，不能拿 OpenAI/Anthropic 价套。
4. **货币与税**：v1 只支持 USD；其他货币需要显式 FX 来源，否则拒绝，不做隐式换算。
5. **插件信任**：签名不等于安全；价格/额度插件可以影响展示与路由判断，必须权限隔离。
6. **性能**：`pricing.catalog` 可能是几千条；宿主必须索引、增量更新、限制单次载荷
   （现有 `payloadBytes` 4MB 上限）。
7. **历史成本**：本次不引入「请求时价格快照」；未来若做账单，需要把 quote id /
   effectiveAt 写进 usage 记录，避免用今天的价格重算历史。
8. **不要过度设计**：P1 不做外部插件加载、不做数据库、不做多币种；先把
   「多来源 + provenance + unknown」跑通。

## 12. 设计模式使用说明

| 模块 | 模式 | 为什么 | 验证 |
| --- | --- | --- | --- |
| `lib/usage/pricing/merge-quotes.js`（P1） | Strategy + Policy | 多来源按 authority/freshness/specificity 裁决，新增来源不改合并代码 | 纯函数单测：冲突、过期、派生、未知 |
| `pricing.catalog` / `pricing.quote` contribution | Registry + Adapter | 插件只提供数据，宿主按 capability 倒排索引调用 | 合同生成 + conformance |
| `lib/server/models-dev-metadata.js`（已改） | Adapter + Value Object | 把外部目录形状翻译成稳定价格/元数据；解析规则集中 | 60 个定向测试 |
| `lib/usage/model-pricing-resolver.js`（现状） | Chain of Responsibility | 多 provider 依次解析；本次保留，P1 在其上增加 collect | 现有 resolver 测试 |
| Provider 描述符 / 插件描述符 | Descriptor + Registry | 新增 provider 只加数据，不写派发分支 | `test/design-pattern-guard.test.js` |
| 宿主合并与权限校验 | Facade + Guard | 插件不直接接触账号/数据库；宿主统一裁决 | 权限/审计测试 |

KISS / YAGNI 取舍：P1 不引入外部插件加载、不做价格数据库、不做多币种；先以
内置适配器验证契约。只有出现第二个真实来源（官方价或 LiteLLM）时，才把
`pricing.catalog` 开放给外部插件。

## 13. 立即可执行的下一步

建议按以下顺序提交，每一步独立可验证：

1. `feat(plugins): add pricing.catalog capability and collect semantics`
   - `contracts/plugins/contract.json` + 生成物 + `capability-pipeline` 的 `collect`；
   - 不接任何业务，先让合同与执行语义可测。
2. `feat(pricing): add PriceQuote value object and host merge policy`
   - `lib/usage/pricing/price-quote.js`、`merge-quotes.js` + 单测；
   - 输入是现有 models.dev records 与账号自定义价，输出合并结果 + warnings。
3. `refactor(pricing): expose models.dev as built-in catalog source`
   - 包装 `models-dev.js`，保留 resolver 兼容；
   - `/v0/webui/openai-models` 增加 provenance 字段。
4. `feat(web): show pricing source, freshness and unknown state`
   - 模型卡片/详情显示来源徽标、stale、冲突；修正 `formatPricePerM` 精度。
5. 之后再开 `quota.probe` / `provider.descriptor` / `account.*`。

在 P1 完成前，不建议把 `provider` / `account` capability 写进合同：那会制造
「合同存在但无实现」的假完成度。价格是当前唯一有真实数据、真实冲突、真实收益的
切入口，先把这条路走通。
