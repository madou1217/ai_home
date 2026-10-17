# 推理能力位：让「谁能服务什么」只有一个声明处

> 状态：**Proposed**（待评审）
> 上位决策：[`docs/architecture/product-direction-node-go-2026-08-15.md`](../architecture/product-direction-node-go-2026-08-15.md)
> ——「一套业务核心、两个宿主角色、一个账号真相源」；Go Core 唯一拥有 Relay 决策。

## 1. 问题

### 1.1 现象

`claude-*` 别名指向 `cline-pass/deepseek-v4.1-flash`（用户手工配置的兜底链），请求经
`/v1/messages` 进入网关后返回：

```
HTTP 503  {"error":"no_available_account",
           "detail":"no available opencode account can serve model cline-pass/deepseek-v4.1-flash"}
```

同一时刻：

- Node 运行时池里 **有** 2 个 cline 账号（`acct_3e25a1db0334a63e7eef`、`acct_c1dfde453a698296e8fa`）
- Go 的 `aih.db` 里 cline 账号数 **为 0**
- `/v1/messages` 已划转给 Go（`gateway.anthropic.messages` 在 `goCoreRoutes` 里）

于是请求落在 Go 上，Go 找不到承载账号，且**没有 Node 回落**（路由已划转）。

### 1.2 这不是「别名配错了」

别名是用户显式配置的合法功能。真正的问题是结构性的：

> **「某个 provider 的推理能不能由 Go 承接」这件事，在代码里有三处互不一致的硬编码清单，
> 且没有任何机制在它们漂移时报警。**

### 1.3 三处硬编码（实测）

| # | 位置 | 内容 | 缺 cline？ |
|---|---|---|---|
| 1 | `core/inference/protocol.go:8-12` + `IsValid()` | `ProviderCodex/Claude/Agy`，共 3 个 | ✅ 缺 |
| 2 | `lib/server/go-core-servable-providers.js:20` | `GO_CANONICAL_INFERENCE_PROVIDERS = ['codex','claude','agy']` | ✅ 缺 |
| 3 | `lib/account/go-bridge/go-import-translator.js:216-223` | `STRATEGIES`（3）+ `NATIVE_ENVELOPE_PROVIDERS`（12） | ✅ 缺 |

三处的**语义各不相同**，却被当成同一件事在用：

- #1 是 Go 领域层的 provider 枚举（推理 + 账号归属）
- #2 是 Node 对「Go 能服务哪些 provider」的**副本**
- #3 是「账号怎么翻译成 Go 能导入的形状」

### 1.4 覆盖面实测（Node vs Go）

| 层 | Node | Go | 差距 |
|---|---:|---:|---|
| Provider 全集（描述符） | 16 | — | — |
| **账号层**（凭据解码 + 身份策略） | 16 | **15** | 缺 `cline` |
| **推理上游**（能真正转发请求） | 16 | **3** + 家族透传 4 | 缺 9 |

Go 账号层已支持 15 个（`internal/adapters/accounts/nativeaccount/decoder.go:41-56`），
推理上游只有 3 个（`core/inference/protocol.go`）+ 家族透传（`internal/transport/http/codebuddyfamilyrelay`）。

**结论：Go 能「存」9 个 provider 的账号，却只能「用」3 个。**
存进去但路由不了 —— 这是「数据不同步」的另一面：不是同步机制坏了，是**同步了也没用**。

### 1.5 实测的账号数差异

| provider | Node `account_refs` | Go `accounts` | 差 |
|---|---:|---:|---:|
| codex | 9 | 5 | **-4** |
| cline | 2 | **0** | **-2** |
| opencode | 6 | 5 | -1 |
| zcode | 3 | 2 | -1 |
| qoder / qodercn | 1 / 1 | 0 / 0 | -1 / -1 |
| 其余 9 类 | 相同 | 相同 | — |
| **合计** | **34** | **30** | **-4** |

### 1.6 已有机制（不是从零开始）

- `lib/server/go-account-sync.js`（347 行）：双向同步已实现 —— Go→Node 凭据 CAS 回写、
  Node→Go 推送、启停/默认账号同步、删除只删自己映射过的、Go 独有 codex/claude 收养。
