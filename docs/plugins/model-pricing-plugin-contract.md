# 模型价格 / 元数据插件契约

状态：v1（wire schema 1）
适用能力：`pricing.catalog`、`pricing.quote`、`model.metadata`
Go 契约：`contracts/modelpricing/contract.go`

## 1. 目标与边界

目标：把“模型价格从哪来”从核心代码里拿出来，models.dev 只是其中一个内置来源；
自定义价格插件可以替换或覆盖它，而不改推理、计费、WebUI 代码。

边界：

- 插件只提供“某来源对某模型的报价 / 元数据”；
- 合并、账号覆盖、最终计费口径、人工复核由宿主决定；
- 价格单位固定 **USD / 每百万 token**（`per_1m_tokens`）；
- 插件不能声明 `account` / `manual` 来源；这两类只由宿主构造；
- 采集失败保留上一份可用快照，不删除、不清空；
- 请求路径（`/v1` 推理）不触发抓取或插件网络访问。

## 2. 能力与 manifest

三个能力可单独或同时声明：

| capability | mode | 用途 |
|---|---|---|
| `pricing.catalog` | collect | 返回整份来源目录（离线快照 + 人工复核） |
| `pricing.quote` | collect | 单模型报价，覆盖目录未收录的模型 |
| `model.metadata` | collect | 上下文窗口、模态、推理档位等展示元数据 |

manifest 示例（字段以 `contracts/plugins/manifest.schema.json` 为准）：

```json
{
  "manifestVersion": 1,
  "protocolVersion": 1,
  "pluginId": "pricing.custom",
  "version": "1.0.0",
  "engines": { "aih": ">=1.0.0", "node": ">=20" },
  "runtime": { "kind": "node" },
  "entry": "index.js",
  "contributes": [
    { "id": "custom-catalog", "capability": "pricing.catalog", "version": 1, "order": 100, "failurePolicy": "delegate" },
    { "id": "custom-quote", "capability": "pricing.quote", "version": 1, "order": 100, "failurePolicy": "delegate" },
    { "id": "custom-metadata", "capability": "model.metadata", "version": 1, "order": 100, "failurePolicy": "delegate" }
  ]
}
```

`order` 只影响同一 authority 层内的尝试顺序，不能越过宿主的账号/人工覆盖。

## 3. Wire 协议

宿主通过插件宿主的 `runtime.invoke` 调用；请求与响应均为 JSON。

### 3.1 pricing.catalog

请求：

```json
{ "schemaVersion": 1, "kind": "catalog", "now": "2026-11-19T04:30:00Z" }
```

响应：

```json
{
  "source": {
    "id": "custom:pricebook",
    "kind": "official",
    "authority": 90,
    "confidence": 0.95,
    "url": "https://example.com/prices.json",
    "license": "proprietary",
    "fetchedAt": "2026-11-19T04:29:00Z"
  },
  "generatedAt": "2026-11-19T04:29:30Z",
  "quotes": [
    {
      "provider": "openai",
      "model": "gpt-6.2",
      "currency": "USD",
      "unit": "per_1m_tokens",
      "input": 2.5,
      "output": 10,
      "cacheRead": 0.25,
      "cacheWrite": 3.125,
      "tiers": [
        { "when": { "contextTokensGt": 200000 }, "input": 5, "output": 15 }
      ],
      "source": { "id": "custom:pricebook", "kind": "official", "authority": 90 },
      "specificity": 2
    }
  ]
}
```

规则：

- 单条坏报价不得毒化整份目录：宿主逐条校验，坏条目丢弃并计入 `invalid`；
- 返回 `quotes: []` 表示“该来源暂时没有报价”，不是删除旧快照；
- `source.kind` 只能在 `official/vendor/provider/aggregator/community/derived/unknown` 中选择；
- `fetchedAt`、`expiresAt` 使用 RFC3339；缺失或超过 14 天标记 stale。

### 3.2 pricing.quote

请求：

```json
{
  "schemaVersion": 1,
  "kind": "quote",
  "now": "2026-11-19T04:30:00Z",
  "provider": "openai",
  "model": "gpt-6.2",
  "accountRef": "acct_...",
  "contextTokens": 120000
}
```

响应：一条 Quote（与 catalog.quotes[] 同形状），或 `{ "quote": { ... } }`。

未收录时返回 `status: "unknown"`，不要返回 0 或抛错；只有参数非法/内部故障才抛错。

### 3.3 model.metadata