- `lib/providers/{contract,registry,loader}.js`：**描述符 + 注册表 + 倒排索引**范式已落地。
- `core/providers/{model,builtins}.go` + `cmd/provider-manifest`：Go 侧能力位已存在
  （`api_key_account` / `model_catalog` / `quota_usage` / … / `acp_session`），
  并投影到 `contracts/providers/manifest.json`。
- `lib/providers/defs/*.js`：**16/16 provider 已声明 `relay` 能力**
  （`{ transport, clientDependent, reason, strategy }`）。

**缺的不是机制，是把「Go 的推理承接能力」也变成能力位。**

## 2. 目标

### 2.1 一句话

> **「Go 能不能服务 provider X 在入口 E 上的推理」= 查 X 自己声明的能力位，
> 而不是查任何中央清单。**

### 2.2 不变量

1. **单一声明处**：每个 provider 的推理能力只在自己的描述符里声明一次（Node 一份、Go 一份）。
2. **消费方问能力**：调用方写 `resolveRelayHost('go', provider, entryId)`，
   不写 `['codex','claude','agy'].includes(provider)`。
3. **不允许沉默缺失**：Go 不支持的 provider **必须显式声明** `supported: false` + `reason`；
   「没声明」= 守卫测试红。cline 今天的病就是沉默缺失（不在任何名单里，没人知道为什么）。
4. **漂移必报警**：Node 声明与 Go 声明的差异必须被守卫测试逐项列出，带原因。
5. **目标态一致**：最终 Node 与 Go 的支持集合完全相同（用户要求「一模一样」）。

### 2.3 与上位文档一致

`product-direction-node-go-2026-08-15.md` §2：

> Go Core 唯一拥有账号身份、凭据、账号模型、额度快照、运行资格、账号征召、**Relay**、
> 失败归因和请求 attempt 历史。

本设计是这句话的落地：**Relay 决策权归 Go，Node 只读 Go 声明的能力**。

## 3. 设计

### 3.1 复用既有 `relay` 能力，不新增能力位

**先说一个自我修正**：本设计的初稿曾提议新增 `inference` 能力位。核查后发现**重复**——
`relay` 能力已经在回答「这个 provider 的推理能不能由网关服务」：

```js
// lib/providers/defs/cline.js:68
relay: { transport: 'http', clientDependent: false }

// lib/server/webui-account-live.js:24-31 —— 唯一消费方
// 「该 provider 能否由网关服务（HTTP relay，**不依赖本机客户端**）」的唯一判定：
// provider 描述符的 relay 能力（transport=http 且 clientDependent=false）。
function providerSupportsGatewayRelay(provider) {
  const relay = getProviderCapability(provider, 'relay');
  return Boolean(relay) && relay.transport === 'http' && relay.clientDependent === false;
}
```

所以**扩展 `relay`，不新建能力位**。这也符合项目铁律：同一概念只能有一处声明。

### 3.2 缺的是什么：`relay` 只说了「能不能」，没说「谁」

现有 `relay` 声明的是**账号侧的客观事实**：「这个 provider 有不依赖本机客户端的 HTTP 推理通道」。
它回答的是「Node 能不能服务」——16/16 provider 都声明了 `transport: 'http'`（qoder/qodercn 除外）。

它**没有**回答的是本设计要解决的问题：

> **Go 能不能服务？**（同一个 provider，Node 能、Go 可能不能）

以及：

> **在哪个入口上？**（家族透传只在 chat completions）

### 3.3 声明处：**Go 一处，Node 读投影**

**设计期间发现的简化**（重要）：Node 的 provider 列表**本来就是从 Go 生成的 manifest 读的**：

```js
// lib/provider-catalog.js:99-103
const PROVIDER_SCHEMA_VERSION = Number(manifestData.schemaVersion || 0);
const PROVIDER_DEFINITIONS = deepFreeze((manifestData.providers || []).map(normalizeDefinition)...);
const PROVIDER_IDS = deepFreeze(PROVIDER_DEFINITIONS.map((definition) => definition.id));

// lib/server/providers.js:11
const SUPPORTED_SERVER_PROVIDERS = PROVIDER_IDS;   // ← 16 个 provider 全部来自 Go
```

所以 `relayHosts` **只在 Go 声明一次**，Node 经 `contracts/providers/manifest.json` 读。
原设计里「两侧都声明 + 守卫逐字段比对」是多余的——**同一份数据不可能漂移，因为它只有一份**。

（既有 `lib/providers/defs/<id>.js` 的 `relay: { transport, clientDependent }` 描述的是
**账号侧的客观事实**——这个 provider 有没有不依赖本机客户端的 HTTP 通道。
它与「哪个宿主能服务」是两个问题，保留在描述符里不动；新增的宿主维度进 Go manifest。）

### 3.4 Go 侧声明

```go
// core/providers/builtins.go
func builtinCline() Definition {
    return Definition{
        ID: "cline",
        // ...
        RelayHosts: map[string]RelayHost{
            RelayHostNode: {Supported: true, Channel: RelayChannelRelay},
            RelayHostGo: {
                Supported: true,
                Channel:   RelayChannelRelay,
                Entries:   []string{"gateway.openai.chat_completions"},
            },
        },
    }
}

// 尚未落地 Go 上游的 provider（P2 之前）
func builtinKimi() Definition {
    return Definition{
        ID: "kimi",
        // ...
        RelayHosts: map[string]RelayHost{
            RelayHostNode: {Supported: true, Channel: RelayChannelRelay},
            RelayHostGo: {
                Supported: false,
                Reason:    "Go 尚无 kimi 推理上游适配器（规划见 2026-10-17-inference-capability-registry.md P2）",
            },
        },
    }
}
```

| 字段 | 说明 |
|---|---|
| `Supported` | 该宿主能否服务该 provider 的推理 |
| `Channel` | `canonical` = 有完整上游适配器（全入口）；`relay` = 同协议透传（受 `Entries` 限制） |
| `Entries` | **入口感知**：家族透传只挂在 `gateway.openai.chat_completions`；canonical 不限定 |
| `Reason` | `Supported: false` 时**必填**：为什么不能（禁止沉默缺失） |

**为什么 `Entries` 必须进载荷**：家族透传只在 chat completions 挂载
（`internal/host/aihserver/router.go:164`）。若只有布尔，`/v1/messages` 上的家族请求会被误判为
「Go 能服务」—— 正是今天 `GO_RELAY_INFERENCE_ENTRIES` 必须单列的原因。收进载荷后消费方只问一次。

### 3.5 契约校验（`core/providers/validate.go`）

`validateRelayHosts` 钉四条不变量：

```
* 宿主名只能是 node / go            —— 拼错会让声明静默失效，等于回到「没声明」
* supported=false 时 reason 必填    —— 禁止沉默缺失
* supported=true  时 channel 必填且取值合法 —— 「能服务」必须说清走哪条通道
* channel=canonical 不得限定 entries —— 该通道本就覆盖全部推理入口
```

### 3.6 投影与消费

`cmd/provider-manifest` 把 `Definition.RelayHosts` 投影到
`contracts/providers/manifest.json` 的 `providers[].relayHosts`。

Node 侧经 `lib/provider-catalog.js` 读取（该文件已经在读同一份 manifest），
新增门面谓词（`lib/providers/index.js`）：

```js
/**
 * 某宿主能否服务该 Provider 在该入口上的推理。
 * @param {string} host      'node' | 'go'
 * @param {string} provider
 * @param {string} entryId   入口 id（如 'gateway.anthropic.messages'）；空 = 只判 provider 级
 * @returns {{ supported: boolean, channel: string, reason: string }}
 */
function resolveRelayHost(host, provider, entryId = '')
```

**为什么门面要接 entryId**：入口感知是能力的一部分（家族透传只在 chat completions）。
调用方不该自己拼「provider 支持 + 入口在不在名单里」两件事。

**既有消费方 `providerSupportsGatewayRelay`（webui-account-live.js:24）行为不变**——
它问的是 `hosts.node`，而 Node 侧恒为 `supported: true`（有 `transport: 'http'` 的前提下）。

### 3.7 消费方改造

**`lib/server/go-core-servable-providers.js` 从「持有名单」降级为「读声明」**：