请求：

```json
{
  "schemaVersion": 1,
  "kind": "metadata",
  "now": "2026-11-19T04:30:00Z",
  "provider": "agy",
  "model": "claude-opus-4-6-thinking",
  "baseModel": "claude-opus-4-6"
}
```

响应：

```json
{
  "id": "claude-opus-4-6-thinking",
  "providerId": "anthropic",
  "baseModel": "claude-opus-4-6",
  "metadataSchemaVersion": 1,
  "metadataStatus": "resolved",
  "source": {
    "id": "custom:metadata",
    "kind": "provider",
    "authority": 60,
    "confidence": 0.9,
    "fetchedAt": "2026-11-19T04:00:00Z",
    "stale": false
  },
  "name": "Claude Opus 4.6 Thinking",
  "family": "claude-opus",
  "status": "active",
  "dates": { "release": "2026-10-01", "lastUpdated": "2026-11-01" },
  "capabilities": { "attachment": true, "reasoning": true, "toolCall": true },
  "limit": { "context": 200000, "maxOutput": 64000 },
  "modalities": { "input": ["text", "image"], "output": ["text"] },
  "reasoningEfforts": ["low", "medium", "high", "max"],
  "cost": { "input": 5, "output": 25, "cacheRead": 0.5, "cacheWrite": 6.25 }
}
```

未知模型也必须显式返回：

```json
{ "id": "...", "metadataStatus": "unknown", "source": { "id": "custom:metadata", "kind": "provider" } }
```

`cost` 与 Quote 同单位（USD / 每百万 token）；缺失维度省略，不要用 0 冒充未知。

## 4. 宿主裁决（Resolver）

报价排序（高 → 低）：

```
account(100) > manual(95) > official(90) > vendor(80) > provider(60)
> aggregator models.dev(40) > community(20) > derived(10) > unknown(0)
```

同层排序：`specificity` 高者优先 → `effectiveAt` 新者优先 → `source.id` 字典序（确定性）。
插件声明的 `authority` 只能向下降，不能把 aggregator 自封为 official。

元数据排序同理；宿主只采用一个“最佳来源”，不逐字段混合，避免价格与上下文窗口来自不同版本。

失败策略：

- 某个插件失败：记录 attempt，继续下一个同层来源；全部失败时使用上一份快照；
- 快照价格发生变化：默认写入 `pending` + 复核队列，旧价格继续计费；
- 首次来源没有旧快照：可以直接生效；
- 只改 `fetchedAt` 不算价格变化，直接更新元数据；
- 超过 14 天的快照标记 stale，管理面必须显示来源与新鲜度。

## 5. Go 接口

`contracts/modelpricing` 定义了宿主侧端口：

```go
type CatalogSource interface {
    Capability() string
    Load(ctx context.Context, request CatalogRequest) (Catalog, error)
}

type QuoteSource interface {
    Capability() string
    Quote(ctx context.Context, request QuoteRequest) (Quote, error)
}

type MetadataSource interface {
    Capability() string
    Resolve(ctx context.Context, request MetadataRequest) (Metadata, error)
}

type Resolver interface {
    ResolveQuote(ctx context.Context, request QuoteRequest) (Quote, error)
    ResolveMetadata(ctx context.Context, request MetadataRequest) (Metadata, error)
}
```

实现分工：

- `models.dev` 内置来源实现 `CatalogSource` + `MetadataSource`（kind=aggregator）；
- Node 插件桥实现同样接口，把 `runtime.invoke` 的返回值解码成 `Catalog/Quote/Metadata`；
- 账号自定义价、人工覆盖在 `Resolver` 内部构造，不经过插件；
- 推理/计费热路径只查 `Resolver`，不直接读 models.dev 或插件。

## 6. 迁移路径

1. 新增 `Resolver` 与 `models.dev` 适配器，行为与当前 Go/Node 解析保持一致（含 base model 回退、stale 判断）；
2. Go 侧 `webuimodelsyncapi`、用量定价、模型上下文接口改为依赖 `Resolver`；
3. Node 的 `pricing.catalog` / `model.metadata` 插件桥接到 `Resolver`；
4. 自定义价格插件接入后，通过 `kind=official/vendor` 覆盖 models.dev；或在配置中禁用内置 aggregator；
5. 回归口径：同一模型在“无插件 / models.dev / 自定义插件”三种情况下，价格、来源、stale 状态与 UI 展示可解释且可切换。