```js
// 改前（三份硬编码之一）
const GO_CANONICAL_INFERENCE_PROVIDERS = Object.freeze(['codex', 'claude', 'agy']);
const GO_RELAY_INFERENCE_PROVIDERS = Object.freeze([...FAMILY_PROVIDERS]);
const GO_RELAY_INFERENCE_ENTRIES = Object.freeze(['gateway.openai.chat_completions']);

// 改后：全部走门面（内部读 Node 描述符 + Go manifest，两侧不一致时以守卫测试报警）
const { resolveRelayHost } = require('../providers');

function goInferenceChannel(provider, entryId = '') {
  const resolved = resolveRelayHost('go', provider, entryId);
  return resolved.supported ? resolved.channel : '';
}
```

`go-core-route-deferral.js` 的调用点**一行不改**（它已经在用 `goInferenceChannel` /
`goServesInference` 这两个谓词）—— 这正是当初把它们抽成谓词的价值。

### 3.8 守卫测试（关键）

新增 `test/relay-host-parity.test.js`，钉三条不变量：

1. **不允许沉默缺失**
   ```
   for each provider in SUPPORTED_SERVER_PROVIDERS:
     Go manifest 必须声明 relayHosts（supported 真或假）
     supported === false 时 reason 必须非空
   ```
   缺失 → 红。这条直接消灭 cline 那类问题：不在任何名单里、没人知道为什么。

2. **Go 的声明必须与 Go 的实现自洽**
   ```
   relayHosts.go.supported === true 时：
     channel=canonical → core/inference 有该 ProviderID 且 internal/adapters 有适配器
     channel=relay     → internal/transport/http 有挂载在 entries 上的透传 Handler
   ```
   声明了却无实现 = **假声明**，比沉默缺失更危险（转发过去必失败）。靠源码扫描守卫。

3. **目标态一致**（迁移完成后启用）
   ```
   Node 支持而 Go 不支持的 provider 集合 == 空
   ```
   迁移期这条以清单形式列出剩余差异，完成一个划掉一个。

### 3.9 删除的硬编码

| 文件 | 删除内容 | 替代 |
|---|---|---|
| `lib/server/go-core-servable-providers.js` | `GO_CANONICAL_INFERENCE_PROVIDERS`、`GO_RELAY_INFERENCE_PROVIDERS`、`GO_RELAY_INFERENCE_ENTRIES` | `resolveRelayHost('go', ...)` 读 manifest |
| `core/inference/protocol.go` | `IsValid()` 的三常量硬编码 | 由 `core/providers` 的 relayHosts 派生 |
| `lib/account/go-bridge/go-import-translator.js` | `STRATEGIES` + `NATIVE_ENVELOPE_PROVIDERS` 双表 | 由描述符的 `goBridge` 能力声明 |

**关于 #3**：账号翻译策略（`STRATEGIES`）与推理能力是**两件事**（能存 ≠ 能用），
但同样不该是中央表。设计上给描述符加一个 `goBridge` 能力位声明翻译策略 id，
`go-import-translator.js` 降级为「按 id 查实现」的执行器（与
`lib/server/native-cli-model-discovery.js` 降级为执行器同一手法，见 design-patterns.md §3 Phase 1 第 4 条）。

## 4. 迁移阶段

每阶段**独立可验证、可回滚**，行为变化仅限该阶段声明的 provider。

### P0 —— relayHosts 落地（行为零变化）

- Go 侧 `RelayHost` + `Definition.RelayHosts` + `validateRelayHosts` 落地
- `builtins.go` 16 个 provider **按现状如实声明**：
  - `codex` / `claude` / `agy` → `go: { supported: true, channel: 'canonical' }`
  - 家族四支（codebuddy / codebuddycn / workbuddy / workbuddycn）→
    `go: { supported: true, channel: 'relay', entries: ['gateway.openai.chat_completions'] }`
  - 其余 9 支 → `go: { supported: false, reason: '...' }`
  - 全部 → `node: { supported: true, channel: 'relay' }`
- `lib/provider-catalog.js` 暴露 `relayHosts`；`lib/providers/index.js` 加 `resolveRelayHost`
- `cmd/provider-manifest` 投影；`contracts/providers/manifest.json` 重新生成
- `go-core-servable-providers.js` 改为走门面（**输出与改前逐项一致**）
- 守卫测试落地（三条不变量）
- **验收**：`npm test` 全绿；`npm run providers:check` 通过；
  `goInferenceChannel()` 对 16 个 provider × 全入口的返回值与改前**逐项相同**

### P1 —— cline 补齐（止血，用户最痛）

- Go 账号层：`nativeaccount/decoder.go` 加 `cline` 策略
- Go 推理上游：cline 是标准 OpenAI chat 形态 → 可复用家族透传的透传范式
  （`internal/transport/http/codebuddyfamilyrelay` 的请���改写 + SSE 聚合）
- `go-import-translator.js` 加 `translateCline`
- Go `relayHosts.go` 改为 `supported: true`
- **验收**：真实 cline 账号端到端推理 200；`claude-*` 别名链路恢复；
  分类器（`claude-sonnet-5[1m]`）连续 10 次请求全 200

### P2 —— 其余 8 个上游按用量补齐

优先级由 `model_usage_records` 的真实请求量决定（当前排序：
opencode → kimi → zcode → kiro → grok → qoder/qodercn → gemini）。
每补一个：Go `relayHosts.go` 改为 `supported: true`，守卫测试的差异清单划掉一行。

### P3 —— 收口

- `go-core-servable-providers.js` 的名单常量彻底删除
- `core/inference/protocol.go` 的 `IsValid()` 改为能力位派生
- 守卫测试第 3 条（目标态一致）从清单转为**强制断言**
- `docs/architecture/go-node-parity-matrix.md` 更新

## 5. 验收标准

| # | 标准 | 证据 |
|---|---|---|
| 1 | 无中央 provider 名单 | `grep -rn "\['codex', 'claude', 'agy'\]" lib/ core/` 无命中 |
| 2 | 消费方问能力 | `go-core-route-deferral.js` 只用谓词，无 provider 字面量 |
| 3 | 沉默缺失会红 | 删除任一描述符的 `relay.hosts` → 守卫测试红 |
| 4 | 差异必须带原因 | `hosts.go.supported:false` 无 `reason` → 守卫测试红 |
| 5 | 两侧声明一致 | Node `relay.hosts.go` 与 Go `relayHosts.go` 逐字段相等 |
| 6 | 目标态 Node/Go 一致 | P3 后「Node 支持而 Go 不支持」集合为空 |
| 7 | 真实上游可用 | P1/P2 每个 provider 有真账号端到端 200 证据 |
| 8 | 数据一致 | Node `account_refs` 与 Go `accounts` 的 provider 集合相同 |

## 6. 风险与取舍

| 风险 | 缓解 |
|---|---|
| Node 描述符与 Go manifest 漂移 | 守卫测试第 2 条逐字段比对；manifest 由 `cmd/provider-manifest` 单向生成 |
| 迁移期差异长期存在（P2 拖尾） | 差异清单进守卫测试，每次跑测试都打印剩余项 |
| `relay` 载荷扩展破坏既有消费方 | `hosts` 是新增可选字段；`providerSupportsGatewayRelay` 行为等价（问 `hosts.node`，恒 true） |
| manifest schema 变更 | `schemaVersion` 2 → 3；`lib/provider-catalog.js` 缺字段视为 `supported:false`（保守侧） |
| 透传范式复用导致 cline 与家族耦合 | 抽出公共透传执行器（`internal/transport/http/relaycore`），家族与 cline 各自声明参数 |

## 7. 明确不做

- **不做 Go 全量重写**（上位文档 §5 已拒绝）
- **不迁移** PTY / tmux / Session / Fabric / WebUI BFF / 平台启动器
- **不做 qoder/qodercn 的 HTTP 上游**：其 relay transport 是 `client-cli`，
  依赖本机 CLI，Go 服务端无此条件 —— 但**仍要在能力位里显式声明
  `supported:false` + reason**，而不是缺席（这正是本设计要消灭的形态）
- **不新增 `inference` 能力位**：`relay` 已经在回答同一问题（见 §3.1 的自我修正）
